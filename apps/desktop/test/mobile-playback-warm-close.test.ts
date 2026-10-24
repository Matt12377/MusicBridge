import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { decodeMobileRequest } from '@music-bridge/contracts';
import { createMobileBackend } from '../src/main/mobile-backend.js';
import { mobileContentRpcFailure, type MobileContentCoreRequest,
  type MobileContentCoreResponse } from '../../../packages/bridge-core/src/mobile/content-rpc.js';
import { isMobileOwnerPrivateResult } from '../../../packages/bridge-core/src/mobile/owner-protocol.js';
import { MobileAuthPersistenceError, MobileServiceError, type MobileOwnerPrivateResult,
  type MobileSealedState } from '../../../packages/bridge-core/src/mobile/types.js';

const DATASET = '50000000-0000-4000-8000-000000000072';
const ORIGIN = 'https://127.0.0.1:9443';
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/** 真实 Main backend/播放服务，仅 Owner 与内容传输叶受控；不访问真实存储或媒体。 */
async function fixture(t: TestContext, outcome: 'not-sent' | 'unknown', contentCleanupFailure = false) {
  const authKey = new Uint8Array(32).fill(72);
  let auth: MobileSealedState = { kind: 'missing', datasetId: DATASET, revision: 0 };
  let loads = 0, saves = 0, scopes = 0, cancels = 0;
  let warmEntered!: () => void;
  const warmed = new Promise<void>(resolve => { warmEntered = resolve; });
  const backend = createMobileBackend({ serverId: 'warm.close.synthetic', datasetId: DATASET, authKey,
    displayName: '合成预热关闭', environment: 'development', enablePlayback: true,
    assertCurrent() {}, resizeArtwork: bytes => bytes,
    async requestOwner(request): Promise<MobileOwnerPrivateResult> {
      // 当前初始化先走history Owner；只在其原load注入同一纯读故障，不回落旧sealed端口。
      if (request.kind === 'playback-history') {
        assert.equal(request.request.op, 'load');
        loads++; warmEntered(); throw new MobileAuthPersistenceError(outcome);
      }
      let result: MobileOwnerPrivateResult;
      if (request.kind === 'load') result = structuredClone(auth);
      else if (request.kind === 'save') {
        assert.equal(request.request.expectedRevision, auth.revision); saves++;
        auth = { kind: 'sealed', datasetId: DATASET, revision: auth.revision + 1,
          commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) };
        result = { kind: 'saved', datasetId: DATASET, revision: auth.revision, commitId: auth.commitId };
      } else throw new Error('本例不派发来源、目录或播放写入。');
      assert.ok(isMobileOwnerPrivateResult(result, request)); return result;
    },
    ...(contentCleanupFailure ? { enableContent: true, requestContentRpc: async (request: MobileContentCoreRequest): Promise<MobileContentCoreResponse> => {
      if (request.action === 'initialize') return { type: 'mobile-content-core-response' as const,
        id: request.id, action: 'initialize' as const, ok: true as const };
      if (request.action === 'scope') scopes++;
      else if (request.action === 'cancel') cancels++;
      else throw new Error('本例不读取内容或来源。');
      return mobileContentRpcFailure(request, new MobileAuthPersistenceError('unknown'));
    } } : {}),
  });
  t.after(async () => {
    // 负向用例的同一关闭拒绝已由正文断言，不让重复清理遮盖原断言。
    await backend.close().catch(() => {}); authKey.fill(0);
    if (auth.kind === 'sealed') auth.sealed.fill(0);
  });
  backend.activatePlayback(ORIGIN); await warmed; await turn();
  return { backend, counts: () => ({ loads, saves, scopes, cancels }) };
}

test('Main预热关闭：首次播放纯读暂错已经落定，原服务静止后关闭成功且不重放预热', async t => {
  for (const outcome of ['not-sent', 'unknown'] as const) await t.test(outcome, async child => {
    const f = await fixture(child, outcome);
    assert.deepEqual(f.counts(), { loads: 1, saves: 0, scopes: 0, cancels: 0 });
    const first = f.backend.close(); assert.equal(f.backend.close(), first);
    await first;
    assert.deepEqual(f.counts(), { loads: 1, saves: 0, scopes: 0, cancels: 0 });
  });
});

test('Main预热关闭：历史纯读暂错不能掩盖真实内容取消未获quiet的关闭失败', async t => {
  const f = await fixture(t, 'not-sent', true);
  const permit = await f.backend.auth.issuePairing();
  const pair = await f.backend.auth.claim({ pairingSecret: permit.pairingSecret,
    installationId: 'warm.close.synthetic.installation', deviceName: '合成客户端' }, 'warm.close.claim');
  const request = decodeMobileRequest('getCapabilities', { method: 'GET', path: '/mobile/v1/capabilities',
    headers: [['Authorization', `Bearer ${pair.accessToken}`]], query: [], body: new Uint8Array() },
  { responseOrigin: ORIGIN, requestPath: '/mobile/v1/capabilities' }); assert.ok(request.ok);
  await assert.rejects(f.backend.backend.dispatch({ operation: 'getCapabilities', request: request.value,
    accessToken: pair.accessToken, signal: new AbortController().signal }),
  error => error instanceof MobileServiceError && error.status === 503 && error.code === 'BUSY');
  await turn();
  const first = f.backend.close(); assert.equal(f.backend.close(), first);
  await assert.rejects(first, error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some(value => value instanceof MobileServiceError && value.status === 503
      && value.code === 'BUSY' && Object.getOwnPropertyDescriptor(value, 'outcome')?.value === 'unknown'));
    return true;
  });
  assert.equal(f.counts().loads, 1); assert.equal(f.counts().scopes, 1); assert.equal(f.counts().cancels, 2);
  await assert.rejects(f.backend.close());
});
