import type { RecordingPrintStore } from './print-store.js';
import { printFail } from './print-integrity.js';

/** 全部行为绑定当前工作库；仅数据/打印任务，不持有录音driver或设备认证。 */
export function createRecordingPrintCoordinator({store,assertCurrent}:{store:RecordingPrintStore;assertCurrent:()=>void}){
 let closed=false;
 const guard=<K extends keyof RecordingPrintStore>(name:K)=>(request:Parameters<RecordingPrintStore[K]>[0]):ReturnType<RecordingPrintStore[K]>=>{
  if(closed)printFail('CLOSED');assertCurrent();
  const method=store[name] as (value:Parameters<RecordingPrintStore[K]>[0])=>ReturnType<RecordingPrintStore[K]>;
  return method(structuredClone(request));
 };
 return {artworkGet:guard('artworkGet'),artworkSave:guard('artworkSave'),list:guard('list'),request:guard('request'),retry:guard('retry'),get:guard('get'),claim:guard('claim'),complete:guard('complete'),fail:guard('fail'),pdf:guard('pdf'),close(){closed=true;}};
}
export type RecordingPrintCoordinator=ReturnType<typeof createRecordingPrintCoordinator>;
