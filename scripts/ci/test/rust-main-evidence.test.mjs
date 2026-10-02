import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyRustMainEvidence } from '../rust-main-evidence.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function required(name) {
  const value = process.env[name];
  assert.ok(typeof value === 'string' && value.length > 0, 'Rust Gate 缺少冻结证据输入：' + name);
  return value;
}
const options = {
  root,
  buildRoot: required('MUSIC_BRIDGE_RUST_MAIN_HOST_BUILD_ROOT'),
  binaryPath: required('MUSIC_BRIDGE_RUST_BINARY'),
  binarySha256: required('MUSIC_BRIDGE_RUST_SHA256'),
  layer: 'controlled-production-Main-components',
};
const original = JSON.parse(fs.readFileSync(required('MUSIC_BRIDGE_RUST_MAIN_COMPONENT_REPORT'), 'utf8'));
const backgroundScenario = 'controlled-Main-components-background-outbox-refresh';
const cloneReport = () => structuredClone(original);
const scene100 = report => report.scenarios.find(scene => scene.scenario === backgroundScenario && scene.models === 100);
const resequence = scene => scene.observations.forEach((observation, index) => { observation.sequence = index + 1; });

// 只在内存改动证据，原报告、编译产物和源码均只读。
test('完整真实组件报告绑定源码、产物和三种规模后被接受', () => {
  const result = verifyRustMainEvidence(cloneReport(), options);
  assert.equal(result.layer, options.layer);
  assert.equal(result.scenes, 4);
  assert.ok(result.inputFiles > 0 && result.artifacts > 0);
});

test('删除真实close ACK并合法重编号，汇总仍称关闭完成也必须拒绝', () => {
  const report = cloneReport(), scene = scene100(report), resourceSummary = structuredClone(scene.resources);
  const index = scene.observations.findIndex(value => value.event === 'rust.frame' && value.operation === 'close' && value.ok === true);
  assert.ok(index >= 0, '输入报告必须含真实关闭 ACK。');
  const [removed] = scene.observations.splice(index, 1);
  resequence(scene);
  assert.equal(scene.resources.childResources.find(child => child.pid === removed.pid).closeAcks, 1);
  assert.deepEqual(scene.resources, resourceSummary);
  assert.throws(() => verifyRustMainEvidence(report, options), /真实 ACK 缺失：close/);
});

test('实际outbox执行观察重复两次但汇总仍为一次，合法序列也必须拒绝', () => {
  const report = cloneReport(), scene = scene100(report);
  const index = scene.observations.findIndex(value => value.event === 'node.dispatch' && value.command === 'commandOutbox.execute');
  assert.ok(index >= 0, '输入报告必须含真实 outbox 执行观察。');
  scene.observations.splice(index + 1, 0, structuredClone(scene.observations[index]));
  resequence(scene);
  assert.equal(scene.nodeOutboxExecuteCount, 1);
  assert.equal(scene.observations.filter(value => value.event === 'node.dispatch' && value.command === 'commandOutbox.execute').length, 2);
  assert.throws(() => verifyRustMainEvidence(report, options), /outbox 写入没有单次执行/);
});

test('只有100规模或用100重复填满场景数，均不能冒充完整三规模组件证据', () => {
  const reduced = cloneReport();
  reduced.scenarios = reduced.scenarios.filter(scene => scene.scenario !== backgroundScenario || scene.models === 100);
  assert.equal(reduced.scenarios.filter(scene => scene.scenario === backgroundScenario).length, 1);
  assert.throws(() => verifyRustMainEvidence(reduced, options), { code: 'ERR_ASSERTION' });
  // 场景条数正确仍缺失2000/5000覆盖，不能只凭汇总数量放行。
  const padded = cloneReport(), hundred = scene100(padded);
  padded.scenarios = [hundred, structuredClone(hundred), structuredClone(hundred),
    padded.scenarios.find(scene => scene.scenario === 'real-print-lease-write')];
  assert.equal(padded.scenarios.length, original.scenarios.length);
  assert.throws(() => verifyRustMainEvidence(padded, options), { code: 'ERR_ASSERTION' });
});

test('报告中的源码提交或编译产物身份漂移，均不能借原manifest放行', () => {
  const sourceDrift = cloneReport();
  sourceDrift.sourceSha = sourceDrift.sourceSha === '0'.repeat(40) ? '1'.repeat(40) : '0'.repeat(40);
  assert.throws(() => verifyRustMainEvidence(sourceDrift, options), { code: 'ERR_ASSERTION' });
  const artifactDrift = cloneReport();
  artifactDrift.artifacts[0].sha256 = artifactDrift.artifacts[0].sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  assert.throws(() => verifyRustMainEvidence(artifactDrift, options), { code: 'ERR_ASSERTION' });
});
