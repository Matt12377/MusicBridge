import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Rust Gate 使用项目固定的 Node.js 22.x。');
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = path.join(root, 'native/rust-core/Cargo.toml');
const pin = fs.readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8').match(/channel\s*=\s*"([^"]+)"/)?.[1];
if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) throw new Error('Rust 工具链必须固定完整版本。');
const hosted = process.env.GITHUB_ACTIONS === 'true' && Boolean(process.env.RUNNER_TEMP);
const external = '/Volumes/LifeWeave/Developer/CommandLine';
if (process.platform === 'darwin' && !hosted) {
  if (!fs.existsSync(external) || fs.statSync('/Volumes/LifeWeave').dev === fs.statSync('/').dev) throw new Error('LifeWeave 外置卷未挂载，停止 Rust Gate。');
  fs.accessSync(external, fs.constants.W_OK);
}
const buildRoot = process.platform === 'darwin' && !hosted ? external : process.env.RUNNER_TEMP ?? os.tmpdir();
const baseDirectory = path.resolve(process.env.MUSIC_BRIDGE_RUST_GATE_DIR ?? path.join(buildRoot, 'tmp/musicbridge-rust-core-gate'));
const within = (candidate, parent) => candidate === parent || candidate.startsWith(parent + path.sep);
function externalDirectory(candidate) {
  if (process.platform === 'darwin' && !hosted) {
    if (!within(candidate, external)) throw new Error('Rust Gate 目录必须位于外置构建根。');
    let ancestor = candidate;
    while (!fs.existsSync(ancestor)) {
      if (fs.lstatSync(path.dirname(ancestor), { throwIfNoEntry: false })?.isSymbolicLink()
        && !fs.existsSync(path.dirname(ancestor))) throw new Error('Rust Gate 目录存在断链。');
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('Rust Gate 路径无效。');
      ancestor = parent;
    }
    if (!within(fs.realpathSync(ancestor), fs.realpathSync(external))) throw new Error('Rust Gate 目录不能通过链接回落本机卷。');
  }
  fs.mkdirSync(candidate, { recursive: true });
  if (process.platform === 'darwin' && !hosted && !within(fs.realpathSync(candidate), fs.realpathSync(external))) throw new Error('Rust Gate 真实目录越界。');
}
externalDirectory(baseDirectory);
// 每次验证使用独立结果目录；旧 PASS 不能混进一次新的失败。
const directory = fs.mkdtempSync(path.join(baseDirectory, 'run-'));
const cache = process.platform === 'darwin' && !hosted ? path.join(external, 'Caches/Cargo') : path.join(directory, 'cargo-home');
const target = path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(directory, 'target'));
const cargoHome = path.resolve(process.env.CARGO_HOME ?? cache);
for (const candidate of [target, cargoHome]) {
  externalDirectory(candidate);
}
const temporary = path.join(directory, 'tmp'); externalDirectory(temporary);
function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : [absolute];
  });
}
function sourceManifest() {
  return [
    ...sourceFiles(path.join(root, 'native/rust-core')),
    ...sourceFiles(path.join(root, 'packages/bridge-core/src')),
    ...sourceFiles(path.join(root, 'packages/contracts/src')),
    ...sourceFiles(path.join(root, 'packages/bridge-core/test/helpers')),
    ...sourceFiles(path.join(root, 'packages/bridge-core/test/rust-core')),
    path.join(root, 'rust-toolchain.toml'), path.join(root, 'package.json'),
    path.join(root, 'pnpm-lock.yaml'), path.join(root, 'pnpm-workspace.yaml'),
    path.join(root, 'packages/bridge-core/package.json'), path.join(root, 'packages/contracts/package.json'),
    path.join(root, 'scripts/ci/verify-rust-core.mjs'), path.join(root, 'scripts/ci/verify-boundaries.mjs'),
    path.join(root, '.github/workflows/rust-core.yml'), path.join(root, 'packages/bridge-core/test/rust-sidecar-client.test.ts'),
    path.join(root, 'packages/bridge-core/test/dataset-collection-snapshot.test.ts'),
  ].sort().map(file => ({ path: path.relative(root, file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
}
const sources = sourceManifest();
const env = { ...process.env, RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? pin,
  CARGO_HOME: cargoHome, CARGO_TARGET_DIR: target, TMPDIR: temporary };
const runs = [];
function run(name, command, args, cwd = root, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  const log = path.join(directory, name + '.log');
  fs.writeFileSync(log, JSON.stringify({ command, args, cwd }) + '\n' + (result.stdout ?? '') + (result.stderr ?? ''));
  runs.push({ name, command, args, exitCode: result.status, signal: result.signal, log,
    sha256: createHash('sha256').update(fs.readFileSync(log)).digest('hex') });
  if (result.error || result.status !== 0 || result.signal !== null) {
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ pin, runs }, null, 2) + '\n');
    throw new Error('Rust Gate 失败：' + name + '，详情见 ' + log);
  }
  console.log('RUST_GATE=' + name + ' PASS');
  return result.stdout;
}
const compiler = run('rustc-version', 'rustc', ['--version']).trim();
const cargoVersion = run('cargo-version', 'cargo', ['--version']).trim();
if (!compiler.startsWith('rustc ' + pin + ' ') || !cargoVersion.startsWith('cargo ' + pin + ' ')) throw new Error('实际 Rust 工具链与固定版本不匹配。');
run('fmt', 'cargo', ['fmt', '--manifest-path', manifestPath, '--all', '--', '--check']);
run('clippy', 'cargo', ['clippy', '--manifest-path', manifestPath, '--locked', '--all-targets', '--', '-D', 'warnings']);
run('rust-test', 'cargo', ['test', '--manifest-path', manifestPath, '--locked']);
const metadata = JSON.parse(run('metadata', 'cargo', ['metadata', '--manifest-path', manifestPath, '--locked', '--format-version=1']));
const allowed = new Set(['musicbridge-rust-core', 'serde', 'serde_core', 'serde_derive', 'serde_json', 'itoa', 'memchr', 'zmij',
  'proc-macro2', 'quote', 'syn', 'unicode-ident']);
const allowedBuildScripts = new Set(['serde', 'serde_core', 'serde_json', 'zmij', 'proc-macro2', 'quote']);
if (metadata.packages.some(p => !allowed.has(p.name) || p.targets.some(t => t.kind.includes('custom-build') && !allowedBuildScripts.has(p.name)))) throw new Error('Rust 原型依赖越过固定 JSON 计算边界。');
run('rust-build', 'cargo', ['build', '--manifest-path', manifestPath, '--locked', '--release']);
const binary = path.join(target, 'release', 'musicbridge-rust-core' + (process.platform === 'win32' ? '.exe' : ''));
const binarySha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
run('contracts-build', 'corepack', ['pnpm@10.17.1', '--filter', '@music-bridge/contracts', 'run', 'build']);
run('ts-client', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/rust-sidecar-client.test.ts'], path.join(root, 'packages/bridge-core'));
run('node-atomic-snapshot', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/dataset-collection-snapshot.test.ts'], path.join(root, 'packages/bridge-core'));
const costReport = path.join(directory, 'atomic-snapshot-cost.json');
run('ts-rust-integration', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-core/readonly-integration.test.ts', 'test/rust-core/atomic-snapshot-integration.test.ts'],
  path.join(root, 'packages/bridge-core'), { MUSIC_BRIDGE_RUST_BINARY: binary, MUSIC_BRIDGE_RUST_SHA256: binarySha256,
    MUSIC_BRIDGE_RUST_COST_REPORT: costReport });
const cost = JSON.parse(fs.readFileSync(costReport, 'utf8'));
if (cost.task !== 'RUST-002' || cost.models !== 2_000 || cost.differentialPages !== 108 || cost.binarySha256 !== binarySha256
  || !['exportRoundtripMs', 'fromOwnerReadyMs', 'remainingStartupMs', 'closeAckAndNaturalExitMs'].every(key => Number.isFinite(cost[key]) && cost[key] >= 0)
  || !['nodeQueryRoundtripMs', 'rustQueryRoundtripIncludingTsValidationMs'].every(key => Array.isArray(cost[key]) && cost[key].length === 10 && cost[key].every(n => Number.isFinite(n) && n >= 0))) throw new Error('实际快照成本记录缺失或不属于本轮二进制。');
if (createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== binarySha256) throw new Error('Rust 二进制在验证期间改变。');
if (JSON.stringify(sourceManifest()) !== JSON.stringify(sources)) throw new Error('Rust Gate 的受测源码在执行期间改变。');
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, task: 'RUST-002', compiler, cargoVersion, sources,
  binary: { path: binary, sha256: binarySha256, platform: process.platform, architecture: process.arch },
  packages: metadata.packages.map(p => ({ name: p.name, version: p.version })), runs,
  realServices: 'NOT_RUN', productionDefault: 'Node', readonlyCommands: ['collection.list'],
  protocolVersions: [1, 2], nodeAtomicSnapshot: true,
  filters: ['query', 'brand', 'decade', 'stockState'],
  costReport: { path: costReport, sha256: createHash('sha256').update(fs.readFileSync(costReport)).digest('hex') },
}, null, 2) + '\n');
console.log('RUST_GATE=PASS manifest=' + path.join(directory, 'manifest.json'));
