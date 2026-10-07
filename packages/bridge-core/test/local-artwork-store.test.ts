import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LocalArtworkCandidate, LocalArtworkImage } from '@music-bridge/contracts';
import { createCollectionRepository } from '../src/collection/repository.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { isolateRestoredDatabase, verifyRestoredDatabaseIsolation } from '../src/recording/restore-database.js';
import { readBackupIndex } from '../src/recording/backup-index.js';

// 唯一Owner收到的展示副本用合成bytes；这些测试不证明图片native解码。
function image(byte = 0): LocalArtworkImage {
  const b = Buffer.from([255,216,byte,255,217]), sha256 = createHash('sha256').update(b).digest('hex');
  return { original:{mime:'image/jpeg',bytes:b.length,sha256,width:1,height:1}, display:{mime:'image/jpeg',bytes:b.length,sha256,width:1,height:1,dataUrl:`data:image/jpeg;base64,${b.toString('base64')}`} };
}
async function fixture(t: test.TestContext, beforeCommit?: (action:string)=>void) {
  assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR));
  if (process.platform === 'darwin' && !(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')) assert.ok(process.env.TMPDIR.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const parent=await mkdtemp(path.join(process.env.TMPDIR!,'artwork-store-')),file=path.join(parent,'library.sqlite'),source=path.join(parent,'source'); await mkdir(source);
  const repository=createCollectionRepository({filePath:file,...(beforeCommit?{beforeCommit}:{})});
  t.after(async()=>{repository.close();await rm(parent,{recursive:true,force:true});});
  const catalog=repository.localCatalog,root=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(source)),library=catalog.registerRoot({commandId:randomUUID(),sourceRootId:root.id,role:'library'});
  const asset=catalog.registerAsset({commandId:randomUUID(),libraryRootId:library.id,expectedRootRevision:'1',relative:'track.flac',sha256:null,sampleFrames:null,timebaseHz:null});
  const track=catalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:null}),edition=catalog.createEdition({commandId:randomUUID(),title:'独立发行',edition:''});
  catalog.linkEditionTrack({commandId:randomUUID(),editionId:edition.id,trackId:track.id,disc:1,trackNumber:1,sequence:1});
  const request={trackId:track.id,editionId:edition.id},target=repository.localArtwork.context(request).target!;
  const stage=(origin:'manual'|'embedded'|'local-independent'='manual',byte=0)=>repository.localArtwork.stage({target,origin,sourceIdentity:createHash('sha256').update(String(byte)+origin).digest('hex'),sourceLabel:'合成图片',image:image(byte)});
  return {repository,catalog,file,parent,library,asset,track,edition,request,target,stage};
}
test('候选暂存按本地独立/内嵌优先排序，但取消或失败不提交选择',async t=>{
  const f=await fixture(t);f.stage('embedded');const view=f.stage('local-independent',1);
  assert.equal(view.selection,null);assert.deepEqual(view.candidates.map(c=>c.origin),['local-independent','embedded']);
  const bad={...image(),display:{...image().display,sha256:'0'.repeat(64)}};
  assert.throws(()=>f.repository.localArtwork.stage({target:f.target,origin:'manual',sourceIdentity:'a'.repeat(64),sourceLabel:'伪副本',image:bad}));
  assert.deepEqual(f.repository.localArtwork.context(f.request),view);
});
test('CAS、确切请求去重与事务失败都保留已选图，文字修订不推进封面修订',async t=>{
  let fail=false;const f=await fixture(t,action=>{if(fail&&action==='local-artwork-apply')throw new Error('合成提交拒绝');});
  const staged=f.stage(),candidate=staged.candidates[0]!,request={commandId:randomUUID(),target:f.target,candidateId:candidate.id,expectedSelectionRevision:null};
  const first=f.repository.localArtwork.apply(request);assert.equal(first.mode,'manual');
  f.catalog.overrideMetadata({commandId:randomUUID(),trackId:f.track.id,expectedRevision:null,fields:{title:'只改文字'}});
  assert.deepEqual(f.repository.localArtwork.context(f.request).selection,first);
  assert.deepEqual(f.repository.localArtwork.apply({...request,target:{...f.target}}),first);
  assert.throws(()=>f.repository.localArtwork.apply({...request,candidateId:null}),/编号/u);
  assert.throws(()=>f.repository.localArtwork.apply({...request,commandId:randomUUID()}),/改变/u);
  fail=true;assert.throws(()=>f.repository.localArtwork.apply({commandId:randomUUID(),target:f.target,candidateId:null,expectedSelectionRevision:first.revision}),/暂时不可用/u);
  assert.deepEqual(f.repository.localArtwork.context(f.request).selection,first);
});
test('改名/换源使旧候选请求失效，稳定发行的手选和来源快照仍保留',async t=>{
  const f=await fixture(t),candidate=f.stage().candidates[0]!,selection=f.repository.localArtwork.apply({commandId:randomUUID(),target:f.target,candidateId:candidate.id,expectedSelectionRevision:null});
  f.catalog.moveAsset({commandId:randomUUID(),assetId:f.asset.id,expectedLocationRevision:'1',expectedRootRevision:'1',relative:'renamed.flac'});
  const fresh=f.repository.localArtwork.context(f.request);assert.notEqual(fresh.target!.expectedSourceRevision,f.target.expectedSourceRevision);assert.deepEqual(fresh.selection,selection);
  assert.throws(()=>f.repository.localArtwork.apply({commandId:randomUUID(),target:f.target,candidateId:candidate.id,expectedSelectionRevision:'1'}),/改变/u);
});
test('同字节的不同发行关系保持独立，不改变底层音频资产',async t=>{
  const f=await fixture(t),first=f.stage().candidates[0]!,before=f.catalog.asset(f.asset.id),other=f.catalog.createEdition({commandId:randomUUID(),title:'独立发行',edition:''});
  f.catalog.linkEditionTrack({commandId:randomUUID(),editionId:other.id,trackId:f.track.id,disc:1,trackNumber:1,sequence:1});
  const target=f.repository.localArtwork.context({trackId:f.track.id,editionId:other.id}).target!;
  const next=f.repository.localArtwork.stage({target,origin:'manual',sourceIdentity:first.sourceIdentity,sourceLabel:'合成图片',image:image()}).candidates[0]!;
  assert.equal(next.original.sha256,first.original.sha256);assert.notEqual(next.id,first.id);
  const a=f.repository.localArtwork.apply({commandId:randomUUID(),target:f.target,candidateId:first.id,expectedSelectionRevision:null}),b=f.repository.localArtwork.apply({commandId:randomUUID(),target,candidateId:next.id,expectedSelectionRevision:null});
  assert.notEqual(a.id,b.id);assert.notEqual(a.editionId,b.editionId);assert.deepEqual(f.catalog.asset(f.asset.id),before);
  assert.throws(()=>f.repository.localArtwork.apply({commandId:randomUUID(),target,candidateId:first.id,expectedSelectionRevision:'1'}),/属于其他发行/u);
});
test('手选副本随SQLite重启/恢复副本保留，schema34恢复路径接受新表',async t=>{
  const f=await fixture(t),candidate=f.stage().candidates[0]!,request={commandId:randomUUID(),target:f.target,candidateId:candidate.id,expectedSelectionRevision:null},selected=f.repository.localArtwork.apply(request);
  f.repository.close();const db=new DatabaseSync(f.file,{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,34);db.close();
  const cold=createCollectionRepository({filePath:f.file});try{assert.deepEqual(cold.localArtwork.context(f.request).selection,selected);assert.deepEqual(cold.localArtwork.apply(request),selected);}finally{cold.close();}
  const copy=path.join(f.parent,'restore.sqlite');await copyFile(f.file,copy);isolateRestoredDatabase(copy);
  const restored=createCollectionRepository({filePath:copy});try{assert.deepEqual(restored.localArtwork.context(f.request).selection,selected);assert.equal(restored.sources.roots()[0]!.authorized,false);}finally{restored.close();}
});
test('候选LRU可继续选图，当前选择和已淘汰候选的确切历史回执保留',async t=>{
  const f=await fixture(t),first=f.stage().candidates[0]!,request={commandId:randomUUID(),target:f.target,candidateId:first.id,expectedSelectionRevision:null},saved=f.repository.localArtwork.apply(request);
  for(let byte=1;byte<=8;byte++)f.stage('manual',byte);
  let view=f.repository.localArtwork.context(f.request);assert.equal(view.candidates.length,4);assert.deepEqual(view.selection,saved);assert.ok(view.candidates.some(c=>c.id===first.id));
  const second=view.candidates.find(c=>c.id!==first.id)!;f.repository.localArtwork.apply({commandId:randomUUID(),target:f.target,candidateId:second.id,expectedSelectionRevision:'1'});
  for(let byte=9;byte<=14;byte++)f.stage('manual',byte);
  view=f.repository.localArtwork.context(f.request);assert.equal(view.candidates.length,4);assert.ok(!view.candidates.some(c=>c.id===first.id));assert.equal(view.selection!.candidate!.id,second.id);
  assert.deepEqual(f.repository.localArtwork.apply(request),saved);
});
test('跨发行未选缓存最多32个，淘汰不删除被选副本或合并同图发行',async t=>{
  const f=await fixture(t),first=f.stage().candidates[0]!,saved=f.repository.localArtwork.apply({commandId:randomUUID(),target:f.target,candidateId:first.id,expectedSelectionRevision:null});
  const editions=[];
  for(let i=0;i<35;i++){
    const e=f.catalog.createEdition({commandId:randomUUID(),title:`同图独立发行${i}`,edition:''});f.catalog.linkEditionTrack({commandId:randomUUID(),editionId:e.id,trackId:f.track.id,disc:1,trackNumber:1,sequence:1});editions.push(e);
    const target=f.repository.localArtwork.context({trackId:f.track.id,editionId:e.id}).target!;f.repository.localArtwork.stage({target,origin:'manual',sourceIdentity:'e'.repeat(64),sourceLabel:'同字节不同发行',image:image()});
  }
  const db=new DatabaseSync(f.file,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM local_artwork_candidates').get()!.n,33);}finally{db.close();}
  assert.deepEqual(f.repository.localArtwork.context(f.request).selection,saved);assert.equal(f.repository.localArtwork.context({trackId:f.track.id,editionId:editions[0]!.id}).candidates.length,0);assert.equal(f.repository.localArtwork.context({trackId:f.track.id,editionId:editions.at(-1)!.id}).candidates.length,1);
});
test('CAA图权利未知不继承元数据CC0，不自动成为本地默认或改变音乐元数据',async t=>{
  const f=await fixture(t),before=f.catalog.trackDetail(f.track.id),source={releaseId:'76df3287-6cda-33eb-8e9a-044b5e15ffdd',imageId:'829521842',releaseTitle:'源提供的独立发行',artist:'源提供的艺人',releaseDate:'1969',country:'GB',releaseUrl:'https://musicbrainz.org/release/76df3287-6cda-33eb-8e9a-044b5e15ffdd',front:true,approved:true,musicBrainzMetadataLicense:'CC0-core' as const,imageRights:'unverified' as const,imageVariant:'original' as const,policyVersion:'2026-10-07-caa-personal-v1' as const};
  const staged=f.repository.localArtwork.stage({target:f.target,origin:'provider',sourceIdentity:'f'.repeat(64),sourceLabel:'Cover Art Archive',remoteSource:source,image:image()});
  assert.equal(staged.selection,null);assert.equal(staged.candidates[0]!.license,'rights-unverified');assert.deepEqual(f.catalog.trackDetail(f.track.id),before);
  const selection=f.repository.localArtwork.apply({commandId:randomUUID(),target:f.target,candidateId:null,expectedSelectionRevision:null});assert.equal(selection.candidate,null);
});
test('坏JSON/展示Hash/列与JSON身份不符的恢复副本在改写前拒绝，原库选择和历史保留',async t=>{
  const f=await fixture(t),chosen=f.stage().candidates[0]!,body={commandId:randomUUID(),target:f.target,candidateId:chosen.id,expectedSelectionRevision:null},saved=f.repository.localArtwork.apply(body);
  f.repository.close();const original=await readFile(f.file);
  const changes:Array<(db:DatabaseSync)=>void>=[
    db=>{db.prepare('UPDATE local_artwork_candidates SET data=? WHERE id=?').run('{',chosen.id);},
    db=>{const c=JSON.parse(String(db.prepare('SELECT data FROM local_artwork_candidates WHERE id=?').get(chosen.id)!.data)) as LocalArtworkCandidate;c.display.sha256='0'.repeat(64);db.prepare('UPDATE local_artwork_candidates SET data=? WHERE id=?').run(JSON.stringify(c),chosen.id);},
    db=>{const c=JSON.parse(String(db.prepare('SELECT data FROM local_artwork_candidates WHERE id=?').get(chosen.id)!.data)) as LocalArtworkCandidate;c.id=randomUUID();db.prepare('UPDATE local_artwork_candidates SET data=? WHERE id=?').run(JSON.stringify(c),chosen.id);},
    db=>{const value={...saved,editionId:randomUUID()};db.prepare('UPDATE local_artwork_selections SET data=? WHERE edition_id=?').run(JSON.stringify(value),f.edition.id);},
    db=>{const trigger=String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='local_artwork_ledger_no_update'").get()!.sql);db.exec('DROP TRIGGER local_artwork_ledger_no_update');db.prepare('UPDATE local_artwork_ledger SET result=? WHERE command_id=?').run('{',body.commandId);db.exec(trigger);},
  ];
  for(let i=0;i<changes.length;i++){
    const copy=path.join(f.parent,`damaged-content-${i}.sqlite`);await copyFile(f.file,copy);const db=new DatabaseSync(copy);
    try{changes[i]!(db);assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);}finally{db.close();}
    const before=await readFile(copy);assert.throws(()=>readBackupIndex(copy));assert.throws(()=>isolateRestoredDatabase(copy));assert.throws(()=>verifyRestoredDatabaseIsolation(copy));assert.deepEqual(await readFile(copy),before);
  }
  assert.deepEqual(await readFile(f.file),original);const cold=createCollectionRepository({filePath:f.file});try{assert.deepEqual(cold.localArtwork.context(f.request).selection,saved);assert.deepEqual(cold.localArtwork.apply(body),saved);}finally{cold.close();}
});
test('恢复校验拒缺失或被弱化的不可改写trigger及候选index，原库不改',async t=>{
  const f=await fixture(t),chosen=f.stage().candidates[0]!,body={commandId:randomUUID(),target:f.target,candidateId:chosen.id,expectedSelectionRevision:null},saved=f.repository.localArtwork.apply(body);
  f.repository.close();const original=await readFile(f.file);
  const changes=[
    'DROP TRIGGER local_artwork_ledger_no_update',
    'DROP TRIGGER local_artwork_create_intents_no_delete',
    'DROP INDEX local_artwork_candidates_edition',
    "DROP TRIGGER local_artwork_ledger_no_update; CREATE TRIGGER local_artwork_ledger_no_update BEFORE UPDATE ON local_artwork_ledger BEGIN SELECT 1; END;",
  ];
  for(let i=0;i<changes.length;i++){
    const copy=path.join(f.parent,`damaged-schema-${i}.sqlite`);await copyFile(f.file,copy);const db=new DatabaseSync(copy);try{db.exec(changes[i]!);assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);}finally{db.close();}
    const before=await readFile(copy);assert.throws(()=>readBackupIndex(copy));assert.throws(()=>isolateRestoredDatabase(copy));assert.deepEqual(await readFile(copy),before);
  }
  assert.deepEqual(await readFile(f.file),original);const cold=createCollectionRepository({filePath:f.file});try{assert.deepEqual(cold.localArtwork.context(f.request).selection,saved);}finally{cold.close();}
});
