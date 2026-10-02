import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const positive = value => Number.isSafeInteger(value) && value > 0;
const events = (scene, name) => scene.observations.filter(value => value.event === name);
function relativeFile(parent, relative) {
  assert.equal(typeof relative, 'string', '证据文件名无效。');
  assert.ok(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), '证据文件越过其目录。');
  const resolved = path.resolve(parent, relative);
  assert.ok(resolved.startsWith(path.resolve(parent) + path.sep), '证据文件越界。');
  return resolved;
}
function resources(scene, children, appendAcks) {
  assert.ok(Array.isArray(scene.observations) && scene.observations.length, '主机观察缺失。');
  scene.observations.forEach((value, index) => {
    assert.equal(value.sequence, index + 1, '主机观察序号断裂。');
    assert.ok(Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0
      && (!index || value.elapsedMs >= scene.observations[index - 1].elapsedMs), '主机观察时序无效。');
  });
  for (const name of ['node.spawn', 'node.prepare', 'node.boot', 'node.bootComplete', 'node.close', 'node.closed', 'node.exit']) {
    assert.equal(events(scene, name).length, 1, 'Node 生命周期不完整：' + name);
  }
  assert.equal(events(scene, 'node.exit')[0].code, 0, 'Node 没有自然退出。');
  assert.equal(events(scene, 'node.fatal').length, 0, '正常场景发生 Node fatal。');
  const owner = events(scene, 'node.spawn')[0];
  assert.ok(positive(owner.hostPid) && positive(owner.threadId), '真实 Owner 进程/线程身份缺失。');
  assert.equal(scene.resources.nodeHostPid, owner.hostPid);
  assert.equal(scene.resources.nodeThreadId, owner.threadId);
  assert.equal(scene.resources.nodeVersion, owner.nodeVersion);
  assert.equal(scene.resources.forcedCleanup, false, '强制清理不能记为自然退出。');
  for (const key of ['nodeSpawn', 'nodePrepare', 'nodeBoot', 'nodeClose', 'nodeExit0']) assert.equal(scene.resources[key], 1);
  assert.equal(scene.resources.rustSpawn, children); assert.equal(scene.resources.rustExit0, children);
  const spawned = events(scene, 'rust.spawn'), exited = events(scene, 'rust.exit');
  assert.equal(spawned.length, children); assert.equal(exited.length, children);
  assert.equal(scene.resources.childResources.length, children);
  spawned.forEach((spawn, index) => {
    assert.ok(positive(spawn.pid)); assert.equal(spawn.liveChildren, 1, '出现并存 Rust child。');
    const frames = events(scene, 'rust.frame').filter(value => value.pid === spawn.pid);
    const ack = operation => frames.filter(value => value.operation === operation && value.ok === true);
    for (const operation of ['prepare', 'commitBoot', 'close']) assert.equal(ack(operation).length, 1, '真实 ACK 缺失：' + operation);
    assert.equal(ack('appendSnapshot').length, appendAcks);
    assert.ok(ack('prepare')[0].sequence < ack('commitBoot')[0].sequence);
    assert.ok(ack('appendSnapshot').every(frame => frame.sequence < ack('commitBoot')[0].sequence));
    const exit = exited.find(value => value.pid === spawn.pid);
    assert.ok(exit && exit.code === 0 && exit.signal === null && exit.liveChildren === 0, 'Rust 没有自然退出。');
    assert.ok(ack('commitBoot')[0].sequence < ack('close')[0].sequence && ack('close')[0].sequence < exit.sequence);
    if (index) assert.ok(exited.find(value => value.pid === spawned[index - 1].pid).sequence < spawn.sequence, '旧 child 未退出即创建新 child。');
    const receipt = scene.resources.childResources[index];
    assert.equal(receipt.pid, spawn.pid); assert.equal(receipt.prepareAcks, 1); assert.equal(receipt.bootAcks, 1);
    assert.equal(receipt.closeAcks, 1); assert.equal(receipt.appendAcks, appendAcks); assert.equal(receipt.exitCode, 0); assert.equal(receipt.signal, null);
  });
}
function refreshProof(scene) {
  assert.equal(scene.initialStatus?.router?.phase, 'rust'); assert.equal(scene.refreshedStatus?.router?.phase, 'rust');
  for (const key of ['epoch', 'datasetId']) assert.equal(scene.initialStatus.router[key], scene.refreshedStatus.router[key]);
  for (const key of ['snapshotId', 'revision']) assert.notEqual(scene.initialStatus.router[key], scene.refreshedStatus.router[key]);
  assert.ok(scene.refreshedStatus.router.generation > scene.initialStatus.router.generation);
  assert.equal(scene.nodeOutboxExecuteCount, 1);
  assert.equal(events(scene, 'node.dispatch').filter(value => value.command === 'commandOutbox.execute').length, 1, 'outbox 写入没有单次执行。');
  assert.equal(events(scene, 'node.export').length + events(scene, 'node.exportLarge').length, 2, '写后发生隐式导出或缺少显式刷新。');
  assert.ok(scene.dispatchCounts.nodeReadonly['commandOutbox.context'] >= 2);
}

/** 单独核验产物、源码和真实资源序列；Worker 组件证据不能升级为 Electron。 */
export function verifyRustMainEvidence(report, { root, buildRoot, binaryPath, binarySha256, layer }) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.task, 'RUST-008'); assert.equal(report.evidenceLayer, layer);
  assert.equal(report.productionDefault, 'Node');
  for (const key of ['realProvider', 'realRoon', 'ownerAcceptance']) assert.equal(report[key], 'NOT_RUN');
  assert.equal(report.binaryPath, binaryPath); assert.equal(report.binarySha256, binarySha256); assert.equal(fileHash(binaryPath), binarySha256);
  const manifestPath = path.join(buildRoot, 'artifact-manifest.json');
  assert.equal(report.artifactManifestPath, manifestPath); assert.equal(fileHash(manifestPath), report.artifactManifestSha256);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.task, 'RUST-008'); assert.equal(manifest.sourceSha, report.sourceSha);
  assert.equal(manifest.binaryPath, binaryPath); assert.equal(manifest.binarySha256, binarySha256);
  assert.ok(Array.isArray(report.sources) && report.sources.length > 0 && Array.isArray(report.artifacts) && report.artifacts.length > 0);
  assert.deepEqual(report.sources, manifest.sources); assert.deepEqual(report.artifacts, manifest.artifacts);
  assert.equal(hash(JSON.stringify(report.sources)), report.sourceAggregateSha256); assert.equal(manifest.sourceAggregateSha256, report.sourceAggregateSha256);
  assert.equal(new Set(report.sources.map(value => value.path)).size, report.sources.length);
  assert.equal(new Set(report.artifacts.map(value => value.path)).size, report.artifacts.length);
  for (const source of report.sources) assert.equal(fileHash(relativeFile(root, source.path)), source.sha256, '受测输入已经改变：' + source.path);
  for (const artifact of report.artifacts) assert.equal(fileHash(relativeFile(buildRoot, artifact.path)), artifact.sha256, '编译产物已经改变：' + artifact.path);
  assert.ok(report.artifacts.some(value => value.path === 'main/index.js') && report.artifacts.some(value => value.path === 'main/dataset-owner.js')
    && report.artifacts.some(value => value.path === 'preload/index.cjs'), '没有绑定真实 Main/Owner/preload。');
  assert.ok(Array.isArray(report.scenarios));
  if (layer === 'controlled-production-Main-components') {
    assert.equal(report.realAudio, 'NOT_RUN'); assert.equal(report.scenarios.length, 4);
    for (const models of [100, 2_000, 5_000]) {
      const matches = report.scenarios.filter(value => value.scenario === 'controlled-Main-components-background-outbox-refresh' && value.models === models);
      assert.equal(matches.length, 1); const scene = matches[0];
      assert.equal(scene.electron, 'NOT_RUN'); assert.equal(scene.differentialPages, 34); assert.ok(scene.nullClaimCount >= 5);
      assert.equal(scene.dispatchCounts.rustListAcks, 34); assert.equal(scene.dispatchCounts.nodeList, 1);
      assert.equal(scene.dispatchCounts.publicListRequests, 35); assert.ok(scene.dispatchCounts.publicNullClaimReplies >= 5);
      assert.ok(Number.isFinite(scene.completeSceneElapsedMs) && scene.completeSceneElapsedMs >= 0);
      refreshProof(scene); resources(scene, 2, models === 5_000 ? 40 : 0);
    }
    const matches = report.scenarios.filter(value => value.scenario === 'real-print-lease-write'); assert.equal(matches.length, 1);
    const scene = matches[0]; assert.equal(scene.validPendingJob, true); assert.equal(scene.realLease, true); assert.equal(scene.claimDispatchCount, 1);
    assert.equal(scene.rendererCalls, 1); assert.equal(scene.electron, 'NOT_RUN'); assert.equal(scene.realRecording, 'NOT_RUN');
    assert.equal(events(scene, 'node.dispatch').filter(value => value.command === 'recordingPrintWorker.claim').length, 1);
    resources(scene, 1, 0);
  } else {
    assert.equal(layer, 'real-Electron-production-Main'); assert.equal(report.scenarios.length, 2);
    for (const key of ['realAccount', 'realAudioRecording', 'pdfDevice', 'systemKeychain']) assert.equal(report[key], 'NOT_RUN');
    assert.equal(report.installedApplication, 'NOT_CHANGED');
    for (const scene of report.scenarios) {
      assert.ok(positive(scene.electronPid) && scene.runtimeVersions.electron && scene.runtimeVersions.node); assert.equal(scene.mockKeychain, true);
      assert.equal(scene.resources.nodeVersion, 'v' + scene.runtimeVersions.node);
      assert.equal(scene.main.filter(value => value.event === 'main.coreFork').length, 1);
      const spawned = scene.main.filter(value => value.event === 'main.coreSpawn'), exits = scene.main.filter(value => value.event === 'main.coreExit');
      assert.equal(spawned.length, 1); assert.equal(exits.length, 1); assert.equal(spawned[0].pid, scene.resources.nodeHostPid); assert.equal(exits[0].code, 0);
    }
    const legacy = report.scenarios.filter(value => value.scenario === 'default-node-real-Main'); assert.equal(legacy.length, 1);
    assert.equal(legacy[0].exportCount, 0); assert.ok(legacy[0].nullClaimCount >= 2); resources(legacy[0], 0, 0);
    assert.equal(events(legacy[0], 'node.export').length + events(legacy[0], 'node.exportLarge').length + events(legacy[0], 'node.exportPlain').length, 0);
    const enabled = report.scenarios.filter(value => value.scenario === 'explicit-rust-real-Main-outbox-refresh'); assert.equal(enabled.length, 1);
    const scene = enabled[0]; assert.equal(scene.models, 100); assert.equal(scene.differentialPages, 3);
    assert.equal(scene.afterWriteStatus?.router?.phase, 'stale'); assert.ok(scene.initialNullClaimCount >= 2 && scene.postRefreshNullClaimCount >= 2);
    assert.equal(scene.outboxSucceededRows, 1); assert.equal(scene.outboxAcknowledgedRows, 1);
    assert.equal(scene.dispatchCounts.rustListAcks, 2); assert.equal(scene.dispatchCounts.nodeList, 1); assert.equal(scene.dispatchCounts.publicListRequests, 3);
    refreshProof(scene); resources(scene, 2, 0);
  }
  return { layer, scenes: report.scenarios.length, inputFiles: report.sources.length, artifacts: report.artifacts.length };
}
