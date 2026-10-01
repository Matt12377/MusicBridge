import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcRequest } from '@music-bridge/contracts';
import { LibraryReadRegistry } from '../src/shared/library-read-registry.js';
import { currentLibraryRead, assertLibraryReadCurrent } from '../src/shared/library-read-lifetime.js';
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function request(id: string, cacheMode?: 'reload'): IpcRequest {
  return { version: 1, id, command: 'roon.library.albums', payload: { page: { offset: 0, limit: 24 } },
    readContext: { deadlineAtMs: Date.now() + 1_000, ...(cacheMode ? { cacheMode } : {}) } };
}

test('005刷新：普通与reload不同flight，同意图共享且ALS保留可信mode', async () => {
  const registry = new LibraryReadRegistry(() => '同一作用域');
  const modes: Array<'reload' | undefined> = []; const finishes: Array<() => void> = [];
  const operation = async () => { modes.push(currentLibraryRead()?.cacheMode); await new Promise<void>(resolve => finishes.push(resolve)); return modes.length; };
  const normal = registry.read(request('normal'), operation);
  const reload = registry.read(request('reload', 'reload'), operation);
  const shared = registry.read(request('shared', 'reload'), operation);
  await turn();
  try { assert.deepEqual(modes, [undefined, 'reload']); }
  finally { for (const finish of finishes) finish(); }
  await Promise.all([normal, reload, shared]);
});

test('005刷新：取消首订阅者不取消同reload，旧work仍占实际未返回预算', async () => {
  const registry = new LibraryReadRegistry(() => 'scope', Date.now, 1);
  let finish!: () => void; let calls = 0; let actualSignal!: AbortSignal;
  const work = async () => { calls++; actualSignal = currentLibraryRead()!.signal; await new Promise<void>(resolve => { finish = resolve; }); assertLibraryReadCurrent(); return '当前结果'; };
  const first = registry.read(request('first', 'reload'), work);
  const firstFailure = assert.rejects(first, /取消/u);
  const second = registry.read(request('second', 'reload'), work);
  await turn(); registry.cancel('first'); await firstFailure;
  assert.equal(actualSignal.aborted, false); assert.equal(calls, 1);
  finish(); assert.equal(await second, '当前结果'); await turn();
  const late = registry.read(request('late', 'reload'), work); const lateFailure = assert.rejects(late, /取消/u);
  await turn(); registry.cancel('late'); await lateFailure;
  await assert.rejects(registry.read(request('blocked', 'reload'), work), /预算已满/u);
  finish(); await turn(); assert.equal(await registry.read(request('after'), async () => '已释放'), '已释放');
});

test('005刷新：过期作用域的reload结果不能提交，旧finally不清新同意图', async () => {
  let scope = '旧'; const registry = new LibraryReadRegistry(() => scope);
  let finishOld!: () => void; let finishNew!: () => void; let calls = 0;
  const old = registry.read(request('old', 'reload'), async () => { await new Promise<void>(resolve => { finishOld = resolve; }); return '旧结果'; });
  const rejected = assert.rejects(old, /取消/u); await turn(); scope = '新';
  const operation = async () => { calls++; await new Promise<void>(resolve => { finishNew = resolve; }); return '新结果'; };
  const next = registry.read(request('next', 'reload'), operation); await turn(); finishOld(); await rejected; await turn();
  const shared = registry.read(request('shared', 'reload'), operation); await turn();
  assert.equal(calls, 1); finishNew(); assert.deepEqual(await Promise.all([next, shared]), ['新结果', '新结果']);
});
