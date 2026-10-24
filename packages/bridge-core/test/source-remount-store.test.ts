import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSourceStore, sourceEvidenceMigration } from '../src/recording/source-store.js';
import type { RootCapability } from '../src/recording/source-files.js';

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
