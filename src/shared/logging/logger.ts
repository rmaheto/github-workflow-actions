export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogContext = Record<string, unknown>;
export type LogSink = (line: string) => void;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export interface LoggerOptions {
  /** Minimum level to emit. Defaults to the LOG_LEVEL environment variable, then INFO. */
  level?: LogLevel;
  /** Receives DEBUG and INFO lines. Defaults to process.stdout. */
  stdout?: LogSink;
  /** Receives WARN and ERROR lines. Defaults to process.stderr. */
  stderr?: LogSink;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 8;

// Matched against lower-cased keys with non-alphanumeric characters removed.
const SENSITIVE_KEY_PARTS = [
  'password', 'passwd', 'secret', 'token', 'authorization', 'credential',
  'apikey', 'privatekey', 'accesskey', 'cookie', 'signature',
];
const SENSITIVE_KEYS = new Set(['pwd', 'auth', 'body', 'content', 'contents', 'payload']);

const SECRET_VALUE_PATTERNS: [RegExp, string][] = [
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, `$1 ${REDACTED}`],
];

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const normalized = value?.trim().toUpperCase();
  return LOG_LEVELS.find((level) => level === normalized);
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function redactString(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function serializeError(error: Error, ancestors: WeakSet<object>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: redactString(String(error.name)),
    message: redactString(String(error.message)),
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') {
    result.code = code;
  }
  if (typeof error.stack === 'string') {
    result.stack = redactString(error.stack);
  }
  if (error.cause !== undefined) {
    result.cause = sanitize(error.cause, ancestors, depth + 1);
  }
  return result;
}

function sanitizeObject(value: object, ancestors: WeakSet<object>, depth: number): Record<string, unknown> {
  // A null-prototype object keeps keys such as "__proto__" as plain data.
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
      continue;
    }
    try {
      result[key] = sanitize((value as Record<string, unknown>)[key], ancestors, depth + 1);
    } catch {
      result[key] = '[Unreadable]';
    }
  }
  return result;
}

/** Converts any value to a JSON-safe, redacted copy. Circular and over-deep references are replaced by markers. */
function sanitize(value: unknown, ancestors: WeakSet<object>, depth: number): unknown {
  switch (typeof value) {
    case 'string': return redactString(value);
    case 'number': return Number.isFinite(value) ? value : String(value);
    case 'boolean': return value;
    case 'bigint': return value.toString();
    case 'undefined': return undefined;
    case 'symbol': return redactString(value.toString());
    case 'function': return '[Function]';
  }
  if (value === null) {
    return null;
  }
  const object = value as object;
  if (ancestors.has(object)) {
    return '[Circular]';
  }
  if (depth >= MAX_DEPTH) {
    return '[MaxDepth]';
  }
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
  }
  // Binary data may be object content, so only its size is reported.
  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    return `[Binary ${object.byteLength} bytes]`;
  }
  if (object instanceof Map || object instanceof Set) {
    return `[${object instanceof Map ? 'Map' : 'Set'} ${object.size} entries]`;
  }
  ancestors.add(object);
  try {
    if (object instanceof Error) {
      return serializeError(object, ancestors, depth);
    }
    if (Array.isArray(object)) {
      return object.map((item) => sanitize(item, ancestors, depth + 1) ?? null);
    }
    return sanitizeObject(object, ancestors, depth);
  } finally {
    ancestors.delete(object);
  }
}

export function createLogger(component: string, options: LoggerOptions = {}): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level ?? parseLogLevel((options.env ?? process.env).LOG_LEVEL) ?? 'INFO');
  const stdout: LogSink = options.stdout ?? ((line) => { process.stdout.write(`${line}\n`); });
  const stderr: LogSink = options.stderr ?? ((line) => { process.stderr.write(`${line}\n`); });
  const now = options.now ?? (() => new Date());

  function write(level: LogLevel, message: string, context?: LogContext): void {
    if (LOG_LEVELS.indexOf(level) < threshold) {
      return;
    }
    let line: string;
    try {
      const entry: Record<string, unknown> = {
        timestamp: now().toISOString(),
        level,
        component,
        message: redactString(String(message)),
      };
      if (context !== undefined) {
        entry.context = sanitize(context, new WeakSet(), 0);
      }
      line = JSON.stringify(entry);
    } catch {
      // Logging must not fail the caller; emit a minimal entry instead.
      line = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        component,
        message: typeof message === 'string' ? redactString(message) : '[Unserializable message]',
        serializationError: true,
      });
    }
    try {
      (level === 'WARN' || level === 'ERROR' ? stderr : stdout)(line);
    } catch {
      // A failing output stream must not interrupt the operation being logged.
    }
  }

  return {
    debug: (message, context) => write('DEBUG', message, context),
    info: (message, context) => write('INFO', message, context),
    warn: (message, context) => write('WARN', message, context),
    error: (message, context) => write('ERROR', message, context),
  };
}
