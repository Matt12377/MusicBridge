import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, open, mkdtemp, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeSourceTagRegion, inspectSourceTagRegion, SourceWriteFormatError } from '../../src/collection/source-write-format.js';
import { observeSourceWriteFile, verifySourceWriteResult, SourceWriteVerificationError } from '../../src/collection/source-write-verify.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

const sync=(n:number):Buffer=>Buffer.from([(n>>>21)&127,(n>>>14)&127,(n>>>7)&127,n&127]);
function frame(id:string,value:Buffer):Buffer {return Buffer.concat([Buffer.from(id),sync(value.length),Buffer.alloc(2),value]);}
function id3():Buffer {const body=Buffer.concat([frame('TIT2',Buffer.from('\x03原名称')),frame('TPE1',Buffer.from('\x03甲\x00乙')),frame('TXXX',Buffer.from('\x03私人键\x00原值')),Buffer.alloc(512)]);return Buffer.concat([Buffer.from('ID3\x04\x00\x00'),sync(body.length),body,Buffer.from([0xff,0xfb,0x90,0x00])]);}
function block(type:number,body:Buffer,last=false):Buffer {const h=Buffer.alloc(4);h[0]=type|(last?128:0);h.writeUIntBE(body.length,1,3);return Buffer.concat([h,body]);}
function flac():Buffer {const stream=Buffer.alloc(34);stream.writeUInt16BE(4096,0);stream.writeUInt16BE(4096,2);stream.writeBigUInt64BE((44100n<<44n)|(1n<<41n)|(15n<<36n)|44100n,10);const parts=[Buffer.from('TITLE=原名称'),Buffer.from('ARTIST=甲'),Buffer.from('ARTIST=乙'),Buffer.from('X-PRIVATE=原始值')];const vendor=Buffer.from('自有合成');const sizes=[vendor,...parts].map(b=>{const n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);});const count=Buffer.alloc(4);count.writeUInt32LE(parts.length);return Buffer.concat([Buffer.from('fLaC'),block(0,stream),block(4,Buffer.concat([sizes[0]!,count,...sizes.slice(1)])),block(1,Buffer.alloc(512),true),Buffer.from([0xff,0xf8,0,0])]);}

for(const [name,make] of [['FLAC',flac],['ID3v2.4',id3]] as const)test(`012 ${name} 固定前部标签区只改选中字段，未知和未选多值原字节保留`,()=>{
  const input=make(),before=inspectSourceTagRegion(input,input.length+1000),output=writeSourceTagRegion(input,input.length+1000,{fields:{title:{action:'set',value:'新名称'}}});
  assert.equal(output.audioStart,before.audioStart);assert.equal(output.bytes.length,before.audioStart);assert.equal(input.subarray(before.audioStart).toString('hex'),make().subarray(before.audioStart).toString('hex'));
  const oldUnknown=name==='FLAC'?Buffer.from('X-PRIVATE=原始值'):frame('TXXX',Buffer.from('\x03私人键\x00原值'));assert.ok(output.bytes.includes(oldUnknown));
  const multiple=name==='FLAC'?Buffer.from('ARTIST=乙'):frame('TPE1',Buffer.from('\x03甲\x00乙'));assert.ok(output.bytes.includes(multiple));
  const merged=writeSourceTagRegion(input,input.length+1000,{fields:{artist:{action:'set',value:'单值'}}});assert.equal(merged.fields.artist,'单值');assert.ok(!merged.bytes.includes(multiple));
  const removed=writeSourceTagRegion(input,input.length+1000,{fields:{title:{action:'remove'}}});assert.equal(removed.audioStart,before.audioStart);assert.equal(removed.fields.title,undefined);
});
test('012 ID3v2.3、unsynchronisation、改变audioStart与padding不足均拒写',()=>{
  const old=id3();old[3]=3;assert.throws(()=>inspectSourceTagRegion(old,old.length+1000),SourceWriteFormatError);
  const unsync=id3();unsync[5]=128;assert.throws(()=>inspectSourceTagRegion(unsync,unsync.length+1000),SourceWriteFormatError);
  assert.throws(()=>writeSourceTagRegion(id3(),id3().length+1000,{fields:{title:{action:'set',value:'大'.repeat(512)}}}),SourceWriteFormatError);
});
test('012 FLAC APPLICATION块未证变体与非artist目标多义明确拒写',()=>{
  const input=flac(),withApplication=Buffer.concat([input.subarray(0,42),block(2,Buffer.from('APP0')),input.subarray(42)]);
  assert.throws(()=>inspectSourceTagRegion(withApplication,withApplication.length+1000),SourceWriteFormatError);
  const original=id3(),extra=frame('TRCK',Buffer.from('\x032/12')),head=original.subarray(0,10),body=Buffer.concat([extra,original.subarray(10,original.length-4)]);const numbered=Buffer.concat([head.subarray(0,6),sync(body.length),body,original.subarray(-4)]);
  assert.throws(()=>writeSourceTagRegion(numbered,numbered.length+1000,{fields:{track:{action:'set',value:'3'}}}),SourceWriteFormatError);
});
const fixtures=new URL('../fixtures/mbrs012-source/',import.meta.url);
async function fixtureBytes(file:string):Promise<Buffer>{
  const raw=await readFile(new URL('manifest.json',fixtures));assert.equal(createHash('sha256').update(raw).digest('hex'),'5a3621481eb22801c020589b393c3a1ffa32e3d132766ea6e8db6e33fa47714b');
  const manifest=JSON.parse(raw.toString('utf8')) as {synthetic:boolean;allContentOwned:boolean;realLibraryUsed:boolean;files:{file:string;bytes:number;sha256:string}[]};assert.equal(manifest.synthetic,true);assert.equal(manifest.allContentOwned,true);assert.equal(manifest.realLibraryUsed,false);
  const entry=manifest.files.find(entry=>entry.file===file);assert.ok(entry);const bytes=await readFile(new URL(file,fixtures));assert.equal(bytes.length,entry.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);return bytes;
}
async function evidenceDirectory(prefix:string):Promise<string>{const storage=buildStoragePolicy(),temporary=storage.check(process.env.TMPDIR!,{mustExist:true}),directory=await mkdtemp(path.join(temporary,prefix));storage.check(directory,{mustExist:true});const info=await lstat(directory);assert.equal(info.isDirectory(),true);assert.equal(info.isSymbolicLink(),false);assert.equal(info.mode&0o777,0o700);return directory;}
for(const [file,mime]of [['owned-stereo-fixed-tags.flac','audio/flac'],['owned-stereo-id3v240.mp3','audio/mpeg']]as const)test(`012 自有 ${mime} 真FD独立核验六字段set/remove、前封面与完整payload，保留输出供独立解码`,async t=>{
  const directory=await evidenceDirectory('mbrs012-format-'),bytes=await fixtureBytes(file),beforeFile=path.join(directory,`before-${file}`);await writeFile(beforeFile,bytes,{flag:'wx'});
  const beforeHandle=await open(beforeFile,'r');let before;try{before=await observeSourceWriteFile(beforeHandle);}finally{await beforeHandle.close();}
  const fields={title:{action:'set',value:'写后新标题'},artist:{action:'set',value:'显式单艺人'},album:{action:'set',value:'写后专辑'},year:{action:'set',value:'2024'},disc:{action:'set',value:'0'},track:{action:'set',value:'100000'}}as const;
  const changed=writeSourceTagRegion(before.prefix,before.bytes,{fields}),written=path.join(directory,`written-${file}`);await writeFile(written,Buffer.concat([changed.bytes,bytes.subarray(before.audioStart)]),{flag:'wx'});
  const handle=await open(written,'r');let after;try{after=await observeSourceWriteFile(handle);verifySourceWriteResult(before,after,{fields});}finally{await handle.close();}
  assert.equal(after.audioPayloadSha256,before.audioPayloadSha256);assert.notEqual(after.sha256,before.sha256);
  const remove={title:{action:'remove'},artist:{action:'remove'},album:{action:'remove'},year:{action:'remove'},disc:{action:'remove'},track:{action:'remove'}}as const,removed=writeSourceTagRegion(after.prefix,after.bytes,{fields:remove}),removedPath=path.join(directory,`removed-${file}`);await writeFile(removedPath,Buffer.concat([removed.bytes,bytes.subarray(before.audioStart)]),{flag:'wx'});
  const removedHandle=await open(removedPath,'r');try{const final=await observeSourceWriteFile(removedHandle);verifySourceWriteResult(after,final,{fields:remove});assert.deepEqual(inspectSourceTagRegion(final.prefix,final.bytes).fields,{});}finally{await removedHandle.close();}
  const picture=await fixtureBytes('owned-cover-16.png'),image={mime:'image/png' as const,width:16,height:16,depth:24,bytes:picture},covered=writeSourceTagRegion(after.prefix,after.bytes,{frontImage:image}),coverPath=path.join(directory,`covered-${file}`);await writeFile(coverPath,Buffer.concat([covered.bytes,bytes.subarray(before.audioStart)]),{flag:'wx'});
  const coverHandle=await open(coverPath,'r');try{const final=await observeSourceWriteFile(coverHandle);verifySourceWriteResult(after,final,{frontImage:image});}finally{await coverHandle.close();}
  t.diagnostic(`独立音频工具验证材料保留：${directory}`);
});
test('012 完整MP3帧链拒绝伪首header、截断帧与未证尾部',async()=>{
  const directory=await evidenceDirectory('mbrs012-bad-mpeg-'),valid=await fixtureBytes('owned-stereo-id3v240.mp3');
  for(const [label,bytes]of [['trailer',Buffer.concat([valid,Buffer.from('TAG不明尾部')])],['truncated',valid.subarray(0,valid.length-1)],['fake',id3()]]as const){const file=path.join(directory,`${label}.mp3`);await writeFile(file,bytes,{flag:'wx'});const handle=await open(file,'r');try{await assert.rejects(observeSourceWriteFile(handle),SourceWriteVerificationError);}finally{await handle.close();}}
});
