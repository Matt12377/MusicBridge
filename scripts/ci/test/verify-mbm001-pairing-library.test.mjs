import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMbm001Admission, MBM001_BASE } from '../verify-mbm001-pairing-library.mjs';
import { MBM002_BASE } from '../mbm002-admission.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const json = file => JSON.parse(readFileSync(path.join(root,file),'utf8'));
function fixture() {
  const gitJson = (file, revision = MBM001_BASE) => JSON.parse(execFileSync('git',['show',revision + ':' + file],{cwd:root,encoding:'utf8',maxBuffer:16777216}));
  const canonicalBytes = readFileSync(path.join(root,'packages/contracts/mobile/openapi.json'));
  return { execution: json('docs/postrust/MBM-001/EXECUTION_SCOPE.json'), tests: json('docs/postrust/MBM-001/TEST_SCOPE.json'), canonical: JSON.parse(canonicalBytes.toString('utf8')), canonicalBytes,
    // 001定位已完成交付，采用其精确最终R；当前002准入由独立002 guard验证。
    status: gitJson('project/STATUS.json', MBM002_BASE), plan: gitJson('project/POSTRUST_PLAN.json', MBM002_BASE), originalPlan: gitJson('project/POSTRUST_PLAN.json'), originalStatus: gitJson('project/STATUS.json'),
    discovered: Object.fromEntries([['core','packages/bridge-core/test/mbm001'],['desktop','apps/desktop/test/mbm001']].map(([area,directory]) => [area,readdirSync(path.join(root,directory)).map(file => directory + '/' + file)])) };
}
const rejects = (value, code) => assert.throws(() => assertMbm001Admission(value), error => error.code === code);
test('001原wire与当前独立范围可准入；源写/第二作者/Rust/default-on或预算改变拒绝', () => {
  assert.equal(assertMbm001Admission(fixture()), true);
  for (const [key,value] of [['sourceFilesWrite',true],['sqliteWriter','SECOND_WRITER'],['optionalRustReadonly','ON'],['newMobileListener','PUBLIC_DEFAULT_ON']]) {
    const f = fixture(); f.execution[key] = value; rejects(f,'MBM001_SCOPE_CHANGED');
  }
  const canonical = fixture(); canonical.canonicalBytes = Buffer.concat([canonical.canonicalBytes,Buffer.from('\n')]); rejects(canonical,'MBM001_SCOPE_CHANGED');
  const budget = fixture(); budget.execution.gateBudgets.totalTimeoutMs++; rejects(budget,'MBM001_SCOPE_CHANGED');
});
test('001不能改变原18/156整账本或013验收层级，不能把真实服务与Owner升级为通过', () => {
  const ledger = fixture(); ledger.plan.acceptance_cases[0].status = 'PROMOTED'; rejects(ledger,'MBM001_ORIGINAL_LEDGER_CHANGED');
  const old = fixture(), key = Object.keys(old.originalStatus).find(name => old.originalStatus[name]?.task?.startsWith?.('MBRS-'));
  assert.ok(key); old.status[key] = { ...old.status[key], ownerAcceptance: 'PASS' }; rejects(old,'MBM001_ORIGINAL_TASK_STATE_CHANGED');
  const live = fixture(); live.status.mobilePairingReadonlyLibrary.realServiceDeviceAudioOwner = 'PASS'; rejects(live,'MBM001_AUTHORITY_CHANGED');
});
test('001测试闭集拒绝未消费文件、缺案/重复名称及跨域借入，App独立范围不当软件通过', () => {
  const extra = fixture(); extra.discovered.core.push('packages/bridge-core/test/mbm001/unconsumed.test.ts'); rejects(extra,'MBM001_TEST_SCOPE_INCOMPLETE');
  const count = fixture(); count.tests.core.expectedTests++; rejects(count,'MBM001_TEST_SCOPE_INCOMPLETE');
  const names = fixture(); names.tests.desktop.caseNames[0] = names.tests.desktop.caseNames[1]; rejects(names,'MBM001_TEST_SCOPE_INCOMPLETE');
  const cross = fixture(); cross.tests.core.testFiles[0] = 'packages/bridge-core/test/old-task.test.ts'; rejects(cross,'MBM001_TEST_SCOPE_INCOMPLETE');
  const app = fixture(); app.tests.app.softwareGate = 'PASS'; rejects(app,'MBM001_APP_SCOPE_INCOMPLETE');
});
