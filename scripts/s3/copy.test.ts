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
import { copyObjects, readInputs } from './copy.ts';

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
  assert.equal(copied, 2);
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
    assert.equal(await copyObjects(client, readInputs({
      ...env, RECURSIVE: 'true', SOURCE_KEY: '', DESTINATION_KEY: '',
    })), contents.length);
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
