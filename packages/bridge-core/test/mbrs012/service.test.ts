import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {lstat,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {SourceWritesError,sourceWritesHash} from '../../src/collection/local-source-writes-journal.js';
import {createLocalSourceTickets} from '../../src/collection/local-source-tickets.js';
import {createLocalSourceWritesService} from '../../src/collection/local-source-writes-service.js';
import {sourceServiceFixture,hash,owned,type SourceServiceFixture} from './service-fixture.js';

const fields={title:{action:'set',value:'真实源写后标题'},artist:{action:'set',value:'明确单艺人'},album:{action:'set',value:'写后专辑'},year:{action:'set',value:'0000'},disc:{action:'set',value:'0'},track:{action:'set',value:'100000'}} as const;
const removed={title:{action:'remove'},artist:{action:'remove'},album:{action:'remove'},year:{action:'remove'},disc:{action:'remove'},track:{action:'remove'}} as const;
const fails=(code:dto.LocalSourceWritesIssue)=>(error:unknown):boolean=>error instanceof SourceWritesError&&error.code===code;
async function evidence(f:SourceServiceFixture,label:string,operationId:string,after:string,undo:string):Promise<string>{
  const backup=path.join(f.directory,'source-writes','safety',operationId,'backup'),original=await readFile(backup),written=await readFile(after),restored=await readFile(undo);
  const previous=f.beforeOperations.get(operationId);assert.ok(previous?.file&&previous.originalStat);const before=previous.file;assert.equal(hash(await readFile(before)),hash(original));
  assert.equal(hash(restored),hash(original));const a=await lstat(backup,{bigint:true}),b=await lstat(path.join(f.media,f.relative(f.tracks[0]!)),{bigint:true});assert.notEqual(`${a.dev}:${a.ino}`,`${b.dev}:${b.ino}`);
  const manifest=path.join(f.directory,`${label}-source-evidence.json`);await writeFile(manifest,JSON.stringify({owned:true,profile:'NONATOMIC_QUARANTINE_LINK_V1',sourceRoot:f.media,safetyRoot:path.join(f.directory,'source-writes','safety'),before,originalStat:previous.originalStat,originalAttributes:previous.originalAttributes,after,undo,restored:undo,target:previous.target,backup,sha256:{before:hash(await readFile(before)),after:hash(written),undo:hash(restored)},fileRevision:f.repository.localCatalog.asset(f.tracks[0]!.assetId).fileRevision},null,2)+'\n',{flag:'wx',mode:0o600});return manifest;
}

for(const name of ['owned-stereo-fixed-tags.flac','owned-stereo-id3v240.mp3'] as const)test(`012 ${name} 真实扫描→源六字段set→fullRaw/search→backup撤销→remove→cold/真实再scan`,async t=>{
  const f=await sourceServiceFixture(t,{files:[name]});f.enable();const track=f.tracks[0]!,beforeAsset=f.repository.localCatalog.asset(track.assetId),beforeBytes=await readFile(path.join(f.media,name));
  const p=await f.ready({kind:'tags',target:f.target(),fields}),written=await f.complete(p),detail=f.repository.localCatalog.trackDetail(track.id);
  assert.equal(written.items[0]!.currentFileRevision,(BigInt(beforeAsset.fileRevision)+1n).toString());assert.equal(detail.asset.id,beforeAsset.id);assert.equal(detail.metadata.raw.title,fields.title.value);assert.equal(detail.metadata.raw.artist,fields.artist.value);assert.equal(detail.metadata.raw.year,'0000');assert.equal(detail.metadata.raw.disc,'0');assert.equal(detail.metadata.raw.track,'100000');
  assert.equal(f.repository.localCatalog.queryTracks({offset:0,limit:20,rootId:null,query:fields.title.value}).items.some(v=>v.track.id===track.id),true);
  const backup=path.join(f.directory,'source-writes','safety',written.items[0]!.operationId,'backup');assert.deepEqual(await readFile(backup),beforeBytes);assert.notEqual(hash(await readFile(path.join(f.media,name))),hash(beforeBytes));
  const tickets=createLocalSourceTickets(f.repository,randomUUID(),f.datasetId,()=>{}),old={schema_version:'1.2',request_id:randomUUID(),route:'roon_audio_input',source_kind:'local_file',local_track_id:track.id,asset_id:track.assetId,expected_asset_revision:beforeAsset.fileRevision,target:{core_id:'owned-core',zone_id:'owned-zone'},action:'PLAY_NOW'} as const;
  assert.throws(()=>tickets.capture(old));tickets.seal();
  const after=await f.retain('source-written'),undone=await f.undo(written),undo=await f.retain('source-restored');assert.deepEqual(await readFile(undo),beforeBytes);assert.ok(undone.items[0]!.restoration);t.diagnostic(`Source独立发布/备份/撤销材料：${await evidence(f,name,written.items[0]!.operationId,after,undo)}`);
  const deletion=await f.complete(await f.ready({kind:'tags',target:f.target(),fields:removed})),revision=deletion.items[0]!.currentFileRevision;
  assert.deepEqual(f.repository.localCatalog.trackDetail(track.id).metadata.raw,{});assert.equal(f.repository.localCatalog.queryTracks({offset:0,limit:20,rootId:null,query:'合成写回样本'}).items.some(v=>v.track.id===track.id),false);assert.equal(f.repository.localCatalog.queryTracks({offset:0,limit:20,rootId:null,query:fields.title.value}).items.some(v=>v.track.id===track.id),false);
  const scan=f.scanner.start({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision});await f.scanner.privateWait(scan.jobId);assert.equal(f.scanner.get(scan.jobId).phase,'completed');assert.equal(f.repository.localCatalog.asset(track.assetId).fileRevision,revision);assert.deepEqual(f.repository.localCatalog.trackDetail(track.id).metadata.raw,{});
  await f.close();const cold=createCollectionRepository({filePath:f.filePath});try{assert.equal(cold.localCatalog.asset(track.assetId).fileRevision,revision);assert.deepEqual(cold.localCatalog.trackDetail(track.id).metadata.raw,{});assert.equal(cold.localCatalog.queryTracks({offset:0,limit:20,rootId:null,query:'合成写回样本'}).items.length,0);}finally{cold.close();}
});

test('012 默认OFF仍持久小accepted与BLOCKED；打开policy不替代具体grant，普通confirm零源副作用',async t=>{
  const f=await sourceServiceFixture(t,{files:['owned-stereo-fixed-tags.flac']}),before=await readFile(path.join(f.media,f.relative(f.tracks[0]!))),accepted=f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),intent:{kind:'tags',target:f.target(),fields}});assert.equal(accepted.outcome,'accepted');assert.ok(accepted.planId);
  const blocked=await f.waitPlan(accepted.planId,p=>p.state!=='PREVIEWING');assert.equal(blocked.state,'BLOCKED');assert.deepEqual(blocked.issues,['POLICY_DISABLED']);f.enable();const p=await f.ready({kind:'tags',target:f.target(),fields}),request=f.confirmation(p),rejected=f.api.confirm(request);
  assert.equal(rejected.outcome,'rejected');assert.equal(rejected.issue,'GRANT_REQUIRED');assert.deepEqual(f.api.confirm(request),rejected);assert.deepEqual(await readFile(path.join(f.media,f.relative(f.tracks[0]!))),before);assert.equal(f.facts.length,0);assert.equal(f.plan(p.planId).state,'READY');
});

test('012 单次真实Main端口grant绑定命令/plan/hash/policy，合法重试只原accepted receipt',async t=>{
  const f=await sourceServiceFixture(t,{files:['owned-stereo-fixed-tags.flac']});f.enable();const p=await f.ready({kind:'tags',target:f.target(),fields}),granted=f.grant(p),wrong={...granted.request,commandId:randomUUID()};
  assert.throws(()=>f.api.executeGranted({datasetId:f.datasetId,confirm:wrong,grant:granted.challenge.grant},f.actor),fails('GRANT_MISMATCH'));assert.throws(()=>f.api.executeGranted({datasetId:f.datasetId,confirm:granted.request,grant:{...granted.challenge.grant,signature:'0'.repeat(64)}},f.actor),fails('GRANT_MISMATCH'));
  const accepted=f.api.executeGranted({datasetId:f.datasetId,confirm:granted.request,grant:granted.challenge.grant},f.actor);assert.equal(accepted.outcome,'accepted');const completed=await f.waitPlan(p.planId,v=>['COMPLETED','RECOVERY_REQUIRED','FAILED'].includes(v.state));assert.equal(completed.state,'COMPLETED');const count=f.facts.length;
  assert.deepEqual(f.api.executeGranted({datasetId:f.datasetId,confirm:granted.request,grant:granted.challenge.grant},f.actor),accepted);assert.equal(f.facts.length,count);const found=f.api.get({datasetId:f.datasetId,selector:{kind:'command',commandId:granted.request.commandId,expectedCommand:'localSourceWrites.confirm',requestFingerprint:accepted.requestFingerprint}});assert.ok(found.kind==='command');assert.deepEqual(found.receipt,accepted);
});

test('012 到期READY/过时view/policy和撤权均不能凭旧grant写文件',async t=>{
  let clock=Date.now();const f=await sourceServiceFixture(t,{files:['owned-stereo-fixed-tags.flac'],now:()=>clock});f.enable();const p=await f.ready({kind:'tags',target:f.target(),fields}),granted=f.grant(p),before=await readFile(path.join(f.media,f.relative(f.tracks[0]!)));
  assert.throws(()=>f.api.challenge({datasetId:f.datasetId,confirm:{...f.confirmation(p),expectedViewRevision:'1'}},f.actor),fails('REVISION_CHANGED'));
  clock=Date.parse(p.expiresAt!);assert.throws(()=>f.api.executeGranted({datasetId:f.datasetId,confirm:granted.request,grant:granted.challenge.grant},f.actor),fails('PLAN_EXPIRED'));clock=Date.now();
  f.enable(false);f.enable(true);assert.throws(()=>f.api.executeGranted({datasetId:f.datasetId,confirm:granted.request,grant:granted.challenge.grant},f.actor),fails('GRANT_MISMATCH'));
  const next=await f.ready({kind:'tags',target:f.target(),fields}),permission=f.grant(next);f.repository.sources.revoke({commandId:randomUUID(),id:f.source.id});assert.throws(()=>f.api.executeGranted({datasetId:f.datasetId,confirm:permission.request,grant:permission.challenge.grant},f.actor),fails('SOURCE_REVOKED'));assert.deepEqual(await readFile(path.join(f.media,f.relative(f.tracks[0]!))),before);assert.equal(f.facts.length,0);
});

test('012 同Asset源外部改写使真实undo拒绝；不是从backup自动覆盖',async t=>{
  const f=await sourceServiceFixture(t,{files:['owned-stereo-fixed-tags.flac']});f.enable();const written=await f.complete(await f.ready({kind:'tags',target:f.target(),fields})),file=path.join(f.media,f.relative(f.tracks[0]!)),changed=Buffer.from(await readFile(file));changed[changed.length-1]=changed[changed.length-1]!^1;await writeFile(file,changed);
  const accepted=f.api.undo({datasetId:f.datasetId,commandId:randomUUID(),planId:written.planId,expectedViewRevision:written.viewRevision,operationIds:written.items.map(i=>i.operationId),journalFingerprint:written.journalFingerprint});assert.equal(accepted.outcome,'accepted');assert.ok(accepted.planId);const inverse=await f.waitPlan(accepted.planId,v=>v.state!=='PREVIEWING');assert.equal(inverse.state,'BLOCKED');assert.ok(inverse.issues.includes('UNDO_CONFLICT')||inverse.issues.includes('SOURCE_CHANGED'));assert.deepEqual(await readFile(file),changed);assert.equal(f.repository.localCatalog.asset(f.tracks[0]!.assetId).fileRevision,written.items[0]!.currentFileRevision);
});

test('012 冷READY只读对账不复发I/O也不为旧Owner补grant',async t=>{
  const f=await sourceServiceFixture(t,{files:['owned-stereo-fixed-tags.flac']});f.enable();const p=await f.ready({kind:'tags',target:f.target(),fields}),before=await readFile(path.join(f.media,f.relative(f.tracks[0]!))),asset=f.repository.localCatalog.asset(f.tracks[0]!.assetId);await f.close();const repository=createCollectionRepository({filePath:f.filePath}),api=createLocalSourceWritesService({repository,datasetId:f.datasetId,ownerEpoch:randomUUID(),assertCurrent(){repository.localCatalog.root(f.root.id);}});
  try{const view=api.get({datasetId:f.datasetId,selector:{kind:'plan',planId:p.planId}});assert.ok(view.kind==='plan'&&view.plan);assert.equal(view.plan.state,'BLOCKED');assert.deepEqual(view.plan.issues,['GRANT_MISMATCH']);assert.equal(sourceWritesHash(repository.localCatalog.asset(f.tracks[0]!.assetId)),sourceWritesHash(asset));}
  finally{await api.close();repository.close();assert.deepEqual(await readFile(path.join(f.media,f.relative(f.tracks[0]!))),before);}
});
