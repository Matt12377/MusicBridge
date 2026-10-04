import { buildStoragePolicy } from '../../apps/desktop/scripts/build-storage-root.mjs';
import { rustGateSources, hostGateSources, RUST_GATE_RUN_NAMES } from './rust-gate-inputs.mjs';
import { readFileSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digestFile = file => hash(readFileSync(file));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function requireFact(value, message) { if (!value) throw new Error(message); }
function relative(value) { requireFact(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), '宿主manifest路径不规范。'); return value; }
function dataFile(root, value) {
  const file = path.join(root, relative(value)), info = lstatSync(file);
  requireFact(info.isFile() && !info.isSymbolicLink() && realpathSync(file) === file, '宿主输入必须是根内真实文件。'); return file;
}
function entries(value, label, keys = ['path', 'sha256']) {
  requireFact(Array.isArray(value) && value.length > 0, label + '清单缺失。');
  const paths = new Set();
  for (const entry of value) { requireFact(JSON.stringify(Object.keys(entry).sort()) === JSON.stringify([...keys].sort()), label + '字段不闭集。'); relative(entry.path); requireFact(!paths.has(entry.path) && sha(entry.sha256), label + '身份重复或无效。'); paths.add(entry.path); }
}
export function verifyRustElectronHosts(manifestPath, { root, runDirectory, platform = process.platform, architecture = process.arch }) {
  requireFact(path.resolve(root) === root && realpathSync(root) === root && path.resolve(runDirectory) === runDirectory && realpathSync(runDirectory) === runDirectory, '父进程指定的本轮根必须真实规范。');
  requireFact(manifestPath === path.join(runDirectory, 'manifest.json'), '只接受父进程本次指定的完整Rust成功manifest。');
  const bytes = readFileSync(dataFile(runDirectory, 'manifest.json')), manifest = JSON.parse(bytes.toString());
  requireFact(manifest.schemaVersion === 1 && manifest.task === 'RUST-009' && manifest.productionDefault === 'Node' && manifest.realServices === 'NOT_RUN', 'Rust成功manifest身份不符。');
  requireFact(Array.isArray(manifest.runs) && manifest.runs.length > 0 && manifest.runs.every(run => run.exitCode === 0 && run.signal === null), '只有完整本次运行全部自然成功才可移交。');
  requireFact(JSON.stringify(manifest.runs.map(run => run.name)) === JSON.stringify(RUST_GATE_RUN_NAMES), '本次完整Rust run集合缺项、额外项或顺序改变。');
  const runNames = new Set();
  for (const run of manifest.runs) {
    requireFact(typeof run.name === 'string' && /^[a-z0-9-]+$/u.test(run.name) && !runNames.has(run.name), '本次run名称不规范或重复。'); runNames.add(run.name);
    requireFact(run.log === path.join(runDirectory, run.name + '.log') && sha(run.sha256), '本次run日志不属于父进程指定目录。');
    requireFact(digestFile(dataFile(runDirectory, run.name + '.log')) === run.sha256, '本次run日志改变。');
  }
  const binaryPath = path.join(runDirectory, 'target/release/musicbridge-rust-core' + (platform === 'win32' ? '.exe' : ''));
  requireFact(manifest.binary?.path === binaryPath && manifest.binary.platform === platform && manifest.binary.architecture === architecture && sha(manifest.binary.sha256), '本次binary路径/平台/架构不符。');
  requireFact(digestFile(dataFile(runDirectory, path.relative(runDirectory, binaryPath))) === manifest.binary.sha256, '本次Rust binary改变。');
  entries(manifest.sources, 'Rust源码');
  requireFact(JSON.stringify(manifest.sources.map(source => source.path)) === JSON.stringify(rustGateSources(root).map(source => source.path)), 'Rust源码集合缩水或额外项。');
  for (const source of manifest.sources) requireFact(digestFile(dataFile(root, source.path)) === source.sha256, 'Rust成功后源码改变：' + source.path);
  const hostRoots = {};
  for (const [field, name, task] of [['mainUiHostBuild', 'isolated-host', 'RUST-008'], ['collectionUiHostBuild', 'isolated-collection-host', 'RUST-009']]) {
    const buildRoot = path.join(runDirectory, name), record = manifest[field];
    requireFact(record && record.path === path.join(buildRoot, 'artifact-manifest.json') && sha(record.sha256), '两宿主必须属于同一成功run。');
    const artifactBytes = readFileSync(dataFile(buildRoot, 'artifact-manifest.json'));
    requireFact(hash(artifactBytes) === record.sha256, '宿主manifest字节改变。');
    const artifact = JSON.parse(artifactBytes.toString());
    requireFact(artifact.schemaVersion === 1 && artifact.task === task && artifact.output === buildRoot && artifact.binaryPath === binaryPath && artifact.binarySha256 === manifest.binary.sha256, '宿主编译pin不属于本轮Rust。');
    entries(artifact.sources, '宿主源码'); entries(artifact.artifacts, '宿主产物', ['path', 'sha256', 'bytes']);
    requireFact(JSON.stringify(artifact.sources.map(source => source.path)) === JSON.stringify(hostGateSources(root, task).map(source => source.path)), '宿主源码集合缩水或额外项。');
    requireFact(hash(JSON.stringify(artifact.sources)) === artifact.sourceAggregateSha256, '宿主源码aggregate不一致。');
    for (const source of artifact.sources) requireFact(digestFile(dataFile(root, source.path)) === source.sha256, '宿主源码身份改变：' + source.path);
    const actual = [];
    function walk(directory, prefix) { for (const entry of readdirSync(directory, { withFileTypes: true })) { const item = prefix + entry.name; requireFact(!entry.isSymbolicLink(), '宿主产物内禁止隐式链接。'); if (entry.isDirectory()) walk(path.join(directory, entry.name), item + '/'); else { requireFact(entry.isFile(), '宿主产物类型无效。'); actual.push(item); } } }
    for (const section of ['main', 'preload', 'renderer']) walk(path.join(buildRoot, section), section + '/'); actual.push('package.json');
    requireFact(JSON.stringify(actual.sort()) === JSON.stringify(artifact.artifacts.map(entry => entry.path).sort()), '宿主完整产物集合不一致。');
    for (const file of artifact.artifacts) { const filePath = dataFile(buildRoot, file.path); requireFact(lstatSync(filePath).size === file.bytes && digestFile(filePath) === file.sha256, '宿主产物改变：' + file.path); }
    hostRoots[field] = buildRoot;
  }
  return { schemaVersion: 1, kind: 'SAME_RUN_RUST_HOSTS_NOT_ELECTRON_ACCEPTANCE', manifestPath, manifestSha256: hash(bytes), binaryPath, binarySha256: manifest.binary.sha256, platform, architecture,
    mainHostBuildRoot: hostRoots.mainUiHostBuild, collectionHostBuildRoot: hostRoots.collectionUiHostBuild };
}

export function readRustElectronHostsReceipt(receiptPath, root) {
  requireFact(typeof receiptPath === 'string' && path.isAbsolute(receiptPath), '缺少父进程本次Rust成功收据。');
  buildStoragePolicy().check(receiptPath, { mustExist: true, kind: 'file' });
  const runDirectory = path.dirname(receiptPath);
  requireFact(path.basename(receiptPath) === 'electron-hosts-receipt.json', 'Rust收据名称不符。');
  const recorded = JSON.parse(readFileSync(dataFile(runDirectory, 'electron-hosts-receipt.json'), 'utf8'));
  const current = verifyRustElectronHosts(path.join(runDirectory, 'manifest.json'), { root, runDirectory });
  requireFact(JSON.stringify(recorded) === JSON.stringify(current), 'Rust成功收据与本次完整manifest不一致。');
  return current;
}
