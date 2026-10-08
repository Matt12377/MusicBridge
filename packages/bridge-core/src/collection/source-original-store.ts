import { constants } from 'node:fs';
import { mkdir, lstat, open, realpath, opendir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import * as dto from '@music-bridge/contracts';
import type { LocalArtworkStore } from './local-artwork-store.js';
import { sourceWritesEvent, sourceWritesFail, sourceWritesHash, type SourceWritesEvent } from './local-source-writes-journal.js';

type OriginalEvent=Extract<SourceWritesEvent,{kind:'original'}>;
interface Access {datasetId:string;directory:string;assertCurrent():void;artwork:Pick<LocalArtworkStore,'assertTarget'|'inspectCandidate'>;read():readonly OriginalEvent[];cached(commandId:string,fingerprint:string):OriginalEvent|null;append(event:OriginalEvent):void}
export interface SourceOriginalMaterial {contentRef:string;candidateId:string;target:dto.LocalArtworkTarget;original:dto.LocalArtworkImageInfo;bytes:Buffer;depth:number}
const crc=(b:Buffer):number=>{let n=0xffffffff;for(const byte of b){n^=byte;for(let bit=0;bit<8;bit++)n=n&1?0xedb88320^(n>>>1):n>>>1;}return (n^0xffffffff)>>>0;};
/** Main先真实解码；Owner再独立核magic、结构、尺寸、完整原Hash，不能用缩略图冒充原件。 */
export function inspectSourceOriginal(bytes:Buffer):{mime:'image/png'|'image/jpeg';width:number;height:number;depth:number}{
  if(bytes.length<1||bytes.length>4194304)return sourceWritesFail('ARTWORK_UNAVAILABLE');
  if(bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'){
    let at=8,width=0,height=0,channels=0,done=false,seenIdat=false,idatEnded=false,chunks=0;const idat:Buffer[]=[];
    while(at<bytes.length){if(++chunks>2048||at+12>bytes.length)return sourceWritesFail('ARTWORK_UNAVAILABLE');const size=bytes.readUInt32BE(at),name=bytes.subarray(at+4,at+8).toString('ascii'),end=at+12+size;if(end>bytes.length||crc(bytes.subarray(at+4,at+8+size))!==bytes.readUInt32BE(at+8+size))return sourceWritesFail('ARTWORK_UNAVAILABLE');const body=bytes.subarray(at+8,at+8+size);
      if(chunks===1){if(name!=='IHDR'||size!==13)return sourceWritesFail('ARTWORK_UNAVAILABLE');width=body.readUInt32BE(0);height=body.readUInt32BE(4);channels=body[9]===2?3:body[9]===6?4:0;if(!channels||body[8]!==8||body[10]!==0||body[11]!==0||body[12]!==0)return sourceWritesFail('ARTWORK_UNAVAILABLE');}
      else if(name==='IHDR'||['acTL','fcTL','fdAT'].includes(name))return sourceWritesFail('ARTWORK_UNAVAILABLE');
      if(name==='IDAT'){if(idatEnded)return sourceWritesFail('ARTWORK_UNAVAILABLE');seenIdat=true;idat.push(body);}else if(seenIdat)idatEnded=true;
      if(name==='IEND'){if(size!==0||!seenIdat||end!==bytes.length)return sourceWritesFail('ARTWORK_UNAVAILABLE');done=true;break;}
      at=end;
    }
    if(!done||!width||!height||width>4096||height>4096||width*height>16777216)return sourceWritesFail('ARTWORK_UNAVAILABLE');
    let raw:Buffer;try{raw=inflateSync(Buffer.concat(idat),{maxOutputLength:67108864});}catch{return sourceWritesFail('ARTWORK_UNAVAILABLE');}
    const stride=width*channels+1;if(raw.length!==stride*height)return sourceWritesFail('ARTWORK_UNAVAILABLE');for(let row=0;row<height;row++)if(raw[row*stride]!>4)return sourceWritesFail('ARTWORK_UNAVAILABLE');
    return {mime:'image/png',width,height,depth:channels*8};
  }
  if(bytes[0]!==255||bytes[1]!==216)return sourceWritesFail('ARTWORK_UNAVAILABLE');let at=2,width=0,height=0,components=0,scans=0,markers=0;
  while(at<bytes.length){if(++markers>2048||bytes[at++]!==255)return sourceWritesFail('ARTWORK_UNAVAILABLE');while(bytes[at]===255)at++;const kind=bytes[at++]!;
    if(kind===217){if(at!==bytes.length||!scans||!width||!height||width>4096||height>4096||width*height>16777216)return sourceWritesFail('ARTWORK_UNAVAILABLE');return {mime:'image/jpeg',width,height,depth:components*8};}
    if(at+2>bytes.length||kind===0||kind===216||kind>=208&&kind<=215)return sourceWritesFail('ARTWORK_UNAVAILABLE');const size=bytes.readUInt16BE(at),end=at+size;if(size<2||end>bytes.length)return sourceWritesFail('ARTWORK_UNAVAILABLE');
    if(kind>=192&&kind<=207&&![196,200,204].includes(kind)){if(kind!==192||width||size<11||bytes[at+2]!==8)return sourceWritesFail('ARTWORK_UNAVAILABLE');height=bytes.readUInt16BE(at+3);width=bytes.readUInt16BE(at+5);components=bytes[at+7]!;if(![1,3].includes(components)||size!==8+3*components)return sourceWritesFail('ARTWORK_UNAVAILABLE');}
    at=end;if(kind===218){if(++scans!==1||!width)return sourceWritesFail('ARTWORK_UNAVAILABLE');while(at<bytes.length){if(bytes[at++]!==255)continue;const next=bytes[at]!;if(next===0||next>=208&&next<=215){at++;continue;}at--;break;}}
  }
  return sourceWritesFail('ARTWORK_UNAVAILABLE');
}
export function createSourceOriginalStore(access:Access){
  let closed=false,queued=0;let tail:Promise<void>=Promise.resolve();
  async function directory():Promise<string>{await mkdir(access.directory,{recursive:true,mode:0o700});const actual=await realpath(access.directory),info=await lstat(actual,{bigint:true});if(actual!==access.directory||!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777n)!==0o700n)return sourceWritesFail('ARTWORK_UNAVAILABLE');return actual;}
  async function usage():Promise<{bytes:number;count:number}>{const root=await directory(),stream=await opendir(root);let bytes=0,count=0;for await(const file of stream){const s=await lstat(path.join(root,file.name),{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||!/^[0-9a-f-]{36}\.blob$/u.test(file.name))return sourceWritesFail('ARTWORK_UNAVAILABLE');count++;bytes+=Number(s.size);if(count>128||bytes>67108864)return sourceWritesFail('BUDGET_EXCEEDED');}return {bytes,count};}
  async function load(event:OriginalEvent):Promise<SourceOriginalMaterial>{const file=path.join(await directory(),`${event.contentRef}.blob`);if(file!==event.file)return sourceWritesFail('ARTWORK_UNAVAILABLE');const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
    try{const s=await handle.stat({bigint:true});if(!s.isFile()||s.nlink!==1n||Number(s.size)!==event.original.bytes||s.size>4194304n)return sourceWritesFail('ARTWORK_UNAVAILABLE');bytes=Buffer.alloc(Number(s.size));let at=0;while(at<bytes.length){const v=await handle.read(bytes,at,bytes.length-at,at);if(!v.bytesRead)return sourceWritesFail('ARTWORK_UNAVAILABLE');at+=v.bytesRead;}}
    finally{await handle.close();}
    const info=inspectSourceOriginal(bytes);if(createHash('sha256').update(bytes).digest('hex')!==event.original.sha256||info.mime!==event.original.mime||info.width!==event.original.width||info.height!==event.original.height)return sourceWritesFail('ARTWORK_CHANGED');return {contentRef:event.contentRef,candidateId:event.candidateId,target:structuredClone(event.target),original:structuredClone(event.original),bytes,depth:info.depth};
  }
  const api={
    async attach(raw:dto.AttachLocalSourceWritesOriginal):Promise<dto.LocalSourceWritesOriginalReceipt>{
      const request=dto.localSourceWritesOriginalSnapshot(raw);access.assertCurrent();if(request.datasetId!==access.datasetId)return sourceWritesFail('DATASET_SCOPE_MISMATCH');
      const {bytes:binary,...metadata}=request,bytes=Buffer.from(binary),sha256=createHash('sha256').update(bytes).digest('hex'),fingerprint=sourceWritesHash(metadata),old=access.cached(request.commandId,fingerprint);
      if(sha256!==request.original.sha256||bytes.length!==request.original.bytes)return sourceWritesFail('ARTWORK_CHANGED');
      const image=inspectSourceOriginal(bytes);if(image.mime!==request.original.mime||image.width!==request.original.width||image.height!==request.original.height)return sourceWritesFail('ARTWORK_CHANGED');
      if(old){const material=await load(old);return {contentRef:material.contentRef,sha256:material.original.sha256,bytes:material.original.bytes};}
      access.artwork.assertTarget(request.target);const candidate=access.artwork.inspectCandidate(request.target.editionId,request.candidateId);
      if(!candidate||sourceWritesHash(candidate.original)!==sourceWritesHash(request.original)||sha256!==request.original.sha256||bytes.length!==request.original.bytes||image.mime!==request.original.mime||image.width!==request.original.width||image.height!==request.original.height)return sourceWritesFail('ARTWORK_CHANGED');
      const current=await usage();if(current.count>=128||current.bytes+bytes.length>67108864)return sourceWritesFail('BUDGET_EXCEEDED');const contentRef=randomUUID(),file=path.join(await directory(),`${contentRef}.blob`),handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{let at=0;while(at<bytes.length){const v=await handle.write(bytes,at,bytes.length-at,at);if(!v.bytesWritten)return sourceWritesFail('ARTWORK_UNAVAILABLE');at+=v.bytesWritten;}await handle.sync();}finally{await handle.close();}
      const directoryHandle=await open(access.directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directoryHandle.sync();}finally{await directoryHandle.close();}
      access.assertCurrent();access.artwork.assertTarget(request.target);const event=sourceWritesEvent({version:1 as const,eventId:randomUUID(),datasetId:access.datasetId,planId:null,occurredAt:new Date().toISOString(),kind:'original' as const,commandId:request.commandId,requestFingerprint:fingerprint,target:request.target,candidateId:request.candidateId,original:request.original,contentRef,file});access.append(event);return {contentRef,sha256,bytes:bytes.length};
    },
    async get(ref:dto.LocalSourceWritesArtworkRef):Promise<SourceOriginalMaterial>{access.assertCurrent();const e=access.read().find(e=>e.contentRef===ref.contentRef&&e.datasetId===access.datasetId);if(!e||e.candidateId!==ref.candidateId||e.target.editionId!==ref.editionId||e.original.sha256!==ref.originalSha256)return sourceWritesFail('ARTWORK_UNAVAILABLE');return load(e);},
    refs():readonly OriginalEvent[]{return access.read().filter(e=>e.datasetId===access.datasetId);},
    usage,
  };
  return {...api,attach(raw:dto.AttachLocalSourceWritesOriginal):Promise<dto.LocalSourceWritesOriginalReceipt>{
    if(closed||queued>=4)return Promise.reject(new Error('原件留存已关闭或达到有界排队容量。'));
    const captured=dto.localSourceWritesOriginalSnapshot(raw);queued++;
    const task=tail.then(()=>{if(closed)return sourceWritesFail('ARTWORK_UNAVAILABLE');return api.attach(captured);});tail=task.then(()=>undefined,()=>undefined);
    return task.finally(()=>{queued--;});
  },async close():Promise<void>{closed=true;await tail;}};
}
export type SourceOriginalStore=ReturnType<typeof createSourceOriginalStore>;
