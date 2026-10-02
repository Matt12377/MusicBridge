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
    path.join(root, 'packages/bridge-core/test/dataset-snapshot-version.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-readonly-router.test.ts'),
    path.join(root, 'packages/bridge-core/test/dataset-large-snapshot.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-large-sidecar.test.ts'),
    path.join(root, 'packages/bridge-core/test/rust-query-index.test.ts'),
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
const costReport = path.join(directory, 'atomic-snapshot-cost.json');
const refreshCostReport = path.join(directory, 'refresh-routing-cost.json');
const largeCostReport = path.join(directory, 'large-snapshot-cost.json');
const indexCostReport = path.join(directory, 'indexed-query-cost.json');
run('ts-rust-integration', process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1',
  'test/rust-core/readonly-integration.test.ts', 'test/rust-core/atomic-snapshot-integration.test.ts', 'test/rust-core/refresh-routing-integration.test.ts', 'test/rust-core/large-snapshot-integration.test.ts', 'test/rust-core/indexed-query-integration.test.ts'],
  path.join(root, 'packages/bridge-core'), { MUSIC_BRIDGE_RUST_BINARY: binary, MUSIC_BRIDGE_RUST_SHA256: binarySha256,
    MUSIC_BRIDGE_RUST_COST_REPORT: costReport, MUSIC_BRIDGE_RUST_REFRESH_COST_REPORT: refreshCostReport,
    MUSIC_BRIDGE_RUST_LARGE_COST_REPORT: largeCostReport, MUSIC_BRIDGE_RUST_INDEX_COST_REPORT: indexCostReport });
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
if (createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== binarySha256) throw new Error('Rust 二进制在验证期间改变。');
if (JSON.stringify(sourceManifest()) !== JSON.stringify(sources)) throw new Error('Rust Gate 的受测源码在执行期间改变。');
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, task: 'RUST-005', compiler, cargoVersion, sources,
  binary: { path: binary, sha256: binarySha256, platform: process.platform, architecture: process.arch },
  packages: metadata.packages.map(p => ({ name: p.name, version: p.version })), runs,
  realServices: 'NOT_RUN', productionDefault: 'Node', readonlyCommands: ['collection.list'],
  protocolVersions: [1, 2, 3], nodeAtomicSnapshot: true,
  filters: ['query', 'brand', 'decade', 'stockState'],
  versionedSnapshots: true, explicitRefreshRouting: true, sourceOwnerBorrowed: true,
  defaultSnapshotProfile: 'v2-2000', optionalSnapshotProfile: 'v3-5000',
  boundedQueryIndex: true, requestResultCache: false, indexScaleModels: scales,
  largeSnapshotModels: 5_000, largeSnapshotBytes: 8 * 1024 * 1024, uploadChunkModels: 128,
  costReport: { path: costReport, sha256: createHash('sha256').update(fs.readFileSync(costReport)).digest('hex') },
  refreshCostReport: { path: refreshCostReport, sha256: createHash('sha256').update(fs.readFileSync(refreshCostReport)).digest('hex') },
  largeCostReport: { path: largeCostReport, sha256: createHash('sha256').update(fs.readFileSync(largeCostReport)).digest('hex') },
  indexCostReport: { path: indexCostReport, sha256: createHash('sha256').update(fs.readFileSync(indexCostReport)).digest('hex') },
  baselineCompletePathComparison: indexCost.baseline.status,
}, null, 2) + '\n');
console.log('RUST_GATE=PASS manifest=' + path.join(directory, 'manifest.json'));
