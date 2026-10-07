import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod,writeFile,rename,lstat,copyFile } from 'node:fs/promises';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import { legacyLinksFixture,executeLegacy,rejectsIssue } from './legacy-links-fixture.js';
import { physicalResourceLocks,PhysicalResourceBusy } from '../../src/stream/physical-resource-locks.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalLegacyLinksService} from '../../src/collection/local-legacy-links-service.js';

async function exact(t:test.TestContext,options:Parameters<typeof legacyLinksFixture>[1]={},range:'whole'|'full-span'|'part'='whole') {
  const f=await legacyLinksFixture(t,options),asset=f.asset();
  const track=f.repository.localCatalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:range==='whole'?null:{startFrame:range==='part'?'1':'0',endFrameExclusive:'44101',timebaseHz:44100}});
  const binding=f.repository.sources.linked(f.draft.draftId,f.draft.trackIds[0]!)!,libraryRoot=f.repository.localCatalog.root(asset.libraryRootId);
  const read:dto.ReadLocalLegacyLinks={datasetId:f.datasetId,selector:{by:'legacy',key:{kind:'draft-source',draftId:f.draft.draftId,draftTrackId:f.draft.trackIds[0]!,sourceBindingId:binding.id}},state:'all',cursor:null,limit:20};
  const request=():dto.PreviewLocalLegacyLink=>({datasetId:f.datasetId,commandId:randomUUID(),reason:'实核两个合成文件完整 Hash',intent:{action:'link',choice:{kind:'draft-source-track',draftId:f.draft.draftId,draftTrackId:f.draft.trackIds[0]!,expectedDraftRevision:f.repository.drafts.detail(f.draft.draftId).revision,sourceBindingId:binding.id,localTrackId:track.id,assetId:asset.id,expectedSelectionRevision:track.selectionRevision,expectedLibraryRootRevision:libraryRoot.revision,expectedFileRevision:asset.fileRevision,expectedLocationRevision:asset.locationRevision,expectedSegment:track.segment,expectedSlot:f.api.read(read).slot!}}});
  return {...f,asset,track,binding,libraryRoot,read,request};
}

test('014 exact：真实双 FD/全文件 Hash 支持 catalog sha=null，确认不补写旧 hash',async t=>{
  const f=await exact(t),bindingBefore=structuredClone(f.binding),assetBefore=f.repository.localCatalog.privateLegacyLinksAssetSnapshot(f.asset.id,f.track.id);
  const p=await f.api.preview(f.request());assert.equal(p.body.evidence.kind,'exact-file');if(p.body.evidence.kind==='exact-file'){assert.equal(p.body.evidence.sha256,f.binding.evidence.sha256);assert.deepEqual(p.body.evidence.coverage,{mode:'whole-file'});}
  const result=await f.api.confirm(executeLegacy(p));assert.equal(result.outcome,'applied');assert.equal(f.api.read(f.read).items.length,1);
  assert.deepEqual(f.repository.sources.linked(f.draft.draftId,f.draft.trackIds[0]!),bindingBefore);assert.deepEqual(f.repository.localCatalog.privateLegacyLinksAssetSnapshot(f.asset.id,f.track.id),assetBefore);
  assert.equal(assetBefore.catalogSha256,null);assert.equal(physicalResourceLocks.snapshot().resources,0);
});

test('014 exact range：精确完整 span 可证，子片段拒绝且无关系',async t=>{
  const f=await exact(t,{},'full-span'),p=await f.api.preview(f.request());assert.equal(p.body.evidence.kind,'exact-file');if(p.body.evidence.kind==='exact-file')assert.equal(p.body.evidence.coverage.mode,'whole-file-span');assert.equal((await f.api.confirm(executeLegacy(p))).outcome,'applied');
  await t.test('子片段',async child=>{const part=await exact(child,{},'part');await assert.rejects(part.api.preview(part.request()),rejectsIssue('SEGMENT_MISMATCH'));assert.equal(part.api.read(part.read).items.length,0);});
});

test('014 exact 失效：字节/修订/文件权限/根授权变化，确认仅拒绝 receipt',async t=>{
  for(const scenario of ['bytes','revision','permission','authorization'] as const)await t.test(scenario,async child=>{
    const f=await exact(child),p=await f.api.preview(f.request());
    if(scenario==='bytes')await writeFile(f.file,Buffer.from('另一个同名源，不能以 frames 推断相同内容'));
    if(scenario==='revision')f.repository.localCatalog.moveAsset({commandId:randomUUID(),assetId:f.asset.id,expectedLocationRevision:f.asset.locationRevision,expectedRootRevision:f.libraryRoot.revision,relative:'fixture.wav'});
    if(scenario==='permission')await chmod(f.file,0o400);
    if(scenario==='authorization')f.repository.sources.revoke({commandId:randomUUID(),id:f.root.id});
    const request=executeLegacy(p),result=await f.api.confirm(request);assert.equal(result.outcome,'rejected');assert.ok(result.issue==='SOURCE_CHANGED'||result.issue==='SOURCE_REVOKED'||result.issue==='REVISION_CHANGED');assert.deepEqual(await f.api.confirm(request),result);assert.equal(f.api.read(f.read).items.length,0);assert.equal(physicalResourceLocks.snapshot().resources,0);
  });
});

test('014 同轮 afterHash 围栏：读 claims 真阻 writer，迟到改文件/根权限不落 preview',async t=>{
  for(const scenario of ['file','root'] as const)await t.test(scenario,async child=>{
    let f:Awaited<ReturnType<typeof exact>>,called=0;
    f=await exact(child,{afterHash:async()=>{called++;const s=await lstat(f.file,{bigint:true});assert.throws(()=>physicalResourceLocks.acquireWrite([{dev:String(s.dev),ino:String(s.ino)}]),PhysicalResourceBusy);if(scenario==='file')await writeFile(f.file,Buffer.from('读取后外部改写'));else await chmod(f.sourcePath,0o500);}});
    await assert.rejects(f.api.preview(f.request()),rejectsIssue('SOURCE_CHANGED'));assert.equal(called,1);assert.equal(f.api.read(f.read).items.length,0);assert.equal(physicalResourceLocks.snapshot().resources,0);
    if(scenario==='root')await chmod(f.sourcePath,0o700);
  });
});

test('014 解除 exact 边不要求已离线来源；恢复 undo 仍必须实核',async t=>{
  const f=await exact(t),p=await f.api.preview(f.request()),active=await f.api.confirm(executeLegacy(p));assert.equal(active.outcome,'applied');
  const moved=path.join(f.directory,'离线合成文件');await rename(f.file,moved);
  const revoke=await f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'只解除边，不读离线文件',intent:{action:'revoke',linkId:active.link!.linkId,expectedLinkRevision:'1'}}),revoked=await f.api.revoke(executeLegacy(revoke));assert.equal(revoked.outcome,'applied');
  await assert.rejects(f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'离线不能自动恢复边',intent:{action:'undo',linkId:revoked.link!.linkId,expectedLinkRevision:'2',undoTransitionEventId:revoked.transitionEventId!}}),rejectsIssue('SOURCE_OFFLINE'));
});

test('014 相同尺寸/frames 的不同文件字节仍拒绝，不能用技术参数推断 Hash',async t=>{
  const f=await exact(t),{readFile}=await import('node:fs/promises'),bytes=await readFile(f.file);bytes[bytes.length-1]=1;await writeFile(path.join(f.sourcePath,'不同字节.wav'),bytes);
  const asset=f.repository.localCatalog.registerAsset({commandId:randomUUID(),libraryRootId:f.libraryRoot.id,expectedRootRevision:f.libraryRoot.revision,relative:'不同字节.wav',sha256:null,sampleFrames:'44101',timebaseHz:44100}),track=f.repository.localCatalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:null}),request=f.request();
  if(request.intent.action!=='link'||request.intent.choice.kind!=='draft-source-track')throw new Error('夹具应为 source');Object.assign(request.intent.choice,{assetId:asset.id,localTrackId:track.id,expectedSelectionRevision:track.selectionRevision,expectedFileRevision:asset.fileRevision,expectedLocationRevision:asset.locationRevision});
  await assert.rejects(f.api.preview(request),rejectsIssue('SOURCE_CHANGED'));assert.equal(f.api.read(f.read).items.length,0);assert.equal(physicalResourceLocks.snapshot().resources,0);
});

test('014 观察超时/close：逻辑期限返回，close 真 join held Hash，迟到零持久副作用',async t=>{
  let entered!:()=>void,release!:()=>void;const atHash=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const f=await exact(t,{ioDeadlineMs:25,afterHash:async()=>{entered();await held;}}),request=f.request(),work=f.api.preview(request);void work.catch(()=>{});await atHash;
  const queued=f.api.preview({...request,commandId:randomUUID()});void queued.catch(()=>{});await assert.rejects(f.api.preview({...request,commandId:randomUUID()}),rejectsIssue('BUDGET_EXCEEDED'));
  await assert.rejects(work,rejectsIssue('BUDGET_EXCEEDED'));await assert.rejects(queued,rejectsIssue('BUDGET_EXCEEDED'));
  let closed=false;const closing=f.api.close().then(()=>{closed=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(physicalResourceLocks.snapshot().resources,1);
  release();await closing;assert.equal(closed,true);assert.equal(physicalResourceLocks.snapshot().resources,0);assert.equal(f.repository.localCatalog.privateReceiptRequest(request.commandId),null);
});

test('014 历史 binding 快照：同 bindingId 改 locator 后冷开保留旧鉴证，当前确认拒旧 context',async t=>{
  const f=await exact(t),p=await f.api.preview(f.request()),command=executeLegacy(p),active=await f.api.confirm(command),old=structuredClone(f.binding);
  await rename(f.file,path.join(f.sourcePath,'新路径.wav'));
  // 原 store 的合法同ID换 locator 用于自建来源输入；不是改写冻结 Master/Prepared JSON。
  const job=f.sources.start({commandId:randomUUID(),draftId:f.draft.draftId,trackId:f.draft.trackIds[0]!,rootId:f.root.id,acquisition:'userFileBind',relocateBindingId:old.id},path.join(f.sourcePath,'新路径.wav'));await f.sources.idle();assert.equal(f.sources.job(job.id).job!.state,'completed');
  const current=f.repository.sources.linked(f.draft.draftId,f.draft.trackIds[0]!)!;assert.equal(current.id,old.id);assert.notEqual(current.relative,old.relative);
  await f.api.close();await f.sources.close();await f.versions.close();f.repository.close();const reopened=createCollectionRepository({filePath:f.filePath}),api=createLocalLegacyLinksService({repository:reopened,datasetId:f.datasetId,assertCurrent:()=>{}});f.registerDependentCleanup(async()=>{await api.close();reopened.close();});
  assert.deepEqual(await api.confirm(command),active);assert.equal(api.read(f.read).items.length,1);assert.equal(reopened.sources.binding(old.id).relative,'新路径.wav');
  const stale=await exact(t),unconfirmed=await stale.api.preview(stale.request()),newFile=path.join(stale.sourcePath,'同字节新位置.wav');await copyFile(stale.file,newFile);
  const moved=stale.sources.start({commandId:randomUUID(),draftId:stale.draft.draftId,trackId:stale.draft.trackIds[0]!,rootId:stale.root.id,acquisition:'userFileBind',relocateBindingId:stale.binding.id},newFile);await stale.sources.idle();assert.equal(stale.sources.job(moved.id).job!.state,'completed');
  const updated=stale.repository.sources.linked(stale.draft.draftId,stale.draft.trackIds[0]!)!;assert.equal(updated.id,stale.binding.id);assert.equal(updated.evidence.sha256,stale.binding.evidence.sha256);assert.notEqual(updated.relative,stale.binding.relative);
  const rejected=await stale.api.confirm(executeLegacy(unconfirmed));assert.equal(rejected.outcome,'rejected');assert.equal(rejected.issue,'SOURCE_CHANGED');assert.equal(stale.api.read(stale.read).items.length,0);
});
