import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, readFile, writeFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildStoragePolicy } from '../../../../../apps/desktop/scripts/build-storage-root.mjs';
import { createSyntheticSamples, runOfflinePoc } from '../offline-poc.js';
import { startSyntheticFileHttp, type SyntheticFileHttp } from '../file-http.js';
import { nextTurn, readyFakeAdapter } from '../fake-roon-sdk.js';
import { createOfflineAttempt } from '../attempt.js';
import type { RoonAudioInputAdapterOptions } from '../../../src/roon/adapter.js';

async function privateDirectory(t: TestContext) {
  const policy = buildStoragePolicy(); const root = policy.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(root, 'musicbridge-mbrs001-life-')); await chmod(directory, 0o700);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fixture(t: TestContext, options: RoonAudioInputAdapterOptions = {}) {
  const policy = buildStoragePolicy(); const root = policy.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(root, 'musicbridge-mbrs001-life-')); await chmod(directory, 0o700);
  let service: SyntheticFileHttp | undefined;
  let harness: Awaited<ReturnType<typeof readyFakeAdapter>> | undefined;
  const attempts: ReturnType<typeof createOfflineAttempt>[] = [];
  t.after(async () => {
    for (const attempt of attempts) attempt.detach();
    try { if (harness) await harness.adapter.shutdown().catch(() => undefined); }
    finally { try { await service?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
  const generated = await createSyntheticSamples(directory);
  service = await startSyntheticFileHttp({ fixtureDirectory: directory, inputs: generated.inputs });
  harness = await readyFakeAdapter({ iconPort: Number(new URL(service.iconUrl).port), ...options });
  const activeService = service; const ready = harness;
  return { ...ready, service: activeService, ...generated,
    attempt(alias = 'attempt-one', sampleAlias = 'sample-1') {
      const attempt = createOfflineAttempt({ attemptAlias: alias, sampleAlias, service: activeService, ...ready });
      attempts.push(attempt); return attempt;
    } };
}
async function startPlaying(harness: Awaited<ReturnType<typeof fixture>>, attempt: ReturnType<typeof createOfflineAttempt>) {
  const beginIndex = harness.sdk.moo.count('begin_session'); const playIndex = harness.sdk.moo.count('play');
  const pending = attempt.start(); await nextTurn(); harness.sdk.moo.emitBegin(beginIndex); harness.sdk.moo.emitPlay(playIndex); await pending;
  return { beginIndex, playIndex };
}
async function stopConfirmed(harness: Awaited<ReturnType<typeof fixture>>, attempt: ReturnType<typeof createOfflineAttempt>) {
  const endIndex = harness.sdk.moo.count('end_session'); const pending = attempt.stop(); await nextTurn();
  harness.sdk.moo.replyEnd(endIndex); await pending; await attempt.disposeLocal();
}

test('MBRS001 cancel-before-begin：句柄调用不当SDK请求，latebegin补end且play零', async t => {
  const harness = await fixture(t); const attempt = harness.attempt();
  const start = attempt.start().catch(error => error); await nextTurn();
  attempt.cancelStartup(); assert.ok(await start instanceof Error);
  const stop = attempt.stop(); await nextTurn();
  assert.equal(harness.sdk.moo.endHandleInvocations, 1); assert.equal(harness.sdk.moo.count('end_session'), 0);
  assert.equal(attempt.observation().sessionConfirmedClosed, false);
  harness.sdk.moo.emitBegin();
  assert.equal(harness.sdk.moo.endHandleInvocations, 2); assert.equal(harness.sdk.moo.count('end_session'), 1);
  assert.equal(harness.sdk.moo.count('play'), 0); assert.equal(harness.sdk.moo.ledger()[0]!.remoteStop, 'UNCONFIRMED');
  harness.sdk.moo.replyEnd(); await stop; await attempt.disposeLocal();
  assert.equal(attempt.observation().sessionConfirmedClosed, true);
  assert.equal(harness.adapter.getDiagnosticResourceCounters().activeSessionCount, 0);
});

test('MBRS001 cancel无explicit-stop对照：latebegin不自动end，远端保持未确认', async t => {
  const harness = await fixture(t); const attempt = harness.attempt();
  const start = attempt.start().catch(error => error); await nextTurn(); attempt.cancelStartup(); await start;
  harness.sdk.moo.emitBegin(); assert.equal(harness.sdk.moo.count('play'), 0); assert.equal(harness.sdk.moo.count('end_session'), 0);
  await attempt.disposeLocal(); assert.equal(attempt.observation().remoteStop, 'UNCONFIRMED');
  // 不为finally虚构关闭确认；原shutdown可能停止超时，fixture清理只关闭本地资源。
});

test('MBRS001 B1：SessionEnded-only独立观察closed，但原Adapter通知缺口不遮盖', async t => {
  const harness = await fixture(t); const attempt = harness.attempt(); await startPlaying(harness, attempt);
  harness.sdk.moo.emitBegin(0, 'SessionEnded'); await attempt.waitForLocalCleanup();
  const observation = attempt.observation();
  assert.equal(observation.sessionConfirmedClosed, true); assert.equal(observation.adapterTerminalNotified, false);
  assert.equal(observation.knownGap, 'KNOWN_GAP_SESSION_ENDED_WITHOUT_ADAPTER_TERMINAL');
  assert.equal(observation.cleanupOrigin, 'HARNESS_RAW_SESSION_ENDED_RESOURCE_CLEANUP');
  assert.equal(harness.adapter.getDiagnosticResourceCounters().activeSessionCount, 0);
  assert.equal(harness.service.resourceSnapshot().closedFds, 1);
  harness.sdk.moo.emitPlay(0, 'Playing'); harness.sdk.moo.emitPlay(0, 'Time', { seek_position_ms: 99 });
  assert.deepEqual(attempt.observation().timePositionsMs, []); assert.equal(harness.adapter.getState().status, 'ready');
});

test('MBRS001 B1有效正对照：EndedNaturally确有Adapter terminal，不混SDK会话关闭', async t => {
  const harness = await fixture(t); const attempt = harness.attempt(); await startPlaying(harness, attempt);
  harness.sdk.moo.emitPlay(0, 'EndedNaturally'); await attempt.waitForLocalCleanup();
  assert.deepEqual(attempt.observation().adapterTerminalReasons, ['ended']);
  assert.equal(attempt.observation().cleanupOrigin, 'ADAPTER_TERMINAL');
  assert.equal(attempt.observation().sessionConfirmedClosed, false);
  harness.sdk.moo.emitBegin(0, 'SessionEnded');
  assert.equal(attempt.observation().sessionConfirmedClosed, true);
});

test('MBRS001 C1：beginTimeout清context不证明关闭，未发play不能伪造Playing', async t => {
  const harness = await fixture(t, { sessionBeginTimeoutMs: 25 }); const attempt = harness.attempt();
  const error = await attempt.start().catch(reason => reason) as { code: string; details: { phase: string } };
  assert.equal(error.code, 'ROON_TIMEOUT'); assert.equal(error.details.phase, 'awaiting_session');
  assert.equal(harness.adapter.getDiagnosticResourceCounters().activeSessionCount, 0);
  harness.sdk.moo.emitBegin(); assert.equal(harness.sdk.moo.count('play'), 0);
  assert.throws(() => harness.sdk.moo.emitPlay(), /没有实际发送/u);
  await attempt.stop(); assert.equal(harness.sdk.moo.count('end_session'), 0);
  await attempt.disposeLocal(); assert.equal(attempt.observation().remoteStop, 'UNCONFIRMED');
  assert.equal(harness.adapter.getDiagnosticResourceCounters().timerCount, 0);
});

test('MBRS001 C2：playingTimeout后实际play回调可迟到，但不能恢复状态或结算Time', async t => {
  const harness = await fixture(t, { playingTimeoutMs: 25 }); const attempt = harness.attempt();
  const pending = attempt.start().catch(error => error); await nextTurn(); harness.sdk.moo.emitBegin();
  const error = await pending as { code: string; details: { phase: string } };
  assert.equal(error.code, 'ROON_TIMEOUT'); assert.equal(error.details.phase, 'awaiting_playing');
  assert.equal(harness.sdk.moo.count('play'), 1);
  harness.sdk.moo.emitPlay(0, 'Playing'); harness.sdk.moo.emitPlay(0, 'Time', { seek_position_ms: 1234 });
  assert.equal(attempt.observation().rawPlayingObserved, true); assert.equal(attempt.observation().playingObserved, false);
  assert.deepEqual(attempt.observation().timePositionsMs, []); assert.deepEqual(attempt.observation().startupStages, ['roon-session-began']);
  await attempt.stop(); assert.equal(harness.sdk.moo.count('end_session'), 0);
  await attempt.disposeLocal(); assert.equal(attempt.observation().remoteStop, 'UNCONFIRMED');
});

test('MBRS001 C3：已确认会话stop超时保持UNKNOWN，只有迟到真实关闭回执才落定', { timeout: 5000 }, async t => {
  const harness = await fixture(t); const attempt = harness.attempt(); await startPlaying(harness, attempt);
  const error = await attempt.stop().catch(reason => reason) as { code: string };
  assert.equal(error.code, 'ROON_TIMEOUT'); assert.equal(harness.sdk.moo.count('end_session'), 1);
  assert.equal(attempt.observation().remoteStop, 'UNCONFIRMED');
  assert.equal(harness.adapter.getDiagnosticResourceCounters().activeSessionCount, 1);
  harness.sdk.moo.emitPlay(); assert.equal(harness.adapter.getState().status, 'error');
  harness.sdk.moo.replyEnd(); await attempt.waitForLocalCleanup();
  assert.deepEqual(attempt.observation().adapterTerminalReasons, ['stopped']); assert.equal(attempt.observation().sessionConfirmedClosed, true);
  assert.equal(harness.adapter.getDiagnosticResourceCounters().activeSessionCount, 0);
});

test('MBRS001 新attempt：同basename不同原字节，旧回调不撤销新token或FD', async t => {
  const harness = await fixture(t); const old = harness.attempt(); await startPlaying(harness, old);
  await stopConfirmed(harness, old); old.detach();
  const current = harness.attempt('attempt-two', 'sample-2'); await startPlaying(harness, current);
  const first = harness.inputs[0]!; const second = harness.inputs[1]!;
  assert.equal(path.basename(first.relativePath), path.basename(second.relativePath)); assert.notEqual(first.sha256, second.sha256);
  harness.sdk.moo.emitBegin(0, 'SessionEnded'); harness.sdk.moo.emitPlay(0, 'EndedNaturally');
  harness.sdk.moo.emitPlay(0, 'Time', { seek_position_ms: 9999 });
  assert.equal(current.observation().adapterTerminalNotified, false); assert.deepEqual(current.observation().timePositionsMs, []);
  const response = await fetch(harness.service.registrations[1]!.mediaUrl);
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), harness.bytes[1]);
  await harness.service.waitForRequestsDrained(); assert.equal(harness.service.resourceSnapshot().openFds, 1);
  const pause = harness.adapter.pause(); await nextTurn(); harness.sdk.transport.emit('paused'); await pause;
  const head = await fetch(harness.service.registrations[1]!.mediaUrl, { method: 'HEAD' }); await head.arrayBuffer();
  assert.equal(harness.service.resourceSnapshot().openFds, 1);
  await stopConfirmed(harness, current); await harness.service.close();
  assert.equal(await harness.service.releasedHandlesRejectStat(), true);
});

test('MBRS001 入口：bad flags/root/cache/复用输出在首写前拒绝，原bytes不变', async t => {
  const directory = await privateDirectory(t);
  const gate = await import(new URL('../../../../../scripts/ci/verify-mbrs001-offline.mjs', import.meta.url).href);
  const output = path.join(directory, 'should-not-exist');
  for (const argv of [[], [`--output-root=${output}`, '--live'], [`--output-root=${output}`, `--output-root=${output}`], ['--output-root=']]) {
    assert.throws(() => gate.validateOfflineArguments(argv)); assert.equal(existsSync(output), false);
  }
  await assert.rejects(runOfflinePoc([`--output-root=${output}`, '--file=arbitrary']), /output-root/u);
  assert.equal(existsSync(output), false);
  assert.throws(() => gate.validateOfflineArguments(['--output-root=/tmp/mbrs001-unapproved']));
  assert.throws(() => gate.validateOfflineArguments([`--output-root=${output}`], { ...process.env, TMPDIR: '/private/tmp' }));
  assert.throws(() => gate.validateOfflineArguments([`--output-root=${output}`], { ...process.env, DEV_CACHE_ROOT: '/private/tmp' }));
  const existing = path.join(directory, 'existing'); await writeFile(existing, 'old-byte-sentinel', { flag: 'wx', mode: 0o600 });
  assert.throws(() => gate.validateOfflineArguments([`--output-root=${existing}`]));
  assert.equal(await readFile(existing, 'utf8'), 'old-byte-sentinel'); assert.equal(existsSync(output), false);
});

test('MBRS001 输出：TAP名称与actual/stack均不能泄露能力URL、路径或opaque句柄', async () => {
  const gate = await import(new URL('../../../../../scripts/ci/verify-mbrs001-offline.mjs', import.meta.url).href);
  const sentinels = ['http://127.0.0.1:1234/sample/secret-capability', '/private/secret-input.wav', 'opaque-session-sentinel', 'opaque-token-sentinel'];
  const raw = `TAP version 13\nnot ok 1 - ${sentinels[0]}\n actual: ${sentinels[1]}\n session_id: ${sentinels[2]}\n token: ${sentinels[3]}\n# tests 1\n# pass 0\n# fail 1\n`;
  const sanitized: string = gate.sanitizeOutput(raw);
  for (const value of sentinels) assert.equal(sanitized.includes(value), false);
  assert.ok(sanitized.includes('not ok 1')); assert.ok(sanitized.includes('# fail 1'));
});

test('MBRS001 输出：新run为0700，结果为0600且wx拒绝覆盖原字节', async t => {
  const directory = await privateDirectory(t);
  const gate = await import(new URL('../../../../../scripts/ci/verify-mbrs001-offline.mjs', import.meta.url).href);
  const output = path.join(directory, 'private-run');
  const admission = gate.validateOfflineArguments([`--output-root=${output}`]);
  assert.equal(gate.createPrivateRun(admission), output);
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  gate.writePrivateJson(output, 'safe-result.json', { synthetic: true, alias: 'sample-1' });
  const result = path.join(output, 'safe-result.json'); const original = await readFile(result);
  assert.equal((await lstat(result)).mode & 0o777, 0o600);
  assert.throws(() => gate.writePrivateJson(output, 'safe-result.json', { replaced: true }));
  assert.deepEqual(await readFile(result), original);
  assert.throws(() => gate.createPrivateRun(admission));
});

test('MBRS001 交错owner：先构造A/B，未start及旧stop不影响当前，旧detach不抢B观察', async t => {
  const harness = await fixture(t);
  const a = harness.attempt('attempt-a', 'sample-1'); const b = harness.attempt('attempt-b', 'sample-2');
  await startPlaying(harness, a);
  await assert.rejects(b.stop(), /不能停止/u);
  await assert.rejects(b.start(), /观察owner/u);
  assert.equal(harness.sdk.moo.count('end_session'), 0);
  harness.sdk.moo.emitPlay(0, 'Time', { seek_position_ms: 1234 });
  assert.deepEqual(a.observation().timePositionsMs, [1234]); assert.deepEqual(b.observation().timePositionsMs, []);
  assert.equal(b.observation().rawPlayingObserved, false); assert.equal(b.observation().sessionAlias, null);
  harness.sdk.moo.emitPlay(0, 'EndedNaturally'); await a.waitForLocalCleanup();
  assert.deepEqual(a.observation().adapterTerminalReasons, ['ended']); assert.equal(b.observation().adapterTerminalNotified, false);
  assert.equal(harness.service.resourceSnapshot().closedFds, 1); assert.equal(harness.service.resourceSnapshot().openFds, 1);
  const response = await fetch(harness.service.registrations[1]!.mediaUrl);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), harness.bytes[1]);
  await harness.service.waitForRequestsDrained();
  await startPlaying(harness, b); a.detach();
  harness.sdk.moo.emitPlay(1, 'Time', { seek_position_ms: 2345 });
  assert.deepEqual(b.observation().timePositionsMs, [2345]); assert.deepEqual(a.observation().timePositionsMs, [1234]);
  await assert.rejects(a.stop(), /不能停止/u); assert.equal(harness.sdk.moo.count('end_session'), 0);
  harness.sdk.moo.emitPlay(1, 'EndedNaturally'); await b.waitForLocalCleanup();
  assert.deepEqual(b.observation().adapterTerminalReasons, ['ended']);
  assert.equal(harness.service.resourceSnapshot().openFds, 0); assert.equal(await harness.service.releasedHandlesRejectStat(), true);
  // 本地两FD关闭不替代两会话的关闭回执。
  assert.equal(a.observation().sessionConfirmedClosed, false); assert.equal(b.observation().sessionConfirmedClosed, false);
});

test('MBRS001 Gate计数合同：完整TAP接受，spec/缺字段/重复/遗漏/skip/todo拒绝', async () => {
  const gate = await import(new URL('../../../../../scripts/ci/verify-mbrs001-offline.mjs', import.meta.url).href);
  const summary = '# tests 31\n# pass 31\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(gate.isCompleteTestRun(gate.parseTestCounts(summary), 31), true);
  for (const raw of [
    'ℹ tests 31\nℹ pass 31\n', summary.replace('# todo 0\n', ''), summary + '# pass 31\n',
    summary.replace('tests 31', 'tests 30').replace('pass 31', 'pass 30'),
    summary.replace('skipped 0', 'skipped 1'), summary.replace('todo 0', 'todo 1'),
    summary.replace('fail 0', 'fail 1'), summary.replace('cancelled 0', 'cancelled 1'),
    summary.replace('tests 31', 'tests 9007199254740992'), summary.replace('pass 31', 'pass NaN'),
  ]) assert.equal(gate.isCompleteTestRun(gate.parseTestCounts(raw), 31), false);
  assert.equal(gate.isCompleteTestRun(gate.parseTestCounts(summary), 118), false);
});

test('MBRS001 stop超时本地收口：旧context仍阻止新owner，迟到确认后新FD可播放', { timeout: 10_000 }, async t => {
  const harness = await fixture(t);
  const a = harness.attempt('attempt-a', 'sample-1'); const b = harness.attempt('attempt-b', 'sample-2');
  await startPlaying(harness, a);
  const stopError = await a.stop().catch(error => error) as { code: string };
  assert.equal(stopError.code, 'ROON_TIMEOUT');
  await a.disposeLocal();
  assert.equal(harness.service.resourceSnapshot().closedFds, 1);
  assert.equal(harness.adapter.getDiagnosticResourceCounters().activeSessionCount, 1);
  assert.equal(a.observation().remoteStop, 'UNCONFIRMED');
  const blockedStart = b.start().catch(error => error); await nextTurn();
  // 不接管旧stopFailed context：首写前拒绝，不额外stop旧会话或派发新begin。
  assert.equal(harness.sdk.moo.count('end_session'), 1);
  assert.equal(harness.sdk.moo.count('begin_session'), 1);
  const blockedError = await blockedStart as Error;
  assert.ok(blockedError instanceof Error); assert.match(blockedError.message, /旧.*会话|确认收口/u);
  assert.equal(b.observation().sessionAlias, null);
  assert.equal(b.observation().adapterTerminalNotified, false);
  assert.equal(harness.service.resourceSnapshot().openFds, 1);
  harness.sdk.moo.replyEnd(0);
  assert.equal(harness.adapter.getDiagnosticResourceCounters().activeSessionCount, 0);
  assert.equal(a.observation().sessionConfirmedClosed, true);
  const response = await fetch(harness.service.registrations[1]!.mediaUrl);
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), harness.bytes[1]);
  await harness.service.waitForRequestsDrained();
  await startPlaying(harness, b); a.detach();
  harness.sdk.moo.emitPlay(1, 'Time', { seek_position_ms: 3456 });
  assert.deepEqual(b.observation().timePositionsMs, [3456]);
  harness.sdk.moo.emitPlay(1, 'EndedNaturally'); await b.waitForLocalCleanup();
  assert.deepEqual(b.observation().adapterTerminalReasons, ['ended']);
  assert.equal(await harness.service.releasedHandlesRejectStat(), true);
  assert.equal(b.observation().sessionConfirmedClosed, false);
});
