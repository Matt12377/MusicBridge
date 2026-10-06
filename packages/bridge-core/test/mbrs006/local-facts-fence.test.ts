import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSourceFence, LocalFactsFenceBusy, withLocalFactsMutation } from '../../src/stream/local-source-fence.js';

test('撤销由共享原子状态立即生效，旧票据不能复活', () => {
  const owner = LocalSourceFence.create(), core = new LocalSourceFence(owner.buffer);
  assert.equal(core.current, true); owner.revoke(); assert.equal(core.current, false);
  assert.throws(() => core.dispatch(() => assert.fail('不得派发')));
});
test('发送先取得claim：撤销后相关提交须等同步发送quiet', () => {
  const owner = LocalSourceFence.create(), core = new LocalSourceFence(owner.buffer);
  core.dispatch(() => {
    owner.revoke(); assert.equal(owner.references, 1);
    assert.throws(() => owner.assertQuiet(), LocalFactsFenceBusy);
  });
  assert.equal(owner.references, 0); owner.assertQuiet(); assert.equal(core.current, false);
});
test('SDK发送抛错仍释放claim，撤销先赢不调用SDK', () => {
  const fence = LocalSourceFence.create(); assert.throws(() => fence.dispatch(() => { throw new Error('受控SDK故障'); }));
  assert.equal(fence.references, 0); fence.revoke(); let sends = 0;
  assert.throws(() => fence.dispatch(() => sends++)); assert.equal(sends, 0);
});
test('事务外只重核已确认回滚的数据库操作，不重放未知提交', async () => {
  const fence = LocalSourceFence.create(); let calls = 0;
  await withLocalFactsMutation(() => { if (++calls === 1) { const busy = new LocalFactsFenceBusy([fence]); busy.confirmRollback(); throw busy; } return 7; });
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(withLocalFactsMutation(() => { calls++; throw new LocalFactsFenceBusy([fence]); }));
  assert.equal(calls, 1);
});
test('私有buffer严格拒绝错误尺寸、普通ArrayBuffer和非法原子状态', () => {
  assert.throws(() => new LocalSourceFence(new SharedArrayBuffer(32)));
  assert.throws(() => new LocalSourceFence(new ArrayBuffer(16) as unknown as SharedArrayBuffer));
  const fence = LocalSourceFence.create(); Atomics.store(new Int32Array(fence.buffer), 1, 9999);
  assert.equal(fence.current, false); assert.throws(() => fence.dispatch(() => assert.fail()));
});
