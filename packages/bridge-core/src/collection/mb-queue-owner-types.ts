import {isMBQueueRecord,isCollectionId,isLocalCatalogRevision,type MBQueueRecord} from '@music-bridge/contracts';
export interface MBQueueNeedsReview {status:'NEEDS_REVIEW';queueId:string;revision:string}
export interface MBQueueUnavailable {status:'UNAVAILABLE'}
export type MBQueueLoadResult=MBQueueRecord|MBQueueNeedsReview|MBQueueUnavailable|null;
export function isMBQueueUnavailable(v:unknown):v is MBQueueUnavailable {return typeof v==='object'&&v!==null&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===1&&Object.prototype.propertyIsEnumerable.call(v,'status')&&(v as Record<string,unknown>).status==='UNAVAILABLE';}
export function isMBQueueNeedsReview(v:unknown):v is MBQueueNeedsReview{
 if(typeof v!=='object'||v===null||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;
 const value=v as Record<string,unknown>;return Reflect.ownKeys(value).length===3&&Object.keys(value).length===3&&value.status==='NEEDS_REVIEW'&&isCollectionId(value.queueId)&&isLocalCatalogRevision(value.revision);
}
export function isMBQueueLoadResult(v:unknown):v is MBQueueLoadResult{return v===null||isMBQueueRecord(v)||isMBQueueNeedsReview(v)||isMBQueueUnavailable(v);}
