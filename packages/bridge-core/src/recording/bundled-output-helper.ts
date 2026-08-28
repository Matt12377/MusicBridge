import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { outputCheckFail } from './output-error.js';

export interface PinnedOutputHelper {
  readonly path: string; readonly sha256: string; readonly manifestPath: string; readonly manifestSha256: string;
  readonly halAdapterPath: string; readonly halAdapterSha256: string;
}
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
async function regularBytes(file: string, limit: number, executable = false): Promise<Buffer> {
  if (!path.isAbsolute(file) || await realpath(file) !== file) return outputCheckFail('HELPER_CHANGED');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); const deadline = performance.now() + 10_000;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(limit) || (before.mode & 0o022n) !== 0n || (executable && !(before.mode & 0o100n))) return outputCheckFail('HELPER_CHANGED');
    const result = Buffer.alloc(Number(before.size)); let position = 0;
    while (position < result.length) {
      if (performance.now() > deadline) return outputCheckFail('TIMEOUT');
      const read = await handle.read(result, position, Math.min(1024 * 1024, result.length - position), position);
      if (!read.bytesRead) return outputCheckFail('HELPER_CHANGED'); position += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    // FD可能仍指向被移动目录里的旧文件，须同时核对当前路径的身份。
    if (!named.isFile() || [after, named].some(value => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'].some(key => before[key as keyof typeof before] !== value[key as keyof typeof value]))) return outputCheckFail('HELPER_CHANGED');
    if (await realpath(file) !== file) return outputCheckFail('HELPER_CHANGED'); return result;
  } finally { await handle.close(); }
}
/** 清单pin只能来自应用编译期；缺包不查PATH、不下载、不回退。加载不执行设备或helper。 */
export async function loadBundledOutputHelper(root: string, expectedHash: string | null): Promise<PinnedOutputHelper | undefined> {
  if (expectedHash === null) return undefined;
  try {
    if (!hash(expectedHash) || !path.isAbsolute(root) || await realpath(root) !== root) return outputCheckFail('HELPER_CHANGED');
    const manifestPath = path.join(root, 'manifest.json'), bytes = await regularBytes(manifestPath, 64 * 1024);
    if (digest(bytes) !== expectedHash) return outputCheckFail('HELPER_CHANGED');
    const m: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(m) || !keys(m, ['schemaVersion', 'platform', 'arch', 'protocolVersion', 'backendId', 'backendVersion', 'mode', 'files', 'sourceSha256'])
      || m.schemaVersion !== 1 || m.platform !== 'darwin' || m.arch !== 'arm64' || m.protocolVersion !== 1 || m.backendId !== 'musicbridge-coreaudio-hal' || m.backendVersion !== '0.1.0' || m.mode !== 'synthetic-only' || !hash(m.sourceSha256)
      || !object(m.files) || !keys(m.files, ['helper', 'halAdapter'])) return outputCheckFail('HELPER_CHANGED');
    const helper = m.files.helper, hal = m.files.halAdapter;
    if (!object(helper) || !keys(helper, ['path', 'sha256']) || helper.path !== 'bin/output-helper' || !hash(helper.sha256)
      || !object(hal) || !keys(hal, ['path', 'sha256']) || hal.path !== 'build/core-audio-adapter.o' || !hash(hal.sha256)) return outputCheckFail('HELPER_CHANGED');
    const pin: PinnedOutputHelper = Object.freeze({ path: path.join(root, helper.path), sha256: helper.sha256, manifestPath, manifestSha256: expectedHash, halAdapterPath: path.join(root, hal.path), halAdapterSha256: hal.sha256 });
    await verifyPinnedOutputHelper(pin); return pin;
  } catch { return outputCheckFail('HELPER_CHANGED'); }
}
export async function verifyPinnedOutputHelper(pin: PinnedOutputHelper): Promise<void> {
  try {
    for (const [file, expected, limit, executable] of [[pin.manifestPath, pin.manifestSha256, 64 * 1024, false], [pin.path, pin.sha256, 16 * 1024 * 1024, true], [pin.halAdapterPath, pin.halAdapterSha256, 16 * 1024 * 1024, false]] as const)
      if (!hash(expected) || digest(await regularBytes(file, limit, executable)) !== expected) return outputCheckFail('HELPER_CHANGED');
  } catch { return outputCheckFail('HELPER_CHANGED'); }
}
