import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, open, writeFile, rm, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as sources from '../src/recording/source-files.js';
import * as wave from '../src/recording/execution-wave.js';

async function fixture(t:test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'replica-lease-')); t.after(() => rm(directory,{recursive:true,force:true}));
  const bytes=Buffer.concat([wave.pcmWaveHeader(8000,1,16,2),Buffer.from([1,0,2,0])]); await writeFile(path.join(directory,'a.wav'),bytes);
  return {directory,bytes,root:{...await sources.authorizeSourceDirectory(directory),id:randomUUID()},expected:{sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}};
}
test('原Render中立解析不伪造profile，返回实际格式和完整PCM证据',async t=>{
  const f=await fixture(t); const handle=await open(path.join(f.directory,'a.wav'),'r');t.after(()=>handle.close());
  assert.ok('inspectReadonlyPcmWave' in wave,'缺少中立原件解析');
  const result=await wave.inspectReadonlyPcmWave(handle,new AbortController().signal);
  assert.deepEqual(result.format,{sampleRate:8000,channelCount:1,sampleFormat:'pcm-s16le'});
  assert.equal(result.audio.sha256,f.expected.sha256); assert.equal(result.audio.frameCount,2);
});
test('Replica有限长租期通过冻结时长推导且原15分钟默认不放宽',async t=>{
  const f=await fixture(t);let now=0,closedHandle:Awaited<ReturnType<typeof open>>|undefined;
  assert.ok('withVerifiedReadonlyReplicaSource' in sources,'缺少显式Replica有限租期');
  await sources.withVerifiedReadonlyReplicaSource(f.root,'a.wav',f.expected,new AbortController().signal,async(handle,check)=>{closedHandle=handle;now=16*60_000;check();},()=>undefined,{durationMs:20*60_000,now:()=>now});
  await assert.rejects(closedHandle!.stat());
  now=0;await assert.rejects(sources.withVerifiedReadonlyReplicaSource(f.root,'a.wav',f.expected,new AbortController().signal,async(_h,check)=>{now=23*60_000;check();},()=>undefined,{durationMs:20*60_000,now:()=>now}));
  await assert.rejects(sources.withVerifiedReadonlyReplicaSource(f.root,'a.wav',f.expected,new AbortController().signal,async()=>{},()=>undefined,{durationMs:6*60*60_000+1}));
});
test('Replica消费中硬链会使内部signal失效，但必须等待消费者收口才释放FD',async t=>{
  const f=await fixture(t);assert.ok('withVerifiedReadonlyReplicaSource' in sources);
  let handle!:Awaited<ReturnType<typeof open>>,finish!:()=>void,aborted!:()=>void;
  const finished=new Promise<void>(r=>{finish=r;}),seenAbort=new Promise<void>(r=>{aborted=r;});
  const run=sources.withVerifiedReadonlyReplicaSource(f.root,'a.wav',f.expected,new AbortController().signal,async(h,_check,signal)=>{handle=h;signal.addEventListener('abort',()=>aborted(),{once:true});await link(path.join(f.directory,'a.wav'),path.join(f.directory,'alias.wav'));await finished;},()=>undefined,{durationMs:1000,watchIntervalMs:5});
  const rejected=assert.rejects(run);await seenAbort;assert.equal((await handle.stat()).nlink,2);finish();await rejected;await assert.rejects(handle.stat());
});

test('格式全量校验属于准备阶段，不消耗短节目消费余量；准备超限零消费',async t=>{
  const f=await fixture(t);let now=0,verified=0,consumed=0;
  await sources.withVerifiedReadonlyReplicaSource(f.root,'a.wav',f.expected,new AbortController().signal,async(_h,check)=>{++consumed;now+=1000;check();},()=>undefined,{durationMs:1000,now:()=>now,verify:async(_h,check)=>{++verified;now=10*60_000;check();}});
  assert.equal(verified,1);assert.equal(consumed,1);
  now=0;consumed=0;
  await assert.rejects(sources.withVerifiedReadonlyReplicaSource(f.root,'a.wav',f.expected,new AbortController().signal,async()=>{++consumed;},()=>undefined,{durationMs:1000,now:()=>now,verify:async(_h,check)=>{now=16*60_000;check();}}));
  assert.equal(consumed,0);
});

test('中立解析四种PCM并拒绝非有限float、RF64与伪帧数',async t=>{
  const f=await fixture(t);
  for(const bits of [16,24,32] as const){
    const bytes=Buffer.concat([wave.pcmWaveHeader(48000,1,bits,1),Buffer.alloc(bits/8),...(bits===24?[Buffer.alloc(1)]:[])]);
    const file=path.join(f.directory,`pcm${bits}.wav`);await writeFile(file,bytes);const handle=await open(file,'r');
    try{const result=await wave.inspectReadonlyPcmWave(handle,new AbortController().signal);assert.equal(result.format.sampleFormat,`pcm-s${bits}le`);assert.equal(result.audio.frameCount,1);}finally{await handle.close();}
  }
  const bytes=Buffer.alloc(60);wave.pcmWaveHeader(48000,1,32,1).copy(bytes,0,0,36);bytes.writeUInt32LE(52,4);bytes.writeUInt16LE(3,20);bytes.write('fact',36);bytes.writeUInt32LE(4,40);bytes.writeUInt32LE(1,44);bytes.write('data',48);bytes.writeUInt32LE(4,52);bytes.writeFloatLE(0.25,56);
  const file=path.join(f.directory,'float.wav');await writeFile(file,bytes);let handle=await open(file,'r');
  try{assert.equal((await wave.inspectReadonlyPcmWave(handle,new AbortController().signal)).format.sampleFormat,'pcm-f32le');}finally{await handle.close();}
  for(const mutate of [(b:Buffer)=>b.writeFloatLE(Infinity,56),(b:Buffer)=>b.write('RF64',0),(b:Buffer)=>b.writeUInt32LE(2,44)]){
    const bad=Buffer.from(bytes);mutate(bad);await writeFile(file,bad);handle=await open(file,'r');try{await assert.rejects(wave.inspectReadonlyPcmWave(handle,new AbortController().signal));}finally{await handle.close();}
  }
});

test('旧只读源入口仍保持15分钟默认，Replica结束后改写也拒绝',async t=>{
  const f=await fixture(t);let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  await assert.rejects(sources.withVerifiedReadonlySource(f.root,'a.wav',f.expected,new AbortController().signal,async(_h,check)=>{clock+=16*60_000;check();}),error=>error instanceof sources.SourceFileError&&error.code==='LIMIT_EXCEEDED');
  await assert.rejects(sources.withVerifiedReadonlyReplicaSource(f.root,'a.wav',f.expected,new AbortController().signal,async()=>{const bytes=Buffer.from(f.bytes);bytes[44]=99;await writeFile(path.join(f.directory,'a.wav'),bytes);},()=>undefined,{durationMs:1000}));
});
