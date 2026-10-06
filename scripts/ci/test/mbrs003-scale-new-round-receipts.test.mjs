import assert from 'node:assert/strict';
import test from 'node:test';
import { readSnapshot04LoadEvidence } from '../mbrs003-scale-receipts.mjs';

const consumedDeadline = 151377066685041n;
const receiptKeys = ['gate', 'result', 'admission', 'fs_terminal', 'process_closure', 'terminal'];
const reference = id => ({ path: '/synthetic-mbrs003/' + id + '.json', bytes: 1, sha256: 'f'.repeat(64) });
function profile(count, started) {
  const whole = count === 100000 ? 23400 : 66600;
  return {
    count, state: 'TERMINAL', wholeBudgetSeconds: whole,
    innerBudgetMs: count === 100000 ? 21600000 : 64800000,
    defaultReaderTimeoutMs: 3000, retries: 0,
    startedMonotonicNs: String(started),
    profileDeadlineMonotonicNs: String(started + BigInt(whole) * 1000000000n),
    historicalConsumed300kDeadlineMonotonicNs: String(consumedDeadline),
    ownerApprovalRef: reference('owner-' + count),
    bindingRef: reference('binding-' + count),
    runnerSealRef: reference('seal-' + count),
    executionClosureRef: reference('execution-' + count),
    references: Object.fromEntries(receiptKeys.map(key => [key, reference(key + '-' + count)])),
  };
}
function specification() {
  const firstStart = consumedDeadline + 1000000000n;
  return {
    schema: 'mbrs003.scan-load-current-fixed-receipts.v3',
    status: 'ROOT_CURRENT_FIXED_SCALE_TERMINAL_RECEIPTS_FROZEN',
    nodeExecutable: '/synthetic-mbrs003/node',
    profiles: [profile(100000, firstStart), profile(300000, firstStart + 23400000000001n)],
  };
}
function storageBoundary() {
  let reads = 0;
  const sentinel = new Error('已到首份收据准入边界，测试不读取正文。');
  return {
    admission: { storage: { check() { reads++; throw sentinel; } } },
    budget: { check() {} }, sentinel, count: () => reads,
  };
}
async function rejectBeforeReading(value) {
  const boundary = storageBoundary();
  const pending = readSnapshot04LoadEvidence(value, boundary.admission, boundary.budget);
  assert(pending instanceof Promise);
  await assert.rejects(pending, error => [
    'SCAN_LOAD_IDENTITY_INVALID', 'SCAN_LOAD_TERMINAL_ADAPTER_MISSING', 'SCAN_LOAD_PROFILE_NOT_TERMINAL',
  ].includes(error?.code));
  assert.equal(boundary.count(), 0);
}

// 合成收据头只证明准入或拒收行为，不制造完整负载成功结果。
test('新轮次允许10万和30万使用不同截止与不同许可，先检查收据再作结论', async () => {
  const value = specification(), boundary = storageBoundary();
  assert.notEqual(value.profiles[0].profileDeadlineMonotonicNs, value.profiles[1].profileDeadlineMonotonicNs);
  assert(BigInt(value.profiles[0].profileDeadlineMonotonicNs) < BigInt(value.profiles[1].startedMonotonicNs));
  assert.notEqual(value.profiles[0].ownerApprovalRef.path, value.profiles[1].ownerApprovalRef.path);
  await assert.rejects(readSnapshot04LoadEvidence(value, boundary.admission, boundary.budget), error => error === boundary.sentinel);
  assert.equal(boundary.count(), 1);
});

test('旧已消费窗口和不规范时间不能改成新轮次，拒收时不读文件', async () => {
  for (const count of [100000, 300000]) {
    const value = specification(), p = value.profiles.find(row => row.count === count);
    p.startedMonotonicNs = String(consumedDeadline - BigInt(p.wholeBudgetSeconds) * 1000000000n);
    p.profileDeadlineMonotonicNs = String(consumedDeadline);
    await rejectBeforeReading(value);
    for (const invalid of [null, '001', 'abc', '123.4']) {
      const malformed = specification();
      malformed.profiles.find(row => row.count === count).startedMonotonicNs = invalid;
      await rejectBeforeReading(malformed);
    }
  }
});

test('固定内外预算、单次期限和零重试不可被收据头放大', async () => {
  for (const count of [100000, 300000]) {
    for (const key of ['wholeBudgetSeconds', 'innerBudgetMs', 'defaultReaderTimeoutMs', 'retries', 'profileDeadlineMonotonicNs']) {
      const value = specification(), p = value.profiles.find(row => row.count === count);
      p[key] = key === 'profileDeadlineMonotonicNs' ? String(BigInt(p[key]) + 1n) : p[key] + 1;
      await rejectBeforeReading(value);
    }
  }
});

test('缺新许可、复用已消费许可或缺任一终态收据，都在文件读取前拒绝', async () => {
  for (const count of [100000, 300000]) {
    for (const approval of [null, {
      ...reference('consumed-owner'),
      sha256: 'b3808ca399610f80c4ef3cfa904851e0788a722e22ff9441a4fc4657c2c95f0a',
    }]) {
      const value = specification();
      value.profiles.find(row => row.count === count).ownerApprovalRef = approval;
      await rejectBeforeReading(value);
    }
    for (const key of receiptKeys) {
      const value = specification();
      value.profiles.find(row => row.count === count).references[key] = null;
      await rejectBeforeReading(value);
    }
  }
});

test('旧同步拒收合同保持，未准入v2仍异步拒收且不读文件', async () => {
  const boundary = storageBoundary();
  assert.throws(() => readSnapshot04LoadEvidence({ schema: 'unknown' }, boundary.admission, boundary.budget),
    error => error?.code === 'SCAN_LOAD_TERMINAL_ADAPTER_MISSING');
  const pending = readSnapshot04LoadEvidence({
    schema: 'mbrs003.scan-load-current-fixed-receipts.v2', status: 'NOT_ADMITTED', profiles: [],
  }, boundary.admission, boundary.budget);
  assert(pending instanceof Promise);
  await assert.rejects(pending, error => error?.code === 'SCAN_LOAD_TERMINAL_ADAPTER_MISSING');
  assert.equal(boundary.count(), 0);
});
