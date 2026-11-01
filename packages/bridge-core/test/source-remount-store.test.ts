import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSourceStore, sourceEvidenceMigration } from '../src/recording/source-store.js';
import type { RootCapability } from '../src/recording/source-files.js';
import { sourcePlaybackExpectedSignature } from '../src/recording/source-remount-proof.js';

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:'); db.exec(sourceEvidenceMigration); t.after(() => db.close());
  let fences = 0, reject = false;
  const store = createSourceStore({ read: fn => fn(db), conflict: message => { throw new Error(message); },
    beforeLocalFactsCommit: () => { fences++; if (reject) throw new Error('合成在途读取尚未静止'); } });
  const previous = store.authorize(randomUUID(), { path: '/合成共享盘/曲库', dev: '12', ino: '-22', authorized: true, label: '曲库' });
  const current: RootCapability = { ...previous, dev: '23' };
  const dump = () => ({ roots: db.prepare('SELECT * FROM source_roots ORDER BY rowid').all(), ledger: db.prepare('SELECT * FROM source_ledger ORDER BY rowid').all() });
  return { db, store, previous, current, dump, fences: () => fences, block: () => { reject = true; } };
}
test('显式重挂载只改原根许可并追加不可变回执，同一操作幂等且保留其他授权', t => {
  const f = fixture(t), other = f.store.authorize(randomUUID(), { ...f.current, label: '另一根' });
  const before = f.dump(), command = randomUUID();
  const restored = f.store.privateReauthorizeRemount(command, f.previous, f.current, 'a'.repeat(64));
  assert.equal(restored.id, f.previous.id); assert.equal(restored.dev, '23'); assert.equal(restored.ino, '-22');
  assert.equal(restored.readonlyRemountProof?.previousDev, '12'); assert.equal(f.fences(), 1);
  const after = f.dump(); assert.equal(after.roots.length, before.roots.length); assert.equal(after.ledger.length, before.ledger.length + 1);
  assert.deepEqual(after.ledger.slice(0, -1), before.ledger); assert.deepEqual(f.store.root(other.id), other);
  assert.deepEqual(f.store.privateReauthorizeRemount(command, f.previous, f.current, 'a'.repeat(64)), restored);
  assert.deepEqual(f.dump(), after);
  assert.throws(() => f.store.privateReauthorizeRemount(command, f.previous, f.current, 'b'.repeat(64)));
  assert.throws(() => f.db.exec("UPDATE source_ledger SET result='重写历史'"), /immutable ledger/u);
});
test('旧捕获、其他根或路径、改变inode、无设备变化及撤权都不能取得重挂载许可', t => {
  const f = fixture(t), before = f.dump();
  for (const current of [{ ...f.current, id: randomUUID() }, { ...f.current, path: '/另一共享盘' }, { ...f.current, ino: '33' },
    { ...f.current, label: '另一目录' }, { ...f.current, dev: f.previous.dev }, { ...f.current, authorized: false }]) {
    assert.throws(() => f.store.privateReauthorizeRemount(randomUUID(), f.previous, current, 'a'.repeat(64)));
  }
  assert.throws(() => f.store.privateReauthorizeRemount(randomUUID(), { ...f.previous, dev: '13' }, f.current, 'a'.repeat(64)));
  assert.deepEqual(f.dump(), before);
  f.store.revoke({ commandId: randomUUID(), id: f.previous.id });
  const revoked = f.dump(); assert.throws(() => f.store.privateReauthorizeRemount(randomUUID(), f.previous, f.current, 'a'.repeat(64)));
  assert.deepEqual(f.dump(), revoked);
});
test('重挂载提交仍受原事实闩保护，拒绝时根与账本一起回滚', t => {
  const f = fixture(t), before = f.dump(); f.block();
  assert.throws(() => f.store.privateReauthorizeRemount(randomUUID(), f.previous, f.current, 'a'.repeat(64)), /未静止/u);
  assert.deepEqual(f.dump(), before); assert.equal(f.db.isTransaction, false);
});
test('批量恢复中后一根过期时前一根也回滚，成功时只通过一次提交闩', t => {
  const f = fixture(t), second = f.store.authorize(randomUUID(), { ...f.previous, path: '/合成共享盘/第二根' });
  const before = f.dump();
  const first = { commandId: randomUUID(), captured: f.previous, current: f.current, evidenceSha256: 'a'.repeat(64) };
  const next = { commandId: randomUUID(), captured: { ...second, dev: '13' }, current: { ...second, dev: '23' }, evidenceSha256: 'a'.repeat(64) };
  assert.throws(() => f.store.privateReauthorizeRemounts([first, next]));
  assert.deepEqual(f.dump(), before); assert.equal(f.fences(), 0);
  const result = f.store.privateReauthorizeRemounts([first, { ...next, captured: second }]);
  assert.equal(result.length, 2); assert.equal(f.fences(), 1); assert.equal(f.dump().ledger.length, before.ledger.length + 2);
});

test('v1恢复可凭真实来源摘要升级v2，连续挂载及回用旧设备号保留各代观察', t => {
  const f = fixture(t), share = 'b'.repeat(64);
  const first = f.store.privateReauthorizeRemount(randomUUID(), f.previous, f.current, 'a'.repeat(64));
  assert.equal(first.readonlyRemountProof?.version, 1);
  const before = f.dump();
  assert.throws(() => f.store.privateReauthorizeRemount(randomUUID(), first, { ...f.current, dev: '34' }, 'c'.repeat(64)));
  assert.deepEqual(f.dump(), before);
  const second = f.store.privateReauthorizeRemount(randomUUID(), first, { ...f.current, dev: '34' }, 'c'.repeat(64), share);
  assert.equal(second.readonlyRemountProof?.version, 2);
  assert.ok(second.readonlyRemountProof?.version === 2);
  assert.deepEqual(second.readonlyRemountProof.previousDevs, ['12', '23']);
  assert.equal(second.readonlyRemountProof.mountSourceSha256, share);
  for (const device of ['12', '23', '34']) assert.equal(sourcePlaybackExpectedSignature(second, `${device}:7:8:9:10`), '34:7:8:9:10');
  const returned = f.store.privateReauthorizeRemount(randomUUID(), second, f.previous, 'd'.repeat(64), share);
  assert.ok(returned.readonlyRemountProof?.version === 2);
  assert.deepEqual(returned.readonlyRemountProof.previousDevs, ['23', '34']);
  for (const device of ['12', '23', '34']) assert.equal(sourcePlaybackExpectedSignature(returned, `${device}:7:8:9:10`), '12:7:8:9:10');
  assert.equal(f.dump().ledger.length, before.ledger.length + 2);
});

test('v2绑定共享盘摘要后不能缺省或更换来源，原路径inode撤权及损坏证明仍拒绝', t => {
  const f = fixture(t), share = 'b'.repeat(64);
  const first = f.store.privateReauthorizeRemount(randomUUID(), f.previous, f.current, 'a'.repeat(64), share);
  const next = { ...f.current, dev: '34' }, before = f.dump();
  for (const source of [undefined, 'c'.repeat(64), '损坏摘要']) {
    assert.throws(() => f.store.privateReauthorizeRemount(randomUUID(), first, next, 'd'.repeat(64), source));
  }
  for (const current of [{ ...next, id: randomUUID() }, { ...next, path: '/另一共享盘' }, { ...next, ino: '33' },
    { ...next, label: '另一目录' }, { ...next, authorized: false }, { ...next, dev: first.dev }]) {
    assert.throws(() => f.store.privateReauthorizeRemount(randomUUID(), first, current, 'd'.repeat(64), share));
  }
  const damaged = structuredClone(first); Object.assign(damaged.readonlyRemountProof!, { previousDevs: ['12', '12'] });
  assert.throws(() => f.store.privateReauthorizeRemount(randomUUID(), damaged, next, 'd'.repeat(64), share));
  assert.deepEqual(f.dump(), before);
  f.store.revoke({ commandId: randomUUID(), id: first.id });
  const revoked = f.dump();
  assert.throws(() => f.store.privateReauthorizeRemount(randomUUID(), first, next, 'd'.repeat(64), share));
  assert.deepEqual(f.dump(), revoked);
});

test('v2批量来源摘要进入原回执，续接提交失败时整批根和不可变账本回滚', t => {
  const f = fixture(t), share = 'b'.repeat(64), command = randomUUID();
  const entry = { commandId: command, captured: f.previous, current: f.current, evidenceSha256: 'a'.repeat(64), mountSourceSha256: share };
  const first = f.store.privateReauthorizeRemounts([entry])[0]!;
  assert.equal(first.readonlyRemountProof?.version, 2);
  const before = f.dump();
  assert.deepEqual(f.store.privateReauthorizeRemounts([entry])[0], first);
  assert.deepEqual(f.dump(), before);
  assert.throws(() => f.store.privateReauthorizeRemounts([{ ...entry, mountSourceSha256: 'c'.repeat(64) }]));
  f.block();
  assert.throws(() => f.store.privateReauthorizeRemounts([{ commandId: randomUUID(), captured: first,
    current: { ...f.current, dev: '34' }, evidenceSha256: 'd'.repeat(64), mountSourceSha256: share }]), /未静止/u);
  assert.deepEqual(f.dump(), before); assert.equal(f.db.isTransaction, false);
});
