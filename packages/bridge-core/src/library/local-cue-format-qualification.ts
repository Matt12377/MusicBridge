import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile, readdir, copyFile, lstat, realpath, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createCueNativeActor, loadBundledCueConverter, CueNativeRunError, type CueNativeRun, type CuePcmProfile, type CueFormatId, type CueInputDemuxer, type CueNativeActor } from './bundled-cue-converter.js';
import { createLocalAudioTagsActor, loadLocalAudioTagsBundle, LocalAudioTagsRunError, type LocalAudioTagValues } from './local-audio-tags-actor.js';
import { CUE_NATIVE_FORMATS } from './cue-ffmpeg-build-policy.js';

export interface NativeEvidencePin { path: string; bytes: number; sha256: string }
export interface NativeRawEvidence extends NativeEvidencePin { stdout: NativeEvidencePin; stderr: NativeEvidencePin }
export interface CueNativeFormatProof {
  id: CueFormatId; profile: string; encoder: string; decoder: string; input: NativeEvidencePin; output: NativeEvidencePin; decoded: NativeEvidencePin;
  expectedFrames: number; decodedFrames: number; eof: true; sampleRate: number; channels: number; lossless: boolean; snrDb: number | null;
  tagsExpected: LocalAudioTagValues; tagsActual: LocalAudioTagValues; sourceUnchanged: true;
  encode: { exitCode: 0; signal: null; raw: NativeRawEvidence; pidClosed: true };
  decode: { exitCode: 0; signal: null; raw: NativeRawEvidence; pidClosed: true };
  physicalClosure: { fdsClosed: true; processesClosed: true; claimsReleased: true }; variants: readonly CueNativeFormatProof[];
}
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error(message); };
const qualified = new WeakSet<object>();
export const CUE_SYNTHETIC_ARTWORK = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
export function createCueSyntheticWave(frames = 24000): { wave: Buffer; pcm: Buffer; frames: number; sampleRate: number; channels: 2 } {
  const sampleRate = 48000, channels = 2 as const, data = Buffer.alloc(frames * channels * 3), pcm = Buffer.alloc(frames * channels * 4);
  for (let i = 0; i < frames; i++) for (let channel = 0; channel < channels; channel++) {
    const value = Math.round(11500 * Math.sin(i * 2 * Math.PI * (channel ? 997 : 440) / sampleRate)) * 256;
    data.writeIntLE(value, (i * channels + channel) * 3, 3); pcm.writeInt32LE(value * 256, (i * channels + channel) * 4);
  }
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 3, 28); header.writeUInt16LE(channels * 3, 32); header.writeUInt16LE(24, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40); return { wave: Buffer.concat([header, data]), pcm, frames, sampleRate, channels };
}
export async function nativeEvidencePin(file: string, root: string): Promise<NativeEvidencePin> {
  const relative = path.relative(root, file).split(path.sep).join('/'), before = await lstat(file, { bigint: true });
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative) || !before.isFile() || await realpath(file) !== file) return fail('Native证据必须是根内的普通原文件。');
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const bytes = await fd.readFile(), after = await fd.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== BigInt(bytes.length) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return fail('Native证据读取期间改变。');
    return { path: relative, bytes: bytes.length, sha256: sha(bytes) };
  } finally { await fd.close(); }
}
async function copyBundle(source: string, destination: string, root: string) {
  await mkdir(destination, { mode: 0o700 }); const all: NativeEvidencePin[] = [];
  async function copy(directory: string, target: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const from = path.join(directory, entry.name), to = path.join(target, entry.name);
      if (entry.isDirectory()) { await mkdir(to, { mode: 0o700 }); await copy(from, to); }
      else if (entry.isFile()) { await copyFile(from, to, constants.COPYFILE_EXCL); all.push(await nativeEvidencePin(to, root)); }
      else return fail('Native包证据不能包含符号链或特殊文件。');
    }
  }
  await copy(source, destination);
  return { manifest: all.find(pin => pin.path.endsWith('/manifest.json'))!, programs: all.filter(pin => pin.path.includes('/bin/')),
    libraries: all.filter(pin => pin.path.includes('/lib/')), legal: all.filter(pin => pin.path.includes('/legal/')) };
}
export async function mergeNativeEvidence(root: string, patch: Record<string, unknown>): Promise<void> {
  const target = path.join(root, 'proof.json'); let previous: Record<string, unknown> = {};
  try { previous = JSON.parse((await readFile(target)).toString('utf8')) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const file = path.join(root, 'proof-' + randomUUID() + '.new');
  await writeFile(file, JSON.stringify({ ...previous, ...patch }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(file, target);
}
export async function rawReceipt(directory: string, name: string, receipt: { stdout: Uint8Array; stderr: Uint8Array; exitCode: number | null; signal: unknown; pid: number | null; pidClosed: boolean }, root: string): Promise<NativeRawEvidence> {
  const stdout = path.join(directory, name + '.stdout.log'), stderr = path.join(directory, name + '.stderr.log');
  await writeFile(stdout, receipt.stdout, { flag: 'wx', mode: 0o600 }); await writeFile(stderr, receipt.stderr, { flag: 'wx', mode: 0o600 });
  const stdoutPin = await nativeEvidencePin(stdout, root), stderrPin = await nativeEvidencePin(stderr, root);
  const target = path.join(directory, name + '.json'); await writeFile(target, JSON.stringify({ exitCode: receipt.exitCode, signal: receipt.signal,
    pid: receipt.pid, pidClosed: receipt.pidClosed, stdout: stdoutPin, stderr: stderrPin }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...await nativeEvidencePin(target, root), stdout: stdoutPin, stderr: stderrPin };
}
type CueRareInputId = 'ape' | 'tta' | 'mpc7' | 'mpc8' | 'tak';
type LocalAudioTagsActor = ReturnType<typeof createLocalAudioTagsActor>;
type NativeFileStat = Readonly<Record<'dev' | 'ino' | 'size' | 'mode' | 'nlink' | 'uid' | 'gid' | 'mtimeNs' | 'ctimeNs', string>>;
interface CueRareFixture {
  id: CueRareInputId; demuxer: CueInputDemuxer; codec: string; sampleFormat: 's16' | 's16p';
  file: string; frames: number; bytes: number; sha256: string; pcmSha256: string; data: Buffer;
}
export interface CueNativeRareOperation {
  label: string; exitCode: 0; signal: null; pid: number; pidClosed: true; pidObservedAbsent: true;
  raw: NativeRawEvidence; freshSourceFd: true; sourceFdClosed: true; actorFdsClosed: true | null;
  sourceBefore: NativeEvidencePin; sourceAfter: NativeEvidencePin; sourceStatBefore: NativeFileStat; sourceStatAfter: NativeFileStat;
}
export interface CueNativeRareInputProof {
  id: CueRareInputId; demuxer: CueInputDemuxer; codec: string; sampleFormat: string; bitsPerSample: 16;
  expectedFrames: number; decodedFrames: number; eof: true; sampleRate: 44100; channels: 2;
  input: NativeEvidencePin; inputAfter: NativeEvidencePin; sourceStatBefore: NativeFileStat; sourceStatAfter: NativeFileStat; sourceUnchanged: true;
  oracle: NativeEvidencePin & { encoding: 's32le'; origin: 'mathematical-synthetic-zero-pcm'; nativeDecoded: false };
  decoded: NativeEvidencePin; exactPcm: true; output: NativeEvidencePin; outputDecoded: NativeEvidencePin;
  flac: { format: 'flac'; profile: 's24'; codec: 'flac'; sampleFormat: 's32'; bitsPerSample: 24;
    frames: number; decodedFrames: number; sampleRate: 44100; channels: 2; eof: true; exactPcm: true };
  tagsExpected: LocalAudioTagValues; tagsActual: LocalAudioTagValues; operations: readonly CueNativeRareOperation[];
  physicalClosure: { fdsClosed: true; processesClosed: true; claimsReleased: true; revokedClaimsRejected: true;
    fdChecks: readonly { label: string; fd: number; error: 'EBADF' }[]; observedPidsAbsent: number;
    actorSnapshots: { cue: ReturnType<CueNativeActor['inspect']>; tags: ReturnType<LocalAudioTagsActor['inspect']> }; raw: NativeEvidencePin };
  raw: NativeEvidencePin;
}
const rareU16 = (value: number): Buffer => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
const rareU32 = (value: number, big = false): Buffer => { const bytes = Buffer.alloc(4); if (big) bytes.writeUInt32BE(value >>> 0); else bytes.writeUInt32LE(value >>> 0); return bytes; };
const rareU24 = (value: number, big = false): Buffer => big ? Buffer.from([(value >>> 16) & 255, (value >>> 8) & 255, value & 255])
  : Buffer.from([value & 255, (value >>> 8) & 255, (value >>> 16) & 255]);
function rareCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
class RareBits {
  readonly bits: number[] = [];
  constructor(readonly little = false) {}
  put(width: number, value: number | bigint): this {
    const integer = BigInt(value);
    if (!Number.isInteger(width) || width < 0 || width > 64 || integer < 0n || integer >= 1n << BigInt(width)) return fail('合成编码字段超出位宽。');
    for (let bit = 0; bit < width; bit++) this.bits.push(Number(integer >> BigInt(this.little ? bit : width - bit - 1) & 1n));
    return this;
  }
  finish(alignment = 8): Buffer {
    const bytes = Buffer.alloc(Math.ceil(this.bits.length / alignment) * alignment / 8);
    for (let bit = 0; bit < this.bits.length; bit++) bytes[bit >>> 3] = bytes[bit >>> 3]! | (this.bits[bit]! << (this.little ? bit & 7 : 7 - (bit & 7)));
    return bytes;
  }
}
function rareApe(): Buffer {
  const encoded = Buffer.concat([rareU32((rareCrc32(Buffer.alloc(88200 * 2 * 2)) >>> 1) | 0x80000000), rareU32(3), Buffer.alloc(4)]);
  const header = Buffer.concat([rareU16(2000), rareU16(32), rareU32(294912), rareU32(88200), rareU32(1), rareU16(16), rareU16(2), rareU32(44100)]);
  // 固定 APE decoder 验证 frame CRC；descriptor MD5 不在该后端的校验范围。
  const descriptor = Buffer.concat([Buffer.from('MAC '), rareU16(3990), rareU16(0), rareU32(52), rareU32(header.length), rareU32(4),
    rareU32(0), rareU32(encoded.length), rareU32(0), rareU32(0), Buffer.alloc(16)]);
  return Buffer.concat([descriptor, header, rareU32(80), encoded]);
}
function rareTta(): Buffer {
  const frames: Buffer[] = [];
  for (let left = 88200; left > 0;) {
    const samples = Math.min(left, Math.floor(44100 * 256 / 245)), k0 = [10, 10], sum0 = [16384, 16384]; let bits = 0;
    for (let sample = 0; sample < samples; sample++) for (let channel = 0; channel < 2; channel++) {
      bits += 1 + k0[channel]!; sum0[channel] = sum0[channel]! - (sum0[channel]! >>> 4);
      if (k0[channel]! > 0 && sum0[channel]! < 2 ** (k0[channel]! + 4)) k0[channel] = k0[channel]! - 1;
      else if (sum0[channel]! > 2 ** (k0[channel]! + 5)) k0[channel] = k0[channel]! + 1;
    }
    const entropy = Buffer.alloc(Math.ceil(bits / 8)); frames.push(Buffer.concat([entropy, rareU32(rareCrc32(entropy))])); left -= samples;
  }
  const header = Buffer.concat([Buffer.from('TTA1'), rareU16(1), rareU16(2), rareU16(16), rareU32(44100), rareU32(88200)]);
  const seek = Buffer.concat(frames.map(frame => rareU32(frame.length)));
  return Buffer.concat([header, rareU32(rareCrc32(header)), seek, rareU32(rareCrc32(seek)), ...frames]);
}
function rareMpc7(): Buffer {
  const bits = new RareBits().put(8, 0);
  for (let frame = 0; frame < 77; frame++) bits.put(20, 8).put(4, 0).put(4, 0);
  const big = bits.finish(32), payload = Buffer.alloc(big.length);
  for (let offset = 0; offset < big.length; offset += 4) payload.writeUInt32LE(big.readUInt32BE(offset), offset);
  return Buffer.concat([Buffer.from([0x4d, 0x50, 0x2b, 0x07]), rareU32(77), Buffer.alloc(16), payload]);
}
function rareVarlen(value: number): Buffer {
  let integer = BigInt(value); const bytes = [Number(integer & 127n)];
  while ((integer >>= 7n) > 0n) bytes.unshift(Number(integer & 127n) | 128);
  return Buffer.from(bytes);
}
function rareMpcChunk(tag: string, body = Buffer.alloc(0)): Buffer {
  let size = body.length + 3;
  while (size !== body.length + 2 + rareVarlen(size).length) size = body.length + 2 + rareVarlen(size).length;
  return Buffer.concat([Buffer.from(tag), rareVarlen(size), body]);
}
function rareMpc8(): Buffer {
  const payload = Buffer.concat([Buffer.from([8]), rareVarlen(88704), rareVarlen(0), Buffer.from([0, 16])]);
  // 固定 MPC8 demuxer 跳过 SH CRC；此处不签发第三方 CRC 验证。
  const header = rareMpcChunk('SH', Buffer.concat([rareU32(rareCrc32(payload), true), payload]));
  return Buffer.concat([Buffer.from('MPCK'), header, ...Array.from({ length: 77 }, () => rareMpcChunk('AP', Buffer.from([0]))), rareMpcChunk('SE')]);
}
const rareTakCrcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index << 24 >>> 0;
  for (let bit = 0; bit < 8; bit++) value = ((value << 1) ^ ((value & 0x80000000) ? 0x864cfb00 : 0)) >>> 0;
  return ((value >>> 24) | ((value >>> 8) & 0xff00) | ((value << 8) & 0xff0000) | (value << 24)) >>> 0;
});
function rareTakCrc(data: Uint8Array): Buffer {
  let crc = 0xce04b7;
  for (const byte of data) crc = (rareTakCrcTable[(crc & 255) ^ byte]! ^ (crc >>> 8)) >>> 0;
  return Buffer.concat([data, rareU24(crc & 0xffffff, true)]);
}
const rareTakInfo = (): RareBits => new RareBits(true).put(6, 2).put(4, 0).put(4, 4).put(35, 88200).put(3, 0)
  .put(18, 44100 - 6000).put(5, 16 - 8).put(4, 2 - 1).put(1, 0);
function rareTak(): Buffer {
  const frames: Buffer[] = [];
  for (let left = 88200, index = 0; left > 0; index++) {
    const samples = Math.min(left, 4096), last = samples === left, bits = new RareBits(true).put(16, 0xa0ff).put(3, last ? 3 : 2).put(21, index);
    if (last) bits.put(14, samples - 1).put(2, 0);
    bits.bits.push(...rareTakInfo().bits); bits.put(6, 0);
    const payload = new RareBits(true);
    for (let channel = 0; channel < 2; channel++) payload.put(1, 0).put(16, 0).put(2, 0).put(3, 0).put(1, 0).put(1, 0).put(6, 0);
    payload.put(1, 0).put(3, 0); frames.push(Buffer.concat([rareTakCrc(bits.finish()), rareTakCrc(payload.finish())])); left -= samples;
  }
  const meta = (type: number, bytes: Buffer): Buffer => { const checked = rareTakCrc(bytes); return Buffer.concat([Buffer.from([type]), rareU24(checked.length), checked]); };
  const last = new RareBits(true).put(40, frames.slice(0, -1).reduce((bytes, frame) => bytes + frame.length, 0)).put(24, frames.at(-1)!.length).finish();
  return Buffer.concat([Buffer.from('tBaK'), meta(1, rareTakInfo().finish()), meta(7, last), Buffer.alloc(4), ...frames]);
}
/** 只构造自有零 PCM 的五族字节与数学 oracle；此函数不授予任何 Native 资格。 */
export function createCueSyntheticRareInputs(): readonly CueRareFixture[] {
  const ordinary = 'bbbf3baab8a5dc22f0ccabe9c9e753a0ec5a58713d6eab66ea37813498a1625a', mpc = '34f5b6601130398b4dd9a44a820c92a954f343cb6eac3deb37661cee6d79b16a';
  return [
    { id: 'ape', demuxer: 'ape', codec: 'ape', sampleFormat: 's16p', file: 'synthetic-silence-44100-s16-stereo.ape', frames: 88200, bytes: 92,
      sha256: 'b4d4e23ee608da258989f3e70c4be37f7a31aa181cadd9acbf916d0947aad817', pcmSha256: ordinary, data: rareApe() },
    { id: 'tta', demuxer: 'tta', codec: 'tta', sampleFormat: 's16', file: 'synthetic-silence-44100-s16-stereo.tta', frames: 88200, bytes: 22340,
      sha256: 'ca8d9aeb8dc9263b3626f92889b9b83bb717a04de736df9bcf54df89d2e44ff1', pcmSha256: ordinary, data: rareTta() },
    { id: 'mpc7', demuxer: 'mpc', codec: 'musepack7', sampleFormat: 's16p', file: 'synthetic-zero-bands-sv7.mpc', frames: 88704, bytes: 296,
      sha256: 'c29d774d9b41a528e18d97f8fe93ee0f1cd3491a44be01a2c945212eb788ca53', pcmSha256: mpc, data: rareMpc7() },
    { id: 'mpc8', demuxer: 'mpc8', codec: 'musepack8', sampleFormat: 's16p', file: 'synthetic-zero-bands-sv8.mpc', frames: 88704, bytes: 329,
      sha256: '21a69cd960c73dd700fbb84dfd6fbf68d6483bb733fcdadea6626b2c5319d1bf', pcmSha256: mpc, data: rareMpc8() },
    { id: 'tak', demuxer: 'tak', codec: 'tak', sampleFormat: 's16p', file: 'synthetic-zero-residuals-44100-s16-stereo.tak', frames: 88200, bytes: 702,
      sha256: '7f75925778cc641df2e94d40c030d59a08957a932bcd3bffcaf8fc3c9b85b0d2', pcmSha256: ordinary, data: rareTak() },
  ];
}

async function closeEvidenceFd(handle: import('node:fs/promises').FileHandle): Promise<void> {
  await handle.close();
  try { await handle.stat(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EBADF') return; throw error; }
  return fail('Native FD 未取得真实 EBADF。');
}
async function freshFormatTags<T>(file: string, target: import('node:fs/promises').FileHandle, tags: LocalAudioTagsActor, commandId: string,
  write: boolean, run: (handle: import('node:fs/promises').FileHandle) => Promise<T>): Promise<T> {
  const handle = await open(file, (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat({ bigint: true }), original = await target.stat({ bigint: true });
    if (!current.isFile() || current.nlink !== 1n || current.dev !== original.dev || current.ino !== original.ino) return fail('标签未持有原输出 FD。');
    return await run(handle);
  } finally { await tags.join(commandId); await closeEvidenceFd(handle); }
}

function rareStat(info: import('node:fs').BigIntStats): NativeFileStat {
  return { dev: String(info.dev), ino: String(info.ino), size: String(info.size), mode: String(info.mode), nlink: String(info.nlink),
    uid: String(info.uid), gid: String(info.gid), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
}
const sameRareStat = (a: NativeFileStat, b: NativeFileStat): boolean => Object.keys(a).every(key => a[key as keyof NativeFileStat] === b[key as keyof NativeFileStat]);
async function rareFileStat(file: string, handle: import('node:fs/promises').FileHandle): Promise<NativeFileStat> {
  const actual = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true });
  if (!actual.isFile() || actual.nlink !== 1n || (actual.mode & 0o777n) !== 0o600n || await realpath(file) !== file
    || !sameRareStat(rareStat(actual), rareStat(named))) return fail('合成 Native 文件、权限或原 FD 绑定改变。');
  return rareStat(actual);
}
function rarePidAbsent(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1) return fail('Native 未返回实际 PID。');
  for (const identity of [pid, -pid]) {
    try { process.kill(identity, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
    return fail('Native 原 PID 或进程组仍未消失。');
  }
}
async function qualifyRareInput(fixture: CueRareFixture, cue: CueNativeActor, tags: LocalAudioTagsActor, directory: string, root: string): Promise<CueNativeRareInputProof> {
  const current = path.join(directory, fixture.id); await mkdir(current, { mode: 0o700 });
  if (fixture.data.length !== fixture.bytes || sha(fixture.data) !== fixture.sha256) return fail('合成编码字节与固定输入 pin 不匹配。');
  const sourcePath = path.join(current, fixture.file), oraclePath = path.join(current, 'oracle-zero.s32le');
  const oracle = Buffer.alloc(fixture.frames * 2 * 4);
  if (sha(oracle) !== fixture.pcmSha256) return fail('合成数学 oracle 与固定 PCM pin 不匹配。');
  await writeFile(sourcePath, fixture.data, { flag: 'wx', mode: 0o600 }); await writeFile(oraclePath, oracle, { flag: 'wx', mode: 0o600 });
  const sourcePin = await nativeEvidencePin(sourcePath, root), oraclePin = await nativeEvidencePin(oraclePath, root);
  const commandId = randomUUID(), claimId = randomUUID(), released = new Error('合成 Native 原声明已关闭。'); let live = true;
  const assertLive = (): void => { if (!live) throw released; };
  type Tracked = { label: string; fd: number; handle: import('node:fs/promises').FileHandle; closed: boolean };
  const handles: Tracked[] = [], fdChecks: { label: string; fd: number; error: 'EBADF' }[] = [], operations: CueNativeRareOperation[] = [];
  const track = async (label: string, file: string, flags: number): Promise<Tracked> => {
    const handle = await open(file, flags | constants.O_NOFOLLOW, 0o600), item = { label, fd: handle.fd, handle, closed: false }; handles.push(item); return item;
  };
  const closeFd = async (item: Tracked): Promise<void> => {
    if (item.closed) return; await item.handle.close();
    try { await item.handle.stat(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
      item.closed = true; fdChecks.push({ label: item.label, fd: item.fd, error: 'EBADF' }); return; }
    return fail('Native FD 未取得真实 EBADF。');
  };
  const quiet = () => {
    const state = { cue: cue.inspect(), tags: tags.inspect() };
    if (Object.values(state).some(value => value.running !== 0 || value.unverified !== 0 || value.pids.length !== 0)) return fail('Native 原进程或未知工作仍未收口。');
    return state;
  };
  const source = await track('source-anchor', sourcePath, constants.O_RDONLY), sourceStatBefore = await rareFileStat(sourcePath, source.handle);
  const assertSource = async (): Promise<void> => {
    assertLive(); const actual = await nativeEvidencePin(sourcePath, root), info = await rareFileStat(sourcePath, source.handle);
    if (actual.bytes !== sourcePin.bytes || actual.sha256 !== sourcePin.sha256 || !sameRareStat(info, sourceStatBefore)) return fail('合成原输入 SHA、inode 或修订改变。');
  };
  const targetBinding = async (file: string, item: Tracked) => {
    const original = await rareFileStat(file, item.handle);
    return async (): Promise<void> => {
      assertLive(); const actual = await rareFileStat(file, item.handle);
      if (!(['dev', 'ino', 'mode', 'nlink', 'uid', 'gid'] as const).every(key => actual[key] === original[key])) return fail('Native 独占目标 FD 绑定改变。');
    };
  };
  type Receipt = { stdout: Uint8Array; stderr: Uint8Array; exitCode: number; signal: null; pid: number; pidClosed: true };
  const native = async <T extends Receipt>(label: string, file: string, binding: () => Promise<void>, writable: boolean,
    run: (handle: import('node:fs/promises').FileHandle, claim: import('./bundled-cue-converter.js').CueNativeClaim) => Promise<T>): Promise<T> => {
    // 每次实际进程重新 open；claim 的 SHA 读取使用另一 FD，不消耗传给 Native 的 offset。
    const fresh = await track(label + '-source', file, writable ? constants.O_RDWR : constants.O_RDONLY);
    let receipt: T, raw: NativeRawEvidence, before: NativeEvidencePin, beforeStat: NativeFileStat;
    try {
      await assertSource(); await binding(); before = await nativeEvidencePin(file, root); beforeStat = await rareFileStat(file, fresh.handle);
      if (writable) {
        // 标签将改变原输出：保存真实写前字节，避免把不可再 lookup 的旧 SHA 挂在同一最终路径上。
        const snapshot = path.join(current, 'flac-before-tags.flac'); await copyFile(file, snapshot, constants.COPYFILE_EXCL);
        const archived = await nativeEvidencePin(snapshot, root), still = await nativeEvidencePin(file, root);
        if (archived.bytes !== before.bytes || archived.sha256 !== before.sha256 || still.bytes !== before.bytes || still.sha256 !== before.sha256
          || !sameRareStat(beforeStat, await rareFileStat(file, fresh.handle))) return fail('标签写前原字节未完整封存。');
        before = archived;
      }
      const claim = { commandId, claimId, async assertCurrent() {
        await assertSource(); await binding(); const actual = await rareFileStat(file, fresh.handle);
        if (!(['dev', 'ino', 'mode', 'nlink', 'uid', 'gid'] as const).every(key => actual[key] === beforeStat[key])) return fail('Native 未持有原调用的精确源 FD。');
      } };
      receipt = await run(fresh.handle, claim); raw = await rawReceipt(current, label, receipt, root);
      if (receipt.exitCode !== 0 || receipt.signal !== null || receipt.pidClosed !== true
        || 'actorFdsClosed' in receipt && receipt.actorFdsClosed !== true) return fail('Native 进程或标签内部 FD 未闭合。');
      await cue.join(commandId); await tags.join(commandId); rarePidAbsent(receipt.pid); quiet();
    } finally {
      // UNKNOWN join 拒绝时保持原 FD/claim；不填写成功的关闭 proof。
      await cue.join(commandId); await tags.join(commandId); await closeFd(fresh);
    }
    await assertSource(); await binding(); const after = await nativeEvidencePin(file, root);
    const named = rareStat(await lstat(file, { bigint: true }));
    if (!writable && (before.bytes !== after.bytes || before.sha256 !== after.sha256 || !sameRareStat(beforeStat, named))) return fail('只读 Native 调用改变了原输入或已批准输出。');
    operations.push({ label, exitCode: 0, signal: null, pid: receipt.pid, pidClosed: true, pidObservedAbsent: true, raw,
      freshSourceFd: true, sourceFdClosed: true, actorFdsClosed: 'actorFdsClosed' in receipt ? true : null,
      sourceBefore: before, sourceAfter: after, sourceStatBefore: beforeStat, sourceStatAfter: named });
    return receipt;
  };
  let body: Omit<CueNativeRareInputProof, 'inputAfter' | 'sourceStatAfter' | 'physicalClosure' | 'raw'> | undefined;
  let inputAfter: NativeEvidencePin | undefined, sourceStatAfter: NativeFileStat | undefined, physicalClosure: CueNativeRareInputProof['physicalClosure'] | undefined;
  try {
    const probe = await native('source-probe', sourcePath, assertSource, false, (fd, claim) => cue.probe(fd, fixture.demuxer, claim));
    if (!probe.eof || probe.codec !== fixture.codec || probe.sampleFormat !== fixture.sampleFormat || probe.bitsPerSample !== 16
      || probe.frames !== fixture.frames || probe.sampleRate !== 44100 || probe.channels !== 2) return fail('冷门输入未取得固定 codec、真实位深与完整 EOF 帧。');
    const decodedPath = path.join(current, 'source-decoded.s32le'), decoded = await track('source-decoded-target', decodedPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
    const assertDecoded = await targetBinding(decodedPath, decoded);
    await native('source-decode', sourcePath, assertSource, false, (fd, claim) => cue.decode(fd, decoded.handle, fixture.demuxer,
      { ...claim, async assertCurrent() { await claim.assertCurrent(); await assertDecoded(); } }));
    const inputPcm = await readFile(decodedPath), decodedPin = await nativeEvidencePin(decodedPath, root);
    if (inputPcm.length !== oracle.length || !inputPcm.equals(oracle) || decodedPin.sha256 !== fixture.pcmSha256) return fail('冷门输入完整实际 PCM 与数学 oracle 不等值。');
    const outputPath = path.join(current, '独立回退.flac'), output = await track('flac-target', outputPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
    const assertOutput = await targetBinding(outputPath, output);
    await native('flac-encode', sourcePath, assertSource, false, (fd, claim) => cue.encode({ source: fd, target: output.handle,
      demuxer: fixture.demuxer, format: 'flac', profile: 's24', startFrame: 0, frameCount: fixture.frames, sampleRate: 44100, channels: 2,
      sourceClaim: claim, targetClaim: { commandId, claimId, assertCurrent: assertOutput } }));
    const expected: LocalAudioTagValues = { TITLE: '合成冷门编码静音：雪と花', ARTIST: '合成艺术家 Δ', ALBUM: '独立FLAC回退：测试',
      DATE: '2026', DISCNUMBER: '2', TRACKNUMBER: '3', LYRICS: '[00:00.00]中文歌词\n[00:00.25]日本語の歌詞\n', PICTURE: CUE_SYNTHETIC_ARTWORK };
    const written = await native('tags-write', outputPath, assertOutput, true, (fd, claim) => tags.run({ ...claim, fd: fd.fd }, 'flac', expected));
    const readback = await native('tags-read', outputPath, assertOutput, false, (fd, claim) => tags.run({ ...claim, fd: fd.fd }, 'flac', null));
    const tagsExpected = { ...expected, PICTURE: sha(Buffer.from(CUE_SYNTHETIC_ARTWORK, 'base64')) };
    if ([written.values, readback.values].some(actual => Object.keys(actual).length !== 8
      || Object.entries(tagsExpected).some(([key, value]) => actual[key as keyof LocalAudioTagValues] !== value))) return fail('冷门 FLAC 的 Unicode 八字段、歌词或图片回读不匹配。');
    const outputProbe = await native('flac-probe', outputPath, assertOutput, false, (fd, claim) => cue.probe(fd, 'flac', claim));
    if (!outputProbe.eof || outputProbe.codec !== 'flac' || outputProbe.sampleFormat !== 's32' || outputProbe.bitsPerSample !== 24
      || outputProbe.frames !== fixture.frames || outputProbe.sampleRate !== 44100 || outputProbe.channels !== 2) return fail('冷门回退产物未取得完整 FLAC24 实际帧。');
    const outputDecodedPath = path.join(current, 'flac-decoded.s32le'), outputDecoded = await track('flac-decoded-target', outputDecodedPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
    const assertOutputDecoded = await targetBinding(outputDecodedPath, outputDecoded);
    await native('flac-decode', outputPath, assertOutput, false, (fd, claim) => cue.decode(fd, outputDecoded.handle, 'flac',
      { ...claim, async assertCurrent() { await claim.assertCurrent(); await assertOutputDecoded(); } }));
    const outputPcm = await readFile(outputDecodedPath), outputDecodedPin = await nativeEvidencePin(outputDecodedPath, root);
    if (!outputPcm.equals(oracle) || !outputPcm.equals(inputPcm) || outputDecodedPin.sha256 !== decodedPin.sha256) return fail('完整回退产物 PCM、原输入实际 PCM 和数学 oracle 不等值。');
    if (operations.length !== 7) return fail('冷门 Native 调用证据不完整。');
    body = { id: fixture.id, demuxer: fixture.demuxer, codec: probe.codec, sampleFormat: probe.sampleFormat, bitsPerSample: 16,
      expectedFrames: fixture.frames, decodedFrames: inputPcm.length / 8, eof: true, sampleRate: 44100, channels: 2,
      input: sourcePin, sourceStatBefore, sourceUnchanged: true, oracle: { ...oraclePin, encoding: 's32le', origin: 'mathematical-synthetic-zero-pcm', nativeDecoded: false },
      decoded: decodedPin, exactPcm: true, output: await nativeEvidencePin(outputPath, root), outputDecoded: outputDecodedPin,
      flac: { format: 'flac', profile: 's24', codec: 'flac', sampleFormat: 's32', bitsPerSample: 24, frames: outputProbe.frames,
        decodedFrames: outputPcm.length / 8, sampleRate: 44100, channels: 2, eof: true, exactPcm: true },
      tagsExpected, tagsActual: readback.values, operations: Object.freeze(operations) };
  } catch (error) {
    if (error instanceof CueNativeRunError || error instanceof LocalAudioTagsRunError) await rawReceipt(current, 'failure', error.raw, root);
    throw error;
  } finally {
    await cue.join(commandId); await tags.join(commandId); quiet(); await assertSource();
    inputAfter = await nativeEvidencePin(sourcePath, root); sourceStatAfter = await rareFileStat(sourcePath, source.handle);
    for (const item of [...handles].reverse()) await closeFd(item);
    live = false; let denied = false;
    try { await assertSource(); } catch (error) { if (error !== released) throw error; denied = true; }
    if (!denied || handles.some(item => !item.closed) || fdChecks.length !== handles.length) return fail('原合成声明或 FD 未真实关闭。');
    const closure = { fdsClosed: true as const, processesClosed: true as const, claimsReleased: true as const, revokedClaimsRejected: true as const,
      fdChecks, observedPidsAbsent: operations.length, actorSnapshots: quiet() };
    const closurePath = path.join(current, 'closure.json'); await writeFile(closurePath, JSON.stringify(closure, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    physicalClosure = { ...closure, raw: await nativeEvidencePin(closurePath, root) };
  }
  if (!body || !inputAfter || !sourceStatAfter || !physicalClosure || !sameRareStat(sourceStatBefore, sourceStatAfter)
    || inputAfter.sha256 !== sourcePin.sha256 || inputAfter.bytes !== sourcePin.bytes) return fail('冷门完整资格或原输入修订证明缺失。');
  const result = { ...body, inputAfter, sourceStatAfter, physicalClosure }, proofPath = path.join(current, 'proof.json');
  await writeFile(proofPath, JSON.stringify({ schema: 'musicbridge.v39.cue-rare-input.evidence.v1', ...result }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return Object.freeze({ ...result, raw: await nativeEvidencePin(proofPath, root) });
}

/** 原八族与五族冷门输入均完成真实音频、标签、EOF 和物理关闭后，才签发同一品牌。 */
export async function qualifyCueEightFormats(input: { cueRoot: string; cueManifestSha256: string; tagsRoot: string; tagsManifestSha256: string; evidenceRoot: string }) {
  const root = input.evidenceRoot, directory = path.join(root, 'cue'); await mkdir(directory, { mode: 0o700 });
  const cue = createCueNativeActor(await loadBundledCueConverter(input.cueRoot, input.cueManifestSha256));
  const tags = createLocalAudioTagsActor(await loadLocalAudioTagsBundle(input.tagsRoot, input.tagsManifestSha256));
  const bundleEvidence = { cue: await copyBundle(input.cueRoot, path.join(directory, 'bundle'), root),
    tags: await copyBundle(input.tagsRoot, path.join(directory, 'tags-bundle'), root) };
  const fixture = createCueSyntheticWave(), sourcePath = path.join(directory, 'synthetic-source.wav');
  await writeFile(sourcePath, fixture.wave, { flag: 'wx', mode: 0o600 }); const sourcePin = await nativeEvidencePin(sourcePath, root);
  const formats: CueNativeFormatProof[] = [], rareInputs: CueNativeRareInputProof[] = [];
  try {
    for (const format of CUE_NATIVE_FORMATS) {
      const formatDirectory = path.join(directory, format.id); await mkdir(formatDirectory, { mode: 0o700 });
      const rows: CueNativeFormatProof[] = [];
      const profiles: CuePcmProfile[] = format.id.startsWith('pcm-') ? ['s24', 's16', 's32', 'f32'] : ['s24'];
      for (const profile of profiles) {
        const currentDirectory = path.join(formatDirectory, profile); await mkdir(currentDirectory, { mode: 0o700 });
        const outputPath = path.join(currentDirectory, 'output.' + format.extension), decodedPath = path.join(currentDirectory, 'decoded.s32le');
        const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW), target = await open(outputPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const commandId = randomUUID(), claimId = randomUUID(); let decoded: import('node:fs/promises').FileHandle | undefined;
        const checkSource = async (): Promise<void> => { if ((await nativeEvidencePin(sourcePath, root)).sha256 !== sourcePin.sha256) return fail('合成源被改变。'); await source.stat(); };
        const checkTarget = async (): Promise<void> => { const info = await target.stat(); if (!info.isFile() || info.nlink !== 1) return fail('Native输出声明已变化。'); };
        let encode: CueNativeRun, decode: CueNativeRun, actual: LocalAudioTagValues, encodeRaw: NativeRawEvidence, decodeRaw: NativeRawEvidence;
        try {
          encode = await cue.encode({ source, target, demuxer: 'wav', format: format.id, profile, startFrame: 0, frameCount: fixture.frames,
            sampleRate: fixture.sampleRate, channels: fixture.channels, sourceClaim: { commandId, claimId, assertCurrent: checkSource }, targetClaim: { commandId, claimId, assertCurrent: checkTarget } });
          encodeRaw = await rawReceipt(currentDirectory, 'encode', encode, root);
          const expected: LocalAudioTagValues = { TITLE: '曲名：雪と花', ARTIST: '艺术家 Δ', ALBUM: '专辑：测试', DATE: '2026', DISCNUMBER: '2', TRACKNUMBER: '3',
            LYRICS: '[00:00.00]中文歌词\n[00:00.25]日本語の歌詞\n', PICTURE: CUE_SYNTHETIC_ARTWORK };
          const written = await freshFormatTags(outputPath, target, tags, commandId, true, fd => tags.run({ fd: fd.fd, commandId, claimId, assertCurrent: checkTarget }, format.id, expected));
          await rawReceipt(currentDirectory, 'tags-write', written, root);
          const readback = await freshFormatTags(outputPath, target, tags, commandId, false, fd => tags.run({ fd: fd.fd, commandId, claimId, assertCurrent: checkTarget }, format.id, null));
          await rawReceipt(currentDirectory, 'tags-read', readback, root); actual = readback.values;
          const demuxer: CueInputDemuxer = format.id === 'alac' ? 'mov' : format.id === 'pcm-wav' ? 'wav' : format.id === 'pcm-aiff' ? 'aiff'
            : format.id === 'vorbis' || format.id === 'opus' ? 'ogg' : format.id === 'wavpack' ? 'wv' : format.id;
          const probeSource = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const probe = await (async () => { try { return await cue.probe(probeSource, demuxer, { commandId, claimId, assertCurrent: checkTarget }); } finally { await closeEvidenceFd(probeSource); } })();
          await rawReceipt(currentDirectory, 'probe', probe, root);
          if (!probe.eof || probe.frames !== fixture.frames || probe.sampleRate !== fixture.sampleRate || probe.channels !== fixture.channels) return fail('完整实际解码帧、采样率或声道不匹配。');
          decoded = await open(decodedPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          const decodeSource = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          decode = await (async () => { try { return await cue.decode(decodeSource, decoded!, demuxer, { commandId, claimId, assertCurrent: checkTarget }); } finally { await closeEvidenceFd(decodeSource); } })();
          decodeRaw = await rawReceipt(currentDirectory, 'decode', decode, root);
          const pcm = await readFile(decodedPath); if (pcm.length !== fixture.pcm.length) return fail('完整PCM字节数不匹配。');
          let power = 0, error = 0;
          for (let offset = 0; offset < pcm.length; offset += 4) { const a = fixture.pcm.readInt32LE(offset) / 2147483648, b = pcm.readInt32LE(offset) / 2147483648; power += a * a; error += (a - b) ** 2; }
          const snr = error === 0 ? null : 10 * Math.log10(power / error);
          if (format.lossless ? !pcm.equals(fixture.pcm) : snr === null || snr < 18) return fail('无损PCM不等值或有损真实质量不足。');
          const tagsExpected = { ...expected, PICTURE: sha(Buffer.from(CUE_SYNTHETIC_ARTWORK, 'base64')) };
          if (Object.entries(tagsExpected).some(([key, value]) => actual[key as keyof LocalAudioTagValues] !== value)) return fail('Unicode标签、歌词或图片回读不匹配。');
          const row: CueNativeFormatProof = { id: format.id, profile: format.id.startsWith('pcm-') ? profile : format.id === 'mp3' ? 'q2' : format.id === 'vorbis' ? 'q6' : format.id === 'opus' ? '128k' : 's24',
            encoder: format.id.startsWith('pcm-') ? 'pcm_' + profile + (format.id === 'pcm-aiff' ? 'be' : 'le') : format.encoder,
            decoder: probe.codec, input: sourcePin, output: await nativeEvidencePin(outputPath, root), decoded: await nativeEvidencePin(decodedPath, root),
            expectedFrames: fixture.frames, decodedFrames: pcm.length / (fixture.channels * 4), eof: true, sampleRate: probe.sampleRate, channels: probe.channels,
            lossless: format.lossless, snrDb: snr, tagsExpected, tagsActual: actual, sourceUnchanged: true,
            encode: { exitCode: 0, signal: null, raw: encodeRaw, pidClosed: true }, decode: { exitCode: 0, signal: null, raw: decodeRaw, pidClosed: true },
            physicalClosure: { fdsClosed: true, processesClosed: true, claimsReleased: true }, variants: [] };
          rows.push(row);
        } catch (error) {
          if (error instanceof CueNativeRunError || error instanceof LocalAudioTagsRunError) await rawReceipt(currentDirectory, 'failure', error.raw, root);
          throw error;
        } finally {
          await cue.join(commandId); await tags.join(commandId); await decoded?.close(); await target.close(); await source.close();
          for (const handle of [source, target, decoded]) if (handle) try { await handle.stat(); return fail('Native FD未真实关闭。'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error; }
        }
      }
      const [main, ...variants] = rows; if (!main) return fail('格式未产生实际证据。'); formats.push({ ...main, variants });
    }
    if ((await nativeEvidencePin(sourcePath, root)).sha256 !== sourcePin.sha256 || formats.length !== 8) return fail('八族或原SHA证明不完整。');
    const rareDirectory = path.join(directory, 'rare-inputs'); await mkdir(rareDirectory, { mode: 0o700 });
    const rareFixtures = createCueSyntheticRareInputs();
    if (rareFixtures.length !== 5 || rareFixtures.map(row => row.id).join(',') !== 'ape,tta,mpc7,mpc8,tak') return fail('五族合成冷门输入缺失。');
    for (const rare of rareFixtures) rareInputs.push(await qualifyRareInput(rare, cue, tags, rareDirectory, root));
  } finally { await cue.close(); await tags.close(); }
  for (const state of [cue.inspect(), tags.inspect()]) if (!state.closing || state.running !== 0 || state.unverified !== 0 || state.pids.length !== 0) return fail('资格 Native actor 未真实关闭。');
  if (rareInputs.length !== 5 || rareInputs.map(row => row.id).join(',') !== 'ape,tta,mpc7,mpc8,tak') return fail('冷门 Native 完整 proof 缺失，不能签发资格。');
  for (const rare of rareInputs) {
    const file = path.join(root, rare.input.path), pin = await nativeEvidencePin(file, root), info = rareStat(await lstat(file, { bigint: true }));
    if (pin.bytes !== rare.input.bytes || pin.sha256 !== rare.input.sha256 || !sameRareStat(info, rare.sourceStatAfter)) return fail('全部 Native 关闭后冷门原输入修订改变。');
  }
  const result = Object.freeze({ formats: Object.freeze(formats), rareInputs: Object.freeze(rareInputs), bundles: bundleEvidence,
    physicalClosure: { fdsClosed: true, processesClosed: true, claimsReleased: true } }); qualified.add(result); return result;
}
export function readCueQualifiedFormats(value: Awaited<ReturnType<typeof qualifyCueEightFormats>>) {
  if (!qualified.has(value)) return fail('必须先取得真实八族编码、五族冷门输入、标签和EOF资格。');
  return value.formats.map(format => ({ formatId: format.id, revision: sha(Buffer.from(JSON.stringify(format))), codec: format.id,
    extension: CUE_NATIVE_FORMATS.find(item => item.id === format.id)!.extension, lossless: format.lossless, evidence: 'encoder-tag-audio-roundtrip' as const, available: true }));
}
