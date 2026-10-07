import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { preparedPublicationFixture } from './prepared-fixture.js';
import { physicalResourceLocks,PhysicalResourceBusy,type PhysicalResource } from '../../src/stream/physical-resource-locks.js';

test('014 Prepared发布：保留原件与Manifest全集合跨COMMIT持锁，旧物理历史不足仍UNKNOWN',async t=>{
  let resources:PhysicalResource[]=[],busy=false;
  const f=await preparedPublicationFixture(t,{beforeCommit(action){if(action==='freeze-prepared'){assert.throws(()=>physicalResourceLocks.acquireWrite(resources),PhysicalResourceBusy);busy=true;}}});
  for(const relative of ['Originals/A.wav','Originals/B.wav','Manifest.json']) {const stat=await lstat(path.join(f.owned.root.path,relative),{bigint:true});resources.push({dev:String(stat.dev),ino:String(stat.ino)});}
  const frozen=await f.prepared.freeze(f.freeze); assert.equal(frozen.status,'frozen'); assert.equal(busy,true);
  const after=physicalResourceLocks.acquireWrite(resources);await after.release();
  const projection=f.repository.sourceProtection.snapshot();assert.equal(projection.complete,false);assert.ok(projection.issues.includes('PHYSICAL_HISTORY_UNKNOWN'));
  assert.ok(projection.references.some(reference=>reference.kind==='PREPARED'&&reference.locations.some(location=>location.relative==='Originals/A.wav')));
});

test('014 Prepared close：review已退场但freeze仍在await，close必须join且不得发布',async t=>{
  let entered!:()=>void,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
  const f=await preparedPublicationFixture(t,{afterFreezeReview:async()=>{entered();await gate;}});
  const stat=await lstat(path.join(f.owned.root.path,'Originals/A.wav'),{bigint:true}),resource={dev:String(stat.dev),ino:String(stat.ino)};
  const freezing=f.prepared.freeze(f.freeze);void freezing.catch(()=>{});await began;
  let closed=false;const closing=f.prepared.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  assert.throws(()=>physicalResourceLocks.acquireWrite([resource]),PhysicalResourceBusy);
  release();await assert.rejects(freezing);await closing;assert.equal(f.repository.prepared.list(f.draft.draftId).preps.length,0);
  const after=physicalResourceLocks.acquireWrite([resource]);await after.release();
});
