import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BridgeError } from '../shared/errors.js';
import { assertSafeAudioUrl } from '../netease/policy.js';

const MAX_REDIRECTS = 5;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff')
  );
}

export async function assertPublicHttpsUrl(urlValue: string): Promise<URL> {
  const normalized = assertSafeAudioUrl(urlValue);
  const url = new URL(normalized);
  const literalKind = isIP(url.hostname);
  const addresses = literalKind
    ? [{ address: url.hostname, family: literalKind }]
    : await lookup(url.hostname, { all: true, verbatim: true });

  if (addresses.length === 0) {
    throw new BridgeError('UNSAFE_UPSTREAM', 'Upstream hostname did not resolve', {
      httpStatus: 502,
    });
  }

  for (const record of addresses) {
    const blocked =
      record.family === 4
        ? isPrivateIpv4(record.address)
        : isPrivateIpv6(record.address);
    if (blocked) {
      throw new BridgeError(
        'UNSAFE_UPSTREAM',
        'Upstream resolved to a private or reserved address',
        { httpStatus: 502, details: { hostname: url.hostname } },
      );
    }
  }
  return url;
}

export type GatewayFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export const secureGatewayFetch: GatewayFetch = async (
  initialUrl,
  initialInit,
): Promise<Response> => {
  let current = await assertPublicHttpsUrl(initialUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current, {
      ...initialInit,
      redirect: 'manual',
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new BridgeError(
        'STREAM_UPSTREAM_FAILED',
        `Upstream redirect ${response.status} had no Location header`,
        { httpStatus: 502 },
      );
    }
    if (redirectCount === MAX_REDIRECTS) {
      throw new BridgeError('STREAM_UPSTREAM_FAILED', 'Too many upstream redirects', {
        httpStatus: 502,
      });
    }

    current = await assertPublicHttpsUrl(new URL(location, current).toString());
  }

  throw new BridgeError('STREAM_UPSTREAM_FAILED', 'Redirect handling failed', {
    httpStatus: 502,
  });
};
