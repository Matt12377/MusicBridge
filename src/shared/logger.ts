type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SECRET_KEY_PATTERN = /(cookie|token|authorization|secret|password|url)/i;
const COOKIE_PATTERN = /(?:MUSIC_U|__csrf|MUSIC_A|MUSIC_R_T|MUSIC_R_I)=[^;\s]*/gi;
const SIGNED_QUERY_PATTERN = /([?&](?:token|auth|signature|sign|key|expires?)=)[^&\s]+/gi;

function redactString(value: string): string {
  return value
    .replace(COOKIE_PATTERN, '[REDACTED_COOKIE]')
    .replace(SIGNED_QUERY_PATTERN, '$1[REDACTED]');
}

function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redact(childValue, childKey);
    }
    return output;
  }
  return value;
}

function shouldLog(level: LogLevel, configured: LogLevel): boolean {
  const order: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  return order[level] >= order[configured];
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(configuredLevel: LogLevel = 'info'): Logger {
  const emit = (
    level: LogLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): void => {
    if (!shouldLog(level, configuredLevel)) return;
    const redactedFields = redact(fields) as Record<string, unknown>;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...redactedFields,
    };
    const line = JSON.stringify(record);
    if (level === 'error' || level === 'warn') {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
