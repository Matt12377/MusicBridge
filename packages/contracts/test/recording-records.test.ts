import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../src/index.js';
const id = (n: number): string => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = '2026-08-28T00:00:00.000Z', end = '2026-08-29T00:00:00.000Z', hash = (s: string): string => s.repeat(64);
function planFixture() {
  const technical = { container: 'WAV', codec: 'PCM', sampleRate: 48000, channels: 2, bitsPerSample: 16, durationMs: 1000, lossless: true, sampleFrames: 48000, frameEvidence: 'container-declared' as const };
  const binding: c.SourceBinding = { id: id(4), rootId: id(5), fileName: '合成.wav', acquisition: 'userFileBind', verification: 'fileHashVerified', preservation: 'externalReferenceOnly', availability: 'ONLINE', sha256: hash('a'), size: 192044, modifiedAt: date, verifiedAt: date, technical, userConfirmed: true, sourceLockEligible: true };
  const master: c.MasterVersion = { id: id(2), draftId: id(1), sequence: 1, title: '合成母版', createdAt: date, content: { programType: 'compilation', tracks: [{ trackId: id(3), metadata: { title: '合成曲目', durationMs: 1000 }, source: { sha256: binding.sha256, size: binding.size, technical }, transitionAfterMs: 0, keepWithNext: false }] }, contentHash: hash('b'), sourceEvidence: [{ trackId: id(3), binding }], status: 'frozen' };
  const capacityFrames = 1440000;
  const layout: c.LayoutVersion = { id: id(6), draftId: master.draftId, masterVersionId: master.id, sequence: 1, planId: id(7), createdAt: date, spec: { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: false } }, lengthMinutes: 1, reservation: { physicalId: 'MB-C-00001', modelId: id(8), skuId: id(9), packaging: 'opened' }, timeline: { timebase: 'sample-frames', sampleRate: 48000, rounding: 'nearest-half-up-v1', sides: [{ name: 'A', capacityFrames, leadInFrames: 0, tailFrames: 0, totalFrames: 48000, tracks: [{ trackId: id(3), sourceBindingId: binding.id, sourceSampleRate: 48000, sourceFrames: 48000, startFrame: 0, endFrame: 48000, gapAfterFrames: 0 }] }, { name: 'B', capacityFrames, leadInFrames: 0, tailFrames: 0, totalFrames: 0, tracks: [] }] }, timelineHash: hash('c'), status: 'frozen', executionReady: false };
  const profile: c.RecordingProfileVersion = { id: id(10), profileId: id(11), sequence: 1, createdAt: date, contentHash: hash('d'), content: { name: '合成录音配置', signalChain: [{ id: id(12), kind: 'audio-interface', label: '未认证合成设备' }], defaults: { noiseReduction: 'Off', calibration: null, recordLevel: null, preRollMs: 1000 }, compatibility: layout.spec.compatibility, executionFormat: { sampleRate: 48000, channelCount: 2, channelLayout: 'stereo', internalProcessingPrecision: 'integer-bit-copy', outputSampleFormat: 'pcm-s16le', resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'synthetic-unverified', version: '1' } } } };
  const settings: c.ResolvedRecordingSettings = { profile, overrides: {}, effective: c.effectiveRecordingSettings(profile, {}), format: { ...profile.content.executionFormat, outputProfileVersion: profile.id }, fingerprint: hash('e') };
  const recipe: c.ExecutionRecipe = { schemaVersion: 1, mode: 'direct', compiler: 'musicbridge-pcm-copy-v1', masterVersionId: master.id, layoutVersionId: layout.id, contentHash: master.contentHash, plannedTimelineHash: layout.timelineHash, format: settings.format, side: 'A', capacityFrames, totalFrames: 48000, segments: [{ kind: 'source', trackId: id(3), input: { sha256: binding.sha256, size: binding.size, sampleRate: 48000, channelCount: 2, bitsPerSample: 16, totalFrames: 48000 }, startFrame: 0, endFrame: 48000 }], formalReady: false };
  const receipt: c.ExecutionAudioReceipt = { recipe, recipeHash: hash('f'), origin: 'compiled', audio: { sha256: hash('a'), pcmSha256: hash('b'), size: 192044, frameCount: 48000, dataOffset: 44 }, formalReady: false };
  const material = { master, layout, execution: { assetId: id(13), manifestHash: hash('d'), mode: 'direct' as const, compiledSettings: settings, recipes: [recipe, { ...recipe, side: 'B' as const, totalFrames: 0, segments: [] }], audio: [receipt] }, physicalCopy: { physicalId: layout.reservation.physicalId, lotId: id(14), skuId: layout.reservation.skuId, lengthMinutes: 1, packaging: 'opened' as const, usage: 'reserved' as const, available: true, origin: 'blank-pool' as const, revision: 2 }, mediaPlanRevision: 2, profileSnapshot: { sessionRevision: 3, settings: { ...settings, overrides: { noiseReduction: null }, effective: c.effectiveRecordingSettings(profile, { noiseReduction: null }), fingerprint: hash('f') } }, archive: { operationId: id(15), rootId: id(16), sourcePolicy: 'reference-dependent' as const, manifestHash: hash('a'), phase: 'FINALIZED' as const, objectCount: 3, copyBytes: 192500 }, retentionPolicy: 'f01-permanent-execution-v1' as const, onlineFallback: false as const, formalReady: false as const };
  const selection = { assetId: material.execution.assetId, archiveOperationId: material.archive.operationId };
  const proposal = { ...material, draftId: master.draftId, selection, checkedAt: date, proposalFingerprint: hash('c') };
  const plan = { ...material, id: id(17), draftId: master.draftId, sequence: 1, createdAt: date, contentHash: hash('e'), status: 'frozen' as const };
  return { material, selection, proposal, plan };
}
function recordFixture(): c.RecordingRecord {
  const { plan } = planFixture(), receipt = plan.execution.audio[0]!;
  return { schemaVersion: 1, id: id(50), createdAt: end, contentHash: hash('a'), completion: {
    kind: 'formal', id: id(51), draftId: plan.draftId, planVersionId: plan.id, planContentHash: plan.contentHash, executionAssetId: plan.execution.assetId, physicalId: plan.physicalCopy.physicalId,
    revision: 7, createdAt: date, updatedAt: end, endedAt: end, status: 'completed', phase: 'finished', softwarePlaybackComplete: true, physicalRecordingConfirmedAt: end, finalVerificationCompleteAt: end,
    sides: [{ side: 'A', phase: 'complete', frameCount: receipt.audio.frameCount, recipeHash: receipt.recipeHash, audioSha256: receipt.audio.sha256, pcmSha256: receipt.audio.pcmSha256, runId: id(52), sourceFramesRead: 48000, submittedFrames: 48000, consumedFrames: 48000, sourceEof: true, backendDrained: true, engineStoppedSubmitting: true, stopAcknowledged: false, cleanupQuiescent: false, startedAt: date, endedAt: end, physicalStopConfirmedAt: end }],
  }, media: { snapshotSource: 'completion', modelId: plan.layout.reservation.modelId, lotId: plan.physicalCopy.lotId, skuId: plan.physicalCopy.skuId, lengthMinutes: 1, origin: 'blank-pool', descriptor: { brand: '合成', name: '系列', edition: '', year: null, format: 'cassette', tapeType: 'II', identification: 'unidentified' } },
  visuals: { artwork: { state: 'not-captured', reason: 'not-provided' }, jCard: { state: 'not-captured', reason: 'not-implemented' }, photos: { state: 'not-captured', reason: 'not-provided' } } };
}
function stateFixture(): c.PhysicalRecordingState { return { physicalId: 'MB-C-00001', revision: 1, physicalRevision: 3, knowledge: { state: 'confirmed-recording', recordingId: id(50), confirmedAt: end, evidence: { kind: 'completed-attempt', attemptId: id(51), revision: 7 } }, latestAttempt: { id: id(51), revision: 7, status: 'completed' }, activeRerecordPermit: null }; }
function summary(): c.RecordingRecordSummary { return { id: id(50), physicalId: 'MB-C-00001', attemptId: id(51), planVersionId: id(17), completedAt: end, title: '合成母版', format: 'cassette', modelId: id(8), mediaBrand: '', mediaSeries: '' }; }
function previewRequest(): c.PreviewPhysicalRecordingDispositionRequest { return { physicalId: 'MB-C-00001', expectedPhysicalRevision: 3, expectedContentRevision: 1, expectedAttempt: { id: id(51), revision: 7 }, intent: { action: 'mark-content-unknown' } }; }
function proposal(): c.PhysicalRecordingDispositionProposal { return { request: previewRequest(), checkedAt: end, proposalFingerprint: hash('a'), before: stateFixture(), effect: 'content-unknown', outputWillStart: false }; }
function applied(): c.ApplyPhysicalRecordingDispositionResult { return { disposition: { id: id(60), physicalId: 'MB-C-00001', createdAt: end, intent: { action: 'mark-content-unknown' }, beforeContentRevision: 1, afterContentRevision: 2, beforePhysicalRevision: 3, afterPhysicalRevision: 3, observedAttempt: { id: id(51), revision: 7 } }, state: { ...stateFixture(), revision: 2, knowledge: { state: 'unknown', reason: 'manual-unknown', since: end } } }; }
function permit(): c.RerecordPermit { return { id: id(61), physicalId: 'MB-C-00001', dispositionId: id(60), createdAt: end, mediaPlanId: id(7), mediaPlanRevision: 3, contentRevision: 2, physicalRevision: 4, precedingAttempt: { id: id(51), revision: 7 }, state: 'available' }; }
function attachment(): c.RecordingVisualAttachment { return { id: id(70), recordingId: id(50), sourcePhotoId: id(71), physicalId: 'MB-C-00001', role: 'photo', source: 'physical-photo', sha256: hash('a'), size: 4, mimeType: 'image/jpeg', width: 1, height: 1 }; }

test('Record仅接受真实完成合同快照，不从EOF/当前配置推导完成', () => {
  assert.equal(typeof c.isRecordingRecord, 'function', 'RecordingRecord合同尚未实现');
  assert.equal(c.isRecordingAttempt(recordFixture().completion), true); assert.equal(c.isRecordingRecord(recordFixture()), true);
  for (const patch of [{ status: 'interrupted' }, { softwarePlaybackComplete: false }, { physicalRecordingConfirmedAt: undefined }, { finalVerificationCompleteAt: undefined }, { reason: 'underrun' }, { formalReady: true }]) assert.equal(c.isRecordingRecord({ ...recordFixture(), completion: { ...recordFixture().completion, ...patch } }), false);
  for (const patch of [{ schemaVersion: 2 }, { createdAt: date }, { contentHash: hash('A') }, { id: `${id(50)}\n` }, { path: '/private/archive' }]) assert.equal(c.isRecordingRecord({ ...recordFixture(), ...patch }), false);
});
test('Detail重用完整Plan，所有谱系/实体/侧帧/照片身份严格对应；当前内容可不同', () => {
  assert.equal(typeof c.isRecordingRecordDetail, 'function'); const value = { record: recordFixture(), plan: planFixture().plan, current: stateFixture() };
  assert.equal(c.isRecordingRecordDetail(value), true);
  for (const patch of [{ planContentHash: hash('d') }, { executionAssetId: id(99) }, { physicalId: 'MB-C-00002' }, { draftId: id(99) }, { sides: [{ ...value.record.completion.sides[0]!, pcmSha256: hash('d') }] }]) assert.equal(c.isRecordingRecordDetail({ ...value, record: { ...value.record, completion: { ...value.record.completion, ...patch } } }), false);
  for (const patch of [{ modelId: id(99) }, { lotId: id(99) }, { origin: 'legacy-registration' }, { lengthMinutes: 2 }]) assert.equal(c.isRecordingRecordDetail({ ...value, record: { ...value.record, media: { ...value.record.media, ...patch } } }), false);
  assert.equal(c.isRecordingRecordDetail({ ...value, current: { ...value.current, knowledge: { state: 'unknown', reason: 'new-attempt' } } }), true);
  assert.equal(c.isRecordingRecordDetail({ ...value, current: { ...value.current, physicalId: 'MB-C-00002' } }), false);
});
test('照片只同实体JPEG只读快照，不允许型号图/外链/伪造Artwork与JCard', () => {
  assert.equal(typeof c.isRecordingRecord, 'function'); const value = recordFixture(); value.visuals.photos = { state: 'captured', attachments: [attachment()] }; assert.equal(c.isRecordingRecord(value), true);
  for (const patch of [{ source: 'model-photo' }, { physicalId: 'MB-C-00002' }, { recordingId: id(99) }, { mimeType: 'image/svg+xml' }, { size: 1048577 }, { width: 1201 }, { url: 'https://example.invalid/a' }, { sha256: `${hash('a')}\n` }]) assert.equal(c.isRecordingRecord({ ...value, visuals: { ...value.visuals, photos: { state: 'captured', attachments: [{ ...attachment(), ...patch }] } } }), false);
  assert.equal(c.isRecordingRecord({ ...value, visuals: { ...value.visuals, artwork: { state: 'captured', attachments: [attachment()] } } }), false);
  assert.equal(c.isRecordingRecord({ ...value, visuals: { ...value.visuals, photos: { state: 'captured', attachments: [attachment(), attachment()] } } }), false);
  assert.equal(c.isRecordingVisualRequest({ recordingId: id(50), attachmentId: id(70) }), true);
  assert.equal(c.isRecordingVisualRequest({ photoId: id(71), path: '/private' }), false);
});
test('当前认知与旧档案分离，未知时间可缺省、不能夹带recordingId或伪认证', () => {
  assert.equal(typeof c.isPhysicalRecordingState, 'function'); assert.equal(c.isPhysicalRecordingState(stateFixture()), true);
  const initial = { ...stateFixture(), revision: 0, latestAttempt: null, knowledge: { state: 'unknown', reason: 'unverified' } }; assert.equal(c.isPhysicalRecordingState(initial), true);
  for (const knowledge of [{ state: 'unknown', reason: 'unverified', recordingId: id(50) }, { state: 'erased', confirmedAt: end }, { state: 'confirmed-recording', recordingId: id(50) }, { state: 'unknown', reason: 'unverified', since: '2026-02-30T00:00:00.000Z' }]) assert.equal(c.isPhysicalRecordingState({ ...stateFixture(), knowledge }), false);
  assert.equal(c.isPhysicalRecordingState({ ...stateFixture(), gateB: 'PASS' }), false);
});
test('许可仅available/consumed/revoked互斥，当前活动许可绑定实体/当前revision', () => {
  assert.equal(typeof c.isRerecordPermit, 'function'); const p = permit(); assert.equal(c.isRerecordPermit(p), true);
  assert.equal(c.isRerecordPermit({ ...p, state: 'consumed', attemptId: id(80), planVersionId: id(81), planContentHash: hash('a'), consumedAt: end }), true);
  assert.equal(c.isRerecordPermit({ ...p, state: 'revoked', dispositionIdOfRevocation: id(82), revokedAt: end }), true);
  for (const patch of [{ state: 'consumed' }, { attemptId: id(80) }, { state: 'available', certified: true }, { createdAt: `${end}\n` }, { mediaPlanRevision: 0 }]) assert.equal(c.isRerecordPermit({ ...p, ...patch }), false);
  const state = { ...stateFixture(), revision: 2, physicalRevision: 4, activeRerecordPermit: p }; assert.equal(c.isPhysicalRecordingState(state), true);
  for (const patch of [{ physicalId: 'MB-C-00002' }, { physicalRevision: 5 }, { contentRevision: 3 }]) assert.equal(c.isPhysicalRecordingState({ ...state, activeRerecordPermit: { ...p, ...patch } }), false);
});
test('五类处置必须明确意图/CAS，禁止Renderer后端事实和未知字段', () => {
  assert.equal(typeof c.isPreviewPhysicalRecordingDispositionRequest, 'function');
  for (const intent of [{ action: 'mark-content-unknown' }, { action: 'confirm-current-recording', recordingId: id(50) }, { action: 'prepare-rerecord', mediaPlanId: id(7), expectedMediaPlanRevision: 2 }, { action: 'cancel-rerecord', permitId: id(61) }, { action: 'confirm-erased' }]) {
    const request = { ...previewRequest(), intent }; assert.equal(c.isPreviewPhysicalRecordingDispositionRequest(request), true);
    assert.equal(c.isApplyPhysicalRecordingDispositionRequest({ ...request, commandId: id(60), proposalFingerprint: hash('a'), userConfirmed: true }), true);
    assert.equal(c.isPreviewPhysicalRecordingDispositionRequest({ ...request, intent: { ...intent, gateB: 'PASS' } }), false);
  }
  for (const patch of [{ expectedAttempt: undefined }, { expectedContentRevision: -1 }, { expectedPhysicalRevision: 0 }, { physicalId: 'MB-C-00001\n' }, { cleanupQuiescent: true }, { intent: { action: 'confirm-current-recording' } }, { intent: { action: 'mark-content-unknown', recordingId: id(50) } }]) assert.equal(c.isPreviewPhysicalRecordingDispositionRequest({ ...previewRequest(), ...patch }), false);
  assert.equal(c.isApplyPhysicalRecordingDispositionRequest({ ...previewRequest(), commandId: id(60), proposalFingerprint: hash('a'), userConfirmed: false }), false);
});
test('处置提案绑定原请求/当前头/最新Attempt及效果，不接受先前版本', () => {
  assert.equal(typeof c.isPhysicalRecordingDispositionProposal, 'function'); const value = proposal(); assert.equal(c.isPhysicalRecordingDispositionProposal(value), true);
  for (const patch of [{ effect: 'erased-confirmed' }, { outputWillStart: true }, { before: { ...value.before, physicalRevision: 4 } }, { before: { ...value.before, revision: 2 } }, { request: { ...value.request, expectedAttempt: null } }, { request: { ...value.request, expectedAttempt: { id: id(51), revision: 6 } } }]) assert.equal(c.isPhysicalRecordingDispositionProposal({ ...value, ...patch }), false);
});
test('处置结果修订/知识/permit分支严格对应，不以处置创建完成快照', () => {
  assert.equal(typeof c.isApplyPhysicalRecordingDispositionResult, 'function'); const value = applied(); assert.equal(c.isApplyPhysicalRecordingDispositionResult(value), true);
  for (const patch of [{ afterContentRevision: 1 }, { afterPhysicalRevision: 5 }, { permitId: id(61) }]) assert.equal(c.isApplyPhysicalRecordingDispositionResult({ ...value, disposition: { ...value.disposition, ...patch } }), false);
  assert.equal(c.isApplyPhysicalRecordingDispositionResult({ ...value, state: stateFixture() }), false);
  assert.equal(c.isApplyPhysicalRecordingDispositionResult({ ...value, mediaPlan: {} }), false);
});
test('搜索限定冻结字段、真实日期范围和25分页，不接受动态SQL/path', () => {
  assert.equal(typeof c.isListRecordingRecordsRequest, 'function');
  for (const query of ['427', 'C-0427', 'MB-C-00427', '合成曲目', "%'_"]) assert.equal(c.isListRecordingRecordsRequest({ page: { offset: 0, limit: 25 }, filter: { query } }), true);
  for (const value of [{ page: { offset: 0, limit: 26 } }, { page: { offset: -1, limit: 1 } }, { page: { offset: 1000001, limit: 1 } }, { page: { offset: 0, limit: 25 }, filter: { completedFrom: end, completedTo: date } }, { page: { offset: 0, limit: 25 }, filter: { sql: 'SELECT' } }]) assert.equal(c.isListRecordingRecordsRequest(value), false);
  assert.equal(c.isRecordingRecordSummary(summary()), true);
  assert.equal(c.isRecordingRecordSummary({ ...summary(), format: 'dat' }), false);
});
test('历史项目只同实体且Completed可带Record，数组超预算先拒绝', () => {
  assert.equal(typeof c.isPhysicalRecordingHistory, 'function'); const record = recordFixture();
  const value = { state: stateFixture(), entries: { items: [{ kind: 'attempt', id: record.completion.id, createdAt: record.completion.createdAt, attempt: record.completion, recordingId: record.id }], offset: 0, limit: 25, total: 1, hasMore: false } }; assert.equal(c.isPhysicalRecordingHistory(value), true);
  assert.equal(c.isPhysicalRecordingHistory({ ...value, state: { ...stateFixture(), physicalId: 'MB-C-00002' } }), false);
  const items = Array.from({ length: 26 }, () => summary()); Object.defineProperty(items, 0, { get() { throw new Error('不应遍历超预算列表'); } });
  assert.doesNotThrow(() => assert.equal(c.isRecordingRecordsPage({ items, offset: 0, limit: 25, total: 26, hasMore: true }), false));
  const photos = Array.from({ length: 25 }, () => attachment()); Object.defineProperty(photos, 0, { get() { throw new Error('不应遍历超预算照片'); } });
  assert.doesNotThrow(() => assert.equal(c.isRecordingRecord({ ...record, visuals: { ...record.visuals, photos: { state: 'captured', attachments: photos } } }), false));
});
test('正式音乐分支保留同physicalId/数量，未知Artist只放宽新分支', () => {
  const entry = { id: 'MB-C-00001', kind: 'personal-cassette', title: '合成母版', artist: '', quantity: 1, revision: 3, modelId: id(8), contentStatus: 'formal', recordingState: { revision: 1, state: 'confirmed-recording', recordingId: id(50) } };
  assert.equal(c.isMusicEntry(entry), true, '缺少正式音乐分支'); assert.equal(c.isMusicDetail({ entry, formal: entry.recordingState, photos: [] }), true);
  for (const patch of [{ quantity: 2 }, { kind: 'cd' }, { contentStatus: 'legacy' }, { contentStatus: 'missing' }, { recordingState: { revision: 1, state: 'unknown' } }]) assert.equal(c.isMusicEntry({ ...entry, ...patch }), false);
  const unknown = { ...entry, contentStatus: 'formal-current-unknown', recordingState: { revision: 2, state: 'unknown' } }; assert.equal(c.isMusicEntry(unknown), true);
  assert.equal(c.isMusicDetail({ entry, formal: unknown.recordingState, photos: [] }), false);
  assert.equal(c.isMusicDetail({ entry, formal: entry.recordingState, recording: { title: '覆写', artist: '伪造', tracks: [] }, photos: [] }), false);
});
test('六API严格注册且全部排除outbox，没有register或认证入口', () => {
  const detail = { record: recordFixture(), plan: planFixture().plan, current: stateFixture() }, result = applied();
  const cases = { 'recordingRecords.list': [{ page: { offset: 0, limit: 25 } }, { items: [summary()], offset: 0, limit: 25, total: 1, hasMore: false }], 'recordingRecords.get': [{ id: id(50) }, { record: detail }], 'recordingRecords.visual': [{ recordingId: id(50), attachmentId: id(70) }, { recordingId: id(50), attachmentId: id(70), sha256: hash('a'), image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 } }], 'recordingRecords.history': [{ physicalId: 'MB-C-00001', page: { offset: 0, limit: 25 } }, { state: stateFixture(), entries: { items: [], offset: 0, limit: 25, total: 0, hasMore: false } }], 'recordingRecords.previewDisposition': [previewRequest(), proposal()], 'recordingRecords.applyDisposition': [{ ...previewRequest(), commandId: id(60), proposalFingerprint: hash('a'), userConfirmed: true }, result] };
  for (const [command, [payload, value]] of Object.entries(cases)) {
    assert.equal(c.validateIpcRequest({ version: 1, id: 'records', command, payload }).ok, true, command);
    assert.equal(c.validateIpcRequest({ version: 1, id: 'records', command, payload: { ...payload, backendReady: true } }).ok, false, command);
    assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'records', ok: true, result: value }, command as c.IpcCommand).ok, true, command);
    assert.equal(c.isCommandOutboxCommand(command), false);
  }
  for (const command of ['recordingRecords.register', 'recordingRecords.complete', 'recordingRecords.start', 'recordingRecords.authorize']) assert.equal(c.validateIpcRequest({ version: 1, id: 'records', command, payload: {} }).ok, false);
});

test('旧schema19只保留Plan可证明的介质身份，不补今天descriptor或照片', () => {
  assert.equal(typeof c.isRecordingRecord, 'function'); const value = recordFixture();
  const { descriptor: _descriptor, ...media } = value.media;
  const legacy = { ...value, media: { ...media, snapshotSource: 'legacy-plan-only' }, visuals: { artwork: {state:'not-captured',reason:'not-provided'}, jCard: {state:'not-captured',reason:'not-provided'}, photos: {state:'not-captured',reason:'not-provided'} } };
  assert.equal(c.isRecordingRecord(legacy), true);
  assert.equal(c.isRecordingRecord({ ...value, media }), false);
  assert.equal(c.isRecordingRecord({ ...legacy, media: { ...legacy.media, descriptor: value.media.descriptor } }), false);
  assert.equal(c.isRecordingRecord({ ...legacy, visuals: { ...legacy.visuals, photos: { state: 'captured', attachments: [attachment()] } } }), false);
})

test('型号单盘投影不改变origin，未知当前内容不能沿用旧recordingTitle', () => {
  const rec = recordFixture(), descriptor = rec.media.descriptor!;
  const copy = { ...planFixture().plan.physicalCopy, usage:'recorded', recordingTitle:'合成母版', recordingState:{revision:1,state:'confirmed-recording',recordingId:rec.id} };
  const empty = {items:[],offset:0,limit:25,total:0,hasMore:false};
  const detail = {model:{...descriptor,id:rec.media.modelId,collectorPolicy:'normal',minimumSealedReserve:0,revision:1,lengths:[1],counts:{total:1,sealedBlank:0,openedBlank:0,legacyUsed:0,recorded:1,reserved:0,unavailable:0,unknown:0}},lots:empty,copies:{...empty,items:[copy],total:1}};
  assert.equal(c.isCollectionDetail(detail), true, '缺少同盘正式内容投影');
  assert.equal(c.isCollectionDetail({...detail,copies:{...detail.copies,items:[{...copy,recordingState:{revision:2,state:'unknown'}}]}}), false);
  assert.equal(c.isPhysicalRecordingSummary({revision:1,state:'confirmed-recording',recordingId:rec.id}),true);
  assert.equal(c.isPhysicalRecordingSummary({revision:1,state:'unknown',recordingId:rec.id}),false);
});

test('正式当前标题允许已预留/unknown历史占用，不放宽旧分支或blank/erased', () => {
  const rec = recordFixture(), descriptor = rec.media.descriptor!, empty = { items: [], offset: 0, limit: 25, total: 0, hasMore: false };
  const original = { ...planFixture().plan.physicalCopy, recordingTitle: '合成母版', recordingState: { revision: 1, state: 'confirmed-recording', recordingId: rec.id } };
  const detail = (copy: unknown) => ({ model: { ...descriptor, id: rec.media.modelId, collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1, lengths: [1], counts: { total: 1, sealedBlank: 0, openedBlank: 0, legacyUsed: 0, recorded: 0, reserved: 1, unavailable: 0, unknown: 0 } }, lots: empty, copies: { ...empty, items: [copy], total: 1 } });
  for (const usage of ['recorded', 'reserved', 'unknown']) assert.equal(c.isCollectionDetail(detail({ ...original, usage })), true, usage);
  for (const usage of ['blank', 'erased']) assert.equal(c.isCollectionDetail(detail({ ...original, usage })), false, usage);
  for (const usage of ['reserved', 'unknown']) { const { recordingState: _recordingState, ...old } = original; assert.equal(c.isCollectionDetail(detail({ ...old, usage })), false, `旧${usage}`); }
  for (const state of ['unknown', 'erased']) assert.equal(c.isCollectionDetail(detail({ ...original, usage: 'reserved', recordingState: { revision: 2, state } })), false, state);
});
