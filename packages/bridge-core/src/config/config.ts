import { BridgeError } from '../shared/errors.js';
import { enforceNeteaseSafetyEnvironment, parseQuality } from '../netease/policy.js';
import type { QualityLevel } from '../netease/types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BridgeConfig {
  controlHost: string;
  controlPort: number;
  streamHost: string;
  streamPort: number;
  publicStreamBaseUrl: string;
  neteaseCookie?: string;
  defaultQuality: QualityLevel;
  logLevel: LogLevel;
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new BridgeError('CONFIG_INVALID', `${name} must be a TCP port`, {
      httpStatus: 500,
    });
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = (value ?? 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new BridgeError('CONFIG_INVALID', `Invalid LOG_LEVEL: ${value}`, {
      httpStatus: 500,
    });
  }
  return level as LogLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  enforceNeteaseSafetyEnvironment(env);

  const controlHost = env.BRIDGE_CONTROL_HOST?.trim() || '127.0.0.1';
  const streamHost = env.BRIDGE_STREAM_HOST?.trim() || '127.0.0.1';
  const controlPort = parsePort(env.BRIDGE_CONTROL_PORT, 38501, 'BRIDGE_CONTROL_PORT');
  const streamPort = parsePort(env.BRIDGE_STREAM_PORT, 38502, 'BRIDGE_STREAM_PORT');

  if (controlHost !== '127.0.0.1' && controlHost !== '::1') {
    throw new BridgeError(
      'CONFIG_INVALID',
      'POC-001 control API must bind to loopback only',
      { httpStatus: 500, details: { controlHost } },
    );
  }
  if (streamHost !== '127.0.0.1' && streamHost !== '::1') {
    throw new BridgeError(
      'CONFIG_INVALID',
      'POC-001 stream gateway must bind to loopback only; run it on the Roon Core Mac',
      { httpStatus: 500, details: { streamHost } },
    );
  }

  const defaultPublicBase = `http://${streamHost.includes(':') ? `[${streamHost}]` : streamHost}:${streamPort}`;
  const publicStreamBaseUrl = (
    env.BRIDGE_PUBLIC_STREAM_BASE_URL?.trim() || defaultPublicBase
  ).replace(/\/$/, '');

  let parsedPublicBase: URL;
  try {
    parsedPublicBase = new URL(publicStreamBaseUrl);
  } catch (error) {
    throw new BridgeError('CONFIG_INVALID', 'Invalid BRIDGE_PUBLIC_STREAM_BASE_URL', {
      cause: error,
      httpStatus: 500,
    });
  }
  if (parsedPublicBase.protocol !== 'http:') {
    throw new BridgeError(
      'CONFIG_INVALID',
      'POC-001 public stream base must use local HTTP',
      { httpStatus: 500 },
    );
  }

  const quality = parseQuality(env.NETEASE_DEFAULT_QUALITY ?? 'lossless');
  const cookie = env.NETEASE_COOKIE?.trim();

  return {
    controlHost,
    controlPort,
    streamHost,
    streamPort,
    publicStreamBaseUrl,
    defaultQuality: quality,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    ...(cookie ? { neteaseCookie: cookie } : {}),
  };
}
