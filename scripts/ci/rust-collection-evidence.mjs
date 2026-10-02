import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateIpcRequest, validateIpcResponseForCommand } from '../../packages/contracts/dist/validator.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const positive = value => Number.isSafeInteger(value) && value > 0;
const finite = value => Number.isFinite(value) && value >= 0;
const events = (scene, name) => scene.observations.filter(value => value.event === name);
const requiredReads = ['collection.list', 'collection.detail', 'collection.photo',
  'collectionProgress.current', 'collectionProgress.wants', 'collectionProgress.wantHistory',
  'collectionProgress.snapshots', 'collectionProgress.snapshot', 'referenceCatalog.sources',
  'referenceCatalog.history', 'referenceCatalog.revision', 'referenceCatalog.snapshot',
  'referenceCatalog.source', 'referenceCatalog.sourceZipReceipts'];
const allowedCommands = new Set([...requiredReads, 'collection.copy', 'collectionProgress.modelLengths', 'commandOutbox.context', 'commandOutbox.execute']);
const roles = ['navigate', 'filter', 'page', 'detail', 'progress', 'wants', 'history', 'reference'];
const layer = 'real-Electron-production-Main-collection-UI';

function relativeFile(parent, relative) {
  assert.ok(typeof relative === 'string' && relative && !path.isAbsolute(relative)
    && !relative.split(/[\\/]/).includes('..'), '证据文件越界。');
  const base = fs.realpathSync(parent), resolved = fs.realpathSync(path.resolve(parent, relative));
  assert.ok(resolved.startsWith(base + path.sep), '证据文件实际路径越界。');
  return resolved;
}
function profile(models, binarySha256) {
  return { profile: models === 5_000 ? 'v3-5000' : 'default', maxModels: models === 5_000 ? 5_000 : 2_000,
    maxJsonBytes: models === 5_000 ? 8 * 1024 * 1024 : 4 * 1024 * 1024, binarySha256 };
}
function identity(report, options) {
  const { root, buildRoot, binaryPath, binarySha256 } = options;
  assert.equal(report.schemaVersion, 1); assert.equal(report.task, 'RUST-009');
  assert.equal(report.evidenceLayer, layer); assert.equal(options.layer ?? layer, layer);
  assert.equal(report.productionDefault, 'Node');
  for (const key of ['realProvider', 'realRoon', 'realAccount', 'realAudioRecording', 'pdfDevice', 'systemKeychain', 'ownerAcceptance']) {
    assert.equal(report[key], 'NOT_RUN', '真实验收边界错误：' + key);
  }
  assert.equal(report.installedApplication, 'NOT_CHANGED');
  assert.ok(path.isAbsolute(report.electronExecutablePath), 'Electron 可执行文件路径缺失。');
  assert.equal(report.electronExecutableSha256, options.electronExecutableSha256
    ?? '1af684f056a8eb13e49fbd677072e437316086b076e3b9b92de3ddb343edc5b1', 'Electron 固定身份漂移。');
  assert.equal(fileHash(report.electronExecutablePath), report.electronExecutableSha256, 'Electron 可执行文件已改变。');
  assert.equal(report.binaryPath, binaryPath); assert.equal(report.binarySha256, binarySha256);
  assert.match(binarySha256, /^[a-f0-9]{64}$/); assert.equal(fileHash(binaryPath), binarySha256, 'binary 身份漂移。');
  const manifestPath = path.join(buildRoot, 'artifact-manifest.json');
  assert.equal(report.artifactManifestPath, manifestPath);
  assert.equal(fileHash(manifestPath), report.artifactManifestSha256, 'manifest 身份漂移。');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.task, 'RUST-009');
  assert.match(report.sourceSha, /^[a-f0-9]{40}$/); assert.equal(manifest.sourceSha, report.sourceSha, '源码基线不匹配。');
  if (options.sourceSha !== undefined) assert.equal(report.sourceSha, options.sourceSha);
  assert.equal(manifest.binaryPath, binaryPath); assert.equal(manifest.binarySha256, binarySha256);
  assert.deepEqual(manifest.staticProfiles, [profile(100, binarySha256), profile(5_000, binarySha256)], '静态 profile 不匹配。');
  assert.ok(Array.isArray(report.sources) && report.sources.length > 0 && Array.isArray(report.artifacts) && report.artifacts.length > 0);
  assert.deepEqual(report.sources, manifest.sources); assert.deepEqual(report.artifacts, manifest.artifacts);
  assert.equal(hash(JSON.stringify(report.sources)), report.sourceAggregateSha256);
  assert.equal(manifest.sourceAggregateSha256, report.sourceAggregateSha256);
  for (const [entries, parent, label] of [[report.sources, root, '源码'], [report.artifacts, buildRoot, '产物']]) {
    assert.equal(new Set(entries.map(value => value.path)).size, entries.length, label + '重复绑定。');
    for (const entry of entries) {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      assert.equal(fileHash(relativeFile(parent, entry.path)), entry.sha256, label + '身份漂移：' + entry.path);
    }
  }
  for (const file of ['main/index.js', 'main/dataset-owner.js', 'preload/index.cjs', 'renderer/index.html']) {
    assert.ok(report.artifacts.some(value => value.path === file), '真实编译入口未绑定：' + file);
  }
  assert.ok(report.sources.some(value => value.path.endsWith('/components/collection/CollectionView.vue')), '生产 Vue 页面源码未绑定。');
  assert.ok(report.sources.some(value => value.path.endsWith('/rust-core/readonly-router.ts')), '生产 router 源码未绑定。');
  for (const file of ['scripts/ci/rust-collection-evidence.mjs', 'scripts/ci/test/rust-collection-evidence.test.mjs']) {
    assert.ok(report.sources.some(value => value.path === file), '验收器实际输入未绑定：' + file);
  }
}

function resources(scene, children) {
  assert.ok(Array.isArray(scene.observations) && scene.observations.length > 0, '真实资源观察缺失。');
  scene.observations.forEach((value, index) => {
    assert.equal(value.sequence, index + 1, '真实观察序号断裂。');
    assert.ok(finite(value.elapsedMs) && (!index || value.elapsedMs >= scene.observations[index - 1].elapsedMs), '真实观察时序无效。');
  });
  assert.ok(positive(scene.electronPid) && scene.runtimeVersions?.electron && scene.runtimeVersions?.node, '真实 Electron 身份缺失。');
  assert.deepEqual(scene.electronExit, { code: 0, signal: null }, 'Electron 未自然退出。');
  assert.equal(scene.mockKeychain, true);
  for (const name of ['node.spawn', 'node.prepare', 'node.boot', 'node.bootComplete', 'node.close', 'node.closed', 'node.exit']) {
    assert.equal(events(scene, name).length, 1, 'Node 生命周期缺失：' + name);
  }
  assert.equal(events(scene, 'node.exit')[0].code, 0, 'Node 未自然退出。');
  // 原 Owner close() 等待 Worker 自然退出后才 resolve；closed 是完成回执。
  const nodeOrder = ['node.spawn', 'node.prepare', 'node.boot', 'node.bootComplete', 'node.close', 'node.exit', 'node.closed'];
  assert.ok(nodeOrder.every((name, index) => !index || events(scene, nodeOrder[index - 1])[0].sequence < events(scene, name)[0].sequence), 'Node 生命周期顺序错误。');
  assert.equal(events(scene, 'node.fatal').length, 0);
  const owner = events(scene, 'node.spawn')[0], summary = scene.resources;
  assert.ok(positive(owner.hostPid) && positive(owner.threadId), '真实 Owner 身份缺失。');
  assert.equal(summary.nodeHostPid, owner.hostPid); assert.equal(summary.nodeThreadId, owner.threadId);
  assert.equal(summary.nodeVersion, owner.nodeVersion); assert.equal(summary.nodeVersion, 'v' + scene.runtimeVersions.node);
  assert.equal(summary.forcedCleanup, false, '强制 cleanup 不能替代自然退出。');
  for (const key of ['nodeSpawn', 'nodePrepare', 'nodeBoot', 'nodeClose', 'nodeExit0']) assert.equal(summary[key], 1);
  assert.equal(summary.rustSpawn, children); assert.equal(summary.rustExit0, children);
  for (const name of ['main.coreFork', 'main.coreSpawn', 'main.coreExit']) assert.equal(scene.main.filter(value => value.event === name).length, 1);
  assert.equal(scene.main.find(value => value.event === 'main.coreSpawn').pid, owner.hostPid);
  assert.equal(scene.main.find(value => value.event === 'main.coreExit').code, 0, '真实 Core 未自然退出。');
  const spawned = events(scene, 'rust.spawn'), exited = events(scene, 'rust.exit');
  assert.equal(spawned.length, children); assert.equal(exited.length, children); assert.equal(summary.childResources.length, children);
  assert.equal(new Set(spawned.map(value => value.pid)).size, children);
  spawned.forEach((spawn, index) => {
    assert.ok(positive(spawn.pid)); assert.equal(spawn.liveChildren, 1, 'Rust child 峰值超过一。');
    const frames = events(scene, 'rust.frame').filter(value => value.pid === spawn.pid);
    const acks = operation => frames.filter(value => value.operation === operation && value.ok === true);
    for (const name of ['prepare', 'commitBoot', 'close']) assert.equal(acks(name).length, 1, '真实 ACK 缺失：' + name);
    assert.equal(acks('appendSnapshot').length, scene.models === 5_000 ? 40 : 0, '真实 append ACK 数量错误。');
    const boot = acks('commitBoot')[0], close = acks('close')[0];
    assert.ok(spawn.sequence < acks('prepare')[0].sequence && acks('prepare')[0].sequence < boot.sequence);
    assert.ok(acks('appendSnapshot').every(value => value.sequence > acks('prepare')[0].sequence && value.sequence < boot.sequence));
    const exit = exited.find(value => value.pid === spawn.pid);
    assert.ok(exit && exit.code === 0 && exit.signal === null && exit.liveChildren === 0, 'Rust 未自然退出。');
    assert.ok(boot.sequence < close.sequence && close.sequence < exit.sequence);
    if (index) assert.ok(exited.find(value => value.pid === spawned[index - 1].pid).sequence < spawn.sequence, '旧 child 未退出即创建新 child。');
    const receipt = summary.childResources[index];
    assert.equal(receipt.pid, spawn.pid); assert.equal(receipt.prepareAcks, 1); assert.equal(receipt.bootAcks, 1);
    assert.equal(receipt.closeAcks, 1); assert.equal(receipt.appendAcks, acks('appendSnapshot').length);
    assert.equal(receipt.exitCode, 0); assert.equal(receipt.signal, null);
  });
  const claims = events(scene, 'node.claimComplete').filter(value => value.leaseNull === true);
  assert.ok(claims.length >= 2, '原后台 print worker 空领取不足两次。');
  assert.ok(events(scene, 'core.publicReply').filter(value => value.command === 'recordingPrintWorker.claim' && value.leaseNull === true).length >= 2);
}

function uiProof(scene, buildRoot) {
  const ui = scene.ui;
  assert.equal(ui?.entry, 'production-Vue-collection'); assert.equal(ui.apiOnly, false, 'API-only 不能冒充页面验收。');
  assert.ok(Array.isArray(ui.actions) && ui.actions.length > 0 && Array.isArray(ui.requests) && ui.requests.length > 0);
  assert.equal(new Set(ui.actions.map(value => value.id)).size, ui.actions.length, '页面动作 id 重复。');
  assert.equal(new Set(ui.requests.map(value => value.requestId)).size, ui.requests.length, '页面请求 id 重复。');
  for (const role of roles) assert.ok(ui.actions.some(value => value.role === role), '真实 locator 动作缺失：' + role);
  for (const action of ui.actions) {
    assert.ok(typeof action.id === 'string' && action.id && ['click', 'fill', 'selectOption', 'check'].includes(action.method));
    assert.ok(typeof action.locator === 'string' && action.locator.trim().length > 0, '真实 locator 缺失。');
    assert.ok(finite(action.startedMs) && finite(action.completedMs) && action.completedMs >= action.startedMs, '页面动作时序无效。');
    assert.equal(action.dom?.mounted, true, '收藏 Vue 页面未实际 mounted。');
    assert.equal(action.dom.url, 'musicbridge://app/index.html', '页面不是生产 Renderer 入口。');
    assert.ok(typeof action.dom.heading === 'string' && action.dom.heading.length > 0 && typeof action.dom.text === 'string' && action.dom.text.length > 0);
    assert.match(action.screenshot?.sha256, /^[a-f0-9]{64}$/);
    const screenshot = relativeFile(buildRoot, action.screenshot.path);
    assert.equal(fileHash(screenshot), action.screenshot.sha256, '页面截图身份漂移。');
    assert.deepEqual(fs.readFileSync(screenshot).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), '页面截图不是 PNG 图像。');
    assert.ok(Array.isArray(action.requestIds));
    for (const requestId of action.requestIds) assert.ok(ui.requests.some(value => value.requestId === requestId && value.actionId === action.id), '动作请求关联丢失。');
  }
  const navigate = ui.actions.find(value => value.role === 'navigate');
  assert.equal(navigate.method, 'click', '导航必须来自实际点击。');
  assert.match(navigate.locator, /收藏|collection/i, '伪造收藏导航。');
  assert.match(navigate.dom.text, /收藏/, '导航没有收藏 DOM。');
  for (const request of ui.requests) {
    assert.ok(allowedCommands.has(request.command), '页面证据越过本期命令闭集。');
    const action = ui.actions.find(value => value.id === request.actionId);
    assert.ok(action && action.requestIds.includes(request.requestId), '请求缺少实际 locator 关联。');
    assert.equal(request.request?.id, request.requestId); assert.equal(request.reply?.id, request.requestId);
    assert.equal(request.command, request.request.command);
    assert.equal(validateIpcRequest(request.request).ok, true, '请求不是完整公开 DTO。');
    assert.equal(validateIpcResponseForCommand(request.reply, request.command).ok, true, '回执不是完整安全 DTO。');
    assert.equal(request.reply.ok, true, '核心阅读未成功。');
    assert.equal(request.oracle?.kind, request.command === 'commandOutbox.execute'
      ? 'independent-Node-SQLite-durable-outbox' : 'independent-Node-SQLite', '缺少独立 Node SQLite oracle。');
    assert.deepEqual(request.oracle.request, request.request, 'oracle 请求漂移。');
    assert.deepEqual(request.oracle.reply, request.reply, '完整 reply DTO 与 SQLite oracle 不同。');
    const publicRequest = events(scene, 'core.publicRequest').find(value => value.requestId === request.requestId);
    const publicReply = events(scene, 'core.publicReply').find(value => value.requestId === request.requestId);
    assert.ok(publicRequest && publicReply && publicRequest.sequence < publicReply.sequence, '公开 request/reply id 证据缺失。');
    assert.equal(publicRequest.command, request.command); assert.equal(publicReply.command, request.command);
    assert.deepEqual(publicRequest.request, request.request); assert.deepEqual(publicReply.reply, request.reply);
    if (request.route === 'rust') {
      assert.equal(request.command, 'collection.list');
      const frame = scene.observations.find(value => value.sequence === request.rustAckSequence);
      assert.ok(frame && frame.event === 'rust.frame' && frame.operation === 'dispatch' && frame.ok === true
        && frame.requestId === request.requestId && frame.pid === request.pid, '页面请求没有对应真实 Rust ACK。');
      assert.ok(publicRequest.sequence < frame.sequence && frame.sequence < publicReply.sequence);
      assert.ok(positive(request.generation) && typeof request.scope?.epoch === 'string' && request.scope.epoch
        && typeof request.scope.datasetId === 'string' && request.scope.datasetId && typeof request.scope.snapshotId === 'string' && request.scope.snapshotId
        && typeof request.scope.revision === 'string' && request.scope.revision, 'Rust 读取 generation/scope 缺失。');
      const status = [scene.initialStatus?.router, scene.refreshedStatus?.router].find(value => value?.generation === request.generation);
      assert.ok(status, 'Rust 请求不属于已发布代次。');
      for (const key of ['epoch', 'datasetId', 'snapshotId', 'revision']) assert.equal(request.scope[key], status[key]);
      assert.equal(frame.generation, request.generation, 'Rust ACK generation 不对应。');
      for (const key of ['epoch', 'datasetId', 'snapshotId']) assert.equal(frame.scope?.[key], request.scope[key], 'Rust ACK scope 不对应。');
      const spawn = events(scene, 'rust.spawn').find(value => value.pid === request.pid);
      const exit = events(scene, 'rust.exit').find(value => value.pid === request.pid);
      assert.ok(spawn && exit && spawn.sequence < frame.sequence && frame.sequence < exit.sequence, 'Rust 请求越过 child 生命周期。');
    } else {
      assert.equal(request.route, 'node');
      const dispatch = scene.observations.find(value => value.sequence === request.ownerSequence);
      assert.ok(dispatch && dispatch.event === 'node.dispatch' && dispatch.requestId === request.requestId
        && dispatch.command === request.command, '页面请求没有对应 Node Owner 分派。');
      assert.ok(publicRequest.sequence < dispatch.sequence && dispatch.sequence < publicReply.sequence);
    }
  }
  for (const command of requiredReads) assert.ok(ui.requests.some(value => value.command === command), '核心页面请求缺失：' + command);
  const read = command => ui.requests.filter(value => value.command === command).map(value => value.reply.result);
  const summary = ui.oracleSummary;
  assert.equal(summary.models, scene.models, '小样本填充不能冒充规模。');
  assert.ok(read('collection.list').some(value => value.total === scene.models && value.offset === 0));
  assert.ok(read('collection.list').some(value => value.offset > 0), '真实收藏分页未读取。');
  assert.ok(ui.requests.some(value => value.command === 'collection.list' && value.request.payload.filter
    && Object.values(value.request.payload.filter).some(entry => entry !== undefined && entry !== '')), '真实收藏筛选未读取。');
  for (const key of ['wants', 'wantHistory', 'snapshots', 'photos']) assert.ok(positive(summary[key]), '合成资料为空：' + key);
  assert.ok(typeof summary.currentCatalogRevision === 'string' && summary.currentCatalogRevision && typeof summary.previousCatalogRevision === 'string'
    && summary.previousCatalogRevision && summary.currentCatalogRevision !== summary.previousCatalogRevision, '缺少两版目录。');
  assert.ok(read('collectionProgress.wants').some(value => value.total > 0 && value.items.length > 0));
  assert.ok(read('collectionProgress.wantHistory').some(value => value.total > 0 && value.items.length > 0));
  assert.ok(read('collectionProgress.snapshots').some(value => value.total > 0 && value.items.length > 0));
  for (const revision of [summary.currentCatalogRevision, summary.previousCatalogRevision]) {
    assert.ok(ui.requests.some(value => value.command === 'collectionProgress.current' && value.request.payload.revisionId === revision
      && value.reply.result.revisionId === revision && value.reply.result.isCurrentRevision === (revision === summary.currentCatalogRevision)), '两版目录完成度未读取。');
  }
  assert.ok(read('collectionProgress.snapshot').some(value => value.snapshot.revisionId === summary.previousCatalogRevision), '旧目录完成度快照未读取。');
  assert.ok(read('collection.photo').some(value => value.dataUrl.startsWith('data:image/jpeg;base64,') && value.width > 0 && value.height > 0));
}

function refreshProof(scene) {
  assert.equal(scene.initialStatus?.router?.phase, 'rust'); assert.equal(scene.afterWriteStatus?.router?.phase, 'stale');
  assert.equal(scene.refreshedStatus?.router?.phase, 'rust');
  for (const key of ['epoch', 'datasetId']) assert.equal(scene.initialStatus.router[key], scene.refreshedStatus.router[key]);
  for (const key of ['snapshotId', 'revision']) assert.notEqual(scene.initialStatus.router[key], scene.refreshedStatus.router[key]);
  assert.ok(scene.refreshedStatus.router.generation > scene.initialStatus.router.generation);
  const outbox = scene.outbox;
  assert.equal(outbox?.refreshCalls, 1, '必须仅一次可信显式 refresh。');
  assert.equal(outbox.succeededRows, 1); assert.equal(outbox.acknowledgedRows, 1);
  const writes = events(scene, 'node.dispatch').filter(value => value.command === 'commandOutbox.execute');
  assert.equal(writes.length, 1, 'outbox 原 Node 作者重复写入。');
  assert.equal(writes[0].requestId, outbox.executeRequestId);
  const writeRequest = scene.ui.requests.find(value => value.requestId === outbox.executeRequestId);
  assert.ok(writeRequest && writeRequest.actionId === outbox.actionId && writeRequest.command === 'commandOutbox.execute', '写入没有原表单 locator 关联。');
  assert.equal(writeRequest.request.payload.command, 'collection.setPolicy');
  assert.equal(writeRequest.request.payload.payload.commandId, outbox.commandId);
  assert.ok(scene.ui.actions.some(value => value.id === outbox.actionId && value.role === 'write' && value.method === 'click'));
  for (const role of ['fallback', 'refreshed-list']) {
    const action = scene.ui.actions.find(value => value.role === role);
    assert.ok(action && scene.ui.requests.some(value => value.actionId === action.id && value.command === 'collection.list'
      && value.route === (role === 'fallback' ? 'node' : 'rust')), '写后回退或刷新页面未读取：' + role);
  }
  assert.equal(events(scene, 'node.export').length + events(scene, 'node.exportLarge').length + events(scene, 'node.exportPlain').length, 2, '隐式导出或刷新。');
  assert.equal(events(scene, 'host.explicitRefresh').length, 1, '可信 refresh 观察不唯一。');
  const window = scene.refreshWindow;
  assert.ok(window && ['export', 'upload'].includes(window.phase) && finite(window.startedMs) && finite(window.completedMs)
    && window.completedMs - window.startedMs >= 1_500, '刷新窗口没有覆盖原 1500ms interval。');
  assert.ok(Array.isArray(window.claimSequences) && window.claimSequences.length > 0, '刷新窗口缺少真实 claim。');
  for (const sequence of window.claimSequences) {
    const claim = scene.observations.find(value => value.sequence === sequence);
    assert.ok(claim && claim.event === 'node.claimComplete' && claim.leaseNull === true && claim.elapsedMs >= window.startedMs
      && claim.elapsedMs <= window.completedMs, '刷新窗口没有实际空 claim 回执。');
    const reply = events(scene, 'core.publicReply').find(value => value.command === 'recordingPrintWorker.claim'
      && value.requestId === claim.requestId && value.leaseNull === true);
    assert.ok(reply && reply.elapsedMs >= window.startedMs && reply.elapsedMs <= window.completedMs, '刷新窗口没有完整公开空 claim 回执。');
  }
  assert.ok(events(scene, 'core.publicReply').filter(value => value.command === 'recordingPrintWorker.claim' && value.leaseNull === true
    && value.elapsedMs > window.completedMs).length >= 2, '刷新后原后台 worker 未继续两轮。');
}

/** 只核验绑定的实际 Electron 页面证据；不将 schema 测试升级为真实服务或 Owner 验收。 */
export function verifyRustCollectionEvidence(report, options) {
  identity(report, options);
  assert.ok(Array.isArray(report.scenarios)); assert.equal(report.scenarios.length, 4, '必须分层覆盖默认 Node 与三种 Rust 规模。');
  const defaults = report.scenarios.filter(value => value.scenario === 'default-node-collection-UI');
  assert.equal(defaults.length, 1); assert.equal(defaults[0].models, 100);
  for (const scene of report.scenarios) {
    assert.deepEqual(scene.staticProfile, profile(scene.models, options.binarySha256), '场景静态 profile 不匹配。');
    const isDefault = scene === defaults[0];
    if (!isDefault) assert.equal(scene.scenario, 'explicit-rust-collection-UI-outbox-refresh');
    resources(scene, isDefault ? 0 : 2); uiProof(scene, options.buildRoot);
    if (isDefault) {
      assert.equal(events(scene, 'node.export').length + events(scene, 'node.exportLarge').length + events(scene, 'node.exportPlain').length, 0, '默认 Node 发生私有导出。');
      assert.ok(scene.ui.requests.every(value => value.route === 'node'), '默认 Node 使用 Rust。');
      assert.equal(events(scene, 'node.dispatch').filter(value => value.command === 'commandOutbox.execute').length, 0, '默认 Node 浏览场景发生写入。');
      assert.equal(events(scene, 'host.explicitRefresh').length, 0);
    } else refreshProof(scene);
  }
  for (const models of [100, 2_000, 5_000]) assert.equal(report.scenarios.filter(value => value.scenario === 'explicit-rust-collection-UI-outbox-refresh'
    && value.models === models).length, 1, '规模缺失或小样本重复填充：' + models);
  return { layer, scenes: report.scenarios.length, inputFiles: report.sources.length, artifacts: report.artifacts.length,
    locatorActions: report.scenarios.reduce((sum, value) => sum + value.ui.actions.length, 0),
    validatedReplies: report.scenarios.reduce((sum, value) => sum + value.ui.requests.length, 0) };
}
