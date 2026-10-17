import { types as nodeTypes } from 'node:util'
import { isLocalWorkbenchAlbumCapture } from './name-proposal.js'
import { isLocalAlbumPrivateRelative } from '../local-album-browser/grouping.js'
import { isLocalWorkbenchPlanCapture, assertLocalWorkbenchCapturedPlan } from './plan-registry.js'
import { freezeLocalWorkbenchValue, isLocalWorkbenchDenseArray, type LocalWorkbenchPlanCapture } from './types.js'
import { LOCAL_CUE_OUTPUT_OPERATION, cueOutputCanonical, isLocalCueOutputEvent, projectLocalCueOutputEvent, type LocalCueOutputEvent, type LocalCueOutputProjection } from '../local-cue-output-protocol.js'
import { LOCAL_SCAN_SETTINGS_OPERATION, LOCAL_SCAN_DEFAULT_SETTINGS, isLocalScanSettingsEvent, localScanSettingsFingerprint, type LocalScanSettingsEvent, type LocalScanSettings, type LocalScanFrozenSettings } from '../local-scan-settings.js'
import { assertLocalLyricsSaveRecord } from '../local-library-lyrics/save-coordinator.js'
import { LocalLyricsError, lyricsCanonical, lyricsDigest, lyricsPresence, type LocalLyricsSaveRecord, type LocalLyricsJobRecord, type LocalLyricsInventoryObservation, type LocalLyricsCapture } from '../local-library-lyrics/types.js'
import type { LocalLyricsScope } from '@music-bridge/contracts'
import type { LocalAlbumLyricsInventory } from '../local-album-browser/sql-types.js'
import { METADATA_PARSER_VERSION, CUE_HEADER_METADATA_PARSER_VERSION } from '../../library/metadata-reader-types.js'
import { createHash, randomUUID } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import { isLocalWorkbenchRegistrySnapshot } from './plan-registry.js'
import { isLocalWorkbenchDataRecord, LocalWorkbenchPlanError, type LocalWorkbenchRegistryPersistence, type LocalWorkbenchRegistrySnapshot } from './types.js'
import { LOCAL_LYRICS_PHYSICAL_OPERATION, LOCAL_LYRICS_PHYSICAL_LIMITS, captureLocalLyricsPhysicalRecord, captureLocalLyricsPhysicalGroup,
  localLyricsPhysicalImmutable, localLyricsPhysicalState, assertLocalLyricsPhysicalTransition, lyricsPhysicalCanonical,
  type LocalLyricsPhysicalRecord } from '../../library/lyrics-source-format.js'

/** 原物理组只在首次保存；后续状态引用原完整组，冷核不得丢尾或跳修订。 */
interface LocalLyricsPhysicalEventCommon {
  datasetId:string; operationId:string; eventId:string; transactionId:string; revision:number
  immutableSha256:string; bytes:number; chunks:number
}
export type LocalLyricsPhysicalEvent = LocalLyricsPhysicalEventCommon & (
  | {kind:'immutable-chunk';index:number;payload:string}
  | {kind:'publication-chunk';index:number;payload:string;publication:LocalLyricsPhysicalPublicationPin}
  | {kind:'state';state:ReturnType<typeof localLyricsPhysicalState>;publication:LocalLyricsPhysicalPublicationPin|null}
)
export interface LocalLyricsPhysicalPublicationPin {sha256:string;bytes:number;chunks:number}
/** 物理提交只引用同一SQL的原扫描行、实际资产子命令和歌词盘点。 */
export interface LocalLyricsPhysicalPublication {
  schema:1;datasetId:string;operationId:string
  replace:null|{commandId:string;ledgerSequence:number;before:dto.AudioAsset;after:dto.AudioAsset;relative:string;catalogSha256:string|null}
  scan:null|{rootId:string;relative:string;jobId:string;batchId:string;before:string;after:string}
  inventory:{record:LocalLyricsInventoryRecord;ledgerSequence:number}
}
export interface LocalLyricsPhysicalProjection {
  datasetId:string;highWater:number
  records:Map<string,{record:LocalLyricsPhysicalRecord;ledgerSequence:number;immutableSha256:string;publication:LocalLyricsPhysicalPublication|null;publicationSequence:number|null}>
  pending:null|{header:Omit<LocalLyricsPhysicalEventCommon,'eventId'>;parts:Buffer[];bytes:number}
  pendingPublication:null|{header:Omit<LocalLyricsPhysicalEventCommon,'eventId'>;pin:LocalLyricsPhysicalPublicationPin;parts:Buffer[];bytes:number}
}
const PHYSICAL_CHUNK_BYTES=40*1024
export function emptyLocalLyricsPhysicalProjection(datasetId:string):LocalLyricsPhysicalProjection {
  if(!dto.isCommandOutboxDatasetId(datasetId))return invalid()
  return {datasetId,highWater:0,records:new Map(),pending:null,pendingPublication:null}
}
export function copyLocalLyricsPhysicalProjection(value:LocalLyricsPhysicalProjection):LocalLyricsPhysicalProjection {
  if(value.pending||value.pendingPublication)return invalid()
  return {...value,records:new Map(value.records),pending:null,pendingPublication:null}
}
function isPhysicalPublicationPin(v:unknown):v is LocalLyricsPhysicalPublicationPin {
  return isLocalWorkbenchDataRecord(v,['sha256','bytes','chunks'])&&hex(v.sha256)
    &&integer(v.bytes,1,LOCAL_LYRICS_PHYSICAL_LIMITS.groupBytes)&&integer(v.chunks,1,Math.ceil(LOCAL_LYRICS_PHYSICAL_LIMITS.groupBytes/PHYSICAL_CHUNK_BYTES))
    &&v.chunks===Math.ceil(Number(v.bytes)/PHYSICAL_CHUNK_BYTES)
}
export function captureLocalLyricsPhysicalPublication(input:unknown):LocalLyricsPhysicalPublication {
  const v=JSON.parse(lyricsPhysicalCanonical(input)) as unknown
  if(!isLocalWorkbenchDataRecord(v,['schema','datasetId','operationId','replace','scan','inventory'])||v.schema!==1||!dto.isCommandOutboxDatasetId(v.datasetId)||!hex(v.operationId)
    ||!isLocalWorkbenchDataRecord(v.inventory,['record','ledgerSequence'])||!integer(v.inventory.ledgerSequence,1,Number.MAX_SAFE_INTEGER))return invalid()
  const inventory=v.inventory.record as LocalLyricsInventoryRecord,identity=localLyricsRecordIdentity('inventory',inventory)
  if(identity.datasetId!==v.datasetId)return invalid()
  if(v.replace!==null&&(!isLocalWorkbenchDataRecord(v.replace,['commandId','ledgerSequence','before','after','relative','catalogSha256'])
    ||!dto.isCollectionId(v.replace.commandId)||!integer(v.replace.ledgerSequence,1,Number.MAX_SAFE_INTEGER)||!dto.isAudioAsset(v.replace.before)||!dto.isAudioAsset(v.replace.after)
    ||v.replace.before.id!==v.replace.after.id||typeof v.replace.relative!=='string'||v.replace.catalogSha256!==null&&!hex(v.replace.catalogSha256)))return invalid()
  const scan=v.scan;
  if(scan!==null&&(!isLocalWorkbenchDataRecord(scan,['rootId','relative','jobId','batchId','before','after'])||!['rootId','jobId','batchId'].every(k=>dto.isCollectionId(scan[k]))
    ||typeof scan.relative!=='string'||typeof scan.before!=='string'||typeof scan.after!=='string'||Buffer.byteLength(scan.before)>64*1024||Buffer.byteLength(scan.after)>64*1024))return invalid()
  if((v.replace===null)!==(v.scan===null))return invalid()
  return v as unknown as LocalLyricsPhysicalPublication
}
function physicalHeader(event:LocalLyricsPhysicalEvent):Omit<LocalLyricsPhysicalEventCommon,'eventId'> {
  return {datasetId:event.datasetId,operationId:event.operationId,transactionId:event.transactionId,revision:event.revision,
    immutableSha256:event.immutableSha256,bytes:event.bytes,chunks:event.chunks}
}
export function isLocalLyricsPhysicalEvent(value:unknown):value is LocalLyricsPhysicalEvent {
  const common=['datasetId','operationId','eventId','transactionId','revision','immutableSha256','bytes','chunks']
  if(!isLocalWorkbenchDataRecord(value,common,['kind','index','payload','state','publication'])
    ||!dto.isCommandOutboxDatasetId(value.datasetId)||!hex(value.operationId)||!dto.isCollectionId(value.eventId)||!dto.isCollectionId(value.transactionId)
    ||!integer(value.revision,1,Number.MAX_SAFE_INTEGER)||!hex(value.immutableSha256)
    ||!integer(value.bytes,1,LOCAL_LYRICS_PHYSICAL_LIMITS.groupBytes)||!integer(value.chunks,1,Math.ceil(LOCAL_LYRICS_PHYSICAL_LIMITS.groupBytes/PHYSICAL_CHUNK_BYTES))
    ||value.chunks!==Math.ceil(Number(value.bytes)/PHYSICAL_CHUNK_BYTES))return false
  if(value.kind==='immutable-chunk') {
    if(Reflect.ownKeys(value).length!==common.length+3||!integer(value.index,0,Number(value.chunks)-1)||typeof value.payload!=='string')return false
    const bytes=Buffer.from(value.payload,'base64'),expected=Number(value.index)===Number(value.chunks)-1?Number(value.bytes)-Number(value.index)*PHYSICAL_CHUNK_BYTES:PHYSICAL_CHUNK_BYTES
    return value.revision===1&&bytes.length===expected&&bytes.toString('base64')===value.payload
  }
  if(value.kind==='publication-chunk') {
    if(Reflect.ownKeys(value).length!==common.length+4||!isPhysicalPublicationPin(value.publication)||!integer(value.index,0,value.publication.chunks-1)||typeof value.payload!=='string')return false
    const raw=Buffer.from(value.payload,'base64'),expected=value.index===value.publication.chunks-1?value.publication.bytes-value.index*PHYSICAL_CHUNK_BYTES:PHYSICAL_CHUNK_BYTES
    return value.revision>1&&raw.length===expected&&raw.toString('base64')===value.payload
  }
  if(value.kind!=='state'||Reflect.ownKeys(value).length!==common.length+3
    ||!isLocalWorkbenchDataRecord(value.state,['revision','currentOwnerEpoch','phase','grant','artifacts','fidelity','result','physicalClosed','protectionReleased','unresolved'])
    ||value.state.revision!==value.revision||value.publication!==null&&!isPhysicalPublicationPin(value.publication)
    ||(value.state.phase==='FACTS_COMMITTED')!==(value.publication!==null))return false
  return Buffer.byteLength(lyricsPhysicalCanonical(value),'utf8')<64*1024
}
export function readLocalLyricsPhysicalEvent(row:Record<string,unknown>):LocalLyricsPhysicalEvent {
  if(row.operation!==LOCAL_LYRICS_PHYSICAL_OPERATION||typeof row.result!=='string'||typeof row.request!=='string'||!dto.isCollectionId(row.command_id)
    ||typeof row.created_at!=='string'||!Number.isFinite(Date.parse(row.created_at)))return invalid()
  let event:unknown,request:unknown
  try{event=JSON.parse(row.result);request=JSON.parse(row.request)}catch{return invalid()}
  if(!isLocalLyricsPhysicalEvent(event)||event.eventId!==row.command_id||row.result!==lyricsPhysicalCanonical(event)||row.fingerprint!==hash(lyricsPhysicalCanonical(event))
    ||row.request!==lyricsPhysicalCanonical(request)||lyricsPhysicalCanonical(request)!==lyricsPhysicalCanonical({purpose:'LYRICS',operationId:event.operationId,datasetId:event.datasetId,revision:event.revision,kind:event.kind}))return invalid()
  return event
}
export function localLyricsPhysicalLedgerRow(event:LocalLyricsPhysicalEvent):Record<string,string> {
  if(!isLocalLyricsPhysicalEvent(event))return invalid()
  const request=lyricsPhysicalCanonical({purpose:'LYRICS',operationId:event.operationId,datasetId:event.datasetId,revision:event.revision,kind:event.kind}),result=lyricsPhysicalCanonical(event)
  const row={command_id:event.eventId,fingerprint:hash(result),operation:LOCAL_LYRICS_PHYSICAL_OPERATION,request,result,created_at:new Date().toISOString()}
  if(Object.values(row).reduce((bytes,text)=>bytes+Buffer.byteLength(text),0)>64*1024)return invalid()
  return row
}
export function createLocalLyricsPhysicalEvents(record:LocalLyricsPhysicalRecord,previous:LocalLyricsPhysicalRecord|null,publication?:LocalLyricsPhysicalPublication):readonly LocalLyricsPhysicalEvent[] {
  const captured=captureLocalLyricsPhysicalRecord(record);assertLocalLyricsPhysicalTransition(previous,captured)
  const bytes=Buffer.from(lyricsPhysicalCanonical(localLyricsPhysicalImmutable(captured)),'utf8')
  if(bytes.length<1||bytes.length>LOCAL_LYRICS_PHYSICAL_LIMITS.groupBytes)return invalid()
  const common={datasetId:captured.binding.datasetId,operationId:captured.operationId,transactionId:randomUUID(),revision:captured.revision,
    immutableSha256:hash(bytes),bytes:bytes.length,chunks:Math.ceil(bytes.length/PHYSICAL_CHUNK_BYTES)}
  const events:LocalLyricsPhysicalEvent[]=[]
  if(previous===null)for(let index=0;index<common.chunks;index++)events.push({...common,eventId:randomUUID(),kind:'immutable-chunk',index,
    payload:bytes.subarray(index*PHYSICAL_CHUNK_BYTES,(index+1)*PHYSICAL_CHUNK_BYTES).toString('base64')})
  let publicationPin:LocalLyricsPhysicalPublicationPin|null=null
  if(publication){const facts=captureLocalLyricsPhysicalPublication(publication),raw=Buffer.from(lyricsPhysicalCanonical(facts),'utf8')
    if(captured.phase!=='FACTS_COMMITTED'||facts.datasetId!==captured.binding.datasetId||facts.operationId!==captured.operationId)return invalid()
    publicationPin={sha256:hash(raw),bytes:raw.length,chunks:Math.ceil(raw.length/PHYSICAL_CHUNK_BYTES)}
    for(let index=0;index<publicationPin.chunks;index++)events.push({...common,eventId:randomUUID(),kind:'publication-chunk',publication:publicationPin,index,payload:raw.subarray(index*PHYSICAL_CHUNK_BYTES,(index+1)*PHYSICAL_CHUNK_BYTES).toString('base64')})
  }
  events.push({...common,eventId:randomUUID(),kind:'state',state:localLyricsPhysicalState(captured),publication:publicationPin})
  if(!events.every(isLocalLyricsPhysicalEvent))return invalid()
  return events
}
export function projectLocalLyricsPhysicalEvent(projection:LocalLyricsPhysicalProjection,event:LocalLyricsPhysicalEvent,ordinal:number):LocalLyricsPhysicalRecord|null {
  if(!isLocalLyricsPhysicalEvent(event)||event.datasetId!==projection.datasetId||!integer(ordinal,projection.highWater+1,Number.MAX_SAFE_INTEGER))return invalid()
  const previous=projection.records.get(event.operationId)
  if(event.kind==='immutable-chunk') {
    if(previous||event.revision!==1||projection.pendingPublication)return invalid()
    if(!projection.pending){if(event.index!==0)return invalid();projection.pending={header:physicalHeader(event),parts:[],bytes:0}}
    const pending=projection.pending
    if(lyricsPhysicalCanonical(pending.header)!==lyricsPhysicalCanonical(physicalHeader(event))||event.index!==pending.parts.length)return invalid()
    const bytes=Buffer.from(event.payload,'base64');pending.parts.push(bytes);pending.bytes+=bytes.length
    if(pending.bytes>event.bytes)return invalid()
    projection.highWater=ordinal;return null
  }
  if(event.kind==='publication-chunk'){
    if(!previous||projection.pending||previous.publication||event.revision!==previous.record.revision+1||event.immutableSha256!==previous.immutableSha256)return invalid()
    if(!projection.pendingPublication){if(event.index!==0)return invalid();projection.pendingPublication={header:physicalHeader(event),pin:event.publication,parts:[],bytes:0}}
    const pending=projection.pendingPublication
    if(lyricsPhysicalCanonical(pending.header)!==lyricsPhysicalCanonical(physicalHeader(event))||lyricsPhysicalCanonical(pending.pin)!==lyricsPhysicalCanonical(event.publication)||event.index!==pending.parts.length)return invalid()
    const raw=Buffer.from(event.payload,'base64');pending.parts.push(raw);pending.bytes+=raw.length
    if(pending.bytes>pending.pin.bytes)return invalid()
    projection.highWater=ordinal;return null
  }
  let immutable:ReturnType<typeof localLyricsPhysicalImmutable>
  if(previous) {
    if(projection.pending||event.revision!==previous.record.revision+1||event.immutableSha256!==previous.immutableSha256)return invalid()
    immutable=localLyricsPhysicalImmutable(previous.record)
    const raw=Buffer.from(lyricsPhysicalCanonical(immutable),'utf8')
    if(raw.length!==event.bytes||hash(raw)!==event.immutableSha256)return invalid()
  } else {
    const pending=projection.pending
    if(!pending||event.revision!==1||pending.parts.length!==event.chunks||pending.bytes!==event.bytes
      ||lyricsPhysicalCanonical(pending.header)!==lyricsPhysicalCanonical(physicalHeader(event)))return invalid()
    const bytes=Buffer.concat(pending.parts)
    if(hash(bytes)!==event.immutableSha256)return invalid()
    try{immutable=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as ReturnType<typeof localLyricsPhysicalImmutable>}catch{return invalid()}
    if(!isLocalWorkbenchDataRecord(immutable,['schema','operationId','binding','original'])||lyricsPhysicalCanonical(immutable)!==bytes.toString('utf8'))return invalid()
  }
  const record=captureLocalLyricsPhysicalRecord({...immutable,...event.state})
  if(record.operationId!==event.operationId||record.binding.datasetId!==projection.datasetId||record.revision!==event.revision)return invalid()
  assertLocalLyricsPhysicalTransition(previous?.record??null,record)
  let publication=previous?.publication??null,publicationSequence=previous?.publicationSequence??null
  if(event.publication){const pending=projection.pendingPublication
    if(!pending||publication||pending.parts.length!==event.publication.chunks||pending.bytes!==event.publication.bytes||lyricsPhysicalCanonical(pending.pin)!==lyricsPhysicalCanonical(event.publication)
      ||lyricsPhysicalCanonical(pending.header)!==lyricsPhysicalCanonical(physicalHeader(event)))return invalid()
    const raw=Buffer.concat(pending.parts);if(hash(raw)!==event.publication.sha256)return invalid()
    try{publication=captureLocalLyricsPhysicalPublication(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)))}catch{return invalid()}
    if(lyricsPhysicalCanonical(publication)!==raw.toString('utf8')||publication.operationId!==record.operationId||publication.datasetId!==record.binding.datasetId)return invalid()
    publicationSequence=ordinal
  }else if(projection.pendingPublication)return invalid()
  projection.records.set(event.operationId,{record,ledgerSequence:ordinal,immutableSha256:event.immutableSha256,publication,publicationSequence});projection.pending=null;projection.pendingPublication=null;projection.highWater=ordinal
  return record
}
export function assertLocalLyricsPhysicalComplete(value:LocalLyricsPhysicalProjection):void {if(value.pending||value.pendingPublication)return invalid()}

export const LOCAL_WORKBENCH_JOURNAL_OPERATION = 'local-workbench-v1'
export const LOCAL_WORKBENCH_SNAPSHOT_BYTES = 32 * 1024 * 1024
const CHUNK_BYTES = 12 * 1024
const MAX_CHUNKS = Math.ceil(LOCAL_WORKBENCH_SNAPSHOT_BYTES / CHUNK_BYTES)
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const invalid = (): never => { throw new LocalWorkbenchPlanError('PERSISTENCE_FAILED', '工作台原持久事实损坏或CAS身份不一致，保留数据并停止应用。') }
interface Common {
  eventId: string
  datasetId: string
  transactionId: string
  expectedRevision: number
  revision: number
  snapshotHash: string
  bytes: number
  chunks: number
}
export type LocalWorkbenchJournalEvent =
  | (Common & { kind: 'snapshot-chunk'; index: number; payload: string })
  | (Common & { kind: 'snapshot-commit' })
export interface LocalWorkbenchJournalProjection {
  datasetId: string
  revision: number
  snapshot: LocalWorkbenchRegistrySnapshot | null
  highWater: number
  pending: { common: Common; chunks: readonly Uint8Array[]; bytes: number } | null
}
function common(value: Common): Common {
  const { eventId, datasetId, transactionId, expectedRevision, revision, snapshotHash, bytes, chunks } = value
  return { eventId, datasetId, transactionId, expectedRevision, revision, snapshotHash, bytes, chunks }
}
function sameTransaction(a: Common, b: Common): boolean {
  return a.datasetId === b.datasetId && a.transactionId === b.transactionId && a.expectedRevision === b.expectedRevision
    && a.revision === b.revision && a.snapshotHash === b.snapshotHash && a.bytes === b.bytes && a.chunks === b.chunks
}
export function isLocalWorkbenchJournalEvent(value: unknown): value is LocalWorkbenchJournalEvent {
  if (!isLocalWorkbenchDataRecord(value, ['kind','eventId','datasetId','transactionId','expectedRevision','revision','snapshotHash','bytes','chunks'], ['index','payload'])
    || !dto.isCollectionId(value.eventId) || !dto.isCommandOutboxDatasetId(value.datasetId) || !dto.isCollectionId(value.transactionId)
    || !integer(value.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1) || value.revision !== value.expectedRevision + 1
    || !hex(value.snapshotHash) || !integer(value.bytes, 1, LOCAL_WORKBENCH_SNAPSHOT_BYTES)
    || !integer(value.chunks, 1, MAX_CHUNKS) || value.chunks !== Math.ceil(value.bytes / CHUNK_BYTES)) return false
  if (value.kind === 'snapshot-commit') return !Object.hasOwn(value, 'index') && !Object.hasOwn(value, 'payload')
  if (value.kind !== 'snapshot-chunk' || !integer(value.index, 0, value.chunks - 1) || typeof value.payload !== 'string'
    || value.payload.length > CHUNK_BYTES * 4 / 3 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.payload)) return false
  const decoded = Buffer.from(value.payload, 'base64')
  return decoded.toString('base64') === value.payload && decoded.length === Math.min(CHUNK_BYTES, value.bytes - value.index * CHUNK_BYTES)
}
export function localWorkbenchJournalCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(localWorkbenchJournalCanonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + localWorkbenchJournalCanonical(item)).join(',') + '}'
  const encoded = JSON.stringify(value); if (encoded === undefined) return invalid(); return encoded
}
/** 分块只为遵守原ledger单行64KiB；整批必须由同一Owner事务原子提交。 */
export function createLocalWorkbenchSnapshotEvents(snapshot: LocalWorkbenchRegistrySnapshot, expectedRevision: number, makeId = randomUUID): readonly LocalWorkbenchJournalEvent[] {
  if (!isLocalWorkbenchDataRecord(snapshot, ['schemaVersion','datasetId','revision','entries']) || typeof snapshot.datasetId !== 'string'
    || !isLocalWorkbenchRegistrySnapshot(snapshot, snapshot.datasetId) || snapshot.revision !== expectedRevision + 1
    || !integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)) return invalid()
  const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8')
  if (!bytes.length || bytes.length > LOCAL_WORKBENCH_SNAPSHOT_BYTES) return invalid()
  const ids = new Set<string>(), id = (): string => {
    const value = makeId(); if (!dto.isCollectionId(value) || ids.has(value)) return invalid(); ids.add(value); return value
  }
  const shared = { datasetId: snapshot.datasetId, transactionId: id(), expectedRevision, revision: snapshot.revision,
    snapshotHash: hash(bytes), bytes: bytes.length, chunks: Math.ceil(bytes.length / CHUNK_BYTES) }
  const events: LocalWorkbenchJournalEvent[] = []
  for (let index = 0; index < shared.chunks; index++) events.push({ ...shared, kind: 'snapshot-chunk', eventId: id(), index,
    payload: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64') })
  events.push({ ...shared, kind: 'snapshot-commit', eventId: id() })
  if (!events.every(isLocalWorkbenchJournalEvent)) return invalid()
  return events
}
export function emptyLocalWorkbenchJournalProjection(datasetId: string): LocalWorkbenchJournalProjection {
  if (!dto.isCommandOutboxDatasetId(datasetId)) return invalid()
  return { datasetId, revision: 0, snapshot: null, highWater: 0, pending: null }
}
export function copyLocalWorkbenchJournalProjection(value: LocalWorkbenchJournalProjection): LocalWorkbenchJournalProjection { return structuredClone(value) }
/** 按原ledger顺序复核；不丢弃坏尾部或把未commit分块当已持久计划。 */
export function projectLocalWorkbenchJournalEvent(projection: LocalWorkbenchJournalProjection, event: LocalWorkbenchJournalEvent, ordinal: number): void {
  if (!isLocalWorkbenchJournalEvent(event) || event.datasetId !== projection.datasetId || !integer(ordinal, 1, Number.MAX_SAFE_INTEGER)
    || ordinal <= projection.highWater || event.expectedRevision !== projection.revision) return invalid()
  if (event.kind === 'snapshot-chunk') {
    if (event.index === 0) {
      if (projection.pending) return invalid()
      projection.pending = { common: common(event), chunks: [], bytes: 0 }
    }
    const pending = projection.pending
    if (!pending || !sameTransaction(pending.common, event) || event.index !== pending.chunks.length) return invalid()
    const bytes = new Uint8Array(Buffer.from(event.payload, 'base64'))
    projection.pending = { common: pending.common, chunks: [...pending.chunks, bytes], bytes: pending.bytes + bytes.length }
    projection.highWater = ordinal; return
  }
  const pending = projection.pending
  if (!pending || !sameTransaction(pending.common, event) || pending.chunks.length !== event.chunks || pending.bytes !== event.bytes) return invalid()
  const bytes = Buffer.concat(pending.chunks.map(chunk => Buffer.from(chunk)), pending.bytes)
  if (hash(bytes) !== event.snapshotHash) return invalid()
  let snapshot: unknown
  try { snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return invalid() }
  if (!isLocalWorkbenchRegistrySnapshot(snapshot, projection.datasetId) || snapshot.revision !== event.revision) return invalid()
  projection.snapshot = snapshot; projection.revision = event.revision; projection.pending = null; projection.highWater = ordinal
}
export function assertLocalWorkbenchJournalComplete(projection: LocalWorkbenchJournalProjection): void { if (projection.pending) return invalid() }
export function localWorkbenchJournalLedgerRow(event: LocalWorkbenchJournalEvent): Record<string, string> {
  if (!isLocalWorkbenchJournalEvent(event)) return invalid()
  const request = localWorkbenchJournalCanonical(event), fingerprint = hash(request)
  const row = { command_id: event.eventId, operation: LOCAL_WORKBENCH_JOURNAL_OPERATION, fingerprint, request,
    result: localWorkbenchJournalCanonical({ eventId: event.eventId, eventHash: fingerprint }), created_at: new Date().toISOString() }
  if (Object.values(row).reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0) > 64 * 1024) return invalid()
  return row
}
export function readLocalWorkbenchJournalEvent(row: Record<string, unknown>): LocalWorkbenchJournalEvent {
  if (row.operation !== LOCAL_WORKBENCH_JOURNAL_OPERATION || !dto.isCollectionId(row.command_id) || !hex(row.fingerprint)
    || typeof row.request !== 'string' || typeof row.result !== 'string' || Buffer.byteLength(row.request) > 64 * 1024 || Buffer.byteLength(row.result) > 64 * 1024
    || typeof row.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.created_at) || !Number.isFinite(Date.parse(row.created_at))) return invalid()
  let event: unknown, result: unknown
  try { event = JSON.parse(row.request); result = JSON.parse(row.result) } catch { return invalid() }
  if (!isLocalWorkbenchJournalEvent(event) || event.eventId !== row.command_id || localWorkbenchJournalCanonical(event) !== row.request || hash(row.request) !== row.fingerprint
    || !isLocalWorkbenchDataRecord(result, ['eventId','eventHash']) || result.eventId !== event.eventId || result.eventHash !== row.fingerprint) return invalid()
  return event
}
export interface LocalWorkbenchOwnerJournalPort {
  /** 原Owner guarded读取并验证完整journal/CAS链，返回深复制。 */
  privateWorkbenchSnapshot(datasetId: string): LocalWorkbenchRegistrySnapshot | null
  /** 原Owner一个BEGIN IMMEDIATE内核CAS、追加全部事件和commit，原预算/提交fatal规则继续适用。 */
  privateWorkbenchCompareAndSwap(datasetId: string, expectedRevision: number, events: readonly LocalWorkbenchJournalEvent[]): void
}
/** 只有真实同Owner持久端口；不新开DB、不提供内存/本地文件fallback。 */
export function createLocalWorkbenchOwnerPersistence(datasetId: string, catalog: LocalWorkbenchOwnerJournalPort): LocalWorkbenchRegistryPersistence {
  if (!dto.isCommandOutboxDatasetId(datasetId) || !catalog?.privateWorkbenchSnapshot || !catalog.privateWorkbenchCompareAndSwap) return invalid()
  return {
    async load(requested) {
      if (requested !== datasetId) return invalid()
      const snapshot = catalog.privateWorkbenchSnapshot(datasetId)
      if (snapshot !== null && !isLocalWorkbenchRegistrySnapshot(snapshot, datasetId)) return invalid()
      return snapshot === null ? null : structuredClone(snapshot)
    },
    async save(snapshot, expectedRevision) {
      if (!isLocalWorkbenchRegistrySnapshot(snapshot, datasetId)) return invalid()
      const events = createLocalWorkbenchSnapshotEvents(snapshot, expectedRevision)
      catalog.privateWorkbenchCompareAndSwap(datasetId, expectedRevision, events)
    },
  }
}


/** 歌词仍在原append-only ledger中；每个原record独立分块，不能整库重写JSON。 */
export const LOCAL_LYRICS_JOURNAL_OPERATION = 'local-lyrics-v1'
export interface LocalLyricsInventoryRecord {
  scope: LocalLyricsScope
  captureFingerprint: string
  revision: number
  observations: readonly LocalLyricsInventoryObservation[]
}
export type LocalLyricsDurableRecord = LocalLyricsSaveRecord | LocalLyricsJobRecord | LocalLyricsInventoryRecord
export type LocalLyricsRecordKind = 'save' | 'job' | 'inventory'
interface LyricsCommon {
  datasetId: string; eventId: string; transactionId: string; recordKind: LocalLyricsRecordKind
  key: string; expectedRevision: number | null; revision: number; snapshotHash: string; bytes: number; chunks: number
  encoding?:'save-state-v1'; intentFingerprint?:string; originalSnapshotHash?:string
}
export type LocalLyricsJournalEvent = LyricsCommon & ({kind:'record-chunk'; index:number; payload:string} | {kind:'record-commit'})
export interface LocalLyricsRecordIndex {
  datasetId: string; recordKind: LocalLyricsRecordKind; key: string; revision: number
  transactionId: string; firstOrdinal: number; lastOrdinal: number; chunks: number; bytes: number; snapshotHash: string
  immutableHash: string; scope: LocalLyricsScope | null; pending: boolean
  intentSource:LocalLyricsFullRecordPin|null
  saveState:LocalLyricsMutableState|null
}
export type LocalLyricsFullRecordPin=Omit<LocalLyricsRecordIndex,'intentSource'|'saveState'>
export interface LocalLyricsMutableState {receipt:dto.LocalLyricsSaveReceipt;physicalClosed:boolean;discarded:boolean}
export interface LocalLyricsStateDelta {
  schemaVersion:1;commandId:string;sessionId:string;intentFingerprint:string;revision:number
  header:{state:dto.LocalLyricsSaveReceipt['state'];cover:dto.LocalLyricsWriteState;snapshot:dto.LocalLyricsSaveReceipt['snapshot'];physicalClosed:boolean;discarded:boolean}
  changes:readonly {index:number;trackId:string;lrc:dto.LocalLyricsWriteState;embed:dto.LocalLyricsWriteState}[]
}
export interface LocalLyricsJournalProjection {
  datasetId: string; highWater: number; latest: Map<string,LocalLyricsRecordIndex>
  inventory: Map<string,{rootId:string;fileRevision:string;lrc:dto.LocalLyricsPresence;embedded:dto.LocalLyricsPresence;presence:dto.LocalLyricsPresence}>
  jobOrigins:Map<string,{request:dto.LocalLyricsSaveRequest;scope:dto.LocalLyricsScope;origin:LocalLyricsJobOrigin}>
  pending: null | {common:Omit<LyricsCommon,'eventId'>;firstOrdinal:number;parts:Uint8Array[];bytes:number}
}
export interface LocalLyricsJobOrigin {jobId:string;originalJobRequestSha256:string;library:dto.LocalLyricsLibraryRequest;watermark:string;phase:dto.LocalLyricsJobSnapshot['state']}
const lyricsInvalid = ():never => { throw new LocalLyricsError('CONFLICT') }
const lyricsIndexKey = (kind:LocalLyricsRecordKind,key:string):string => `${kind}:${key}`
const exact = (value:unknown,keys:readonly string[]):boolean => isLocalWorkbenchDataRecord(value,keys)
export function localLyricsRecordIdentity(kind:LocalLyricsRecordKind,value:LocalLyricsDurableRecord):{datasetId:string;key:string;revision:number;immutableHash:string;scope:LocalLyricsScope|null;pending:boolean} {
  if(kind==='save'){
    const r=value as LocalLyricsSaveRecord;assertLocalLyricsSaveRecord(r)
    return {datasetId:r.intent.scope.datasetId,key:r.intent.request.commandId,revision:r.revision,immutableHash:r.intent.fingerprint,scope:r.intent.scope,
      pending:!r.discarded && (!r.physicalClosed || r.receipt.state!=='complete' || r.receipt.snapshot==='failed' || r.receipt.snapshot==='pending')}
  }
  if(kind==='job'){
    const r=value as LocalLyricsJobRecord,s=r.snapshot
    if(!exact(r,['snapshot','embed','watermark','deadlineAtMs','enumerationComplete','entries']) || !exact(s,['jobId','library','state','totalAlbums','processedAlbums','savedAlbums','reviewAlbumIds','failedAlbumIds','unknownAlbumIds','sidecars','embedded','inspectionFailures','revision'])
      || !dto.isLocalLyricsLibraryRequest(s.library) || !dto.isLocalLyricsId(s.jobId) || !['queued','running','stopped','complete','partial','unknown','failed'].includes(s.state)
      || typeof r.embed!=='boolean' || typeof r.enumerationComplete!=='boolean' || !dto.isLocalLyricsId(r.watermark) || !Number.isFinite(r.deadlineAtMs)
      || ![s.totalAlbums,s.processedAlbums,s.savedAlbums,s.sidecars,s.embedded,s.inspectionFailures,s.revision].every(x=>integer(x,0,Number.MAX_SAFE_INTEGER))
      || !Array.isArray(r.entries) || r.entries.length>10000 || new Set(r.entries.map(x=>x.scope.albumId)).size!==r.entries.length
      || s.processedAlbums>s.totalAlbums || s.savedAlbums>s.processedAlbums || r.enumerationComplete && r.entries.length!==s.totalAlbums) return lyricsInvalid()
    for(const e of r.entries){
      if(!exact(e,['scope','state','saveRequest','sessionId','unresolved','sidecars','embedded']) || !dto.isLocalLyricsScope(e.scope) || e.scope.datasetId!==s.library.datasetId || e.scope.libraryId!==s.library.libraryId
        || !['pending','saved','review','failed','unknown'].includes(e.state) || ![null,'review','failed','unknown'].includes(e.unresolved)
        || !integer(e.sidecars,0,10000) || !integer(e.embedded,0,10000) || e.sessionId!==null&&!dto.isLocalLyricsId(e.sessionId)
        || e.saveRequest!==null&&(!dto.isLocalLyricsCommandPayload('localLyrics.save',e.saveRequest)||e.saveRequest.sessionId!==e.sessionId)) return lyricsInvalid()
    }
    for(const ids of [s.reviewAlbumIds,s.failedAlbumIds,s.unknownAlbumIds]) if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!r.entries.some(e=>e.scope.albumId===id)))return lyricsInvalid()
    return {datasetId:s.library.datasetId,key:s.jobId,revision:s.revision,immutableHash:lyricsDigest(lyricsCanonical([s.jobId,s.library,r.embed,r.watermark,r.deadlineAtMs])),scope:null,pending:false}
  }
  const r=value as LocalLyricsInventoryRecord
  if(!exact(r,['scope','captureFingerprint','revision','observations']) || !dto.isLocalLyricsScope(r.scope) || !hex(r.captureFingerprint) || !integer(r.revision,0,Number.MAX_SAFE_INTEGER)
    || !Array.isArray(r.observations) || r.observations.length>10000 || new Set(r.observations.map(x=>x.trackId)).size!==r.observations.length
    || r.observations.some(x=>!exact(x,['trackId','fileRevision','lrc','embedded'])||!dto.isCollectionId(x.trackId)||!dto.isLocalCatalogRevision(x.fileRevision)||!['unknown','false','true'].includes(x.lrc)||!['unknown','false','true'].includes(x.embedded))) return lyricsInvalid()
  return {datasetId:r.scope.datasetId,key:lyricsDigest(lyricsCanonical([r.scope.libraryId,r.scope.albumId])),revision:r.revision,immutableHash:'',scope:r.scope,pending:false}
}
export function isLocalLyricsJournalEvent(value:unknown):value is LocalLyricsJournalEvent {
  if(!isLocalWorkbenchDataRecord(value,['kind','datasetId','eventId','transactionId','recordKind','key','expectedRevision','revision','snapshotHash','bytes','chunks'],['index','payload','encoding','intentFingerprint','originalSnapshotHash'])
    || !dto.isCommandOutboxDatasetId(value.datasetId)||!dto.isCollectionId(value.eventId)||!dto.isCollectionId(value.transactionId)||!['save','job','inventory'].includes(String(value.recordKind))
    || !dto.isLocalLyricsId(value.key)||!integer(value.revision,0,Number.MAX_SAFE_INTEGER)||value.expectedRevision!==null&&!integer(value.expectedRevision,0,Number.MAX_SAFE_INTEGER-1)
    || value.revision!==(value.expectedRevision===null?0:Number(value.expectedRevision)+1)||!hex(value.snapshotHash)||!integer(value.bytes,1,LOCAL_WORKBENCH_SNAPSHOT_BYTES)
    || !integer(value.chunks,1,MAX_CHUNKS)||value.chunks!==Math.ceil(value.bytes/CHUNK_BYTES))return false
  if(Object.hasOwn(value,'encoding')){
    if(value.encoding!=='save-state-v1'||value.recordKind!=='save'||value.expectedRevision===null||!hex(value.intentFingerprint)||!hex(value.originalSnapshotHash))return false
  }else if(Object.hasOwn(value,'intentFingerprint')||Object.hasOwn(value,'originalSnapshotHash'))return false
  if(value.kind==='record-commit')return !Object.hasOwn(value,'index')&&!Object.hasOwn(value,'payload')
  if(value.kind!=='record-chunk'||!integer(value.index,0,Number(value.chunks)-1)||typeof value.payload!=='string'||value.payload.length>CHUNK_BYTES*4/3||/[^A-Za-z0-9+/=]/u.test(value.payload))return false
  const bytes=Buffer.from(value.payload,'base64')
  return bytes.toString('base64')===value.payload&&bytes.length===Math.min(CHUNK_BYTES,Number(value.bytes)-Number(value.index)*CHUNK_BYTES)
}
export function createLocalLyricsRecordEvents(kind:LocalLyricsRecordKind,record:LocalLyricsDurableRecord,expectedRevision:number|null):readonly LocalLyricsJournalEvent[]{
  const identity=localLyricsRecordIdentity(kind,record),bytes=Buffer.from(lyricsCanonical(record),'utf8')
  if(bytes.length===0||bytes.length>LOCAL_WORKBENCH_SNAPSHOT_BYTES||identity.revision!==(expectedRevision===null?0:expectedRevision+1))return lyricsInvalid()
  const shared={...identity,transactionId:randomUUID(),expectedRevision,snapshotHash:hash(bytes),bytes:bytes.length,chunks:Math.ceil(bytes.length/CHUNK_BYTES),recordKind:kind}
  const {immutableHash:_immutable,scope:_scope,pending:_pending,...fields}=shared,events:LocalLyricsJournalEvent[]=[]
  for(let index=0;index<fields.chunks;index++)events.push({...fields,eventId:randomUUID(),kind:'record-chunk',index,payload:bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES).toString('base64')})
  events.push({...fields,eventId:randomUUID(),kind:'record-commit'})
  if(!events.every(isLocalLyricsJournalEvent))return lyricsInvalid()
  return events
}
export function emptyLocalLyricsJournalProjection(datasetId:string):LocalLyricsJournalProjection{
  if(!dto.isCommandOutboxDatasetId(datasetId))return lyricsInvalid()
  return {datasetId,highWater:0,latest:new Map(),inventory:new Map(),jobOrigins:new Map(),pending:null}
}
/** 全部历史逐事件审；只保小索引/本地presence事实，不在热投影复制所有正文。 */
export function projectLocalLyricsJournalEvent(p:LocalLyricsJournalProjection,event:LocalLyricsJournalEvent,ordinal:number):LocalLyricsDurableRecord|null{
  if(!isLocalLyricsJournalEvent(event)||event.datasetId!==p.datasetId||!integer(ordinal,1,Number.MAX_SAFE_INTEGER)||ordinal<=p.highWater)return lyricsInvalid()
  const previous=p.latest.get(lyricsIndexKey(event.recordKind,event.key))
  if((previous?.revision??null)!==event.expectedRevision)return lyricsInvalid()
  const {kind:_kind,...commonWithPayload}=event
  const {eventId:_event,index:_index,payload:_payload,...common}=commonWithPayload as LyricsCommon&{index?:number;payload?:string}
  if(event.kind==='record-chunk'){
    if(event.index===0){if(p.pending)return lyricsInvalid();p.pending={common,firstOrdinal:ordinal,parts:[],bytes:0}}
    const held=p.pending
    if(!held||lyricsCanonical(held.common)!==lyricsCanonical(common)||event.index!==held.parts.length)return lyricsInvalid()
    const bytes=new Uint8Array(Buffer.from(event.payload,'base64'));held.parts.push(bytes);held.bytes+=bytes.length;p.highWater=ordinal;return null
  }
  const held=p.pending
  if(!held||lyricsCanonical(held.common)!==lyricsCanonical(common)||held.parts.length!==event.chunks||held.bytes!==event.bytes)return lyricsInvalid()
  const bytes=Buffer.concat(held.parts.map(x=>Buffer.from(x)),held.bytes)
  if(hash(bytes)!==event.snapshotHash)return lyricsInvalid()
  let decoded:unknown
  try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{return lyricsInvalid()}
  if(lyricsCanonical(decoded)!==bytes.toString('utf8'))return lyricsInvalid()
  let identity:ReturnType<typeof localLyricsRecordIdentity>,saveState:LocalLyricsMutableState|null=null,intentSource:LocalLyricsFullRecordPin|null=null
  if(event.encoding==='save-state-v1'){
    if(!previous?.saveState||!previous.intentSource||event.intentFingerprint!==previous.immutableHash||event.originalSnapshotHash!==previous.intentSource.snapshotHash)return lyricsInvalid()
    saveState=applyLocalLyricsStateDelta(previous,decoded)
    identity={datasetId:event.datasetId,key:event.key,revision:event.revision,immutableHash:previous.immutableHash,scope:previous.scope,
      pending:!saveState.discarded&&(!saveState.physicalClosed||saveState.receipt.state!=='complete'||saveState.receipt.snapshot==='failed'||saveState.receipt.snapshot==='pending')}
    intentSource=previous.intentSource
  }else{
    identity=localLyricsRecordIdentity(event.recordKind,decoded as LocalLyricsDurableRecord)
    if(event.recordKind==='save'){
      const value=decoded as LocalLyricsSaveRecord
      saveState={receipt:structuredClone(value.receipt),physicalClosed:value.physicalClosed,discarded:value.discarded}
      intentSource=previous?.intentSource??null
    }
  }
  if(identity.datasetId!==event.datasetId||identity.key!==event.key||identity.revision!==event.revision
    ||previous&&event.recordKind!=='inventory'&&previous.immutableHash!==identity.immutableHash)return lyricsInvalid()
  const fullPin:LocalLyricsFullRecordPin={...identity,recordKind:event.recordKind,transactionId:event.transactionId,firstOrdinal:held.firstOrdinal,lastOrdinal:ordinal,chunks:event.chunks,bytes:event.bytes,snapshotHash:event.snapshotHash}
  if(event.recordKind==='save'&&intentSource===null)intentSource=fullPin
  const index:LocalLyricsRecordIndex={...fullPin,intentSource,saveState}
  if(event.recordKind==='save'&&event.expectedRevision===null&&[...p.latest.values()].some(x=>x.recordKind==='save'&&x.pending&&x.scope&&identity.scope&&x.scope.datasetId===identity.scope.datasetId&&x.scope.libraryId===identity.scope.libraryId&&x.scope.albumId===identity.scope.albumId))return lyricsInvalid()
  p.latest.set(lyricsIndexKey(event.recordKind,event.key),index)
  if(event.recordKind==='job'){
    const job=decoded as LocalLyricsJobRecord,origin:LocalLyricsJobOrigin={jobId:job.snapshot.jobId,originalJobRequestSha256:lyricsDigest(lyricsCanonical({commandId:job.snapshot.jobId,library:job.snapshot.library,embed:job.embed})),library:job.snapshot.library,watermark:job.watermark,phase:job.snapshot.state};
    const entries=job.entries.filter(e=>e.saveRequest!==null);
    for(const e of entries){const old=p.jobOrigins.get(e.saveRequest!.commandId);if(old&&(old.origin.jobId!==origin.jobId||lyricsCanonical(old.request)!==lyricsCanonical(e.saveRequest)||lyricsCanonical(old.scope)!==lyricsCanonical(e.scope)))return lyricsInvalid();}
    for(const [key,value] of p.jobOrigins)if(value.origin.jobId===job.snapshot.jobId)p.jobOrigins.delete(key);
    for(const e of entries)p.jobOrigins.set(e.saveRequest!.commandId,{request:structuredClone(e.saveRequest!),scope:structuredClone(e.scope),origin:structuredClone(origin)});
  }
  if(event.recordKind==='inventory')for(const row of (decoded as LocalLyricsInventoryRecord).observations)p.inventory.set(row.trackId,{rootId:(decoded as LocalLyricsInventoryRecord).scope.libraryId,fileRevision:row.fileRevision,lrc:row.lrc,embedded:row.embedded,presence:lyricsPresence(row.lrc,row.embedded)})
  p.pending=null;p.highWater=ordinal
  // delta已完整验证并投影；不是完整intent DTO，避免伪造省略正文的record。
  return event.encoding==='save-state-v1'?null:decoded as LocalLyricsDurableRecord
}
export function assertLocalLyricsJournalComplete(p:LocalLyricsJournalProjection):void{if(p.pending)return lyricsInvalid()}
export function localLyricsJournalLedgerRow(event:LocalLyricsJournalEvent):Record<string,string>{
  if(!isLocalLyricsJournalEvent(event))return lyricsInvalid()
  const request=lyricsCanonical(event),fingerprint=hash(request),row={command_id:event.eventId,operation:LOCAL_LYRICS_JOURNAL_OPERATION,fingerprint,request,result:lyricsCanonical({eventId:event.eventId,eventHash:fingerprint}),created_at:new Date().toISOString()}
  if(Object.values(row).reduce((n,x)=>n+Buffer.byteLength(x),0)>64*1024)return lyricsInvalid()
  return row
}
export function readLocalLyricsJournalEvent(row:Record<string,unknown>):LocalLyricsJournalEvent{
  if(row.operation!==LOCAL_LYRICS_JOURNAL_OPERATION||typeof row.request!=='string'||typeof row.result!=='string'||Buffer.byteLength(row.request)>64*1024||Buffer.byteLength(row.result)>64*1024
    ||typeof row.created_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.created_at)||!Number.isFinite(Date.parse(row.created_at)))return lyricsInvalid()
  let event:unknown,result:unknown;try{event=JSON.parse(row.request);result=JSON.parse(row.result)}catch{return lyricsInvalid()}
  if(!isLocalLyricsJournalEvent(event)||event.eventId!==row.command_id||lyricsCanonical(event)!==row.request||hash(row.request)!==row.fingerprint
    ||!isLocalWorkbenchDataRecord(result,['eventId','eventHash'])||result.eventId!==event.eventId||result.eventHash!==row.fingerprint)return lyricsInvalid()
  return event
}
export interface LocalLyricsOwnerJournalPort {
  privateLyricsRecord(datasetId:string,kind:LocalLyricsRecordKind,key:string):LocalLyricsDurableRecord|null
  privateLyricsPending(datasetId:string,scope:LocalLyricsScope):readonly LocalLyricsSaveRecord[]
  privateLyricsCompareAndSwap(datasetId:string,kind:LocalLyricsRecordKind,record:LocalLyricsDurableRecord,expectedRevision:number|null):void
  privateLyricsInventoryRevision(datasetId:string):string
  privateLyricsInventoryRead(datasetId:string,trackId:string,rootId:string,fileRevision:string):dto.LocalLyricsPresence
}
/** 第九SQL仅回调原journal事实；源在线/Root修订仍由原SQL scope屏障核验。 */
export function createLocalLyricsAlbumInventory(datasetId:string,catalog:LocalLyricsOwnerJournalPort):LocalAlbumLyricsInventory{
  return {revision:()=>catalog.privateLyricsInventoryRevision(datasetId),read:(trackId,rootId,fileRevision)=>catalog.privateLyricsInventoryRead(datasetId,trackId,rootId,fileRevision)}
}


function applyLocalLyricsStateDelta(previous:LocalLyricsRecordIndex,value:unknown):LocalLyricsMutableState{
  if(!isLocalWorkbenchDataRecord(value,['schemaVersion','commandId','sessionId','intentFingerprint','revision','header','changes'])||value.schemaVersion!==1
    ||value.commandId!==previous.key||value.sessionId!==previous.saveState?.receipt.sessionId||value.intentFingerprint!==previous.immutableHash||value.revision!==previous.revision+1
    ||!isLocalWorkbenchDataRecord(value.header,['state','cover','snapshot','physicalClosed','discarded'])||!Array.isArray(value.changes)||value.changes.length>previous.saveState!.receipt.tracks.length)return lyricsInvalid()
  const h=value.header,states=['not-requested','pending','saved','existing','failed','unknown','cancelled']
  if(!['running','complete','partial','unknown','cancelled','failed'].includes(String(h.state))||!states.includes(String(h.cover))||!['not-requested','pending','saved','failed'].includes(String(h.snapshot))||typeof h.physicalClosed!=='boolean'||typeof h.discarded!=='boolean')return lyricsInvalid()
  const receipt=structuredClone(previous.saveState!.receipt),seen=new Set<number>(),tracks=[...previous.saveState!.receipt.tracks]
  for(const change of value.changes){
    if(!isLocalWorkbenchDataRecord(change,['index','trackId','lrc','embed'])||!integer(change.index,0,receipt.tracks.length-1)||seen.has(change.index)
      ||change.trackId!==receipt.tracks[change.index]!.trackId||!states.includes(String(change.lrc))||!states.includes(String(change.embed)))return lyricsInvalid()
    seen.add(change.index)
    if(receipt.tracks[change.index]!.embed==='not-requested'&&change.embed!=='not-requested')return lyricsInvalid()
    tracks[change.index]={trackId:change.trackId as string,lrc:change.lrc as dto.LocalLyricsWriteState,embed:change.embed as dto.LocalLyricsWriteState};receipt.tracks=tracks
  }
  receipt.tracks=tracks
  receipt.state=h.state as dto.LocalLyricsSaveReceipt['state'];receipt.cover=h.cover as dto.LocalLyricsWriteState;receipt.snapshot=h.snapshot as dto.LocalLyricsSaveReceipt['snapshot']
  if(h.discarded&&(!h.physicalClosed||['running','unknown'].includes(receipt.state)))return lyricsInvalid()
  // 快照失败是独立恢复域；正文已成功且物理关闭的回执仍可complete，pending索引继续阻同album新原id。
  if(receipt.state==='complete'&&(!h.physicalClosed||!['saved','existing','not-requested'].includes(receipt.cover)||receipt.tracks.some(t=>!['saved','existing'].includes(t.lrc)||!['saved','existing','not-requested'].includes(t.embed))))return lyricsInvalid()
  return {receipt,physicalClosed:h.physicalClosed,discarded:h.discarded}
}
export function createLocalLyricsStateEvents(record:LocalLyricsSaveRecord,previous:LocalLyricsRecordIndex):readonly LocalLyricsJournalEvent[]{
  assertLocalLyricsSaveRecord(record)
  if(previous.recordKind!=='save'||!previous.saveState||!previous.intentSource||previous.key!==record.intent.request.commandId||previous.immutableHash!==record.intent.fingerprint||previous.revision+1!==record.revision
    ||previous.saveState.receipt.tracks.length!==record.receipt.tracks.length)return lyricsInvalid()
  const changes:LocalLyricsStateDelta['changes'][number][]=[]
  for(const [index,track]of record.receipt.tracks.entries()){
    const old=previous.saveState.receipt.tracks[index]!
    if(track.trackId!==old.trackId)return lyricsInvalid()
    if(track.lrc!==old.lrc||track.embed!==old.embed)changes.push({index,trackId:track.trackId,lrc:track.lrc,embed:track.embed})
  }
  const value:LocalLyricsStateDelta={schemaVersion:1,commandId:record.intent.request.commandId,sessionId:record.intent.request.sessionId,intentFingerprint:record.intent.fingerprint,revision:record.revision,
    header:{state:record.receipt.state,cover:record.receipt.cover,snapshot:record.receipt.snapshot,physicalClosed:record.physicalClosed,discarded:record.discarded},changes}
  const applied=applyLocalLyricsStateDelta(previous,value)
  if(lyricsCanonical(applied)!==lyricsCanonical({receipt:record.receipt,physicalClosed:record.physicalClosed,discarded:record.discarded}))return lyricsInvalid()
  const bytes=Buffer.from(lyricsCanonical(value),'utf8')
  if(bytes.length===0||bytes.length>LOCAL_WORKBENCH_SNAPSHOT_BYTES)return lyricsInvalid()
  const fields={datasetId:record.intent.scope.datasetId,recordKind:'save' as const,key:record.intent.request.commandId,transactionId:randomUUID(),expectedRevision:previous.revision,revision:record.revision,
    snapshotHash:hash(bytes),bytes:bytes.length,chunks:Math.ceil(bytes.length/CHUNK_BYTES),encoding:'save-state-v1' as const,intentFingerprint:record.intent.fingerprint,originalSnapshotHash:previous.intentSource.snapshotHash}
  const events:LocalLyricsJournalEvent[]=[]
  for(let index=0;index<fields.chunks;index++)events.push({...fields,eventId:randomUUID(),kind:'record-chunk',index,payload:bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES).toString('base64')})
  events.push({...fields,eventId:randomUUID(),kind:'record-commit'})
  if(!events.every(isLocalLyricsJournalEvent))return lyricsInvalid()
  return events
}


/** CUE/扫描设置只占原ledger两个固定operation，不能扩成任意持久domain。 */
export interface LocalCueOwnerProjection { datasetId:string; highWater:number; output:LocalCueOutputProjection }
export function emptyLocalCueOwnerProjection(datasetId:string):LocalCueOwnerProjection{
  if(!dto.isCommandOutboxDatasetId(datasetId))return invalid()
  return {datasetId,highWater:0,output:{latest:new Map(),pending:null}}
}
export function copyLocalCueOwnerProjection(value:LocalCueOwnerProjection):LocalCueOwnerProjection{
  assertLocalCueOwnerComplete(value)
  return {...value,output:{latest:new Map(value.output.latest),pending:null}}
}
export function projectLocalCueOwnerEvent(value:LocalCueOwnerProjection,event:LocalCueOutputEvent,sequence:number):void{
  if(event.datasetId!==value.datasetId||!integer(sequence,1,Number.MAX_SAFE_INTEGER)||sequence<=value.highWater)return invalid()
  projectLocalCueOutputEvent(value.output,event,sequence);value.highWater=sequence
}
export function assertLocalCueOwnerComplete(value:LocalCueOwnerProjection):void{if(value.output.pending)return invalid()}
export function localCueOwnerLedgerRow(event:LocalCueOutputEvent):Record<string,string>{
  if(!isLocalCueOutputEvent(event))return invalid()
  const request=cueOutputCanonical(event),fingerprint=hash(request)
  const row={command_id:event.eventId,operation:LOCAL_CUE_OUTPUT_OPERATION,fingerprint,request,result:cueOutputCanonical({eventId:event.eventId,eventHash:fingerprint}),created_at:new Date().toISOString()}
  if(Object.values(row).reduce((n,item)=>n+Buffer.byteLength(item),0)>64*1024)return invalid()
  return row
}
export function readLocalCueOwnerEvent(row:Record<string,unknown>):LocalCueOutputEvent{
  if(row.operation!==LOCAL_CUE_OUTPUT_OPERATION||!dto.isCollectionId(row.command_id)||!hex(row.fingerprint)||typeof row.request!=='string'||typeof row.result!=='string'
    ||Buffer.byteLength(row.request)>64*1024||Buffer.byteLength(row.result)>64*1024||!ownerLedgerTime(row.created_at))return invalid()
  let event:unknown,result:unknown;try{event=JSON.parse(row.request);result=JSON.parse(row.result)}catch{return invalid()}
  if(!isLocalCueOutputEvent(event)||event.eventId!==row.command_id||cueOutputCanonical(event)!==row.request||hash(row.request)!==row.fingerprint
    ||!isLocalWorkbenchDataRecord(result,['eventId','eventHash'])||result.eventId!==event.eventId||result.eventHash!==row.fingerprint)return invalid()
  return event
}
const ownerLedgerTime=(value:unknown):boolean=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)&&Number.isFinite(Date.parse(value))
export interface LocalScanSettingsOwnerProjection {
  datasetId:string;highWater:number;settings:LocalScanSettings
  commands:Map<string,{event:LocalScanSettingsEvent;result:LocalScanSettings|LocalScanFrozenSettings}>
  jobs:Map<string,LocalScanFrozenSettings>
}
export function emptyLocalScanSettingsOwnerProjection(datasetId:string):LocalScanSettingsOwnerProjection{
  if(!dto.isCommandOutboxDatasetId(datasetId))return invalid()
  return {datasetId,highWater:0,settings:{...LOCAL_SCAN_DEFAULT_SETTINGS},commands:new Map(),jobs:new Map()}
}
export function copyLocalScanSettingsOwnerProjection(value:LocalScanSettingsOwnerProjection):LocalScanSettingsOwnerProjection{
  return {...value,settings:{...value.settings},commands:new Map(value.commands),jobs:new Map(value.jobs)}
}
export function localScanSettingsOwnerOriginal(value:LocalScanSettingsOwnerProjection,event:LocalScanSettingsEvent):LocalScanSettings|LocalScanFrozenSettings|null{
  const prior=value.commands.get(event.commandId)
  if(!prior)return null
  if(localScanSettingsFingerprint(prior.event)!==localScanSettingsFingerprint(event))return invalid()
  return structuredClone(prior.result)
}
export function projectLocalScanSettingsOwnerEvent(value:LocalScanSettingsOwnerProjection,event:LocalScanSettingsEvent,sequence:number):void{
  if(!isLocalScanSettingsEvent(event)||event.datasetId!==value.datasetId||!integer(sequence,1,Number.MAX_SAFE_INTEGER)||sequence<=value.highWater||value.commands.has(event.commandId))return invalid()
  let result:LocalScanSettings|LocalScanFrozenSettings
  if(event.kind==='settings'){
    if(event.expectedRevision!==value.settings.revision)return invalid()
    result=structuredClone(event.settings);value.settings=result
  }else{
    if(value.jobs.has(event.frozen.jobId)||event.frozen.settingsRevision!==value.settings.revision||event.frozen.albumConcurrency!==value.settings.albumConcurrency||event.frozen.readerConcurrency!==1)return invalid()
    result=structuredClone(event.frozen);value.jobs.set(event.frozen.jobId,result)
  }
  value.commands.set(event.commandId,{event:structuredClone(event),result});value.highWater=sequence
}
export function localScanSettingsOwnerLedgerRow(event:LocalScanSettingsEvent):Record<string,string>{
  if(!isLocalScanSettingsEvent(event))return invalid()
  // 原protocol的fingerprint明确绑定JSON.stringify原字节，不另造canonical协议。
  const request=JSON.stringify(event),fingerprint=localScanSettingsFingerprint(event)
  const row={command_id:event.eventId,operation:LOCAL_SCAN_SETTINGS_OPERATION,fingerprint,request,result:JSON.stringify({eventId:event.eventId,eventHash:fingerprint}),created_at:new Date().toISOString()}
  if(Object.values(row).reduce((n,item)=>n+Buffer.byteLength(item),0)>64*1024)return invalid()
  return row
}
export function readLocalScanSettingsOwnerEvent(row:Record<string,unknown>):LocalScanSettingsEvent{
  if(row.operation!==LOCAL_SCAN_SETTINGS_OPERATION||!dto.isCollectionId(row.command_id)||!hex(row.fingerprint)||typeof row.request!=='string'||typeof row.result!=='string'
    ||Buffer.byteLength(row.request)>64*1024||Buffer.byteLength(row.result)>64*1024||!ownerLedgerTime(row.created_at))return invalid()
  let event:unknown,result:unknown;try{event=JSON.parse(row.request);result=JSON.parse(row.result)}catch{return invalid()}
  if(!isLocalScanSettingsEvent(event)||event.eventId!==row.command_id||JSON.stringify(event)!==row.request||localScanSettingsFingerprint(event)!==row.fingerprint
    ||!isLocalWorkbenchDataRecord(result,['eventId','eventHash'])||result.eventId!==event.eventId||result.eventHash!==row.fingerprint)return invalid()
  return event
}


/** 只对已持久MB_ONLY计划作一次完整原子结算，独立于原registry/lyrics/CUE帧。 */
export const LOCAL_WORKBENCH_MB_ONLY_OPERATION='local-workbench-mb-only-v1'
export type LocalWorkbenchMBNameSources={artistName:'raw'|'manual'|'workbench-ai'|'unknown';albumName:'raw'|'manual'|'workbench-ai'|'unknown'}
export interface LocalWorkbenchMBOnlyMutation {commandId:string;operation:'override-metadata'|'create-edition'|'link-edition-track';sequence:string;request:Record<string,unknown>;result:dto.LocalCatalogResult}
export interface LocalWorkbenchMBOnlyRecord {
  schema:1;request:dto.LocalWorkbenchApplyRequest;plan:dto.LocalWorkbenchPlan;capture:LocalWorkbenchPlanCapture
  origin:'Human'|'AI'|'Artwork'|'Unknown';receipt:dto.LocalWorkbenchReceipt
  mutations:readonly LocalWorkbenchMBOnlyMutation[]
  editionUpdates:readonly {before:dto.AlbumEdition;after:dto.AlbumEdition}[]
  artwork:readonly {albumId:string;editionId:string;commandId:string;selection:dto.LocalArtworkSelection}[]
  provenance:readonly {trackId:string;commandId:string;revision:string;fields:dto.LocalMetadata;sources:LocalWorkbenchMBNameSources}[]
}
const mbFail=():never=>{throw new LocalWorkbenchPlanError('PERSISTENCE_FAILED','MB整组原命令或完整持久事实不一致，现有事实保留。')}
export function isLocalWorkbenchMBOnlyRecord(value:unknown):value is LocalWorkbenchMBOnlyRecord{
  if(!isLocalWorkbenchDataRecord(value,['schema','request','plan','capture','origin','receipt','mutations','editionUpdates','artwork','provenance'])||value.schema!==1
    ||!dto.isLocalWorkbenchApplyRequest(value.request)||!dto.isLocalWorkbenchPlan(value.plan)||value.plan.kind==='cue'||value.plan.scope!=='MB_ONLY'
    ||!isLocalWorkbenchPlanCapture(value.capture)||!dto.isLocalWorkbenchReceipt(value.receipt,value.request,value.plan)
    ||(typeof value.origin!=='string'||!['Human','AI','Artwork','Unknown'].includes(value.origin))||!['succeeded','failed'].includes(value.receipt.state)
    ||!isLocalWorkbenchDenseArray(value.mutations,10100)||!isLocalWorkbenchDenseArray(value.editionUpdates,100)||!isLocalWorkbenchDenseArray(value.artwork,100)||!isLocalWorkbenchDenseArray(value.provenance,10000))return false
  try{assertLocalWorkbenchCapturedPlan(value.plan,value.capture)}catch{return false}
  if(value.request.planId!==value.plan.planId||value.request.datasetId!==value.plan.datasetId||value.request.planHash!==value.plan.planHash||value.request.kind!==value.plan.kind
    ||value.request.expectedRevision!==value.plan.revision||value.request.contextFingerprint!==value.plan.contextFingerprint
    ||hash(localWorkbenchJournalCanonical(value.capture))!==value.plan.contextFingerprint)return false
  const {planHash:_hash,...body}=value.plan;if(hash(localWorkbenchJournalCanonical(body))!==value.plan.planHash)return false
  if(value.receipt.state==='failed')return value.mutations.length===0&&value.editionUpdates.length===0&&value.artwork.length===0&&value.provenance.length===0&&Buffer.byteLength(localWorkbenchJournalCanonical(value))<=LOCAL_WORKBENCH_SNAPSHOT_BYTES
  if(value.origin==='Unknown'||value.plan.kind==='ai'&&!['Human','AI'].includes(value.origin as string)||value.plan.kind==='artwork'&&value.origin!=='Artwork')return false
  if(!value.mutations.every(m=>isLocalWorkbenchDataRecord(m,['commandId','operation','sequence','request','result'])&&dto.isCollectionId(m.commandId)&&dto.isLocalCatalogRevision(m.sequence)
    &&typeof m.operation==='string'&&['override-metadata','create-edition','link-edition-track'].includes(m.operation)&&isLocalWorkbenchDataRecord(m.request,[],['commandId','trackId','expectedRevision','fields','annotations','title','edition','editionId','disc','trackNumber','sequence'])&&dto.isLocalCatalogResult(m.operation as dto.LocalCatalogOperation,m.result))
    ||new Set(value.mutations.map(m=>(m as LocalWorkbenchMBOnlyMutation).commandId)).size!==value.mutations.length)return false
  if(!value.editionUpdates.every(e=>isLocalWorkbenchDataRecord(e,['before','after'])&&dto.isAlbumEdition(e.before)&&dto.isAlbumEdition(e.after)&&e.before.id===e.after.id&&e.before.edition===e.after.edition&&BigInt(e.after.revision)===BigInt(e.before.revision)+1n))return false
  if(!value.artwork.every(a=>isLocalWorkbenchDataRecord(a,['albumId','editionId','commandId','selection'])&&dto.isLocalWorkbenchIdentity(a.albumId)&&dto.isCollectionId(a.editionId)&&dto.isCollectionId(a.commandId)&&dto.isLocalArtworkSelection(a.selection)&&a.selection.editionId===a.editionId))return false
  if(!value.provenance.every(p=>isLocalWorkbenchDataRecord(p,['trackId','commandId','revision','fields','sources'])&&dto.isCollectionId(p.trackId)&&dto.isCollectionId(p.commandId)&&dto.isLocalCatalogRevision(p.revision)&&dto.isLocalMetadata(p.fields)
    &&isLocalWorkbenchDataRecord(p.sources,['artistName','albumName'])&&Object.values(p.sources).every(s=>typeof s==='string'&&['raw','manual','workbench-ai','unknown'].includes(s))))return false
  const tracks=value.capture.albums.flatMap(a=>a.members.map(m=>m.trackId));if(tracks.length>10000||tracks.some(id=>id===null)||new Set(tracks).size!==tracks.length)return false
  if(value.plan.kind==='ai'&&(value.provenance.length!==tracks.length||new Set(value.provenance.map(p=>(p as {trackId:string}).trackId)).size!==tracks.length||value.provenance.some(p=>!tracks.includes((p as {trackId:string}).trackId))||value.artwork.length||value.mutations.length!==tracks.length||value.mutations.some(m=>(m as LocalWorkbenchMBOnlyMutation).operation!=='override-metadata')))return false
  if(new Set(value.editionUpdates.map(e=>(e as {before:dto.AlbumEdition}).before.id)).size!==value.editionUpdates.length||value.plan.kind!=='ai'&&value.editionUpdates.length)return false
  if(value.plan.kind==='ai'){const plan=value.plan as Extract<dto.LocalWorkbenchPlan,{kind:'ai'}>;for(const p of value.provenance as LocalWorkbenchMBOnlyRecord['provenance']){const album=value.capture.albums.find(album=>album.members.some(member=>member.trackId===p.trackId))!,item=plan.items.find(item=>item.albumId===album.albumId)!;for(const change of item.changes)if(change.after!==change.before&&(p.fields[change.field as 'artist'|'album']!==change.after||p.sources[change.field==='artist'?'artistName':'albumName']!==(value.origin==='Human'?'manual':'workbench-ai')))return false}
    for(const update of value.editionUpdates as LocalWorkbenchMBOnlyRecord['editionUpdates'])if(update.before.title===update.after.title||!value.capture.albums.some(album=>album.editionId===update.before.id&&plan.items.some(item=>item.albumId===album.albumId&&item.changes.some(change=>change.field==='album'&&change.after!==change.before&&change.after===update.after.title))))return false}
  if(value.plan.kind==='artwork'&&(value.provenance.length||value.artwork.length!==value.capture.albums.length))return false
  return Buffer.byteLength(localWorkbenchJournalCanonical(value))<=LOCAL_WORKBENCH_SNAPSHOT_BYTES
}
interface MBCommon {datasetId:string;eventId:string;transactionId:string;commandId:string;bytes:number;chunks:number;snapshotHash:string}
export type LocalWorkbenchMBOnlyEvent=MBCommon&({kind:'chunk';index:number;payload:string}|{kind:'commit'})
export interface LocalWorkbenchMBOnlyProjection {datasetId:string;highWater:number;latest:Map<string,{record:LocalWorkbenchMBOnlyRecord;ledgerSequence:string}>;provenance:Map<string,LocalWorkbenchMBOnlyRecord['provenance'][number]>;pending:null|{common:Omit<MBCommon,'eventId'>;parts:Buffer[]}}
export function emptyLocalWorkbenchMBOnlyProjection(datasetId:string):LocalWorkbenchMBOnlyProjection{if(!dto.isCommandOutboxDatasetId(datasetId))return mbFail();return {datasetId,highWater:0,latest:new Map(),provenance:new Map(),pending:null}}
export function copyLocalWorkbenchMBOnlyProjection(p:LocalWorkbenchMBOnlyProjection):LocalWorkbenchMBOnlyProjection{assertLocalWorkbenchMBOnlyComplete(p);return {...p,latest:new Map(p.latest),provenance:new Map(p.provenance),pending:null}}
export function isLocalWorkbenchMBOnlyEvent(value:unknown):value is LocalWorkbenchMBOnlyEvent{
  if(!isLocalWorkbenchDataRecord(value,['datasetId','eventId','transactionId','commandId','bytes','chunks','snapshotHash','kind'],['index','payload'])||![value.datasetId,value.eventId,value.transactionId,value.commandId].every(dto.isCollectionId)
    ||!integer(value.bytes,1,LOCAL_WORKBENCH_SNAPSHOT_BYTES)||value.chunks!==Math.ceil(Number(value.bytes)/CHUNK_BYTES)||!hex(value.snapshotHash))return false
  if(value.kind==='commit')return !Object.hasOwn(value,'index')&&!Object.hasOwn(value,'payload')
  if(value.kind!=='chunk'||!integer(value.index,0,Number(value.chunks)-1)||typeof value.payload!=='string'||value.payload.length>CHUNK_BYTES*4/3||/[^A-Za-z0-9+/=]/u.test(value.payload))return false
  const b=Buffer.from(value.payload,'base64');return b.toString('base64')===value.payload&&b.length===Math.min(CHUNK_BYTES,Number(value.bytes)-Number(value.index)*CHUNK_BYTES)
}
export function createLocalWorkbenchMBOnlyEvents(record:LocalWorkbenchMBOnlyRecord):readonly LocalWorkbenchMBOnlyEvent[]{
  if(!isLocalWorkbenchMBOnlyRecord(record))return mbFail();const bytes=Buffer.from(localWorkbenchJournalCanonical(record)),shared={datasetId:record.request.datasetId,transactionId:randomUUID(),commandId:record.request.commandId,bytes:bytes.length,chunks:Math.ceil(bytes.length/CHUNK_BYTES),snapshotHash:hash(bytes)}
  const events:LocalWorkbenchMBOnlyEvent[]=[];for(let index=0;index<shared.chunks;index++)events.push({...shared,eventId:randomUUID(),kind:'chunk',index,payload:bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES).toString('base64')});events.push({...shared,eventId:randomUUID(),kind:'commit'});return events
}
export function projectLocalWorkbenchMBOnlyEvent(p:LocalWorkbenchMBOnlyProjection,e:LocalWorkbenchMBOnlyEvent,sequence:number):LocalWorkbenchMBOnlyRecord|null{
  if(!isLocalWorkbenchMBOnlyEvent(e)||e.datasetId!==p.datasetId||!integer(sequence,1,Number.MAX_SAFE_INTEGER)||sequence<=p.highWater||p.latest.has(e.commandId))return mbFail()
  const {eventId:_event,kind:_kind,...fields}=e;const {index:_index,payload:_payload,...common}=fields as MBCommon&{index?:number;payload?:string}
  if(e.kind==='chunk'){if(e.index===0){if(p.pending)return mbFail();p.pending={common,parts:[]}}
    if(!p.pending||localWorkbenchJournalCanonical(p.pending.common)!==localWorkbenchJournalCanonical(common)||p.pending.parts.length!==e.index)return mbFail();p.pending.parts.push(Buffer.from(e.payload,'base64'));p.highWater=sequence;return null}
  if(!p.pending||localWorkbenchJournalCanonical(p.pending.common)!==localWorkbenchJournalCanonical(common)||p.pending.parts.length!==e.chunks)return mbFail()
  const raw=Buffer.concat(p.pending.parts);if(raw.length!==e.bytes||hash(raw)!==e.snapshotHash)return mbFail();let record:unknown;try{record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))}catch{return mbFail()}
  if(!isLocalWorkbenchMBOnlyRecord(record)||record.request.datasetId!==p.datasetId||record.request.commandId!==e.commandId||localWorkbenchJournalCanonical(record)!==raw.toString('utf8'))return mbFail()
  p.latest.set(e.commandId,{record,ledgerSequence:String(sequence)});for(const source of record.provenance)p.provenance.set(source.trackId,source);if(p.provenance.size>300000)return mbFail();p.pending=null;p.highWater=sequence;return record
}
export function assertLocalWorkbenchMBOnlyComplete(p:LocalWorkbenchMBOnlyProjection):void{if(p.pending)return mbFail()}
export function localWorkbenchMBOnlyLedgerRow(e:LocalWorkbenchMBOnlyEvent):Record<string,string>{
  if(!isLocalWorkbenchMBOnlyEvent(e))return mbFail();const request=localWorkbenchJournalCanonical(e),fingerprint=hash(request),row={command_id:e.eventId,operation:LOCAL_WORKBENCH_MB_ONLY_OPERATION,fingerprint,request,result:localWorkbenchJournalCanonical({eventId:e.eventId,eventHash:fingerprint}),created_at:new Date().toISOString()};if(Object.values(row).reduce((n,s)=>n+Buffer.byteLength(s),0)>64*1024)return mbFail();return row
}
export function readLocalWorkbenchMBOnlyEvent(row:Record<string,unknown>):LocalWorkbenchMBOnlyEvent{
  if(row.operation!==LOCAL_WORKBENCH_MB_ONLY_OPERATION||typeof row.request!=='string'||typeof row.result!=='string'||Buffer.byteLength(row.request)>64*1024||Buffer.byteLength(row.result)>64*1024||!ownerLedgerTime(row.created_at))return mbFail()
  let e:unknown,result:unknown;try{e=JSON.parse(row.request);result=JSON.parse(row.result)}catch{return mbFail()}
  if(!isLocalWorkbenchMBOnlyEvent(e)||e.eventId!==row.command_id||localWorkbenchJournalCanonical(e)!==row.request||hash(row.request)!==row.fingerprint||!isLocalWorkbenchDataRecord(result,['eventId','eventHash'])||result.eventId!==e.eventId||result.eventHash!==row.fingerprint)return mbFail();return e
}


/** Library管理只使用同Owner账本的四种有限记录；捕获正文不是路径或写许可。 */
export const LOCAL_LIBRARY_MANAGEMENT_OPERATION = 'local-library-management-v1'
export const LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES = 40 * 1024
export const LOCAL_LIBRARY_MANAGEMENT_BYTES = 32 * 1024 * 1024
export const LOCAL_LIBRARY_MANAGEMENT_RESOURCES = 10000
export const LOCAL_LIBRARY_MANAGEMENT_MUTATIONS = [
  'library.import.confirm', 'library.rename', 'library.remove', 'library.snapshot.load',
  'library.snapshot.retry', 'library.settings.save', 'library.watch.set',
] as const
export type LocalLibraryManagementMutation = typeof LOCAL_LIBRARY_MANAGEMENT_MUTATIONS[number]
export type LocalLibraryManagementOriginalOperation = {
  [C in LocalLibraryManagementMutation]: { command: C; request: dto.LocalLibraryManagementPayloads[C] }
}[LocalLibraryManagementMutation]
export type LocalLibraryManagementStart =
  | { command: 'library.ai.start'; request: dto.LocalLibraryManagementPayloads['library.ai.start'] }
  | { command: 'library.cue.start'; request: dto.LocalLibraryManagementPayloads['library.cue.start'] }
export interface LocalLibraryManagementBindingRecord {
  schema: 1; kind: 'binding'; datasetId: string; key: string; revision: number
  libraryId: string; sourceRootId: string; rootRevision: string
  role: dto.LocalLibraryRole; name: string; active: boolean; watchEnabled: boolean; operationId: string
}
export interface LocalLibraryManagementOperationRecord {
  schema: 1; kind: 'operation'; datasetId: string; key: string; revision: number
  original: LocalLibraryManagementOriginalOperation; originalSha256: string
  receipt: dto.LocalLibraryManagementOperation
}
export interface LocalLibraryManagementLibraryPin { libraryId: string; sourceRootId: string; rootRevision: string }
export interface LocalLibraryManagementAlbumRef { albumId: string; rootId: string; revision: string }
export interface LocalLibraryManagementCapturedAlbum extends LocalLibraryManagementLibraryPin {
  /** 原作者完整原件，含拒收成员/扫描来源/人工覆盖；冷恢复不依赖selected subset。 */
  resolved: import('./read-service.js').LocalWorkbenchResolvedReadCapture
}
export type LocalLibraryManagementCaptureOriginal = {
  captureId: string; watermark: string; catalogRevision: string; scanRevision: string
  libraries: readonly LocalLibraryManagementLibraryPin[]
  albumRefs: readonly LocalLibraryManagementAlbumRef[]
  albums: readonly LocalLibraryManagementCapturedAlbum[]
} & (
  | { mode: 'library'; request: dto.LocalLibraryManagementPayloads['library.capture'] }
  | { mode: 'albums'; request: dto.LocalLibraryManagementPayloads['library.albums.capture'] }
)
export interface LocalLibraryManagementCaptureRecord {
  schema: 1; kind: 'capture'; datasetId: string; key: string; revision: 1
  original: LocalLibraryManagementCaptureOriginal; originalSha256: string
}
export interface LocalLibraryManagementSelection extends LocalLibraryManagementAlbumRef { cueId: string | null }
export interface LocalLibraryManagementJobItem extends dto.LocalLibraryBatchItem {
  /** 只有原执行受理后才登记，后续UNKNOWN不能换command。 */
  planId: string | null; commandId: string | null; receipt: dto.LocalWorkbenchReceipt | null
}
export type LocalLibraryManagementJobAction =
  | { command: 'library.job.stop'; request: dto.LocalLibraryManagementPayloads['library.job.stop'] }
  | { command: 'library.job.resume'; request: dto.LocalLibraryManagementPayloads['library.job.resume'] }
  | { command: 'library.job.retry'; request: dto.LocalLibraryManagementPayloads['library.job.retry'] }
export interface LocalLibraryManagementJobCheckpoint {
  state: dto.LocalLibraryBatchPage['state']; action: LocalLibraryManagementJobAction | null
  items: readonly LocalLibraryManagementJobItem[]
}
export interface LocalLibraryManagementJobRecord {
  schema: 1; kind: 'job'; datasetId: string; key: string; revision: number
  original: {
    start: LocalLibraryManagementStart; startSha256: string
    captureId: string; captureSha256: string
    expandedSelection: readonly LocalLibraryManagementSelection[]
  }
  originalSha256: string; checkpoint: LocalLibraryManagementJobCheckpoint
}
export interface LocalLibraryManagementRecordMap {
  binding: LocalLibraryManagementBindingRecord; operation: LocalLibraryManagementOperationRecord
  capture: LocalLibraryManagementCaptureRecord; job: LocalLibraryManagementJobRecord
}
export type LocalLibraryManagementRecordKind = keyof LocalLibraryManagementRecordMap
export type LocalLibraryManagementRecord = LocalLibraryManagementRecordMap[LocalLibraryManagementRecordKind]
export interface LocalLibraryManagementStored<T extends LocalLibraryManagementRecord = LocalLibraryManagementRecord> {
  record: Readonly<T>; ledgerSequence: string; recordSha256: string
}
export interface LocalLibraryManagementWrite { record: LocalLibraryManagementRecord; expectedRevision: number | null }
export interface LocalLibraryManagementOwnerPort {
  privateLibraryManagementRead<K extends LocalLibraryManagementRecordKind>(identity: import('../../recording/dataset-identity.js').DatasetIdentity, kind: K, key: string): LocalLibraryManagementStored<LocalLibraryManagementRecordMap[K]> | null
  privateLibraryManagementBindings(identity: import('../../recording/dataset-identity.js').DatasetIdentity): readonly LocalLibraryManagementStored<LocalLibraryManagementBindingRecord>[]
  privateLibraryManagementRevision(identity: import('../../recording/dataset-identity.js').DatasetIdentity): string
  privateLibraryManagementCompareAndSwap(identity: import('../../recording/dataset-identity.js').DatasetIdentity, writes: readonly LocalLibraryManagementWrite[]): { ledgerSequence: string; records: readonly LocalLibraryManagementStored[] }
}

const librarySlot = (kind: LocalLibraryManagementRecordKind, key: string): string => kind + ':' + key
export const localLibraryManagementDigest = (value: unknown): string => hash(localWorkbenchJournalCanonical(value))
function libraryInputWithCanonical(value: unknown): {value:unknown;canonical:string} {
  const seen = new WeakSet<object>(); let size = 0, nodes = 0
  function clone(input: unknown, depth: number): unknown {
    if (++nodes > LOCAL_LIBRARY_MANAGEMENT_BYTES || depth > 64) return invalid()
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') { if (!Number.isFinite(input)) return invalid(); return input }
    if (typeof input === 'string') { size += Buffer.byteLength(input); if (size > LOCAL_LIBRARY_MANAGEMENT_BYTES) return invalid(); return input }
    if (typeof input !== 'object' || nodeTypes.isProxy(input) || seen.has(input)) return invalid()
    seen.add(input)
    let result: unknown
    if (Array.isArray(input)) {
      if (!isLocalWorkbenchDenseArray(input, LOCAL_LIBRARY_MANAGEMENT_BYTES)) return invalid()
      result = input.map(child => clone(child, depth + 1))
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid()
      const output: Record<string, unknown> = {}
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string') return invalid()
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid()
        size += Buffer.byteLength(key); if (size > LOCAL_LIBRARY_MANAGEMENT_BYTES) return invalid()
        Object.defineProperty(output,key,{value:clone(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true})
      }
      result = output
    }
    seen.delete(input); return result
  }
  const copied = clone(value, 0),canonical=localWorkbenchJournalCanonical(copied)
  if (Buffer.byteLength(canonical) > LOCAL_LIBRARY_MANAGEMENT_BYTES) return invalid()
  return {value:copied,canonical}
}
function libraryInput(value:unknown):unknown {return libraryInputWithCanonical(value).value}
const libraryIds = (value: unknown, min = 0, max = 10000): value is string[] => isLocalWorkbenchDenseArray(value, max)
  && value.length >= min && value.every(dto.isLocalWorkbenchIdentity) && new Set(value).size === value.length
const librarySame = (left: unknown, right: unknown): boolean => localWorkbenchJournalCanonical(left) === localWorkbenchJournalCanonical(right)
const libraryMetadata = (value: unknown): value is dto.LocalMetadata => isLocalWorkbenchDataRecord(value, [], ['title','artist','album','disc','track','year']) && dto.isLocalMetadata(value)
const libraryFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
/** 原扫描的完整叶约束；不反向导入持久ScanStore形成新的依赖环。 */
function libraryScanFile(value: unknown): value is import('../local-scan-facts.js').ScanFileState {
  if (!isLocalWorkbenchDataRecord(value,['libraryRootId','relative','signature','parserVersion','outcome','assetId','trackId','failureCode','readFacts'])
    || !dto.isCollectionId(value.libraryRootId) || !isLocalAlbumPrivateRelative(value.relative)
    || !dto.isLocalCatalogText(value.signature) || !dto.isLocalCatalogText(value.parserVersion)) return false
  if (value.readFacts !== null) {
    const f = value.readFacts
    if (!isLocalWorkbenchDataRecord(f,['technical','coverEvidence','readEvidence'])
      || !isLocalWorkbenchDataRecord(f.technical,['container','codec','lossless','sampleRateHz','channels','bitsPerSample','durationSeconds','evidence'])
      || !['FLAC','MPEG','MP4','WAVE','AIFF','DSF','DFF','OGG','WAVPACK','APE','TTA','MPC','TAK'].includes(String(f.technical.container)) || !dto.isLocalCatalogText(f.technical.codec)
      || !(f.technical.lossless === null || typeof f.technical.lossless === 'boolean')
      || !libraryFinite(f.technical.sampleRateHz) || f.technical.sampleRateHz === 0 || !libraryFinite(f.technical.channels) || f.technical.channels === 0
      || !(f.technical.bitsPerSample === null || libraryFinite(f.technical.bitsPerSample))
      || !(f.technical.durationSeconds === null || libraryFinite(f.technical.durationSeconds)) || f.technical.evidence !== 'bounded-parser-reported'
      || !isLocalWorkbenchDenseArray(f.coverEvidence,8) || !f.coverEvidence.every(c => isLocalWorkbenchDataRecord(c,['mime','bytes','sha256','evidence'])
        && ['image/png','image/jpeg'].includes(String(c.mime)) && integer(c.bytes,1,4*1024*1024) && hex(c.sha256) && c.evidence === 'encoded-bytes-magic-and-digest')
      || !isLocalWorkbenchDataRecord(f.readEvidence,['bytesRead','readCalls','maxReadBytes','allocationBytes','elapsedMs','wholeAudioHash','wholeAudioDecode'])) return false
    if (['OGG','WAVPACK','APE','MPC'].includes(String(f.technical.container)) && value.parserVersion !== METADATA_PARSER_VERSION
      || ['TTA','TAK'].includes(String(f.technical.container)) && value.parserVersion !== CUE_HEADER_METADATA_PARSER_VERSION) return false
    if (['DSF','DFF'].includes(String(f.technical.container)) && (f.technical.codec !== 'DSD' || f.technical.lossless !== true || f.technical.bitsPerSample !== 1
      || ![2822400,3072000,5644800,6144000,11289600,12288000,22579200,24576000].includes(Number(f.technical.sampleRateHz))
      || !integer(f.technical.channels,1,6) || !libraryFinite(f.technical.durationSeconds) || f.technical.durationSeconds === 0)) return false
    const e=f.readEvidence
    if (!integer(e.bytesRead,0,32*1024*1024) || !integer(e.readCalls,0,Number.MAX_SAFE_INTEGER) || !integer(e.maxReadBytes,0,8*1024*1024)
      || !integer(e.allocationBytes,0,64*1024*1024) || !libraryFinite(e.elapsedMs) || e.wholeAudioHash !== false || e.wholeAudioDecode !== false) return false
  }
  return value.outcome === 'accepted' ? dto.isCollectionId(value.assetId) && dto.isCollectionId(value.trackId) && value.failureCode === null && value.readFacts !== null
    : value.outcome === 'rejected' && (value.assetId === null || dto.isCollectionId(value.assetId)) && (value.trackId === null || dto.isCollectionId(value.trackId))
      && (value.assetId === null) === (value.trackId === null) && dto.isLocalCatalogText(value.failureCode)
}
function libraryPin(value: unknown): value is LocalLibraryManagementLibraryPin {
  return isLocalWorkbenchDataRecord(value,['libraryId','sourceRootId','rootRevision']) && dto.isCollectionId(value.libraryId)
    && dto.isCollectionId(value.sourceRootId) && dto.isLocalCatalogRevision(value.rootRevision)
}
function libraryRef(value: unknown): value is LocalLibraryManagementAlbumRef {
  return isLocalWorkbenchDataRecord(value,['albumId','rootId','revision']) && dto.isLocalLibraryManagementPayload('library.album.capture',value)
}
function libraryResolved(input: unknown, pin: LocalLibraryManagementLibraryPin, datasetId: string, watermark: string): input is LocalLibraryManagementCapturedAlbum['resolved'] {
  if (!isLocalWorkbenchDataRecord(input,['datasetId','datasetRevision','capture','group','directoryFacts','provenance','availability'])
    || input.datasetId !== datasetId || input.datasetRevision !== watermark || !isLocalWorkbenchAlbumCapture(input.capture)
    || input.capture.rootId !== pin.libraryId || !['online','offline','unavailable'].includes(String(input.availability))) return false
  const capture=input.capture, group=input.group, facts=input.directoryFacts
  if (!isLocalWorkbenchDataRecord(group,['summary','members','directory','issues'],['rejectedFiles']) || !dto.isLocalAlbumSummary(group.summary)
    || group.summary.id !== capture.albumId || group.summary.rootId !== pin.libraryId || group.summary.editionId !== capture.editionId
    || !isLocalWorkbenchDenseArray(group.members,10000) || !(group.directory === null || isLocalAlbumPrivateRelative(group.directory,true))
    || !isLocalWorkbenchDenseArray(group.issues,30100)) return false
  const groupIds: string[]=[], relatives: string[]=[]
  for (const member of group.members) {
    if (!isLocalWorkbenchDataRecord(member,['fact','disc','trackNumber','sequence','editionLink','statuses'])
      || !(member.disc===null||integer(member.disc,1,1000000)) || !(member.trackNumber===null||integer(member.trackNumber,1,1000000))
      || !integer(member.sequence,1,1000000) || !(member.editionLink===null||dto.isAlbumEditionTrack(member.editionLink))
      || !isLocalWorkbenchDenseArray(member.statuses,9) || !member.statuses.every(status=>(dto.LOCAL_ALBUM_STATUSES as readonly unknown[]).includes(status))
      || !isLocalWorkbenchDataRecord(member.fact,['relative','summary','rawMetadata','hasArtwork','artworkRevision'],['artworkState'])
      || !isLocalAlbumPrivateRelative(member.fact.relative) || !dto.isLocalLibraryTrackSummary(member.fact.summary) || !libraryMetadata(member.fact.rawMetadata)
      || typeof member.fact.hasArtwork!=='boolean' || !(member.fact.artworkRevision===null||dto.isLocalWorkbenchIdentity(member.fact.artworkRevision))
      || Object.hasOwn(member.fact,'artworkState') && (!['available','missing','unknown','source-unavailable'].includes(String(member.fact.artworkState)) || member.fact.hasArtwork !== (member.fact.artworkState==='available'))) return false
    const track=member.fact.summary.track, asset=member.fact.summary.asset
    if (track.assetId !== asset.id || asset.libraryRootId!==pin.libraryId || asset.sourceRootId!==pin.sourceRootId || asset.rootRevision!==pin.rootRevision
      || member.editionLink!==null && (member.editionLink.trackId!==track.id || member.editionLink.editionId!==capture.editionId || !member.editionLink.active)) return false
    groupIds.push(track.id); relatives.push(member.fact.relative)
  }
  if (new Set(groupIds).size!==groupIds.length || group.summary.trackCount!==groupIds.length) return false
  if (!group.issues.every(issue => isLocalWorkbenchDataRecord(issue,['kind'],['trackId','fields','relative','status','revision']) && (
    issue.kind==='missing-metadata' ? isLocalWorkbenchDataRecord(issue,['kind','trackId','fields']) && groupIds.includes(String(issue.trackId)) && isLocalWorkbenchDenseArray(issue.fields,3) && issue.fields.every(f=>['title','artist','album'].includes(String(f)))
    : issue.kind==='metadata-read-failed' ? isLocalWorkbenchDataRecord(issue,['kind','relative']) && isLocalAlbumPrivateRelative(issue.relative)
    : issue.kind==='cue' ? isLocalWorkbenchDataRecord(issue,['kind','relative','status']) && isLocalAlbumPrivateRelative(issue.relative) && ['ready','failed','unresolved'].includes(String(issue.status))
    : issue.kind==='name-enhancement-failed' && isLocalWorkbenchDataRecord(issue,['kind','revision']) && dto.isLocalWorkbenchIdentity(issue.revision)))) return false
  if (!isLocalWorkbenchDataRecord(facts,['revision','files','cues']) || !dto.isLocalWorkbenchIdentity(facts.revision)
    || !isLocalWorkbenchDenseArray(facts.files,10000) || !isLocalWorkbenchDenseArray(facts.cues,10000) || facts.files.length+facts.cues.length>10000) return false
  const parent=(relative:string):string=>relative.includes('/')?relative.slice(0,relative.lastIndexOf('/')):''
  const basename=(relative:string):string=>relative.slice(relative.lastIndexOf('/')+1)
  const originalDirectories=[...new Set(group.directory!==null?[group.directory]:relatives.map(parent))]
  const rejectedDirectoryRefs=group.rejectedFiles??[]
  if(!isLocalWorkbenchDenseArray(rejectedDirectoryRefs,10000)||!rejectedDirectoryRefs.every(ref=>isLocalWorkbenchDataRecord(ref,['relative','revision'])&&isLocalAlbumPrivateRelative(ref.relative)&&dto.isLocalWorkbenchIdentity(ref.revision)))return false
  // 新组织捕获仍只准本组真实成员、拒收及CUE的直接目录；旧捕获保留原摘要。
  const organizedDirectories=[...new Set([...(group.directory!==null?[group.directory]:[]),...relatives.map(parent),
    ...rejectedDirectoryRefs.map(ref=>parent(String((ref as {relative:string}).relative))),
    ...group.issues.flatMap(issue=>(issue as {kind:string}).kind==='cue'?[parent(String((issue as {relative:string}).relative))]:[])])]
  const directories=capture.directoryId==='directory-'+localLibraryManagementDigest([pin.libraryId,pin.sourceRootId,organizedDirectories])?organizedDirectories:originalDirectories
  if (!directories.length || directories.length>100 || !facts.files.every(file => isLocalWorkbenchDataRecord(file,['jobId','rootRevision','sourceRootId','currentRelative','value'])
    && dto.isCollectionId(file.jobId) && file.rootRevision===pin.rootRevision && file.sourceRootId===pin.sourceRootId && isLocalAlbumPrivateRelative(file.currentRelative)
    && directories.includes(parent(file.currentRelative)) && libraryScanFile(file.value) && file.value.libraryRootId===pin.libraryId)
    || new Set(facts.files.map(f=>String((f as Record<string,unknown>).currentRelative))).size!==facts.files.length) return false
  if (!facts.cues.every(cue => isLocalWorkbenchDataRecord(cue,['id','sidecarId','libraryRootId','sourceRootId','rootRevision','item'])
    && dto.isCollectionId(cue.id) && dto.isCollectionId(cue.sidecarId) && cue.libraryRootId===pin.libraryId && cue.sourceRootId===pin.sourceRootId
    && cue.rootRevision===pin.rootRevision && dto.isLocalCuePreparedItem(cue.item) && directories.includes(parent(cue.item.relative)))) return false
  if (!isLocalWorkbenchDenseArray(input.provenance,10000) || input.provenance.length!==groupIds.length
    || !input.provenance.every(p=>isLocalWorkbenchDataRecord(p,['trackId','override']) && groupIds.includes(String(p.trackId))
      && (p.override===null || isLocalWorkbenchDataRecord(p.override,['commandId','revision','fields']) && dto.isCollectionId(p.override.commandId) && dto.isLocalCatalogRevision(p.override.revision) && libraryMetadata(p.override.fields)))
    || new Set(input.provenance.map(p=>String((p as Record<string,unknown>).trackId))).size!==groupIds.length) return false
  const accepted=capture.members.filter(m=>m.trackId!==null), rejected=capture.members.filter(m=>m.trackId===null)
  if (accepted.length!==groupIds.length || !accepted.every(m=>groupIds.includes(m.trackId!)) || new Set(accepted.map(m=>m.trackId)).size!==accepted.length) return false
  for (const m of accepted) {
    const member=group.members.find(item=>(item as {fact:{summary:dto.LocalLibraryTrackSummary}}).fact.summary.track.id===m.trackId) as import('../local-album-browser/types.js').LocalAlbumGroupMember
    const asset=member.fact.summary.asset, file=facts.files.find(f=>(f as {currentRelative:string}).currentRelative===member.fact.relative) as import('./read-service.js').LocalWorkbenchDirectoryFacts['files'][number]|undefined
    if (m.assetId!==asset.id || m.fileName!==basename(member.fact.relative) || m.rootRevision!==pin.rootRevision || m.fileRevision!==asset.fileRevision || m.locationRevision!==asset.locationRevision
      || m.title!==(member.fact.rawMetadata.title??null) || m.artist!==(member.fact.rawMetadata.artist??null) || m.album!==(member.fact.rawMetadata.album??null)
      || (file ? !m.scan || !librarySame(m.scan,{signature:file.value.signature,parserVersion:file.value.parserVersion,revision:localLibraryManagementDigest(file),failureCode:file.value.failureCode}) : m.scan!==undefined)) return false
  }
  const rejectedRefs=group.rejectedFiles===undefined ? (groupIds.length===0?facts.files.filter(f=>(f as {value:{outcome:string}}).value.outcome==='rejected').map(f=>({relative:(f as {currentRelative:string}).currentRelative,revision:(f as {value:{signature:string}}).value.signature})):[]) : group.rejectedFiles
  if (!isLocalWorkbenchDenseArray(rejectedRefs,10000) || !rejectedRefs.every(f=>isLocalWorkbenchDataRecord(f,['relative','revision']) && isLocalAlbumPrivateRelative(f.relative) && dto.isLocalWorkbenchIdentity(f.revision))
    || new Set(rejectedRefs.map(f=>String((f as {relative:string}).relative))).size!==rejectedRefs.length || rejected.length!==rejectedRefs.filter(f=>!relatives.includes(String((f as {relative:string}).relative))).length) return false
  for (const ref of rejectedRefs as {relative:string;revision:string}[]) {
    if (relatives.includes(ref.relative)) continue
    const file=facts.files.find(f=>(f as {currentRelative:string}).currentRelative===ref.relative) as import('./read-service.js').LocalWorkbenchDirectoryFacts['files'][number]|undefined
    if (!file || file.value.outcome!=='rejected' || !rejected.some(m=>m.fileName===basename(ref.relative) && m.rootRevision===pin.rootRevision && librarySame(m.scan,
      {signature:file.value.signature,parserVersion:file.value.parserVersion,revision:localLibraryManagementDigest(file),failureCode:file.value.failureCode}))) return false
  }
  const root:dto.LibraryRoot={id:pin.libraryId,sourceRootId:pin.sourceRootId,role:'library',revision:pin.rootRevision}
  if (!capture.nameSources || capture.revision!==localLibraryManagementDigest([group.summary.revision,root,facts,input.provenance,capture.members,capture.nameSources])
    || capture.directoryId!=='directory-'+localLibraryManagementDigest([pin.libraryId,pin.sourceRootId,directories])) return false
  return true
}
function libraryCaptureOriginal(value: unknown, datasetId: string): value is LocalLibraryManagementCaptureOriginal {
  if (!isLocalWorkbenchDataRecord(value,['captureId','watermark','catalogRevision','scanRevision','libraries','albumRefs','albums','mode','request'])
    || ![value.captureId,value.watermark,value.catalogRevision,value.scanRevision].every(dto.isLocalWorkbenchIdentity)
    || !isLocalWorkbenchDenseArray(value.libraries,100) || !value.libraries.length || !value.libraries.every(libraryPin)
    || new Set(value.libraries.map(l=>(l as LocalLibraryManagementLibraryPin).libraryId)).size!==value.libraries.length
    || !isLocalWorkbenchDenseArray(value.albumRefs,10000) || !value.albumRefs.every(libraryRef) || !isLocalWorkbenchDenseArray(value.albums,10000)
    || value.albums.length!==value.albumRefs.length || new Set(value.albumRefs.map(r=>(r as LocalLibraryManagementAlbumRef).albumId)).size!==value.albumRefs.length) return false
  if (value.mode==='library') {
    if (!dto.isLocalLibraryManagementPayload('library.capture',value.request) || !librarySame(value.request.libraryIds,value.libraries.map(l=>(l as LocalLibraryManagementLibraryPin).libraryId))) return false
  } else if (value.mode!=='albums' || !dto.isLocalLibraryManagementPayload('library.albums.capture',value.request) || !librarySame(value.request.albums,value.albumRefs)) return false
  let resources=0
  for (let i=0;i<value.albums.length;i++) {
    const a=value.albums[i],ref=value.albumRefs[i] as LocalLibraryManagementAlbumRef
    if (!isLocalWorkbenchDataRecord(a,['libraryId','sourceRootId','rootRevision','resolved'])) return false
    if(!dto.isCollectionId(a.libraryId)||!dto.isCollectionId(a.sourceRootId)||!dto.isLocalCatalogRevision(a.rootRevision))return false
    const pin:LocalLibraryManagementLibraryPin={libraryId:a.libraryId,sourceRootId:a.sourceRootId,rootRevision:a.rootRevision}
    if (!libraryPin(pin) || !value.libraries.some(p=>librarySame(p,pin)) || !libraryResolved(a.resolved,pin,datasetId,String(value.watermark))) return false
    if (a.resolved.capture.albumId!==ref.albumId || a.resolved.capture.rootId!==ref.rootId || a.resolved.group.summary.revision!==ref.revision
      || a.resolved.directoryFacts.revision!==value.scanRevision) return false
    resources+=a.resolved.capture.members.length; if (resources>LOCAL_LIBRARY_MANAGEMENT_RESOURCES) return false
  }
  return true
}
function libraryJobItem(value: unknown, original: LocalLibraryManagementJobRecord['original'], datasetId:string): value is LocalLibraryManagementJobItem {
  if (!isLocalWorkbenchDataRecord(value,['albumId','state','message','planId','commandId','receipt'])
    || !original.expandedSelection.some(s=>s.albumId===value.albumId) || !['queued','running','ready','applied','review','failed','unknown','cancelled'].includes(String(value.state))
    || !(value.message===null||dto.isLocalWorkbenchText(value.message,false,1024)) || !(value.planId===null||dto.isLocalWorkbenchIdentity(value.planId))
    || !(value.commandId===null||dto.isLocalWorkbenchIdentity(value.commandId)) || (value.commandId!==null&&value.planId===null)) return false
  if (value.receipt!==null && (!dto.isLocalWorkbenchReceipt(value.receipt) || value.receipt.datasetId!==datasetId || value.receipt.commandId!==value.commandId
    || value.receipt.planId!==value.planId || !value.receipt.items.some(item=>item.albumId===value.albumId))) return false
  return value.state!=='applied' || value.receipt!==null && value.receipt.state==='succeeded'
}
function libraryRecord(value: unknown): value is LocalLibraryManagementRecord {
  if (!isLocalWorkbenchDataRecord(value,['schema','kind','datasetId','key','revision'],['libraryId','sourceRootId','rootRevision','role','name','active','watchEnabled','operationId','original','originalSha256','receipt','checkpoint'])
    || value.schema!==1 || !dto.isCommandOutboxDatasetId(value.datasetId) || !dto.isLocalWorkbenchIdentity(value.key) || !integer(value.revision,1,Number.MAX_SAFE_INTEGER)) return false
  const base=['schema','kind','datasetId','key','revision']
  if (value.kind==='binding') return isLocalWorkbenchDataRecord(value,[...base,'libraryId','sourceRootId','rootRevision','role','name','active','watchEnabled','operationId'])
    && dto.isCollectionId(value.libraryId) && value.libraryId===value.key && dto.isCollectionId(value.sourceRootId) && dto.isLocalCatalogRevision(value.rootRevision)
    && typeof value.role==='string' && ['catalog','artist','album','container'].includes(value.role) && dto.isLocalWorkbenchText(value.name,false,256) && typeof value.active==='boolean' && typeof value.watchEnabled==='boolean'
    && dto.isLocalWorkbenchIdentity(value.operationId) && (value.active || !value.watchEnabled)
  if (!hex(value.originalSha256) || !isLocalWorkbenchDataRecord(value.original,[],['command','request','captureId','watermark','catalogRevision','scanRevision','libraries','albumRefs','albums','mode','start','startSha256','captureSha256','expandedSelection'])
    || value.originalSha256!==localLibraryManagementDigest(value.original)) return false
  if (value.kind==='operation') {
    if (!isLocalWorkbenchDataRecord(value,[...base,'original','originalSha256','receipt']) || !isLocalWorkbenchDataRecord(value.original,['command','request'])
      || !(LOCAL_LIBRARY_MANAGEMENT_MUTATIONS as readonly unknown[]).includes(value.original.command)) return false
    const command=value.original.command as LocalLibraryManagementMutation
    return dto.isLocalLibraryManagementPayload(command,value.original.request) && value.original.request.commandId===value.key
      && dto.isLocalLibraryManagementResult(command,value.receipt,value.original.request)
  }
  if (value.kind==='capture') return isLocalWorkbenchDataRecord(value,[...base,'original','originalSha256']) && value.revision===1
    && libraryCaptureOriginal(value.original,value.datasetId) && value.original.captureId===value.key
  if (value.kind!=='job' || !isLocalWorkbenchDataRecord(value,[...base,'original','originalSha256','checkpoint'])
    || !isLocalWorkbenchDataRecord(value.original,['start','startSha256','captureId','captureSha256','expandedSelection'])
    || !isLocalWorkbenchDataRecord(value.original.start,['command','request']) || !['library.ai.start','library.cue.start'].includes(String(value.original.start.command))
    || !hex(value.original.startSha256) || value.original.startSha256!==localLibraryManagementDigest(value.original.start)
    || !dto.isLocalWorkbenchIdentity(value.original.captureId) || !hex(value.original.captureSha256)
    || !isLocalWorkbenchDenseArray(value.original.expandedSelection,10000)) return false
  const start=value.original.start as LocalLibraryManagementStart
  if (!dto.isLocalLibraryManagementPayload(start.command,start.request) || start.request.commandId!==value.key || start.request.captureId!==value.original.captureId
    || !value.original.expandedSelection.every(s=>isLocalWorkbenchDataRecord(s,['albumId','rootId','revision','cueId'])
      && dto.isLocalLibraryManagementPayload('library.album.capture',{albumId:s.albumId,rootId:s.rootId,revision:s.revision})
      && (start.command==='library.ai.start'?s.cueId===null:s.cueId===null&&start.request.selection==='all-unsplit'||dto.isLocalWorkbenchIdentity(s.cueId)))
    || new Set(value.original.expandedSelection.map(s=>String((s as LocalLibraryManagementSelection).albumId))).size!==value.original.expandedSelection.length) return false
  const original=value.original as unknown as LocalLibraryManagementJobRecord['original']
  if (start.command==='library.ai.start' && start.request.selection==='selected' && !librarySame(start.request.albumIds,original.expandedSelection.map(s=>s.albumId))
    || start.command==='library.cue.start' && start.request.selection==='selected' && !librarySame(start.request.selections,original.expandedSelection.map(s=>({albumId:s.albumId,cueId:s.cueId})))) return false
  const checkpoint=value.checkpoint
  return isLocalWorkbenchDataRecord(checkpoint,['state','action','items']) && ['queued','running','stopped','complete','partial','unknown','failed'].includes(String(checkpoint.state))
    && isLocalWorkbenchDenseArray(checkpoint.items,10000) && checkpoint.items.length===original.expandedSelection.length
    && checkpoint.items.every((item,i)=>libraryJobItem(item,original,value.datasetId as string) && item.albumId===original.expandedSelection[i]!.albumId)
    && (checkpoint.action===null || isLocalWorkbenchDataRecord(checkpoint.action,['command','request']) && ['library.job.stop','library.job.resume','library.job.retry'].includes(String(checkpoint.action.command))
      && dto.isLocalLibraryManagementPayload(checkpoint.action.command as 'library.job.stop'|'library.job.resume'|'library.job.retry',checkpoint.action.request)
      && checkpoint.action.request.jobId===value.key)
    && (checkpoint.state!=='complete' || checkpoint.items.every(item=>(item as LocalLibraryManagementJobItem).state==='applied'||(item as LocalLibraryManagementJobItem).state==='review'))
}
function captureLibraryManagementRecordWithCanonical(input:unknown):{record:LocalLibraryManagementRecord;canonical:string} {
  const captured=libraryInputWithCanonical(input)
  if (!libraryRecord(captured.value)) return invalid()
  return {record:captured.value,canonical:captured.canonical}
}
export function captureLocalLibraryManagementRecord(input: unknown): LocalLibraryManagementRecord {
  return captureLibraryManagementRecordWithCanonical(input).record
}
/** 只复用同Owner内部已完整防御捕获的不可变正文；不能代替身份、CAS或当前SQL校验。 */
const libraryOwnerRecords=new WeakSet<object>()
const libraryOwnerCanonicals=new WeakMap<object,string>()
export function captureLocalLibraryManagementOwnerRecord(input:unknown):Readonly<LocalLibraryManagementRecord> {
  const captured=captureLibraryManagementRecordWithCanonical(input),frozen=freezeLocalWorkbenchValue(captured.record)
  libraryOwnerRecords.add(frozen);libraryOwnerCanonicals.set(frozen,captured.canonical)
  return frozen
}
export function isLocalLibraryManagementRecord(input: unknown): input is LocalLibraryManagementRecord {
  try { captureLocalLibraryManagementRecord(input); return true } catch { return false }
}
/** 只允许原import未确认空绑定在实际注册后取得唯一原Root；其它operation目标不变。 */
export function isLocalLibraryManagementImportCompletion(previous:LocalLibraryManagementOperationRecord,current:LocalLibraryManagementOperationRecord):boolean {
  return previous.original.command==='library.import.confirm'&&current.original.command==='library.import.confirm'
    && ['running','unknown'].includes(previous.receipt.state)&&previous.receipt.libraryIds.length===0
    && current.receipt.state==='succeeded'&&current.receipt.libraryIds.length===1
    && previous.datasetId===current.datasetId&&previous.key===current.key&&previous.originalSha256===current.originalSha256
    && librarySame(previous.original,current.original)
}
export function assertLocalLibraryManagementTransition(previous: LocalLibraryManagementRecord|null, current: LocalLibraryManagementRecord): void {
  if (!previous) {
    if (current.revision!==1 || current.kind==='job' && (current.checkpoint.state!=='queued'||current.checkpoint.action!==null||current.checkpoint.items.some(item=>!['queued','review'].includes(item.state)||item.planId!==null||item.commandId!==null||item.receipt!==null))) return invalid()
    return
  }
  if (previous.kind!==current.kind || previous.datasetId!==current.datasetId || previous.key!==current.key || current.revision!==previous.revision+1 || current.kind==='capture') return invalid()
  if (previous.kind==='binding' && current.kind==='binding') return
  if (previous.kind==='operation' && current.kind==='operation') {
    if (previous.originalSha256!==current.originalSha256 || !librarySame(previous.original,current.original)
      || ['succeeded','failed','cancelled'].includes(previous.receipt.state) || !librarySame(previous.receipt.libraryIds,current.receipt.libraryIds)&&!isLocalLibraryManagementImportCompletion(previous,current)) return invalid()
    return
  }
  if (previous.kind!=='job'||current.kind!=='job'||previous.originalSha256!==current.originalSha256||!librarySame(previous.original,current.original)) return invalid()
  const action=current.checkpoint.action
  if (action?.command==='library.job.resume' && (previous.checkpoint.state!=='stopped'||current.checkpoint.state!=='queued') || action?.command==='library.job.stop' && (!['queued','running'].includes(previous.checkpoint.state)||!['stopped','unknown'].includes(current.checkpoint.state))
    || action?.command==='library.job.retry' && (!action.request.albumIds.every(id=>previous.checkpoint.items.some(i=>i.albumId===id&&i.state==='failed')) || current.checkpoint.state!=='queued')) return invalid()
  if (['complete'].includes(previous.checkpoint.state) && current.checkpoint.state!=='complete') return invalid()
  if (previous.checkpoint.state==='unknown' && current.checkpoint.state==='queued') return invalid()
  for (let i=0;i<previous.checkpoint.items.length;i++) {
    const before=previous.checkpoint.items[i]!, after=current.checkpoint.items[i]!
    const reset=after.state==='queued'&&after.planId===null&&after.commandId===null&&after.receipt===null&&(before.state==='failed'&&action?.command==='library.job.retry'&&action.request.albumIds.includes(before.albumId)||before.state==='cancelled'&&action?.command==='library.job.resume')
    if (before.albumId!==after.albumId || !reset&&before.planId!==null&&before.planId!==after.planId || !reset&&before.commandId!==null&&before.commandId!==after.commandId
      || before.state==='applied'&&!librarySame(before,after) || before.state==='unknown'&&after.state!=='unknown'&&!(after.receipt!==null&&['failed','succeeded'].includes(after.receipt.state))
      || before.state==='failed'&&after.state==='queued'&&!(action?.command==='library.job.retry'&&action.request.albumIds.includes(before.albumId))) return invalid()
  }
}
interface LibraryManagementEventCommon {
  datasetId:string; eventId:string; transactionId:string; batchId:string; batchIndex:number; batchCount:number; recordKind:LocalLibraryManagementRecordKind; key:string
  expectedRevision:number|null; revision:number; encoding:'full-v1'|'job-state-v1'|'operation-state-v1'
  recordSha256:string; frameSha256:string; bytes:number; chunks:number
}
export type LocalLibraryManagementEvent=LibraryManagementEventCommon & ({kind:'chunk';index:number;payload:string}|{kind:'commit'})
export interface LocalLibraryManagementProjection {
  datasetId:string; highWater:number; records:Map<string,LocalLibraryManagementStored>
  pending:null|{header:Omit<LibraryManagementEventCommon,'eventId'>;parts:Buffer[];bytes:number}
  batch:null|{id:string;count:number;records:LocalLibraryManagementStored[]}
}
export function emptyLocalLibraryManagementProjection(datasetId:string):LocalLibraryManagementProjection {
  if (!dto.isCommandOutboxDatasetId(datasetId)) return invalid()
  return {datasetId,highWater:0,records:new Map(),pending:null,batch:null}
}
export function assertLocalLibraryManagementComplete(value:LocalLibraryManagementProjection):void { if(value.pending||value.batch)return invalid() }
export function copyLocalLibraryManagementProjection(value:LocalLibraryManagementProjection):LocalLibraryManagementProjection {
  assertLocalLibraryManagementComplete(value);return {...value,records:new Map(value.records),pending:null,batch:null}
}
export function isLocalLibraryManagementEvent(value:unknown):value is LocalLibraryManagementEvent {
  if (!isLocalWorkbenchDataRecord(value,['datasetId','eventId','transactionId','batchId','batchIndex','batchCount','recordKind','key','expectedRevision','revision','encoding','recordSha256','frameSha256','bytes','chunks','kind'],['index','payload'])
    || ![value.datasetId,value.eventId,value.transactionId,value.batchId].every(dto.isCollectionId) || !integer(value.batchCount,1,101) || !integer(value.batchIndex,0,Number(value.batchCount)-1) || !dto.isLocalWorkbenchIdentity(value.key)
    || !['binding','operation','capture','job'].includes(String(value.recordKind)) || !['full-v1','job-state-v1','operation-state-v1'].includes(String(value.encoding))
    || !integer(value.revision,1,Number.MAX_SAFE_INTEGER) || value.expectedRevision!==null&&!integer(value.expectedRevision,1,Number.MAX_SAFE_INTEGER-1)
    || value.revision!==(value.expectedRevision===null?1:Number(value.expectedRevision)+1) || !hex(value.recordSha256)||!hex(value.frameSha256)
    || !integer(value.bytes,1,LOCAL_LIBRARY_MANAGEMENT_BYTES) || value.chunks!==Math.ceil(Number(value.bytes)/LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES)) return false
  if (value.kind==='commit')return !Object.hasOwn(value,'index')&&!Object.hasOwn(value,'payload')
  if(value.kind!=='chunk'||!integer(value.index,0,Number(value.chunks)-1)||typeof value.payload!=='string'||value.payload.length>LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES*4/3+4||/[^A-Za-z0-9+/=]/u.test(value.payload))return false
  const raw=Buffer.from(value.payload,'base64')
  return raw.toString('base64')===value.payload&&raw.length===Math.min(LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES,Number(value.bytes)-Number(value.index)*LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES)
}
export function createLocalLibraryManagementEvents(input:LocalLibraryManagementRecord, previous:LocalLibraryManagementRecord|null):readonly LocalLibraryManagementEvent[] {
  const current=libraryOwnerRecords.has(input)?input:captureLocalLibraryManagementRecord(input)
  assertLocalLibraryManagementTransition(previous,current)
  let encoding:LibraryManagementEventCommon['encoding']='full-v1', frame:unknown=current
  if(previous?.kind==='job'&&current.kind==='job'){
    encoding='job-state-v1';frame={schema:1,kind:'job-state',datasetId:current.datasetId,key:current.key,revision:current.revision,originalSha256:current.originalSha256,
      state:current.checkpoint.state,action:current.checkpoint.action,changes:current.checkpoint.items.flatMap((item,index)=>librarySame(item,previous.checkpoint.items[index])?[]:[{index,item}])}
  }else if(previous?.kind==='operation'&&current.kind==='operation'){
    encoding='operation-state-v1';frame={schema:1,kind:'operation-state',datasetId:current.datasetId,key:current.key,revision:current.revision,originalSha256:current.originalSha256,receipt:current.receipt}
  }
  // 仅同对象Owner品牌的full-v1复用防御克隆已实算的原规范串；其余正文仍逐次计算。
  const ownedCanonical=encoding==='full-v1'&&libraryOwnerRecords.has(current)?libraryOwnerCanonicals.get(current):undefined
  const raw=Buffer.from(ownedCanonical??localWorkbenchJournalCanonical(frame)),frameSha256=hash(raw)
  // full-v1的frame就是本次已完整校验的current；复用同规范原字节的实算SHA，不重复序列化。
  const recordSha256=encoding==='full-v1'?frameSha256:localLibraryManagementDigest(current)
  const header={datasetId:current.datasetId,transactionId:randomUUID(),batchId:randomUUID(),batchIndex:0,batchCount:1,recordKind:current.kind,key:current.key,
    expectedRevision:previous?.revision??null,revision:current.revision,encoding,recordSha256,frameSha256,bytes:raw.length,chunks:Math.ceil(raw.length/LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES)}
  const events:LocalLibraryManagementEvent[]=[]
  for(let index=0;index<header.chunks;index++)events.push({...header,eventId:randomUUID(),kind:'chunk',index,payload:raw.subarray(index*LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES,(index+1)*LOCAL_LIBRARY_MANAGEMENT_CHUNK_BYTES).toString('base64')})
  events.push({...header,eventId:randomUUID(),kind:'commit'})
  if(!events.every(isLocalLibraryManagementEvent))return invalid()
  return events
}
function libraryEventHeader(event:LocalLibraryManagementEvent):Omit<LibraryManagementEventCommon,'eventId'> {
  return {datasetId:event.datasetId,transactionId:event.transactionId,batchId:event.batchId,batchIndex:event.batchIndex,batchCount:event.batchCount,recordKind:event.recordKind,key:event.key,expectedRevision:event.expectedRevision,
    revision:event.revision,encoding:event.encoding,recordSha256:event.recordSha256,frameSha256:event.frameSha256,bytes:event.bytes,chunks:event.chunks}
}
export function projectLocalLibraryManagementEvent(value:LocalLibraryManagementProjection,event:LocalLibraryManagementEvent,sequence:number):LocalLibraryManagementStored|null {
  if(!isLocalLibraryManagementEvent(event)||event.datasetId!==value.datasetId||!integer(sequence,value.highWater+1,Number.MAX_SAFE_INTEGER)||value.batch!==null&&sequence!==value.highWater+1)return invalid()
  const previous=value.records.get(librarySlot(event.recordKind,event.key))
  if((previous?.record.revision??null)!==event.expectedRevision)return invalid()
  const header=libraryEventHeader(event)
  if(event.kind==='chunk'){
    if(!value.pending){if(event.index!==0)return invalid();if(!value.batch){if(event.batchIndex!==0)return invalid();value.batch={id:event.batchId,count:event.batchCount,records:[]}}
      if(value.batch.id!==event.batchId||value.batch.count!==event.batchCount||value.batch.records.length!==event.batchIndex)return invalid();value.pending={header,parts:[],bytes:0}}
    if(!librarySame(value.pending.header,header)||value.pending.parts.length!==event.index)return invalid()
    const raw=Buffer.from(event.payload,'base64');value.pending.parts.push(raw);value.pending.bytes+=raw.length
    if(value.pending.bytes>event.bytes)return invalid();value.highWater=sequence;return null
  }
  const pending=value.pending
  if(!pending||!librarySame(pending.header,header)||pending.parts.length!==event.chunks||pending.bytes!==event.bytes)return invalid()
  const raw=Buffer.concat(pending.parts),rawSha256=hash(raw);if(rawSha256!==event.frameSha256)return invalid()
  let capturedFrame:ReturnType<typeof libraryInputWithCanonical>
  try{capturedFrame=libraryInputWithCanonical(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)))}catch{return invalid()}
  const frame=capturedFrame.value
  if(capturedFrame.canonical!==raw.toString('utf8'))return invalid()
  let current:LocalLibraryManagementRecord
  if(event.encoding==='full-v1') {
    if(previous&&['job','operation','capture'].includes(event.recordKind))return invalid()
    // 本次私有frame已完成同一有界克隆与规范字节对账；完整record校验仍逐次执行。
    if(!libraryRecord(frame))return invalid()
    current=frame
  }else if(event.encoding==='job-state-v1'){
    if(previous?.record.kind!=='job'||!isLocalWorkbenchDataRecord(frame,['schema','kind','datasetId','key','revision','originalSha256','state','action','changes'])
      ||frame.schema!==1||frame.kind!=='job-state'||frame.originalSha256!==previous.record.originalSha256||!isLocalWorkbenchDenseArray(frame.changes,10000))return invalid()
    const items=structuredClone(previous.record.checkpoint.items) as LocalLibraryManagementJobItem[],indexes=new Set<number>()
    for(const change of frame.changes){if(!isLocalWorkbenchDataRecord(change,['index','item'])||!integer(change.index,0,items.length-1)||indexes.has(change.index))return invalid();indexes.add(change.index);items[change.index]=change.item as LocalLibraryManagementJobItem}
    current=captureLocalLibraryManagementRecord({...previous.record,revision:frame.revision,checkpoint:{state:frame.state,action:frame.action,items}})
  }else{
    if(previous?.record.kind!=='operation'||!isLocalWorkbenchDataRecord(frame,['schema','kind','datasetId','key','revision','originalSha256','receipt'])
      ||frame.schema!==1||frame.kind!=='operation-state'||frame.originalSha256!==previous.record.originalSha256)return invalid()
    current=captureLocalLibraryManagementRecord({...previous.record,revision:frame.revision,receipt:frame.receipt})
  }
  const actualRecordSha256=event.encoding==='full-v1'?rawSha256:localLibraryManagementDigest(current)
  if(current.datasetId!==event.datasetId||current.kind!==event.recordKind||current.key!==event.key||current.revision!==event.revision
    ||actualRecordSha256!==event.recordSha256||isLocalWorkbenchDataRecord(frame,[],['schema','kind','datasetId','key','revision','originalSha256','state','action','changes','receipt'])&&(frame.datasetId!==current.datasetId||frame.key!==current.key))return invalid()
  assertLocalLibraryManagementTransition(previous?.record??null,current)
  const stored={record:current,ledgerSequence:String(sequence),recordSha256:event.recordSha256}
  if(!value.batch||value.batch.id!==event.batchId||value.batch.records.some(r=>r.record.kind===current.kind&&r.record.key===current.key))return invalid()
  value.batch.records.push(stored);value.pending=null;value.highWater=sequence
  if(value.batch.records.length===value.batch.count){assertLocalLibraryManagementBatch(value.records,value.batch.records.map(r=>r.record));for(const r of value.batch.records)value.records.set(librarySlot(r.record.kind,r.record.key),r);value.batch=null}
  return stored
}
export function localLibraryManagementLedgerRow(event:LocalLibraryManagementEvent):Record<string,string> {
  if(!isLocalLibraryManagementEvent(event))return invalid()
  const request=localWorkbenchJournalCanonical(event),fingerprint=hash(request)
  const row={command_id:event.eventId,fingerprint,operation:LOCAL_LIBRARY_MANAGEMENT_OPERATION,request,result:localWorkbenchJournalCanonical({eventId:event.eventId,eventHash:fingerprint}),created_at:new Date().toISOString()}
  if(Object.values(row).reduce((n,v)=>n+Buffer.byteLength(v),0)>64*1024)return invalid()
  return row
}
export function readLocalLibraryManagementEvent(row:Record<string,unknown>):LocalLibraryManagementEvent {
  if(row.operation!==LOCAL_LIBRARY_MANAGEMENT_OPERATION||!dto.isCollectionId(row.command_id)||!hex(row.fingerprint)||typeof row.request!=='string'||Buffer.byteLength(row.request)>64*1024
    ||typeof row.result!=='string'||Buffer.byteLength(row.result)>64*1024||!ownerLedgerTime(row.created_at))return invalid()
  let event:unknown,result:unknown;try{event=JSON.parse(row.request);result=JSON.parse(row.result)}catch{return invalid()}
  if(!isLocalLibraryManagementEvent(event)||event.eventId!==row.command_id||localWorkbenchJournalCanonical(event)!==row.request||hash(row.request)!==row.fingerprint
    ||!isLocalWorkbenchDataRecord(result,['eventId','eventHash'])||result.eventId!==event.eventId||result.eventHash!==row.fingerprint)return invalid()
  return event
}

/** 每个binding revision必须与本批同原命令的成功回执一起结算；冷尾不能遗失半个管理操作。 */
export function assertLocalLibraryManagementBatch(previous:ReadonlyMap<string,LocalLibraryManagementStored>, records:readonly LocalLibraryManagementRecord[]):void {
  const bindings=records.filter((r):r is LocalLibraryManagementBindingRecord=>r.kind==='binding')
  const operations=records.filter((r):r is LocalLibraryManagementOperationRecord=>r.kind==='operation')
  for(const operation of operations){
    const command=operation.original.command, request=operation.original.request
    const paired=bindings.filter(b=>b.operationId===operation.key)
    if(operation.receipt.state!=='succeeded'){if(paired.length)return invalid();continue}
    const ids=paired.map(b=>b.libraryId)
    if(command==='library.import.confirm'){
      if(paired.length!==1||operation.receipt.libraryIds.length!==1||ids[0]!==operation.receipt.libraryIds[0]
        ||paired[0]!.role!==(request as dto.LocalLibraryManagementPayloads['library.import.confirm']).role||!paired[0]!.active)return invalid()
    }else if(command==='library.rename'||command==='library.remove'||command==='library.watch.set'){
      const wanted=command==='library.remove'?(request as dto.LocalLibraryManagementPayloads['library.remove']).libraryIds:[(request as {libraryId:string}).libraryId]
      if(!librarySame(ids,wanted)||!librarySame(operation.receipt.libraryIds,wanted))return invalid()
      for(const binding of paired){
        const old=previous.get(librarySlot('binding',binding.key))?.record
        if(old?.kind!=='binding'||!old.active||binding.sourceRootId!==old.sourceRootId||binding.rootRevision!==old.rootRevision||binding.role!==old.role)return invalid()
        const expected={...old,revision:binding.revision,operationId:operation.key}
        if(command==='library.rename')expected.name=(request as dto.LocalLibraryManagementPayloads['library.rename']).name
        else if(command==='library.remove'){expected.active=false;expected.watchEnabled=false}
        else expected.watchEnabled=(request as dto.LocalLibraryManagementPayloads['library.watch.set']).enabled
        if(!librarySame(binding,expected))return invalid()
      }
    }else if(paired.length)return invalid()
  }
  if(bindings.some(b=>!operations.some(op=>op.key===b.operationId&&op.receipt.state==='succeeded')))return invalid()
}
export function createLocalLibraryManagementBatchEvents(writes:readonly {record:LocalLibraryManagementRecord;previous:LocalLibraryManagementRecord|null}[]):readonly LocalLibraryManagementEvent[]{
  if(!isLocalWorkbenchDenseArray(writes,101)||!writes.length||new Set(writes.map(w=>librarySlot(w.record.kind,w.record.key))).size!==writes.length)return invalid()
  const batchId=randomUUID()
  return writes.flatMap((write,batchIndex)=>createLocalLibraryManagementEvents(write.record,write.previous).map(event=>({...event,batchId,batchIndex,batchCount:writes.length})))
}

/** 原歌词捕获/本次保存快照独立域；沿唯一Owner原catalog ledger，不复用旧scan lastSuccess。 */
export const LOCAL_LYRICS_ROOT_OPERATION='local-lyrics-root-v1'
export interface LocalLyricsRootResource {rootId:string;relative:string;pin:import('../../library/lyrics-source-format.js').LocalLyricsPhysicalResource|null}
export interface LocalLyricsRootCaptureRecord {
  schema:1;kind:'original-capture';datasetId:string;key:string;revision:1;scope:dto.LocalLyricsScope;ownerEpoch:string;fingerprint:string
  resolved:import('./read-service.js').LocalWorkbenchResolvedReadCapture
  managementCapture:{key:string;ledgerSequence:string;recordSha256:string;originalSha256:string;libraryId:string;sourceRootId:string;rootRevision:string}
  resources:readonly LocalLyricsRootResource[];observations:readonly LocalLyricsInventoryObservation[]
}
export interface LocalLyricsRootPublicationPin {operationId:string;revision:number;ledgerSequence:number;publicationSequence:number;recordSha256:string;publicationSha256:string}
export interface LocalLyricsRootSnapshotAttempt {
  attempt:number;phase:'PREPARED'|'SAVED'|'FAILED';publicationPins:readonly LocalLyricsRootPublicationPin[]
  observations:readonly LocalLyricsInventoryObservation[]|null;observationsSha256:string|null
  resources:readonly LocalLyricsRootResource[]|null;error:'UNAVAILABLE'|'CHANGED'|null
}
export interface LocalLyricsRootSnapshotRecord {
  schema:1;kind:'save-snapshot';datasetId:string;key:string;revision:number
  original:{request:dto.LocalLyricsSaveRequest;scope:dto.LocalLyricsScope;intentSha256:string;captureSha256:string;originalCaptureKey:string}
  attempts:readonly LocalLyricsRootSnapshotAttempt[]
}
export interface LocalLyricsRootRecordMap {'original-capture':LocalLyricsRootCaptureRecord;'save-snapshot':LocalLyricsRootSnapshotRecord}
export type LocalLyricsRootRecordKind=keyof LocalLyricsRootRecordMap
export type LocalLyricsRootRecord=LocalLyricsRootRecordMap[LocalLyricsRootRecordKind]
export const localLyricsRootCaptureKey=(scope:dto.LocalLyricsScope):string=>{if(!dto.isLocalLyricsScope(scope))return invalid();return localLibraryManagementDigest(scope)}
function rootResources(v:unknown):v is readonly LocalLyricsRootResource[]{
  if(!isLocalWorkbenchDenseArray(v,10000)||!v.length)return false
  const names=new Set<string>(),ids=new Set<string>()
  for(const r of v){if(!isLocalWorkbenchDataRecord(r,['rootId','relative','pin'])||!dto.isCollectionId(r.rootId)||!isLocalAlbumPrivateRelative(r.relative))return false
    const key=r.rootId+'\0'+r.relative;if(names.has(key))return false;names.add(key)
    if(r.pin!==null){try{const pin=r.pin as import('../../library/lyrics-source-format.js').LocalLyricsPhysicalResource
      const member={trackId:'physical-observation',rootId:'physical-library',sourceRootId:r.rootId,fileId:'physical-file',rootRevision:'1',fileRevision:'1',locationRevision:'1',metadataRevision:'0'.repeat(64),resourceIndex:0}
      captureLocalLyricsPhysicalGroup({members:[member],resources:[pin]})
      if(pin.rootId!==r.rootId||pin.relative!==r.relative||ids.has(pin.dev+':'+pin.ino))return false;ids.add(pin.dev+':'+pin.ino)
    }catch{return false}}
  }return true
}
function rootObservations(v:unknown,trackIds?:readonly string[]):v is readonly LocalLyricsInventoryObservation[]{
  return isLocalWorkbenchDenseArray(v,10000)&&new Set(v.map(r=>isLocalWorkbenchDataRecord(r,['trackId','lrc','embedded','fileRevision'])?r.trackId:null)).size===v.length
    &&v.every(r=>isLocalWorkbenchDataRecord(r,['trackId','lrc','embedded','fileRevision'])&&dto.isLocalLyricsId(r.trackId)&&dto.isLocalCatalogRevision(r.fileRevision)
      &&['unknown','false','true'].includes(String(r.lrc))&&['unknown','false','true'].includes(String(r.embedded)))
    &&(!trackIds||v.length===trackIds.length&&v.every(r=>isLocalWorkbenchDataRecord(r,['trackId','lrc','embedded','fileRevision'])&&trackIds.includes(String(r.trackId))))
}
export function captureLocalLyricsRootRecord(input:unknown):LocalLyricsRootRecord {
  const v=libraryInput(input)
  if(!v||typeof v!=='object')return invalid()
  const r=v as Record<string,unknown>
  if(r.schema!==1||!dto.isCommandOutboxDatasetId(r.datasetId)||!integer(r.revision,1,Number.MAX_SAFE_INTEGER))return invalid()
  if(r.kind==='original-capture'){
    if(!isLocalWorkbenchDataRecord(r,['schema','kind','datasetId','key','revision','scope','ownerEpoch','fingerprint','resolved','managementCapture','resources','observations'])
      ||r.revision!==1||!dto.isLocalLyricsScope(r.scope)||r.scope.datasetId!==r.datasetId||!hex(r.key)||r.key!==localLyricsRootCaptureKey(r.scope)||!dto.isCollectionId(r.ownerEpoch)||!hex(r.fingerprint))return invalid()
    const p=r.managementCapture
    if(!isLocalWorkbenchDataRecord(p,['key','ledgerSequence','recordSha256','originalSha256','libraryId','sourceRootId','rootRevision'])||!dto.isLocalWorkbenchIdentity(p.key)
      ||typeof p.ledgerSequence!=='string'||!/^[1-9][0-9]{0,15}$/u.test(p.ledgerSequence)||!hex(p.recordSha256)||!hex(p.originalSha256)
      ||p.libraryId!==r.scope.libraryId||!dto.isCollectionId(p.sourceRootId)||!dto.isLocalCatalogRevision(p.rootRevision))return invalid()
    const resolved=r.resolved as import('./read-service.js').LocalWorkbenchResolvedReadCapture
    if(!resolved||!libraryResolved(resolved,{libraryId:p.libraryId as string,sourceRootId:p.sourceRootId,rootRevision:p.rootRevision},r.datasetId as string,resolved.datasetRevision)
      ||resolved.capture.albumId!==r.scope.albumId||r.fingerprint!==localLibraryManagementDigest([r.ownerEpoch,resolved.datasetRevision,resolved.capture])
      ||!rootResources(r.resources)||!rootObservations(r.observations,resolved.group.members.map(m=>m.fact.summary.track.id)))return invalid()
    const names=new Set(resolved.group.members.map(m=>p.sourceRootId+'\0'+m.fact.relative))
    for(const ref of resolved.group.rejectedFiles??[])names.add(p.sourceRootId+'\0'+ref.relative)
    if(names.size!==r.resources.length||r.resources.some(resource=>!names.has(resource.rootId+'\0'+resource.relative)))return invalid()
    for(const observation of r.observations){const m=resolved.group.members.find(m=>m.fact.summary.track.id===observation.trackId)!;if(observation.fileRevision!==m.fact.summary.asset.fileRevision)return invalid()}
    return r as unknown as LocalLyricsRootCaptureRecord
  }
  if(r.kind!=='save-snapshot'||!isLocalWorkbenchDataRecord(r,['schema','kind','datasetId','key','revision','original','attempts']))return invalid()
  const original=r.original
  if(!isLocalWorkbenchDataRecord(original,['request','scope','intentSha256','captureSha256','originalCaptureKey'])||!dto.isLocalLyricsCommandPayload('localLyrics.save',original.request)
    ||!dto.isLocalLyricsScope(original.scope)||original.scope.datasetId!==r.datasetId||r.key!==(original.request as dto.LocalLyricsSaveRequest).commandId
    ||!hex(original.intentSha256)||!hex(original.captureSha256)||original.originalCaptureKey!==localLyricsRootCaptureKey(original.scope)
    ||!isLocalWorkbenchDenseArray(r.attempts,10000)||!r.attempts.length)return invalid()
  for(const [index,a]of r.attempts.entries()){
    if(!isLocalWorkbenchDataRecord(a,['attempt','phase','publicationPins','observations','observationsSha256','resources','error'])||a.attempt!==index+1||!['PREPARED','SAVED','FAILED'].includes(String(a.phase))
      ||!isLocalWorkbenchDenseArray(a.publicationPins,10000)||new Set(a.publicationPins.map(p=>isLocalWorkbenchDataRecord(p,['operationId','revision','ledgerSequence','publicationSequence','recordSha256','publicationSha256'])?p.operationId:null)).size!==a.publicationPins.length
      ||a.publicationPins.some((p,i)=>!isLocalWorkbenchDataRecord(p,['operationId','revision','ledgerSequence','publicationSequence','recordSha256','publicationSha256'])||!hex(p.operationId)||!integer(p.revision,1,Number.MAX_SAFE_INTEGER)
        ||!integer(p.ledgerSequence,1,Number.MAX_SAFE_INTEGER)||!integer(p.publicationSequence,1,Number.MAX_SAFE_INTEGER)||p.publicationSequence>p.ledgerSequence||!hex(p.recordSha256)||!hex(p.publicationSha256)
        ||i>0&&Number((a.publicationPins as LocalLyricsRootPublicationPin[])[i-1]!.publicationSequence)>=Number(p.publicationSequence))
      ||a.observations!==null&&!rootObservations(a.observations)||a.resources!==null&&!rootResources(a.resources)
      ||(a.observations===null?a.observationsSha256!==null:a.observationsSha256!==localLibraryManagementDigest(a.observations))
      ||!['UNAVAILABLE','CHANGED',null].includes(a.error as never))return invalid()
    if(index<r.attempts.length-1&&a.phase!=='FAILED'||a.phase==='PREPARED'&&(a.observations!==null||a.resources!==null||a.error!==null)
      ||a.phase==='SAVED'&&(a.error!==null||a.observations===null||a.resources===null||!a.publicationPins.length||a.resources.some(resource=>resource.pin===null))
      ||a.phase==='FAILED'&&a.error===null)return invalid()
  }
  return r as unknown as LocalLyricsRootSnapshotRecord
}
export function assertLocalLyricsRootTransition(previous:LocalLyricsRootRecord|null,next:LocalLyricsRootRecord):void{
  const n=captureLocalLyricsRootRecord(next),p=previous?captureLocalLyricsRootRecord(previous):null
  if((p?.revision??0)+1!==n.revision)return invalid()
  if(!p){if(n.kind==='save-snapshot'&&(n.attempts.length!==1||n.attempts[0]!.phase!=='PREPARED'))return invalid();return}
  if(p.kind!==n.kind||p.datasetId!==n.datasetId||p.key!==n.key||p.kind==='original-capture'||n.kind!=='save-snapshot')return invalid()
  if(!librarySame(p.original,n.original))return invalid()
  const old=p.attempts,last=old.at(-1)!,updated=n.attempts
  if(last.phase==='SAVED')return invalid()
  if(last.phase==='FAILED'){
    if(updated.length!==old.length+1||!librarySame(updated.slice(0,-1),old)||updated.at(-1)!.phase!=='PREPARED')return invalid()
  }else if(updated.length!==old.length||!librarySame(updated.slice(0,-1),old.slice(0,-1))||updated.at(-1)!.phase==='PREPARED'
    ||!librarySame(last.publicationPins,updated.at(-1)!.publicationPins))return invalid()
}
interface LocalLyricsRootEvent {datasetId:string;eventId:string;transactionId:string;kind:LocalLyricsRootRecordKind;key:string;revision:number;bytes:number;sha256:string;chunks:number;index:number;payload:string}
export interface LocalLyricsRootProjection {highWater:number;datasetId:string;records:Map<string,LocalLyricsRootRecord>;pending:null|{header:Omit<LocalLyricsRootEvent,'eventId'|'index'|'payload'>;parts:Buffer[];bytes:number}}
export function emptyLocalLyricsRootProjection(datasetId:string):LocalLyricsRootProjection{if(!dto.isCommandOutboxDatasetId(datasetId))return invalid();return {highWater:0,datasetId,records:new Map(),pending:null}}
export function copyLocalLyricsRootProjection(p:LocalLyricsRootProjection):LocalLyricsRootProjection{if(p.pending)return invalid();return {...p,records:new Map(p.records),pending:null}}
export function assertLocalLyricsRootComplete(p:LocalLyricsRootProjection):void{if(p.pending)return invalid()}
export function createLocalLyricsRootEvents(input:LocalLyricsRootRecord,previous:LocalLyricsRootRecord|null):readonly LocalLyricsRootEvent[]{
  const record=captureLocalLyricsRootRecord(input);assertLocalLyricsRootTransition(previous,record);const raw=Buffer.from(localWorkbenchJournalCanonical(record))
  if(raw.length<1||raw.length>LOCAL_LIBRARY_MANAGEMENT_BYTES)return invalid()
  const chunks=Math.ceil(raw.length/(40*1024)),transactionId=randomUUID()
  return Array.from({length:chunks},(_,index)=>({datasetId:record.datasetId,eventId:randomUUID(),transactionId,kind:record.kind,key:record.key,revision:record.revision,bytes:raw.length,sha256:hash(raw),chunks,index,payload:raw.subarray(index*40*1024,(index+1)*40*1024).toString('base64')}))
}
function rootEvent(input:unknown):input is LocalLyricsRootEvent{
  if(!isLocalWorkbenchDataRecord(input,['datasetId','eventId','transactionId','kind','key','revision','bytes','sha256','chunks','index','payload'])||!dto.isCommandOutboxDatasetId(input.datasetId)
    ||!dto.isCollectionId(input.eventId)||!dto.isCollectionId(input.transactionId)||!['original-capture','save-snapshot'].includes(String(input.kind))||(input.kind==='original-capture'?!hex(input.key):!dto.isCollectionId(input.key))||!hex(input.sha256)
    ||!integer(input.revision,1,Number.MAX_SAFE_INTEGER)||!integer(input.bytes,1,LOCAL_LIBRARY_MANAGEMENT_BYTES)||!integer(input.chunks,1,Math.ceil(LOCAL_LIBRARY_MANAGEMENT_BYTES/(40*1024)))
    ||input.chunks!==Math.ceil(Number(input.bytes)/(40*1024))||!integer(input.index,0,Number(input.chunks)-1)||typeof input.payload!=='string'||input.payload.length>Math.ceil(40*1024/3)*4)return false
  const raw=Buffer.from(input.payload,'base64'),expected=input.index===Number(input.chunks)-1?Number(input.bytes)-Number(input.index)*40*1024:40*1024
  return raw.length===expected&&raw.toString('base64')===input.payload
}
export function localLyricsRootLedgerRow(event:LocalLyricsRootEvent):Record<string,string>{if(!rootEvent(event))return invalid();const frame=localWorkbenchJournalCanonical(event);return {command_id:event.eventId,operation:LOCAL_LYRICS_ROOT_OPERATION,fingerprint:hash(frame),request:frame,result:localWorkbenchJournalCanonical({eventId:event.eventId,sha256:event.sha256}),created_at:new Date().toISOString()}}
export function readLocalLyricsRootEvent(row:Record<string,unknown>):LocalLyricsRootEvent{
  if(row.operation!==LOCAL_LYRICS_ROOT_OPERATION||typeof row.request!=='string'||Buffer.byteLength(row.request)>64*1024||typeof row.result!=='string'||!dto.isCollectionId(row.command_id)||typeof row.created_at!=='string'||!Number.isFinite(Date.parse(row.created_at)))return invalid()
  const event:unknown=JSON.parse(row.request);if(!rootEvent(event)||event.eventId!==row.command_id||row.request!==localWorkbenchJournalCanonical(event)||row.fingerprint!==hash(row.request)||row.result!==localWorkbenchJournalCanonical({eventId:event.eventId,sha256:event.sha256}))return invalid();return event
}
export function projectLocalLyricsRootEvent(p:LocalLyricsRootProjection,event:LocalLyricsRootEvent,sequence:number):LocalLyricsRootRecord|null{
  if(!rootEvent(event)||event.datasetId!==p.datasetId||!integer(sequence,p.highWater+1,Number.MAX_SAFE_INTEGER))return invalid()
  const {eventId:_id,index:_index,payload:_payload,...header}=event
  if(!p.pending){if(event.index!==0)return invalid();p.pending={header,parts:[],bytes:0}}
  const pending=p.pending;if(!librarySame(pending.header,header)||event.index!==pending.parts.length)return invalid()
  const raw=Buffer.from(event.payload,'base64');pending.parts.push(raw);pending.bytes+=raw.length;if(pending.bytes>event.bytes)return invalid();p.highWater=sequence
  if(event.index!==event.chunks-1)return null
  const bytes=Buffer.concat(pending.parts);if(bytes.length!==event.bytes||hash(bytes)!==event.sha256)return invalid()
  const record=captureLocalLyricsRootRecord(JSON.parse(bytes.toString('utf8')))
  if(localWorkbenchJournalCanonical(record)!==bytes.toString('utf8')||record.kind!==event.kind||record.key!==event.key||record.datasetId!==event.datasetId||record.revision!==event.revision)return invalid()
  const slot=record.kind+':'+record.key;assertLocalLyricsRootTransition(p.records.get(slot)??null,record);p.records.set(slot,record);p.pending=null;return record
}
