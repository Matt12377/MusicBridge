import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync, type Stats } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MetadataReadBudget, MetadataReaderLifecycle, MetadataReadResult } from '../src/library/metadata-reader-types.js';
import { mobileOwnerDirectPlaybackKind } from '../src/mobile/catalog-service.js';
import { loadFreshMetadataReader } from './helpers/mbrs003-audio-fixtures.js';

// 全部媒体都是自有合成字节；真正读取同一次 fresh dist 的固定 Worker，不借普通曲库或 Roon。
const readerModule = await loadFreshMetadataReader();
const files = await import(new URL('../dist/recording/source-files.js', import.meta.url).href) as typeof import('../src/recording/source-files.js');
const locks = await import(new URL('../dist/stream/physical-resource-locks.js', import.meta.url).href) as typeof import('../src/stream/physical-resource-locks.js');
const parserVersion = 'music-metadata-11.15.0/mbrs003-v4';
const pcmGuid = '0100000000001000800000aa00389b71', floatGuid = '0300000000001000800000aa00389b71';
const rate = 48000, frames = 4800, tags = { title: '合成扩展 WAVE', artist: '合成艺人', album: '合成专辑' };
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function chunk(id: string, payload: Buffer, declaredBytes = payload.length): Buffer {
  const head = Buffer.alloc(8); head.write(id, 0, 'ascii'); head.writeUInt32LE(declaredBytes, 4);
  return Buffer.concat([head, payload, ...(payload.length % 2 ? [Buffer.alloc(1)] : [])]);
}
function riff(parts: readonly Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...parts]), head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]);
}
interface FormatOptions {
  tag?: number; size?: number; cbSize?: number; bits?: number; validBits?: number; channels?: number;
  sampleRate?: number; align?: number; byteRate?: number; mask?: number; guid?: string;
}
function formatBytes(options: FormatOptions = {}): Buffer {
  const tag = options.tag ?? 0xfffe, bits = options.bits ?? 24, channels = options.channels ?? 2;
  const sampleRate = options.sampleRate ?? rate, align = options.align ?? channels * bits / 8;
  const bytes = Buffer.alloc(options.size ?? (tag === 0xfffe ? 40 : 18));
  bytes.writeUInt16LE(tag, 0); bytes.writeUInt16LE(channels, 2); bytes.writeUInt32LE(sampleRate, 4);
  bytes.writeUInt32LE(options.byteRate ?? sampleRate * align, 8); bytes.writeUInt16LE(align, 12); bytes.writeUInt16LE(bits, 14);
  if (bytes.length >= 18) bytes.writeUInt16LE(options.cbSize ?? (tag === 0xfffe ? 22 : 0), 16);
  if (bytes.length >= 40) {
    bytes.writeUInt16LE(options.validBits ?? bits, 18); bytes.writeUInt32LE(options.mask ?? 3, 20);
    Buffer.from(options.guid ?? pcmGuid, 'hex').copy(bytes, 24);
  }
  return bytes;
}
function info(): Buffer {
  return chunk('LIST', Buffer.concat([Buffer.from('INFO', 'ascii'), ...Object.entries({ INAM: tags.title, IART: tags.artist, IPRD: tags.album })
    .map(([key, value]) => chunk(key, Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])])))]));
}
interface WaveOptions {
  format?: FormatOptions; fmt?: Buffer; declaredFmtBytes?: number; duplicate?: Buffer; fact?: 'before' | 'after';
  emptyLists?: number; dataBytes?: number;
}
function wave(options: WaveOptions = {}): Buffer {
  const fmt = options.fmt ?? formatBytes(options.format), align = options.format?.align
    ?? (options.format?.channels ?? 2) * (options.format?.bits ?? 24) / 8;
  const data = chunk('data', Buffer.alloc(options.dataBytes ?? frames * align));
  const factBytes = Buffer.alloc(4); factBytes.writeUInt32LE(frames);
  const fact = chunk('fact', factBytes);
  return riff([chunk('fmt ', fmt, options.declaredFmtBytes), ...(options.duplicate ? [chunk('fmt ', options.duplicate)] : []),
    ...(options.fact === 'before' ? [fact] : []), data, ...(options.fact === 'after' ? [fact] : []),
    ...Array.from({ length: options.emptyLists ?? 0 }, () => chunk('LIST', Buffer.alloc(0))), info()]);
}
function sourceIdentity(st: Stats): Record<string, string> {
  return Object.fromEntries(['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeMs', 'ctimeMs', 'birthtimeMs']
    .map(key => [key, String(st[key as keyof Stats])]));
}
function closed(fd: number): boolean {
  try { fstatSync(fd); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EBADF'; }
}
function quiet(events: readonly MetadataReaderLifecycle[], result: MetadataReadResult): void {
  const starts = events.filter((event): event is Extract<MetadataReaderLifecycle, { type: 'worker-start' | 'worker-online' }> => event.type === 'worker-start');
  assert.equal(starts.length, 1, '每次读取都启动真实固定 Worker');
  const start = starts[0]!, acquired = events.findIndex(event => event.type === 'lease-acquired' && event.fd === start.fd);
  const exited = events.findIndex(event => event.type === 'worker-exit' && event.threadId === start.threadId);
  const released = events.findIndex(event => event.type === 'lease-released' && event.fd === start.fd);
  const completed = events.findIndex(event => event.type === 'read-complete');
  assert.equal(acquired >= 0 && exited > acquired && released > exited && completed > released, true,
    '成功与失败均等待 Worker exit，再释放原 FD 和完成');
  assert.equal(closed(start.fd), true);
  const exit = events[exited]!; assert.equal(exit.type === 'worker-exit' && exit.exitCode === 0, true);
  const completion = events[completed]!; assert.equal(completion.type === 'read-complete' && completion.status === result.status, true);
  assert.ok(result.readEvidence); assert.equal(result.readEvidence.wholeAudioHash, false); assert.equal(result.readEvidence.wholeAudioDecode, false);
  assert.ok(result.readEvidence.bytesRead <= 32 * 1024 * 1024);
  assert.ok(result.readEvidence.maxReadBytes <= 8 * 1024 * 1024);
  assert.ok(result.readEvidence.allocationBytes <= 64 * 1024 * 1024);
}
async function fixture(t: TestContext, entries: Readonly<Record<string, Buffer>>, trustedBudget?: Partial<MetadataReadBudget>) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && path.isAbsolute(temporary), 'Root 提供批准外置 tmp');
  assert.equal(await realpath(temporary), temporary);
  const parent = await lstat(temporary); assert.equal(parent.isDirectory() && !parent.isSymbolicLink(), true);
  assert.equal(parent.mode & 0o777, 0o700); assert.equal(parent.uid, process.getuid!());
  const directory = await mkdtemp(path.join(temporary, 'local-library-wave-extensible-')); await chmod(directory, 0o700);
  const beforeClaims = locks.physicalResourceLocks.combinedSnapshot();
  const originals = new Map<string, { bytes: Buffer; sha256: string; identity: Record<string, string>; signature: string }>();
  for (const [relative, bytes] of Object.entries(entries)) {
    assert.match(relative, /^[a-z0-9-]+\.wav$/u);
    const file = path.join(directory, relative); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const st = await lstat(file); assert.equal(st.nlink, 1); assert.equal(st.mode & 0o777, 0o600);
    originals.set(relative, { bytes: Buffer.from(bytes), sha256: digest(bytes), identity: sourceIdentity(st), signature: '' });
  }
  const root = { ...await files.authorizeSourceDirectory(directory), id: randomUUID() };
  for (const [relative, before] of originals) before.signature = (await files.readonlySourceCandidateMetadata(root, relative)).signature;
  const events: MetadataReaderLifecycle[] = [], reader = readerModule.createMetadataReader({
    ...(trustedBudget ? { trustedBudget } : {}), onLifecycle: event => events.push(event),
  });
  t.after(async () => {
    await reader.close();
    for (const [relative, before] of originals) {
      const file = path.join(directory, relative), bytes = await readFile(file);
      assert.deepEqual(sourceIdentity(await lstat(file)), before.identity, '原源文件的身份和时间元数据保持');
      assert.deepEqual(bytes, before.bytes); assert.equal(digest(bytes), before.sha256);
      assert.equal((await files.readonlySourceCandidateMetadata(root, relative)).signature, before.signature);
    }
    assert.deepEqual(locks.physicalResourceLocks.combinedSnapshot(), beforeClaims, '没有遗留物理读 claim');
  });
  return { async read(relative: string) {
    const before = originals.get(relative); assert.ok(before);
    const first = events.length, result = await reader.read({ root, relative, expectedSignature: before.signature });
    quiet(events.slice(first), result); return result;
  } };
}
function success(result: MetadataReadResult): Extract<MetadataReadResult, { status: 'ok' }> {
  assert.equal(result.status, 'ok'); if (result.status !== 'ok') assert.fail('固定 Worker 应完成有效 fmt 解析');
  assert.equal(result.parserVersion, parserVersion); assert.deepEqual(result.fields, tags); assert.deepEqual(result.coverEvidence, []);
  return result;
}

const validCases: readonly { label: string; options: WaveOptions; codec: 'PCM' | 'IEEE_FLOAT'; bits: number }[] = [
  { label: '扩展 PCM 无 fact', options: {}, codec: 'PCM', bits: 24 },
  { label: '扩展 PCM fact 在 data 前', options: { fact: 'before' }, codec: 'PCM', bits: 24 },
  { label: '扩展 PCM fact 在 data 后', options: { fact: 'after' }, codec: 'PCM', bits: 24 },
  { label: '扩展 PCM 保留两个空 LIST 后的 INFO', options: { fact: 'after', emptyLists: 2 }, codec: 'PCM', bits: 24 },
  { label: 'PCM 容器 32 有效 24 保持容器位宽', options: { format: { bits: 32, validBits: 24 } }, codec: 'PCM', bits: 32 },
  { label: '完整 fmt 接受已验界的额外扩展区', options: { format: { size: 42, cbSize: 24 } }, codec: 'PCM', bits: 24 },
  { label: '扩展 float32 无 fact', options: { format: { bits: 32, guid: floatGuid } }, codec: 'IEEE_FLOAT', bits: 32 },
  { label: '扩展 float32 fact 在 data 前', options: { format: { bits: 32, guid: floatGuid }, fact: 'before' }, codec: 'IEEE_FLOAT', bits: 32 },
  { label: '扩展 float64 无 fact', options: { format: { bits: 64, guid: floatGuid } }, codec: 'IEEE_FLOAT', bits: 64 },
  { label: '扩展 float64 fact 在 data 后', options: { format: { bits: 64, guid: floatGuid }, fact: 'after' }, codec: 'IEEE_FLOAT', bits: 64 },
  { label: '标准 PCM 16 字节 fmt 带 fact 仍无损', options: { format: { tag: 1, size: 16 }, fact: 'after' }, codec: 'PCM', bits: 24 },
  { label: '标准 float18 fmt 带 fact 仍无损', options: { format: { tag: 3, bits: 32 }, fact: 'after' }, codec: 'IEEE_FLOAT', bits: 32 },
  { label: '扩展 PCM 未声明 speaker mask 不补造布局', options: { format: { mask: 0 } }, codec: 'PCM', bits: 24 },
];
for (const entry of validCases) test(`本地 WAVE 完整格式：${entry.label}`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, { 'valid.wav': wave(entry.options) }), value = success(await f.read('valid.wav'));
  assert.deepEqual(value.technical, { container: 'WAVE', codec: entry.codec, lossless: true, sampleRateHz: rate, channels: 2,
    bitsPerSample: entry.bits, durationSeconds: frames / rate, evidence: 'bounded-parser-reported' });
  const { durationSeconds, ...parameters } = value.technical;
  assert.equal(mobileOwnerDirectPlaybackKind({ ...parameters, durationMs: durationSeconds! * 1000 }), entry.codec === 'PCM' ? 'WAVE' : null,
    '格式更正只沿原整数 direct 白名单；float 不获得新资格');
});

const unknownCases: readonly { label: string; options: WaveOptions }[] = [
  { label: '其它完整 SubFormat', options: { format: { guid: '0200000000001000800000aa00389b71' } } },
  { label: '仅 GUID 尾字节不同不冒 PCM', options: { format: { guid: '0100000000001000800000aa00389b70' }, fact: 'after' } },
  { label: '空 GUID 无 fact 不冒无损', options: { format: { guid: '00000000000000000000000000000000' } } },
  { label: 'Data1 低字为 1 不等于完整 PCM GUID', options: { format: { guid: '0100010000001000800000aa00389b71' } } },
  { label: '未知子格式 Samples union 不套 PCM validBits', options: { format: { guid: '0200000000001000800000aa00389b71', validBits: 0 } } },
];
for (const entry of unknownCases) test(`本地 WAVE 未知格式：${entry.label}`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, { 'unknown.wav': wave(entry.options) }), value = success(await f.read('unknown.wav'));
  assert.equal(value.technical.codec, 'WAVE_EXTENSIBLE_UNKNOWN'); assert.equal(value.technical.lossless, null);
  const { durationSeconds, ...parameters } = value.technical;
  assert.equal(mobileOwnerDirectPlaybackKind({ ...parameters, durationMs: durationSeconds! * 1000 }), null);
});

const malformedCases: readonly { label: string; bytes(): Buffer }[] = [
  { label: 'fmt 不足基础 16 字节', bytes: () => wave({ fmt: formatBytes().subarray(0, 15) }) },
  { label: 'extensible 缺少扩展区', bytes: () => wave({ fmt: formatBytes().subarray(0, 16) }) },
  { label: '完整 GUID 截断一字节', bytes: () => wave({ fmt: formatBytes().subarray(0, 39) }) },
  { label: 'cbSize 小于 22', bytes: () => wave({ format: { cbSize: 21 } }) },
  { label: 'cbSize 比真实扩展区多一字节', bytes: () => wave({ format: { cbSize: 23 } }) },
  { label: 'cbSize 超块不跨进 data', bytes: () => wave({ format: { cbSize: 65535 } }) },
  { label: 'PCM 有效位为零', bytes: () => wave({ format: { validBits: 0 } }) },
  { label: 'PCM 有效位大于容器位宽', bytes: () => wave({ format: { validBits: 25 } }) },
  { label: 'float 容器位宽不是 32 或 64', bytes: () => wave({ format: { guid: floatGuid } }) },
  { label: 'float 有效位不完整', bytes: () => wave({ format: { guid: floatGuid, bits: 32, validBits: 31 } }) },
  { label: '采样率为零', bytes: () => wave({ format: { sampleRate: 0 } }) },
  { label: '声道为零', bytes: () => wave({ format: { channels: 0 }, dataBytes: 6 }) },
  { label: '声道超原上限', bytes: () => wave({ format: { channels: 65 } }) },
  { label: 'blockAlign 与 PCM 容器不符', bytes: () => wave({ format: { align: 5 } }) },
  { label: 'byteRate 与 PCM 规格不符', bytes: () => wave({ format: { byteRate: rate * 6 + 1 } }) },
  { label: 'PCM 容器不是字节位宽', bytes: () => wave({ format: { bits: 20 } }) },
  { label: '非零 mask 声道计数冲突', bytes: () => wave({ format: { mask: 4 } }) },
  { label: '重复同一 fmt 不拼接解析事实', bytes: () => wave({ duplicate: formatBytes() }) },
  { label: '冲突 fmt 不混用首尾事实', bytes: () => wave({ duplicate: formatBytes({ guid: floatGuid, bits: 32 }) }) },
  { label: 'fmt 声明越过 RIFF', bytes: () => wave({ declaredFmtBytes: 1_000_000 }) },
  { label: '实际 FD 截断 RIFF', bytes: () => wave().subarray(0, -1) },
  { label: 'PCM data 不是完整 frame', bytes: () => wave({ dataBytes: 7 }) },
];
for (const entry of malformedCases) test(`本地 WAVE 畸形格式拒绝：${entry.label}`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, { 'invalid.wav': entry.bytes() }), result = await f.read('invalid.wav');
  assert.equal(result.status, 'failure'); if (result.status === 'failure') assert.equal(result.code, 'PARSE_FAILED');
});

const budgetCases: readonly { label: string; budget: Partial<MetadataReadBudget> }[] = [
  { label: '总读额度计入额外 fmt 读取', budget: { totalReadBytes: 80 } },
  { label: '单读上限不因 fmt 修复提高', budget: { singleReadBytes: 32 } },
  { label: '单分配上限不因 fmt 修复提高', budget: { singleAllocationBytes: 32 } },
];
for (const entry of budgetCases) test(`本地 WAVE 原预算：${entry.label}`, { timeout: 30_000 }, async t => {
  const f = await fixture(t, { 'budget.wav': wave() }, entry.budget), result = await f.read('budget.wav');
  assert.equal(result.status, 'failure'); if (result.status === 'failure') assert.equal(result.code, 'BUDGET_EXCEEDED');
  assert.ok(result.readEvidence);
  if (entry.budget.totalReadBytes !== undefined) assert.ok(result.readEvidence.bytesRead <= entry.budget.totalReadBytes);
  if (entry.budget.singleReadBytes !== undefined) assert.ok(result.readEvidence.maxReadBytes <= entry.budget.singleReadBytes);
  if (entry.budget.singleAllocationBytes !== undefined) assert.ok(result.readEvidence.allocationBytes <= entry.budget.singleAllocationBytes);
});
test('本地 WAVE 畸形读取后原池恢复，未知格式不污染下一完整 PCM', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { 'invalid.wav': wave({ format: { cbSize: 21 } }),
    'unknown.wav': wave({ format: { guid: '0100000000001000800000aa00389b70' } }), 'valid.wav': wave({ fact: 'after' }) });
  const invalid = await f.read('invalid.wav'); assert.equal(invalid.status, 'failure');
  const unknown = success(await f.read('unknown.wav')); assert.equal(unknown.technical.codec, 'WAVE_EXTENSIBLE_UNKNOWN');
  const valid = success(await f.read('valid.wav')); assert.equal(valid.technical.codec, 'PCM'); assert.equal(valid.technical.lossless, true);
});
