import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCopyCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { pathToFileURL } from 'node:url';
import { createLogger, type LogContext, type Logger } from '../../src/shared/logging/logger.ts';
import { writeJobSummary } from '../../src/shared/reporting/job-summary.ts';

interface CopyInputs {
  sourceBucket: string;
  destinationBucket: string;
  sourceKey: string;
  destinationKey: string;
  recursive: boolean;
}

type CopyClient = Pick<S3Client, 'send'>;

export interface TransferProgress {
  objectsCopied: number;
  bytesCopied: number;
}

export interface TransferResult extends TransferProgress {
  durationMs: number;
}

export interface CopyOptions {
  logger?: Logger;
  now?: () => Date;
  /** Updated in place so callers can report partial progress after a failure. */
  progress?: TransferProgress;
}

export type FailureCategory = 'SourceNotFound' | 'SourceLookupFailed' | 'SourceListFailed' | 'CopyFailed';

interface FailureOrigin {
  operation: string;
  objectKey?: string;
}

interface AwsErrorShape {
  name?: unknown;
  message?: unknown;
  $metadata?: { httpStatusCode?: number; requestId?: string };
}

const SOURCE_NOT_FOUND_MESSAGE = 'Source object not found or inaccessible. Verify the source bucket and object key.';
const origins = new WeakMap<object, FailureOrigin>();
const loggedErrors = new WeakSet<object>();

/** True when copyObjects already logged this error, so callers can avoid a duplicate entry. */
export function wasLogged(error: unknown): boolean {
  return typeof error === 'object' && error !== null && loggedErrors.has(error);
}

function recordOrigin(error: unknown, origin: FailureOrigin): void {
  if (typeof error === 'object' && error !== null && !origins.has(error)) {
    origins.set(error, origin);
  }
}

async function step<T>(operation: string, objectKey: string | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    recordOrigin(error, objectKey === undefined ? { operation } : { operation, objectKey });
    throw error;
  }
}

function fail(operation: string, objectKey: string | undefined, message: string): Error {
  const error = new Error(message);
  recordOrigin(error, objectKey === undefined ? { operation } : { operation, objectKey });
  return error;
}

/** Only a failed HeadObject with a not-found signal is a missing source; a 404 elsewhere (e.g. CopyObject) is not. */
export function classifyFailure(operation: string, error: unknown): FailureCategory {
  const { name, $metadata } = (error ?? {}) as AwsErrorShape;
  if (operation === 'HeadObject') {
    const notFound = $metadata?.httpStatusCode === 404 || name === 'NotFound' || name === 'NoSuchKey';
    return notFound ? 'SourceNotFound' : 'SourceLookupFailed';
  }
  if (operation === 'ListObjectsV2') {
    return 'SourceListFailed';
  }
  if (operation === 'ValidateSource' || operation === 'GetObjectTagging') {
    return 'SourceLookupFailed';
  }
  return 'CopyFailed';
}

export function readInputs(env: NodeJS.ProcessEnv): CopyInputs {
  const sourceBucket = env.SOURCE_BUCKET;
  const destinationBucket = env.DESTINATION_BUCKET;
  const sourceKey = env.SOURCE_KEY ?? '';
  const destinationKey = env.DESTINATION_KEY ?? '';
  const recursive = env.RECURSIVE ?? 'false';

  const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
  if (!sourceBucket || !destinationBucket
    || !bucketPattern.test(sourceBucket) || !bucketPattern.test(destinationBucket)) {
    throw new Error('Provide bucket names of 3-63 characters, without s3:// or a path.');
  }
  if (sourceBucket === destinationBucket) {
    throw new Error('Source and destination must be different buckets.');
  }
  if (recursive !== 'true' && recursive !== 'false') {
    throw new Error('RECURSIVE must be true or false.');
  }
  if (recursive === 'false' && !sourceKey) {
    throw new Error('A source object key is required for non-recursive copying.');
  }
  return { sourceBucket, destinationBucket, sourceKey, destinationKey, recursive: recursive === 'true' };
}

function destinationFor(inputs: CopyInputs, key: string): string {
  if (!inputs.recursive) {
    if (!inputs.destinationKey || inputs.destinationKey.endsWith('/')) {
      return inputs.destinationKey + key.slice(key.lastIndexOf('/') + 1);
    }
    return inputs.destinationKey;
  }
  const prefix = inputs.destinationKey && !inputs.destinationKey.endsWith('/')
    ? `${inputs.destinationKey}/`
    : inputs.destinationKey;
  return prefix + key.slice(inputs.sourceKey.length);
}

interface TransferContext {
  client: CopyClient;
  inputs: CopyInputs;
  logger: Logger;
  progress: TransferProgress;
  base: LogContext;
}

async function copyObject(ctx: TransferContext, key: string): Promise<void> {
  const { client, inputs, logger, progress, base } = ctx;
  const quiet = inputs.recursive;
  const log = quiet ? logger.debug : logger.info;
  const source = { Bucket: inputs.sourceBucket, Key: key };
  const destination = { Bucket: inputs.destinationBucket, Key: destinationFor(inputs, key) };
  logger.debug('Object key details', { operation: 'CopyObject', objectKey: key, destinationKey: destination.Key });

  logger.debug('Validating source object', { ...base, operation: 'HeadObject' });
  const head = await step('HeadObject', key, () => client.send(new HeadObjectCommand(source)));
  if (typeof head.ContentLength !== 'number'
    || !Number.isSafeInteger(head.ContentLength) || head.ContentLength < 0 || !head.ETag) {
    throw fail('ValidateSource', key, 'Source object has invalid size or missing ETag.');
  }
  const size = head.ContentLength;
  log('Source object validated', { ...base, operation: 'HeadObject', sizeBytes: size });

  const copySource = `${inputs.sourceBucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const condition = { CopySource: copySource, CopySourceIfMatch: head.ETag };

  if (size <= 5 * 1024 ** 3) {
    log('Copy started', { ...base, operation: 'CopyObject', sizeBytes: size });
    await step('CopyObject', key, () => client.send(new CopyObjectCommand({
      ...destination,
      ...condition,
      MetadataDirective: 'COPY',
      TaggingDirective: 'COPY',
    })));
    progress.objectsCopied += 1;
    progress.bytesCopied += size;
    log('Copy succeeded', { ...base, operation: 'CopyObject', sizeBytes: size });
    return;
  }

  const { TagSet = [] } = await step('GetObjectTagging', key, () => client.send(new GetObjectTaggingCommand(source)));
  const tagging = TagSet.map(({ Key, Value }) => {
    if (typeof Key !== 'string' || typeof Value !== 'string') {
      throw fail('GetObjectTagging', key, 'S3 returned an invalid object tag.');
    }
    return `${encodeURIComponent(Key)}=${encodeURIComponent(Value)}`;
  }).join('&');
  logger.info('Multipart copy started', { ...base, operation: 'CreateMultipartUpload', sizeBytes: size });
  const { UploadId } = await step('CreateMultipartUpload', key, () => client.send(new CreateMultipartUploadCommand({
    ...destination,
    Metadata: head.Metadata,
    CacheControl: head.CacheControl,
    ContentDisposition: head.ContentDisposition,
    ContentEncoding: head.ContentEncoding,
    ContentLanguage: head.ContentLanguage,
    ContentType: head.ContentType,
    Expires: head.Expires,
    WebsiteRedirectLocation: head.WebsiteRedirectLocation,
    Tagging: tagging || undefined,
  })));
  if (!UploadId) {
    throw fail('CreateMultipartUpload', key, 'S3 did not return a multipart upload ID.');
  }
  logger.info('Multipart upload initiated', { ...base, operation: 'CreateMultipartUpload', uploadId: UploadId });
  const upload = { ...destination, UploadId };
  // Bound part count to S3's 10,000-part limit while avoiding object downloads.
  const partSize = Math.max(512 * 1024 ** 2, Math.ceil(size / 10000));
  try {
    const parts: CompletedPart[] = [];
    for (let start = 0; start < size; start += partSize) {
      const PartNumber = parts.length + 1;
      const end = Math.min(start + partSize, size) - 1;
      const result = await step('UploadPartCopy', key, () => client.send(new UploadPartCopyCommand({
        ...upload,
        ...condition,
        PartNumber,
        CopySourceRange: `bytes=${start}-${end}`,
      })));
      const ETag = result.CopyPartResult?.ETag;
      if (!ETag) {
        throw fail('UploadPartCopy', key, `S3 did not return an ETag for multipart part ${PartNumber}.`);
      }
      parts.push({ ETag, PartNumber });
      logger.debug('Multipart part copied', { ...base, operation: 'UploadPartCopy', partNumber: PartNumber, bytesEnd: end + 1, sizeBytes: size });
    }
    await step('CompleteMultipartUpload', key, () => client.send(new CompleteMultipartUploadCommand({
      ...upload,
      MultipartUpload: { Parts: parts },
    })));
    progress.objectsCopied += 1;
    progress.bytesCopied += size;
    logger.info('Multipart upload completed', {
      ...base, operation: 'CompleteMultipartUpload', uploadId: UploadId, parts: parts.length, sizeBytes: size,
    });
  } catch (error) {
    try {
      await client.send(new AbortMultipartUploadCommand(upload));
      logger.warn('Multipart upload aborted', { ...base, operation: 'AbortMultipartUpload', uploadId: UploadId });
    } catch (abortError) {
      const { name, message, $metadata } = abortError as AwsErrorShape;
      logger.error('Failed to abort multipart upload', {
        ...base,
        operation: 'AbortMultipartUpload',
        uploadId: UploadId,
        errorName: name,
        errorMessage: message,
        httpStatusCode: $metadata?.httpStatusCode,
        requestId: $metadata?.requestId,
      });
    }
    throw error;
  }
}

function logFailure(logger: Logger, error: unknown, base: LogContext, progress: TransferProgress, durationMs: number): void {
  const origin = (typeof error === 'object' && error !== null ? origins.get(error) : undefined) ?? { operation: 'Transfer' };
  const category = classifyFailure(origin.operation, error);
  const { name, message, $metadata } = (error ?? {}) as AwsErrorShape;
  const context: LogContext = {
    ...base,
    status: 'failure',
    operation: origin.operation,
    errorCategory: category,
    errorName: name,
    httpStatusCode: $metadata?.httpStatusCode,
    requestId: $metadata?.requestId,
    errorMessage: category === 'SourceNotFound' ? SOURCE_NOT_FOUND_MESSAGE : message,
    objectsCopied: progress.objectsCopied,
    bytesCopied: progress.bytesCopied,
    durationMs,
  };
  logger.error('S3 transfer failed', context);
  if (origin.objectKey !== undefined) {
    logger.debug('Failed object key', { operation: origin.operation, objectKey: origin.objectKey });
  }
  if (typeof error === 'object' && error !== null) {
    loggedErrors.add(error);
  }
}

export async function copyObjects(
  client: CopyClient,
  inputs: CopyInputs,
  options: CopyOptions = {},
): Promise<TransferResult> {
  const logger = options.logger ?? createLogger('s3-copy');
  const now = options.now ?? (() => new Date());
  const progress = options.progress ?? { objectsCopied: 0, bytesCopied: 0 };
  const startedAt = now();
  const base: LogContext = {
    sourceBucket: inputs.sourceBucket,
    destinationBucket: inputs.destinationBucket,
    mode: inputs.recursive ? 'recursive' : 'single-object',
  };
  const ctx: TransferContext = { client, inputs, logger, progress, base };
  const elapsed = (): number => now().getTime() - startedAt.getTime();

  logger.info('Transfer started', { ...base, startedAt: startedAt.toISOString() });
  try {
    if (!inputs.recursive) {
      await copyObject(ctx, inputs.sourceKey);
    } else {
      let token: string | undefined;
      let pages = 0;
      do {
        const page = await step('ListObjectsV2', undefined, () => client.send(new ListObjectsV2Command({
          Bucket: inputs.sourceBucket,
          Prefix: inputs.sourceKey,
          ContinuationToken: token,
        })));
        pages += 1;
        const contents = page.Contents ?? [];
        logger.info('Listing page received', { ...base, page: pages, objectsInPage: contents.length });
        for (const object of contents) {
          if (typeof object.Key !== 'string') {
            throw fail('ListObjectsV2', undefined, 'S3 returned an object without a key.');
          }
          await copyObject(ctx, object.Key);
        }
        logger.info('Listing page processed', { ...base, page: pages, objectsCopied: progress.objectsCopied });
        if (page.IsTruncated && (!page.NextContinuationToken || page.NextContinuationToken === token)) {
          throw fail('ListObjectsV2', undefined, 'S3 returned a truncated listing without a new continuation token.');
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    }
  } catch (error) {
    logFailure(logger, error, base, progress, elapsed());
    throw error;
  }
  const durationMs = elapsed();
  logger.info('Transfer completed', {
    ...base,
    status: 'success',
    objectsCopied: progress.objectsCopied,
    bytesCopied: progress.bytesCopied,
    durationMs,
  });
  return { ...progress, durationMs };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--validate-only')) {
    throw new Error('Usage: node scripts/s3/copy.ts [--validate-only]');
  }
  const inputs = readInputs(process.env);
  if (args[0] === '--validate-only') {
    return;
  }
  const logger = createLogger('s3-copy');
  const client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const progress: TransferProgress = { objectsCopied: 0, bytesCopied: 0 };
  const startedAt = Date.now();
  let status: 'success' | 'failure' = 'failure';
  try {
    await copyObjects(client, inputs, { logger, progress });
    status = 'success';
  } finally {
    client.destroy();
    const outcome = await writeJobSummary({
      title: 'S3 copy',
      status,
      rows: [
        ['Source bucket', inputs.sourceBucket],
        ['Destination bucket', inputs.destinationBucket],
        ['Mode', inputs.recursive ? 'recursive' : 'single-object'],
        ['Objects copied', progress.objectsCopied],
        ['Bytes copied', progress.bytesCopied],
        ['Duration (ms)', Date.now() - startedAt],
      ],
      notes: ['Encryption verification: not performed by this job.'],
    });
    if (outcome === 'failed') {
      logger.warn('Could not write the job summary');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (!wasLogged(error)) {
      createLogger('s3-copy').error('S3 copy failed', { error });
    }
    process.exitCode = 1;
  });
}
