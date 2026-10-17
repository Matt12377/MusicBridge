import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, readFile, writeFile, mkdir, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { createCueNativeActor, loadBundledCueConverter, CueNativeRunError, type CueNativeRun, type CueInputDemuxer, type CuePcmProfile, type CueNativeClaim } from '../../src/library/bundled-cue-converter.js';
import { loadLocalAudioTagsBundle } from '../../src/library/local-audio-tags-actor.js';
import { createCueSyntheticWave, nativeEvidencePin, rawReceipt, mergeNativeEvidence, readCueQualifiedFormats, type NativeEvidencePin } from '../../src/library/local-cue-format-qualification.js';
import { CUE_NATIVE_FORMATS, CUE_FFMPEG_CONFIGURE } from '../../src/library/cue-ffmpeg-build-policy.js';
import { parseCueText, type CueOwnerAssetReference } from '../../src/library/cue-text-reader.js';
import { buildLocalCuePlan, localCueCdFramesToPcm } from '../../src/collection/local-library-workbench/cue-plan.js';
import { isLocalWorkbenchPlanCapture } from '../../src/collection/local-library-workbench/plan-registry.js';
import { isLocalWorkbenchAlbumCapture } from '../../src/collection/local-library-workbench/name-proposal.js';
import type { LocalCueAudioProbe, LocalCueSheetCapture, LocalCueFormatQualification, LocalWorkbenchAlbumCapture } from '../../src/collection/local-library-workbench/types.js';
import { PhysicalResourceCoordinator } from '../../src/stream/physical-resource-locks.js';
import { captureSourceNamespace, acquireSourceNamespaceRead, type SourceNamespaceReadClaims } from '../../src/stream/source-namespace-claims.js';

const INPUT_BYTES = 32 * 1024 * 1024, READER_MS = 3000;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const unsupported = process.platform !== 'darwin' ? '实际输入证据由独立Darwin arm64 Native域执行，不能以本跳过签资格' : false;
const zero = { readers: 0, writers: 0, resources: 0 };
const names = [
  'CUE输入：七个实际demux与八族来源逐件probe和完整PCM解码EOF，源原件及FD/PID/命名租约不变',
  'CUE输入：WAV/AIFF s16/s24/s32/f32/f64真实位深回读，f64仅输入且不扩输出资格',
  'CUE输入：同stem多FILE与Unicode精确关联实际PCM，CD75/pregap/末轨完整绑定',
  'CUE输入：99轨×100专辑完整计划不截尾，轨组FILE及32MiB边界整组拒绝',
  'CUE输入：弱类型格式/假品牌/源修订/路径/非独立目标整组拒绝且原输入保留',
  'CUE输入：真实坏音频probe/decode失败保留全raw，join后FD/PID/命名租约物理关闭',
] as const;

async function wholePin(file: string, root: string): Promise<NativeEvidencePin> {
  const before = await lstat(file, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(INPUT_BYTES));
  assert.equal(await realpath(file), file);
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = createHash('sha256'), buffer = Buffer.alloc(65536); let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
      assert.ok(bytesRead > 0); state.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    for (const current of [await fd.stat({ bigint: true }), await lstat(file, { bigint: true })])
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'] as const) assert.equal(current[key], before[key]);
    const relative = path.relative(root, file).split(path.sep).join('/');
    assert.ok(relative && !relative.startsWith('../') && !path.isAbsolute(relative));
    return { path: relative, bytes: position, sha256: state.digest('hex') };
  } finally { await fd.close(); }
}
function absent(pid: number, group = false): boolean {
  try { process.kill(group ? -pid : pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
async function rootPort(directory: string) {
  const stat = await lstat(directory, { bigint: true });
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); assert.equal(await realpath(directory), directory);
  // 只为本测试自有合成根捕获真实物理命名位，不登记生产来源或Dataset资格。
  return { id: 'cue-input-test-root', path: directory, dev: String(stat.dev), ino: String(stat.ino), authorized: true, label: '自有合成输入' };
}
interface Media {
  id: string; file: string; demuxer: CueInputDemuxer; profile: string; input: NativeEvidencePin;
  probe: Awaited<ReturnType<ReturnType<typeof createCueNativeActor>['probe']>>;
  decoded: NativeEvidencePin; probeRaw: Awaited<ReturnType<typeof rawReceipt>>; decodeRaw: Awaited<ReturnType<typeof rawReceipt>>;
  exactPcm: boolean; snrDb: number | null;
}
interface Context {
  root: string; directory: string; inputs: string; outputs: string;
  actor: ReturnType<typeof createCueNativeActor>; coordinator: PhysicalResourceCoordinator;
  seed: ReturnType<typeof createCueSyntheticWave>; seedFile: string; seedPin: NativeEvidencePin;
  bundle: Awaited<ReturnType<typeof loadBundledCueConverter>>;
  media: Map<string, Media>; handles: FileHandle[]; pids: number[]; closures: unknown[];
  facts: Record<string, unknown>; closed: boolean;
}
let pending: Promise<Context> | undefined;
async function context(): Promise<Context> {
  return pending ??= (async () => {
    assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
    const cue = process.env.MB_V39_CUE_BUNDLE, tags = process.env.MB_V39_TAGS_BUNDLE, root = process.env.MB_V39_NATIVE_PROOF_DIR;
    assert.ok(cue && tags && root, '独立Native域必须明确给出两个实际本地包与新证据根；缺失不能跳过。');
    for (const directory of [cue, tags, root]) { assert.ok(path.isAbsolute(directory)); assert.equal(await realpath(directory), directory); assert.ok((await lstat(directory)).isDirectory()); }
    const cueManifest = await readFile(path.join(cue, 'manifest.json')), tagsManifest = await readFile(path.join(tags, 'manifest.json'));
    const cuePin = process.env.MB_V39_CUE_MANIFEST_SHA256 ?? sha(cueManifest), tagsPin = process.env.MB_V39_TAGS_MANIFEST_SHA256 ?? sha(tagsManifest);
    const bundle = await loadBundledCueConverter(cue, cuePin); await loadLocalAudioTagsBundle(tags, tagsPin);
    const directory = path.join(root, 'cue-input'); await mkdir(directory, { mode: 0o700 });
    const inputs = path.join(directory, 'inputs'), outputs = path.join(directory, 'outputs');
    await mkdir(inputs, { mode: 0o700 }); await mkdir(outputs, { mode: 0o700 });
    await writeFile(path.join(directory, 'cue-manifest.json'), cueManifest, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(directory, 'tags-manifest.json'), tagsManifest, { flag: 'wx', mode: 0o600 });
    const seed = createCueSyntheticWave(96000), seedFile = path.join(inputs, '完整自有源.wav');
    await writeFile(seedFile, seed.wave, { flag: 'wx', mode: 0o600 });
    return { root, directory, inputs, outputs, actor: createCueNativeActor(bundle), coordinator: new PhysicalResourceCoordinator(),
      seed, seedFile, seedPin: await wholePin(seedFile, root), bundle, media: new Map(), handles: [], pids: [], closures: [], closed: false,
      facts: { scope: 'SYNTHETIC_REAL_INPUT_PROBE_AND_DECODE_ONLY_NOT_APP_OR_OUTPUT_QUALIFICATION', readerMs: READER_MS, sourceBytesLimit: INPUT_BYTES,
        cueManifest: await nativeEvidencePin(path.join(directory, 'cue-manifest.json'), root), tagsManifest: await nativeEvidencePin(path.join(directory, 'tags-manifest.json'), root) } };
  })();
}
/** 真FD与物理读写/命名租约；源whole SHA、root及目标inode在每次native fence重验。 */
async function guarded<T extends CueNativeRun>(ctx: Context, label: string, file: string, target: string | null,
  operation: (source: FileHandle, output: FileHandle | undefined, claim: CueNativeClaim, signal: AbortSignal | undefined) => Promise<T>, reader = false) {
  const directory = path.join(ctx.directory, label); await mkdir(directory, { mode: 0o700 });
  const before = await wholePin(file, ctx.root), source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); ctx.handles.push(source);
  let output: FileHandle | undefined, namespace: SourceNamespaceReadClaims | undefined;
  const guards: Array<{ release(): Promise<void> }> = [], commandId = randomUUID();
  const controller = new AbortController(), began = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
  let raw: Awaited<ReturnType<typeof rawReceipt>> | undefined;
  try {
    const sourceInfo = await source.stat({ bigint: true });
    const named = [await captureSourceNamespace(await rootPort(path.dirname(file)), path.basename(file))];
    if (target) {
      output = await open(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); ctx.handles.push(output);
      named.push(await captureSourceNamespace(await rootPort(path.dirname(target)), path.basename(target)));
    }
    namespace = await acquireSourceNamespaceRead(named, ctx.coordinator);
    guards.push(ctx.coordinator.acquireRead([{ dev: String(sourceInfo.dev), ino: String(sourceInfo.ino) }]));
    const targetInfo = output ? await output.stat({ bigint: true }) : null;
    if (targetInfo) guards.push(ctx.coordinator.acquireWrite([{ dev: String(targetInfo.dev), ino: String(targetInfo.ino) }]));
    const claim: CueNativeClaim = { commandId, claimId: randomUUID(), async assertCurrent() {
      assert.equal(namespace?.state, 'held'); assert.deepEqual(await wholePin(file, ctx.root), before);
      const now = await source.stat({ bigint: true }); assert.equal(now.dev, sourceInfo.dev); assert.equal(now.ino, sourceInfo.ino);
      if (reader) assert.ok(performance.now() - began < READER_MS, '完整输入probe沿原Reader3000ms绝对期限，不能重置。');
      if (output && targetInfo) { const actual = await output.stat({ bigint: true }); assert.ok(actual.isFile()); assert.equal(actual.nlink, 1n);
        assert.equal(actual.dev, targetInfo.dev); assert.equal(actual.ino, targetInfo.ino); }
    } };
    if (reader) timer = setTimeout(() => controller.abort(new Error('原输入Reader3000ms期限')), Math.max(1, READER_MS - (performance.now() - began)));
    const result = await operation(source, output, claim, reader ? controller.signal : undefined);
    raw = await rawReceipt(directory, 'run', result, ctx.root);
    assert.equal(result.exitCode, 0); assert.equal(result.signal, null); assert.equal(result.pidClosed, true);
    ctx.pids.push(result.pid); assert.ok(absent(result.pid) && absent(result.pid, true));
    if (reader) assert.ok(performance.now() - began < READER_MS);
    return { result, raw, before };
  } catch (error) {
    if (error instanceof CueNativeRunError) {
      raw = await rawReceipt(directory, 'failure', error.raw, ctx.root);
      if (error.raw.pid !== null) { ctx.pids.push(error.raw.pid); assert.equal(error.raw.pidClosed, true); assert.ok(absent(error.raw.pid) && absent(error.raw.pid, true)); }
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await ctx.actor.join(commandId); await immediate();
    await output?.close(); await source.close();
    for (const handle of [source, output]) if (handle) await assert.rejects(handle.stat(), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF');
    for (const guard of [...guards].reverse()) await guard.release();
    await namespace?.release(); if (namespace) assert.equal(namespace.state, 'released');
    assert.deepEqual(ctx.coordinator.combinedSnapshot(), zero); assert.deepEqual(await wholePin(file, ctx.root), before);
    ctx.closures.push({ label, raw, sourceBefore: before, sourceAfter: await wholePin(file, ctx.root),
      fdsClosed: true, namespaceState: namespace?.state ?? 'NOT_ACQUIRED', actualCombinedResourceSnapshot: ctx.coordinator.combinedSnapshot() });
  }
}
async function inspectInput(ctx: Context, id: string, file: string, demuxer: CueInputDemuxer, profile: string, lossless: boolean): Promise<Media> {
  const probe = await guarded(ctx, id + '-probe', file, null, (source, _output, claim, signal) => ctx.actor.probe(source, demuxer, claim, signal), true);
  assert.equal(probe.result.eof, true); assert.equal(probe.result.frames, ctx.seed.frames); assert.equal(probe.result.sampleRate, ctx.seed.sampleRate); assert.equal(probe.result.channels, ctx.seed.channels);
  const decoded = path.join(ctx.outputs, id + '.s32le');
  const decoding = await guarded(ctx, id + '-decode', file, decoded, (source, output, claim) => { assert.ok(output); return ctx.actor.decode(source, output, demuxer, claim); });
  const pcm = await readFile(decoded); assert.equal(pcm.length, probe.result.frames * probe.result.channels * 4); assert.ok(pcm.length <= INPUT_BYTES);
  const exactPcm = pcm.equals(ctx.seed.pcm); let signalPower = 0, errorPower = 0;
  for (let at = 0; at < pcm.length; at += 4) { const a = ctx.seed.pcm.readInt32LE(at) / 2147483648, b = pcm.readInt32LE(at) / 2147483648; signalPower += a * a; errorPower += (a - b) ** 2; }
  const snrDb = errorPower === 0 ? null : 10 * Math.log10(signalPower / errorPower);
  if (lossless) assert.ok(exactPcm, '完整无损输入的全部PCM字节必须等值，不能只看时长或首帧。');
  else assert.ok(snrDb !== null && snrDb >= 18);
  const media: Media = { id, file, demuxer, profile, input: probe.before, probe: probe.result, decoded: await wholePin(decoded, ctx.root),
    probeRaw: probe.raw, decodeRaw: decoding.raw, exactPcm, snrDb };
  ctx.media.set(id, media); return media;
}
async function encodedInput(ctx: Context, format: typeof CUE_NATIVE_FORMATS[number], profile: CuePcmProfile = 's24'): Promise<Media> {
  const id = format.id + '-' + profile, file = path.join(ctx.inputs, id + '.' + format.extension);
  const encode = await guarded(ctx, id + '-prepare', ctx.seedFile, file, (source, output, claim) => { assert.ok(output);
    return ctx.actor.encode({ source, target: output, demuxer: 'wav', format: format.id, profile, startFrame: 0, frameCount: ctx.seed.frames,
      sampleRate: ctx.seed.sampleRate, channels: ctx.seed.channels, sourceClaim: claim, targetClaim: claim }); });
  const demuxer: CueInputDemuxer = format.id === 'alac' ? 'mov' : format.id === 'pcm-wav' ? 'wav' : format.id === 'pcm-aiff' ? 'aiff'
    : format.id === 'vorbis' || format.id === 'opus' ? 'ogg' : format.id === 'wavpack' ? 'wv' : format.id;
  const row = await inspectInput(ctx, id, file, demuxer, profile, format.lossless);
  ctx.facts[id + '-preparation'] = encode.raw; return row;
}
/** f64仅手写自有输入容器；不添加FFmpeg输出encoder或借输入decoder扩大输出资格。 */
function float64Input(ctx: Context, kind: 'wav' | 'aiff'): Buffer {
  const data = Buffer.alloc(ctx.seed.frames * ctx.seed.channels * 8);
  for (let at = 0; at < ctx.seed.pcm.length / 4; at++) {
    const value = ctx.seed.pcm.readInt32LE(at * 4) / 2147483648;
    if (kind === 'wav') data.writeDoubleLE(value, at * 8); else data.writeDoubleBE(value, at * 8);
  }
  if (kind === 'wav') {
    const header = Buffer.alloc(56); header.write('RIFF'); header.writeUInt32LE(data.length + 48, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(ctx.seed.channels, 22); header.writeUInt32LE(ctx.seed.sampleRate, 24);
    header.writeUInt32LE(ctx.seed.sampleRate * ctx.seed.channels * 8, 28); header.writeUInt16LE(ctx.seed.channels * 8, 32); header.writeUInt16LE(64, 34);
    header.write('fact', 36); header.writeUInt32LE(4, 40); header.writeUInt32LE(ctx.seed.frames, 44); header.write('data', 48); header.writeUInt32LE(data.length, 52);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.alloc(72); header.write('FORM'); header.writeUInt32BE(data.length + 64, 4); header.write('AIFC', 8);
  header.write('FVER', 12); header.writeUInt32BE(4, 16); header.writeUInt32BE(0xa2805140, 20); header.write('COMM', 24); header.writeUInt32BE(24, 28);
  header.writeUInt16BE(ctx.seed.channels, 32); header.writeUInt32BE(ctx.seed.frames, 34); header.writeUInt16BE(64, 38);
  const exponent = Math.floor(Math.log2(ctx.seed.sampleRate)); header.writeUInt16BE(16383 + exponent, 40);
  header.writeBigUInt64BE(BigInt(ctx.seed.sampleRate) << BigInt(63 - exponent), 42); header.write('fl64', 50);
  header.write('SSND', 56); header.writeUInt32BE(data.length + 8, 60);
  return Buffer.concat([header, data]);
}
// 下列格式仅是纯计划的受控schema输入；不签发实际输出格式、Owner或Source资格。
const planFormat: LocalCueFormatQualification = { formatId: 'pcm-wav', revision: 'CONTROLLED_PLAN_SHAPE_ONLY', codec: 'pcm-wav', extension: 'wav', lossless: true, evidence: 'encoder-tag-audio-roundtrip', available: true };
const target = { choiceId: 'controlled-output-choice', label: '自有独立输出', independent: true as const };
function reference(media: Media, id = media.id): CueOwnerAssetReference {
  return { assetId: 'asset-' + id, libraryRootId: 'library-cue-input', sourceRootId: 'source-cue-input', rootRevision: 'root-revision-402',
    fileRevision: 'file-' + media.input.sha256.slice(0, 48), locationRevision: 'location-' + id };
}
function audio(media: Media, asset = reference(media)): LocalCueAudioProbe {
  return { assetReference: asset, sourceLabel: path.basename(media.file), evidence: 'audio-pcm-read',
    readRevision: sha(Buffer.from(JSON.stringify({ source: media.input, probe: media.probeRaw, decoded: media.decoded }))), sampleRate: media.probe.sampleRate, totalPcmFrames: media.probe.frames };
}
function album(id: string, media: readonly Media[], refs = media.map(item => reference(item))): LocalWorkbenchAlbumCapture {
  return { albumId: 'album-' + id, readToken: 'read-' + id, revision: 'album-revision-' + id, rootId: 'library-cue-input', directoryId: 'directory-' + id,
    editionId: null, artistName: '艺术家 雪と花 Δ', albumName: '实际输入合成专辑', directoryName: '合成目录', manualLocks: { artistName: false, albumName: false },
    members: media.map((item, index) => ({ trackId: 'track-' + id + '-' + index, assetId: refs[index]!.assetId, fileName: path.basename(item.file), title: null, artist: null, album: null,
      rootRevision: refs[index]!.rootRevision, fileRevision: refs[index]!.fileRevision, locationRevision: refs[index]!.locationRevision, metadataRevision: 'metadata-' + id + '-' + index })) };
}
function selected(id: string, media: readonly Media[], text: string, refs = media.map(item => reference(item))): LocalCueSheetCapture {
  const parsed = parseCueText(text, new Map(media.map((item, index) => [path.basename(item.file), [refs[index]!]])));
  assert.equal(parsed.status, 'ok');
  return { album: album(id, media, refs), cueId: 'cue-' + id, cueRevision: 'cue-' + sha(Buffer.from(text)), parsed, audio: media.map((item, index) => audio(item, refs[index])) };
}
const input = (selections: readonly LocalCueSheetCapture[]) => ({ selections, target, format: planFormat, pregapPolicy: 'append-to-previous' as const });

test(names[0], { skip: unsupported }, async () => {
  const ctx = await context();
  for (const format of CUE_NATIVE_FORMATS) await encodedInput(ctx, format);
  assert.deepEqual([...new Set([...ctx.media.values()].map(row => row.demuxer))].sort(), ['aiff', 'flac', 'mov', 'mp3', 'ogg', 'wav', 'wv']);
  assert.equal(ctx.media.size, 8); assert.equal(ctx.media.get('vorbis-s24')!.probe.codec, 'vorbis'); assert.equal(ctx.media.get('opus-s24')!.probe.codec, 'opus');
  assert.deepEqual(await wholePin(ctx.seedFile, ctx.root), ctx.seedPin); assert.deepEqual(ctx.coordinator.combinedSnapshot(), zero);
  ctx.facts.sevenDemuxersAndEightInputFamiliesPassed = true;
});

test(names[1], { skip: unsupported }, async () => {
  const ctx = await context();
  for (const id of ['pcm-wav', 'pcm-aiff'] as const) {
    const format = CUE_NATIVE_FORMATS.find(row => row.id === id)!;
    for (const profile of ['s16', 's32', 'f32'] as const) await encodedInput(ctx, format, profile);
    const kind = id === 'pcm-wav' ? 'wav' : 'aiff', file = path.join(ctx.inputs, id + '-f64.' + kind);
    await writeFile(file, float64Input(ctx, kind), { flag: 'wx', mode: 0o600 }); await inspectInput(ctx, id + '-f64', file, kind, 'f64-input-only', true);
    for (const [profile, bits, codec] of [['s16', 16, 's16'], ['s24', 24, 's24'], ['s32', 32, 's32'], ['f32', 32, 'f32'], ['f64', 64, 'f64']] as const) {
      const row = ctx.media.get(id + '-' + profile)!; assert.equal(row.probe.bitsPerSample, bits); assert.ok(row.probe.codec.includes(codec)); assert.ok(row.exactPcm);
    }
  }
  const encoders = CUE_FFMPEG_CONFIGURE.find(row => row.startsWith('--enable-encoder='))!;
  assert.ok(!encoders.includes('pcm_f64')); assert.equal(ctx.media.size, 16); ctx.facts.float64IsInputDecoderOnly = true;
});

test(names[2], { skip: unsupported }, async () => {
  const ctx = await context(), wave = ctx.media.get('pcm-wav-s24')!, flac = ctx.media.get('flac-s24')!;
  // 实际文件同stem、不同容器；新名字只拷贝本测试完整原件，不推断关联。
  const copies: Media[] = [];
  for (const [source, extension] of [[wave, 'wav'], [flac, 'flac']] as const) {
    const file = path.join(ctx.inputs, '同名源.' + extension); await writeFile(file, await readFile(source.file), { flag: 'wx', mode: 0o600 });
    copies.push(await inspectInput(ctx, 'same-stem-' + extension, file, source.demuxer, source.profile, true));
  }
  const text = 'TITLE "雪と花 Δ"\nFILE "同名源.wav" WAVE\nTRACK 01 AUDIO\nTITLE "第一轨/花."\nINDEX 00 00:00:00\nINDEX 01 00:00:01\nTRACK 02 AUDIO\nTITLE "第二轨"\nINDEX 00 00:01:00\nINDEX 01 00:01:02\nFILE "同名源.flac" WAVE\nTRACK 03 AUDIO\nTITLE "第三轨"\nINDEX 01 00:00:02\n';
  const item = selected('multi', copies, text), before = structuredClone(item), result = buildLocalCuePlan(input([item]));
  assert.deepEqual(result.draft.tracks.map(row => [row.startFrame, row.frameCount]), [[0, 49280], [49280, 46720], [1280, 94720]]);
  assert.deepEqual(result.outputs.map(row => row.sourceAssetId), [reference(copies[0]!).assetId, reference(copies[0]!).assetId, reference(copies[1]!).assetId]);
  assert.deepEqual(result.outputs.map(row => row.sourceReadRevision), [item.audio[0]!.readRevision, item.audio[0]!.readRevision, item.audio[1]!.readRevision]);
  assert.ok(result.draft.tracks.every(row => !/[\\/]/u.test(row.outputName))); assert.equal(result.draft.sourceDisposition, 'retain'); assert.deepEqual(item, before);
  assert.equal(localCueCdFramesToPcm(1, 32000), 426); assert.equal(localCueCdFramesToPcm(76, 32000), 32426);
  const outside = structuredClone(item); if (outside.parsed.status === 'ok') outside.parsed.tracks[2]!.index01Frames = 150;
  assert.throws(() => buildLocalCuePlan(input([outside])));
  const ambiguous = parseCueText(text, new Map([['同名源.wav', [reference(copies[0]!), reference(copies[1]!)]], ['同名源.flac', [reference(copies[1]!)]]]));
  assert.deepEqual(ambiguous, { status: 'failure', code: 'AMBIGUOUS_FILE' });
  assert.deepEqual(parseCueText(text.replace('00:00:01', '00:00:75'), new Map([['同名源.wav', [reference(copies[0]!)]], ['同名源.flac', [reference(copies[1]!)]]])), { status: 'failure', code: 'MALFORMED' });
  ctx.facts.multiFile = { cueSha256: sha(Buffer.from(text)), sourceBindings: result.outputs, ranges: result.draft.tracks.map(row => ({ startFrame: row.startFrame, frameCount: row.frameCount, outputName: row.outputName })) };
});

test(names[3], { skip: unsupported }, async () => {
  const ctx = await context(), media = ctx.media.get('pcm-wav-s24')!, basename = path.basename(media.file);
  const text = 'FILE "' + basename + '" WAVE\n' + Array.from({ length: 99 }, (_v, i) => 'TRACK ' + String(i + 1).padStart(2, '0') + ' AUDIO\nINDEX 01 00:' + String(Math.floor(i / 75)).padStart(2, '0') + ':' + String(i % 75).padStart(2, '0') + '\n').join('');
  // 控制纯预览的逻辑别名，不把这些fixture专辑/asset登记为生产来源或执行9900项。
  const selections = Array.from({ length: 100 }, (_v, i) => selected('group-' + i, [media], text, [reference(media, 'group-' + i)]));
  const before = sha(Buffer.from(JSON.stringify(selections))), result = buildLocalCuePlan(input(selections));
  assert.equal(result.draft.tracks.length, 9900); assert.equal(result.outputs.length, 9900); assert.equal(new Set(result.draft.tracks.map(row => row.outputName)).size, 9900);
  assert.equal(sha(Buffer.from(JSON.stringify(selections))), before); assert.throws(() => buildLocalCuePlan(input([...selections, { ...selections[0]!, album: { ...selections[0]!.album, albumId: 'album-101' } }])));
  assert.deepEqual(parseCueText(text + 'TRACK 99 AUDIO\nINDEX 01 00:01:24\n', new Map([[basename, [reference(media)]]])), { status: 'failure', code: 'MALFORMED' });
  const excess = structuredClone(selections[0]!); if (excess.parsed.status === 'ok') excess.parsed.tracks.push({ ...excess.parsed.tracks[98]!, trackNumber: 100 });
  assert.throws(() => buildLocalCuePlan(input([excess])));
  const refs = Array.from({ length: 33 }, (_v, i) => reference(media, 'file-' + i));
  const association = new Map(refs.map((ref, i) => ['源' + i + '.wav', [ref]]));
  const filesText = Array.from({ length: 33 }, (_v, i) => 'FILE "源' + i + '.wav" WAVE\nTRACK ' + String(i + 1).padStart(2, '0') + ' AUDIO\nINDEX 01 00:00:00\n');
  assert.equal(parseCueText(filesText.slice(0, 32).join(''), association).status, 'ok');
  assert.deepEqual(parseCueText(filesText.join(''), association), { status: 'failure', code: 'BUDGET_EXCEEDED' });
  const base = album('bytes', [media]), member = base.members[0]!; assert.ok(member.assetId !== null);
  const largeMembers = Array.from({ length: 4000 }, (_v, i) => ({ ...member, trackId: 'bounded-track-' + i, assetId: 'bounded-asset-' + i,
    title: '量'.repeat(1000), artist: '量'.repeat(1000), album: '量'.repeat(1000) }));
  const capture = { datasetId: 'CONTROLLED_SHAPE_ONLY', datasetRevision: 'revision-402', albums: [{ ...base, members: largeMembers }] };
  assert.ok(isLocalWorkbenchAlbumCapture(capture.albums[0]));
  let low = 1, high = largeMembers.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2); capture.albums[0]!.members = largeMembers.slice(0, middle);
    if (Buffer.byteLength(JSON.stringify(capture)) <= INPUT_BYTES) low = middle; else high = middle - 1;
  }
  capture.albums[0]!.members = largeMembers.slice(0, low);
  const acceptedBytes = Buffer.byteLength(JSON.stringify(capture)); assert.ok(isLocalWorkbenchPlanCapture(capture));
  capture.albums[0]!.members.push({ ...largeMembers[0]!, trackId: 'bounded-track-over', assetId: 'bounded-asset-over' });
  const rejectedBytes = Buffer.byteLength(JSON.stringify(capture)); assert.ok(rejectedBytes > INPUT_BYTES); assert.ok(isLocalWorkbenchAlbumCapture(capture.albums[0])); assert.equal(isLocalWorkbenchPlanCapture(capture), false);
  ctx.facts.pureGroupBoundaries = { albums: 100, tracksPerAlbum: 99, completeOutputs: result.outputs.length, filesLimit: 32, acceptedBytes, rejectedBytes,
    executed9900Outputs: false, snapshotBudgetRaised: false };
});

test(names[4], { skip: unsupported }, async () => {
  const ctx = await context(), media = ctx.media.get('pcm-wav-s24')!, basename = path.basename(media.file);
  const item = selected('refusal', [media], 'FILE "' + basename + '" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n');
  const original = sha(Buffer.from(JSON.stringify(item)));
  for (const patch of [{ available: false }, { extension: 'm4a' }, { evidence: 'binary-version' }, { codec: 'pcm-f64' }, { lossless: false }])
    assert.throws(() => buildLocalCuePlan({ ...input([item]), format: { ...planFormat, ...patch } as LocalCueFormatQualification }));
  let invoked = false; const accessor = { ...planFormat }; Object.defineProperty(accessor, 'available', { enumerable: true, get() { invoked = true; return true; } });
  assert.throws(() => buildLocalCuePlan({ ...input([item]), format: accessor })); assert.equal(invoked, false);
  assert.throws(() => createCueNativeActor(structuredClone(ctx.bundle)));
  assert.throws(() => readCueQualifiedFormats({ formats: [], bundles: {}, physicalClosure: { fdsClosed: true, processesClosed: true, claimsReleased: true } } as unknown as Parameters<typeof readCueQualifiedFormats>[0]));
  for (const key of ['rootRevision', 'fileRevision', 'locationRevision'] as const) {
    const bad = structuredClone(item); bad.album.members = bad.album.members.map(member => { assert.ok(member.assetId !== null); return { ...member, [key]: 'changed-' + key }; }); assert.throws(() => buildLocalCuePlan(input([bad])));
  }
  for (const name of ['../源.wav', '/源.wav', 'a\\源.wav', 'https:源.wav']) assert.deepEqual(parseCueText('FILE "' + name + '" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n', new Map([[name, [reference(media)]]])), { status: 'failure', code: 'MALFORMED' });
  assert.throws(() => buildLocalCuePlan({ ...input([item]), target: { ...target, independent: false } as unknown as typeof target }));
  await assert.rejects(guarded(ctx, 'same-file-target', media.file, null, (source, _output, claim) => ctx.actor.encode({ source, target: source,
    demuxer: 'wav', format: 'pcm-wav', profile: 's24', startFrame: 0, frameCount: ctx.seed.frames, sampleRate: ctx.seed.sampleRate,
    channels: ctx.seed.channels, sourceClaim: claim, targetClaim: claim })), /独占的新文件/u);
  const hidden = input([item]); Object.defineProperty(hidden, 'sourceDisposition', { value: 'delete', enumerable: false }); assert.throws(() => buildLocalCuePlan(hidden));
  assert.equal(sha(Buffer.from(JSON.stringify(item))), original); assert.deepEqual(await wholePin(media.file, ctx.root), media.input);
  ctx.facts.closedRefusals = { fakeNativeBrand: true, fakeOutputQualification: true, weakShape: true, alteredRevisions: true, paths: true, nonIndependentTarget: true,
    actualSameFileTargetRejectedBeforeNativeSpawn: true, originalPreserved: true };
});

test(names[5], { skip: unsupported }, async () => {
  const ctx = await context(), file = path.join(ctx.inputs, '坏结构.wav');
  await writeFile(file, Buffer.from('RIFF\x20\x00\x00\x00WAVEfmt 这不是完整音频帧'), { flag: 'wx', mode: 0o600 }); const before = await wholePin(file, ctx.root);
  await assert.rejects(guarded(ctx, 'bad-input-probe', file, null, (source, _output, claim, signal) => ctx.actor.probe(source, 'wav', claim, signal), true), (error: unknown) => error instanceof CueNativeRunError && error.raw.exitCode !== 0 && error.raw.pidClosed);
  await assert.rejects(guarded(ctx, 'bad-input-decode', file, path.join(ctx.outputs, 'bad-input.s32le'), (source, output, claim) => { assert.ok(output); return ctx.actor.decode(source, output, 'wav', claim); }), (error: unknown) => error instanceof CueNativeRunError && error.raw.exitCode !== 0 && error.raw.pidClosed);
  assert.deepEqual(await wholePin(file, ctx.root), before); assert.deepEqual(ctx.coordinator.combinedSnapshot(), zero);
  const media = ctx.media.get('pcm-wav-s24')!;
  const recovered = await guarded(ctx, 'after-failure-valid-probe', media.file, null, (source, _output, claim, signal) => ctx.actor.probe(source, 'wav', claim, signal), true);
  assert.equal(recovered.result.frames, ctx.seed.frames); assert.equal(ctx.actor.inspect().unverified, 0); assert.equal(ctx.actor.inspect().running, 0);
  ctx.facts.failedAudioClosedAndNextValidInputRead = true;
});

test.after(async () => {
  if (!pending) return;
  const ctx = await pending; await ctx.actor.close(); ctx.closed = true;
  assert.equal(ctx.actor.inspect().running, 0); assert.equal(ctx.actor.inspect().unverified, 0); assert.deepEqual(ctx.coordinator.combinedSnapshot(), zero);
  for (const handle of ctx.handles) await assert.rejects(handle.stat(), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF');
  for (const pid of ctx.pids) assert.ok(absent(pid) && absent(pid, true));
  assert.deepEqual(await wholePin(ctx.seedFile, ctx.root), ctx.seedPin);
  const profiles = [];
  for (const row of ctx.media.values()) { assert.deepEqual(await wholePin(row.file, ctx.root), row.input);
    profiles.push({ id: row.id, demuxer: row.demuxer, profile: row.profile, input: row.input, decoded: row.decoded, expectedFrames: ctx.seed.frames,
      actualFrames: row.probe.frames, sampleRate: row.probe.sampleRate, channels: row.probe.channels, codec: row.probe.codec, sampleFormat: row.probe.sampleFormat,
      bitsPerSample: row.probe.bitsPerSample, eof: row.probe.eof, probe: row.probeRaw, decode: row.decodeRaw, exactPcm: row.exactPcm, snrDb: row.snrDb, sourceUnchanged: true }); }
  const evidence = { schema: 'musicbridge.v39.cue-input-formats.evidence.v1', source: ctx.seedPin, facts: ctx.facts, profiles, operations: ctx.closures,
    actualOutputEncoderTagQualificationGranted: false, actualSourceQualificationGranted: false,
    physicalClosure: { fdsClosed: true, processesClosed: true, claimsReleased: true, actualResourceSnapshot: ctx.coordinator.combinedSnapshot(), observedPidsAbsent: ctx.pids.length } };
  const filename = path.join(ctx.directory, 'input-formats.json'); await writeFile(filename, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await mergeNativeEvidence(ctx.root, { cueInputFormats: { raw: await nativeEvidencePin(filename, ctx.root), inputDemuxers: ['wav', 'aiff', 'flac', 'mp3', 'ogg', 'wv', 'mov'],
    completeInputProfiles: profiles.length, actualOutputEncoderTagQualificationGranted: false, physicalClosure: evidence.physicalClosure } });
});
