import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';

const source = readFileSync(new URL('../../../apps/desktop/scripts/prepare-electron-identity.mjs', import.meta.url), 'utf8');
// 执行原准备脚本；仅下载/写盘与官方资产核验为明确外部seam，路径校验器仍用真实代码。
async function execute(env) {
  const events = [], policy = buildStoragePolicy({ env, platform: 'linux' });
  const sourceIdentity = { packageRoot: path.join(env.RUNNER_TEMP, 'musicbridge-fixture/package'), assetName: 'synthetic.zip', checksums: {} };
  const archive = path.join(env.DEV_CACHE_ROOT, 'Electron/synthetic.zip');
  const body = source.replace(/^import[^\n]+;\n/gmu, '');
  const execution = vm.runInNewContext('(async () => {\n' + body + '\n})()', {
    path, process: { env, platform: process.platform, arch: process.arch }, ELECTRON_VERSION: '43.4.0',
    buildStoragePolicy: () => policy,
    electronSource: () => { events.push({ kind: 'source' }); return sourceIdentity; },
    createRequire: () => name => { assert.equal(name, '@electron/get'); return { downloadArtifact: async options => { events.push({ kind: 'download', options }); return archive; } }; },
    mkdirSync: directory => events.push({ kind: 'mkdir', directory }),
    mkdtempSync: prefix => { events.push({ kind: 'mkdtemp', prefix }); return prefix + 'synthetic'; },
    writeFileSync: (file, bytes, options) => events.push({ kind: 'write', file, options }),
    appendFileSync: file => events.push({ kind: 'append', file }),
    verifyElectronArchive: file => { events.push({ kind: 'verify', file }); return { kind: 'SYNTHETIC_PREPARATION_NOT_OFFICIAL_ELECTRON' }; },
    console: { log: () => undefined },
  });
  try { await execution; return { events, error: null }; } catch (error) { return { events, error }; }
}
function fixture() {
  assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR));
  const base = mkdtempSync(path.join(process.env.TMPDIR, 'musicbridge-preparation-order-'));
  const runner = path.join(base, 'runner'), tmp = path.join(runner, 'musicbridge-fixture/tmp'), cache = path.join(runner, 'musicbridge-fixture/cache');
  mkdirSync(tmp, { recursive: true, mode: 0o700 }); mkdirSync(path.join(cache, 'Electron'), { recursive: true, mode: 0o700 });
  const outside = path.join(base, 'outside'); mkdirSync(outside, { mode: 0o700 });
  const alias = path.join(runner, 'musicbridge-fixture/alias'); symlinkSync(tmp, alias);
  return { tmp, outside, alias, env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: runner, TMPDIR: tmp, DEV_CACHE_ROOT: cache } };
}
for (const invalid of ['missing', 'outside', 'symlink']) test('Electron下载前严格TMPDIR拒绝且零落盘：' + invalid, async () => {
  const f = fixture(), env = { ...f.env, TMPDIR: invalid === 'missing' ? undefined : invalid === 'outside' ? f.outside : f.alias };
  const result = await execute(env);
  assert.ok(result.error); assert.deepEqual(result.events, [], '路径拒绝必须先于source读取、下载及任何写盘seam');
});
test('Electron准备下载和receipt只复用同一已受验TMPDIR', async () => {
  const f = fixture(), result = await execute(f.env);
  assert.equal(result.error, null);
  const download = result.events.find(event => event.kind === 'download'), temp = result.events.find(event => event.kind === 'mkdtemp');
  assert.equal(download.options.tempDirectory, f.tmp); assert.equal(temp.prefix, path.join(f.tmp, 'musicbridge-electron-identity-'));
  assert.deepEqual(result.events.map(event => event.kind), ['source', 'mkdir', 'download', 'verify', 'mkdtemp', 'write']);
  assert.equal(result.events.find(event => event.kind === 'write').options.flag, 'wx');
});
