import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,open,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {observeSourceFileAttributes,sameSourceFileAttributes,sameSourceFileAttributeProof,SourcePublisherError} from '../../src/collection/source-writes-publisher.js';
import {authorizeSourceDirectory,openLocalPlaybackReadonlySource} from '../../src/recording/source-files.js';
import {owned,retainedDirectory,hash} from './service-fixture.js';

const run=promisify(execFile),options={timeout:3000,maxBuffer:16384,encoding:'utf8' as const,env:{LANG:'C',LC_ALL:'C'}};
const denied=(error:unknown):boolean=>error instanceof SourcePublisherError&&error.issue==='FILE_ATTRIBUTES_UNPROVEN';
async function fixture(){const directory=await retainedDirectory('mbrs012-native-attributes-'),file=path.join(directory,'owned-source.flac'),sample=await owned('owned-stereo-fixed-tags.flac');await writeFile(file,sample.bytes,{flag:'wx',mode:0o600});return {directory,file,sample};}
async function independentXattrs(file:string):Promise<{names:string[];provenance:{bytes:number;sha256:string}|null}>{
  if(process.platform==='darwin'){
    const listed=await run('/usr/bin/xattr',[file],options);assert.equal(listed.stderr,'');const names=listed.stdout.split('\n').filter(Boolean);let provenance:{bytes:number;sha256:string}|null=null;
    if(names.includes('com.apple.provenance')){const actual=await run('/usr/bin/xattr',['-px','com.apple.provenance',file],options);assert.equal(actual.stderr,'');const hex=actual.stdout.replace(/\s/gu,'');assert.match(hex,/^(?:[0-9a-fA-F]{2})+$/u);const bytes=Buffer.from(hex,'hex');provenance={bytes:bytes.length,sha256:hash(bytes)};}
    return {names,provenance};
  }
  assert.equal(process.platform,'linux');const actual=await run('/usr/bin/python3',['-c',"import os,sys,json; f=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW)\ntry: print(json.dumps({'names':os.listxattr(f),'provenance':None}))\nfinally: os.close(f)",file],options);assert.equal(actual.stderr,'');return JSON.parse(actual.stdout) as {names:string[];provenance:null};
}
async function ordinaryRead(directory:string,file:string,expected:Buffer):Promise<void>{const root={id:randomUUID(),...await authorizeSourceDirectory(directory)},info=await lstat(file,{bigint:true}),signature=[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'),lease=await openLocalPlaybackReadonlySource(root,path.basename(file),signature);try{const actual=Buffer.alloc(expected.length);assert.equal((await lease.handle.read(actual,0,actual.length,0)).bytesRead,expected.length);assert.deepEqual(actual,expected);await lease.verify();}finally{await lease.close();}}

test('012 实际Node源原件的属性profile与独立完整OS xattr值一致；不清provenance、不硬编码opaque SHA',async t=>{
  const f=await fixture(),fd=await open(f.file,'r');try{
    const before=await fd.stat({bigint:true}),actual=await observeSourceFileAttributes(f.file,fd),independent=await independentXattrs(f.file),after=await fd.stat({bigint:true});assert.equal(actual.mode,String(before.mode&0o7777n));assert.equal(actual.uid,String(before.uid));assert.equal(actual.gid,String(before.gid));assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);assert.equal(after.ctimeNs,before.ctimeNs);
    if(process.platform==='darwin'&&independent.names.length){assert.deepEqual(independent.names,['com.apple.provenance']);assert.ok(independent.provenance);assert.equal(independent.provenance.bytes,11);assert.equal(actual.proof,'MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1');assert.ok(actual.proof==='MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1');assert.deepEqual(actual.provenance,independent.provenance);}
    else {assert.deepEqual(independent.names,[]);assert.equal(actual.proof,process.platform==='darwin'?'MACOS_EMPTY_XATTR_ACL_FLAGS_V1':'LINUX_EMPTY_XATTR_ACL_FLAGS_V1');assert.deepEqual(Object.keys(actual).sort(),['gid','mode','proof','uid']);}
    assert.deepEqual(await readFile(f.file),f.sample.bytes);const manifest=path.join(f.directory,'native-attribute-proof.json');await writeFile(manifest,JSON.stringify({owned:true,file:f.file,platform:process.platform,originalStat:{dev:String(before.dev),ino:String(before.ino),mode:actual.mode,uid:actual.uid,gid:actual.gid},proof:actual,independent},null,2)+'\n',{flag:'wx',mode:0o600});t.diagnostic(`Source真实OS属性独立对照：${manifest}`);
  }finally{await fd.close();}
});

test('012 自有原件增加真实额外xattr时writer资格拒绝，普通FLAC读取仍逐字节成功',async t=>{
  const f=await fixture(),fd=await open(f.file,'r');try{
    await observeSourceFileAttributes(f.file,fd);
    if(process.platform==='darwin')await run('/usr/bin/xattr',['-w','com.musicbridge.mbrs012.synthetic','owned-negative',f.file],options);
    else {assert.equal(process.platform,'linux');await run('/usr/bin/python3',['-c',"import os,sys; f=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW)\ntry: os.setxattr(f,'user.musicbridge_mbrs012',b'owned-negative')\nfinally: os.close(f)",f.file],options);}
    const names=(await independentXattrs(f.file)).names;assert.ok(names.includes(process.platform==='darwin'?'com.musicbridge.mbrs012.synthetic':'user.musicbridge_mbrs012'));await assert.rejects(()=>observeSourceFileAttributes(f.file,fd),denied);await ordinaryRead(f.directory,f.file,f.sample.bytes);t.diagnostic(`Source真实额外xattr拒写原件保留：${f.file}`);
  }finally{await fd.close();}
});

test('012 自有原件真实nodump语义flag必须拒绝writer，原Reader不随新资格收紧',async t=>{
  const f=await fixture(),fd=await open(f.file,'r');try{
    await observeSourceFileAttributes(f.file,fd);
    if(process.platform==='darwin'){await run('/usr/bin/chflags',['nodump',f.file],options);const flags=await run('/usr/bin/stat',['-f','%f',f.file],options);assert.notEqual(flags.stdout.trim(),'0');}
    else {assert.equal(process.platform,'linux');const set=await run('/usr/bin/python3',['-c',"import os,sys,fcntl,array; f=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW)\ntry:\n a=array.array('L',[0]); fcntl.ioctl(f,0x80086601,a,True); a[0]|=0x40; fcntl.ioctl(f,0x40086602,a,True); b=array.array('L',[0]); fcntl.ioctl(f,0x80086601,b,True); assert b[0]&0x40; print('NODUMP')\nfinally: os.close(f)",f.file],options);assert.equal(set.stdout.trim(),'NODUMP');}
    await assert.rejects(()=>observeSourceFileAttributes(f.file,fd),denied);await ordinaryRead(f.directory,f.file,f.sample.bytes);t.diagnostic(`Source真实语义flag拒写原件保留：${f.file}`);
  }finally{await fd.close();}
});

test('012 自有原件真实非空ACL必须拒绝writer，非空ACL没有被provenance变体掩盖',async t=>{
  const f=await fixture(),fd=await open(f.file,'r');try{
    await observeSourceFileAttributes(f.file,fd);
    if(process.platform==='darwin'){const getuid=process.getuid;assert.ok(typeof getuid==='function');const uid=getuid(),named=await run('/usr/bin/id',['-un'],options);assert.equal(named.stderr,'');const username=named.stdout.trim();assert.match(username,/^[A-Za-z_][A-Za-z0-9_.-]*$/u);const identity=await run('/usr/bin/id',['-u',username],options);assert.equal(identity.stderr,'');assert.equal(identity.stdout.trim(),String(uid));assert.equal((await fd.stat({bigint:true})).uid,BigInt(uid));await run('/bin/chmod',['+a',`user:${username} allow read`,f.file],options);const acl=await run('/bin/ls',['-lde',f.file],options);assert.match(acl.stdout,/\n\s*0:/u);}
    else {assert.equal(process.platform,'linux');const acl=await run('/usr/bin/python3',['-c',"import os,sys,struct; f=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW)\ntry:\n entries=[(1,6,0xffffffff),(2,4,os.getuid()+1),(4,0,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)]; value=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*e) for e in entries); os.setxattr(f,'system.posix_acl_access',value); assert os.getxattr(f,'system.posix_acl_access'); print('ACL')\nfinally: os.close(f)",f.file],options);assert.equal(acl.stdout.trim(),'ACL');}
    await assert.rejects(()=>observeSourceFileAttributes(f.file,fd),denied);await ordinaryRead(f.directory,f.file,f.sample.bytes);t.diagnostic(`Source真实ACL拒写原件保留：${f.file}`);
  }finally{await fd.close();}
});

test('012 属性完整比较包含源mode，但独立backup0600仅复核同profile/opaque证明；真实provenance hash不被忽略',async t=>{
  const f=await fixture(),fd=await open(f.file,'r');try{
    const actual=await observeSourceFileAttributes(f.file,fd),otherMode={...actual,mode:actual.mode==='416'?'384':'416'};assert.equal(sameSourceFileAttributes(actual,actual),true);assert.equal(sameSourceFileAttributes(actual,otherMode),false);assert.equal(sameSourceFileAttributeProof(actual,otherMode),true);
    if(actual.proof==='MACOS_PROVENANCE_ONLY_ACL_FLAGS_V1'){const changed={...actual,provenance:{...actual.provenance,sha256:actual.provenance.sha256==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64)}};assert.equal(sameSourceFileAttributes(actual,changed),false);assert.equal(sameSourceFileAttributeProof(actual,changed),false);}
    await ordinaryRead(f.directory,f.file,f.sample.bytes);t.diagnostic(`Source实际profile比较输入保留：${f.file}`);
  }finally{await fd.close();}
});
