import assert from 'node:assert/strict';
import { rename, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { LocalFileSourcePool } from '../../src/stream/local-file-source.js';
import { physicalResourceLocks } from '../../src/stream/physical-resource-locks.js';
import { fixture, authority } from './fixture.js';

test('R1/AT03 descriptor之后替换文件、catalog数字全部未变仍不能把新bytes绑定旧修订', async t => {
  const f = await fixture(t), pool = new LocalFileSourcePool(); t.after(() => pool.close());
  const before = structuredClone(f.descriptor); await rename(f.absolute, f.absolute + '.old'); await writeFile(f.absolute, Buffer.alloc(f.bytes.length, 255));
  assert.deepEqual(f.descriptor, before); await assert.rejects(pool.prepare(f.descriptor, authority()));
  assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
  const lock = physicalResourceLocks.acquireWrite([f.resource]); await lock.release();
});

test('R1/AT03 缺少可信扫描观察拒绝Pool准入，不能退化为当下stat自证', async t => {
  const f = await fixture(t), pool = new LocalFileSourcePool(); t.after(() => pool.close());
  Reflect.deleteProperty(f.descriptor.facts, 'observation'); await assert.rejects(pool.prepare(f.descriptor, authority()), /INVALID_DESCRIPTOR/u);
  assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
});

for (const revision of ['fileRevision', 'rootRevision', 'locationRevision', 'selectionRevision'] as const) test(`R1/AT03 可信观察绑定的${revision}过期/改变时拒绝旧内容资格`, async t => {
  const f = await fixture(t), pool = new LocalFileSourcePool(); t.after(() => pool.close());
  if (revision === 'selectionRevision') f.descriptor.facts.track.selectionRevision = '99';
  else if (revision === 'rootRevision') { f.descriptor.facts.root.revision = '99'; f.descriptor.facts.asset.rootRevision = '99'; }
  else f.descriptor.facts.asset[revision] = '99';
  await assert.rejects(pool.prepare(f.descriptor, authority()), /INVALID_DESCRIPTOR/u);
  assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
});
