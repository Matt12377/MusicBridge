import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { preparationFixture } from '../helpers/preparation-fixture.js';
import { physicalResourceLocks, PhysicalResourceBusy, type PhysicalResource } from '../../src/stream/physical-resource-locks.js';
import { probeReadonlySource } from '../../src/recording/source-files.js';

test('014 Frozen 发布：全 Hash 复核后的 COMMIT 仍持真实源读保护', async t => {
  let resources: PhysicalResource[] = [], writerAdmitted = false, writerBusy = false;
  const releases: Promise<void>[] = [];
  const f = await preparationFixture(t, { beforeCommit(action) {
    if (action !== 'freeze-master-versions') return;
    try {
      const guard = physicalResourceLocks.acquireWrite(resources);
      writerAdmitted = true;
      releases.push(guard.release());
    } catch (error) {
      if (!(error instanceof PhysicalResourceBusy)) throw error;
      writerBusy = true;
    }
  } });
  const info = await lstat(f.file, { bigint: true });
  resources = [{ dev: String(info.dev), ino: String(info.ino) }];
  const job = await f.freeze();
  await f.versions.idle();
  await Promise.all(releases);
  assert.equal(f.versions.job(job.id).job?.state, 'completed');
  assert.equal(writerAdmitted, false, '冻结 COMMIT 前不能出现源写 claim 窗口');
  assert.equal(writerBusy, true, '必须按实际 fstat 身份与原协调器冲突');
  const after = physicalResourceLocks.acquireWrite(resources);
  await after.release();
});

test('014 Frozen close：取消仍join已进入复核的发布，未quiet之前源保护不释放', async t => {
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  const f = await preparationFixture(t, { probe: async (...args) => { entered(); await resume; return probeReadonlySource(...args); } });
  const info = await lstat(f.file, { bigint: true }), resource = { dev: String(info.dev), ino: String(info.ino) };
  await f.freeze(); await began;
  let closed = false;
  const closing = f.versions.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.throws(() => physicalResourceLocks.acquireWrite([resource]), PhysicalResourceBusy);
  release(); await closing;
  assert.equal(f.repository.versions.list(f.draft.draftId).masters.length, 0);
  const after = physicalResourceLocks.acquireWrite([resource]); await after.release();
});

test('014 确定ROLLBACK：COMMIT前故障零Frozen，实际FDquiet后完整释放',async t=>{
  const f=await preparationFixture(t,{beforeCommit(action){if(action==='freeze-master-versions')throw new Error('合成确定回滚');}});
  await f.freeze();await f.versions.idle();assert.equal(f.repository.versions.list(f.draft.draftId).masters.length,0);
  assert.equal(physicalResourceLocks.snapshot().resources,0);
  const stat=await lstat(f.file,{bigint:true}),guard=physicalResourceLocks.acquireWrite([{dev:String(stat.dev),ino:String(stat.ino)}]);await guard.release();
});

test('014 原200曲业务容量：200个真实物理源分组跨冻结COMMIT，曲数不降为128',async t=>{
  let observed=0;
  const f=await preparationFixture(t,{beforeCommit(action){if(action==='freeze-master-versions')observed=physicalResourceLocks.snapshot().resources;}});
  const first=f.repository.drafts.append({commandId:randomUUID(),fingerprint:'c'.repeat(64),title:'200曲合成母版',programType:'compilation',metadata:Array.from({length:100},(_,index)=>({title:`曲目${index+1}`}))});
  const second=f.repository.drafts.append({commandId:randomUUID(),fingerprint:'d'.repeat(64),draftId:first.draftId,expectedRevision:f.repository.drafts.detail(first.draftId).revision,metadata:Array.from({length:100},(_,index)=>({title:`曲目${index+101}`}))});
  const draft={draftId:first.draftId,trackIds:[...first.trackIds,...second.trackIds]};
  const bytes=await readFile(f.file);
  for(const [index,trackId] of draft.trackIds.entries()) {
    const file=path.join(f.sourcePath,`capacity-${index}.wav`);await writeFile(file,bytes);
    const job=f.sources.start({commandId:randomUUID(),draftId:draft.draftId,trackId,rootId:f.root.id,acquisition:'userFileBind'},file);await f.sources.idle();assert.equal(f.sources.job(job.id).job?.state,'completed');
    const binding=f.repository.sources.linked(draft.draftId,trackId)!;await f.sources.confirm({commandId:randomUUID(),id:binding.id,draftId:draft.draftId,trackId,userConfirmed:true});
  }
  const spec={...f.plan.spec,splitAfter:100},preview=await f.media.preview({draftId:draft.draftId,spec,page:{offset:0,limit:20}});
  const saved=await f.media.save({commandId:randomUUID(),draftId:draft.draftId,expectedDraftRevision:preview.draftRevision,inputFingerprint:preview.inputFingerprint,spec});
  const plan=await f.media.reserve({commandId:randomUUID(),planId:saved.id,expectedRevision:saved.revision,skuId:preview.candidates.items[0]!.skuId,packaging:'opened',userConfirmed:true});
  const proposal=await f.versions.preview({planId:plan.id,sampleRate:96000});
  const job=await f.versions.freeze({commandId:randomUUID(),planId:plan.id,sampleRate:96000,proposalFingerprint:proposal.proposalFingerprint,userConfirmed:true});await f.versions.idle();
  assert.equal(f.versions.job(job.id).job?.state,'completed');assert.equal(f.repository.versions.list(draft.draftId).masters[0]!.content.tracks.length,200);
  assert.equal(observed,200);assert.equal(physicalResourceLocks.snapshot().resources,0);
});
