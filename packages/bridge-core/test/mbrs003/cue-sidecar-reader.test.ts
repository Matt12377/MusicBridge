import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,stat,open,symlink,link} from 'node:fs/promises';
import path from 'node:path';
import {buildStoragePolicy} from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import fsPromises,{type FileHandle} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {fstatSync} from 'node:fs';
import {audioFixture,loadFreshMetadataReader} from '../helpers/mbrs003-audio-fixtures.js';
import {authorizeSourceDirectory,readonlySourceCandidateMetadata} from '../../src/recording/source-files.js';
import type {CueSidecarLifecycle} from '../../src/library/cue-sidecar-reader.js';
import {parseCueText} from '../../src/library/cue-text-reader.js';
import {createCollectionRepository} from '../../src/collection/repository.js';
import {createLocalScanCoordinator} from '../../src/collection/local-scan-coordinator.js';
import {createScanReadAdmission} from '../../src/library/scan-read-admission.js';
import type {DatasetProjectionPort,DatasetProjectionCommand,DatasetProjectionCommandPayloads,DatasetProjectionCommandResults} from '../../src/collection/dataset-owner-protocol.js';
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
async function fixture(t:test.TestContext,bytes:Uint8Array) {const f=await audioFixture(t),relative='readonly.cue';await writeFile(path.join(f.directory,relative),bytes,{flag:'wx',mode:0o600});const observed=await readonlySourceCandidateMetadata(f.root,relative);return {...f,relative,input:{root:f.root,relative,expectedSignature:observed.signature}};}

test('真实CUE worker读取有界字节，actual exit先于FDclose，UTF8与文本预算独立分类',async t=>{
  const body=Buffer.from('FILE "disc.wav" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:01:01\n'),f=await fixture(t,body),events:CueSidecarLifecycle[]=[];
  const reader=(await freshCueReader()).createCueSidecarReader({onLifecycle:event=>events.push(event)});t.after(()=>reader.close());const result=await reader.read(f.input);assert.equal(result.status,'ok');if(result.status !== 'ok') return;
  assert.deepEqual(result.bytes,new Uint8Array(body));assert.ok(result.readCalls<=64);assert.deepEqual(events.map(e=>e.type),['lease-acquired','worker-start','worker-exit','lease-released']);assert.equal(events[0]!.fd,events[3]!.fd);assert.deepEqual(await readFile(path.join(f.directory,f.relative)),body);
  const asset={assetId:randomUUID(),libraryRootId:randomUUID(),sourceRootId:f.root.id,rootRevision:'1',fileRevision:'1',locationRevision:'1'};
  const parsed=parseCueText(result.bytes,new Map([['disc.wav',[asset]]]));assert.equal(parsed.status,'ok');if(parsed.status === 'ok'){assert.equal(parsed.tracks[0]!.index01Frames,76);assert.equal(parsed.tracks[0]!.endFrames,null);assert.equal(parsed.tracks[0]!.playback,'NOT_VERIFIED');}
  assert.deepEqual(parseCueText(new Uint8Array([255]),new Map()),{status:'failure',code:'MALFORMED'});
  const large=await fixture(t,Buffer.alloc(65537,32)),largeReader=(await freshCueReader()).createCueSidecarReader();assert.deepEqual(await largeReader.read(large.input),{status:'failure',code:'BUDGET_EXCEEDED'});await largeReader.close();
  assert.deepEqual(parseCueText(Buffer.alloc(65537,32),new Map()),{status:'failure',code:'BUDGET_EXCEEDED'});assert.deepEqual(parseCueText('REM x\n'.repeat(1025),new Map()),{status:'failure',code:'BUDGET_EXCEEDED'});
});

test('取消与close等待真实worker exit和FDclose，拒symlink和hardlink的Root只读资格',async t=>{
  const f=await fixture(t,Buffer.alloc(65536,32)),events:CueSidecarLifecycle[]=[],controller=new AbortController();
  const reader=(await freshCueReader()).createCueSidecarReader({onLifecycle:event=>{events.push(event);if(event.type === 'worker-start') controller.abort();}});
  assert.deepEqual(await reader.read(f.input,controller.signal),{status:'failure',code:'CANCELLED'});await reader.close();assert.deepEqual(events.map(e=>e.type),['lease-acquired','worker-start','worker-exit','lease-released']);
  const again=(await freshCueReader()).createCueSidecarReader();await again.close();assert.deepEqual(await again.read(f.input),{status:'failure',code:'CLOSED'});
  await symlink(path.join(f.directory,f.relative),path.join(f.directory,'link.cue'));await assert.rejects(()=>readonlySourceCandidateMetadata(f.root,'link.cue'));
  await link(path.join(f.directory,f.relative),path.join(f.directory,'hard.cue'));await assert.rejects(()=>readonlySourceCandidateMetadata(f.root,f.relative));
  await f.assertUnchanged();
});

test('实际FileHandle close故障保持LRF fatal，不能以cancel或close伪装已关闭',async t=>{
  const f=await fixture(t,Buffer.from('REM finite\n')),target=path.join(f.directory,f.relative),events:CueSidecarLifecycle[]=[];
  const originalOpen=fsPromises.open;let owned:FileHandle|undefined,realClose:(()=>Promise<void>)|undefined,injected=0;
  const mocked=t.mock.method(fsPromises,'open',async(...args:Parameters<typeof originalOpen>)=>{
    const handle=await originalOpen(...args);if(String(args[0]) === target){owned=handle;realClose=handle.close.bind(handle);t.mock.method(handle,'close',async()=>{injected++;throw new Error('合成真实close故障');});}return handle;
  });syncBuiltinESMExports();
  const reader=(await freshCueReader()).createCueSidecarReader({onLifecycle:event=>events.push(event)});
  try {assert.deepEqual(await reader.read(f.input),{status:'failure',code:'LEASE_RELEASE_FAILED'});assert.equal(injected,1);assert.ok(owned);assert.equal(fstatSync(owned.fd).isFile(),true);
    assert.equal(events.at(-1)!.type,'worker-exit');assert.equal(events.some(e=>e.type === 'lease-released'),false);assert.deepEqual(await reader.read(f.input),{status:'failure',code:'LEASE_RELEASE_FAILED'});await assert.rejects(()=>reader.close(),/句柄关闭未确认/);
  } finally {if(owned && realClose){const fd=owned.fd;await realClose();assert.throws(()=>fstatSync(fd),{code:'EBADF'});}mocked.mock.restore();syncBuiltinESMExports();await reader.close().catch(()=>undefined);}  // 同case接真实coordinator/admission：LRF不能释放Core票据或提交sidecar/checkpoint。
  const media=path.join(f.directory,'fatal-cue-root');await mkdir(media,{mode:0o700});const ownerTarget=path.join(media,'fatal.cue');await writeFile(ownerTarget,'REM finite\n',{flag:'wx',mode:0o600});
  const repo=createCollectionRepository({filePath:path.join(f.directory,'fatal-owner.sqlite')}),datasetId=randomUUID(),p=projection(datasetId);
  const source=repo.sources.authorize(randomUUID(),await authorizeSourceDirectory(media)),root=repo.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'});
  let ownerHandle:FileHandle|undefined,ownerRealClose:(()=>Promise<void>)|undefined;const ownerOpen=fsPromises.open;
  const ownerMock=t.mock.method(fsPromises,'open',async(...args:Parameters<typeof ownerOpen>)=>{const handle=await ownerOpen(...args);if(String(args[0]) === ownerTarget){ownerHandle=handle;ownerRealClose=handle.close.bind(handle);t.mock.method(handle,'close',async()=>{throw new Error('合成owner FD close故障');});}return handle;});syncBuiltinESMExports();
  const cue=(await freshCueReader()).createCueSidecarReader(),coordinator=createLocalScanCoordinator({repository:repo,datasetId,assertCurrent:()=>{},projection:p.port,reader:(await loadFreshMetadataReader()).createMetadataReader(),cueReader:cue});
  try {const job=coordinator.start({commandId:randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision});await coordinator.privateWait(job.jobId);
    assert.ok(ownerHandle);assert.equal(fstatSync(ownerHandle.fd).isFile(),true);assert.equal(repo.localScan.privateCueSnapshot(root.id,'fatal.cue'),null);
    assert.equal(p.admission.resourceCounts().permits,1);assert.throws(()=>coordinator.get(job.jobId),/FD关闭未确认/);await assert.rejects(()=>coordinator.close());
  } finally {if(ownerHandle && ownerRealClose){const fd=ownerHandle.fd;await ownerRealClose();assert.throws(()=>fstatSync(fd),{code:'EBADF'});}ownerMock.mock.restore();syncBuiltinESMExports();p.admission.close();await coordinator.close().catch(()=>undefined);repo.close();}
});
