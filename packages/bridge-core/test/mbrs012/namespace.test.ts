import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {constants,fstatSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {link,lstat,mkdir,open,rename,symlink,writeFile} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {Worker} from 'node:worker_threads';
import {loadFreshMetadataReader} from '../helpers/mbrs003-audio-fixtures.js';
import {hash,owned,retainedDirectory} from './service-fixture.js';
import {PHYSICAL_RESOURCE_BUFFER_BYTES,PhysicalResourceBusy,PhysicalResourceCoordinator,installPhysicalResourceCoordinator,physicalResourceLocks,
  type PhysicalResource,type PhysicalResourceGuard} from '../../src/stream/physical-resource-locks.js';
import {acquirePhysicalWriteClaims,assertPhysicalWriteClaims,assertRetainedPhysicalWriteClaims,closePhysicalWriteClaimDescriptors,physicalWriteClaimDescriptors,
  registerPhysicalWriteClaimDescriptors,transferPhysicalWriteClaims} from '../../src/stream/physical-resource-claims.js';
import {acquireSourceNamespaceRead,acquireSourceNamespaceWrite,assertSourceNamespaceHeld,captureSourceNamespace,
  delegateSourceNamespaceRecovery,releaseSourceNamespaceWrite,resolveSourceNamespaceOrigin,resolveSourceNamespaceRecovery,
  retainSourceNamespaceWrite,sourceNamespaceRecoveryBindings,SourceNamespaceCaptureError,
  type SourceNamespaceIdentity,type SourceNamespaceOperation,type SourceNamespaceOriginBinding,
  type SourceNamespaceRecoveryScope,type SourceNamespaceWriteScope} from '../../src/stream/source-namespace-claims.js';
import {authorizeSourceDirectory,copyReadonlySource,observeSourceProtectionWithWriteClaims,openLocalPlaybackReadonlySource,
  probeReadonlySource,readonlySourceCandidateMetadata,readonlySourceDirectoryEntries,sourceFileAvailability,
  withCheckedReadonlyMetadataSource,withReadonlySourcePublicationClaims,withVerifiedReadonlyReplicaSource,withVerifiedReadonlySource,
  type RootCapability} from '../../src/recording/source-files.js';

const signal=():AbortSignal=>new AbortController().signal;
const signature=(info:BigIntStats):string=>[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
const busy=(error:unknown):boolean=>error instanceof PhysicalResourceBusy;

/** 仅命名保护的私有单元材料；不伪造 grant、冷journal、源写资格或数据库 resolved。 */
async function fixture(t:TestContext){
  const directory=await retainedDirectory('mbrs012-namespace-'),media=path.join(directory,'media'),album=path.join(media,'album');
  await mkdir(album,{recursive:true,mode:0o700});
  const input=await owned('owned-stereo-fixed-tags.flac');
  for(const name of ['a.flac','b.flac'])await writeFile(path.join(album,name),input.bytes,{flag:'wx',mode:0o600});
  const root:RootCapability={id:randomUUID(),...await authorizeSourceDirectory(media)};
  const nested:RootCapability={id:randomUUID(),...await authorizeSourceDirectory(album)};
  const names={a:await captureSourceNamespace(root,'album/a.flac'),b:await captureSourceNamespace(root,'album/b.flac')};
  const binding:SourceNamespaceOriginBinding={datasetId:randomUUID(),originPlanId:randomUUID(),planHash:input.entry.sha256,
    contextFingerprint:hash(Buffer.from(`namespace-context:${randomUUID()}`)),journalSequence:'1',projectionFingerprint:hash(Buffer.from(`namespace-projection:${randomUUID()}`))};
  const a=randomUUID(),b=randomUUID();
  const scope=(operations:readonly SourceNamespaceOperation[]):SourceNamespaceWriteScope=>({...binding,operations});
  const held=(operationId:string,name:SourceNamespaceIdentity,planId=binding.originPlanId)=>({datasetId:binding.datasetId,planId,originBinding:binding,operations:[{operationId,name}]});
  const recovery=(recoveryPlanId:string,operations:SourceNamespaceRecoveryScope['operations'],originPlanId=binding.originPlanId):SourceNamespaceRecoveryScope=>
    ({datasetId:binding.datasetId,originPlanId,recoveryPlanId,originBinding:binding,operations});
  async function read(relative='album/a.flac',cap=root):Promise<string>{
    const expected=signature(await lstat(path.join(cap.path,relative),{bigint:true}));
    const lease=await openLocalPlaybackReadonlySource(cap,relative,expected);
    try{const bytes=Buffer.alloc(lease.size),result=await lease.handle.read(bytes,0,bytes.length,0);assert.equal(result.bytesRead,bytes.length);await lease.verify();return hash(bytes);}
    finally{await lease.close();}
  }
  t.after(()=>{assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);t.diagnostic(`真实namespace材料保留：${directory}`);});
  return {directory,media,album,root,nested,input,names,binding,a,b,scope,held,recovery,read};
}

/** 多组物理保护全部来自实际owned文件的只读FD/fstat，不能手填SAB负槽。 */
async function physicalGroups(t:TestContext){
  const f=await fixture(t),relatives=['album/a.flac'];
  for(let at=0;at<127;at++){const relative=`album/physical-group-${at}.flac`;await writeFile(path.join(f.media,relative),f.input.bytes,{flag:'wx',mode:0o600});relatives.push(relative);}
  relatives.push('album/b.flac');
  const handles=await Promise.all(relatives.map(relative=>open(path.join(f.media,relative),constants.O_RDONLY|constants.O_NOFOLLOW)));
  const descriptors=handles.map(handle=>handle.fd);
  const stats=await Promise.all(handles.map(handle=>handle.stat({bigint:true}))),resources=stats.map(info=>({dev:String(info.dev),ino:String(info.ino)}));
  assert.equal(new Set(resources.map(value=>`${value.dev}:${value.ino}`)).size,129);
  const coordinator=physicalResourceLocks,guards=[coordinator.acquireWrite(resources.slice(0,128)),coordinator.acquireWrite(resources.slice(128))];
  let quiet=false;
  async function close():Promise<void>{if(!quiet){await Promise.all(handles.map(handle=>handle.close()));assert.ok(handles.every(handle=>handle.fd===-1));for(const fd of descriptors)assert.throws(()=>fstatSync(fd),error=>(error as NodeJS.ErrnoException).code==='EBADF');quiet=true;}}
  t.after(async()=>{await close();await coordinator.releasePhysicalWriteGuards(guards);});
  return {...f,handles,resources,guards,coordinator,close};
}

/** 只观察真实协调器调用，返回原品牌guard并执行原SAB操作，不以假release替代保护。 */
class ObservedPhysicalCoordinator extends PhysicalResourceCoordinator {
  readonly acquired:{guard:PhysicalResourceGuard;resources:readonly PhysicalResource[]}[]=[];
  readonly released:(readonly PhysicalResourceGuard[])[]=[];
  readonly observations:('before'|'after')[]=[];
  private watched:readonly PhysicalResource[]=[];
  private readonly peer:PhysicalResourceCoordinator;
  constructor(buffer:SharedArrayBuffer){super(buffer);this.peer=new PhysicalResourceCoordinator(buffer);}
  watch(resources:readonly PhysicalResource[]):void{this.watched=resources.map(value=>({...value}));}
  private observe(phase:'before'|'after'):void{
    if(!this.watched.length)return;
    const actual=this.peer.inspect(this.watched);
    assert.equal(actual.resources,this.watched.length);assert.equal(actual.writers,this.watched.length);assert.equal(actual.readers,0);
    for(const resource of this.watched)assert.throws(()=>this.peer.acquireRead([resource]),busy);
    this.observations.push(phase);
  }
  override acquireWrite(resources:readonly PhysicalResource[]):PhysicalResourceGuard{
    this.observe('before');const guard=super.acquireWrite(resources);
    this.acquired.push({guard,resources:resources.map(value=>({...value}))});this.observe('after');return guard;
  }
  override async releasePhysicalWriteGuards(guards:readonly PhysicalResourceGuard[]):Promise<void>{
    this.released.push([...guards]);await super.releasePhysicalWriteGuards(guards);
  }
}

test('原SAB字节布局和真实dev/ino物理key保持黄金值，namespace独立域共用原表',async t=>{
  const f=await fixture(t),handle=await open(path.join(f.album,'a.flac'),constants.O_RDONLY),info=await handle.stat({bigint:true});
  const coordinator=new PhysicalResourceCoordinator(),guard=coordinator.acquireRead([{dev:String(info.dev),ino:String(info.ino)}]);
  const namespace=coordinator.acquireSourceNamespaceRead(f.names.a.resources);
  try{
    assert.equal(PHYSICAL_RESOURCE_BUFFER_BYTES,(1+2048*4)*4);assert.equal(coordinator.buffer.byteLength,PHYSICAL_RESOURCE_BUFFER_BYTES);
    const words=new Int32Array(coordinator.buffer),keys:number[][]=[];
    for(let offset=1;offset<words.length;offset+=4)if(Atomics.load(words,offset+3)!==0)keys.push([0,1,2].map(at=>Atomics.load(words,offset+at)));
    const digest=createHash('sha256').update(`${info.dev}:${info.ino}`).digest(),physical=[0,4,8].map(at=>digest.readInt32LE(at));
    assert.ok(keys.some(value=>value.every((word,at)=>word===physical[at])));assert.equal(keys.length,1+f.names.a.resources.length);
    assert.equal(coordinator.inspect([{dev:String(info.dev),ino:String(info.ino)}]).readers,1);
    assert.throws(()=>new PhysicalResourceCoordinator(coordinator.buffer).acquireWrite([{dev:String(info.dev),ino:String(info.ino)}]),busy);
  }finally{await handle.close();await guard.release();await namespace.release();}
  assert.equal(coordinator.combinedSnapshot().resources,0);
});

test('同一个实际命名位在两coordinator共享SAB上相互排他，物理和命名保护不互相冒充',async t=>{
  const f=await fixture(t),one=new PhysicalResourceCoordinator(),two=new PhysicalResourceCoordinator(one.buffer);
  const namespace=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]),one);
  const handle=await open(path.join(f.album,'a.flac'),constants.O_RDONLY),info=await handle.stat({bigint:true});
  const physical=two.acquireRead([{dev:String(info.dev),ino:String(info.ino)}]);
  try{await assert.rejects(acquireSourceNamespaceRead([f.names.a],two),busy);assert.equal(two.combinedSnapshot().writers,f.names.a.resources.length);}
  finally{await handle.close();await physical.release();await releaseSourceNamespaceWrite(namespace,[f.a]);}
  const after=await acquireSourceNamespaceRead([f.names.a],two);await after.release();assert.equal(one.combinedSnapshot().resources,0);
});

test('旧snapshot保持三物理读者一资源，combined按实际两域计读者、writer与去重资源',async t=>{
  const f=await fixture(t),coordinator=new PhysicalResourceCoordinator(),peer=new PhysicalResourceCoordinator(coordinator.buffer);
  const handles=await Promise.all(['a.flac','b.flac'].map(name=>open(path.join(f.album,name),constants.O_RDONLY|constants.O_NOFOLLOW)));
  const stats=await Promise.all(handles.map(handle=>handle.stat({bigint:true}))),physical=stats.map(info=>({dev:String(info.dev),ino:String(info.ino)}));
  const first=physical[0],second=physical[1];assert.ok(first&&second);assert.equal(f.names.a.resources.length,1);assert.equal(f.names.b.resources.length,1);
  const readers:PhysicalResourceGuard[]=[],names:PhysicalResourceGuard[]=[];let writer:PhysicalResourceGuard|undefined,namedWriter:PhysicalResourceGuard|undefined;
  try{
    for(let at=0;at<3;at++){readers.push(coordinator.acquireRead([first]));names.push(coordinator.acquireSourceNamespaceRead(f.names.a.resources));}
    assert.deepEqual(coordinator.snapshot(),{readers:3,writers:0,resources:1});
    assert.deepEqual(peer.snapshot(),{readers:3,writers:0,resources:1});
    assert.deepEqual(coordinator.combinedSnapshot(),{readers:6,writers:0,resources:2});
    assert.deepEqual(peer.combinedSnapshot(),{readers:6,writers:0,resources:2});
    namedWriter=coordinator.acquireSourceNamespaceWrite(f.names.b.resources);
    assert.deepEqual(coordinator.snapshot(),{readers:3,writers:0,resources:1});
    assert.deepEqual(coordinator.combinedSnapshot(),{readers:6,writers:1,resources:3});
    writer=coordinator.acquireWrite([second]);
    assert.deepEqual(coordinator.snapshot(),{readers:3,writers:1,resources:2});
    assert.deepEqual(coordinator.combinedSnapshot(),{readers:6,writers:2,resources:4});
    const words=new Int32Array(coordinator.buffer),counts:number[]=[];
    for(let offset=1;offset<words.length;offset+=4){const count=Atomics.load(words,offset+3);if(count!==0)counts.push(count);}
    assert.deepEqual(counts.sort((a,b)=>a-b),[-2,-1,3,65539]);
  }finally{
    await Promise.all(handles.map(handle=>handle.close()));
    for(const reader of readers)await reader.release();for(const named of names)await named.release();
    await writer?.release();await namedWriter?.release();
  }
  assert.deepEqual(coordinator.snapshot(),{readers:0,writers:0,resources:0});
  assert.deepEqual(coordinator.combinedSnapshot(),{readers:0,writers:0,resources:0});
});

test('只有真实namespace read或write仍拒绝替换全局SAB，实际释放后原FLAC可读',async t=>{
  const f=await fixture(t),coordinator=physicalResourceLocks;
  for(const mode of ['read','write'] as const){
    const guard=mode==='read'?coordinator.acquireSourceNamespaceRead(f.names.a.resources):coordinator.acquireSourceNamespaceWrite(f.names.a.resources);
    try{
      assert.deepEqual(coordinator.snapshot(),{readers:0,writers:0,resources:0});
      assert.deepEqual(coordinator.combinedSnapshot(),{readers:mode==='read'?f.names.a.resources.length:0,writers:mode==='write'?f.names.a.resources.length:0,resources:f.names.a.resources.length});
      const before=Array.from(new Int32Array(coordinator.buffer));
      assert.throws(()=>installPhysicalResourceCoordinator(new SharedArrayBuffer(PHYSICAL_RESOURCE_BUFFER_BYTES)));
      assert.strictEqual(physicalResourceLocks,coordinator);assert.strictEqual(physicalResourceLocks.buffer,coordinator.buffer);
      assert.deepEqual(Array.from(new Int32Array(coordinator.buffer)),before);
    }finally{await guard.release();}
    assert.deepEqual(coordinator.combinedSnapshot(),{readers:0,writers:0,resources:0});
    assert.equal(await f.read(),f.input.entry.sha256);
  }
});

test('自有SAB模拟两域摘要碰撞时read与write均保守Busy，不重解释或改动真实count',async t=>{
  const f=await fixture(t);
  for(const domain of ['physical','namespace'] as const)for(const mode of ['read','write'] as const){
    const handle=await open(path.join(f.album,'a.flac'),constants.O_RDONLY|constants.O_NOFOLLOW),info=await handle.stat({bigint:true});
    const resource={dev:String(info.dev),ino:String(info.ino)},coordinator=new PhysicalResourceCoordinator(),peer=new PhysicalResourceCoordinator(coordinator.buffer);
    const guard=domain==='physical'?(mode==='read'?coordinator.acquireRead([resource]):coordinator.acquireWrite([resource]))
      :(mode==='read'?coordinator.acquireSourceNamespaceRead(f.names.a.resources):coordinator.acquireSourceNamespaceWrite(f.names.a.resources));
    const words=new Int32Array(coordinator.buffer),offsets:number[]=[];
    for(let offset=1;offset<words.length;offset+=4)if(Atomics.load(words,offset+3)!==0)offsets.push(offset);
    assert.equal(offsets.length,1);const offset=offsets[0];assert.ok(offset!==undefined);
    const original=[0,1,2].map(at=>Atomics.load(words,offset+at)),count=Atomics.load(words,offset+3);
    try{
      const reference=new PhysicalResourceCoordinator(),referenceGuard=domain==='physical'
        ?reference.acquireSourceNamespaceRead(f.names.a.resources):reference.acquireRead([resource]);
      let collision:number[]=[];
      try{
        const other=new Int32Array(reference.buffer),active:number[]=[];
        for(let at=1;at<other.length;at+=4)if(Atomics.load(other,at+3)!==0)active.push(at);
        assert.equal(active.length,1);const at=active[0];assert.ok(at!==undefined);
        collision=[0,1,2].map(index=>Atomics.load(other,at+index));
      }finally{await referenceGuard.release();}
      // 仅在本case新建且无人并发的SAB复制另一真实guard的摘要；不改count、不伪造或收养品牌。
      for(let at=0;at<3;at++){const word=collision[at];assert.ok(word!==undefined);Atomics.store(words,offset+at,word);}
      const before=Array.from(words);
      if(domain==='physical'){
        assert.throws(()=>peer.acquireSourceNamespaceRead(f.names.a.resources),busy);
        assert.throws(()=>peer.acquireSourceNamespaceWrite(f.names.a.resources),busy);
      }else{
        assert.throws(()=>peer.acquireRead([resource]),busy);assert.throws(()=>peer.acquireWrite([resource]),busy);
        assert.throws(()=>peer.inspect([resource]),busy);
        // 未知count只在这个局部碰撞样本短暂出现；观察不能把它当作实际物理租约。
        Atomics.store(words,offset+3,65536);const unknown=Array.from(words);
        try{assert.throws(()=>peer.inspect([resource]),busy);assert.deepEqual(Array.from(words),unknown);}
        finally{Atomics.store(words,offset+3,count);}
      }
      assert.deepEqual(Array.from(words),before);assert.equal(Atomics.load(words,offset+3),count);
    }finally{
      // 恢复这个局部实验的原摘要，再关闭实际FD并用原真实guard释放；绝不清slot或重置SAB。
      for(let at=0;at<3;at++){const word=original[at];assert.ok(word!==undefined);Atomics.store(words,offset+at,word);}
      await handle.close();await guard.release();
    }
    assert.deepEqual(coordinator.combinedSnapshot(),{readers:0,writers:0,resources:0});
  }
});

test('真实物理read及namespace read/write guard末项跨域count或key时全集拒绝释放',async t=>{
  const f=await fixture(t),unresolved:{words:Int32Array;expected:number[]}[]=[];
  t.after(()=>{for(const entry of unresolved)assert.deepEqual(Array.from(entry.words),entry.expected);});
  for(const changed of ['count','key'] as const){
    const handles=await Promise.all(['a.flac','b.flac'].map(name=>open(path.join(f.album,name),constants.O_RDONLY|constants.O_NOFOLLOW)));
    const stats=await Promise.all(handles.map(handle=>handle.stat({bigint:true}))),resources=stats.map(info=>({dev:String(info.dev),ino:String(info.ino)}));
    const first=resources[0];assert.ok(first);
    const coordinator=new PhysicalResourceCoordinator(),peer=new PhysicalResourceCoordinator(coordinator.buffer),guard=coordinator.acquireRead(resources);
    const words=new Int32Array(coordinator.buffer),offsets:number[]=[];
    for(let offset=1;offset<words.length;offset+=4)if(Atomics.load(words,offset+3)!==0)offsets.push(offset);
    assert.equal(offsets.length,2);const last=offsets[1];assert.ok(last!==undefined);
    let quiet=false;
    try{
      const reference=new PhysicalResourceCoordinator(),referenceGuard=reference.acquireSourceNamespaceRead(f.names.a.resources);
      const other=new Int32Array(reference.buffer),active:number[]=[];let named:number[]=[];
      try{
        for(let at=1;at<other.length;at+=4)if(Atomics.load(other,at+3)!==0)active.push(at);
        assert.equal(active.length,1);const offset=active[0];assert.ok(offset!==undefined);
        named=[0,1,2,3].map(at=>Atomics.load(other,offset+at));
      }finally{await referenceGuard.release();}
      await Promise.all(handles.map(handle=>handle.close()));quiet=true;assert.ok(handles.every(handle=>handle.fd===-1));
      // 只在新的局部SAB模拟末项跨域损坏，复制真实namespace值；不伪造guard或收养损坏slot。
      const fields=changed==='count'?[3]:[0,1,2];
      for(const at of fields){const value=named[at];assert.ok(value!==undefined);Atomics.store(words,last+at,value);}
      const expected=Array.from(words);unresolved.push({words,expected});
      await assert.rejects(guard.release(),/物理保护租约不一致/u);
      assert.deepEqual(Array.from(words),expected);assert.throws(()=>peer.acquireWrite([first]),busy);
      await assert.rejects(guard.release(),/物理保护租约不一致/u);assert.deepEqual(Array.from(words),expected);
      assert.deepEqual(coordinator.combinedSnapshot(),{readers:2,writers:0,resources:2});
    }finally{if(!quiet)await Promise.all(handles.map(handle=>handle.close()));}
  }
  for(const mode of ['read','write'] as const){
    const coordinator=new PhysicalResourceCoordinator(),peer=new PhysicalResourceCoordinator(coordinator.buffer),resources=[...f.names.a.resources,...f.names.b.resources];
    const guard=mode==='read'?coordinator.acquireSourceNamespaceRead(resources):coordinator.acquireSourceNamespaceWrite(resources);
    const words=new Int32Array(coordinator.buffer),offsets:number[]=[];
    for(let offset=1;offset<words.length;offset+=4)if(Atomics.load(words,offset+3)!==0)offsets.push(offset);
    assert.equal(offsets.length,2);const last=offsets[1];assert.ok(last!==undefined);
    const handle=await open(path.join(f.album,'a.flac'),constants.O_RDONLY|constants.O_NOFOLLOW),info=await handle.stat({bigint:true});
    const reference=new PhysicalResourceCoordinator(),referenceGuard=reference.acquireRead([{dev:String(info.dev),ino:String(info.ino)}]);
    let foreign:number[]=[];
    try{
      const other=new Int32Array(reference.buffer),active:number[]=[];
      for(let at=1;at<other.length;at+=4)if(Atomics.load(other,at+3)!==0)active.push(at);
      assert.equal(active.length,1);const offset=active[0];assert.ok(offset!==undefined);
      foreign=[0,1,2].map(at=>Atomics.load(other,offset+at));
    }finally{await handle.close();await referenceGuard.release();}
    // 末项仅漂移到另一真实物理key，count仍保留这个真实namespace guard的原域编码。
    for(let at=0;at<3;at++){const value=foreign[at];assert.ok(value!==undefined);Atomics.store(words,last+at,value);}
    const expected=Array.from(words);unresolved.push({words,expected});
    await assert.rejects(guard.release());assert.deepEqual(Array.from(words),expected);
    assert.throws(()=>peer.acquireSourceNamespaceWrite(f.names.a.resources),busy);
    await assert.rejects(guard.release());assert.deepEqual(Array.from(words),expected);
    assert.deepEqual(coordinator.snapshot(),{readers:0,writers:0,resources:0});
    assert.deepEqual(coordinator.combinedSnapshot(),{readers:mode==='read'?2:0,writers:mode==='write'?2:0,resources:2});
  }
  t.diagnostic('四份自有局部SAB保持未核释放状态；未清slot、重置活动协调器或把失败guard重新称为held。');
});

test('真实命名write只阻受影响FLAC，源写policy未开启时同根其它普通FLAC仍可读',async t=>{
  const f=await fixture(t),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));
  try{await assert.rejects(f.read(),busy);assert.equal(await f.read('album/b.flac'),f.input.entry.sha256);}
  finally{await releaseSourceNamespaceWrite(token,[f.a]);}
  assert.equal(await f.read(),f.input.entry.sha256);
});

test('nested root和外层根对同canonical path共享命名位，不按root ID拆分',async t=>{
  const f=await fixture(t),alias=await captureSourceNamespace(f.nested,'a.flac');
  assert.equal(alias.absolute,f.names.a.absolute);assert.deepEqual(alias.resources,f.names.a.resources);
  const token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));
  try{await assert.rejects(f.read('a.flac',f.nested),busy);}
  finally{await releaseSourceNamespaceWrite(token,[f.a]);}
  assert.equal(await f.read('a.flac',f.nested),f.input.entry.sha256);
});

test('目标pathgap先返回真实Busy，新inode/current signature不能绕同名屏障',async t=>{
  const f=await fixture(t),before=await lstat(path.join(f.album,'a.flac'),{bigint:true}),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));
  try{
    await rename(path.join(f.album,'a.flac'),path.join(f.directory,'retained-a.flac'));
    const missing=await captureSourceNamespace(f.root,'album/a.flac');assert.deepEqual(missing.resources,f.names.a.resources);
    await assert.rejects(openLocalPlaybackReadonlySource(f.root,'album/a.flac'),busy);
    await assert.rejects(withReadonlySourcePublicationClaims([{root:f.root,relative:'album/a.flac'}],signal(),()=>assert.fail('pathgap不得进入publication')),busy);
    await writeFile(path.join(f.album,'a.flac'),f.input.bytes,{flag:'wx',mode:0o600});
    const after=await lstat(path.join(f.album,'a.flac'),{bigint:true});assert.notEqual(after.ino,before.ino);
    await assert.rejects(f.read(),busy);
  }finally{await releaseSourceNamespaceWrite(token,[f.a]);}
  assert.equal(await f.read(),f.input.entry.sha256);
});

test('父目录真实inode更换后新授权nested root仍命中同名位，未涉文件可读',async t=>{
  const f=await fixture(t),before=await lstat(f.album,{bigint:true}),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));
  try{
    await rename(f.album,path.join(f.directory,'retained-album'));await mkdir(f.album,{mode:0o700});
    for(const name of ['a.flac','b.flac'])await writeFile(path.join(f.album,name),f.input.bytes,{flag:'wx',mode:0o600});
    const after=await lstat(f.album,{bigint:true});assert.notEqual(after.ino,before.ino);assert.equal(after.dev,before.dev);
    const current:RootCapability={id:randomUUID(),...await authorizeSourceDirectory(f.album)};
    await assert.rejects(f.read('a.flac',current),busy);await assert.rejects(f.read(),busy);
    assert.equal(await f.read('b.flac',current),f.input.entry.sha256);
  }finally{await releaseSourceNamespaceWrite(token,[f.a]);}
});

test('真实硬链接别名仍受原inode write保护，namespace不能替掉物理claims',async t=>{
  const f=await fixture(t);await link(path.join(f.album,'a.flac'),path.join(f.album,'alias.flac'));
  const token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));
  const handle=await open(path.join(f.album,'a.flac'),constants.O_RDONLY),info=await handle.stat({bigint:true});
  const claims=await acquirePhysicalWriteClaims([{dev:String(info.dev),ino:String(info.ino)}]);registerPhysicalWriteClaimDescriptors(claims,[handle]);
  try{await assert.rejects(f.read('album/alias.flac'),busy);assert.equal(await f.read('album/b.flac'),f.input.entry.sha256);}
  finally{await handle.close();await claims.release();await releaseSourceNamespaceWrite(token,[f.a]);}
  assert.equal(await f.read('album/alias.flac'),f.input.entry.sha256);
});

test('真实全组FD transfer追加期间旧inode持续Busy且零旧guard释放，fresh quiet后hardlink才读通',async t=>{
  const f=await fixture(t);await link(path.join(f.album,'a.flac'),path.join(f.album,'alias.flac'));
  const token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));
  const original=await open(path.join(f.album,'a.flac'),constants.O_RDONLY),originalInfo=await original.stat({bigint:true});
  const stagePath=path.join(f.directory,'stage.flac');await writeFile(stagePath,f.input.bytes,{flag:'wx',mode:0o600});
  const stage=await open(stagePath,constants.O_RDONLY),stageInfo=await stage.stat({bigint:true});
  const resource={dev:String(originalInfo.dev),ino:String(originalInfo.ino)},stageResource={dev:String(stageInfo.dev),ino:String(stageInfo.ino)};
  const coordinator=new ObservedPhysicalCoordinator(physicalResourceLocks.buffer);
  const previous=await acquirePhysicalWriteClaims([resource],coordinator);registerPhysicalWriteClaimDescriptors(previous,[original]);let current=previous;
  const oldGuards=new Set(coordinator.acquired.map(value=>value.guard));coordinator.watch([resource]);
  try{
    await assert.rejects(f.read('album/alias.flac'),busy);
    const transferring=transferPhysicalWriteClaims(previous,[resource,stageResource],[stage]);
    current=await transferring;
    assert.deepEqual(coordinator.observations,['before','after']);assert.equal(coordinator.released.length,0);
    assert.equal(coordinator.acquired.length,2);assert.deepEqual(coordinator.acquired[1]!.resources,[stageResource]);
    assertPhysicalWriteClaims(current,[resource,stageResource]);
    assert.throws(()=>assertPhysicalWriteClaims(previous,[resource]));assert.throws(()=>assertRetainedPhysicalWriteClaims(previous,[resource]));
    assert.throws(()=>previous.retain());await assert.rejects(async()=>previous.release());
    assert.throws(()=>registerPhysicalWriteClaimDescriptors(previous,[original]));
    await assert.rejects(transferPhysicalWriteClaims(previous,[resource,stageResource],[stage]));
    const actual=physicalWriteClaimDescriptors(current);assert.ok(actual.includes(original));assert.ok(actual.includes(stage));assert.equal(new Set(actual).size,2);
    await assert.rejects(f.read('album/alias.flac'),busy);assert.equal(await f.read('album/b.flac'),f.input.entry.sha256);
    assert.throws(()=>physicalWriteClaimDescriptors({...current}));
    assert.equal(coordinator.released.some(guards=>guards.some(guard=>oldGuards.has(guard))),false);
  }finally{
    const descriptors=[original.fd,stage.fd];await closePhysicalWriteClaimDescriptors(current);
    assert.equal(original.fd,-1);assert.equal(stage.fd,-1);
    for(const fd of descriptors)assert.throws(()=>fstatSync(fd),error=>(error as NodeJS.ErrnoException).code==='EBADF');
    await current.release();await releaseSourceNamespaceWrite(token,[f.a]);
  }
  assert.equal(await f.read('album/alias.flac'),f.input.entry.sha256);
});

test('真实transfer末批新增inode Busy仅回收新增首批，旧完整FD组及hardlink保护连续保留',async t=>{
  const f=await fixture(t);await link(path.join(f.album,'a.flac'),path.join(f.album,'alias.flac'));
  const originals=await Promise.all(['a.flac','b.flac'].map(name=>open(path.join(f.album,name),constants.O_RDONLY|constants.O_NOFOLLOW)));
  const oldDescriptors=originals.map(handle=>handle.fd),oldStats=await Promise.all(originals.map(handle=>handle.stat({bigint:true})));
  const oldResources=oldStats.map(info=>({dev:String(info.dev),ino:String(info.ino)}));
  const stageDirectory=path.join(f.directory,'transfer-stages');await mkdir(stageDirectory,{mode:0o700});
  const stagePaths=Array.from({length:129},(_,at)=>path.join(stageDirectory,`${at}.flac`));
  await Promise.all(stagePaths.map(file=>writeFile(file,f.input.bytes,{flag:'wx',mode:0o600})));
  const stages=await Promise.all(stagePaths.map(file=>open(file,constants.O_RDONLY|constants.O_NOFOLLOW))),stageDescriptors=stages.map(handle=>handle.fd);
  const stageStats=await Promise.all(stages.map(handle=>handle.stat({bigint:true}))),stageResources=stageStats.map(info=>({dev:String(info.dev),ino:String(info.ino)}));
  assert.equal(new Set(stageResources.map(value=>`${value.dev}:${value.ino}`)).size,129);
  const ordered=[...stageResources].sort((a,b)=>BigInt(a.dev)<BigInt(b.dev)?-1:BigInt(a.dev)>BigInt(b.dev)?1:BigInt(a.ino)<BigInt(b.ino)?-1:BigInt(a.ino)>BigInt(b.ino)?1:0);
  const coordinator=new ObservedPhysicalCoordinator(physicalResourceLocks.buffer),peer=new PhysicalResourceCoordinator(coordinator.buffer);
  const previous=await acquirePhysicalWriteClaims(oldResources,coordinator);registerPhysicalWriteClaimDescriptors(previous,originals);
  const oldGuards=new Set(coordinator.acquired.map(value=>value.guard));coordinator.watch(previous.resources);
  const conflict=peer.acquireWrite([ordered[128]!]);
  try{
    await assert.rejects(transferPhysicalWriteClaims(previous,[...oldResources,...stageResources],stages),busy);
    assert.deepEqual(coordinator.observations,['before','after','before']);
    assert.equal(coordinator.acquired.length,2);assert.equal(coordinator.acquired[1]!.resources.length,128);
    assert.deepEqual(coordinator.released,[[coordinator.acquired[1]!.guard]]);
    assert.equal(coordinator.released.some(guards=>guards.some(guard=>oldGuards.has(guard))),false);
    assert.equal(previous.state,'held');assertPhysicalWriteClaims(previous,oldResources);assertRetainedPhysicalWriteClaims(previous,oldResources);
    assert.deepEqual(new Set(physicalWriteClaimDescriptors(previous)),new Set(originals));
    assert.deepEqual(peer.inspect(oldResources),{readers:0,writers:2,resources:2});
    assert.deepEqual(peer.inspect(stageResources),{readers:0,writers:1,resources:1});
    await assert.rejects(f.read('album/alias.flac'),busy);await assert.rejects(f.read(),busy);await assert.rejects(f.read('album/b.flac'),busy);
  }finally{
    await Promise.all(stages.map(handle=>handle.close()));assert.ok(stages.every(handle=>handle.fd===-1));
    for(const fd of stageDescriptors)assert.throws(()=>fstatSync(fd),error=>(error as NodeJS.ErrnoException).code==='EBADF');
    await conflict.release();await closePhysicalWriteClaimDescriptors(previous);
    assert.ok(originals.every(handle=>handle.fd===-1));
    for(const fd of oldDescriptors)assert.throws(()=>fstatSync(fd),error=>(error as NodeJS.ErrnoException).code==='EBADF');
    await previous.release();
  }
  assert.equal(await f.read('album/alias.flac'),f.input.entry.sha256);assert.equal(await f.read('album/b.flac'),f.input.entry.sha256);
});

test('capture真实认证根和祖先，拒symlink/撤销/错根inode/越界而不求目标存在',async t=>{
  const f=await fixture(t);await symlink(f.album,path.join(f.media,'linked'));
  for(const relative of ['../a.flac','album/../a.flac','album//a.flac','/a.flac','album/./a.flac'])
    await assert.rejects(captureSourceNamespace(f.root,relative),error=>error instanceof SourceNamespaceCaptureError&&error.code==='OUTSIDE_ROOT');
  await assert.rejects(captureSourceNamespace(f.root,'linked/a.flac'),error=>error instanceof SourceNamespaceCaptureError&&error.code==='OUTSIDE_ROOT');
  await assert.rejects(captureSourceNamespace({...f.root,authorized:false},'album/a.flac'),error=>error instanceof SourceNamespaceCaptureError&&error.code==='REVOKED');
  await assert.rejects(captureSourceNamespace({...f.root,ino:(BigInt(f.root.ino)+1n).toString()},'album/a.flac'),error=>error instanceof SourceNamespaceCaptureError&&error.code==='SOURCE_ROOT_OFFLINE');
  const missing=await captureSourceNamespace(f.root,'album/not-created.flac');assert.equal(missing.absolute,path.join(f.album,'not-created.flac'));
});

test('根和scope原始描述符先拒getter/symbol/稀疏与复制identity，不读取伪授权',async t=>{
  const f=await fixture(t);let reads=0;
  const hostile={...f.root};Object.defineProperty(hostile,'path',{enumerable:true,get(){reads++;return f.root.path;}});
  await assert.rejects(captureSourceNamespace(hostile,'album/a.flac'));assert.equal(reads,0);
  const extra={...f.root,[Symbol('能力')]:true};await assert.rejects(captureSourceNamespace(extra,'album/a.flac'));
  const scope=f.scope([{operationId:f.a,name:f.names.a}]);Object.defineProperty(scope,'operations',{enumerable:true,get(){reads++;return [{operationId:f.a,name:f.names.a}];}});
  await assert.rejects(acquireSourceNamespaceWrite(scope));assert.equal(reads,0);
  const sparse=new Array<SourceNamespaceOperation>(1);await assert.rejects(acquireSourceNamespaceWrite(f.scope(sparse)));
  await assert.rejects(acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:{...f.names.a}}])));
  assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);
});

test('真实token核dataset/plan/context/hash/序列/投影/op/name，JSON复制没有品牌',async t=>{
  const f=await fixture(t),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));
  try{
    assertSourceNamespaceHeld(token,f.held(f.a,f.names.a));
    assert.throws(()=>assertSourceNamespaceHeld({...token},f.held(f.a,f.names.a)));
    assert.throws(()=>assertSourceNamespaceHeld(token,{...f.held(f.a,f.names.a),datasetId:randomUUID()}));
    assert.throws(()=>assertSourceNamespaceHeld(token,f.held(f.a,f.names.a,randomUUID())));
    for(const key of ['planHash','contextFingerprint','journalSequence','projectionFingerprint'] as const){
      const changed={...f.binding,[key]:key==='journalSequence'?'2':hash(Buffer.from(`changed:${key}`))};
      assert.throws(()=>assertSourceNamespaceHeld(token,{...f.held(f.a,f.names.a),originBinding:changed}));
    }
    assert.throws(()=>assertSourceNamespaceHeld(token,f.held(f.b,f.names.a)));
    assert.throws(()=>assertSourceNamespaceHeld(token,f.held(f.a,f.names.b)));
    await assert.rejects(acquireSourceNamespaceWrite({...f.scope([{operationId:f.a,name:f.names.a}]),journalSequence:'01'}));
    await assert.rejects(acquireSourceNamespaceWrite({...f.scope([{operationId:f.a,name:f.names.a}]),journalSequence:'18446744073709551616'}));
    await assert.rejects(f.read(),busy);
  }finally{await releaseSourceNamespaceWrite(token,[f.a]);}
});

test('一个operation完整绑定多name，重复或不完整恢复不能提升/缩掉资源组',async t=>{
  const f=await fixture(t),operations=[{operationId:f.a,name:f.names.a},{operationId:f.a,name:f.names.b}];
  await assert.rejects(acquireSourceNamespaceWrite(f.scope([operations[0]!,operations[0]!])));
  const token=await acquireSourceNamespaceWrite(f.scope(operations));retainSourceNamespaceWrite(token);
  const inverse=randomUUID();
  try{
    assert.throws(()=>delegateSourceNamespaceRecovery(token,f.recovery(randomUUID(),[{operationId:inverse,originOperationId:f.a,name:f.names.a}])));
    const recovery=delegateSourceNamespaceRecovery(token,f.recovery(randomUUID(),operations.map(v=>({operationId:inverse,originOperationId:f.a,name:v.name}))));
    assert.equal(sourceNamespaceRecoveryBindings(recovery).length,2);assert.deepEqual(recovery.rootOperationIds,[f.a]);
    await resolveSourceNamespaceRecovery(recovery,[inverse]);await assert.rejects(f.read(),busy);await assert.rejects(f.read('album/b.flac'),busy);
  }finally{await resolveSourceNamespaceOrigin(token,[f.a]);}
});

test('UNKNOWN真token不能普通release或由新SAB作者收养，显式resolved前持续Busy',async t=>{
  const f=await fixture(t),coordinator=new PhysicalResourceCoordinator(),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]),coordinator);
  retainSourceNamespaceWrite(token);assert.equal(token.state,'unverified');
  const sameTable=new PhysicalResourceCoordinator(coordinator.buffer);
  try{
    await assert.rejects(releaseSourceNamespaceWrite(token,[f.a]));
    await assert.rejects(acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]),sameTable),busy);
    assert.throws(()=>delegateSourceNamespaceRecovery({...token},f.recovery(randomUUID(),[{operationId:randomUUID(),originOperationId:f.a,name:f.names.a}])));
    await assert.rejects(sameTable.releaseSourceNamespaceGuards([{release:async()=>undefined}]));
    await assert.rejects(acquireSourceNamespaceRead([f.names.a],sameTable),busy);
  }finally{await resolveSourceNamespaceOrigin(token,[f.a]);}
  const readable=await acquireSourceNamespaceRead([f.names.a],sameTable);await readable.release();
});

test('逐项resolved仅收口对应义务，另一原operation与祖先引用继续保护',async t=>{
  const f=await fixture(t),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a},{operationId:f.b,name:f.names.b}]));
  retainSourceNamespaceWrite(token);const inverse=randomUUID(),recovery=delegateSourceNamespaceRecovery(token,f.recovery(randomUUID(),[{operationId:inverse,originOperationId:f.a,name:f.names.a}]));
  try{
    await resolveSourceNamespaceRecovery(recovery,[inverse]);assert.equal(recovery.state,'released');await assert.rejects(f.read(),busy);
    await resolveSourceNamespaceOrigin(token,[f.a]);assert.equal(await f.read(),f.input.entry.sha256);await assert.rejects(f.read('album/b.flac'),busy);
  }finally{await resolveSourceNamespaceOrigin(token,[f.b]);}
});

test('Root→A UNKNOWN→B品牌父链组合精确rootop，B/A成功不自动消Root义务',async t=>{
  const f=await fixture(t),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));retainSourceNamespaceWrite(token);
  const aPlan=randomUUID(),aOp=randomUUID(),a=delegateSourceNamespaceRecovery(token,f.recovery(aPlan,[{operationId:aOp,originOperationId:f.a,name:f.names.a}]));retainSourceNamespaceWrite(a);
  const bPlan=randomUUID(),bOp=randomUUID(),b=delegateSourceNamespaceRecovery(a,f.recovery(bPlan,[{operationId:bOp,originOperationId:aOp,name:f.names.a}],aPlan));
  assert.deepEqual(b.originOperationIds,[aOp]);assert.deepEqual(b.rootOperationIds,[f.a]);
  assert.deepEqual(sourceNamespaceRecoveryBindings(b).map(v=>[v.operationId,v.originOperationId,v.name.absolute]),[[bOp,f.a,f.names.a.absolute]]);
  assertSourceNamespaceHeld(b,f.held(bOp,f.names.a,bPlan));assert.throws(()=>assertSourceNamespaceHeld(a,f.held(aOp,f.names.a,aPlan)));
  await resolveSourceNamespaceRecovery(b,[bOp]);await assert.rejects(f.read(),busy);
  await resolveSourceNamespaceRecovery(a,[aOp]);await assert.rejects(f.read(),busy);
  assert.throws(()=>delegateSourceNamespaceRecovery(a,f.recovery(randomUUID(),[{operationId:randomUUID(),originOperationId:aOp,name:f.names.a}],aPlan)));
  await resolveSourceNamespaceOrigin(token,[f.a]);assert.equal(await f.read(),f.input.entry.sha256);
});

test('已实际收口失败子委托后允许新的精确READY委托，不放开Root保护窗口',async t=>{
  const f=await fixture(t),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));retainSourceNamespaceWrite(token);
  const firstOp=randomUUID(),first=delegateSourceNamespaceRecovery(token,f.recovery(randomUUID(),[{operationId:firstOp,originOperationId:f.a,name:f.names.a}]));retainSourceNamespaceWrite(first);
  await resolveSourceNamespaceRecovery(first,[firstOp]);await assert.rejects(f.read(),busy);
  const nextOp=randomUUID(),nextPlan=randomUUID(),next=delegateSourceNamespaceRecovery(token,f.recovery(nextPlan,[{operationId:nextOp,originOperationId:f.a,name:f.names.a}]));
  assertSourceNamespaceHeld(next,f.held(nextOp,f.names.a,nextPlan));await assert.rejects(f.read(),busy);
  await resolveSourceNamespaceRecovery(next,[nextOp]);await assert.rejects(f.read(),busy);
  await resolveSourceNamespaceOrigin(token,[f.a]);assert.equal(await f.read(),f.input.entry.sha256);
});

test('祖先先被durable resolved也不清仍未解B引用，不能借祖先新委托收养B',async t=>{
  const f=await fixture(t),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));retainSourceNamespaceWrite(token);
  const aPlan=randomUUID(),aOp=randomUUID(),a=delegateSourceNamespaceRecovery(token,f.recovery(aPlan,[{operationId:aOp,originOperationId:f.a,name:f.names.a}]));retainSourceNamespaceWrite(a);
  const bPlan=randomUUID(),bOp=randomUUID(),b=delegateSourceNamespaceRecovery(a,f.recovery(bPlan,[{operationId:bOp,originOperationId:aOp,name:f.names.a}],aPlan));retainSourceNamespaceWrite(b);
  await resolveSourceNamespaceOrigin(token,[f.a]);await resolveSourceNamespaceRecovery(a,[aOp]);
  assert.equal(token.state,'unverified');assertSourceNamespaceHeld(b,f.held(bOp,f.names.a,bPlan));await assert.rejects(f.read(),busy);
  assert.throws(()=>delegateSourceNamespaceRecovery(token,f.recovery(randomUUID(),[{operationId:randomUUID(),originOperationId:f.a,name:f.names.a}])));
  await resolveSourceNamespaceRecovery(b,[bOp]);assert.equal(token.state,'released');assert.equal(await f.read(),f.input.entry.sha256);
});

test('中间A resolved而B未解时原Root不能冒充B命名借用者，B收口后Root可再精确委托',async t=>{
  const f=await fixture(t),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));retainSourceNamespaceWrite(token);
  const aPlan=randomUUID(),aOp=randomUUID(),a=delegateSourceNamespaceRecovery(token,f.recovery(aPlan,[{operationId:aOp,originOperationId:f.a,name:f.names.a}]));retainSourceNamespaceWrite(a);
  const bPlan=randomUUID(),bOp=randomUUID(),b=delegateSourceNamespaceRecovery(a,f.recovery(bPlan,[{operationId:bOp,originOperationId:aOp,name:f.names.a}],aPlan));retainSourceNamespaceWrite(b);
  await resolveSourceNamespaceRecovery(a,[aOp]);assert.throws(()=>assertSourceNamespaceHeld(token,f.held(f.a,f.names.a)));
  assertSourceNamespaceHeld(b,f.held(bOp,f.names.a,bPlan));await assert.rejects(f.read(),busy);
  await resolveSourceNamespaceRecovery(b,[bOp]);assertSourceNamespaceHeld(token,f.held(f.a,f.names.a));
  const nextPlan=randomUUID(),nextOp=randomUUID(),next=delegateSourceNamespaceRecovery(token,f.recovery(nextPlan,[{operationId:nextOp,originOperationId:f.a,name:f.names.a}]));
  assertSourceNamespaceHeld(next,f.held(nextOp,f.names.a,nextPlan));await resolveSourceNamespaceRecovery(next,[nextOp]);await resolveSourceNamespaceOrigin(token,[f.a]);
});

test('共享同name的另一未解operation继续引用guard，释放一项不能清slot',async t=>{
  const f=await fixture(t),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a},{operationId:f.b,name:f.names.a}]));
  await releaseSourceNamespaceWrite(token,[f.a]);await assert.rejects(f.read(),busy);
  assertSourceNamespaceHeld(token,f.held(f.b,f.names.a));await releaseSourceNamespaceWrite(token,[f.b]);assert.equal(await f.read(),f.input.entry.sha256);
});

test('原子release先核全部真实guards，混入另一coordinator guard不会提前放第一项',async t=>{
  const f=await fixture(t),one=new PhysicalResourceCoordinator(),two=new PhysicalResourceCoordinator(one.buffer);
  const a=one.acquireSourceNamespaceWrite(f.names.a.resources),b=one.acquireSourceNamespaceWrite(f.names.b.resources);
  const third=await captureSourceNamespace(f.root,'album/third.flac'),foreign=two.acquireSourceNamespaceWrite(third.resources);
  try{
    await assert.rejects(one.releaseSourceNamespaceGuards([a,foreign]));
    assert.throws(()=>two.acquireSourceNamespaceRead(f.names.a.resources),busy);assert.throws(()=>two.acquireSourceNamespaceRead(f.names.b.resources),busy);
    assert.throws(()=>one.acquireSourceNamespaceRead(third.resources),busy);
    await one.releaseSourceNamespaceGuards([a,b]);const read=two.acquireSourceNamespaceRead(f.names.a.resources);await read.release();
  }finally{await one.releaseSourceNamespaceGuards([a,b]);await foreign.release();}
  assert.equal(one.combinedSnapshot().resources,0);
});

test('真实129个FD分两组write guards，整组quiet后原子释放并实际读通首末FLAC',async t=>{
  const f=await physicalGroups(t),peer=new PhysicalResourceCoordinator(f.coordinator.buffer);
  assert.equal(f.coordinator.snapshot().writers,129);await assert.rejects(f.read(),busy);await assert.rejects(f.read('album/b.flac'),busy);
  assert.throws(()=>peer.acquireRead([f.resources[0]!,f.resources[128]!]),busy);
  await f.close();await f.coordinator.releasePhysicalWriteGuards(f.guards);
  assert.equal(f.coordinator.snapshot().resources,0);assert.equal(await f.read(),f.input.entry.sha256);assert.equal(await f.read('album/b.flac'),f.input.entry.sha256);
  const read=peer.acquireRead([f.resources[0]!,f.resources[128]!]);await read.release();
});

test('物理整组release末项foreign/read/namespace/JSON异常时首末真实write仍Busy',async t=>{
  const f=await physicalGroups(t),peer=new PhysicalResourceCoordinator(f.coordinator.buffer);
  const extra:FileHandle[]=[];
  for(const name of ['foreign.flac','read-guard.flac']){const absolute=path.join(f.album,name);await writeFile(absolute,f.input.bytes,{flag:'wx',mode:0o600});extra.push(await open(absolute,constants.O_RDONLY));}
  const stats=await Promise.all(extra.map(handle=>handle.stat({bigint:true}))),foreign=peer.acquireWrite([{dev:String(stats[0]!.dev),ino:String(stats[0]!.ino)}]);
  const read=f.coordinator.acquireRead([{dev:String(stats[1]!.dev),ino:String(stats[1]!.ino)}]);
  const namespace=f.coordinator.acquireSourceNamespaceWrite(f.names.a.resources),namespaceRead=f.coordinator.acquireSourceNamespaceRead(f.names.b.resources);
  const forged:PhysicalResourceGuard={release:f.guards[1]!.release};
  try{
    const before=f.coordinator.combinedSnapshot();
    for(const invalid of [foreign,read,namespace,namespaceRead,forged]){
      await assert.rejects(f.coordinator.releasePhysicalWriteGuards([...f.guards,invalid]));
      assert.deepEqual(f.coordinator.combinedSnapshot(),before);
      assert.throws(()=>peer.acquireRead([f.resources[0]!]),busy);assert.throws(()=>peer.acquireRead([f.resources[128]!]),busy);
    }
    await assert.rejects(peer.releasePhysicalWriteGuards(f.guards));assert.deepEqual(f.coordinator.combinedSnapshot(),before);
  }finally{
    await Promise.all(extra.map(handle=>handle.close()));await foreign.release();await read.release();await namespace.release();await namespaceRead.release();
    await f.close();await f.coordinator.releasePhysicalWriteGuards(f.guards);
  }
  assert.equal(await f.read(),f.input.entry.sha256);assert.equal(await f.read('album/b.flac'),f.input.entry.sha256);
});

test('单write release与整组并发/重复共享状态，旧guard不能清后来新签发的同inode保护',async t=>{
  const f=await physicalGroups(t);await f.close();
  await Promise.all([f.guards[0]!.release(),f.coordinator.releasePhysicalWriteGuards(f.guards),f.guards[1]!.release(),
    f.coordinator.releasePhysicalWriteGuards([f.guards[0]!,f.guards[0]!,f.guards[1]!])]);
  assert.equal(f.coordinator.snapshot().resources,0);
  const handle=await open(path.join(f.album,'a.flac'),constants.O_RDONLY),info=await handle.stat({bigint:true});
  const next=f.coordinator.acquireWrite([{dev:String(info.dev),ino:String(info.ino)}]);
  try{
    await Promise.all([f.guards[0]!.release(),f.coordinator.releasePhysicalWriteGuards(f.guards)]);
    assert.equal(f.coordinator.snapshot().writers,1);await assert.rejects(f.read(),busy);
  }finally{await handle.close();await next.release();}
  await next.release();assert.equal(f.coordinator.snapshot().resources,0);assert.equal(await f.read(),f.input.entry.sha256);
});

test('namespace与真实inode合计2048槽，单批128保持且容量失败不泄漏先前guards',async t=>{
  const f=await fixture(t),coordinator=new PhysicalResourceCoordinator(),handle=await open(path.join(f.album,'a.flac'),constants.O_RDONLY),info=await handle.stat({bigint:true});
  const physical=coordinator.acquireRead([{dev:String(info.dev),ino:String(info.ino)}]),guards:PhysicalResourceGuard[]=[];
  const names:SourceNamespaceIdentity[]=[];
  for(let at=0;at<2048;at++)names.push(await captureSourceNamespace(f.root,`album/capacity-${at}.flac`));
  assert.ok(names.every(value=>value.resources.length===1));const resources=names.flatMap(value=>value.resources);
  try{
    assert.throws(()=>coordinator.acquireSourceNamespaceRead(resources.slice(0,129)));
    for(let at=0;at<2047;at+=128)guards.push(coordinator.acquireSourceNamespaceWrite(resources.slice(at,Math.min(2047,at+128))));
    assert.equal(coordinator.combinedSnapshot().resources,2048);assert.throws(()=>coordinator.acquireSourceNamespaceRead(resources.slice(2047)),busy);
    assert.equal(coordinator.combinedSnapshot().resources,2048);
  }finally{await handle.close();await physical.release();await coordinator.releaseSourceNamespaceGuards(guards);}
  assert.equal(coordinator.combinedSnapshot().resources,0);
  const full=await acquireSourceNamespaceRead(names,coordinator);
  try{await assert.rejects(acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]),coordinator),busy);assert.equal(coordinator.combinedSnapshot().resources,2048);}
  finally{await full.release();}
  assert.equal(coordinator.combinedSnapshot().resources,0);
});

test('后项Busy时回滚实际已取得的namespace guards，分组read同样不泄漏前128项',async t=>{
  const f=await fixture(t),coordinator=new PhysicalResourceCoordinator(),last=await captureSourceNamespace(f.root,'album/z-busy.flac');
  const token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.b,name:f.names.b},{operationId:f.b,name:last}]),coordinator);
  try{
    await assert.rejects(acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a},{operationId:f.b,name:f.names.b}]),coordinator),busy);
    assert.equal(coordinator.combinedSnapshot().resources,2);const first=await acquireSourceNamespaceRead([f.names.a],coordinator);await first.release();
    const names:SourceNamespaceIdentity[]=[];for(let at=0;at<128;at++)names.push(await captureSourceNamespace(f.root,`album/rollback-${at}.flac`));names.push(last);
    await assert.rejects(acquireSourceNamespaceRead(names,coordinator),busy);assert.equal(coordinator.combinedSnapshot().resources,2);
    const after=await acquireSourceNamespaceRead(names.slice(0,128),coordinator);await after.release();assert.equal(coordinator.combinedSnapshot().resources,2);
  }finally{await releaseSourceNamespaceWrite(token,[f.b]);}
  assert.equal(coordinator.combinedSnapshot().resources,0);
});

test('旧200曲真实publication不被新100项source计划预算收紧，FD到消费quiet才释放',async t=>{
  const f=await fixture(t),sources:{root:RootCapability;relative:string}[]=[];
  for(let at=0;at<200;at++){const relative=`album/publication-${at}.flac`;await writeFile(path.join(f.media,relative),f.input.bytes,{flag:'wx',mode:0o600});sources.push({root:f.root,relative});}
  const last=await captureSourceNamespace(f.root,sources[199]!.relative);
  await withReadonlySourcePublicationClaims(sources,signal(),async(verify,files)=>{
    assert.equal(files.length,200);const bytes=Buffer.alloc(f.input.bytes.length),read=await files[199]!.handle.read(bytes,0,bytes.length,0);
    assert.equal(read.bytesRead,bytes.length);assert.equal(hash(bytes),f.input.entry.sha256);
    await assert.rejects(acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:last}])),busy);
    await verify();assert.equal(physicalResourceLocks.combinedSnapshot().resources,400);
  });
  assert.equal(physicalResourceLocks.combinedSnapshot().resources,0);const after=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:last}]));await releaseSourceNamespaceWrite(after,[f.a]);
});

test('真实内容入口全部先取namespace read，stat与目录浏览在Busy时继续可用',async t=>{
  const f=await fixture(t),expected={sha256:f.input.entry.sha256,size:f.input.bytes.length},current=signature(await lstat(path.join(f.album,'a.flac'),{bigint:true}));
  const destination=await open(path.join(f.directory,'copy.flac'),'wx+'),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));
  try{
    const rejected=()=>Promise.reject(new Error('命名屏障后不能启动内容消费者。'));
    await assert.rejects(withCheckedReadonlyMetadataSource(f.root,'album/a.flac',current,signal(),rejected),busy);
    await assert.rejects(withVerifiedReadonlySource(f.root,'album/a.flac',expected,signal(),rejected),busy);
    await assert.rejects(withVerifiedReadonlyReplicaSource(f.root,'album/a.flac',expected,signal(),rejected,()=>undefined,{durationMs:1000}),busy);
    await assert.rejects(copyReadonlySource(f.root,'album/a.flac',expected,destination,signal()),busy);
    await assert.rejects(probeReadonlySource(f.root,'album/a.flac',signal()),busy);
    assert.equal((await destination.stat()).size,0);assert.equal((await readonlySourceCandidateMetadata(f.root,'album/a.flac')).signature,current);
    assert.equal(await sourceFileAvailability(f.root,'album/a.flac',current),'ONLINE');
    const listing=await readonlySourceDirectoryEntries(f.root,'album',100,signal(),Date.now()+30000);assert.ok(listing.entries.some(entry=>entry.name==='a.flac'));
  }finally{await destination.close();await releaseSourceNamespaceWrite(token,[f.a]);}
  assert.equal(await f.read(),f.input.entry.sha256);
});

test('真实metadata FD消费尚未quiet和close时命名writer拒绝，消费终结后恢复准入',async t=>{
  const f=await fixture(t),expected=signature(await lstat(path.join(f.album,'a.flac'),{bigint:true}));
  let enter!:()=>void,finish!:()=>void,opened=-1,closed=-1;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  const read=withCheckedReadonlyMetadataSource(f.root,'album/a.flac',expected,signal(),async handle=>{
    opened=handle.fd;const bytes=Buffer.alloc(f.input.bytes.length),result=await handle.read(bytes,0,bytes.length,0);assert.equal(result.bytesRead,bytes.length);assert.equal(hash(bytes),f.input.entry.sha256);
    enter();await gate;return handle;
  });
  await Promise.race([entered,read.then(()=>assert.fail('真实metadata消费应先进入等待阶段。'))]);assert.ok(opened>=0);
  try{await assert.rejects(acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}])),busy);}
  finally{finish();closed=(await read).fd;}
  assert.equal(closed,-1);const token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));await releaseSourceNamespaceWrite(token,[f.a]);
});

test('Owner held观察须实际FD物理claims加精确namespace品牌，无proof/private路径不绕busy',async t=>{
  const f=await fixture(t),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));
  const handle=await open(path.join(f.album,'a.flac'),constants.O_RDONLY),info=await handle.stat({bigint:true}),resource={dev:String(info.dev),ino:String(info.ino)};
  const claims=await acquirePhysicalWriteClaims([resource]);registerPhysicalWriteClaimDescriptors(claims,[handle]);
  const observation={token,datasetId:f.binding.datasetId,planId:f.binding.originPlanId,originBinding:f.binding,operationId:f.a};
  try{
    await assert.rejects(observeSourceProtectionWithWriteClaims(f.root,'album/a.flac',signal(),claims),busy);
    const result=await observeSourceProtectionWithWriteClaims(f.root,'album/a.flac',signal(),claims,observation);assert.deepEqual(result.physical,resource);assert.equal(result.signature,signature(info));
    await assert.rejects(observeSourceProtectionWithWriteClaims(f.root,'album/a.flac',signal(),claims,{...observation,token:{...token}}));
    await assert.rejects(observeSourceProtectionWithWriteClaims(f.root,'album/a.flac',signal(),claims,{...observation,operationId:f.b}));
    const outside=await captureSourceNamespace(f.root,'album/b.flac'),other=await acquireSourceNamespaceWrite(f.scope([{operationId:f.b,name:outside}]));
    try{await assert.rejects(observeSourceProtectionWithWriteClaims(f.root,'album/b.flac',signal(),claims),busy);}
    finally{await releaseSourceNamespaceWrite(other,[f.b]);}
    assert.equal((await observeSourceProtectionWithWriteClaims(f.root,'album/b.flac',signal(),claims)).signature,signature(await lstat(path.join(f.album,'b.flac'),{bigint:true})));
  }finally{await handle.close();await claims.release();await releaseSourceNamespaceWrite(token,[f.a]);}
});

interface WorkerRead {status:'ok'|'busy';sha256?:string;actualBusy?:boolean}
/** 子Worker执行同一个实际content helper，收到message仍须join真实exit。 */
async function workerRead(root:RootCapability,relative:string,buffer:SharedArrayBuffer):Promise<WorkerRead>{
  const code=`import {parentPort,workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
const locks=await import(workerData.locks);locks.installPhysicalResourceCoordinator(workerData.buffer);
const sources=await import(workerData.sources);let lease,result;
try{lease=await sources.openLocalPlaybackReadonlySource(workerData.root,workerData.relative);const bytes=Buffer.alloc(lease.size);const actual=await lease.handle.read(bytes,0,bytes.length,0);if(actual.bytesRead!==bytes.length)throw new Error('真实Worker短读');await lease.verify();result={status:'ok',sha256:createHash('sha256').update(bytes).digest('hex')};}
catch(error){if(!(error instanceof locks.PhysicalResourceBusy))throw error;result={status:'busy',actualBusy:true};}
finally{await lease?.close();}
parentPort.postMessage(result);parentPort.close();`;
  const worker=new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`),{execArgv:['--import','tsx'],workerData:{root,relative,buffer,
    locks:new URL('../../src/stream/physical-resource-locks.ts',import.meta.url).href,sources:new URL('../../src/recording/source-files.ts',import.meta.url).href}});
  return new Promise<WorkerRead>((resolve,reject)=>{
    let result:WorkerRead|undefined,failure:unknown;
    worker.on('message',(value:WorkerRead)=>{if(result)failure=new Error('Worker重复结果。');else result=value;});worker.once('error',error=>{failure=error;});
    worker.once('exit',code=>{if(failure)reject(failure);else if(code!==0||!result)reject(new Error('实际Worker未正常完成。'));else resolve(result);});
  });
}

test('真实新Worker共享原SAB先命中Busy，同根未涉FLAC与resolve后的读取均实际完成',async t=>{
  const f=await fixture(t),token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));retainSourceNamespaceWrite(token);
  try{
    assert.deepEqual(await workerRead(f.root,'album/a.flac',physicalResourceLocks.buffer),{status:'busy',actualBusy:true});
    assert.deepEqual(await workerRead(f.root,'album/b.flac',physicalResourceLocks.buffer),{status:'ok',sha256:f.input.entry.sha256});
  }finally{await resolveSourceNamespaceOrigin(token,[f.a]);}
  assert.deepEqual(await workerRead(f.root,'album/a.flac',physicalResourceLocks.buffer),{status:'ok',sha256:f.input.entry.sha256});
});

test('新鲜编译真实MetadataReader同SAB拒受影响对象且无lease/worker，未涉FLAC正常解析',async t=>{
  const f=await fixture(t),readerModule=await loadFreshMetadataReader();
  const compiledLocks:typeof import('../../src/stream/physical-resource-locks.js')=await import(new URL('../../dist/stream/physical-resource-locks.js',import.meta.url).href);
  compiledLocks.installPhysicalResourceCoordinator(physicalResourceLocks.buffer);
  const events:string[]=[],reader=readerModule.createMetadataReader({onLifecycle(event){events.push(event.type);}});
  const token=await acquireSourceNamespaceWrite(f.scope([{operationId:f.a,name:f.names.a}]));retainSourceNamespaceWrite(token);
  try{
    const failed=await reader.read({root:f.root,relative:'album/a.flac',expectedSignature:signature(await lstat(path.join(f.album,'a.flac'),{bigint:true}))});
    assert.equal(failed.status,'failure');assert.ok(failed.status==='failure');assert.equal(failed.code,'IO_ERROR');assert.equal(failed.readEvidence,null);
    assert.equal(events.includes('lease-acquired'),false);assert.equal(events.includes('worker-start'),false);
    const allowed=await reader.read({root:f.root,relative:'album/b.flac',expectedSignature:signature(await lstat(path.join(f.album,'b.flac'),{bigint:true}))});
    assert.equal(allowed.status,'ok');assert.ok(allowed.status==='ok');assert.equal(allowed.technical.container,'FLAC');
    assert.ok(events.includes('lease-acquired'));assert.ok(events.includes('worker-start'));assert.ok(events.includes('worker-exit'));assert.ok(events.includes('lease-released'));
    await resolveSourceNamespaceOrigin(token,[f.a]);
    const restored=await reader.read({root:f.root,relative:'album/a.flac',expectedSignature:signature(await lstat(path.join(f.album,'a.flac'),{bigint:true}))});assert.equal(restored.status,'ok');
  }finally{await reader.close();if(token.state!=='released')await resolveSourceNamespaceOrigin(token,[f.a]);}
});
