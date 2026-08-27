import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as c from '../src/index.js';

const profile: c.RecordingProfileVersion = { id: randomUUID(), profileId: randomUUID(), sequence: 1, createdAt: new Date().toISOString(), contentHash: 'a'.repeat(64), content: { name: '合成参数', signalChain: [{ id: randomUUID(), kind: 'audio-interface', label: '未认证的计划声卡' }], defaults: { noiseReduction: 'Off', calibration: null, recordLevel: null, preRollMs: 1000 }, compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true }, executionFormat: { sampleRate: 96000, channelCount: 2, channelLayout: 'stereo', internalProcessingPrecision: 'integer-bit-copy', outputSampleFormat: 'pcm-s16le', resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'fixture-no-output', version: '1' } } } };
const settings: c.ResolvedRecordingSettings = { profile, overrides: { noiseReduction: null }, effective: c.effectiveRecordingSettings(profile, { noiseReduction: null }), format: { ...profile.content.executionFormat, outputProfileVersion: profile.id }, fingerprint: 'b'.repeat(64) };
const recipe: c.ExecutionRecipe = { schemaVersion: 1, mode: 'direct', compiler: 'musicbridge-pcm-copy-v1', masterVersionId: randomUUID(), layoutVersionId: randomUUID(), contentHash: 'c'.repeat(64), plannedTimelineHash: 'd'.repeat(64), format: settings.format, side: 'A', capacityFrames: 100, totalFrames: 1, segments: [{ kind: 'source', trackId: randomUUID(), input: { sha256: 'e'.repeat(64), size: 48, sampleRate: 96000, channelCount: 2, bitsPerSample: 16, totalFrames: 1 }, startFrame: 0, endFrame: 1 }], formalReady: false };
const proposal: c.ExecutionProposal = { draftId: randomUUID(), masterVersionId: recipe.masterVersionId, layoutVersionId: recipe.layoutVersionId, mode: 'direct', destinationId: randomUUID(), sessionRevision: 1, settings, recipes: [recipe, { ...recipe, side: 'B', totalFrames: 0, segments: [] }], destinationLabel: '合成执行目录', audioBytesToWrite: 48, referencedAudioBytes: 0, proposalFingerprint: 'f'.repeat(64), retentionPolicy: 'unresolved-no-automatic-deletion', formalReady: false };

test('Profile/Session 拒绝私有字段、假认证、重复设备和越界预卷；null 明确覆盖', () => {
  assert.equal(c.isRecordingProfileVersion(profile), true); assert.equal(c.isResolvedRecordingSettings(settings), true); assert.equal(settings.effective.noiseReduction, null);
  for (const patch of [{ certified: true }, { defaults: { ...profile.content.defaults, preRollMs: 600001 } }, { signalChain: [...profile.content.signalChain, ...profile.content.signalChain] }, { executionFormat: { ...profile.content.executionFormat, devicePath: '/private/device' } }, { compatibility: { ...profile.content.compatibility, cassetteTypes: [['II']] } }]) assert.equal(c.isRecordingProfileContent({ ...profile.content, ...patch }), false);
  assert.equal(c.isRecordingSessionOverrides({ preRollMs: 10 }), false);
  assert.equal(c.isResolvedRecordingSettings({ ...settings, effective: { ...settings.effective, noiseReduction: 'Off' } }), false);
  assert.equal(c.isResolvedRecordingSettings({ ...settings, format: { ...settings.format, outputProfileVersion: randomUUID() } }), false);
  assert.equal(c.isSaveRecordingProfileRequest({ commandId: randomUUID(), profileId: profile.profileId, content: profile.content, userConfirmed: true }), false);
  assert.equal(c.isRecordingProfileHistory({ profileId: profile.profileId, versions: [profile] }), true);
  assert.equal(c.isRecordingProfileHistory({ profileId: profile.profileId, versions: [{ ...profile, sequence: 2, parentVersionId: randomUUID() }] }), false);
});
test('执行提案绑定相同 M/L 内容与时间线，空 B 不生成 WAV，预卷不加入音频', () => {
  assert.equal(c.isExecutionProposal(proposal), true); assert.equal(c.executionAudioSize(recipe), 48); assert.equal(c.executionAudioSize(proposal.recipes[1]!), 0);
  for (const patch of [{ audioBytesToWrite: 92 }, { formalReady: true }, { retentionPolicy: 'delete-on-failure' }, { preparedVersionId: randomUUID() }, { settings: { ...settings, format: { ...settings.format, sampleRate: 44100 } } }, { recipes: [recipe, { ...proposal.recipes[1], contentHash: 'a'.repeat(64) }] }, { recipes: [recipe, { ...proposal.recipes[1], plannedTimelineHash: 'a'.repeat(64) }] }]) assert.equal(c.isExecutionProposal({ ...proposal, ...patch }), false);
});
test('执行任务/资产区分发布事实、当前校验和正式就绪', () => {
  const job: c.ExecutionJob = { id: randomUUID(), draftId: proposal.draftId, layoutVersionId: recipe.layoutVersionId, destinationId: proposal.destinationId, profileVersionId: profile.id, mode: 'direct', state: 'running', completedSides: 0, totalSides: 1 };
  assert.equal(c.isExecutionJob(job), true);
  for (const patch of [{ state: 'completed' }, { state: 'completed', assetId: randomUUID() }, { state: 'failed', failure: 'private error stack' }, { mode: ['direct'] }, { state: ['running'] }, { assetId: randomUUID() }]) assert.equal(c.isExecutionJob({ ...job, ...patch }), false);
  const audio: c.ExecutionAudioReceipt = { recipe, recipeHash: 'a'.repeat(64), origin: 'compiled', audio: { sha256: 'b'.repeat(64), pcmSha256: 'c'.repeat(64), size: 48, frameCount: 1, dataOffset: 44 }, formalReady: false };
  const asset: c.ExecutionAsset = { id: job.id, draftId: proposal.draftId, masterVersionId: recipe.masterVersionId, layoutVersionId: recipe.layoutVersionId, destinationId: proposal.destinationId, mode: 'direct', settings, recipes: proposal.recipes, audio: [audio], manifestHash: 'd'.repeat(64), createdAt: new Date().toISOString(), state: 'verified-at-publication', retentionPolicy: 'unresolved-no-automatic-deletion', formalReady: false };
  assert.equal(c.isExecutionAsset(asset), true); assert.equal(c.isExecutionAsset({ ...asset, audio: [] }), false);
  assert.equal(c.isExecutionAsset({ ...asset, audio: [audio, audio] }), false);
  const completed = { ...job, state: 'completed', completedSides: 1, assetId: asset.id };
  assert.equal(c.isExecutionHistory({ draftId: asset.draftId, assets: [asset], jobs: [completed] }), true);
  assert.equal(c.isExecutionHistory({ draftId: asset.draftId, assets: [], jobs: [completed] }), false);
  assert.equal(c.isExecutionAssetCheck({ assetId: asset.id, state: 'verified', checkedAt: asset.createdAt, formalReady: false }), true);
  assert.equal(c.isExecutionAssetCheck({ assetId: asset.id, state: 'unavailable', checkedAt: asset.createdAt, formalReady: false }), false);
  for (const reason of ['DESTINATION_INVALID', 'ASSET_INVALID']) {
    const check = { assetId: asset.id, state: 'unavailable', checkedAt: asset.createdAt, reason, formalReady: false };
    assert.equal(c.isExecutionAssetCheck(check), true);
    assert.equal(c.isExecutionAssetCheck({ ...check, reason: [reason] }), false);
  }
});

test('Profile/执行 IPC 仅传公开版本、命令和授权编号，拒绝路径、替换配方及假认证', () => {
  const request = (command: string, payload: unknown): boolean => c.validateIpcRequest({ version: 1, id: 'execution-contract', command, payload }).ok;
  const payloads: Record<string, unknown> = {
    'recordingProfiles.list': {}, 'recordingProfiles.history': { profileId: profile.profileId }, 'recordingProfiles.version': { versionId: profile.id },
    'recordingProfiles.save': { commandId: randomUUID(), content: profile.content, userConfirmed: true },
    'recordingProfiles.session': { draftId: proposal.draftId }, 'recordingProfiles.saveSession': { commandId: randomUUID(), draftId: proposal.draftId, expectedRevision: 0, profileVersionId: profile.id, overrides: {}, userConfirmed: true },
    'recordingExecution.list': { draftId: proposal.draftId }, 'recordingExecution.preview': { layoutVersionId: proposal.layoutVersionId, destinationId: proposal.destinationId, mode: 'direct', sessionRevision: 1, readId: randomUUID() },
    'recordingExecution.start': { layoutVersionId: proposal.layoutVersionId, destinationId: proposal.destinationId, mode: 'direct', sessionRevision: 1, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true },
    'recordingExecution.job': { id: randomUUID() }, 'recordingExecution.cancel': { commandId: randomUUID(), id: randomUUID() }, 'recordingExecution.cancelRead': { id: randomUUID() }, 'recordingExecution.verify': { assetId: randomUUID(), readId: randomUUID() },
  };
  for (const [command,payload] of Object.entries(payloads)) { assert.equal(request(command,payload), true, command); assert.equal(request(command,{ ...payload as object, absolutePath: '/private/music' }), false, command); }
  assert.equal(request('recordingExecution.start', { ...payloads['recordingExecution.start'] as object, recipes: proposal.recipes }), false);
  assert.equal(request('recordingProfiles.save', { ...payloads['recordingProfiles.save'] as object, certified: true }), false);
});

test('Profile/执行 IPC 响应仍做严格公共合同检查，不把空缺或私有状态返回 Renderer', () => {
  const response = (command: string, result: unknown): boolean => c.validateIpcResponseForCommand({ version: 1, id: 'execution-contract', ok: true, result }, command as c.IpcCommand).ok;
  for (const [command,result] of Object.entries({ 'recordingProfiles.list': { profiles: [profile] }, 'recordingProfiles.history': { profileId: profile.profileId, versions: [profile] }, 'recordingProfiles.version': profile, 'recordingProfiles.save': profile, 'recordingProfiles.session': { session: null }, 'recordingExecution.list': { draftId: proposal.draftId, assets: [], jobs: [] }, 'recordingExecution.preview': proposal, 'recordingExecution.job': { job: null }, 'recordingExecution.cancelRead': { cancelled: true }, 'recordingExecution.verify': { assetId: randomUUID(), state: 'verified', checkedAt: profile.createdAt, formalReady: false } })) {
    assert.equal(response(command,result), true, command); assert.equal(response(command,{ ...result, absolutePath: '/private/music' }), false, command);
  }
});
