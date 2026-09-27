import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  DEVICE_OUTPUT_BACKEND_ID, DEVICE_OUTPUT_BACKEND_VERSION, DEVICE_OUTPUT_DRAIN_ALGORITHM_ID,
  DEVICE_OUTPUT_PROTOCOL_VERSION,
} from './device-output-protocol.js';

export interface PinnedDeviceOutputHelper {
  readonly path: string; readonly sha256: string;
  readonly manifestPath: string; readonly manifestSha256: string;
  readonly sourceSha256: string; readonly drainAlgorithmId: typeof DEVICE_OUTPUT_DRAIN_ALGORITHM_ID;
}
export class DeviceOutputPinError extends Error { constructor() { super('固定正式输出 helper 身份无效。'); } }
const invalid = (): never => { throw new DeviceOutputPinError(); };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function regularBytes(file: string, limit: number, executable: boolean): Promise<Buffer> {
  if (!path.isAbsolute(file) || await realpath(file) !== file) return invalid();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit)
      || (before.mode & 0o022n) !== 0n || executable && (before.mode & 0o100n) === 0n) return invalid();
    const bytes = Buffer.alloc(Number(before.size)), deadline = performance.now() + 10_000;
    for (let position = 0; position < bytes.length;) {
      if (performance.now() >= deadline) return invalid();
      const { bytesRead } = await handle.read(bytes, position, Math.min(bytes.length - position, 1024 * 1024), position);
      if (!bytesRead) return invalid();
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    if (!named.isFile() || await realpath(file) !== file
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]
        || before[key as keyof typeof before] !== named[key as keyof typeof named])) return invalid();
    return bytes;
  } finally { await handle.close(); }
}

/** 只接受编译期 manifest pin；缺包不会查 PATH、下载或借用旧 synthetic helper。 */
export async function loadBundledDeviceOutputHelper(root: string, expectedHash: string | null): Promise<PinnedDeviceOutputHelper | undefined> {
  if (expectedHash === null) return undefined;
  try {
    if (!hash(expectedHash) || !path.isAbsolute(root) || await realpath(root) !== root) return invalid();
    const manifestPath = path.join(root, 'manifest.json');
    const bytes = await regularBytes(manifestPath, 64 * 1024, false);
    if (digest(bytes) !== expectedHash) return invalid();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(value) || !exact(value, ['schemaVersion', 'platform', 'arch', 'protocolVersion', 'backendId', 'backendVersion', 'mode', 'drainAlgorithmId', 'sourceSha256', 'files'])
      || value.schemaVersion !== 1 || value.platform !== 'darwin' || value.arch !== 'arm64'
      || value.protocolVersion !== DEVICE_OUTPUT_PROTOCOL_VERSION || value.backendId !== DEVICE_OUTPUT_BACKEND_ID
      || value.backendVersion !== DEVICE_OUTPUT_BACKEND_VERSION || value.mode !== 'device'
      || value.drainAlgorithmId !== DEVICE_OUTPUT_DRAIN_ALGORITHM_ID || !hash(value.sourceSha256)
      || !object(value.files) || !exact(value.files, ['helper'])) return invalid();
    const helper = value.files.helper;
    if (!object(helper) || !exact(helper, ['path', 'sha256']) || helper.path !== 'bin/output-device-helper' || !hash(helper.sha256)) return invalid();
    const pin: PinnedDeviceOutputHelper = Object.freeze({ path: path.join(root, helper.path), sha256: helper.sha256,
      manifestPath, manifestSha256: expectedHash, sourceSha256: value.sourceSha256,
      drainAlgorithmId: DEVICE_OUTPUT_DRAIN_ALGORITHM_ID });
    await verifyPinnedDeviceOutputHelper(pin); return pin;
  } catch { return invalid(); }
}

/** 每个run开始与child.close后都复核；旧包/替换/权限漂移不取得正式准入。 */
export async function verifyPinnedDeviceOutputHelper(pin: PinnedDeviceOutputHelper): Promise<void> {
  try {
    if (!hash(pin.manifestSha256) || !hash(pin.sha256) || !hash(pin.sourceSha256)
      || pin.drainAlgorithmId !== DEVICE_OUTPUT_DRAIN_ALGORITHM_ID
      || digest(await regularBytes(pin.manifestPath, 64 * 1024, false)) !== pin.manifestSha256
      || digest(await regularBytes(pin.path, 16 * 1024 * 1024, true)) !== pin.sha256) return invalid();
  } catch { return invalid(); }
}
