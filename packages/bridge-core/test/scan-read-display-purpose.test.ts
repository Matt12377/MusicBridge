import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { DatasetOwnerDispatchError, isDatasetProjectionPayload } from '../src/collection/dataset-owner-protocol.js';
import { createScanReadAdmission, ScanReadAdmissionError, type ScanReadAdmission, type ScanReadContext, type ScanReadPurpose } from '../src/library/scan-read-admission.js';
import { responseFailure } from '../src/shared/ipc-failure.js';

const scope: ScanReadContext = { epoch: '11111111-1111-4111-8111-111111111111', datasetId: '22222222-2222-4222-8222-222222222222' };
const other = '33333333-3333-4333-8333-333333333333';

function heldPermits(t: test.TestContext, admission: ScanReadAdmission) {
  const held = new Set<string>();
  t.after(() => {
    admission.close();
    for (const id of held) admission.release(scope, id);
    assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true });
  });
  return {
    grant(purpose?: ScanReadPurpose): string {
      const result = admission.acquire(scope, purpose);
      assert.equal(result.status, 'granted');
      if (result.status !== 'granted') assert.fail('原准入未授予测试票据。');
      held.add(result.permitId); return result.permitId;
    },
    release(id: string): void { admission.release(scope, id); held.delete(id); },
  };
}

test('显示读取私有用途：payload只接受旧空对象或唯一显示用途，getter与换用途均拒绝', () => {
  for (const payload of [{}, Object.create(null), { purpose: 'local-album-display' }, Object.assign(Object.create(null), { purpose: 'local-album-display' })]) {
    assert.equal(isDatasetProjectionPayload('scanReadAcquire', payload), true);
  }
  let getters = 0, proxyTraps = 0;
  const getter = Object.defineProperty({}, 'purpose', { enumerable: true, get() { getters++; return 'local-album-display'; } });
  const hidden = Object.defineProperty({}, 'purpose', { enumerable: false, value: 'local-album-display' });
  const proxy = new Proxy({}, { ownKeys() { proxyTraps++; return []; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const payload of [null, [], { purpose: 'scan' }, { purpose: 'unknown' }, { purpose: undefined }, { purpose: true },
    { purpose: 'local-album-display', extra: true }, { purpose: 'local-album-display', [Symbol('extra')]: true },
    Object.create({ purpose: 'local-album-display' }), getter, hidden, proxy, revoked.proxy]) {
    assert.equal(isDatasetProjectionPayload('scanReadAcquire', payload), false);
  }
  for (const command of ['scanReadWatchRevocation', 'scanReadRelease'] as const) {
    assert.equal(isDatasetProjectionPayload(command, { permitId: other }), true);
    assert.equal(isDatasetProjectionPayload(command, { permitId: other, purpose: 'local-album-display' }), false);
    assert.equal(isDatasetProjectionPayload(command, { purpose: 'local-album-display' }), false);
    assert.equal(isDatasetProjectionPayload(command, Object.defineProperty({}, 'permitId', { enumerable: true, get() { getters++; return other; } })), false);
  }
  assert.equal(getters, 0); assert.equal(proxyTraps, 0);
});

test('显示读取私有用途：混合票据共用两槽，observe按原用途撤销且未quiet不扣槽', async t => {
  let scanBusy = false, displayBusy = false;
  const admission = createScanReadAdmission({ isBusy: () => scanBusy, isDisplayBusy: () => displayBusy }), held = heldPermits(t, admission);
  const scan = held.grant(), display = held.grant('local-album-display');
  for (const context of [{ ...scope, epoch: other }, { ...scope, datasetId: other }]) {
    for (const id of [scan, display]) {
      assert.throws(() => admission.watchRevocation(context, id), ScanReadAdmissionError);
      assert.throws(() => admission.release(context, id), ScanReadAdmissionError);
    }
  }
  const scanWatch = admission.watchRevocation(scope, scan), displayWatch = admission.watchRevocation(scope, display);
  assert.deepEqual(admission.acquire(scope), { status: 'deferred' });
  assert.deepEqual(admission.acquire(scope, 'local-album-display'), { status: 'deferred' });
  scanBusy = true; admission.observe();
  assert.deepEqual(await scanWatch, { reason: 'media-busy' });
  assert.deepEqual(admission.resourceCounts(), { permits: 2, revoked: 1, watches: 1, timers: 1, closed: false });
  assert.deepEqual(admission.acquire(scope, 'local-album-display'), { status: 'deferred' }, '撤销扫描票仍占原槽，不能另开显示池。');
  held.release(scan);
  const secondDisplay = held.grant('local-album-display');
  assert.deepEqual(admission.acquire(scope), { status: 'deferred' }, '旧扫描语义仍由原busy阻断。');
  scanBusy = false; displayBusy = true; admission.observe();
  assert.deepEqual(await displayWatch, { reason: 'media-busy' });
  assert.deepEqual(admission.resourceCounts(), { permits: 2, revoked: 2, watches: 0, timers: 0, closed: false });
  displayBusy = false;
  assert.deepEqual(await admission.watchRevocation(scope, secondDisplay), { reason: 'media-busy' }, '繁忙恢复不能洗掉原票已撤销的事实。');
  assert.deepEqual(admission.acquire(scope), { status: 'deferred' });
  held.release(display);
  held.grant('scan');
  assert.equal(admission.resourceCounts().permits, 2);
});

test('显示读取私有用途：显示采样异常保守撤销，缺省谓词与关闭仍保持原语义', async t => {
  let broken = false;
  const admission = createScanReadAdmission({ isBusy: () => false, isDisplayBusy: () => { if (broken) throw new Error('合成采样失败'); return false; } });
  const held = heldPermits(t, admission), display = held.grant('local-album-display'), watch = admission.watchRevocation(scope, display);
  broken = true;
  assert.deepEqual(admission.acquire(scope, 'local-album-display'), { status: 'deferred' });
  assert.deepEqual(await watch, { reason: 'media-busy' });
  const scan = held.grant(), scanWatch = admission.watchRevocation(scope, scan);
  admission.close();
  assert.deepEqual(await scanWatch, { reason: 'admission-closed' });
  assert.equal(admission.resourceCounts().permits, 2);
  assert.deepEqual(admission.acquire(scope, 'local-album-display'), { status: 'deferred' });
  let busy = true;
  const legacy = createScanReadAdmission({ isBusy: () => busy }), legacyHeld = heldPermits(t, legacy);
  assert.deepEqual(legacy.acquire(scope), { status: 'deferred' });
  assert.deepEqual(legacy.acquire(scope, 'local-album-display'), { status: 'deferred' }, '未注入显示谓词时必须回退原busy。');
  busy = false; const legacyDisplay = legacyHeld.grant('local-album-display'); busy = true;
  assert.deepEqual(await legacy.watchRevocation(scope, legacyDisplay), { reason: 'media-busy' });
  assert.throws(() => legacy.acquire(scope, 'unknown' as ScanReadPurpose), ScanReadAdmissionError);
  assert.equal(legacy.resourceCounts().permits, 1);
});

type ScanProjectionCommand = 'scanReadAcquire' | 'scanReadWatchRevocation' | 'scanReadRelease';
type ScanProjection = (command: ScanProjectionCommand, payload: unknown, context: ScanReadContext) => Promise<unknown>;
/** 精确提取原Utility三命令分支；仅证明该组件接线，不启动或冒充完整Utility/Owner。 */
async function originalUtilityProjection(admission: ScanReadAdmission, identity: ScanReadContext | undefined): Promise<ScanProjection> {
  const source = await readFile(new URL('../src/utility-main.ts', import.meta.url), 'utf8');
  const start = "            if (command === 'scanReadAcquire' || command === 'scanReadWatchRevocation' || command === 'scanReadRelease') {";
  const end = '\n            return projectionGateway!.handler(';
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const begin = source.indexOf(start), finish = source.indexOf(end, begin); assert.ok(finish > begin);
  const extracted = source.slice(begin, finish);
  const compiled = ts.transpileModule(`const projection = async (command: unknown, payload: unknown, context: { epoch: string; datasetId?: string }) => {\n${extracted}\nthrow new Error('此定向测试只接受扫描私有三命令。');\n};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true,
  });
  assert.equal((compiled.diagnostics ?? []).some(value => value.category === ts.DiagnosticCategory.Error), false);
  const instantiate = new Function('isDatasetProjectionPayload', 'DatasetOwnerDispatchError', 'responseFailure', 'runtime', 'ownerIdentity', `${compiled.outputText}\nreturn projection;`);
  return instantiate(isDatasetProjectionPayload, DatasetOwnerDispatchError, responseFailure, { getDatasetScanReadAdmission: () => admission }, identity) as ScanProjection;
}

test('显示读取私有用途：原Utility身份门禁后接同一准入，旧空payload不能取得显示资格', async t => {
  const admission = createScanReadAdmission({ isBusy: () => true, isDisplayBusy: () => false });
  const held = new Set<string>();
  t.after(() => { admission.close(); for (const id of held) admission.release(scope, id); assert.equal(admission.resourceCounts().permits, 0); assert.equal(admission.resourceCounts().timers, 0); });
  const projection = await originalUtilityProjection(admission, scope);
  assert.deepEqual(await projection('scanReadAcquire', {}, scope), { status: 'deferred' });
  const result = await projection('scanReadAcquire', { purpose: 'local-album-display' }, scope) as { status: string; permitId: string };
  assert.equal(result.status, 'granted'); held.add(result.permitId);
  const before = admission.resourceCounts();
  for (const context of [{ ...scope, epoch: other }, { ...scope, datasetId: other }]) {
    for (const command of ['scanReadAcquire', 'scanReadWatchRevocation', 'scanReadRelease'] as const) {
      await assert.rejects(projection(command, command === 'scanReadAcquire' ? { purpose: 'local-album-display' } : { permitId: result.permitId }, context), DatasetOwnerDispatchError);
    }
  }
  const noOwner = await originalUtilityProjection(admission, undefined);
  await assert.rejects(noOwner('scanReadAcquire', { purpose: 'local-album-display' }, scope), DatasetOwnerDispatchError);
  await assert.rejects(projection('scanReadAcquire', { purpose: 'scan' }, scope), DatasetOwnerDispatchError);
  for (const command of ['scanReadWatchRevocation', 'scanReadRelease'] as const) {
    await assert.rejects(projection(command, { permitId: result.permitId, purpose: 'local-album-display' }, scope), DatasetOwnerDispatchError);
  }
  assert.deepEqual(admission.resourceCounts(), before, '坏身份或换用途不得撤销、释放或新增原票据。');
  const watch = projection('scanReadWatchRevocation', { permitId: result.permitId }, scope);
  assert.deepEqual(await projection('scanReadRelease', { permitId: result.permitId }, scope), { released: true }); held.delete(result.permitId);
  assert.deepEqual(await watch, { reason: 'permit-released' });
  assert.equal(admission.resourceCounts().permits, 0); assert.equal(admission.resourceCounts().timers, 0);
});
