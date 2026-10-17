import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mobileCatalogResponseSnapshot, type MobileAlbum, type MobileTrack } from '@music-bridge/contracts';
import type { MobilePlaybackPreparedSource } from '../../src/mobile/source-types.js';
import type { MobileOwnerSourceResult } from '../../src/mobile/source-protocol.js';
import type { MobileOwnerCatalogSnapshot, MobileOwnerPrivateFailure } from '../../src/mobile/types.js';
import { directoryFixture } from './mobile-directory-fixture.js';

type Fixture = Awaited<ReturnType<typeof directoryFixture>>;
type SourceResult = MobileOwnerSourceResult | MobileOwnerPrivateFailure;

function snapshot(value: MobileOwnerCatalogSnapshot | MobileOwnerPrivateFailure): MobileOwnerCatalogSnapshot {
  assert.ok(!('kind' in value), '真实扫描目录必须可读，不能以 BUSY 或空页替代目录事实。');
  return value;
}
function album(value: MobileAlbum | MobileTrack): MobileAlbum {
  const checked = mobileCatalogResponseSnapshot('album', value);
  assert.ok(checked.ok, '只消费生产合同认可的实际专辑回包。');
  return checked.value;
}
function track(value: MobileAlbum | MobileTrack): MobileTrack {
  const checked = mobileCatalogResponseSnapshot('track', value);
  assert.ok(checked.ok, '只消费生产合同认可的实际曲目回包。');
  return checked.value;
}
function selection(value: MobileTrack) {
  return { resourceId: randomUUID(), trackId: value.id, versionId: value.versionId, contentRevision: value.contentRevision };
}
function failure(value: SourceResult, status: number, code: string): void {
  assert.equal(value.kind, 'mobile-error'); assert.ok(value.kind === 'mobile-error');
  assert.equal(value.status, status); assert.equal(value.code, code); assert.equal(value.outcome, null);
  assert.deepEqual(Reflect.ownKeys(value).sort(), ['code', 'kind', 'outcome', 'retryable', 'status']);
}
function ack(value: SourceResult, operation: 'release' | 'close-read', handle: string, readId: string | null = null): void {
  assert.deepEqual(value, { kind: 'mobile-source-ack', operation, handle, readId, quiet: true });
}
function readBytes(value: SourceResult, handle: string, readId: string, start: number): Uint8Array {
  assert.equal(value.kind, 'mobile-source-read'); assert.ok(value.kind === 'mobile-source-read');
  assert.equal(value.handle, handle); assert.equal(value.readId, readId); assert.equal(value.start, start);
  assert.equal(Object.getPrototypeOf(value.bytes), Uint8Array.prototype);
  return value.bytes;
}

/** 仅围住已完成扫描与目录查询之后的原 prepare；所有真实 open 均原样委派。 */
async function withoutSourceOpen(t: TestContext, run: () => Promise<void>): Promise<void> {
  const nativeOpen = promises.open, nativeOpenSync = fs.openSync;
  let opens = 0, syncOpens = 0;
  let restoreOpen: (() => void) | undefined, restoreOpenSync: (() => void) | undefined;
  const errors: unknown[] = [];
  try {
    const opened = t.mock.method(promises, 'open', (...args: Parameters<typeof promises.open>) => {
      opens++; return Reflect.apply(nativeOpen, promises, args) as ReturnType<typeof promises.open>;
    });
    restoreOpen = () => opened.mock.restore();
    const openedSync = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      syncOpens++; return Reflect.apply(nativeOpenSync, fs, args) as ReturnType<typeof fs.openSync>;
    });
    restoreOpenSync = () => openedSync.mock.restore();
    syncBuiltinESMExports();
    await run();
  } catch (error) { errors.push(error); }
  finally {
    for (const restore of [restoreOpenSync, restoreOpen, syncBuiltinESMExports]) {
      if (restore) try { restore(); } catch (error) { errors.push(error); }
    }
    try { assert.deepEqual({ opens, syncOpens }, { opens: 0, syncOpens: 0 }, '身份或版本拒绝必须发生在取得源 FD 之前。'); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, '源拒绝及文件观察清理未完全成立。', { cause: errors[0] });
}

async function withPrepared(f: Fixture, value: MobileTrack, use: (source: MobilePlaybackPreparedSource) => Promise<void>): Promise<void> {
  const source = await f.prepareFromTrack(value), errors: unknown[] = [];
  try { await use(source); } catch (error) { errors.push(error); }
  try { ack(await f.sourceDispatch({ operation: 'release', handle: source.handle }), 'release', source.handle); }
  catch (error) { errors.push(error); }
  try { f.assertQuiet(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, '原字节断言或原资源 quiet 释放未完全成立。', { cause: errors[0] });
}

async function completeAndRange(f: Fixture, source: MobilePlaybackPreparedSource, original: Buffer): Promise<void> {
  assert.equal(source.contentType, 'audio/wav'); assert.equal(source.size, original.length); assert.ok(original.length > 32);
  assert.deepEqual(source.actualAudio, source.sourceAudio);
  assert.equal(source.processing.mode, 'direct'); assert.equal(source.processing.fromPreparedCache, false);
  const readId = randomUUID(), chunks: Uint8Array[] = [];
  for (let offset = 0; offset < original.length;) {
    const bytes = readBytes(await f.sourceDispatch({ operation: 'read', handle: source.handle, readId, start: offset, maxBytes: 64 * 1024 }), source.handle, readId, offset);
    assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024); assert.ok(offset + bytes.length <= original.length);
    chunks.push(bytes); offset += bytes.length;
  }
  assert.deepEqual(Buffer.concat(chunks), original, '完整读取必须是原扫描 WAV 的全部原始字节。');
  assert.equal(readBytes(await f.sourceDispatch({ operation: 'read', handle: source.handle, readId, start: original.length, maxBytes: 64 * 1024 }), source.handle, readId, original.length).length, 0);
  ack(await f.sourceDispatch({ operation: 'close-read', handle: source.handle, readId }), 'close-read', source.handle, readId);
  for (const start of [7, original.length - 17]) {
    const rangeId = randomUUID();
    const bytes = readBytes(await f.sourceDispatch({ operation: 'read', handle: source.handle, readId: rangeId, start, maxBytes: 13 }), source.handle, rangeId, start);
    assert.deepEqual(bytes, new Uint8Array(original.subarray(start, start + 13)), '独立 Range 必须匹配相同原文件的准确区间。');
    ack(await f.sourceDispatch({ operation: 'close-read', handle: source.handle, readId: rangeId }), 'close-read', source.handle, rangeId);
  }
}

test('MBM扫描目录衔接：目录与全局列表同一opaque曲目可准备并完整及Range读取原字节', { concurrency: false }, async t => {
  const f = await directoryFixture(t);
  const albums = snapshot(await f.catalogDispatch({ operation: 'listAlbums' }));
  const global = snapshot(await f.catalogDispatch({ operation: 'listTracks' }));
  assert.equal(albums.total, 3); assert.equal(albums.items.length, 3); assert.equal(global.total, 5); assert.equal(global.items.length, 5);
  assert.equal(albums.libraryRevision, global.libraryRevision);
  const group = album(albums.items[0]!);
  const members = snapshot(await f.catalogDispatch({ operation: 'listTracks', albumId: group.id }));
  assert.equal(members.libraryRevision, global.libraryRevision); assert.equal(members.total, group.trackCount); assert.ok(members.items.length > 0);
  const member = track(members.items[0]!); assert.equal(member.albumId, group.id); assert.equal(member.availability, 'available');
  const fromGlobal = global.items.map(track).find(value => value.id === member.id);
  assert.ok(fromGlobal, '目录成员的原 opaque ID 必须同时存在于全局列表。'); assert.deepEqual(fromGlobal, member);
  const original = f.originals.values().next().value; assert.ok(original);
  assert.equal(f.originals.size, 5);
  for (const bytes of f.originals.values()) assert.deepEqual(bytes, original, '本夹具五份自有 WAV 的源字节相同，不通过拆解 opaque ID 反推源路径。');
  for (const listed of [member, fromGlobal]) await withPrepared(f, listed, source => completeAndRange(f, source, original));
  f.assertQuiet(); f.assertReadonly(); await f.assertOriginals();
});

test('MBM扫描目录衔接：另一工作库真实返回的身份与版本均不得取得源FD', { concurrency: false }, async t => {
  const local = await directoryFixture(t), foreign = await directoryFixture(t);
  assert.notEqual(local.datasetId, foreign.datasetId);
  const localPage = snapshot(await local.catalogDispatch({ operation: 'listTracks' }));
  const foreignPage = snapshot(await foreign.catalogDispatch({ operation: 'listTracks' }));
  assert.equal(localPage.total, 5); assert.equal(foreignPage.total, 5);
  const selected = track(localPage.items[0]!), other = track(foreignPage.items[0]!);
  assert.notEqual(selected.id, other.id); assert.notEqual(selected.versionId, other.versionId); assert.notEqual(selected.contentRevision, other.contentRevision);
  await withoutSourceOpen(t, async () => {
    failure(await local.sourceDispatch({ operation: 'prepare', selection: selection(other) }), 404, 'INVALID_REQUEST');
    local.assertQuiet(); foreign.assertQuiet();
    failure(await local.sourceDispatch({ operation: 'prepare', selection: { ...selection(selected), versionId: other.versionId, contentRevision: other.contentRevision } }), 409, 'SOURCE_CHANGED');
    local.assertQuiet(); foreign.assertQuiet();
  });
  local.assertReadonly(); foreign.assertReadonly(); await local.assertOriginals(); await foreign.assertOriginals();
});

test('MBM扫描目录衔接：真实资产修订推进后旧列表内容版本拒绝且原源与资源保持quiet', { concurrency: false }, async t => {
  const f = await directoryFixture(t), page = snapshot(await f.catalogDispatch({ operation: 'listTracks' }));
  assert.equal(page.total, 5); const previous = track(page.items[0]!);
  const assets = new Set(f.tracks.map(value => value.assetId)); assert.equal(assets.size, 5);
  // 全部五个真实扫描资产各推进一次修订；无需解析公开身份来反推内部 track/asset。
  for (const assetId of assets) {
    const before = f.repository.localCatalog.asset(assetId), locator = f.repository.localCatalog.privateAssetLocator(assetId);
    const original = f.originals.get(locator.relative); assert.ok(original);
    const after = f.repository.localCatalog.replaceAsset({ commandId: randomUUID(), assetId,
      libraryRootId: f.root.id, expectedRootRevision: f.root.revision, expectedFileRevision: before.fileRevision,
      expectedLocationRevision: before.locationRevision, relative: locator.relative,
      sha256: createHash('sha256').update(original).digest('hex'), sampleFrames: before.sampleFrames, timebaseHz: before.timebaseHz });
    assert.equal(after.id, before.id); assert.notEqual(after.fileRevision, before.fileRevision);
  }
  const afterMutation = f.readonlyStamp();
  await withoutSourceOpen(t, async () => {
    failure(await f.sourceDispatch({ operation: 'prepare', selection: selection(previous) }), 409, 'SOURCE_CHANGED');
    f.assertQuiet();
  });
  f.assertReadonly(afterMutation); await f.assertOriginals();
});


test('MBM扫描目录衔接：真实曲目与另一实际组身份错配时拒绝准备且零源FD', { concurrency: false }, async t => {
  const f = await directoryFixture(t);
  const identities = await import(new URL('../../dist/mobile/local-album-identity.js', import.meta.url).href) as typeof import('../../src/mobile/local-album-identity.js');
  const groups = snapshot(await f.catalogDispatch({ operation: 'listAlbums' }));
  assert.equal(groups.total, 3); assert.equal(groups.items.length, 3);
  const firstGroup = album(groups.items[0]!), secondGroup = album(groups.items[1]!);
  assert.notEqual(firstGroup.id, secondGroup.id);
  const firstPage = snapshot(await f.catalogDispatch({ operation: 'listTracks', albumId: firstGroup.id }));
  const secondPage = snapshot(await f.catalogDispatch({ operation: 'listTracks', albumId: secondGroup.id }));
  const first = track(firstPage.items[0]!), second = track(secondPage.items[0]!);
  assert.equal(first.albumId, firstGroup.id); assert.equal(second.albumId, secondGroup.id);
  assert.equal(first.availability, 'available'); assert.equal(second.availability, 'available');
  const original = f.originals.values().next().value; assert.ok(original);
  // 两个正常身份均先经原生产源prepare和实际FD读取，攻击不能因正常源本已不可用而假通过。
  for (const member of [first, second]) await withPrepared(f, member, async source => {
    const readId = randomUUID(), start = 7;
    assert.deepEqual(readBytes(await f.sourceDispatch({ operation: 'read', handle: source.handle, readId, start, maxBytes: 13 }), source.handle, readId, start),
      new Uint8Array(original.subarray(start, start + 13)));
    ack(await f.sourceDispatch({ operation: 'close-read', handle: source.handle, readId }), 'close-read', source.handle, readId);
  });
  const firstIdentity = identities.parseMobileTrackId(first.id, f.datasetId), secondIdentity = identities.parseMobileTrackId(second.id, f.datasetId);
  assert.ok(firstIdentity && firstIdentity.kind === 'canonical'); assert.ok(secondIdentity && secondIdentity.kind === 'canonical');
  assert.notEqual(firstIdentity.trackId, secondIdentity.trackId); assert.notEqual(firstIdentity.groupHash, secondIdentity.groupHash);
  // 只为攻击输入消费原生产解析器与编码器；不复制其前缀、散列规则或正常身份构造。
  const mismatched = identities.mobileTrackId(f.datasetId, firstIdentity.trackId, secondIdentity.groupHash);
  assert.notEqual(mismatched, first.id); assert.notEqual(mismatched, second.id);
  await withoutSourceOpen(t, async () => {
    failure(await f.sourceDispatch({ operation: 'prepare', selection: { ...selection(first), trackId: mismatched } }), 404, 'INVALID_REQUEST');
    f.assertQuiet();
  });
  f.assertReadonly(); await f.assertOriginals();
});

test('MBM扫描目录衔接：真实来源撤权守住原FD静止门并拒绝旧版本及已准备资源后续读取', { concurrency: false }, async t => {
  const f = await directoryFixture(t), page = snapshot(await f.catalogDispatch({ operation: 'listTracks' }));
  assert.equal(page.total, 5); const selected = track(page.items[0]!); assert.equal(selected.availability, 'available');
  const original = f.originals.values().next().value; assert.ok(original);
  await withPrepared(f, selected, async source => {
    const readId = randomUUID(), firstBytes = 19;
    assert.deepEqual(readBytes(await f.sourceDispatch({ operation: 'read', handle: source.handle, readId, start: 0, maxBytes: firstBytes }), source.handle, readId, 0),
      new Uint8Array(original.subarray(0, firstBytes)), '撤权前必须已经通过原准备与真实FD读取。');
    const revoke = { commandId: randomUUID(), id: f.source.id };
    // 原事实作者不能在FD仍持有fence时提交撤权；首尝试撤票并完成ROLLBACK，随后复用同一命令。
    assert.throws(() => f.repository.sources.revoke(revoke), error => {
      assert.ok(error instanceof f.modules.fence.LocalFactsFenceBusy);
      assert.equal(error.canRetry, true); assert.ok(error.fences.some(fence => fence.references > 0)); return true;
    });
    assert.equal(f.repository.sources.root(f.source.id).authorized, true, '未quiet的首尝试必须保留原ROLLBACK语义。');
    const afterRollback = f.readonlyStamp();
    failure(await f.sourceDispatch({ operation: 'read', handle: source.handle, readId, start: firstBytes, maxBytes: 13 }), 409, 'SOURCE_CHANGED');
    f.assertQuiet(); f.assertReadonly(afterRollback);
    const revoked = f.repository.sources.revoke(revoke);
    assert.equal(revoked.id, f.source.id); assert.equal(revoked.authorized, false);
    assert.equal(f.repository.sources.root(f.source.id).authorized, false);
    const afterRevoke = f.readonlyStamp();
    await withoutSourceOpen(t, async () => {
      failure(await f.sourceDispatch({ operation: 'prepare', selection: selection(selected) }), 409, 'SOURCE_CHANGED');
      failure(await f.sourceDispatch({ operation: 'read', handle: source.handle, readId, start: firstBytes, maxBytes: 13 }), 409, 'SOURCE_CHANGED');
      f.assertQuiet();
    });
    f.assertReadonly(afterRevoke);
  });
  f.assertQuiet(); await f.assertOriginals();
});
