import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const LOCAL_AUDIO_TAG_FORMATS = ['flac', 'alac', 'mp3', 'vorbis', 'opus', 'wavpack', 'pcm-wav', 'pcm-aiff'] as const;
export type LocalAudioTagFormat = typeof LOCAL_AUDIO_TAG_FORMATS[number];
export const LOCAL_AUDIO_TAG_KEYS = ['TITLE', 'ARTIST', 'ALBUM', 'DATE', 'DISCNUMBER', 'TRACKNUMBER', 'LYRICS', 'PICTURE'] as const;
export type LocalAudioTagValues = Partial<Record<typeof LOCAL_AUDIO_TAG_KEYS[number], string>>;
export interface LocalAudioTagsCopyClaim {
  fd: number; commandId: string; claimId: string;
  /** 只由SourceFiles作者核验独占保护副本、源修订、命名空间和原命令。 */
  assertCurrent(): void | Promise<void>;
}
export interface LocalAudioTagsRunReceipt {
  values: LocalAudioTagValues; stdout: Uint8Array; stderr: Uint8Array;
  exitCode: number; signal: null; pid: number; pidClosed: true; actorFdsClosed: true;
}
export class LocalAudioTagsRunError extends Error {
  constructor(readonly raw: { exitCode: number | null; signal: NodeJS.Signals | null; stdout: Uint8Array; stderr: Uint8Array; pid: number | null; pidClosed: boolean }) {
    super('标签处理失败，未提交保护副本。');
  }
}
type Pin = { relative: string; bytes: number; sha256: string; dependencies: readonly string[] };
type Bundle = { root: string; manifestSha256: string; files: readonly Pin[]; program: string };
const admitted = new WeakSet<Bundle>(), sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fail = (message = '音频标签后端身份或保护副本无效。'): never => { throw new Error(message); };
const equalStat = (a: import('node:fs').BigIntStats, b: import('node:fs').BigIntStats): boolean =>
  ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);
async function whole(file: string, maximum: number): Promise<Buffer> {
  if (await realpath(file) !== file) return fail();
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum) || (before.mode & 0o022n) !== 0n) return fail();
    const bytes = await fd.readFile(), after = await fd.stat({ bigint: true }), named = await lstat(file, { bigint: true });
    if (BigInt(bytes.length) !== before.size || !equalStat(before, after) || !equalStat(after, named)) return fail();
    return bytes;
  } finally { await fd.close(); }
}
/** expectedManifest来自应用编译身份或当前测试固定pin，不能取旁边manifest重新授权。 */
export async function loadLocalAudioTagsBundle(root: string, expectedManifest: string): Promise<Bundle> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !path.isAbsolute(root) || !/^[a-f0-9]{64}$/u.test(expectedManifest)) return fail();
  const bytes = await whole(path.join(root, 'manifest.json'), 64 * 1024);
  if (sha(bytes) !== expectedManifest) return fail();
  const manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  const source = manifest.source as Record<string, unknown>, files = manifest.files as Pin[], legal = manifest.legal as Pin[];
  if (manifest.schemaVersion !== 1 || manifest.purpose !== 'owner-protected-audio-copy-tags' || manifest.platform !== 'darwin' || manifest.arch !== 'arm64'
    || source?.version !== '2.3.2' || source.sha256 !== '3ca2d8afaa7f1cf7f6ed10e511ebc368bfacd6dcaa3dbfa690b89e502e8963dc'
    || JSON.stringify(manifest.formats) !== JSON.stringify(LOCAL_AUDIO_TAG_FORMATS) || !Array.isArray(files) || files.length !== 2
    || new Set(files.map(file => file.relative)).size !== 2 || !Array.isArray(legal) || legal.length !== 4) return fail();
  const permitted = new Set(['bin/mb-audio-tags', 'lib/libtag.2.dylib']);
  const dependencies = new Set(['@rpath/libtag.2.dylib', '/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib']);
  for (const pin of files) {
    if (!permitted.has(pin.relative) || !Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || !/^[a-f0-9]{64}$/u.test(pin.sha256)
      || !Array.isArray(pin.dependencies) || pin.dependencies.some(value => !dependencies.has(value))) return fail();
    const actual = await whole(path.join(root, pin.relative), 64 * 1024 * 1024);
    if (actual.length !== pin.bytes || sha(actual) !== pin.sha256) return fail();
  }
  const sourceBytes = await whole(path.join(root, 'legal/taglib-2.3.2.tar.gz'), 4 * 1024 * 1024);
  if (sourceBytes.length !== source.bytes || sha(sourceBytes) !== source.sha256) return fail();
  const legalNames = new Set(['legal/COPYING.LGPL', 'legal/COPYING.MPL', 'legal/AUTHORS', 'legal/3rdparty-utfcpp-LICENSE']);
  for (const pin of legal) {
    if (!legalNames.delete(pin.relative) || !Number.isSafeInteger(pin.bytes) || !/^[a-f0-9]{64}$/u.test(pin.sha256)) return fail();
    const actual = await whole(path.join(root, pin.relative), 1024 * 1024);
    if (actual.length !== pin.bytes || sha(actual) !== pin.sha256) return fail();
  }
  const bundle: Bundle = { root, manifestSha256: expectedManifest, files: Object.freeze(structuredClone(files)), program: path.join(root, 'bin/mb-audio-tags') };
  admitted.add(bundle); return Object.freeze(bundle);
}
export function encodeLocalAudioTagsInput(format: LocalAudioTagFormat, values: LocalAudioTagValues): Buffer {
  if (!LOCAL_AUDIO_TAG_FORMATS.includes(format) || !values || Object.getPrototypeOf(values) !== Object.prototype) return fail();
  const chunks = [Buffer.from('MBTAG1\n')], field = (value: string): void => {
    const bytes = Buffer.from(value, 'utf8'), length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); chunks.push(length, bytes);
  };
  field(format); const entries = Object.entries(values), count = Buffer.alloc(4); count.writeUInt32BE(entries.length); chunks.push(count);
  for (const [key, value] of entries) {
    if (!LOCAL_AUDIO_TAG_KEYS.includes(key as typeof LOCAL_AUDIO_TAG_KEYS[number]) || typeof value !== 'string' || value.includes('\0')
      || Buffer.byteLength(value) > (key === 'PICTURE' ? 6 * 1024 * 1024 : key === 'LYRICS' ? 64 * 1024 : 4096) || Buffer.from(value).toString('utf8') !== value) return fail();
    if (key === 'PICTURE') { const image = Buffer.from(value, 'base64'); if (image.length > 4 * 1024 * 1024 || image.toString('base64') !== value
      || !image.subarray(0, 3).equals(Buffer.from([255, 216, 255])) && !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return fail(); }
    field(key); field(value);
  }
  const result = Buffer.concat(chunks); if (result.length > 8 * 1024 * 1024) return fail(); return result;
}
export function decodeLocalAudioTagsReply(bytes: Uint8Array, expected: LocalAudioTagFormat): LocalAudioTagValues {
  const input = Buffer.from(bytes); let pos = 7;
  const number = (): number => { if (pos + 4 > input.length) return fail(); const value = input.readUInt32BE(pos); pos += 4; return value; };
  const field = (limit: number): string => { const length = number(); if (length > limit || pos + length > input.length) return fail();
    const part = input.subarray(pos, pos + length); pos += length; const value = part.toString('utf8'); if (!Buffer.from(value).equals(part) || value.includes('\0')) return fail(); return value; };
  if (input.length > 128 * 1024 || input.subarray(0, pos).toString() !== 'MBTAG1\n' || field(16) !== expected || number() !== LOCAL_AUDIO_TAG_KEYS.length) return fail();
  const result: LocalAudioTagValues = {};
  for (let i = 0; i < LOCAL_AUDIO_TAG_KEYS.length; i++) {
    const key = field(16) as typeof LOCAL_AUDIO_TAG_KEYS[number];
    if (!LOCAL_AUDIO_TAG_KEYS.includes(key) || Object.hasOwn(result, key)) return fail(); result[key] = field(key === 'LYRICS' ? 64 * 1024 : 4096);
  }
  if (pos !== input.length) return fail(); return Object.freeze(result);
}
export function createLocalAudioTagsActor(bundle: Bundle) {
  if (!admitted.has(bundle)) return fail();
  const running = new Map<string, { promise: Promise<LocalAudioTagsRunReceipt>; controller: AbortController; pid: number | null }>(); let closing = false;
  const unverified = new Map<string, LocalAudioTagsRunError>();
  async function execute(claim: LocalAudioTagsCopyClaim, format: LocalAudioTagFormat, values: LocalAudioTagValues | null, signal?: AbortSignal): Promise<LocalAudioTagsRunReceipt> {
    if (closing || signal?.aborted || !Number.isSafeInteger(claim.fd) || claim.fd < 0 || !claim.commandId || !claim.claimId) return fail('标签处理已结束或保护副本声明无效。');
    await claim.assertCurrent();
    for (const pin of bundle.files) if (sha(await whole(path.join(bundle.root, pin.relative), 64 * 1024 * 1024)) !== pin.sha256) return fail();
    const input = encodeLocalAudioTagsInput(format, values ?? {});
    if (closing || signal?.aborted) return fail('标签处理已取消。');
    const child = spawn(bundle.program, [values === null ? '--read-copy' : '--write-copy'], { detached: true,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe', claim.fd, 'pipe'] });
    const originalRun = running.get(claim.commandId); if (originalRun) originalRun.pid = child.pid ?? null;
    const parts: Buffer[][] = [[], []]; let size = 0, failure: string | null = null;
    const kill = (): void => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= '物理关闭失败'; } };
    const cancel = (): void => { failure ??= '标签处理已取消'; kill(); };
    const timer = setTimeout(() => { failure ??= '标签处理超过30秒期限'; kill(); }, 30_000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    for (const [i, stream] of [child.stdout, child.stderr].entries()) stream?.on('data', (bytes: Buffer) => {
      size += bytes.length; if (size > 256 * 1024) { failure ??= '标签回显超过预算'; kill(); } else parts[i]!.push(bytes);
    });
    const metadata = child.stdio[4] as import('node:stream').Writable | null;
    metadata?.on('error', () => { failure ??= '标签输入未完整写入'; kill(); });
    metadata?.end(input);
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', () => { failure ??= '标签后端无法启动'; }); child.once('close', (code, stopped) => resolve({ code, signal: stopped }));
    });
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    let processGroupClosed = !child.pid;
    if (child.pid) try { process.kill(-child.pid, 0); failure ??= '标签进程组仍未结束'; kill(); } catch (error) {
      processGroupClosed = (error as NodeJS.ErrnoException).code === 'ESRCH'; if (!processGroupClosed) failure ??= '标签进程组状态未知';
    }
    if (failure || outcome.code !== 0 || outcome.signal || !child.pid) throw new LocalAudioTagsRunError({ exitCode: outcome.code, signal: outcome.signal,
      stdout: Buffer.concat(parts[0]!), stderr: Buffer.concat(parts[1]!), pid: child.pid ?? null, pidClosed: processGroupClosed });
    await claim.assertCurrent();
    const stdout = Buffer.concat(parts[0]!), stderr = Buffer.concat(parts[1]!), actual = decodeLocalAudioTagsReply(stdout, format);
    if (values && Object.entries(values).some(([key, value]) => actual[key as keyof LocalAudioTagValues] !== (key === 'PICTURE' ? sha(Buffer.from(value, 'base64')) : value))) return fail('保护副本标签回读不匹配。');
    return { values: actual, stdout, stderr, exitCode: 0, signal: null, pid: child.pid, pidClosed: true, actorFdsClosed: true };
  }
  function run(claim: LocalAudioTagsCopyClaim, format: LocalAudioTagFormat, values: LocalAudioTagValues | null, signal?: AbortSignal): Promise<LocalAudioTagsRunReceipt> {
    if (unverified.size) throw unverified.values().next().value;
    if (running.has(claim.commandId)) return fail('原标签命令仍在处理，不能重复启动。');
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const pending = execute(claim, format, values, combined); running.set(claim.commandId, { promise: pending, controller, pid: null });
    void pending.catch(error => { if(error instanceof LocalAudioTagsRunError && !error.raw.pidClosed)unverified.set(claim.commandId,error); })
      .finally(() => { if (running.get(claim.commandId)?.promise === pending) running.delete(claim.commandId); }).catch(() => {}); return pending;
  }
  return { run, async join(commandId: string) { const pending = running.get(commandId); if (pending) await pending.promise.catch(() => {}); if(unverified.has(commandId))throw unverified.get(commandId); },
    async close() { closing = true; for (const item of running.values()) item.controller.abort(); await Promise.allSettled([...running.values()].map(item => item.promise)); if(unverified.size)throw unverified.values().next().value; },
    inspect: () => ({ closing, running: running.size, unverified: unverified.size, pids: [...running.values()].flatMap(value => value.pid === null ? [] : [value.pid]) }) };
}
