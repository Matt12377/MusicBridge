import { constants } from 'node:fs'
import * as metadataFs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { types as bootstrapTypes } from 'node:util'
import { isDatasetWorkbenchNativeConfiguration, captureDatasetWorkbenchNativeConfiguration, type DatasetWorkbenchNativeConfiguration } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import path from 'node:path'
import { MessagePort } from 'node:worker_threads'
import { PHYSICAL_RESOURCE_BUFFER_BYTES } from '../../../../packages/bridge-core/src/stream/physical-resource-locks.js'
import { isDatasetOwnerReadRevocationBuffer } from '../../../../packages/bridge-core/src/collection/dataset-owner-read-revocation.js'

export function datasetOwnerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ['NODE_ENV', 'TMPDIR', 'DEV_BUILD_ROOT', 'DEV_CACHE_ROOT', 'NODE_COMPILE_CACHE',
    'MB_MEDIA_WORKER_BINARY', 'MB_MEDIA_WORKER_BINARY_SHA256',
    'LANG', 'LC_ALL', 'TZ', 'MUSIC_BRIDGE_CORE_TEST_MODE', 'MUSIC_BRIDGE_UI_E2E',
    'MUSIC_BRIDGE_BUNDLED_CONVERTER_GATE', 'MUSIC_BRIDGE_BUNDLED_OUTPUT_GATE', 'MUSIC_BRIDGE_MOBILE_DSD_BACKEND_GATE']) {
    const value = env[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

export function parseDatasetOwnerWorkerData(value: unknown): { dataDirectory: string; resourcesDirectory: string; localWorkbenchNative?: Readonly<DatasetWorkbenchNativeConfiguration>; physicalResourceBuffer?: SharedArrayBuffer; albumReadRevocationBuffer?: SharedArrayBuffer;sourceWritesPort?:MessagePort; relocationMainPort?: MessagePort } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || bootstrapTypes.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('数据集所有者启动身份无效。')
  const input = value as Record<string, unknown>
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (![2,3,4,5,6,7].includes(Reflect.ownKeys(input).length) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key]!, 'value')) || Object.keys(input).some(key => !['dataDirectory', 'resourcesDirectory', 'physicalResourceBuffer','albumReadRevocationBuffer','sourceWritesPort','relocationMainPort','localWorkbenchNative'].includes(key))
    || Object.hasOwn(input, 'albumReadRevocationBuffer') && !isDatasetOwnerReadRevocationBuffer(input.albumReadRevocationBuffer)
    || Object.hasOwn(input,'localWorkbenchNative') && !isDatasetWorkbenchNativeConfiguration(input.localWorkbenchNative)
    || Object.hasOwn(input,'sourceWritesPort') && !(input.sourceWritesPort instanceof MessagePort)
    || Object.hasOwn(input, 'relocationMainPort') && (!(input.relocationMainPort instanceof MessagePort) || input.relocationMainPort === input.sourceWritesPort)
    || Object.hasOwn(input, 'physicalResourceBuffer') && (!(input.physicalResourceBuffer instanceof SharedArrayBuffer) || input.physicalResourceBuffer.byteLength !== PHYSICAL_RESOURCE_BUFFER_BYTES)
    || typeof input.dataDirectory !== 'string' || !path.isAbsolute(input.dataDirectory)
    || input.dataDirectory.length > 1024 || input.dataDirectory.includes('\0')
    || typeof input.resourcesDirectory !== 'string' || !path.isAbsolute(input.resourcesDirectory)
    || input.resourcesDirectory.length > 1024 || input.resourcesDirectory.includes('\0')) {
    throw new Error('数据集所有者启动身份无效。')
  }
  return { dataDirectory: input.dataDirectory, resourcesDirectory: input.resourcesDirectory, ...(Object.hasOwn(input,'localWorkbenchNative') ? {localWorkbenchNative:captureDatasetWorkbenchNativeConfiguration(input.localWorkbenchNative)} : {}), ...(input.physicalResourceBuffer instanceof SharedArrayBuffer ? { physicalResourceBuffer: input.physicalResourceBuffer } : {}), ...(isDatasetOwnerReadRevocationBuffer(input.albumReadRevocationBuffer) ? { albumReadRevocationBuffer: input.albumReadRevocationBuffer } : {}),...(input.sourceWritesPort instanceof MessagePort?{sourceWritesPort:input.sourceWritesPort}:{}), ...(input.relocationMainPort instanceof MessagePort ? { relocationMainPort: input.relocationMainPort } : {}) }
}


const NATIVE_BUILD_METADATA = Object.freeze({
  cue:{file:'cue-build.json',purpose:'cue-independent-eight-format-output',root:'cue-ffmpeg/darwin-arm64'},
  tags:{file:'local-audio-tags-build.json',purpose:'owner-protected-audio-copy-tags',root:'local-audio-tags/darwin-arm64'},
  watch:{file:'library-watch-build.json',purpose:'owner-fsevents-library-invalidation',root:'library-watch/darwin-arm64'},
})
const metadataError = (): never => {throw new Error('已编译原生资源身份无效；未取得Native资格。')}
function metadataRecord(value:unknown,keys:readonly string[]):value is Record<string,unknown>{
  if(!value||typeof value!=='object'||bootstrapTypes.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false
  const fields=Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(value).length===keys.length&&keys.every(key=>fields[key]?.enumerable===true&&Object.hasOwn(fields[key]!, 'value'))
}
export function parseDatasetWorkbenchNativeMetadata(raw:Uint8Array,purpose:string,required=false):string|null {
  if(raw.byteLength===0||raw.byteLength>1024)return metadataError()
  let value:unknown
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))}catch{return metadataError()}
  if(!metadataRecord(value,['schemaVersion','purpose','platform','arch','manifestSha256'])||value.schemaVersion!==1||value.purpose!==purpose||value.platform!=='darwin'||value.arch!=='arm64'
    ||value.manifestSha256!==null&&(typeof value.manifestSha256!=='string'||!(/^[a-f0-9]{64}$/u.test(value.manifestSha256)))
    ||required&&value.manifestSha256===null)return metadataError()
  const expected=Buffer.from(JSON.stringify({schemaVersion:1,purpose,platform:'darwin',arch:'arm64',manifestSha256:value.manifestSha256})+'\n','utf8')
  if(!Buffer.from(raw).equals(expected))return metadataError()
  return value.manifestSha256 as string|null
}
function metadataLocation(value:string):boolean{return typeof value==='string'&&value.length>0&&value.length<=1024&&path.isAbsolute(value)&&path.normalize(value)===value&&!/[\u0000-\u001f\u007f]/u.test(value)}
const nativeStatFields=['dev','ino','mode','size','mtimeNs','ctimeNs','nlink'] as const
/** Electron使用原始fs读取app.asar，不触发临时解包；Node隔离检查仍用同一原始OS文件接口。 */
function nativeMetadataFs():typeof metadataFs {
  return process.versions.electron ? (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).promises : metadataFs
}
async function readNativeBuildFile(file:string):Promise<Buffer>{
  const fs=nativeMetadataFs(),named=await fs.lstat(file,{bigint:true})
  if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1n||(named.mode&0o7022n)!==0n||named.size<=0n||named.size>1024n||await fs.realpath(file)!==file)return metadataError()
  const fd=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
    const before=await fd.stat({bigint:true});if(!nativeStatFields.every(key=>before[key]===named[key]))return metadataError()
    const raw=Buffer.alloc(Number(before.size));let offset=0
    while(offset<raw.length){const read=await fd.read(raw,offset,raw.length-offset,offset);if(read.bytesRead===0)return metadataError();offset+=read.bytesRead}
    const after=await fd.stat({bigint:true}),current=await fs.lstat(file,{bigint:true})
    if(!nativeStatFields.every(key=>before[key]===after[key]&&before[key]===current[key])||await fs.realpath(file)!==file)return metadataError()
    return raw
  }finally{await fd.close()}
}
/** 沿原有界asar读取独立metadata；旧包缺watch只表示null，不能旁读manifest补授权。 */
async function readNativeAsarMetadata(archive:string):Promise<Record<'cue'|'tags'|'watch',Buffer|null>>{
  const fs=nativeMetadataFs(),named=await fs.lstat(archive,{bigint:true})
  if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1n||(named.mode&0o7022n)!==0n||named.size<16n||named.size>2n*1024n*1024n*1024n||await fs.realpath(archive)!==archive)return metadataError()
  const fd=await fs.open(archive,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
    const before=await fd.stat({bigint:true});if(!nativeStatFields.every(key=>before[key]===named[key]))return metadataError()
    async function read(position:number,length:number):Promise<Buffer>{
      if(!Number.isSafeInteger(position)||!Number.isSafeInteger(length)||position<0||length<=0||length>16*1024*1024||position+length>Number(before.size))return metadataError()
      const raw=Buffer.alloc(length);for(let offset=0;offset<length;){const next=await fd.read(raw,offset,Math.min(65536,length-offset),position+offset);if(next.bytesRead===0)return metadataError();offset+=next.bytesRead}return raw
    }
    const prefix=await read(0,8);if(prefix.readUInt32LE(0)!==4)return metadataError()
    const length=prefix.readUInt32LE(4);if(length<12||length>16*1024*1024||length%4!==0)return metadataError()
    const header=await read(8,length),textLength=header.readUInt32LE(4)
    if(header.readUInt32LE(0)!==length-4||textLength<=0||textLength>length-8||length-8-textLength>=4||!header.subarray(8+textLength).every(byte=>byte===0))return metadataError()
    const parsed=parseNativeMetadataHeader(header.subarray(8,8+textLength)),positions:Array<{begin:number;end:number}>=[],result={} as Record<'cue'|'tags'|'watch',Buffer|null>
    for(const key of ['cue','tags','watch'] as const){
      let node:unknown=parsed,absent=false
      for(const part of ['dist','main',NATIVE_BUILD_METADATA[key].file]){
        if(!node||typeof node!=='object'||!Object.hasOwn(node,'files'))return metadataError()
        const value=node as Record<string,unknown>;if(value.link||value.unpacked||!value.files||typeof value.files!=='object')return metadataError()
        if(!Object.hasOwn(value.files,part)){
          if(key==='watch'&&part===NATIVE_BUILD_METADATA.watch.file){absent=true;break}
          return metadataError()
        }
        node=(value.files as Record<string,unknown>)[part]
      }
      if(absent){result[key]=null;continue}
      if(!metadataRecord(node,Object.hasOwn(node as object,'integrity')?['size','offset','integrity']:['size','offset'])||!Number.isSafeInteger(node.size)||Number(node.size)<=0||Number(node.size)>1024||typeof node.offset!=='string'||!/^(0|[1-9][0-9]{0,10})$/u.test(node.offset))return metadataError()
      const position=8+length+Number(node.offset),end=position+Number(node.size)
      if(!positions.every(old=>end<=old.begin||position>=old.end))return metadataError();positions.push({begin:position,end})
      const raw=await read(position,Number(node.size))
      if(Object.hasOwn(node,'integrity')){const integrity=node.integrity,hash=createHash('sha256').update(raw).digest('hex')
        if(!metadataRecord(integrity,['algorithm','hash','blockSize','blocks'])||integrity.algorithm!=='SHA256'||integrity.hash!==hash||integrity.blockSize!==4*1024*1024||!Array.isArray(integrity.blocks)||integrity.blocks.length!==1||integrity.blocks[0]!==hash)return metadataError()}
      result[key]=raw
    }
    const after=await fd.stat({bigint:true}),current=await fs.lstat(archive,{bigint:true})
    if(!nativeStatFields.every(key=>before[key]===after[key]&&before[key]===current[key])||await fs.realpath(archive)!==archive)return metadataError()
    return result
  }finally{await fd.close()}
}
/** 同376：完整UTF8与重复JSON键拒绝，header沿原16MiB/200000值/64层上限。 */
function parseNativeMetadataHeader(raw:Buffer):unknown{
  if(raw.length===0||raw.length>16*1024*1024)return metadataError();const text=new TextDecoder('utf-8',{fatal:true}).decode(raw)
  let cursor=0,values=0;const space=()=>{while(cursor<text.length&&/[\x20\t\r\n]/u.test(text[cursor]!))cursor++}
  function string():string{const begin=cursor++;if(text[begin]!=='"')return metadataError();while(cursor<text.length){const char=text[cursor++];if(char==='"'){try{return JSON.parse(text.slice(begin,cursor)) as string}catch{return metadataError()}}if(char==='\\')cursor++}return metadataError()}
  function value(depth:number):unknown{if(depth>64||++values>200000)return metadataError();space();const char=text[cursor]
    if(char==='"')return string()
    if(char==='{'){cursor++;space();const result:Record<string,unknown>=Object.create(null),keys=new Set<string>();if(text[cursor]==='}'){cursor++;return result}while(cursor<text.length){space();if(text[cursor]!=='"')return metadataError();const key=string();if(keys.has(key))return metadataError();keys.add(key);space();if(text[cursor++]!==':')return metadataError();result[key]=value(depth+1);space();const next=text[cursor++];if(next==='}')return result;if(next!==',')return metadataError()}}
    else if(char==='['){cursor++;space();const result:unknown[]=[];if(text[cursor]===']'){cursor++;return result}while(cursor<text.length){result.push(value(depth+1));space();const next=text[cursor++];if(next===']')return result;if(next!==',')return metadataError()}}
    else{for(const [token,result] of [['true',true],['false',false],['null',null]] as const){if(text.startsWith(token,cursor)){cursor+=token.length;return result}}const number=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(cursor));if(!number)return metadataError();cursor+=number[0].length;const result=Number(number[0]);if(!Number.isFinite(result)||Number.isInteger(result)&&!Number.isSafeInteger(result))return metadataError();return result}
    return metadataError()
  }
  const result=value(0);space();if(cursor!==text.length)return metadataError();return result
}
export async function readDatasetWorkbenchNativeConfiguration(context:{entryDirectory:string;appDirectory:string;resourcesDirectory:string;packaged:boolean}):Promise<Readonly<DatasetWorkbenchNativeConfiguration>>{
  if(!metadataRecord(context,['entryDirectory','appDirectory','resourcesDirectory','packaged'])||![context.entryDirectory,context.appDirectory,context.resourcesDirectory].every(metadataLocation)||typeof context.packaged!=='boolean'
    ||context.entryDirectory!==(context.packaged?path.join(context.resourcesDirectory,'app.asar','dist','main'):path.join(context.appDirectory,'dist','main')))return metadataError()
  const packed=context.packaged?await readNativeAsarMetadata(path.join(context.resourcesDirectory,'app.asar')):undefined
  const configuration:{cue:DatasetWorkbenchNativeConfiguration['cue'];tags:DatasetWorkbenchNativeConfiguration['tags'];watch:DatasetWorkbenchNativeConfiguration['watch']}={cue:null,tags:null,watch:null}
  for(const key of ['cue','tags','watch'] as const){
    const data=NATIVE_BUILD_METADATA[key];let raw:Buffer|null
    if(packed)raw=packed[key]
    else{
      try{raw=await readNativeBuildFile(path.join(context.entryDirectory,data.file))}
      catch(error){if(key!=='watch'||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;raw=null}
    }
    if(raw===null)continue
    const manifestSha256=parseDatasetWorkbenchNativeMetadata(raw,data.purpose,context.packaged)
    if(manifestSha256!==null)configuration[key]={root:path.join(context.packaged?context.resourcesDirectory:path.join(context.appDirectory,'native'),data.root),manifestSha256}}
  return captureDatasetWorkbenchNativeConfiguration(configuration)
}
