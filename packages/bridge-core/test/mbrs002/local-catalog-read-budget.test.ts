import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isAlbumEditionTrack, isAudioAsset, isLibraryRoot, isLocalTrack, isLocalMetadataObservation, isLocalCatalogReceipt, isLocalCatalogCommandResult, type AlbumEditionTrack, type LocalMetadataObservation, type LocalMetadata } from '@music-bridge/contracts';
import { CollectionError, createCollectionRepository } from '../../src/collection/repository.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

const READ_LIMIT = 200, SENTINEL_LIMIT = 201, LARGE_CONTROL = 501;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (operation: string, body: unknown): string => createHash('sha256').update(canonical([operation, body])).digest('hex');

/** 每case独占合成目录，只有真实Repository/API事务与receipt；不创建媒体文件或改版本。 */
async function fixture(t: test.TestContext) {
  const storage = buildStoragePolicy(), temporary = storage.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-local-read-budget-')); storage.check(directory, { mustExist: true });
  assert.equal(typeof process.getuid, 'function');
  const owner = await lstat(directory); assert.equal(owner.uid, process.getuid!()); assert.equal(owner.mode & 0o777, 0o700); assert.equal(await realpath(directory), directory);
  const file = path.join(directory, 'private-catalog.sqlite'); let repository = createCollectionRepository({ filePath: file });
  t.after(() => { repository.close(); return rm(directory, { recursive: true, force: true }); });
  const sourcePath = path.join(directory, '合成许可'); await mkdir(sourcePath);
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(sourcePath));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' }); assert.ok(isLibraryRoot(root));
  const asset = repository.localCatalog.registerAsset({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision, relative: '无媒体/合成.flac', sha256: null, sampleFrames: null, timebaseHz: null }); assert.ok(isAudioAsset(asset));
  const track = repository.localCatalog.createTrack({ commandId: randomUUID(), assetId: asset.id, segment: null }); assert.ok(isLocalTrack(track));
  const info = await lstat(file); assert.equal(info.uid, process.getuid!()); assert.equal(info.mode & 0o777, 0o600); assert.equal(info.nlink, 1); assert.equal(await realpath(file), file);
  return {
    file, track,
    get catalog() { return repository.localCatalog; },
    /** 只在本case的私有库上独立核合法事实，然后真实冷开；完整审计不落在读预算窗口内。 */
    coldLegal(table: 'local_catalog_edition_tracks' | 'local_catalog_observations', count: number, expectedLedger: number) {
      repository.close();
      const db = new DatabaseSync(file, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true });
      try {
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 34);
        assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n, count);
        assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_ledger').get()?.n, expectedLedger);
      } finally { db.close(); }
      repository = createCollectionRepository({ filePath: file });
      assert.equal(repository.localCatalog.pageTracks({ offset: 0, limit: 1 }).total, 1);
      assert.deepEqual(repository.localCatalog.track(track.id), track);
    },
  };
}
interface ReadSample { method: 'get' | 'all' | 'iterate'; rows: number }
/** spy只计实际返回/迭代，不查看SQL文本、不重写结果、不在spy中制造拒绝。 */
function observeRead<T>(operation: () => T) {
  const prepare = DatabaseSync.prototype.prepare, samples: ReadSample[] = [];
  let value: T | undefined, failure: unknown;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    return new Proxy(statement, { get(target, property) {
      const method: unknown = Reflect.get(target, property, target);
      if (property === 'get' || property === 'all') return (...bindings: unknown[]) => {
        const result: unknown = Reflect.apply(method as (...args: unknown[]) => unknown, target, bindings);
        samples.push({ method: property, rows: property === 'all' ? (result as unknown[]).length : result === undefined ? 0 : 1 }); return result;
      };
      if (property === 'iterate') return (...bindings: unknown[]) => {
        const iterator = Reflect.apply(method as (...args: unknown[]) => Iterable<Record<string, unknown>>, target, bindings);
        return (function*() { let rows = 0; try { for (const row of iterator) { rows++; yield row; } } finally { samples.push({ method: 'iterate', rows }); } })();
      };
      return typeof method === 'function' ? method.bind(target) : method;
    } });
  };
  try { value = operation(); } catch (error) { failure = error; }
  finally { DatabaseSync.prototype.prepare = prepare; }
  return { value, failure, samples, collectionRows: samples.filter(sample => sample.method !== 'get').reduce((total, sample) => total + sample.rows, 0), maxStatementRows: Math.max(0, ...samples.map(sample => sample.rows)) };
}
function assertFiniteRefusal(sample: ReturnType<typeof observeRead>, stage: number) {
  assert.ok(sample.failure instanceof CollectionError && sample.failure.code === 'INVENTORY_UNAVAILABLE', `目标：${stage}条合法记录应通过原公开不可用码有限拒绝，不能返回全量或静默截断`);
  assert.equal(sample.value, undefined);
  assert.ok(sample.collectionRows > 0 && sample.collectionRows <= SENTINEL_LIMIT, `目标：实际集合读仅消费201 sentinel；${stage}条库实际消费${sample.collectionRows}条`);
  assert.ok(sample.maxStatementRows <= SENTINEL_LIMIT);
}
function assertReceipt(f: Awaited<ReturnType<typeof fixture>>, operation: 'link-edition-track' | 'observe-metadata', body: { commandId: string }, result: unknown) {
  const receipt = f.catalog.receipt(body.commandId); assert.ok(isLocalCatalogReceipt(receipt));
  assert.equal(receipt.operation, operation); assert.equal(receipt.fingerprint, fingerprint(operation, body)); assert.deepEqual(receipt.result, result);
}

test('MBRS002 read-budget editionTracks：200真实关系读成功，201及501有限拒绝且最多物化201 sentinel', { timeout: 120_000 }, async t => {
  const f = await fixture(t), edition = f.catalog.createEdition({ commandId: randomUUID(), title: '合成关系预算', edition: '' }), relations: AlbumEditionTrack[] = [];
  const append = () => {
    const body = { commandId: randomUUID(), editionId: edition.id, trackId: f.track.id, disc: 1, trackNumber: relations.length + 1, sequence: relations.length + 1 };
    const result = f.catalog.linkEditionTrack(body); assert.ok(isAlbumEditionTrack(result)); assertReceipt(f, 'link-edition-track', body, result); relations.push(result);
  };
  while (relations.length < READ_LIMIT) append();
  const positive = f.catalog.editionTracks(edition.id); assert.deepEqual(positive, relations); assert.equal(positive.length, READ_LIMIT); assert.equal(isLocalCatalogCommandResult('localCatalog.editionTracks', positive), true);
  append(); assert.equal(relations.length, SENTINEL_LIMIT);
  const at201 = observeRead(() => f.catalog.editionTracks(edition.id)); const guard201 = isLocalCatalogCommandResult('localCatalog.editionTracks', relations);
  while (relations.length < LARGE_CONTROL) append(); assert.equal(new Set(relations.map(row => row.id)).size, LARGE_CONTROL);
  f.coldLegal('local_catalog_edition_tracks', LARGE_CONTROL, LARGE_CONTROL + 4);
  const at501 = observeRead(() => f.catalog.editionTracks(edition.id));
  t.diagnostic(`合法关系${relations.length}；201阶段实际集合读${at201.collectionRows}，501阶段${at501.collectionRows}，sentinel预算${SENTINEL_LIMIT}`);
  assertFiniteRefusal(at201, SENTINEL_LIMIT); assertFiniteRefusal(at501, LARGE_CONTROL);
  assert.equal(guard201, false, '公开数组result guard必须拒201，不能将超限数组送到父线程');
});

test('MBRS002 read-budget observations：200真实raw观察读成功，201及501有限拒绝且最多物化201 sentinel', { timeout: 120_000 }, async t => {
  const f = await fixture(t), observations: LocalMetadataObservation[] = [];
  const append = () => {
    const body = { commandId: randomUUID(), trackId: f.track.id, source: 'synthetic' as const, parserVersion: 'read-budget-1', fields: { title: `合成观察${observations.length + 1}` } };
    const result = f.catalog.observeMetadata(body); assert.ok(isLocalMetadataObservation(result)); assertReceipt(f, 'observe-metadata', body, result); observations.push(result);
  };
  while (observations.length < READ_LIMIT) append();
  const positive = f.catalog.observations(f.track.id); assert.deepEqual(positive, observations); assert.equal(positive.length, READ_LIMIT); assert.equal(isLocalCatalogCommandResult('localCatalog.observations', positive), true);
  append(); assert.equal(observations.length, SENTINEL_LIMIT);
  const at201 = observeRead(() => f.catalog.observations(f.track.id)); const guard201 = isLocalCatalogCommandResult('localCatalog.observations', observations);
  while (observations.length < LARGE_CONTROL) append(); assert.equal(new Set(observations.map(row => row.id)).size, LARGE_CONTROL);
  f.coldLegal('local_catalog_observations', LARGE_CONTROL, LARGE_CONTROL + 3);
  const at501 = observeRead(() => f.catalog.observations(f.track.id));
  t.diagnostic(`合法raw观察${observations.length}；201阶段实际集合读${at201.collectionRows}，501阶段${at501.collectionRows}，sentinel预算${SENTINEL_LIMIT}`);
  assertFiniteRefusal(at201, SENTINEL_LIMIT); assertFiniteRefusal(at501, LARGE_CONTROL);
  assert.equal(guard201, false, '公开数组result guard必须拒201，不能将超限数组送到父线程');
});

test('MBRS002 read-budget metadata：200内最新raw加人工覆盖保持，201及501历史有限拒绝且最多物化201 sentinel', { timeout: 120_000 }, async t => {
  const f = await fixture(t), observations: LocalMetadataObservation[] = [], expectedRaw: LocalMetadata = {};
  const append = () => {
    const n = observations.length + 1, fields: LocalMetadata = { title: `原始标题${n}`, ...(n % 2 ? { artist: `合成艺人${n}` } : { album: `合成专辑${n}` }) };
    const body = { commandId: randomUUID(), trackId: f.track.id, source: 'synthetic' as const, parserVersion: 'read-budget-1', fields };
    const result = f.catalog.observeMetadata(body); assert.ok(isLocalMetadataObservation(result)); assertReceipt(f, 'observe-metadata', body, result); observations.push(result); Object.assign(expectedRaw, fields);
  };
  while (observations.length < READ_LIMIT) append();
  const overrideBody = { commandId: randomUUID(), trackId: f.track.id, expectedRevision: null, fields: { title: '人工标题', year: '2026' } }, override = f.catalog.overrideMetadata(overrideBody);
  const overrideReceipt = f.catalog.receipt(overrideBody.commandId); assert.ok(isLocalCatalogReceipt(overrideReceipt)); assert.deepEqual(overrideReceipt.result, override); assert.equal(overrideReceipt.fingerprint, fingerprint('override-metadata', overrideBody));
  const expected = { raw: { ...expectedRaw }, override, effective: { ...expectedRaw, ...override.fields } };
  assert.equal(expected.raw.title, '原始标题200'); assert.equal(expected.raw.artist, '合成艺人199'); assert.equal(expected.raw.album, '合成专辑200');
  const positive = f.catalog.metadata(f.track.id); assert.deepEqual(positive, expected); assert.equal(isLocalCatalogCommandResult('localCatalog.metadata', positive), true); assert.equal(positive.effective.title, '人工标题');
  append(); assert.equal(observations.length, SENTINEL_LIMIT);
  const at201 = observeRead(() => f.catalog.metadata(f.track.id));
  while (observations.length < LARGE_CONTROL) append(); assert.equal(new Set(observations.map(row => row.id)).size, LARGE_CONTROL);
  f.coldLegal('local_catalog_observations', LARGE_CONTROL, LARGE_CONTROL + 4);
  const at501 = observeRead(() => f.catalog.metadata(f.track.id));
  t.diagnostic(`合法metadata历史${observations.length}；201阶段实际集合读${at201.collectionRows}，501阶段${at501.collectionRows}，sentinel预算${SENTINEL_LIMIT}`);
  assertFiniteRefusal(at201, SENTINEL_LIMIT); assertFiniteRefusal(at501, LARGE_CONTROL);
  assert.deepEqual(f.catalog.receipt(overrideBody.commandId)?.result, override, '拒绝读取不改人工覆盖或原回执');
});
