import { TextDecoder } from 'node:util';

/** 仅新源作者使用；拒写范围不改变原扫描、录音或普通播放的格式能力。 */
export const SOURCE_TAG_REGION_BYTES=8*1024*1024, SOURCE_TAG_PARTS=4096;
export type SourceWriteProfile='NATIVE_FLAC_FIXED_TAG_REGION_V1'|'MPEG1_LAYERIII_ID3V240_FIXED_TAG_REGION_V1';
export type SourceTagKey='title'|'artist'|'album'|'year'|'disc'|'track';
export type SourceTagPatch=Partial<Record<SourceTagKey,{action:'set';value:string}|{action:'remove'}>>;
export interface SourceFrontImage {mime:'image/png'|'image/jpeg';width:number;height:number;depth:number;bytes:Buffer}
export type SourceRegionChange={fields:SourceTagPatch}|{frontImage:SourceFrontImage|null};
interface Part {id:string;raw:Buffer;body:Buffer;kind:number}
export interface SourceTagRegion {profile:SourceWriteProfile;audioStart:number;fields:Partial<Record<SourceTagKey,string>>;parts:readonly Part[];padding:number}
export class SourceWriteFormatError extends Error {constructor(readonly issue:string){super(`源写格式未准入：${issue}。`);}}
const fail=(issue:string):never=>{throw new SourceWriteFormatError(issue);};
const utf8=(value:Buffer):string=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{return fail('INVALID_UTF8');}};
const plain=(value:string):boolean=>value.length<=512&&!/[\u0000-\u001f\u007f]/u.test(value);
const decimal=(value:string):boolean=>/^(?:0|[1-9]\d{0,5})$/u.test(value)&&Number(value)<=100000;
const names:Record<SourceTagKey,[string,string]>={title:['TITLE','TIT2'],artist:['ARTIST','TPE1'],album:['ALBUM','TALB'],year:['DATE','TDRC'],disc:['DISCNUMBER','TPOS'],track:['TRACKNUMBER','TRCK']};
const keyFor=(name:string,format:0|1):SourceTagKey|undefined=>(Object.keys(names) as SourceTagKey[]).find(key=>names[key][format]===name);
function checkedValue(key:SourceTagKey,value:string):void {if(!plain(value)||key==='year'&&!/^\d{4}$/u.test(value)||(key==='disc'||key==='track')&&!decimal(value))fail('UNREPRESENTABLE_FIELD');}
function size4(value:Buffer,at:number):number {if(at+4>value.length||value.subarray(at,at+4).some(n=>n>127))return fail('INVALID_SYNCHSAFE');return value[at]!*2097152+value[at+1]!*16384+value[at+2]!*128+value[at+3]!;}
function encode4(size:number):Buffer {return Buffer.from([(size>>>21)&127,(size>>>14)&127,(size>>>7)&127,size&127]);}
function block(type:number,body:Buffer,last=false):Buffer {if(body.length>0xffffff)fail('TAG_REGION_BUDGET');const head=Buffer.alloc(4);head[0]=type|(last?128:0);head.writeUIntBE(body.length,1,3);return Buffer.concat([head,body]);}
function frame(id:string,body:Buffer):Buffer {return Buffer.concat([Buffer.from(id,'ascii'),encode4(body.length),Buffer.alloc(2),body]);}
interface Comments {vendor:Buffer;items:Buffer[]}
function comments(body:Buffer):Comments {
  let offset=0;const take=():Buffer=>{if(offset+4>body.length)return fail('INVALID_VORBIS_COMMENT');const length=body.readUInt32LE(offset);offset+=4;if(length>body.length-offset)return fail('INVALID_VORBIS_COMMENT');const bytes=body.subarray(offset,offset+length);offset+=length;utf8(bytes);return bytes;};
  const vendor=take();if(offset+4>body.length)return fail('INVALID_VORBIS_COMMENT');const count=body.readUInt32LE(offset);offset+=4;if(count>SOURCE_TAG_PARTS)return fail('TAG_PART_BUDGET');const items:Buffer[]=[];
  for(let i=0;i<count;i++){const value=take(),text=utf8(value),eq=text.indexOf('=');if(eq<1||!/^[-\x20-\x3c\x3e-\x7d]+$/u.test(text.slice(0,eq)))return fail('INVALID_COMMENT_NAME');items.push(value);}
  if(offset!==body.length)return fail('INVALID_VORBIS_COMMENT');return {vendor,items};
}
function encodeComments(value:Comments):Buffer {const count=Buffer.alloc(4);count.writeUInt32LE(value.items.length);const sized=(b:Buffer):Buffer=>{const n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b]);};return Buffer.concat([sized(value.vendor),count,...value.items.map(sized)]);}
function commentName(value:Buffer):string {const text=utf8(value);return text.slice(0,text.indexOf('=')).toUpperCase();}
function textFrame(body:Buffer):string {if(body[0]!==3)return fail('TARGET_TEXT_ENCODING');return utf8(body.subarray(1));}
function extract(parts:readonly Part[],flac:boolean):Partial<Record<SourceTagKey,string>> {
  const fields:Partial<Record<SourceTagKey,string>>={};
  if(flac){const v=parts.find(part=>part.kind===4);if(v)for(const b of comments(v.body).items){const text=utf8(b),key=keyFor(commentName(b),0);if(key&&fields[key]===undefined)fields[key]=text.slice(text.indexOf('=')+1);}}
  else for(const part of parts){const key=keyFor(part.id,1);if(key&&part.body[0]===3&&fields[key]===undefined)fields[key]=utf8(part.body.subarray(1));}
  return fields;
}
export function inspectSourceTagRegion(prefix:Buffer,fileSize:number):SourceTagRegion {
  if(!Buffer.isBuffer(prefix)||!Number.isSafeInteger(fileSize)||fileSize<=0)return fail('INVALID_SOURCE_SIZE');
  const parts:Part[]=[];
  if(prefix.subarray(0,4).toString('ascii')==='fLaC'){
    let offset=4,last=false,padding=0;
    while(!last){if(parts.length>=SOURCE_TAG_PARTS||offset+4>prefix.length||offset+4>SOURCE_TAG_REGION_BYTES)return fail('TAG_REGION_BUDGET');const kind=prefix[offset]!&127,length=prefix.readUIntBE(offset+1,3);last=!!(prefix[offset]!&128);const end=offset+4+length;if(end>prefix.length||end>SOURCE_TAG_REGION_BYTES||end>=fileSize||kind>6||kind===2)return fail('INVALID_FLAC_BLOCK');const body=prefix.subarray(offset+4,end);parts.push({id:String(kind),kind,body,raw:prefix.subarray(offset,end)});offset=end;}
    if(parts[0]?.kind!==0||parts[0].body.length!==34||parts.filter(p=>p.kind===0).length!==1||parts.filter(p=>p.kind===4).length>1)return fail('INVALID_FLAC_STREAMINFO');
    const bits=parts[0].body.readBigUInt64BE(10),rate=Number(bits>>44n),samples=bits&0xfffffffffn;if(rate<1||rate>655350||samples<1n)return fail('INVALID_FLAC_STREAMINFO');
    const pads=parts.filter(p=>p.kind===1);if(pads.length!==1||parts.at(-1)?.kind!==1||pads[0]!.body.some(b=>b!==0))return fail('FLAC_FINAL_PADDING_REQUIRED');padding=pads[0]!.body.length;
    return {profile:'NATIVE_FLAC_FIXED_TAG_REGION_V1',audioStart:offset,parts,padding,fields:extract(parts,true)};
  }
  if(prefix.subarray(0,3).toString('ascii')!=='ID3'||prefix[3]!==4||prefix[4]!==0||prefix[5]!==0||prefix.length<14)return fail('ID3V240_FLAGS0_REQUIRED');
  const end=10+size4(prefix,6);if(end>SOURCE_TAG_REGION_BYTES||end>prefix.length||end+4>=fileSize)return fail('TAG_REGION_BUDGET');
  let offset=10;
  while(offset<end&&prefix[offset]!==0){if(parts.length>=SOURCE_TAG_PARTS||offset+10>end)return fail('INVALID_ID3_FRAME');const id=prefix.subarray(offset,offset+4).toString('ascii'),length=size4(prefix,offset+4);if(!/^[A-Z0-9]{4}$/u.test(id)||length<1||offset+10+length>end||prefix[offset+8]!==0||prefix[offset+9]!==0)return fail('ID3_FRAME_FLAGS0_REQUIRED');const next=offset+10+length;parts.push({id,kind:0,body:prefix.subarray(offset+10,next),raw:prefix.subarray(offset,next)});offset=next;}
  if(prefix.subarray(offset,end).some(b=>b!==0))return fail('INVALID_ID3_PADDING');
  const h=prefix.subarray(end,end+4);if(h[0]!==255||(h[1]!&254)!==250||(h[2]!>>>4)===0||(h[2]!>>>4)===15||((h[2]!>>>2)&3)===3)return fail('MPEG1_LAYERIII_REQUIRED');
  return {profile:'MPEG1_LAYERIII_ID3V240_FIXED_TAG_REGION_V1',audioStart:end,parts,padding:end-offset,fields:extract(parts,false)};
}
function changedComments(old:Comments,patch:SourceTagPatch):Comments {
  let items=[...old.items];
  for(const key of Object.keys(patch) as SourceTagKey[]){const change=patch[key]!;const indexes=items.flatMap((value,i)=>commentName(value)===names[key][0]?[i]:[]);if(key!=='artist'&&indexes.length>1)return fail('TARGET_MULTIVALUE_AMBIGUOUS');
    for(const index of indexes){const text=utf8(items[index]!),current=text.slice(text.indexOf('=')+1);if(!(key==='artist'?current.split('\0').every(plain):plain(current))||key==='year'&&!/^\d{4}$/u.test(current)||(key==='disc'||key==='track')&&!decimal(current))return fail('TARGET_VALUE_AMBIGUOUS');}
    if(change.action==='remove'){items=items.filter((_v,i)=>!indexes.includes(i));continue;}checkedValue(key,change.value);
    const value=Buffer.from(`${indexes.length?utf8(items[indexes[0]!]!).split('=')[0]:names[key][0]}=${change.value}`,'utf8');if(indexes.length){items[indexes[0]!]=value;items=items.filter((_v,i)=>!indexes.slice(1).includes(i));}else items.push(value);
  }
  return {vendor:old.vendor,items};
}
function imageBytes(image:SourceFrontImage):void {if(image.bytes.length<1||image.bytes.length>4194304||!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||image.width<1||image.height<1||image.width>4096||image.height>4096||image.width*image.height>16777216)return fail('IMAGE_BUDGET');}
function flacFront(body:Buffer):boolean {
  let offset=0;
  const number=():number=>{if(offset+4>body.length)return fail('INVALID_FLAC_PICTURE');const n=body.readUInt32BE(offset);offset+=4;return n;};
  const take=():Buffer=>{const n=number();if(n>body.length-offset)return fail('INVALID_FLAC_PICTURE');const value=body.subarray(offset,offset+n);offset+=n;return value;};
  const kind=number(),mime=take().toString('ascii');utf8(take());
  const width=number(),height=number(),depth=number();number();const bytes=take();
  if(offset!==body.length||!width||!height||!depth||!bytes.length)return fail('INVALID_FLAC_PICTURE');
  if(kind===3&&!['image/png','image/jpeg'].includes(mime))return fail('FRONT_COVER_FORMAT_UNPROVEN');
  return kind===3;
}
function encodePicture(image:SourceFrontImage):Buffer {imageBytes(image);const n=(x:number):Buffer=>{const b=Buffer.alloc(4);b.writeUInt32BE(x);return b;},mime=Buffer.from(image.mime);return Buffer.concat([n(3),n(mime.length),mime,n(0),n(image.width),n(image.height),n(image.depth),n(0),n(image.bytes.length),image.bytes]);}
function apicFront(body:Buffer):boolean {
  const end=body.indexOf(0,1);if(end<2||end+2>=body.length)return fail('INVALID_APIC');
  if(body[end+1]!==3)return false;
  if(body[0]!==3||!['image/png','image/jpeg'].includes(body.subarray(1,end).toString('ascii')))return fail('FRONT_COVER_FORMAT_UNPROVEN');
  const descriptionEnd=body.indexOf(0,end+2);if(descriptionEnd<0||descriptionEnd+1>=body.length)return fail('INVALID_APIC');
  utf8(body.subarray(end+2,descriptionEnd));return true;
}
function encodeApic(image:SourceFrontImage):Buffer {imageBytes(image);return Buffer.concat([Buffer.from([3]),Buffer.from(image.mime),Buffer.from([0,3,0]),image.bytes]);}
export function writeSourceTagRegion(prefix:Buffer,fileSize:number,change:SourceRegionChange):{bytes:Buffer;profile:SourceWriteProfile;audioStart:number;fields:Partial<Record<SourceTagKey,string>>} {
  const parsed=inspectSourceTagRegion(prefix,fileSize),flac=parsed.profile==='NATIVE_FLAC_FIXED_TAG_REGION_V1';let pieces:Buffer[]=[];
  if(flac){
    const parts=parsed.parts.filter(p=>p.kind!==1);let changed=false;
    if('fields'in change){for(const part of parts){if(part.kind===4){pieces.push(block(4,encodeComments(changedComments(comments(part.body),change.fields))));changed=true;}else pieces.push(part.raw);}if(!changed)pieces.push(block(4,encodeComments(changedComments({vendor:Buffer.from('MusicBridge finite source writer v1'),items:[]},change.fields))));}
    else {const fronts=parts.filter(p=>p.kind===6&&flacFront(p.body));if(fronts.length>1)return fail('MULTIPLE_FRONT_COVERS');for(const part of parts){if(fronts.includes(part)){if(change.frontImage)pieces.push(block(6,encodePicture(change.frontImage)));changed=true;}else pieces.push(part.raw);}if(!changed&&change.frontImage)pieces.push(block(6,encodePicture(change.frontImage)));}
    const available=parsed.audioStart-4-pieces.reduce((n,b)=>n+b.length,0)-4;if(available<0)return fail('PADDING_INSUFFICIENT');pieces=[Buffer.from('fLaC'),...pieces,block(1,Buffer.alloc(available),true)];
  }else {
    const parts=parsed.parts;let frontAdded=false;
    if('fields'in change){const selected=new Map<string,SourceTagKey>();for(const key of Object.keys(change.fields) as SourceTagKey[])selected.set(names[key][1],key);
      for(const [id,key]of selected){const existing=parts.filter(p=>p.id===id);if(key!=='artist'&&existing.length>1)return fail('TARGET_MULTIVALUE_AMBIGUOUS');for(const part of existing){const current=textFrame(part.body);if(!(key==='artist'?current.split('\0').every(plain):plain(current))||key==='year'&&!/^\d{4}$/u.test(current)||(key==='disc'||key==='track')&&!decimal(current))return fail('TARGET_VALUE_AMBIGUOUS');}const value=change.fields[key]!;if(value.action==='set')checkedValue(key,value.value);}
      const emitted=new Set<string>();for(const part of parts){const key=selected.get(part.id);if(!key){pieces.push(part.raw);continue;}if(emitted.has(part.id))continue;emitted.add(part.id);const action=change.fields[key]!;if(action.action==='set')pieces.push(frame(part.id,Buffer.concat([Buffer.from([3]),Buffer.from(action.value)])));}for(const [id,key]of selected)if(!emitted.has(id)&&change.fields[key]!.action==='set')pieces.push(frame(id,Buffer.concat([Buffer.from([3]),Buffer.from((change.fields[key] as {action:'set';value:string}).value)])));
    }else {const fronts=parts.filter(p=>p.id==='APIC'&&apicFront(p.body));if(fronts.length>1)return fail('MULTIPLE_FRONT_COVERS');for(const part of parts){if(fronts.includes(part)){if(change.frontImage)pieces.push(frame('APIC',encodeApic(change.frontImage)));frontAdded=true;}else pieces.push(part.raw);}if(!frontAdded&&change.frontImage)pieces.push(frame('APIC',encodeApic(change.frontImage)));}
    const available=parsed.audioStart-10-pieces.reduce((n,b)=>n+b.length,0);if(available<0)return fail('PADDING_INSUFFICIENT');pieces=[prefix.subarray(0,10),...pieces,Buffer.alloc(available)];
  }
  const bytes=Buffer.concat(pieces),final=inspectSourceTagRegion(Buffer.concat([bytes,prefix.subarray(parsed.audioStart,parsed.audioStart+4)]),fileSize);
  if(bytes.length!==parsed.audioStart||final.audioStart!==parsed.audioStart)return fail('AUDIO_START_CHANGED');
  return {bytes,profile:parsed.profile,audioStart:parsed.audioStart,fields:final.fields};
}
