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

interface CopyInputs {
  sourceBucket: string;
  destinationBucket: string;
  sourceKey: string;
  destinationKey: string;
  recursive: boolean;
}

type CopyClient = Pick<S3Client, 'send'>;

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

async function copyObject(client: CopyClient, inputs: CopyInputs, key: string): Promise<void> {
  const source = { Bucket: inputs.sourceBucket, Key: key };
  const head = await client.send(new HeadObjectCommand(source));
  if (typeof head.ContentLength !== 'number'
    || !Number.isSafeInteger(head.ContentLength) || head.ContentLength < 0 || !head.ETag) {
    throw new Error(`Source object has invalid size or missing ETag: ${key}`);
  }
  const copySource = `${inputs.sourceBucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const destination = { Bucket: inputs.destinationBucket, Key: destinationFor(inputs, key) };
  const condition = { CopySource: copySource, CopySourceIfMatch: head.ETag };

  if (head.ContentLength <= 5 * 1024 ** 3) {
    await client.send(new CopyObjectCommand({
      ...destination,
      ...condition,
      MetadataDirective: 'COPY',
      TaggingDirective: 'COPY',
    }));
    return;
  }

  const { TagSet = [] } = await client.send(new GetObjectTaggingCommand(source));
  const tagging = TagSet.map(({ Key, Value }) => {
    if (typeof Key !== 'string' || typeof Value !== 'string') {
      throw new Error(`S3 returned an invalid tag for ${key}`);
    }
    return `${encodeURIComponent(Key)}=${encodeURIComponent(Value)}`;
  }).join('&');
  const { UploadId } = await client.send(new CreateMultipartUploadCommand({
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
  }));
  if (!UploadId) {
    throw new Error(`S3 did not return a multipart upload ID for ${destination.Key}`);
  }
  const upload = { ...destination, UploadId };
  // Bound part count to S3's 10,000-part limit while avoiding object downloads.
  const partSize = Math.max(512 * 1024 ** 2, Math.ceil(head.ContentLength / 10000));
  try {
    const parts: CompletedPart[] = [];
    for (let start = 0; start < head.ContentLength; start += partSize) {
      const PartNumber = parts.length + 1;
      const end = Math.min(start + partSize, head.ContentLength) - 1;
      const result = await client.send(new UploadPartCopyCommand({
        ...upload,
        ...condition,
        PartNumber,
        CopySourceRange: `bytes=${start}-${end}`,
      }));
      const ETag = result.CopyPartResult?.ETag;
      if (!ETag) {
        throw new Error(`S3 did not return an ETag for multipart part ${PartNumber}`);
      }
      parts.push({ ETag, PartNumber });
    }
    await client.send(new CompleteMultipartUploadCommand({
      ...upload,
      MultipartUpload: { Parts: parts },
    }));
  } catch (error) {
    try {
      await client.send(new AbortMultipartUploadCommand(upload));
    } catch (abortError) {
      console.error(`Failed to abort multipart upload ${UploadId}:`, abortError);
    }
    throw error;
  }
}

export async function copyObjects(client: CopyClient, inputs: CopyInputs): Promise<number> {
  let copied = 0;
  if (!inputs.recursive) {
    await copyObject(client, inputs, inputs.sourceKey);
    copied = 1;
  } else {
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: inputs.sourceBucket,
        Prefix: inputs.sourceKey,
        ContinuationToken: token,
      }));
      for (const object of page.Contents ?? []) {
        if (typeof object.Key !== 'string') {
          throw new Error('S3 returned an object without a key.');
        }
        await copyObject(client, inputs, object.Key);
        copied += 1;
      }
      if (page.IsTruncated && (!page.NextContinuationToken || page.NextContinuationToken === token)) {
        throw new Error('S3 returned a truncated listing without a new continuation token.');
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  console.log(`Copied ${copied} object(s).`);
  return copied;
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
  const client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  try {
    await copyObjects(client, inputs);
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('S3 copy failed:', error);
    process.exitCode = 1;
  });
}
