import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createSourceCandidateService } from '../src/recording/source-candidates.js';
import { createSourceEvidenceService } from '../src/recording/source-evidence.js';
import { probeReadonlySource, readonlySourceCandidateMetadata, readonlySourceDirectoryEntries, sourceRootAvailability, SourceFileError } from '../src/recording/source-files.js';

function wav(seconds = 1): Buffer {
  const dataSize = 44100 * 4 * seconds, bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(176400, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}
async function fixture(t: test.TestContext, probe?: typeof probeReadonlySource) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-candidates-'));
  const source = path.join(directory, 'private-source'), file = path.join(source, 'a.wav'), filePath = path.join(directory, 'collection.sqlite');
  await mkdir(source); await writeFile(file, wav());
  const repository = createCollectionRepository({ filePath });
  const sources = createSourceEvidenceService({ store: repository.sources, drafts: repository.drafts, ...(probe ? { probe } : {}) });
  const draft = repository.drafts.append({ commandId: randomUUID(), fingerprint: 'a'.repeat(64), title: '合成母版', programType: 'compilation', metadata: [{ title: '合成曲目' }] });
  const root = await sources.authorize(randomUUID(), source);
  const candidates = createSourceCandidateService({ store: repository.sources, drafts: repository.drafts, sources });
  const scanRequest = () => ({ commandId: randomUUID(), rootId: root.id, draftId: draft.draftId, trackId: draft.trackIds[0]!, expectedDraftRevision: 1 });
  t.after(async () => { await candidates.close(); await sources.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, source, file, filePath, repository, sources, draft, root, candidates, scanRequest };
}
function select(f: Awaited<ReturnType<typeof fixture>>, scanId: string, candidateId: string) {
  return { commandId: randomUUID(), rootId: f.root.id, draftId: f.draft.draftId, trackId: f.draft.trackIds[0]!, acquisition: 'userFileBind' as const,
    candidate: { scanId, candidateId, expectedDraftRevision: 1 } };
}

test('R08：扫描只给清洗后的相对线索，跳过链接，选择后才完整校验且不自动确认', async t => {
  const f = await fixture(t), nested = path.join(f.source, 'sub'); await mkdir(nested);
  await writeFile(path.join(nested, 'b.flac'), '并非有效音频');
  await writeFile(path.join(f.source, 'x\ny.wav'), '合成候选一'); await writeFile(path.join(f.source, 'x_y.wav'), '合成候选二');
  await symlink(f.file, path.join(f.source, 'symlink.wav'));
  await symlink(nested, path.join(f.source, 'linked-directory'));
  const outside = path.join(f.directory, 'outside.wav'); await writeFile(outside, '根外硬链接'); await link(outside, path.join(f.source, 'hard.wav'));
  const request = f.scanRequest(); await f.candidates.start(request); await f.candidates.idle();
  const scan = (await f.candidates.get(request.commandId)).scan!;
  assert.equal(scan.state, 'completed'); assert.ok(scan.skippedSymlinks >= 2); assert.ok(scan.skippedUnreadable >= 1);
  assert.deepEqual(scan.candidates.map(item => item.relativeLabel), [...scan.candidates.map(item => item.relativeLabel)].sort());
  assert.equal(scan.candidates.filter(item => item.fileName === 'x_y.wav').length, 2);
  assert.equal(new Set(scan.candidates.map(item => item.id)).size, scan.candidates.length);
  assert.ok(!JSON.stringify(scan).includes(f.source)); assert.ok(!JSON.stringify(scan).includes(f.directory));
  assert.ok(!scan.candidates.some(item => item.fileName === 'hard.wav' || item.fileName === 'symlink.wav'));
  assert.equal((await f.sources.snapshot(f.draft.draftId)).sourceLockEligible, false);
  const candidate = scan.candidates.find(item => item.fileName === 'a.wav')!;
  const selection = select(f, scan.id, candidate.id);
  assert.equal((await f.candidates.select(selection)).state, 'running'); await f.sources.idle();
  assert.equal(f.sources.job(selection.commandId).job?.state, 'completed');
  const binding = (await f.sources.snapshot(f.draft.draftId)).tracks[0]!.binding!;
  assert.equal(binding.verification, 'fileHashVerified'); assert.equal(binding.userConfirmed, false); assert.equal(binding.sourceLockEligible, false);
  assert.deepEqual(await readFile(f.file), wav());
  assert.throws(() => f.sources.start(selection, f.file), /候选文件必须/u);
});

test('R08：扫描后文件改动先拒绝；probe 中签名改变不能落绑定', async t => {
  let changed = false;
  const f = await fixture(t, async (root, relative, signal) => {
    if (!changed) { changed = true; await writeFile(path.join(root.path, relative), wav(2)); }
    return probeReadonlySource(root, relative, signal);
  });
  const first = f.scanRequest(); await f.candidates.start(first); await f.candidates.idle();
  const item = (await f.candidates.get(first.commandId)).scan!.candidates[0]!;
  await writeFile(f.file, wav(3));
  const stale = select(f, first.commandId, item.id);
  await assert.rejects(f.candidates.select(stale), /候选文件.*已变化/u);
  assert.equal(f.sources.job(stale.commandId).job, null);
  const second = f.scanRequest(); await f.candidates.start(second); await f.candidates.idle();
  const fresh = (await f.candidates.get(second.commandId)).scan!.candidates[0]!;
  const selection = select(f, second.commandId, fresh.id);
  assert.equal((await f.candidates.select(selection)).state, 'running'); await f.sources.idle();
  assert.equal(f.sources.job(selection.commandId).job?.failure, 'CANDIDATE_CHANGED');
  assert.equal((await f.sources.snapshot(f.draft.draftId)).tracks[0]!.binding, undefined);
});

test('R08：草稿改版与源目录身份改变使候选失效；取消不可再次选择', async t => {
  const f = await fixture(t);
  const cancelled = f.scanRequest(); await f.candidates.start(cancelled);
  assert.equal(f.candidates.cancel({ commandId: randomUUID(), id: cancelled.commandId }).state, 'cancelled'); await f.candidates.idle();
  assert.equal((await f.candidates.get(cancelled.commandId)).scan?.state, 'cancelled');
  const revision = f.scanRequest(); await f.candidates.start(revision); await f.candidates.idle();
  const item = (await f.candidates.get(revision.commandId)).scan!.candidates[0]!;
  f.repository.drafts.update({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, title: '已修改草稿', programType: 'compilation', trackIds: f.draft.trackIds }, 'b'.repeat(64));
  assert.equal((await f.candidates.get(revision.commandId)).scan?.stopReason, 'DRAFT_CHANGED');
  await assert.rejects(f.candidates.select(select(f, revision.commandId, item.id)), /候选扫描已失效/u);
  const current = { ...f.scanRequest(), expectedDraftRevision: 2 };
  await f.candidates.start(current); await f.candidates.idle();
  const currentItem = (await f.candidates.get(current.commandId)).scan!.candidates[0]!;
  await rename(f.source, `${f.source}-moved`);
  assert.equal((await f.candidates.get(current.commandId)).scan?.stopReason, 'ROOT_CHANGED');
  await assert.rejects(f.candidates.select({ ...select(f, current.commandId, currentItem.id), candidate: { scanId: current.commandId, candidateId: currentItem.id, expectedDraftRevision: 2 } }), /候选扫描已失效/u);
});

test('R08：结果上限明确截断且部分候选可选；重启后仅持久 SourceJob 原请求可取回', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(path.join(f.source, `sample-${String(index).padStart(3, '0')}.wav`), '仅候选元数据')));
  const request = f.scanRequest(); await f.candidates.start(request); await f.candidates.idle();
  const scan = (await f.candidates.get(request.commandId)).scan!;
  assert.equal(scan.state, 'truncated'); assert.equal(scan.stopReason, 'RESULT_LIMIT'); assert.equal(scan.candidates.length, 200);
  const item = scan.candidates.find(candidate => candidate.fileName === 'a.wav')!;
  const selection = select(f, scan.id, item.id); await f.candidates.select(selection); await f.sources.idle();
  const reopened = createCollectionRepository({ filePath: f.filePath });
  const sources = createSourceEvidenceService({ store: reopened.sources, drafts: reopened.drafts });
  const candidates = createSourceCandidateService({ store: reopened.sources, drafts: reopened.drafts, sources });
  try {
    assert.equal((await candidates.get(scan.id)).scan, null);
    assert.equal((await candidates.select(selection)).id, selection.commandId);
    await assert.rejects(candidates.select({ ...selection, acquisition: 'roonDesktopExport' }), /操作编号/u);
  } finally { await candidates.close(); await sources.close(); reopened.close(); }
});

test('R08：先遇深度上限后仍不得让兄弟目录突破 200 个候选', async t => {
  const f = await fixture(t);
  let nested = path.join(f.source, '00-depth');
  await mkdir(nested);
  for (let depth = 1; depth <= 6; depth++) { nested = path.join(nested, `level-${depth}`); await mkdir(nested); }
  for (let group = 1; group <= 3; group++) {
    const directory = path.join(f.source, `${group}0-many`);
    await mkdir(directory);
    await Promise.all(Array.from({ length: 70 }, (_, index) => writeFile(path.join(directory, `candidate-${String(index).padStart(3, '0')}.wav`), '只读候选')));
  }
  const request = f.scanRequest(); await f.candidates.start(request); await f.candidates.idle();
  const scan = (await f.candidates.get(request.commandId)).scan!;
  assert.equal(scan.state, 'truncated');
  assert.equal(scan.candidates.length, 200);
  assert.equal(scan.stopReason, 'RESULT_LIMIT');
  assert.ok(scan.scannedEntries <= 3000);
});

test('R08：深度软截断后目录读取失败须以 IO_ERROR 停止，不继续遍历兄弟目录', async t => {
  const f = await fixture(t);
  let nested = path.join(f.source, '00-depth');
  await mkdir(nested);
  for (let depth = 1; depth <= 6; depth++) { nested = path.join(nested, `level-${depth}`); await mkdir(nested); }
  await mkdir(path.join(f.source, '10-unreadable'));
  const later = path.join(f.source, '20-later'); await mkdir(later); await writeFile(path.join(later, 'later.wav'), '不应访问');
  const service = createSourceCandidateService({ store: f.repository.sources, drafts: f.repository.drafts, sources: f.sources,
    list: async (root, relative, remaining, signal, deadline) => relative === '10-unreadable'
      ? Promise.reject(new SourceFileError('IO_ERROR'))
      : readonlySourceDirectoryEntries(root, relative, remaining, signal, deadline) });
  try {
    const request = f.scanRequest(); await service.start(request); await service.idle();
    const scan = (await service.get(request.commandId)).scan!;
    assert.equal(scan.state, 'truncated');
    assert.equal(scan.stopReason, 'IO_ERROR');
    assert.equal(scan.skippedUnreadable, 1);
    assert.equal(scan.candidates.length, 0);
  } finally { await service.close(); }
});

test('R08：已完成扫描取消后不可再选；同编号异请求不能借会话重放', async t => {
  const f = await fixture(t), request = f.scanRequest(); await f.candidates.start(request); await f.candidates.idle();
  const item = (await f.candidates.get(request.commandId)).scan!.candidates[0]!;
  assert.equal(f.candidates.cancel({ commandId: randomUUID(), id: request.commandId }).state, 'cancelled');
  await assert.rejects(f.candidates.select(select(f, request.commandId, item.id)), /候选扫描已失效/u);
  await assert.rejects(f.candidates.start({ ...request, expectedDraftRevision: 2 }), /同一操作编号/u);
});

test('R08：start 同编号单飞；close 或撤权发生在授权检查期间不能迟到建会话', async t => {
  const f = await fixture(t);
  for (const outcome of ['single-flight', 'close', 'revoke'] as const) {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve }), atCheck = new Promise<void>(resolve => { entered = resolve });
    let calls = 0;
    const service = createSourceCandidateService({ store: f.repository.sources, drafts: f.repository.drafts, sources: f.sources,
      checkRoot: async root => { if (++calls === 1) { entered(); await gate; } return sourceRootAvailability(root); } });
    const request = f.scanRequest(), first = service.start(request); await atCheck;
    if (outcome === 'single-flight') {
      const same = service.start(request);
      await assert.rejects(service.start({ ...request, expectedDraftRevision: 2 }), /同一操作编号/u);
      release(); const [a, b] = await Promise.all([first, same]); assert.equal(a.id, b.id); await service.idle();
    } else {
      const closing = outcome === 'close' ? service.close() : f.sources.revoke({ commandId: randomUUID(), id: f.root.id });
      release(); await assert.rejects(first); await closing;
      assert.equal((await service.get(request.commandId)).scan, null);
    }
    await service.close();
    if (outcome === 'revoke') break;
  }
});

test('R08：select 读取候选元数据期间取消，迟到回包不得建立 SourceJob', async t => {
  const f = await fixture(t);
  let wait = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve }), atInspect = new Promise<void>(resolve => { entered = resolve });
  const service = createSourceCandidateService({ store: f.repository.sources, drafts: f.repository.drafts, sources: f.sources,
    inspect: async (root, relative) => { if (wait) { entered(); await gate; } return readonlySourceCandidateMetadata(root, relative); } });
  try {
    const request = f.scanRequest(); await service.start(request); await service.idle();
    const item = (await service.get(request.commandId)).scan!.candidates[0]!;
    wait = true; const selection = select(f, request.commandId, item.id), choosing = service.select(selection); await atInspect;
    assert.equal(service.cancel({ commandId: randomUUID(), id: request.commandId }).state, 'cancelled');
    release(); await assert.rejects(choosing, /候选扫描已失效/u);
    assert.equal(f.sources.job(selection.commandId).job, null);
  } finally { await service.close(); }
});

test('R08：扫描后父目录被替换，即使文件名相同也不可选择旧候选', async t => {
  const f = await fixture(t), nested = path.join(f.source, 'nested'); await mkdir(nested);
  await writeFile(path.join(nested, 'same.wav'), wav());
  const request = f.scanRequest(); await f.candidates.start(request); await f.candidates.idle();
  const item = (await f.candidates.get(request.commandId)).scan!.candidates.find(candidate => candidate.relativeLabel === 'nested/same.wav')!;
  await rename(nested, `${nested}-old`); await mkdir(nested); await writeFile(path.join(nested, 'same.wav'), wav());
  await assert.rejects(f.candidates.select(select(f, request.commandId, item.id)), /候选文件或其目录已变化/u);
});

test('R08：会话 TTL 到期后 get 不复活，旧编号不能重新扫描或选择', async t => {
  const f = await fixture(t); let offset = 0;
  const service = createSourceCandidateService({ store: f.repository.sources, drafts: f.repository.drafts, sources: f.sources, now: () => Date.now() + offset });
  try {
    const request = f.scanRequest(); await service.start(request); await service.idle();
    const item = (await service.get(request.commandId)).scan!.candidates[0]!;
    offset = 11 * 60_000;
    assert.equal((await service.get(request.commandId)).scan, null);
    await assert.rejects(service.start(request), /已过期/u);
    await assert.rejects(service.select(select(f, request.commandId, item.id)), /候选扫描已失效/u);
  } finally { await service.close(); }
});

test('R08：目录枚举只读取给定预算并在取消/超时时停止', async t => {
  const f = await fixture(t), root = f.repository.sources.root(f.root.id);
  await Promise.all(Array.from({ length: 5 }, (_, index) => writeFile(path.join(f.source, `extra-${index}.txt`), '合成目录项')));
  const signal = new AbortController();
  const listing = await readonlySourceDirectoryEntries(root, '', 3, signal.signal, Date.now() + 5000);
  assert.equal(listing.entries.length, 3); assert.equal(listing.truncated, true);
  signal.abort();
  await assert.rejects(readonlySourceDirectoryEntries(root, '', 3, signal.signal, Date.now() + 5000), error => error instanceof SourceFileError && error.code === 'CANCELLED');
  await assert.rejects(readonlySourceDirectoryEntries(root, '', 3, new AbortController().signal, Date.now() - 1), error => error instanceof SourceFileError && error.code === 'LIMIT_EXCEEDED');
});
