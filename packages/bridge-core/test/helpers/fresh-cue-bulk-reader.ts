import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

interface BuildFile { file: string; bytes: number; sha256: string }
/** Root编译前冻结输入、成功后声明实际输出；本helper仅读核身份，不编译、不生成声明。 */
async function fresh(kind: 'legacy' | 'bulk'): Promise<string> {
  assert.equal(process.versions.node.split('.')[0], '22');
  const bulk = kind === 'bulk', declaration = process.env[bulk ? 'MB_CUE_BULK_BUILD_BINDING' : 'MBRS003_CUE_BUILD_BINDING'];
  assert.ok(declaration && path.isAbsolute(declaration), 'Root须提供本次实际CUE编译身份声明。');
  buildStoragePolicy().check(declaration, { mustExist: true, kind: 'file' });
  const binding = JSON.parse(await readFile(declaration, 'utf8')) as { schema: string; compilerExit: number;
    compilerStartedAtMs: number; compilerFinishedAtMs: number; sourceInputs: BuildFile[]; outputs: BuildFile[] };
  assert.equal(binding.schema, bulk ? 'musicbridge.cue-bulk.fresh-build.v1' : 'mbrs003.cue.fresh-build.v1');
  assert.equal(binding.compilerExit, 0);
  assert.ok(binding.compilerStartedAtMs > 0 && binding.compilerFinishedAtMs >= binding.compilerStartedAtMs);
  const stems = bulk ? ['cue-sidecar-bulk-reader','cue-sidecar-bulk-worker'] : ['cue-sidecar-reader','cue-sidecar-worker'];
  const sources = stems.map(stem => `src/library/${stem}.ts`), outputs = stems.flatMap(stem => ['.js','.js.map'].map(suffix => `dist/library/${stem}${suffix}`));
  assert.deepEqual(binding.sourceInputs.map(value => value.file).sort(), sources.sort());
  assert.deepEqual(binding.outputs.map(value => value.file).sort(), outputs.sort());
  const coreRoot = fileURLToPath(new URL('../../', import.meta.url));
  for (const entry of [...binding.sourceInputs, ...binding.outputs]) {
    assert.ok([...sources,...outputs].includes(entry.file));
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && /^[a-f0-9]{64}$/u.test(entry.sha256));
    const target = path.join(coreRoot, entry.file), info = await lstat(target), bytes = await readFile(target);
    assert.ok(info.isFile() && !info.isSymbolicLink()); assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    if (entry.file.startsWith('dist/')) assert.ok(info.mtimeMs >= binding.compilerStartedAtMs && info.mtimeMs <= binding.compilerFinishedAtMs);
  }
  for (const stem of stems) {
    const js = `dist/library/${stem}.js`, map = JSON.parse(await readFile(path.join(coreRoot, js + '.map'), 'utf8')) as { file: string; sourceRoot: string; sources: string[] };
    assert.equal(map.file, `${stem}.js`); assert.equal(map.sourceRoot, ''); assert.equal(map.sources.length, 1);
    assert.equal(path.resolve(path.dirname(path.join(coreRoot, js)), map.sources[0]!), path.join(coreRoot, `src/library/${stem}.ts`));
  }
  return pathToFileURL(path.join(coreRoot, `dist/library/${stems[0]}.js`)).href;
}
export async function freshBulkCueReader(): Promise<typeof import('../../src/library/cue-sidecar-bulk-reader.js')> {
  const module = await import(await fresh('bulk')) as typeof import('../../src/library/cue-sidecar-bulk-reader.js');
  assert.equal(typeof module.createCueSidecarBulkReader, 'function'); return module;
}
export async function freshLegacyCueReader(): Promise<typeof import('../../src/library/cue-sidecar-reader.js')> {
  const module = await import(await fresh('legacy')) as typeof import('../../src/library/cue-sidecar-reader.js');
  assert.equal(typeof module.createCueSidecarReader, 'function'); return module;
}
