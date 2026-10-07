import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {audioFixture,loadFreshMetadataReader} from '../helpers/mbrs003-audio-fixtures.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {admitScanFields} from '../../src/collection/local-scan-coordinator.js';
import {isScanPreparedBatch,type ScanPreparedItem,type ScanPreparedBatch} from '../../src/collection/local-scan-store.js';
import {authorizeSourceDirectory,readonlySourceCandidateMetadata} from '../../src/recording/source-files.js';
import {isLocalScanPreparedBatch,isLocalScanCommandPayload} from '@music-bridge/contracts';

function rows(file:string) {
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,34);assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    const data=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>[row.name,db.prepare('SELECT * FROM "'+String(row.name)+'" ORDER BY rowid').all()]);
    return {schema,data};
  } finally {db.close();}
}
test('tagged批重复真实relative在合同与唯一Writer准备提交前拒绝，实体账本receipt及lazy DDL零副作用',async t=>{
  const f=await audioFixture(t),media=path.join(f.directory,'duplicate-media');await mkdir(media,{mode:0o700});await writeFile(path.join(media,'disc.wav'),await f.bytes('core-wav'),{flag:'wx',mode:0o600});
  const file=path.join(f.directory,'duplicate.sqlite'),repo=createCollectionRepository({filePath:file}),datasetId=randomUUID();t.after(()=>repo.close());
  const source=repo.sources.authorize(randomUUID(),await authorizeSourceDirectory(media)),root=repo.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'});
  const created=repo.localScan.start({commandId:randomUUID(),datasetId,libraryRootId:root.id,expectedRootRevision:root.revision,parserVersion:'music-metadata-11.15.0/mbrs003-v1'}).job;
  const running=repo.localScan.resume({commandId:randomUUID(),jobId:created.jobId,expectedRevision:created.jobRevision});
  const observed=await readonlySourceCandidateMetadata(source,'disc.wav'),reader=(await loadFreshMetadataReader()).createMetadataReader();
  let value:Awaited<ReturnType<typeof reader.read>>;
  try {value=await reader.read({root:source,relative:'disc.wav',expectedSignature:observed.signature});} finally {await reader.close();}
  if(value.status!=='ok') assert.fail('必须先由真实WAV Reader读取合法技术事实。');
  const fields=admitScanFields(value.fields);if(fields.status!=='accepted') assert.fail('真实fixture标签必须满足原512字段合同。');
  const item:ScanPreparedItem={relative:'disc.wav',signature:observed.signature,parserVersion:'music-metadata-11.15.0/mbrs003-v1',outcome:'accepted',fields:fields.fields,failureCode:null,reused:false,readFacts:{technical:value.technical,coverEvidence:value.coverEvidence,readEvidence:value.readEvidence}};
  assert.equal(item.readFacts!.technical.container,'WAVE');assert.equal(item.readFacts!.readEvidence.wholeAudioHash,false);assert.equal(item.readFacts!.readEvidence.wholeAudioDecode,false);
  const valid:ScanPreparedBatch={batchId:randomUUID(),jobId:running.jobId,expectedJobRevision:running.jobRevision,checkpointBefore:null,items:[item],frontier:[],completed:true};
  assert.equal(isLocalScanPreparedBatch(valid),true);assert.equal(isScanPreparedBatch(valid),true);
  const tagged={...valid,kind:'cue-sidecars-v1' as const,cueItems:[]};assert.equal(isLocalScanPreparedBatch(tagged),true);assert.equal(isScanPreparedBatch(tagged),true);
  const ordinaryDuplicate={...valid,items:[item,{...item}]};assert.equal(isLocalScanPreparedBatch(ordinaryDuplicate),false);assert.equal(isScanPreparedBatch(ordinaryDuplicate),false);
  const duplicate={...tagged,items:[item,{...item}]},request={commandId:randomUUID(),jobId:running.jobId,batch:duplicate};
  const before=rows(file);assert.equal(repo.localCatalog.pageTracks({offset:0,limit:200}).total,0);assert.deepEqual(repo.localScan.privatePreparedBatches(running.jobId),[]);
  // 首个目标只对新tagged分支：不能绕过原音频relative唯一性约束。
  assert.equal(isLocalScanPreparedBatch(duplicate),false,'tagged音频批也必须拒绝重复relative');
  assert.equal(isLocalScanCommandPayload('localScan.prepareBatch',request),false);assert.equal(isScanPreparedBatch(duplicate),false);
  assert.throws(()=>repo.localScan.privatePrepareBatch(request));assert.deepEqual(rows(file),before);
  assert.throws(()=>repo.localScan.privateCommitBatch({commandId:randomUUID(),jobId:running.jobId,batchId:duplicate.batchId,expectedRevision:running.jobRevision}));assert.deepEqual(rows(file),before);
  assert.deepEqual(repo.localScan.privatePreparedBatches(running.jobId),[]);assert.deepEqual(repo.localScan.get(running.jobId),running);assert.equal(repo.localScan.receipt(request.commandId),null);assert.equal(repo.localCatalog.pageTracks({offset:0,limit:200}).total,0);
  repo.close();const cold=createCollectionRepository({filePath:file});try {assert.deepEqual(cold.localScan.get(running.jobId).progress,{visited:'0',accepted:'0',rejected:'0'});assert.equal(cold.localScan.get(running.jobId).phase,'paused');assert.equal(cold.localCatalog.pageTracks({offset:0,limit:200}).total,0);}finally{cold.close();}
});
