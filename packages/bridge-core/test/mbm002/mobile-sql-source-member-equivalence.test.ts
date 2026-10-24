import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type * as dto from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import type { LocalAlbumSqlMobileQuery } from '../../src/collection/local-album-browser/sql-types.js';
import { createMobileLocalAlbumProjection } from '../../src/mobile/local-album-projection.js';
import { mobileTrackId } from '../../src/mobile/local-album-identity.js';
import { MobileServiceError } from '../../src/mobile/types.js';
import { seedMobileSqlWaveLibrary } from '../helpers/mobile-sql-owned-wave-library.js';

const query = (trackId: string): LocalAlbumSqlMobileQuery => ({ kind:'members',offset:0,limit:100,query:'',rootId:null,
  albumKey:null,trackId,editionId:null,groupHash:null });
async function fixture(t: test.TestContext, role: dto.LocalLibraryRole | null = null,
  relatives = ['合成专辑/1.wav','合成专辑/2.wav'], twoRoots = false) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'mac72-source-member-'));
  const repository = createCollectionRepository({filePath:path.join(directory,'catalog.sqlite')});
  const datasetId = randomUUID(), ownerEpoch = randomUUID(), media = path.join(directory,'合成来源');
  const seeded = await seedMobileSqlWaveLibrary(repository,datasetId,media,false,relatives), libraries = [seeded];
  if (twoRoots) libraries.push(await seedMobileSqlWaveLibrary(repository,datasetId,path.join(directory,'另一合成来源')));
  const service = createLocalAlbumOwnerService({ repository, datasetId, assertCurrent() {},
    async readArtwork() { return {image:null,status:'ready'}; },
    async readRootViews() { return libraries.map(library => ({root:repository.localCatalog.root(library.rootId),label:'受控原作者',availability:'ONLINE' as const})); },
    // 本组件层由可信作者提供固定组织事实；不伪称工作台管理提交或真实domain撤权围栏。
    ...(role === null ? {} : {readLibraryOrganizations: () => libraries.map(library => {
      const root = repository.localCatalog.root(library.rootId);
      return {datasetId,rootId:root.id,sourceRootId:root.sourceRootId,rootRevision:root.revision,bindingRevision:1,
        recordSha256:createHash('sha256').update('受控组织作者').digest('hex'),role,rootName:'受控艺人',parentName:'受控目录'};
    })}),
  });
  t.after(async () => { service.close(); repository.close(); await rm(directory,{recursive:true,force:true}); });
  await service.privateMobile.refresh();
  const projection = createMobileLocalAlbumProjection({collection:repository,localAlbums:service,datasetId,ownerEpoch,assertCurrent() {}});
  const ids = (trackId = seeded.trackIds[0]!) => {
    const page = service.privateMobile.current(query(trackId));
    return page.items.map(row => mobileTrackId(datasetId,trackId,row.groupHash));
  };
  const result = (id: string, original: boolean) => {
    try { return {ok:true as const,detail:(original ? projection.resolveTrack(id) : projection.resolveSourceTrack(id)).detail}; }
    catch (error) { if (!(error instanceof MobileServiceError)) throw error; return {ok:false as const,status:error.status,code:error.code}; }
  };
  const compare = (id: string) => { const expected = result(id,true); assert.deepEqual(result(id,false),expected); return expected; };
  async function addUnscanned(relative: string) {
    const root = repository.localCatalog.root(seeded.rootId), target = path.join(media,relative);
    await mkdir(path.dirname(target),{recursive:true}); await writeFile(target,await readFile(path.join(media,relatives[0]!)),{flag:'wx',mode:0o600});
    const asset = repository.localCatalog.registerAsset({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision,
      relative,sha256:null,sampleFrames:'480',timebaseHz:48000});
    const track = repository.localCatalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:null});
    repository.localCatalog.observeMetadata({commandId:randomUUID(),trackId:track.id,source:'synthetic',parserVersion:'受控无扫描提示-v1',
      fields:{title:'新增真实文件',artist:'受控艺人',album:'合成专辑'}});
    return track;
  }
  return {repository,service,projection,datasetId,seeded,libraries,ids,result,compare,addUnscanned};
}

test('MAC72 单成员差分合法父作者基线', {timeout:25_000}, async t => {
  for (const role of [null,'catalog','container','album','artist'] as const) {
    const f = await fixture(t,role,['专辑/01/a.wav','专辑/02/b.wav']);
    for (const track of f.seeded.trackIds) for (const id of f.ids(track)) assert.equal(f.result(id,true).ok,true);
  }
  const artist = await fixture(t,'artist',['专辑/01 track/a.wav','专辑/02 track/b.wav']);
  const oldArtist = artist.ids()[0]!; assert.equal(artist.result(oldArtist,true).ok,true);
  await artist.addUnscanned('专辑/02 track/c.wav');
  assert.equal(artist.result(oldArtist,true).ok,false);
  for (const id of artist.ids()) assert.equal(artist.result(id,true).ok,true);
  const roots = await fixture(t,null,undefined,true), trackId = roots.seeded.trackIds[0]!;
  const edition = roots.repository.localCatalog.createEdition({commandId:randomUUID(),title:'受控父发行',edition:'受控版'});
  roots.repository.localCatalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId,disc:1,trackNumber:1,sequence:1});
  const legacy = `lt:${roots.datasetId}:${trackId}:${edition.id}`;
  assert.equal(roots.result(legacy,true).ok,true);
  roots.repository.localCatalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:roots.libraries[1]!.trackIds[0]!,disc:1,trackNumber:2,sequence:2});
  const ambiguous = roots.result(legacy,true); assert.equal(ambiguous.ok,false); if (!ambiguous.ok) assert.equal(ambiguous.status,409);
});

test('MAC72 单成员证明保持目录与组织原作者完整detail', {timeout:25_000}, async t => {
  for (const role of [null,'catalog','container','album','artist'] as const) {
    const f = await fixture(t,role,['专辑/01/a.wav','专辑/02/b.wav']);
    for (const track of f.seeded.trackIds) for (const id of f.ids(track)) assert.equal(f.compare(id).ok,true);
  }
});

test('MAC72 单成员raw版本与effective override变更仍按原分组拒旧hash', {timeout:15_000}, async t => {
  const f = await fixture(t), trackId = f.seeded.trackIds[0]!, previous = f.ids()[0]!;
  f.repository.localCatalog.observeMetadata({commandId:randomUUID(),trackId,source:'synthetic',parserVersion:'受控raw-v2',
    fields:{title:'曲名 Live',artist:'受控艺人',album:'新目录标签 (Deluxe Edition)'}});
  f.repository.localCatalog.overrideMetadata({commandId:randomUUID(),trackId,expectedRevision:null,fields:{album:'只改effective显示',title:'受控显示曲名'}});
  assert.equal(f.compare(previous).ok,false);
  for (const id of f.ids()) assert.equal(f.compare(id).ok,true);
  assert.equal(f.compare(mobileTrackId(f.datasetId,trackId,'f'.repeat(64))).ok,false);
});

test('MAC72 单成员保持多active发行与legacy跨根歧义', {timeout:15_000}, async t => {
  const f = await fixture(t,null,undefined,true), trackId = f.seeded.trackIds[0]!;
  const editions = ['受控发行甲','受控发行乙'].map(title => f.repository.localCatalog.createEdition({commandId:randomUUID(),title,edition:'受控版'}));
  for (const edition of editions) f.repository.localCatalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId,disc:1,trackNumber:1,sequence:1});
  for (const id of f.ids()) assert.equal(f.compare(id).ok,true);
  const legacy = `lt:${f.datasetId}:${trackId}:${editions[0]!.id}`;
  assert.equal(f.compare(legacy).ok,true);
  f.repository.localCatalog.linkEditionTrack({commandId:randomUUID(),editionId:editions[0]!.id,trackId:f.libraries[1]!.trackIds[0]!,disc:1,trackNumber:2,sequence:2});
  const changed = f.compare(legacy); assert.equal(changed.ok,false); if (!changed.ok) assert.equal(changed.status,409);
});

test('MAC72 artist直接兄弟音频变化与合法缺扫描提示仍重核原边界', {timeout:15_000}, async t => {
  const f = await fixture(t,'artist',['专辑/01 track/a.wav','专辑/02 track/b.wav']);
  const old = f.ids()[0]!; assert.equal(f.compare(old).ok,true);
  const added = await f.addUnscanned('专辑/02 track/c.wav');
  assert.equal(f.compare(old).ok,false);
  for (const trackId of [...f.seeded.trackIds,added.id]) for (const id of f.ids(trackId)) assert.equal(f.compare(id).ok,true);
});

test('MAC72 单成员不把真实Source撤销变成旧许可复用', {timeout:15_000}, async t => {
  const f = await fixture(t), id = f.ids()[0]!;
  f.repository.sources.revoke({commandId:randomUUID(),id:f.seeded.sourceId});
  assert.equal(f.compare(id).ok,false);
});

test('MAC72 已保存Root修订与旧资产错配保留原409身份冲突', {timeout:15_000}, async t => {
  const f = await fixture(t), id = f.ids()[0]!, root = f.repository.localCatalog.root(f.seeded.rootId);
  f.repository.localCatalog.relinkRoot({commandId:randomUUID(),rootId:root.id,expectedRevision:root.revision,sourceRootId:root.sourceRootId,role:'library'});
  await f.service.privateMobile.refresh();
  const original = f.result(id,true); assert.deepEqual(original,{ok:false,status:409,code:'SOURCE_CHANGED'});
  assert.deepEqual(f.result(id,false),original);
  if (!original.ok) console.log(JSON.stringify({事件:'Root修订错配原作者差分',原状态:original.status,原分类:original.code,新状态:409}));
});
