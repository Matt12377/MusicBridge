import assert from 'node:assert/strict';
import test from 'node:test';
import { rename, truncate, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { auditHttpBytes, HTTP_AUDIT_MAX_BYTES } from '../../src/stream/http-byte-evidence.js';
import { physicalResourceLocks, PhysicalResourceBusy } from '../../src/stream/physical-resource-locks.js';
import { gatewayFixture, eventually } from '../mbrs005/fixture.js';
const reader=(url:string,signal?:AbortSignal)=>async(input:{method:'GET'|'HEAD';headers:Readonly<Record<string,string>>})=>{
 const response=await fetch(url,{method:input.method,headers:input.headers,...(signal?{signal}:{})});const headers:Record<string,string>={};response.headers.forEach((value,key)=>headers[key]=value);return {status:response.status,headers,body:new Uint8Array(await response.arrayBuffer())};
};
test('008真实Gateway逐字节完整/Range/HEAD/If-Range/错误集合，HTTP完成仍PREPARED读锁',async t=>{
 const f=await gatewayFixture(t),report=await auditHttpBytes(f.bytes,reader(f.url));assert.equal(report.verified,true);assert.equal(report.rows.length,14);assert.equal(f.lease.state,'PREPARED');assert.equal(f.fetches(),0);
 assert.throws(()=>physicalResourceLocks.acquireWrite([f.resource]),PhysicalResourceBusy);assert.equal(JSON.stringify(report).includes(f.token),false);assert.equal(JSON.stringify(report).includes(f.absolute),false);
});
test('008中间一字节差异是真正Q1失败，不能只比较长度或source Hash',async t=>{
 const f=await gatewayFixture(t),real=reader(f.url),report=await auditHttpBytes(f.bytes,async input=>{const result=await real(input);if(!Object.hasOwn(input.headers,'Range')&&input.method==='GET'){const byte=result.body[100];assert.notEqual(byte,undefined);result.body[100]=byte!^1;}return result;});
 assert.equal(report.verified,false);assert.equal(report.rows[0]!.mismatchBytes,1);assert.equal(report.rows.filter(row=>row.mismatchBytes!==0).length,1);
});
for(const mutation of ['replace','truncate'] as const)test(`008实际${mutation}后的旧固定FD审计拒绝混用新版字节`,async t=>{
 const f=await gatewayFixture(t);if(mutation==='replace'){await rename(f.absolute,f.absolute+'.old');await writeFile(f.absolute,Buffer.alloc(f.bytes.length,77));}else await truncate(f.absolute,4);
 const report=await auditHttpBytes(f.bytes,reader(f.url));assert.equal(report.verified,false);assert.equal(report.rows[0]!.bodyLength,0);await f.lease.close();assert.equal(f.lease.state,'CLOSED');
});
test('008真实短read无法产生字节通过证据，并关闭旧lease',async t=>{
 const f=await gatewayFixture(t),fixed=(f.lease as unknown as {file:{handle:FileHandle}}).file.handle;
 fixed.read=(async()=>({bytesRead:0,buffer:Buffer.alloc(0)})) as FileHandle['read'];
 const report=await auditHttpBytes(f.bytes,reader(f.url));assert.equal(report.verified,false);await f.lease.close();assert.equal(f.lease.state,'CLOSED');
});
test('008取消与close等待真实自有FD read quiet，不能提前释放物理guard',async t=>{
 const f=await gatewayFixture(t),fixed=(f.lease as unknown as {file:{handle:FileHandle}}).file.handle,original=fixed.read.bind(fixed);
 let release!:()=>void,entered=false,closed=false;const gate=new Promise<void>(resolve=>release=resolve);
 fixed.read=(async(buffer:Buffer,offset:number,length:number,position:number)=>{entered=true;await gate;return original(buffer,offset,length,position);}) as FileHandle['read'];
 const abort=new AbortController(),work=auditHttpBytes(f.bytes,reader(f.url,abort.signal));
 try{await eventually(()=>entered,'实际read已进入');abort.abort();const closing=f.lease.close().then(()=>closed=true);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.throws(()=>physicalResourceLocks.acquireWrite([f.resource]),PhysicalResourceBusy);release();await closing;assert.equal((await work).verified,false);const guard=physicalResourceLocks.acquireWrite([f.resource]);await guard.release();}
 finally{release();await work;await f.lease.close();}
});
test('008审计8MiB上限与响应预算显式拒绝，不改变播放FD上限',async()=>{
 await assert.rejects(auditHttpBytes(new Uint8Array(HTTP_AUDIT_MAX_BYTES+1),async()=>{assert.fail('超预算不能派发请求');}),/8MiB/u);
 await assert.rejects(auditHttpBytes(new Uint8Array([1]),async()=>({status:200,headers:{},body:new Uint8Array(HTTP_AUDIT_MAX_BYTES+1)})),/预算/u);
});
