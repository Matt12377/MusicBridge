import type { DatabaseSync } from 'node:sqlite';

type Update=(rootId:string,relative:string,jobId:string,batchId:string,before:string,after:string)=>()=>void;
const ports=new WeakMap<DatabaseSync,Update>();
/** 原扫描作者安装同连接同步更新闭包；此叶模块不导入 catalog、journal 或 scan store。 */
export function installSourceWriteScanPort(db:DatabaseSync,update:Update):void{if(!ports.has(db))ports.set(db,update);}
export function updateSourceWriteScanFacts(db:DatabaseSync,rootId:string,relative:string,jobId:string,batchId:string,before:string,after:string):()=>void {
  const update=ports.get(db);if(!update)throw new Error('源写缺少原扫描作者的同连接事实接点。');return update(rootId,relative,jobId,batchId,before,after);
}
