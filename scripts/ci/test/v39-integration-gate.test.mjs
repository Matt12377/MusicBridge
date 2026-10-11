import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { captureCiReportMirrorStage } from '../verify-ci-report-mirror.mjs';
import { V39_INTEGRATION_BASE, V39_INTEGRATION_BRANCH, V39_INTEGRATION_SOURCE_PARENT,
  V39_INTEGRATION_SOURCE_FILES, V39_INTEGRATION_HISTORICAL_SOURCE_FILES, V39_INTEGRATION_SOURCE_DELTA_FILES,
  V39_INTEGRATION_SOURCE_CORRECTION_IDENTITY, v39IntegrationCanonicalPin, v39IntegrationWorkflowOutputs } from '../v39-integration-admission.mjs';
import { V39_INTEGRATION_SAFETY_CASE_NAMES as names, V39_INTEGRATION_TAPE_TESTS,
  V39_INTEGRATION_REPORT_SKIP, V39_INTEGRATION_GATE_LIMITS, V39_INTEGRATION_EXPORT_ROOT_FILES,
  inspectV39IntegrationGateInputs, inspectV39IntegrationSafetyRaw, inspectV39StandardRaw,
  parseV39IntegrationTap, validateV39IntegrationGateArguments, retainV39StandardVerificationFiles,
  buildV39IntegrationGateSummary } from '../verify-v39-integration.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const require=createRequire(path.join(repository,'packages/bridge-core/package.json'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const role=process.env.V39_INTEGRATION_GATE_ROLE??'source';
const page={offset:0,limit:25};
const yieldTurn=()=>new Promise(resolve=>setImmediate(resolve));
const productOptions={skip:role==='report'?V39_INTEGRATION_REPORT_SKIP:false,timeout:25_000};
function directory() {
  const storage=buildStoragePolicy(),root=storage.check(process.env.TMPDIR,{mustExist:true});
  const result=mkdtempSync(path.join(root,'musicbridge-v39-case-'));storage.check(result,{mustExist:true});return result;
}
function fixtureGit(directory,args,input) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')&&!key.startsWith('GITHUB_')));
  Object.assign(env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',
    GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1'});
  const result=spawnSync('git',['--no-replace-objects','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',
    '-c','commit.gpgsign=false',...args],{cwd:directory,env,input,encoding:'utf8',timeout:10_000,
    killSignal:'SIGKILL',maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe']});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0,String(result.stderr));
  return result.stdout.trim();
}
function fixtureCommit(directory,tree,parents) {
  return fixtureGit(directory,['-c','user.name=MusicBridge CI Fixture','-c','user.email=ci-fixture@example.invalid',
    'commit-tree',tree,...parents.flatMap(parent=>['-p',parent])],'受控Fake Gate变异；不代表真实Source或平台CI\n');
}
async function bounded(promise,label,ms=2000) {
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('合成组合资源未按原预算关闭：'+label)),ms);})]);}
  finally{clearTimeout(timer);}
}
async function modules() {
  return Object.assign({},
    await import('../../../packages/bridge-core/src/collection/dataset-owner-client.ts'),
    await import('../../../packages/bridge-core/src/collection/repository.ts'),
    await import('../../../packages/bridge-core/src/collection/reference-catalog-store.ts'),
    await import('../../../apps/desktop/src/main/cassette-catalog-service.ts'),
    await import('../../../apps/desktop/src/main/command-outbox-executor.ts'),
    await import('../../../apps/desktop/src/main/command-outbox-store.ts'),
    await import('../../../apps/desktop/src/main/command-outbox-service.ts'),
    await import('../../../packages/contracts/src/index.ts'));
}
async function owner(t,dataDirectory,m) {
  const signals=new Int32Array(new SharedArrayBuffer(12)),fatal=[];
  const worker=new Worker(new URL('../../../packages/bridge-core/test/helpers/dataset-owner-domain-fixture.ts',import.meta.url),{
    execArgv:['--import',pathToFileURL(require.resolve('tsx/esm')).href],workerData:{dataDirectory,signals:signals.buffer}});
  const endpoint=m.createDatasetOwnerClient({worker,onFatal:reason=>fatal.push(reason)});
  let closed=false;
  const close=async()=>{
    if(closed)return;const exiting=once(worker,'exit');
    try {await bounded(endpoint.close(),'Owner close');assert.deepEqual(await bounded(exiting,'Owner exit'),[0]);}
    catch(error){if(worker.threadId!==-1)await worker.terminate();throw error;}
    assert.equal(worker.threadId,-1);assert.equal(Atomics.load(signals,2),2);assert.deepEqual(fatal,[]);closed=true;
  };
  t.after(close);
  const identity=await bounded(endpoint.prepare(),'Owner prepare');await bounded(endpoint.commitBoot(),'Owner commitBoot');
  const request=async(command,payload={},scope=identity.datasetId)=>bounded(endpoint.dispatch({version:1,id:randomUUID(),command,payload,expectedDatasetId:scope}),'Owner '+command);
  return{worker,endpoint,signals,identity,request,close};
}
const reference=(id,changes={})=>({referenceId:id,bookId:'synthetic-cassette-book',brand:'合成品牌',series:'',edition:'书中1973标签',
  model:id,iec:'I',era:null,lengths:[],image:{kind:'none'},pages:['12'],notes:'合成组合资料',confidence:'unknown',...changes});
const pack=items=>JSON.stringify({schemaVersion:1,bookId:'synthetic-cassette-book',title:'合成组合资料',sourceVersion:'synthetic-r3',items});
async function publish(request,items,current=null) {
  const rawPack=pack(items),source=await request('referenceCatalog.registerSource',{commandId:randomUUID(),rawPack,packHash:sha(rawPack),userConfirmed:true});
  const command={sourceId:source.id,expectedCurrentRevisionId:current,items,mappings:[]};
  const preview=await request('referenceCatalog.previewRevision',command);
  return request('referenceCatalog.publishRevision',{...command,commandId:randomUUID(),baselineFingerprint:preview.baselineFingerprint,userConfirmed:true});
}
async function syntheticZip(filename) {
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD4YAAAAASUVORK5CYII=','base64');
  const items=[reference('new-a'),reference('new-no-picture')],root='合成组合档案/';
  const files=new Map(),json=(name,value)=>files.set(root+name,Buffer.from(JSON.stringify(value)));
  json('catalog/SOURCEPACK.json',JSON.parse(pack(items)));
  json('catalog/reference_catalog_r3.json',{schema_version:'musicbridge-rich-reference-r3/v1',bookId:items[0].bookId,sourceVersion:'synthetic-r3',
    records:items.map(item=>({...item,lengths:null,production_year_verified:false,all_possible_lengths_known:false,
      asset_ids:item.referenceId==='new-a'?['book-image-a']:[],auxiliary_asset_ids:[],r3_information:{summary_zh:'仅合成完整原文',source_transcriptions:[]}}))});
  json('catalog/primary_images.json',{records:[{referenceId:'new-a',primary_asset_id:'book-image-a',status:'eligible_native_primary_candidate'},
    {referenceId:'new-no-picture',primary_asset_id:null,status:'no_eligible_primary_image'}]});
  json('catalog/images_manifest.json',[{asset_id:'book-image-a',role:'packaging_front',printed_page_label:'12',canonical_reference_ids:['new-a'],
    cutout_path:'assets/cutouts/a.png',wall_512_path:'assets/wall_512/a.png',thumbnail_256_path:'assets/thumbs_256/a.png',sha256:sha(png)}]);
  json('catalog/PRIMARY_RECONCILIATION.json',{remaining_no_primary_cases:[{referenceId:'new-no-picture',reason_label:'合成原书无照片'}]});
  json('photo_upgrade/PHOTO_REFERENCES.json',{records:[]});json('photo_upgrade/DISPLAY_OVERLAY.json',{records:[]});
  for(const name of ['assets/cutouts/a.png','assets/wall_512/a.png','assets/thumbs_256/a.png'])files.set(root+name,png);
  const {ZipFile}=require('yazl'),zip=new ZipFile();for(const[name,bytes]of files)zip.addBuffer(bytes,name,{compress:true});zip.end();
  const chunks=[];for await(const bytes of zip.outputStream)chunks.push(Buffer.from(bytes));const bytes=Buffer.concat(chunks);
  writeFileSync(filename,bytes,{flag:'wx',mode:0o600});return{bytes,sha256:sha(bytes),png};
}
function rows(filename,excludeReferences=false) {
  const db=new DatabaseSync(filename,{readOnly:true,allowExtension:false});
  try{return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row=>String(row.name)).filter(name=>!excludeReferences||!name.startsWith('reference_')).map(name=>{
      assert.match(name,/^[a-zA-Z0-9_]+$/u);return{name,rows:db.prepare('SELECT * FROM "'+name+'"').all().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};});}
  finally{db.close();}
}
async function chainFixture(t) {
  const m=await modules(),root=directory(),dataDirectory=path.join(root,'data');mkdirSync(dataDirectory,{mode:0o700});
  // 仅在本fixture新建的库里预置非空旧个人事实；建立真实Owner后不直写其数据库。
  const seed=m.createCollectionRepository({filePath:path.join(dataDirectory,'collection.v1.sqlite')});let received,copy,release,modelId;
  try{received=seed.receive({commandId:randomUUID(),model:{brand:'旧合成用户品牌',name:'原个人录音磁带',edition:'合成旧版',year:1990,
    format:'cassette',tapeType:'I',identification:'verified'},lengthMinutes:60,quantities:{sealedBlank:0,openedBlank:0,legacyUsed:1,unclassified:0}});
  modelId=received.modelId??seed.list(page).items.find(model=>model.name==='原个人录音磁带')?.id;
  assert.equal(typeof modelId,'string');
  copy=seed.materialize({commandId:randomUUID(),lotId:received.lotId,bucket:'legacyUsed',action:'register-legacy'});
  seed.music.saveLegacy({commandId:randomUUID(),physicalId:copy.physicalId,expectedRevision:1,
    content:{title:'旧合成个人录音',artist:'合成用户资料',tracks:[{title:'旧录音一',artist:'合成用户资料',position:1,side:'A'}],notes:'必须逐行保留'}});
  release=seed.music.saveRelease({commandId:randomUUID(),release:{title:'旧合成实体专辑',artist:'合成艺人',format:'cd',quantity:1,completeness:'basic',tracks:[]}});
  seed.links.link({commandId:randomUUID(),fingerprint:sha('合成既有数字关联'),releaseId:release.id,expectedRevision:1,
    relation:'exact',ripFromCdConfirmed:true,metadata:{title:'旧数字专辑',artist:'合成艺人',year:1990,version:'合成旧版'}});
  seed.music.addPhoto({commandId:randomUUID(),id:release.id,image:{dataUrl:'data:image/jpeg;base64,/9j/2Q==',width:1,height:1}});
  }finally{seed.close();}
  const f=await owner(t,dataDirectory,m);
  let old=await publish(f.request,['old-a','old-b','old-c','old-d'].map(id=>reference(id)));
  for(const[referenceId,status,availability]of [['old-a','confirmed','unknown'],['old-b','candidate','unknown'],['old-c','needs-review','unknown'],['old-d','unmatched','missing']])
    old=await f.request('referenceCatalog.setMatch',{commandId:randomUUID(),revisionId:old.revision.id,expectedMatchVersion:old.matchVersion,
      match:{referenceId,modelId:status==='unmatched'?null:modelId,status,availability},userConfirmed:true});
  const current=await f.request('collectionProgress.current',{revisionId:old.revision.id,page});
  const progress=await f.request('collectionProgress.capture',{commandId:randomUUID(),revisionId:old.revision.id,expectedFingerprint:current.fingerprint,userConfirmed:true});
  const historicProgress=await f.request('collectionProgress.snapshot',{id:progress.id,page});
  const zip=await syntheticZip(path.join(root,'source.zip'));
  const service=m.createCassetteCatalogService({dataDirectory:()=>dataDirectory,chooseArchive:async()=>path.join(root,'source.zip'),request:f.request});
  const mainPreview=await service.pick(),fullPreview=await f.request('referenceCatalog.previewArchive',{
    archiveSha256:zip.sha256,expectedDatasetId:f.identity.datasetId,expectedCurrentRevisionId:old.revision.id});
  assert.equal(m.isCatalogRevisionPreview(fullPreview),true);assert.deepEqual(mainPreview.delta,fullPreview.delta);
  assert.deepEqual(mainPreview.delta.preservedHistory.referenceIds,['old-a','old-b','old-c','old-d']);
  assert.equal(mainPreview.delta.preservedHistory.revisionId,old.revision.id);assert.equal(mainPreview.delta.preservedHistory.snapshotId,old.snapshot.id);
  assert.equal(mainPreview.delta.preservedHistory.matchVersion,old.matchVersion);assert.match(mainPreview.delta.preservedHistory.fingerprint,/^[a-f0-9]{64}$/u);
  const filePath=path.join(dataDirectory,'collection.v1.sqlite'),personalBefore=rows(filePath,true);
  const executor=m.createCommandOutboxExecutor({supervisor:{request:f.request,requestInternal:async()=>assert.fail('没有额外内部写入口'),
    activateRestoredDataset:async()=>assert.fail('没有真实工作库切换')},pick:async()=>({canceled:true,filePaths:[]})});
  const outboxPath=path.join(root,'main-outbox.sqlite'),store=m.createCommandOutboxStore({filePath:outboxPath});
  const outbox=m.createCommandOutboxService({store,currentDataset:async()=>f.identity.datasetId,execute:entry=>executor.execute(entry)});
  t.after(()=>outbox.close());
  const command={datasetId:f.identity.datasetId,command:'referenceCatalog.importArchive',payload:{commandId:randomUUID(),archiveSha256:zip.sha256,
    expectedDatasetId:f.identity.datasetId,expectedCurrentRevisionId:old.revision.id,baselineFingerprint:mainPreview.baselineFingerprint,userConfirmed:true}};
  const submitted=await bounded(outbox.submit(command),'Main outbox import');assert.equal(m.isCatalogRevisionDetail(submitted.result),true);
  assert.equal(submitted.result.currentCounts.unknown,2);assert.equal(submitted.result.currentCounts.owned,0);
  assert.deepEqual((await f.request('referenceCatalog.revision',{id:old.revision.id})).matches,old.matches);
  assert.deepEqual(await f.request('collectionProgress.snapshot',{id:progress.id,page}),historicProgress);
  assert.deepEqual(rows(filePath,true),personalBefore);assert.equal(store.get(submitted.outboxId).state,'succeeded');
  return{...f,m,root,dataDirectory,filePath,old,zip,service,outbox,store,outboxPath,command,submitted,progress,historicProgress,personalBefore};
}

test(names[0],productOptions,async t=>{
  await yieldTurn();const f=await chainFixture(t);
  const allBefore=rows(f.filePath),repeat=await f.outbox.submit(f.command);assert.deepEqual(repeat,f.submitted);assert.deepEqual(rows(f.filePath),allBefore);
  const image=await f.service.image('musicbridge://app/reference-assets/'+f.zip.sha256+'/book-image-a','GET');
  assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),f.zip.png);
  assert.equal((await f.service.image('musicbridge://app/reference-assets/'+f.zip.sha256+'/book-image-a?leak=1','GET')).status,404);
  const foreign=structuredClone(f.command);foreign.datasetId=randomUUID();foreign.payload.expectedDatasetId=foreign.datasetId;foreign.payload.commandId=randomUUID();
  await assert.rejects(f.outbox.submit(foreign),error=>error.code==='OUTBOX_SCOPE_MISMATCH');assert.deepEqual(rows(f.filePath),allBefore);
  await f.outbox.close();await f.close();
  const cold=await owner(t,f.dataDirectory,f.m);assert.equal(cold.identity.datasetId,f.identity.datasetId);
  assert.deepEqual((await cold.request('referenceCatalog.revision',{id:f.old.revision.id})).matches,f.old.matches);
  const coldStore=f.m.createCommandOutboxStore({filePath:f.outboxPath});
  try{assert.equal(coldStore.get(f.submitted.outboxId).state,'succeeded');assert.deepEqual(coldStore.get(f.submitted.outboxId).result,f.submitted.result);}finally{coldStore.close();}
  await cold.close();
});

test(names[1],productOptions,async t=>{
  await yieldTurn();const m=await modules(),root=directory(),filePath=path.join(root,'collection.sqlite');
  const db=new DatabaseSync(filePath);try{db.exec(readFileSync(new URL('../../../packages/bridge-core/test/fixtures/collection-schema16.sql',import.meta.url),'utf8'));}finally{db.close();}
  let repo=m.createCollectionRepository({filePath});t.after(()=>repo?.close());
  const request=async(command,payload)=>({
    'referenceCatalog.registerSource':()=>repo.catalog.registerSource(payload),'referenceCatalog.previewRevision':()=>repo.catalog.previewRevision(payload),
    'referenceCatalog.publishRevision':()=>repo.catalog.publishRevision(payload),
  })[command]();
  const old=await publish(request,[reference('old')]),captured=[];
  for(let n=0;n<3;n++){const current=repo.collectionProgress.current({revisionId:old.revision.id,page});captured.push(repo.collectionProgress.capture({commandId:randomUUID(),revisionId:old.revision.id,expectedFingerprint:current.fingerprint,userConfirmed:true}));}
  const original=DatabaseSync.prototype.prepare;let reads=0;
  const measure=()=>{reads=0;DatabaseSync.prototype.prepare=function(sql){if(/FROM reference_catalog_snapshots\b/isu.test(sql)&&/revision_id=\? AND match_version=\?/u.test(sql))reads++;return original.call(this,sql);};
    try{const result=repo.collectionProgress.snapshots({page});assert.equal(reads,1);return result;}finally{DatabaseSync.prototype.prepare=original;}};
  const baseline=measure();assert.deepEqual(baseline.items,captured.toReversed());assert.deepEqual(measure(),baseline);
  const rawPack=pack([reference('new',{archive:{sha256:sha('合成目录事务绑定'),primaryAssetId:null}})]),input={archiveSha256:sha('合成目录事务绑定'),
    expectedDatasetId:'11111111-1111-7111-8111-111111111111',expectedCurrentRevisionId:old.revision.id};
  const preview=repo.catalog.previewArchiveCatalog(input,rawPack);assert.deepEqual(preview.delta.preservedHistory.referenceIds,['old']);
  repo.catalog.importArchiveCatalog({...input,commandId:randomUUID(),baselineFingerprint:preview.baselineFingerprint,userConfirmed:true},rawPack);
  assert.deepEqual(measure(),baseline);repo.close();repo=m.createCollectionRepository({filePath});assert.deepEqual(measure(),baseline);
  repo.close();repo=undefined;
  const edit=new DatabaseSync(filePath);let raw,trigger,snapshotId;
  try{const original=edit.prepare('SELECT id,data FROM reference_catalog_snapshots WHERE revision_id=? AND match_version=0 ORDER BY rowid LIMIT 1').get(old.revision.id);raw=original.data;snapshotId=original.id;
    trigger=edit.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='reference_catalog_snapshots_no_update'").get().sql;
    edit.exec('DROP TRIGGER reference_catalog_snapshots_no_update');edit.prepare('UPDATE reference_catalog_snapshots SET data=? WHERE id=?').run('{}',snapshotId);edit.exec(trigger);
  }finally{edit.close();}
  const corrupted=m.createCollectionRepository({filePath});
  try{assert.throws(()=>corrupted.collectionProgress.snapshots({page}),/损坏|库存|目录|不可用/u,'下一次冷开后的实际读取不能沿用上次缓存');}
  finally{corrupted.close();}
  const repair=new DatabaseSync(filePath);try{repair.exec('DROP TRIGGER reference_catalog_snapshots_no_update');repair.prepare('UPDATE reference_catalog_snapshots SET data=? WHERE id=?').run(raw,snapshotId);repair.exec(trigger);}finally{repair.close();}
  repo=m.createCollectionRepository({filePath});assert.deepEqual(measure(),baseline);repo.close();repo=undefined;
});

test(names[2],productOptions,async t=>{
  await yieldTurn();const f=await chainFixture(t);await f.outbox.close();await f.close();
  const restore=path.join(f.root,'isolated-restore');mkdirSync(restore,{mode:0o700});
  const sourceFiles=[f.filePath,path.join(f.dataDirectory,'backup-maintenance.v1.sqlite'),f.outboxPath];
  for(const filename of sourceFiles){
    const db=new DatabaseSync(filename,{readOnly:true,allowExtension:false});
    try{await bounded(backup(db,path.join(restore,path.basename(filename))),'真实SQLite backup');}finally{db.close();}
  }
  const restoredFile=path.join(restore,'collection.v1.sqlite');assert.deepEqual(rows(restoredFile),rows(f.filePath));
  const inspection=new DatabaseSync(restoredFile,{readOnly:true,allowExtension:false});
  try{assert.doesNotThrow(()=>f.m.verifyReferenceCatalogDatabase(inspection));assert.doesNotThrow(()=>f.m.verifyReferenceCatalogZipDatabase(inspection));}finally{inspection.close();}
  const restored=f.m.createCollectionRepository({filePath:restoredFile});
  try{assert.deepEqual(restored.catalog.revision({id:f.old.revision.id}).matches,f.old.matches);
    assert.deepEqual(restored.collectionProgress.snapshot({id:f.progress.id,page}),f.historicProgress);assert.deepEqual(rows(restoredFile,true),f.personalBefore);
  }finally{restored.close();}
  const coldOutbox=f.m.createCommandOutboxStore({filePath:path.join(restore,'main-outbox.sqlite')});
  try{assert.deepEqual(coldOutbox.get(f.submitted.outboxId).result,f.submitted.result);}finally{coldOutbox.close();}
  // 真实排他事务能够重新取得三个已关闭数据库；没有把布尔声明当作handle退出。
  for(const filename of [...sourceFiles,...sourceFiles.map(file=>path.join(restore,path.basename(file)))]){
    const db=new DatabaseSync(filename);try{db.exec('PRAGMA busy_timeout=1; BEGIN EXCLUSIVE; ROLLBACK;');}finally{db.close();}
  }
  await assert.rejects(f.endpoint.dispatch({version:1,id:randomUUID(),command:'collection.list',payload:{page},expectedDatasetId:f.identity.datasetId}));
  assert.equal(f.worker.threadId,-1);assert.equal(Atomics.load(f.signals,2),2);
});

function syntheticTap(list,skips=[]) {
  const skip=new Map(skips.map(row=>[row.name,row.reason]));return Buffer.from('TAP version 13\n'+list.map((name,i)=>'ok '+(i+1)+' - '+name+(skip.has(name)?' # SKIP '+skip.get(name):'')).join('\n')
    +'\n1..'+list.length+'\n# tests '+list.length+'\n# suites 0\n# pass '+(list.length-skips.length)+'\n# fail 0\n# cancelled 0\n# skipped '+skips.length+'\n# todo 0\n');
}
test(names[3],async()=>{
  await yieldTurn();const all=V39_INTEGRATION_TAPE_TESTS.flatMap(row=>row.expectedCaseNames);assert.equal(all.length,74);assert.equal(new Set(all).size,74);
  assert.equal(parseV39IntegrationTap(syntheticTap(all),all).counts.pass,74);
  assert.throws(()=>parseV39IntegrationTap(syntheticTap(all.slice(0,-1)),all));
  assert.throws(()=>parseV39IntegrationTap(syntheticTap([...all.slice(0,-1),all[0]]),all));
  assert.throws(()=>parseV39IntegrationTap(syntheticTap(all,[{name:all[0],reason:'不是当前软件PASS'}]),all));
  assert.throws(()=>parseV39IntegrationTap(syntheticTap(all).subarray(0,20),all));
});
test(names[4],async()=>{
  await yieldTurn();const raw=Buffer.from('Core Reader准备阶段：fresh-contracts-compiler\nCore Reader准备阶段：fresh-core-compiler\nCore Reader准备阶段：fresh-fixed-metadata-worker\n'
    +Array.from({length:4},(_,i)=>syntheticTap(['合成标准阶段'+i]).toString('utf8')).join('')+'electron-vite build\nbuilt in 1ms\n');
  assert.equal(inspectV39StandardRaw(raw,[0,0]).tapRuns.length,4);
  const nested = 'TAP version 13\n# Subtest: 合成父测试\n    ok 1 - 合成子一\n    ok 2 - 合成子二\n    1..2\n'
    +'ok 1 - 合成父测试\nok 2 - 合成同层测试\n1..2\n# tests 4\n# suites 0\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  const nestedRaw = Buffer.from(raw.toString('utf8').replace(syntheticTap(['合成标准阶段1']).toString('utf8'),nested));
  const nestedRead = inspectV39StandardRaw(nestedRaw,[0,0]);assert.equal(nestedRead.tapRuns[1].tests,4);assert.equal(nestedRead.totals.tests,7);
  for(const changed of [nested.replace('    1..2\n',''),nested.replace('    1..2\n','    1..1\n'),
    nested.replace('ok 2 - 合成子二','ok 3 - 合成子二'),nested.replace('# tests 4\n','# tests 2\n'),
    nested.replace('    ok 1 - 合成子一','    not ok 1 - 合成子一')])
    assert.throws(()=>inspectV39StandardRaw(Buffer.from(nestedRaw.toString('utf8').replace(nested,changed)),[0,0]));
  for(const exits of [[1,0],[0,1],[0],['0',0]])assert.throws(()=>inspectV39StandardRaw(raw,exits));
  assert.throws(()=>inspectV39StandardRaw(raw.subarray(0,raw.length-25),[0,0]));
  assert.throws(()=>inspectV39StandardRaw(Buffer.alloc(16*1024*1024+1),[0,0]));
  const root=directory(),logPath=path.join(root,'actual-failed-standard.log'),receiptPath=path.join(root,'receipt.json');
  const failedRaw=Buffer.from('合成标准子进程实际失败全原文\nnot ok 1 - 合成失败\n');
  writeFileSync(logPath,failedRaw,{flag:'wx',mode:0o600});
  const missingRoot=path.join(root,'missing-receipt');mkdirSync(missingRoot,{mode:0o700});
  const missing=retainV39StandardVerificationFiles(missingRoot,{logPath,receiptPath},performance.now()+3000);
  assert.deepEqual(readFileSync(path.join(missingRoot,'verify.log')),failedRaw);
  const diagnostic=JSON.parse(readFileSync(path.join(missingRoot,'standard-verification.json'),'utf8'));
  assert.equal(diagnostic.status,'FAILED_CURRENT_SOURCE_STANDARD_VERIFICATION');assert.equal(diagnostic.originalReceiptAvailable,false);
  assert.equal(diagnostic.pipelineExitCodesAttested,false);assert.equal(diagnostic.raw.sha256,sha(failedRaw));
  const failedReceipt=Buffer.from(JSON.stringify({schema:'musicbridge.v39.integration.standard-verification.v1',
    status:'FAILED_CURRENT_SOURCE_STANDARD_VERIFICATION',verifyExit:1,teeExit:0})+'\n');
  writeFileSync(receiptPath,failedReceipt,{flag:'wx',mode:0o600});
  const failedRoot=path.join(root,'failed-receipt');mkdirSync(failedRoot,{mode:0o700});
  const retained=retainV39StandardVerificationFiles(failedRoot,{logPath,receiptPath},performance.now()+3000);
  assert.deepEqual(readFileSync(path.join(failedRoot,'verify.log')),failedRaw);
  assert.deepEqual(readFileSync(path.join(failedRoot,'standard-verification.json')),failedReceipt);
  assert.throws(()=>inspectV39StandardRaw(retained.log.bytes,[retained.receipt.verifyExit,retained.receipt.teeExit]));
  const missingLogRoot=path.join(root,'missing-log');mkdirSync(missingLogRoot,{mode:0o700});
  const missingLog=retainV39StandardVerificationFiles(missingLogRoot,{logPath:path.join(root,'missing.log'),receiptPath},performance.now()+3000);
  assert.equal(missingLog.logFailure,'V39_INTEGRATION_STANDARD_INPUT_MISSING');
  assert.deepEqual(readFileSync(path.join(missingLogRoot,'standard-verification.json')),failedReceipt);
  const summary=buildV39IntegrationGateSummary({sourceBefore:null,sourceAfter:null,freshReader:null,
    standardVerification:{status:'FAILED_CURRENT_SOURCE_STANDARD_VERIFICATION',artifactRaw:missing.artifactRaw,artifactReceipt:missing.artifactReceipt},
    stages:[],temporaryCleanup:null,failureCode:missing.receiptFailure,startedAtMs:1,finishedAtMs:2,durationMs:1,
    artifactFiles:['summary.json','verify.log','standard-verification.json']});
  assert.equal(summary.passed,false);assert.equal(summary.currentSoftwareGateExitCode,1);assert.equal(summary.sourceUnchanged,false);
  assert.equal(summary.standardVerification.artifactRaw.sha256,sha(failedRaw));
});
test(names[5],async()=>{
  await yieldTurn();const root=directory(),base=path.join(root,'new-root');
  assert.equal(validateV39IntegrationGateArguments(['--output-root',base]).outputRoot,base);
  mkdirSync(base,{mode:0o700});assert.throws(()=>validateV39IntegrationGateArguments(['--output-root',base]));
  const alias=path.join(root,'alias');symlinkSync(root,alias);assert.throws(()=>validateV39IntegrationGateArguments(['--output-root',path.join(alias,'child')]));
  assert.throws(()=>validateV39IntegrationGateArguments(['--output-root','/tmp/musicbridge-unowned']));
  assert.throws(()=>validateV39IntegrationGateArguments(['--output-root',path.join(root,'another')],{...process.env,NODE_OPTIONS:'--eval=bad'}));
  assert.throws(()=>validateV39IntegrationGateArguments(['--output-root',path.join(root,'another'),'--standard-verify-log',path.join(root,'missing')]));
  assert.equal(validateV39IntegrationGateArguments(['--output-root',path.join(root,'paired-missing'),
    '--standard-verify-log',path.join(root,'missing.log'),'--standard-verify-receipt',path.join(root,'missing.json')]).standardReceipt,
    path.join(root,'missing.json'));
});
test(names[6],async t=>{
  await yieldTurn();assert.throws(()=>v39IntegrationWorkflowOutputs({task:'V39-INTEGRATION-001',currentProductSoftwareRequired:true,
    exactSourceFiles:40,exactSourceDeltaFiles:10,failedSource1Preserved:true,sourceCorrection:V39_INTEGRATION_SOURCE_CORRECTION_IDENTITY}));
  const deadline=performance.now()+15_000;
  assert.throws(()=>inspectV39IntegrationGateInputs(repository,{...process.env,GITHUB_SHA:'f'.repeat(40)},deadline));
  assert.throws(()=>inspectV39IntegrationGateInputs(repository,process.env,performance.now()-1));
  assert.equal(V39_INTEGRATION_SOURCE_FILES.length,40);assert.equal(V39_INTEGRATION_HISTORICAL_SOURCE_FILES.length,39);
  assert.equal(V39_INTEGRATION_SOURCE_DELTA_FILES.length,10);
  assert.equal(V39_INTEGRATION_SOURCE_FILES.filter(row=>row.status==='A').length,17);
  assert.equal(V39_INTEGRATION_SOURCE_FILES.filter(row=>row.status==='M').length,23);
  assert.deepEqual(V39_INTEGRATION_SOURCE_FILES.filter(row=>!V39_INTEGRATION_HISTORICAL_SOURCE_FILES.some(old=>old.path===row.path)).map(row=>row.path),
    ['packages/bridge-core/test/rust-core-owner-lifecycle.test.ts']);
  for(const row of V39_INTEGRATION_SOURCE_DELTA_FILES){assert.equal(row.status,'M');assert.equal(row.oldMode,'100644');
    assert.equal(row.newMode,'100644');assert.equal(row.before.mode,'100644');assert.match(row.before.blob,/^[a-f0-9]{40}$/u);
    assert.ok(Number.isSafeInteger(row.before.bytes)&&row.before.bytes>0);assert.match(row.before.sha256,/^[a-f0-9]{64}$/u);}
  // 正例来自本次实际冻结Source2或其实际Report；不从dirty WIP制造Source资格。
  const current=inspectV39IntegrationGateInputs(repository,process.env,performance.now()+45_000);
  assert.equal(current.admission.sourceParentSha,V39_INTEGRATION_SOURCE_PARENT);assert.equal(current.admission.exactSourceFiles,40);
  assert.equal(current.admission.exactSourceDeltaFiles,10);assert.equal(current.admission.failedSource1Preserved,true);
  assert.deepEqual(current.admission.sourceCorrection,V39_INTEGRATION_SOURCE_CORRECTION_IDENTITY);
  assert.equal(current.admission.sourceCorrectionSha256,v39IntegrationCanonicalPin(V39_INTEGRATION_SOURCE_CORRECTION_IDENTITY).sha256);
  if(role==='source')assert.equal(current.identity.parent,V39_INTEGRATION_SOURCE_PARENT);
  else assert.equal(current.identity.parent,current.admission.sourceSha);
  const root=directory(),isolated=path.join(root,'source-parent-variants');
  fixtureGit(root,['-c','protocol.file.allow=always','clone','--no-local','--no-hardlinks','--no-checkout','--',repository,isolated]);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')&&!key.startsWith('GITHUB_')));
  const checkout=head=>fixtureGit(isolated,['checkout','-f','-B',V39_INTEGRATION_BRANCH,head,'--']);
  checkout(current.admission.sourceSha);
  assert.equal(fixtureGit(isolated,['rev-list','--parents','-n','1','HEAD']),current.admission.sourceSha+' '+V39_INTEGRATION_SOURCE_PARENT);
  const sourceTree=fixtureGit(isolated,['rev-parse','HEAD^{tree}']);
  const unknownParent=fixtureCommit(isolated,sourceTree,[V39_INTEGRATION_BASE]);
  checkout(fixtureCommit(isolated,sourceTree,[unknownParent]));
  assert.throws(()=>inspectV39IntegrationGateInputs(isolated,env,performance.now()+15_000),error=>/^V39_/u.test(error.code));
  checkout(V39_INTEGRATION_SOURCE_PARENT);
  assert.throws(()=>inspectV39IntegrationGateInputs(isolated,env,performance.now()+15_000),error=>error.code==='V39_INTEGRATION_FAILED_SOURCE1_CANNOT_QUALIFY');
  checkout(current.admission.sourceSha);
  writeFileSync(path.join(isolated,'v39-unreleased-path-41.txt'),'只有合成fixture的越界第41路径\n',{flag:'wx',mode:0o644});
  fixtureGit(isolated,['add','--','v39-unreleased-path-41.txt']);
  checkout(fixtureCommit(isolated,fixtureGit(isolated,['write-tree']),[V39_INTEGRATION_SOURCE_PARENT]));
  assert.throws(()=>inspectV39IntegrationGateInputs(isolated,env,performance.now()+15_000),error=>/^V39_/u.test(error.code));
  assert.equal(fixtureGit(repository,['rev-parse','HEAD']),current.identity.head);
  t.diagnostic('forward真实Source2='+current.admission.sourceSha+'；unknown parent/失败534/第41路径仅在外置Fake Git变异且均拒绝。');
});
test(names[7],{timeout:10_000},async()=>{
  await yieldTurn();const root=directory(),stage=await captureCiReportMirrorStage({directory:repository,outputRoot:root,name:'owned-natural',
    args:['-e','process.stdout.write("合成stdout\\n");process.stderr.write("合成stderr\\n")'],timeoutMs:4000,deadline:performance.now()+5000});
  assert.equal(stage.passed,true);assert.equal(stage.exitObserved,true);assert.equal(stage.closeObserved,true);
  assert.deepEqual(stage.physicalShutdown,{pidAbsent:true,processGroupAbsent:true});assert.equal(stage.rawCaptureComplete,true);
  for(const stream of ['stdout','stderr']){const bytes=readFileSync(path.join(root,stage.raw[stream].path));assert.equal(sha(bytes),stage.raw[stream].sha256);assert.equal(bytes.length,stage.raw[stream].bytes);}
});
test(names[8],{timeout:15_000},async()=>{
  await yieldTurn();const root=directory();
  const timeout=await captureCiReportMirrorStage({directory:repository,outputRoot:root,name:'owned-timeout',args:['-e','setInterval(()=>{},1000)'],timeoutMs:700,deadline:performance.now()+2000});
  assert.equal(timeout.passed,false);assert.equal(timeout.timedOut,true);assert.equal(timeout.terminationRequested,true);assert.equal(timeout.physicalShutdown.pidAbsent,true);
  const overflow=await captureCiReportMirrorStage({directory:repository,outputRoot:root,name:'owned-overflow',args:['-e','process.stdout.write(Buffer.alloc(4096));setInterval(()=>{},1000)'],
    timeoutMs:2000,deadline:performance.now()+3000,maxBytesPerStream:512});assert.equal(overflow.passed,false);assert.equal(overflow.overflow,true);assert.equal(overflow.raw.stdout.bytes,512);
  const pipes=await captureCiReportMirrorStage({directory:repository,outputRoot:root,name:'owned-pipe',args:['-e',
    'const {spawn}=require("node:child_process");spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2],detached:false});setTimeout(()=>process.exit(0),200)'],
    timeoutMs:2000,deadline:performance.now()+3000});assert.equal(pipes.passed,false);assert.equal(pipes.unexpectedPipeHolder,true);
  assert.equal(pipes.physicalShutdown.pidAbsent,true);assert.equal(pipes.physicalShutdown.processGroupAbsent,true);assert.equal(pipes.observedDescendantsAbsent,true);
});
test(names[9],async()=>{
  await yieldTurn();const skipped=names.slice(0,3).map(name=>({name,reason:V39_INTEGRATION_REPORT_SKIP}));
  const report=inspectV39IntegrationSafetyRaw(syntheticTap(names,skipped),'report');assert.equal(report.counts.tests,10);assert.equal(report.counts.pass,7);assert.equal(report.counts.skipped,3);
  assert.throws(()=>inspectV39IntegrationSafetyRaw(syntheticTap(names,skipped),'source'));
  assert.throws(()=>inspectV39IntegrationSafetyRaw(syntheticTap(names),'report'));
  assert.equal(V39_INTEGRATION_GATE_LIMITS.ownerRequestMs,2000);assert.equal(V39_INTEGRATION_GATE_LIMITS.rawBytesPerStream,16*1024*1024);
  assert.equal(V39_INTEGRATION_EXPORT_ROOT_FILES.length,28);assert.equal(new Set(V39_INTEGRATION_EXPORT_ROOT_FILES).size,28);
  assert.ok(!V39_INTEGRATION_EXPORT_ROOT_FILES.some(name=>name.includes('/')||name.includes('*')||name.includes('tmp')));
  for(const repairRole of ['source','report']){
    const input={identity:{head:'f'.repeat(40)},admission:{repairRole,sourceSha:'e'.repeat(40),
      sourceParentSha:V39_INTEGRATION_SOURCE_PARENT,sourceCorrection:V39_INTEGRATION_SOURCE_CORRECTION_IDENTITY,
      sourceCorrectionSha256:v39IntegrationCanonicalPin(V39_INTEGRATION_SOURCE_CORRECTION_IDENTITY).sha256,failedSource1Preserved:true}};
    const summary=buildV39IntegrationGateSummary({sourceBefore:input,sourceAfter:input,freshReader:null,standardVerification:null,
      stages:[],temporaryCleanup:null,failureCode:'V39_INTEGRATION_CONTROLLED_SHAPE_NOT_CURRENT_SOFTWARE_PASS',
      startedAtMs:1,finishedAtMs:2,durationMs:1,artifactFiles:['summary.json']});
    assert.equal(summary.baseSha,V39_INTEGRATION_BASE);assert.equal(summary.sourceParentSha,V39_INTEGRATION_SOURCE_PARENT);
    assert.deepEqual(summary.sourceCorrection,input.admission.sourceCorrection);
    assert.equal(summary.sourceCorrectionSha256,input.admission.sourceCorrectionSha256);assert.equal(summary.failedSource1Preserved,true);
    assert.equal(summary.passed,false);assert.equal(summary.currentSoftwareGateExitCode,1);
    assert.equal(summary.expectedRegisteredTests,repairRole==='source'?277:203);
    assert.equal(summary.expectedPassedTests,repairRole==='source'?277:200);assert.equal(summary.expectedSkippedTests,repairRole==='source'?0:3);
  }
});
