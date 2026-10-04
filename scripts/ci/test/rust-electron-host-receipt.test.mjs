import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { rustGateSources, hostGateSources, RUST_GATE_RUN_NAMES } from '../rust-gate-inputs.mjs';
import { verifyRustElectronHosts } from '../rust-electron-host-receipt.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/u, '');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR));
  const runDirectory = mkdtempSync(path.join(process.env.TMPDIR, 'musicbridge-host-receipt-'));
  const put = (name, bytes) => { const file = path.join(runDirectory, name); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, bytes); return file; };
  const binaryPath = put('target/release/musicbridge-rust-core' + (process.platform === 'win32' ? '.exe' : ''), '明确合成binary，非App运行\n'), binarySha256 = sha(readFileSync(binaryPath));
  const manifest = { schemaVersion: 1, task: 'RUST-009', productionDefault: 'Node', realServices: 'NOT_RUN', binary: { path: binaryPath, sha256: binarySha256, platform: process.platform, architecture: process.arch },
    sources: rustGateSources(root), runs: RUST_GATE_RUN_NAMES.map(name => { const log = put(name + '.log', '合成闭集收据负例输入\n'); return { name, exitCode: 0, signal: null, log, sha256: sha(readFileSync(log)) }; }) };
  for (const [field, name, task] of [['mainUiHostBuild', 'isolated-host', 'RUST-008'], ['collectionUiHostBuild', 'isolated-collection-host', 'RUST-009']]) {
    const sources = hostGateSources(root, task), artifacts = [];
    for (const file of ['main/index.js', 'preload/index.js', 'renderer/index.html', 'package.json']) {
      const bytes = Buffer.from('合成artifact:' + file), target = put(name + '/' + file, bytes);
      artifacts.push({ path: file, sha256: sha(bytes), bytes: bytes.length });
    }
    const artifact = { schemaVersion: 1, task, output: path.join(runDirectory, name), binaryPath, binarySha256, sources, sourceAggregateSha256: sha(JSON.stringify(sources)), artifacts };
    const bytes = JSON.stringify(artifact), file = put(name + '/artifact-manifest.json', bytes);
    manifest[field] = { path: file, sha256: sha(bytes) };
  }
  const manifestPath = put('manifest.json', JSON.stringify(manifest));
  return { runDirectory, manifest, manifestPath, put, verify: () => verifyRustElectronHosts(manifestPath, { root, runDirectory }), save: () => put('manifest.json', JSON.stringify(manifest)) };
}
test('本次两host闭集成功收据只表示合成结构核验', () => { const f = fixture(); assert.equal(f.verify().kind, 'SAME_RUN_RUST_HOSTS_NOT_ELECTRON_ACCEPTANCE'); });
for (const [name, mutate] of Object.entries({
  '缺run': f => f.manifest.runs.pop(), '重复run': f => f.manifest.runs.push(f.manifest.runs[0]), '额外run': f => f.manifest.runs.push({ ...f.manifest.runs[0], name: 'extra' }),
  '非零退出': f => f.manifest.runs[0].exitCode = 1, 'signal退出': f => f.manifest.runs[0].signal = 'SIGTERM',
  '缩水源码': f => f.manifest.sources.pop(), '源码逃逸': f => f.manifest.sources[0].path = '../outside', '重复源码': f => f.manifest.sources.push(f.manifest.sources[0]),
  '额外源码字段': f => f.manifest.sources[0].extra = true, '额外源码': f => f.manifest.sources.push({ path: 'tasks/RUST-016-ci-security-portability.md', sha256: 'a'.repeat(64) }),
  '不同run宿主': f => f.manifest.mainUiHostBuild.path = path.join(f.runDirectory, '../old/artifact-manifest.json'),
  '改变binary': f => f.put(path.relative(f.runDirectory, f.manifest.binary.path), 'changed'), '日志身份变化': f => f.put(f.manifest.runs[0].name + '.log', 'changed'),
  '宿主漏源': f => { const record = f.manifest.mainUiHostBuild, value = JSON.parse(readFileSync(record.path)); value.sources.pop(); value.sourceAggregateSha256 = sha(JSON.stringify(value.sources)); const bytes = JSON.stringify(value); f.put('isolated-host/artifact-manifest.json', bytes); record.sha256 = sha(bytes); },
  '宿主额外产物': f => f.put('isolated-host/main/extra.js', 'extra'),
})) test('Rust host移交独立拒绝：' + name, () => { const f = fixture(); mutate(f); f.save(); assert.throws(f.verify); });
