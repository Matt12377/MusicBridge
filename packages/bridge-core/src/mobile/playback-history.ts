import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { MobileAuthCrypto, MobileAuthPersistence, MobileSealedSave, MobileSealedState } from './types.js';
import { MobileAuthPersistenceError } from './types.js';
import { playbackCanonical, playbackFailure, type PlaybackState } from './playback-state.js';
import type { MobilePlaybackLimits, MobilePlaybackStateCodecContext, MobilePlaybackStateCodecPort } from './playback-types.js';
import { MobilePlaybackError } from './playback-types.js';
import { capturePlaybackHistoryRequest, capturePlaybackHistoryReply, samePlaybackHistoryToken } from './playback-history-protocol.js';
import { historyLookupKey, readPlaybackHistoryProof, updatePlaybackHistoryProof, verifyPlaybackHistoryProof } from './playback-history-index.js';
import { capturePlaybackHistoryGroup, capturePlaybackHistoryHead, capturePlaybackHistoryLocator, copyPlaybackHistoryBytes,
  decodePlaybackHistoryGroup, parsePlaybackHistorySmallJson, playbackHistoryHeadAad, playbackHistoryLocatorAad,
  playbackHistorySnapshotAad } from './playback-history-codec.js';
import { PLAYBACK_HISTORY_HEAD_SCHEMA, PLAYBACK_HISTORY_LOCATOR_SCHEMA, PLAYBACK_HISTORY_MAX_STAGE_BYTES, PLAYBACK_HISTORY_MAX_STAGE_LOCATORS,
  PLAYBACK_HISTORY_MAX_STAGE_NODES, type MobilePlaybackHistoryPort, type PlaybackHistoryArchiveCurrent,
  type PlaybackHistoryAuthenticatedHead, type PlaybackHistoryAuthenticatedLocator, type PlaybackHistoryHeadToken,
  type PlaybackHistoryNextHead, type PlaybackHistoryNodeRecord, type PlaybackHistoryRecordKind,
  type PlaybackHistoryRequest, type PlaybackHistorySealedLocator } from './playback-history-types.js';

const bad = (): never => playbackFailure(503, 'BUSY');
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value: unknown): Uint8Array => Buffer.from(playbackCanonical(value));
interface Proposal {
  request: Extract<PlaybackHistoryRequest, { op: 'commit' }>;
  head: PlaybackHistoryAuthenticatedHead;
}
interface ArchivePlan {
  expected: PlaybackHistoryHeadToken; attemptId: string; root: string | null;
  archive: PlaybackHistoryArchiveCurrent; nodes: PlaybackHistoryNodeRecord[]; locators: PlaybackHistorySealedLocator[];
}
export interface PlaybackHistorySelection { locator: PlaybackHistoryAuthenticatedLocator; group: PlaybackState }

/** 原Main仍持Cipher；Owner只点取密文/认证索引，不在每次操作加载全部历史。 */
export function createPlaybackHistoryPersistence(options: {
  serverId: string; datasetId: string; responseOrigin: string; limits: Readonly<MobilePlaybackLimits>;
  port: MobilePlaybackHistoryPort; crypto: MobileAuthCrypto; codec?: MobilePlaybackStateCodecPort;
  context(revision: number, commitId: string | null): MobilePlaybackStateCodecContext;
  current(): void;
}) {
  const { serverId, datasetId, limits, crypto } = options;
  let token: PlaybackHistoryHeadToken | undefined, head: PlaybackHistoryAuthenticatedHead | undefined;
  let legacyFileSha256: string | null = null, proposal: Proposal | undefined, plan: ArchivePlan | undefined;
  const scope = { serverId, datasetId };
  async function exchange(raw: PlaybackHistoryRequest) {
    options.current();
    const request = capturePlaybackHistoryRequest(raw);
    const reply = capturePlaybackHistoryReply(await options.port.dispatch(request), request);
    options.current(); return reply;
  }
  function active(): PlaybackHistoryHeadToken {
    if (!token || token.authority !== 'journal' || !head || proposal) return bad();
    return token;
  }
  function sealHead(value: PlaybackHistoryAuthenticatedHead): { head: PlaybackHistoryAuthenticatedHead; next: PlaybackHistoryHeadToken; sealed: Uint8Array } {
    const captured = capturePlaybackHistoryHead(value);
    const provisional: PlaybackHistoryHeadToken = { authority: 'journal', storeId: captured.storeId,
      revision: captured.revision, commitId: captured.commitId, hotSha256: captured.hotSha256,
      headSha256: null, indexRoot: captured.indexRoot };
    const plain = jsonBytes(captured);
    try {
      const sealed = copyPlaybackHistoryBytes(crypto.seal(plain, playbackHistoryHeadAad(serverId, datasetId, provisional)), limits.sealedBytes);
      return { head: captured, next: { ...provisional, headSha256: sha(sealed) }, sealed };
    } finally { plain.fill(0); }
  }
  function openHead(value: Extract<Awaited<ReturnType<typeof exchange>>, { kind: 'loaded' }>): PlaybackHistoryAuthenticatedHead {
    if (value.token.authority !== 'journal' || !value.sealedHead || value.hot.kind !== 'sealed'
      || sha(value.sealedHead) !== value.token.headSha256 || sha(value.hot.sealed) !== value.token.hotSha256) return bad();
    const plain = copyPlaybackHistoryBytes(crypto.open(value.sealedHead, playbackHistoryHeadAad(serverId, datasetId, value.token)), 16 * 1024);
    try {
      const result = capturePlaybackHistoryHead(parsePlaybackHistorySmallJson(plain));
      if (result.serverId !== serverId || result.datasetId !== datasetId || result.storeId !== value.token.storeId
        || result.revision !== value.token.revision || result.commitId !== value.token.commitId
        || result.hotSha256 !== value.token.hotSha256 || result.indexRoot !== value.token.indexRoot
        || result.legacyFileSha256 !== value.legacyFileSha256) return bad();
      return result;
    } finally { plain.fill(0); }
  }
  async function resolveProposal(): Promise<void> {
    if (!proposal) return;
    const selected = proposal;
    const reply = await exchange({ ...scope, op: 'read-commit', expected: selected.request.expected,
      attemptId: selected.request.attemptId, next: selected.request.next.token });
    if (reply.kind !== 'committed' || !samePlaybackHistoryToken(reply.token, selected.request.next.token))
      throw new MobileAuthPersistenceError('unknown');
    // 原attempt只读确认后，仍须load并开认证头，不以callback成功替代真实持久结果。
  }
  const persistence: MobileAuthPersistence = {
    async load(requestDatasetId): Promise<MobileSealedState> {
      if (requestDatasetId !== datasetId) return bad();
      await resolveProposal();
      const result = await exchange({ ...scope, op: 'load' });
      if (result.kind !== 'loaded') return bad();
      if (proposal && !samePlaybackHistoryToken(result.token, proposal.request.next.token))
        throw new MobileAuthPersistenceError('unknown');
      if (result.token.authority === 'journal') head = openHead(result);
      else {
        if (head || result.sealedHead !== null || result.token.storeId !== null || result.token.headSha256 !== null
          || result.token.indexRoot !== null || result.hot.kind === 'sealed' && sha(result.hot.sealed) !== result.token.hotSha256)
          return bad();
      }
      token = result.token; legacyFileSha256 = result.legacyFileSha256;
      if (proposal) { proposal = undefined; plan = undefined; }
      if (result.hot.kind === 'sealed' && result.hot.revision === 0) {
        // 仅新journal允许已认证的revision0；原Core空state语义保持原样。
        if (result.token.authority !== 'journal' || result.hot.commitId !== null) return bad();
        const plain = copyPlaybackHistoryBytes(crypto.open(result.hot.sealed, playbackHistorySnapshotAad(serverId, datasetId, 0)), limits.stateBytes);
        try {
          const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)) as unknown;
          if (playbackCanonical(parsed) !== playbackCanonical({ schema: 'musicbridge.mobile002.playback-state.v1',
            serverId, datasetId, revision: 0, commitId: null, clockFloor: 0, sessions: [], resources: [], receipts: [] })) return bad();
        } finally { plain.fill(0); result.hot.sealed.fill(0); }
        return { kind: 'missing', datasetId, revision: 0 };
      }
      if (result.hot.kind === 'sealed' && result.hot.commitId === null) return bad();
      return result.hot as MobileSealedState;
    },
    async save(request: MobileSealedSave) {
      const previous = active();
      if (request.datasetId !== datasetId || request.expectedRevision !== previous.revision) return bad();
      const selected = plan;
      if (selected && !samePlaybackHistoryToken(selected.expected, previous)) return bad();
      const sealed = copyPlaybackHistoryBytes(request.sealed, limits.sealedBytes);
      const prepared = sealHead({ schema: PLAYBACK_HISTORY_HEAD_SCHEMA, ...scope, storeId: head!.storeId,
        revision: request.expectedRevision + 1, commitId: request.commitId, hotSha256: sha(sealed),
        indexRoot: selected?.root ?? previous.indexRoot, legacyFileSha256 });
      const next: PlaybackHistoryNextHead = { token: prepared.next, sealedHead: prepared.sealed, hot: { kind: 'sealed', sealed } };
      const commit: Extract<PlaybackHistoryRequest, { op: 'commit' }> = { ...scope, op: 'commit', expected: previous,
        attemptId: selected?.attemptId ?? request.commitId, mode: 'advance', next, archiveCurrent: selected?.archive ?? null };
      proposal = { request: commit, head: prepared.head };
      try {
        const result = await exchange(commit);
        if (result.kind === 'conflict') { proposal = undefined; plan = undefined;
          return { kind: 'conflict' as const, datasetId, currentRevision: result.token.revision }; }
        if (result.kind !== 'committed' || !samePlaybackHistoryToken(result.token, next.token)) throw new MobileAuthPersistenceError('unknown');
        token = result.token; head = prepared.head; proposal = undefined; plan = undefined;
        return { kind: 'saved' as const, datasetId, revision: result.token.revision, commitId: request.commitId };
      } catch (error) {
        if (error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent') { proposal = undefined; plan = undefined; }
        throw error;
      } finally { sealed.fill(0); prepared.sealed.fill(0); }
    },
  };
  async function ensureActivated(canonical: string): Promise<void> {
    options.current();
    if (!token || proposal) return bad();
    if (token.authority === 'journal') return;
    const previous = token;
    let initial: Uint8Array | undefined;
    if (previous.hotSha256 === null) {
      if (previous.revision !== 0 || previous.commitId !== null) return bad();
      const plain = Buffer.from(canonical);
      try { initial = copyPlaybackHistoryBytes(crypto.seal(plain, playbackHistorySnapshotAad(serverId, datasetId, 0)), limits.sealedBytes); }
      finally { plain.fill(0); }
    }
    const prepared = sealHead({ schema: PLAYBACK_HISTORY_HEAD_SCHEMA, ...scope, storeId: randomUUID(),
      revision: previous.revision, commitId: previous.commitId, hotSha256: initial ? sha(initial) : previous.hotSha256!,
      indexRoot: null, legacyFileSha256 });
    const commit: Extract<PlaybackHistoryRequest, { op: 'commit' }> = { ...scope, op: 'commit', expected: previous,
      attemptId: randomUUID(), mode: 'activate', next: { token: prepared.next, sealedHead: prepared.sealed,
        hot: initial ? { kind: 'sealed', sealed: initial } : { kind: 'reuse-current' } }, archiveCurrent: null };
    proposal = { request: commit, head: prepared.head };
    try {
      const result = await exchange(commit);
      if (result.kind !== 'committed' || !samePlaybackHistoryToken(result.token, prepared.next)) throw new MobileAuthPersistenceError('unknown');
      token = result.token; head = prepared.head; proposal = undefined;
    } catch (error) {
      if (error instanceof MobileAuthPersistenceError && error.outcome === 'not-sent') proposal = undefined;
      throw error;
    } finally { prepared.sealed.fill(0); initial?.fill(0); }
  }
  async function lookup(kind: PlaybackHistoryRecordKind, identity: unknown): Promise<PlaybackHistorySelection | null> {
    try { return await lookupChecked(kind, identity); }
    catch (error) { if (error instanceof MobilePlaybackError) throw error; return bad(); }
  }
  async function lookupChecked(kind: PlaybackHistoryRecordKind, identity: unknown): Promise<PlaybackHistorySelection | null> {
    const previous = active(), key = historyLookupKey(kind, serverId, datasetId, identity);
    const reply = await exchange({ ...scope, op: 'lookup', expected: previous, key });
    if (reply.kind !== 'proof' || !samePlaybackHistoryToken(reply.token, previous) || reply.key !== key) return bad();
    const proof = verifyPlaybackHistoryProof(previous.indexRoot, key, reply.proof);
    if (proof.kind === 'absent') {
      if (reply.locator !== null || reply.archive !== null) return bad();
      return null;
    }
    if (!reply.locator || !reply.archive || reply.locator.valueHash !== proof.valueHash
      || sha(reply.locator.sealed) !== proof.valueHash) return bad();
    const locatorPlain = copyPlaybackHistoryBytes(crypto.open(reply.locator.sealed, playbackHistoryLocatorAad(serverId, datasetId, key)), 16 * 1024);
    let locator: PlaybackHistoryAuthenticatedLocator;
    try { locator = capturePlaybackHistoryLocator(parsePlaybackHistorySmallJson(locatorPlain)); }
    finally { locatorPlain.fill(0); }
    if (locator.serverId !== serverId || locator.datasetId !== datasetId || locator.kind !== kind || locator.key !== key
      || locator.archiveId !== reply.archive.id || locator.archiveId !== reply.locator.archiveId
      || playbackCanonical(locator.snapshot) !== playbackCanonical(reply.archive.snapshot)
      || sha(reply.archive.sealed) !== locator.snapshot.hotSha256) return bad();
    const plain = copyPlaybackHistoryBytes(crypto.open(reply.archive.sealed,
      playbackHistorySnapshotAad(serverId, datasetId, locator.snapshot.revision)), limits.stateBytes);
    try {
      const context = options.context(locator.snapshot.revision, locator.snapshot.commitId);
      const raw = options.codec?.readHistory ? await options.codec.readHistory(plain, context, locator.sessionId)
        : decodePlaybackHistoryGroup(plain, context, locator.sessionId);
      options.current();
      const group = capturePlaybackHistoryGroup(raw, context, locator.sessionId);
      const row = kind === 'receipt' ? group.receipts.find(value => value.id === locator.recordId)
        : kind === 'session' ? group.sessions.find(value => value.id === locator.recordId)
          : group.resources.find(value => value.id === locator.recordId);
      if (!row) return bad();
      const actualKey = kind === 'receipt' ? historyLookupKey(kind, serverId, datasetId,
        { deviceId: (row as PlaybackState['receipts'][number]).deviceId,
          deviceEpoch: (row as PlaybackState['receipts'][number]).deviceEpoch, keyHash: (row as PlaybackState['receipts'][number]).keyHash })
        : historyLookupKey(kind, serverId, datasetId, { id: row.id });
      if (actualKey !== key) return bad();
      return { locator, group };
    } finally { plain.fill(0); }
  }
  async function prepareArchive(state: PlaybackState, sessionIds: readonly string[]): Promise<void> {
    const previous = active();
    if (plan || !sessionIds.length || state.revision !== previous.revision || state.commitId !== previous.commitId
      || previous.commitId === null || previous.hotSha256 === null) return bad();
    const ids = new Set(sessionIds);
    if (ids.size !== sessionIds.length || state.sessions.filter(value => ids.has(value.id)).length !== ids.size
      || state.sessions.some(value => ids.has(value.id) && !value.terminal)
      || state.resources.some(value => ids.has(value.sessionId) && value.state !== 'terminal')) return bad();
    const archive: PlaybackHistoryArchiveCurrent = { id: randomUUID(),
      snapshot: { revision: previous.revision, commitId: previous.commitId, hotSha256: previous.hotSha256 }, sessionIds: [...sessionIds] };
    const selected: { kind: PlaybackHistoryRecordKind; recordId: string; sessionId: string; identity: unknown }[] = [
      ...state.sessions.filter(row => ids.has(row.id)).map(row => ({ kind: 'session' as const, recordId: row.id, sessionId: row.id, identity: { id: row.id } })),
      ...state.resources.filter(row => ids.has(row.sessionId)).map(row => ({ kind: 'resource' as const, recordId: row.id, sessionId: row.sessionId, identity: { id: row.id } })),
      ...state.receipts.filter(row => ids.has(row.sessionId)).map(row => ({ kind: 'receipt' as const, recordId: row.id,
        sessionId: row.sessionId, identity: { deviceId: row.deviceId, deviceEpoch: row.deviceEpoch, keyHash: row.keyHash } })),
    ];
    const overlay = new Map<string, PlaybackHistoryNodeRecord>(), additions = new Map<string, PlaybackHistoryNodeRecord>();
    const locators: PlaybackHistorySealedLocator[] = [];
    let root = previous.indexRoot;
    for (const [index, row] of selected.entries()) {
      const key = historyLookupKey(row.kind, serverId, datasetId, row.identity);
      if (previous.indexRoot !== null) {
        const proof = await exchange({ ...scope, op: 'lookup', expected: previous, key });
        if (proof.kind !== 'proof' || verifyPlaybackHistoryProof(previous.indexRoot, key, proof.proof).kind !== 'absent'
          || proof.locator !== null || proof.archive !== null) return bad();
        for (const node of proof.proof) overlay.set(node.hash, node);
      }
      const locator = capturePlaybackHistoryLocator({ schema: PLAYBACK_HISTORY_LOCATOR_SCHEMA, ...scope,
        kind: row.kind, key, archiveId: archive.id, snapshot: archive.snapshot, sessionId: row.sessionId, recordId: row.recordId });
      const bytes = jsonBytes(locator);
      let sealed: Uint8Array;
      try { sealed = copyPlaybackHistoryBytes(crypto.seal(bytes, playbackHistoryLocatorAad(serverId, datasetId, key)), limits.sealedBytes); }
      finally { bytes.fill(0); }
      const valueHash = sha(sealed);
      const result = updatePlaybackHistoryProof(root, key, valueHash, readPlaybackHistoryProof(root, key, hash => overlay.get(hash)));
      root = result.root;
      for (const node of result.nodes) { overlay.set(node.hash, node); additions.set(node.hash, node); }
      locators.push({ valueHash, archiveId: archive.id, sealed });
      if (index % 32 === 31) { await yieldTurn(); options.current(); }
    }
    const prepared: ArchivePlan = { expected: previous, attemptId: randomUUID(), root, archive, nodes: [...additions.values()], locators };
    plan = prepared;
    try {
      async function stage(nodes: readonly PlaybackHistoryNodeRecord[], selectedLocators: readonly PlaybackHistorySealedLocator[]): Promise<void> {
        const request = { ...scope, op: 'stage' as const, expected: previous, attemptId: prepared.attemptId, nodes, locators: selectedLocators };
        const metadata = JSON.stringify({ ...request, locators: selectedLocators.map(({ valueHash, archiveId }) => ({ valueHash, archiveId })) });
        const size = Buffer.byteLength(metadata) + selectedLocators.reduce((sum, value) => sum + value.sealed.byteLength, 0);
        if (size > PLAYBACK_HISTORY_MAX_STAGE_BYTES) {
          if (nodes.length && selectedLocators.length) { await stage(nodes, []); await stage([], selectedLocators); return; }
          if (nodes.length > 1) { const half = Math.ceil(nodes.length / 2); await stage(nodes.slice(0, half), []); await stage(nodes.slice(half), []); return; }
          if (selectedLocators.length > 1) { const half = Math.ceil(selectedLocators.length / 2);
            await stage([], selectedLocators.slice(0, half)); await stage([], selectedLocators.slice(half)); return; }
          return bad();
        }
        const reply = await exchange(request);
        if (reply.kind !== 'staged' || reply.attemptId !== prepared.attemptId || !samePlaybackHistoryToken(reply.token, previous)) return bad();
      }
      const count = Math.max(Math.ceil(prepared.nodes.length / PLAYBACK_HISTORY_MAX_STAGE_NODES), Math.ceil(locators.length / PLAYBACK_HISTORY_MAX_STAGE_LOCATORS));
      for (let index = 0; index < count; index++) {
        await stage(prepared.nodes.slice(index * PLAYBACK_HISTORY_MAX_STAGE_NODES, (index + 1) * PLAYBACK_HISTORY_MAX_STAGE_NODES),
          locators.slice(index * PLAYBACK_HISTORY_MAX_STAGE_LOCATORS, (index + 1) * PLAYBACK_HISTORY_MAX_STAGE_LOCATORS));
      }
    } catch (error) { plan = undefined; throw error; }
  }
  return { persistence, ensureActivated, lookup, prepareArchive,
    abandonArchive() { if (!proposal) plan = undefined; },
  };
}
