import { physicalResourceLocks, type PhysicalResourceCoordinator, type PhysicalResource, type PhysicalResourceGuard } from './physical-resource-locks.js';
import { fstatSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export type PhysicalClaimsState = 'held' | 'released' | 'unverified';
/** 保留原协调器的 guards；错误不是已经释放的证据。 */
export class PhysicalClaimsUnverified extends Error {
  constructor(readonly claims: PhysicalReadClaims, readonly reason: 'RELEASE_UNVERIFIED' | 'COMMIT_UNVERIFIED', cause?: unknown) {
    super('物理保护结果尚未核实，原保护保留，禁止继续准入。', { cause });
  }
}
export interface PhysicalReadClaims {
  readonly resources: readonly PhysicalResource[];
  readonly state: PhysicalClaimsState;
  retain(): void;
  release(): Promise<void>;
}

export interface PhysicalWriteClaims extends PhysicalReadClaims { readonly mode:'write' }
interface WriteDescriptor {handle:FileHandle;fd:number;dev:string;ino:string;quiet:boolean}
interface WriteGuard {guard:PhysicalResourceGuard;resources:readonly PhysicalResource[];released:boolean}
interface WriteGroup {
  coordinator:PhysicalResourceCoordinator;resources:readonly PhysicalResource[];guards:WriteGuard[];
  descriptors:WriteDescriptor[]|null;active:boolean;transferring:boolean;complete:boolean;releaseUnverified:boolean;
  state:PhysicalClaimsState;releasing:Promise<void>|undefined;
}
// 真实性来自作者内对象身份；移交后的旧品牌没有任何释放/登记/再次移交能力。
const writeGroups=new WeakMap<object,WriteGroup>();
const key=(r:PhysicalResource):string=>`${BigInt(r.dev)}:${BigInt(r.ino)}`;
function selectedResources(resources:readonly PhysicalResource[],inputLimit=2048):readonly PhysicalResource[]{
  if(!Array.isArray(resources)||!resources.length||resources.length>inputLimit)throw new Error('源写保护集合超出原容量。');
  const unique=new Map<string,PhysicalResource>();
  for(const item of resources){if(!item||typeof item.dev!=='string'||typeof item.ino!=='string'||!/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(item.dev)||!/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(item.ino))throw new Error('源写物理身份无效。');const r=Object.freeze({dev:BigInt(item.dev).toString(),ino:BigInt(item.ino).toString()});unique.set(key(r),r);}
  if(unique.size>2048)throw new Error('源写保护集合超出原容量。');return Object.freeze([...unique.values()].sort((a,b)=>BigInt(a.dev)<BigInt(b.dev)?-1:BigInt(a.dev)>BigInt(b.dev)?1:BigInt(a.ino)<BigInt(b.ino)?-1:BigInt(a.ino)>BigInt(b.ino)?1:0));
}
function activeWriteGroup(value:unknown):WriteGroup{
  const group=value&&typeof value==='object'?writeGroups.get(value):undefined;
  if(!group?.active)throw new Error('源写保护缺少当前作者的真实持有证明。');return group;
}
const allHeld=(group:WriteGroup):boolean=>group.complete&&!group.releaseUnverified&&group.guards.every(g=>!g.released);
function covered(group:WriteGroup,resources:readonly PhysicalResource[]):void{
  const held=new Set(group.resources.map(key));if(resources.some(v=>!held.has(key(v))))throw new Error('源写保护未覆盖全部真实资源。');
}
export function assertPhysicalWriteClaims(value:unknown,resources:readonly PhysicalResource[]):asserts value is PhysicalWriteClaims{
  const group=activeWriteGroup(value);if(group.state!=='held'||!allHeld(group))throw new Error('源写保护状态尚未核实。');covered(group,resources);
}
/** 恢复只读观察沿原真实guards；部分释放、伪对象、旧品牌都不能冒充仍独占。 */
export function assertRetainedPhysicalWriteClaims(value:unknown,resources:readonly PhysicalResource[]):asserts value is PhysicalWriteClaims{
  const group=activeWriteGroup(value);if(group.state==='released'||!allHeld(group))throw new Error('恢复保护没有完整真实持有证明。');covered(group,resources);
}
function capturedDescriptors(handles:readonly FileHandle[]):WriteDescriptor[]{
  if(!Array.isArray(handles)||handles.length>4096)throw new Error('源写FD登记无效。');
  return [...new Set(handles)].map(handle=>{const fd=handle.fd;if(!Number.isSafeInteger(fd)||fd<0)throw new Error('源写FD尚未取得。');const stat=fstatSync(fd,{bigint:true});return {handle,fd,dev:String(stat.dev),ino:String(stat.ino),quiet:false};});
}
function descriptorIdentity(entry:WriteDescriptor):void{
  if(entry.handle.fd>=0){if(entry.quiet||entry.handle.fd!==entry.fd)throw new Error('保留FD身份已经改变。');const info=fstatSync(entry.fd,{bigint:true});if(String(info.dev)!==entry.dev||String(info.ino)!==entry.ino)throw new Error('保留FD身份已经改变。');return;}
  if(entry.quiet)return; // 已在真实close之后以原fd的EBADF留下证明；FD号码可随后被OS正常重用。
  try{fstatSync(entry.fd);throw new Error('原FD号码尚未证明已关闭。');}catch(error){if((error as NodeJS.ErrnoException).code!=='EBADF')throw error;entry.quiet=true;}
}
function descriptorCoverage(group:WriteGroup,entries:readonly WriteDescriptor[]):void{
  const actual=new Set(entries.map(v=>`${v.dev}:${v.ino}`));if(group.resources.some(r=>!actual.has(key(r))))throw new Error('源写FD未完整覆盖claims。');
}
/** publisher在任何目标移动前登记全部真实FD；外部不能提交FD列表换取quiet。 */
export function registerPhysicalWriteClaimDescriptors(claims:PhysicalWriteClaims,handles:readonly FileHandle[]):void{
  assertPhysicalWriteClaims(claims,[]);const group=activeWriteGroup(claims);if(group.transferring||group.descriptors)throw new Error('源写FD登记无效。');const entries=capturedDescriptors(handles);descriptorCoverage(group,entries);group.descriptors=entries;
}
/** 仅当前真实品牌可得到其已登记句柄；不向公开IPC传递FD。 */
export function physicalWriteClaimDescriptors(claims:PhysicalWriteClaims):readonly FileHandle[]{
  assertRetainedPhysicalWriteClaims(claims,[]);const entries=activeWriteGroup(claims).descriptors;if(!entries)throw new Error('源写FD尚未登记。');entries.forEach(descriptorIdentity);return Object.freeze(entries.map(e=>e.handle));
}
/** 实际join/close与guard释放分开；QUIET必须在此成功后、guards仍持有时落盘。 */
export async function closePhysicalWriteClaimDescriptors(claims:PhysicalWriteClaims):Promise<void>{
  assertRetainedPhysicalWriteClaims(claims,[]);const group=activeWriteGroup(claims),entries=group.descriptors;if(group.transferring||!entries)throw new Error('缺少可核对的保留FD。');entries.forEach(descriptorIdentity);
  const results=await Promise.allSettled(entries.filter(e=>!e.quiet).map(e=>e.handle.close()));
  let failure:unknown;for(const entry of entries)try{descriptorIdentity(entry);if(!entry.quiet)throw new Error('真实FD尚未quiet。');}catch(error){failure??=error;}
  if(failure){group.state='unverified';throw new PhysicalClaimsUnverified(claims,'RELEASE_UNVERIFIED',failure);}
  // close返回错误但全部真实FD均已EBADF，仍以实际quiet为准；不据普通错误伪称FD活着。
  void results;
}
async function releaseWriteGroup(claims:PhysicalWriteClaims,group:WriteGroup,afterQuiet:boolean):Promise<void>{
  if(!group.active||group.transferring)throw new Error('已移交或正在移交的旧保护不能释放。');
  if(group.state==='released')return;if(group.releasing)return group.releasing;
  if(group.releaseUnverified||!group.complete)throw new PhysicalClaimsUnverified(claims,'RELEASE_UNVERIFIED');
  if(group.state==='unverified'&&!afterQuiet)throw new PhysicalClaimsUnverified(claims,'COMMIT_UNVERIFIED');
  group.releasing=(async()=>{const live=group.guards.filter(entry=>!entry.released);
    try{if(live.length)await group.coordinator.releasePhysicalWriteGuards(live.map(e=>e.guard));for(const entry of live)entry.released=true;group.state='released';}
    catch(error){group.state='unverified';group.releaseUnverified=true;throw new PhysicalClaimsUnverified(claims,'RELEASE_UNVERIFIED',error);}})();return group.releasing;
}
function writeClaim(group:WriteGroup):PhysicalWriteClaims{
  const claims:PhysicalWriteClaims={mode:'write',get resources(){return group.resources;},get state(){return group.state;},retain(){if(!group.active||group.transferring||group.state==='released')throw new Error('旧品牌或已释放的保护不能伪造重新持有。');group.state='unverified';},release(){return releaseWriteGroup(claims,group,false);}};
  writeGroups.set(claims,group);return Object.freeze(claims);
}
/** 仅显式收口调用；真实FDquiet证明仍必经，不据COMMIT回执或普通错误推断释放。 */
export async function releaseRetainedPhysicalWriteClaims(claims:PhysicalWriteClaims):Promise<void>{
  const group=activeWriteGroup(claims);await closePhysicalWriteClaimDescriptors(claims);await releaseWriteGroup(claims,group,true);
}
/** 新作者分组取得同一原协调器；128是单批上限，旧2048总容量不变。 */
export async function acquirePhysicalWriteClaims(resources:readonly PhysicalResource[],coordinator:PhysicalResourceCoordinator=physicalResourceLocks):Promise<PhysicalWriteClaims>{
  const selected=selectedResources(resources),group:WriteGroup={coordinator,resources:selected,guards:[],descriptors:null,active:true,transferring:false,complete:false,releaseUnverified:false,state:'held',releasing:undefined},claims=writeClaim(group);
  try{for(let offset=0;offset<selected.length;offset+=128){const batch=selected.slice(offset,offset+128);group.guards.push({guard:coordinator.acquireWrite(batch),resources:batch,released:false});}group.complete=true;return claims;}
  catch(error){group.complete=true;try{await claims.release();}catch(releaseError){throw new PhysicalClaimsUnverified(claims,'RELEASE_UNVERIFIED',releaseError);}throw error;}
}
/** 仅整组能力移交；旧guards不释放，新增guards齐备后同步让旧品牌失权。 */
export async function transferPhysicalWriteClaims(previous:PhysicalWriteClaims,resources:readonly PhysicalResource[],handles:readonly FileHandle[]):Promise<PhysicalWriteClaims>{
  assertRetainedPhysicalWriteClaims(previous,[]);const old=activeWriteGroup(previous);if(old.transferring||old.releasing||!old.descriptors)throw new Error('整组源写保护不能重复移交。');
  old.descriptors.forEach(descriptorIdentity);const captured=capturedDescriptors(handles),byHandle=new Map(old.descriptors.map(e=>[e.handle,e]));for(const entry of captured){const known=byHandle.get(entry.handle);if(known&&(known.fd!==entry.fd||known.dev!==entry.dev||known.ino!==entry.ino||known.quiet))throw new Error('移交FD身份已经改变。');byHandle.set(entry.handle,known??entry);}
  if(byHandle.size>4096)throw new Error('整组移交FD超过原有界集合。');const selected=selectedResources([...old.resources,...resources],4096),entries=[...byHandle.values()],temporary:WriteGroup={...old,resources:selected,descriptors:entries};descriptorCoverage(temporary,entries);
  const held=new Set(old.resources.map(key)),added=selected.filter(r=>!held.has(key(r))),guards:WriteGuard[]=[];old.transferring=true;
  try{
    for(let offset=0;offset<added.length;offset+=128){const batch=added.slice(offset,offset+128);guards.push({guard:old.coordinator.acquireWrite(batch),resources:batch,released:false});}
    old.descriptors.forEach(descriptorIdentity);captured.forEach(descriptorIdentity);if(!allHeld(old)||!old.active)throw new Error('整组保护在移交期间已改变。');
    const group:WriteGroup={coordinator:old.coordinator,resources:selected,guards:[...old.guards,...guards],descriptors:entries,active:true,transferring:false,complete:true,releaseUnverified:false,state:'held',releasing:undefined},next=writeClaim(group);
    old.active=false;old.transferring=false;old.state='unverified';return next;
  }catch(error){
    let failure:unknown;try{if(guards.length)await old.coordinator.releasePhysicalWriteGuards(guards.map(g=>g.guard));for(const entry of guards)entry.released=true;}catch(releaseError){failure=releaseError;}
    old.transferring=false;if(failure){old.guards.push(...guards.filter(g=>!g.released));old.resources=selectedResources([...old.resources,...guards.filter(g=>!g.released).flatMap(g=>g.resources)]);old.descriptors=entries;old.state='unverified';old.releaseUnverified=true;throw new PhysicalClaimsUnverified(previous,'RELEASE_UNVERIFIED',failure);}throw error;
  }
}

/** 一次最多原有 2048 槽；128 是 acquire 调用上限，不是旧母版曲数上限。 */
export async function acquirePhysicalReadClaims(resources: readonly PhysicalResource[], coordinator: PhysicalResourceCoordinator = physicalResourceLocks): Promise<PhysicalReadClaims> {
  if (!Array.isArray(resources) || !resources.length || resources.length > 2048) throw new Error('物理保护集合无效或超过原容量。');
  const unique = new Map<string, PhysicalResource>();
  for (const resource of resources) {
    if (!resource || typeof resource.dev !== 'string' || typeof resource.ino !== 'string' || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(resource.dev) || !/^(0|[1-9][0-9]{0,31}|-[1-9][0-9]{0,30})$/u.test(resource.ino)) throw new Error('物理保护身份无效。');
    const normalized = { dev: BigInt(resource.dev).toString(), ino: BigInt(resource.ino).toString() };
    unique.set(`${normalized.dev}:${normalized.ino}`, normalized);
  }
  const selected = [...unique.values()].sort((a, b) => BigInt(a.dev) < BigInt(b.dev) ? -1 : BigInt(a.dev) > BigInt(b.dev) ? 1 : BigInt(a.ino) < BigInt(b.ino) ? -1 : BigInt(a.ino) > BigInt(b.ino) ? 1 : 0);
  const guards: { guard: PhysicalResourceGuard; released: boolean }[] = [];
  let state: PhysicalClaimsState = 'held', releasing: Promise<void> | undefined;
  const claims: PhysicalReadClaims = {
    resources: selected,
    get state() { return state; },
    retain() { if(state==='released')throw new Error('已核释放的claim不能伪变为仍持有。');state = 'unverified'; },
    release() {
      if (releasing) return releasing;
      if (state === 'unverified') return Promise.reject(new PhysicalClaimsUnverified(claims, 'COMMIT_UNVERIFIED'));
      releasing = (async () => {
        let failed = false, cause: unknown;
        for (const entry of [...guards].reverse()) {
          if (entry.released) continue;
          try { await entry.guard.release(); entry.released = true; }
          catch (error) { failed = true; cause ??= error; }
        }
        if (failed) { state = 'unverified'; throw new PhysicalClaimsUnverified(claims, 'RELEASE_UNVERIFIED', cause); }
        state = 'released';
      })();
      return releasing;
    },
  };
  try {
    for (let offset = 0; offset < selected.length; offset += 128) guards.push({ guard: coordinator.acquireRead(selected.slice(offset, offset + 128)), released: false });
    return claims;
  } catch (error) {
    await claims.release();
    throw error;
  }
}
