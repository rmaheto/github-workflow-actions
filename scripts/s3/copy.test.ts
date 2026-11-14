import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test, { mock } from 'node:test';
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
} from '@aws-sdk/client-s3';
import { createLogger } from '../../src/shared/logging/logger.ts';
import { classifyFailure, copyObjects as transfer, readInputs, wasLogged } from './copy.ts';
import type { CopyOptions } from './copy.ts';

const silent = createLogger('test', { level: 'ERROR', stdout: () => {}, stderr: () => {} });
const copyObjects = (client: Parameters<typeof transfer>[0], inputs: Parameters<typeof transfer>[1], options: CopyOptions = {}) =>
  transfer(client, inputs, { logger: silent, ...options });

type CopyCommand = AbortMultipartUploadCommand | CompleteMultipartUploadCommand
  | CopyObjectCommand | CreateMultipartUploadCommand | GetObjectTaggingCommand
  | HeadObjectCommand | ListObjectsV2Command | UploadPartCopyCommand;

const env = {
  SOURCE_BUCKET: 'example-source',
  DESTINATION_BUCKET: 'example-destination',
  SOURCE_KEY: 'reports/monthly.csv',
  DESTINATION_KEY: 'archive/monthly.csv',
  RECURSIVE: 'false',
};

function mockClient(handler: (command: CopyCommand) => object) {
  const calls: CopyCommand[] = [];
  const client = new S3Client({ region: 'us-east-1' });
  mock.method(client, 'send', async (command: CopyCommand) => {
    calls.push(command);
    return handler(command);
  });
  return Object.assign(client, { calls });
}

test('invalid inputs fail and validate-only needs no AWS credentials', () => {
  for (const overrides of [
    { SOURCE_BUCKET: 's3://example-source' },
    { SOURCE_KEY: '' },
    { DESTINATION_BUCKET: env.SOURCE_BUCKET },
    { RECURSIVE: 'yes' },
  ]) {
    assert.throws(() => readInputs({ ...env, ...overrides }));
  }
  const result = spawnSync(process.execPath, ['scripts/s3/copy.ts', '--validate-only'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('single copies preserve literal keys and destination basename/prefix semantics', async () => {
  const key = 'reports/a b+%#; $(echo injected).csv';
  const destinations: [string, string][] = [
    ['', 'a b+%#; $(echo injected).csv'],
    ['archive/', 'archive/a b+%#; $(echo injected).csv'],
    ['renamed.csv', 'renamed.csv'],
  ];
  for (const [destination, expected] of destinations) {
    const client = mockClient((command) => command instanceof HeadObjectCommand
      ? { ContentLength: 0, ETag: '"source"' }
      : {});
    await copyObjects(client, readInputs({ ...env, SOURCE_KEY: key, DESTINATION_KEY: destination }));
    const command = client.calls.find((c) => c instanceof CopyObjectCommand);
    assert.ok(command);
    const copy = command.input;
    assert.equal(copy.Key, expected);
    assert.equal(copy.CopySource, `example-source/reports/${encodeURIComponent(key.slice(8))}`);
    assert.equal(copy.CopySourceIfMatch, '"source"');
    assert.equal(copy.MetadataDirective, 'COPY');
    assert.equal(copy.TaggingDirective, 'COPY');
    assert.equal(copy.ServerSideEncryption, undefined);
  }
});

test('recursive copy paginates and preserves relative paths', async () => {
  const client = mockClient((command) => {
    if (command instanceof ListObjectsV2Command) {
      const input = command.input;
      assert.equal(input.Prefix, 'reports/');
      return input.ContinuationToken
        ? { Contents: [{ Key: 'reports/nested/b.csv' }], IsTruncated: false }
        : { Contents: [{ Key: 'reports/a.csv' }], IsTruncated: true, NextContinuationToken: 'next' };
    }
    return command instanceof HeadObjectCommand ? { ContentLength: 12, ETag: '"source"' } : {};
  });
  const copied = await copyObjects(client, readInputs({
    ...env, RECURSIVE: 'true', SOURCE_KEY: 'reports/', DESTINATION_KEY: 'archive',
  }));
  assert.equal(copied.objectsCopied, 2);
  assert.equal(copied.bytesCopied, 24);
  assert.deepEqual(client.calls.filter((c) => c instanceof CopyObjectCommand)
    .map((c) => c.input.Key), ['archive/a.csv', 'archive/nested/b.csv']);
});

test('whole-bucket copies and empty listings', async () => {
  for (const contents of [[], [{ Key: 'nested/a.csv' }]]) {
    const client = mockClient((command) => {
      if (command instanceof ListObjectsV2Command) {
        assert.equal(command.input.Prefix, '');
        return { Contents: contents };
      }
      return command instanceof HeadObjectCommand ? { ContentLength: 12, ETag: '"source"' } : {};
    });
    assert.equal((await copyObjects(client, readInputs({
      ...env, RECURSIVE: 'true', SOURCE_KEY: '', DESTINATION_KEY: '',
    }))).objectsCopied, contents.length);
    if (contents.length) {
      const command = client.calls.at(-1);
      assert.ok(command instanceof CopyObjectCommand);
      assert.equal(command.input.Key, 'nested/a.csv');
    }
  }
});

test('multipart copying above 5 GiB preserves metadata/tags and completes exact ranges', async () => {
  const size = 5 * 1024 ** 3 + 1;
  const client = mockClient((command) => {
    if (command instanceof HeadObjectCommand) {
      return {
        ContentLength: size, ETag: '"source"', VersionId: 'current-version',
        Metadata: { owner: 'example' }, ContentType: 'text/plain',
      };
    }
    if (command instanceof GetObjectTaggingCommand) {
      assert.equal(command.input.VersionId, undefined);
      return { TagSet: [{ Key: 'a b', Value: 'x&y' }] };
    }
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload' };
    if (command instanceof UploadPartCopyCommand) return { CopyPartResult: { ETag: '"part"' } };
    return {};
  });
  await copyObjects(client, readInputs(env));
  const createCommand = client.calls.find((c) => c instanceof CreateMultipartUploadCommand);
  assert.ok(createCommand);
  const create = createCommand.input;
  assert.deepEqual(create.Metadata, { owner: 'example' });
  assert.equal(create.ContentType, 'text/plain');
  assert.equal(create.Tagging, 'a%20b=x%26y');
  assert.equal(create.ServerSideEncryption, undefined);
  const parts = client.calls.filter((c) => c instanceof UploadPartCopyCommand);
  assert.equal(parts.length, 11);
  assert.equal(parts[0]?.input.CopySourceRange, 'bytes=0-536870911');
  assert.equal(parts.at(-1)?.input.CopySourceRange, `bytes=${size - 1}-${size - 1}`);
  assert.ok(parts.every((part) => part.input.CopySourceIfMatch === '"source"'));
  const complete = client.calls.at(-1);
  assert.ok(complete instanceof CompleteMultipartUploadCommand);
  assert.deepEqual(complete.input.MultipartUpload?.Parts,
    Array.from({ length: 11 }, (_, index) => ({ ETag: '"part"', PartNumber: index + 1 })));
});

test('5 GiB uses CopyObject; larger objects use multipart and abort on errors', async () => {
  const client = mockClient((command) => command instanceof HeadObjectCommand
    ? { ContentLength: 5 * 1024 ** 3, ETag: '"source"' }
    : {});
  await copyObjects(client, readInputs(env));
  assert.ok(client.calls.at(-1) instanceof CopyObjectCommand);

  const failure = new Error('AccessDenied');
  const failing = mockClient((command) => {
    if (command instanceof HeadObjectCommand) return { ContentLength: 5 * 1024 ** 3 + 1, ETag: '"source"' };
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'upload' };
    if (command instanceof UploadPartCopyCommand) throw failure;
    return {};
  });
  await assert.rejects(copyObjects(failing, readInputs(env)), (error) => error === failure);
  assert.ok(failing.calls.at(-1) instanceof AbortMultipartUploadCommand);
});

test('AWS failures and malformed pagination are not converted to success', async () => {
  const failure = new Error('KMS AccessDenied');
  await assert.rejects(copyObjects(mockClient(() => { throw failure; }), readInputs(env)),
    (error) => error === failure);
  await assert.rejects(copyObjects(mockClient(() => ({ IsTruncated: true })),
    readInputs({ ...env, RECURSIVE: 'true' })), /continuation token/);
});

function capture(level: 'DEBUG' | 'INFO' = 'INFO') {
  const lines: string[] = [];
  const logger = createLogger('s3-copy', { level, stdout: (l) => lines.push(l), stderr: (l) => lines.push(l) });
  const entries = () => lines.map((l) => JSON.parse(l) as { level: string; message: string; context?: Record<string, unknown> });
  return { logger, lines, entries };
}

const awsError = (name: string, status: number, requestId: string) =>
  Object.assign(new Error(`${name} for AKIAABCDEFGHIJKLMNOP`), { name, $metadata: { httpStatusCode: status, requestId } });

test('logs initialization, success and totals without object keys at INFO', async () => {
  const { logger, lines, entries } = capture();
  const client = mockClient((c) => c instanceof HeadObjectCommand ? { ContentLength: 12, ETag: '"e"' } : {});
  const result = await copyObjects(client, readInputs(env), { logger });
  assert.equal(result.bytesCopied, 12);
  const [start, ...rest] = entries();
  assert.equal(start?.message, 'Transfer started');
  assert.equal(start?.context?.sourceBucket, 'example-source');
  assert.equal(start?.context?.destinationBucket, 'example-destination');
  assert.equal(start?.context?.mode, 'single-object');
  assert.ok(typeof start?.context?.startedAt === 'string');
  const done = rest.at(-1);
  assert.equal(done?.message, 'Transfer completed');
  assert.deepEqual([done?.context?.status, done?.context?.objectsCopied, done?.context?.bytesCopied],
    ['success', 1, 12]);
  assert.ok(typeof done?.context?.durationMs === 'number');
  assert.ok(rest.some((e) => e.message === 'Source object validated' && e.context?.sizeBytes === 12));
  assert.ok(!lines.join('\n').includes('monthly.csv'));
});

test('object keys appear only at DEBUG', async () => {
  const { logger, lines } = capture('DEBUG');
  const client = mockClient((c) => c instanceof HeadObjectCommand ? { ContentLength: 1, ETag: '"e"' } : {});
  await copyObjects(client, readInputs(env), { logger });
  assert.ok(lines.join('\n').includes('reports/monthly.csv'));
});

test('recursive transfers log listing progress and a summary', async () => {
  const { logger, entries } = capture();
  const client = mockClient((c) => {
    if (c instanceof ListObjectsV2Command) return { Contents: [{ Key: 'p/a' }, { Key: 'p/b' }] };
    return c instanceof HeadObjectCommand ? { ContentLength: 5, ETag: '"e"' } : {};
  });
  await copyObjects(client, readInputs({ ...env, RECURSIVE: 'true', SOURCE_KEY: 'p/' }), { logger });
  const all = entries();
  assert.ok(all.some((e) => e.message === 'Listing page received' && e.context?.objectsInPage === 2));
  assert.equal(all.at(-1)?.context?.objectsCopied, 2);
  assert.equal(all.at(-1)?.context?.bytesCopied, 10);
  assert.equal(all.at(-1)?.context?.mode, 'recursive');
});

test('missing source is reported once with AWS metadata and the original error is rethrown', async () => {
  const { logger, entries, lines } = capture();
  const failure = awsError('NotFound', 404, 'REQ123');
  const progress = { objectsCopied: 0, bytesCopied: 0 };
  await assert.rejects(
    copyObjects(mockClient(() => { throw failure; }), readInputs(env), { logger, progress }),
    (error) => error === failure,
  );
  const errors = entries().filter((e) => e.level === 'ERROR');
  assert.equal(errors.length, 1);
  assert.deepEqual(
    [errors[0]?.context?.errorCategory, errors[0]?.context?.operation, errors[0]?.context?.httpStatusCode, errors[0]?.context?.requestId],
    ['SourceNotFound', 'HeadObject', 404, 'REQ123'],
  );
  assert.match(String(errors[0]?.context?.errorMessage), /Source object not found or inaccessible/);
  assert.ok(wasLogged(failure));
  assert.ok(!lines.join('\n').includes('AKIAABCDEFGHIJKLMNOP'));
});

test('a 404 from CopyObject is a copy failure, not a missing source', async () => {
  const { logger, entries } = capture();
  const failure = awsError('NoSuchBucket', 404, 'REQ9');
  const client = mockClient((c) => {
    if (c instanceof HeadObjectCommand) return { ContentLength: 1, ETag: '"e"' };
    throw failure;
  });
  await assert.rejects(copyObjects(client, readInputs(env), { logger }));
  const error = entries().find((e) => e.level === 'ERROR');
  assert.equal(error?.context?.errorCategory, 'CopyFailed');
  assert.equal(error?.context?.operation, 'CopyObject');
  assert.equal(classifyFailure('ListObjectsV2', failure), 'SourceListFailed');
});

test('multipart copy logs progress and abort failures', async () => {
  const { logger, entries } = capture('DEBUG');
  const size = 5 * 1024 ** 3 + 1;
  const ok = mockClient((c) => {
    if (c instanceof HeadObjectCommand) return { ContentLength: size, ETag: '"e"' };
    if (c instanceof CreateMultipartUploadCommand) return { UploadId: 'up' };
    if (c instanceof UploadPartCopyCommand) return { CopyPartResult: { ETag: '"p"' } };
    return {};
  });
  const result = await copyObjects(ok, readInputs(env), { logger });
  assert.equal(result.bytesCopied, size);
  const messages = entries().map((e) => e.message);
  assert.ok(messages.includes('Multipart upload initiated'));
  assert.equal(messages.filter((m) => m === 'Multipart part copied').length, 11);
  assert.ok(messages.includes('Multipart upload completed'));

  const second = capture();
  const failure = awsError('AccessDenied', 403, 'R1');
  const failing = mockClient((c) => {
    if (c instanceof HeadObjectCommand) return { ContentLength: size, ETag: '"e"' };
    if (c instanceof CreateMultipartUploadCommand) return { UploadId: 'up' };
    if (c instanceof GetObjectTaggingCommand) return { TagSet: [] };
    if (c instanceof AbortMultipartUploadCommand) throw awsError('InternalError', 500, 'R2');
    throw failure;
  });
  await assert.rejects(copyObjects(failing, readInputs(env), { logger: second.logger }), (e) => e === failure);
  const abort = second.entries().find((e) => e.message === 'Failed to abort multipart upload');
  assert.equal(abort?.context?.requestId, 'R2');
  assert.equal(second.entries().filter((e) => e.message === 'S3 transfer failed').length, 1);
});

test('logs never contain credentials found in error details', async () => {
  const { logger, lines } = capture('DEBUG');
  const failure = Object.assign(new Error('denied Bearer abc.def token=1'), {
    name: 'AccessDenied', $metadata: { httpStatusCode: 403 }, authorization: 'secret-value',
  });
  await assert.rejects(copyObjects(mockClient(() => { throw failure; }), readInputs(env), { logger }));
  const output = lines.join('\n');
  assert.ok(!output.includes('abc.def'));
  assert.ok(!output.includes('secret-value'));
});
