import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, readdirSync, readlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateIpcRequest, validateIpcResponseForCommand, validateIpcInternalResponseForCommand, isCollectionId, isCollectionModel, isCommandOutboxView, isCommandOutboxOverview } from '@music-bridge/contracts'
import { filterCollectionSnapshot, projectCollectionFilter } from '../../../../packages/bridge-core/src/rust-core/collection-query.js'
import { COLLECTION_READONLY_FIXTURE, COLLECTION_READONLY_FIXTURE_SHA256 } from '../../src/main/collection-readonly-dom-driver.js'
import { rendererCheck as check, rendererExact as exact, rendererSame as same, rendererOnlyData as onlyData,
  rendererExternalPath as externalPath, rendererBytesAt as bytesAt, rendererDigest as digest, rendererJsonDigest as jsonDigest,
  rendererSha as sha, rendererArtifact as artifact, RENDERER_RUN_KEYS,
  type RendererArtifactIdentity } from './rust-packaged-renderer-cost.js'

export const COLLECTION_READONLY_PACKAGE_KEYS = ['default-node', 'node-controls', 'rust-controls', 'pin-rejected'] as const
export const COLLECTION_READONLY_EVIDENCE_RUN_KEYS = ['default-node', 'node-fresh', 'node-cold', 'rust-fresh', 'rust-cold', 'pin-rejected'] as const
type PackageKind = typeof COLLECTION_READONLY_PACKAGE_KEYS[number]
type RunKey = typeof COLLECTION_READONLY_EVIDENCE_RUN_KEYS[number]
const BASE_COMMIT = 'e35ad579ef276075d09d0b52fc6bb8158c418b26'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'))
const asar = desktopRequire(desktopRequire.resolve('@electron/asar', { paths: [path.dirname(desktopRequire.resolve('electron-builder'))] }))
const commit = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
export interface CollectionReadonlyExpectedIdentity {
 baseCommit: string; sourceCommit: string; sourceSha256: string
 packages: Record<PackageKind, any>; runs: Record<RunKey, RendererArtifactIdentity>
 sqliteReferences: Record<'node' | 'rust', RendererArtifactIdentity>
}
export interface CollectionReadonlyEvidenceReport {
 schemaVersion: 1; task: 'RUST-014'; state: 'PASS'; baseCommit: string; sourceCommit: string; sourceSha256: string
 packages: Record<PackageKind, any>; runs: Record<RunKey, {receipt:any;evidence:RendererArtifactIdentity}>
 sqliteReferences: Record<'node' | 'rust', RendererArtifactIdentity>
 productionDefault:'Node';businessDatabaseWriter:'Node';mainOutboxWriter:'Main';rendererFullDtoObservation:'NOT_INDEPENDENTLY_OBSERVED'
 ownerAcceptance:'NOT_RUN';realServices:'NOT_RUN';installation:'NOT_RUN';push:'NOT_RUN'
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
  exact(compiled, ['diagnostics', 'coreEntry', 'manifestPin', 'snapshotProfile', 'defaultEnabled', 'probeExpectation'])
  check(compiled.diagnostics === (kind !== 'default-node') && compiled.coreEntry === 'core-entry.ts' && compiled.defaultEnabled === false && compiled.snapshotProfile === 'v2-2000' && sha(compiled.manifestPin))
  check(compiled.probeExpectation === (kind === 'default-node' ? null : kind === 'node-controls' ? 'node' : kind === 'rust-controls' ? 'rust' : 'pin'))
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
    && manifest.protocolVersion === 2 && manifest.source.commit === sourceCommit && sha(manifest.source.sha256)
    && manifest.binary.relativePath === 'bin/musicbridge-rust-core' && manifest.binary.size === binary.length && digest(binary) === manifest.binary.sha256
    && identity.native.binarySha256 === manifest.binary.sha256 && identity.native.cdHash === manifest.binary.cdHash
    && binary.length >= 32 && binary.readUInt32LE(0) === 0xfeedfacf && binary.readUInt32LE(4) === 0x0100000c)
  same(readdirSync(path.dirname(identity.native.binaryPath)), ['musicbridge-rust-core'])
  same(readdirSync(path.join(identity.resourcesDirectory, 'rust-core/darwin-arm64')).sort(), ['bin', 'manifest.json'])
  if (kind !== 'pin-rejected') check(compiled.manifestPin === identity.manifestSha256)
  if (kind === 'pin-rejected') check(compiled.manifestPin !== identity.manifestSha256)
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
const eventFields: Record<string, readonly string[]> = {
  'main.diagnosticsInstalled': [], 'main.channelCreated': [], 'main.coreReady': [],
  'main.beforeQuit': [], 'main.willQuit': [], 'main.coreKill': [], 'main.coreEvidenceOverflow': [],
  'main.coreFork': ['entryPath', 'args'], 'main.coreSpawn': ['pid'], 'main.coreExit': ['code', 'pid'],
  'main.request': ['actionId','request','requestJsonBytes','requestSha256'], 'main.response': ['actionId','reply','requestId','command','durationMs','replyJsonBytes','replySha256'],
  'main.probePhase': ['phase'],
  'main.lifecycle':['event'], 'main.supervisorLifecycle':['event'],
  'core.publicPortObserved':[], 'core.observationRejected':[],
  'main.ipcRequest':['actionId','invokeId','channel','args','sender'], 'main.ipcReply':['actionId','invokeId','channel','result'], 'main.ipcRejected':['actionId','invokeId','channel','code'],
  'main.domSettled':['actionId','pollCount','elapsedMs','snapshot'],
  'core.diagnosticsInstalled': [],
'core.resourceValidated': ['binary', 'manifestSha256', 'manifest'],
  'core.publicRequest': ['request', 'status'], 'core.publicReply': ['reply', 'command', 'status'], 'core.ready': ['status'], 'core.closedStatus': ['status'],
  'node.spawn': ['threadId', 'hostPid', 'entry'], 'node.exit': ['threadId', 'code'], 'node.prepare': [], 'node.prepared': ['identity'],
  'node.boot': [], 'node.bootComplete': [], 'node.closeStarted': [], 'node.closeCompleted': [],
  'node.dispatch': ['request'], 'node.reply': ['requestId', 'command', 'result'], 'node.dispatchFailed': ['requestId', 'command'],
  'node.snapshotVersion': ['version'], 'node.snapshotExport': ['epoch', 'datasetId', 'snapshotId', 'modelCount', 'modelsSha256'],
  'node.versionedSnapshotExport': ['version', 'snapshotId', 'modelCount', 'modelsSha256'],
  'rust.spawn': ['pid', 'binary'], 'rust.request': ['pid', 'frame'], 'rust.validated-reply': ['pid', 'frame'],
  'rust.exit': ['pid', 'code', 'signal', 'closeAcknowledged', 'pendingRequests'], 'rust.kill-request': ['pid', 'signal', 'reason'],
}
const withStatus = new Set<string>()
function statusFor(value:any):void {
 exact(value,Object.hasOwn(value,'errorCode')?['schemaVersion','enabled','mode','state','errorCode']:['schemaVersion','enabled','mode','state'])
 check(value.schemaVersion===1&&typeof value.enabled==='boolean'&&['node','rust'].includes(value.mode)&&['off','enabling','ready','stale','refreshing','failed','blocked','closing'].includes(value.state))
 if(Object.hasOwn(value,'errorCode'))check(['RUST_UNAVAILABLE','RUST_STALE','RUST_BLOCKED'].includes(value.errorCode))
 if(value.mode==='rust')check(value.enabled&&value.state==='ready')
 if(value.state==='off')check(value.enabled===false&&value.mode==='node')
}
const entries = (events: any[], name: string) => events.filter(event => event.event === name)
function single(events: any[], name: string) { const found = entries(events, name); check(found.length === 1); return found[0] }
function closedFile(identity:any): void {
 exact(identity,['path','sha256','bytes']);check(sha(identity.sha256) && Number.isSafeInteger(identity.bytes) && identity.bytes>0)
 const bytes=bytesAt(identity.path);check(bytes.length===identity.bytes && digest(bytes)===identity.sha256)
}
function canonical(value:any):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(value && typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}'
 return JSON.stringify(value)
}
function sqlRows(stage:any):void {
 const files=stage.frozenFilesBefore
 check(Array.isArray(files) && files.length===3)
 same(files.map((item:any)=>path.basename(item.path)),['backup-maintenance.v1.sqlite','collection.v1.sqlite','command-outbox.v1.sqlite'])
 files.forEach(closedFile);same(files,stage.frozenFilesAfter)
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
print(json.dumps(result,ensure_ascii=False))`,JSON.stringify(files)],{encoding:'utf8',timeout:15_000,maxBuffer:8*1024*1024,env:{PATH:'/usr/bin:/bin',TMPDIR:path.dirname(files[0].path)}})
 check(!observed.error && observed.status===0 && observed.signal===null)
 const rows=JSON.parse(observed.stdout);for(const key of ['models','lots','skus','ledger','outbox'])same(rows[key],stage[key])
 files.forEach(closedFile)
}
function sqlStage(stage:any,runKey:string,runtime:any,runtimeIdentity:any):void {
 exact(stage,['schemaVersion','task','runKey','runtimeEvidence','profileDirectory','profileNonce','datasetId','sourceFilesBefore','sourceFilesAfter','frozenFilesBefore','frozenFilesAfter','immutableReadOnly','integrityCheck','foreignKeyCheck','models','fullModels','lots','skus','ledger','outbox','queryReferences','realUserData'])
 check(stage.schemaVersion===1 && stage.task==='RUST-014' && stage.runKey===runKey && stage.profileDirectory===runtime.profileDirectory && isCollectionId(stage.profileNonce)
  && isCollectionId(stage.datasetId) && stage.immutableReadOnly===true && stage.integrityCheck==='ok' && stage.realUserData==='NOT_RUN')
 same(stage.runtimeEvidence,runtimeIdentity);same(stage.foreignKeyCheck,[])
 same(stage.sourceFilesBefore,stage.sourceFilesAfter)
 check(Array.isArray(stage.sourceFilesBefore)&&stage.sourceFilesBefore.length===3)
 for(let at=0;at<3;at++){
  const source=stage.sourceFilesBefore[at],frozen=stage.frozenFilesBefore[at]
  exact(source,['path','sha256','bytes']);externalPath(source.path)
  check(path.dirname(source.path)===path.join(runtime.profileDirectory,'data') && path.basename(source.path)===path.basename(frozen.path)
   && source.sha256===frozen.sha256 && source.bytes===frozen.bytes)
  if(runKey.endsWith('cold'))closedFile(source)
 }
 const liveFiles=readdirSync(path.join(runtime.profileDirectory,'data')).filter(name=>name.endsWith('.sqlite')||name.endsWith('-wal')||name.endsWith('-journal')).sort()
 same(liveFiles,['backup-maintenance.v1.sqlite','collection.v1.sqlite','command-outbox.v1.sqlite'])
 sqlRows(stage)
 check(stage.models.length===26 && stage.fullModels.length===26 && stage.lots.length===26 && stage.skus.length===26 && stage.ledger.length===27 && stage.outbox.length===27)
 // 从刚独立重读的真实行重建DTO；fixture常量或报告fullModels不能替代物理库。
 const rebuilt=stage.models.map((row:any)=>{
  const skus=stage.skus.filter((sku:any)=>sku.model_id===row.id),lots=stage.lots.filter((lot:any)=>skus.some((sku:any)=>sku.id===lot.sku_id))
  check(skus.length===1&&lots.length===1)
  const sum=(key:string)=>lots.reduce((total:number,lot:any)=>{check(Number.isSafeInteger(lot[key])&&lot[key]>=0);return total+lot[key]},0)
  const counts={sealedBlank:sum('sealed'),openedBlank:sum('opened'),legacyUsed:sum('legacy'),unknown:sum('unknown'),total:sum('sealed')+sum('opened')+sum('legacy')+sum('unknown'),recorded:0,reserved:0,unavailable:0}
  return {...JSON.parse(row.descriptor),id:row.id,collectorPolicy:row.policy,minimumSealedReserve:row.minimum_sealed,revision:row.revision,lengths:skus.map((sku:any)=>sku.minutes||null).sort((a:any,b:any)=>(a??0)-(b??0)),counts,photoCount:0}
 })
 same(stage.fullModels,rebuilt)
 check(new Set(stage.skus.map((sku:any)=>sku.id)).size===26&&new Set(stage.lots.map((lot:any)=>lot.id)).size===26)
 const receives=stage.outbox.filter((row:any)=>JSON.parse(row.request_json).command==='collection.receive')
 check(receives.length===26&&stage.outbox.filter((row:any)=>JSON.parse(row.request_json).command==='collection.setPolicy').length===1)
 const receivedModels=new Set<string>(),receivedLots=new Set<string>()
 for(const row of receives){
  const stored=JSON.parse(row.request_json),result=JSON.parse(row.result_json)
  exact(result,['modelId','lotId']);check(!receivedModels.has(result.modelId)&&!receivedLots.has(result.lotId));receivedModels.add(result.modelId);receivedLots.add(result.lotId)
  const model=stage.models.find((model:any)=>model.id===result.modelId),lot=stage.lots.find((lot:any)=>lot.id===result.lotId),sku=stage.skus.find((sku:any)=>sku.id===lot?.sku_id)
  check(model&&lot&&sku&&sku.model_id===model.id&&sku.minutes===stored.payload.lengthMinutes&&lot.acquired===1&&lot.quantity_adjustment===0)
  same(JSON.parse(model.descriptor),stored.payload.model)
  same({sealedBlank:lot.sealed,openedBlank:lot.opened,legacyUsed:lot.legacy,unclassified:lot.unknown},stored.payload.quantities)
 }
 check(receivedModels.size===26&&receivedLots.size===26)
 check(new Set(stage.models.map((model:any)=>model.id)).size===26 && stage.fullModels.every(isCollectionModel))
 const fixtureNames=COLLECTION_READONLY_FIXTURE.map(value=>value.model.name)
 same(stage.fullModels.map((model:any)=>model.name),[...fixtureNames].reverse())
 for(const model of stage.fullModels) {
  const fixture=COLLECTION_READONLY_FIXTURE.find(value=>value.model.name===model.name)!,row=stage.models.find((value:any)=>value.id===model.id)
  check(row);same(JSON.parse(row.descriptor),fixture.model)
  for(const [key,value] of Object.entries(fixture.model))same(model[key],value)
  same(model.counts,{sealedBlank:0,openedBlank:1,legacyUsed:0,unknown:0,total:1,recorded:0,reserved:0,unavailable:0});same(model.lengths,[60]);check(model.photoCount===0)
  const target=model.name===fixtureNames[0]
  check(model.collectorPolicy===(target?'collector':'normal') && model.minimumSealedReserve===(target?2:0) && model.revision===(target?2:1)
    && row.policy===model.collectorPolicy && row.minimum_sealed===model.minimumSealedReserve && row.revision===model.revision)
 }
 const nativePreparations=runtime.events.filter((event:any)=>event.event==='rust.request'&&event.data.frame.operation==='prepare')
 const policy=runtime.events.find((event:any)=>event.event==='core.publicRequest'&&event.data.request.command==='commandOutbox.execute'&&event.data.request.payload.command==='collection.setPolicy')
 for(const event of nativePreparations){const beforePolicy=policy&&event.pid===policy.pid&&event.sequence<policy.sequence;const expectedModels=stage.fullModels.map((model:any)=>beforePolicy&&model.collectorPolicy==='collector'?{...model,collectorPolicy:'normal',minimumSealedReserve:0,revision:1}:model);same(event.data.frame.payload.models,expectedModels)}
 const completed=JSON.parse(bytesAt(path.join(runtime.profileDirectory,'rust014-completed.json'),1024*1024).toString())
 same(completed.models,[...stage.fullModels].sort((a:any,b:any)=>a.name.localeCompare(b.name,'en')))
 same(completed.commandIds,stage.outbox.map((row:any)=>row.command_id));same(completed.outboxIds,stage.outbox.map((row:any)=>row.id));check(completed.datasetId===stage.datasetId&&completed.nonce===stage.profileNonce&&stage.profileNonce===runtime.nonce)
 check(new Set(stage.ledger.map((row:any)=>row.command_id)).size===27 && new Set(stage.outbox.map((row:any)=>row.command_id)).size===27)
 for(const row of stage.outbox) {
  check(row.state==='succeeded' && row.acknowledged===1 && row.error_code===null && isCollectionId(row.id) && isCollectionId(row.command_id))
  const stored=JSON.parse(row.request_json);exact(stored,['datasetId','command','payload','schemaVersion','id','commandId','fingerprint','createdAt'])
  const request={datasetId:stored.datasetId,command:stored.command,payload:stored.payload}
  check(stored.schemaVersion===1 && stored.id===row.id && stored.commandId===row.command_id && stored.payload.commandId===row.command_id
   && stored.datasetId===stage.datasetId && stored.fingerprint===digest(canonical(request)))
  const domain=stage.ledger.find((value:any)=>value.command_id===row.command_id),action=stored.command==='collection.receive'?'receive':'set-policy'
  check(domain && domain.action===action && domain.fingerprint===digest(canonical({action,request:stored.payload})))
  same(JSON.parse(domain.result),JSON.parse(row.result_json))
 }
 const main=runtime.events.filter((event:any)=>event.actor==='main'),requests=entries(main,'main.request'),replies=entries(main,'main.response')
 const writes=requests.filter((event:any)=>event.data.request.command==='commandOutbox.execute')
 check(writes.length===(runKey.endsWith('fresh')?27:0))
 for(const [at,event] of writes.entries()) {
  const request=event.data.request.payload, row=stage.outbox.find((value:any)=>value.command_id===request.payload.commandId)
  check(row && request.datasetId===stage.datasetId);const stored=JSON.parse(row.request_json)
  same(request,{datasetId:stored.datasetId,command:stored.command,payload:stored.payload})
  if(at<26){check(request.command==='collection.receive');same({...request.payload,commandId:undefined},{...COLLECTION_READONLY_FIXTURE[at],commandId:undefined})}
  else {check(request.command==='collection.setPolicy');same(request.payload,{commandId:row.command_id,modelId:stage.fullModels.find((model:any)=>model.name===fixtureNames[0]).id,expectedRevision:1,collectorPolicy:'collector',minimumSealedReserve:2})}
  const reply=replies.find((value:any)=>value.data.requestId===event.data.request.id);check(reply)
  same(reply.data.reply.result,{command:request.command,result:JSON.parse(row.result_json)})
 }
 const reads=requests.filter((event:any)=>['collection.list','collection.detail'].includes(event.data.request.command))
 check(Array.isArray(stage.queryReferences) && stage.queryReferences.length===reads.length)
 for(const [at,event] of reads.entries()) {
  const reference=stage.queryReferences[at],request=event.data.request,reply=replies.find((value:any)=>value.data.requestId===request.id)
  exact(reference,['requestId','command','request','oracle']);check(reference.requestId===request.id && reference.command===request.command);same(reference.request,request)
  check(reply);same(reply.data.reply.result,reference.oracle)
  const preceding=writes.filter((write:any)=>replies.find((value:any)=>value.data.requestId===write.data.request.id).sequence<event.sequence)
  const present=runKey.endsWith('cold')?new Set(stage.fullModels.map((model:any)=>model.id)):new Set(preceding.filter((write:any)=>write.data.request.payload.command==='collection.receive').map((write:any)=>replies.find((value:any)=>value.data.requestId===write.data.request.id).data.reply.result.result.modelId))
  const policyDone=runKey.endsWith('cold')||preceding.some((write:any)=>write.data.request.payload.command==='collection.setPolicy')
  const models=stage.fullModels.filter((model:any)=>present.has(model.id)).map((model:any)=>!policyDone&&model.collectorPolicy==='collector'?{...model,collectorPolicy:'normal',minimumSealedReserve:0,revision:1}:model)
  const page=(items:readonly any[],p:any)=>({items:items.slice(p.offset,p.offset+p.limit),offset:p.offset,limit:p.limit,total:items.length,hasMore:p.offset+Math.min(p.limit,Math.max(0,items.length-p.offset))<items.length})
  const payload=request.payload
  if(request.command==='collection.list')same(reference.oracle,page(filterCollectionSnapshot(models,payload.filter??{}),payload.page))
  else {
   const model=models.find((value:any)=>value.id===payload.modelId);check(model)
   const lots=stage.lots.filter((lot:any)=>stage.skus.find((sku:any)=>sku.id===lot.sku_id)?.model_id===model.id).sort((a:any,b:any)=>b.rowid-a.rowid).map((lot:any)=>({id:lot.id,skuId:lot.sku_id,lengthMinutes:stage.skus.find((sku:any)=>sku.id===lot.sku_id).minutes||null,quantityAcquired:lot.acquired,quantityAdjustment:lot.quantity_adjustment,quantities:{sealedBlank:lot.sealed,openedBlank:lot.opened,legacyUsed:lot.legacy,unclassified:lot.unknown}}))
   same(reference.oracle,{model,lots:page(lots,payload.page),copies:page([],payload.page),photos:[]})
  }
 }
}
function envelope(request:any):void { check(validateIpcRequest(request).ok && isCollectionId(request.id));exact(request,Object.hasOwn(request,'expectedDatasetId')?['version','id','command','payload','expectedDatasetId']:['version','id','command','payload']) }
function replyFor(reply:any,request:any):void {
 check(reply.id===request.id && reply.ok===true && (request.command==='recordingPrintWorker.claim'?validateIpcInternalResponseForCommand(reply,request.command).ok:validateIpcResponseForCommand(reply,request.command).ok))
 exact(reply,['version','id','ok','result']);if(request.command==='recordingPrintWorker.claim')same(reply.result,{lease:null})
}
function routedRequests(runtime:any,identity:any,mode:'node'|'rust'|'pin',cold:boolean):void {
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
 if(mode==='rust'){
  for(const resource of entries(core,'core.resourceValidated'))same(resource.data,{binary:{path:identity.native.binaryPath,sha256:identity.native.binarySha256},manifestSha256:identity.manifestSha256,manifest:identity.native.manifest})
  check(entries(core,'core.resourceValidated').length===(cold?1:2)&&entries(core,'core.resourceValidated').every((resource:any)=>resource.sequence>single(core,'node.bootComplete').sequence))
  const spawns=entries(core,'rust.spawn'),exits=entries(core,'rust.exit');check(spawns.length===(cold?1:3)&&exits.length===spawns.length&&new Set(spawns.map((event:any)=>event.data.pid)).size===spawns.length)
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
     exact(request.payload,['models']);const models=request.payload.models;check(Array.isArray(models)&&models.length===26&&models.every(isCollectionModel))
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
 }else check(!events.some((event:any)=>event.event.startsWith('rust.')||['core.resourceValidated','node.snapshotVersion','node.snapshotExport','node.versionedSnapshotExport','node.largeSnapshotExport'].includes(event.event)))
 for(const event of requests){
  const request=event.data.request;envelope(request)
  const matched=replies.filter((entry:any)=>entry.data.requestId===request.id),received=publicRequests.filter((entry:any)=>entry.data.request.id===request.id),returned=publicReplies.filter((entry:any)=>entry.data.reply.id===request.id)
  check(matched.length===1&&received.length===1&&returned.length===1&&matched[0].sequence>event.sequence&&returned[0].sequence>received[0].sequence)
  check(returned[0].data.command===request.command);if(request.command!=='core.shutdown'&&Object.hasOwn(request,'expectedDatasetId'))check(request.expectedDatasetId===owner.datasetId);same(received[0].data.request,request);same(returned[0].data.reply,matched[0].data.reply);replyFor(matched[0].data.reply,request)
  const dispatched=nodeRequests.filter((entry:any)=>entry.data.request.id===request.id)
  if(nativeDispatches.has(request.id)){
   check(dispatched.length===0 && mode==='rust');check(received[0].data.status?.mode==='rust'&&returned[0].data.status?.mode==='rust')
  }else if(request.command!=='core.shutdown'){
   check(dispatched.length===1);const nodeRequest=dispatched[0].data.request
   if(Object.hasOwn(nodeRequest,'expectedDatasetId'))same(nodeRequest,{...request,expectedDatasetId:owner.datasetId});else same(nodeRequest,request)
   same(nodeReplies.find((entry:any)=>entry.data.requestId===request.id).data.result,matched[0].data.reply.result)
   if(mode==='rust'&&request.command==='collection.list')check(received[0].data.status?.mode==='node')
  }
 }
 check(requests.filter((event:any)=>event.data.request.command==='core.shutdown').length===1)

}
/** 可信身份由Gate独立回读包/源/收据；同步只读，无运行或签名副作用。 */
export function acceptCollectionReadonlyEvidence(report:unknown,expectedIdentity:unknown):Readonly<{state:'PASS';task:'RUST-014';rendererFullDtoObservation:'NOT_INDEPENDENTLY_OBSERVED'}> {
 onlyData(report);onlyData(expectedIdentity)
 const value=report as CollectionReadonlyEvidenceReport,expected=expectedIdentity as CollectionReadonlyExpectedIdentity
 exact(value,['schemaVersion','task','state','baseCommit','sourceCommit','sourceSha256','packages','runs','sqliteReferences','productionDefault','businessDatabaseWriter','mainOutboxWriter','rendererFullDtoObservation','ownerAcceptance','realServices','installation','push'])
 exact(expected,['baseCommit','sourceCommit','sourceSha256','packages','runs','sqliteReferences'])
 check(value.schemaVersion===1&&value.task==='RUST-014'&&value.state==='PASS'&&value.baseCommit===BASE_COMMIT&&expected.baseCommit===BASE_COMMIT&&commit(value.sourceCommit)&&value.sourceCommit===expected.sourceCommit&&sha(value.sourceSha256)&&value.sourceSha256===expected.sourceSha256)
 check(value.productionDefault==='Node'&&value.businessDatabaseWriter==='Node'&&value.mainOutboxWriter==='Main'&&value.rendererFullDtoObservation==='NOT_INDEPENDENTLY_OBSERVED')
 for(const key of ['ownerAcceptance','realServices','installation','push'] as const)check(value[key]==='NOT_RUN')
 exact(value.packages,COLLECTION_READONLY_PACKAGE_KEYS);exact(expected.packages,COLLECTION_READONLY_PACKAGE_KEYS);same(value.packages,expected.packages)
 exact(value.runs,COLLECTION_READONLY_EVIDENCE_RUN_KEYS);exact(expected.runs,COLLECTION_READONLY_EVIDENCE_RUN_KEYS)
 const identities={} as Record<PackageKind,any>,runtimes={} as Record<RunKey,any>
 for(const kind of COLLECTION_READONLY_PACKAGE_KEYS)identities[kind]=packageFor(value.packages[kind],kind,value.sourceCommit)
 check(new Set(COLLECTION_READONLY_PACKAGE_KEYS.map(kind=>identities[kind].appPath)).size===4)
 check(identities['default-node'].asar.defaultEntries[0].sha256!==identities['node-controls'].asar.defaultEntries[0].sha256)
 for(const kind of COLLECTION_READONLY_PACKAGE_KEYS)same(value.packages[kind].originalAssets,value.packages['default-node'].originalAssets)
 for(const runKey of COLLECTION_READONLY_EVIDENCE_RUN_KEYS){
  const run=value.runs[runKey];exact(run,['receipt','evidence']);const runtime=artifact(run.evidence,expected.runs[runKey]);same(runtime,run.receipt);runtimes[runKey]=runtime
 }
 for(const runKey of COLLECTION_READONLY_EVIDENCE_RUN_KEYS)runtimeFor(runtimes[runKey],runKey,identities[packageForRun(runKey)])
 check(new Set(['default-node','node-fresh','rust-fresh','pin-rejected'].map(key=>runtimes[key as RunKey].profileDirectory)).size===4)
 for(const mode of ['node','rust']){
  const freshKey=`${mode}-fresh` as RunKey,coldKey=`${mode}-cold` as RunKey,fresh=runtimes[freshKey],cold=runtimes[coldKey]
  for(const field of ['profileDirectory','tmpDirectory','profileDev','profileIno','markerPath','markerSha256','nonce','completedMarkerSha256'])same(fresh[field],cold[field])
  check(fresh.mainPid!==cold.mainPid&&fresh.launchId!==cold.launchId&&cold.launch.priorReceiptPath===value.runs[freshKey].evidence.path&&cold.priorReceiptSha256===value.runs[freshKey].evidence.sha256)
 }
 for(const runKey of [...RENDERER_RUN_KEYS,'pin-rejected'] as const){routedRequests(runtimes[runKey],identities[packageForRun(runKey)],runKey==='pin-rejected'?'pin':runKey.startsWith('node')?'node':'rust',runKey.endsWith('cold'));ipcFor(runtimes[runKey],runKey.endsWith('cold'))}
 exact(value.sqliteReferences,['node','rust']);exact(expected.sqliteReferences,['node','rust'])
 for(const mode of ['node','rust'] as const){
  const sql=artifact(value.sqliteReferences[mode],expected.sqliteReferences[mode]);exact(sql,['schemaVersion','task','kind','stages']);check(sql.schemaVersion===1&&sql.task==='RUST-014'&&sql.kind===mode&&Array.isArray(sql.stages)&&sql.stages.length===2)
  for(const [at,suffix] of ['fresh','cold'].entries()){const key=`${mode}-${suffix}` as RunKey;sqlStage(sql.stages[at],key,runtimes[key],value.runs[key].evidence)}
  for(const key of ['models','fullModels','lots','skus','ledger','outbox'])same(sql.stages[0][key],sql.stages[1][key])
 }
 return Object.freeze({state:'PASS',task:'RUST-014',rendererFullDtoObservation:'NOT_INDEPENDENTLY_OBSERVED'})
}
function packageForRun(key:RunKey):PackageKind {return key.startsWith('node-')?'node-controls':key.startsWith('rust-')?'rust-controls':key as PackageKind}
const runtimeKeys=['schemaVersion','executable','expectedExecutableSha256','evidenceDirectory','kind','launch','launchId','executableSha256','executableSha256After','profileDirectory','tmpDirectory','profileDev','profileIno','markerPath','markerSha256','nonce','completedMarkerSha256','priorReceiptSha256','startedAt','mainPid','actualLaunch','events','lifecycle','rawEvidence','mainExit','timedOut','forceKilled','parseErrors','stdoutSha256','stderrSha256','stdoutBytes','stderrBytes','startupReady','startupFailed','completion']
Object.assign(eventFields,{
 'node.largeSnapshotExport':[],
 'main.profileValidated':['profileDirectory','profileDev','profileIno','markerSha256','nonce'],
 'main.window':['webContentsId','rendererPid','frameUrl','visible','bounds'],
 'main.domAction':['actionId','operation','control','mechanism','isTrusted'],
 'main.screenshot':['actionId','path','sha256','bytes','width','height'],
 'main.rendererProbeComplete':['phase','fixtureCount','fixtureSha256','commandIds','modelIds','policyModelId','policyRevision','nonce','completedMarkerSha256'],
 'main.probeFailed':['code'],'main.observationRejected':[],'main.coreEvidenceRejected':[],
})
function runtimeFor(value:any,key:RunKey,identity:any):void {
 exact(value,runtimeKeys)
 check(value.schemaVersion===1&&value.kind===packageForRun(key)&&value.executable===identity.executable&&value.expectedExecutableSha256===identity.executableSha256
  &&value.executableSha256===identity.executableSha256&&value.executableSha256After===identity.executableSha256&&isCollectionId(value.launchId)&&Number.isSafeInteger(value.mainPid)&&value.mainPid>0
  &&Number.isFinite(Date.parse(value.startedAt))&&value.completion==='closed'&&value.timedOut===false&&value.forceKilled===false&&value.parseErrors===0)
 for(const dir of [value.evidenceDirectory,value.tmpDirectory,value.profileDirectory]){externalPath(dir);check(realpathSync(dir)===dir&&lstatSync(dir).isDirectory())}
 check(path.dirname(value.profileDirectory)===value.tmpDirectory&&/^musicbridge-(?:ui-diagnostics|task036-startup)-[A-Za-z0-9._-]+$/u.test(path.basename(value.profileDirectory)))
 const profile=lstatSync(value.profileDirectory,{bigint:true});check(String(profile.dev)===value.profileDev&&String(profile.ino)===value.profileIno&&(profile.mode&0o077n)===0n)
 check(value.markerPath===path.join(value.profileDirectory,'rust014-profile.json')&&isCollectionId(value.nonce))
 const markerBytes=bytesAt(value.markerPath,1024);check(digest(markerBytes)===value.markerSha256&&(lstatSync(value.markerPath).mode&0o077)===0)
 same(JSON.parse(markerBytes.toString()),{schemaVersion:1,kind:'rust014-synthetic-profile',nonce:value.nonce})
 const cold=key.endsWith('cold');exact(value.launch,cold?['type','priorReceiptPath','priorReceiptSha256']:['type']);check(value.launch.type===(cold?'cold':'fresh'))
 if(cold){externalPath(value.launch.priorReceiptPath);check(sha(value.priorReceiptSha256)&&value.priorReceiptSha256===value.launch.priorReceiptSha256&&digest(bytesAt(value.launch.priorReceiptPath))===value.priorReceiptSha256)}else check(value.priorReceiptSha256===null)
 exact(value.actualLaunch,['executable','argv','cwd','env']);check(value.actualLaunch.executable===identity.executable&&value.actualLaunch.cwd===path.dirname(identity.executable));same(value.actualLaunch.argv,['--use-mock-keychain'])
 const env={TMPDIR:value.tmpDirectory,DEV_BUILD_ROOT:'/Volumes/LifeWeave/Developer/CommandLine',DEV_CACHE_ROOT:'/Volumes/LifeWeave/Developer/CommandLine/Caches',LANG:'zh_CN.UTF-8',
  ...(key==='default-node'?{MUSIC_BRIDGE_STARTUP_TEST:'1',MUSIC_BRIDGE_STARTUP_USER_DATA_DIR:value.profileDirectory}:{MUSIC_BRIDGE_UI_E2E:'1',MUSIC_BRIDGE_UI_E2E_OFFLINE:'1',MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR:value.profileDirectory})}
 same(value.actualLaunch.env,env)
 exact(value.mainExit,['code','signal']);check(value.mainExit.code===0&&value.mainExit.signal===null&&sha(value.stdoutSha256)&&sha(value.stderrSha256)
  &&Number.isSafeInteger(value.stdoutBytes)&&value.stdoutBytes>0&&value.stdoutBytes<=32*1024*1024&&Number.isSafeInteger(value.stderrBytes)&&value.stderrBytes>=0)
 check(value.startupReady===(key==='default-node')&&value.startupFailed===false)
 exact(value.rawEvidence,['path','sha256','bytes']);check(sha(value.rawEvidence.sha256)&&Number.isSafeInteger(value.rawEvidence.bytes)&&value.rawEvidence.bytes>=0)
 const raw=bytesAt(value.rawEvidence.path,32*1024*1024,false,true);check(raw.length===value.rawEvidence.bytes&&digest(raw)===value.rawEvidence.sha256)
 check(Array.isArray(value.events)&&value.events.length<20000&&Array.isArray(value.lifecycle)&&value.lifecycle.length<=256)
 const lines=raw.length?raw.toString().split('\n'):[];if(lines.length)check(lines.pop()==='')
 same(lines.map((line:string)=>{check(line.startsWith('RUST014_EVIDENCE '));return JSON.parse(line.slice('RUST014_EVIDENCE '.length))}),value.events)
 if(key==='default-node'){same(value.events,[]);same(value.lifecycle,[]);check(value.completedMarkerSha256===null);return}
 const streams=new Map<string,{sequence:number;elapsedMs:number}>()
 for(const event of value.events){
  exact(event,['schemaVersion','actor','sequence','elapsedMs','pid','event','data']);check(event.schemaVersion===1&&['main','core'].includes(event.actor)&&Number.isSafeInteger(event.pid)&&event.pid>0&&Number.isSafeInteger(event.sequence)&&event.sequence>0&&Number.isFinite(event.elapsedMs)&&event.elapsedMs>=0)
  check(event.actor==='main'?event.pid===value.mainPid&&event.event.startsWith('main.'):!event.event.startsWith('main.'))
  const stream=event.actor+':'+event.pid,previous=streams.get(stream);check(event.sequence===(previous?.sequence??0)+1&&event.elapsedMs>=(previous?.elapsedMs??0));streams.set(stream,event)
  const fields=eventFields[event.event];check(fields);const keys=[...fields]
  if(withStatus.has(event.event)&&Object.hasOwn(event.data,'status')){keys.push('status');statusFor(event.data.status)}
  if(event.event==='main.domAction'&&['receive-save','detail-open'].includes(event.data.control))keys.push('fixtureIndex')
  if(['main.lifecycle','main.supervisorLifecycle'].includes(event.event)){if(event.event==='main.lifecycle')keys.push('actionId');if(Object.hasOwn(event.data,'code'))keys.push('code')}
  exact(event.data,keys)
 }
 const main=value.events.filter((event:any)=>event.actor==='main'),spawns=entries(main,'main.coreSpawn'),exits=entries(main,'main.coreExit'),forks=entries(main,'main.coreFork')
 check(spawns.length===1&&exits.length===spawns.length&&forks.length===spawns.length&&new Set(spawns.map((event:any)=>event.data.pid)).size===spawns.length)
 single(main,'main.diagnosticsInstalled');check(entries(main,'main.channelCreated').length===spawns.length)
 for(const fork of forks){check(fork.data.entryPath===path.join(identity.resourcesDirectory,'app.asar/dist/main/core.js'));same(fork.data.args,[])}
 for(const spawn of spawns){check(Number.isSafeInteger(spawn.data.pid)&&spawn.data.pid>0);const matched=exits.filter((event:any)=>event.data.pid===spawn.data.pid);check(matched.length===1&&matched[0].data.code===0&&matched[0].sequence>spawn.sequence)
  const core=value.events.filter((event:any)=>event.actor==='core'&&event.pid===spawn.data.pid);single(core,'core.diagnosticsInstalled');single(core,'core.publicPortObserved')}
 check(value.events.filter((event:any)=>event.actor==='core').every((event:any)=>spawns.some((spawn:any)=>spawn.data.pid===event.pid)))
 check(!value.events.some((event:any)=>['main.coreKill','rust.kill-request','main.probeFailed','main.observationRejected','main.coreEvidenceRejected','main.coreEvidenceOverflow','main.diagnosticRejected','core.diagnosticRejected','core.explicitRefreshFailed','node.dispatchFailed','main.ipcRejected','core.observationRejected','node.largeSnapshotExport'].includes(event.event)))
 single(main,'main.coreReady');single(value.events,'core.ready')
 const complete=single(main,'main.rendererProbeComplete').data
 check(complete.phase===(cold?'cold':'fresh')&&complete.fixtureCount===26&&complete.fixtureSha256===COLLECTION_READONLY_FIXTURE_SHA256&&complete.nonce===value.nonce&&complete.completedMarkerSha256===value.completedMarkerSha256)
 const completedBytes=bytesAt(path.join(value.profileDirectory,'rust014-completed.json'),1024*1024);check(digest(completedBytes)===value.completedMarkerSha256)
 const completed=JSON.parse(completedBytes.toString());exact(completed,['schemaVersion','kind','nonce','fixtureSha256','datasetId','commandIds','outboxIds','models','policyModelId','policyRevision'])
 check(completed.schemaVersion===1&&completed.kind==='rust014-completed-profile'&&completed.nonce===value.nonce&&completed.fixtureSha256===COLLECTION_READONLY_FIXTURE_SHA256&&isCollectionId(completed.datasetId)&&completed.policyRevision===2)
 for(const field of ['commandIds','outboxIds'])check(Array.isArray(completed[field])&&completed[field].length===27&&completed[field].every(isCollectionId)&&new Set(completed[field]).size===27)
 check(Array.isArray(completed.models)&&completed.models.length===26&&completed.models.every(isCollectionModel));same(complete.modelIds,completed.models.map((model:any)=>model.id));same(complete.commandIds,completed.commandIds);check(complete.policyModelId===completed.policyModelId&&complete.policyRevision===completed.policyRevision)
 const validated=single(main,'main.profileValidated');same(validated.data,{profileDirectory:value.profileDirectory,profileDev:value.profileDev,profileIno:value.profileIno,markerSha256:value.markerSha256,nonce:value.nonce})
 const window=single(main,'main.window').data;exact(window.bounds,['x','y','width','height']);check(Number.isSafeInteger(window.webContentsId)&&window.webContentsId>0&&Number.isSafeInteger(window.rendererPid)&&window.rendererPid>0&&window.frameUrl==='musicbridge://app/index.html'&&window.visible===true&&window.bounds.width>0&&window.bounds.height>0)
 const screenshots=entries(main,'main.screenshot');check(screenshots.length===(cold?2:key.startsWith('node')?5:7))
 for(const event of screenshots){const image=event.data;externalPath(image.path);check(image.path.startsWith(value.profileDirectory+'/rust014-screenshots-')&&sha(image.sha256)&&Number.isSafeInteger(image.bytes)&&image.bytes>0);const bytes=bytesAt(image.path,32*1024*1024);check(bytes.length===image.bytes&&digest(bytes)===image.sha256&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)===image.width&&bytes.readUInt32BE(20)===image.height)}
 lifecycleFor(value)
}
function lifecycleFor(runtime:any):void {
 const observed=entries(runtime.events.filter((event:any)=>event.actor==='main'),'main.lifecycle'),phases=observed.map((event:any)=>event.data.event)
 same(runtime.lifecycle.map((item:any)=>({phase:item.phase,...(Object.hasOwn(item,'exitCode')?{exitCode:item.exitCode}:{})})),observed.map((event:any)=>({phase:event.data.event,...(Object.hasOwn(event.data,'code')?{exitCode:event.data.code}:{})})))
 let elapsed=0;for(const event of runtime.lifecycle){exact(event,event.phase==='core-exit'?['phase','elapsedMs','exitCode']:['phase','elapsedMs']);check(Number.isFinite(event.elapsedMs)&&event.elapsedMs>=elapsed);elapsed=event.elapsedMs}
 const allowed=['bootstrap-start','data-prepared','core-spawn','core-ready-received','onready-complete','supervisor-ready','core-exit','ui-loaded','before-quit','print-stop-requested','print-stop-settled','remote-stop-start','remote-stop-end','core-shutdown-start','core-shutdown-end','outbox-close-start','outbox-close-end','app-quit-reissued','will-quit']
 check(phases.every((phase:string)=>allowed.includes(phase)))
 for(const phase of allowed.filter(phase=>!['before-quit','print-stop-requested','print-stop-settled'].includes(phase)))check(phases.filter((value:string)=>value===phase).length===1)
 const before=phases.flatMap((phase:string,at:number)=>phase==='before-quit'?[at]:[]);check(before.length===2)
 const index=(name:string)=>phases.indexOf(name)
 check(before[0]>index('ui-loaded')&&before[0]<index('remote-stop-start')&&index('remote-stop-start')<index('remote-stop-end')&&index('remote-stop-end')<index('core-shutdown-start')&&index('core-shutdown-start')<index('core-exit')&&index('core-exit')<index('core-shutdown-end')&&index('core-shutdown-end')<index('outbox-close-start')&&index('outbox-close-start')<index('outbox-close-end')&&index('outbox-close-end')<index('app-quit-reissued')&&index('app-quit-reissued')<before[1]&&before[1]<index('will-quit'))
 check(single(observed.filter((event:any)=>event.data.event==='core-exit'),'main.lifecycle').data.code===0)
}
function ipcFor(runtime:any,cold:boolean):void {
 const main=runtime.events.filter((event:any)=>event.actor==='main'),actions=entries(main,'main.domAction'),waits=entries(main,'main.domSettled'),requests=entries(main,'main.request'),responses=entries(main,'main.response')
 const mode=runtime.kind==='node-controls'?'node':runtime.kind==='rust-controls'?'rust':'pin',controls=['navigate']
 if(!cold){
  for(let at=0;at<26;at++)controls.push('receive-open','receive-save')
  controls.push('settings-open');if(mode!=='node')controls.push('readonly-on');controls.push('settings-close');if(mode!=='rust')controls.push('refresh')
  for(const control of ['filter-brand','filter-query','filter-decade','filter-state'])controls.push(control,'clear')
  controls.push('next','previous','next','detail-open','policy-open','policy-save','refresh','detail-close','filter-brand','clear','next','previous')
  if(mode!=='node')controls.push('settings-open','readonly-off','readonly-on','settings-close')
 }else controls.push('settings-open','settings-close','next','previous')
 controls.push('next','detail-open');same(actions.map((event:any)=>event.data.control),controls)
 same(entries(main,'main.probePhase').map((event:any)=>event.data.phase),cold?['cold']:['fresh','seeded','matrix','policy','stale','refreshed',...(mode==='node'?[]:['off-on'])])
 check(waits.length===actions.length+1&&waits[0].data.actionId===null)
 for(const [at,event] of actions.entries()){
  const data=event.data,control=controls[at]!,settled=waits[at+1]
  check(data.actionId===`dom-${String(at+1).padStart(3,'0')}-${control}`&&data.mechanism==='fixed-dom'&&data.isTrusted===false&&data.operation===(['receive-save','policy-save'].includes(control)?'form':'click')&&settled.data.actionId===data.actionId&&settled.sequence>event.sequence)
  if(control==='receive-save')check(data.fixtureIndex===Math.floor((at-1)/2))
  if(control==='detail-open')check(data.fixtureIndex===0)
  const snapshot=settled.data.snapshot
  exact(snapshot,['readonlySettings','frameUrl','readyState','total','page','rows','detail','dialog','inventoryLoading','errorCount'])
  check(snapshot.frameUrl==='musicbridge://app/index.html'&&snapshot.readyState==='complete'&&snapshot.errorCount===0&&Array.isArray(snapshot.rows)&&snapshot.rows.length<=24&&typeof snapshot.dialog==='boolean'&&typeof snapshot.inventoryLoading==='boolean')
  for(const row of snapshot.rows){exact(row,['label','year','state']);check(typeof row.label==='string'&&row.label.includes('RUST014 合成型号')&&typeof row.year==='string'&&typeof row.state==='string')}
  if(control==='receive-open')check(snapshot.dialog===true)
  else check(snapshot.dialog===false&&snapshot.inventoryLoading===false)
  if(control==='receive-save')check(snapshot.total===data.fixtureIndex+1)
  if(control==='next')check(snapshot.page==='2 / 2'&&snapshot.rows.length===2)
  if(control==='previous')check(snapshot.page==='1 / 2'&&snapshot.rows.length===24)
  if(control==='clear')check(snapshot.total===26)
  if(control==='refresh'){
   const before=waits[at].data.snapshot,refresh=single(entries(main,'main.ipcRequest').filter((entry:any)=>entry.data.actionId===data.actionId&&entry.data.channel==='collection:refresh'),'main.ipcRequest')
   const refreshReply=single(entries(main,'main.ipcReply').filter((entry:any)=>entry.data.invokeId===refresh.data.invokeId),'main.ipcReply')
   check(refresh.sequence>event.sequence&&refreshReply.sequence>refresh.sequence&&refreshReply.sequence<settled.sequence)
   const listRequest=single(requests.filter((entry:any)=>entry.data.actionId===data.actionId&&entry.data.request.command==='collection.list'&&entry.data.request.payload.page.limit===24),'main.request')
   const listReply=single(responses.filter((entry:any)=>entry.data.requestId===listRequest.data.request.id),'main.response')
   check(listRequest.sequence>refreshReply.sequence&&listReply.sequence>listRequest.sequence&&listReply.sequence<settled.sequence)
   if(mode==='rust')check(runtime.events.some((entry:any)=>entry.event==='rust.request'&&entry.data.frame.operation==='dispatch'&&entry.data.frame.payload.request.id===listRequest.data.request.id))
   else check(runtime.events.some((entry:any)=>entry.event==='node.dispatch'&&entry.data.request.id===listRequest.data.request.id))
   if(before.detail){
    check(snapshot.detail?.modelId===before.detail.modelId)
    const detailRequest=single(requests.filter((entry:any)=>entry.data.actionId===data.actionId&&entry.data.request.command==='collection.detail'&&entry.data.request.payload.modelId===before.detail.modelId),'main.request')
    const detailReply=single(responses.filter((entry:any)=>entry.data.requestId===detailRequest.data.request.id),'main.response')
    check(detailRequest.sequence>listReply.sequence&&detailReply.sequence>detailRequest.sequence&&detailReply.sequence<settled.sequence)
   }
  }
  for(const [name,total] of [['filter-brand',13],['filter-query',1],['filter-decade',9],['filter-state',5]] as const)if(control===name)check(snapshot.total===total)
  if(['settings-open','readonly-on','readonly-off'].includes(control)) {
   check(snapshot.readonlySettings);exact(snapshot.readonlySettings,['enabled','mode','state']);const settings=snapshot.readonlySettings
   check(typeof settings.enabled==='boolean'&&['node','rust'].includes(settings.mode)&&['off','enabling','ready','stale','refreshing','failed','blocked','closing'].includes(settings.state))
   if(control==='readonly-off')same(settings,{enabled:false,mode:'node',state:'off'})
   if(control==='readonly-on')same(settings,{enabled:true,mode:mode==='rust'?'rust':'node',state:mode==='rust'?'ready':'failed'})
   if(cold)same(settings,{enabled:mode==='rust',mode:mode==='rust'?'rust':'node',state:mode==='rust'?'ready':'off'})
   continue
  }
  if(snapshot.detail){
   exact(snapshot.detail,['label','modelId','total','openedBlank','policy','reserve']);check(isCollectionId(snapshot.detail.modelId)&&snapshot.detail.total===1&&snapshot.detail.openedBlank===1)
   const detailReplies=responses.filter((entry:any)=>entry.sequence<settled.sequence&&entry.data.command==='collection.detail'&&entry.data.reply.result.model.id===snapshot.detail.modelId)
   check(detailReplies.length>0);const model=detailReplies.at(-1).data.reply.result.model;check(snapshot.detail.label.includes(model.name)&&snapshot.detail.policy===model.collectorPolicy&&snapshot.detail.reserve===String(model.minimumSealedReserve))
  }else {
   const listReplies=responses.filter((entry:any)=>entry.sequence<settled.sequence&&entry.data.command==='collection.list'&&entry.data.reply.result.limit===24)
   check(listReplies.length>0);const list=listReplies.at(-1).data.reply.result
   check(snapshot.total===list.total&&snapshot.rows.length===list.items.length)
   snapshot.rows.forEach((row:any,index:number)=>check(row.label.includes(list.items[index].name)&&row.label.includes(list.items[index].brand)))
  }
 }
 const window=single(main,'main.window').data,ipcs=entries(main,'main.ipcRequest'),ipcReplies=entries(main,'main.ipcReply'),bound=new Set<string>()
 check(ipcs.length===ipcReplies.length&&new Set(ipcs.map((event:any)=>event.data.invokeId)).size===ipcs.length)
 for(const event of ipcs){
  const data=event.data;exact(data.sender,['webContentsId','rendererPid','frameUrl','trusted']);same(data.sender,{webContentsId:window.webContentsId,rendererPid:window.rendererPid,frameUrl:window.frameUrl,trusted:true})
  check(typeof data.invokeId==='string'&&/^ipc-[1-9][0-9]*$/u.test(data.invokeId)&&Array.isArray(data.args)&&(data.actionId===null||actions.some((action:any)=>action.data.actionId===data.actionId&&action.sequence<event.sequence)))
  const matches=ipcReplies.filter((reply:any)=>reply.data.invokeId===data.invokeId);check(matches.length===1&&matches[0].sequence>event.sequence&&matches[0].data.channel===data.channel&&matches[0].data.actionId===data.actionId)
  const ipcReply=matches[0]
  const command=data.channel==='collection:list'?'collection.list':data.channel==='collection:detail'?'collection.detail':data.channel==='commandOutbox:submit'?'commandOutbox.execute':data.channel==='commandOutbox:context'?'commandOutbox.context':null
  if(command){
   let payload:any
   if(command==='collection.list'){check(data.args.length>=1&&data.args.length<=2);payload={page:data.args[0],...(data.args[1]?{filter:data.args[1]}:{})}}
   else if(command==='collection.detail'){check(data.args.length===2);payload={modelId:data.args[0],page:data.args[1]}}
   else if(command==='commandOutbox.execute'){check(!cold&&data.args.length===1);exact(data.args[0],['request']);payload=data.args[0].request;check(['collection.receive','collection.setPolicy'].includes(payload.command))}
   else {same(data.args,[null]);payload={}}
   const matches=requests.filter((request:any)=>!bound.has(request.data.request.id)&&request.data.request.command===command&&request.sequence>event.sequence&&request.sequence<ipcReply.sequence&&JSON.stringify(request.data.request.payload)===JSON.stringify(payload))
   check(matches.length>0);const request=matches[0],response=responses.find((reply:any)=>reply.data.requestId===request.data.request.id)
   check(response&&response.sequence<ipcReply.sequence);bound.add(request.data.request.id)
   if(command==='commandOutbox.execute'){exact(ipcReply.data.result,['ok','outboxId','result']);check(ipcReply.data.result.ok===true&&isCollectionId(ipcReply.data.result.outboxId));same(ipcReply.data.result.result,response.data.reply.result.result)}else same(ipcReply.data.result,response.data.reply.result)
  }else if(data.channel==='commandOutbox:acknowledge'){
   check(!cold&&data.args.length===1);exact(data.args[0],['id']);check(isCommandOutboxView(ipcReply.data.result));exact(ipcReply.data.result,['id','commandId','command','datasetId','state','createdAt','updatedAt','acknowledged','canRetry']);check(isCollectionId(data.args[0].id)&&ipcReply.data.result.id===data.args[0].id&&ipcReply.data.result.acknowledged===true&&ipcReply.data.result.state==='succeeded')
  }else if(['collection:readonly-settings','collection:set-readonly-enabled','collection:refresh'].includes(data.channel)) {
   if(data.channel==='collection:set-readonly-enabled'){check(!cold);same(data.args,[data.args[0]]);check(typeof data.args[0]==='boolean');statusFor(ipcReply.data.result);same(ipcReply.data.result,{schemaVersion:1,enabled:data.args[0],mode:data.args[0]&&mode==='rust'?'rust':'node',state:data.args[0]?(mode==='rust'?'ready':'failed'):'off',...(data.args[0]&&mode==='pin'?{errorCode:'RUST_UNAVAILABLE'}:{})})}
   else if(data.channel==='collection:readonly-settings'){same(data.args,[]);statusFor(ipcReply.data.result);if(mode==='node')same(ipcReply.data.result,{schemaVersion:1,enabled:false,mode:'node',state:'off'});if(mode==='pin')check(ipcReply.data.result.mode==='node');if(cold&&mode==='rust')check(ipcReply.data.result.enabled===true&&['enabling','refreshing','ready'].includes(ipcReply.data.result.state))}
   else {check(!cold);same(data.args,[]);exact(ipcReply.data.result,['schemaVersion','refreshed','settings']);check(ipcReply.data.result.schemaVersion===1&&ipcReply.data.result.refreshed===(mode==='rust'));statusFor(ipcReply.data.result.settings)}
  }else {check(data.channel==='commandOutbox:overview'&&data.args.length===0&&isCommandOutboxOverview(ipcReply.data.result))}
 }
 for(const event of requests.filter((event:any)=>['collection.list','collection.detail','commandOutbox.execute'].includes(event.data.request.command)))check(bound.has(event.data.request.id))
 const submits=ipcs.filter((event:any)=>event.data.channel==='commandOutbox:submit'),acks=ipcs.filter((event:any)=>event.data.channel==='commandOutbox:acknowledge');check(submits.length===(cold?0:27)&&acks.length===submits.length)
 const complete=JSON.parse(bytesAt(path.join(runtime.profileDirectory,'rust014-completed.json'),1024*1024).toString())
 if(!cold){
  same(submits.map((event:any)=>event.data.args[0].request.payload.commandId),complete.commandIds)
  same(submits.map((event:any)=>ipcReplies.find((reply:any)=>reply.data.invokeId===event.data.invokeId).data.result.outboxId),complete.outboxIds)
  same(acks.map((event:any)=>event.data.args[0].id),complete.outboxIds)
  for(const [at,event] of acks.entries()){const reply=ipcReplies.find((entry:any)=>entry.data.invokeId===event.data.invokeId),submit=ipcReplies.find((entry:any)=>entry.data.invokeId===submits[at].data.invokeId);check(event.sequence>submit.sequence&&reply.data.result.commandId===complete.commandIds[at]&&reply.data.result.datasetId===complete.datasetId)}
 }
 const toggles=ipcs.filter((event:any)=>event.data.channel==='collection:set-readonly-enabled'),refreshes=ipcs.filter((event:any)=>event.data.channel==='collection:refresh')
 same(toggles.map((event:any)=>event.data.args[0]),cold||mode==='node'?[]:[true,false,true])
 check(refreshes.length===(cold?0:mode==='rust'?1:2))
 const preference=path.join(runtime.profileDirectory,'collection-readonly.json')
 try {const observed=lstatSync(preference);check((observed.mode&0o077)===0);same(JSON.parse(bytesAt(preference,4096).toString()),{schemaVersion:1,enabled:mode!=='node'})}catch(error){check(mode==='node'&&(error as NodeJS.ErrnoException).code==='ENOENT')}
 const stalePhase=entries(main,'main.probePhase').find((event:any)=>event.data.phase==='stale'),refreshed=entries(main,'main.probePhase').find((event:any)=>event.data.phase==='refreshed')
 if(!cold&&runtime.kind==='rust-controls'){
  const explicitRefresh=single(ipcs.filter((event:any)=>event.data.channel==='collection:refresh'),'main.ipcRequest')
  const staleLists=requests.filter((event:any)=>event.data.request.command==='collection.list'&&event.sequence>stalePhase.sequence&&event.sequence<explicitRefresh.sequence)
  check(staleLists.length>0&&staleLists.every((event:any)=>runtime.events.some((core:any)=>core.event==='node.dispatch'&&core.data.request.id===event.data.request.id)))
  const offOn=entries(main,'main.probePhase').find((event:any)=>event.data.phase==='off-on');const resumed=requests.filter((event:any)=>event.data.request.command==='collection.list'&&event.sequence>refreshed.sequence&&(!offOn||event.sequence<offOn.sequence))
  check(resumed.length>0&&resumed.every((event:any)=>runtime.events.some((core:any)=>core.event==='rust.request'&&core.data.frame.operation==='dispatch'&&core.data.frame.payload.request.id===event.data.request.id)))
 }
}


/** 单层审计用于拒绝归因；不检查完整包身份、SQL和成本，不能作为最终PASS。 */
export function validateCollectionReadonlyRuntimeLayerEvidence(runtime:any,runKey:typeof RENDERER_RUN_KEYS[number],expectedCandidateIdentity:any) {
 onlyData(runtime);onlyData(expectedCandidateIdentity);check(RENDERER_RUN_KEYS.includes(runKey))
 runtimeFor(runtime,runKey,expectedCandidateIdentity)
 routedRequests(runtime,expectedCandidateIdentity,runKey.startsWith('node')?'node':'rust',runKey.endsWith('cold'))
 ipcFor(runtime,runKey.endsWith('cold'))
 return Object.freeze({state:'RUNTIME_LAYER_VALIDATED' as const,fullPackageAcceptance:'NOT_EVALUATED' as const})
}
/** SQL层仍独立读取已关闭的immutable文件，不接受报告行作为物理参照。 */
export function validateCollectionReadonlySqliteLayerEvidence(sql:any,kind:'node'|'rust',runtimes:Record<string,any>,runtimeIdentities:Record<string,RendererArtifactIdentity>) {
 onlyData(sql);onlyData(runtimes);onlyData(runtimeIdentities)
 exact(sql,['schemaVersion','task','kind','stages']);check(sql.schemaVersion===1&&sql.task==='RUST-014'&&sql.kind===kind&&Array.isArray(sql.stages)&&sql.stages.length===2)
 for(const [at,suffix] of ['fresh','cold'].entries()){const key=`${kind}-${suffix}`;check(runtimes[key]&&runtimeIdentities[key]);sqlStage(sql.stages[at],key,runtimes[key],runtimeIdentities[key])}
 for(const key of ['models','fullModels','lots','skus','ledger','outbox'])same(sql.stages[0][key],sql.stages[1][key])
 return Object.freeze({state:'SQLITE_LAYER_VALIDATED' as const,fullPackageAcceptance:'NOT_EVALUATED' as const})
}
