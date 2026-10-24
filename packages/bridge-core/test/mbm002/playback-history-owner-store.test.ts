import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { createMobileSealedStateStore } from '../../src/mobile/sealed-state-store.js';
import { createMobilePlaybackHistoryOwnerStore, type PlaybackHistoryOwnerFaultPhase } from '../../src/mobile/playback-history-owner-store.js';
import { capturePlaybackState, playbackCanonical, PLAYBACK_STATE_SCHEMA, type PlaybackState } from '../../src/mobile/playback-state.js';
import { decodePlaybackStorage, encodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits } from '../../src/mobile/playback-types.js';
import { MobileAuthPersistenceError } from '../../src/mobile/types.js';
import { historyLookupKey, readPlaybackHistoryProof, updatePlaybackHistoryProof, verifyPlaybackHistoryProof } from '../../src/mobile/playback-history-index.js';
import { playbackHistoryHeadAad, playbackHistoryLocatorAad, playbackHistorySnapshotAad } from '../../src/mobile/playback-history-codec.js';
import { PLAYBACK_HISTORY_HEAD_SCHEMA, PLAYBACK_HISTORY_LOCATOR_SCHEMA, type PlaybackHistoryAuthenticatedHead,
  type PlaybackHistoryHeadToken, type PlaybackHistoryNodeRecord, type PlaybackHistoryNextHead,
  type PlaybackHistoryRequest, type PlaybackHistoryReply, type PlaybackHistoryRoot,
  type PlaybackHistorySealedLocator } from '../../src/mobile/playback-history-types.js';
import { encodeMobileSealedCoreRequest, encodeMobileSealedOwnerRequest, encodeMobileSealedOwnerReply,
  encodeMobileSealedCoreReply, attachMobileSealedCoreReceiver, attachMobileSealedOwnerReceiver,
  attachMobileSealedOwnerReplyReceiver, attachMobileSealedCoreReplyReceiver } from '../../src/mobile/sealed-request-transport.js';
import { captureMobileCorePrivateCall, captureDatasetOwnerRequest, captureMobileOwnerPrivateResult,
  captureMobileCorePrivateReply } from '../../src/mobile/owner-boundary-capture.js';

const SERVER = 'history.synthetic.server', DATASET = '60000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://127.0.0.1:43123', NOW = Date.parse('2026-10-23T00:00:00.000Z');
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Commit = Extract<PlaybackHistoryRequest, { op: 'commit' }>;
type Loaded = Extract<PlaybackHistoryReply, { kind: 'loaded' }>;
const scope = { serverId: SERVER, datasetId: DATASET };
function initialState(): PlaybackState {
  const session = { id: 'history.owner.session', deviceId: 'history.owner.device', deviceEpoch: 1,
    clientInstanceId: 'history.owner.private-client', createdAt: NOW - 1_000, expiresAt: NOW + 60_000,
    terminal: 'SESSION_CLOSED' as const, lastSequence: 0, playerGeneration: null,
    currentQueueItemId: null, currentResourceId: null, observation: null };
  const body = { clientInstanceId: session.clientInstanceId }, key = 'history.owner.private-original-key';
  const domain = (name: string, value: unknown) => digest(playbackCanonical(['MBM002_PLAYBACK_V1', SERVER, DATASET, name, value]));
  const scopeHash = domain('scope', [session.deviceId, 1, 'createSession', 'POST', '/mobile/v1/sessions']);
  return capturePlaybackState({ schema: PLAYBACK_STATE_SCHEMA, serverId: SERVER, datasetId: DATASET,
    revision: 1, commitId: randomUUID(), clockFloor: NOW, sessions: [session], resources: [], receipts: [{
      id: 'history.owner.receipt', operation: 'createSession', deviceId: session.deviceId, deviceEpoch: 1,
      keyHash: domain('key', [session.deviceId, 1, key]), fingerprint: domain('request', [scopeHash, body]), scopeHash,
      request: { path: '/mobile/v1/sessions', pathParameters: {}, query: {}, body, idempotencyKey: key },
      createdAt: session.createdAt, sessionId: session.id, resourceId: null, state: 'RECORDED',
      reply: { status: 201, body: { id: session.id, deviceId: session.deviceId,
        createdAt: new Date(session.createdAt).toISOString(), expiresAt: new Date(session.expiresAt).toISOString() } }, resourceContext: null,
    }] }, SERVER, DATASET, ORIGIN, limits);
}
function fixture(t: TestContext, seed = true) {
  const directory = mkdtempSync(path.join(tmpdir(), 'musicbridge-history-owner-'));
  if (process.platform === 'darwin') assert.ok(directory.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'));
  const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1)), crypto = createMobileAuthCrypto(key); key.fill(0);
  const legacy = createMobileSealedStateStore({ directory, datasetId: DATASET, namespace: 'playback', assertCurrent() {} });
  const original = initialState();
  if (seed) {
    const encoded = encodePlaybackStorage(original, SERVER, DATASET, ORIGIN, limits);
    const sealed = crypto.seal(encoded.bytes, playbackHistorySnapshotAad(SERVER, DATASET, original.revision)); encoded.bytes.fill(0);
    legacy.save({ datasetId: DATASET, expectedRevision: 0, commitId: original.commitId!, sealed }); sealed.fill(0);
  }
  const legacyFile = path.join(directory, 'mobile-devices/playback-state.v1.sealed.json');
  const originalBytes = seed ? new Uint8Array(readFileSync(legacyFile)) : null;
  let owner: ReturnType<typeof createMobilePlaybackHistoryOwnerStore> | undefined;
  let armed: PlaybackHistoryOwnerFaultPhase | undefined;
  const store = () => owner ??= createMobilePlaybackHistoryOwnerStore({ directory, datasetId: DATASET, assertCurrent() {},
    fault(phase) { if (phase === armed) { armed = undefined; throw new Error('合成Owner故障。'); } } });
  const close = () => { owner?.close(); owner = undefined; }; t.after(close);
  const load = (): Loaded => { const value = store().dispatch({ op: 'load', ...scope }); assert.equal(value.kind, 'loaded');
    if (value.kind !== 'loaded') throw new Error('缺少Owner头。'); return value; };
  return { directory, legacyFile, database: path.join(directory, 'mobile-devices/playback-history.v1.sqlite'),
    crypto, legacy, original, originalBytes, legacySha: originalBytes ? digest(originalBytes) : null,
    store, load, close, arm(phase: PlaybackHistoryOwnerFaultPhase) { armed = phase; } };
}
function head(f: ReturnType<typeof fixture>, expected: PlaybackHistoryHeadToken, state: PlaybackState,
  root: PlaybackHistoryRoot, storeId = expected.storeId ?? randomUUID()): PlaybackHistoryNextHead {
  const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  const sealed = f.crypto.seal(encoded.bytes, playbackHistorySnapshotAad(SERVER, DATASET, state.revision)); encoded.bytes.fill(0);
  const token: PlaybackHistoryHeadToken = { authority: 'journal', storeId, revision: state.revision, commitId: state.commitId,
    hotSha256: digest(sealed), headSha256: null, indexRoot: root };
  const raw: PlaybackHistoryAuthenticatedHead = { schema: PLAYBACK_HISTORY_HEAD_SCHEMA, ...scope, storeId,
    revision: state.revision, commitId: state.commitId, hotSha256: token.hotSha256!, indexRoot: root, legacyFileSha256: f.legacySha };
  const sealedHead = f.crypto.seal(Buffer.from(playbackCanonical(raw)), playbackHistoryHeadAad(SERVER, DATASET, token));
  return { token: { ...token, headSha256: digest(sealedHead) }, sealedHead, hot: { kind: 'sealed', sealed } };
}
function activation(f: ReturnType<typeof fixture>): Commit {
  const loaded = f.load(); assert.equal(loaded.token.authority, 'legacy');
  const state: PlaybackState = loaded.hot.kind === 'missing'
    ? { schema: PLAYBACK_STATE_SCHEMA, serverId: SERVER, datasetId: DATASET, revision: 0, commitId: null, clockFloor: 0,
      sessions: [], resources: [], receipts: [] } : f.original;
  const next = head(f, loaded.token, state, null);
  if (loaded.hot.kind === 'sealed') {
    // 激活必须直接复用原已ACK密文，而不是重seal碰巧相同的明文。
    const token = { ...next.token, hotSha256: digest(loaded.hot.sealed) };
    const raw = { schema: PLAYBACK_HISTORY_HEAD_SCHEMA, ...scope, storeId: token.storeId!, revision: token.revision,
      commitId: token.commitId, hotSha256: token.hotSha256, indexRoot: null, legacyFileSha256: f.legacySha };
    const sealedHead = f.crypto.seal(Buffer.from(playbackCanonical(raw)), playbackHistoryHeadAad(SERVER, DATASET, token));
    return { op: 'commit', ...scope, expected: loaded.token, attemptId: randomUUID(), mode: 'activate', archiveCurrent: null,
      next: { token: { ...token, headSha256: digest(sealedHead) }, sealedHead, hot: { kind: 'reuse-current' } } };
  }
  return { op: 'commit', ...scope, expected: loaded.token, attemptId: randomUUID(), mode: 'activate', archiveCurrent: null, next };
}
function activate(f: ReturnType<typeof fixture>): Commit {
  const request = activation(f), result = f.store().dispatch(request); assert.equal(result.kind, 'committed');
  assert.deepEqual(result.token, request.next.token); return request;
}
function archiveAttempt(f: ReturnType<typeof fixture>) {
  const loaded = f.load(), expected = loaded.token; assert.equal(expected.authority, 'journal'); assert.equal(loaded.hot.kind, 'sealed');
  const archiveId = randomUUID(), snapshot = { revision: expected.revision, commitId: expected.commitId!, hotSha256: expected.hotSha256! };
  const receipt = f.original.receipts[0]!, session = f.original.sessions[0]!;
  const rows = [{ kind: 'receipt' as const, identity: { deviceId: receipt.deviceId, deviceEpoch: receipt.deviceEpoch, keyHash: receipt.keyHash }, recordId: receipt.id },
    { kind: 'session' as const, identity: { id: session.id }, recordId: session.id }];
  const locators: PlaybackHistorySealedLocator[] = [], nodes = new Map<string, PlaybackHistoryNodeRecord>();
  let root = expected.indexRoot;
  for (const row of rows) {
    const key = historyLookupKey(row.kind, SERVER, DATASET, row.identity);
    const raw = { schema: PLAYBACK_HISTORY_LOCATOR_SCHEMA, ...scope, kind: row.kind, key, archiveId, snapshot, sessionId: session.id, recordId: row.recordId };
    const sealed = f.crypto.seal(Buffer.from(playbackCanonical(raw)), playbackHistoryLocatorAad(SERVER, DATASET, key));
    const locator = { valueHash: digest(sealed), archiveId, sealed }; locators.push(locator);
    const proof = readPlaybackHistoryProof(root, key, hash => nodes.get(hash));
    const update = updatePlaybackHistoryProof(root, key, locator.valueHash, proof);
    for (const record of update.nodes) nodes.set(record.hash, record); root = update.root;
  }
  const state: PlaybackState = { ...f.original, revision: expected.revision + 1, commitId: randomUUID(), sessions: [], resources: [], receipts: [] };
  const attemptId = randomUUID(), next = head(f, expected, state, root);
  const commit: Commit = { op: 'commit', ...scope, expected, attemptId, mode: 'advance', next,
    archiveCurrent: { id: archiveId, snapshot, sessionIds: [session.id] } };
  const stage: PlaybackHistoryRequest = { op: 'stage', ...scope, expected, attemptId, nodes: [...nodes.values()], locators };
  return { loaded, commit, stage, key: historyLookupKey('receipt', SERVER, DATASET,
    { deviceId: receipt.deviceId, deviceEpoch: receipt.deviceEpoch, keyHash: receipt.keyHash }), archiveId };
}
function readCommit(request: Commit): Extract<PlaybackHistoryRequest, { op: 'read-commit' }> {
  return { op: 'read-commit', ...scope, expected: request.expected, attemptId: request.attemptId, next: request.next.token };
}
function databaseCounts(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Object.fromEntries(['current_head', 'archives', 'nodes', 'locators', 'commits'].map(table =>
    [table, Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n)])); }
  finally { db.close(); }
}
const CHILD = `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(readFileSync(0, 'utf8'), (_key, value) =>
  value && typeof value === 'object' && Object.keys(value).join(',') === 'syntheticBytes'
    ? new Uint8Array(Buffer.from(value.syntheticBytes, 'base64')) : value);
const { createMobilePlaybackHistoryOwnerStore } = await import(pathToFileURL(process.env.MUSIC_BRIDGE_HISTORY_OWNER_TEST_ENTRY));
const owner = createMobilePlaybackHistoryOwnerStore({directory: input.directory, datasetId: input.datasetId,
  fault(phase) { if (phase === input.phase) process.exit(86); }});
owner.dispatch(input.request); owner.close();
throw Error('合成退出点未触发。');
`;
function crash(f: ReturnType<typeof fixture>, phase: PlaybackHistoryOwnerFaultPhase, request: PlaybackHistoryRequest): void {
  const entry = process.env.MUSIC_BRIDGE_HISTORY_OWNER_TEST_ENTRY
    ?? fileURLToPath(new URL('../../src/mobile/playback-history-owner-store.ts', import.meta.url));
  const input = JSON.stringify({ directory: f.directory, datasetId: DATASET, phase, request }, (_key, value) =>
    value instanceof Uint8Array ? { syntheticBytes: Buffer.from(value).toString('base64') } : value);
  const run = spawnSync(process.execPath, [...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []), '--input-type=module', '--eval', CHILD],
    { cwd: process.cwd(), env: { ...process.env, MUSIC_BRIDGE_HISTORY_OWNER_TEST_ENTRY: entry }, input, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.error, undefined); assert.equal(run.signal, null); assert.equal(run.status, 86, run.stderr);
}

function persistence(outcome: 'not-sent' | 'unknown') {
  return (error: unknown) => error instanceof MobileAuthPersistenceError && error.outcome === outcome;
}
function mutateDatabase(file: string, work: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(file); try { work(db); } finally { db.close(); }
}
function assertOriginalBackup(f: ReturnType<typeof fixture>): void {
  assert.ok(f.originalBytes && f.legacySha);
  const backups = readdirSync(path.dirname(f.legacyFile)).filter(name => name.startsWith('playback-state.v1.legacy-'));
  assert.deepEqual(backups, [`playback-state.v1.legacy-${f.legacySha}.sealed.json`]);
  assert.deepEqual(new Uint8Array(readFileSync(path.join(path.dirname(f.legacyFile), backups[0]!))), f.originalBytes);
}

test('HISTORY_OWNER stage不出版；原hot密文、索引与新head同事务提交，冷读保全原回执', t => {
  const f = fixture(t); activate(f); const attempt = archiveAttempt(f);
  assert.equal(f.store().dispatch(attempt.stage).kind, 'staged');
  const hidden = f.store().dispatch({ op: 'lookup', ...scope, expected: attempt.loaded.token, key: attempt.key });
  assert.equal(hidden.kind, 'proof'); assert.ok(hidden.kind === 'proof');
  assert.deepEqual(verifyPlaybackHistoryProof(attempt.loaded.token.indexRoot, attempt.key, hidden.proof), { kind: 'absent' });
  assert.equal(hidden.locator, null); assert.equal(hidden.archive, null);
  assert.equal(databaseCounts(f.database).archives, 0);
  assert.equal(f.store().dispatch(attempt.commit).kind, 'committed'); f.close();
  const current = f.load(); assert.deepEqual(current.token, attempt.commit.next.token);
  assert.ok(current.hot.kind === 'sealed' && current.sealedHead);
  const authenticated = JSON.parse(Buffer.from(f.crypto.open(current.sealedHead,
    playbackHistoryHeadAad(SERVER, DATASET, current.token))).toString('utf8'));
  assert.equal(authenticated.storeId, current.token.storeId); assert.equal(authenticated.hotSha256, digest(current.hot.sealed));
  assert.equal(authenticated.indexRoot, current.token.indexRoot); assert.equal(authenticated.revision, current.token.revision);
  const found = f.store().dispatch({ op: 'lookup', ...scope, expected: current.token, key: attempt.key });
  assert.ok(found.kind === 'proof' && found.locator && found.archive);
  assert.deepEqual(verifyPlaybackHistoryProof(current.token.indexRoot, attempt.key, found.proof),
    { kind: 'present', valueHash: found.locator.valueHash });
  assert.equal(found.locator.valueHash, digest(found.locator.sealed));
  assert.ok(attempt.loaded.hot.kind === 'sealed'); assert.deepEqual(found.archive.sealed, attempt.loaded.hot.sealed);
  const decoded = decodePlaybackStorage(f.crypto.open(found.archive.sealed,
    playbackHistorySnapshotAad(SERVER, DATASET, found.archive.snapshot.revision)), SERVER, DATASET, ORIGIN, limits);
  assert.deepEqual(decoded.state, f.original);
  assert.deepEqual(f.store().dispatch(readCommit(attempt.commit)),
    { kind: 'committed', token: attempt.commit.next.token, attemptId: attempt.commit.attemptId });
  assert.throws(() => f.legacy.load(DATASET), persistence('not-sent')); assertOriginalBackup(f);
  for (const name of readdirSync(path.dirname(f.database)).filter(value => value.startsWith('playback-history.v1.sqlite'))) {
    const bytes = readFileSync(path.join(path.dirname(f.database), name));
    assert.equal(bytes.includes(Buffer.from('history.owner.private-original-key')), false);
    assert.equal(bytes.includes(Buffer.from('history.owner.private-client')), false);
  }
});

test('HISTORY_OWNER advance原子故障：未提交可确认not-sent，已提交丢ACK只能原attempt对账', async t => {
  for (const phase of ['beforeCommit', 'afterCommit'] as const) await t.test(phase, sub => {
    const f = fixture(sub); activate(f); const attempt = archiveAttempt(f); f.store().dispatch(attempt.stage);
    f.arm(phase); assert.throws(() => f.store().dispatch(attempt.commit), persistence(phase === 'beforeCommit' ? 'not-sent' : 'unknown'));
    f.close(); const loaded = f.load();
    if (phase === 'beforeCommit') {
      assert.deepEqual(loaded.token, attempt.loaded.token); assert.equal(databaseCounts(f.database).archives, 0);
      assert.equal(databaseCounts(f.database).nodes, 0); assert.equal(databaseCounts(f.database).locators, 0);
      assert.deepEqual(f.store().dispatch(readCommit(attempt.commit)),
        { kind: 'unconfirmed', token: attempt.loaded.token, attemptId: attempt.commit.attemptId });
    } else {
      assert.deepEqual(loaded.token, attempt.commit.next.token); assert.equal(databaseCounts(f.database).archives, 1);
      assert.deepEqual(f.store().dispatch(readCommit(attempt.commit)),
        { kind: 'committed', token: attempt.commit.next.token, attemptId: attempt.commit.attemptId });
      assert.throws(() => f.store().dispatch({ ...readCommit(attempt.commit), next: attempt.loaded.token }), persistence('not-sent'));
    }
  });
});

test('HISTORY_OWNER 激活真实进程退出：备份、marker、COMMIT各边界只恢复原attempt', async t => {
  for (const phase of ['afterBackup', 'beforeMarker', 'afterMarker', 'afterCommit'] as const) await t.test(phase, sub => {
    const f = fixture(sub), request = activation(f); f.close(); crash(f, phase, request);
    const beforeMarker = phase === 'afterBackup' || phase === 'beforeMarker';
    if (beforeMarker) {
      assert.equal(f.legacy.load(DATASET).revision, f.original.revision);
      assert.equal(digest(readFileSync(f.legacyFile)), f.legacySha); assert.equal(databaseCounts(f.database).current_head, 0);
    } else assert.throws(() => f.legacy.load(DATASET), persistence('not-sent'));
    const loaded = f.load(); assert.deepEqual(loaded.token, request.next.token);
    assert.deepEqual(f.store().dispatch(readCommit(request)), { kind: 'committed', token: request.next.token, attemptId: request.attemptId });
    assertOriginalBackup(f); assert.throws(() => f.legacy.load(DATASET), persistence('not-sent'));
    const marker = JSON.parse(readFileSync(f.legacyFile, 'utf8'));
    assert.equal(marker.attemptId, request.attemptId); assert.equal(marker.storeId, request.next.token.storeId);
    assert.equal(marker.legacyFileSha256, f.legacySha); assert.deepEqual(marker.expected, request.expected);
  });
});

test('HISTORY_OWNER marker前旧作者合法推进：原pending激活冲突，绝不覆盖新legacy或旧备份', t => {
  const f = fixture(t), request = activation(f); f.close(); crash(f, 'beforeMarker', request);
  const advanced = { ...f.original, revision: f.original.revision + 1, commitId: randomUUID(), clockFloor: NOW + 1 };
  const bytes = encodePlaybackStorage(advanced, SERVER, DATASET, ORIGIN, limits).bytes;
  const sealed = f.crypto.seal(bytes, playbackHistorySnapshotAad(SERVER, DATASET, advanced.revision)); bytes.fill(0);
  assert.equal(f.legacy.save({ datasetId: DATASET, expectedRevision: f.original.revision, commitId: advanced.commitId!, sealed }).kind, 'saved'); sealed.fill(0);
  const newer = new Uint8Array(readFileSync(f.legacyFile)), loaded = f.load();
  assert.equal(loaded.token.authority, 'legacy'); assert.equal(loaded.token.revision, advanced.revision);
  assert.equal(f.store().dispatch(readCommit(request)).kind, 'conflict');
  assert.equal(f.store().dispatch(request).kind, 'conflict'); assert.deepEqual(new Uint8Array(readFileSync(f.legacyFile)), newer);
  assert.equal(databaseCounts(f.database).current_head, 0); assertOriginalBackup(f);
});

test('HISTORY_OWNER 首次schema真实崩溃重开：空库可恢复且identity与DDL一起提交', async t => {
  for (const phase of ['afterDatabaseCreate', 'beforeSchemaCommit'] as const) await t.test(phase, sub => {
    const f = fixture(sub); crash(f, phase, { op: 'load', ...scope });
    const loaded = f.load(); assert.equal(loaded.token.authority, 'legacy'); assert.equal(loaded.token.revision, 1);
    assert.deepEqual(new Uint8Array(readFileSync(f.legacyFile)), f.originalBytes); assert.equal(databaseCounts(f.database).current_head, 0);
    f.close(); const db = new DatabaseSync(f.database, { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) n FROM identity').get()!.n, 1); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1); }
    finally { db.close(); }
  });
});

test('HISTORY_OWNER 未知非空schema、未知版本、已v1缺identity均不得伪装首次空库', async t => {
  for (const mode of ['foreign-schema', 'foreign-version', 'missing-identity'] as const) await t.test(mode, sub => {
    const f = fixture(sub);
    if (mode === 'missing-identity') { f.load(); f.close(); mutateDatabase(f.database, db => db.exec('DELETE FROM identity')); }
    else {
      mutateDatabase(f.database, db => db.exec(mode === 'foreign-schema' ? 'CREATE TABLE foreign_state(x TEXT)' : 'PRAGMA user_version=99'));
      chmodSync(f.database, 0o600);
    }
    assert.throws(f.load, persistence('not-sent')); f.close();
    assert.deepEqual(new Uint8Array(readFileSync(f.legacyFile)), f.originalBytes);
    assert.equal(f.legacy.load(DATASET).revision, 1);
    const db = new DatabaseSync(f.database, { readOnly: true });
    try {
      if (mode === 'foreign-schema') assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['foreign_state']);
      if (mode === 'foreign-version') assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 99);
      if (mode === 'missing-identity') assert.equal(db.prepare('SELECT COUNT(*) n FROM identity').get()!.n, 0);
    } finally { db.close(); }
  });
});

test('HISTORY_OWNER 已归档节点、locator、archive、hot或store身份缺失损坏均失败关闭而非负查', async t => {
  for (const mode of ['node', 'locator', 'archive', 'archive-cipher', 'hot', 'instance'] as const) await t.test(mode, sub => {
    const f = fixture(sub); activate(f); const attempt = archiveAttempt(f); f.store().dispatch(attempt.stage); f.store().dispatch(attempt.commit);
    const marker = readFileSync(f.legacyFile); f.close();
    mutateDatabase(f.database, db => {
      if (mode === 'node') db.prepare('DELETE FROM nodes WHERE hash=?').run(attempt.commit.next.token.indexRoot!);
      if (mode === 'locator') db.exec('DELETE FROM locators');
      if (mode === 'archive') { db.exec('PRAGMA foreign_keys=OFF'); db.exec('DELETE FROM archives'); }
      if (mode === 'archive-cipher') db.exec("UPDATE archives SET sealed=X'010203'");
      if (mode === 'hot') db.exec("UPDATE current_head SET hot=X'010203'");
      if (mode === 'instance') db.prepare('UPDATE identity SET instance_id=?').run(randomUUID());
    });
    assert.throws(() => f.store().dispatch({ op: 'lookup', ...scope, expected: attempt.commit.next.token, key: attempt.key }), persistence('not-sent'));
    assert.deepEqual(readFileSync(f.legacyFile), marker); assert.throws(() => f.legacy.load(DATASET), persistence('not-sent'));
  });
});

test('HISTORY_OWNER scope、旧CAS、stage硬上限与不可变attempt继续拒绝', t => {
  const f = fixture(t); const activationRequest = activate(f), attempt = archiveAttempt(f);
  for (const foreign of [{ ...scope, serverId: 'history.foreign.server' }, { ...scope, datasetId: 'history.foreign.dataset' }])
    assert.throws(() => f.store().dispatch({ op: 'load', ...foreign }), persistence('not-sent'));
  assert.equal(f.store().dispatch({ op: 'lookup', ...scope, expected: activationRequest.expected, key: attempt.key }).kind, 'conflict');
  assert.ok(attempt.stage.op === 'stage');
  assert.throws(() => f.store().dispatch({ ...attempt.stage, nodes: Array.from({ length: 257 }, () => attempt.stage.op === 'stage' ? attempt.stage.nodes[0]! : null) } as unknown as PlaybackHistoryRequest), persistence('not-sent'));
  assert.throws(() => f.store().dispatch({ ...attempt.stage, locators: Array.from({ length: 65 }, () => attempt.stage.op === 'stage' ? attempt.stage.locators[0]! : null) } as unknown as PlaybackHistoryRequest), persistence('not-sent'));
  assert.throws(() => f.store().dispatch({ ...attempt.stage, fault: () => undefined } as PlaybackHistoryRequest), persistence('not-sent'));
  f.store().dispatch(attempt.stage); f.store().dispatch(attempt.commit);
  const changed = { ...attempt.commit, next: { ...attempt.commit.next, token: { ...attempt.commit.next.token, commitId: randomUUID() } } };
  assert.throws(() => f.store().dispatch(changed), persistence('not-sent'));
  assert.equal(f.store().dispatch(readCommit(attempt.commit)).kind, 'committed');
});

async function binaryRoundtrip(f: ReturnType<typeof fixture>, request: PlaybackHistoryRequest): Promise<PlaybackHistoryReply> {
  const rawCall = { type: 'mobile-main-request', id: randomUUID(), request: { kind: 'playback-history', datasetId: DATASET, request } };
  const outgoing = encodeMobileSealedCoreRequest(rawCall), core = new EventEmitter();
  let captured!: ReturnType<typeof captureMobileCorePrivateCall>;
  attachMobileSealedCoreReceiver({ on(_event, receive) { core.on('message', receive); } }, value => { captured = captureMobileCorePrivateCall(value.data); });
  core.emit('message', { data: outgoing }); assert.ok(captured); const call = captured;
  assert.equal(call.request.kind, 'playback-history');
  const envelope = { version: 1, type: 'request', epoch: randomUUID(), requestId: randomUUID(), sequence: 1,
    operation: 'mobileMain', expectedDatasetId: DATASET, mobile: call.request };
  const channel = new MessageChannel();
  try {
    const received = new Promise<PlaybackHistoryReply>((resolve, reject) => {
      attachMobileSealedOwnerReceiver(channel.port2, raw => {
        try {
          const owned = captureDatasetOwnerRequest(raw); assert.ok(owned?.mobile?.kind === 'playback-history');
          const result = f.store().dispatch(owned.mobile.request);
          channel.port2.postMessage(encodeMobileSealedOwnerReply({ version: 1, type: 'response', epoch: envelope.epoch,
            requestId: envelope.requestId, operation: 'mobileMain', ok: true, result }, owned.mobile));
        } catch (error) { reject(error); }
      });
      attachMobileSealedOwnerReplyReceiver(channel.port1, raw => {
        try {
          assert.ok(raw && typeof raw === 'object' && 'result' in raw);
          const ownerReply = captureMobileOwnerPrivateResult(raw.result, call.request); assert.ok(ownerReply);
          const encoded = encodeMobileSealedCoreReply({ type: 'mobile-main-response', id: call.id, result: ownerReply }, call);
          const replies = new EventEmitter(); let result!: ReturnType<typeof captureMobileCorePrivateReply>;
          attachMobileSealedCoreReplyReceiver({ on(_event, receive) { replies.on('message', receive); } }, value => { result = captureMobileCorePrivateReply(value.data, call); });
          replies.emit('message', { data: encoded }); assert.ok(result && 'kind' in result.result);
          assert.ok(['loaded', 'proof', 'staged', 'committed', 'unconfirmed', 'conflict'].includes(result.result.kind));
          resolve(result.result as PlaybackHistoryReply);
        } catch (error) { reject(error); }
      });
    });
    channel.port1.postMessage(encodeMobileSealedOwnerRequest(envelope)); return await received;
  } finally { channel.port1.close(); channel.port2.close(); }
}

test('HISTORY_OWNER 原Core与Owner正式私有二进制边界逐份传输stage/commit/load/proof多密文', async t => {
  const f = fixture(t), activationRequest = activation(f);
  assert.equal((await binaryRoundtrip(f, activationRequest)).kind, 'committed');
  const loaded = await binaryRoundtrip(f, { op: 'load', ...scope }); assert.ok(loaded.kind === 'loaded' && loaded.hot.kind === 'sealed');
  assert.ok(loaded.sealedHead); assert.deepEqual(loaded.token, activationRequest.next.token);
  assert.ok(activationRequest.next.hot.kind === 'reuse-current');
  const attempt = archiveAttempt(f); assert.ok(attempt.stage.op === 'stage');
  assert.equal(attempt.stage.locators.length, 2); assert.equal((await binaryRoundtrip(f, attempt.stage)).kind, 'staged');
  assert.equal((await binaryRoundtrip(f, attempt.commit)).kind, 'committed');
  const found = await binaryRoundtrip(f, { op: 'lookup', ...scope, expected: attempt.commit.next.token, key: attempt.key });
  assert.ok(found.kind === 'proof' && found.archive && found.locator);
  assert.ok(attempt.loaded.hot.kind === 'sealed'); assert.deepEqual(found.archive.sealed, attempt.loaded.hot.sealed);
  const decoded = decodePlaybackStorage(f.crypto.open(found.archive.sealed,
    playbackHistorySnapshotAad(SERVER, DATASET, found.archive.snapshot.revision)), SERVER, DATASET, ORIGIN, limits);
  assert.deepEqual(decoded.state, f.original);
  found.archive.sealed.fill(0); found.locator.sealed.fill(0);
  const fresh = await binaryRoundtrip(f, { op: 'lookup', ...scope, expected: attempt.commit.next.token, key: attempt.key });
  assert.ok(fresh.kind === 'proof' && fresh.archive && fresh.locator); assert.equal(digest(fresh.archive.sealed), attempt.loaded.token.hotSha256);
  assert.equal(digest(fresh.locator.sealed), fresh.locator.valueHash);
});
