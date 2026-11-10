import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mobileConnectionAddressKind } from '@music-bridge/contracts';

/** CLI output is untrusted/private. Project only one actual local IPv4; never return peer/account/AuthURL data. */
export function captureMobileTailscaleAddress(status: unknown, localAddresses: readonly string[]): string | null {
  try {
    if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
    const fields = Object.getOwnPropertyDescriptors(status), self: unknown = fields.Self?.value;
    if (fields.BackendState?.value !== 'Running' || !self || typeof self !== 'object' || Array.isArray(self)) return null;
    const addresses: unknown = Object.getOwnPropertyDescriptor(self, 'TailscaleIPs')?.value;
    if (!Array.isArray(addresses) || Object.getPrototypeOf(addresses) !== Array.prototype || addresses.length > 16
      || Reflect.ownKeys(addresses).length !== addresses.length + 1) return null;
    for (let index = 0; index < addresses.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(addresses, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      const address: unknown = descriptor.value;
      if (typeof address === 'string' && mobileConnectionAddressKind(address) === 'tailscale' && localAddresses.includes(address)) return address;
    }
  } catch { /* A malformed probe can never grant a bind address. */ }
  return null;
}
let preferredExecutable: string | undefined;

/** Read-only external prerequisite probe: no login, up, install, configuration, or shell invocation. */
export async function detectMobileTailscaleAddress(localAddresses: readonly string[]): Promise<string | null> {
  if (!localAddresses.some(address => mobileConnectionAddressKind(address) === 'tailscale')) return null;
  // Only the fixed executable name is resolved in the trusted Main process environment, never from phone input.
  const candidates = [...new Set([
    ...(preferredExecutable ? [preferredExecutable] : []),
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    path.join(os.homedir(), 'Applications/Tailscale.app/Contents/MacOS/Tailscale'),
    '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale',
    ...(process.env.PATH ?? '').split(path.delimiter).filter(value => path.isAbsolute(value)).map(value => path.join(value, 'tailscale')),
  ])].slice(0, 24);
  let attempts = 0;
  for (const executable of candidates) {
    if (attempts >= 3) break;
    try { await access(executable, constants.X_OK); } catch { continue; }
    attempts++;
    const status = await new Promise<unknown>(resolve => {
      execFile(executable, ['status', '--json'], { timeout: 1200, maxBuffer: 512 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        if (error) { resolve(null); return; }
        try { resolve(JSON.parse(stdout) as unknown); } catch { resolve(null); }
      });
    });
    const address = captureMobileTailscaleAddress(status, localAddresses);
    if (address) { preferredExecutable = executable; return address; }
  }
  return null;
}
