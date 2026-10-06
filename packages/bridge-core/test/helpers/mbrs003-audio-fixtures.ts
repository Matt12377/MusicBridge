import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { readFixedMetadataWorkerBundle } from '../../scripts/metadata-reader-bundle-artifacts.mjs';

export interface AudioFixtureEntry {
  id: string; file: string; bytes: number; sha256: string; kind: 'audio' | 'png';
  observedAudio?: { codec: string; sampleRate: number; channels: number };
  expectedTags?: { title: string; artist: string; album: string };
  expectedTitleBytes?: number;
  expectedCover?: { bytes: number; sha256: string; mime: string; width: number; height: number };
  expectedReadable?: false;
}
interface Manifest { schema: string; synthetic: boolean; files: AudioFixtureEntry[] }
const fixturesRoot = fileURLToPath(new URL('../fixtures/mbrs003/audio/', import.meta.url));
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const coreAudioIds = ['core-flac', 'core-mp3', 'core-m4a-alac', 'core-m4a-aac', 'core-wav', 'core-aiff'] as const;
const manifestHash = '5e4157b8fa3428a82def6c128e5e60dce3cc90186b804d835c9be8e957c8feb1';

// 只消费已封合成字节。每次测试创建自己的私有副本，原件不修改、无自动删除。
export async function audioFixture(t: TestContext) {
  const raw = await readFile(path.join(fixturesRoot, 'manifest.json'));
  assert.equal(sha256(raw), manifestHash, 'portable manifest身份必须保持');
  const manifest = JSON.parse(raw.toString('utf8')) as Manifest;
  assert.equal(manifest.schema, 'mbrs003.synthetic-audio-portable.v1');
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.files.length, 19);
  assert.equal(new Set(manifest.files.map(f => f.id)).size, 19);
  const temporaryRoot = process.env.TMPDIR;
  assert.equal(typeof temporaryRoot === 'string' && path.isAbsolute(temporaryRoot), true, 'root须提供批准私有TMPDIR');
  const policy = buildStoragePolicy(), temporary = policy.check(temporaryRoot!, { mustExist: true });
  const parent = await lstat(temporary);
  assert.equal(parent.isDirectory() && !parent.isSymbolicLink(), true);
  assert.equal(await realpath(temporary), temporary);
  assert.equal(parent.mode & 0o777, 0o700);
  assert.equal(typeof process.getuid, 'function');
  assert.equal(parent.uid, process.getuid!());
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-mbrs003-reader-'));
  await chmod(directory, 0o700); policy.check(directory, { mustExist: true });
  const byId = new Map(manifest.files.map(entry => [entry.id, entry]));
  async function checkedBytes(entry: AudioFixtureEntry, base = fixturesRoot): Promise<Buffer> {
    assert.equal(/^(?:fixtures|inputs)\/[A-Za-z0-9.-]+$/u.test(entry.file), true, '夹具路径闭集且纯relative');
    const file = path.join(base, entry.file), info = await lstat(file);
    assert.equal(info.isFile() && !info.isSymbolicLink(), true);
    const bytes = await readFile(file);
    assert.equal(bytes.length, entry.bytes, '夹具长度保持');
    assert.equal(sha256(bytes), entry.sha256, '夹具SHA保持');
    return bytes;
  }
  for (const entry of manifest.files) {
    const bytes = await checkedBytes(entry);
    const file = path.join(directory, entry.file);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const info = await lstat(file);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.nlink, 1);
    assert.equal(info.uid, process.getuid!());
  }
  const root = { ...await authorizeSourceDirectory(directory), id: randomUUID() };
  const entry = (id: string): AudioFixtureEntry => {
    const value = byId.get(id); assert.ok(value, '必须消费manifest中已封夹具'); return value;
  };
  const assertUnchanged = async (): Promise<void> => {
    for (const item of manifest.files) { await checkedBytes(item); await checkedBytes(item, directory); }
  };
  t.after(assertUnchanged);
  return { directory, root, manifest, entry, assertUnchanged,
    file: (id: string) => path.join(directory, entry(id).file),
    bytes: (id: string) => checkedBytes(entry(id), directory) };
}

interface BuildFileIdentity { file: string; bytes: number; sha256: string }
interface ReaderBuildBinding {
  schema: 'mbrs003.reader.fresh-build.v2'; compilerExit: 0;
  fixedWorkerBundle: unknown;
  compilerStartedAtMs: number; compilerFinishedAtMs: number;
  sourceInputs: BuildFileIdentity[]; outputs: BuildFileIdentity[];
}
const coreRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const readerSources = [
  'src/recording/source-files.ts',
  'src/library/metadata-reader.ts',
  'src/library/metadata-reader-worker.ts',
  'src/library/metadata-reader-types.ts',
] as const;
// root先独立冻结precompile输入，编译后确认全部输入不变才生成声明。
// 本helper只核声明与现字节/新产物身份，不构建、不换worker入口，缺声明属准备失败。
export async function loadFreshMetadataReader(): Promise<typeof import('../../src/library/metadata-reader.js')> {
  assert.equal(process.versions.node.split('.')[0], '22', 'Reader测试沿实际Node22');
  const declaration = process.env.MBRS003_READER_BUILD_BINDING;
  assert.equal(typeof declaration === 'string' && path.isAbsolute(declaration), true, 'PREPARATION_FAILED: root须提供fresh Reader编译身份声明');
  const policy = buildStoragePolicy();
  policy.check(declaration!, { mustExist: true, kind: 'file' });
  const binding = JSON.parse((await readFile(declaration!)).toString('utf8')) as ReaderBuildBinding;
  assert.equal(binding.schema, 'mbrs003.reader.fresh-build.v2', 'bundle Reader不接受历史v1假声明'); assert.equal(binding.compilerExit, 0);
  assert.equal(Number.isFinite(binding.compilerStartedAtMs) && binding.compilerStartedAtMs > 0 &&
    Number.isFinite(binding.compilerFinishedAtMs) && binding.compilerFinishedAtMs >= binding.compilerStartedAtMs, true);
  assert.equal(binding.sourceInputs.length, 4); assert.equal(binding.outputs.length, 8);
  assert.equal(new Set(binding.sourceInputs.map(f => f.file)).size, 4);
  assert.equal(new Set(binding.outputs.map(f => f.file)).size, 8);
  const outputs = new Map(binding.outputs.map(f => [f.file, f]));
  async function verify(file: BuildFileIdentity, fresh: boolean): Promise<void> {
    assert.equal(/^(?:src|dist)\/(?:library|recording)\/[A-Za-z0-9.-]+$/u.test(file.file), true);
    assert.equal(Number.isSafeInteger(file.bytes) && file.bytes > 0 && /^[a-f0-9]{64}$/u.test(file.sha256), true);
    const target = path.join(coreRoot, file.file), info = await lstat(target);
    assert.equal(info.isFile() && !info.isSymbolicLink(), true);
    const bytes = await readFile(target); assert.equal(bytes.length, file.bytes); assert.equal(sha256(bytes), file.sha256);
    if (fresh) assert.equal(info.mtimeMs >= binding.compilerStartedAtMs && info.mtimeMs <= binding.compilerFinishedAtMs, true,
      'JS/map必须本次compiler区间实际写入，不能复用旧dist');
  }
  for (const source of readerSources) {
    const declared = binding.sourceInputs.find(f => f.file === source);
    assert.ok(declared, '编译前独立冻结声明必须覆盖全部Reader源码');
    await verify(declared, false);
    const js = source.replace(/^src\//u, 'dist/').replace(/\.ts$/u, '.js'), mapFile = js + '.map';
    const jsIdentity = outputs.get(js), mapIdentity = outputs.get(mapFile);
    assert.ok(jsIdentity); assert.ok(mapIdentity); await verify(jsIdentity, true); await verify(mapIdentity, true);
    const map = JSON.parse((await readFile(path.join(coreRoot, mapFile))).toString('utf8')) as { file: string; sourceRoot: string; sources: string[] };
    assert.equal(map.file, path.basename(js)); assert.equal(map.sourceRoot, ''); assert.equal(map.sources.length, 1);
    assert.equal(path.resolve(path.dirname(path.join(coreRoot, mapFile)), map.sources[0]!), path.join(coreRoot, source));
  }
  const fixed = await readFixedMetadataWorkerBundle(coreRoot);
  assert.deepEqual(binding.fixedWorkerBundle, fixed.manifest, 'v2必须覆盖实际bundle、builder、adapter、graph及map');
  const reader = await import(pathToFileURL(path.join(coreRoot, 'dist/library/metadata-reader.js')).href) as typeof import('../../src/library/metadata-reader.js');
  assert.equal(typeof reader.createMetadataReader, 'function'); return reader;
}
