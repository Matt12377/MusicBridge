import { BridgeError } from '../shared/errors.js';
import { enforceNeteaseSafetyEnvironment, parseQualityPreference } from '../netease/policy.js';
import {
  REMOTE_CORE_LOCAL_PORT_PAIRS,
  REMOTE_CORE_STREAM_PORT_CANDIDATES,
  type RemoteCoreMode,
} from '@music-bridge/contracts';
import type { PlaybackQualityPreference } from '@music-bridge/contracts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BridgeConfig {
  mode: RemoteCoreMode;
  controlHost: string;
  controlPort: number;
  streamHost: string;
  streamPort: number;
  publicStreamBaseUrl: string;
  remoteStreamPort?: number;
  roonCoreHost?: string;
  roonCorePort?: number;
  neteaseCookie?: string;
  defaultQuality: PlaybackQualityPreference;
  logLevel: LogLevel;
}

export const REMOTE_STREAM_PORT_CANDIDATES = REMOTE_CORE_STREAM_PORT_CANDIDATES;
export const REMOTE_ROON_CORE_HOST = '127.0.0.1' as const;
export const LOCAL_ROON_CORE_PORT = 19330 as const;
export const DIRECT_ROON_CORE_PORT = 9330 as const;

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

  const modeValue = env.MUSIC_BRIDGE_REMOTE_CORE_MODE?.trim() || 'local-core';
  if (modeValue !== 'local-core' && modeValue !== 'remote-core-development') {
    throw new BridgeError('CONFIG_INVALID', 'Invalid MUSIC_BRIDGE_REMOTE_CORE_MODE', {
      httpStatus: 500,
    });
  }
  const mode = modeValue as RemoteCoreMode;

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

  let remoteStreamPort: number | undefined;
  let roonCoreHost: string | undefined;
  let roonCorePort: number | undefined;
  if (mode === 'remote-core-development') {
    remoteStreamPort = parsePort(
      env.MUSIC_BRIDGE_REMOTE_STREAM_PORT,
      REMOTE_STREAM_PORT_CANDIDATES[0]!,
      'MUSIC_BRIDGE_REMOTE_STREAM_PORT',
    );
    if (!REMOTE_STREAM_PORT_CANDIDATES.includes(remoteStreamPort)) {
      throw new BridgeError(
        'CONFIG_INVALID',
        'Remote Core development mode requires a bounded remote stream port',
        { httpStatus: 500 },
      );
    }
    const localPortPair = Object.values(REMOTE_CORE_LOCAL_PORT_PAIRS).some(
      (pair) => pair.controlPort === controlPort && pair.streamPort === streamPort,
    );
    if (controlHost !== '127.0.0.1' || streamHost !== '127.0.0.1' || !localPortPair) {
      throw new BridgeError(
        'CONFIG_INVALID',
        'Remote Core development mode requires a bounded loopback Core port pair',
        { httpStatus: 500 },
      );
    }
    if (
      parsedPublicBase.hostname !== '127.0.0.1' ||
      parsedPublicBase.port !== String(remoteStreamPort) ||
      parsedPublicBase.username !== '' ||
      parsedPublicBase.password !== '' ||
      parsedPublicBase.pathname !== '/' ||
      parsedPublicBase.search !== '' ||
      parsedPublicBase.hash !== ''
    ) {
      throw new BridgeError(
        'CONFIG_INVALID',
        'Remote Core development public stream base must stay on the selected loopback port',
        { httpStatus: 500 },
      );
    }
    roonCoreHost = env.ROON_CORE_HOST?.trim() || REMOTE_ROON_CORE_HOST;
    if (roonCoreHost !== REMOTE_ROON_CORE_HOST && roonCoreHost !== '::1') {
      throw new BridgeError(
        'CONFIG_INVALID',
        'Remote Core development Roon host must stay on loopback',
        { httpStatus: 500 },
      );
    }
    roonCorePort = parsePort(env.ROON_CORE_PORT, LOCAL_ROON_CORE_PORT, 'ROON_CORE_PORT');
    if (roonCorePort !== LOCAL_ROON_CORE_PORT) {
      throw new BridgeError(
        'CONFIG_INVALID',
        'Remote Core development Roon port must use the fixed local tunnel port',
        { httpStatus: 500 },
      );
    }
  } else if (env.ROON_CORE_HOST?.trim() || env.ROON_CORE_PORT?.trim()) {
    roonCoreHost = env.ROON_CORE_HOST?.trim() || REMOTE_ROON_CORE_HOST;
    if (roonCoreHost !== REMOTE_ROON_CORE_HOST && roonCoreHost !== '::1') {
      throw new BridgeError(
        'CONFIG_INVALID',
        'Direct Roon Core host must stay on loopback',
        { httpStatus: 500 },
      );
    }
    roonCorePort = parsePort(env.ROON_CORE_PORT, DIRECT_ROON_CORE_PORT, 'ROON_CORE_PORT');
  }

  const quality = parseQualityPreference(env.NETEASE_DEFAULT_QUALITY ?? 'auto');
  const cookie = env.NETEASE_COOKIE?.trim();

  return {
    mode,
    controlHost,
    controlPort,
    streamHost,
    streamPort,
    publicStreamBaseUrl,
    ...(remoteStreamPort !== undefined ? { remoteStreamPort } : {}),
    ...(roonCoreHost !== undefined ? { roonCoreHost } : {}),
    ...(roonCorePort !== undefined ? { roonCorePort } : {}),
    defaultQuality: quality,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    ...(cookie ? { neteaseCookie: cookie } : {}),
  };
}
