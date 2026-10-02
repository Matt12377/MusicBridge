import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyRustCollectionEvidence } from '../rust-collection-evidence.mjs';

function required(name) {
  const value = process.env[name];
  assert.ok(typeof value === 'string' && value.length > 0, '完整 Electron 验收器负测试缺少冻结输入：' + name);
  return value;
}
const options = {
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  buildRoot: required('MUSIC_BRIDGE_RUST_COLLECTION_HOST_BUILD_ROOT'),
  binaryPath: required('MUSIC_BRIDGE_RUST_BINARY'),
  binarySha256: required('MUSIC_BRIDGE_RUST_SHA256'),
  layer: 'real-Electron-production-Main-collection-UI',
};
const original = JSON.parse(fs.readFileSync(required('MUSIC_BRIDGE_RUST_COLLECTION_ELECTRON_REPORT'), 'utf8'));
const clone = () => structuredClone(original);
const rust = (report, models = 100) => report.scenarios.find(value => value.scenario === 'explicit-rust-collection-UI-outbox-refresh' && value.models === models);
const request = (scene, command) => scene.ui.requests.find(value => value.command === command);
const resequence = scene => {
  const moved = new Map();
  scene.observations.forEach((value, index) => { moved.set(value.sequence, index + 1); value.sequence = index + 1; });
  for (const value of scene.ui.requests) {
    if (value.ownerSequence !== undefined) value.ownerSequence = moved.get(value.ownerSequence);
    if (value.rustAckSequence !== undefined) value.rustAckSequence = moved.get(value.rustAckSequence);
  }
  if (scene.refreshWindow) scene.refreshWindow.claimSequences = scene.refreshWindow.claimSequences.map(value => moved.get(value));
};
function reject(name, mutate, pattern = { code: 'ERR_ASSERTION' }) {
  test('拒绝：' + name, () => {
    const report = clone(); mutate(report);
    assert.throws(() => verifyRustCollectionEvidence(report, options), pattern);
  });
}

// 原始报告、源码、编译产物、binary 与截图全部只读；变体只在内存。
// 这些是验收器的拒绝行为测试，不构成另一轮 Electron、设备或 Owner 验收。
test('完整实际 Electron 报告绑定四场景、locator、DTO、oracle 与资源后接受', () => {
  const result = verifyRustCollectionEvidence(clone(), options);
  assert.equal(result.scenes, 4); assert.equal(result.layer, options.layer);
  assert.ok(result.locatorActions > 0 && result.validatedReplies > 0);
});

reject('API-only 有完整 DTO 也不能冒充真实 Vue 点击', report => { rust(report).ui.apiOnly = true; }, /API-only/);
reject('伪造收藏导航定位器', report => { rust(report).ui.actions.find(value => value.role === 'navigate').locator = '主页'; }, /伪造收藏导航/);
reject('伪造导航后 DOM 没有收藏内容', report => { rust(report).ui.actions.find(value => value.role === 'navigate').dom.text = '只有主页'; }, /没有收藏 DOM/);
reject('页面未实际 mounted', report => { rust(report).ui.actions[0].dom.mounted = false; }, /未实际 mounted/);
reject('外部HTTP页面不能冒充生产Renderer入口', report => { rust(report).ui.actions[0].dom.url = 'https://example.test/index.html'; }, /生产 Renderer 入口/);
reject('浏览器 evaluate 冒充 locator 动作', report => { rust(report).ui.actions[0].method = 'evaluate'; });
reject('删除真实分页动作但保留 API 分页结果', report => { rust(report).ui.actions.forEach(value => { if (value.role === 'page') value.role = 'detail'; }); }, /locator 动作缺失：page/);
for (const command of ['collectionProgress.wants', 'collectionProgress.current', 'referenceCatalog.source', 'referenceCatalog.history', 'collectionProgress.wantHistory', 'collectionProgress.snapshot', 'collection.photo']) {
  reject('缺少核心请求 ' + command, report => {
    const scene = rust(report), removed = scene.ui.requests.filter(value => value.command === command).map(value => value.requestId);
    assert.ok(removed.length > 0, '实际输入必须覆盖被删除的核心请求。');
    scene.ui.requests = scene.ui.requests.filter(value => value.command !== command);
    scene.ui.actions.forEach(value => { value.requestIds = value.requestIds.filter(id => !removed.includes(id)); });
  }, new RegExp('核心页面请求缺失：' + command.replaceAll('.', '\\.')));
}
reject('公开 requestId 与完整 reply 不对应', report => { request(rust(report), 'collection.detail').reply.id += '-伪造'; });
reject('完整 DTO 缩成只剩 total', report => {
  const scene = rust(report), value = request(scene, 'collection.list');
  value.reply.result = { total: scene.models }; value.oracle.reply = structuredClone(value.reply);
  scene.observations.find(entry => entry.event === 'core.publicReply' && entry.requestId === value.requestId).reply = structuredClone(value.reply);
}, /完整安全 DTO/);
reject('独立 oracle 与公开完整回执不同', report => { request(rust(report), 'collection.list').oracle.reply.result.total += 1; }, /SQLite oracle 不同/);
reject('把 SQLite oracle 改成被测 Rust 自证', report => { request(rust(report), 'collection.list').oracle.kind = 'Rust-self-comparison'; }, /独立 Node SQLite oracle/);
reject('公开阅读缺少真实 Owner dispatch', report => { request(rust(report), 'collection.detail').ownerSequence = 0; }, /Node Owner 分派/);
reject('真实 Rust 请求没有同 requestId 的 ACK', report => {
  const scene = rust(report), value = scene.ui.requests.find(entry => entry.route === 'rust');
  scene.observations.find(entry => entry.sequence === value.rustAckSequence).requestId = '另一个请求';
}, /对应真实 Rust ACK/);
reject('真实 Rust 读取绑定错误 scope', report => { rust(report).ui.requests.find(value => value.route === 'rust').scope.datasetId += '-伪造'; });
reject('删除 close ACK 并重新编号，汇总仍为一也不接受', report => {
  const scene = rust(report), index = scene.observations.findIndex(value => value.event === 'rust.frame' && value.operation === 'close' && value.ok);
  assert.ok(index >= 0); scene.observations.splice(index, 1); resequence(scene);
}, /真实 ACK 缺失：close/);
reject('5000 的真实 append ACK 缺一，汇总仍为40也不接受', report => {
  const scene = rust(report, 5_000), index = scene.observations.findIndex(value => value.event === 'rust.frame' && value.operation === 'appendSnapshot' && value.ok);
  assert.ok(index >= 0); scene.observations.splice(index, 1); resequence(scene);
}, /append ACK/);
reject('Rust 强制 signal 退出不能冒充自然退出', report => { rust(report).observations.find(value => value.event === 'rust.exit').signal = 'SIGKILL'; }, /未自然退出/);
reject('Electron 强制退出不能冒充自然退出', report => { rust(report).electronExit.signal = 'SIGKILL'; }, /Electron 未自然退出/);
reject('forcedCleanup=true 不能借绿色资源汇总放行', report => { rust(report).resources.forcedCleanup = true; }, /强制 cleanup/);
reject('最多一个 child 的峰值被突破', report => { rust(report).observations.find(value => value.event === 'rust.spawn').liveChildren = 2; }, /峰值超过一/);
reject('真实 Owner PID 与 Core PID 不对应', report => { rust(report).main.find(value => value.event === 'main.coreSpawn').pid += 1; });
reject('Owner 自然退出前伪称 close 完成', report => {
  const scene = rust(report), exit = scene.observations.find(value => value.event === 'node.exit'), closed = scene.observations.find(value => value.event === 'node.closed');
  exit.event = 'node.closed'; closed.event = 'node.exit'; closed.code = 0;
}, /Node 生命周期顺序错误/);
reject('Node 默认入口发生私有导出', report => {
  const scene = report.scenarios.find(value => value.scenario === 'default-node-collection-UI');
  const last = scene.observations.at(-1);
  scene.observations.push({ sequence: last.sequence + 1, elapsedMs: last.elapsedMs, event: 'node.export' });
}, /默认 Node 发生私有导出/);
reject('重复 Node outbox 写入，汇总一仍不得放行', report => {
  const scene = rust(report), index = scene.observations.findIndex(value => value.event === 'node.dispatch' && value.command === 'commandOutbox.execute');
  const duplicated = structuredClone(scene.observations[index]); duplicated.sequence = -1;
  scene.observations.splice(index + 1, 0, duplicated); resequence(scene);
}, /outbox 原 Node 作者重复写入/);
reject('写后自动 refresh 或第二次显式刷新', report => { rust(report).outbox.refreshCalls = 2; }, /一次可信显式 refresh/);
reject('多一次私有导出就是隐式重建', report => {
  const scene = rust(report), last = scene.observations.at(-1);
  scene.observations.push({ sequence: last.sequence + 1, elapsedMs: last.elapsedMs, event: 'node.export' });
}, /隐式导出或刷新/);
reject('刷新窗口只覆盖100ms，claims 汇总再高也不接受', report => { const window = rust(report).refreshWindow; window.completedMs = window.startedMs + 100; }, /1500ms interval/);
reject('刷新窗口 claim 来自窗口外', report => {
  const scene = rust(report), outside = scene.observations.find(value => value.event === 'node.claimComplete' && value.elapsedMs < scene.refreshWindow.startedMs);
  assert.ok(outside); scene.refreshWindow.claimSequences = [outside.sequence];
}, /没有实际空 claim/);
reject('刷新窗口只有 Node claim 而无完整公开空回执', report => {
  const scene = rust(report), claim = scene.observations.find(value => value.sequence === scene.refreshWindow.claimSequences[0]);
  const reply = scene.observations.find(value => value.event === 'core.publicReply' && value.command === 'recordingPrintWorker.claim' && value.requestId === claim.requestId);
  assert.ok(reply); reply.requestId = '窗口外的另一个请求';
}, /没有完整公开空 claim/);
reject('100 场景重复填满四场景不能冒充2000或5000', report => {
  const hundred = rust(report), node = report.scenarios.find(value => value.scenario === 'default-node-collection-UI');
  report.scenarios = [node, hundred, structuredClone(hundred), structuredClone(hundred)];
}, /小样本重复填充/);
reject('伪称5000而实际 SQLite oracle 仍100', report => { rust(report, 5_000).ui.oracleSummary.models = 100; }, /小样本填充/);
reject('5000错误使用默认2000 profile', report => { rust(report, 5_000).staticProfile = structuredClone(rust(report).staticProfile); }, /静态 profile/);
reject('非空求购被改成空清单摘要', report => { rust(report).ui.oracleSummary.wants = 0; }, /合成资料为空/);
reject('旧目录与当前目录是同一版', report => { const summary = rust(report).ui.oracleSummary; summary.previousCatalogRevision = summary.currentCatalogRevision; }, /两版目录/);
reject('源码基线漂移不能借旧 manifest', report => { report.sourceSha = '0'.repeat(40); }, /源码基线/);
reject('源码输入 hash 漂移不能借旧 manifest', report => { report.sources[0].sha256 = '0'.repeat(64); });
reject('编译产物 hash 漂移不能借旧 manifest', report => { report.artifacts[0].sha256 = '0'.repeat(64); });
reject('binary pin 漂移', report => { report.binarySha256 = '0'.repeat(64); });
reject('Electron 固定可执行文件身份漂移', report => { report.electronExecutableSha256 = '0'.repeat(64); }, /Electron 固定身份/);
reject('manifest hash 漂移', report => { report.artifactManifestSha256 = '0'.repeat(64); }, /manifest 身份/);
reject('截图 hash 漂移', report => { rust(report).ui.actions[0].screenshot.sha256 = '0'.repeat(64); }, /截图身份/);
reject('截图 ../ 越界', report => { rust(report).ui.actions[0].screenshot.path = '../other.png'; }, /证据文件越界/);
