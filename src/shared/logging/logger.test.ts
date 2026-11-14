import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger, isSensitiveKey, parseLogLevel, type LogLevel } from './logger.ts';

function setup(level?: LogLevel, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const logger = createLogger('unit', {
    ...(level ? { level } : {}),
    env,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    now: () => new Date('2024-01-02T03:04:05.678Z'),
  });
  return { logger, out, err };
}

test('emits structured JSON with ISO timestamp, level, component and context', () => {
  const { logger, out } = setup();
  logger.info('hello', { count: 2, nested: { ok: true } });
  assert.deepEqual(JSON.parse(out[0] ?? ''), {
    timestamp: '2024-01-02T03:04:05.678Z',
    level: 'INFO',
    component: 'unit',
    message: 'hello',
    context: { count: 2, nested: { ok: true } },
  });
  logger.info('bare');
  assert.equal('context' in JSON.parse(out[1] ?? ''), false);
});

test('routes levels to stdout/stderr and filters below the minimum (default INFO)', () => {
  const { logger, out, err } = setup();
  logger.debug('d');
  logger.info('i');
  logger.warn('w');
  logger.error('e');
  assert.deepEqual(out.map((l) => JSON.parse(l).level), ['INFO']);
  assert.deepEqual(err.map((l) => JSON.parse(l).level), ['WARN', 'ERROR']);

  const debug = setup('DEBUG');
  debug.logger.debug('d');
  assert.equal(debug.out.length, 1);
  const error = setup('ERROR');
  error.logger.warn('w');
  error.logger.error('e');
  assert.equal(error.err.length, 1);
});

test('reads LOG_LEVEL from the environment and ignores invalid values', () => {
  const debug = setup(undefined, { LOG_LEVEL: 'debug' });
  debug.logger.debug('d');
  assert.equal(debug.out.length, 1);
  const invalid = setup(undefined, { LOG_LEVEL: 'loud' });
  invalid.logger.debug('d');
  assert.equal(invalid.out.length, 0);
  assert.equal(parseLogLevel('Warn'), 'WARN');
});

test('redacts sensitive keys case-insensitively in nested objects and arrays', () => {
  const { logger, out } = setup();
  logger.info('x', {
    AccessKeyId: 'a', SecretAccessKey: 'b', sessionToken: 'c', GITHUB_TOKEN: 'd',
    headers: { Authorization: 'Bearer zzz', accept: 'json' },
    list: [{ password: 'p', keep: 1 }],
    Body: 'object contents',
  });
  const line = out[0] ?? '';
  for (const secret of ['"a"', '"b"', '"c"', '"d"', 'zzz', '"p"', 'object contents']) {
    assert.ok(!line.includes(secret), secret);
  }
  const { context } = JSON.parse(line);
  assert.equal(context.headers.accept, 'json');
  assert.equal(context.list[0].keep, 1);
  assert.equal(context.AccessKeyId, '[REDACTED]');
  assert.ok(isSensitiveKey('x-api-key'));
  assert.ok(!isSensitiveKey('bucket'));
});

test('redacts secret-looking values inside strings', () => {
  const { logger, out } = setup();
  logger.info('key AKIAABCDEFGHIJKLMNOP', { note: `ghp_${'a'.repeat(36)} Bearer tok.en` });
  assert.ok(!/AKIA|ghp_|tok\.en/.test(out[0] ?? ''));
});

test('serializes errors including causes', () => {
  const { logger, err } = setup();
  logger.error('failed', { error: new Error('outer', { cause: new TypeError('inner') }) });
  const { error } = JSON.parse(err[0] ?? '').context;
  assert.equal(error.name, 'Error');
  assert.equal(error.message, 'outer');
  assert.equal(error.cause.name, 'TypeError');
  assert.ok(typeof error.stack === 'string');
});

test('handles circular references and shared (non-circular) references', () => {
  const { logger, out } = setup();
  const loop: Record<string, unknown> = { name: 'loop' };
  loop.self = loop;
  const shared = { v: 1 };
  logger.info('c', { loop, a: shared, b: shared });
  const { context } = JSON.parse(out[0] ?? '');
  assert.equal(context.loop.self, '[Circular]');
  assert.deepEqual(context.b, { v: 1 });
});

test('serialization failures never throw and still emit a minimal entry', () => {
  const { logger, out } = setup();
  const hostile = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
  assert.doesNotThrow(() => logger.info('bad', hostile as Record<string, unknown>));
  const getter = { get value(): string { throw new Error('nope'); } };
  assert.doesNotThrow(() => logger.info('getter', { getter }));
  assert.equal(JSON.parse(out[0] ?? '').serializationError, true);
  assert.equal(JSON.parse(out[1] ?? '').context.getter.value, '[Unreadable]');

  const throwing = createLogger('unit', { stdout: () => { throw new Error('closed'); } });
  assert.doesNotThrow(() => throwing.info('x'));
});

test('summarizes binary data, bigint and dates', () => {
  const { logger, out } = setup();
  logger.info('t', { data: new Uint8Array(4), big: 10n, when: new Date(0) });
  const { context } = JSON.parse(out[0] ?? '');
  assert.deepEqual(context, { data: '[Binary 4 bytes]', big: '10', when: '1970-01-01T00:00:00.000Z' });
});
