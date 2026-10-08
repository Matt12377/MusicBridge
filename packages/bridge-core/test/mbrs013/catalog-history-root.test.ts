import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { LocalPlayRequest, MediaLayoutSpec } from '@music-bridge/contracts';
import * as dto from '@music-bridge/contracts';
import type { PreparedLocalSource } from '../../src/application/local-source-resolver.js';
import type { Logger } from '../../src/shared/logger.js';
import { relocationFixture, wholeHash, type RelocationFixture } from './relocation-fixture.js';

const fresh = <T>(file: string): Promise<T> => import(new URL(`../../dist/${file}.js`, import.meta.url).href) as Promise<T>;

/** 目标仅为受控Core权威；目录/Parser/FD/HTTP均为原真实实现，不证明真实Roon或听感。 */
async function gatewayFor(t: TestContext, f: RelocationFixture) {
  const [{ StreamGateway }, { StreamRegistry }, resolver] = await Promise.all([
    fresh<typeof import('../../src/stream/gateway.js')>('stream/gateway'),
    fresh<typeof import('../../src/stream/registry.js')>('stream/registry'),
    fresh<typeof import('../../src/application/local-source-resolver.js')>('application/local-source-resolver'),
  ]);
  const registry = new StreamRegistry(), events: unknown[] = []; let externalFetches = 0;
  const record = (event: string, fields?: unknown): void => { events.push({ event, fields }); };
  const logger: Logger = { debug: record, info: record, warn: record, error: record };
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry, logger,
    fetcher: async () => { externalFetches++; throw new Error('本域自有文件回归禁止外部请求。'); } });
  t.after(() => gateway.stop()); await gateway.start();
  const target = { core_id: 'mbrs013-owned-core', zone_id: 'mbrs013-owned-zone' };
  const request = (): LocalPlayRequest => ({ schema_version: '1.2', request_id: randomUUID(), route: 'roon_audio_input', source_kind: 'local_file',
    local_track_id: f.track.id, asset_id: f.track.assetId, expected_asset_revision: f.repository.localCatalog.asset(f.track.assetId).fileRevision,
    target, action: 'PLAY_NOW' });
  const authority = { captureCurrentTarget: () => ({ target, isCurrent: () => true }) };
  const descriptor = (previous?: PreparedLocalSource): PreparedLocalSource => {
    const value = resolver.prepareLocalSourceReadonly(request(), f.repository, authority, previous);
    assert.equal(value.status, 'prepared_descriptor'); assert.ok('facts' in value && value.facts.observation); return value as PreparedLocalSource;
  };
  let attempt = 0;
  async function register() {
    const value = descriptor(), registration = await registry.registerLocalSource(value, { ownerId: 'mbrs013-owned-controller', attempt: ++attempt, isCurrent: () => true }, 'flac');
    return { ...registration, descriptor: value, url: gateway.localStreamUrl(registration.token) };
  }
  return { registry, gateway, descriptor, register, events, externalFetches: () => externalFetches };
}

async function bindingsFor(t: TestContext, f: RelocationFixture) {
  const { createSourceEvidenceService } = await fresh<typeof import('../../src/recording/source-evidence.js')>('recording/source-evidence');
  const service = createSourceEvidenceService({ store: f.repository.sources, drafts: f.repository.drafts }); t.after(() => service.close());
  const draft = f.repository.drafts.append({ commandId: randomUUID(), fingerprint: wholeHash(Buffer.from('013真实非空历史源引用')),
    title: '013自有历史源引用', programType: 'compilation', metadata: [1, 2, 3].map(index => ({ title: `自有源引用 ${index}` })) });
  for (const trackId of draft.trackIds) {
    const job = service.start({ commandId: randomUUID(), draftId: draft.draftId, trackId, rootId: f.source.id, acquisition: 'userFileBind' }, path.join(f.media, 'Original.flac'));
    await service.idle(); assert.equal(service.job(job.id).job?.state, 'completed');
    const binding = f.repository.sources.linked(draft.draftId, trackId); assert.ok(binding);
    await service.confirm({ commandId: randomUUID(), id: binding.id, draftId: draft.draftId, trackId, userConfirmed: true });
  }
  const snapshot = draft.trackIds.map(trackId => structuredClone(f.repository.sources.linked(draft.draftId, trackId)!));
  assert.equal(snapshot.length, 3); assert.equal(new Set(snapshot.map(binding => binding.id)).size, 3);
  assert.ok(snapshot.every(binding => binding.evidence.sha256 === wholeHash(f.bytes) && binding.userConfirmed && !binding.invalidated));
  return { service, draft, snapshot };
}
function sourceHistory(filePath: string) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try { return db.prepare('SELECT * FROM source_ledger ORDER BY rowid').all().map(row => ({ ...row })); } finally { db.close(); }
}
async function scan(f: RelocationFixture, libraryRootId: string, expectedRootRevision: string) {
  const job = f.scanner.start({ commandId: randomUUID(), libraryRootId, expectedRootRevision }); await f.scanner.privateWait(job.jobId);
  assert.equal(f.scanner.get(job.jobId).phase, 'completed'); return job.jobId;
}

test('013真实新位置Resolver与Gateway送完整原音频，三个非空SourceBinding/旧Hash和发行版引用经冷重开保持', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t), bindings = await bindingsFor(t, f), beforeRows = sourceHistory(f.filePath);
  assert.ok(beforeRows.length >= 10);
  const edition = f.repository.localCatalog.createEdition({ commandId: randomUUID(), title: '013稳定逻辑曲目', edition: '自有引用回归' });
  const link = f.repository.localCatalog.linkEditionTrack({ commandId: randomUUID(), editionId: edition.id, trackId: f.track.id, disc: 1, trackNumber: 1, sequence: 1 });
  await f.enable(); const choice = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: f.destination });
  const ready = await f.ready({ kind: 'move', targets: [f.selection()], targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' });
  const g = await gatewayFor(t, f), old = await g.register();
  const response = await fetch(old.url); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  await g.registry.revokeLocal(old.token); assert.equal(old.lease.state, 'CLOSED'); assert.equal((await fetch(old.url)).status, 404);
  const done = await f.complete(ready); assert.equal(done.state, 'SOURCE_RETAINED');
  const current = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId); assert.deepEqual(current.tracks, f.original.tracks);
  assert.equal(current.asset.fileRevision, f.original.asset.fileRevision); assert.equal(BigInt(current.asset.locationRevision), BigInt(f.original.asset.locationRevision) + 1n);
  assert.deepEqual(f.repository.localCatalog.editionTracks(edition.id), [link]);
  assert.throws(() => g.descriptor(old.descriptor), error => error instanceof Error && 'code' in error && error.code === 'FACTS_CHANGED');
  const next = await g.register(); assert.notEqual(next.token, old.token); assert.equal(next.descriptor.facts.sourceRoot.path, f.destination);
  assert.equal(next.descriptor.facts.relative, 'Original.flac'); assert.equal(next.descriptor.facts.observation!.locationRevision, current.asset.locationRevision);
  const full = await fetch(next.url); assert.equal(full.status, 200); assert.equal(full.headers.get('content-length'), String(f.bytes.length));
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), f.bytes); assert.equal((await fetch(old.url)).status, 404);
  const afterRows = sourceHistory(f.filePath); for (const row of beforeRows) assert.deepEqual(afterRows.find(candidate => candidate.command_id === row.command_id), row);
  for (const binding of bindings.snapshot) assert.deepEqual(f.repository.sources.binding(binding.id), binding);
  assert.equal(g.externalFetches(), 0); const diagnostics = JSON.stringify(g.events);
  assert.equal(diagnostics.includes(next.token), false); assert.equal(diagnostics.includes(f.destination), false);
  await g.gateway.stop(); await bindings.service.close(); await f.close();
  const cold = f.modules.repository.createCollectionRepository({ filePath: f.filePath });
  try { assert.deepEqual(cold.localCatalog.privateRelocationSnapshot(f.track.assetId), current);
    assert.deepEqual(cold.localCatalog.editionTracks(edition.id), [link]);
    for (const binding of bindings.snapshot) assert.deepEqual(cold.sources.binding(binding.id), binding);
    const coldRows = sourceHistory(f.filePath); for (const row of beforeRows) assert.deepEqual(coldRows.find(candidate => candidate.command_id === row.command_id), row); }
  finally { cold.close(); }
});

test('013实际活动播放FD使既存READY执行延期，旧secret拒同名新文件且不强停原lease', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t); await f.enable();
  const ready = await f.ready({ kind: 'rename', target: f.selection(), newName: 'Deferred.flac', sourceDisposition: 'RETAIN' });
  const g = await gatewayFor(t, f), old = await g.register(), request = f.confirm(ready);
  const challenge = await f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request });
  await f.main('localRelocationMain.executeGranted', { datasetId: f.datasetId, confirm: request, grant: challenge.grant });
  const deferred = await f.waitPlan(ready.planId, plan => ['DEFERRED', 'FAILED', 'RECOVERY_REQUIRED'].includes(plan.state));
  assert.equal(deferred.state, 'DEFERRED', JSON.stringify(deferred.issues)); assert.equal(deferred.issues[0]?.code, 'LEASE_ACTIVE');
  assert.equal(old.lease.state, 'PREPARED'); assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), f.original);
  assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes); await assert.rejects(readFile(path.join(f.media, 'Deferred.flac')), { code: 'ENOENT' });
  const before = await fetch(old.url); assert.equal(before.status, 200); assert.deepEqual(Buffer.from(await before.arrayBuffer()), f.bytes);
  // 外部替换只在本测试拥有的文件上发生；旧能力不得凭相同名字转向新inode。
  await rename(path.join(f.media, 'Original.flac'), path.join(f.media, 'Original-held.flac'));
  const replacement = Buffer.alloc(f.bytes.length, 0x31); await writeFile(path.join(f.media, 'Original.flac'), replacement, { mode: 0o600, flag: 'wx' });
  const denied = await fetch(old.url); assert.ok([404, 409].includes(denied.status)); assert.equal(await denied.text(), '');
  await old.lease.close(); assert.equal(old.lease.state, 'CLOSED'); assert.deepEqual(old.lease.resourceSnapshot(), { activeRequests: 0, activeIo: 0, timer: 0 });
  assert.deepEqual(await readFile(path.join(f.media, 'Original-held.flac')), f.bytes); assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), replacement);
  assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), f.original); assert.equal(g.externalFetches(), 0);
  await g.gateway.stop(); assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 });
});

test('013保留源再次走原Scanner不重复登记，另一独立同字节副本仍取得独立Asset/Track而不猜合并', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t); await f.enable();
  const choice = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: f.destination });
  const ready = await f.ready({ kind: 'move', targets: [f.selection()], targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' }); await f.complete(ready);
  const moved = f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId);
  assert.ok(f.repository.localScan.privateRetainedSource(f.datasetId, f.root.id, f.source.id, f.root.revision, 'Original.flac'));
  await scan(f, f.root.id, f.root.revision); assert.equal(f.repository.localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 1);
  assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), moved);
  await copyFile(path.join(f.media, 'Original.flac'), path.join(f.media, 'Independent.flac'));
  await scan(f, f.root.id, f.root.revision); const tracks = f.repository.localCatalog.pageTracks({ offset: 0, limit: 200 }); assert.equal(tracks.total, 2);
  const independent = tracks.items.find(track => track.id !== f.track.id)!; assert.ok(independent); assert.notEqual(independent.assetId, f.track.assetId);
  const copy = f.repository.localCatalog.privateRelocationSnapshot(independent.assetId); assert.equal(copy.relative, 'Independent.flac'); assert.equal(copy.asset.sourceRootId, f.source.id);
  assert.deepEqual(await readFile(path.join(f.media, copy.relative)), f.bytes); assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), moved);
  await f.close(); const cold = f.modules.repository.createCollectionRepository({ filePath: f.filePath });
  try { assert.equal(cold.localCatalog.pageTracks({ offset: 0, limit: 200 }).total, 2); assert.deepEqual(cold.localCatalog.privateRelocationSnapshot(f.track.assetId), moved);
    assert.deepEqual(cold.localCatalog.privateRelocationSnapshot(independent.assetId), copy); } finally { cold.close(); }
});

test('013两个真实完整成员整库根重关联保全部ID/hash/修订，真实新路径HTTP和冷root-facts认证通过', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t, { trustedWholeHash: true });
  await copyFile(path.join(f.media, 'Original.flac'), path.join(f.media, 'Second.flac')); await scan(f, f.root.id, f.root.revision);
  const members = f.repository.localCatalog.privateRelocationRootMembers(f.root.id); assert.equal(members.length, 2);
  await copyFile(path.join(f.media, 'Original.flac'), path.join(f.destination, 'Original.flac'));
  await copyFile(path.join(f.media, 'Second.flac'), path.join(f.destination, 'Second.flac'));
  await copyFile(path.join(f.media, 'Original.lrc'), path.join(f.destination, 'Original.lrc'));
  await f.enable(); const choice = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: f.destination });
  const ready = await f.ready({ kind: 'root-reassociate', libraryRootId: f.root.id, expectedRootRevision: f.root.revision, targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' });
  assert.equal(ready.closure.operationCount, 2); const done = await f.complete(ready); assert.equal(done.state, 'SOURCE_RETAINED');
  const root = f.repository.localCatalog.root(f.root.id); assert.equal(root.id, f.root.id); assert.equal(root.revision, '2'); assert.notEqual(root.sourceRootId, f.source.id);
  const after = members.map(member => f.repository.localCatalog.privateRelocationSnapshot(member.asset.id));
  for (const [index, current] of after.entries()) { const previous = members[index]!; assert.equal(current.asset.id, previous.asset.id);
    assert.equal(current.asset.fileRevision, previous.asset.fileRevision); assert.equal(BigInt(current.asset.locationRevision), BigInt(previous.asset.locationRevision) + 1n);
    assert.equal(current.asset.libraryRootId, f.root.id); assert.equal(current.asset.rootRevision, root.revision); assert.deepEqual(current.tracks, previous.tracks);
    assert.equal(current.catalogSha256, previous.catalogSha256); assert.equal(current.relative, previous.relative);
    assert.deepEqual(await readFile(path.join(f.destination, current.relative)), f.bytes); assert.deepEqual(await readFile(path.join(f.media, current.relative)), f.bytes); }
  const facts = f.repository.localCatalog.privateRelocationRead(view => view.projection.events.filter(event => event.planId === done.planId && event.kind === 'root-facts'));
  assert.equal(facts.length, 1); const g = await gatewayFor(t, f), playable = await g.register(); assert.equal(playable.descriptor.facts.root.revision, root.revision);
  const response = await fetch(playable.url); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes); assert.equal(g.externalFetches(), 0);
  await g.gateway.stop(); await f.close(); const cold = f.modules.repository.createCollectionRepository({ filePath: f.filePath });
  try { assert.deepEqual(cold.localCatalog.root(f.root.id), root); for (const current of after) assert.deepEqual(cold.localCatalog.privateRelocationSnapshot(current.asset.id), current); }
  finally { cold.close(); }
});

test('013冷核在历史root-facts点拒绝遗漏成员和101成员，合法原journal与当前SQL不能掩盖部分整库登记', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t); await copyFile(path.join(f.media, 'Original.flac'), path.join(f.destination, 'Original.flac'));
  await copyFile(path.join(f.media, 'Original.lrc'), path.join(f.destination, 'Original.lrc')); await f.enable();
  const choice = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: f.destination });
  const ready = await f.ready({ kind: 'root-reassociate', libraryRootId: f.root.id, expectedRootRevision: f.root.revision, targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' });
  await f.complete(ready); await f.close();
  const valid = f.modules.repository.createCollectionRepository({ filePath: f.filePath });
  try { assert.equal(valid.localCatalog.root(f.root.id).revision, '2'); } finally { valid.close(); }
  const { verifyLocalCatalogDatabase } = await fresh<typeof import('../../src/collection/local-catalog-store.js')>('collection/local-catalog-store');
  for (const omitted of [1, 100]) {
    const file = path.join(f.directory, `owned-corrupt-partial-root-${omitted}.sqlite`); await copyFile(f.filePath, file);
    const db = new DatabaseSync(file);
    try {
      const rows = db.prepare('SELECT * FROM local_catalog_ledger ORDER BY rowid').all();
      const point = rows.findIndex(row => row.operation === 'LOCAL_RELOCATION_V1' && JSON.parse(String(row.request)).kind === 'root-facts'); assert.ok(point > 0);
      const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='local_catalog_ledger_no_delete'").get()!.sql; assert.equal(typeof trigger, 'string');
      const inserted: { command_id: string; fingerprint: string; operation: string; request: string; result: string; created_at: string }[] = [];
      for (let index = 0; index < omitted; index++) {
        const asset: dto.AudioAsset = { id: randomUUID(), libraryRootId: f.root.id, sourceRootId: f.source.id, rootRevision: f.root.revision,
          fileRevision: '1', locationRevision: '1', sampleFrames: null, timebaseHz: null };
        const track: dto.LocalTrack = { id: randomUUID(), assetId: asset.id, selectionRevision: '1', segment: null };
        const relative = `Historical-unmapped-${index}.flac`;
        const create = { commandId: randomUUID(), libraryRootId: f.root.id, expectedRootRevision: f.root.revision, relative, sha256: null, sampleFrames: null, timebaseHz: null };
        const select = { commandId: randomUUID(), assetId: asset.id, segment: null };
        assert.ok(dto.isAudioAsset(asset)); assert.ok(dto.isLocalTrack(track));
        for (const [operation, request, result] of [['register-asset', create, asset], ['create-track', select, track]] as const) {
          const fingerprint = createHash('sha256').update(dto.localRelocationCanonical([operation, request])).digest('hex');
          inserted.push({ command_id: request.commandId, fingerprint, operation, request: JSON.stringify(request), result: JSON.stringify(result), created_at: String(rows[point]!.created_at) });
        }
        db.prepare('INSERT INTO local_catalog_assets VALUES(?,?,?,?,?,?)').run(asset.id, f.root.id, f.source.id, relative, null, JSON.stringify(asset));
        db.prepare('INSERT INTO local_catalog_tracks VALUES(?,?,?)').run(track.id, asset.id, JSON.stringify(track));
      }
      // 仅损坏本测试自有副本：补入合法旧域创建回执，却故意让真实013 READY/根事实遗漏这些成员。
      // 恢复原immutable trigger全文；其它真实Parser/Scanner/根迁移journal、结果JSON和实体保持原样。
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DROP TRIGGER local_catalog_ledger_no_delete'); db.exec('DELETE FROM local_catalog_ledger');
        const all = [...rows.slice(0, point), ...inserted, ...rows.slice(point)], insert = db.prepare('INSERT INTO local_catalog_ledger VALUES(?,?,?,?,?,?)');
        for (const row of all) insert.run(row.command_id!, row.fingerprint!, row.operation!, row.request!, row.result!, row.created_at!);
        db.exec(String(trigger)); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok'); assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
      assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_assets WHERE root_id=?').get(f.root.id)!.n, omitted + 1);
      assert.throws(() => verifyLocalCatalogDatabase(db), /本地目录结构或历史损坏/u);
    } finally { db.close(); }
    const cold = f.modules.repository.createCollectionRepository({ filePath: file });
    try { assert.throws(() => cold.localCatalog.root(f.root.id), error => error instanceof Error && 'code' in error && error.code === 'INVENTORY_UNAVAILABLE'); }
    finally { cold.close(); }
    t.diagnostic(`历史点完整成员冷核负例保留：${file}`);
  }
  const unchanged = f.modules.repository.createCollectionRepository({ filePath: f.filePath });
  try { assert.equal(unchanged.localCatalog.privateRelocationRootMembers(f.root.id).length, 1); } finally { unchanged.close(); }
});

test('013冷目录直接拒绝完整READY和真实根事实但缺全成员实际位置事实，不借Scanner或终态失败掩盖', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t); await copyFile(path.join(f.media, 'Original.flac'), path.join(f.destination, 'Original.flac'));
  await copyFile(path.join(f.media, 'Original.lrc'), path.join(f.destination, 'Original.lrc')); await f.enable();
  const choice = await f.main('localRelocationMain.captureTarget', { datasetId: f.datasetId, commandId: randomUUID(), kind: 'directory', absolutePath: f.destination });
  const ready = await f.ready({ kind: 'root-reassociate', libraryRootId: f.root.id, expectedRootRevision: f.root.revision, targetChoiceId: choice.choiceId, sourceDisposition: 'RETAIN' });
  await f.complete(ready); const actualRoot = f.repository.localCatalog.root(f.root.id); await f.close();
  const { verifyLocalCatalogDatabase } = await fresh<typeof import('../../src/collection/local-catalog-store.js')>('collection/local-catalog-store');
  const valid = new DatabaseSync(f.filePath, { readOnly: true });
  try { assert.doesNotThrow(() => verifyLocalCatalogDatabase(valid)); } finally { valid.close(); }
  const file = path.join(f.directory, 'owned-corrupt-root-without-location-facts.sqlite'); await copyFile(f.filePath, file);
  const db = new DatabaseSync(file);
  try {
    const rows = db.prepare('SELECT rowid AS ledger_rowid,* FROM local_catalog_ledger ORDER BY rowid').all();
    const point = rows.findIndex(row => row.operation === 'LOCAL_RELOCATION_V1' && JSON.parse(String(row.request)).kind === 'root-facts'); assert.ok(point > 0);
    const actual = JSON.parse(String(rows[point]!.request)); assert.equal(actual.planId, ready.planId); assert.equal(actual.planHash, ready.planHash);
    assert.deepEqual(actual.beforeRoot, f.root); assert.deepEqual(actual.afterRoot, actualRoot);
    assert.ok(rows.slice(point + 1).some(row => row.operation === 'LOCAL_RELOCATION_V1' && JSON.parse(String(row.request)).kind === 'location-facts'));
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='local_catalog_ledger_no_delete'").get()!.sql;
    assert.equal(typeof trigger, 'string'); db.exec('BEGIN IMMEDIATE');
    try {
      // 自有副本只留真实历史至原root-facts；终态和Scanner冷核不参与这条直接目录负例。
      db.exec('DROP TRIGGER local_catalog_ledger_no_delete');
      db.prepare('DELETE FROM local_catalog_ledger WHERE rowid>?').run(rows[point]!.ledger_rowid!);
      db.prepare('UPDATE local_catalog_assets SET root_id=?,source_root_id=?,relative=?,sha256=?,data=? WHERE id=?')
        .run(f.original.asset.libraryRootId, f.original.asset.sourceRootId, f.original.relative, f.original.catalogSha256, JSON.stringify(f.original.asset), f.original.asset.id);
      db.exec(String(trigger)); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok'); assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT data FROM local_catalog_roots WHERE id=?').get(f.root.id)!.data)), actualRoot);
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT data FROM local_catalog_assets WHERE id=?').get(f.original.asset.id)!.data)), f.original.asset);
    assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?').get('trigger', 'local_catalog_ledger_no_delete')!.sql, trigger);
    assert.deepEqual(db.prepare('SELECT rowid AS ledger_rowid,* FROM local_catalog_ledger ORDER BY rowid').all(), rows.slice(0, point + 1));
    assert.throws(() => verifyLocalCatalogDatabase(db), /本地目录结构或历史损坏/u);
    t.diagnostic(`无全成员实际位置事实的直接冷核负例保留：${file}`);
  } finally { db.close(); }
  const unchanged = f.modules.repository.createCollectionRepository({ filePath: f.filePath });
  try { assert.deepEqual(unchanged.localCatalog.root(f.root.id), actualRoot); assert.equal(unchanged.localCatalog.privateRelocationRootMembers(f.root.id).length, 1); }
  finally { unchanged.close(); }
});

test('013真实非空母版Frozen保护拒绝既存READY与新预览，全部源历史和实际音频保留', { timeout: 180_000 }, async t => {
  const f = await relocationFixture(t), bindings = await bindingsFor(t, f);
  const [{ createMediaPlanningCoordinator }, { createMasterVersionsCoordinator }] = await Promise.all([
    fresh<typeof import('../../src/recording/media-coordinator.js')>('recording/media-coordinator'),
    fresh<typeof import('../../src/recording/versions-coordinator.js')>('recording/versions-coordinator'),
  ]);
  f.repository.receive({ commandId: randomUUID(), model: { brand: 'TDK', name: 'SA', edition: '013自有Frozen材料', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
    lengthMinutes: 60, quantities: { openedBlank: 3, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } });
  const media = createMediaPlanningCoordinator({ store: f.repository.media, drafts: f.repository.drafts, sources: bindings.service });
  const spec: MediaLayoutSpec = { format: 'cassette', splitAfter: 2, leadInMs: 1000, tailMs: 1000, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true } };
  const preview = await media.preview({ draftId: bindings.draft.draftId, spec, page: { offset: 0, limit: 20 } });
  const saved = await media.save({ commandId: randomUUID(), draftId: bindings.draft.draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec });
  const candidate = preview.candidates.items[0]!; assert.ok(candidate);
  const layout = await media.reserve({ commandId: randomUUID(), planId: saved.id, expectedRevision: saved.revision, skuId: candidate.skuId, packaging: 'opened', userConfirmed: true });
  const versions = createMasterVersionsCoordinator({ store: f.repository.versions, mediaStore: f.repository.media, media, drafts: f.repository.drafts,
    sourceStore: f.repository.sources, sources: bindings.service }); t.after(() => versions.close());
  await f.enable(); const ready = await f.ready({ kind: 'rename', target: f.selection(), newName: 'Frozen-denied.flac', sourceDisposition: 'RETAIN' });
  const proposal = await versions.preview({ planId: layout.id, sampleRate: 96000 });
  const job = await versions.freeze({ commandId: randomUUID(), planId: layout.id, sampleRate: 96000, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true });
  await versions.idle(); assert.equal(versions.job(job.id).job?.state, 'completed');
  const history = f.repository.versions.list(bindings.draft.draftId); assert.equal(history.masters.length, 1); assert.equal(history.masters[0]!.sourceEvidence.length, 3);
  const request = f.confirm(ready), challenge = await f.main('localRelocationMain.challenge', { datasetId: f.datasetId, confirm: request });
  await f.main('localRelocationMain.executeGranted', { datasetId: f.datasetId, confirm: request, grant: challenge.grant });
  const rejected = await f.waitPlan(ready.planId, plan => ['FAILED', 'DEFERRED', 'RECOVERY_REQUIRED'].includes(plan.state));
  assert.equal(rejected.state, 'FAILED', JSON.stringify(rejected.issues)); assert.equal(rejected.issues[0]?.code, 'FROZEN_REFERENCE');
  const accepted = await f.api.preview({ datasetId: f.datasetId, commandId: randomUUID(), intent: { kind: 'rename', target: f.selection(), newName: 'Frozen-again.flac', sourceDisposition: 'RETAIN' } });
  const blocked = await f.waitPlan(accepted.planId!, plan => plan.state !== 'PREVIEWING'); assert.equal(blocked.state, 'BLOCKED'); assert.equal(blocked.issues[0]?.code, 'FROZEN_REFERENCE');
  assert.equal(f.repository.localCatalog.privateRelocationRead(view => view.projection.latestAssets.size), 0);
  assert.deepEqual(f.repository.localCatalog.privateRelocationSnapshot(f.track.assetId), f.original); assert.deepEqual(f.repository.versions.list(bindings.draft.draftId), history);
  for (const binding of bindings.snapshot) assert.deepEqual(f.repository.sources.binding(binding.id), binding);
  assert.deepEqual(await readFile(path.join(f.media, 'Original.flac')), f.bytes); await assert.rejects(readFile(path.join(f.media, 'Frozen-denied.flac')), { code: 'ENOENT' });
  assert.deepEqual(f.modules.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 }); await versions.close(); await bindings.service.close();
});
