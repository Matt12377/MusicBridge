import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createMobileSealedStateStore } from '../../src/mobile/sealed-state-store.js';
import { MobileAuthPersistenceError } from '../../src/mobile/types.js';

function fixture() {
  const temporary = process.env.TMPDIR;
  const hostedRoot = process.env.RUNNER_TEMP;
  const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
    && typeof hostedRoot === 'string' && path.isAbsolute(hostedRoot) && typeof temporary === 'string'
    && temporary.startsWith(hostedRoot + path.sep);
  assert.ok(typeof temporary === 'string' && (process.platform === 'darwin' && temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/') || hosted));
  const directory = mkdtempSync(path.join(temporary, 'mbm001-state-'));
  chmodSync(directory, 0o700);
  const datasetId = randomUUID();
  return { directory, datasetId, options: { directory, datasetId, assertCurrent() {} } };
}
test('持久状态冷重开、CAS和原commit完整字节保持', () => {
  const f = fixture(), first = createMobileSealedStateStore(f.options);
  assert.deepEqual(first.load(f.datasetId), { kind: 'missing', datasetId: f.datasetId, revision: 0 });
  const request = { datasetId: f.datasetId, expectedRevision: 0, commitId: randomUUID(), sealed: new Uint8Array([1, 2, 3, 4]) };
  assert.equal(first.save(request).kind, 'saved');
  const reopened = createMobileSealedStateStore(f.options), loaded = reopened.load(f.datasetId);
  assert.equal(loaded.kind, 'sealed');
  if (loaded.kind !== 'sealed') assert.fail();
  assert.deepEqual(loaded.sealed, request.sealed);
  assert.equal(loaded.commitId, request.commitId); assert.equal(loaded.revision, 1);
  assert.deepEqual(reopened.save(request), { kind: 'saved', datasetId: f.datasetId, revision: 1, commitId: request.commitId });
  assert.deepEqual(reopened.save({ ...request, commitId: randomUUID() }), { kind: 'conflict', datasetId: f.datasetId, currentRevision: 1 });
  assert.throws(() => reopened.save({ ...request, sealed: new Uint8Array([9]) }), MobileAuthPersistenceError);
  assert.deepEqual(reopened.load(f.datasetId), loaded);
  const privateDirectory = path.join(f.directory, 'mobile-devices');
  assert.equal(lstatSync(privateDirectory).mode & 0o777, 0o700);
  assert.equal(lstatSync(path.join(privateDirectory, 'device-state.v1.sealed.json')).mode & 0o777, 0o600);
});
test('发布后未知结果只读原commit，不重写或丢失密文', () => {
  const f = fixture(), store = createMobileSealedStateStore({ ...f.options, afterPublish() { throw new Error('合成故障'); } });
  const request = { datasetId: f.datasetId, expectedRevision: 0, commitId: randomUUID(), sealed: new Uint8Array([6, 7]) };
  assert.throws(() => store.save(request), error => error instanceof MobileAuthPersistenceError && error.outcome === 'unknown');
  const loaded = createMobileSealedStateStore(f.options).load(f.datasetId);
  assert.equal(loaded.kind, 'sealed');
  if (loaded.kind !== 'sealed') assert.fail();
  assert.equal(loaded.commitId, request.commitId); assert.deepEqual(loaded.sealed, request.sealed);
});
test('跨工作库、权限失效与坏预算不能写入', () => {
  const f = fixture(), store = createMobileSealedStateStore(f.options);
  assert.throws(() => store.load(randomUUID()), MobileAuthPersistenceError);
  assert.throws(() => store.save({ datasetId: randomUUID(), expectedRevision: 0, commitId: randomUUID(), sealed: new Uint8Array([1]) }), MobileAuthPersistenceError);
  assert.throws(() => store.save({ datasetId: f.datasetId, expectedRevision: -1, commitId: randomUUID(), sealed: new Uint8Array([1]) }), MobileAuthPersistenceError);
  const revoked = createMobileSealedStateStore({ ...f.options, assertCurrent() { throw new Error('合成撤权'); } });
  assert.throws(() => revoked.load(f.datasetId), MobileAuthPersistenceError);
  assert.equal(store.load(f.datasetId).kind, 'missing');
});
test('符号链接和损坏密文保持拒绝，原目标字节不变', () => {
  const f = fixture(), store = createMobileSealedStateStore(f.options); store.load(f.datasetId);
  const target = path.join(f.directory, 'outside-fixture'); writeFileSync(target, '合成原资料', { mode: 0o600 });
  const link = path.join(f.directory, 'mobile-devices', 'device-state.v1.sealed.json'); symlinkSync(target, link);
  assert.throws(() => store.load(f.datasetId), MobileAuthPersistenceError);
  assert.throws(() => store.save({ datasetId: f.datasetId, expectedRevision: 0, commitId: randomUUID(), sealed: new Uint8Array([1]) }), MobileAuthPersistenceError);
  assert.equal(readFileSync(target, 'utf8'), '合成原资料');
  const g = fixture(), good = createMobileSealedStateStore(g.options);
  good.save({ datasetId: g.datasetId, expectedRevision: 0, commitId: randomUUID(), sealed: new Uint8Array([3]) });
  const file = path.join(g.directory, 'mobile-devices', 'device-state.v1.sealed.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { sealed: string }; raw.sealed = 'BQ=='; writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
  assert.throws(() => good.load(g.datasetId), MobileAuthPersistenceError);
  const h = fixture(), single = createMobileSealedStateStore(h.options);
  const request = { datasetId: h.datasetId, expectedRevision: 0, commitId: randomUUID(), sealed: new Uint8Array([4]) };
  single.save(request);
  const original = path.join(h.directory, 'mobile-devices', 'device-state.v1.sealed.json'), originalBytes = readFileSync(original);
  linkSync(original, path.join(h.directory, 'second-name'));
  assert.throws(() => single.load(h.datasetId), MobileAuthPersistenceError);
  assert.throws(() => single.save({ ...request, commitId: randomUUID(), expectedRevision: 1 }), MobileAuthPersistenceError);
  assert.deepEqual(readFileSync(original), originalBytes);
});
