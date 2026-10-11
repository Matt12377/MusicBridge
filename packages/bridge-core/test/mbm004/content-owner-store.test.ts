import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mobileCanonicalJson } from '@music-bridge/contracts';
import type { MobileJsonValue } from '@music-bridge/contracts';
import { createMobileContentOwnerStore, MobileContentPersistenceError, type MobileContentOwnerStoreOptions } from '../../src/mobile/content-owner-store.js';
import { applyMobileContentMutation, createMobileContentState, lookupMobileContentReceipt, mobileContentDomainSnapshot } from '../../src/mobile/content-state.js';
import type { MobileContentMutationInput, MobileContentScope, MobileContentStateLimits } from '../../src/mobile/content-types.js';

const limits: MobileContentStateLimits = { stateBytes: 1024 * 1024, receipts: 100, albums: 100, favoriteTracks: 100, playlists: 100, playlistTracks: 100 };
function fixture() {
  const tmp = process.env.TMPDIR, hosted = process.env.RUNNER_TEMP;
  assert.ok(typeof tmp === 'string' && path.isAbsolute(tmp) && (tmp.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')
    || process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && typeof hosted === 'string' && path.isAbsolute(hosted) && tmp.startsWith(hosted + path.sep)));
  const directory = mkdtempSync(path.join(tmp, 'mbm004-content-store-')); chmodSync(directory, 0o700);
  const serverId = 'server.004', datasetId = randomUUID(), key = randomBytes(32);
  const scope: MobileContentScope = { serverId, datasetId, deviceId: 'device.1', deviceEpoch: 1, accessGeneration: 1, ownerEpoch: 'owner.1', accountDomain: 'content.1', providerEpoch: null };
  const seal = (plain: Uint8Array): Uint8Array => {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(datasetId));
    const payload = Buffer.concat([cipher.update(plain), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), payload]);
  };
  const open = (sealed: Uint8Array): Uint8Array => {
    const bytes = Buffer.from(sealed), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(datasetId)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  };
  const options = { directory, serverId, datasetId, limits, seal, open, assertCurrent() {} };
  const state = createMobileContentState({ serverId, datasetId });
  const input: MobileContentMutationInput = { operation: 'createPersonalPlaylist', scope, request: {
    path: '/mobile/v1/ui/playlists', pathParameters: {}, query: {}, idempotencyKey: 'original.command',
    body: { accountDomain: scope.accountDomain, expectedCollectionRevision: mobileContentDomainSnapshot(state, scope, limits).collectionRevision,
      draft: { title: '加密合成歌单', icon: 'music.note', description: '' }, initialTrack: null } } };
  const applied = applyMobileContentMutation(state, input, {}, { limits, newPlaylistId: 'playlist.1' });
  const request = { expectedRevision: 0, commitId: randomUUID(), state: applied.state, guard() {} };
  const file = path.join(directory, 'mobile-content', 'content-state.v1.sealed.json');
  return { options, directory, file, state, input, applied, request };
}
const outcome = (value: 'not-sent' | 'unknown') => (error: unknown) => error instanceof MobileContentPersistenceError && error.outcome === value;

test('内容Owner存储：真实AES-GCM同次数据与回执冷重开完整保持', () => {
  const f = fixture(), store = createMobileContentOwnerStore(f.options);
  assert.equal(store.load().revision, 0); assert.equal(store.save(f.request).kind, 'saved');
  const cold = createMobileContentOwnerStore(f.options).load();
  assert.equal(cold.commitId, f.request.commitId); assert.equal(cold.revision, 1); assert.deepEqual(cold.state, f.applied.state);
  assert.deepEqual(lookupMobileContentReceipt(cold.state, f.input, limits), f.applied.reply);
  const file = readFileSync(f.file, 'utf8'); assert.equal(file.includes('加密合成歌单'), false);
  assert.equal(lstatSync(path.dirname(f.file)).mode & 0o777, 0o700); assert.equal(lstatSync(f.file).mode & 0o777, 0o600);
});

test('内容Owner存储：同步CAS与原commit重取不重写文件', () => {
  const f = fixture(), store = createMobileContentOwnerStore(f.options); store.save(f.request);
  const before = readFileSync(f.file), identity = lstatSync(f.file, { bigint: true });
  assert.equal(store.save(f.request).kind, 'saved'); assert.deepEqual(readFileSync(f.file), before);
  assert.equal(lstatSync(f.file, { bigint: true }).ino, identity.ino);
  assert.deepEqual(store.save({ ...f.request, commitId: randomUUID() }), { kind: 'conflict', currentRevision: 1 });
  assert.throws(() => store.save({ ...f.request, state: f.state }), outcome('not-sent'));
});

test('内容Owner存储：发布后UNKNOWN封新写，必须读原commit解决且不自动重做', () => {
  const f = fixture(); let fail = true;
  const store = createMobileContentOwnerStore({ ...f.options, afterPublish() { if (fail) throw new Error('受控丢回执'); } });
  assert.throws(() => store.save(f.request), outcome('unknown')); const published = readFileSync(f.file);
  fail = false;
  assert.throws(() => store.load(), outcome('unknown'));
  assert.throws(() => store.save(f.request), outcome('unknown'));
  assert.throws(() => store.resolve(randomUUID()), outcome('unknown'));
  assert.deepEqual(readFileSync(f.file), published);
  const resolved = store.resolve(f.request.commitId); assert.equal(resolved.commitId, f.request.commitId); assert.deepEqual(resolved.state, f.applied.state);
  assert.equal(store.save(f.request).kind, 'saved'); assert.deepEqual(readFileSync(f.file), published);
});

test('内容Owner存储：创建参数和原commit绑定不被同步回调改写', () => {
  const f = fixture(), originalCommit = f.request.commitId;
  const options: MobileContentOwnerStoreOptions = { ...f.options, afterPublish() { throw new Error('受控发布后丢回执'); } };
  const store = createMobileContentOwnerStore(options);
  options.serverId = 'server.replaced'; options.datasetId = 'dataset.replaced';
  options.seal = () => { throw new Error('不应调用替换函数'); };
  options.open = () => { throw new Error('不应调用替换函数'); };
  options.assertCurrent = () => { throw new Error('不应调用替换函数'); };
  options.afterPublish = () => {};
  const request = { ...f.request };
  request.guard = () => { request.commitId = randomUUID(); request.expectedRevision = 999; };
  assert.throws(() => store.save(request), error => outcome('unknown')(error)
    && (error as MobileContentPersistenceError).commitId === originalCommit);
  const saved = readFileSync(f.file);
  const actual = store.resolve(originalCommit);
  assert.equal(actual.commitId, originalCommit); assert.equal(actual.revision, 1);
  assert.deepEqual(lookupMobileContentReceipt(actual.state, f.input, limits), f.applied.reply);
  assert.deepEqual(readFileSync(f.file), saved);
  assert.deepEqual(store.load(), actual);
});

test('内容Owner存储：线性化guard撤销阻止发布，提交后撤销不删除原回执', () => {
  const f = fixture(), store = createMobileContentOwnerStore(f.options);
  assert.throws(() => store.save({ ...f.request, guard() { throw new Error('同步撤销'); } }), outcome('not-sent'));
  assert.equal(store.load().revision, 0);
  let current = true;
  const later = createMobileContentOwnerStore({ ...f.options, assertCurrent() { if (!current) throw new Error('已撤销'); }, afterPublish() { current = false; } });
  assert.throws(() => later.save(f.request), outcome('unknown'));
  current = true; const actual = later.resolve(f.request.commitId);
  assert.deepEqual(lookupMobileContentReceipt(actual.state, f.input, limits), f.applied.reply);
  const g = fixture(), outer = createMobileContentOwnerStore(g.options), nested = createMobileContentOwnerStore(g.options);
  // 受控第二 actor 只用于模拟同步 guard 重入；生产仍只有唯一 Owner。
  assert.throws(() => outer.save({ ...g.request, guard() { nested.save(g.request); } }), outcome('not-sent'));
  assert.deepEqual(lookupMobileContentReceipt(nested.load().state, g.input, limits), g.applied.reply);
  const h = fixture(), asynchronous = createMobileContentOwnerStore(h.options);
  assert.throws(() => asynchronous.save({ ...h.request, guard: async () => {} }), outcome('not-sent'));
  assert.equal(asynchronous.load().revision, 0);
});

test('内容Owner存储：符号链接和多硬链接拒绝且原目标字节不变', () => {
  for (const type of ['symbolic', 'hard'] as const) {
    const f = fixture(), store = createMobileContentOwnerStore(f.options); store.load();
    const target = path.join(f.directory, 'owned-target'); writeFileSync(target, '合成原件', { mode: 0o600 });
    if (type === 'symbolic') symlinkSync(target, f.file); else linkSync(target, f.file);
    assert.throws(() => store.load(), outcome('not-sent')); assert.throws(() => store.save(f.request), outcome('not-sent'));
    assert.equal(readFileSync(target, 'utf8'), '合成原件');
  }
});

test('内容Owner存储：目录替身、权限和密文损坏均拒绝，不创建第二auth文件', () => {
  const f = fixture(), store = createMobileContentOwnerStore(f.options); store.save(f.request);
  const before = readFileSync(f.file); chmodSync(f.file, 0o644); assert.throws(() => store.load(), outcome('not-sent')); chmodSync(f.file, 0o600);
  const changedCommit = JSON.parse(before.toString('utf8')) as Record<string, MobileJsonValue>;
  changedCommit.commitId = randomUUID(); writeFileSync(f.file, mobileCanonicalJson(changedCommit) + '\n', { mode: 0o600 });
  // 即使外层 JSON 仍 canonical，commitId 也必须与认证密文内的同次提交一致。
  assert.throws(() => store.load(), outcome('not-sent'));
  const envelope = JSON.parse(before.toString('utf8')) as { sealed: string }; envelope.sealed = Buffer.alloc(28).toString('base64');
  writeFileSync(f.file, JSON.stringify(envelope), { mode: 0o600 }); assert.throws(() => store.load(), outcome('not-sent'));
  const g = fixture();
  symlinkSync(g.directory, path.join(g.directory, 'mobile-content')); assert.throws(() => createMobileContentOwnerStore(g.options).load(), outcome('not-sent'));
  assert.equal(lstatSync(f.directory).isDirectory(), true);
  assert.equal(existsSync(path.join(f.directory, 'mobile-devices')), false);
  assert.equal(existsSync(path.join(g.directory, 'mobile-devices')), false);
});
