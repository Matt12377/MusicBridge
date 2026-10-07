import type { DatabaseSync } from 'node:sqlite';
import * as dto from '@music-bridge/contracts';
import type { LocalCatalogStore } from './local-catalog-store.js';
import type { SourceStore } from '../recording/source-store.js';
import { CollectionError } from './repository.js';
import { organizerApplyPatch, organizerContextFingerprint, organizerCurrentPlan, organizerEqual, organizerEvent, organizerFrozenPatch, organizerHash, organizerId,
  organizerProposal, organizerRevisionId, organizerPlanSummary, ORGANIZER_JOURNAL, ORGANIZER_MAX_REVISIONS, type OrganizerEvent, type OrganizerHeader } from './local-organizer-journal.js';

export class OrganizerConflict extends CollectionError { constructor(readonly issue: string) { super('INVENTORY_CONFLICT', `整理上下文已改变：${issue}。请重新预览。`); } }
type Observation = dto.LocalOrganizerItem['sourceObservation'];
type Capture = { items: dto.LocalOrganizerItem[]; editionBindings: dto.LocalOrganizerPlan['editionBindings'] };
const unknownObservation = (): Observation => ({ status: 'unknown', fileSignature: null, permissionMode: null, rootPermissionMode: null, directoryIds: [] });
const conflict = (message: string): never => { throw new CollectionError('INVENTORY_CONFLICT', message); };
const next = (revision: string): string => { if (Number(revision) >= ORGANIZER_MAX_REVISIONS) return conflict('整理计划历史已达到有界重试预算，请重新预览。'); return (BigInt(revision) + 1n).toString(); };
export function createLocalOrganizerStore(options: { catalog: LocalCatalogStore; sources: SourceStore; datasetId: string; assertCurrent(): void }) {
  const catalog = options.catalog;
  const current = (db: DatabaseSync, id: string): dto.LocalOrganizerPlan => {
    const plan = organizerCurrentPlan(db, id); if (plan.datasetId !== options.datasetId) return conflict('整理计划不属于当前工作库。'); return plan;
  };
  function prior(commandId: string, action: 'preview' | 'undo' | 'confirm' | 'cancel', request: unknown): dto.LocalOrganizerPlan | undefined {
    return catalog.privateRead(db => {
      const row = db.prepare('SELECT operation FROM local_catalog_ledger WHERE command_id=?').get(commandId); if (!row) return undefined;
      if (row.operation !== ORGANIZER_JOURNAL) return conflict('操作编号已用于其他目录操作。');
      const event = organizerEvent(db, commandId)!;
      if ((event.kind !== 'proposed' && event.kind !== 'decision') || event.action !== action || !organizerEqual(event.request, request)) return conflict('操作编号已绑定另一整理请求。');
      return current(db, event.planId);
    });
  }
  function editionTracks(editionId: string): string[] {
    catalog.edition(editionId);
    return catalog.privateRead(db => {
      const rows = db.prepare("SELECT data FROM local_catalog_edition_tracks WHERE edition_id=? AND json_extract(data,'$.active')=1 ORDER BY json_extract(data,'$.sequence'),id LIMIT 101").all(editionId);
      if (rows.length < 1 || rows.length > 100) return conflict('整张发行的整理范围须为1到100首，请明确选择较小批次。');
      const values = rows.map(row => { const value: unknown = JSON.parse(String(row.data)); if (!dto.isAlbumEditionTrack(value)) return conflict('发行关系无效。'); return value.trackId; });
      if (new Set(values).size !== values.length) return conflict('发行含重复曲目关系，请先明确选择曲目。'); return values;
    });
  }
  function capture(request: dto.PreviewLocalOrganizer, inverse?: dto.LocalOrganizerPlan): Capture {
    options.assertCurrent();
    const target = request.target, ids = target.mode === 'single' ? [target.trackId] : target.mode === 'batch' ? target.trackIds : editionTracks(target.editionId);
    const bindings = new Map<string, string>();
    const bind = (id: string, expected?: string): void => { const edition = catalog.edition(id); if (expected !== undefined && expected !== edition.revision) throw new OrganizerConflict('GROUPING_REVISION_CHANGED'); bindings.set(id, edition.revision); };
    if (target.mode === 'edition') bind(target.editionId);
    const items = ids.map((trackId, index): dto.LocalOrganizerItem => {
      const detail = catalog.trackDetail(trackId), location = catalog.privateAssetLocator(detail.asset.id), root = catalog.root(detail.asset.libraryRootId), source = options.sources.root(root.sourceRootId);
      if (detail.asset.sourceRootId !== root.sourceRootId || detail.asset.rootRevision !== root.revision) throw new OrganizerConflict('ROOT_BINDING_CHANGED');
      const before = { fields: structuredClone(detail.metadata.override?.fields ?? {}), annotations: structuredClone(detail.metadata.override?.annotations ?? {}) };
      const after = inverse ? structuredClone(inverse.items[index]!.before) : organizerApplyPatch(before, request.patch);
      if (inverse && (trackId !== inverse.items[index]!.trackId || detail.metadata.override?.revision !== inverse.results[index]!.overrideRevision || !organizerEqual(before, inverse.items[index]!.after))) throw new OrganizerConflict('UNDO_OVERRIDE_CHANGED');
      for (const group of after.annotations.groupingSuggestions ?? []) bind(group.editionId, group.expectedRevision);
      return {
        operation: { operation_id: organizerId(request.commandId, `operation/${index}`), kind: request.scope === 'MB_ONLY' ? 'MB_OVERRIDE' : 'WRITE_TAGS', root_id: root.id, target_asset_id: detail.asset.id,
          expected_asset_revision: detail.asset.fileRevision, source_relative_path: location.relative, target_relative_path: null, field_patch: organizerFrozenPatch(after), backup_required: request.scope === 'SOURCE_FILES' },
        trackId, selectionRevision: detail.track.selectionRevision, rootRevision: root.revision, locationRevision: detail.asset.locationRevision, overrideRevision: detail.metadata.override?.revision ?? null,
        raw: structuredClone(detail.metadata.raw), before, after, permission: { sourceRootId: source.id, authorized: source.authorized, dev: source.dev, ino: source.ino }, sourceObservation: unknownObservation(),
        protection: { resources: request.scope === 'SOURCE_FILES' ? [location.relative] : [], complete: request.scope === 'MB_ONLY', activeLease: request.scope === 'MB_ONLY' ? 'not-applicable' : 'unknown',
          frozenReferences: request.scope === 'MB_ONLY' ? 'not-applicable' : 'unknown', writable: request.scope === 'MB_ONLY' ? 'not-applicable' : 'unknown', backupBytes: null },
      };
    });
    if (bindings.size > 100) return conflict('分组建议引用超出单计划预算。');
    return { items, editionBindings: [...bindings].map(([editionId, revision]) => ({ editionId, revision })).sort((a, b) => a.editionId.localeCompare(b.editionId, 'en')) };
  }
  function inverseRequest(request: dto.ChangeLocalOrganizer, original: dto.LocalOrganizerPlan): dto.PreviewLocalOrganizer {
    return { commandId: request.commandId, scope: 'MB_ONLY', target: { mode: 'batch', trackIds: original.items.map(i => i.trackId) }, patch: { fields: { title: { action: 'clear' } } } };
  }
  function snapshotFor(plan: dto.LocalOrganizerPlan): Capture {
    return catalog.privateRead(db => {
      const proposal = organizerProposal(db, plan.planId);
      return proposal.action === 'preview' ? capture(proposal.request) : capture(inverseRequest(proposal.request, current(db, proposal.request.planId)), current(db, proposal.request.planId));
    });
  }
  function assertSnapshot(plan: dto.LocalOrganizerPlan, observations: readonly Observation[]): void {
    let fresh: Capture;
    try { fresh = snapshotFor(plan); } catch (error) { if (error instanceof OrganizerConflict) throw error; throw new OrganizerConflict('CATALOG_CONTEXT_CHANGED'); }
    if (observations.length !== fresh.items.length) throw new OrganizerConflict('SOURCE_CONTEXT_CHANGED');
    fresh.items.forEach((item, index) => { item.sourceObservation = structuredClone(observations[index]!); });
    if (!organizerEqual(fresh.items, plan.items) || !organizerEqual(fresh.editionBindings, plan.editionBindings)) throw new OrganizerConflict('CONTEXT_CHANGED');
  }
  const stateEvent = (plan: dto.LocalOrganizerPlan, state: dto.LocalOrganizerState, issue: string | null, decisionId: string | null, relatedPlanId: string | null = null): OrganizerEvent => {
    const revision = next(plan.revision); return { version: 1, kind: 'state', eventId: organizerRevisionId(plan.planId, revision), planId: plan.planId, revision, state, issue, decisionId, relatedPlanId };
  };
  function persistProposal(action: 'preview' | 'undo', request: dto.PreviewLocalOrganizer | dto.ChangeLocalOrganizer, prepared: Capture, createdAt: string, expiresAt: string, original?: dto.LocalOrganizerPlan): dto.LocalOrganizerPlan {
    const preview = action === 'preview' ? request as dto.PreviewLocalOrganizer : inverseRequest(request as dto.ChangeLocalOrganizer, original!);
    return catalog.privateBatch((db, _mutate, append) => {
      const repeated = prior(request.commandId, action, request); if (repeated) return repeated;
      const fresh = capture(preview, original);
      fresh.items.forEach((item, index) => { item.sourceObservation = structuredClone(prepared.items[index]?.sourceObservation ?? unknownObservation()); });
      if (!organizerEqual(fresh, prepared)) throw new OrganizerConflict('PREVIEW_CONTEXT_CHANGED');
      const roots = Object.fromEntries(fresh.items.map(item => [item.operation.root_id, item.rootRevision]));
      const body: dto.OrganizerFrozenBody = { created_at: createdAt, scope: preview.scope, operations: fresh.items.map(item => item.operation), root_mapping_revisions: roots,
        conflicts: preview.scope === 'SOURCE_FILES' ? ['SOURCE_WRITER_NOT_READY', 'FROZEN_PROTECTION_UNKNOWN', 'RESOURCE_SET_INCOMPLETE'] : [],
        resource_guards: { require_exclusive_asset_lock: preview.scope === 'SOURCE_FILES', defer_if_read_lease: preview.scope === 'SOURCE_FILES', protect_frozen_sources: true, recheck_at_execution: true } };
      const context = { datasetId: options.datasetId, createdAt, expiresAt, scope: preview.scope, items: fresh.items, editionBindings: fresh.editionBindings, undoOf: original?.planId ?? null };
      const plan: dto.LocalOrganizerPlan = { ...context, planId: request.commandId, revision: '1', body, planHash: '0'.repeat(64), contextFingerprint: '0'.repeat(64), state: preview.scope === 'SOURCE_FILES' ? 'BLOCKED' : 'DRAFT',
        issue: preview.scope === 'SOURCE_FILES' ? 'SOURCE_FILES_WRITE_OFF' : null, results: fresh.items.map(item => ({ operationId: item.operation.operation_id, trackId: item.trackId, state: 'planned', overrideRevision: null, issue: null })) };
      if (!dto.isLocalOrganizerPlan(plan)) return conflict('整理计划超过字段或总字节预算。');
      plan.planHash = organizerHash(body); plan.contextFingerprint = organizerContextFingerprint(context);
      for (let index = 0; index < plan.items.length; index++) append({ version: 1, kind: 'item', eventId: organizerId(plan.planId, `item/${index}`), planId: plan.planId, index, item: plan.items[index]! });
      const { operations: _operations, ...frozenHeader } = plan.body;
      const header: OrganizerHeader = { planId: plan.planId, datasetId: plan.datasetId, scope: plan.scope, planHash: plan.planHash, contextFingerprint: plan.contextFingerprint, createdAt, expiresAt,
        body: frozenHeader, editionBindings: plan.editionBindings, undoOf: plan.undoOf, count: plan.items.length, initialState: preview.scope === 'SOURCE_FILES' ? 'BLOCKED' : 'DRAFT', initialIssue: plan.issue };
      if (action === 'preview') append({ version: 1, kind: 'proposed', eventId: plan.planId, planId: plan.planId, header, action, request: request as dto.PreviewLocalOrganizer });
      else append({ version: 1, kind: 'proposed', eventId: plan.planId, planId: plan.planId, header, action, request: request as dto.ChangeLocalOrganizer });
      return current(db, plan.planId);
    }, 'local-organizer:propose');
  }
  function checkedConfirmation(db: DatabaseSync, request: dto.ConfirmLocalOrganizer): dto.LocalOrganizerPlan {
    const plan = current(db, request.planId);
    if (plan.scope !== 'MB_ONLY' || request.scope !== 'MB_ONLY') return conflict('SOURCE_FILES_WRITE_OFF：源文件作者和完整保护尚未就绪，禁止执行。');
    if (request.planHash !== plan.planHash || request.contextFingerprint !== plan.contextFingerprint) return conflict('整理Hash或上下文指纹不匹配。');
    if (request.expectedRevision !== plan.revision || !['DRAFT', 'RECOVERY_REQUIRED'].includes(plan.state)) return conflict('整理计划修订或状态已改变。');
    // 确认、执行、完成消耗3个修订，另为成功计划保留1个正式撤销修订。
    if (Number(plan.revision) > ORGANIZER_MAX_REVISIONS - 4) return conflict('整理重试历史预算不足，请重新预览。');
    if (plan.undoOf) { const original = current(db, plan.undoOf); if (original.state !== 'COMPLETED') throw new OrganizerConflict('UNDO_ORIGINAL_CHANGED'); }
    return plan;
  }
  return {
    prior,
    capturePreview(request: dto.PreviewLocalOrganizer): Capture { return capture(request); },
    captureUndo(request: dto.ChangeLocalOrganizer): { original: dto.LocalOrganizerPlan; capture: Capture } {
      return catalog.privateRead(db => {
        const original = current(db, request.planId); if (original.state !== 'COMPLETED' || original.scope !== 'MB_ONLY' || original.revision !== request.expectedRevision) return conflict('仅可为当前完整成功的MB整理生成撤销预览。');
        return { original, capture: capture(inverseRequest(request, original), original) };
      });
    },
    persistPreview(request: dto.PreviewLocalOrganizer, prepared: Capture, createdAt: string, expiresAt: string) { return persistProposal('preview', request, prepared, createdAt, expiresAt); },
    persistUndo(request: dto.ChangeLocalOrganizer, prepared: Capture, original: dto.LocalOrganizerPlan, createdAt: string, expiresAt: string) { return persistProposal('undo', request, prepared, createdAt, expiresAt, original); },
    get(planId: string, recover = false): dto.LocalOrganizerPlan {
      options.assertCurrent(); const plan = catalog.privateRead(db => current(db, planId));
      if (!recover || !['CONFIRMED', 'EXECUTING'].includes(plan.state)) return plan;
      return catalog.privateBatch((db, _mutate, append) => {
        const now = current(db, planId); if (!['CONFIRMED', 'EXECUTING'].includes(now.state)) return now;
        if (now.items.some(item => db.prepare('SELECT 1 FROM local_catalog_ledger WHERE command_id=?').get(item.operation.operation_id))) return conflict('存在未对账的逐项回执，工作库保留且禁止重放。');
        append(stateEvent(now, 'RECOVERY_REQUIRED', 'CONFIRMATION_INTERRUPTED', null)); return current(db, planId);
      }, 'local-organizer:recover');
    },
    prepareConfirm(request: dto.ConfirmLocalOrganizer) { return catalog.privateRead(db => checkedConfirmation(db, request)); },
    confirm(request: dto.ConfirmLocalOrganizer, observations: readonly Observation[], now: number): dto.LocalOrganizerPlan {
      return catalog.privateBatch((db, _mutate, append) => {
        const repeated = prior(request.commandId, 'confirm', request); if (repeated) return repeated;
        const plan = checkedConfirmation(db, request);
        let issue: string | null = Date.parse(plan.expiresAt) <= now ? 'PLAN_EXPIRED' : null;
        if (!issue) try { assertSnapshot(plan, observations); } catch (error) { if (!(error instanceof OrganizerConflict)) throw error; issue = error.issue; }
        const state = stateEvent(plan, issue ? 'FAILED' : 'CONFIRMED', issue, request.commandId);
        append({ version: 1, kind: 'decision', eventId: request.commandId, planId: plan.planId, action: 'confirm', request, revision: state.kind === 'state' ? state.revision : '0' }); append(state);
        return current(db, plan.planId);
      }, 'local-organizer:confirm');
    },
    apply(request: dto.ConfirmLocalOrganizer, observations: readonly Observation[]): dto.LocalOrganizerPlan {
      return catalog.privateBatch((db, mutate, append) => {
        const plan = current(db, request.planId); if (plan.state === 'CANCELLED') return plan;
        const decision = organizerEvent(db, request.commandId);
        if (plan.state !== 'CONFIRMED' || decision?.kind !== 'decision' || decision.action !== 'confirm' || !organizerEqual(decision.request, request)) return conflict('确认回执或执行状态已改变。');
        assertSnapshot(plan, observations);
        const executing = stateEvent(plan, 'EXECUTING', null, request.commandId); append(executing);
        for (let index = 0; index < plan.items.length; index++) {
          const item = plan.items[index]!;
          const result = mutate('override-metadata', { commandId: item.operation.operation_id, trackId: item.trackId, expectedRevision: item.overrideRevision, fields: item.after.fields, annotations: item.after.annotations });
          if (!dto.isLocalMetadataOverride(result)) return conflict('逐项覆盖回执无效。');
          append({ version: 1, kind: 'item-applied', eventId: organizerId(plan.planId, `applied/${index}`), planId: plan.planId, index, decisionId: request.commandId, operationId: item.operation.operation_id, overrideRevision: result.revision });
        }
        const running = current(db, plan.planId); append(stateEvent(running, 'COMPLETED', null, request.commandId));
        if (plan.undoOf) { const original = current(db, plan.undoOf); if (original.state !== 'COMPLETED') throw new OrganizerConflict('UNDO_ORIGINAL_CHANGED'); append(stateEvent(original, 'ROLLED_BACK', null, null, plan.planId)); }
        return current(db, plan.planId);
      }, 'local-organizer:apply');
    },
    failConfirmed(planId: string, decisionId: string, issue: string): dto.LocalOrganizerPlan {
      return catalog.privateBatch((db, _mutate, append) => { const plan = current(db, planId); if (plan.state !== 'CONFIRMED') return plan; append(stateEvent(plan, 'FAILED', issue, decisionId)); return current(db, planId); }, 'local-organizer:failed');
    },
    cancel(request: dto.ChangeLocalOrganizer): dto.LocalOrganizerPlan {
      return catalog.privateBatch((db, _mutate, append) => {
        const repeated = prior(request.commandId, 'cancel', request); if (repeated) return repeated;
        const plan = current(db, request.planId); if (request.expectedRevision !== plan.revision || !['DRAFT', 'BLOCKED', 'CONFIRMED', 'RECOVERY_REQUIRED'].includes(plan.state)) return conflict('计划状态已改变，不能取消已提交的写入。');
        const state = stateEvent(plan, 'CANCELLED', 'USER_CANCELLED', request.commandId);
        append({ version: 1, kind: 'decision', eventId: request.commandId, planId: plan.planId, action: 'cancel', request, revision: state.kind === 'state' ? state.revision : '0' }); append(state); return current(db, plan.planId);
      }, 'local-organizer:cancel');
    },
    history(request: { offset: number; limit: number }): dto.LocalOrganizerCommandResults['localOrganizer.history'] {
      return catalog.privateRead(db => {
        const total = Number(db.prepare("SELECT count(*) n FROM local_catalog_ledger WHERE operation=? AND json_extract(request,'$.kind')='proposed' AND json_extract(request,'$.header.datasetId')=?").get(ORGANIZER_JOURNAL, options.datasetId)!.n);
        const rows = db.prepare("SELECT command_id FROM local_catalog_ledger WHERE operation=? AND json_extract(request,'$.kind')='proposed' AND json_extract(request,'$.header.datasetId')=? ORDER BY rowid DESC LIMIT ? OFFSET ?").all(ORGANIZER_JOURNAL, options.datasetId, request.limit, request.offset);
        return { ...request, total, items: rows.map(row => { const { datasetId, ...summary } = organizerPlanSummary(db, String(row.command_id)); if (datasetId !== options.datasetId) return conflict('历史整理计划不属于当前工作库。'); return summary; }) };
      });
    },
  };
}
export type LocalOrganizerStore = ReturnType<typeof createLocalOrganizerStore>;
