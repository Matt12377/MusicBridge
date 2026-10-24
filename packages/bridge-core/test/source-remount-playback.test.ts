import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { authorizeSourceDirectory, openLocalPlaybackReadonlySource, readonlySourceCatalogFileAvailable,
  sourceFileAvailability, withCheckedReadonlyMetadataSource, type RootCapability } from '../src/recording/source-files.js';
import { createSourceRemountProof, isSourceRemountProof, sourceRemountProofMatchesRoot, sourcePlaybackExpectedSignature } from '../src/recording/source-remount-proof.js';
import { openMobileDsdSource, verifyMobileDsdSource, closeMobileDsdSource, mobileDsdSourceIdentity } from '../src/mobile/dsd-converter.js';

async function fixture(t: test.TestContext) {
  assert.ok(process.env.TMPDIR?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'));
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'source-remount-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  const relative='音频.wav', file=path.join(directory,relative), bytes=Buffer.alloc(96);
  bytes.write('RIFF');bytes.write('WAVE',8);await writeFile(file,bytes);
  const current:RootCapability={...await authorizeSourceDirectory(directory),id:randomUUID()}, previous={...current,dev:(BigInt(current.dev)+9n).toString()};
  const proof=createSourceRemountProof(previous,current,'a'.repeat(64)), root={...current,readonlyRemountProof:proof};
  const stat=await lstat(file,{bigint:true}), signature=[previous.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  return {directory,relative,file,root,current,previous,proof,signature};
}
test('明确重挂载证明只映射dev，目录资格和普通真实FD读取可复用旧观察', async t=>{
  const f=await fixture(t);
  assert.equal(readonlySourceCatalogFileAvailable(f.current,f.relative,f.signature,'WAVE'),false);
  await assert.rejects(openLocalPlaybackReadonlySource(f.current,f.relative,f.signature));
  assert.equal(readonlySourceCatalogFileAvailable(f.root,f.relative,f.signature,'WAVE'),true);
  const file=await openLocalPlaybackReadonlySource(f.root,f.relative,f.signature);
  try {await file.verify();assert.equal(file.signature.split(':')[0],f.current.dev);assert.equal(file.signature.split(':').slice(1).join(':'),f.signature.split(':').slice(1).join(':'));}
  finally {await file.close();}
  assert.equal(f.signature.split(':')[0],f.previous.dev);
});
test('证明闭集与当前原Root绑定不能由另一根、目录或设备复用',async t=>{
  const f=await fixture(t);
  assert.equal(isSourceRemountProof({...f.proof,extra:true}),false);
  for(const root of [{...f.root,id:randomUUID()},{...f.root,path:f.directory+'-other'},{...f.root,ino:'0'},{...f.root,dev:f.previous.dev},{...f.root,authorized:false},{...f.root,extra:true}]){
    assert.equal(sourceRemountProofMatchesRoot(root),false);
    assert.equal(sourcePlaybackExpectedSignature(root,f.signature),undefined);
    assert.equal(readonlySourceCatalogFileAvailable(root,f.relative,f.signature),false);
    await assert.rejects(openLocalPlaybackReadonlySource(root,f.relative,f.signature));
  }
  assert.throws(()=>createSourceRemountProof(f.root,f.current,'a'.repeat(64)));
});
test('余四字段任何改变都拒绝，已打开后文件修改仍使verify失效',async t=>{
  const f=await fixture(t);
  for(const index of [1,2,3,4]){
    const pieces=f.signature.split(':');pieces[index]=(BigInt(pieces[index]!)+1n).toString();
    assert.equal(readonlySourceCatalogFileAvailable(f.root,f.relative,pieces.join(':')),false);
    await assert.rejects(openLocalPlaybackReadonlySource(f.root,f.relative,pieces.join(':')));
  }
  const file=await openLocalPlaybackReadonlySource(f.root,f.relative,f.signature);
  try {await writeFile(f.file,Buffer.alloc(128));await assert.rejects(file.verify());}finally{await file.close();}
});
test('重挂载证明不放宽扫描/严格元数据/源文件资格，符号链接仍拒绝',async t=>{
  const f=await fixture(t);
  assert.equal(await sourceFileAvailability(f.root,f.relative,f.signature),'CONTENT_CHANGED');
  await assert.rejects(withCheckedReadonlyMetadataSource(f.root,f.relative,f.signature,new AbortController().signal,async()=>true));
  const link='链接.wav';await symlink(f.file,path.join(f.directory,link));
  assert.equal(readonlySourceCatalogFileAvailable(f.root,link,f.signature),false);
  await assert.rejects(openLocalPlaybackReadonlySource(f.root,link,f.signature));
});
for (const container of ['dsf','dff'] as const) test(`DSD ${container}只读源沿同一重挂载证明并保持实际容器与FD变化核验`,async t=>{
  const f=await fixture(t), bytes=await readFile(new URL(`./fixtures/mbrs003/dsd/synthetic-balanced-dsd64.${container}`,import.meta.url));
  await writeFile(f.file,bytes);
  const stat=await lstat(f.file,{bigint:true}), signature=[f.previous.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  const source=await openMobileDsdSource({root:f.root,relative:f.relative,signature,datasetId:randomUUID(),identity:'b'.repeat(64),
    sourceAudio:{codec:'dsd',container,sampleRateHz:2822400,bitsPerSample:1,channels:2},assertCurrent(){}},new AbortController().signal);
  try {
    await verifyMobileDsdSource(source);assert.equal(mobileDsdSourceIdentity(source).signature.split(':')[0],f.current.dev);
    await writeFile(f.file,Buffer.concat([bytes,Buffer.from([0])]));await assert.rejects(verifyMobileDsdSource(source));
  } finally {await closeMobileDsdSource(source);}
});
