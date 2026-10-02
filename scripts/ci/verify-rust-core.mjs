import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyRustMainEvidence } from './rust-main-evidence.mjs';

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
    ...sourceFiles(path.join(root, 'apps/desktop/src')),
    ...sourceFiles(path.join(root, 'apps/desktop/test/helpers')),
    ...sourceFiles(path.join(root, 'apps/desktop/test/rust-core')),
    path.join(root, 'rust-toolchain.toml'), path.join(root, 'package.json'),
    path.join(root, 'pnpm-lock.yaml'), path.join(root, 'pnpm-workspace.yaml'),
    path.join(root, 'packages/bridge-core/package.json'), path.join(root, 'packages/contracts/package.json'),
    path.join(root, 'scripts/ci/verify-rust-core.mjs'), path.join(root, 'scripts/ci/verify-boundaries.mjs'),
    path.join(root, 'scripts/ci/rust-main-evidence.mjs'),
    path.join(root, 'scripts/ci/test/rust-main-evidence.test.mjs'),
    path.join(root, 'scripts/ci/rust-collection-evidence.mjs'),
    path.join(root, 'scripts/ci/test/rust-collection-evidence.test.mjs'),
    path.join(root, '.github/workflows/rust-core.yml'), path.join(root, 'packages/bridge-core/test/rust-sidecar-client.test.ts'),
    path.join(root, 'packages/bridge-core/test/dataset-collection-snapshot.test.ts'),
    path.join(root, 'packages/bridge-core/test/dataset-snapshot-version.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-readonly-router.test.ts'),
    path.join(root, 'packages/bridge-core/test/dataset-large-snapshot.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-large-sidecar.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-query-index.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-core-owner-lifecycle.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-core-utility-options.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-readonly-node-reads.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-core-host-controls.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-readonly-main-boundary.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-readonly-collection-ui.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-collection-ui-node-purity.test.ts'),
    path.join(root, 'apps/desktop/test/rust-core-host.test.ts'),
    path.join(root, 'apps/desktop/test/native-output-device-package.test.ts'),
    path.join(root, 'apps/desktop/package.json'), path.join(root, 'apps/desktop/tsconfig.json'),
    path.join(root, 'apps/desktop/electron.vite.config.ts'),
    ...sourceFiles(path.join(root, 'apps/desktop/e2e')).filter(file => /\/(?:private-rust-|rust-main-host|rust-collection-host)/.test(file)),
    path.join(root, 'apps/desktop/electron-gate/rust-main-host.test.ts'),
    path.join(root, 'apps/desktop/scripts/rust-main-host-gate.mjs'),
    path.join(root, 'apps/desktop/electron-gate/rust-collection-host.test.ts'),
    path.join(root, 'apps/desktop/scripts/rust-collection-host-gate.mjs'),
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
run('node-snapshot-version', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/dataset-snapshot-version.test.ts'], path.join(root, 'packages/bridge-core'));
run('ts-refresh-router', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/rust-readonly-router.test.ts'], path.join(root, 'packages/bridge-core'));
run('node-large-snapshot', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/dataset-large-snapshot.test.ts'], path.join(root, 'packages/bridge-core'));
run('ts-large-snapshot', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/rust-large-sidecar.test.ts'], path.join(root, 'packages/bridge-core'));
run('ts-query-index', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/rust-query-index.test.ts'], path.join(root, 'packages/bridge-core'));
run('ts-core-owner-lifecycle', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/rust-core-owner-lifecycle.test.ts'], path.join(root, 'packages/bridge-core'));
run('ts-core-utility-options', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/rust-core-utility-options.test.ts'], path.join(root, 'packages/bridge-core'));
const costReport = path.join(directory, 'atomic-snapshot-cost.json');
const refreshCostReport = path.join(directory, 'refresh-routing-cost.json');
const largeCostReport = path.join(directory, 'large-snapshot-cost.json');
const indexCostReport = path.join(directory, 'indexed-query-cost.json');
const runtimeReport = path.join(directory, 'runtime-lifecycle-report.json');
const hostReport = path.join(directory, 'runtime-host-report.json');
run('ts-rust-integration', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-core/readonly-integration.test.ts', 'test/rust-core/atomic-snapshot-integration.test.ts', 'test/rust-core/refresh-routing-integration.test.ts', 'test/rust-core/large-snapshot-integration.test.ts', 'test/rust-core/indexed-query-integration.test.ts'],
  path.join(root, 'packages/bridge-core'), { MUSIC_BRIDGE_RUST_BINARY: binary, MUSIC_BRIDGE_RUST_SHA256: binarySha256,
    MUSIC_BRIDGE_RUST_COST_REPORT: costReport, MUSIC_BRIDGE_RUST_REFRESH_COST_REPORT: refreshCostReport,
    MUSIC_BRIDGE_RUST_LARGE_COST_REPORT: largeCostReport, MUSIC_BRIDGE_RUST_INDEX_COST_REPORT: indexCostReport });
run('core-runtime-integration', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-core/runtime-lifecycle-integration.test.ts'], path.join(root, 'packages/bridge-core'), {
  MUSIC_BRIDGE_RUST_BINARY: binary, MUSIC_BRIDGE_RUST_SHA256: binarySha256, MUSIC_BRIDGE_RUST_RUNTIME_REPORT: runtimeReport,
});
run('ts-node-mixed-reads', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-readonly-node-reads.test.ts'], path.join(root, 'packages/bridge-core'));
run('ts-core-host-controls', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-core-host-controls.test.ts'], path.join(root, 'packages/bridge-core'));
run('core-host-integration', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-core/runtime-host-integration.test.ts'], path.join(root, 'packages/bridge-core'), {
  MUSIC_BRIDGE_RUST_BINARY: binary, MUSIC_BRIDGE_RUST_SHA256: binarySha256, MUSIC_BRIDGE_RUST_HOST_REPORT: hostReport,
});
const mainComponentReport = path.join(directory, 'main-component-report.json');
run('ts-main-read-boundary', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-readonly-main-boundary.test.ts'], path.join(root, 'packages/bridge-core'));
run('desktop-core-host-adapter', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-core-host.test.ts'], path.join(root, 'apps/desktop'));
const mainHostBuildRoot = path.join(directory, 'isolated-host');
run('main-host-isolated-build', process.execPath, ['apps/desktop/scripts/rust-main-host-gate.mjs',
  '--mode=build', '--output=' + mainHostBuildRoot], root, {
  MUSIC_BRIDGE_RUST_BINARY: binary, MUSIC_BRIDGE_RUST_SHA256: binarySha256,
});
run('main-background-components', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-core/runtime-main-background.test.ts'], path.join(root, 'apps/desktop'), {
  MUSIC_BRIDGE_RUST_BINARY: binary, MUSIC_BRIDGE_RUST_SHA256: binarySha256,
  MUSIC_BRIDGE_RUST_MAIN_COMPONENT_REPORT: mainComponentReport,
  MUSIC_BRIDGE_RUST_MAIN_HOST_BUILD_ROOT: mainHostBuildRoot,
});
run('main-evidence-acceptance', process.execPath, ['--test', 'scripts/ci/test/rust-main-evidence.test.mjs'], root, {
  MUSIC_BRIDGE_RUST_BINARY: binary, MUSIC_BRIDGE_RUST_SHA256: binarySha256,
  MUSIC_BRIDGE_RUST_MAIN_HOST_BUILD_ROOT: mainHostBuildRoot, MUSIC_BRIDGE_RUST_MAIN_COMPONENT_REPORT: mainComponentReport,
});
run('ts-collection-ui-read-boundary', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-readonly-collection-ui.test.ts'], path.join(root, 'packages/bridge-core'));
run('node-collection-ui-purity', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-collection-ui-node-purity.test.ts'], path.join(root, 'packages/bridge-core'));
const collectionHostBuildRoot = path.join(directory, 'isolated-collection-host');
// 跨平台 Rust Gate 证明专用类型与静态隔离构建；真实 Electron 与完整报告验收另列严格 Gate。
run('collection-host-isolated-build', process.execPath, ['apps/desktop/scripts/rust-collection-host-gate.mjs',
  '--mode=build', '--output=' + collectionHostBuildRoot], root, {
  MUSIC_BRIDGE_RUST_BINARY: binary, MUSIC_BRIDGE_RUST_SHA256: binarySha256,
});
const cost = JSON.parse(fs.readFileSync(costReport, 'utf8'));
if (cost.task !== 'RUST-002' || cost.models !== 2_000 || cost.differentialPages !== 108 || cost.binarySha256 !== binarySha256
  || !['exportRoundtripMs', 'fromOwnerReadyMs', 'remainingStartupMs', 'closeAckAndNaturalExitMs'].every(key => Number.isFinite(cost[key]) && cost[key] >= 0)
  || !['nodeQueryRoundtripMs', 'rustQueryRoundtripIncludingTsValidationMs'].every(key => Array.isArray(cost[key]) && cost[key].length === 10 && cost[key].every(n => Number.isFinite(n) && n >= 0))) throw new Error('实际快照成本记录缺失或不属于本轮二进制。');
const refreshCost = JSON.parse(fs.readFileSync(refreshCostReport, 'utf8'));
if (refreshCost.task !== 'RUST-003' || refreshCost.models !== 2_000 || refreshCost.differentialPages !== 32
  || refreshCost.binarySha256 !== binarySha256
  || !['refreshMs', 'closeMs'].every(key => Number.isFinite(refreshCost[key]) && refreshCost[key] >= 0)
  || !['nodeQueryRoundtripMs', 'rustQueryWithVersionProbesMs'].every(key => Array.isArray(refreshCost[key]) && refreshCost[key].length === 10 && refreshCost[key].every(n => Number.isFinite(n) && n >= 0))) throw new Error('版本化读取的完整成本缺失或不属于本轮二进制。');
const largeCost = JSON.parse(fs.readFileSync(largeCostReport, 'utf8'));
const workloadNames = ['unfiltered', 'selective-brand-stock', 'literal-percent-underscore', 'unicode', 'decade', 'empty-result'];
if (largeCost.task !== 'RUST-004' || largeCost.models !== 5_000 || largeCost.completePages !== 50 || largeCost.differentialPages !== 108
  || largeCost.snapshotProfile !== 'v3-5000' || largeCost.binarySha256 !== binarySha256
  || !['exportRoundtripMs', 'refreshMs', 'closeMs'].every(key => Number.isFinite(largeCost[key]) && largeCost[key] >= 0)
  || !Number.isSafeInteger(largeCost.snapshotJsonBytes) || largeCost.snapshotJsonBytes < 1 || largeCost.snapshotJsonBytes > 8 * 1024 * 1024
  || !Number.isSafeInteger(largeCost.uploadBytes) || largeCost.uploadBytes < 1 || largeCost.uploadBytes > 8 * 1024 * 1024 + 64 * 1024
  || largeCost.uploadChunks !== 40 || !Number.isSafeInteger(largeCost.maximumChunkFrameBytes) || largeCost.maximumChunkFrameBytes < 1 || largeCost.maximumChunkFrameBytes > 1024 * 1024
  || !Array.isArray(largeCost.workloads) || largeCost.workloads.length !== workloadNames.length
  || largeCost.workloads.some((workload, index) => workload.name !== workloadNames[index]
    || !['nodeQueryRoundtripMs', 'rustQueryWithVersionProbesMs'].every(key => Array.isArray(workload[key]) && workload[key].length === 10 && workload[key].every(n => Number.isFinite(n) && n >= 0)))
  || largeCost.counts?.refreshExports !== 1 || largeCost.counts?.warmVersionRoundtrips !== 120 || largeCost.counts?.warmRustQueries !== 60
  || largeCost.counts?.rustChildren !== 1 || largeCost.counts?.peakLiveRustChildren !== 1
  || !['borrowedOwnerPrepare', 'borrowedOwnerBoot', 'borrowedOwnerClose'].every(key => largeCost.counts?.[key] === 0)
  || !Array.isArray(largeCost.counts?.naturalRustExits) || largeCost.counts.naturalRustExits.length !== 1
  || largeCost.counts.naturalRustExits[0]?.code !== 0 || largeCost.counts.naturalRustExits[0]?.signal !== null
  || !/^[a-f0-9]{64}$/.test(largeCost.protectedFactsSha256 ?? '')) throw new Error('本轮大快照完整差分、字节或多工作量成本证据无效。');
const indexCost = JSON.parse(fs.readFileSync(indexCostReport, 'utf8'));
const sampleArray = value => Array.isArray(value) && value.length === 10 && value.every(n => Number.isFinite(n) && n >= 0);
const completeWorkloads = value => Array.isArray(value) && value.length === workloadNames.length
  && value.every((workload, index) => workload.name === workloadNames[index]
    && sampleArray(workload.nodeQueryRoundtripMs) && sampleArray(workload.rustQueryWithVersionProbesMs));
const pureWorkloads = value => Array.isArray(value) && value.length === workloadNames.length
  && value.every((workload, index) => workload.name === workloadNames[index]
    && sampleArray(workload.linearFilterMs) && sampleArray(workload.indexedFilterMs));
const warmCounts = value => value?.nodeQueries === 60 && value?.rustQueries === 60 && value?.versionRoundtrips === 120
  && value?.nodeFallbackQueries === 0 && value?.untimedWarmupNodeQueries === 6
  && value?.untimedWarmupRustQueries === 6 && value?.untimedWarmupVersionRoundtrips === 12;
const scales = [0, 100, 2_000, 5_000], completePages = [1, 1, 20, 50];
if (indexCost.task !== 'RUST-005' || indexCost.models !== 5_000 || indexCost.binarySha256 !== binarySha256
  || !['refreshMs', 'closeMs'].every(key => Number.isFinite(indexCost[key]) && indexCost[key] >= 0)
  || !completeWorkloads(indexCost.workloads) || !sampleArray(indexCost.tsIndexBuildMs) || !pureWorkloads(indexCost.tsPureWorkloads)
  || !Array.isArray(indexCost.scales) || indexCost.scales.length !== scales.length
  || indexCost.scales.some((scale, index) => scale.models !== scales[index] || scale.completePages !== completePages[index]
    || scale.differentialPages !== 108 || scale.filters !== 27 || scale.writeAndRefresh?.pages !== 4
    || scale.writeAndRefresh?.beforeModels !== scales[index] || scale.writeAndRefresh?.afterModels !== (scales[index] || 1)
    || scale.writeAndRefresh?.beforeSnapshotId === scale.writeAndRefresh?.afterSnapshotId
    || !Number.isFinite(scale.writeAndRefresh?.refreshMs) || scale.writeAndRefresh.refreshMs < 0
    || scale.calls?.export !== 2 || !['prepare', 'boot', 'close'].every(key => scale.calls?.[key] === 0)
    || !sampleArray(scale.pureTs?.buildMs) || !pureWorkloads(scale.pureTs?.workloads))
  || !warmCounts(indexCost.scales[3]?.fullRouterWarmCost?.counts)
  || indexCost.counts?.peakLiveRustChildren !== 1
  || !['borrowedOwnerPrepare', 'borrowedOwnerBoot', 'borrowedOwnerClose'].every(key => indexCost.counts?.[key] === 0)
  || !['RUN', 'NOT_RUN'].includes(indexCost.baseline?.status)
  || indexCost.counts?.rustChildren !== (indexCost.baseline.status === 'RUN' ? 9 : 8)
  || !Array.isArray(indexCost.counts?.naturalRustExits) || indexCost.counts.naturalRustExits.length !== indexCost.counts.rustChildren
  || indexCost.counts.naturalRustExits.some(exit => exit.code !== 0 || exit.signal !== null)) throw new Error('本轮索引四规模差分、写后换代或完整成本证据无效。');
const indexedModuleNames = ['readonly-router.ts', 'readonly-sidecar.ts', 'collection-query.ts'];
if (!Array.isArray(indexCost.sourceModules) || indexCost.sourceModules.length !== indexedModuleNames.length
  || new Set(indexCost.sourceModules.map(module => module.name)).size !== indexedModuleNames.length
  || indexCost.sourceModules.some(module => !indexedModuleNames.includes(module.name)
    || module.sha256 !== sources.find(source => source.path === 'packages/bridge-core/src/rust-core/' + module.name)?.sha256)) throw new Error('本轮索引模块与成本身份不匹配。');
const baselineModulePins = {
  'readonly-router.ts': '51e648e6920b08c2b25f263509c8868f408a27a6ed5ea2d547e2e9ebd02dd8c6',
  'readonly-sidecar.ts': 'bd826746375fc15945b397efec9ec1e4fe5156c846cc943aab3fb05c90e84d02',
  'collection-query.ts': '42a61da3f44484b64ad1f68ba7f1fdcf972df5d6d628cdd4865339a2f1e73a5b',
};
if (indexCost.baseline.status === 'RUN' && (indexCost.baseline.baseCommit !== 'd2676884a537bf3d232ed2cc957fef11b6d5cfeb'
  || indexCost.baseline.models !== 5_000 || indexCost.baseline.binarySha256 !== '1e2b5164591204772196f987009ae254bda2fcb807471f5ff917ec65b5c105ea'
  || !completeWorkloads(indexCost.baseline.workloads) || !warmCounts(indexCost.baseline.counts)
  || !['refreshMs', 'closeMs'].every(key => Number.isFinite(indexCost.baseline[key]) && indexCost.baseline[key] >= 0)
  || !Array.isArray(indexCost.baseline.sourceModules) || indexCost.baseline.sourceModules.length !== 3
  || indexCost.baseline.sourceModules.some(module => !Object.hasOwn(baselineModulePins, module.name) || module.sha256 !== baselineModulePins[module.name])
  || new Set(indexCost.baseline.sourceModules.map(module => module.name)).size !== 3)) throw new Error('旧 RUST-004 完整路径对照身份或样本无效。');
if (process.env.MUSIC_BRIDGE_RUST_BASELINE_ROUTER && indexCost.baseline.status !== 'RUN') throw new Error('已指定的旧完整路径基线没有运行。');
const runtimeEvidence = JSON.parse(fs.readFileSync(runtimeReport, 'utf8'));
if (runtimeEvidence.schemaVersion !== 1 || runtimeEvidence.task !== 'RUST-006' || runtimeEvidence.binarySha256 !== binarySha256
  || runtimeEvidence.nodeVersion !== process.version || runtimeEvidence.productionDefault !== 'Node'
  || runtimeEvidence.electron !== 'NOT_RUN' || runtimeEvidence.realServices !== 'NOT_RUN'
  || runtimeEvidence.data !== 'synthetic-real-Core-worker-Node-two-database-owner-pinned-Rust'
  || !Array.isArray(runtimeEvidence.scenarios) || runtimeEvidence.scenarios.length !== 10) throw new Error('Core 实际生命周期报告缺失或身份不匹配。');
const runtimeEvents = (scenario, event) => scenario.observations.filter(value => value.event === event);
const eventCount = (scenario, event, count) => runtimeEvents(scenario, event).length === count;
const soleScenario = (name, models) => {
  const matches = runtimeEvidence.scenarios.filter(scenario => scenario.scenario === name && (models === undefined || scenario.models === models));
  if (matches.length !== 1) throw new Error('Core 生命周期场景缺失或重复。');
  return matches[0];
};
const nodeClosedNaturally = scenario => eventCount(scenario, 'node.spawn', 1) && eventCount(scenario, 'node.close', 1)
  && eventCount(scenario, 'node.closed', 1) && eventCount(scenario, 'node.exit', 1)
  && runtimeEvents(scenario, 'node.exit')[0].code === 0 && eventCount(scenario, 'node.fatal', 0);
for (const scenario of runtimeEvidence.scenarios) {
  if (!Array.isArray(scenario.observations) || !scenario.observations.length
    || scenario.observations.some((value, index) => value.type !== 'observation' || value.sequence !== index + 1
      || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0
      || index > 0 && value.elapsedMs < scenario.observations[index - 1].elapsedMs)
    || !nodeClosedNaturally(scenario)) throw new Error('Core 场景观察序列或 Node 自然关闭证据无效。');
}
const legacyRuntime = soleScenario('legacy-node', 100);
if (legacyRuntime.coreExit !== 0 || !eventCount(legacyRuntime, 'core.ready', 1) || !eventCount(legacyRuntime, 'node.boot', 1)
  || !eventCount(legacyRuntime, 'node.version', 0) || !eventCount(legacyRuntime, 'rust.spawn', 0)
  || ['node.export', 'node.exportLarge', 'node.exportPlain'].some(event => !eventCount(legacyRuntime, event, 0))) throw new Error('默认 Core 路径意外启用 Rust 能力。');
for (const models of scales) {
  const scenario = soleScenario('explicit-rust', models), frames = runtimeEvents(scenario, 'rust.frame');
  const boots = frames.filter(frame => frame.operation === 'commitBoot'), chunks = frames.filter(frame => frame.operation === 'appendSnapshot');
  const ready = runtimeEvents(scenario, 'core.ready'), exits = runtimeEvents(scenario, 'rust.exit');
  const exported = runtimeEvents(scenario, 'node.exportComplete'), writing = runtimeEvents(scenario, 'node.dispatch');
  if (scenario.coreExit !== 0 || scenario.differentialPages !== 32
    || !Array.isArray(scenario.queryRoundtripMs) || scenario.queryRoundtripMs.length !== 32
    || scenario.queryRoundtripMs.some(value => !Number.isFinite(value) || value < 0)
    || !['node.prepare', 'node.boot', 'rust.spawn'].every(event => eventCount(scenario, event, 1))
    || runtimeEvents(scenario, 'rust.spawn')[0].liveChildren !== 1
    || boots.length !== 1 || boots[0].ok !== true || ready.length !== 1 || boots[0].sequence >= ready[0].sequence
    || chunks.length !== (models === 5_000 ? 40 : 0) || chunks.some(frame => frame.ok !== true || frame.sequence >= boots[0].sequence)
    || frames.filter(frame => frame.operation === 'dispatch').length !== 32
    || exits.length !== 1 || exits[0].code !== 0 || exits[0].signal !== null || exits[0].liveChildren !== 0
    || exported.length !== 1 || exported[0].models !== models || !Number.isSafeInteger(exported[0].jsonBytes)
    || exported[0].jsonBytes < 1 || exported[0].jsonBytes > (models === 5_000 ? 8 : 4) * 1024 * 1024
    || runtimeEvents(scenario, 'node.export').length + runtimeEvents(scenario, 'node.exportLarge').length !== 1
    || writing.length !== 2 || writing.filter(event => event.command === 'collection.receive').length !== 1
    || writing.filter(event => event.command === 'collection.list').length !== 1
    || writing.some(event => event.sequence <= ready[0].sequence)) throw new Error('Core 四规模差分、ACK 准入或写后失效证据无效。');
}
const earlyShutdown = soleScenario('early-shutdown-before-ready');
if (earlyShutdown.coreExit !== 0 || !['node.prepare', 'node.boot', 'node.bootSeeded'].every(event => eventCount(earlyShutdown, event, 1))
  || !['core.ready', 'rust.spawn', 'node.bootComplete', 'node.version', 'node.dispatch', 'node.export', 'node.exportLarge'].every(event => eventCount(earlyShutdown, event, 0))) throw new Error('Core 提前 shutdown 被误判为启动成功或失败。');
for (const name of ['bad-pin', 'missing-capabilities', 'capacity']) {
  const scenario = soleScenario(name);
  if (scenario.coreExit !== 1 || !eventCount(scenario, 'core.ready', 0) || !eventCount(scenario, 'rust.spawn', 0)
    || !eventCount(scenario, 'node.boot', name === 'missing-capabilities' ? 0 : 1)) throw new Error('Core 启动拒绝没有确认资源收口。');
}
const killed = soleScenario('real-rust-sigkill-close-failure'), killedExits = runtimeEvents(killed, 'rust.exit');
if (killed.forcedTestCleanup !== true || killed.coreExit !== 1 || !eventCount(killed, 'rust.spawn', 1)
  || killedExits.length !== 1 || killedExits[0].code !== null || killedExits[0].signal !== 'SIGKILL'
  || killedExits[0].liveChildren !== 0) throw new Error('受控 SIGKILL 被误记为正常关闭。');
// 宿主报告必须同时证明真实业务差分、能力隔离与逐 child 的 ACK/自然退出。
const host = JSON.parse(fs.readFileSync(hostReport, 'utf8'));
const mixedReadCommands = ['collection.detail', 'collection.copy', 'collection.photo',
  'referenceCatalog.sources', 'referenceCatalog.history', 'referenceCatalog.revision'];
if (host.schemaVersion !== 1 || host.task !== 'RUST-007' || host.binaryPath !== binary
  || host.binarySha256 !== binarySha256 || host.productionDefault !== 'Node'
  || host.electron !== 'NOT_RUN' || host.realServices !== 'NOT_RUN' || host.ownerAcceptance !== 'NOT_RUN'
  || !Array.isArray(host.scenarios) || host.scenarios.length !== 7) throw new Error('可信宿主实际报告身份或场景缺失。');
const hostEvents = (scenario, name) => scenario.observations.filter(event => event.event === name);
const hostScene = (name, models) => {
  const found = host.scenarios.filter(scenario => scenario.scenario === name && (models === undefined || scenario.models === models));
  if (found.length !== 1) throw new Error('可信宿主场景不是完整唯一记录：' + name);
  return found[0];
};
for (const scenario of host.scenarios) {
  if (!Array.isArray(scenario.observations) || scenario.resources?.forcedTestCleanup !== false
    || scenario.observations.some((event, index, events) => !Number.isSafeInteger(event.sequence) || event.sequence < 1
      || (index > 0 && event.sequence <= events[index - 1].sequence))) throw new Error('可信宿主报告缺少有序自然资源观察。');
  if (scenario.scenario === 'parent-payload-non-admission') continue;
  const nodeExits = hostEvents(scenario, 'node.exit'), children = hostEvents(scenario, 'rust.spawn');
  const exits = hostEvents(scenario, 'rust.exit'), resources = scenario.resources;
  if (nodeExits.length !== 1 || nodeExits[0].code !== 0 || hostEvents(scenario, 'node.close').length !== 1
    || hostEvents(scenario, 'node.closed').length !== 1 || resources.nodeClose !== 1 || resources.nodeExit0 !== 1
    || children.some(child => child.liveChildren !== 1) || children.length !== exits.length
    || resources.rustSpawn !== children.length || resources.rustCloseAck !== children.length || resources.rustExit0 !== children.length
    || !Array.isArray(resources.childResources) || resources.childResources.length !== children.length
    || new Set(resources.childResources.map(child => child.pid)).size !== children.length) throw new Error('可信宿主没有确认 Node/Rust 资源收口。');
  for (const [index, child] of children.entries()) {
    const detail = resources.childResources.find(value => value.pid === child.pid);
    const frames = hostEvents(scenario, 'rust.frame').filter(frame => frame.pid === child.pid);
    const ack = operation => frames.filter(frame => frame.operation === operation && frame.ok === true);
    const exit = exits.find(value => value.pid === child.pid);
    const prepared = ack('prepare'), booted = ack('commitBoot'), closed = ack('close'), appended = ack('appendSnapshot');
    const expectedAppend = scenario.scenario === 'real-inflight-refresh-shutdown-late-boot' ? 1 : scenario.models === 5_000 ? 40 : 0;
    if (!detail || prepared.length !== 1 || booted.length !== 1 || closed.length !== 1 || appended.length !== expectedAppend
      || prepared[0].sequence <= child.sequence || booted[0].sequence <= prepared[0].sequence
      || appended.some(frame => frame.sequence <= prepared[0].sequence || frame.sequence >= booted[0].sequence)
      || closed[0].sequence <= booted[0].sequence || !exit || exit.code !== 0 || exit.signal !== null || exit.liveChildren !== 0
      || exit.sequence <= closed[0].sequence || (index > 0 && child.sequence <= resources.childResources[index - 1].exitSequence)
      || detail.prepareAcks !== 1 || detail.bootAcks !== 1 || detail.closeAcks !== 1 || detail.appendAcks !== expectedAppend
      || detail.spawnSequence !== child.sequence || detail.bootSequence !== booted[0].sequence
      || detail.closeSequence !== closed[0].sequence || detail.exitSequence !== exit.sequence
      || detail.exitCode !== 0 || detail.signal !== null) throw new Error('可信宿主 child ACK/分块/排空身份不匹配。');
  }
}
const legacyHost = hostScene('legacy-node-env-public-non-admission');
if (legacyHost.resources.coreExit !== 0 || legacyHost.resources.rustSpawn !== 0
  || ['host.delivered', 'node.version', 'node.export', 'node.exportLarge', 'node.exportPlain'].some(name => hostEvents(legacyHost, name).length)) throw new Error('默认环境或公共消息取得了私有 Rust 能力。');
for (const models of [100, 2_000, 5_000]) {
  const scenario = hostScene('mixed-read-write-trusted-refresh', models);
  const delivered = hostEvents(scenario, 'host.delivered'), prepare = hostEvents(scenario, 'node.prepare'), ready = hostEvents(scenario, 'core.ready');
  const dispatches = hostEvents(scenario, 'node.dispatch'), ref = hostEvents(scenario, 'node.referenceSeeded');
  const completed = hostEvents(scenario, 'host.controlComplete').filter(event => event.operation === 'refresh');
  const first = scenario.initialStatus, stale = scenario.staleStatus, shared = scenario.concurrentRefresh;
  if (scenario.resources.coreExit !== 0 || scenario.resources.rustSpawn !== 3 || scenario.resources.nodePrepare !== 1 || scenario.resources.nodeBoot !== 1
    || scenario.differentialPages !== 38 || scenario.referenceSourceCount !== 1 || scenario.referenceRevisionCount !== 1
    || scenario.missingPhoto !== 'original-safe-Node-error' || ref.length !== 1 || ref[0].writer !== 'Node'
    || delivered.length !== 1 || !delivered[0].frozen || delivered[0].status?.phase !== 'new'
    || JSON.stringify(delivered[0].keys) !== JSON.stringify(['refresh', 'invalidate', 'getStatus'])
    || prepare.length !== 1 || delivered[0].sequence >= prepare[0].sequence || ready.length !== 1
    || ready[0].sequence <= scenario.resources.childResources[0].bootSequence
    || first?.phase !== 'ready' || first.router?.phase !== 'rust' || stale?.router?.phase !== 'stale'
    || stale.router.generation <= first.router.generation || stale.router.snapshotId !== undefined
    || !Array.isArray(shared) || shared.length !== 2 || JSON.stringify(shared[0]) !== JSON.stringify(shared[1])
    || shared[0]?.router?.phase !== 'rust' || shared[0].router.snapshotId === first.router.snapshotId
    || shared[0].router.revision === first.router.revision || shared[0].router.generation <= stale.router.generation
    || !Number.isFinite(scenario.refreshRoundtripMs) || scenario.refreshRoundtripMs < 0
    || !Array.isArray(scenario.queryRoundtripMs) || scenario.queryRoundtripMs.length !== 36
    || scenario.queryRoundtripMs.some(value => !Number.isFinite(value) || value < 0)
    || mixedReadCommands.some(command => scenario.pureNodeReadCounts?.[command] !== 1
      || dispatches.filter(event => event.command === command).length !== 1)
    || dispatches.filter(event => event.command === 'collection.setPolicy').length !== 1
    || dispatches.filter(event => event.command === 'collection.list').length !== 2 || dispatches.length !== 9
    || hostEvents(scenario, 'rust.frame').filter(frame => frame.operation === 'dispatch' && frame.ok).length !== 40
    || hostEvents(scenario, 'node.export').length + hostEvents(scenario, 'node.exportLarge').length !== 3
    || completed.length !== 3 || completed.some(event => !event.status?.router?.snapshotId || event.status.router.phase !== 'rust')
    || !hostEvents(scenario, 'host.controlRejected').some(event => event.operation === 'refresh' && event.code === 'NOT_READY')
    || !hostEvents(scenario, 'host.closedStatus').some(event => event.status?.phase === 'closed')
    || !hostEvents(scenario, 'host.refreshAfterCloseRejected').some(event => event.code === 'CLOSING')) throw new Error('可信宿主混合读/写后显式刷新/关闭能力证据无效。');
}
const closingHost = hostScene('real-inflight-refresh-shutdown-late-boot');
const held = hostEvents(closingHost, 'rust.commitBootHeld'), released = hostEvents(closingHost, 'rust.releaseHeldBoot');
const rejected = hostEvents(closingHost, 'host.controlRejected').filter(event => event.operation === 'refresh');
if (closingHost.resources.coreExit !== 0 || closingHost.resources.rustSpawn !== 2 || closingHost.inflightStatus?.router?.phase !== 'refreshing'
  || closingHost.closingStatus?.phase !== 'closing' || !['CLOSING', 'STALE_SNAPSHOT'].includes(closingHost.refreshRejectedCode)
  || held.length !== 1 || released.length !== 1 || held[0].pid !== released[0].pid
  || held[0].sequence >= released[0].sequence || closingHost.resources.childResources[1].bootSequence <= released[0].sequence
  || hostEvents(closingHost, 'core.ready').length !== 1 || rejected.length !== 1
  || hostEvents(closingHost, 'host.controlComplete').some(event => event.operation === 'refresh')
  || !hostEvents(closingHost, 'host.refreshAfterCloseRejected').some(event => event.code === 'CLOSING')) throw new Error('在途刷新关闭错误地交付成功或遗留 child。');
const thrownHost = hostScene('host-callback-throw');
if (thrownHost.resources.coreExit !== 1 || thrownHost.resources.nodePrepare !== 0 || thrownHost.resources.nodeBoot !== 0
  || thrownHost.resources.rustSpawn !== 0 || hostEvents(thrownHost, 'host.delivered').length !== 1
  || hostEvents(thrownHost, 'core.ready').length) throw new Error('可信回调失败没有关闭已登记 Node。');
const parentHost = hostScene('parent-payload-non-admission');
if (parentHost.resources.coreExit !== 1 || parentHost.resources.nodeSpawn !== 0 || parentHost.resources.rustSpawn !== 0
  || parentHost.observations.length) throw new Error('父启动字段进入了私有能力准入。');
const mainComponents = JSON.parse(fs.readFileSync(mainComponentReport, 'utf8'));
verifyRustMainEvidence(mainComponents, { root, buildRoot: mainHostBuildRoot, binaryPath: binary, binarySha256, layer: 'controlled-production-Main-components' });
if (createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== binarySha256) throw new Error('Rust 二进制在验证期间改变。');
if (JSON.stringify(sourceManifest()) !== JSON.stringify(sources)) throw new Error('Rust Gate 的受测源码在执行期间改变。');
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, task: 'RUST-009', compiler, cargoVersion, sources,
  binary: { path: binary, sha256: binarySha256, platform: process.platform, architecture: process.arch },
  packages: metadata.packages.map(p => ({ name: p.name, version: p.version })), runs,
  realServices: 'NOT_RUN', productionDefault: 'Node', readonlyCommands: ['collection.list'],
  protocolVersions: [1, 2, 3], nodeAtomicSnapshot: true,
  filters: ['query', 'brand', 'decade', 'stockState'],
  versionedSnapshots: true, explicitRefreshRouting: true, sourceOwnerBorrowed: true,
  defaultSnapshotProfile: 'v2-2000', optionalSnapshotProfile: 'v3-5000',
  boundedQueryIndex: true, requestResultCache: false, indexScaleModels: scales,
  optionalCoreRuntimeComposition: true, coreOwnsSourceOwner: true, publicRuntimeConfiguration: false,
  trustedHostController: true, synchronousControllerDelivery: true,
  mixedNodeReadonlyCommands: [...mixedReadCommands, 'commandOutbox.context', 'collectionProgress.modelLengths',
    'collectionProgress.current', 'collectionProgress.wants', 'collectionProgress.wantHistory',
    'collectionProgress.snapshots', 'collectionProgress.snapshot', 'referenceCatalog.snapshot',
    'referenceCatalog.source', 'referenceCatalog.sourceZipReceipts'],
  conditionalEmptyClaimRetention: true, readCompletionBarrier: true, sharedDesktopCoreHost: true,
  refreshConditionalEmptyClaimRetention: true,
  electronEvidenceLayer: 'separate-isolated-Electron-Gate',
  collectionUiEvidenceLayer: 'separate-actual-Electron-production-Main-collection-ui-Gate',
  collectionUiHostBuild: {
    path: path.join(collectionHostBuildRoot, 'artifact-manifest.json'),
    sha256: createHash('sha256').update(fs.readFileSync(path.join(collectionHostBuildRoot, 'artifact-manifest.json'))).digest('hex'),
  },
  largeSnapshotModels: 5_000, largeSnapshotBytes: 8 * 1024 * 1024, uploadChunkModels: 128,
  costReport: { path: costReport, sha256: createHash('sha256').update(fs.readFileSync(costReport)).digest('hex') },
  refreshCostReport: { path: refreshCostReport, sha256: createHash('sha256').update(fs.readFileSync(refreshCostReport)).digest('hex') },
  largeCostReport: { path: largeCostReport, sha256: createHash('sha256').update(fs.readFileSync(largeCostReport)).digest('hex') },
  indexCostReport: { path: indexCostReport, sha256: createHash('sha256').update(fs.readFileSync(indexCostReport)).digest('hex') },
  runtimeReport: { path: runtimeReport, sha256: createHash('sha256').update(fs.readFileSync(runtimeReport)).digest('hex') },
  hostReport: { path: hostReport, sha256: createHash('sha256').update(fs.readFileSync(hostReport)).digest('hex') },
  mainComponentReport: { path: mainComponentReport, sha256: createHash('sha256').update(fs.readFileSync(mainComponentReport)).digest('hex') },
  baselineCompletePathComparison: indexCost.baseline.status,
}, null, 2) + '\n');
console.log('RUST_GATE=PASS manifest=' + path.join(directory, 'manifest.json'));
