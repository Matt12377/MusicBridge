import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {lstat} from 'node:fs/promises';
import * as dto from '@music-bridge/contracts';
import {legacyLinksFixture,executeLegacy,rejectsIssue} from './legacy-links-fixture.js';
import {SourcePublicationUnverified} from '../../src/recording/source-files.js';
import {physicalResourceLocks,PhysicalResourceBusy} from '../../src/stream/physical-resource-locks.js';
import {LOCAL_LEGACY_LINKS_OPERATION,readLegacyLinksEvent} from '../../src/collection/local-legacy-links-journal.js';

test('014 exact 未知 COMMIT：确认已真实落账而回报丢失，保留 FD/claim、零伪 rejected/释放',async t=>{
  let armed=false,inject=false;const original=DatabaseSync.prototype.exec;
  const f=await legacyLinksFixture(t,{beforeCommit:action=>{if(armed&&action==='local-legacy-links:append')inject=true;}}),asset=f.asset(),track=f.repository.localCatalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:null}),root=f.repository.localCatalog.root(asset.libraryRootId),binding=f.repository.sources.linked(f.draft.draftId,f.draft.trackIds[0]!)!;
  const request:dto.PreviewLocalLegacyLink={datasetId:f.datasetId,commandId:randomUUID(),reason:'自建未知提交故障',intent:{action:'link',choice:{kind:'draft-source-track',draftId:f.draft.draftId,draftTrackId:f.draft.trackIds[0]!,expectedDraftRevision:f.repository.drafts.detail(f.draft.draftId).revision,sourceBindingId:binding.id,localTrackId:track.id,assetId:asset.id,expectedSelectionRevision:track.selectionRevision,expectedLibraryRootRevision:root.revision,expectedFileRevision:asset.fileRevision,expectedLocationRevision:asset.locationRevision,expectedSegment:null,expectedSlot:{activeLinkId:null,lastTransitionEventId:null}}}},p=await f.api.preview(request),command=executeLegacy(p);
  DatabaseSync.prototype.exec=function(sql:string){if(inject&&sql==='COMMIT'){inject=false;original.call(this,sql);throw new Error('自建 COMMIT 回报丢失');}return original.call(this,sql);};
  let retained:SourcePublicationUnverified|undefined;armed=true;
  try{
    await assert.rejects(f.api.confirm(command),rejectsIssue('RECOVERY_REQUIRED'));
    try{await f.api.close();}catch(error){assert.ok(error instanceof SourcePublicationUnverified);retained=error;}
    assert.ok(retained);assert.equal(retained.reason,'COMMIT_UNVERIFIED');assert.equal(retained.claims!.state,'unverified');
    const stat=await lstat(f.file,{bigint:true});assert.throws(()=>physicalResourceLocks.acquireWrite([{dev:String(stat.dev),ino:String(stat.ino)}]),PhysicalResourceBusy);await assert.rejects(retained.claims!.release());
    await assert.rejects(f.api.confirm(command),rejectsIssue('RECOVERY_REQUIRED'));
    const db=new DatabaseSync(f.filePath,{readOnly:true});try{const row=db.prepare('SELECT * FROM local_catalog_ledger WHERE operation=? AND command_id=?').get(LOCAL_LEGACY_LINKS_OPERATION,command.commandId)!;const event=readLegacyLinksEvent(row);assert.equal(event.kind,'decision');if(event.kind==='decision'){assert.equal(event.receipt.outcome,'applied');assert.equal(event.transition!.action,'confirmed');}assert.equal(db.prepare('SELECT count(*) n FROM local_catalog_ledger WHERE command_id=?').get(command.commandId)!.n,1);}finally{db.close();}
  }finally{
    DatabaseSync.prototype.exec=original;
    // 自建测试直接对账确认COMMIT，只收口实际FD；产品未核claim仍留到隔离进程退出。
    if(retained)for(const file of retained.files)await file.handle.close();
    const close=f.api.close;f.api.close=async()=>{try{await close();}catch(error){if(error!==retained)throw error;}};
  }
});
