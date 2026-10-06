import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { validateIpcEvent, roonTrackIdFromReference } from '@music-bridge/contracts';
import { BridgeController } from '../../src/application/bridge-controller.js';
import { assessAudioQuality, formatCapabilityMatrix } from '../../src/application/audio-quality-evidence.js';
import { auditHttpBytes } from '../../src/stream/http-byte-evidence.js';
import { LocalFileSourcePool } from '../../src/stream/local-file-source.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { StreamGateway } from '../../src/stream/gateway.js';
import { isLocalSourceCaptureResult } from '../../src/collection/local-source-ticket-types.js';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import type { NeteasePort } from '../../src/netease/types.js';
import { adapterFixture, silentLogger } from '../mbrs006/adapter-fixture.js';
import { catalogFixture } from '../mbrs006/catalog-fixture.js';
import { eventually } from '../mbrs005/fixture.js';
import path from 'node:path';
import test from 'node:test';
import type { LocalPlayRequest } from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createLocalSourceTickets } from '../../src/collection/local-source-tickets.js';
import { createLocalScanCoordinator } from '../../src/collection/local-scan-coordinator.js';
import { createScanReadAdmission } from '../../src/library/scan-read-admission.js';
import type { DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults, DatasetProjectionPort } from '../../src/collection/dataset-owner-protocol.js';
import { fixture } from '../mbrs005/fixture.js';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

/** 自有合法PCM，左右声道与低位均变化；不是设备捕获或真实素材。 */
function wave() {
  const frames = 2048, bytes = Buffer.alloc(44 + frames * 4);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(176400, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame++) {
    bytes.writeInt16LE((frame * 137 % 30001) - 15000, 44 + frame * 4);
    bytes.writeInt16LE((frame * 251 % 28001) - 14000, 46 + frame * 4);
  }
  return bytes;
}

test('008真实WAVE Reader/扫描/唯一Owner捕获投影当前文件参数，不能用扩展名代替', { timeout: 20_000 }, async t => {
  const { createMetadataReader } = await loadFreshMetadataReader();
  const f = await fixture(t, wave()), repository = createCollectionRepository({ filePath: path.join(f.directory, 'catalog.sqlite') });
  t.after(() => repository.close());
  const { id: _, ...capability } = f.descriptor.facts.sourceRoot;
  const source = repository.sources.authorize(randomUUID(), capability);
  const root = repository.localCatalog.registerRoot({ commandId: randomUUID(), sourceRootId: source.id, role: 'library' });
  const context = { datasetId: randomUUID(), epoch: randomUUID() }, admission = createScanReadAdmission({ isBusy: () => false });
  const projection: DatasetProjectionPort = { async call<K extends DatasetProjectionCommand>(command: K, payload: DatasetProjectionCommandPayloads[K]): Promise<DatasetProjectionCommandResults[K]> {
    let result: unknown;
    if (command === 'scanReadAcquire') result = admission.acquire(context);
    else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId);
    else throw new Error('本测试只允许扫描读取票据。');
    return result as DatasetProjectionCommandResults[K];
  } };
  const reader = createMetadataReader(), scanner = createLocalScanCoordinator({ repository, datasetId: context.datasetId, projection, assertCurrent() {}, reader });
  t.after(async () => { await scanner.close(); admission.close(); });
  const job = scanner.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision }); await scanner.privateWait(job.jobId);
  assert.equal(scanner.get(job.jobId).phase, 'completed');
  const page = repository.localCatalog.pageTracks({ offset: 0, limit: 10 }); assert.equal(page.total, 1);
  const track = page.items[0]!, asset = repository.localCatalog.asset(track.assetId);
  const selection: LocalPlayRequest = { schema_version: '1.2', route: 'roon_audio_input', source_kind: 'local_file', request_id: randomUUID(), local_track_id: track.id, asset_id: asset.id, expected_asset_revision: asset.fileRevision, target: f.descriptor.target, action: 'PLAY_NOW' };
  const current = repository.localScan.privateCurrentFileState(root.id, f.descriptor.facts.relative);
  assert.equal(current?.value.outcome, 'accepted'); assert.equal(current?.value.readFacts?.technical.sampleRateHz, 44100);
  const tickets = createLocalSourceTickets(repository, context.epoch, context.datasetId, () => {}); t.after(() => tickets.seal());
  const capture = tickets.capture(selection);
  assert.equal(capture.facts.observation?.signature, current?.value.signature);
  // 在旧产品上这是既有capture的可观察缺口，不依赖新模块import或新类型。
  assert.deepEqual((capture as unknown as Record<string, unknown>).fileParameters, {
    container: 'WAVE', codec: 'PCM', lossless: true, sampleRateHz: 44100, channels: 2,
    bitsPerSample: 16, durationMs: Math.round(2048 / 44100 * 1000), evidence: 'bounded-parser-reported',
  });
  assert.equal(isLocalSourceCaptureResult(capture), true);
  for (const field of ['path','url','token','buffer']) assert.equal(isLocalSourceCaptureResult({...capture,fileParameters:{...capture.fileParameters,[field]:'private'}}),false);
  tickets.release(capture.ticketId);
  const pool = new LocalFileSourcePool(), registry = new StreamRegistry({localSourcePool:pool}), gateway = new StreamGateway({host:'127.0.0.1',port:0,publicBaseUrl:'http://127.0.0.1:0',registry,logger:silentLogger});
  await gateway.start(); const sdk = await adapterFixture(1000,Number(new URL(gateway.iconUrl()).port));
  const localSources:DatasetOwnerEndpoint={async prepare(){return context;},async dispatch(){},async commitBoot(){},async close(){},isLocalSourceCurrent:()=>true,
    async captureLocalSource(input){return tickets.capture(input);},async revalidateLocalSource(id){return tickets.revalidate(id);},async releaseLocalSource(id){tickets.release(id);}};
  const controller = new BridgeController({roon:sdk.adapter,registry,gateway,logger:silentLogger,localSources,
    netease:new Proxy({configured:true},{get:(_target,key)=>key==='configured'?true:()=>{throw new Error('本地样本不调用云。');}}) as NeteasePort});
  t.after(async()=>{await controller.shutdown();await sdk.adapter.shutdown();await gateway.stop();});
  const work=controller.playLocal(selection);await eventually(()=>sdk.sessions.length===1,'受控SDK唯一begin');sdk.sessions[0]!('SessionBegan',{session_id:'private-controlled-session'});await work;
  const state=controller.getPlaybackState();assert.deepEqual(state.local?.file_parameters,capture.fileParameters);assert.equal(validateIpcEvent({version:1,event:'playback.changed',payload:{state}}).ok,true);
  assert.deepEqual(state.local?.quality,{http_bytes:'NOT_TESTED',signal_path:'NOT_TESTED',digital_output:'NOT_TESTED',gapless:'NOT_TESTED'});
  const audit=await auditHttpBytes(f.bytes,async input=>{const response=await fetch(sdk.sends[0]!.media_url,{method:input.method,headers:input.headers});const headers:Record<string,string>={};response.headers.forEach((value,key)=>headers[key]=value);return {status:response.status,headers,body:new Uint8Array(await response.arrayBuffer())};});
  assert.equal(audit.verified,true);assert.equal(audit.rows.length,14);assert.equal(controller.getPlaybackState().local?.phase,'PLAYING');assert.equal(pool.resourceSnapshot().openLeases,1);
  const scope={build:process.env.MBRS008_BUILD_ID??'software-test-build',core:'synthetic-core',zone:'synthetic-zone',outputs:['synthetic-output'],assetId:asset.id,revision:asset.fileRevision,sourceDigest:audit.sourceDigest,profile:'FMT-03' as const,settingsDigest:null};
  const assessment=assessAudioQuality(scope,[{scope,id:'owned-wave-http',origin:'synthetic',measurement:{axis:'http_bytes',result:audit}}]);
  assert.equal(assessment.quality.http_bytes,'SAMPLE_VERIFIED');assert.equal(assessment.quality.digital_output,'NOT_TESTED');assert.equal(assessment.endToEndBitExact,false);
  // 只保存自有合成原件和安全测量JSON；URL/token/session不进入索引。
  const evidence=process.env.MBRS008_PRIVATE_EVIDENCE_ROOT;
  if(evidence){buildStoragePolicy().check(evidence,{mustExist:true});const info=await lstat(evidence);assert.equal(info.isDirectory()&&!info.isSymbolicLink(),true);assert.equal(await realpath(evidence),evidence);assert.equal(info.mode&0o777,0o700);assert.equal(typeof process.getuid,'function');assert.equal(info.uid,process.getuid!());await mkdir(path.join(evidence,'writer'),{recursive:true,mode:0o700});
    await writeFile(path.join(evidence,'writer','wave-oracle.wav'),f.bytes,{mode:0o600});await writeFile(path.join(evidence,'writer','wave-http-byte-audit.json'),JSON.stringify({schema:'mbrs008.private-http.v1',synthetic:true,audit,assessment,matrix:formatCapabilityMatrix([assessment]),fileParameters:capture.fileParameters,oracleRef:'wave-oracle.wav',realRoon:'NOT_RUN'},null,2)+'\n',{mode:0o600});}
  await controller.shutdown();assert.equal(pool.resourceSnapshot().openLeases,0);assert.equal(tickets.size,0);
});


test('008当前A/B参数不互串，缺参数B保持未知，旧A回报与新native都不继承文件参数',async t=>{
 const f=await catalogFixture(t),registry=new StreamRegistry(),gateway=new StreamGateway({host:'127.0.0.1',port:0,publicBaseUrl:'http://127.0.0.1:0',registry,logger:silentLogger});await gateway.start();
 const sdk=await adapterFixture(1000,Number(new URL(gateway.iconUrl()).port));
 const localSources:DatasetOwnerEndpoint={async prepare(){return {datasetId:f.datasetId,epoch:f.epoch};},async dispatch(){},async commitBoot(){},async close(){},isLocalSourceCurrent:()=>true,
  async captureLocalSource(input){const value=f.tickets.capture(input);if(input.asset_id===f.requests[1]!.asset_id)delete value.fileParameters;return value;},async revalidateLocalSource(id){return f.tickets.revalidate(id);},async releaseLocalSource(id){f.tickets.release(id);}};
 const roonLibrary:NonNullable<ConstructorParameters<typeof BridgeController>[0]['roonLibrary']>={async play(_reference,zoneId,track,options){options?.onDispatch?.();options?.onDispatchCompletion?.(Promise.resolve());return {zoneId,revision:1,state:'playing',positionMs:0,nowPlaying:{title:track.title,artist:'合成',album:'合成'}};},async stop(){},async pause(){},async resume(){}};
 const controller=new BridgeController({roon:sdk.adapter,registry,gateway,logger:silentLogger,localSources,roonLibrary,netease:{} as NeteasePort});
 t.after(async()=>{await controller.shutdown();await sdk.adapter.shutdown();await gateway.stop();});
 const start=async(i:number)=>{const work=controller.playLocal({...f.requests[i]!,request_id:randomUUID()});await eventually(()=>sdk.sessions.length===i+1,'受控begin');sdk.sessions[i]!('SessionBegan',{session_id:`private-${i}`});await work;};
 await start(0);assert.equal(controller.getPlaybackState().local?.file_parameters?.sampleRateHz,48000);
 await start(1);assert.equal(controller.getPlaybackState().local?.file_parameters,undefined);const id=controller.getPlaybackState().local?.attempt_id;
 sdk.plays[0]!('Playing',{});sdk.sessions[0]!('SessionEnded',{});assert.equal(controller.getPlaybackState().local?.attempt_id,id);assert.equal(controller.getPlaybackState().local?.file_parameters,undefined);
 const reference='musicbridge-v2-entity-00000001-1111-4111-8111-111111111111';await controller.playRoon({reference,zoneId:'synthetic-zone',track:{id:roonTrackIdFromReference(reference),title:'受控native',artists:['合成'],album:'合成'}});
 assert.equal(controller.getPlaybackState().source,'roon');assert.equal(controller.getPlaybackState().local,undefined);
});
