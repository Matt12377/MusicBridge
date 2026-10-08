import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { SourceRegionChange, SourceWriteProfile } from './source-write-format.js';

export const SOURCE_WRITE_FILE_BYTES = 256 * 1024 * 1024;
export const SOURCE_WRITE_PLAN_IO_BYTES = 2 * 1024 * 1024 * 1024;
export class SourceWriteVerificationError extends Error {
  constructor(readonly issue: string) { super(`源文件独立回读拒绝：${issue}。`); }
}
const fail = (issue: string): never => { throw new SourceWriteVerificationError(issue); };
export interface SourceWriteFileObservation {
  sha256: string; bytes: number; audioStart: number; audioPayloadSha256: string;
  signature: string; birthtimeNs: string; permissionMode: string;
  physical: {dev:string;ino:string}; prefix: Buffer; profile: SourceWriteProfile;
}
interface Span { key:string; raw:Buffer; value?:string }
interface IndependentRegion { audioStart:number; profile:SourceWriteProfile; spans:Span[] }
const decode = (bytes:Buffer):string => { try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { return fail('INVALID_UTF8'); } };
const safeSize = (bytes:Buffer,offset:number):number => {
  if(offset+4>bytes.length||bytes.subarray(offset,offset+4).some(n=>n>127))return fail('INVALID_ID3_SIZE');
  return bytes[offset]!*2**21+bytes[offset+1]!*2**14+bytes[offset+2]!*128+bytes[offset+3]!;
};
/** 独立实现只读索引，不调用writer/parser生成器；未知span保留原始字节与顺序。 */
function readRegion(bytes:Buffer):IndependentRegion {
  const spans:Span[]=[];
  if(bytes.subarray(0,4).equals(Buffer.from('fLaC'))){
    let at=4,last=false,blocks=0;
    while(!last){
      if(++blocks>4096||at+4>bytes.length)return fail('INVALID_FLAC_REGION');
      const type=bytes[at]!&127,size=bytes.readUIntBE(at+1,3),end=at+4+size;last=!!(bytes[at]!&128);
      if(end>bytes.length||end>8388608||type>6||type===2)return fail('INVALID_FLAC_REGION');
      const body=bytes.subarray(at+4,end);
      if(type===4){
        let p=0;const value=():Buffer=>{if(p+4>body.length)return fail('INVALID_COMMENT');const n=body.readUInt32LE(p);p+=4;if(n>body.length-p)return fail('INVALID_COMMENT');const b=body.subarray(p,p+n);p+=n;return b;};
        const vendor=value();spans.push({key:'vendor',raw:vendor});if(p+4>body.length)return fail('INVALID_COMMENT');const count=body.readUInt32LE(p);p+=4;if(count>4096)return fail('COMMENT_BUDGET');
        for(let n=0;n<count;n++){const raw=value(),text=decode(raw),eq=text.indexOf('=');if(eq<1)return fail('INVALID_COMMENT');spans.push({key:text.slice(0,eq).toUpperCase(),raw,value:text.slice(eq+1)});}
        if(p!==body.length)return fail('INVALID_COMMENT');
      }else if(type===6){if(body.length<4)return fail('INVALID_PICTURE');spans.push({key:body.readUInt32BE(0)===3?'front':'picture',raw:bytes.subarray(at,end)});}
      else if(type!==1)spans.push({key:`block:${type}`,raw:bytes.subarray(at,end)});
      at=end;
    }
    return {audioStart:at,profile:'NATIVE_FLAC_FIXED_TAG_REGION_V1',spans};
  }
  if(bytes.subarray(0,6).toString('hex')!=='494433040000')return fail('INVALID_ID3_REGION');
  const end=10+safeSize(bytes,6);if(end>bytes.length||end>8388608)return fail('ID3_BUDGET');let at=10;
  while(at<end&&bytes[at]!==0){
    if(spans.length>=4096||at+10>end)return fail('INVALID_ID3_FRAME');const id=bytes.subarray(at,at+4).toString('ascii'),size=safeSize(bytes,at+4),next=at+10+size;
    if(!/^[A-Z0-9]{4}$/u.test(id)||next>end||bytes[at+8]!==0||bytes[at+9]!==0)return fail('INVALID_ID3_FRAME');
    const body=bytes.subarray(at+10,next);let key=id;
    if(id==='APIC'){const mimeEnd=body.indexOf(0,1);if(mimeEnd<1||mimeEnd+1>=body.length)return fail('INVALID_APIC');key=body[mimeEnd+1]===3?'front':'picture';}
    spans.push({key,raw:bytes.subarray(at,next),...(id.startsWith('T')&&body[0]===3?{value:decode(body.subarray(1))}:{})});at=next;
  }
  if(bytes.subarray(at,end).some(n=>n!==0))return fail('INVALID_ID3_PADDING');
  return {audioStart:end,profile:'MPEG1_LAYERIII_ID3V240_FIXED_TAG_REGION_V1',spans};
}
function mpegLength(header:Buffer):number {
  if(header.length<4||header[0]!==255||(header[1]!&254)!==250)return fail('MPEG1_LAYERIII_REQUIRED');
  const bitrate=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0][header[2]!>>>4]!,rate=[44100,48000,32000,0][(header[2]!>>>2)&3]!;
  if(!bitrate||!rate||(header[3]!&3)===2)return fail('INVALID_MPEG_FRAME');return Math.floor(144000*bitrate/rate)+((header[2]!>>>1)&1);
}
/** 真FD完整流读，限制只属于新writer；旧播放/录音读取额度不改变。 */
export async function observeSourceWriteFile(handle:FileHandle,signal?:AbortSignal):Promise<SourceWriteFileObservation> {
  const first=await handle.stat({bigint:true});const size=Number(first.size);
  if(!first.isFile()||first.nlink!==1n||!Number.isSafeInteger(size)||size<1||size>SOURCE_WRITE_FILE_BYTES)return fail('SOURCE_ATTRIBUTE_UNPROVEN');
  const signature=(s:typeof first):string=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
  const prefix=Buffer.alloc(Math.min(size,8388612));let read=0;
  while(read<prefix.length){if(signal?.aborted)return fail('CANCELLED');const v=await handle.read(prefix,read,prefix.length-read,read);if(!v.bytesRead)return fail('TRUNCATED_SOURCE');read+=v.bytesRead;}
  const region=readRegion(prefix),all=createHash('sha256'),audio=createHash('sha256');
  let at=0,frameCarry=Buffer.alloc(0),remainingFrame=0,mpegParameters:string|undefined;
  const chunk=Buffer.alloc(262144);
  while(at<size){
    if(signal?.aborted)return fail('CANCELLED');const v=await handle.read(chunk,0,Math.min(chunk.length,size-at),at);if(!v.bytesRead)return fail('TRUNCATED_SOURCE');const b=chunk.subarray(0,v.bytesRead);all.update(b);
    if(at+b.length>region.audioStart){const payload=b.subarray(Math.max(0,region.audioStart-at));audio.update(payload);
      if(region.profile==='MPEG1_LAYERIII_ID3V240_FIXED_TAG_REGION_V1'){
        let frames=frameCarry.length?Buffer.concat([frameCarry,payload]):payload;frameCarry=Buffer.alloc(0);let p=0;
        while(p<frames.length){if(remainingFrame){const take=Math.min(remainingFrame,frames.length-p);remainingFrame-=take;p+=take;continue;}if(frames.length-p<4){frameCarry=Buffer.from(frames.subarray(p));break;}const header=frames.subarray(p,p+4),parameters=`${(header[2]!>>>2)&3}:${header[3]!>>>6===3?1:2}`;if(mpegParameters!==undefined&&parameters!==mpegParameters)return fail('MPEG_PARAMETERS_CHANGED');mpegParameters=parameters;remainingFrame=mpegLength(header);}
      }
    }
    at+=b.length;
  }
  if(remainingFrame||frameCarry.length)return fail('TRAILING_OR_TRUNCATED_MPEG');
  const last=await handle.stat({bigint:true});if(signature(first)!==signature(last)||first.birthtimeNs!==last.birthtimeNs||first.mode!==last.mode)return fail('SOURCE_CHANGED_DURING_READ');
  return {sha256:all.digest('hex'),bytes:size,audioStart:region.audioStart,audioPayloadSha256:audio.digest('hex'),signature:signature(last),birthtimeNs:String(last.birthtimeNs),permissionMode:String(last.mode&0o7777n),physical:{dev:String(last.dev),ino:String(last.ino)},prefix,profile:region.profile};
}
/** 目标值独立回读，并比较所有未选span及完整audio SHA；Hash改变不能掩盖音频改变。 */
export function verifySourceWriteResult(before:SourceWriteFileObservation,after:SourceWriteFileObservation,change:SourceRegionChange):void {
  if(before.profile!==after.profile||before.bytes!==after.bytes||before.audioStart!==after.audioStart||before.audioPayloadSha256!==after.audioPayloadSha256)return fail('AUDIO_PAYLOAD_CHANGED');
  const old=readRegion(before.prefix),fresh=readRegion(after.prefix),flac=old.profile==='NATIVE_FLAC_FIXED_TAG_REGION_V1';
  const mapping={title:flac?'TITLE':'TIT2',artist:flac?'ARTIST':'TPE1',album:flac?'ALBUM':'TALB',year:flac?'DATE':'TDRC',disc:flac?'DISCNUMBER':'TPOS',track:flac?'TRACKNUMBER':'TRCK'};
  const selected=new Set('fields'in change?Object.keys(change.fields).map(k=>mapping[k as keyof typeof mapping]):['front']);
  const retained=(spans:Span[]):Span[]=>spans.filter(s=>!selected.has(s.key));const a=retained(old.spans),b=retained(fresh.spans);
  if(a.length!==b.length||a.some((span,i)=>span.key!==b[i]!.key||!span.raw.equals(b[i]!.raw)))return fail('UNTARGETED_METADATA_CHANGED');
  if('fields'in change)for(const key of Object.keys(change.fields) as (keyof typeof mapping)[]){const action=change.fields[key]!,found=fresh.spans.filter(s=>s.key===mapping[key]);if(action.action==='remove'?found.length!==0:found.length!==1||found[0]!.value!==action.value)return fail('TARGET_VALUE_MISMATCH');}
  else {const found=fresh.spans.filter(s=>s.key==='front');if(change.frontImage?found.length!==1:found.length!==0)return fail('FRONT_COVER_MISMATCH');if(change.frontImage&&!found[0]!.raw.subarray(found[0]!.raw.length-change.frontImage.bytes.length).equals(change.frontImage.bytes))return fail('FRONT_COVER_MISMATCH');}
}
