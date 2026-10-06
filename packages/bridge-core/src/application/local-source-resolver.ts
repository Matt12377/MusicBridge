import path from 'node:path';
import { isLocalPlayRequest, isLocalPlayTarget, isAudioAsset, isLibraryRoot, isLocalTrack,
  type LocalPlayRequest, type LocalPlayTarget, type LocalSourceUnsupported } from '@music-bridge/contracts';
import type { RootCapability } from '../recording/source-files.js';
import type { CollectionRepository } from '../collection/repository.js';
import type { ResolvedAudioStream } from '../netease/types.js';
import type { StreamResolver, StreamResolveRequest } from '../stream/resolver-types.js';

/** 合成UNIT可提供；生产来源与原Controller currentness在006接入，此类型不认证origin。 */
export interface LocalSourceAuthority {
  captureCurrentTarget(): { target: LocalPlayTarget; isCurrent(): boolean } | null;
}
import type { LocalSourceFacts, LocalSourceObservation } from './local-source-facts.js';
export type { LocalSourceFacts, LocalSourceObservation } from './local-source-facts.js';
/** Node私有描述符：没有FD/lease/HTTP/session/Playing；locator不进入公开合同。 */
export interface PreparedLocalSource {
  source_kind: 'local_file'; status: 'prepared_descriptor'; request_id: string;
  action: LocalPlayRequest['action']; target: LocalPlayTarget; facts: LocalSourceFacts;
}
export interface RemoteProviderSource { source_kind: 'remote_provider'; stream: ResolvedAudioStream }
export class LocalSourcePreparationError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'TARGET_CHANGED' | 'FACTS_CHANGED' | 'UNAUTHORIZED_ROOT' | 'SEGMENT_UNSUPPORTED') { super(`本地源准备拒绝：${code}`); }
}
const fail = (code: LocalSourcePreparationError['code']): never => { throw new LocalSourcePreparationError(code); };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameTarget = (a: LocalPlayTarget, b: LocalPlayTarget): boolean => a.core_id === b.core_id && a.zone_id === b.zone_id;
function rootShape(v: unknown, expectedId: string): v is RootCapability {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>, required = ['id','path','dev','ino','authorized','label'];
  return required.every(k => Object.hasOwn(r,k)) && Object.keys(r).length === required.length && r.id === expectedId
    && typeof r.path === 'string' && r.path.length <= 4096 && path.isAbsolute(r.path) && !/[\u0000-\u001f\u007f]/u.test(r.path)
    && typeof r.dev === 'string' && /^(0|[1-9][0-9]*)$/u.test(r.dev) && r.dev.length <= 32
    && typeof r.ino === 'string' && /^(0|[1-9][0-9]*)$/u.test(r.ino) && r.ino.length <= 32
    && typeof r.authorized === 'boolean' && typeof r.label === 'string' && r.label.length <= 256;
}
function facts(repository: CollectionRepository, request: LocalPlayRequest): LocalSourceFacts {
  const track = repository.localCatalog.track(request.local_track_id);
  const locator = repository.localCatalog.privateAssetLocator(request.asset_id), asset = locator.asset;
  const root = repository.localCatalog.root(asset.libraryRootId), sourceRoot = repository.sources.root(root.sourceRootId);
  if (!isLocalTrack(track) || !isAudioAsset(asset) || !isLibraryRoot(root) || track.id !== request.local_track_id || asset.id !== request.asset_id
    || track.assetId !== asset.id || asset.fileRevision !== request.expected_asset_revision
    || root.id !== asset.libraryRootId || root.revision !== asset.rootRevision || root.sourceRootId !== asset.sourceRootId) return fail('FACTS_CHANGED');
  if (!rootShape(sourceRoot, root.sourceRootId) || sourceRoot.authorized !== true) return fail('UNAUTHORIZED_ROOT');
  // 未扫描的002逻辑descriptor不因同名独立asset丢失原有表达能力；它没有005读取资格。
  // 先确认此位置确有扫描事实，再由受当前locator约束的接点取得物理观察，绝不回退到旧path历史。
  const observed = repository.localScan.privateFileState(root.id, locator.relative)
    ? repository.localScan.privateCurrentFileState(root.id, locator.relative) : null;
  let observation: LocalSourceObservation | undefined;
  if (observed?.value.outcome === 'accepted' && observed.value.assetId === asset.id && observed.value.trackId === track.id) {
    const job = repository.localScan.get(observed.jobId);
    if (job.rootRevision === root.revision && job.sourceRootId === sourceRoot.id) observation = {
      signature: observed.value.signature, assetId: asset.id, trackId: track.id, libraryRootId: root.id, sourceRootId: sourceRoot.id,
      fileRevision: asset.fileRevision, rootRevision: root.revision, locationRevision: asset.locationRevision, selectionRevision: track.selectionRevision,
    };
  }
  // 002的纯descriptor可以没有扫描观察；005取得FD资格时必须拒绝这种未证明输入。
  return { track: { ...track, segment: track.segment === null ? null : { ...track.segment } }, asset: { ...asset }, root: { ...root }, sourceRoot: { ...sourceRoot }, relative: locator.relative,
    ...(observation ? { observation } : {}) };
}
/** Owner只证明目录/观察事实，Core目标权威另由原Adapter与Controller绑定。 */
export function captureLocalFactsReadonly(request: LocalPlayRequest, repository: CollectionRepository): LocalSourceFacts {
  if (!isLocalPlayRequest(request)) return fail('INVALID_REQUEST');
  const before = facts(repository, request), after = facts(repository, request);
  if(after.track.segment!==null)return fail('SEGMENT_UNSUPPORTED');
  if (!same(before, after) || !after.observation) return fail('FACTS_CHANGED');
  return after;
}
export function prepareLocalSourceReadonly(request: unknown, repository: CollectionRepository, authority?: LocalSourceAuthority, previous?: PreparedLocalSource): PreparedLocalSource | LocalSourceUnsupported {
  if (!isLocalPlayRequest(request)) return fail('INVALID_REQUEST');
  // 不把public.target传给capture，也没有默认Core/Zone或public自证分支。
  const captured = authority?.captureCurrentTarget();
  if (!captured) return { status: 'unsupported', reason: 'TARGET_AUTHORITY_UNAVAILABLE' };
  if (!isLocalPlayTarget(captured.target) || typeof captured.isCurrent !== 'function' || !sameTarget(captured.target,request.target) || captured.isCurrent() !== true) return fail('TARGET_CHANGED');
  const target = { core_id: captured.target.core_id, zone_id: captured.target.zone_id }, before = facts(repository,request);
  if (previous && (!sameTarget(previous.target,target) || !same(previous.facts,before))) return fail('FACTS_CHANGED');
  const current = authority!.captureCurrentTarget();
  if (!current || !isLocalPlayTarget(current.target) || !sameTarget(target,current.target) || typeof current.isCurrent !== 'function'
    || current.isCurrent() !== true || captured.isCurrent() !== true) return fail('TARGET_CHANGED');
  const after = facts(repository,request);
  if (!same(before,after)) return fail('FACTS_CHANGED');
  // 最终同步核验之后不yield；实际文件/卷/读权限仍由005另行证明。
  if (captured.isCurrent() !== true || current.isCurrent() !== true) return fail('TARGET_CHANGED');
  return { source_kind: 'local_file', status: 'prepared_descriptor', request_id: request.request_id, action: request.action, target, facts: after };
}
export type SourceResolveInput = { source_kind: 'local_file'; request: unknown; repository: CollectionRepository; authority?: LocalSourceAuthority; previous?: PreparedLocalSource }
  | { source_kind: 'remote_provider'; resolve: StreamResolver; request?: StreamResolveRequest };
export async function resolveSourceReadonly(input: SourceResolveInput): Promise<PreparedLocalSource | LocalSourceUnsupported | RemoteProviderSource> {
  if (input.source_kind === 'local_file') return prepareLocalSourceReadonly(input.request,input.repository,input.authority,input.previous);
  if (input.source_kind !== 'remote_provider') return fail('INVALID_REQUEST');
  return { source_kind: 'remote_provider', stream: await input.resolve(input.request) };
}
