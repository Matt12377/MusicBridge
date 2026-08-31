import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, open, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const binary = path.resolve('apps/desktop/native/output/darwin-arm64/bin/output-helper');
const digest = b => createHash('sha256').update(b).digest();
function configuration(bytes, { format = 1, channels = 2, offset = 44, callback = 257 } = {}) {
  const header = Buffer.alloc(256), frameBytes = channels * (format === 1 ? 2 : format === 2 ? 3 : 4);
  header.write('MBFP'); header.writeUInt16LE(1, 4); header.writeUInt16LE(256, 6);
  for (const at of [8,24,40]) Buffer.from(randomUUID().replaceAll('-', ''), 'hex').copy(header, at);
  for (const at of [56,88]) digest(Buffer.from(`合成身份${at}`)).copy(header, at);
  digest(bytes).copy(header,120); digest(bytes.subarray(offset)).copy(header,152);
  for (const [at,n] of [[184,bytes.length],[192,offset],[200,bytes.length-offset],[208,(bytes.length-offset)/frameBytes]]) header.writeBigUInt64LE(BigInt(n),at);
  header.writeUInt32LE(48000,216); header.writeUInt16LE(channels,220); header.writeUInt16LE(format,222); header.writeUInt32LE(callback,224);
  return header;
}
function control(header, opcode, sequence) { const b=Buffer.alloc(32);b.write('MBFC');b.writeUInt16LE(1,4);b.writeUInt16LE(opcode,6);header.copy(b,8,8,24);b.writeUInt32LE(sequence,24);return b; }
async function invoke(t, bytes, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-native-output-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const file = path.join(directory,'synthetic.wav'); await writeFile(file,bytes);
  const handle=await open(file,options.readWrite?'r+':'r'); t.after(()=>handle.close());
  const header=configuration(bytes,options); options.mutate?.(header);
  const child=spawn(binary,[],{stdio:['pipe','pipe','pipe',options.inputPipe?'pipe':handle.fd],env:{}}); child.stdin.on('error',()=>{});
  let buffer=Buffer.alloc(0), stderr=Buffer.alloc(0); const events=[];
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000); t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');});
  child.stderr.on('data',b=>{stderr=Buffer.concat([stderr,b]);});
  child.stdout.on('data',b=>{
    buffer=Buffer.concat([buffer,b]);
    while(buffer.length>=128){const event=buffer.subarray(0,128);buffer=buffer.subarray(128);events.push(Buffer.from(event));
      const kind=event.readUInt16LE(6);
      if(kind===1 && options.cancelEarly) child.stdin.write(control(header,2,1));
      if(kind===2 && !options.cancelEarly){if(options.eof) child.stdin.end(); else { const value=control(header,options.badControl?99:1,1);options.mutateControl?.(value);if(options.shortControl)child.stdin.end(value.subarray(0,7));else if(options.trailingControlFragment)child.stdin.write(Buffer.concat([value,control(header,2,2).subarray(0,7)]));else child.stdin.write(value); }}
      if(kind===3 && options.stop) child.stdin.write(control(header,2,2));
    }
  });
  const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
  if(options.shortHeader) child.stdin.end(header.subarray(0,100)); else if(options.fragment) { for(let i=0;i<header.length;i+=7) child.stdin.write(header.subarray(i,i+7)); } else child.stdin.write(header);
  const exit=await completion;clearTimeout(timer);
  assert.equal(buffer.length,0);assert.equal(stderr.length,0);
  for(const [i,event]of events.entries()){assert.equal(event.toString('ascii',0,4),'MBFE');assert.equal(event.readUInt32LE(8),i+1);assert.deepEqual(event.subarray(16,32),header.subarray(8,24));}
  assert.deepEqual(await readFile(file),bytes,'原合成音频不得改变');
  return {exit,events,last:events.at(-1),header};
}
for(const format of [1,2,3,4]) test(`真实helper消费格式${format}的原PCM并核对hash/帧`,async t=>{
  const frameBytes=format===1?4:format===2?6:8, frames=10003;
  const bytes=Buffer.alloc(46+frames*frameBytes);
  for(let i=46;i<bytes.length;i++)bytes[i]=format===4?0:(i*17)%256;
  if(format===4) for(let i=46;i<bytes.length;i+=4)bytes.writeFloatLE([0,-0.25,0.5,1.25][((i-46)/4)%4],i);
  const r=await invoke(t,bytes,{format,offset:46,fragment:true});
  assert.equal(r.exit.code,0);assert.deepEqual(r.events.map(e=>e.readUInt16LE(6)),[1,2,3,4,5]);
  assert.equal(r.last.readBigUInt64LE(40),BigInt(frames));assert.deepEqual(r.last.subarray(96,128),digest(bytes.subarray(46)));
});
test('整文件或PCM hash错误不会进入RUNNING',async t=>{
  const r=await invoke(t,Buffer.alloc(44+1024),{mutate:h=>h[152]^=1});assert.notEqual(r.exit.code,0);assert.equal(r.last.readUInt16LE(6),7);assert.equal(r.last.readUInt32LE(12),8);assert.ok(!r.events.some(e=>e.readUInt16LE(6)===3));
});
test('只读FD能力不能以可写句柄代替',async t=>{const r=await invoke(t,Buffer.alloc(44+1024),{readWrite:true});assert.notEqual(r.exit.code,0);assert.equal(r.last.readUInt32LE(12),4);});
test('输入区间越界拒绝',async t=>{const r=await invoke(t,Buffer.alloc(44+1024),{mutate:h=>h.writeBigUInt64LE(99999n,192)});assert.notEqual(r.exit.code,0);assert.equal(r.last.readUInt32LE(12),6);});
test('协议EOF不能成为完成',async t=>{const r=await invoke(t,Buffer.alloc(44+1024),{eof:true});assert.notEqual(r.exit.code,0);assert.equal(r.last.readUInt16LE(6),7);});
test('未知控制码拒绝',async t=>{const r=await invoke(t,Buffer.alloc(44+1024),{badControl:true});assert.notEqual(r.exit.code,0);assert.equal(r.last.readUInt32LE(12),3);});
test('真实停止只消费前缀且不隐式读到结尾',async t=>{const r=await invoke(t,Buffer.alloc(44+8*1024*1024,23),{callback:1,stop:true});assert.equal(r.exit.code,2);assert.equal(r.last.readUInt16LE(6),6);assert.ok(r.last.readBigUInt64LE(40)<BigInt(2*1024*1024));});
test('fd3不能指向pipe或socket',async t=>{const r=await invoke(t,Buffer.alloc(44+1024),{inputPipe:true});assert.notEqual(r.exit.code,0);assert.equal(r.last.readUInt32LE(12),4);});
test('取消先于RUN不消费任何源帧',async t=>{const r=await invoke(t,Buffer.alloc(44+1024*1024),{cancelEarly:true});assert.equal(r.exit.code,2);assert.equal(r.last.readBigUInt64LE(40),0n);assert.ok(!r.events.some(e=>e.readUInt16LE(6)===3));});
test('float32非有限样本不能取得VERIFIED',async t=>{const bytes=Buffer.alloc(44+1024);bytes.writeFloatLE(Infinity,44);const r=await invoke(t,bytes,{format:4});assert.notEqual(r.exit.code,0);assert.equal(r.last.readUInt32LE(12),5);assert.ok(!r.events.some(e=>e.readUInt16LE(6)===2));});
for(const name of ['reserved','frameCount','format','callback']) test(`header ${name}非法拒绝`,async t=>{
  const r=await invoke(t,Buffer.alloc(44+1024),{mutate:h=>{if(name==='reserved')h[255]=1;else if(name==='frameCount')h.writeBigUInt64LE(0xffffffffffffffffn,208);else if(name==='format')h.writeUInt16LE(9,222);else h.writeUInt32LE(4097,224);}});
  assert.notEqual(r.exit.code,0);assert.equal(r.last.readUInt16LE(6),7);assert.ok(!r.events.some(e=>e.readUInt16LE(6)===3));
});
for(const name of ['runId','sequence','reserved']) test(`control ${name}非法拒绝`,async t=>{
  const r=await invoke(t,Buffer.alloc(44+1024),{mutateControl:b=>{if(name==='runId')b[8]^=1;else if(name==='sequence')b.writeUInt32LE(2,24);else b[31]=1;}});
  assert.notEqual(r.exit.code,0);assert.equal(r.last.readUInt32LE(12),3);
});
test('截断header不得虚构已识别run事件',async t=>{const r=await invoke(t,Buffer.alloc(44+1024),{shortHeader:true});assert.notEqual(r.exit.code,0);assert.equal(r.events.length,0);});
test('截断control不得成为RUN',async t=>{const r=await invoke(t,Buffer.alloc(44+1024),{shortControl:true});assert.notEqual(r.exit.code,0);assert.ok(!r.events.some(e=>e.readUInt16LE(6)===3));});
test('mono packed24末帧保持三个原字节',async t=>{const bytes=Buffer.alloc(44+3*10001,79);const r=await invoke(t,bytes,{channels:1,format:2});assert.equal(r.exit.code,0);assert.equal(r.last.readBigUInt64LE(40),10001n);assert.deepEqual(r.last.subarray(96),digest(bytes.subarray(44)));});
test('打包产物树只保留固定helper与HAL object',async()=>{assert.deepEqual((await readdir(path.resolve('apps/desktop/native/output/darwin-arm64/build'))).sort(),['core-audio-adapter.o']);assert.deepEqual(await readdir(path.dirname(binary)),['output-helper']);});
test('RUN后已读控制残片即使stdin保持打开也不能成功收口',async t=>{
  const r=await invoke(t,Buffer.alloc(44+1024),{trailingControlFragment:true});
  assert.notEqual(r.exit.code,0,'完整RUN后只有7字节控制残片，协议不能成功');
  assert.equal(r.last.readUInt16LE(6),7);
  assert.equal(r.last.readUInt32LE(12),3,'残片只能归类BAD_PROTOCOL，不能猜测STOP');
  assert.ok(r.events.some(event=>event.readUInt16LE(6)===3),'确实进入过运行阶段');
  assert.ok(!r.events.some(event=>event.readUInt16LE(6)===5),'不得产生SYNTHETIC_DRAINED');
});
