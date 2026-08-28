import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as c from '../src/index.js';

const root = { id: randomUUID(), label: '合成归档目标', state: 'selected' };
const selection = { assetId: randomUUID(), rootId: root.id, sourcePolicy: 'reference-dependent' };
const audio = { role: 'execution-audio', name: 'A.execution.wav', media: 'audio', sha256: 'a'.repeat(64), size: 100 };
const manifest = { role: 'manifest', name: 'ExecutionManifest.json', media: 'json', sha256: 'b'.repeat(64), size: 50 };
const snapshot = { role: 'metadata', name: 'ArchiveSnapshot.json', media: 'json', sha256: 'c'.repeat(64), size: 75 };
const proposal = { ...selection, draftId: randomUUID(), masterVersionId: randomUUID(), layoutVersionId: randomUUID(), mode: 'direct', files: [audio, manifest, snapshot], objectCount: 3, copyBytes: 225, requiredBytes: 225 + 8 * 1024 * 1024, availableBytes: 30 * 1024 * 1024, proposalFingerprint: 'd'.repeat(64), retentionPolicy: 'unresolved-no-automatic-deletion', formalReady: false };
const operation = { ...selection, id: randomUUID(), draftId: proposal.draftId, masterVersionId: proposal.masterVersionId, layoutVersionId: proposal.layoutVersionId, phase: 'REQUESTED', active: true, objectCount: 3, copyBytes: 225, createdAt: '2026-08-28T00:00:00.000Z', formalReady: false };

test('归档 Root 与请求严格隔离原生路径，初始化和写入必须明确确认', () => {
  assert.equal(typeof c.isArchiveRootView, 'function', '归档公共合同尚未接入');
  assert.equal(c.isArchiveRootView(root), true);
  for (const extra of [{ absolutePath: '/private/archive' }, { owner: 'private-owner' }, { state: 'recording-ready' }]) assert.equal(c.isArchiveRootView({ ...root, ...extra }), false);
  const initialize = { commandId: randomUUID(), id: root.id, userConfirmed: true };
  assert.equal(c.isInitializeArchiveRequest(initialize), true); assert.equal(c.isInitializeArchiveRequest({ ...initialize, userConfirmed: false }), false);
  const preview = { ...selection, readId: randomUUID() }, start = { ...selection, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true };
  assert.equal(c.isPreviewArchiveRequest(preview), true); assert.equal(c.isStartArchiveRequest(start), true);
  for (const extra of [{ files: [audio] }, { sourcePolicy: undefined }, { absolutePath: '/private/source' }, { formalReady: true }]) { assert.equal(c.isPreviewArchiveRequest({ ...preview, ...extra }), false); assert.equal(c.isStartArchiveRequest({ ...start, ...extra }), false); }
  assert.equal(c.isStartArchiveRequest({ ...start, userConfirmed: false }), false);
});

test('归档提案计入唯一字节、谱系和完整对象角色，不承诺正式录音或永久保留', () => {
  assert.equal(c.isArchiveProposal(proposal), true);
  for (const change of [{ copyBytes: 224 }, { objectCount: 4 }, { requiredBytes: 225 }, { formalReady: true }, { retentionPolicy: 'permanent' }, { files: [audio] }, { preparedVersionId: randomUUID() }]) assert.equal(c.isArchiveProposal({ ...proposal, ...change }), false);
  assert.equal(c.isArchiveProposal({ ...proposal, files: [{ ...audio, relative: 'private-source/file.wav' }, manifest, snapshot] }), false);
  assert.equal(c.isArchiveProposal({ ...proposal, files: [{ ...audio, name: '../file.wav' }, manifest, snapshot] }), false);
  const prepared = { ...proposal, mode: 'prepared-reference', preparedVersionId: randomUUID(), files: [audio, { ...audio, role: 'raw-render', name: 'A.original.wav' }, manifest, { ...manifest, name: 'PreparedManifest.json' }, snapshot] };
  assert.equal(c.isArchiveProposal(prepared), true);
  assert.equal(c.isArchiveProposal({ ...prepared, files: [audio, manifest, snapshot] }), false);
  const copied = { ...proposal, sourcePolicy: 'preserve-exact-sources', files: [...proposal.files, { ...audio, role: 'exact-source', name: '001.wav' }] };
  assert.equal(c.isArchiveProposal(copied), true); assert.equal(c.isArchiveProposal({ ...copied, sourcePolicy: 'reference-dependent' }), false);
  assert.equal(c.isArchiveProposal({ ...copied, files: [...proposal.files, { ...audio, role: 'exact-source', name: '001.wav', size: 99 }] }), false);
});

test('归档历史与当前核验分开，拒绝伪完成、混入别的草稿和无界错误', () => {
  assert.equal(c.isArchiveOperationView(operation), true); assert.equal(c.isArchiveHistory({ draftId: proposal.draftId, operations: [operation] }), true);
  assert.equal(c.isArchiveOperationView({ ...operation, phase: 'CompletedRecording' }), false);
  assert.equal(c.isArchiveOperationView({ ...operation, issue: '/private/path ECONNRESET' }), false);
  assert.equal(c.isArchiveHistory({ draftId: randomUUID(), operations: [operation] }), false);
  const checked = { id: operation.id, state: 'verified', checkedAt: operation.createdAt, formalReady: false };
  assert.equal(c.isArchiveCheck(checked), true); assert.equal(c.isArchiveCheck({ ...checked, state: 'unavailable' }), false);
  assert.equal(c.isArchiveCheck({ ...checked, state: 'unavailable', reason: 'ARCHIVE_RECOVERY_REQUIRED' }), true);
  assert.equal(c.isArchiveCheck({ ...checked, formalReady: true }), false);
});

test('归档 IPC 接线、公开响应与内部授权返回均严格校验', () => {
  const request = (command: string, payload: unknown) => c.validateIpcRequest({ version: 1, id: 'archive-contract', command, payload }).ok;
  const commands = { 'recordingArchive.roots': {}, 'recordingArchive.initialize': { commandId: randomUUID(), id: root.id, userConfirmed: true }, 'recordingArchive.revokeRoot': { commandId: randomUUID(), id: root.id }, 'recordingArchive.preview': { ...selection, readId: randomUUID() }, 'recordingArchive.start': { ...selection, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true }, 'recordingArchive.list': { draftId: proposal.draftId }, 'recordingArchive.operation': { id: operation.id }, 'recordingArchive.cancel': { commandId: randomUUID(), id: operation.id }, 'recordingArchive.resume': { commandId: randomUUID(), id: operation.id }, 'recordingArchive.verify': { id: operation.id, readId: randomUUID() }, 'recordingArchive.cancelRead': { id: randomUUID() } };
  for (const [command, payload] of Object.entries(commands)) { assert.equal(request(command, payload), true, command); assert.equal(request(command, { ...payload, absolutePath: '/private/archive' }), false, command); }
  const response = (command: string, result: unknown) => c.validateIpcResponseForCommand({ version: 1, id: 'archive-contract', ok: true, result }, command as c.IpcCommand).ok;
  for (const [command, result] of Object.entries({ 'recordingArchive.roots': { roots: [root] }, 'recordingArchive.initialize': { ...root, state: 'ready' }, 'recordingArchive.preview': proposal, 'recordingArchive.start': operation, 'recordingArchive.list': { draftId: proposal.draftId, operations: [operation] }, 'recordingArchive.operation': { operation: null }, 'recordingArchive.cancelRead': { cancelled: true } })) { assert.equal(response(command, result), true, command); assert.equal(response(command, { ...result, absolutePath: '/private/archive' }), false, command); }
});

test('原生归档授权只通过内部响应通道返回，不暴露私有路径或 owner', () => {
  const response = { version: 1, id: 'archive-internal', ok: true, result: root };
  assert.equal(c.validateIpcInternalResponseForCommand(response, 'recordingArchive.authorize').ok, true);
  assert.equal(c.validateIpcResponseForCommand(response, 'recordingArchive.authorize').ok, false);
  assert.equal(c.validateIpcInternalResponseForCommand({ ...response, result: { ...root, owner: 'private' } }, 'recordingArchive.authorize').ok, false);
  assert.equal(c.validateIpcInternalResponseForCommand({ ...response, result: { root: null } }, 'recordingArchive.authorizationReceipt').ok, true);
});
