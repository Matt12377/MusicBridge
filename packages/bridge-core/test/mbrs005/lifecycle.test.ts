import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalFileSourcePool } from '../../src/stream/local-file-source.js';
import { physicalResourceLocks, PhysicalResourceBusy } from '../../src/stream/physical-resource-locks.js';
import { fixture, authority, session } from './fixture.js';

test('AT12 已关闭attempt不能通过重新prepare复活，较新attempt才能取得新租约', async t => {
  const f = await fixture(t), pool = new LocalFileSourcePool(); t.after(() => pool.close());
  const lease = await pool.prepare(f.descriptor, authority()); await lease.close();
  await assert.rejects(pool.prepare(f.descriptor, authority()), /STALE_ATTEMPT/u);
  const newer = await pool.prepare(f.descriptor, authority(2)); newer.confirmSession(session(2)); assert.equal(newer.state, 'ACTIVE');
});

test('AT07/12 PREPARED可探测但只有可信确认会话转ACTIVE，PAUSED保持物理读保护', async t => {
  const f = await fixture(t), pool = new LocalFileSourcePool(); t.after(() => pool.close());
  const lease = await pool.prepare(f.descriptor, authority()); assert.equal(lease.state, 'PREPARED'); await lease.verify();
  assert.throws(() => lease.renew(session()), /NOT_CONFIRMED/u);
  assert.throws(() => lease.confirmSession({ ...session(), isConfirmed: () => false }), /NOT_CONFIRMED/u);
  assert.throws(() => lease.confirmSession(session(2)), /NOT_CONFIRMED/u);
  lease.confirmSession(session()); lease.pause(session()); assert.equal(lease.state, 'PAUSED');
  assert.throws(() => physicalResourceLocks.acquireWrite([f.resource]), PhysicalResourceBusy);
  lease.renew(session()); assert.equal(lease.state, 'PAUSED');
  assert.throws(() => lease.confirmSession({ ...session(), sessionId: 'other-session' }), /NOT_CONFIRMED/u);
  lease.confirmSession(session()); assert.equal(lease.state, 'ACTIVE'); await lease.close();
  const writer = physicalResourceLocks.acquireWrite([f.resource]); await writer.release(); assert.equal(lease.state, 'CLOSED');
});

test('AT12 新attempt使旧会话失效，target/currentness变化拒绝续租且不恢复', async t => {
  const f = await fixture(t), pool = new LocalFileSourcePool(); t.after(() => pool.close());
  let current = true;
  const old = await pool.prepare(f.descriptor, { ...authority(), isCurrent: () => current }); old.confirmSession(session());
  const next = await pool.prepare(f.descriptor, authority(2));
  assert.throws(() => old.confirmSession(session()), /STALE_ATTEMPT/u); await assert.rejects(old.verify(), /STALE_ATTEMPT/u); await old.close();
  next.confirmSession(session(2)); current = false;
  await assert.rejects(pool.prepare(f.descriptor, { ...authority(3), isCurrent: () => current }), /STALE_ATTEMPT/u);
});

test('AT07/10 有界FD池、PREPARED期限与总租期不能被续租无限延长', async t => {
  const f = await fixture(t); let now = 0;
  const pool = new LocalFileSourcePool({ maxLeases: 1, now: () => now }); t.after(() => pool.close());
  const lease = await pool.prepare(f.descriptor, authority());
  await assert.rejects(pool.prepare(f.descriptor, authority(1, 'other-owner')), /CAPACITY/u);
  now = 30_001; await assert.rejects(lease.verify(), /EXPIRED/u); await lease.close();
  const active = await pool.prepare(f.descriptor, authority(2)); active.confirmSession(session(2));
  for (let i = 0; i < 144; i++) { now += 299_000; active.renew(session(2)); }
  now += 299_000; assert.throws(() => active.renew(session(2)), /EXPIRED/u); await active.close();
  assert.deepEqual(pool.resourceSnapshot(), { openLeases: 0, reservations: 0 });
});

test('AT01 固定事实修订与根描述符不随调用者对象修改，公开片段尚不冒充整文件', async t => {
  const f = await fixture(t), pool = new LocalFileSourcePool(); t.after(() => pool.close());
  const lease = await pool.prepare(f.descriptor, authority());
  f.descriptor.facts.asset.fileRevision = '99'; f.descriptor.facts.relative = '不存在.wav';
  assert.equal(lease.revisions.assetRevision, '2'); assert.equal(lease.revisions.locationRevision, '3'); await lease.verify();
  const invalid = structuredClone(f.descriptor); invalid.facts.track.segment = { id: invalid.facts.track.id, startFrame: '0', endFrameExclusive: '20', timebaseHz: 44100 };
  await assert.rejects(pool.prepare(invalid, authority(2)), /INVALID_DESCRIPTOR/u);
});
