import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {legacyLinksFixture,executeLegacy,rejectsIssue} from './legacy-links-fixture.js';
import {createLocalLegacyLinksService} from '../../src/collection/local-legacy-links-service.js';

test('014 cursor 快照：新 append 不改变旧页水位、边状态或 slot',async t=>{
  const f=await legacyLinksFixture(t),first=await f.applied();
  const revoke=await f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'生成旧边历史',intent:{action:'revoke',linkId:first.link!.linkId,expectedLinkRevision:'1'}});await f.api.revoke(executeLegacy(revoke));
  const second=await f.applied(),request={...f.read,limit:1},page=f.api.read(request);assert.equal(page.hasMore,true);assert.ok(page.cursor);
  const latest=await f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'水位之后再解除',intent:{action:'revoke',linkId:second.link!.linkId,expectedLinkRevision:'1'}});await f.api.revoke(executeLegacy(latest));await f.applied();
  const next=f.api.read({...request,cursor:page.cursor}),all=[...page.items,...next.items];assert.equal(next.snapshotFingerprint,page.snapshotFingerprint);assert.deepEqual(next.slot,page.slot);assert.equal(next.hasMore,false);
  assert.deepEqual(new Set(all.map(x=>x.linkId)),new Set([first.link!.linkId,second.link!.linkId]));assert.equal(all.find(x=>x.linkId===second.link!.linkId)!.state,'active');
  assert.equal(f.api.read(f.read).items.length,3);
});

test('014 cursor 作用域/TTL/128个容量：无静默空页，关闭清理后新服务不能复用旧 token',async t=>{
  let now=Date.parse('2026-10-07T00:00:00.000Z');const f=await legacyLinksFixture(t,{now:()=>now}),active=await f.applied();
  const rev=await f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'生成两页历史',intent:{action:'revoke',linkId:active.link!.linkId,expectedLinkRevision:'1'}});await f.api.revoke(executeLegacy(rev));
  const request={datasetId:f.datasetId,linkId:active.link!.linkId,cursor:null,limit:1},first=f.api.history(request);assert.ok(first.cursor);
  assert.throws(()=>f.api.history({...request,limit:2,cursor:first.cursor}),rejectsIssue('CURSOR_SCOPE_MISMATCH'));
  for(let i=1;i<128;i++)assert.ok(f.api.history(request).cursor);assert.throws(()=>f.api.history(request),rejectsIssue('BUDGET_EXCEEDED'));
  now+=600000;assert.throws(()=>f.api.history({...request,cursor:first.cursor}),rejectsIssue('CURSOR_EXPIRED'));const live=f.api.history(request);assert.ok(live.cursor);
  await f.api.close();const fresh=createLocalLegacyLinksService({repository:f.repository,datasetId:f.datasetId,assertCurrent:()=>{},now:()=>now});f.registerDependentCleanup(()=>fresh.close());
  assert.throws(()=>fresh.history({...request,cursor:live.cursor}),rejectsIssue('CURSOR_EXPIRED'));assert.ok(fresh.history(request).cursor);
});

test('014 增量 ledger 512 上限：超界阻关系读，旧目录仍可用；明确冷开重投影恢复',async t=>{
  const f=await legacyLinksFixture(t);await f.applied();
  for(let i=0;i<513;i++)f.repository.localCatalog.createEdition({commandId:randomUUID(),title:`保留旧功能 ${i}`,edition:''});
  assert.throws(()=>f.api.read(f.read),rejectsIssue('BUDGET_EXCEEDED'));assert.equal(f.repository.localCatalog.edition(f.edition.id).title,f.edition.title);
  await f.api.close();await f.sources.close();await f.versions.close();f.repository.close();
  const {createCollectionRepository}=await import('../../src/collection/repository.js'),{createLocalLegacyLinksService}=await import('../../src/collection/local-legacy-links-service.js');
  const reopened=createCollectionRepository({filePath:f.filePath}),api=createLocalLegacyLinksService({repository:reopened,datasetId:f.datasetId,assertCurrent:()=>{}});f.registerDependentCleanup(async()=>{await api.close();reopened.close();});
  assert.equal(api.read(f.read).items.length,1);
});
