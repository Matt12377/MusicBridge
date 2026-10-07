import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import {legacyLinksFixture,executeLegacy,rejectsIssue} from './legacy-links-fixture.js';

test('014 数字专辑独立旧边：无本地位置的旧身份不冒充 asset/绑定，原实体边不变',async t=>{
  const f=await legacyLinksFixture(t),metadata={title:'旧数字对象',artist:'旧目录艺人',version:'原版本'};
  const digital=f.repository.links.register(randomUUID(),'a'.repeat(64),metadata,false).digitalId!;
  f.repository.links.link({commandId:randomUUID(),fingerprint:'b'.repeat(64),releaseId:f.release.id,expectedRevision:1,digitalId:digital,relation:'probable',ripFromCdConfirmed:false,reason:'保留原目录关系',origin:'existing-digital',legacyRequest:false});
  const before=f.repository.links.digitalDetail(digital),physical=f.repository.links.physical(f.release.id);
  const request=f.linkRequest();assert.equal(request.intent.action,'link');if(request.intent.action!=='link'||request.intent.choice.kind!=='legacy-edition')throw new Error('夹具应为人工关系');
  request.intent.choice.subject={kind:'digital-album',digitalAlbumId:digital,expectedRevision:before.album.revision};request.intent.choice.expectedSlot={activeLinkId:null,lastTransitionEventId:null};
  const p=await f.api.preview(request),receipt=await f.api.confirm(executeLegacy(p));assert.equal(receipt.outcome,'applied');assert.equal(receipt.link!.endpoints.kind,'legacy-edition');assert.deepEqual(receipt.link!.evidence,{kind:'manual-edition'});assert.doesNotMatch(JSON.stringify(receipt),/sourceBindingId|localTrackId|assetId/);
  assert.deepEqual(f.repository.links.digitalDetail(digital),before);assert.deepEqual(f.repository.links.physical(f.release.id),physical);
  assert.equal(f.api.read({...f.read,selector:{by:'local',key:{kind:'local-edition',localEditionId:f.edition.id}}}).items.length,1);
});

test('014 CAS：发行成员改变不靠父 revision 检出；旧发行 revision 改变拒确认',async t=>{
  for(const change of ['member','release'] as const)await t.test(change,async child=>{
    const f=await legacyLinksFixture(child),p=await f.api.preview(f.linkRequest());
    if(change==='member'){const asset=f.asset(),track=f.repository.localCatalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:null});f.repository.localCatalog.linkEditionTrack({commandId:randomUUID(),editionId:f.edition.id,trackId:track.id,disc:1,trackNumber:1,sequence:1});assert.equal(f.repository.localCatalog.edition(f.edition.id).revision,f.edition.revision);}
    else f.repository.links.absence({commandId:randomUUID(),target:'digital',id:f.release.id,expectedRevision:1,confirmedAbsent:true,userConfirmed:true},'c'.repeat(64));
    const receipt=await f.api.confirm(executeLegacy(p));assert.equal(receipt.outcome,'rejected');assert.ok(receipt.issue==='REVISION_CHANGED'||receipt.issue==='SOURCE_CHANGED');assert.equal(f.api.read(f.read).items.length,0);
  });
});

test('014 ABA 与 undo：slot 空→占用→空不能用旧 preview，undo 只准最后非undo转换',async t=>{
  const f=await legacyLinksFixture(t),stale=await f.api.preview(f.linkRequest()),active=await f.applied();
  const rev=await f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'制造真实 ABA',intent:{action:'revoke',linkId:active.link!.linkId,expectedLinkRevision:'1'}}),removed=await f.api.revoke(executeLegacy(rev));assert.equal(removed.outcome,'applied');
  const rejected=await f.api.confirm(executeLegacy(stale));assert.equal(rejected.outcome,'rejected');assert.equal(rejected.issue,'LEFT_SLOT_CHANGED');assert.equal(f.api.read(f.read).slot!.activeLinkId,null);
  await assert.rejects(f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'拒绝非最新转换',intent:{action:'undo',linkId:active.link!.linkId,expectedLinkRevision:'2',undoTransitionEventId:active.transitionEventId!}}),rejectsIssue('UNDO_CONFLICT'));
  const undo=await f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'仅撤销最后解除',intent:{action:'undo',linkId:active.link!.linkId,expectedLinkRevision:'2',undoTransitionEventId:removed.transitionEventId!}}),restored=await f.api.undo(executeLegacy(undo));assert.equal(restored.outcome,'applied');
  await assert.rejects(f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'不能把undo再当作被撤销目标',intent:{action:'undo',linkId:active.link!.linkId,expectedLinkRevision:'3',undoTransitionEventId:restored.transitionEventId!}}),rejectsIssue('UNDO_CONFLICT'));
});

test('014 跨共享账本永久 command：原 catalog/新 preview/三执行不能相互换参复用',async t=>{
  const f=await legacyLinksFixture(t),id=randomUUID();f.repository.localCatalog.createEdition({commandId:id,title:'原目录账本占用命令',edition:''});
  await assert.rejects(f.api.preview(f.linkRequest(id)),rejectsIssue('COMMAND_ID_REUSED'));
  const request=f.linkRequest(),p=await f.api.preview(request);assert.throws(()=>f.repository.localCatalog.createEdition({commandId:request.commandId,title:'反向占用命令',edition:''}));
  const confirm=executeLegacy(p),receipt=await f.api.confirm(confirm);assert.equal(receipt.outcome,'applied');
  await assert.rejects(f.api.revoke(confirm),rejectsIssue('COMMAND_ID_REUSED'));await assert.rejects(f.api.confirm({...confirm,contextFingerprint:'f'.repeat(64)}),rejectsIssue('COMMAND_ID_REUSED'));
});

test('014 Hash/action/到期：拒绝 receipt 持久，原已成功回执不被后续状态替换',async t=>{
  let now=Date.parse('2026-10-07T00:00:00.000Z');const f=await legacyLinksFixture(t,{now:()=>now}),p=await f.api.preview(f.linkRequest());
  for(const change of ['hash','action','expired'] as const){const request=executeLegacy(p);if(change==='hash')request.previewHash='0'.repeat(64);if(change==='expired')now+=600000;const result=await (change==='action'?f.api.revoke(request):f.api.confirm(request));assert.equal(result.outcome,'rejected');assert.equal(result.issue,change==='expired'?'PLAN_EXPIRED':'PREVIEW_MISMATCH');assert.deepEqual(await (change==='action'?f.api.revoke(request):f.api.confirm(request)),result);}
  const fresh=await f.api.preview(f.linkRequest()),command=executeLegacy(fresh),active=await f.api.confirm(command),revoke=await f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'解除后仍保存原确认回执',intent:{action:'revoke',linkId:active.link!.linkId,expectedLinkRevision:'1'}});await f.api.revoke(executeLegacy(revoke));assert.deepEqual(await f.api.confirm(command),active);assert.equal(f.api.read(f.read).items[0]!.state,'revoked');
});

test('014 递增时钟：有效人工预览 TTL 精确600000毫秒且可确认',async t=>{
  let clock=Date.parse('2026-10-08T00:00:00.000Z');const f=await legacyLinksFixture(t,{now:()=>++clock});
  const preview=await f.api.preview(f.linkRequest());assert.equal(Date.parse(preview.body.expiresAt)-Date.parse(preview.body.createdAt),600000);
  const receipt=await f.api.confirm(executeLegacy(preview));assert.equal(receipt.outcome,'applied');assert.equal(receipt.link!.state,'active');assert.equal(f.api.read(f.read).items.length,1);
});

test('014 明确 ROLLBACK：beforeCommit 故障无边/无回执；同命令显式重试才执行',async t=>{
  let fail=false;const f=await legacyLinksFixture(t,{beforeCommit:action=>{if(fail&&action==='local-legacy-links:append')throw new Error('自建确定回滚故障');}}),p=await f.api.preview(f.linkRequest()),command=executeLegacy(p);fail=true;
  await assert.rejects(f.api.confirm(command),rejectsIssue('INVENTORY_UNAVAILABLE'));assert.equal(f.api.read(f.read).items.length,0);assert.equal(f.repository.localCatalog.privateLegacyLinksRead(v=>v.receipt(command.commandId,'x'.repeat(64))),null);
  fail=false;assert.equal((await f.api.confirm(command)).outcome,'applied');
});
