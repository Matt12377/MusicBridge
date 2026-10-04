import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isAudioAsset, type LocalPlayRequest, type LocalPlayTarget } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { prepareLocalSourceReadonly, resolveSourceReadonly, LocalSourcePreparationError, type LocalSourceAuthority, type PreparedLocalSource } from '../../src/application/local-source-resolver.js';
import type { ResolvedAudioStream } from '../../src/netease/types.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
const target:LocalPlayTarget={core_id:'合成Core',zone_id:'合成Zone'};
async function fixture(t:test.TestContext) {
  const storage=buildStoragePolicy(),tmp=storage.check(process.env.TMPDIR!,{mustExist:true}),parent=await mkdtemp(path.join(tmp,'musicbridge-local-prepare-'));
  storage.check(parent,{mustExist:true}); await chmod(parent,0o700);
  const file=path.join(parent,'collection.sqlite'),repository=createCollectionRepository({filePath:file});
  t.after(async()=>{repository.close();await rm(parent,{recursive:true,force:true});});
  const sourcePath=path.join(parent,'合成空源');await mkdir(sourcePath);
  const capability=await authorizeSourceDirectory(sourcePath),source=repository.sources.authorize(randomUUID(),capability),catalog=repository.localCatalog;
  const root=catalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'});
  const assetBody=()=>({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:catalog.root(root.id).revision,relative:'合成/不存在.flac',sha256:'a'.repeat(64),sampleFrames:'96000',timebaseHz:48000});
  const asset=catalog.registerAsset(assetBody()),track=catalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:{startFrame:'0',endFrameExclusive:'48000',timebaseHz:48000}});
  const request:LocalPlayRequest={schema_version:'1.2',request_id:randomUUID(),route:'roon_audio_input',source_kind:'local_file',local_track_id:track.id,asset_id:asset.id,expected_asset_revision:asset.fileRevision,target:{...target},action:'PLAY_NOW'};
  const authority:LocalSourceAuthority={captureCurrentTarget:()=>({target:{...target},isCurrent:()=>true})};
  return {parent,file,repository,catalog,capability,source,root,asset,track,request,authority,assetBody};
}
function dump(file:string):unknown {
  const db=new DatabaseSync(file,{readOnly:true});
  try {return {version:db.prepare('PRAGMA user_version').get(),tables:db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>({name:row.name,sql:row.sql,rows:db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"','""')}" ORDER BY rowid`).all()}))};}
  finally {db.close();}
}
function prepared(v:ReturnType<typeof prepareLocalSourceReadonly>):PreparedLocalSource {assert.ok('source_kind' in v);assert.equal(v.status,'prepared_descriptor');return v;}
const error=(code:LocalSourcePreparationError['code'])=>(v:unknown)=>v instanceof LocalSourcePreparationError && v.code===code;

test('MBRS002 B3私有locator：真实Repository新对象，经已有资产校验且公开DTO不含locator',async t=>{
  const f=await fixture(t),before=dump(f.file),a=f.catalog.privateAssetLocator(f.asset.id),b=f.catalog.privateAssetLocator(f.asset.id);
  const reordered={...f.request,target:{zone_id:target.zone_id,core_id:target.core_id}};
  const first=prepared(prepareLocalSourceReadonly(reordered,f.repository,f.authority));
  const previous={...first,target:{zone_id:target.zone_id,core_id:target.core_id}};
  const serverReordered:LocalSourceAuthority={captureCurrentTarget:()=>({target:{zone_id:target.zone_id,core_id:target.core_id},isCurrent:()=>true})};
  prepared(prepareLocalSourceReadonly(f.request,f.repository,serverReordered,previous));
  assert.notEqual(a,b);assert.notEqual(a.asset,b.asset);assert.deepEqual(a.asset,f.asset);assert.equal(a.relative,'合成/不存在.flac');assert.equal(isAudioAsset(a.asset),true);assert.equal(isAudioAsset(a),false);
  a.asset.fileRevision='999';assert.equal(f.catalog.asset(f.asset.id).fileRevision,'1');
  assert.ok(!JSON.stringify(f.catalog.asset(f.asset.id)).includes('不存在.flac'));assert.deepEqual(dump(f.file),before);
});
test('MBRS002 B3只读准备：三个动作均产私有descriptor，完整SQL事实不变且不存在媒体仍不打开',async t=>{
  const f=await fixture(t),before=dump(f.file);let mutationCalls=0;
  const mutations=new Set(['registerRoot','relinkRoot','registerAsset','moveAsset','replaceAsset','createTrack','selectAsset','createEdition','linkEditionTrack','removeEditionTrack','observeMetadata','overrideMetadata','authorize','revoke','start','finish','confirm']);
  const observe=<T extends object>(value:T):T=>new Proxy(value,{get(target,key,receiver){const method:unknown=Reflect.get(target,key,receiver);if(mutations.has(String(key)) && typeof method==='function')return (...args:unknown[])=>{mutationCalls++;return Reflect.apply(method,target,args);};return method;}});
  f.repository.localCatalog=observe(f.repository.localCatalog);f.repository.sources=observe(f.repository.sources);
  for(const action of ['PLAY_NOW','APPEND_MB_QUEUE','PLAY_NEXT_MB_QUEUE'] as const){const p=prepared(prepareLocalSourceReadonly({...f.request,action},f.repository,f.authority));assert.equal(p.action,action);assert.equal(p.facts.relative,'合成/不存在.flac');assert.deepEqual(p.facts.track,f.track);assert.deepEqual(p.target,target);assert.equal(Object.hasOwn(p,'upstreamUrl'),false);assert.equal(Object.hasOwn(p,'lease'),false);assert.equal(Object.hasOwn(p,'session_id'),false);}
  assert.deepEqual(dump(f.file),before);assert.equal(mutationCalls,0);
  f.repository.localCatalog.createEdition({commandId:randomUUID(),title:'spy正控制',edition:''});assert.equal(mutationCalls,1);assert.notDeepEqual(dump(f.file),before);
});
test('MBRS002 B3服务端目标：无权威unsupported，错Core或Zone与切换均拒且capture不接公开参数',async t=>{
  const f=await fixture(t),before=dump(f.file);assert.deepEqual(prepareLocalSourceReadonly(f.request,f.repository),{status:'unsupported',reason:'TARGET_AUTHORITY_UNAVAILABLE'});
  assert.deepEqual(prepareLocalSourceReadonly(f.request,f.repository,{captureCurrentTarget:()=>null}),{status:'unsupported',reason:'TARGET_AUTHORITY_UNAVAILABLE'});
  for(const wrong of [{...target,core_id:'另一Core'},{...target,zone_id:'另一Zone'}])assert.throws(()=>prepareLocalSourceReadonly(f.request,f.repository,{captureCurrentTarget:()=>({target:wrong,isCurrent:()=>true})}),error('TARGET_CHANGED'));
  let captures=0,current=true;
  const authority:LocalSourceAuthority={captureCurrentTarget(...args:unknown[]){assert.equal(args.length,0);captures++;if(captures===2)current=false;return {target:{...target},isCurrent:()=>current};}};
  assert.throws(()=>prepareLocalSourceReadonly(f.request,f.repository,authority),error('TARGET_CHANGED'));assert.equal(captures,2);assert.deepEqual(dump(f.file),before);
});
test('MBRS002 B3事实currentness：最终捕获期间位置改变拒准备，不复用旧locator',async t=>{
  const f=await fixture(t);let captures=0;
  const authority:LocalSourceAuthority={captureCurrentTarget(){if(++captures===2)f.catalog.moveAsset({commandId:randomUUID(),assetId:f.asset.id,expectedLocationRevision:'1',expectedRootRevision:'1',relative:'合成/移动.flac'});return {target:{...target},isCurrent:()=>true};}};
  assert.throws(()=>prepareLocalSourceReadonly(f.request,f.repository,authority),error('FACTS_CHANGED'));assert.equal(f.catalog.asset(f.asset.id).locationRevision,'2');
});
test('MBRS002 B3旧快照：真实selection与location ABA即使资产路径恢复仍拒，文件修订无损比较',async t=>{
  const f=await fixture(t),prior=prepared(prepareLocalSourceReadonly(f.request,f.repository,f.authority)),second=f.catalog.registerAsset(f.assetBody());
  f.catalog.selectAsset({commandId:randomUUID(),trackId:f.track.id,expectedSelectionRevision:'1',assetId:second.id});f.catalog.selectAsset({commandId:randomUUID(),trackId:f.track.id,expectedSelectionRevision:'2',assetId:f.asset.id});
  assert.throws(()=>prepareLocalSourceReadonly(f.request,f.repository,f.authority,prior),error('FACTS_CHANGED'));
  const selected=prepared(prepareLocalSourceReadonly(f.request,f.repository,f.authority));
  f.catalog.moveAsset({commandId:randomUUID(),assetId:f.asset.id,expectedLocationRevision:'1',expectedRootRevision:'1',relative:'合成/移动.flac'});f.catalog.moveAsset({commandId:randomUUID(),assetId:f.asset.id,expectedLocationRevision:'2',expectedRootRevision:'1',relative:'合成/不存在.flac'});
  assert.throws(()=>prepareLocalSourceReadonly(f.request,f.repository,f.authority,selected),error('FACTS_CHANGED'));
  const moved=prepared(prepareLocalSourceReadonly(f.request,f.repository,f.authority));f.catalog.replaceAsset({...f.assetBody(),assetId:f.asset.id,expectedFileRevision:'1',expectedLocationRevision:'3'});
  assert.throws(()=>prepareLocalSourceReadonly(f.request,f.repository,f.authority),error('FACTS_CHANGED'));
  assert.throws(()=>prepareLocalSourceReadonly({...f.request,expected_asset_revision:'2'},f.repository,f.authority,moved),error('FACTS_CHANGED'));
  for(const revision of ['0','18446744073709551616','99999999999999999999'])assert.throws(()=>prepareLocalSourceReadonly({...f.request,expected_asset_revision:revision},f.repository,f.authority),error('FACTS_CHANGED'));
  for(const revision of ['1\n','1\r'])assert.throws(()=>prepareLocalSourceReadonly({...f.request,expected_asset_revision:revision},f.repository,f.authority),error('INVALID_REQUEST'));
  assert.equal(prepared(prepareLocalSourceReadonly({...f.request,expected_asset_revision:'2'},f.repository,f.authority)).facts.asset.fileRevision,'2');
});
test('MBRS002 B3许可与relink：旧许可仍true也不能绕root关联，撤销及A到B到A快照拒绝',async t=>{
  const f=await fixture(t),prior=prepared(prepareLocalSourceReadonly(f.request,f.repository,f.authority));
  const next=f.repository.sources.authorize(randomUUID(),f.capability);f.catalog.relinkRoot({commandId:randomUUID(),rootId:f.root.id,expectedRevision:'1',sourceRootId:next.id,role:'library'});
  assert.equal(f.repository.sources.root(f.source.id).authorized,true);assert.throws(()=>prepareLocalSourceReadonly(f.request,f.repository,f.authority),error('FACTS_CHANGED'));
  f.catalog.relinkRoot({commandId:randomUUID(),rootId:f.root.id,expectedRevision:'2',sourceRootId:f.source.id,role:'library'});
  f.catalog.replaceAsset({...f.assetBody(),assetId:f.asset.id,expectedFileRevision:'1',expectedLocationRevision:'1'});
  const revised={...f.request,expected_asset_revision:'2'};assert.throws(()=>prepareLocalSourceReadonly(revised,f.repository,f.authority,prior),error('FACTS_CHANGED'));prepared(prepareLocalSourceReadonly(revised,f.repository,f.authority));
  f.repository.sources.revoke({commandId:randomUUID(),id:f.source.id});assert.throws(()=>prepareLocalSourceReadonly(revised,f.repository,f.authority),error('UNAUTHORIZED_ROOT'));
});
test('MBRS002 B3许可JSON：实际SourceStore typed返回需身份结构与strict true，公开不能自报许可',async t=>{
  const f=await fixture(t),source=f.repository.sources.root(f.source.id),actual=f.repository.sources.root.bind(f.repository.sources);const before=dump(f.file);
  for(const malformed of [{...source,id:randomUUID()},{...source,authorized:'true'},{...source,path:1},{...source,dev:'无效'}, {...source,ino:null},{...source,authorized:false}]){
    // 只在测试seam覆盖真实SourceStore getter返回；不写SQL或建立第二许可store。
    f.repository.sources.root=()=>malformed as unknown as typeof source;
    assert.throws(()=>prepareLocalSourceReadonly(f.request,f.repository,f.authority),error('UNAUTHORIZED_ROOT'));
  }
  f.repository.sources.root=actual;prepared(prepareLocalSourceReadonly(f.request,f.repository,f.authority));
  assert.throws(()=>prepareLocalSourceReadonly({...f.request,authorized:true},f.repository,f.authority),error('INVALID_REQUEST'));assert.deepEqual(dump(f.file),before);
});
test('MBRS002 B3私有源分流：local零远程调用，remote真实resolver正分支保留原stream且不碰catalog',async t=>{
  const f=await fixture(t),before=dump(f.file);let remoteCalls=0;
  const stream:ResolvedAudioStream={trackId:'合成云曲目',upstreamUrl:'https://synthetic.invalid/audio',requestedQuality:'standard',actualQuality:'合成',format:'flac'};
  const remote=async()=>{remoteCalls++;return stream;};
  const local=await resolveSourceReadonly({source_kind:'local_file',request:f.request,repository:f.repository,authority:f.authority});assert.ok('source_kind' in local);assert.equal(local.source_kind,'local_file');assert.equal(remoteCalls,0);
  const cloud=await resolveSourceReadonly({source_kind:'remote_provider',resolve:remote});assert.ok('source_kind' in cloud && cloud.source_kind==='remote_provider');assert.equal(cloud.stream,stream);assert.equal(remoteCalls,1);assert.deepEqual(dump(f.file),before);
});
test('MBRS002 B3冷库与关闭：真实冷Repository仍只读prepared，关闭后不得返回descriptor',async t=>{
  const f=await fixture(t);f.repository.close();const cold=createCollectionRepository({filePath:f.file});
  try{const before=dump(f.file);prepared(prepareLocalSourceReadonly(f.request,cold,f.authority));assert.deepEqual(dump(f.file),before);cold.close();assert.throws(()=>prepareLocalSourceReadonly(f.request,cold,f.authority));}finally{cold.close();}
});
