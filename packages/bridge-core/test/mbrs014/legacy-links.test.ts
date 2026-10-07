import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import { preparationFixture } from '../helpers/preparation-fixture.js';
import type { CollectionRepository } from '../../src/collection/repository.js';
import { legacyLinksFixture, rejectsIssue } from './legacy-links-fixture.js';

type Service={preview(r:dto.PreviewLocalLegacyLink):Promise<dto.LocalLegacyLinkPreview>;confirm(r:dto.ExecuteLocalLegacyLink):Promise<dto.LocalLegacyLinkReceipt>;revoke(r:dto.ExecuteLocalLegacyLink):Promise<dto.LocalLegacyLinkReceipt>;undo(r:dto.ExecuteLocalLegacyLink):Promise<dto.LocalLegacyLinkReceipt>;read(r:dto.ReadLocalLegacyLinks):dto.LocalLegacyLinksReadPage;history(r:dto.HistoryLocalLegacyLinks):dto.LocalLegacyLinksHistoryPage;close():Promise<void>};
async function service(repository:CollectionRepository,datasetId:string):Promise<Service>{
  const module=await import('../../src/collection/local-legacy-links-service.js').catch(()=>null);
  assert.ok(module&&typeof module.createLocalLegacyLinksService==='function','唯一 Owner 必须提供真实六命令关联服务');
  return module.createLocalLegacyLinksService({repository,datasetId,assertCurrent:()=>{}});
}
const execute=(p:dto.LocalLegacyLinkPreview):dto.ExecuteLocalLegacyLink=>({datasetId:p.datasetId,commandId:randomUUID(),previewId:p.previewId,expectedPreviewRevision:'1',previewHash:p.previewHash,contextFingerprint:p.contextFingerprint,userConfirmed:true});

test('014 人工发行关系：无 DigitalAlbum/Roon 也能预览确认，解除/undo 只追加边',async t=>{
  const f=await preparationFixture(t),datasetId=randomUUID(),api=await service(f.repository,datasetId);f.registerDependentCleanup(()=>api.close());
  const release=f.repository.music.saveRelease({commandId:randomUUID(),release:{format:'cd',title:'合成商业发行',artist:'合成艺人',tracks:[{title:'合成曲目',artist:'',position:1}],quantity:1,completeness:'basic'}});
  const edition=f.repository.localCatalog.createEdition({commandId:randomUUID(),title:'独立本地发行',edition:'版本一'});
  const read={datasetId,selector:{by:'legacy' as const,key:{kind:'physical-release' as const,physicalReleaseId:release.id}},state:'all' as const,cursor:null,limit:20};
  const initial=api.read(read);assert.deepEqual(initial.slot,{activeLinkId:null,lastTransitionEventId:null});assert.equal(initial.items.length,0);
  const before=f.repository.links.physical(release.id);
  const request:dto.PreviewLocalLegacyLink={datasetId,commandId:randomUUID(),reason:'核对实体发行与本地版本',intent:{action:'link',choice:{kind:'legacy-edition',subject:{kind:'physical-release',physicalReleaseId:release.id,expectedRevision:before.revision},localEditionId:edition.id,expectedEditionRevision:edition.revision,expectedSlot:initial.slot!}}};
  const p=await api.preview(request);assert.equal(api.read(read).items.length,0);assert.deepEqual(await api.preview(request),p);
  const confirmedRequest=execute(p),receipt=await api.confirm(confirmedRequest);assert.equal(receipt.outcome,'applied');assert.equal(receipt.link?.state,'active');assert.deepEqual(await api.confirm(confirmedRequest),receipt);
  const revokedPreview=await api.preview({datasetId,commandId:randomUUID(),reason:'仅解除本地关系',intent:{action:'revoke',linkId:receipt.link!.linkId,expectedLinkRevision:receipt.link!.revision}});
  const revoked=await api.revoke(execute(revokedPreview));assert.equal(revoked.link!.revision,'2');
  const undo=await api.preview({datasetId,commandId:randomUUID(),reason:'撤销刚才解除',intent:{action:'undo',linkId:revoked.link!.linkId,expectedLinkRevision:'2',undoTransitionEventId:revoked.transitionEventId!}});
  const restored=await api.undo(execute(undo));assert.equal(restored.link!.revision,'3');assert.equal(restored.link!.state,'active');
  assert.deepEqual(f.repository.links.physical(release.id),before);assert.equal(api.history({datasetId,linkId:receipt.link!.linkId,cursor:null,limit:20}).items.length,3);
});

test('014 真实 repository 错误：重复 command 变参保留闭集 issue，不被旧 guarded 泛化',async t=>{
  const f=await legacyLinksFixture(t),request=f.linkRequest();await f.api.preview(request);
  await assert.rejects(f.api.preview({...request,reason:'同一命令改成不同原因'}),rejectsIssue('COMMAND_ID_REUSED'));
  await assert.rejects(f.api.preview({...f.linkRequest(),datasetId:randomUUID()}),rejectsIssue('DATASET_SCOPE_MISMATCH'));
  const altered=f.linkRequest();if(altered.intent.action!=='link')throw new Error('夹具应是 link');altered.intent.choice.expectedSlot.lastTransitionEventId=randomUUID();
  await assert.rejects(f.api.preview(altered),rejectsIssue('LEFT_SLOT_CHANGED'));
});
