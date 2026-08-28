import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { FileHandle } from 'node:fs/promises';
import { writeFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { recordingPlanFixture } from './helpers/recording-plan-fixture.js';
import type { RecordingOutputRunner } from '../src/recording/output-input.js';

function facts(filePath: string) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]); }
  finally { db.close(); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const helperSha256 = 'a'.repeat(64);
const consume: RecordingOutputRunner['run'] = async ({ handle, audio, format, signal, checkOperation }) => {
  const bytesPerSample = format.outputSampleFormat === 'pcm-s16le' ? 2 : format.outputSampleFormat === 'pcm-s24le' ? 3 : 4;
  const dataBytes = audio.frameCount * format.channelCount * bytesPerSample, hash = createHash('sha256');
  const chunk = Buffer.alloc(4096); let offset = 0;
  while (offset < dataBytes) {
    signal.throwIfAborted(); checkOperation();
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, dataBytes - offset), audio.dataOffset + offset);
    assert.ok(bytesRead); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
  }
  return { consumedFrames: audio.frameCount, pcmSha256: hash.digest('hex'), helperSha256 };
};
async function fixture(t: test.TestContext, options: { prepared?: boolean; format?: 'cassette' | 'dat'; runner?: RecordingOutputRunner; maxRunIds?: number; operationTimeoutMs?: number; afterVerification?: () => Promise<void> } = {}) {
  const f = await recordingPlanFixture(t, options.prepared, options.format ? { format: options.format } : {});
  const plan = await f.plans.freeze(await f.planRequest());
  const module = await import('../src/recording/output-check.js').catch(() => ({}));
  assert.ok('createRecordingOutputCoordinator' in module, '缺少只读合成输出检查协调器');
  const output = (module as typeof import('../src/recording/output-check.js')).createRecordingOutputCoordinator({ store: f.repository.recordingPlans, runner: options.runner ?? { run: consume }, ...(options.maxRunIds ? { maxRunIds: options.maxRunIds } : {}), ...(options.operationTimeoutMs ? { operationTimeoutMs: options.operationTimeoutMs } : {}), ...(options.afterVerification ? { afterVerification: options.afterVerification } : {}) });
  t.after(() => output.close());
  const request = { runId: randomUUID(), planVersionId: plan.id, side: options.format === 'dat' ? 'Program' as const : 'A' as const };
  return { ...f, planVersion: plan, output, outputRequest: request };
}

for (const mode of ['direct', 'prepared', 'dat'] as const) test(`${mode}只读真实执行PCM并保持全部SQL/库存/Plan；合成通过不认证设备`, async t => {
  const f = await fixture(t, { prepared: mode === 'prepared', ...(mode === 'dat' ? { format: 'dat' } : {}) }), before = facts(f.filePath);
  const result = await f.output.check(f.outputRequest), audio = f.planVersion.execution.audio.find(a => a.recipe.side === f.outputRequest.side)!;
  assert.deepEqual(result, { state: 'verified', ...f.outputRequest, planContentHash: f.planVersion.contentHash, frameCount: audio.audio.frameCount, consumedFrames: audio.audio.frameCount, pcmSha256: audio.audio.pcmSha256, helperSha256, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN', evidence: 'synthetic-only' });
  assert.deepEqual(facts(f.filePath), before);
  assert.ok(!JSON.stringify(result).includes(f.directory));
});

test('音频FD为只读且租期覆盖runner完成，完成后关闭句柄', async t => {
  const entered = deferred(), release = deferred(); let live!: FileHandle;
  const f = await fixture(t, { runner: { run: async input => { live = input.handle; await assert.rejects(live.write(Buffer.from([1]), 0, 1, 0)); entered.resolve(); await release.promise; return consume(input); } } });
  const pending = f.output.check(f.outputRequest); await entered.promise; assert.ok((await live.stat()).isFile()); release.resolve(); await pending;
  await assert.rejects(live.stat());
});

test('同run同body单飞及终态重放；异body与同时另一run拒绝，不自动重跑', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, { runner: { run: async input => { calls++; entered.resolve(); await release.promise; return consume(input); } } });
  const one = f.output.check(f.outputRequest), two = f.output.check(f.outputRequest); await entered.promise;
  await assert.rejects(f.output.check({ ...f.outputRequest, side: 'B' }), /RUN_CONFLICT/);
  await assert.rejects(f.output.check({ ...f.outputRequest, runId: randomUUID() }), /RUN_CONFLICT/);
  release.resolve(); const result = await one; assert.deepEqual(await two, result); assert.deepEqual(await f.output.check(f.outputRequest), result); assert.equal(calls, 1);
});

test('取消先到、重复取消、ID预算不淘汰；关闭后不能开始检查', async t => {
  let calls = 0; const f = await fixture(t, { maxRunIds: 2, runner: { run: async input => { calls++; return consume(input); } } });
  assert.deepEqual(f.output.cancel({ runId: f.outputRequest.runId }), { cancelled: true });
  assert.deepEqual(f.output.cancel({ runId: f.outputRequest.runId }), { cancelled: true });
  await assert.rejects(f.output.check(f.outputRequest), /CANCELLED/);
  await f.output.check({ ...f.outputRequest, runId: randomUUID() });
  await assert.rejects(f.output.check({ ...f.outputRequest, runId: randomUUID() }), /RUN_LIMIT/);
  assert.equal(calls, 1); await f.output.close(); await assert.rejects(f.output.check(f.outputRequest), /CLOSED/);
});

test('cancel请求和close使迟到成功失效，close等待runner退出再释放FD', async t => {
  for (const action of ['cancel', 'close'] as const) {
    const entered = deferred(), release = deferred(); let live!: FileHandle;
    const f = await fixture(t, { runner: { run: async input => { live = input.handle; const result = await consume(input); entered.resolve(); await release.promise; return result; } } });
    const pending = f.output.check(f.outputRequest); const rejection = assert.rejects(pending, /CANCELLED|CLOSED/); await entered.promise;
    if (action === 'cancel') f.output.cancel({ runId: f.outputRequest.runId });
    let settled = false; const closing = f.output.close().then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false); assert.ok((await live.stat()).isFile());
    release.resolve(); await rejection; await closing; await assert.rejects(live.stat());
  }
});

test('租期内重命名替换输入，即使新路径字节完全相同也拒绝成功', async t => {
  const f = await fixture(t, { runner: { run: async input => {
    const result = await consume(input), job = f.repository.execution.job(f.planVersion.execution.assetId)!;
    const file = path.join(job.owned!.root.path, 'Audio/A.execution.wav'), bytes = await readFile(file);
    await rename(file, file + '.saved'); await writeFile(file, bytes); return result;
  } } });
  await assert.rejects(f.output.check(f.outputRequest), /INPUT_CHANGED/);
});

test('runner期间源内容改变或执行目录撤权不得沿用早先核验', async t => {
  for (const change of ['source', 'authorization'] as const) {
    const f = await fixture(t, { runner: { run: async input => {
      const result = await consume(input);
      if (change === 'source') await writeFile(f.file, '合成源变化');
      else f.repository.preparations.revoke({ commandId: randomUUID(), id: f.repository.execution.job(f.planVersion.execution.assetId)!.input.destination.id });
      return result;
    } } });
    await assert.rejects(f.output.check(f.outputRequest), change === 'source' ? /INPUT_CHANGED/ : /PLAN_CHANGED/);
  }
});

test('错误PCM hash或helper身份不能形成verified；失败run保留原失败不重跑', async t => {
  for (const change of ['pcm', 'helper'] as const) {
    let calls = 0;
    const f = await fixture(t, { runner: { run: async input => { calls++; const result = await consume(input); return change === 'pcm' ? { ...result, pcmSha256: 'b'.repeat(64) } : { ...result, helperSha256: 'not-a-hash' }; } } });
    await assert.rejects(f.output.check(f.outputRequest), change === 'pcm' ? /FRAME_MISMATCH/ : /HELPER_PROTOCOL/);
    await assert.rejects(f.output.check(f.outputRequest)); assert.equal(calls, 1);
  }
});

test('对runner核验时传入的是冻结Plan/recipe identity和完整音频范围', async t => {
  const f = await fixture(t, { runner: { run: async input => {
    const audio = f.planVersion.execution.audio.find(receipt => receipt.recipe.side === 'A')!;
    assert.deepEqual(input.identity, { runId: f.outputRequest.runId, planVersionId: f.planVersion.id, assetId: f.planVersion.execution.assetId, planContentHash: f.planVersion.contentHash, recipeHash: audio.recipeHash });
    assert.deepEqual(input.audio, audio.audio); assert.deepEqual(input.format, f.planVersion.profileSnapshot.settings.format);
    return consume(input);
  } } });
  await f.output.check(f.outputRequest);
});

test('有界超时触发abort并等待受控runner退出，超时不得作为合成通过', async t => {
  const entered = deferred(); let live!: FileHandle;
  const f = await fixture(t, { runner: { run: async input => {
    live = input.handle; const result = await consume(input); entered.resolve();
    await new Promise<void>(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', () => resolve(), { once: true }); });
    return result;
  } } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.output.check(f.outputRequest), rejection = assert.rejects(pending, /TIMEOUT/);
  await entered.promise; t.mock.timers.tick(15 * 60_000 + 1); await rejection;
  t.mock.timers.reset(); await assert.rejects(live.stat());
});

test('核验await期间当前Plan依赖变化在runner启动前拒绝，旧Plan与资产不被改写', async t => {
  let mutate = false, calls = 0;
  const f = await fixture(t, { runner: { run: async input => { calls++; return consume(input); } }, afterVerification: async () => { if (mutate) { mutate = false; f.repository.updateCopy({ commandId: randomUUID(), physicalId: f.planVersion.physicalCopy.physicalId, expectedRevision: f.planVersion.physicalCopy.revision, action: 'mark-unavailable' }); } } });
  mutate = true; await assert.rejects(f.output.check(f.outputRequest), /PLAN_CHANGED/); assert.equal(calls, 0);
  assert.deepEqual(f.repository.recordingPlans.version({ id: f.planVersion.id }).plan, f.planVersion);
});

test('runner退出前实际输入被改写，租期末检查拒绝原位变化且不返回伪成功', async t => {
  const f = await fixture(t, { runner: { run: async input => {
    const result = await consume(input), job = f.repository.execution.job(f.planVersion.execution.assetId)!;
    await writeFile(path.join(job.owned!.root.path, 'Audio/A.execution.wav'), '合成破坏已读文件'); return result;
  } } });
  await assert.rejects(f.output.check(f.outputRequest), /INPUT_CHANGED/);
});

test('缺失side及伪造helper帧/hash回执均拒绝；未知异常消息不含私有路径', async t => {
  const f = await fixture(t, { runner: { run: async input => ({ ...await consume(input), consumedFrames: 1 }) } });
  await assert.rejects(f.output.check({ ...f.outputRequest, side: 'Program' }), /EMPTY_SIDE/);
  await assert.rejects(f.output.check({ ...f.outputRequest, runId: randomUUID() }), /FRAME_MISMATCH/);
  const g = await fixture(t, { runner: { run: async () => { throw new Error('/private/synthetic-output-helper'); } } });
  await assert.rejects(g.output.check(g.outputRequest), error => error instanceof Error && !error.message.includes('/private/') && error.message.includes('HELPER_UNAVAILABLE'));
});
