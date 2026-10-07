import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { preparationFixture } from '../helpers/preparation-fixture.js';
import { createSourceProtectionService, SourceProtectionRefused } from '../../src/recording/source-protection.js';
import { createSourceProtectionStore } from '../../src/recording/source-protection-store.js';
import { observeReadonlySourceProtection } from '../../src/recording/source-files.js';
import { physicalResourceLocks } from '../../src/stream/physical-resource-locks.js';

test('014 精确物理证据：跨根硬链接没有 AssetID 仍命中 Frozen，writer OFF 单独拒绝', async t => {
  const f = await preparationFixture(t); await f.freeze(); await f.versions.idle();
  const directory = path.join(f.directory,'alias'); await mkdir(directory); await link(f.file,path.join(directory,'different-name.wav'));
  const authorized = await f.sources.authorize(randomUUID(),directory), root=f.repository.sources.root(authorized.id);
  const service = createSourceProtectionService({store:f.repository.sourceProtection,datasetId:randomUUID(),assertCurrent:()=>{f.repository.readonlySnapshotStamp();}});
  f.registerDependentCleanup(()=>service.close());
  const proof = await service.inspect([{root,relative:'different-name.wav'}]);
  assert.equal(proof.state,'PROTECTED'); assert.equal(proof.complete,true); assert.equal(proof.sourceWriterReady,false);
  assert.ok(proof.references.some(reference=>reference.kind==='MASTER'));
  assert.throws(()=>service.assertMutationAllowed(proof),SourceProtectionRefused);
  assert.equal(physicalResourceLocks.snapshot().readers,0);
  await f.sources.revoke({commandId:randomUUID(),id:f.root.id});
  const revoked = await service.inspect([{root,relative:'different-name.wav'}]);
  assert.equal(revoked.state,'PROTECTED'); assert.equal(revoked.complete,false); assert.ok(revoked.issues.includes('SOURCE_ROOT_REVOKED'));
});

test('014 活动锁与持久引用独立：无冻结命中的目标读者仍返回 BUSY', async t => {
  const f = await preparationFixture(t); await f.freeze(); await f.versions.idle();
  await writeFile(path.join(f.sourcePath,'other.wav'),'独立合成文件');
  const info = await lstat(path.join(f.sourcePath,'other.wav'),{bigint:true});
  const guard = physicalResourceLocks.acquireRead([{dev:String(info.dev),ino:String(info.ino)}]);
  const service = createSourceProtectionService({store:f.repository.sourceProtection,datasetId:randomUUID(),assertCurrent:()=>{}});
  f.registerDependentCleanup(()=>service.close());
  try { const proof=await service.inspect([{root:f.repository.sources.root(f.root.id),relative:'other.wav'}]); assert.equal(proof.state,'BUSY'); assert.deepEqual(proof.references,[]); }
  finally { await guard.release(); }
  const clear = await service.inspect([{root:f.repository.sources.root(f.root.id),relative:'other.wav'}]); assert.equal(clear.state,'CLEAR'); assert.equal(clear.sourceWriterReady,false);
});

test('014 执行重读：外部 chmod 未扫描也改变精确 proof，旧 Frozen 原文不变', async t => {
  const f = await preparationFixture(t); await f.freeze(); await f.versions.idle();
  const db = new DatabaseSync(f.filePath,{readOnly:true});
  const original = db.prepare('SELECT data FROM master_versions').get()!.data;
  const service = createSourceProtectionService({store:f.repository.sourceProtection,datasetId:randomUUID(),assertCurrent:()=>{}});
  f.registerDependentCleanup(()=>service.close());
  const target=[{root:f.repository.sources.root(f.root.id),relative:'fixture.wav'}], preview=await service.inspect(target);
  await chmod(f.file,0o600);
  const execution=await service.inspect(target,preview.fingerprint);
  assert.equal(execution.complete,false); assert.ok(execution.issues.includes('PROTECTION_CONTEXT_CHANGED')); assert.notEqual(execution.fingerprint,preview.fingerprint);
  assert.equal(db.prepare('SELECT data FROM master_versions').get()!.data,original); db.close();
});

test('014 新保护审计超预算只返回 UNKNOWN，不截断历史或阻断旧母版读取', async t => {
  const f=await preparationFixture(t); await f.freeze(); await f.versions.idle();
  const db=new DatabaseSync(f.filePath,{readOnly:true});
  try {
    const store=createSourceProtectionStore({read:fn=>fn(db),budget:{rows:1}}), projection=store.snapshot();
    assert.equal(projection.complete,false); assert.ok(projection.issues.includes('SOURCE_PROTECTION_BUDGET_EXCEEDED'));
    assert.equal(f.repository.versions.list(f.draft.draftId).masters.length,1);
  } finally { db.close(); }
});

test('014 观察超时：held promise 到界返回 UNKNOWN；关闭join迟到观察且不重发', async t => {
  const f=await preparationFixture(t); await f.freeze(); await f.versions.idle();
  let release!:()=>void, calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const before=f.repository.readonlySnapshotStamp();
  const service=createSourceProtectionService({store:f.repository.sourceProtection,datasetId:randomUUID(),assertCurrent:()=>{},timeoutMs:10,
    observe:async(...args)=>{calls++; await gate; return observeReadonlySourceProtection(...args);}});
  const proof=await service.inspect([{root:f.repository.sources.root(f.root.id),relative:'fixture.wav'}]);
  assert.equal(proof.state,'UNKNOWN'); assert.ok(proof.issues.includes('SOURCE_OBSERVATION_TIMEOUT'));
  let quiet=false; const closing=service.close().then(()=>{quiet=true;}); await Promise.resolve(); assert.equal(quiet,false);
  release(); await closing; assert.equal(calls,1); assert.equal(physicalResourceLocks.snapshot().readers,0);
  assert.deepEqual(f.repository.readonlySnapshotStamp(),before);
});

test('014 根权限与离线：无需扫描也使proof失效，旧路径缺失不能给出无保护',async t=>{
  const f=await preparationFixture(t);await f.freeze();await f.versions.idle();
  const alias=path.join(f.directory,'visible-alias');await mkdir(alias);await link(f.file,path.join(alias,'alias.wav'));
  const selected=await f.sources.authorize(randomUUID(),alias),target=[{root:f.repository.sources.root(selected.id),relative:'alias.wav'}];
  const service=createSourceProtectionService({store:f.repository.sourceProtection,datasetId:randomUUID(),assertCurrent:()=>{}});f.registerDependentCleanup(()=>service.close());
  const preview=await service.inspect(target),mode=await lstat(f.sourcePath,{bigint:true});await chmod(f.sourcePath,Number(mode.mode & 0o7777n)===0o700?0o755:0o700);
  const changed=await service.inspect(target,preview.fingerprint);assert.equal(changed.complete,false);assert.ok(changed.issues.includes('PROTECTION_CONTEXT_CHANGED'));
  const offline=path.join(f.directory,'offline-source');await rename(f.sourcePath,offline);
  try{const proof=await service.inspect(target);assert.equal(proof.state,'PROTECTED');assert.equal(proof.complete,false);assert.ok(proof.issues.includes('SOURCE_ROOT_OFFLINE'));}
  finally{await rename(offline,f.sourcePath);}
});
