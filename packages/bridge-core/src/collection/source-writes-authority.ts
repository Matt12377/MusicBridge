import { MessagePort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { sourceWritesFail } from './local-source-writes-journal.js';

export interface SourceWritesMainActor {readonly authorityId:string;readonly active:boolean}
const actors=new WeakSet<object>();
/** 只在已转移的专用物理端口安装；普通命令 DTO 或 grant JSON 不能创建此对象身份。 */
export function createSourceWritesMainActor(port:MessagePort):SourceWritesMainActor {
  if(!(port instanceof MessagePort))return sourceWritesFail('GRANT_REQUIRED');let active=true;
  const actor=Object.freeze({authorityId:randomUUID(),get active(){return active;}});actors.add(actor);
  port.once('close',()=>{active=false;});port.once('messageerror',()=>{active=false;});return actor;
}
export function assertSourceWritesMainActor(actor:unknown):asserts actor is SourceWritesMainActor {
  if(!actor||typeof actor!=='object'||!actors.has(actor)||!(actor as SourceWritesMainActor).active)return sourceWritesFail('GRANT_REQUIRED');
}
