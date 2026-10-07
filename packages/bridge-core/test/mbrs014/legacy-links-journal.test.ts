import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import {legacyLinksFixture,executeLegacy,rejectsIssue} from './legacy-links-fixture.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalLegacyLinksService} from '../../src/collection/local-legacy-links-service.js';
import {LOCAL_LEGACY_LINKS_OPERATION,emptyLegacyLinksProjection,copyLegacyLinksProjection,projectLegacyLinksEvent,readLegacyLinksEvent} from '../../src/collection/local-legacy-links-journal.js';

const domainRows=(db:DatabaseSync)=>db.prepare('SELECT * FROM local_catalog_ledger WHERE operation=? ORDER BY rowid').all(LOCAL_LEGACY_LINKS_OPERATION);
async function reopen(f:Awaited<ReturnType<typeof legacyLinksFixture>>) {
  await f.api.close();await f.sources.close();await f.versions.close();f.repository.close();
  const repository=createCollectionRepository({filePath:f.filePath}),api=createLocalLegacyLinksService({repository,datasetId:f.datasetId,assertCurrent:()=>{}});f.registerDependentCleanup(async()=>{await api.close();repository.close();});return {repository,api};
}

test('014 事件真实预算：合法长中文边形成 >16KiB/<64KiB decision，热写与冷核一致',async t=>{
  const f=await legacyLinksFixture(t),release=f.repository.music.saveRelease({commandId:randomUUID(),release:{format:'cd',title:'长'.repeat(240),artist:'艺'.repeat(240),edition:'版'.repeat(240),tracks:[],quantity:1,completeness:'basic'}}),edition=f.repository.localCatalog.createEdition({commandId:randomUUID(),title:'本'.repeat(512),edition:'地'.repeat(512)});
  const request:dto.PreviewLocalLegacyLink={datasetId:f.datasetId,commandId:randomUUID(),reason:'有界长字段实例',intent:{action:'link',choice:{kind:'legacy-edition',subject:{kind:'physical-release',physicalReleaseId:release.id,expectedRevision:1},localEditionId:edition.id,expectedEditionRevision:'1',expectedSlot:{activeLinkId:null,lastTransitionEventId:null}}}};
  const p=await f.api.preview(request),active=await f.api.confirm(executeLegacy(p)),rev=await f.api.preview({datasetId:f.datasetId,commandId:randomUUID(),reason:'长边解除保存完整前后',intent:{action:'revoke',linkId:active.link!.linkId,expectedLinkRevision:'1'}}),revokeCommand=executeLegacy(rev),removed=await f.api.revoke(revokeCommand);assert.equal(removed.outcome,'applied');
  const db=new DatabaseSync(f.filePath,{readOnly:true});try{const rows=domainRows(db),event=rows.find(row=>row.command_id===revokeCommand.commandId)!;assert.ok(Buffer.byteLength(String(event.request))>16384);assert.ok(Object.values(event).reduce<number>((n,v)=>n+(typeof v==='string'?Buffer.byteLength(v):0),0)<65536);assert.equal(readLegacyLinksEvent(event).kind,'decision');}finally{db.close();}
  const fresh=await reopen(f);assert.deepEqual(await fresh.api.revoke(revokeCommand),removed);assert.equal(fresh.api.history({datasetId:f.datasetId,linkId:active.link!.linkId,cursor:null,limit:20}).items.length,2);
});

test('014 冷恢复：拒绝 receipt/原成功 receipt 全部保留，合法旧端点更新不破坏历史核验',async t=>{
  const f=await legacyLinksFixture(t),p=await f.api.preview(f.linkRequest()),bad={...executeLegacy(p),previewHash:'e'.repeat(64)},rejected=await f.api.confirm(bad),command=executeLegacy(p),active=await f.api.confirm(command);
  f.repository.links.absence({commandId:randomUUID(),id:f.release.id,target:'digital',expectedRevision:1,confirmedAbsent:true,userConfirmed:true},'f'.repeat(64));
  const fresh=await reopen(f);assert.deepEqual(await fresh.api.confirm(bad),rejected);assert.deepEqual(await fresh.api.confirm(command),active);assert.equal(fresh.repository.links.physical(f.release.id).revision,2);
  assert.equal(fresh.api.read(f.read).items.length,1);assert.throws(()=>fresh.api.read({...f.read,datasetId:randomUUID()}),rejectsIssue('DATASET_SCOPE_MISMATCH'));
});

test('014 损坏私有事件：duplicate/noncanonical 文本冷开拒绝且保留损坏字节',async t=>{
  const f=await legacyLinksFixture(t);await f.applied();await f.api.close();await f.sources.close();await f.versions.close();f.repository.close();
  const db=new DatabaseSync(f.filePath);let damaged='';try{const row=domainRows(db)[0]!;damaged=String(row.request).replace('"version":1','"version":0,"version":1');assert.notEqual(damaged,row.request);const sql=String(db.prepare("SELECT sql FROM sqlite_master WHERE name='local_catalog_ledger_no_update'").get()!.sql);db.exec('DROP TRIGGER local_catalog_ledger_no_update');db.prepare('UPDATE local_catalog_ledger SET request=? WHERE command_id=?').run(damaged,String(row.command_id));db.exec(sql);}finally{db.close();}
  const reopened=createCollectionRepository({filePath:f.filePath});try{assert.throws(()=>reopened.list({offset:0,limit:1}));}finally{reopened.close();}
  const preserved=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(String(domainRows(preserved)[0]!.request),damaged);}finally{preserved.close();}
});

test('014 projection 50k/64MiB：不发布预算超限候选，旧12M ledger预算未缩小',async t=>{
  const f=await legacyLinksFixture(t),p=await f.api.preview(f.linkRequest()),db=new DatabaseSync(f.filePath,{readOnly:true});let event;try{event=readLegacyLinksEvent(domainRows(db)[0]!);}finally{db.close();}
  const rows=emptyLegacyLinksProjection();rows.events=new Array(50000);assert.throws(()=>projectLegacyLinksEvent(copyLegacyLinksProjection(rows),event),rejectsIssue('BUDGET_EXCEEDED'));assert.equal(rows.events.length,50000);
  const bytes=emptyLegacyLinksProjection();bytes.canonicalBytes=67108864;assert.throws(()=>projectLegacyLinksEvent(copyLegacyLinksProjection(bytes),event),rejectsIssue('BUDGET_EXCEEDED'));assert.equal(bytes.events.length,0);assert.equal(bytes.links.size,0);assert.equal(p.revision,'1');
  assert.equal(f.repository.localCatalog.edition(f.edition.id).id,f.edition.id);
});

test('014 typed append：Promise callback 不能在同步事务后迟到写；公开 DTO 修改不污染投影',async t=>{
  const f=await legacyLinksFixture(t);await f.applied();const before=f.api.read(f.read);const changed=f.api.read(f.read);changed.items[0]!.state='revoked';assert.deepEqual(f.api.read(f.read),before);
  assert.throws(()=>f.repository.localCatalog.privateLegacyLinksTransaction(async()=>{await Promise.resolve();return true;}));assert.deepEqual(f.api.read(f.read),before);
});
