import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import type { SyntheticInputDescriptor, SyntheticFileHttp } from './file-http.js';

/** 两份runner自建小WAV；仅作原字节fixture，不作为Roon解码或出声证据。 */
export async function createSyntheticSamples(directory: string): Promise<{
  inputs: SyntheticInputDescriptor[]; bytes: Buffer[];
}> {
  buildStoragePolicy().check(directory, { mustExist: true });
  const info = await lstat(directory);
  if ((info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) throw new Error('合成fixture必须位于runner私有目录。');
  const inputs: SyntheticInputDescriptor[] = []; const bytes: Buffer[] = [];
  for (let index = 0; index < 2; index += 1) {
    const pcm = Buffer.alloc(256, index + 1);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    const content = Buffer.concat([header, pcm]);
    const subdirectory = index === 0 ? 'one' : 'two';
    const relativePath = `${subdirectory}/same-name.wav`;
    await mkdir(path.join(directory, subdirectory), { mode: 0o700 });
    await writeFile(path.join(directory, relativePath), content, { flag: 'wx', mode: 0o600 });
    inputs.push({ kind: 'synthetic', sampleAlias: `sample-${index + 1}`, relativePath,
      sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    bytes.push(content);
  }
  return { inputs, bytes };
}

export async function runOfflinePoc(argv: string[] = process.argv.slice(2)): Promise<void> {
  // 动态加载只有纯准入功能；Adapter/SDK/FD/端口均在所有flags/root检查之后。
  const gate = await import(new URL('../../../../scripts/ci/verify-mbrs001-offline.mjs', import.meta.url).href);
  const admission = gate.validateOfflineArguments(argv);
  const output: string = gate.createPrivateRun(admission);
  const directory = path.join(output, 'samples'); await mkdir(directory, { mode: 0o700 });
  const { inputs, bytes } = await createSyntheticSamples(directory);
  const { startSyntheticFileHttp } = await import('./file-http.js');
  const { readyFakeAdapter, nextTurn, SYNTHETIC_ZONE, AUDIOINPUT_COMMIT, AUDIOINPUT_LIB_SHA256 } = await import('./fake-roon-sdk.js');
  const { createOfflineAttempt } = await import('./attempt.js');
  let service: SyntheticFileHttp | undefined;
  let harness: Awaited<ReturnType<typeof readyFakeAdapter>> | undefined;
  const attempts: ReturnType<typeof createOfflineAttempt>[] = [];
  const observations: ReturnType<ReturnType<typeof createOfflineAttempt>['observation']>[] = [];
  try {
    service = await startSyntheticFileHttp({ fixtureDirectory: directory, inputs });
    harness = await readyFakeAdapter({ iconPort: Number(new URL(service.iconUrl).port) });
    const { adapter, sdk } = harness;
    for (let index = 0; index < 2; index += 1) {
      const registration: SyntheticFileHttp['registrations'][number] = service.registrations[index]!;
      const whole: Response = await fetch(registration.mediaUrl);
      assert.equal(whole.status, 200); assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes[index]);
      const part = await fetch(registration.mediaUrl, { headers: { Range: 'bytes=4-11' } });
      assert.equal(part.status, 206); assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes[index]!.subarray(4, 12));
      const head = await fetch(registration.mediaUrl, { method: 'HEAD', headers: { Range: 'bytes=4-11' } });
      assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
      await service.waitForRequestsDrained();
      const attempt = createOfflineAttempt({ attemptAlias: `attempt-${index + 1}`, sampleAlias: registration.sampleAlias, service, adapter, sdk });
      attempts.push(attempt);
      const starting = attempt.start(); await nextTurn();
      sdk.moo.emitBegin(index); sdk.moo.emitPlay(index); await starting;
      sdk.moo.emitPlay(index, 'Time', { seek_position_ms: 1234 });
      const pause = adapter.pause({ expectedZoneId: SYNTHETIC_ZONE }); await nextTurn(); sdk.transport.emit('paused'); await pause;
      sdk.moo.emitPlay(index, 'Paused');
      // 一次HEAD或GET已结束，paused/current的FD仍有效。
      assert.equal(service.resourceSnapshot().openFds, 2 - index);
      const resume = adapter.resume({ expectedZoneId: SYNTHETIC_ZONE }); await nextTurn(); sdk.transport.emit('playing'); await resume;
      const seek = adapter.seek(1234, { expectedZoneId: SYNTHETIC_ZONE }); await nextTurn(); sdk.transport.emit('playing', 1.234); await seek;
      if (index === 0) {
        const stop = attempt.stop(); await nextTurn(); sdk.moo.replyEnd(0); await stop;
        await attempt.disposeLocal();
      } else {
        // 有效Playing前缀之后核验Adapter实际终态；原资源观察不替代会话回执。
        sdk.moo.emitBegin(index, 'SessionEnded'); await attempt.waitForLocalCleanup();
        assert.equal(attempt.observation().adapterTerminalNotified, true);
        assert.deepEqual(attempt.observation().adapterTerminalReasons, ['ended']);
        assert.equal(attempt.observation().knownGap, null);
        assert.equal(attempt.observation().cleanupOrigin, 'ADAPTER_TERMINAL');
        assert.equal(attempt.observation().sessionConfirmedClosed, true);
      }
      observations.push(attempt.observation()); attempt.detach();
    }
    assert.notEqual(inputs[0]!.sha256, inputs[1]!.sha256);
    assert.deepEqual(sdk.forbiddenCalls, { browse: 0, resolver: 0, enhancement: 0 });
    await adapter.shutdown(); await service.close();
    const actualClosedHandleProbe = await service.releasedHandlesRejectStat();
    assert.equal(actualClosedHandleProbe, true);
    assert.equal(sdk.moo.callbackSlots(), 0); assert.equal(sdk.moo.observerCount(), 0); assert.equal(sdk.transport.subscriptionCount(), 0);
    gate.writePrivateJson(output, 'result.json', {
      schema: 'mbrs001.synthetic-poc.v1', synthetic: true, completed: true, liveRoon: 'BLOCKED_ENV', ownerAcceptance: 'NOT_TESTED',
      audioInputIdentity: { gitSha: AUDIOINPUT_COMMIT, libSha256: AUDIOINPUT_LIB_SHA256 },
      samples: inputs.map(input => ({ sampleAlias: input.sampleAlias, sizeBytes: input.sizeBytes, sha256: input.sha256, sameBasename: true })),
      observations, localResources: { ...service.resourceSnapshot(), actualClosedHandleProbe,
        fakeSdkCallbackSlots: sdk.moo.callbackSlots(), fakeSdkObservers: sdk.moo.observerCount(), fakeTransportSubscriptions: sdk.transport.subscriptionCount(),
        adapterTimerCount: adapter.getDiagnosticResourceCounters().timerCount },
      forbiddenPortCalls: sdk.forbiddenCalls, knownGapCapturedNotRepaired: false,
      acceptance: { 'MBRS-AT-001-01': 'BLOCKED_ENV', 'MBRS-AT-001-02': 'SYNTHETIC_BYTES_ONLY',
        'MBRS-AT-001-03': 'BLOCKED_ENV', 'MBRS-AT-001-04': 'BLOCKED_ENV', 'MBRS-AT-001-05': 'BLOCKED_ENV',
        'MBRS-AT-001-06': 'SYNTHETIC_SESSION_ENDED_TERMINAL_ONLY', 'MBRS-AT-001-07': 'SYNTHETIC_SUBMISSION_ONLY',
        'MBRS-AT-001-08': 'SYNTHETIC_ISOLATION_ONLY', 'MBRS-AT-001-09': 'SYNTHETIC_ADAPTER_REUSE_ONLY' },
      formats: ['wav', 'flac', 'mp3'].map(format => ({ format, liveDecode: 'NOT_TESTED', actualSound: 'NOT_TESTED' })),
    });
  } finally {
    for (const attempt of attempts) { attempt.detach(); await attempt.disposeLocal().catch(() => undefined); }
    if (harness) await harness.adapter.shutdown().catch(() => undefined);
    if (service) await service.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runOfflinePoc().catch(() => { console.error('MBRS001离线复现失败；未公开输入路径或SDK句柄。'); process.exitCode = 1; });
}
