import assert from 'node:assert/strict';
import test from 'node:test';
import { readMobileNeteaseAudioFacts } from '../../src/mobile/netease-audio-facts.js';
import { MobileServiceError } from '../../src/mobile/types.js';

function flac(rate=192000,bits=24,channels=2,samples=192000) {
  const b=Buffer.alloc(96);b.write('fLaC');b[4]=0x80;b.writeUIntBE(34,5,3);b.writeUInt16BE(4096,8);b.writeUInt16BE(4096,10);
  b.writeBigUInt64BE(BigInt(rate)<<44n|BigInt(channels-1)<<41n|BigInt(bits-1)<<36n|BigInt(samples),18);return b;
}
function reader(bytes:Uint8Array){const reads:[number,number][]=[];return {reads,read:async(start:number,n:number)=>{reads.push([start,n]);return bytes.slice(start,start+n);}};}
test('FLAC STREAMINFO 保留实际 24/192 与声道和样本数，不读取整曲',async()=>{
  const data=flac(),r=reader(data),before=Buffer.from(data);
  const facts=await readMobileNeteaseAudioFacts(data.length,r.read,new AbortController().signal);
  assert.deepEqual(facts.audio,{codec:'flac',container:'flac',sampleRateHz:192000,bitsPerSample:24,channels:2});
  assert.equal(facts.durationMs,1000);assert.equal(facts.contentType,'audio/flac');assert.match(facts.headerSha256,/^[a-f0-9]{64}$/);assert.ok(r.reads.every(([,n])=>n<=65536));assert.deepEqual(data,before);
});
test('MP3 两帧真实头给出 rate/channel/bitrate，不造 bitDepth 或整曲时长',async()=>{
  const data=Buffer.alloc(900);data.set([0xff,0xfb,0x90,0x00],0);data.set([0xff,0xfb,0x90,0x00],417);
  const r=reader(data),facts=await readMobileNeteaseAudioFacts(data.length,r.read,new AbortController().signal);
  assert.deepEqual(facts.audio,{codec:'mp3',container:'mp3',sampleRateHz:44100,channels:2,bitrateKbps:128});assert.equal(facts.durationMs,null);assert.equal(facts.contentType,'audio/mpeg');
});
test('假扩展名和 FLAC 截断/未知样本/非法布局都不能创造真实音频',async()=>{
  const invalid=[Buffer.from('https://private.invalid/song.flac'),flac().subarray(0,25),flac(192000,24,2,0)];
  for(const data of invalid)await assert.rejects(readMobileNeteaseAudioFacts(data.length,reader(data).read,new AbortController().signal),
    (e:unknown)=>e instanceof MobileServiceError&&e.code==='UNSUPPORTED_FORMAT');
});
test('ID3 超预算和 MP3 第二帧改变声道均拒绝，读取器短读与超块拒绝',async()=>{
  const id3=Buffer.alloc(100);id3.write('ID3');id3[3]=4;id3.set([0x7f,0x7f,0x7f,0x7f],6);
  await assert.rejects(readMobileNeteaseAudioFacts(300000000,reader(id3).read,new AbortController().signal));
  const data=Buffer.alloc(900);data.set([0xff,0xfb,0x90,0x00],0);data.set([0xff,0xfb,0x90,0xc0],417);
  await assert.rejects(readMobileNeteaseAudioFacts(data.length,reader(data).read,new AbortController().signal));
  await assert.rejects(readMobileNeteaseAudioFacts(96,async()=>new Uint8Array(3),new AbortController().signal));
});
test('读取期间取消不返回晚到 facts，共享或可执行字节对象拒绝',async()=>{
  const controller=new AbortController(),data=flac();
  await assert.rejects(readMobileNeteaseAudioFacts(data.length,async(start,n)=>{controller.abort();return data.slice(start,start+n);},controller.signal));
  await assert.rejects(readMobileNeteaseAudioFacts(96,async()=>new Uint8Array(new SharedArrayBuffer(12)),new AbortController().signal));
});
