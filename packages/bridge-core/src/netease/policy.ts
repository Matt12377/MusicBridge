import { isIP } from 'node:net';
import { BridgeError } from '../shared/errors.js';
import {
  QUALITY_LEVELS,
  type QualityLevel,
  type TransportSecurity,
} from './types.js';

const FORBIDDEN_TRUE_ENV_VARS = [
  'ENABLE_GENERAL_UNBLOCK',
  'ENABLE_PROXY',
  'ENABLE_RANDOM_CN_IP',
] as const;

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function enforceNeteaseSafetyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const variable of FORBIDDEN_TRUE_ENV_VARS) {
    if (isTruthy(env[variable])) {
      throw new BridgeError(
        'CONFIG_INVALID',
        `${variable} must remain false. Music Bridge does not permit unblock, replacement-source, proxy-unlock, or random-IP behavior.`,
        { httpStatus: 500, details: { variable } },
      );
    }
    env[variable] = 'false';
  }
}

export function parseQuality(value: unknown): QualityLevel {
  if (typeof value !== 'string') {
    throw new BridgeError('BAD_REQUEST', 'quality must be a string', {
      httpStatus: 400,
    });
  }
  if (!QUALITY_LEVELS.includes(value as QualityLevel)) {
    throw new BridgeError(
      'BAD_REQUEST',
      `Unsupported quality: ${value}. Allowed: ${QUALITY_LEVELS.join(', ')}`,
      { httpStatus: 400 },
    );
  }
  return value as QualityLevel;
}

export function normalizeTrackId(value: unknown): string {
  const trackId = typeof value === 'number' ? String(value) : value;
  if (typeof trackId !== 'string' || !/^\d+$/.test(trackId)) {
    throw new BridgeError('BAD_REQUEST', 'trackId must be a positive numeric ID', {
      httpStatus: 400,
    });
  }
  if (trackId === '0') {
    throw new BridgeError('BAD_REQUEST', 'trackId must be greater than zero', {
      httpStatus: 400,
    });
  }
  return trackId;
}

export function assertSafeAudioUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BridgeError('TRACK_UNAVAILABLE', 'NetEase returned no playable URL', {
      httpStatus: 409,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new BridgeError('UNSAFE_UPSTREAM', 'NetEase returned an invalid URL', {
      cause: error,
      httpStatus: 502,
    });
  }

  if (parsed.protocol !== 'https:') {
    throw new BridgeError(
      'UNSAFE_UPSTREAM',
      'Only HTTPS audio upstreams are permitted',
      { httpStatus: 502 },
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '::1'
  ) {
    throw new BridgeError('UNSAFE_UPSTREAM', 'Local upstream URLs are forbidden', {
      httpStatus: 502,
    });
  }

  if (isIP(hostname) !== 0 && isObviouslyPrivateIp(hostname)) {
    throw new BridgeError('UNSAFE_UPSTREAM', 'Private upstream IPs are forbidden', {
      httpStatus: 502,
    });
  }

  return parsed.toString();
}

export function resolveNeteaseAudioUrl(value: unknown): {
  upstreamUrl: string;
  transportSecurity: TransportSecurity;
} {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BridgeError('TRACK_UNAVAILABLE', 'NetEase returned no playable URL', {
      httpStatus: 409,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new BridgeError('UNSAFE_UPSTREAM', 'NetEase returned an invalid URL', {
      cause: error,
      httpStatus: 502,
    });
  }

  if (parsed.protocol === 'https:') {
    return {
      upstreamUrl: assertSafeAudioUrl(parsed.toString()),
      transportSecurity: 'https-native',
    };
  }

  if (parsed.protocol !== 'http:') {
    throw new BridgeError(
      'UNSAFE_UPSTREAM',
      'Only HTTPS audio upstreams or approved NetEase HTTP candidates are permitted',
      { httpStatus: 502 },
    );
  }

  const trimmedValue = value.trim();
  const authority = /^https?:\/\/([^/?#]*)/i.exec(trimmedValue)?.[1] ?? '';
  if (
    parsed.username ||
    parsed.password ||
    authority.includes('@') ||
    parsed.hash ||
    trimmedValue.includes('#')
  ) {
    throw new BridgeError(
      'UNSAFE_UPSTREAM',
      'NetEase HTTP upgrade candidates cannot contain userinfo or fragments',
      { httpStatus: 502 },
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const ipLiteral = isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;
  const isNeteaseCdn =
    hostname === 'music.126.net' || hostname.endsWith('.music.126.net');
  if (ipLiteral || !isNeteaseCdn) {
    throw new BridgeError(
      'UNSAFE_UPSTREAM',
      'Only NetEase CDN HTTP candidates may be upgraded to HTTPS',
      { httpStatus: 502 },
    );
  }

  if (parsed.port !== '' && parsed.port !== '80') {
    throw new BridgeError(
      'UNSAFE_UPSTREAM',
      'NetEase HTTP upgrade candidates must use the default port',
      { httpStatus: 502 },
    );
  }

  if (parsed.port === '80') parsed.port = '';
  parsed.protocol = 'https:';
  return {
    upstreamUrl: assertSafeAudioUrl(parsed.toString()),
    transportSecurity: 'https-upgraded',
  };
}

function isObviouslyPrivateIp(hostname: string): boolean {
  if (hostname.includes(':')) {
    const normalized = hostname.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }

  const parts = hostname.split('.').map(Number);
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}
