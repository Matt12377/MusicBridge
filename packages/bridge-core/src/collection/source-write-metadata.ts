import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import * as dto from '@music-bridge/contracts';
import type { ScanReadFacts } from './local-scan-facts.js';
import type { SourceWriteFileObservation } from './source-write-verify.js';
import { sourceWritesFail } from './local-source-writes-journal.js';

export const SOURCE_FULL_RAW_PARSER='music-metadata-11.15.0/source-writes-full-v1';
const names:Record<dto.LocalSourceWritesField,[string,string]>={title:['TITLE','TIT2'],artist:['ARTIST','TPE1'],album:['ALBUM','TALB'],year:['DATE','TDRC'],disc:['DISCNUMBER','TPOS'],track:['TRACKNUMBER','TRCK']};
const decode=(b:Buffer):string=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{return sourceWritesFail('UNSUPPORTED_TAGS');}};
/** 预览展示真实选中字段的全部值；与生成器独立，不借第一值掩盖 artist 合并影响。 */
export function sourceWriteFieldValues(observation:SourceWriteFileObservation):Partial<Record<dto.LocalSourceWritesField,string[]>>{
  const result:Partial<Record<dto.LocalSourceWritesField,string[]>>={},b=observation.prefix;
  const add=(name:string,value:string,format:0|1):void=>{const key=dto.LOCAL_SOURCE_WRITES_FIELDS.find(k=>names[k][format]===name);if(!key)return;const values=value.split('\0');if(values.some(v=>!dto.isLocalCatalogText(v,true))||(result[key]?.length??0)+values.length>100)return sourceWritesFail('UNSUPPORTED_TAGS');result[key]=[...(result[key]??[]),...values];};
  if(observation.profile==='NATIVE_FLAC_FIXED_TAG_REGION_V1'){
    let at=4;while(at<observation.audioStart){const type=b[at]!&127,end=at+4+b.readUIntBE(at+1,3);if(type===4){const body=b.subarray(at+4,end);let p=0;const take=():Buffer=>{const n=body.readUInt32LE(p);p+=4;const value=body.subarray(p,p+n);p+=n;return value;};take();const count=body.readUInt32LE(p);p+=4;for(let i=0;i<count;i++){const text=decode(take()),eq=text.indexOf('=');add(text.slice(0,eq).toUpperCase(),text.slice(eq+1),0);}}at=end;}
  }else {let at=10;while(at<observation.audioStart&&b[at]!==0){const n=b[at+4]!*2097152+b[at+5]!*16384+b[at+6]!*128+b[at+7]!,body=b.subarray(at+10,at+10+n),id=b.subarray(at,at+4).toString('ascii');if(body[0]===3&&Object.values(names).some(pair=>pair[1]===id))add(id,decode(body.subarray(1)),1);at+=10+n;}}
  return result;
}
/** 真实独立 parser 读取已由完整 FD 哈希绑定的前区；fullRaw 包含缺失字段的真实删除语义。 */
export async function readSourceFullRaw(observation:SourceWriteFileObservation,old:ScanReadFacts):Promise<{fullRaw:dto.LocalMetadata;readFacts:ScanReadFacts}> {
  const {parseBuffer}=await import('music-metadata');
  const parsed=await parseBuffer(observation.prefix,{mimeType:observation.profile==='NATIVE_FLAC_FIXED_TAG_REGION_V1'?'audio/flac':'audio/mpeg',size:observation.bytes},{duration:false,skipCovers:false});
  const c=parsed.common,fullRaw:dto.LocalMetadata={};
  for(const key of ['title','artist','album'] as const)if(c[key]!==undefined)fullRaw[key]=c[key];
  if(c.year!==undefined)fullRaw.year=String(c.year);if(c.disk.no!==null)fullRaw.disc=String(c.disk.no);if(c.track.no!==null)fullRaw.track=String(c.track.no);
  // 第三方 common 的 no=0 会归一化为 null，year也会丢前导零。完整前区的原值是新源事实，不能伪称删除。
  const actual=sourceWriteFieldValues(observation);
  for(const key of ['disc','track'] as const){const values=actual[key],first=values?.[0];if(values?.length===1&&first!==undefined&&/^(0|[1-9][0-9]*)$/u.test(first)&&Number(first)<=100000)fullRaw[key]=first;}
  const year=actual.year?.[0];if(actual.year?.length===1&&year!==undefined&&/^\d{4}$/u.test(year))fullRaw.year=year;
  if(!dto.isLocalMetadata(fullRaw))return sourceWritesFail('UNSUPPORTED_TAGS');
  const pictures=c.picture??[];if(pictures.length>8)return sourceWritesFail('UNSUPPORTED_TAGS');
  const coverEvidence:ScanReadFacts['coverEvidence']=pictures.map(p=>{
    const data=Buffer.from(p.data),mime=data.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?'image/png':data[0]===255&&data[1]===216?'image/jpeg':null;
    if(!mime||!data.length||data.length>4194304)return sourceWritesFail('UNSUPPORTED_TAGS');return {mime,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),evidence:'encoded-bytes-magic-and-digest' as const};
  });
  return {fullRaw,readFacts:{...structuredClone(old),coverEvidence}};
}
