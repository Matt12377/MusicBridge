import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,stat,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {buildStoragePolicy} from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import {audioFixture,loadFreshMetadataReader} from '../helpers/mbrs003-audio-fixtures.js';
import {createCollectionRepository,type CollectionRepository} from '../../src/collection/repository.js';
import {createLocalScanCoordinator} from '../../src/collection/local-scan-coordinator.js';
import {createScanReadAdmission} from '../../src/library/scan-read-admission.js';
import type {DatasetProjectionPort,DatasetProjectionCommand,DatasetProjectionCommandPayloads,DatasetProjectionCommandResults} from '../../src/collection/dataset-owner-protocol.js';
import {authorizeSourceDirectory} from '../../src/recording/source-files.js';
import {createArchiveBackup,verifyArchiveBackup} from '../../src/recording/backup-package.js';
import {readBackupIndex} from '../../src/recording/backup-index.js';
import {isolateRestoredDatabase,verifyRestoredDatabaseIsolation} from '../../src/recording/restore-database.js';
import {createBackupWorkflowStore} from '../../src/recording/backup-workflow-store.js';
import {createBackupCoordinator} from '../../src/recording/backup-coordinator.js';
import {prepareRestoredDataset} from '../../src/recording/restore-activation-files.js';
import {openCollectionDataset} from '../../src/recording/restore-dataset-runtime.js';

async function freshCueReader():Promise<typeof import('../../src/library/cue-sidecar-reader.js')> {
  assert.equal(process.versions.node.split('.')[0],'22');
  const declaration=process.env.MBRS003_CUE_BUILD_BINDING;assert.ok(declaration && path.isAbsolute(declaration),'root须提供实际fresh CUE编译身份');
  buildStoragePolicy().check(declaration,{mustExist:true,kind:'file'});
  const binding=JSON.parse(await readFile(declaration,'utf8')) as {schema:string;compilerExit:number;compilerStartedAtMs:number;compilerFinishedAtMs:number;sourceInputs:{file:string;bytes:number;sha256:string}[];outputs:{file:string;bytes:number;sha256:string}[]};
  assert.equal(binding.schema,'mbrs003.cue.fresh-build.v1');assert.equal(binding.compilerExit,0);
  assert.ok(binding.compilerStartedAtMs>0 && binding.compilerFinishedAtMs>=binding.compilerStartedAtMs);assert.equal(binding.sourceInputs.length,2);assert.equal(binding.outputs.length,4);
  const coreRoot=fileURLToPath(new URL('../../',import.meta.url));
  assert.deepEqual(binding.sourceInputs.map(v=>v.file).sort(),['src/library/cue-sidecar-reader.ts','src/library/cue-sidecar-worker.ts']);
  for(const entry of [...binding.sourceInputs,...binding.outputs]) {
    assert.match(entry.file,/^(src|dist)\/library\/cue-sidecar-(reader|worker)\.(ts|js|js.map)$/u);
    const bytes=await readFile(path.join(coreRoot,entry.file));assert.equal(bytes.length,entry.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);
    if(entry.file.startsWith('dist/')) assert.ok((await stat(path.join(coreRoot,entry.file))).mtimeMs>=binding.compilerStartedAtMs && (await stat(path.join(coreRoot,entry.file))).mtimeMs<=binding.compilerFinishedAtMs);
  }
  const expected=['cue-sidecar-reader','cue-sidecar-worker'].flatMap(n=>['.js','.js.map'].map(s=>'dist/library/'+n+s));
  assert.deepEqual(binding.outputs.map(v=>v.file).sort(),expected.sort());
  for(const stem of ['reader','worker']) {
    const js='dist/library/cue-sidecar-'+stem+'.js',map=JSON.parse(await readFile(path.join(coreRoot,js+'.map'),'utf8')) as {file:string;sourceRoot:string;sources:string[]};
    assert.equal(map.file,path.basename(js));assert.equal(map.sourceRoot,'');assert.equal(map.sources.length,1);assert.equal(path.resolve(path.dirname(path.join(coreRoot,js)),map.sources[0]!),path.join(coreRoot,'src/library/cue-sidecar-'+stem+'.ts'));
  }
  const actual=await import(pathToFileURL(path.join(coreRoot,'dist/library/cue-sidecar-reader.js')).href) as typeof import('../../src/library/cue-sidecar-reader.js');
  assert.equal(typeof actual.createCueSidecarReader,'function','PREPARATION_FAILED: 必须有实际compiled reader export');return actual;
}
function projection(datasetId:string) {
  let busy=false;const context={datasetId,epoch:randomUUID()},admission=createScanReadAdmission({isBusy:()=>busy});
  const port:DatasetProjectionPort={async call<K extends DatasetProjectionCommand>(command:K,payload:DatasetProjectionCommandPayloads[K]):Promise<DatasetProjectionCommandResults[K]> {
    let result:unknown;
    if(command === 'scanReadAcquire') result=admission.acquire(context);
    else if(command === 'scanReadWatchRevocation') result=await admission.watchRevocation(context,(payload as {permitId:string}).permitId);
    else if(command === 'scanReadRelease') result=admission.release(context,(payload as {permitId:string}).permitId);
    else throw new Error('只接实际scanRead admission。');return result as DatasetProjectionCommandResults[K];
  }};return {port,admission,busy(value:boolean){busy=value;admission.observe();}};
}

const cueText='TITLE "备份声明专辑"\nFILE "disc.wav" WAVE\n TRACK 01 AUDIO\n INDEX 00 00:01:00\n INDEX 01 00:01:01\n TRACK 02 AUDIO\n INDEX 01 00:02:00\n';
async function seed(t:test.TestContext) {
  const f=await audioFixture(t),media=path.join(f.directory,'cue-backup-media');await mkdir(media,{mode:0o700});
  await writeFile(path.join(media,'disc.cue'),cueText,{flag:'wx',mode:0o600});
  await writeFile(path.join(media,'disc.wav'),await f.bytes('core-wav'),{flag:'wx',mode:0o600});
  const opened=await openCollectionDataset(f.directory),repo=opened.repository;
  t.after(()=>opened.close());
  const source=repo.sources.authorize(randomUUID(),await authorizeSourceDirectory(media));
  const root=repo.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'});
  // 无真实CUE发现前，新的32库仍只有原五张扫描表。
  assert.equal(databaseFacts(opened.databaseFile).tables.length,116);
  const p=projection(opened.datasetId),coordinator=createLocalScanCoordinator({repository:repo,datasetId:opened.datasetId,assertCurrent:()=>opened.assertIdentity(),projection:p.port,
    reader:(await loadFreshMetadataReader()).createMetadataReader(),cueReader:(await freshCueReader()).createCueSidecarReader()});
  try {
    const job=coordinator.start({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision});
    await coordinator.privateWait(job.jobId);assert.equal(coordinator.get(job.jobId).phase,'completed');
    assert.deepEqual(coordinator.get(job.jobId).progress,{visited:'2',accepted:'2',rejected:'0'});
  } finally {await coordinator.close();p.admission.close();}
  assert.equal(p.admission.resourceCounts().permits,0);
  const snapshot=repo.localScan.privateCueSnapshot(root.id,'disc.cue');assert.ok(snapshot && snapshot.item.result);
  const tracks=repo.localCatalog.pageTracks({offset:0,limit:200}).items;assert.equal(tracks.length,1);
  const track=tracks[0]!;assert.equal(track.segment,null);
  const asset=repo.localCatalog.asset(track.assetId);assert.equal(repo.localCatalog.privateAssetHasExactEvidence(asset.id),false);assert.equal(asset.sampleFrames,null);assert.equal(asset.timebaseHz,null);
  const raw=repo.localCatalog.observeMetadata({commandId:randomUUID(),trackId:track.id,source:'synthetic',parserVersion:'backup-fixture-1',fields:{title:'备份原始标题',artist:'备份原始艺人'}});
  const overrideCommand=randomUUID(),override=repo.localCatalog.overrideMetadata({commandId:overrideCommand,trackId:track.id,expectedRevision:null,fields:{title:'备份人工标题'}});
  const metadata=repo.localCatalog.metadata(track.id),observations=repo.localCatalog.observations(track.id),receipt=repo.localCatalog.receipt(overrideCommand);
  assert.equal(metadata.raw.title,raw.fields.title);assert.equal(metadata.effective.title,'备份人工标题');
  const facts=databaseFacts(opened.databaseFile);assert.equal(facts.version,32);assert.equal(facts.tables.length,118);
  assert.deepEqual(facts.tables.filter(v=>v.name.startsWith('local_cue_')).map(v=>[v.name,v.rows.length]),[['local_cue_sources',1],['local_cue_tracks',2]]);
  assert.ok(facts.tables.find(v=>v.name==='local_catalog_ledger')!.rows.length>0);
  assert.ok(facts.tables.find(v=>v.name==='local_scan_receipts')!.rows.length>0);
  assert.equal(snapshot.item.result.tracks[0]!.index00Frames,75);assert.equal(snapshot.item.result.tracks[0]!.index01Frames,76);assert.equal(snapshot.item.result.tracks[1]!.index01Frames,150);
  for(const declaration of snapshot.item.result.tracks) {assert.equal(declaration.timebase,'cue-cd-frames');assert.equal(declaration.framesPerSecond,75);assert.equal(declaration.endFrames,null);assert.equal(declaration.evidence,'cue-text-declared');assert.equal(declaration.playback,'NOT_VERIFIED');}
  return {...f,opened,repo,media,source,root,track,asset,raw,override,overrideCommand,metadata,observations,receipt,snapshot,facts};
}
// SQLite INTEGER以十进制BigInt保留，REAL/BLOB/TEXT/NULL各有独立标签；不以counts代替旧事实。
function typed(value:unknown):unknown {
  if(value===null) return ['null'];
  if(typeof value==='bigint') return ['integer',value.toString()];
  if(typeof value==='number') return ['real',Object.is(value,-0)?'-0':String(value)];
  if(typeof value==='string') return ['text',value];
  if(value instanceof Uint8Array) return ['blob',Buffer.from(value).toString('hex')];
  assert.fail('非SQLite cell类型');
}
function databaseFacts(file:string) {
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const tables=names.map(row=>{
      const name=String(row.name),quoted='"'+name.replaceAll('"','""')+'"';
      const statement=db.prepare('SELECT * FROM '+quoted+' ORDER BY rowid');statement.setReadBigInts(true);
      return {name,columns:db.prepare('PRAGMA table_xinfo('+quoted+')').all(),rows:statement.all().map(value=>Object.entries(value).map(([column,cell])=>[column,typed(cell)]))};
    });
    return {version:db.prepare('PRAGMA user_version').get()?.user_version,schema,tables};
  } finally {db.close();}
}
function preservedSql(file:string,expected:ReturnType<typeof databaseFacts>,revoked:boolean):void {
  const actual=databaseFacts(file);assert.equal(actual.version,expected.version);assert.deepEqual(actual.schema,expected.schema);
  assert.deepEqual(actual.tables.map(v=>[v.name,v.columns]),expected.tables.map(v=>[v.name,v.columns]));
  // 恢复仅撤销SourceStore当前根许可；其余117张表逐列typedcell/完整行序EXACT。
  assert.deepEqual(actual.tables.filter(v=>v.name!=='source_roots'),expected.tables.filter(v=>v.name!=='source_roots'));
  const table=actual.tables.find(v=>v.name==='source_roots')!,original=expected.tables.find(v=>v.name==='source_roots')!;
  if(!revoked) assert.deepEqual(table,original);
  else {
    assert.equal(table.rows.length,original.rows.length);
    for(let i=0;i<table.rows.length;i++) {
      const before=original.rows[i]!,after=table.rows[i]!;assert.deepEqual(after[0],before[0]);
      assert.equal(after[1]![0],'data');const expectedData=(before[1]![1] as string[])[1]!,actualData=(after[1]![1] as string[])[1]!;
      assert.deepEqual(JSON.parse(actualData),{...JSON.parse(expectedData),authorized:false});
    }
  }
}
function retained(repo:CollectionRepository,f:Awaited<ReturnType<typeof seed>>,revoked:boolean):void {
  assert.deepEqual(repo.localCatalog.root(f.root.id),f.root);assert.deepEqual(repo.localCatalog.asset(f.asset.id),f.asset);
  assert.deepEqual(repo.localCatalog.track(f.track.id),f.track);assert.deepEqual(repo.localCatalog.pageTracks({offset:0,limit:200}).items,[f.track]);
  assert.deepEqual(repo.localCatalog.observations(f.track.id),f.observations);assert.deepEqual(repo.localCatalog.metadata(f.track.id),f.metadata);
  assert.deepEqual(repo.localCatalog.receipt(f.overrideCommand),f.receipt);assert.deepEqual(repo.localScan.privateCueSnapshot(f.root.id,'disc.cue'),f.snapshot);
  assert.deepEqual(repo.sources.root(f.source.id),{...f.source,authorized:!revoked});
  if(revoked) assert.throws(()=>repo.localCatalog.registerAsset({commandId:randomUUID(),libraryRootId:f.root.id,expectedRootRevision:f.root.revision,relative:'new.wav',sha256:null,sampleFrames:null,timebaseHz:null}),/授权/u);
}

test('CUE完整七表32实际备份包核验、隔离恢复与激活冷开保持声明、raw/manual及完整账本',async t=>{
  const f=await seed(t),destinationPath=path.join(f.directory,'cue-backup-packages');await mkdir(destinationPath,{mode:0o700});
  const signal=new AbortController().signal,destination={...await authorizeSourceDirectory(destinationPath),id:randomUUID()};
  // 走正式生产备份包→SQLite backup()→manifest/hash/index校验；非copyFile模拟备份。
  const backup=await createArchiveBackup({repository:f.repo,destination,id:randomUUID(),mode:'metadata',userConfirmed:true,signal});
  assert.deepEqual(await verifyArchiveBackup(backup.directory,signal),backup.manifest);
  assert.equal(backup.manifest.contentIncluded,false);assert.equal(backup.manifest.mode,'metadata');
  const backupFile=path.join(backup.directory.path,'database','collection.sqlite'),backupBytes=await readFile(backupFile);
  assert.equal(backupBytes.length,backup.manifest.database.size);assert.equal(createHash('sha256').update(backupBytes).digest('hex'),backup.manifest.database.sha256);
  preservedSql(backupFile,f.facts,false);readBackupIndex(backupFile);assert.deepEqual(await readFile(backupFile),backupBytes);
  const privatePath=path.join(f.directory,'cue-active-private'),restorePath=path.join(f.directory,'cue-restored-packages');await mkdir(privatePath,{mode:0o700});await mkdir(restorePath,{mode:0o700});
  const initial=await openCollectionDataset(privatePath),defaultFile=initial.databaseFile;initial.close();const defaultBytes=await readFile(defaultFile);
  const privateRoot={...await authorizeSourceDirectory(privatePath),id:randomUUID()},storeFile=path.join(privatePath,'backup-maintenance.v1.sqlite');
  const store=createBackupWorkflowStore({filePath:storeFile}),coordinator=createBackupCoordinator({store,repository:f.repo,privateRoot});
  let output:NonNullable<ReturnType<typeof store.job>['output']>,restoreJobId:string;
  try {
    const source=await coordinator.authorize({commandId:randomUUID(),kind:'backup-source',absolutePath:backup.directory.path});
    const destination=await coordinator.authorize({commandId:randomUUID(),kind:'restore-destination',absolutePath:restorePath});
    const verify=coordinator.start({commandId:randomUUID(),kind:'verify',rootId:source.id,userConfirmed:true});await coordinator.idle();assert.equal(store.job(verify.id).view.state,'succeeded');
    const restored=coordinator.start({commandId:randomUUID(),kind:'restore',rootId:source.id,destinationId:destination.id,verificationId:verify.id,userConfirmed:true});await coordinator.idle();
    assert.equal(store.job(restored.id).view.state,'succeeded');restoreJobId=restored.id;output=store.job(restored.id).output!;assert.ok(output);
  } finally {await coordinator.close();}
  const restoredFile=path.join(output.path,'database','collection.sqlite');verifyRestoredDatabaseIsolation(restoredFile);readBackupIndex(restoredFile);preservedSql(restoredFile,f.facts,true);
  const datasetsPath=path.join(privatePath,'restored-datasets');await mkdir(datasetsPath,{mode:0o700});const datasets={...await authorizeSourceDirectory(datasetsPath),id:randomUUID()};
  const maintenance=createBackupWorkflowStore({filePath:storeFile});let pendingId:string;
  try {
    const pending=maintenance.activations.begin({commandId:randomUUID(),restoreJobId,expectedActiveId:null,userConfirmed:true,stopPlaybackConfirmed:true});pendingId=pending.view.id;
    const prepared=await prepareRestoredDataset({id:pendingId,source:output,destination:datasets,userConfirmed:true,signal});maintenance.activations.prepared(pendingId,prepared);
  } finally {maintenance.close();}
  let activeFile:string,activeId:string;
  const active=await openCollectionDataset(privatePath);
  try {assert.equal(active.pendingActivationId,pendingId);activeFile=active.databaseFile;activeId=active.datasetId;assert.equal(path.basename(activeFile),'collection.sqlite');assert.notEqual(activeFile,defaultFile);retained(active.repository,f,true);active.commit();}
  finally {active.close();}
  for(let pass=0;pass<2;pass++) {
    const cold=await openCollectionDataset(privatePath);
    try {assert.equal(cold.pendingActivationId,undefined);assert.equal(cold.databaseFile,activeFile);assert.equal(cold.datasetId,activeId);retained(cold.repository,f,true);}
    finally {cold.close();}
    verifyRestoredDatabaseIsolation(activeFile);readBackupIndex(activeFile);preservedSql(activeFile,f.facts,true);
  }
  assert.deepEqual(await readFile(defaultFile),defaultBytes);assert.deepEqual(await readFile(backupFile),backupBytes);
  retained(f.repo,f,false);preservedSql(f.opened.databaseFile,f.facts,false);preservedSql(restoredFile,f.facts,true);
  assert.equal(await readFile(path.join(f.media,'disc.cue'),'utf8'),cueText);
});

test('实际CUE备份快照注入partial扩展后索引、隔离恢复与冷开全部拒绝且不补DDL或改原字节',async t=>{
  const f=await seed(t),snapshotPath=path.join(f.directory,'cue-partial-owned-snapshot');await mkdir(snapshotPath,{mode:0o700});
  const snapshot=await f.repo.backupSnapshot({...await authorizeSourceDirectory(snapshotPath),id:randomUUID()});
  assert.equal(snapshot.schemaVersion,32);assert.ok(snapshot.pages>0);assert.equal(snapshot.relative,'collection.sqlite');
  const completeFile=path.join(snapshotPath,snapshot.relative),completeBytes=await readFile(completeFile);
  assert.equal(completeBytes.length,snapshot.size);assert.equal(createHash('sha256').update(completeBytes).digest('hex'),snapshot.sha256);
  preservedSql(completeFile,f.facts,false);readBackupIndex(completeFile);
  // 仅将本case的真实owned快照改为默认库文件名，随后注入缺失扩展表故障；源库/固定夹具均不触碰。
  const partialFile=path.join(snapshotPath,'collection.v1.sqlite');await rename(completeFile,partialFile);
  const injected=new DatabaseSync(partialFile,{allowExtension:false});
  // 原Repository在cold-open核验前设置WAL；本故障图先进入其正常日志模式，主字节保护不误测DELETE→WAL策略。
  try {injected.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF; DROP TABLE local_cue_tracks;');} finally {injected.close();}
  const before=databaseFacts(partialFile),bytes=await readFile(partialFile);assert.equal(before.version,32);assert.equal(before.tables.length,117);
  assert.deepEqual(before.tables.filter(v=>v.name.startsWith('local_cue_')).map(v=>v.name),['local_cue_sources']);
  assert.equal(before.tables.find(v=>v.name==='local_cue_sources')!.rows.length,1);
  const unchanged=async()=>{assert.deepEqual(await readFile(partialFile),bytes);assert.deepEqual(databaseFacts(partialFile),before);};
  assert.throws(()=>readBackupIndex(partialFile));await unchanged();
  assert.throws(()=>isolateRestoredDatabase(partialFile));await unchanged();
  assert.throws(()=>verifyRestoredDatabaseIsolation(partialFile));await unchanged();
  const cold=createCollectionRepository({filePath:partialFile});try {assert.throws(()=>cold.list({offset:0,limit:1}));} finally {cold.close();}await unchanged();
  await assert.rejects(openCollectionDataset(snapshotPath));await unchanged();
  // 负控制不是SQLite损坏/FK失败；唯一破坏是完整七表扩展缺一表，原库事实仍逐cell一致。
  retained(f.repo,f,false);preservedSql(f.opened.databaseFile,f.facts,false);
});
