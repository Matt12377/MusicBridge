import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile, lstat, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import { authorizeSourceDirectory, readonlySourceCandidateMetadata, sourceRootAvailability } from '../../src/recording/source-files.js';
import { createLocalAlbumOwnerService } from '../../src/collection/local-album-browser/owner-port.js';
import { createLocalWorkbenchReadService } from '../../src/collection/local-library-workbench/read-service.js';
import { createLocalWorkbenchOwnerPersistence } from '../../src/collection/local-library-workbench/owner-journal.js';
import { createLocalWorkbenchPlanRegistry, type LocalWorkbenchPlanRegistry } from '../../src/collection/local-library-workbench/plan-registry.js';
import { buildLocalCuePlan } from '../../src/collection/local-library-workbench/cue-plan.js';
import { parseCueText } from '../../src/library/cue-text-reader.js';
import { createLocalCueOutputActor, type LocalCueOutputActorOptions } from '../../src/collection/local-cue-output-actor.js';
import { cueOutputCanonical, type LocalCueOutputStore } from '../../src/collection/local-cue-output-protocol.js';
import { createCueNativeActor, loadBundledCueConverter, CueNativeRunError } from '../../src/library/bundled-cue-converter.js';
import { createLocalAudioTagsActor, loadLocalAudioTagsBundle } from '../../src/library/local-audio-tags-actor.js';
import { createCueSyntheticWave, qualifyCueEightFormats, readCueQualifiedFormats, nativeEvidencePin, rawReceipt, mergeNativeEvidence } from '../../src/library/local-cue-format-qualification.js';
import type { LocalCueAudioProbe, LocalWorkbenchPlanCapture } from '../../src/collection/local-library-workbench/types.js';

import { Worker, MessageChannel } from 'node:worker_threads';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';

test('CUE实际独立输出原回执、品牌恢复和SQLite冷回读保持原命令，不重编码或覆盖同名外部文件', { skip: process.platform !== 'darwin' }, async () => {
  const cueRoot=process.env.MB_V39_CUE_BUNDLE,tagsRoot=process.env.MB_V39_TAGS_BUNDLE,evidenceRoot=process.env.MB_V39_NATIVE_PROOF_DIR;
  assert.ok(cueRoot&&tagsRoot&&evidenceRoot,'Native实际包及新证据根必须存在，缺失不能跳过。');
  const nativeEvidenceRoot: string=evidenceRoot;
  const sha=(bytes:Uint8Array):string=>createHash('sha256').update(bytes).digest('hex');
  const cueManifest=process.env.MB_V39_CUE_MANIFEST_SHA256??sha(await readFile(path.join(cueRoot,'manifest.json')));
  const tagsManifest=process.env.MB_V39_TAGS_MANIFEST_SHA256??sha(await readFile(path.join(tagsRoot,'manifest.json')));
  const directory=path.join(evidenceRoot,'cue-recovery'),sources=path.join(directory,'sources'),qualificationRoot=path.join(directory,'qualification');
  await mkdir(directory,{mode:0o700});await mkdir(sources,{mode:0o700});await mkdir(qualificationRoot,{mode:0o700});
  const qualification=await qualifyCueEightFormats({cueRoot,cueManifestSha256:cueManifest,tagsRoot,tagsManifestSha256:tagsManifest,evidenceRoot:qualificationRoot});
  assert.equal(readCueQualifiedFormats(qualification).length,8);
  const nativeActor=createCueNativeActor(await loadBundledCueConverter(cueRoot,cueManifest));
  const tagsActor=createLocalAudioTagsActor(await loadLocalAudioTagsBundle(tagsRoot,tagsManifest));
  const raw:unknown[]=[],failures:unknown[]=[],nativeHandles=new Set<FileHandle>();let serial=0,encodes=0;
  const observe=async<T extends Parameters<typeof rawReceipt>[2]>(value:T)=>{raw.push(await rawReceipt(directory,'native-'+String(++serial).padStart(3,'0'),value,evidenceRoot));return value;};
  // 这里只记录真实actor的原raw，不替代Native、SourceFiles或底层进程。
  const native={...nativeActor,
    async probe(...args:Parameters<typeof nativeActor.probe>){nativeHandles.add(args[0]);return observe(await nativeActor.probe(...args));},
    async encode(...args:Parameters<typeof nativeActor.encode>){encodes++;nativeHandles.add(args[0].source);nativeHandles.add(args[0].target);return observe(await nativeActor.encode(...args));},
    async decode(...args:Parameters<typeof nativeActor.decode>){nativeHandles.add(args[0]);nativeHandles.add(args[1]);return observe(await nativeActor.decode(...args));},
  };
  const tags={...tagsActor,async run(...args:Parameters<typeof tagsActor.run>){return observe(await tagsActor.run(...args));}};
  const wave=createCueSyntheticWave(),sourcePath=path.join(sources,'原音乐.wav'),cuePath=path.join(sources,'原索引.cue');
  const cueText='TITLE "原始专辑"\nPERFORMER "原艺术家"\nFILE "原音乐.wav" WAVE\nTRACK 01 AUDIO\nTITLE "第一曲"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "第二曲"\nINDEX 01 00:00:15\n';
  await writeFile(sourcePath,wave.wave,{mode:0o600,flag:'wx'});await writeFile(cuePath,cueText,{mode:0o600,flag:'wx'});
  const originalMusic=await nativeEvidencePin(sourcePath,evidenceRoot),originalCue=await nativeEvidencePin(cuePath,evidenceRoot);
  const database=path.join(directory,'catalog.sqlite'),identityFile=path.join(directory,'identity.sqlite');
  let repository=createCollectionRepository({filePath:database}),state=createBackupWorkflowStore({filePath:identityFile});
  repository.localCatalog.roots();let identity=state.datasetIdentities.bind('default',database,false);
  repository.localCatalog.privateBindWorkbenchDataset(identity);
  const source=repository.sources.authorize(randomUUID(),await authorizeSourceDirectory(sources));
  const library=repository.localCatalog.registerRoot({commandId:randomUUID(),sourceRootId:source.id,role:'library'});
  const asset=repository.localCatalog.registerAsset({commandId:randomUUID(),libraryRootId:library.id,expectedRootRevision:library.revision,
    relative:path.basename(sourcePath),sha256:originalMusic.sha256,sampleFrames:String(wave.frames),timebaseHz:wave.sampleRate});
  const track=repository.localCatalog.createTrack({commandId:randomUUID(),assetId:asset.id,segment:null});
  repository.localCatalog.observeMetadata({commandId:randomUUID(),trackId:track.id,source:'synthetic',parserVersion:'native-cue-recovery-v1',
    fields:{title:'原音乐',artist:'原艺术家',album:'原始专辑'}});
  const roots=async()=>[{root:repository.localCatalog.root(library.id),label:'任务自有Native来源',
    availability:await sourceRootAvailability(repository.sources.root(source.id))}];
  const albums=createLocalAlbumOwnerService({repository,assertCurrent:()=>identity.assertCurrent(),readRootViews:roots,
    readArtwork:async()=>({image:null,status:'ready'})});
  const reads=createLocalWorkbenchReadService({datasetId:identity.datasetId,repository,localAlbums:albums,assertCurrent:()=>identity.assertCurrent(),readRootViews:roots});
  const summary=(await albums.queryAlbums({query:'',rootId:null,filter:'all',offset:0,limit:20})).items[0]!;
  const publicCapture=await reads.readAlbumTargets({albums:[{albumId:summary.id,rootId:summary.rootId,revision:summary.revision}]});
  const resolved=await reads.resolveCapture({datasetId:identity.datasetId,capture:publicCapture.albums[0]!.capture});
  const metadata=await readonlySourceCandidateMetadata(source,path.basename(sourcePath));
  const sourceHandle=await open(sourcePath,constants.O_RDONLY|constants.O_NOFOLLOW);
  let probe:Awaited<ReturnType<typeof native.probe>>;
  try{probe=await native.probe(sourceHandle,'wav',{commandId:randomUUID(),claimId:randomUUID(),async assertCurrent(){
    identity.assertCurrent();assert.deepEqual(await nativeEvidencePin(sourcePath,evidenceRoot),originalMusic);
  }});}finally{await sourceHandle.close();}
  const member=resolved.capture.members[0]!;assert.ok(member.assetId&&member.fileRevision&&member.locationRevision);
  const reference={assetId:asset.id,libraryRootId:library.id,sourceRootId:source.id,rootRevision:member.rootRevision,
    fileRevision:member.fileRevision,locationRevision:member.locationRevision};
  const audio:LocalCueAudioProbe={assetReference:reference,sourceLabel:path.basename(sourcePath),evidence:'audio-pcm-read',
    readRevision:'native-'+originalMusic.sha256,sampleRate:probe.sampleRate,totalPcmFrames:probe.frames};
  const parsed=parseCueText(await readFile(cuePath,'utf8'),new Map([[path.basename(sourcePath),[reference]]]));
  assert.equal(parsed.status,'ok');if(parsed.status!=='ok')assert.fail('实际合成CUE解析失败');
  const choices=new Map<string,Awaited<ReturnType<typeof authorizeSourceDirectory>>&{id:string}>();
  let actor:ReturnType<typeof createLocalCueOutputActor>,registry:LocalWorkbenchPlanRegistry;
  const pending=new Map<string,'quiet'|'terminal'>(),proof:Record<string,unknown>={};
  const partials=new Map<string,{mode:'cancel'|'fail';request:dto.LocalWorkbenchApplyRequest;directoryPath:string;firstName:string;fired:boolean;before?:Awaited<ReturnType<typeof nativeEvidencePin>>;dev?:string;ino?:string;cancel?:Promise<dto.LocalWorkbenchReceipt>}>();
  function makeActor(){
    const store:LocalCueOutputStore={
      read:(scope,commandId)=>repository.localCatalog.privateCueOutputRead(scope,commandId),
      compareAndSwap(scope,record,expected){
        // 窄故障注入发生在实际SQLite提交前，不伪造commit、回执或物理quiet。
        if(pending.get(record.request.commandId)==='quiet'&&record.phase==='quiet'
          ||pending.get(record.request.commandId)==='terminal'&&record.phase==='succeeded')throw new Error('合成原终态提交拒绝');
        return repository.localCatalog.privateCueOutputCompareAndSwap(scope,record,expected);
      },
    };
    const options:LocalCueOutputActorOptions={identity,store,native,tags,qualification,assertAccepting(){identity.assertCurrent();},
      onFailure(commandId,error){failures.push({commandId,message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null,
        native:error instanceof CueNativeRunError?{...error.raw,stdout:Buffer.from(error.raw.stdout).toString('utf8'),stderr:Buffer.from(error.raw.stderr).toString('utf8')}:null});},
      assertOriginal(request,plan,capture){
        identity.assertCurrent();const stored=repository.localCatalog.privateWorkbenchSnapshot(identity.datasetId);
        const entry=stored?.entries.find(value=>value.original?.commandId===request.commandId);
        assert.ok(entry);assert.equal(cueOutputCanonical(entry.original),cueOutputCanonical(request));
        assert.equal(cueOutputCanonical(entry.plan),cueOutputCanonical(plan));assert.equal(cueOutputCanonical(entry.capture),cueOutputCanonical(capture));
      },
      async revalidate(capture){identity.assertCurrent();assert.equal(capture.datasetId,identity.datasetId);
        const current=repository.localCatalog.trackDetail(track.id);
        assert.equal(current.asset.id,asset.id);assert.equal(current.asset.fileRevision,member.fileRevision);
        assert.deepEqual(await readonlySourceCandidateMetadata(repository.sources.root(source.id),path.basename(sourcePath)),metadata);
        assert.deepEqual(await nativeEvidencePin(sourcePath,nativeEvidenceRoot),originalMusic);assert.deepEqual(await nativeEvidencePin(cuePath,nativeEvidenceRoot),originalCue);
        const partial=partials.get(capture.target!.choiceId);
        if(partial&&!partial.fired){
          const absolute=path.join(partial.directoryPath,partial.firstName);let published:Awaited<ReturnType<typeof lstat>>;
          try{published=await lstat(absolute);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
          partial.fired=true;partial.before=await nativeEvidencePin(absolute,nativeEvidenceRoot);partial.dev=String(published.dev);partial.ino=String(published.ino);
          // 真link之后才触发原controller取消/普通故障；不在自己的fence等待自己的join。
          if(partial.mode==='cancel'){partial.cancel=actor.cancel({cancelCommandId:randomUUID(),original:partial.request});void partial.cancel.catch(()=>{});}
          else throw new Error('合成故障：首次已验证输出link后停止后续发布');
        }
      },
      source(capture,binding){assert.equal(binding.sourceAssetId,asset.id);assert.equal(binding.libraryRootId,library.id);
        assert.equal(capture.albums[0]!.members[0]!.assetId,asset.id);
        return {root:repository.sources.root(source.id),relative:path.basename(sourcePath),signature:metadata.signature,
          sha256:originalMusic.sha256,channels:wave.channels,demuxer:'wav'};
      },
      async target(capture){const value=choices.get(capture.target!.choiceId);assert.ok(value);return value;},
    };
    return createLocalCueOutputActor(options);
  }
  async function makeRegistry(){
    return createLocalWorkbenchPlanRegistry({datasetId:identity.datasetId,persistence:createLocalWorkbenchOwnerPersistence(identity.datasetId,repository.localCatalog),
      writer:{revalidate:async capture=>{await actorOptionsRevalidate(capture);return {valid:true};},
        apply:(request,plan,capture)=>actor.apply(request,plan,capture),
        readOriginalReceipt:async(request):Promise<dto.LocalWorkbenchReceipt|null>=>{const receipt=await actor.readOriginal(request);
          assert.ok(receipt===null||dto.isLocalWorkbenchReceipt(receipt,request));return receipt;},
        cancel:request=>actor.cancel(request)}});
  }
  async function actorOptionsRevalidate(capture:LocalWorkbenchPlanCapture){identity.assertCurrent();assert.equal(capture.datasetId,identity.datasetId);
    assert.deepEqual(await nativeEvidencePin(sourcePath,nativeEvidenceRoot),originalMusic);assert.deepEqual(await nativeEvidencePin(cuePath,nativeEvidenceRoot),originalCue);}
  actor=makeActor();registry=await makeRegistry();
  async function planFor(label:string){
    const directoryPath=path.join(directory,label);await mkdir(directoryPath,{mode:0o700});
    const choice={choiceId:randomUUID(),label,independent:true as const},capability={...await authorizeSourceDirectory(directoryPath),id:randomUUID()};
    choices.set(choice.choiceId,capability);
    const format=readCueQualifiedFormats(qualification).find(value=>value.codec==='flac')!;
    const selection={album:resolved.capture,cueId:randomUUID(),cueRevision:originalCue.sha256,parsed,audio:[audio]};
    const {draft,outputs}=buildLocalCuePlan({selections:[selection],target:choice,format,pregapPolicy:'append-to-previous'});
    const capture:LocalWorkbenchPlanCapture={datasetId:identity.datasetId,datasetRevision:resolved.datasetRevision,albums:[resolved.capture],
      cueSheets:[{cueId:selection.cueId,revision:selection.cueRevision,albumId:resolved.capture.albumId}],cueOutputs:outputs,audio:[audio],target:{...choice,revision:'1'},format};
    const plan=await registry.issuePlan(draft,capture);
    if(plan.kind!=='cue')assert.fail('原registry没有签发CUE计划。');
    const request:dto.LocalWorkbenchApplyRequest={commandId:randomUUID(),datasetId:plan.datasetId,planId:plan.planId,kind:'cue',
      expectedRevision:plan.revision,planHash:plan.planHash,contextFingerprint:plan.contextFingerprint};
    return {plan,request,capture,directoryPath};
  }
  try{
    const ordinary=await planFor('正常独立输出'),reply=await registry.apply(ordinary.request);assert.equal(reply.state,'running');
    await actor.join(ordinary.request.commandId);
    const first=await registry.readOriginalReceipt(ordinary.request);assert.equal(first?.state,'succeeded',JSON.stringify(failures));
    const before=encodes;assert.deepEqual(await registry.apply(ordinary.request),first);assert.equal(encodes,before);
    for(const output of ordinary.plan.tracks){assert.equal((await lstat(path.join(ordinary.directoryPath,output.outputName))).nlink,1);}
    proof.completed={commandId:ordinary.request.commandId,state:first!.state,originalReplayDidNotEncode:true,
      outputs:await Promise.all(ordinary.plan.tracks.map(output=>nativeEvidencePin(path.join(ordinary.directoryPath,output.outputName),evidenceRoot)))};
    const held=await planFor('原品牌恢复');pending.set(held.request.commandId,'quiet');await registry.apply(held.request);
    await assert.rejects(actor.join(held.request.commandId));assert.equal((await actor.readOriginal(held.request))?.state,'unknown');
    assert.equal(actor.inspect().retained,1);pending.delete(held.request.commandId);const heldEncodes=encodes;
    const recovered=await actor.recoverOriginal(held.request,held.plan,held.capture);assert.equal(recovered.state,'failed');assert.equal(recovered.commandId,held.request.commandId);
    assert.equal(encodes,heldEncodes);assert.equal(actor.inspect().retained,0);assert.equal(actor.inspect().recoveryRequired,false);
    assert.equal((await registry.readOriginalReceipt(held.request))?.state,'failed');
    proof.retained={commandId:held.request.commandId,originalState:'unknown',resolvedState:'failed',brandRecoveryOriginalId:true,noReencode:true};
    const cold=await planFor('冷回读完整终态输出');await registry.apply(cold.request);
    await actor.join(cold.request.commandId);assert.equal((await actor.readOriginal(cold.request))?.state,'succeeded');
    const coldOutputs=await Promise.all(cold.plan.tracks.map(output=>nativeEvidencePin(path.join(cold.directoryPath,output.outputName),evidenceRoot)));
    const oldDataset=identity.datasetId;await actor.close();reads.close();albums.close();repository.close();state.close();
    pending.clear();repository=createCollectionRepository({filePath:database});repository.localCatalog.roots();state=createBackupWorkflowStore({filePath:identityFile});
    identity=state.datasetIdentities.bind('default',database,false);assert.equal(identity.datasetId,oldDataset);repository.localCatalog.privateBindWorkbenchDataset(identity);
    actor=makeActor();registry=await makeRegistry();const coldEncodes=encodes;
    const completed=await actor.recoverOriginal(cold.request,cold.plan,cold.capture);assert.equal(completed.state,'succeeded');assert.equal(completed.commandId,cold.request.commandId);
    assert.equal(encodes,coldEncodes);assert.deepEqual(await registry.readOriginalReceipt(cold.request),completed);
    assert.deepEqual(await Promise.all(cold.plan.tracks.map(output=>nativeEvidencePin(path.join(cold.directoryPath,output.outputName),evidenceRoot))),coldOutputs);
    proof.cold={commandId:cold.request.commandId,datasetId:oldDataset,state:completed.state,samePhysicalDatasetColdId:true,noReencode:true,outputs:coldOutputs};
    const conflict=await planFor('保留同名外部文件'),foreignPath=path.join(conflict.directoryPath,conflict.plan.tracks[0]!.outputName);
    await writeFile(foreignPath,'同名外部文件完整保留',{mode:0o600,flag:'wx'});const foreign=await nativeEvidencePin(foreignPath,evidenceRoot);
    await registry.apply(conflict.request);await actor.join(conflict.request.commandId);assert.equal((await registry.readOriginalReceipt(conflict.request))?.state,'failed');
    assert.deepEqual(await nativeEvidencePin(foreignPath,evidenceRoot),foreign);
    proof.conflict={commandId:conflict.request.commandId,state:'failed',unownedFilePreserved:true,foreign};
    proof.partialOutputs=[];
    for(const mode of ['cancel','fail'] as const){
      const partial=await planFor(mode==='cancel'?'同plan取消保留已发布':'同plan失败保留已发布');
      const fault={mode,request:partial.request,directoryPath:partial.directoryPath,firstName:partial.plan.tracks[0]!.outputName,fired:false} as NonNullable<ReturnType<typeof partials.get>>;
      partials.set(partial.capture.target!.choiceId,fault);const beforeEncodes=encodes;
      await registry.apply(partial.request);await actor.join(partial.request.commandId);await fault.cancel;
      assert.equal(fault.fired,true);assert.ok(fault.before);
      const expected=mode==='cancel'?'cancelled':'failed',receipt=await registry.readOriginalReceipt(partial.request);
      assert.equal(receipt?.state,expected,JSON.stringify(failures));assert.deepEqual(receipt!.items.map(item=>item.state),['applied',mode==='cancel'?'cancelled':'not-written']);
      const output=path.join(partial.directoryPath,fault.firstName),after=await nativeEvidencePin(output,evidenceRoot),stat=await lstat(output);
      assert.deepEqual(after,fault.before);assert.equal(String(stat.dev),fault.dev);assert.equal(String(stat.ino),fault.ino);assert.equal(stat.nlink,1);
      await assert.rejects(lstat(path.join(partial.directoryPath,partial.plan.tracks[1]!.outputName)),{code:'ENOENT'});
      const journal=repository.localCatalog.privateCueOutputRead(identity,partial.request.commandId)!.record;
      assert.equal(journal.physicalClosed,true);assert.deepEqual(journal.published,[partial.plan.items[0]!.itemId]);
      const doneEncodes=encodes;assert.equal(doneEncodes-beforeEncodes,2);
      assert.deepEqual(await registry.apply(partial.request),receipt);assert.deepEqual(await actor.recoverOriginal(partial.request,partial.plan,partial.capture),receipt);assert.equal(encodes,doneEncodes);
      (proof.partialOutputs as unknown[]).push({mode,request:partial.request,receipt,output:after,originalDev:fault.dev,originalIno:fault.ino,nlink:1,noReencode:true,physicalClosed:journal.physicalClosed});
    }
    assert.deepEqual(await nativeEvidencePin(sourcePath,evidenceRoot),originalMusic);assert.deepEqual(await nativeEvidencePin(cuePath,evidenceRoot),originalCue);
  }finally{
    await actor.close();await tagsActor.close();await nativeActor.close();reads.close();albums.close();repository.close();state.close();
  }
  for(const handle of nativeHandles)await assert.rejects(handle.stat(),(error:unknown)=>(error as NodeJS.ErrnoException).code==='EBADF');
  assert.equal(nativeActor.inspect().running,0);assert.equal(tagsActor.inspect().running,0);
  assert.equal(actor.inspect().running,0);assert.equal(actor.inspect().recovering,0);assert.equal(actor.inspect().retained,0);
  const evidence=path.join(directory,'original-receipts.json');await writeFile(evidence,JSON.stringify({proof,raw,sourceUnchanged:true,
    sourceMusic:originalMusic,sourceCue:originalCue,physicalClosure:{fdsClosed:true,processesClosed:true,claimsReleased:true}},null,2)+'\n',{mode:0o600,flag:'wx'});
  await mergeNativeEvidence(evidenceRoot,{cueOutputRecovery:{raw:await nativeEvidencePin(evidence,evidenceRoot),...proof,sourceUnchanged:true,
    physicalClosure:{fdsClosed:true,processesClosed:true,claimsReleased:true}}});
  await normalCueOwner504({ evidenceRoot: nativeEvidenceRoot, cueRoot, tagsRoot, cueManifest, tagsManifest });
});

/** 只观察真实生产调用；本helper不签Main/Electron或跨run Native资格。 */
async function normalCueOwner504(input: { evidenceRoot: string; cueRoot: string; tagsRoot: string; cueManifest: string; tagsManifest: string }): Promise<void> {
  const root = input.evidenceRoot, directory = path.join(root, 'cue-normal-scan-owner504');
  const globalDeadline = Number(process.env.MB_V39_GATE_DEADLINE);
  assert.ok(Number.isFinite(globalDeadline) && globalDeadline > Date.now(), 'PREPARATION_FAILED：缺原Gate剩余期限。');
  const accepting = () => assert.ok(Date.now() < globalDeadline, '原90秒capture/480秒whole的外层期限不由helper续期。');
  const write = async (name: string, value: unknown) => {
    const file = path.join(directory, name);
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return nativeEvidencePin(file, root);
  };
  await mkdir(directory, { mode: 0o700 });
  const sourceSha = process.env.MB_V39_SOURCE_SHA, scopeSha256 = process.env.MB_V39_SCOPE_SHA256;
  assert.match(sourceSha ?? '', /^[a-f0-9]{40}$/u); assert.match(scopeSha256 ?? '', /^[a-f0-9]{64}$/u);
  const beforeProofBytes = await readFile(path.join(root, 'proof.json'));
  const beforeProof = JSON.parse(beforeProofBytes.toString('utf8')) as NativeSourceProof504;
  assert.equal(beforeProof.schema, 'musicbridge.v39.integration002.native-proof.v1');
  assert.equal(beforeProof.task, 'V39-INTEGRATION-002'); assert.equal(beforeProof.sourceSha, sourceSha); assert.equal(beforeProof.scopeSha256, scopeSha256);
  assert.equal(beforeProof.platform, 'darwin'); assert.equal(beforeProof.architecture, 'arm64');
  assert.equal(beforeProof.formats.length, 8);
  assert.equal(beforeProof.formats.reduce((count, format) => count + 1 + format.variants.length, 0), 14);
  assert.deepEqual(beforeProof.rareInputs.map(row => row.id), ['ape', 'tta', 'mpc7', 'mpc8', 'tak']);
  assert.deepEqual(beforeProof.physicalClosure, { fdsClosed: true, processesClosed: true, claimsReleased: true });
  const sourceProofPin = await write('case1-source-proof.json', beforeProof);
  const pinInput = async (pin: NativePin504) => {
    assert.ok(typeof pin.path === 'string' && !path.isAbsolute(pin.path) && !pin.path.split('/').some(part => !part || part === '.' || part === '..'));
    assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes >= 0); assert.match(pin.sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await nativeEvidencePin(path.join(root, pin.path), root), { path: pin.path, bytes: pin.bytes, sha256: pin.sha256 });
  };
  const checkedPins = new Set<string>();
  const walkPins = async (value: unknown): Promise<void> => {
    if (Array.isArray(value)) { for (const child of value) await walkPins(child); return; }
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (typeof row.path === 'string' && typeof row.bytes === 'number' && typeof row.sha256 === 'string') {
      const pin = { path: row.path, bytes: row.bytes, sha256: row.sha256 };
      if (!checkedPins.has(pin.path)) { await pinInput(pin); checkedPins.add(pin.path); }
    }
    for (const child of Object.values(row)) await walkPins(child);
  };
  await walkPins({ bundles: beforeProof.bundles, formats: beforeProof.formats, rareInputs: beforeProof.rareInputs });
  assert.equal(beforeProof.bundles.cue.manifest.sha256, input.cueManifest); assert.equal(beforeProof.bundles.tags.manifest.sha256, input.tagsManifest);
  const { coreRoot, readerBinding, cueBinding, preparation, currentOutputs } = await compiledOwner504(sourceSha!, scopeSha256!);
  const buildRaw = await write('current-core-binding.json', { readerBinding, cueBinding, preparation, currentOutputs });
  const load = async <T>(relative: string): Promise<T> => import(pathToFileURL(path.join(coreRoot, relative)).href) as Promise<T>;
  const clientModule = await load<typeof import('../../src/collection/dataset-owner-client.js')>('dist/collection/dataset-owner-client.js');
  const protocol = await load<typeof import('../../src/collection/dataset-owner-protocol.js')>('dist/collection/dataset-owner-protocol.js');
  const authority = await load<typeof import('../../src/collection/source-writes-authority.js')>('dist/collection/source-writes-authority.js');
  const locks = await load<typeof import('../../src/stream/physical-resource-locks.js')>('dist/stream/physical-resource-locks.js');
  const admissionModule = await load<typeof import('../../src/library/scan-read-admission.js')>('dist/library/scan-read-admission.js');
  const repositoryModule = await load<typeof import('../../src/collection/repository.js')>('dist/collection/repository.js');
  const stateModule = await load<typeof import('../../src/recording/backup-workflow-store.js')>('dist/recording/backup-workflow-store.js');
  const nativeModule = await load<typeof import('../../src/library/bundled-cue-converter.js')>('dist/library/bundled-cue-converter.js');
  const filesModule = await load<typeof import('../../src/recording/source-files.js')>('dist/recording/source-files.js');
  const normalize = (value: unknown): unknown => JSON.parse(Buffer.from(protocol.datasetWorkbenchJson(value)).toString('utf8'));
  const digest = (value: unknown) => protocol.datasetWorkbenchSha(protocol.datasetWorkbenchJson(value));

  const media = path.join(directory, '原中文音乐库'), dataDirectory = path.join(directory, '唯一Owner资料');
  await mkdir(media, { mode: 0o700 }); await mkdir(dataDirectory, { mode: 0o700 });
  const inputs: CueInput504[] = [];
  for (const id of ['vorbis', 'opus', 'wavpack'] as const) {
    const format = beforeProof.formats.find(value => value.id === id); assert.ok(format);
    assert.equal(format.eof, true); assert.equal(format.sourceUnchanged, true);
    assert.equal(format.encode.exitCode, 0); assert.equal(format.decode.exitCode, 0);
    inputs.push({ id, original: format.output, demuxer: id === 'wavpack' ? 'wv' : 'ogg', expectedOutput: id, frames: format.expectedFrames, sampleRate: format.sampleRate, channels: format.channels });
  }
  for (const row of beforeProof.rareInputs) {
    assert.equal(row.eof, true); assert.equal(row.exactPcm, true); assert.deepEqual(row.input, row.inputAfter);
    assert.deepEqual(row.sourceStatBefore, row.sourceStatAfter); assert.equal(row.expectedFrames, row.decodedFrames);
    assert.equal(row.flac.profile, 's24'); assert.equal(row.flac.bitsPerSample, 24);
    assert.ok(row.operations.every(value => value.exitCode === 0 && value.signal === null && value.pidClosed && value.pidObservedAbsent));
    inputs.push({ id: row.id, original: row.input, demuxer: row.demuxer, expectedOutput: 'flac', frames: row.expectedFrames, sampleRate: row.sampleRate, channels: row.channels });
  }
  assert.equal(inputs.length, 8);
  const sourcePins: { id: string; input: NativePin504; copy: NativePin504; cue: NativePin504; copyStat: ReturnType<typeof statIdentity504>; cueStat: ReturnType<typeof statIdentity504> }[] = [];
  for (const row of inputs) {
    accepting(); const album = path.join(media, '正常源-' + row.id); await mkdir(album, { mode: 0o700 });
    const name = '原音频' + path.extname(row.original.path), file = path.join(album, name), cue = path.join(album, '原索引.cue');
    const bytes = await readFile(path.join(root, row.original.path)); await pinInput(row.original);
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const body = 'TITLE "正常源-' + row.id + '"\nPERFORMER "自有艺术家 Δ"\nFILE "' + name + '" WAVE\n  TRACK 01 AUDIO\n    TITLE "第一曲：雪"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "第二曲：花"\n    INDEX 01 00:00:15\n';
    await writeFile(cue, body, { flag: 'wx', mode: 0o600 });
    row.file = file; row.cue = cue;
    const copied = await nativeEvidencePin(file, root); assert.equal(copied.bytes, row.original.bytes); assert.equal(copied.sha256, row.original.sha256);
    sourcePins.push({ id: row.id, input: row.original, copy: copied, cue: await nativeEvidencePin(cue, root), copyStat: statIdentity504(await lstat(file, { bigint: true })), cueStat: statIdentity504(await lstat(cue, { bigint: true })) });
  }
  const sourceRaw = await write('original-copy-inputs.json', sourcePins);
  const shared = new SharedArrayBuffer(locks.PHYSICAL_RESOURCE_BUFFER_BYTES), peer = new locks.PhysicalResourceCoordinator(shared);
  locks.installPhysicalResourceCoordinator(shared);
  const channel = new MessageChannel(), closedPorts = new Set<string>();
  channel.port1.once('close', () => closedPorts.add('main-source'));
  const entryPath = path.join(directory, 'actual-owner-entry.mjs'), ownerRawPath = path.join(directory, 'actual-owner-raw.json');
  const entry = ownerEntry504({
    worker: pathToFileURL(path.join(coreRoot, 'dist/collection/dataset-owner-worker.js')).href,
    domain: pathToFileURL(path.join(coreRoot, 'dist/collection/dataset-domain.js')).href,
    locks: pathToFileURL(path.join(coreRoot, 'dist/stream/physical-resource-locks.js')).href,
  });
  await writeFile(entryPath, entry, { flag: 'wx', mode: 0o600 }); const entryPin = await nativeEvidencePin(entryPath, root);
  const worker = new Worker(entryPath, { execArgv: [], stdout: true, stderr: true,
    workerData: { dataDirectory, sourcePort: channel.port2, physicalResourceBuffer: shared, evidenceRoot: root, reportPath: ownerRawPath,
      native: { cue: { root: input.cueRoot, manifestSha256: input.cueManifest }, tags: { root: input.tagsRoot, manifestSha256: input.tagsManifest }, watch: null } },
    transferList: [channel.port2] });
  const actualOwnerThreadId = worker.threadId;
  const workerStdout: Buffer[] = [], workerStderr: Buffer[] = [], fatals: string[] = [], producerErrors: unknown[] = [];
  const workerErrors: { name: string; message: string; stack?: string | undefined }[] = [];
  worker.on('error', (error: Error) => workerErrors.push({ name: error.name, message: error.message, stack: error.stack }));
  worker.stdout.on('data', (chunk: Buffer) => workerStdout.push(Buffer.from(chunk)));
  worker.stderr.on('data', (chunk: Buffer) => workerStderr.push(Buffer.from(chunk)));
  let workerExit: number | undefined; const exited = new Promise<void>(resolve => worker.once('exit', code => { workerExit = code; resolve(); }));
  const admitted = admissionModule.createScanReadAdmission({ isBusy: () => false });
  let ownerIdentity: import('../../src/collection/dataset-owner-protocol.js').DatasetOwnerIdentity | undefined;
  const endpoint = clientModule.createDatasetOwnerClient({ worker, onFatal: reason => fatals.push(reason), async projection(command, payload, context) {
    assert.ok(ownerIdentity && context.datasetId === ownerIdentity.datasetId && context.epoch === ownerIdentity.epoch);
    let result: unknown;
    if (command === 'scanReadAcquire') result = admitted.acquire(ownerIdentity);
    else if (command === 'scanReadWatchRevocation') result = await admitted.watchRevocation(ownerIdentity, (payload as { permitId: string }).permitId);
    else if (command === 'scanReadRelease') result = admitted.release(ownerIdentity, (payload as { permitId: string }).permitId);
    // 本Node链没有Main原生图像decoder，明确不可用；不制造归一化封面或资格。
    else if (command === 'normalizeLocalAlbumArtwork') result = { image: null, status: 'source-unavailable' };
    else throw new Error('本自有链不提供Provider/Roon/设备投影。');
    return result as import('../../src/collection/dataset-owner-protocol.js').DatasetProjectionCommandResults[typeof command];
  } });
  const directories = new Map<string, { binding: import('../../src/collection/source-writes-authority.js').SourceWorkbenchDirectoryBinding; fd: FileHandle; physical: import('../../src/collection/source-writes-authority.js').SourceWorkbenchDirectoryPhysical; active: boolean }>();
  const ui = new Map<string, import('../../src/collection/source-writes-authority.js').SourceWorkbenchDirectoryUi>();
  const directoryRequests: unknown[] = [], directoryFdChecks: unknown[] = [];
  const registrations = new Map<string, { request: import('../../src/collection/source-writes-authority.js').SourceWorkbenchDirectoryRegistrationRequest; resolve(value: import('../../src/collection/source-writes-authority.js').SourceWorkbenchDirectoryRegistration): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  let registrationSequence = 0, approvalSequence = 0, authorityId: string | undefined;
  const rememberUi = (family: 'management' | 'workbench', command: import('../../src/collection/source-writes-authority.js').SourceWorkbenchDirectoryUi['command'], payload: unknown, commandId: string | null) => {
    const value = authority.captureSourceWorkbenchDirectoryUi({ family, command, commandId, requestSha256: digest({ command, payload }) });
    ui.set(digest(value), value); return value;
  };
  const onSourceMessage = (raw: unknown) => { void (async () => {
    if (authority.isSourceWorkbenchDirectoryWire(raw, 'registration-reply')) {
      const reply = authority.captureSourceWorkbenchDirectoryRegistrationReply(raw), pending = registrations.get(reply.requestId);
      assert.ok(pending); authority.assertSourceWorkbenchDirectoryRegistrationReplyForRequest(reply, pending.request);
      clearTimeout(pending.timer); registrations.delete(reply.requestId);
      assert.equal(reply.ok, true); if (reply.ok) { assert.ok('kind' in reply.result); pending.resolve(reply.result); } return;
    }
    const request = authority.captureSourceWorkbenchDirectoryRequest(raw), actual = directories.get(request.binding.choiceId);
    assert.ok(actual && actual.active && ownerIdentity); assert.deepEqual(request.binding, actual.binding);
    assert.equal(request.binding.datasetId, ownerIdentity.datasetId); assert.equal(request.binding.ownerEpoch, ownerIdentity.epoch);
    assert.equal(request.sequence, ++approvalSequence); assert.ok(request.expiresAtMs > Date.now() && request.expiresAtMs <= Date.now() + 2000);
    if (authorityId === undefined) authorityId = request.authorityId; assert.equal(request.authorityId, authorityId);
    assert.deepEqual(ui.get(digest(request.ui)), request.ui, 'Main须核已登记的原正文，不能仅echo任意UI。');
    const fd = await actual.fd.stat({ bigint: true }), named = await lstat(actual.physical.path, { bigint: true });
    assert.ok(fd.isDirectory() && named.isDirectory() && !named.isSymbolicLink()); assert.equal(await realpath(actual.physical.path), actual.physical.path);
    assert.deepEqual(directoryPhysical504(actual.physical.path, fd), actual.physical); assert.deepEqual(directoryPhysical504(actual.physical.path, named), actual.physical);
    directoryRequests.push(normalize(request));
    const reply = authority.captureSourceWorkbenchDirectoryReply({ version: 1, type: 'workbench-directory-reply', purpose: 'WORKBENCH_DIRECTORY',
      requestId: request.requestId, sequence: request.sequence, authorityId: request.authorityId, command: request.command, binding: actual.binding, ui: request.ui,
      requestSha256: digest(request), decision: request.command === 'revoke' ? 'revoked' : 'approved', nonce: request.command === 'revoke' ? null : randomUUID(), validUntilMs: request.command === 'revoke' ? null : actual.binding.expiresAtMs, physical: request.command === 'revoke' ? null : actual.physical });
    authority.assertSourceWorkbenchDirectoryReplyForRequest(reply, request);
    if (request.command === 'revoke') { await actual.fd.close(); await assert.rejects(actual.fd.stat(), { code: 'EBADF' }); actual.active = false;
      directoryFdChecks.push({ choiceId: actual.binding.choiceId, physical: actual.physical, error: 'EBADF', originalCommand: 'revoke' }); }
    assert.ok(Date.now() < request.expiresAtMs); channel.port1.postMessage(reply);
  })().catch(error => {
    producerErrors.push(error instanceof Error ? { name: error.name, message: error.message } : String(error));
    for (const pending of registrations.values()) { clearTimeout(pending.timer); pending.reject(error); } registrations.clear();
    channel.port1.close();
  }); };
  channel.port1.on('message', onSourceMessage); channel.port1.start();
  const register = async (kind: 'library' | 'cue', absolute: string) => {
    assert.ok(ownerIdentity); accepting(); const physical = directoryPhysical504(absolute, await lstat(absolute, { bigint: true }));
    const fd = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    assert.deepEqual(directoryPhysical504(absolute, await fd.stat({ bigint: true })), physical);
    const originalUi = rememberUi(kind === 'library' ? 'management' : 'workbench', kind === 'library' ? 'library.import.prepare' : 'localWorkbench.cue.target', {}, null);
    const now = Date.now(), binding = authority.captureSourceWorkbenchDirectoryBinding({ datasetId: ownerIdentity.datasetId, ownerEpoch: ownerIdentity.epoch,
      childGeneration: 1, kind, choiceId: randomUUID(), revision: digest([physical, now, kind]), issuedAtMs: now, expiresAtMs: Math.min(globalDeadline, now + 600000), originalUi });
    directories.set(binding.choiceId, { binding, fd, physical, active: true });
    const request = authority.captureSourceWorkbenchDirectoryRegistrationRequest({ version: 1, type: 'workbench-directory-registration-request', purpose: 'WORKBENCH_DIRECTORY',
      requestId: randomUUID(), sequence: ++registrationSequence, command: 'register', binding, expiresAtMs: Math.min(globalDeadline, Date.now() + 2000) });
    const result = await new Promise<import('../../src/collection/source-writes-authority.js').SourceWorkbenchDirectoryRegistration>((resolve, reject) => {
      const timer = setTimeout(() => { registrations.delete(request.requestId); reject(new Error('原目录2000ms注册过期，不重发。')); }, Math.max(1, request.expiresAtMs - Date.now()));
      registrations.set(request.requestId, { request, resolve, reject, timer }); channel.port1.postMessage(request);
    });
    return { binding, result };
  };
  const flights: unknown[] = [], results: CueResult504[] = [];
  const management = async <C extends dto.LocalLibraryManagementCommand>(command: C, payload: dto.LocalLibraryManagementPayloads[C]): Promise<dto.LocalLibraryManagementResults[C]> => {
    assert.ok(ownerIdentity && endpoint.dispatchWorkbench); const began = Date.now(), controller = new AbortController();
    const value = await endpoint.dispatchWorkbench({ family: 'management', command, payload } as import('../../src/collection/dataset-owner-protocol.js').DatasetWorkbenchRequest,
      { identity: ownerIdentity, signal: controller.signal, deadlineAtMs: performance.now() + Math.min(2000, globalDeadline - Date.now()) });
    assert.ok(Date.now() - began < 2000); assert.ok(dto.isLocalLibraryManagementResult(command, value, payload)); flights.push({ command, payload, value, elapsedMs: Date.now() - began });
    return value;
  };
  const ownerCall = async <C extends import('../../src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerCommand>(command: C,
    payload: import('../../src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerPayloads[C]): Promise<import('../../src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerResults[C]> => {
    assert.ok(ownerIdentity && endpoint.dispatchWorkbenchOwner); const began = Date.now();
    const request = { command, payload } as import('../../src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerRequest;
    const value = await endpoint.dispatchWorkbenchOwner(request, { identity: ownerIdentity, deadlineAtMs: performance.now() + Math.min(2000, globalDeadline - Date.now()) });
    assert.ok(Date.now() - began < 2000); assert.ok(protocol.isDatasetWorkbenchOwnerResult(command, value, payload, ownerIdentity.datasetId)); flights.push({ command, payload, value, elapsedMs: Date.now() - began });
    return value as import('../../src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerResults[C];
  };
  const dispatch = async (command: dto.IpcCommand, payload: unknown) => {
    assert.ok(ownerIdentity); const request = { version: 1 as const, id: randomUUID(), command, payload, expectedDatasetId: ownerIdentity.datasetId } as dto.IpcRequest;
    return endpoint.dispatch(request);
  };
  let closed = false, driverPhase = 'prepare';
  let driverFailure: unknown, cleanupFailure: unknown;
  const failureView = (error: unknown): unknown => error instanceof Error ? { name: error.name, message: error.message, stack: error.stack, code: (error as Error & { code?: unknown }).code, cause: error.cause === undefined ? undefined : failureView(error.cause), errors: error instanceof AggregateError ? error.errors.map(failureView) : undefined } : String(error);
  const closeOwner = async () => {
    if (closed) return; await endpoint.close(); await exited; closed = true; assert.equal(workerExit, 0); assert.deepEqual(fatals, []);
    for (const actual of directories.values()) {
      if (!actual.active) continue;
      await actual.fd.close(); await assert.rejects(actual.fd.stat(), { code: 'EBADF' });
      directoryFdChecks.push({ choiceId: actual.binding.choiceId, physical: actual.physical, error: 'EBADF' }); actual.active = false;
    }
    if (!closedPorts.has('main-source')) await new Promise<void>(resolve => { channel.port1.once('close', resolve); channel.port1.close(); });
    assert.equal(registrations.size, 0); assert.equal(closedPorts.size, 1);
    assert.deepEqual(admitted.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: false }); admitted.close();
    assert.deepEqual(peer.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 });
  };
  try {
    ownerIdentity = await endpoint.prepare(); await endpoint.commitBoot();
    const context = await endpoint.workbenchContext!(); assert.deepEqual(context, { ...ownerIdentity, ready: true });
    driverPhase = 'library-register';
    const registered = await register('library', media); assert.equal(registered.result.kind, 'library');
    const choice = await management('library.import.prepare', {}); assert.ok(choice); assert.equal(choice.choiceId, registered.binding.choiceId);
    const confirm = { commandId: randomUUID(), choiceId: choice.choiceId, role: 'catalog' as const };
    rememberUi('management', 'library.import.confirm', confirm, confirm.commandId);
    driverPhase = 'library-import-confirm';
    const imported = await management('library.import.confirm', confirm); assert.equal(imported.state, 'succeeded'); assert.equal(imported.libraryIds.length, 1);
    const libraryId = imported.libraryIds[0]!, roots = await dispatch('localCatalog.roots', {});
    assert.ok(Array.isArray(roots) && roots.every(dto.isLibraryRoot)); const library = roots.find(value => value.id === libraryId); assert.ok(library);
    driverPhase = 'scan';
    const started = await dispatch('localScan.start', { commandId: randomUUID(), libraryRootId: libraryId, expectedRootRevision: library.revision });
    assert.ok(dto.isScanJobRecord(started));
    let scan = started;
    while (scan.phase === 'pending' || scan.phase === 'running') {
      accepting(); await new Promise<void>(resolve => setTimeout(resolve, 10));
      const current = await dispatch('localScan.get', { jobId: started.jobId }); assert.ok(dto.isScanJobRecord(current)); scan = current;
    }
    assert.equal(scan.phase, 'completed'); assert.deepEqual(scan.progress, { visited: '16', accepted: '16', rejected: '0' });
    driverPhase = 'album-complete-capture';
    const query: dto.LocalAlbumQuery = { query: '', rootId: libraryId, filter: 'all', offset: 0, limit: 100 };
    assert.ok(endpoint.readLocalAlbum); const page = await endpoint.readLocalAlbum({ command: 'localAlbum.query', payload: query }); assert.ok(dto.isLocalAlbumPage(page, query));
    assert.equal(page.total, 8); assert.equal(page.hasMore, false); assert.equal(page.items.length, 8); assert.ok(page.items.every(album => album.trackCount === 1));
    const complete = await management('library.capture', { libraryIds: [libraryId] }); assert.deepEqual(complete.libraryIds, [libraryId]);
    const read = await management('library.albums.capture', { albums: page.items.map(album => ({ albumId: album.id, rootId: album.rootId, revision: album.revision })) });
    assert.equal(read.albums.length, 8); assert.equal(new Set(read.albums.map(album => album.capture.readToken)).size, 8);
    const capabilities = await ownerCall('capabilities.read', {}); assert.ok(capabilities.capabilities['cue-preview']?.available);
    for (const album of read.albums) {
      accepting(); assert.equal(album.availability, 'online'); assert.equal(album.album.trackCount, 1);
      const resolved: import('../../src/collection/local-library-workbench/read-service.js').LocalWorkbenchResolvedReadCapture = await ownerCall('read.resolveCapture', { datasetId: ownerIdentity.datasetId, capture: album.capture });
      assert.equal(resolved.capture.members.length, 1);
      const source = inputs.find(row => resolved.directoryFacts.files.some(file => file.currentRelative === path.relative(media, row.file!).split(path.sep).join('/'))); assert.ok(source, album.album.title);
      const cues = album.cueSheets.filter(cue => cue.eligible); assert.equal(cues.length, 1);
      const outputDirectory = path.join(directory, '独立分轨-' + source.id); await mkdir(outputDirectory, { mode: 0o700 });
      driverPhase = 'cue-target-' + source.id;
      const targetRegistration = await register('cue', outputDirectory), target = { choiceId: targetRegistration.binding.choiceId, label: '自有独立输出-' + source.id, independent: true as const };
      const request: dto.LocalCueSplitInput = { datasetId: ownerIdentity.datasetId, captures: [album.capture], cueSelections: [{ albumId: album.album.albumId, cueId: cues[0]!.cueId }],
        outputFormat: 'auto', target, sourceDisposition: 'retain' };
      rememberUi('workbench', 'localWorkbench.cue.preview', request, null);
      driverPhase = 'cue-preview-' + source.id;
      const prepared = await ownerCall('cue.preparePreview', { request, target: { target, revision: targetRegistration.binding.revision } });
      assert.equal(prepared.capture.format?.codec, source.expectedOutput); assert.equal(prepared.capture.albums[0]!.members.length, 1);
      assert.equal(prepared.capture.audio?.length, 1); assert.equal(prepared.capture.audio![0]!.sampleRate, source.sampleRate);
      assert.equal(prepared.capture.audio![0]!.totalPcmFrames, source.frames); assert.equal(prepared.draft.tracks.length, 2);
      assert.deepEqual(prepared.draft.tracks.map(track => [track.startFrame, track.frameCount]), [[0, source.sampleRate / 5], [source.sampleRate / 5, source.frames - source.sampleRate / 5]]);
      const plan = await ownerCall('registry.issuePlan', prepared); assert.equal(plan.kind, 'cue'); if (plan.kind !== 'cue') assert.fail('原registry未签原CUE计划。');
      const apply: dto.LocalWorkbenchApplyRequest = { commandId: randomUUID(), datasetId: plan.datasetId, planId: plan.planId, kind: 'cue', expectedRevision: plan.revision,
        planHash: plan.planHash, contextFingerprint: plan.contextFingerprint };
      rememberUi('workbench', 'localWorkbench.plan.apply', apply, apply.commandId);
      driverPhase = 'cue-apply-' + source.id;
      let receipt = await ownerCall('registry.apply', apply);
      while (receipt.state === 'running' || receipt.state === 'unknown') {
        accepting(); await new Promise<void>(resolve => setTimeout(resolve, 10));
        const original = await ownerCall('registry.readOriginalReceipt', apply); assert.ok(original); assert.equal(original.commandId, apply.commandId); receipt = original;
      }
      assert.equal(receipt.state, 'succeeded'); assert.equal(receipt.items.length, 2); assert.ok(receipt.items.every(item => item.state === 'applied'));
      const outputs = await Promise.all(plan.tracks.map(track => nativeEvidencePin(path.join(outputDirectory, track.outputName), root)));
      results.push({ id: source.id, source: source.file!, demuxer: source.demuxer, outputDirectory, expectedOutput: source.expectedOutput, request: apply, plan, capture: prepared.capture, receipt, outputs });
    }
    driverPhase = 'owner-close'; await closeOwner();
  } catch (error) {
    driverFailure = failureView(error);
    await write('driver-first-failure.json', { phase: driverPhase, error: driverFailure, flights, completedResults: results.map(row => row.id) });
    throw error;
  } finally {
    if (!closed) {
      try { await closeOwner(); }
      catch (error) { cleanupFailure = failureView(error); if (driverFailure === undefined) throw error; }
      finally {
        await writeBytes504(path.join(directory, 'owner.failed.stdout.log'), Buffer.concat(workerStdout), root);
        await writeBytes504(path.join(directory, 'owner.failed.stderr.log'), Buffer.concat(workerStderr), root);
        await write('owner-failure.json', { phase: driverPhase, driverFailure, cleanupFailure, workerExit: workerExit ?? null, workerErrors, fatals, producerErrors });
      }
    }
  }
  const ownerRaw = JSON.parse((await readFile(ownerRawPath)).toString('utf8')) as ActualOwnerRaw504;
  assert.equal(ownerRaw.testMode, false); assert.equal(ownerRaw.factoryCount, 1); assert.equal(ownerRaw.ownerThreadId, actualOwnerThreadId);
  assert.equal(ownerRaw.factoryStartedNativeProcesses > 0, true); assert.equal(ownerRaw.sourcePortClosed, true); assert.equal(ownerRaw.parentPortClosed, true);
  assert.equal(ownerRaw.repositoryClosed, true); assert.deepEqual(ownerRaw.physical, { readers: 0, writers: 0, resources: 0 });
  assert.ok(ownerRaw.fds.length > 0 && ownerRaw.fds.every(fd => fd.closed && fd.error === 'EBADF'));
  assert.ok(ownerRaw.readerWorkers.length >= 16 && ownerRaw.readerWorkers.every(row => row.exitObserved && row.exitCode === 0));
  assert.ok(ownerRaw.readerWorkers.some(row => row.entry.endsWith('metadata-reader-worker.bundle.mjs')) && ownerRaw.readerWorkers.some(row => row.entry.endsWith('cue-sidecar-worker.js')));
  assert.ok(ownerRaw.processes.length > ownerRaw.factoryStartedNativeProcesses && ownerRaw.processes.every(row => row.closed && row.exitCode === 0 && row.signal === null && row.pidAbsent && row.groupAbsent));
  for (const row of ownerRaw.processes) { assert.throws(() => process.kill(row.pid, 0), { code: 'ESRCH' }); assert.throws(() => process.kill(-row.pid, 0), { code: 'ESRCH' }); }
  const stdoutPin = await writeBytes504(path.join(directory, 'owner.stdout.log'), Buffer.concat(workerStdout), root);
  const stderrPin = await writeBytes504(path.join(directory, 'owner.stderr.log'), Buffer.concat(workerStderr), root);
  const database = path.join(dataDirectory, 'collection.v1.sqlite'), maintenanceFile = path.join(dataDirectory, 'backup-maintenance.v1.sqlite');
  const cold = repositoryModule.createCollectionRepository({ filePath: database }), maintenance = stateModule.createBackupWorkflowStore({ filePath: maintenanceFile });
  let coldRows: unknown;
  try {
    cold.localCatalog.roots(); const identity = maintenance.datasetIdentities.bind('default', database, false);
    assert.equal(identity.datasetId, ownerIdentity!.datasetId); cold.localCatalog.privateBindWorkbenchDataset(identity);
    coldRows = cold.privateMobileCatalogAccess!(db => sqlRows504(db));
    assert.deepEqual(coldRows, ownerRaw.sqlRows);
    assert.equal(cold.localCatalog.pageTracks({ offset: 0, limit: 100 }).items.length, 8);
    for (const result of results) {
      const original = cold.localCatalog.privateCueOutputRead(identity, result.request.commandId);
      assert.ok(original); assert.equal(original.record.physicalClosed, true); assert.equal(original.record.phase, 'succeeded');
      assert.deepEqual(original.record.request, result.request); assert.deepEqual(original.record.receipt, result.receipt);
      assert.equal(original.record.published.length, 2);
    }
    cold.privateMobileCatalogAccess!(db => { assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)), [['ok']]); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
  } finally { cold.close(); maintenance.close(); }
  const verification: unknown[] = [], native = nativeModule.createCueNativeActor(await nativeModule.loadBundledCueConverter(input.cueRoot, input.cueManifest));
  const pcmVerification: { id: string; sampleRate: number; channels: number; source: Awaited<ReturnType<typeof nativeEvidencePin>>;
    tracks: { sequence: number; startFrame: number; frameCount: number; outputAudio: Awaited<ReturnType<typeof nativeEvidencePin>>;
      decoded: Awaited<ReturnType<typeof nativeEvidencePin>> }[] }[] = [];
  const verifierHandles = new Set<FileHandle>();
  let verifierPhase = 'source-decode', verifierFailure: unknown;
  try {
    for (const result of results) {
      const inputRow = inputs.find(row => row.id === result.id)!;
      const rootCapability = { ...await filesModule.authorizeSourceDirectory(path.dirname(result.source)), id: randomUUID() };
      const metadata = await filesModule.readonlySourceCandidateMetadata(rootCapability, path.basename(result.source)), commandId = randomUUID();
      await filesModule.withReadonlySourcePublicationClaims([{ root: rootCapability, relative: path.basename(result.source), expectedSignature: metadata.signature }], new AbortController().signal,
        async (verify, files) => {
          const claim = { commandId, claimId: randomUUID(), assertCurrent: verify }; verifierHandles.add(files[0]!.handle);
          const originalDecoded = path.join(directory, result.id + '-source.s32le'), decoded = await open(originalDecoded, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          verifierHandles.add(decoded);
          verifierPhase = result.id + '-source-decode';
          try { const raw = await native.decode(files[0]!.handle, decoded, result.demuxer, claim); verification.push(await rawReceipt(directory, result.id + '-source-decode', raw, root)); }
          finally { await decoded.close(); }
          const sourcePcm = await readFile(originalDecoded); assert.equal(sourcePcm.length, inputRow.frames * inputRow.channels * 4);
          const pcmRow: (typeof pcmVerification)[number] = { id: result.id, sampleRate: inputRow.sampleRate, channels: inputRow.channels,
            source: await nativeEvidencePin(originalDecoded, root), tracks: [] };
          for (const track of result.plan.tracks) {
            const output = path.join(result.outputDirectory, track.outputName), handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW); verifierHandles.add(handle);
            const target = await open(path.join(directory, result.id + '-track' + track.sequence + '.s32le'), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); verifierHandles.add(target);
            try {
              const demuxer = result.expectedOutput === 'wavpack' ? 'wv' : result.expectedOutput === 'flac' ? 'flac' : 'ogg';
              const outputPin = await nativeEvidencePin(output, root), heldStat = statIdentity504(await handle.stat({ bigint: true }));
              assert.deepEqual(outputPin, result.outputs[track.sequence - 1]);
              verifierPhase = result.id + '-track' + track.sequence + '-probe';
              const probe = await native.probe(handle, demuxer, claim); verification.push(await rawReceipt(directory, result.id + '-track' + track.sequence + '-probe', probe, root));
              assert.equal(probe.frames, track.frameCount); assert.equal(probe.sampleRate, inputRow.sampleRate); assert.equal(probe.channels, inputRow.channels);
              if (result.expectedOutput === 'flac') assert.equal(probe.bitsPerSample, 24);
              // Native子进程dup共享文件位置；解码必须重新打开原同一文件，不能复用probe已推进的FD。
              const decodeInput = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW); verifierHandles.add(decodeInput);
              try {
                const freshStat = await decodeInput.stat({ bigint: true }), namedStat = await lstat(output, { bigint: true });
                assert.ok(freshStat.isFile() && namedStat.isFile() && !namedStat.isSymbolicLink());
                assert.deepEqual(statIdentity504(freshStat), heldStat); assert.deepEqual(statIdentity504(namedStat), heldStat);
                assert.deepEqual(statIdentity504(await handle.stat({ bigint: true })), heldStat);
                verifierPhase = result.id + '-track' + track.sequence + '-decode';
                const raw = await native.decode(decodeInput, target, demuxer, claim); verification.push(await rawReceipt(directory, result.id + '-track' + track.sequence + '-decode', raw, root));
                assert.deepEqual(statIdentity504(await decodeInput.stat({ bigint: true })), heldStat);
                assert.deepEqual(statIdentity504(await lstat(output, { bigint: true })), heldStat);
                assert.deepEqual(await nativeEvidencePin(output, root), outputPin);
              } finally { await decodeInput.close(); }
            } finally { await handle.close(); await target.close(); }
            const decodedPcm = await readFile(path.join(directory, result.id + '-track' + track.sequence + '.s32le'));
            assert.equal(decodedPcm.length, track.frameCount * inputRow.channels * 4);
            const expected = sourcePcm.subarray(track.startFrame * inputRow.channels * 4, (track.startFrame + track.frameCount) * inputRow.channels * 4);
            if (!['vorbis', 'opus'].includes(result.id)) assert.deepEqual(decodedPcm, expected);
            else assert.ok(snr504(expected, decodedPcm) >= 18, '有损保持仍核实际帧范围与有限质量，不称原源无损。');
            pcmRow.tracks.push({ sequence: track.sequence, startFrame: track.startFrame, frameCount: track.frameCount,
              outputAudio: await nativeEvidencePin(output, root), decoded: await nativeEvidencePin(path.join(directory, result.id + '-track' + track.sequence + '.s32le'), root) });
          }
          pcmVerification.push(pcmRow);
        }, () => native.join(commandId));
    }
  } catch (error) {
    verifierFailure = failureView(error);
    const raw = error instanceof nativeModule.CueNativeRunError ? error.raw : undefined;
    await write('verifier-first-failure.json', { phase: verifierPhase, error: verifierFailure, raw: raw === undefined ? undefined : {
      exitCode: raw.exitCode, signal: raw.signal, pid: raw.pid, pidClosed: raw.pidClosed,
      stdout: await writeBytes504(path.join(directory, 'verifier-failed-native.stdout.log'), Buffer.from(raw.stdout), root),
      stderr: await writeBytes504(path.join(directory, 'verifier-failed-native.stderr.log'), Buffer.from(raw.stderr), root) } });
    throw error;
  } finally {
    try { await native.close(); }
    catch (error) { if (verifierFailure === undefined) throw error; await write('verifier-cleanup-failure.json', { error: failureView(error) }); }
  }
  assert.equal(verifierHandles.size, 64);
  for (const handle of verifierHandles) await assert.rejects(handle.stat(), { code: 'EBADF' });
  assert.equal(native.inspect().running, 0); assert.equal(native.inspect().unverified, 0);
  for (const row of sourcePins) {
    await pinInput(row.input); assert.deepEqual(await nativeEvidencePin(path.join(root, row.copy.path), root), row.copy); assert.deepEqual(await nativeEvidencePin(path.join(root, row.cue.path), root), row.cue);
    assert.deepEqual(statIdentity504(await lstat(path.join(root, row.copy.path), { bigint: true })), row.copyStat);
    assert.deepEqual(statIdentity504(await lstat(path.join(root, row.cue.path), { bigint: true })), row.cueStat);
  }
  const summary = { schema: 'musicbridge.v39.cue-normal-scan-owner504.evidence.v1', sourceSha, scopeSha256,
    caseName: 'CUE实际独立输出原回执、品牌恢复和SQLite冷回读保持原命令，不重编码或覆盖同名外部文件', domain: 'native',
    sourceProof: sourceProofPin, currentBuild: buildRaw, ownerEntry: entryPin, inputs: sourceRaw, owner: { raw: await nativeEvidencePin(ownerRawPath, root), stdout: stdoutPin, stderr: stderrPin, exitCode: workerExit },
    originalCaptureScope: '8完整专辑/8物理成员/8真实CUE/16声明轨；非Electron Main资格', flights,
    results, verification, pcmVerification, directoryRequests, directoryFdChecks, producerErrors, cold: { nativeReinitialized: false, previewOrApply: false, sameDatasetId: ownerIdentity!.datasetId, rows: coldRows },
    physical: { actualCombinedTable: peer.combinedSnapshot(), sourcePortCloseEvents: [...closedPorts], admission: admitted.resourceCounts(), verifierFdChecks: verifierHandles.size },
    qualifier: { inputOrigin: '本次case1真实资格pins', warmOwnerFirstInitialization: '真实默认factory再次完成该新作者mandatory资格，不从JSON恢复WeakSet', crossRunQualification: false } };
  assert.deepEqual(producerErrors, []); accepting(); const raw = await write('normal-scan-entry.json', summary);
  assert.deepEqual(peer.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 });
  await mergeNativeEvidence(root, { cueNormalScanEntry: { raw, sourceProof: sourceProofPin, currentBuild: buildRaw, ownerEntry: entryPin, owner: summary.owner,
    sourceSha, scopeSha256, caseName: summary.caseName, domain: 'native', inputFamilies: inputs.map(row => row.id), sameDatasetId: ownerIdentity!.datasetId,
    libraryAlbums: 8, libraryMembers: 8, cueSources: 8, outputTracks: 16, sourceUnchanged: true, coldReadOnly: true, nativeQualificationReusedAcrossRun: false,
    physicalClosure: { ownerNaturalExit: workerExit === 0, actualCombinedTable: peer.combinedSnapshot(), mainSourcePortClosed: closedPorts.has('main-source') } } });
}

type NativePin504 = { path: string; bytes: number; sha256: string };
type NativeSourceProof504 = Awaited<ReturnType<typeof qualifyCueEightFormats>> & { schema: string; task: string; sourceSha: string; scopeSha256: string; platform: string; architecture: string };
type CueInput504 = { id: string; original: NativePin504; demuxer: import('../../src/library/bundled-cue-converter.js').CueInputDemuxer; expectedOutput: string; frames: number; sampleRate: number; channels: number; file?: string; cue?: string };
type CueResult504 = { id: string; source: string; demuxer: import('../../src/library/bundled-cue-converter.js').CueInputDemuxer; outputDirectory: string; expectedOutput: string; request: dto.LocalWorkbenchApplyRequest; plan: Extract<dto.LocalWorkbenchPlan, { kind: 'cue' }>; capture: LocalWorkbenchPlanCapture; receipt: dto.LocalWorkbenchReceipt; outputs: NativePin504[] };
type ActualOwnerRaw504 = { testMode: false; factoryCount: number; ownerThreadId: number; factoryStartedNativeProcesses: number; sourcePortClosed: boolean; parentPortClosed: boolean; repositoryClosed: boolean; physical: { readers: number; writers: number; resources: number }; sqlRows: unknown;
  readerWorkers: { entry: string; exitObserved: boolean; exitCode: number }[]; fds: { closed: boolean; error: string }[]; processes: { pid: number; closed: boolean; exitCode: number; signal: null; pidAbsent: boolean; groupAbsent: boolean }[] };
function statIdentity504(value: import('node:fs').BigIntStats) { return Object.fromEntries(['dev','ino','size','mode','nlink','uid','gid','mtimeNs','ctimeNs'].map(key => [key, String(value[key as keyof typeof value])])); }
function directoryPhysical504(absolute: string, value: import('node:fs').BigIntStats) { return { path: absolute, dev: String(value.dev), ino: String(value.ino), birthtimeNs: String(value.birthtimeNs), mode: String(value.mode), uid: String(value.uid), gid: String(value.gid) }; }
async function writeBytes504(file: string, bytes: Buffer, root: string) { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); return nativeEvidencePin(file, root); }
function sqlRows504(db: import('node:sqlite').DatabaseSync): unknown {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => {
    assert.equal(typeof row.name, 'string'); assert.match(row.name as string, /^[a-zA-Z0-9_]+$/u);
    return [row.name, db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid').all().map(value => JSON.parse(JSON.stringify(value)))];
  }));
}
function snr504(expected: Buffer, actual: Buffer): number {
  assert.equal(expected.length, actual.length); let signal = 0, noise = 0;
  for (let offset = 0; offset < expected.length; offset += 4) { const a = expected.readInt32LE(offset) / 2147483648, b = actual.readInt32LE(offset) / 2147483648; signal += a * a; noise += (a - b) ** 2; }
  return noise === 0 ? 100 : 10 * Math.log10(signal / noise);
}
async function compiledOwner504(sourceSha: string, scopeSha256: string) {
  const coreRoot = fileURLToPath(new URL('../../', import.meta.url)), repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const regular = async (absolute: string) => {
    assert.ok(path.isAbsolute(absolute)); const info = await lstat(absolute);
    assert.ok(info.isFile() && !info.isSymbolicLink() && await realpath(absolute) === absolute);
    return { info, bytes: await readFile(absolute) };
  };
  const pinShape = (row: { bytes: number; sha256: string }) => { assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0); assert.match(row.sha256, /^[a-f0-9]{64}$/u); };
  const relative = (value: string) => { assert.ok(typeof value === 'string' && !path.isAbsolute(value) && !value.split('/').some(part => !part || part === '.' || part === '..')); };
  const readerPath = process.env.MBRS003_READER_BUILD_BINDING, cuePath = process.env.MBRS003_CUE_BUILD_BINDING;
  assert.ok(readerPath && cuePath && path.isAbsolute(readerPath) && path.isAbsolute(cuePath), 'PREPARATION_FAILED：Native childEnv须消费本Source真实Reader/CUE准备绑定。');
  const readerBinding = JSON.parse((await regular(readerPath)).bytes.toString('utf8')) as CoreBinding504;
  const cueBinding = JSON.parse((await regular(cuePath)).bytes.toString('utf8')) as CoreBinding504;
  for (const value of [readerBinding, cueBinding]) {
    assert.ok(['whole-source-standard-run', 'fresh-native-preparation-run'].includes(value.timeBasis), 'PREPARATION_FAILED：缺失或未知真实准备来源，不能借另job标准时钟。');
    assert.equal(value.sourceSha, sourceSha); assert.equal(value.scopeSha256, scopeSha256); assert.equal(value.compilerExit, 0);
    assert.ok(Number.isFinite(value.compilerStartedAtMs) && value.compilerStartedAtMs > 0 && Number.isFinite(value.compilerFinishedAtMs) && value.compilerFinishedAtMs >= value.compilerStartedAtMs);
    assert.equal(value.originalSingleCompilerIntervalsRetained, true);
  }
  assert.equal(readerBinding.timeBasis, cueBinding.timeBasis); assert.equal(readerBinding.compilerStartedAtMs, cueBinding.compilerStartedAtMs); assert.equal(readerBinding.compilerFinishedAtMs, cueBinding.compilerFinishedAtMs);
  assert.equal(readerBinding.schema, 'mbrs003.reader.fresh-build.v2'); assert.equal(cueBinding.schema, 'mbrs003.cue.fresh-build.v1');
  const original = readerBinding.originalPreparationReceipt; assert.ok(original && path.isAbsolute(original.path)); pinShape(original); assert.ok(original.bytes > 0);
  assert.deepEqual(cueBinding.originalPreparationReceipt, original);
  const raw = (await regular(original.path)).bytes; assert.equal(raw.length, original.bytes); assert.equal(digest(raw), original.sha256);
  const preparation = JSON.parse(raw.toString('utf8')) as CorePreparation504;
  assert.equal(preparation.schema, 'core-test.reader-preparation.v1'); assert.equal(preparation.status, 'FRESH_READER_PREPARED');
  assert.equal(preparation.inputsUnchanged, true); assert.equal(preparation.outputsUnchanged, true);
  assert.deepEqual(preparation.stages.map(row => row.name), ['fresh-contracts-compiler', 'fresh-core-compiler', 'fresh-fixed-metadata-worker']);
  for (const [index, stage] of preparation.stages.entries()) {
    // 原producer只在error/signal为空且自然status=0后封compilerExit=0，沿原收据语义，不发明自然退出字段。
    assert.equal(stage.compilerExit, 0); assert.ok(Number.isFinite(stage.startedMs) && stage.startedMs > 0 && Number.isFinite(stage.finishedMs) && stage.finishedMs >= stage.startedMs);
    assert.ok(stage.startedMs >= readerBinding.compilerStartedAtMs && stage.finishedMs <= readerBinding.compilerFinishedAtMs);
    if (index) assert.ok(stage.startedMs >= preparation.stages[index - 1]!.finishedMs, '原三准备阶段必须顺序完成，不能并行或倒序借窗。');
  }
  const [contractsStage, coreStage, fixedStage] = preparation.stages;
  assert.ok(contractsStage && coreStage && fixedStage);
  const nativePreparation = readerBinding.timeBasis === 'fresh-native-preparation-run';
  if (nativePreparation) {
    assert.equal(readerBinding.compilerStartedAtMs, Math.min(...preparation.stages.map(row => row.startedMs)));
    assert.equal(readerBinding.compilerFinishedAtMs, Math.max(...preparation.stages.map(row => row.finishedMs)));
  }
  // 原件完整保留；新Native窗口只包这三真实stage，完整standard模式继续包原整体运行。
  const precompile = JSON.parse((await regular(path.join(path.dirname(original.path), 'precompile-inputs.json'))).bytes.toString('utf8')) as { schema: string; sourceInputs: CorePreparation504['sourceInputs']; toolInputs: CorePreparation504['toolInputs'] };
  assert.equal(precompile.schema, 'core-test.precompile-inputs.v1'); assert.deepEqual(precompile.sourceInputs, preparation.sourceInputs); assert.deepEqual(precompile.toolInputs, preparation.toolInputs);
  const originalReaderRaw = (await regular(path.join(path.dirname(original.path), 'reader-build-binding.json'))).bytes;
  assert.match(preparation.readerBindingSha256, /^[a-f0-9]{64}$/u); assert.equal(digest(originalReaderRaw), preparation.readerBindingSha256);
  const originalReader = JSON.parse(originalReaderRaw.toString('utf8')) as CoreBinding504;
  assert.equal(originalReader.schema, 'mbrs003.reader.fresh-build.v2'); assert.equal(originalReader.compilerExit, 0);
  assert.equal(originalReader.compilerStartedAtMs, coreStage.startedMs);
  assert.ok(Number.isFinite(originalReader.compilerFinishedAtMs) && originalReader.compilerFinishedAtMs >= originalReader.compilerStartedAtMs && originalReader.compilerFinishedAtMs <= coreStage.finishedMs);
  assert.ok(originalReader.fixedWorkerBundle); assert.equal(originalReader.fixedWorkerBundle.schema, 'mbrs003.metadata-worker.fixed-bundle.v2');
  assert.ok(Number.isFinite(originalReader.fixedWorkerBundle.startedAtMs) && Number.isFinite(originalReader.fixedWorkerBundle.finishedAtMs) && originalReader.fixedWorkerBundle.startedAtMs >= fixedStage.startedMs && originalReader.fixedWorkerBundle.finishedAtMs >= originalReader.fixedWorkerBundle.startedAtMs && originalReader.fixedWorkerBundle.finishedAtMs <= fixedStage.finishedMs);
  const scope = (await regular(path.join(repositoryRoot, 'docs/integration/V39-INTEGRATION-002/EXECUTION_SCOPE.json'))).bytes; assert.equal(digest(scope), scopeSha256);
  assert.ok(preparation.sourceInputs.length > 0); assert.equal(new Set(preparation.sourceInputs.map(row => row.path)).size, preparation.sourceInputs.length);
  for (const row of preparation.sourceInputs) {
    relative(row.path); pinShape(row); const bytes = (await regular(path.join(repositoryRoot, row.path))).bytes;
    assert.equal(bytes.length, row.bytes); assert.equal(digest(bytes), row.sha256);
  }
  assert.ok(preparation.sourceInputs.some(row => row.path === 'scripts/ci/run-core-tests.mjs'));
  // 只调用已整件核过的原只读输入清单函数，不调用prepare/编译/测试，避免另造一个不完整源闭集。
  const sourceInventory = await import(pathToFileURL(path.join(repositoryRoot, 'scripts/ci/run-core-tests.mjs')).href) as { coreTestSourceInputs(): CorePreparation504['sourceInputs'] };
  assert.deepEqual(sourceInventory.coreTestSourceInputs(), preparation.sourceInputs);
  const { createRequire } = await import('node:module'), require = createRequire(path.join(coreRoot, 'package.json'));
  const typescriptPackage = require.resolve('typescript/package.json');
  const toolFiles = await Promise.all([require.resolve('typescript/bin/tsc'), typescriptPackage, ...['tsc.js', '_tsc.js'].map(name => path.join(path.dirname(typescriptPackage), 'lib', name))].map(file => realpath(file)));
  assert.deepEqual(preparation.toolInputs.map(row => row.file), toolFiles); assert.equal(new Set(toolFiles).size, 4);
  for (const row of preparation.toolInputs) { pinShape(row); const bytes = (await regular(row.file)).bytes; assert.equal(bytes.length, row.bytes); assert.equal(digest(bytes), row.sha256); }
  assert.equal((JSON.parse((await regular(await realpath(typescriptPackage))).bytes.toString('utf8')) as { version: string }).version, '5.9.3');
  const compiledSources = preparation.sourceInputs.filter(row => /^packages\/(?:bridge-core|contracts)\/src\//u.test(row.path) && row.path.endsWith('.ts') && !row.path.endsWith('.d.ts'));
  const fixedFiles = ['.mjs', '.mjs.map', '.meta.json', '.build.json'].map(suffix => 'packages/bridge-core/dist/library/metadata-reader-worker.bundle' + suffix);
  const expectedOutputs = [...compiledSources.flatMap(row => ['.js', '.js.map', '.d.ts'].map(suffix => row.path.replace('/src/', '/dist/').slice(0, -3) + suffix)), ...fixedFiles].sort();
  assert.ok(compiledSources.length > 0); assert.deepEqual(preparation.outputs.map(row => row.path).sort(), expectedOutputs); assert.equal(new Set(expectedOutputs).size, expectedOutputs.length);
  const currentOutputs: NativePin504[] = [];
  for (const row of preparation.outputs) {
    pinShape(row); const { info, bytes } = await regular(path.join(repositoryRoot, row.path));
    const stage = fixedFiles.includes(row.path) ? fixedStage : row.path.startsWith('packages/contracts/') ? contractsStage : coreStage;
    assert.ok(Number.isFinite(row.mtimeMs) && row.mtimeMs >= stage.startedMs && row.mtimeMs <= stage.finishedMs);
    assert.ok(info.mtimeMs >= readerBinding.compilerStartedAtMs && info.mtimeMs <= readerBinding.compilerFinishedAtMs);
    // standard末尾再次build可更新原fixed manifest时钟；Native三阶段准备无第二次build，连该原件也必须完全相等。
    if (nativePreparation || !row.path.endsWith('.bundle.build.json')) { assert.equal(bytes.length, row.bytes); assert.equal(digest(bytes), row.sha256); }
    if (nativePreparation) assert.equal(info.mtimeMs, row.mtimeMs, 'Native必须消费原三准备产物，不能借旧dist或准备后重编译。');
    if (!fixedFiles.includes(row.path)) {
      const source = compiledSources.find(value => value.path === row.sourcePath); assert.ok(source); assert.equal(row.sourceSha256, source.sha256);
      assert.ok(['.js', '.js.map', '.d.ts'].some(suffix => source.path.replace('/src/', '/dist/').slice(0, -3) + suffix === row.path));
      if (row.path.startsWith('packages/bridge-core/')) assert.ok(row.mtimeMs <= originalReader.compilerFinishedAtMs);
    } else { assert.equal(row.sourcePath, undefined); assert.equal(row.sourceSha256, undefined); }
    currentOutputs.push({ path: row.path, bytes: bytes.length, sha256: digest(bytes) });
  }
  for (const binding of [readerBinding, cueBinding, originalReader]) {
    const sourceNames = binding === cueBinding ? ['src/library/cue-sidecar-reader.ts', 'src/library/cue-sidecar-worker.ts'] : ['src/recording/source-files.ts', 'src/library/metadata-reader.ts', 'src/library/metadata-reader-worker.ts', 'src/library/metadata-reader-types.ts'];
    assert.deepEqual(binding.sourceInputs.map(row => row.file).sort(), [...sourceNames].sort());
    assert.deepEqual(binding.outputs.map(row => row.file).sort(), sourceNames.flatMap(file => ['.js', '.js.map'].map(suffix => file.replace(/^src\//u, 'dist/').slice(0, -3) + suffix)).sort());
    for (const row of binding.sourceInputs) {
      const source = preparation.sourceInputs.find(value => value.path === 'packages/bridge-core/' + row.file); assert.ok(source); assert.equal(row.bytes, source.bytes); assert.equal(row.sha256, source.sha256);
    }
    for (const row of binding.outputs) {
      const output = preparation.outputs.find(value => value.path === 'packages/bridge-core/' + row.file); assert.ok(output); assert.equal(row.bytes, output.bytes); assert.equal(row.sha256, output.sha256);
      const { info, bytes } = await regular(path.join(coreRoot, row.file)); assert.equal(bytes.length, row.bytes); assert.equal(digest(bytes), row.sha256);
      if (binding !== originalReader) assert.ok(info.mtimeMs >= binding.compilerStartedAtMs && info.mtimeMs <= binding.compilerFinishedAtMs);
    }
  }
  for (const stem of ['reader', 'worker']) {
    const js = path.join(coreRoot, 'dist/library/cue-sidecar-' + stem + '.js'), map = JSON.parse((await regular(js + '.map')).bytes.toString('utf8')) as { file: string; sourceRoot: string; sources: string[] };
    assert.equal(map.file, path.basename(js)); assert.equal(map.sourceRoot, ''); assert.equal(map.sources.length, 1);
    assert.equal(path.resolve(path.dirname(js), map.sources[0]!), path.join(coreRoot, 'src/library/cue-sidecar-' + stem + '.ts'));
  }
  // 原v2 helper独立核fixed全manifest/源码graph/map/工具SHA，并核Reader八JS/map；不从本测试构造假绑定。
  await loadFreshMetadataReader(); assert.ok(readerBinding.fixedWorkerBundle);
  assert.ok(readerBinding.fixedWorkerBundle.startedAtMs >= readerBinding.compilerStartedAtMs && readerBinding.fixedWorkerBundle.finishedAtMs <= readerBinding.compilerFinishedAtMs);
  if (nativePreparation) assert.deepEqual(readerBinding.fixedWorkerBundle, originalReader.fixedWorkerBundle);
  for (const source of ['collection/dataset-owner-worker', 'collection/dataset-owner-client', 'collection/dataset-domain', 'collection/source-writes-authority', 'collection/repository', 'recording/backup-workflow-store', 'stream/physical-resource-locks']) {
    for (const suffix of ['.js', '.js.map']) assert.ok(currentOutputs.some(row => row.path === 'packages/bridge-core/dist/' + source + suffix));
    assert.ok(preparation.sourceInputs.some(row => row.path === 'packages/bridge-core/src/' + source + '.ts'));
  }
  return { coreRoot, readerBinding, cueBinding, preparation, currentOutputs };
}
type CoreBinding504 = { schema: string; compilerExit: number; compilerStartedAtMs: number; compilerFinishedAtMs: number; timeBasis: string; sourceSha: string; scopeSha256: string;
  sourceInputs: { file: string; bytes: number; sha256: string }[]; outputs: { file: string; bytes: number; sha256: string }[]; originalPreparationReceipt: NativePin504;
  originalSingleCompilerIntervalsRetained: boolean; fixedWorkerBundle?: { schema: string; startedAtMs: number; finishedAtMs: number } };
type CorePreparation504 = { schema: string; status: string; inputsUnchanged: boolean; outputsUnchanged: boolean; sourceInputs: { path: string; bytes: number; sha256: string }[];
  toolInputs: { file: string; bytes: number; sha256: string }[]; readerBindingSha256: string;
  outputs: { path: string; bytes: number; sha256: string; mtimeMs: number; sourcePath?: string; sourceSha256?: string }[]; stages: { name: string; compilerExit: number; startedMs: number; finishedMs: number }[] };
function ownerEntry504(urls: { worker: string; domain: string; locks: string }): string {
  return `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import threads from 'node:worker_threads';
import { parentPort, workerData, threadId } from 'node:worker_threads';
import { writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
assert.ok(parentPort && workerData.sourcePort);
const urls = ${JSON.stringify(urls)};
const fds = [], processes = [], phaseEvents = [], readerWorkers = [];
let phase = 'owner-native-first-prepare', sourcePortClosed = false, parentPortClosed = false, repositoryClosed = false, sqlRows, factoryCount = 0, factoryStartedNativeProcesses = 0, reportWritten = false;
const originalOpen = fs.promises.open, originalSpawn = cp.spawn, OriginalWorker = threads.Worker;
threads.Worker = class ObservedActualWorker extends OriginalWorker {
  constructor(...args) {
    super(...args);
    const row = { entry: String(args[0]), threadId: this.threadId, execArgv: args[1]?.execArgv ?? [], exitObserved: false, exitCode: null };
    readerWorkers.push(row); this.once('exit', code => { row.exitObserved = true; row.exitCode = code; });
  }
};
fs.promises.open = async function(...args) {
  const handle = await originalOpen(...args), originalClose = handle.close.bind(handle);
  const row = { serial: fds.length + 1, path: typeof args[0] === 'string' ? args[0] : String(args[0]), fd: handle.fd, phase, closed: false, error: null };
  fds.push(row);
  handle.close = async function() {
    await originalClose();
    try { await handle.stat(); assert.fail('真实FileHandle.close之后仍能stat。'); }
    catch(error) { assert.equal(error.code, 'EBADF'); row.closed = true; row.error = error.code; }
  };
  return handle;
};
cp.spawn = function(...args) {
  const child = originalSpawn(...args), row = { pid: child.pid, executable: args[0], args: args[1], phase, closed: false, exitCode: null, signal: null, stdout: '', stderr: '', pidAbsent: false, groupAbsent: false };
  const stdout = [], stderr = []; processes.push(row);
  child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk))); child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
  child.once('close', (code, signal) => {
    row.closed = true; row.exitCode = code; row.signal = signal; row.stdout = Buffer.concat(stdout).toString('base64'); row.stderr = Buffer.concat(stderr).toString('base64');
    for (const [key, pid] of [['pidAbsent', child.pid], ['groupAbsent', -child.pid]]) {
      try { process.kill(pid, 0); } catch(error) { if(error.code === 'ESRCH') row[key] = true; }
    }
  });
  return child;
};
syncBuiltinESMExports();
workerData.sourcePort.once('close', () => { sourcePortClosed = true; });
parentPort.once('close', () => { parentPortClosed = true; });
const locks = await import(urls.locks); locks.installPhysicalResourceCoordinator(workerData.physicalResourceBuffer);
const { attachDatasetOwnerWorkerPort } = await import(urls.worker);
const { prepareOwnedDatasetDomain } = await import(urls.domain);
function normalizeRows(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => {
    assert.match(row.name, /^[a-zA-Z0-9_]+$/u);
    return [row.name, db.prepare('SELECT * FROM "' + row.name + '" ORDER BY rowid').all().map(value => JSON.parse(JSON.stringify(value)))];
  }));
}
async function pins(directory) {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if(entry.isDirectory()) rows.push(...await pins(absolute));
    else if(entry.isFile()) {
      const bytes = await readFile(absolute);
      rows.push({ path: path.relative(workerData.evidenceRoot, absolute).split(path.sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } else assert.fail('作者资格原件包含非普通文件。');
  }
  return rows;
}
let authorInitializationFiles = [];
attachDatasetOwnerWorkerPort(parentPort, {
  privateSourceWritesPort: workerData.sourcePort,
  async prepare(epoch, projection, sourceWritesMainActor) {
    assert.ok(sourceWritesMainActor); assert.equal(++factoryCount, 1);
    const began = Date.now();
    // 完整默认生产工厂真实执行本作者首次mandatory资格；没有Reader/Native/ACK注入。
    let domain;
    try { domain = await prepareOwnedDatasetDomain({ dataDirectory: workerData.dataDirectory, epoch, testMode: false, projection, sourceWritesMainActor, localWorkbenchNative: workerData.native }); }
    catch(error) {
      const view=e=>e&&typeof e==='object'?{name:e.name,message:e.message,stack:e.stack,code:e.code,cause:e.cause?view(e.cause):undefined,errors:Array.isArray(e.errors)?e.errors.map(view):undefined}:String(e);
      await writeFile(workerData.reportPath+'.prepare-error.json',JSON.stringify({phase,factoryCount,error:view(error)},null,2)+'\\n',{flag:'wx',mode:0o600});
      throw error;
    }
    factoryStartedNativeProcesses = processes.length;
    phaseEvents.push({ phase, began, finished: Date.now(), datasetId: domain.datasetId, epoch, actualFactoryNativeProcesses: processes.length });
    authorInitializationFiles = (await pins(workerData.dataDirectory)).filter(row => row.path.includes('cue-qualification-' + epoch + '/'));
    assert.ok(authorInitializationFiles.length > 14);
    phase = 'production-owner-ready';
    const originalDispatch = domain.dispatchWorkbenchOwner.bind(domain), originalClose = domain.close.bind(domain);
    domain.dispatchWorkbenchOwner = async (request, context) => {
      phase = request.command + ('commandId' in request.payload ? ':' + request.payload.commandId : '');
      const began = Date.now(), result = await originalDispatch(request, context);
      phaseEvents.push({ command: request.command, began, finished: Date.now() }); return result;
    };
    domain.close = async beforeConnectionClose => {
      phase = 'actual-owner-close';
      await originalClose(async () => {
        await beforeConnectionClose?.();
        sqlRows = domain.collection.privateMobileCatalogAccess(db => normalizeRows(db));
      });
      assert.throws(() => domain.collection.localCatalog.roots()); repositoryClosed = true;
    };
    return domain;
  },
});
process.once('beforeExit', async () => {
  assert.equal(reportWritten, false); reportWritten = true;
  assert.ok(sourcePortClosed && parentPortClosed && repositoryClosed);
  assert.ok(fds.length > 0 && fds.every(row => row.closed && row.error === 'EBADF'));
  assert.ok(processes.length > factoryStartedNativeProcesses && processes.every(row => row.closed && row.exitCode === 0 && row.signal === null));
  assert.ok(readerWorkers.length >= 16 && readerWorkers.every(row => row.exitObserved && row.exitCode === 0));
  for (const row of processes) {
    for (const [key, pid] of [['pidAbsent', row.pid], ['groupAbsent', -row.pid]]) {
      try { process.kill(pid, 0); assert.fail('实际Native PID或进程组尚在。'); } catch(error) { assert.equal(error.code, 'ESRCH'); row[key] = true; }
    }
  }
  const physical = locks.physicalResourceLocks.combinedSnapshot(); assert.deepEqual(physical, { readers: 0, writers: 0, resources: 0 });
  await writeFile(workerData.reportPath, JSON.stringify({ schema: 'musicbridge.v39.cue-normal-owner504.raw.v1', testMode: false, factoryCount, ownerThreadId: threadId, factoryStartedNativeProcesses,
    sourcePortClosed, parentPortClosed, repositoryClosed, physical, sqlRows, fds, processes, readerWorkers, phaseEvents, authorInitializationFiles,
    observations: '只包装真实open/close/spawn并返回原对象，不替Native/Reader/prepare ACK。' }, null, 2) + '\\n', { flag: 'wx', mode: 0o600 });
});
`;
}
