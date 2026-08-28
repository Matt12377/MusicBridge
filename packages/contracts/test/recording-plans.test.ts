import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../src/index.js';

const id = (n: number): string => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = '2026-08-28T00:00:00.000Z', hash = (letter: string): string => letter.repeat(64);
function fixture() {
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
const categories = ['versions', 'sources', 'execution', 'archive', 'physical-copy', 'capacity', 'profile', 'backend'];
function checked() { return { planVersionId: id(17), checkedAt: date, state: 'blocked', gateB: 'NOT_RUN', formalReady: false, checks: categories.map(category => category === 'backend' ? { category, state: 'not-run', code: 'BACKEND_NOT_CERTIFIED' } : { category, state: 'passed' }) }; }

test('计划合成材料符合原有冻结版本、Profile和执行字节合同', () => {
  const { material: m } = fixture();
  assert.equal(c.isMasterVersion(m.master), true); assert.equal(c.isLayoutVersion(m.layout), true);
  assert.equal(c.isVersionHistory({ draftId: m.master.draftId, masters: [m.master], layouts: [m.layout], jobs: [] }), true);
  assert.equal(c.isResolvedRecordingSettings(m.profileSnapshot.settings), true);
  assert.equal(c.isExecutionAudioReceipt(m.execution.audio[0]), true);
});

test('计划请求只接受明确资产/归档ID及原命令确认，不能注入参数、认证或路径', () => {
  assert.equal(typeof c.isFreezeRecordingPlanRequest, 'function', '正式计划合同尚未实现');
  const { selection } = fixture(), preview = { readId: id(20), selection }, freeze = { commandId: id(21), selection, proposalFingerprint: hash('a'), userConfirmed: true };
  assert.equal(c.isPreviewRecordingPlanRequest(preview), true); assert.equal(c.isFreezeRecordingPlanRequest(freeze), true);
  for (const patch of [{ userConfirmed: false }, { proposalFingerprint: 'bad' }, { certified: true }, { absolutePath: '/private/source' }, { settings: {} }]) assert.equal(c.isFreezeRecordingPlanRequest({ ...freeze, ...patch }), false);
  for (const patch of [{ assetId: '' }, { archiveOperationId: undefined }, { profileVersionId: id(22) }, { backendCertified: true }]) assert.equal(c.isPreviewRecordingPlanRequest({ ...preview, selection: { ...selection, ...patch } }), false);
  assert.equal(c.isRecordingPreflightRequest({ readId: id(22), planVersionId: id(17) }), true);
  assert.equal(c.isRecordingPreflightRequest({ readId: id(22), planVersionId: id(17), gateB: 'PASS' }), false);
});

test('计划允许当前会话覆盖快照但保留资产编译设置，拒绝缺会话、执行格式和Profile版本变化', () => {
  const { material: m, proposal, plan } = fixture();
  assert.equal(c.isRecordingPlanMaterial(m), true); assert.equal(c.isRecordingPlanProposal(proposal), true); assert.equal(c.isRecordingPlanVersion(plan), true);
  assert.notDeepEqual(m.profileSnapshot.settings, m.execution.compiledSettings);
  for (const profileSnapshot of [undefined, { ...m.profileSnapshot, sessionRevision: 0 }, { ...m.profileSnapshot, settings: { ...m.profileSnapshot.settings, effective: {} } }]) assert.equal(c.isRecordingPlanMaterial({ ...m, profileSnapshot }), false);
  const changed = structuredClone(m.profileSnapshot); changed.settings.profile.id = id(99); changed.settings.format.outputProfileVersion = id(99);
  assert.equal(c.isResolvedRecordingSettings(changed.settings), true); assert.equal(c.isRecordingPlanMaterial({ ...m, profileSnapshot: changed }), false);
  const changedFormat = structuredClone(m.profileSnapshot); changedFormat.settings.profile.content.executionFormat.outputBackend.version = '2'; changedFormat.settings.format.outputBackend.version = '2';
  assert.equal(c.isRecordingPlanMaterial({ ...m, profileSnapshot: changedFormat }), false);
});

test('计划对M/L、实际执行配方与空B面、实体预留及归档终态核对同一谱系', () => {
  const { material: m, proposal } = fixture();
  const patches = [{ master: { ...m.master, id: id(50) } }, { layout: { ...m.layout, timelineHash: hash('f') } }, { execution: { ...m.execution, audio: [] } }, { execution: { ...m.execution, recipes: [...m.execution.recipes].reverse() } }, { physicalCopy: { ...m.physicalCopy, physicalId: 'MB-C-00002' } }, { physicalCopy: { ...m.physicalCopy, skuId: id(99) } }, { physicalCopy: { ...m.physicalCopy, lengthMinutes: null } }, { physicalCopy: { ...m.physicalCopy, usage: 'recorded' } }, { archive: { ...m.archive, phase: 'DB_COMMITTED' } }, { archive: { ...m.archive, objectCount: 0 } }, { onlineFallback: true }, { formalReady: true }, { retentionPolicy: 'unresolved-no-automatic-deletion' }];
  for (const patch of patches) assert.equal(c.isRecordingPlanMaterial({ ...m, ...patch }), false, JSON.stringify(patch));
  assert.equal(c.isRecordingPlanProposal({ ...proposal, selection: { ...proposal.selection, assetId: id(99) } }), false);
  assert.equal(c.isRecordingPlanProposal({ ...proposal, selection: { ...proposal.selection, archiveOperationId: id(99) } }), false);
  const replacedSource = structuredClone(m);
  const segment = replacedSource.execution.recipes[0]!.segments[0]!;
  if (segment.kind === 'source') segment.input.sha256 = hash('f');
  assert.equal(c.isRecordingPlanMaterial(replacedSource), false, '只保留相同M/L Hash不能掩盖已替换的实际源内容');
});

test('Prepared计划冻结原始Render和Timeline，拒绝缺PREP或跨母版引用', () => {
  const { material: original } = fixture(), m = structuredClone(original);
  const raw: c.RawRenderAsset = { id: id(30), side: 'A', sha256: hash('a'), size: 192044, format: 'wav', sampleRate: 48000, channelLayout: 'stereo', totalFrames: 48000, createdAt: date, creationTimeEvidence: 'first-observed' };
  const prepared: c.FrozenPrepared = { id: id(31), draftId: m.master.draftId, sequence: 1, preparationId: id(32), importJobId: id(33), masterVersionId: m.master.id, layoutVersionId: m.layout.id, contentHash: m.master.contentHash, plannedTimelineHash: m.layout.timelineHash, plannedTimeline: m.layout.timeline, renderTimeline: { timebase: 'sample-frames', sides: [{ name: 'A', renderAssetId: raw.id, renderFileHash: raw.sha256, sampleRate: 48000, channelLayout: 'stereo', totalFrames: 48000, markers: [{ trackId: id(3), exactSourceSha256: hash('a'), actualStartFrame: 0, actualEndFrame: 48000, actualGapToNextFrames: 0, confirmationMethod: 'manual', userConfirmed: true }] }, { name: 'B', renderAssetId: null, renderFileHash: null, sampleRate: 48000, channelLayout: 'none', totalFrames: 0, markers: [] }] }, renderTimelineHash: hash('d'), assets: [raw], conformance: { status: 'MATCHED', policy: 'one-render-frame-v1', reasons: [] }, varianceReason: '', daw: '合成DAW', processingLineage: '合成人工处理', createdAt: date, transitionRenderingMode: 'Baked Into Render', status: 'frozen', executionReady: false };
  assert.equal(c.isFrozenPrepared(prepared), true);
  const recipe: c.ExecutionRecipe = { ...m.execution.recipes[0]!, mode: 'prepared-reference', prepared: { id: prepared.id, renderTimelineHash: prepared.renderTimelineHash }, segments: [{ kind: 'render', renderAssetId: raw.id, input: { sha256: raw.sha256, size: raw.size, sampleRate: raw.sampleRate, channelCount: 2, bitsPerSample: 16, totalFrames: raw.totalFrames }, startFrame: 0, endFrame: raw.totalFrames }] };
  const execution = { ...m.execution, mode: 'prepared-reference', recipes: [recipe, { ...recipe, side: 'B', totalFrames: 0, segments: [] }], audio: [{ ...m.execution.audio[0]!, recipe, origin: 'retained-render' }] };
  const value = { ...m, prepared, execution };
  assert.equal(c.isRecordingPlanMaterial(value), true);
  assert.equal(c.isRecordingPlanMaterial({ ...value, prepared: undefined }), false);
  assert.equal(c.isRecordingPlanMaterial({ ...value, prepared: { ...prepared, masterVersionId: id(99) } }), false);
  assert.equal(c.isRecordingPlanMaterial({ ...m, prepared }), false);
  const replacedRender = structuredClone(value);
  const render = replacedRender.execution.recipes[0]!.segments[0]!;
  if (render.kind === 'render') render.renderAssetId = id(99);
  assert.equal(c.isRecordingPlanMaterial(replacedRender), false, 'PREP头部ID不能替代实际Render引用');
});

test('计划历史按草稿保持不可变父链，拒绝重复、跳号与假就绪状态', () => {
  const { plan } = fixture(), next = { ...plan, id: id(18), sequence: 2, parentId: plan.id };
  assert.equal(c.isRecordingPlanHistory({ draftId: plan.draftId, versions: [next, plan] }), true);
  assert.equal(c.isRecordingPlanHistory({ draftId: plan.draftId, versions: [] }), true);
  for (const versions of [[plan, plan], [next], [{ ...next, parentId: id(99) }, plan], [{ ...next, draftId: id(99) }, plan]]) assert.equal(c.isRecordingPlanHistory({ draftId: plan.draftId, versions }), false);
  assert.equal(c.isRecordingPlanVersion({ ...plan, parentId: id(99) }), false);
  assert.equal(c.isRecordingPlanVersion({ ...plan, state: 'ready', formalReady: true }), false);
});

test('Preflight明确列出八项检查；Gate B未运行不能伪装就绪或把缺读当通过', () => {
  const result = checked(); assert.equal(c.isRecordingPreflightResult(result), true);
  for (const patch of [{ state: 'ready' }, { formalReady: true }, { gateB: 'PASS' }, { checks: result.checks.slice(1) }, { checks: [...result.checks, result.checks[0]] }, { checks: result.checks.map(check => check.category === 'backend' ? { category: 'backend', state: 'passed' } : check) }]) assert.equal(c.isRecordingPreflightResult({ ...result, ...patch }), false);
  for (const code of ['READ_FAILED', 'NOT_CHECKED']) assert.equal(c.isRecordingPreflightResult({ ...result, checks: result.checks.map(check => check.category === 'archive' ? { category: 'archive', state: code === 'NOT_CHECKED' ? 'not-run' : 'blocked', code } : check) }), true);
  assert.equal(c.isRecordingPreflightResult({ ...result, checks: result.checks.map(check => check.category === 'archive' ? { category: 'archive', state: 'blocked', code: '/private/archive: permission denied' } : check) }), false);
});

test('六个计划IPC请求/响应和公开导出严格闭合，不开放Start', () => {
  const { selection, proposal, plan } = fixture();
  const cases = { 'recordingPlans.list': [{ draftId: plan.draftId }, { draftId: plan.draftId, versions: [plan] }], 'recordingPlans.version': [{ id: plan.id }, { plan }], 'recordingPlans.preview': [{ readId: id(20), selection }, proposal], 'recordingPlans.freeze': [{ commandId: id(21), selection, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true }, plan], 'recordingPlans.preflight': [{ readId: id(22), planVersionId: plan.id }, checked()], 'recordingPlans.cancelRead': [{ id: id(23) }, { cancelled: true }] };
  for (const [command, [payload, result]] of Object.entries(cases)) {
    assert.equal(c.validateIpcRequest({ version: 1, id: 'plans', command, payload }).ok, true, command);
    assert.equal(c.validateIpcRequest({ version: 1, id: 'plans', command, payload: { ...payload, absolutePath: '/private/recording' } }).ok, false, command);
    assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'plans', ok: true, result }, command as c.IpcCommand).ok, true, command);
    assert.equal(c.validateIpcResponseForCommand({ version: 1, id: 'plans', ok: true, result: { ...result, certified: true } }, command as c.IpcCommand).ok, false, command);
  }
  assert.equal(c.validateIpcRequest({ version: 1, id: 'plans', command: 'recordingPlans.start', payload: { id: plan.id } }).ok, false);
});

test('只有计划Freeze进入持久outbox，结果保持原计划合同与工作库信封', () => {
  const { selection, proposal, plan } = fixture(), payload = { commandId: id(21), selection, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true };
  assert.equal(c.isCommandOutboxExecute({ datasetId: id(25), command: 'recordingPlans.freeze', payload }), true);
  assert.equal(c.isCommandOutboxResult({ command: 'recordingPlans.freeze', result: plan }), true);
  assert.equal(c.isCommandOutboxResult({ command: 'recordingPlans.freeze', result: { ...plan, formalReady: true } }), false);
  for (const command of ['recordingPlans.list', 'recordingPlans.preview', 'recordingPlans.preflight', 'recordingPlans.cancelRead', 'recordingPlans.start']) assert.equal(c.isCommandOutboxCommand(command), false);
});
