import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import * as dto from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import type { ScanPreparedBatch, ScanPreparedItem } from '../../src/collection/local-scan-store.js';
import { createMobileLocalAlbumProjection } from '../../src/mobile/local-album-projection.js';
import { authorizeSourceDirectory, sourceRootAvailability } from '../../src/recording/source-files.js';

export const DISPLAY_EXPECTED: dto.FileAudioParameters = { container: 'FLAC', codec: 'flac', lossless: true,
  sampleRateHz: 48000, channels: 2, bitsPerSample: 24, durationMs: 1000, evidence: 'bounded-parser-reported' };

/** 只在本测试创建的空来源和SQLite写入合成扫描事实，不读取源音频或运行中曲库。 */
export async function displayMemoFixture(t: TestContext, width = 12,
  factories = { createCollectionRepository, createLocalAlbumOwnerService, createMobileLocalAlbumProjection }) {
  const temporary = process.env.TMPDIR;
  assert.ok(temporary && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(temporary, 'scan-display-page-memo-'));
  const media = path.join(directory, '合成空来源'); await mkdir(media);
  const repository = factories.createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
  let owner: ReturnType<typeof createLocalAlbumOwnerService> | undefined;
  t.after(async () => { owner?.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const source = repository.sources.authorize(randomUUID(), await authorizeSourceDirectory(media));
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const datasetId = randomUUID(), parserVersion = 'music-metadata-11.15.0/mbrs003-v1';
  const started = repository.localScan.start({ commandId: randomUUID(), datasetId, libraryRootId: root.id,
    expectedRootRevision: root.revision, parserVersion }).job;
  const job = repository.localScan.resume({ commandId: randomUUID(), jobId: started.jobId, expectedRevision: started.jobRevision });
  const items: ScanPreparedItem[] = Array.from({ length: width }, (_, index) => ({
    relative: `合成目录/${String(index).padStart(3, '0')}.flac`, signature: `合成签名-${index}`, parserVersion,
    outcome: 'accepted', fields: { title: `合成曲目${index}`, artist: '合成艺人', album: '合成页', track: String(index + 1) },
    failureCode: null, reused: false, readFacts: { technical: { container: 'FLAC', codec: 'flac', lossless: true,
      sampleRateHz: 48000, channels: 2, bitsPerSample: 24, durationSeconds: 1, evidence: 'bounded-parser-reported' },
    coverEvidence: [], readEvidence: { bytesRead: 44, readCalls: 1, maxReadBytes: 44, allocationBytes: 44,
      elapsedMs: 1, wholeAudioHash: false, wholeAudioDecode: false } },
  }));
  const batch: ScanPreparedBatch = { batchId: randomUUID(), jobId: job.jobId, expectedJobRevision: job.jobRevision,
    checkpointBefore: job.checkpointRef, items, frontier: [], completed: true };
  repository.localScan.privatePrepareBatch({ commandId: randomUUID(), jobId: job.jobId, batch });
  repository.localScan.privateCommitBatch({ commandId: randomUUID(), jobId: job.jobId, batchId: batch.batchId, expectedRevision: job.jobRevision });
  const records = items.map(item => {
    const state = repository.localScan.privateCurrentFileState(root.id, item.relative);
    assert.ok(state?.value.assetId && state.value.trackId);
    return { track: repository.localCatalog.track(state.value.trackId), asset: repository.localCatalog.asset(state.value.assetId) };
  });
  let db!: DatabaseSync; repository.localCatalog.privateRead(value => { db = value; });
  owner = factories.createLocalAlbumOwnerService({ repository, datasetId, assertCurrent() {},
    readRootViews: async () => Promise.all(repository.localCatalog.roots().map(async current => ({ root: current,
      label: '合成来源', availability: await sourceRootAvailability(repository.sources.root(current.sourceRootId)) }))),
    async readArtwork(): Promise<never> { throw new Error('参数测试不打开图片或音频。'); } });
  const projection = factories.createMobileLocalAlbumProjection({ collection: repository, datasetId,
    ownerEpoch: randomUUID(), assertCurrent() {}, localAlbums: owner });
  const legacy = repository.localScan as typeof repository.localScan & {
    privateWithDisplayFileParametersRead?: <T>(read: () => T) => T;
  };
  // RED沿旧行为执行，失败必须来自重复解析，不能以缺少新API冒充行为证据。
  const page = <T>(read: () => T): T => legacy.privateWithDisplayFileParametersRead
    ? legacy.privateWithDisplayFileParametersRead(read) : read();
  const read = (index = 0) => repository.localScan.privateDisplayFileParameters(records[index]!.track.id, records[index]!.asset, 'mobile-catalog');
  return { directory, repository, source, root, db, batch, records, projection, page, read };
}

export function displayBatchParses(t: TestContext, batchId: string, capture = true) {
  const parse = JSON.parse; let count = 0; const parsed: unknown[] = [];
  const mock = t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    const target = args[0].includes(batchId) && /"items"\s*:/u.test(args[0]);
    if (target) count++;
    const result = Reflect.apply(parse, JSON, args);
    if (target && capture) parsed.push(result); return result;
  });
  return { count: () => count, parsed, reset() { count = 0; parsed.length = 0; }, restore() { mock.mock.restore(); } };
}

/** 保留每次真实SQL执行，只在自有库的只读返回值上注入受控故障。 */
export function displayReads(t: TestContext, db: DatabaseSync, alter?: (raw: string, stage: 'batch' | 'origin') => string) {
  const prepare = DatabaseSync.prototype.prepare;
  const counts = { batch: 0, origin: 0, ledger: 0 };
  let beforeBatch: (() => void) | undefined, missingLedger = false;
  const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (this !== db) return statement;
    if (sql === "SELECT request FROM local_scan_batches WHERE id=? AND phase='committed'") {
      const get = statement.get;
      t.mock.method(statement, 'get', (...args: unknown[]) => {
        const row = Reflect.apply(get, statement, args); counts.batch++;
        const callback = beforeBatch; beforeBatch = undefined; callback?.();
        return row && alter ? { ...row, request: alter(String(row.request), 'batch') } : row;
      });
    } else if (sql.includes("JOIN json_each(b.result,'$.files') f")) {
      for (const method of ['iterate', 'get'] as const) {
        const original = statement[method];
        if (method === 'get') t.mock.method(statement, method, (...args: unknown[]) => {
          counts.origin++; const row = Reflect.apply(original, statement, args) as Record<string, unknown> | undefined;
          return row && alter ? { ...row, request: alter(String(row.request), 'origin') } : row;
        });
        else t.mock.method(statement, method, function* (...args: unknown[]) {
          counts.origin++;
          for (const row of Reflect.apply(original, statement, args) as Iterable<Record<string, unknown>>) {
            yield alter ? { ...row, request: alter(String(row.request), 'origin') } : row;
          }
        });
      }
    } else if (sql === 'SELECT result FROM local_catalog_ledger WHERE command_id IN (?,?)') {
      const all = statement.all;
      t.mock.method(statement, 'all', (...args: unknown[]) => {
        counts.ledger++; const rows = Reflect.apply(all, statement, args); return missingLedger ? [] : rows;
      });
    }
    return statement;
  });
  return { counts, beforeBatch(work: () => void) { beforeBatch = work; }, missingLedger(value: boolean) { missingLedger = value; },
    restore() { mock.mock.restore(); } };
}
