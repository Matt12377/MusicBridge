import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, readdirSync, readlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateIpcRequest, validateIpcResponseForCommand, validateIpcInternalResponseForCommand, isCollectionId, isCollectionModel, isCollectionFilter } from '@music-bridge/contracts'
import { filterCollectionSnapshot, projectCollectionFilter } from '../../../../packages/bridge-core/src/rust-core/collection-query.js'
import { COLLECTION_SCALE_COUNTS, COLLECTION_SCALE_WORKLOADS, collectionScaleDescriptor } from '../../scripts/collection-scale-seed.js'
import { isCollectionReadonlyControlRequest,isCollectionReadonlyControlResponse } from '../../src/main/collection-readonly-control-protocol.js'
import { parseCollectionScaleEvent } from '../../scripts/collection-scale-runtime.mjs'
import { rendererCheck as check, rendererExact as exact, rendererSame as same, rendererOnlyData as onlyData,
 rendererExternalPath as externalPath, rendererBytesAt as bytesAt, rendererDigest as digest, rendererJsonDigest as jsonDigest,
 rendererSha as sha, type RendererArtifactIdentity } from './rust-packaged-renderer-cost.js'

export const COLLECTION_SCALE_PACKAGE_KEYS = ['default-node', 'scale-0', 'scale-100', 'scale-2000', 'scale-2001', 'scale-5000', 'scale-5001'] as const
export const COLLECTION_SCALE_RUN_KEYS = ['default-node', ...COLLECTION_SCALE_COUNTS.flatMap(count => [`scale-${count}-fresh`, `scale-${count}-cold`])] as readonly string[]
export const COLLECTION_SCALE_COST_RUN_KEYS = COLLECTION_SCALE_RUN_KEYS.filter(key => key !== 'default-node')
type PackageKind = typeof COLLECTION_SCALE_PACKAGE_KEYS[number]
const BASE_COMMIT = '906a3841df3424fff05b6071f4342f312d0c7de9'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'))
const asar = desktopRequire(desktopRequire.resolve('@electron/asar', { paths: [path.dirname(desktopRequire.resolve('electron-builder'))] }))
const commit = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const countFor = (kind: string): number => kind === 'default-node' ? 0 : Number(kind.split('-')[1])
const entries = (events: any[], name: string): any[] => events.filter(event => event.event === name)
function single(events: any[], name: string): any { const found=entries(events,name);check(found.length===1);return found[0] }
function artifact(identity: any, expected: any): any {
 exact(identity,['path','sha256','bytes']);exact(expected,['path','sha256','bytes']);same(identity,expected)
 check(sha(identity.sha256)&&Number.isSafeInteger(identity.bytes)&&identity.bytes>0)
 const bytes=bytesAt(identity.path,1024*1024*1024);check(bytes.length===identity.bytes&&digest(bytes)===identity.sha256)
 const value=JSON.parse(bytes.toString());onlyData(value);return value
}
export interface CollectionScaleExpectedIdentity { baseCommit:string;sourceCommit:string;sourceSha256:string;packages:Record<PackageKind,any>;runs:Record<string,RendererArtifactIdentity>;sqliteReferences:Record<string,RendererArtifactIdentity>;costEvidence:RendererArtifactIdentity }
export interface CollectionScaleEvidenceReport extends Omit<CollectionScaleExpectedIdentity,'runs'> {
 schemaVersion:1;task:'RUST-015';state:'PASS';runs:Record<string,{receipt:any;evidence:RendererArtifactIdentity}>;
 productionDefault:'Node';businessDatabaseWriter:'Node';mainOutboxWriter:'Main';rendererFullDtoObservation:'PASSIVE_RENDERER_COMMIT_FULL_DTO_AND_PAINT_OPPORTUNITY';ownerAcceptance:'NOT_RUN';realServices:'NOT_RUN';installation:'NOT_RUN';push:'NOT_RUN'
}
function originalAssetsFor(value: any, archive: string): void {
 exact(value, ['sources', 'asar']); check(Array.isArray(value.sources) && value.sources.length > 0 && Array.isArray(value.asar) && value.asar.length > 0)
 const assets = asar.listPackage(archive).map((file:string)=>file.replace(/^\//u,''))
  .filter((file:string)=>/^(?:dist\/preload|dist\/renderer)\//u.test(file) && !file.endsWith('.map') && !asar.statFile(archive,file).files).sort()
 same(value.asar.map((entry:any)=>entry.path),assets)
 for (const entry of value.asar) { exact(entry,['path','sha256']); check(sha(entry.sha256) && digest(asar.extractFile(archive,entry.path))===entry.sha256) }
 const sources=value.sources.map((entry:any)=>entry.path);check(new Set(sources).size===sources.length);same([...sources].sort(),sources)
 for(const required of ['service','store','ipc','executor'])check(sources.includes(`apps/desktop/src/main/command-outbox-${required}.ts`))
 same(sources,['apps/desktop/src/main/command-outbox-executor.ts','apps/desktop/src/main/command-outbox-ipc.ts','apps/desktop/src/main/command-outbox-service.ts','apps/desktop/src/main/command-outbox-store.ts','apps/desktop/src/main/dataset-owner-bootstrap.ts','apps/desktop/src/main/dataset-owner-entry.ts','packages/bridge-core/src/collection/dataset-domain.ts','packages/bridge-core/src/collection/dataset-owner-client.ts','packages/bridge-core/src/collection/dataset-owner-protocol.ts','packages/bridge-core/src/collection/dataset-owner-worker.ts'])
 for(const entry of value.sources){
  exact(entry,['path','sha256']);check(typeof entry.path==='string'&&/^(?:apps\/desktop\/src\/main\/(?:command-outbox-(?:service|store|ipc|executor)|dataset-owner-(?:entry|bootstrap))\.ts|packages\/bridge-core\/src\/collection\/[^/]+\.ts)$/u.test(entry.path)&&path.normalize(entry.path)===entry.path&&!entry.path.includes('..')&&sha(entry.sha256))
  const file=path.join(root,entry.path);check(realpathSync(file)===file&&lstatSync(file).isFile()&&digest(readFileSync(file))===entry.sha256)
  const base=spawnSync('git',['show',`${BASE_COMMIT}:${entry.path}`],{cwd:root,encoding:null,maxBuffer:16*1024*1024});check(base.status===0&&!base.error&&digest(base.stdout)===entry.sha256)
 }
}
function tree(directory: string) {
  const entries: any[] = []
  function visit(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = path.relative(directory, file).replaceAll(path.sep, '/'), info = lstatSync(file)
      if (info.isSymbolicLink()) { check(realpathSync(file).startsWith(directory + '/')); entries.push({ path: relative, kind: 'symlink', target: readlinkSync(file) }) }
      else if (info.isDirectory()) visit(file)
      else { check(info.isFile()); entries.push({ path: relative, kind: 'file', sha256: digest(readFileSync(file)), bytes: info.size, mode: info.mode & 0o777 }) }
    }
  }
  visit(directory); return entries
}

function packageFor(value: any, kind: PackageKind, sourceCommit: string) {
  exact(value, ['candidateIdentity', 'verification', 'compile', 'originalAssets'])
  const identity = value.candidateIdentity, verification = value.verification, compiled = value.compile
  exact(compiled, ['diagnostics', 'rendererDiagnostics', 'coreEntry', 'manifestPin', 'snapshotProfile', 'defaultEnabled', 'modelCount'])
  check(compiled.diagnostics === (kind !== 'default-node') && compiled.coreEntry === 'core-entry.ts' && compiled.defaultEnabled === false && compiled.snapshotProfile === 'v2-2000' && sha(compiled.manifestPin))
  check(compiled.rendererDiagnostics === (kind !== 'default-node') && compiled.modelCount === (kind === 'default-node' ? null : countFor(kind)))
  exact(identity, ['appPath', 'resourcesDirectory', 'executable', 'executableSha256', 'manifestSha256', 'native', 'asar', 'fuses', 'infoPlistSha256', 'bundleCDHash', 'bundleFiles'])
  externalPath(identity.appPath); check(identity.appPath.endsWith('.app') && realpathSync(identity.appPath) === identity.appPath)
  check(identity.resourcesDirectory === path.join(identity.appPath, 'Contents/Resources') && path.dirname(identity.executable) === path.join(identity.appPath, 'Contents/MacOS'))
  check(digest(bytesAt(identity.executable, 64 * 1024 * 1024, true)) === identity.executableSha256)
  exact(identity.native, ['manifest', 'manifestSha256', 'binaryPath', 'binarySha256', 'cdHash'])
  check(identity.native.binaryPath === path.join(identity.resourcesDirectory, 'rust-core/darwin-arm64/bin/musicbridge-rust-core'))
  const manifestBytes = bytesAt(path.join(identity.resourcesDirectory, 'rust-core/darwin-arm64/manifest.json'), 64 * 1024)
  check(digest(manifestBytes) === identity.manifestSha256 && identity.native.manifestSha256 === identity.manifestSha256)
  same(JSON.parse(manifestBytes.toString()), identity.native.manifest)
  const manifest = identity.native.manifest, binary = bytesAt(identity.native.binaryPath, 64 * 1024 * 1024, true)
  exact(manifest, ['schemaVersion', 'kind', 'platform', 'arch', 'protocolVersion', 'source', 'binary'])
  exact(manifest.source, ['commit', 'sha256']); exact(manifest.binary, ['relativePath', 'sha256', 'size', 'cdHash'])
  check(manifest.schemaVersion === 1 && manifest.kind === 'musicbridge-rust-readonly-resource' && manifest.platform === 'darwin' && manifest.arch === 'arm64'
    && manifest.protocolVersion === 2 && manifest.source.commit === 'e35ad579ef276075d09d0b52fc6bb8158c418b26' && manifest.source.sha256 === '2a4e6297c44d92495e8a54a74ea2738646c5942a8cf84c0b497f400f04170565' && sha(manifest.source.sha256)
    && manifest.binary.relativePath === 'bin/musicbridge-rust-core' && manifest.binary.size === binary.length && digest(binary) === manifest.binary.sha256
    && identity.native.binarySha256 === manifest.binary.sha256 && identity.native.cdHash === manifest.binary.cdHash
    && binary.length >= 32 && binary.readUInt32LE(0) === 0xfeedfacf && binary.readUInt32LE(4) === 0x0100000c)
  same(readdirSync(path.dirname(identity.native.binaryPath)), ['musicbridge-rust-core'])
  same(readdirSync(path.join(identity.resourcesDirectory, 'rust-core/darwin-arm64')).sort(), ['bin', 'manifest.json'])
  check(compiled.manifestPin === identity.manifestSha256)
  exact(identity.asar, ['path', 'sha256', 'headerSha256', 'main', 'defaultEntries'])
  check(identity.asar.path === path.join(identity.resourcesDirectory, 'app.asar') && identity.asar.main === 'dist/main/index.js'
    && digest(bytesAt(identity.asar.path, 512 * 1024 * 1024)) === identity.asar.sha256 && sha(identity.asar.headerSha256))
  check(Array.isArray(identity.asar.defaultEntries) && identity.asar.defaultEntries.length === 2)
  identity.asar.defaultEntries.forEach((entry: any, at: number) => { exact(entry, ['path', 'sha256']); check(entry.path === ['dist/main/index.js', 'dist/main/core.js'][at] && sha(entry.sha256)) })
  check(digest(asar.getRawHeader(identity.asar.path).headerString) === identity.asar.headerSha256)
  identity.asar.defaultEntries.forEach((entry:any)=>check(digest(asar.extractFile(identity.asar.path,entry.path))===entry.sha256))
  check(JSON.parse(asar.extractFile(identity.asar.path,'package.json').toString()).main === identity.asar.main)
  check(digest(bytesAt(path.join(identity.appPath, 'Contents/Info.plist'), 1024 * 1024)) === identity.infoPlistSha256)
  same(tree(identity.appPath), identity.bundleFiles)
  exact(identity.fuses, ['version', '0', '1', '2', '3', '4', '5', '6', '7', '8'])
  check(identity.fuses.version === '1'); Object.entries({ 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49, 6: 48, 7: 48, 8: 49 }).forEach(([key, setting]) => check(identity.fuses[key] === setting))
  exact(verification, ['platform', 'arch', 'nativeSignature', 'bundleSignature', 'asarIntegrity'])
  check(verification.platform === 'darwin' && verification.arch === 'arm64')
  for (const [signature, cdHash] of [[verification.nativeSignature, identity.native.cdHash], [verification.bundleSignature, identity.bundleCDHash]]) {
    exact(signature, ['verified', 'adHoc', 'cdHash']); check(signature.verified === true && signature.adHoc === true && commit(cdHash) && signature.cdHash === cdHash)
  }
  same(verification.asarIntegrity, { algorithm: 'SHA256', hash: identity.asar.headerSha256 })
  originalAssetsFor(value.originalAssets, identity.asar.path)
  return identity
}

function statusFor(value:any):void {
 exact(value,Object.hasOwn(value,'errorCode')?['schemaVersion','enabled','mode','state','errorCode']:['schemaVersion','enabled','mode','state'])
 check(value.schemaVersion===1&&typeof value.enabled==='boolean'&&['node','rust'].includes(value.mode)&&['off','enabling','ready','stale','refreshing','failed','blocked','closing'].includes(value.state))
 if(Object.hasOwn(value,'errorCode'))check(['RUST_UNAVAILABLE','RUST_STALE','RUST_BLOCKED'].includes(value.errorCode))
 if(value.mode==='rust')check(value.enabled&&value.state==='ready')
 if(value.state==='off')check(value.enabled===false&&value.mode==='node')
}

function canonical(value:any):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(value && typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
 return JSON.stringify(value)
}
function closedFile(value:any):void { fileProof(value);check(!['-wal','-journal'].some(suffix=>{try{return lstatSync(value.path+suffix).isFile()}catch{return false}})) }
function sqlRows(stage:any):void {
 const files=stage.frozenFilesBefore
 check(Array.isArray(files) && files.length===3)
 same(files.map((item:any)=>path.basename(item.path)),['backup-maintenance.v1.sqlite','collection.v1.sqlite','command-outbox.v1.sqlite'])
 files.forEach((file:any)=>closedFile(file));same(files,stage.frozenFilesAfter)
 const observed=spawnSync('/usr/bin/python3',['-c',`import json,sqlite3,sys,pathlib
p=json.loads(sys.argv[1]);result={}
for name in ('collection.v1.sqlite','command-outbox.v1.sqlite','backup-maintenance.v1.sqlite'):
 file=next(x['path'] for x in p if pathlib.Path(x['path']).name==name)
 db=sqlite3.connect(pathlib.Path(file).as_uri()+'?mode=ro&immutable=1',uri=True);db.row_factory=sqlite3.Row
 assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
 assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
 if name=='collection.v1.sqlite':
  for key,query in [('models','SELECT rowid,id,descriptor,policy,minimum_sealed,revision FROM collection_models ORDER BY rowid DESC'),('lots','SELECT rowid,* FROM inventory_lots ORDER BY rowid'),('skus','SELECT rowid,* FROM collection_skus ORDER BY rowid'),('ledger','SELECT rowid,* FROM inventory_ledger ORDER BY rowid')]: result[key]=[dict(r) for r in db.execute(query)]
  assert db.execute('SELECT count(*) FROM physical_copies').fetchone()[0]==0
  assert db.execute('SELECT count(*) FROM collection_photos').fetchone()[0]==0
 if name=='command-outbox.v1.sqlite': result['outbox']=[dict(r) for r in db.execute('SELECT e.rowid,e.id,e.command_id,e.request_json,s.state,s.updated_at,s.acknowledged,s.error_code,s.result_json FROM outbox_entries e JOIN outbox_states s ON s.id=e.id ORDER BY e.rowid')]
 db.close()
print(json.dumps(result,ensure_ascii=False))`,JSON.stringify(files)],{encoding:'utf8',timeout:15_000,maxBuffer:32*1024*1024,env:{PATH:'/usr/bin:/bin',TMPDIR:path.dirname(files[0].path)}})
 check(!observed.error && observed.status===0 && observed.signal===null)
 const rows=JSON.parse(observed.stdout);for(const key of ['models','lots','skus','ledger','outbox'])same(rows[key],stage[key])
 files.forEach((file:any)=>closedFile(file))
}

function envelope(request:any):void { check(validateIpcRequest(request).ok && isCollectionId(request.id));exact(request,Object.hasOwn(request,'expectedDatasetId')?['version','id','command','payload','expectedDatasetId']:['version','id','command','payload']) }
function replyFor(reply:any,request:any):void {
 check(reply.id===request.id && reply.ok===true && (request.command==='recordingPrintWorker.claim'?validateIpcInternalResponseForCommand(reply,request.command).ok:validateIpcResponseForCommand(reply,request.command).ok))
 exact(reply,['version','id','ok','result']);if(request.command==='recordingPrintWorker.claim')same(reply.result,{lease:null})
}
function routedRequests(runtime:any,identity:any,count:number,cold:boolean):void {
 const events=runtime.events,main=events.filter((event:any)=>event.actor==='main'),core=events.filter((event:any)=>event.actor==='core')
 const requests=entries(main,'main.request'),replies=entries(main,'main.response'),publicRequests=entries(core,'core.publicRequest'),publicReplies=entries(core,'core.publicReply')
 check(requests.length===replies.length && requests.length===publicRequests.length && requests.length===publicReplies.length && new Set(requests.map((event:any)=>event.data.request.id)).size===requests.length)
 const nativeDispatches=new Map<string,any>()
 const worker=single(core,'node.spawn'),workerExit=single(core,'node.exit'),owner=single(core,'node.prepared').data.identity
 exact(owner,['epoch','datasetId']);check(isCollectionId(owner.epoch)&&isCollectionId(owner.datasetId))
 check(Number.isSafeInteger(worker.data.threadId)&&worker.data.threadId>0 && worker.data.hostPid===worker.pid
  && worker.data.entry===pathToFileURL(path.join(identity.resourcesDirectory,'app.asar/dist/main/dataset-owner.js')).href
  && workerExit.data.threadId===worker.data.threadId && workerExit.data.code===0 && workerExit.sequence>single(core,'node.closeStarted').sequence&&workerExit.sequence<single(core,'node.closeCompleted').sequence)
 single(core,'node.prepare');single(core,'node.boot');single(core,'node.bootComplete');single(core,'node.closeStarted');single(core,'node.closeCompleted')
 check(single(core,'node.prepare').sequence<single(core,'node.prepared').sequence&&single(core,'node.prepared').sequence<single(core,'node.boot').sequence&&single(core,'node.boot').sequence<single(core,'node.bootComplete').sequence&&single(core,'node.bootComplete').sequence<single(core,'core.ready').sequence&&single(core,'node.closeCompleted').sequence<single(core,'core.closedStatus').sequence)
 for(const event of core){
  if(event.data.status)statusFor(event.data.status)
  if(['node.snapshotVersion','node.versionedSnapshotExport'].includes(event.event)){exact(event.data.version,['epoch','datasetId','revision']);check(event.data.version.epoch===owner.epoch&&event.data.version.datasetId===owner.datasetId&&isCollectionId(event.data.version.revision))}
 }
 const closed=single(core,'core.closedStatus');statusFor(closed.data.status);check(closed.data.status.state==='closing'&&closed.data.status.mode==='node')
 const nodeRequests=entries(core,'node.dispatch'),nodeReplies=entries(core,'node.reply')
 check(nodeRequests.length===nodeReplies.length)
 for(const event of nodeRequests){const matched=nodeReplies.filter((entry:any)=>entry.data.requestId===event.data.request.id);check(matched.length===1 && matched[0].data.command===event.data.request.command && matched[0].sequence>event.sequence)}
 {
  for(const resource of entries(core,'core.resourceValidated'))same(resource.data,{binary:{path:identity.native.binaryPath,sha256:identity.native.binarySha256},manifestSha256:identity.manifestSha256,manifest:identity.native.manifest})
  check(entries(core,'core.resourceValidated').length>0&&entries(core,'core.resourceValidated').every((resource:any)=>resource.sequence>single(core,'node.bootComplete').sequence))
  const spawns=entries(core,'rust.spawn'),exits=entries(core,'rust.exit');check((count<=2000?spawns.length>0:spawns.length===0)&&exits.length===spawns.length&&new Set(spawns.map((event:any)=>event.data.pid)).size===spawns.length)
  for(const [index,spawn] of spawns.entries()){
   same(spawn.data.binary,{path:identity.native.binaryPath,sha256:identity.native.binarySha256});check(Number.isSafeInteger(spawn.data.pid)&&spawn.data.pid>0)
   const exit=exits.filter((event:any)=>event.data.pid===spawn.data.pid);check(exit.length===1);same(exit[0].data,{pid:spawn.data.pid,code:0,signal:null,closeAcknowledged:true,pendingRequests:0});check(exit[0].sequence>spawn.sequence&&exit[0].sequence<closed.sequence)
   if(index)check(exits.find((event:any)=>event.data.pid===spawns[index-1].data.pid).sequence<spawn.sequence)
   const sent=entries(core,'rust.request').filter((event:any)=>event.data.pid===spawn.data.pid),acks=entries(core,'rust.validated-reply').filter((event:any)=>event.data.pid===spawn.data.pid)
   check(sent.length===acks.length&&sent.length>=3);const scope=sent[0].data.frame;check(scope.epoch===owner.epoch&&scope.datasetId===owner.datasetId&&isCollectionId(scope.snapshotId))
   const wireIds=new Set<string>()
   for(const [at,event] of sent.entries()){
    const request=event.data.frame,matching=acks.filter((ack:any)=>ack.data.frame.requestId===request.requestId);check(matching.length===1&&matching[0].sequence>event.sequence);const reply=matching[0].data.frame
    exact(request,['protocolVersion','requestId','epoch','datasetId','snapshotId','sequence','operation','payload']);exact(reply,['protocolVersion','requestId','epoch','datasetId','snapshotId','sequence','operation','ok','result'])
    check(request.protocolVersion===2&&reply.protocolVersion===2&&request.sequence===at+1&&reply.sequence===request.sequence&&reply.ok===true&&isCollectionId(request.requestId)&&!wireIds.has(request.requestId));wireIds.add(request.requestId)
    for(const key of ['requestId','epoch','datasetId','snapshotId','operation'])check(reply[key]===request[key]);check(request.epoch===scope.epoch&&request.datasetId===scope.datasetId&&request.snapshotId===scope.snapshotId)
    const operation=at===0?'prepare':at===1?'commitBoot':at===sent.length-1?'close':'dispatch';check(request.operation===operation)
    if(operation==='prepare'){
     exact(request.payload,['models']);const models=request.payload.models;check(Array.isArray(models)&&models.length===count && count<=2000 && Buffer.byteLength(JSON.stringify(models))<=4*1024*1024 && Buffer.byteLength(JSON.stringify(request))<=4*1024*1024&&models.every(isCollectionModel))
     same(reply.result,{epoch:scope.epoch,datasetId:scope.datasetId,snapshotId:scope.snapshotId,readOnly:true,capabilities:['collection.list'],modelCount:models.length})
     const exports=entries(core,'node.versionedSnapshotExport').filter((entry:any)=>entry.data.snapshotId===scope.snapshotId);check(exports.length===1&&exports[0].sequence<event.sequence&&exports[0].data.modelCount===models.length&&exports[0].data.modelsSha256===jsonDigest(models))
     check(exports[0].data.version.epoch===owner.epoch&&exports[0].data.version.datasetId===owner.datasetId)
    }else if(operation==='dispatch'){
     exact(request.payload,['request','filterProjection']);const original=request.payload.request,mainRequest=requests.find((entry:any)=>entry.data.request.id===original.id)
     check(mainRequest && original.command==='collection.list'&&!nativeDispatches.has(original.id));same(original,Object.hasOwn(mainRequest.data.request,'expectedDatasetId')?mainRequest.data.request:{...mainRequest.data.request,expectedDatasetId:owner.datasetId});same(request.payload.filterProjection,projectCollectionFilter(original.payload.filter??{}));same(reply.result,replies.find((entry:any)=>entry.data.requestId===original.id)?.data.reply.result);nativeDispatches.set(original.id,request)
    }else {same(request.payload,{});check(reply.result===null)}
   }
   check(acks.find((event:any)=>event.data.frame.operation==='close').sequence<exit[0].sequence)
  }
 }
 check(entries(core,'node.largeSnapshotExport').length===0)
 for(const event of requests){
  const request=event.data.request;envelope(request);check(event.data.requestJsonBytes===Buffer.byteLength(JSON.stringify(request))&&event.data.requestSha256===jsonDigest(request))
  const matched=replies.filter((entry:any)=>entry.data.requestId===request.id),received=publicRequests.filter((entry:any)=>entry.data.request.id===request.id),returned=publicReplies.filter((entry:any)=>entry.data.reply.id===request.id)
  check(matched.length===1&&received.length===1&&returned.length===1&&matched[0].sequence>event.sequence&&returned[0].sequence>received[0].sequence)
  check(returned[0].data.command===request.command);if(request.command!=='core.shutdown'&&Object.hasOwn(request,'expectedDatasetId'))check(request.expectedDatasetId===owner.datasetId);same(received[0].data.request,request);same(returned[0].data.reply,matched[0].data.reply);check(matched[0].data.replyJsonBytes===Buffer.byteLength(JSON.stringify(matched[0].data.reply))&&matched[0].data.replySha256===jsonDigest(matched[0].data.reply));replyFor(matched[0].data.reply,request)
  const dispatched=nodeRequests.filter((entry:any)=>entry.data.request.id===request.id)
  if(nativeDispatches.has(request.id)){
   check(dispatched.length===0 && count<=2000);check(received[0].data.status?.mode==='rust'&&returned[0].data.status?.mode==='rust')
  }else if(request.command!=='core.shutdown'){
   check(dispatched.length===1);const nodeRequest=dispatched[0].data.request
   if(Object.hasOwn(nodeRequest,'expectedDatasetId'))same(nodeRequest,{...request,expectedDatasetId:owner.datasetId});else same(nodeRequest,request)
   same(nodeReplies.find((entry:any)=>entry.data.requestId===request.id).data.result,matched[0].data.reply.result)
   if(request.command==='collection.list')check(received[0].data.status?.mode==='node')
  }
 }
 const writes=requests.filter((event:any)=>event.data.request.command==='commandOutbox.execute');if(!cold&&count){check(writes.length===1);const wrote=replies.find((e:any)=>e.data.requestId===writes[0].data.request.id),refresh=entries(main,'main.controlRequest').find(e=>e.data.request.type==='refresh'&&e.sequence>wrote.sequence);check(refresh);const stale=requests.filter((e:any)=>['collection.list','collection.detail'].includes(e.data.request.command)&&e.sequence>wrote.sequence&&e.sequence<refresh.sequence);check(stale.length>0&&stale.every((e:any)=>!nativeDispatches.has(e.data.request.id)))}
 check(requests.filter((event:any)=>event.data.request.command==='core.shutdown').length===1)

}
const runtimeKeys=['schemaVersion','executable','expectedExecutableSha256','evidenceDirectory','kind','launch','seedTool','rss','launchId','executableSha256','executableSha256After','profileDirectory','tmpDirectory','modelCount','seedReceipt','profileDev','profileIno','markerPath','markerSha256','nonce','completedMarkerSha256','priorReceiptSha256','startedAt','mainPid','actualLaunch','events','lifecycle','rawEvidence','mainExit','timedOut','forceKilled','parseErrors','stdoutSha256','stderrSha256','stdoutBytes','stderrBytes','streams','startupReady','startupFailed','completion']
function fileProof(value:any,allowEmpty=false):Buffer {
 exact(value,['path','sha256','bytes']);check(sha(value.sha256)&&Number.isSafeInteger(value.bytes)&&value.bytes>=(allowEmpty?0:1))
 const bytes=bytesAt(value.path,1024*1024*1024,false,allowEmpty);check(bytes.length===value.bytes&&digest(bytes)===value.sha256);return bytes
}
function runtimeFor(value:any,key:string,identity:any):void {
 exact(value,runtimeKeys);const kind=key==='default-node'?key:key.replace(/-(?:fresh|cold)$/u,'')
 check(value.schemaVersion===1&&value.kind===kind&&value.modelCount===countFor(kind)&&value.executable===identity.executable&&value.expectedExecutableSha256===identity.executableSha256&&value.executableSha256===identity.executableSha256&&value.executableSha256After===identity.executableSha256&&isCollectionId(value.launchId)&&Number.isSafeInteger(value.mainPid)&&value.mainPid>0)
 check(value.completion==='closed'&&value.timedOut===false&&value.forceKilled===false&&value.parseErrors===0&&value.startupFailed===false);same(value.mainExit,{code:0,signal:null})
 for(const dir of [value.evidenceDirectory,value.tmpDirectory,value.profileDirectory]){externalPath(dir);check(realpathSync(dir)===dir&&lstatSync(dir).isDirectory())}
 check(path.dirname(value.profileDirectory)===value.tmpDirectory&&(kind==='default-node'?/^musicbridge-task036-startup-[A-Za-z0-9._-]+$/u:/^musicbridge-ui-diagnostics-[A-Za-z0-9._-]+$/u).test(path.basename(value.profileDirectory)))
 const p=lstatSync(value.profileDirectory,{bigint:true});check(String(p.dev)===value.profileDev&&String(p.ino)===value.profileIno&&(p.mode&0o777n)===0o700n)
 check(value.markerPath===path.join(value.profileDirectory,'rust015-profile.json')&&isCollectionId(value.nonce));const marker=bytesAt(value.markerPath,4096);check(digest(marker)===value.markerSha256&&(lstatSync(value.markerPath).mode&0o777)===0o600)
 same(JSON.parse(marker.toString()),{schemaVersion:1,kind:'rust015-synthetic-profile',nonce:value.nonce,modelCount:value.modelCount,seedReceipt:value.seedReceipt})
 exact(value.seedReceipt,['path','sha256']);check(value.seedReceipt.path===path.join(value.profileDirectory,'rust015-seed.json'));const seedBytes=bytesAt(value.seedReceipt.path,64*1024*1024);check(digest(seedBytes)===value.seedReceipt.sha256)
 const seed=JSON.parse(seedBytes.toString());exact(seed,['schemaVersion','task','kind','profileDirectory','profileDev','profileIno','nonce','modelCount','writer','schema','handlesClosedBeforeLaunch','models','factsSha256','policyModelId','seedDomainLedger','seedMainOutbox','database','repositoryFullDtoSha256'])
 check(seed.schemaVersion===1&&seed.task==='RUST-015'&&seed.kind==='collection-scale-fixture-seed'&&seed.profileDirectory===value.profileDirectory&&seed.profileDev===value.profileDev&&seed.profileIno===value.profileIno&&seed.nonce===value.nonce&&seed.modelCount===value.modelCount&&seed.writer==='Node-before-App'&&seed.schema==='original-CollectionRepository'&&seed.handlesClosedBeforeLaunch===true&&seed.seedDomainLedger===0&&seed.seedMainOutbox===0&&sha(seed.repositoryFullDtoSha256)&&seed.factsSha256===jsonDigest(seed.models))
 check(seed.models.length===value.modelCount&&new Set(seed.models.flatMap((m:any)=>[m.modelId,m.skuId,m.lotId])).size===value.modelCount*3)
 for(const [at,m] of seed.models.entries()){exact(m,['ordinal','modelId','skuId','lotId']);check(m.ordinal===at+1&&[m.modelId,m.skuId,m.lotId].every(isCollectionId))}
 check(seed.policyModelId===(seed.models[0]?.modelId??null));exact(seed.database,['path','sha256','bytes']);check(seed.database.path===path.join(value.profileDirectory,'data/collection.v1.sqlite')&&sha(seed.database.sha256)&&Number.isSafeInteger(seed.database.bytes)&&seed.database.bytes>0)
 const cold=key.endsWith('cold');exact(value.launch,cold?['type','priorReceiptPath','priorReceiptSha256']:['type']);check(value.launch.type===(cold?'cold':'fresh'))
 if(cold){check(value.seedTool===null&&value.priorReceiptSha256===value.launch.priorReceiptSha256&&digest(bytesAt(value.launch.priorReceiptPath,1024*1024*1024))===value.priorReceiptSha256)}
 else {
  check(value.priorReceiptSha256===null);const tool=value.seedTool;exact(tool,['executable','argv','source','loader','exit','durationMs','log']);check(tool.executable==='/Users/yihe/.nvm/versions/node/v22.23.2/bin/node');same(tool.exit,{code:0,signal:null});check(Number.isFinite(tool.durationMs)&&tool.durationMs>=0)
  for(const [name,expectedPath] of [['source',path.join(root,'apps/desktop/scripts/collection-scale-seed.ts')],['loader',path.join(root,'node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs')]]){const input=tool[name];exact(input,['path','sha256','bytes']);check(realpathSync(input.path)===realpathSync(expectedPath));const bytes=readFileSync(input.path);check(digest(bytes)===input.sha256&&bytes.length===input.bytes)}
  check(Array.isArray(tool.argv)&&tool.argv.length===5&&tool.argv[0]==='--import'&&tool.argv[1]===tool.loader.path&&tool.argv[2]==='--input-type=module'&&tool.argv[3]==='--eval')
  same(tool.argv[4],`import {seedCollectionScaleProfile} from ${JSON.stringify(pathToFileURL(tool.source.path).href)}; seedCollectionScaleProfile(${JSON.stringify(value.profileDirectory)}, ${value.modelCount}, ${JSON.stringify(value.nonce)});`);fileProof(tool.log,true)
 }
 exact(value.actualLaunch,['executable','argv','cwd','env']);check(value.actualLaunch.executable===identity.executable&&value.actualLaunch.cwd===path.dirname(identity.executable));same(value.actualLaunch.argv,['--use-mock-keychain'])
 const env={TMPDIR:value.tmpDirectory,DEV_BUILD_ROOT:'/Volumes/LifeWeave/Developer/CommandLine',DEV_CACHE_ROOT:'/Volumes/LifeWeave/Developer/CommandLine/Caches',LANG:'zh_CN.UTF-8',...(kind==='default-node'?{MUSIC_BRIDGE_STARTUP_TEST:'1',MUSIC_BRIDGE_STARTUP_USER_DATA_DIR:value.profileDirectory}:{MUSIC_BRIDGE_UI_E2E:'1',MUSIC_BRIDGE_UI_E2E_OFFLINE:'1',MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR:value.profileDirectory})};same(value.actualLaunch.env,env)
 exact(value.streams,['stdout','stderr']);const stdout=fileProof(value.streams.stdout,true),stderr=fileProof(value.streams.stderr,true);check(digest(stdout)===value.stdoutSha256&&stdout.length===value.stdoutBytes&&digest(stderr)===value.stderrSha256&&stderr.length===value.stderrBytes)
 check(value.streams.stdout.path===path.join(value.evidenceDirectory,'stdout.log')&&value.streams.stderr.path===path.join(value.evidenceDirectory,'stderr.log')&&value.rawEvidence.path===path.join(value.evidenceDirectory,'raw-evidence.jsonl'));const raw=fileProof(value.rawEvidence,true);new TextDecoder('utf-8',{fatal:true}).decode(stdout);new TextDecoder('utf-8',{fatal:true}).decode(stderr);const lines=stdout.toString().split('\n').filter((line:string)=>line.startsWith('RUST015_EVIDENCE '));same(lines.map((line:string)=>JSON.parse(line.slice('RUST015_EVIDENCE '.length))),value.events);check(raw.equals(Buffer.from(lines.map((line:string)=>line+'\n').join(''))))
 const actors=new Map<string,{sequence:number;elapsedMs:number}>();check(Array.isArray(value.events))
 for(const event of value.events){parseCollectionScaleEvent(event);const key=`${event.actor}:${event.pid}`,previous=actors.get(key)??{sequence:0,elapsedMs:0};check(event.sequence===previous.sequence+1&&event.elapsedMs>=previous.elapsedMs);actors.set(key,{sequence:event.sequence,elapsedMs:event.elapsedMs});if(event.actor==='main')check(event.pid===value.mainPid)}
 const pids=new Set<number>([value.mainPid,...entries(value.events,'main.coreSpawn').map(e=>e.data.pid),...entries(value.events,'rust.spawn').map(e=>e.data.pid)]);assertCollectionScaleRssEvidence(value.rss,pids)
 const text=stdout.toString(),observedLifecycle=text.split('\n').filter(line=>line.startsWith('TASK078_LIFECYCLE ')).map(line=>JSON.parse(line.slice('TASK078_LIFECYCLE '.length)));same(value.lifecycle,observedLifecycle);check(value.startupReady===text.split('\n').includes('DESKTOP_STARTUP_READY')&&value.startupFailed===(text.includes('DESKTOP_STARTUP_FAIL')||stderr.toString().includes('DESKTOP_STARTUP_FAIL')));if(kind==='default-node')check(text.split('\n').filter(line=>line==='DESKTOP_STARTUP_READY').length===1);
 if(kind==='default-node'){check(value.startupReady===true&&value.events.length===0&&value.lifecycle.length===0&&value.completedMarkerSha256===null);return}
 const phases=value.lifecycle.map((x:any)=>x.phase);check(phases.filter((x:string)=>x==='before-quit').length===2&&phases.includes('outbox-close-end')&&phases.includes('will-quit')&&!phases.includes('outbox-close-timeout'));check(value.lifecycle.find((x:any)=>x.phase==='core-exit')?.exitCode===0&&phases.indexOf('core-exit')<phases.indexOf('outbox-close-end')&&phases.indexOf('outbox-close-end')<phases.indexOf('will-quit'))
 const first=phases.indexOf('before-quit'),reissued=phases.indexOf('app-quit-reissued'),second=phases.lastIndexOf('before-quit');check(first<phases.indexOf('core-shutdown-start')&&phases.indexOf('core-shutdown-end')<phases.indexOf('outbox-close-start')&&phases.indexOf('outbox-close-end')<reissued&&reissued<second&&second<phases.indexOf('will-quit'));for(const phase of ['core-exit','core-shutdown-start','core-shutdown-end','outbox-close-start','outbox-close-end','app-quit-reissued','will-quit'])check(phases.filter((p:string)=>p===phase).length===1);
 check(entries(value.events,'main.coreKill').length===0&&entries(value.events,'rust.kill-request').length===0&&!value.events.some((e:any)=>/(?:Rejected|Failed|Overflow)$/u.test(e.event)||['renderer.observationRejected','node.dispatchFailed'].includes(e.event)))
 const complete=single(value.events,'main.rendererProbeComplete');check(complete.data.phase===(cold?'cold':'fresh')&&complete.data.modelCount===value.modelCount&&complete.data.nonce===value.nonce&&complete.data.completedMarkerSha256===value.completedMarkerSha256)
 const completed=bytesAt(path.join(value.profileDirectory,'rust015-completed.json'),4096);check(digest(completed)===value.completedMarkerSha256);const done=JSON.parse(completed.toString());exact(done,['schemaVersion','kind','nonce','modelCount','datasetId','commandIds','outboxIds','policyModelId','policyRevision']);check(done.schemaVersion===1&&done.kind==='rust015-completed-profile'&&done.nonce===value.nonce&&done.modelCount===value.modelCount&&isCollectionId(done.datasetId));same(done.commandIds,complete.data.commandIds);same(done.outboxIds,complete.data.outboxIds);check(done.policyModelId===seed.policyModelId&&done.policyRevision===(value.modelCount?2:null))
 const core=entries(value.events,'main.coreSpawn'),exit=entries(value.events,'main.coreExit');check(core.length===1&&exit.length===1&&core[0].data.pid===exit[0].data.pid&&exit[0].data.code===0);check(value.events.filter((e:any)=>e.actor==='core').every((e:any)=>e.pid===core[0].data.pid));const fork=single(value.events,'main.coreFork');same(fork.data,{entryPath:path.join(identity.resourcesDirectory,'app.asar/dist/main/core.js'),args:[]})
 const pref=bytesAt(path.join(value.profileDirectory,'collection-readonly.json'),4096);same(JSON.parse(pref.toString()),{schemaVersion:1,enabled:true});check((lstatSync(path.join(value.profileDirectory,'collection-readonly.json')).mode&0o777)===0o600)
 routedRequests(value,identity,value.modelCount,cold); controlsFor(value)
}
function sqlStage(stage:any,key:string,runtime:any,runtimeIdentity:any):void {
 exact(stage,['schemaVersion','task','runKey','runtimeEvidence','profileDirectory','profileNonce','datasetId','modelCount','seedReceipt','sourceFilesBefore','sourceFilesAfter','frozenFilesBefore','frozenFilesAfter','immutableReadOnly','integrityCheck','foreignKeyCheck','models','fullModels','lots','skus','ledger','outbox','queryReferences','realUserData'])
 const count=runtime.modelCount;check(stage.schemaVersion===1&&stage.task==='RUST-015'&&stage.runKey===key&&stage.modelCount===count&&stage.profileDirectory===runtime.profileDirectory&&stage.profileNonce===runtime.nonce&&isCollectionId(stage.datasetId)&&stage.immutableReadOnly===true&&stage.integrityCheck==='ok'&&stage.realUserData==='NOT_RUN');same(stage.runtimeEvidence,runtimeIdentity);same(stage.foreignKeyCheck,[])
 const seed=artifact(stage.seedReceipt,{...runtime.seedReceipt,bytes:bytesAt(runtime.seedReceipt.path,64*1024*1024).length});same(stage.sourceFilesBefore,stage.sourceFilesAfter);check(stage.sourceFilesBefore.length===3)
 for(let at=0;at<3;at++){const source=stage.sourceFilesBefore[at],frozen=stage.frozenFilesBefore[at];exact(source,['path','sha256','bytes']);externalPath(source.path);check(path.dirname(source.path)===path.join(runtime.profileDirectory,'data')&&path.basename(source.path)===path.basename(frozen.path)&&source.sha256===frozen.sha256&&source.bytes===frozen.bytes);if(key.endsWith('cold'))closedFile(source)}
 same(readdirSync(path.join(runtime.profileDirectory,'data')).filter(name=>name.endsWith('.sqlite')||name.endsWith('-wal')||name.endsWith('-journal')).sort(),['backup-maintenance.v1.sqlite','collection.v1.sqlite','command-outbox.v1.sqlite'])
 sqlRows(stage);check(stage.models.length===count&&stage.fullModels.length===count&&stage.lots.length===count&&stage.skus.length===count&&stage.ledger.length===(count?1:0)&&stage.outbox.length===(count?1:0))
 const skuByModel=new Map(stage.skus.map((s:any)=>[s.model_id,s])),lotBySku=new Map(stage.lots.map((l:any)=>[l.sku_id,l])),factById=new Map(seed.models.map((m:any)=>[m.modelId,m]));check(skuByModel.size===count&&lotBySku.size===count&&factById.size===count)
 const rebuilt=stage.models.map((row:any)=>{
  const fixture:any=factById.get(row.id),sku:any=skuByModel.get(row.id),lot:any=lotBySku.get(sku?.id);check(fixture&&sku&&lot&&sku.id===fixture.skuId&&lot.id===fixture.lotId);same(JSON.parse(row.descriptor),collectionScaleDescriptor(fixture.ordinal));check(sku.minutes===60&&lot.acquired===1&&lot.quantity_adjustment===0);same([lot.sealed,lot.opened,lot.legacy,lot.unknown],[0,1,0,0]);const target=row.id===seed.policyModelId;check(row.policy===(target?'collector':'normal')&&row.minimum_sealed===(target?2:0)&&row.revision===(target?2:1))
  return {...JSON.parse(row.descriptor),id:row.id,collectorPolicy:row.policy,minimumSealedReserve:row.minimum_sealed,revision:row.revision,lengths:[sku.minutes],counts:{sealedBlank:lot.sealed,openedBlank:lot.opened,legacyUsed:lot.legacy,unknown:lot.unknown,total:lot.sealed+lot.opened+lot.legacy+lot.unknown,recorded:0,reserved:0,unavailable:0},photoCount:0}
 });same(stage.fullModels,rebuilt);check(rebuilt.every(isCollectionModel));same(stage.models.map((m:any)=>(factById.get(m.id) as any).ordinal),Array.from({length:count},(_,i)=>count-i))
 const before=rebuilt.map((m:any)=>m.id===seed.policyModelId?{...m,collectorPolicy:'normal',minimumSealedReserve:0,revision:1}:m);check(digest(canonical(before))===seed.repositoryFullDtoSha256)
 if(count){const row=stage.outbox[0],domain=stage.ledger[0];check(row.state==='succeeded'&&row.acknowledged===1&&row.error_code===null&&isCollectionId(row.id)&&isCollectionId(row.command_id)&&domain.command_id===row.command_id&&domain.action==='set-policy');const stored=JSON.parse(row.request_json);exact(stored,['datasetId','command','payload','schemaVersion','id','commandId','fingerprint','createdAt']);check(stored.schemaVersion===1&&stored.datasetId===stage.datasetId&&stored.command==='collection.setPolicy'&&stored.id===row.id&&stored.commandId===row.command_id);same(stored.payload,{commandId:row.command_id,modelId:seed.policyModelId,expectedRevision:1,collectorPolicy:'collector',minimumSealedReserve:2});check(stored.fingerprint===digest(canonical({datasetId:stored.datasetId,command:stored.command,payload:stored.payload}))&&domain.fingerprint===digest(canonical({action:'set-policy',request:stored.payload})));same(JSON.parse(row.result_json),{modelId:seed.policyModelId});same(JSON.parse(domain.result),JSON.parse(row.result_json));same(JSON.parse(domain.event_data),{kind:'POLICY_CHANGED',before:{policy:'normal',minimumSealedReserve:0},after:{policy:'collector',minimumSealedReserve:2}})}
 const events=runtime.events,main=events.filter((e:any)=>e.actor==='main'),requests=entries(main,'main.request'),responses=entries(main,'main.response'),writes=requests.filter((e:any)=>e.data.request.command==='commandOutbox.execute');check(writes.length===(count&&key.endsWith('fresh')?1:0));check(entries(main,'main.ipcRequest').filter((e:any)=>e.data.channel==='commandOutbox:submit').length===writes.length&&entries(main,'main.ipcRequest').filter((e:any)=>e.data.channel==='commandOutbox:acknowledge').length===writes.length)
 for(const write of writes){const row=stage.outbox[0],stored=JSON.parse(row.request_json);same(write.data.request.payload,{datasetId:stored.datasetId,command:stored.command,payload:stored.payload});const response=responses.find((e:any)=>e.data.requestId===write.data.request.id);same(response.data.reply.result,{command:stored.command,result:JSON.parse(row.result_json)});const submit=single(main.filter((e:any)=>e.event==='main.ipcRequest'&&e.data.channel==='commandOutbox:submit'),'main.ipcRequest'),ack=single(main.filter((e:any)=>e.event==='main.ipcRequest'&&e.data.channel==='commandOutbox:acknowledge'),'main.ipcRequest');check(submit.sequence<write.sequence&&response.sequence<ack.sequence);check(submit.data.sender.trusted===true&&ack.data.sender.trusted===true)}
 const owner=single(events,'node.prepared');check(owner.data.identity.datasetId===stage.datasetId)
 const done=JSON.parse(bytesAt(path.join(runtime.profileDirectory,'rust015-completed.json'),4096).toString());check(done.datasetId===stage.datasetId);same(done.commandIds,stage.outbox.map((row:any)=>row.command_id));same(done.outboxIds,stage.outbox.map((row:any)=>row.id))
 const policy=events.find((e:any)=>e.event==='core.publicRequest'&&e.data.request.command==='commandOutbox.execute')
 for(const event of entries(events,'rust.request').filter((e:any)=>e.data.frame.operation==='prepare'))same(event.data.frame.payload.models,key.endsWith('cold')||policy&&policy.sequence<event.sequence?rebuilt:before)
 const reads=requests.filter((e:any)=>['collection.list','collection.detail'].includes(e.data.request.command));check(stage.queryReferences.length===reads.length);const page=(items:readonly any[],p:any)=>({items:items.slice(p.offset,p.offset+p.limit),offset:p.offset,limit:p.limit,total:items.length,hasMore:p.offset+p.limit<items.length})
 for(const [at,event] of reads.entries()){
  const ref=stage.queryReferences[at],request=event.data.request,response=responses.find((e:any)=>e.data.requestId===request.id);exact(ref,['requestId','command','request','oracle']);check(ref.requestId===request.id&&ref.command===request.command);same(ref.request,request);same(response.data.reply.result,ref.oracle);const policyDone=key.endsWith('cold')||writes.some((w:any)=>responses.find((e:any)=>e.data.requestId===w.data.request.id).sequence<event.sequence),models=policyDone?rebuilt:before,p=request.payload
  if(request.command==='collection.list')same(ref.oracle,page(filterCollectionSnapshot(models,p.filter??{}),p.page))
  else {const m=models.find((m:any)=>m.id===p.modelId);check(m);const sku:any=skuByModel.get(m.id),lot:any=lotBySku.get(sku.id);same(ref.oracle,{model:m,photos:[],lots:page([{id:lot.id,skuId:sku.id,lengthMinutes:sku.minutes,quantityAcquired:lot.acquired,quantityAdjustment:lot.quantity_adjustment,quantities:{sealedBlank:lot.sealed,openedBlank:lot.opened,legacyUsed:lot.legacy,unclassified:lot.unknown}}],p.page),copies:page([],p.page)})}
 }
}

const distribution=(values:number[])=>{check(values.length>0&&values.every(v=>Number.isFinite(v)&&v>=0));const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;return {count:n,min:sorted[0],median:n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2,p95:sorted[Math.ceil(n*.95)-1],max:sorted[n-1]}}
const duration=(value:any):number=>{check(Number.isFinite(value)&&value>=0);return value}
function routeFor(events:any[],request:any,result:any):'node'|'rust' {
 const dispatch=entries(events,'rust.request').filter(e=>e.data.frame.operation==='dispatch'&&e.data.frame.payload.request.id===request.id)
 if(dispatch.length){check(dispatch.length===1);const sent=dispatch[0],frame=sent.data.frame;const ack=entries(events,'rust.validated-reply').filter(e=>e.data.pid===sent.data.pid&&e.data.frame.requestId===frame.requestId);check(ack.length===1&&ack[0].sequence>sent.sequence&&ack[0].data.frame.ok===true);same(ack[0].data.frame.result,result);return 'rust'}
 const replies=entries(events,'node.reply').filter(e=>e.data.requestId===request.id);check(replies.length===1);same(replies[0].data.result,result);return 'node'
}
/** 仅原合同允许的 query/brand 空串与缺省等价；原件和摘要始终保留。 */
export function normalizeCollectionScaleObservedFilter(value:any):any {
 onlyData(value);check(isCollectionFilter(value));const normalized:Record<string,any>={...value}
 for(const key of ['query','brand'])if(normalized[key]==='')delete normalized[key]
 return normalized
}
function rendererReads(events:any[]):any[] {
 const observed:any[]=[]
 for(const commitEvent of entries(events,'renderer.commit')){
  const c=commitEvent.data;check(['catalog','detail','refresh','control'].includes(c.layer)&&Number.isSafeInteger(c.generation));
  const own=(name:string)=>entries(events,name).filter(e=>e.pid===commitEvent.pid&&e.data.observationId===c.observationId)
  const begun=own('renderer.begin'),invoked=own('renderer.invokeReply');check(begun.length===1&&invoked.length===1&&begun[0].sequence<invoked[0].sequence&&invoked[0].sequence<commitEvent.sequence);same(invoked[0].data.result,c.result);same(begun[0].data.request,c.request);duration(c.durationMs);duration(invoked[0].data.durationMs)
  const paint=own('renderer.paint'),tick=own('renderer.nextTick');check(paint.length<=1&&tick.length<=1)
  for(const event of [...begun,...invoked,...tick,...paint]){const d=event.data;for(const key of ['actionId','generation','layer','triggerSequence','triggerDomEvent','catalogOrdinal'])same(d[key],c[key]);same(d.request,c.request)}
  check(c.triggerSequence===null||Number.isSafeInteger(c.triggerSequence)&&c.triggerSequence>0);check(c.triggerDomEvent===null||['click','input','change','submit'].includes(c.triggerDomEvent));check(c.catalogOrdinal===null||Number.isSafeInteger(c.catalogOrdinal)&&c.catalogOrdinal>0)
  if(c.triggerSequence!==null){const trigger=entries(events,'renderer.trigger').filter(e=>e.pid===commitEvent.pid&&e.sequence===c.triggerSequence);check(trigger.length===1&&trigger[0].sequence<begun[0].sequence&&trigger[0].data.actionId===c.actionId&&trigger[0].data.domEvent===c.triggerDomEvent)}else check(c.triggerDomEvent===null)
  if(paint.length){check(tick.length===1&&tick[0].sequence>commitEvent.sequence&&paint[0].sequence>tick[0].sequence&&paint[0].data.scope==='paint-opportunity-after-latest-commit');check(duration(paint[0].data.durationMs)>=duration(tick[0].data.durationMs)&&tick[0].data.durationMs>=c.durationMs);check(!entries(events,'renderer.discarded').some(e=>e.pid===commitEvent.pid&&e.data.observationId===c.observationId));
   observed.push({observationId:c.observationId,actionId:c.actionId,pid:commitEvent.pid,layer:c.layer,generation:c.generation,triggerSequence:c.triggerSequence,triggerDomEvent:c.triggerDomEvent,catalogOrdinal:c.catalogOrdinal,beginRendererSequence:begun[0].sequence,paintRendererSequence:paint[0].sequence,request:c.request,result:c.result,invokeDurationMs:invoked[0].data.durationMs,commitDurationMs:c.durationMs,nextTickDurationMs:tick[0].data.durationMs,paintOpportunityDurationMs:paint[0].data.durationMs})}
 }
 return observed
}
/** 局部因果验收器：不替代包/库/退出与完整十三轮准入。 */
export function selectCollectionScaleWarmObservation(events:any[],warm:any):any {
 // 公共入口每次从本次raw独立校验，不接受调用方视图或跨调用缓存。
 return selectWarmFromValidatedRendererReads(events,warm,rendererReads(events))
}
/** 仅由同步derive的同一run或公共入口传入本次完整校验的局部视图。 */
function selectWarmFromValidatedRendererReads(events:any[],warm:any,reads:any[]):any {
 const w=warm.data;exact(w,['actionId','workload','iteration','mode','warmup','reply','selection']);const selected=w.selection
 exact(selected,['finalSubmitRendererSequence','observationId','generation','catalogOrdinal','invokeId','requestId','paintRendererSequence'])
 check(isCollectionId(w.actionId)&&isCollectionId(selected.requestId)&&typeof selected.invokeId==='string'&&typeof selected.observationId==='string'&&Number.isSafeInteger(selected.generation)&&selected.generation>0&&Number.isSafeInteger(selected.catalogOrdinal)&&selected.catalogOrdinal>0)
 const workload=COLLECTION_SCALE_WORKLOADS.find(x=>x.name===w.workload);check(workload&&Number.isSafeInteger(w.iteration)&&w.iteration>=-1&&w.iteration<=9&&['node','rust'].includes(w.mode)&&w.warmup===(w.iteration===-1))
 const own=(name:string)=>entries(events,name).filter(e=>e.data.actionId===w.actionId)
 const actions=own('main.domAction');check(actions.length===1&&actions[0].pid===warm.pid&&actions[0].sequence<warm.sequence&&actions[0].data.operation==='workload'&&actions[0].data.workload===w.workload&&actions[0].data.mode===w.mode&&actions[0].data.iteration===w.iteration);check(own('main.warmSample').length===1)
 const submits=own('renderer.trigger').filter(e=>e.data.domEvent==='submit');check(submits.length>0&&new Set(submits.map(e=>e.pid)).size===1);const submit=submits.at(-1);check(submit.sequence===selected.finalSubmitRendererSequence&&submit.data.target==='FORM')
 const begins=own('renderer.begin').filter(e=>e.data.layer==='catalog');check(begins.length>0&&begins.every(e=>e.pid===submit.pid));const begun=begins.at(-1);check(begun.sequence>submit.sequence&&begun.data.triggerSequence===submit.sequence&&begun.data.triggerDomEvent==='submit'&&begun.data.observationId===selected.observationId&&begun.data.generation===selected.generation&&begun.data.catalogOrdinal===selected.catalogOrdinal)
 check(begins.filter(e=>e.data.triggerSequence===submit.sequence).length===1&&begins.every(e=>e===begun||e.data.generation<selected.generation))
 const rendered=reads.filter(r=>r.pid===submit.pid&&r.observationId===selected.observationId);check(rendered.length===1);const renderer=rendered[0];check(renderer.paintRendererSequence===selected.paintRendererSequence&&renderer.paintRendererSequence>begun.sequence)
 same(renderer.request.page,{offset:0,limit:24});same(normalizeCollectionScaleObservedFilter(renderer.request.filter??{}),normalizeCollectionScaleObservedFilter(workload.filter))
 const ipc=own('main.ipcRequest').filter(e=>e.data.invokeId===selected.invokeId);check(ipc.length===1&&ipc[0].pid===warm.pid&&ipc[0].data.channel==='collection:list'&&ipc[0].data.catalogOrdinal===selected.catalogOrdinal);same(ipc[0].data.args,[renderer.request.page,renderer.request.filter??{}])
 const catalog=own('main.ipcRequest').filter(e=>e.data.channel==='collection:list'&&e.data.args[0]?.limit===24);check(catalog.length===begins.length);same(catalog.map(e=>e.data.catalogOrdinal),Array.from({length:catalog.length},(_,i)=>i+1));check(catalog.at(-1)===ipc[0]&&selected.catalogOrdinal===catalog.length)
 for(const [index,begin] of begins.entries()){const original=catalog[index];check(begin.data.catalogOrdinal===index+1);normalizeCollectionScaleObservedFilter(begin.data.request.filter??{});same(begin.data.request,{page:original.data.args[0],filter:original.data.args[1]??{}});const publicRequests=own('main.request').filter(e=>e.data.invokeId===original.data.invokeId);check(publicRequests.length===1&&publicRequests[0].data.catalogOrdinal===index+1&&publicRequests[0].data.request.command==='collection.list');same(publicRequests[0].data.request.payload,begin.data.request)}
 const ipcReply=own('main.ipcReply').filter(e=>e.data.invokeId===selected.invokeId);check(ipcReply.length===1&&ipcReply[0].pid===warm.pid&&ipcReply[0].sequence>ipc[0].sequence&&ipcReply[0].sequence<warm.sequence&&ipcReply[0].data.channel==='collection:list'&&ipcReply[0].data.catalogOrdinal===selected.catalogOrdinal);same(ipcReply[0].data.result,w.reply)
 const requests=own('main.request').filter(e=>e.data.invokeId===selected.invokeId);check(requests.length===1);const sent=requests[0],request=sent.data.request;check(sent.pid===warm.pid&&sent.sequence>ipc[0].sequence&&request.command==='collection.list'&&request.id===selected.requestId&&sent.data.catalogOrdinal===selected.catalogOrdinal);same(request.payload,{page:renderer.request.page,filter:renderer.request.filter??{}})
 const responses=entries(events,'main.response').filter(e=>e.data.requestId===request.id);check(responses.length===1);const response=responses[0];check(response.pid===warm.pid&&response.sequence>sent.sequence&&response.sequence<ipcReply[0].sequence&&response.data.actionId===w.actionId&&response.data.invokeId===selected.invokeId&&response.data.catalogOrdinal===selected.catalogOrdinal&&response.data.command==='collection.list');same(response.data.reply.result,w.reply);same(renderer.result,w.reply)
 const core=entries(events,'core.publicReply').filter(e=>e.data.requestId===request.id);check(core.length===1);same(core[0].data.reply,response.data.reply);check(routeFor(events,request,w.reply)===w.mode)
 return {sent,request,response,core:core[0],renderer,engineeringReadCounts:{catalogRequests:catalog.length,allListRequests:own('main.request').filter(e=>e.data.request.command==='collection.list').length,paintedCatalogReads:reads.filter(r=>r.actionId===w.actionId&&r.layer==='catalog').length,selectedWarmReads:1}}
}
/** 全部时长来自相同 actor 的真实 producer；嵌套阶段只分列，不能相加构造总量。 */
export function deriveCollectionScaleCostEvidence(runs:Record<string,{receipt:any;evidence:RendererArtifactIdentity}>):any {
 exact(runs,[...COLLECTION_SCALE_RUN_KEYS]);const result:any={schemaVersion:1,task:'RUST-015',scope:'SYNTHETIC_COLLECTION_SCALE_DIAGNOSTIC_OBSERVATION',runs:{},limitations:['Main/Core/Renderer被动全DTO诊断、ALS/ordinal关联与同步Core输出开销包含在观察值中','同actor时钟；跨进程时钟不相减；重叠阶段不相加','两次requestAnimationFrame是绘制机会，不是像素显示证明','工程execute/控件可用等待与DOM轮询各自分列，不计Renderer产品cost、不相加','RSS仅Main/Core/native的100ms有界ps采样，非真实峰值且含采样开销','SQLite水合、序列化、native内部未独立观测','固定v2-2000/4MiB；超限只证明完整Node回退；不推定Rust更快']}
 for(const key of COLLECTION_SCALE_COST_RUN_KEYS){
  const runtime=runs[key].receipt,events=runtime.events;check(Array.isArray(events)&&events.length>0);const reads=rendererReads(events),samples:any[]=[]
  for(const warm of entries(events,'main.warmSample')){
   const w=warm.data,{sent,request,response,core,renderer,engineeringReadCounts}=selectWarmFromValidatedRendererReads(events,warm,reads)
   const r=response.data;check(r.replyJsonBytes===Buffer.byteLength(JSON.stringify(r.reply))&&r.replySha256===jsonDigest(r.reply));check(sent.data.requestJsonBytes===Buffer.byteLength(JSON.stringify(request))&&sent.data.requestSha256===jsonDigest(request))
   samples.push({actionId:w.actionId,workload:w.workload,iteration:w.iteration,warmup:w.warmup,mode:w.mode,selection:w.selection,engineeringReadCounts,requestId:request.id,requestJsonBytes:sent.data.requestJsonBytes,replyJsonBytes:r.replyJsonBytes,dtoSha256:jsonDigest(w.reply),mainPid:response.pid,mainRoundtripMs:duration(r.durationMs),corePid:core.pid,coreRoundtripMs:duration(core.data.durationMs),renderer})
  }
  const count=countFor(key),fits=count<=2000, fresh=key.endsWith('fresh');check(samples.length===(fits&&fresh?132:0));if(fits&&fresh)for(const workload of COLLECTION_SCALE_WORKLOADS)for(const mode of ['node','rust']){const group=samples.filter(s=>s.workload===workload.name&&s.mode===mode);same(group.map(s=>s.iteration),Array.from({length:11},(_,i)=>i-1))}
  const engineeringExecutions=entries(events,'main.domExecution').map(e=>{check(e.data.scope==='engineering-execute-and-control-ready-wait');return {actionId:e.data.actionId,durationMs:duration(e.data.durationMs),pid:e.pid,scope:e.data.scope}}),resetSkips=entries(events,'main.domResetSkipped').map(e=>({pid:e.pid,sequence:e.sequence,...e.data}));
  const waits=entries(events,'main.domSettled').map(e=>{check(e.data.scope==='engineering-poll-wait');return {actionId:e.data.actionId,pollCount:e.data.pollCount,durationMs:duration(e.data.durationMs),pid:e.pid}})
  const controls=entries(events,'main.controlReply').map(e=>({actionId:e.data.actionId,requestId:e.data.requestId,response:e.data.response,durationMs:duration(e.data.durationMs),pid:e.pid}))
  const costEvents=entries(events,'core.cost');const stages=costEvents.map(e=>{const d=e.data;check(['versionProbe','snapshotExport','snapshotCopyFreeze','frameEncoding','nativeRpc','tsIndexBuild','routerDispatch','routerRefresh'].includes(d.stage)&&['fulfilled','rejected'].includes(d.outcome)&&d.snapshotProfile==='v2-2000');duration(d.durationMs);return {pid:e.pid,sequence:e.sequence,elapsedMs:e.elapsedMs,...d}})
  const snapshots=entries(events,'node.snapshotOperation').map(e=>{if(e.data.outcome==='fulfilled'){check(e.data.jsonBytes===Buffer.byteLength(JSON.stringify(e.data.value))&&e.data.sha256===jsonDigest(e.data.value))}const {value,...metadata}=e.data;return {pid:e.pid,sequence:e.sequence,...metadata}})
  for(const sent of entries(events,'rust.request')){const f=sent.data.frame;for(const stage of ['frameEncoding','nativeRpc']){const measured=costEvents.filter(e=>e.data.stage===stage&&e.data.requestId===f.requestId);check(measured.length===1&&measured[0].data.outcome==='fulfilled'&&measured[0].data.operation===f.operation&&measured[0].data.epoch===f.epoch&&measured[0].data.datasetId===f.datasetId&&measured[0].data.snapshotId===f.snapshotId);if(stage==='frameEncoding')check(measured[0].data.encodedBytes===Buffer.byteLength(JSON.stringify(f))&&measured[0].sequence<sent.sequence)}}
  check(costEvents.some(e=>e.data.stage==='versionProbe')&&costEvents.some(e=>e.data.stage==='snapshotExport')&&costEvents.some(e=>e.data.stage==='routerRefresh'))
  for(const measured of costEvents.filter(e=>e.data.stage==='routerDispatch')){const publicRequest=entries(events,'core.publicRequest').filter(e=>e.data.request.id===measured.data.requestId);check(publicRequest.length===1&&publicRequest[0].data.request.command===measured.data.operation)}
  for(const measured of costEvents.filter(e=>e.data.stage==='snapshotExport'&&e.data.outcome==='fulfilled')){check(measured.data.modelCount===runtime.modelCount);const original=entries(events,'node.snapshotOperation').filter(e=>e.data.outcome==='fulfilled'&&e.data.operation===measured.data.operation&&e.data.value.snapshot?.snapshotId===measured.data.snapshotId);check(original.length===1);check(measured.data.encodedBytes===Buffer.byteLength(JSON.stringify(original[0].data.value.snapshot)))}
  const close=single(events,'main.closeCost');check(close.data.scope==='ordinary-before-quit-to-will-quit'&&close.data.outboxCloseIncluded===true);duration(close.data.durationMs)
  const groups:any[]=[];for(const workload of COLLECTION_SCALE_WORKLOADS)for(const mode of ['node','rust']){const warm=samples.filter(s=>!s.warmup&&s.workload===workload.name&&s.mode===mode);if(warm.length)groups.push({workload:workload.name,mode,mainRoundtripMs:distribution(warm.map(s=>s.mainRoundtripMs)),coreRoundtripMs:distribution(warm.map(s=>s.coreRoundtripMs)),rendererInvokeMs:distribution(warm.map(s=>s.renderer.invokeDurationMs)),rendererCommitMs:distribution(warm.map(s=>s.renderer.commitDurationMs)),rendererPaintOpportunityMs:distribution(warm.map(s=>s.renderer.paintOpportunityDurationMs))})}
  const firstOnRequest=entries(events,'main.controlRequest').find(e=>e.data.request.type==='setEnabled'&&e.data.request.enabled===true);check(firstOnRequest);const firstOn=controls.find(c=>c.requestId===firstOnRequest.data.request.requestId);check(firstOn)
  const rssPids=[...new Set<number>(runtime.rss.samples.map((s:any)=>s.pid))].map(pid=>({pid,samples:runtime.rss.samples.filter((s:any)=>s.pid===pid).length,observedMaxKiB:Math.max(...runtime.rss.samples.filter((s:any)=>s.pid===pid).map((s:any)=>s.rssKiB))}))
  result.runs[key]={runtimeEvidence:runs[key].evidence,modelCount:count,phase:fresh?'fresh':'cold',samples,groups,rendererReads:reads,controls,firstOn,refresh:controls.filter(c=>c.response.type==='refresh'),stages,snapshots,close:{pid:close.pid,...close.data},driverWaits:waits,engineeringExecutions,resetSkips,rss:runtime.rss,excludedZeroReadingCount:runtime.rss.zeroReadings.length,rssObservedMaxima:rssPids,amortization:{scope:'workload-read-count-vs-observed-explicit-control-only',warmReads:samples.filter(s=>!s.warmup).length,refreshCount:controls.filter(c=>c.response.type==='refresh').length,conclusion:'NO_GENERAL_SPEEDUP_OR_BREAK_EVEN_CLAIM'}}
 }
 return result
}

export function acceptCollectionScaleEvidence(report:any,expected:any):void {
 onlyData(report);onlyData(expected)
 exact(report,['schemaVersion','task','state','baseCommit','sourceCommit','sourceSha256','packages','runs','sqliteReferences','costEvidence','productionDefault','businessDatabaseWriter','mainOutboxWriter','rendererFullDtoObservation','ownerAcceptance','realServices','installation','push'])
 exact(expected,['baseCommit','sourceCommit','sourceSha256','packages','runs','sqliteReferences','costEvidence'])
 check(report.schemaVersion===1&&report.task==='RUST-015'&&report.state==='PASS'&&report.baseCommit===BASE_COMMIT&&commit(report.sourceCommit)&&sha(report.sourceSha256));same([report.baseCommit,report.sourceCommit,report.sourceSha256],[expected.baseCommit,expected.sourceCommit,expected.sourceSha256])
 same([report.productionDefault,report.businessDatabaseWriter,report.mainOutboxWriter,report.rendererFullDtoObservation,report.ownerAcceptance,report.realServices,report.installation,report.push],['Node','Node','Main','PASSIVE_RENDERER_COMMIT_FULL_DTO_AND_PAINT_OPPORTUNITY','NOT_RUN','NOT_RUN','NOT_RUN','NOT_RUN'])
 exact(report.packages,[...COLLECTION_SCALE_PACKAGE_KEYS]);exact(expected.packages,[...COLLECTION_SCALE_PACKAGE_KEYS]);same(report.packages,expected.packages)
 for(const kind of COLLECTION_SCALE_PACKAGE_KEYS)packageFor(report.packages[kind],kind,report.sourceCommit)
 exact(report.runs,[...COLLECTION_SCALE_RUN_KEYS]);exact(expected.runs,[...COLLECTION_SCALE_RUN_KEYS]);const profiles=new Set<string>()
 for(const key of COLLECTION_SCALE_RUN_KEYS){const run=report.runs[key];exact(run,['receipt','evidence']);same(artifact(run.evidence,expected.runs[key]),run.receipt);runtimeFor(run.receipt,key,report.packages[key==='default-node'?key:key.replace(/-(?:fresh|cold)$/u,'')].candidateIdentity);if(!key.endsWith('cold')){check(!profiles.has(run.receipt.profileDirectory));profiles.add(run.receipt.profileDirectory)}}
 const sqlKeys=COLLECTION_SCALE_PACKAGE_KEYS.filter(k=>k!=='default-node');exact(report.sqliteReferences,sqlKeys);exact(expected.sqliteReferences,sqlKeys)
 for(const kind of sqlKeys){const aggregate=artifact(report.sqliteReferences[kind],expected.sqliteReferences[kind]);exact(aggregate,['schemaVersion','task','kind','stages']);check(aggregate.schemaVersion===1&&aggregate.task==='RUST-015'&&aggregate.kind===kind&&aggregate.stages.length===2)
  const fresh=report.runs[kind+'-fresh'],cold=report.runs[kind+'-cold'];same([fresh.receipt.profileDirectory,fresh.receipt.nonce,fresh.receipt.seedReceipt,fresh.receipt.profileDev,fresh.receipt.profileIno],[cold.receipt.profileDirectory,cold.receipt.nonce,cold.receipt.seedReceipt,cold.receipt.profileDev,cold.receipt.profileIno]);check(cold.receipt.launch.priorReceiptPath===fresh.evidence.path&&cold.receipt.launch.priorReceiptSha256===fresh.evidence.sha256)
  for(const [at,phase] of ['fresh','cold'].entries())sqlStage(aggregate.stages[at],kind+'-'+phase,report.runs[kind+'-'+phase].receipt,report.runs[kind+'-'+phase].evidence)
  same(aggregate.stages[0].fullModels,aggregate.stages[1].fullModels);same(aggregate.stages[0].ledger,aggregate.stages[1].ledger);same(aggregate.stages[0].outbox,aggregate.stages[1].outbox)
 }
 same(artifact(report.costEvidence,expected.costEvidence),deriveCollectionScaleCostEvidence(report.runs))
}

function controlsFor(runtime:any):void {
 const events=runtime.events,main=events.filter((e:any)=>e.actor==='main'),requests=entries(main,'main.controlRequest'),responses=entries(main,'main.controlReply'),ipcRequests=entries(main,'main.ipcRequest'),ipcReplies=entries(main,'main.ipcReply');check(requests.length===responses.length&&new Set(requests.map(e=>e.data.request.requestId)).size===requests.length)
 for(const event of requests){const request=event.data.request;check(isCollectionReadonlyControlRequest(request));const matches=responses.filter(e=>e.data.requestId===request.requestId);check(matches.length===1&&matches[0].sequence>event.sequence);const reply=matches[0].data.response;check(isCollectionReadonlyControlResponse(reply)&&reply.ok===true&&reply.requestId===request.requestId&&reply.type===request.type&&reply.generationNonce===request.generationNonce&&matches[0].data.generationNonce===request.generationNonce);duration(matches[0].data.durationMs);if('status' in reply)statusFor(reply.status);if('result' in reply){statusFor(reply.result.status);check(reply.result.refreshed===(runtime.modelCount<=2000))}}
 const initialSettings=entries(main,'main.domSettled').find(e=>entries(main,'main.domAction').some(a=>a.data.actionId===e.data.actionId&&a.data.operation==='settings-open'));check(initialSettings?.data.snapshot.readonlySettings);const initial=initialSettings.data.snapshot.readonlySettings;check(initial.enabled===runtime.launch.type.startsWith('cold'));if(runtime.launch.type==='cold')check(initial.mode===(runtime.modelCount<=2000?'rust':'node')&&initial.state===(runtime.modelCount<=2000?'ready':'failed'));else check(initial.mode==='node'&&initial.state==='off');
 const closed=single(main,'main.controlClosed');check(closed.data.pendingCount===0)
 const invokes=new Set<string>();for(const event of ipcRequests){check(typeof event.data.invokeId==='string'&&!invokes.has(event.data.invokeId));invokes.add(event.data.invokeId);const response=ipcReplies.filter(e=>e.data.invokeId===event.data.invokeId);check(response.length===1&&response[0].sequence>event.sequence&&response[0].data.channel===event.data.channel&&response[0].data.actionId===event.data.actionId&&response[0].data.catalogOrdinal===event.data.catalogOrdinal&&event.data.sender?.trusted===true);check(event.data.catalogOrdinal===null||event.data.channel==='collection:list'&&event.data.args[0]?.limit===24&&Number.isSafeInteger(event.data.catalogOrdinal)&&event.data.catalogOrdinal>0);duration(response[0].data.durationMs)}check(ipcReplies.length===ipcRequests.length)
 for(const publicRequest of entries(main,'main.request')){const d=publicRequest.data,response=entries(main,'main.response').filter(e=>e.data.requestId===d.request.id);check(response.length===1);same([response[0].data.invokeId,response[0].data.catalogOrdinal],[d.invokeId,d.catalogOrdinal]);check(d.invokeId===null||typeof d.invokeId==='string');if(d.invokeId!==null){const ipc=ipcRequests.filter(e=>e.data.invokeId===d.invokeId);check(ipc.length===1&&ipc[0].data.actionId===d.actionId&&ipc[0].data.catalogOrdinal===d.catalogOrdinal&&ipc[0].sequence<publicRequest.sequence);if(d.request.command==='collection.list')same(d.request.payload,{page:ipc[0].data.args[0],filter:ipc[0].data.args[1]??{}})}else check(d.catalogOrdinal===null)}
 check(entries(main,'main.domSettled').filter(e=>e.data.actionId===null).length===1)
 assertCollectionScaleRendererIpcDrain(events);assertCollectionScaleSettingsPaint(events)
 const reads=rendererReads(events); assertCollectionScaleEngineeringObservations(main)
 for(const event of entries(events,'renderer.commit')){
  const d=event.data;let channel:string,args:any[]
  if(d.layer==='catalog'){channel='collection:list';args=[d.request.page,d.request.filter??{}]}
  else if(d.layer==='detail'){channel='collection:detail';args=[d.request.modelId,d.request.page]}
  else if(d.layer==='refresh'){channel='collection:refresh';args=[]}
  else {channel=d.request.operation==='status'?'collection:readonly-settings':'collection:set-readonly-enabled';args=d.request.operation==='status'?[]:[d.request.enabled]}
  const matches=ipcRequests.filter(e=>e.data.channel===channel&&(d.layer!=='catalog'||e.data.catalogOrdinal===d.catalogOrdinal)&&canonical(e.data.args)===canonical(args)&&(d.actionId===null||e.data.actionId===d.actionId)&&ipcReplies.some(r=>r.data.invokeId===e.data.invokeId&&canonical(r.data.result)===canonical(d.result)));check(matches.length>0)
 }
 for(const action of entries(main,'main.domAction')){
  const name=action.data.operation, actionId=action.data.actionId;check(isCollectionId(actionId)&&action.data.mechanism==='fixed-dom'&&action.data.isTrusted===false)
  const settled=entries(main,'main.domSettled').filter(e=>e.data.actionId===actionId);check(settled.length===1&&settled[0].sequence>action.sequence&&settled[0].data.scope==='engineering-poll-wait')
  if(['workload','clear','target','next','previous','detail-open','policy-save','refresh','readonly-on','readonly-off'].includes(name)){
   const layer=['readonly-on','readonly-off'].includes(name)?'control':name==='refresh'?'refresh':['detail-open','policy-save'].includes(name)?'detail':'catalog';const paint=reads.filter(r=>r.actionId===actionId&&r.layer===layer);check(paint.length>0)
   const channels=layer==='control'?['collection:set-readonly-enabled']:name==='refresh'?['collection:refresh','collection:list']:layer==='detail'?['collection:detail']:['collection:list']
   assertCollectionScaleActionReplies(events,action,channels,runtime.modelCount)
  }
 }
}
/** 同runtime时钟的原ps正读与零读分记；零读原因未独立观测。 */
export function assertCollectionScaleRssEvidence(rss:any,pids:ReadonlySet<number>):void {
 exact(rss,['intervalMs','scope','clock','samples','zeroReadings','errors']);check(rss.intervalMs===100&&rss.scope==='bounded-runtime-ps-sampling'&&rss.clock==='runtime-performance');same(rss.errors,[]);check(Array.isArray(rss.samples)&&rss.samples.length>0&&Array.isArray(rss.zeroReadings))
 const identity=(sample:any)=>check(pids.has(sample.pid)&&Number.isSafeInteger(sample.pid)&&sample.pid>0&&Number.isFinite(sample.elapsedMs)&&sample.elapsedMs>=0&&sample.elapsedMs<=600000)
 for(const sample of rss.samples){exact(sample,['pid','elapsedMs','rssKiB']);identity(sample);check(Number.isSafeInteger(sample.rssKiB)&&sample.rssKiB>0)}
 for(const reading of rss.zeroReadings){exact(reading,['pid','elapsedMs','rssKiB','psStatus']);identity(reading);check(reading.rssKiB===0&&reading.psStatus===0)}
}
/** 单份已绑定原件的运行层检查；不能代替签包/十三run/SQL完整验收。 */
export function acceptCollectionScaleRuntimeEvidence(receipt:any,key:string,identity:any,evidence:RendererArtifactIdentity,expected:RendererArtifactIdentity):void {
 check(COLLECTION_SCALE_RUN_KEYS.includes(key));same(artifact(evidence,expected),receipt);runtimeFor(receipt,key,identity)
}
function scaleDomSnapshot(value:any):void {
 exact(value,['frameUrl','readyState','total','page','rows','detail','readonlySettings','dialog','inventoryLoading','errorCount','filterClearVisible']);check(value.frameUrl==='musicbridge://app/index.html'&&['loading','interactive','complete'].includes(value.readyState)&&typeof value.filterClearVisible==='boolean'&&typeof value.dialog==='boolean'&&typeof value.inventoryLoading==='boolean'&&Number.isSafeInteger(value.errorCount)&&value.errorCount===0);check(value.total===null||Number.isSafeInteger(value.total)&&value.total>=0);check(value.page===null||typeof value.page==='string');check(Array.isArray(value.rows));for(const row of value.rows){exact(row,['label','year','state']);check([row.label,row.year,row.state].every(v=>typeof v==='string'))}
 if(value.detail){exact(value.detail,['label','modelId','total','openedBlank','policy','reserve']);check(isCollectionId(value.detail.modelId)&&Number.isSafeInteger(value.detail.total)&&Number.isSafeInteger(value.detail.openedBlank)&&[value.detail.label,value.detail.policy,value.detail.reserve].every(v=>typeof v==='string'))}
 if(value.readonlySettings){exact(value.readonlySettings,['enabled','mode','state']);check(typeof value.readonlySettings.enabled==='boolean'&&['node','rust'].includes(value.readonlySettings.mode)&&typeof value.readonlySettings.state==='string')}
}
/** 只校验工程观察因果，不能被当成真实签包/业务使用正例。 */
export function assertCollectionScaleEngineeringObservations(main:any[]):void {
 for(const event of entries(main,'main.domSettled'))scaleDomSnapshot(event.data.snapshot)
 const actions=entries(main,'main.domAction'),executions=entries(main,'main.domExecution');check(actions.length===executions.length&&new Set(actions.map(a=>a.data.actionId)).size===actions.length)
 for(const action of actions){const matches=executions.filter(e=>e.data.actionId===action.data.actionId),settled=entries(main,'main.domSettled').filter(e=>e.data.actionId===action.data.actionId);check(matches.length===1&&settled.length===1&&matches[0].pid===action.pid&&matches[0].sequence>action.sequence&&matches[0].sequence<settled[0].sequence&&matches[0].data.scope==='engineering-execute-and-control-ready-wait');duration(matches[0].data.durationMs)}
 for(const skipped of entries(main,'main.domResetSkipped')){
  exact(skipped.data,['reason']);check(skipped.data.reason==='original-clear-control-absent-in-unfiltered-state')
  const previous=entries(main,'main.domSettled').filter(e=>e.sequence<skipped.sequence).at(-1);check(previous?.data.snapshot.filterClearVisible===false)
  const catalog=entries(main,'main.ipcReply').filter(e=>e.sequence<skipped.sequence&&e.data.channel==='collection:list'&&entries(main,'main.ipcRequest').some(r=>r.data.invokeId===e.data.invokeId&&r.data.channel==='collection:list'&&r.data.args[0]?.limit===24));const last=catalog.at(-1);check(last);const requests=entries(main,'main.ipcRequest').filter(e=>e.data.invokeId===last.data.invokeId);check(requests.length===1);const request=requests[0];check(request.sequence<last.sequence&&request.data.args[0]?.limit===24);same(normalizeCollectionScaleObservedFilter(request.data.args[1]??{}),{})
 }
}

/** 原UI invoke关闭前收口的独立局部验收；不替代完整包与SQL准入。 */
export function assertCollectionScaleRendererIpcDrain(events:any[]):void {
 const main=events.filter(e=>e.actor==='main'),drain=single(main,'main.rendererIpcDrained'),data=drain.data
 exact(data,['scope','pendingCount','requestCount','replyCount','rejectedCount']);check(data.scope==='before-original-quit'&&data.pendingCount===0&&data.rejectedCount===0)
 const requests=entries(main,'main.ipcRequest'),replies=entries(main,'main.ipcReply');check(entries(main,'main.ipcRejected').length===0)
 check(Number.isSafeInteger(data.requestCount)&&data.requestCount===requests.length&&data.replyCount===replies.length&&requests.length===replies.length)
 const ids=new Set<string>()
 for(const request of requests){const d=request.data;check(typeof d.invokeId==='string'&&d.invokeId.length>0&&!ids.has(d.invokeId));ids.add(d.invokeId)
  const reply=single(replies.filter(r=>r.data.invokeId===d.invokeId),'main.ipcReply');check(request.pid===drain.pid&&reply.pid===drain.pid&&request.sequence<reply.sequence&&reply.sequence<drain.sequence)
  same([reply.data.channel,reply.data.actionId,reply.data.catalogOrdinal],[d.channel,d.actionId,d.catalogOrdinal])
 }
 for(const request of entries(main,'main.request').filter(e=>e.data.invokeId!==null&&e.data.invokeId!==undefined)){
  const ipc=single(requests.filter(e=>e.data.invokeId===request.data.invokeId),'main.ipcRequest'),reply=single(entries(main,'main.response').filter(e=>e.data.requestId===request.data.request.id),'main.response'),ipcReply=single(replies.filter(e=>e.data.invokeId===ipc.data.invokeId),'main.ipcReply')
  check(ipc.sequence<request.sequence&&request.sequence<reply.sequence&&reply.sequence<ipcReply.sequence&&reply.sequence<drain.sequence);same(reply.data.invokeId,request.data.invokeId)
 }
 const complete=single(main,'main.rendererProbeComplete'),quits=main.filter(e=>e.event==='main.beforeQuit'||e.event==='main.lifecycle'&&e.data.event==='before-quit');check(quits.length>0&&complete.pid===drain.pid&&drain.sequence<complete.sequence&&quits.every(e=>e.pid===drain.pid&&complete.sequence<e.sequence))
}
/** settings-open最新普通status到产品paint的独立局部验收。 */
export function assertCollectionScaleSettingsPaint(events:any[]):void {
 const main=events.filter(e=>e.actor==='main'),settledEvents=entries(main,'main.domSettled'),actions=entries(main,'main.domAction'),initials=settledEvents.filter(e=>e.data.actionId===null)
 // 局部action-only片段可无初始化；完整runtime controlsFor另强制恰一首个工程wait。
 check(initials.length<=1)
 if(initials.length){const initial=initials[0];check(initial===settledEvents[0]&&initial.data.settingsStatusSelection===null&&initial.data.scope==='engineering-poll-wait'&&Number.isSafeInteger(initial.data.pollCount)&&initial.data.pollCount>0);duration(initial.data.durationMs);scaleDomSnapshot(initial.data.snapshot);check(initial.data.snapshot.readyState==='complete'&&actions.length>0&&actions.every(action=>action.pid===initial.pid&&initial.sequence<action.sequence))}
 for(const settled of settledEvents){if(settled.data.actionId===null)continue;const action=single(entries(main,'main.domAction').filter(e=>e.data.actionId===settled.data.actionId),'main.domAction')
  if(action.data.operation!=='settings-open'){check(settled.data.settingsStatusSelection===null);continue}
  const selection=settled.data.settingsStatusSelection;exact(selection,['observationId','generation','invokeId','requestId','paintRendererSequence']);check(typeof selection.observationId==='string'&&selection.observationId.length>0&&typeof selection.invokeId==='string'&&selection.invokeId.length>0&&isCollectionId(selection.requestId)&&Number.isSafeInteger(selection.generation)&&selection.generation>0&&Number.isSafeInteger(selection.paintRendererSequence)&&selection.paintRendererSequence>0)
  const sameAction=(name:string)=>entries(events,name).filter(e=>e.data.actionId===action.data.actionId),begins=sameAction('renderer.begin').filter(e=>e.data.layer==='control'&&e.data.request?.operation==='status'),ipcs=sameAction('main.ipcRequest').filter(e=>e.data.channel==='collection:readonly-settings'),privateRequests=sameAction('main.controlRequest').filter(e=>e.data.request.type==='status')
  check(begins.length>0&&begins.length===ipcs.length&&ipcs.length===privateRequests.length&&new Set(begins.map(e=>e.pid)).size===1)
  for(let at=0;at<begins.length;at++){const begin=begins[at],ipc=ipcs[at],request=privateRequests[at];check(Number.isSafeInteger(begin.data.generation)&&begin.data.generation>0);check(at===0||begin.sequence>begins[at-1].sequence&&begin.data.generation>begins[at-1].data.generation);same(begin.data.request,{operation:'status'});same(ipc.data.args,[]);check(ipc.data.sender?.trusted===true&&ipc.data.sender.rendererPid===begin.pid)
   const ipcReply=single(sameAction('main.ipcReply').filter(e=>e.data.invokeId===ipc.data.invokeId),'main.ipcReply'),reply=single(sameAction('main.controlReply').filter(e=>e.data.requestId===request.data.request.requestId),'main.controlReply')
   check(ipc.sequence<request.sequence&&request.sequence<reply.sequence&&reply.sequence<ipcReply.sequence&&ipcReply.data.channel===ipc.data.channel)
   check(isCollectionReadonlyControlRequest(request.data.request)&&isCollectionReadonlyControlResponse(reply.data.response)&&reply.data.response.ok===true&&reply.data.response.type==='status');same([reply.data.response.requestId,reply.data.requestId],[request.data.request.requestId,request.data.request.requestId]);same([reply.data.response.generationNonce,reply.data.generationNonce],[request.data.request.generationNonce,request.data.request.generationNonce]);same(reply.data.response.status,ipcReply.data.result)
  }
  // 选择只使用Main settled之前已进入普通IPC的最高status代际；之后同action的500ms轮询保留到总drain。
  const eligible=ipcs.map((ipc,at)=>({ipc,at})).filter(({ipc})=>ipc.sequence<settled.sequence);check(eligible.length>0);const at=eligible.at(-1)!.at
  const begin=begins[at],ipc=ipcs[at],privateRequest=privateRequests[at],identity=begin.data
  const selectedReply=single(sameAction('main.ipcReply').filter(e=>e.data.invokeId===ipc.data.invokeId),'main.ipcReply');check(selectedReply.sequence<settled.sequence)
  same([selection.observationId,selection.generation,selection.invokeId,selection.requestId],[identity.observationId,identity.generation,ipc.data.invokeId,privateRequest.data.request.requestId])
  const own=(name:string)=>entries(events,name).filter(e=>e.pid===begin.pid&&e.data.observationId===identity.observationId),stages=['renderer.invokeReply','renderer.commit','renderer.nextTick','renderer.paint'].map(name=>single(own(name),name));if(own('renderer.discarded').length!==0)throw new Error('settings同代际已discarded');check(own('renderer.begin').length===1&&own('renderer.invokeRejected').length===0)
  let sequence=begin.sequence
  for(const stage of stages){check(sequence<stage.sequence);sequence=stage.sequence;for(const key of ['actionId','generation','layer','triggerSequence','triggerDomEvent','catalogOrdinal'])same(stage.data[key],identity[key]);same(stage.data.request,identity.request);duration(stage.data.durationMs)}
  const [invoked,commit,tick,paint]=stages,reply=single(sameAction('main.ipcReply').filter(e=>e.data.invokeId===ipc.data.invokeId),'main.ipcReply');same(invoked.data.result,reply.data.result);same(commit.data.result,reply.data.result)
  check(paint.sequence===selection.paintRendererSequence&&paint.data.scope==='paint-opportunity-after-latest-commit'&&invoked.data.durationMs<=commit.data.durationMs&&commit.data.durationMs<=tick.data.durationMs&&tick.data.durationMs<=paint.data.durationMs)
  const status=reply.data.result;statusFor(status);same(settled.data.snapshot.readonlySettings,{enabled:status.enabled,mode:status.mode,state:status.state})
 }
}

/** 原Main动作回执局部因果核验，不替代Renderer、Core路由或闭库SQL验收。 */
export function assertCollectionScaleActionReplies(events:any[],action:any,channels:readonly string[],modelCount:number):void {
 const main=events.filter(e=>e.actor==='main'),actionId=action.data.actionId,settled=single(main.filter(e=>e.event==='main.domSettled'&&e.data.actionId===actionId),'main.domSettled')
 check(action.pid===settled.pid&&action.sequence<settled.sequence)
 for(const channel of channels){
  const requests=entries(main,'main.ipcRequest').filter(e=>e.data.actionId===actionId&&e.data.channel===channel),replies=entries(main,'main.ipcReply').filter(e=>e.data.actionId===actionId&&e.data.channel===channel)
  check(requests.length>0&&requests.length===replies.length&&new Set(requests.map(e=>e.data.invokeId)).size===requests.length)
  let foregroundCount=0
  for(const request of requests){
   const d=request.data,reply=single(entries(main,'main.ipcReply').filter(e=>e.data.invokeId===d.invokeId),'main.ipcReply')
   check(entries(main,'main.ipcRequest').filter(e=>e.data.invokeId===d.invokeId).length===1&&d.sender?.trusted===true&&request.pid===action.pid&&reply.pid===action.pid&&action.sequence<request.sequence&&request.sequence<settled.sequence&&request.sequence<reply.sequence)
   same([reply.data.actionId,reply.data.channel,reply.data.catalogOrdinal],[actionId,channel,d.catalogOrdinal])
   const background=channel==='collection:list'&&d.catalogOrdinal===null&&canonical(d.args)===canonical([{offset:0,limit:1},{stockState:'needs-review'}])
   if(channel==='collection:list'){
    const publicRequest=single(entries(main,'main.request').filter(e=>e.data.invokeId===d.invokeId),'main.request'),pd=publicRequest.data,publicReply=single(entries(main,'main.response').filter(e=>e.data.requestId===pd.request.id),'main.response')
    check(entries(main,'main.request').filter(e=>e.data.request.id===pd.request.id).length===1&&publicRequest.pid===action.pid&&publicReply.pid===action.pid&&request.sequence<publicRequest.sequence&&publicRequest.sequence<publicReply.sequence&&publicReply.sequence<reply.sequence)
    same([pd.actionId,pd.catalogOrdinal,pd.request.command],[actionId,d.catalogOrdinal,'collection.list']);same(pd.request.payload,{page:d.args[0],filter:d.args[1]??{}});envelope(pd.request)
    same([publicReply.data.actionId,publicReply.data.invokeId,publicReply.data.catalogOrdinal,publicReply.data.command],[actionId,d.invokeId,d.catalogOrdinal,'collection.list']);replyFor(publicReply.data.reply,pd.request);same(publicReply.data.reply.result,reply.data.result)
    if(!background&&d.args[0]?.limit===24&&Number.isSafeInteger(d.catalogOrdinal)&&d.catalogOrdinal>0&&reply.sequence<settled.sequence)foregroundCount++
   }
   if(background){const drain=single(main,'main.rendererIpcDrained');check(drain.pid===action.pid&&reply.sequence<drain.sequence)}
   else check(reply.sequence<settled.sequence)
   if(channel==='collection:refresh')check(reply.data.result.refreshed===(modelCount<=2000))
  }
  if(channel==='collection:list')check(foregroundCount>0)
 }
}
