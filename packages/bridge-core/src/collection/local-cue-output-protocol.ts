import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import type { DatasetIdentity } from '../recording/dataset-identity.js';
import type { RootCapability } from '../recording/source-files.js';
import { isLocalWorkbenchDataRecord as closed, isLocalWorkbenchDenseArray as dense } from './local-library-workbench/types.js';

export const LOCAL_CUE_OUTPUT_OPERATION = 'local-cue-output-v1';
export interface LocalCueStagedOutput {
  itemId: string; outputName: string; stageName: string; bytes: number; sha256: string; dev: string; ino: string;
}
export interface LocalCueOutputRecord {
  schema: 1; request: dto.LocalWorkbenchApplyRequest; revision: number;
  phase: 'prepared' | 'encoding' | 'staged' | 'publishing' | 'cancelling' | 'failing' | 'quiet' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  outputRoot: RootCapability | null; stageDirectory: string | null; staged: readonly LocalCueStagedOutput[];
  published: readonly string[]; physicalClosed: boolean; receipt: dto.LocalWorkbenchReceipt;
}
export interface LocalCueOutputStore {
  read(identity: DatasetIdentity, commandId: string): { record: LocalCueOutputRecord; ledgerSequence: string } | null;
  compareAndSwap(identity: DatasetIdentity, record: LocalCueOutputRecord, expectedRevision: number | null): { ledgerSequence: string };
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const cueOutputCanonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(cueOutputCanonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,entry]) => JSON.stringify(key) + ':' + cueOutputCanonical(entry)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
};
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,31})$/u.test(value);
export const isCueOutputName = (value: unknown): value is string => typeof value === 'string' && Buffer.byteLength(value) > 0
  && Buffer.byteLength(value) <= 240 && value !== '.' && value !== '..' && !/[\\/\u0000-\u001f\u007f]/u.test(value) && path.basename(value) === value;
export function isLocalCueOutputRecord(value: unknown): value is LocalCueOutputRecord {
  if (!closed(value,['schema','request','revision','phase','outputRoot','stageDirectory','staged','published','physicalClosed','receipt'])
    || value.schema !== 1 || !dto.isLocalWorkbenchApplyRequest(value.request) || value.request.kind !== 'cue'
    || !integer(value.revision,0,Number.MAX_SAFE_INTEGER) || !['prepared','encoding','staged','publishing','cancelling','failing','quiet','succeeded','failed','cancelled','unknown'].includes(String(value.phase))
    || typeof value.physicalClosed !== 'boolean' || !dto.isLocalWorkbenchReceipt(value.receipt,value.request)
    || !dense(value.staged,9900) || !dense(value.published,9900) || value.published.length > value.staged.length) return false;
  if (value.outputRoot !== null && (!closed(value.outputRoot,['id','path','dev','ino','authorized','label'])
    || !dto.isCollectionId(value.outputRoot.id) || typeof value.outputRoot.path !== 'string' || !path.isAbsolute(value.outputRoot.path)
    || path.resolve(value.outputRoot.path) !== value.outputRoot.path || !decimal(value.outputRoot.dev) || !decimal(value.outputRoot.ino)
    || value.outputRoot.authorized !== true || !dto.isLocalWorkbenchText(value.outputRoot.label))) return false;
  if (value.stageDirectory !== null && !isCueOutputName(value.stageDirectory)) return false;
  if (!value.staged.every(item => closed(item,['itemId','outputName','stageName','bytes','sha256','dev','ino'])
    && dto.isLocalWorkbenchIdentity(item.itemId) && isCueOutputName(item.outputName) && isCueOutputName(item.stageName)
    && integer(item.bytes,1,256*1024*1024) && digest(item.sha256) && decimal(item.dev) && decimal(item.ino))
    || new Set(value.staged.map(item=>(item as LocalCueStagedOutput).itemId)).size !== value.staged.length
    || new Set(value.staged.map(item=>(item as LocalCueStagedOutput).outputName.normalize('NFC').toLocaleLowerCase('en-US'))).size !== value.staged.length
    || !value.published.every(id => typeof id === 'string' && (value.staged as LocalCueStagedOutput[]).some(item=>item.itemId===id))
    || new Set(value.published).size !== value.published.length) return false;
  const receipt=value.receipt,published=new Set(value.published);
  if (value.phase === 'succeeded' && (value.receipt.state !== 'succeeded' || !value.physicalClosed || value.staged.length !== value.published.length)
    || ['failed','cancelled'].includes(String(value.phase)) && (!value.physicalClosed || value.receipt.state !== value.phase
      || !value.published.every(id => receipt.items.some(item => item.itemId === id && item.state === 'applied'))
      || !receipt.items.every(item => published.has(item.itemId) ? item.state === 'applied' : item.state === (value.phase==='cancelled'?'cancelled':'not-written'))
      || value.published.length > 0 && (value.outputRoot === null || value.stageDirectory === null || value.staged.length !== value.receipt.items.length))
    || ['cancelling','failing'].includes(String(value.phase)) && (value.physicalClosed || value.receipt.state !== 'unknown'
      || value.published.length > 0 && (value.outputRoot === null || value.stageDirectory === null || value.staged.length !== value.receipt.items.length))
    || value.phase === 'unknown' && value.receipt.state !== 'unknown'
    || ['prepared','encoding','staged','publishing','quiet'].includes(String(value.phase)) && value.receipt.state !== 'running'
    || ['staged','publishing','succeeded'].includes(String(value.phase)) && (value.outputRoot === null || value.stageDirectory === null || value.staged.length !== value.receipt.items.length)) return false;
  return Buffer.byteLength(cueOutputCanonical(value)) <= 32*1024*1024;
}
const CHUNK_BYTES = 32*1024;
interface EventCommon { datasetId:string; eventId:string; transactionId:string; commandId:string; expectedRevision:number|null; revision:number; bytes:number; sha256:string; chunks:number }
export type LocalCueOutputEvent = EventCommon & ({kind:'chunk'; index:number; payload:string}|{kind:'commit'});
export function isLocalCueOutputEvent(value:unknown):value is LocalCueOutputEvent {
  if (!closed(value,['datasetId','eventId','transactionId','commandId','expectedRevision','revision','bytes','sha256','chunks','kind'],['index','payload'])
    || ![value.datasetId,value.eventId,value.transactionId,value.commandId].every(dto.isCollectionId)
    || !integer(value.revision,0,Number.MAX_SAFE_INTEGER) || value.expectedRevision !== null && !integer(value.expectedRevision,0,Number.MAX_SAFE_INTEGER-1)
    || value.revision !== (value.expectedRevision === null ? 0 : Number(value.expectedRevision)+1)
    || !integer(value.bytes,1,32*1024*1024) || !digest(value.sha256)
    || value.chunks !== Math.ceil(Number(value.bytes)/CHUNK_BYTES)) return false;
  if (value.kind === 'commit') return !Object.hasOwn(value,'index') && !Object.hasOwn(value,'payload');
  if (value.kind !== 'chunk' || !integer(value.index,0,Number(value.chunks)-1) || typeof value.payload !== 'string') return false;
  const body=Buffer.from(value.payload,'base64');
  return body.toString('base64')===value.payload && body.length===Math.min(CHUNK_BYTES,Number(value.bytes)-Number(value.index)*CHUNK_BYTES);
}
export function createLocalCueOutputEvents(record:LocalCueOutputRecord,expectedRevision:number|null):readonly LocalCueOutputEvent[] {
  if (!isLocalCueOutputRecord(record) || record.revision !== (expectedRevision===null?0:expectedRevision+1)) throw new Error('CUE原操作或CAS链无效。');
  const bytes=Buffer.from(cueOutputCanonical(record)), common={datasetId:record.request.datasetId,commandId:record.request.commandId,
    transactionId:randomUUID(),expectedRevision,revision:record.revision,bytes:bytes.length,sha256:hash(bytes),chunks:Math.ceil(bytes.length/CHUNK_BYTES)};
  const events:LocalCueOutputEvent[]=[];
  for(let index=0;index<common.chunks;index++) events.push({...common,eventId:randomUUID(),kind:'chunk',index,payload:bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES).toString('base64')});
  events.push({...common,eventId:randomUUID(),kind:'commit'}); return events;
}
export interface LocalCueOutputProjection {
  latest: Map<string,{record:LocalCueOutputRecord;ledgerSequence:string}>;
  pending: { common: Omit<EventCommon,'eventId'>; parts:Buffer[] } | null;
}
export function projectLocalCueOutputEvent(projection:LocalCueOutputProjection,event:LocalCueOutputEvent,sequence:number):void {
  if (!isLocalCueOutputEvent(event) || !Number.isSafeInteger(sequence) || sequence<1) throw new Error('CUE日志完整性无效。');
  const previous=projection.latest.get(event.commandId);
  if ((previous?.record.revision??null)!==event.expectedRevision) throw new Error('CUE原操作CAS链已改变。');
  const {eventId:_id,kind:_kind,...fields}=event; const {index:_index,payload:_payload,...common}=fields as EventCommon&{index?:number;payload?:string};
  if(event.kind==='chunk'){
    if(event.index===0){if(projection.pending)throw new Error('CUE日志缺少commit。');projection.pending={common,parts:[]};}
    if(!projection.pending || cueOutputCanonical(projection.pending.common)!==cueOutputCanonical(common) || projection.pending.parts.length!==event.index)throw new Error('CUE日志块顺序无效。');
    projection.pending.parts.push(Buffer.from(event.payload,'base64'));return;
  }
  if(!projection.pending || cueOutputCanonical(projection.pending.common)!==cueOutputCanonical(common) || projection.pending.parts.length!==event.chunks)throw new Error('CUE日志不完整。');
  const bytes=Buffer.concat(projection.pending.parts);if(bytes.length!==event.bytes || hash(bytes)!==event.sha256)throw new Error('CUE日志摘要不一致。');
  const record:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!isLocalCueOutputRecord(record)||cueOutputCanonical(record)!==bytes.toString('utf8') || record.request.datasetId!==event.datasetId
    || record.request.commandId!==event.commandId || record.revision!==event.revision
    || previous && cueOutputCanonical(previous.record.request)!==cueOutputCanonical(record.request))throw new Error('CUE原意图已改变。');
  projection.latest.set(event.commandId,{record,ledgerSequence:String(sequence)});projection.pending=null;
}
