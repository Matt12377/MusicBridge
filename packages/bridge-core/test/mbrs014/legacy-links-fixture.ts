import assert from 'node:assert/strict';
import type test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as dto from '@music-bridge/contracts';
import { preparationFixture } from '../helpers/preparation-fixture.js';
import { createLocalLegacyLinksService } from '../../src/collection/local-legacy-links-service.js';

export async function legacyLinksFixture(t:test.TestContext,options:Parameters<typeof preparationFixture>[1]&{now?:()=>number;afterHash?:()=>Promise<void>;ioDeadlineMs?:number}={}) {
  const f=await preparationFixture(t,options),datasetId=randomUUID();
  const api=createLocalLegacyLinksService({repository:f.repository,datasetId,assertCurrent:()=>{},...(options.now?{now:options.now}:{}),...(options.afterHash?{afterHash:options.afterHash}:{}),...(options.ioDeadlineMs?{ioDeadlineMs:options.ioDeadlineMs}:{})});
  f.registerDependentCleanup(()=>api.close());
  const release=f.repository.music.saveRelease({commandId:randomUUID(),release:{format:'cd',title:'自建实体发行',artist:'合成艺人',tracks:[{title:'自建曲目',artist:'',position:1}],quantity:1,completeness:'basic'}});
  const edition=f.repository.localCatalog.createEdition({commandId:randomUUID(),title:'自建本地发行',edition:'版本一'});
  const read:dto.ReadLocalLegacyLinks={datasetId,selector:{by:'legacy',key:{kind:'physical-release',physicalReleaseId:release.id}},state:'all',cursor:null,limit:20};
  const linkRequest=(commandId=randomUUID()):dto.PreviewLocalLegacyLink=>({datasetId,commandId,reason:'人工审查自建实体版本',intent:{action:'link',choice:{kind:'legacy-edition',subject:{kind:'physical-release',physicalReleaseId:release.id,expectedRevision:f.repository.links.physical(release.id).revision},localEditionId:edition.id,expectedEditionRevision:edition.revision,expectedSlot:api.read(read).slot!}}});
  const asset=()=>{const root=f.repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:f.root.id,role:'library'});return f.repository.localCatalog.registerAsset({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision,relative:'fixture.wav',sampleFrames:'44101',timebaseHz:44100,sha256:null});};
  const applied=async()=>{const p=await api.preview(linkRequest()),receipt=await api.confirm(executeLegacy(p));assert.equal(receipt.outcome,'applied');return receipt;};
  return {...f,datasetId,api,release,edition,read,linkRequest,applied,asset};
}
export const executeLegacy=(p:dto.LocalLegacyLinkPreview,commandId=randomUUID()):dto.ExecuteLocalLegacyLink=>({datasetId:p.datasetId,commandId,previewId:p.previewId,expectedPreviewRevision:'1',previewHash:p.previewHash,contextFingerprint:p.contextFingerprint,userConfirmed:true});
export const rejectsIssue=(issue:dto.LocalLegacyLinksIssue)=>(error:unknown):boolean=>error instanceof Error&&'code'in error&&error.code===issue;
