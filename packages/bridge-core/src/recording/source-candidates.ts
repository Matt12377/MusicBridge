import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  isCollectionId, isSourceAction, isStartSourceCandidateScan, isSelectSourceCandidate,
  type SelectSourceCandidate, type SourceCandidate, type SourceCandidateScan, type SourceCandidateStopReason,
  type SourceAction, type StartSourceCandidateScan,
} from '@music-bridge/contracts';
import { BridgeError } from '../shared/errors.js';
import type { MasterDraftsRepository } from './drafts.js';
import type { SourceEvidenceService } from './source-evidence.js';
import { readonlySourceCandidateMetadata, readonlySourceDirectoryEntries, sourceRootAvailability, SourceFileError } from './source-files.js';
import type { SourceStore, CandidateFileConstraint } from './source-store.js';

const MAX_ENTRIES = 3000, MAX_DEPTH = 6, MAX_RESULTS = 200, MAX_SCAN_MS = 5000, MAX_SESSIONS = 16, SESSION_TTL_MS = 10 * 60_000, MAX_ACCEPTED_IDS = 4096;
const extensions = new Set(['wav', 'wave', 'flac', 'aiff', 'aif']);
const invalid = (message: string): never => { throw new BridgeError('BAD_REQUEST', message, { httpStatus: 400 }); };
const fingerprint = (value: unknown): string => JSON.stringify(value);
const rawOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const cleanPart = (value: string): string => value.replace(/[\u0000-\u001f\u007f/\\]/gu, '_') || '未命名';
const label = (relative: string): string => {
  const value = relative.split(path.sep).map(cleanPart).join('/');
  return value.length <= 240 ? value : `…${value.slice(-239)}`;
};
interface PrivateCandidate { relative: string; constraint: CandidateFileConstraint }
interface Session {
  request: StartSourceCandidateScan;
  scan: SourceCandidateScan;
  candidates: Map<string, PrivateCandidate>;
  controller: AbortController;
  promise: Promise<void>;
  expiresAt: number;
  generation: number;
}

/** 候选只在 Core 内存中保留；唯一持久结果是用户选择后启动的 SourceJob。 */
export function createSourceCandidateService({ store, drafts, sources, checkRoot = sourceRootAvailability, inspect = readonlySourceCandidateMetadata, list = readonlySourceDirectoryEntries, now = Date.now }: {
  store: SourceStore; drafts: MasterDraftsRepository; sources: SourceEvidenceService;
  checkRoot?: typeof sourceRootAvailability; inspect?: typeof readonlySourceCandidateMetadata; list?: typeof readonlySourceDirectoryEntries; now?: () => number;
}) {
  const sessions = new Map<string, Session>();
  const acceptedIds = new Map<string, string>();
  const pendingStarts = new Map<string, { fingerprint: string; promise: Promise<SourceCandidateScan> }>();
  const cancelReceipts = new Map<string, string>();
  let closed = false, epoch = 0;
  const invalidate = (session: Session, state: 'cancelled' | 'failed', stopReason?: SourceCandidateStopReason): void => {
    session.generation++;
    session.controller.abort();
    session.scan = { ...session.scan, state, ...(stopReason ? { stopReason } : {}) };
  };
  const unsubscribe = sources.onRootRevoked(rootId => {
    for (const session of sessions.values()) if (session.scan.rootId === rootId) {
      if (session.scan.state === 'running' || session.scan.state === 'completed' || session.scan.state === 'truncated') {
        invalidate(session, 'failed', 'ROOT_CHANGED');
      }
    }
  });
  const publicScan = (session: Session): SourceCandidateScan => ({ ...session.scan, candidates: session.scan.candidates.map(candidate => ({ ...candidate })) });
  async function refreshSessionState(session: Session): Promise<boolean> {
    if (closed) return false;
    if (now() >= session.expiresAt) {
      if (session.scan.state === 'running' || session.scan.state === 'completed' || session.scan.state === 'truncated') invalidate(session, 'cancelled');
      return false;
    }
    if (!currentDraft(session.request)) {
      if (session.scan.state === 'running' || session.scan.state === 'completed' || session.scan.state === 'truncated') invalidate(session, 'failed', 'DRAFT_CHANGED');
      return true;
    }
    try {
      const root = store.root(session.scan.rootId);
      if (await checkRoot(root) !== 'ONLINE' && (session.scan.state === 'running' || session.scan.state === 'completed' || session.scan.state === 'truncated')) invalidate(session, 'failed', 'ROOT_CHANGED');
    } catch {
      if (session.scan.state === 'running' || session.scan.state === 'completed' || session.scan.state === 'truncated') invalidate(session, 'failed', 'IO_ERROR');
    }
    return !closed && now() < session.expiresAt;
  }
  function currentDraft(request: StartSourceCandidateScan): boolean {
    try {
      const draft = drafts.detail(request.draftId);
      return draft.revision === request.expectedDraftRevision && draft.tracks.some(track => track.id === request.trackId);
    } catch { return false; }
  }
  function evictTerminal(): void {
    while (sessions.size >= MAX_SESSIONS) {
      const first = [...sessions.entries()].find(([, value]) => value.scan.state !== 'running');
      if (!first) return invalid('候选扫描会话过多，请先等待已有扫描完成。');
      sessions.delete(first[0]);
    }
  }
  async function run(session: Session): Promise<void> {
    const { request, controller } = session, deadline = now() + MAX_SCAN_MS;
    const candidates: { item: SourceCandidate; private: PrivateCandidate }[] = [];
    let stopReason: SourceCandidateStopReason | undefined;
    const check = (): void => {
      if (controller.signal.aborted) throw new SourceFileError('CANCELLED');
      if (now() > deadline) stopReason = 'TIME_LIMIT';
    };
    const visit = async (root: ReturnType<SourceStore['root']>, directory: string, depth: number): Promise<void> => {
      check(); if (stopReason && stopReason !== 'DEPTH_LIMIT') return;
      const remaining = MAX_ENTRIES - session.scan.scannedEntries;
      if (remaining < 1) { stopReason = 'ENTRY_LIMIT'; return; }
      let listing: Awaited<ReturnType<typeof readonlySourceDirectoryEntries>>;
      try { listing = await list(root, directory, remaining, controller.signal, deadline); }
      catch (error) {
        if (error instanceof SourceFileError && error.code === 'LIMIT_EXCEEDED') { stopReason = 'TIME_LIMIT'; return; }
        if (error instanceof SourceFileError && ['REVOKED', 'SOURCE_ROOT_OFFLINE', 'CONTENT_CHANGED'].includes(error.code)) throw error;
        if (!directory) throw error;
        session.scan.skippedUnreadable++;
        // 深度截断只是可继续的软截断；目录读取失败须终止本轮遍历。
        if (!stopReason || stopReason === 'DEPTH_LIMIT') stopReason = 'IO_ERROR';
        return;
      }
      session.scan.scannedEntries += listing.entries.length;
      listing.entries.sort((a, b) => rawOrder(a.name, b.name));
      for (const entry of listing.entries) {
        check(); if (stopReason && stopReason !== 'DEPTH_LIMIT') return;
        const relative = directory ? path.join(directory, entry.name) : entry.name;
        if (entry.isSymbolicLink()) { session.scan.skippedSymlinks++; continue; }
        if (entry.isDirectory()) {
          if (depth >= MAX_DEPTH) { stopReason ??= 'DEPTH_LIMIT'; continue; }
          await visit(root, relative, depth + 1); continue;
        }
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).slice(1).toLowerCase();
        if (!extensions.has(extension)) continue;
        try {
          const metadata = await inspect(root, relative);
          const item: SourceCandidate = { id: randomUUID(), fileName: cleanPart(entry.name).slice(0, 240), relativeLabel: label(relative), extension: extension as SourceCandidate['extension'], size: metadata.size, modifiedAt: metadata.modifiedAt };
          candidates.push({ item, private: { relative, constraint: { fileSignature: metadata.signature, directoryIds: metadata.directoryIds, rootDev: root.dev, rootIno: root.ino } } });
          // 结果预算是硬上限，必须覆盖此前的深度软截断。
          if (candidates.length >= MAX_RESULTS) { stopReason = 'RESULT_LIMIT'; return; }
        } catch (error) {
          if (error instanceof SourceFileError && ['REVOKED', 'SOURCE_ROOT_OFFLINE'].includes(error.code)) throw error;
          session.scan.skippedUnreadable++;
        }
      }
      if (listing.truncated) stopReason = 'ENTRY_LIMIT';
    };
    try {
      const root = store.root(request.rootId);
      if (!currentDraft(request)) throw new SourceFileError('DRAFT_CHANGED');
      if (await checkRoot(root) !== 'ONLINE') throw new SourceFileError('SOURCE_ROOT_OFFLINE');
      await visit(root, '', 0);
      check();
      if (await checkRoot(store.root(request.rootId)) !== 'ONLINE' || store.root(request.rootId).dev !== root.dev || store.root(request.rootId).ino !== root.ino) throw new SourceFileError('SOURCE_ROOT_OFFLINE');
      if (!currentDraft(request)) throw new SourceFileError('DRAFT_CHANGED');
      if (session.scan.state !== 'running') return;
      candidates.sort((a, b) => rawOrder(a.private.relative, b.private.relative));
      session.candidates = new Map(candidates.map(candidate => [candidate.item.id, candidate.private]));
      session.scan = { ...session.scan, candidates: candidates.map(candidate => candidate.item), state: stopReason ? 'truncated' : 'completed', ...(stopReason ? { stopReason } : {}) };
    } catch (error) {
      if (session.scan.state !== 'running') return;
      if (error instanceof SourceFileError && error.code === 'CANCELLED') session.scan = { ...session.scan, state: 'cancelled' };
      else session.scan = { ...session.scan, state: 'failed', stopReason: error instanceof SourceFileError && error.code === 'DRAFT_CHANGED' ? 'DRAFT_CHANGED' : error instanceof SourceFileError && ['REVOKED', 'SOURCE_ROOT_OFFLINE', 'CONTENT_CHANGED'].includes(error.code) ? 'ROOT_CHANGED' : 'IO_ERROR' };
    }
  }
  return {
    async start(request: StartSourceCandidateScan): Promise<SourceCandidateScan> {
      if (!isStartSourceCandidateScan(request) || closed) return invalid('候选扫描请求无效。');
      const body = fingerprint(request), pending = pendingStarts.get(request.commandId);
      if (pending) {
        if (pending.fingerprint !== body) return invalid('同一操作编号不能用于不同候选扫描。');
        return pending.promise;
      }
      const prior = sessions.get(request.commandId);
      if (prior) {
        if (fingerprint(prior.request) !== body) return invalid('同一操作编号不能用于不同候选扫描。');
        if (!await refreshSessionState(prior)) return invalid('候选扫描会话已过期，请重新扫描。');
        return publicScan(prior);
      }
      const accepted = acceptedIds.get(request.commandId);
      if (accepted) return invalid(accepted === body ? '候选扫描会话已过期或被回收，请使用新操作编号重新扫描。' : '同一操作编号不能用于不同候选扫描。');
      if (acceptedIds.size >= MAX_ACCEPTED_IDS) return invalid('本次运行的候选扫描次数已达上限，请重启应用后继续。');
      if ([...sessions.values()].filter(value => value.scan.state === 'running').length + pendingStarts.size >= 2) return invalid('已有两项候选扫描在进行，请等待或取消。');
      const startedEpoch = epoch;
      const work = (async (): Promise<SourceCandidateScan> => {
        if (!currentDraft(request)) return invalid('草稿曲目已改变，请刷新后重新扫描。');
        const root = store.root(request.rootId);
        if (await checkRoot(root) !== 'ONLINE') return invalid('源目录当前未授权或离线。');
        if (closed || epoch !== startedEpoch) return invalid('候选扫描已中止，请重新发起。');
        if (!currentDraft(request)) return invalid('草稿曲目已改变，请刷新后重新扫描。');
        const latest = store.root(request.rootId);
        if (!latest.authorized || latest.dev !== root.dev || latest.ino !== root.ino) return invalid('源目录授权或身份已变化，请重新选择。');
        if (await checkRoot(latest) !== 'ONLINE') return invalid('源目录当前未授权或离线。');
        if (closed || epoch !== startedEpoch || !currentDraft(request) || !store.root(request.rootId).authorized) return invalid('候选扫描上下文已变化，请重新发起。');
        evictTerminal();
        const session: Session = { request, scan: { id: request.commandId, rootId: request.rootId, draftId: request.draftId, trackId: request.trackId, expectedDraftRevision: request.expectedDraftRevision, state: 'running', scannedEntries: 0, skippedSymlinks: 0, skippedUnreadable: 0, candidates: [] }, candidates: new Map(), controller: new AbortController(), promise: Promise.resolve(), expiresAt: now() + SESSION_TTL_MS, generation: 0 };
        sessions.set(request.commandId, session);
        acceptedIds.set(request.commandId, body);
        session.promise = run(session).catch(() => { if (session.scan.state === 'running') invalidate(session, 'failed', 'IO_ERROR'); });
        return publicScan(session);
      })();
      pendingStarts.set(request.commandId, { fingerprint: body, promise: work });
      void work.then(() => { if (pendingStarts.get(request.commandId)?.promise === work) pendingStarts.delete(request.commandId); }, () => { if (pendingStarts.get(request.commandId)?.promise === work) pendingStarts.delete(request.commandId); });
      return work;
    },
    async get(id: string): Promise<{ scan: SourceCandidateScan | null }> {
      if (!isCollectionId(id)) return invalid('候选扫描编号无效。');
      if (closed) return { scan: null };
      const session = sessions.get(id);
      return { scan: session && await refreshSessionState(session) ? publicScan(session) : null };
    },
    cancel(request: SourceAction): SourceCandidateScan {
      if (!isSourceAction(request) || closed) return invalid('取消候选扫描请求无效。');
      const fp = fingerprint(['cancel', request.id]), prior = cancelReceipts.get(request.commandId);
      if (prior && prior !== fp) return invalid('同一操作编号不能用于不同候选扫描取消操作。');
      const session = sessions.get(request.id);
      if (!session || now() >= session.expiresAt) return invalid('候选扫描会话不存在或已失效。');
      if (!prior && cancelReceipts.size >= MAX_ACCEPTED_IDS) return invalid('本次运行的取消回执已达上限，请重启应用后继续。');
      cancelReceipts.set(request.commandId, fp);
      if (session.scan.state === 'running' || session.scan.state === 'completed' || session.scan.state === 'truncated') invalidate(session, 'cancelled');
      return publicScan(session);
    },
    async select(request: SelectSourceCandidate) {
      if (!isSelectSourceCandidate(request) || closed) return invalid('候选选择请求无效。');
      // 持久 SourceJob 的完整选择指纹是重启后的唯一回执来源；不能把丢失的扫描当成未接受。
      if (store.job(request.commandId)) return sources.startCandidate(request);
      const session = sessions.get(request.candidate.scanId), candidate = session?.candidates.get(request.candidate.candidateId);
      if (!session || !await refreshSessionState(session) || !candidate || !['completed', 'truncated'].includes(session.scan.state)) return invalid('候选扫描已失效，请重新扫描。');
      const generation = session.generation;
      const stillSelectable = (): void => {
        if (closed || sessions.get(session.scan.id) !== session || session.generation !== generation || now() >= session.expiresAt
          || !['completed', 'truncated'].includes(session.scan.state) || !currentDraft(session.request)) invalid('候选扫描已失效，请重新扫描。');
      };
      if (session.scan.rootId !== request.rootId || session.scan.draftId !== request.draftId || session.scan.trackId !== request.trackId || session.scan.expectedDraftRevision !== request.candidate.expectedDraftRevision) return invalid('候选与当前草稿或源目录不符，请重新扫描。');
      stillSelectable();
      const root = store.root(request.rootId);
      if (await checkRoot(root) !== 'ONLINE' || root.dev !== candidate.constraint.rootDev || root.ino !== candidate.constraint.rootIno) return invalid('源目录已变化，请重新授权并扫描。');
      stillSelectable();
      try {
        const current = await inspect(root, candidate.relative);
        stillSelectable();
        if (current.signature !== candidate.constraint.fileSignature || JSON.stringify(current.directoryIds) !== JSON.stringify(candidate.constraint.directoryIds)) return invalid('候选文件或其目录已变化，请重新扫描。');
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        return invalid('候选文件已变化或不可访问，请重新扫描。');
      }
      stillSelectable();
      return sources.startCandidate(request, candidate);
    },
    async idle(): Promise<void> { await Promise.all([...sessions.values()].map(session => session.promise)); },
    async close(): Promise<void> {
      if (closed) return;
      closed = true; epoch++; unsubscribe();
      for (const session of sessions.values()) if (session.scan.state === 'running' || session.scan.state === 'completed' || session.scan.state === 'truncated') invalidate(session, 'cancelled');
      await Promise.allSettled([...pendingStarts.values()].map(entry => entry.promise));
      await Promise.all([...sessions.values()].map(session => session.promise));
    },
  };
}
export type SourceCandidateService = ReturnType<typeof createSourceCandidateService>;
