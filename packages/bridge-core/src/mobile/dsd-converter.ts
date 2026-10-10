import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isMobileDsdSourceAudio, type MobileAudioInfo } from '@music-bridge/contracts';
import { openLocalPlaybackReadonlySource } from '../recording/source-files.js';
import { readDsdContainerFacts, DsdContainerError } from '../library/dsd-container-facts.js';
import { MobileDsdError, type MobileDsdSourceAccess, type MobileDsdSourceInput, type MobileDsdConverter, type MobileDsdOutput } from './prepared-cache-types.js';
import { MOBILE_DSD_RECIPE, MOBILE_DSD_VERIFY_ARGUMENTS, MOBILE_FFMPEG_CONFIGURE_SHA256,
  MOBILE_FFMPEG_DEPENDENCIES, MOBILE_FFMPEG_SOURCE_SHA256, MOBILE_FFMPEG_VERSION, mobileDsdConversionArguments } from './mobile-ffmpeg-policy.js';

const MAX_SOURCE = 64 * 1024 ** 3, MAX_METADATA = 16 * 1024 ** 2;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const fail = (code: MobileDsdError['code'] = 'UNSUPPORTED_FORMAT'): never => { throw new MobileDsdError(code); };
const signature = (s: BigIntStats): string => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs, s.mode, s.uid, s.gid, s.nlink].join(':');
interface SourceRecord {
  file: Awaited<ReturnType<typeof openLocalPlaybackReadonlySource>>; input: MobileDsdSourceInput;
  first: BigIntStats; samples: number; closed: boolean; closing: Promise<void> | null; fullHash: string | null;
}
const sources = new WeakMap<MobileDsdSourceAccess, SourceRecord>(), converters = new WeakSet<MobileDsdConverter>();
function sourceRecord(access: MobileDsdSourceAccess): SourceRecord {
  const record = sources.get(access);
  if (!record || record.closed) return fail('RESOURCE_RELEASED');
  record.input.assertCurrent(); return record;
}
async function bytes(handle: FileHandle, at: number, size: number): Promise<Buffer> {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 1 || size > MAX_METADATA) return fail();
  const result = Buffer.alloc(size); let offset = 0;
  while (offset < size) { const read = await handle.read(result, offset, size - offset, at + offset); if (!read.bytesRead) return fail('SOURCE_CHANGED'); offset += read.bytesRead; }
  return result;
}
/** 复用原 Scanner 作者的受限容器叶；真实 FD、保护和当前身份仍由此域持有。 */
export async function inspectMobileDsdFile(handle: FileHandle, size: number, check: () => void): Promise<{ sourceAudio: MobileAudioInfo; samples: number; durationMs: number }> {
  check(); if (!Number.isSafeInteger(size) || size < 16 || size > MAX_SOURCE) return fail();
  try {
    const facts = await readDsdContainerFacts(size, async (at, length) => { check(); const read = await bytes(handle, at, length); check(); return read; });
    const sourceAudio: MobileAudioInfo = { codec:'dsd',container:facts.container.toLowerCase(),sampleRateHz:facts.sampleRateHz,bitsPerSample:1,channels:facts.channels };
    if (!isMobileDsdSourceAudio(sourceAudio)) return fail(); check();
    return { sourceAudio, samples:facts.oneBitSamples, durationMs:Math.round(facts.durationSeconds * 1000) };
  } catch (error) { if (error instanceof DsdContainerError) return fail(); throw error; }
}
export async function openMobileDsdSource(input: MobileDsdSourceInput, signal: AbortSignal): Promise<MobileDsdSourceAccess> {
  const check = (): void => { input.assertCurrent(); if (signal.aborted) return fail('RESOURCE_RELEASED'); };
  check(); if (!isMobileDsdSourceAudio(input.sourceAudio) || !/^[a-f0-9]{64}$/u.test(input.identity)) return fail();
  const file = await openLocalPlaybackReadonlySource(input.root, input.relative, input.signature);
  try {
    const first = await file.handle.stat({ bigint: true });
    const facts = await inspectMobileDsdFile(file.handle, file.size, check);
    if (JSON.stringify(facts.sourceAudio) !== JSON.stringify({ codec: input.sourceAudio.codec, container: input.sourceAudio.container,
      sampleRateHz: input.sourceAudio.sampleRateHz, bitsPerSample: input.sourceAudio.bitsPerSample, channels: input.sourceAudio.channels })) return fail('SOURCE_CHANGED');
    await file.verify(); check();
    const access: MobileDsdSourceAccess = Object.freeze({ identity: input.identity, sourceAudio: Object.freeze(facts.sourceAudio), durationMs: facts.durationMs });
    sources.set(access, { file, input, first, samples: facts.samples, closed: false, closing: null, fullHash: null }); return access;
  } catch (error) { await file.close(); throw error; }
}
export async function verifyMobileDsdSource(access: MobileDsdSourceAccess): Promise<void> {
  const record = sourceRecord(access); await record.file.verify();
  if (signature(await record.file.handle.stat({ bigint: true })) !== signature(record.first)) return fail('SOURCE_CHANGED'); sourceRecord(access);
}
async function fullHash(handle: FileHandle, size: number, check: () => void): Promise<string> {
  const h = createHash('sha256'), block = Buffer.alloc(256 * 1024); let offset = 0;
  while (offset < size) { check(); const result = await handle.read(block, 0, Math.min(block.length, size - offset), offset); if (!result.bytesRead) return fail('SOURCE_CHANGED'); h.update(block.subarray(0, result.bytesRead)); offset += result.bytesRead; }
  check(); return h.digest('hex');
}
export async function hashMobileDsdSource(access: MobileDsdSourceAccess, check: () => void): Promise<string> {
  await verifyMobileDsdSource(access); const record = sourceRecord(access), value = await fullHash(record.file.handle, record.file.size, check);
  await verifyMobileDsdSource(access); if (record.fullHash !== null && record.fullHash !== value) return fail('SOURCE_CHANGED'); record.fullHash = value; return value;
}
export function mobileDsdSourceIdentity(access: MobileDsdSourceAccess): Readonly<{ identity: string; signature: string; size: number; samples: number; fullHash: string | null }> {
  const record = sourceRecord(access); return Object.freeze({ identity: access.identity, signature: signature(record.first), size: record.file.size, samples: record.samples, fullHash: record.fullHash });
}
export async function closeMobileDsdSource(access: MobileDsdSourceAccess): Promise<void> {
  const record = sources.get(access); if (!record) return fail('RESOURCE_RELEASED');
  return record.closing ??= (async () => { await record.file.close(); record.closed = true; })();
}

interface Pin { path: string; sha256: string }
function closed(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
  const ds = Object.getOwnPropertyDescriptors(raw);
  return Reflect.ownKeys(ds).length === keys.length && keys.every(k => ds[k]?.enumerable && Object.hasOwn(ds[k]!, 'value'));
}
async function verifyPin(pin: Pin, check: () => void): Promise<void> {
  check(); if (!path.isAbsolute(pin.path) || !sha(pin.sha256) || await realpath(pin.path) !== pin.path) return fail();
  const handle = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = await handle.stat({ bigint: true }); if (!a.isFile() || a.nlink !== 1n || a.size < 1n || a.size > 512n * 1024n ** 2n || (a.mode & 0o022n) !== 0n) return fail();
    if (await fullHash(handle, Number(a.size), check) !== pin.sha256 || signature(await handle.stat({ bigint: true })) !== signature(a)
      || signature(await lstat(pin.path, { bigint: true })) !== signature(a) || await realpath(pin.path) !== pin.path) return fail();
  } finally { await handle.close(); }
}
/** FD-only 子进程有界监督：取消后杀组并等待实际 close，永不保留内部 stderr。 */
async function processFd(executable: string, args: readonly string[], descriptors: readonly number[], check: () => void,
  onOutput?: (chunk: Buffer) => void): Promise<Buffer> {
  check(); const child = spawn(executable, [...args], { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...descriptors], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  const chunks: Buffer[] = []; let outputBytes = 0, stderrBytes = 0, reason: unknown;
  let quietTimer: ReturnType<typeof setTimeout> | undefined, rejectQuiet: (error: MobileDsdError) => void = () => undefined;
  const stop = (error: unknown): void => {
    reason ??= error; try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    quietTimer ??= setTimeout(() => rejectQuiet(new MobileDsdError(reason instanceof MobileDsdError ? reason.code : 'RESOURCE_BUSY', false)), 10_000);
  };
  const guarded = (fn: () => void): void => { try { check(); fn(); } catch (error) { stop(error); } };
  const timer = setInterval(() => guarded(() => undefined), 25);
  child.stdout!.on('data', (chunk: Buffer) => guarded(() => { if (onOutput) onOutput(chunk); else { outputBytes += chunk.length; if (outputBytes > 256 * 1024) return fail(); chunks.push(Buffer.from(chunk)); } }));
  child.stderr!.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) stop(new MobileDsdError('UNSUPPORTED_FORMAT')); });
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      rejectQuiet = reject;
      child.once('error', () => stop(new MobileDsdError('UNSUPPORTED_FORMAT')));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (reason) throw reason; check(); if (result.code !== 0 || result.signal !== null || stderrBytes !== 0) return fail(); return Buffer.concat(chunks);
  } finally { clearInterval(timer); if (quietTimer) clearTimeout(quietTimer); }
}
export function isQualifiedMobileDsdConverter(raw: unknown): raw is MobileDsdConverter { return !!raw && typeof raw === 'object' && converters.has(raw as MobileDsdConverter); }

export async function loadMobileDsdConverter(options: { directory: string; manifestSha256: string }): Promise<MobileDsdConverter> {
  const deadline = Date.now() + 10_000, check = (): void => { if (Date.now() >= deadline) return fail(); };
  try {
    const root = options.directory; if (!path.isAbsolute(root) || await realpath(root) !== root || !sha(options.manifestSha256)) return fail();
    const stat = await lstat(root, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022n) !== 0n) return fail();
    const manifestFile = path.join(root, 'manifest.json'), handle = await open(manifestFile, constants.O_RDONLY | constants.O_NOFOLLOW); let manifest: unknown;
    try { const a = await handle.stat({ bigint: true }); if (!a.isFile() || a.size < 1n || a.size > 64n * 1024n) return fail();
      const raw = await bytes(handle, 0, Number(a.size)); if (createHash('sha256').update(raw).digest('hex') !== options.manifestSha256
        || signature(await handle.stat({ bigint: true })) !== signature(a) || signature(await lstat(manifestFile, { bigint: true })) !== signature(a)) return fail(); manifest = JSON.parse(raw.toString('utf8'));
    } finally { await handle.close(); }
    if (!closed(manifest, ['schemaVersion','purpose','recipe','configureSha256','platform','arch','minimumMacOS','sourceSha256','license','build'])
      || manifest.schemaVersion !== 1 || manifest.purpose !== 'mobile-dsd-to-pcm-flac' || manifest.configureSha256 !== MOBILE_FFMPEG_CONFIGURE_SHA256
      || manifest.sourceSha256 !== MOBILE_FFMPEG_SOURCE_SHA256 || manifest.license !== 'LGPL-2.1-or-later' || manifest.platform !== process.platform || manifest.arch !== process.arch
      || manifest.minimumMacOS !== '13.0' || !closed(manifest.recipe, ['outputCodec','sampleRateHz','bitsPerSample'])
      || manifest.recipe.outputCodec !== 'flac' || manifest.recipe.sampleRateHz !== 48000 || manifest.recipe.bitsPerSample !== 24
      || !closed(manifest.build, ['version','ffmpeg','ffprobe','dependencies','components']) || manifest.build.version !== MOBILE_FFMPEG_VERSION) return fail();
    const pins: Pin[] = [], programs: { path: string; versionSha256: string }[] = [];
    for (const [name, expected] of [['ffmpeg','bin/ffmpeg'], ['ffprobe','bin/ffprobe']] as const) {
      const raw = manifest.build[name]; if (!closed(raw, ['path','sha256','versionSha256'])) return fail();
      const programPath = raw.path, programSha256 = raw.sha256, versionSha256 = raw.versionSha256;
      if (typeof programPath !== 'string' || programPath !== expected || !sha(programSha256) || !sha(versionSha256)) return fail();
      pins.push({ path: path.join(root, programPath), sha256: programSha256 }); programs.push({ path: path.join(root, programPath), versionSha256 });
    }
    const dependencies = manifest.build.dependencies;
    if (!Array.isArray(dependencies) || dependencies.length !== MOBILE_FFMPEG_DEPENDENCIES.length) return fail();
    for (const [i, name] of MOBILE_FFMPEG_DEPENDENCIES.entries()) { const d: unknown = dependencies[i]; if (!closed(d, ['id','path','sha256']) || d.id !== name || d.path !== `lib/${name}` || !sha(d.sha256)) return fail(); pins.push({ path: path.join(root, d.path), sha256: d.sha256 }); }
    if (!Array.isArray(manifest.build.components) || JSON.stringify(manifest.build.components) !== JSON.stringify([
      {name:'libavcodec',version:'62.28.102'}, {name:'libavfilter',version:'11.14.102'}, {name:'libavformat',version:'62.12.102'}, {name:'libavutil',version:'60.26.102'}, {name:'libswresample',version:'6.3.102'},
    ])) return fail();
    const verifyBackend = async (jobCheck: () => void): Promise<void> => { for (const pin of pins) await verifyPin(pin, jobCheck);
      const actual = await lstat(root, { bigint: true }); if (actual.dev !== stat.dev || actual.ino !== stat.ino || await realpath(root) !== root) return fail(); };
    await verifyBackend(check);
    for (const p of programs) { const output = await processFd(p.path, ['-version'], [], check); if (createHash('sha256').update(output).digest('hex') !== p.versionSha256) return fail(); }
    const converter: MobileDsdConverter = Object.freeze({ identity: createHash('sha256').update(`${options.manifestSha256}:${MOBILE_DSD_RECIPE}`).digest('hex'),
      async convert(source: MobileDsdSourceAccess, output: FileHandle, jobCheck: () => void, maximumBytes: number): Promise<void> {
        if (!converters.has(converter)) return fail(); const record = sourceRecord(source);
        const beforeHash = await hashMobileDsdSource(source, jobCheck); await verifyBackend(jobCheck);
        const stat = await output.stat({ bigint: true }); if (!stat.isFile() || stat.nlink !== 1n || stat.size !== 0n || (stat.mode & 0o777n) !== 0o600n) return fail();
        const checkSize = (): void => { jobCheck(); sourceRecord(source); };
        // 输出长度在运行时也检查；失败仍等待实际进程 close，写FD由 cache 在之后关闭。
        let watching = false, overflow = false, ioFailure: unknown;
        const timer = setInterval(() => { if (!watching) { watching = true; void output.stat({ bigint: true }).then(s => { if (s.size > BigInt(maximumBytes)) overflow = true; }, e => { ioFailure = e; }).finally(() => { watching = false; }); } }, 25);
        try { await processFd(programs[0]!.path, mobileDsdConversionArguments(source.sourceAudio.container as 'dsf' | 'dff'), [record.file.handle.fd, output.fd], () => { checkSize(); if (overflow || ioFailure) return fail('RESOURCE_BUSY'); }); }
        finally { clearInterval(timer); while (watching) await new Promise<void>(resolve => setTimeout(resolve, 1)); }
        if (overflow || ioFailure || (await output.stat({ bigint: true })).size > BigInt(maximumBytes)) return fail('RESOURCE_BUSY');
        await verifyBackend(jobCheck); if (await hashMobileDsdSource(source, jobCheck) !== beforeHash) return fail('SOURCE_CHANGED');
      },
      async verifyOutput(output: FileHandle, source: MobileDsdSourceAccess, jobCheck: () => void, maximumBytes: number): Promise<MobileDsdOutput> {
        const record = sourceRecord(source), stat = await output.stat({ bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.size < 42n || stat.size > BigInt(maximumBytes)) return fail();
        const h = await bytes(output, 0, 42); if (h.toString('ascii', 0, 4) !== 'fLaC' || (h[4]! & 127) !== 0 || h.readUIntBE(5, 3) !== 34) return fail();
        const packed = h.readBigUInt64BE(18), rate = Number(packed >> 44n), channels = Number((packed >> 41n) & 7n) + 1,
          bits = Number((packed >> 36n) & 31n) + 1, samples = Number(packed & 0xfffffffffn);
        const expected = record.samples * 48000 / source.sourceAudio.sampleRateHz!;
        if (rate !== 48000 || bits !== 24 || channels !== source.sourceAudio.channels || samples < 1
          || samples < Math.floor(expected) || samples > Math.ceil(expected) || h.subarray(26, 42).every(v => v === 0)) return fail();
        await verifyBackend(jobCheck); let decodedBytes = 0; const pcmMd5 = createHash('md5');
        await processFd(programs[0]!.path, MOBILE_DSD_VERIFY_ARGUMENTS, [output.fd], jobCheck, b => {
          decodedBytes += b.length; if (decodedBytes > samples * channels * 3) return fail(); pcmMd5.update(b);
        });
        if (decodedBytes !== samples * channels * 3 || !pcmMd5.digest().equals(h.subarray(26, 42))
          || signature(await output.stat({ bigint: true })) !== signature(stat)) return fail();
        const outputHash = await fullHash(output, Number(stat.size), jobCheck);
        await hashMobileDsdSource(source, jobCheck); await verifyBackend(jobCheck);
        if (signature(await output.stat({ bigint: true })) !== signature(stat)) return fail();
        return Object.freeze({ size: Number(stat.size), sha256: outputHash, actualAudio: Object.freeze({ codec:'flac',container:'flac',sampleRateHz:48000,bitsPerSample:24,channels }), samples });
      },
    });
    converters.add(converter); return converter;
  } catch (error) { if (error instanceof MobileDsdError) throw error; return fail(); }
}
