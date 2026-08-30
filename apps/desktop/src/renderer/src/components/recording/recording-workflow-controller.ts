import type { MasterDraft, RecordingSourcesPublicApi, MediaPlanningPublicApi, MasterVersionsPublicApi, PreparationPublicApi, PreparedPublicApi, RecordingExecutionPublicApi } from '@music-bridge/contracts'
import {
  currentRecordingLayout, matchingPreparation, matchingPrepared, recordingFactsMatchDraft, sameRecordingFact,
  type RecordingWorkflowFacts, type RecordingWorkflowSelection, type RecordingWorkflowState,
} from './recording-next-step.js'
export type { RecordingWorkflowFacts, RecordingWorkflowSelection, RecordingWorkflowState } from './recording-next-step.js'

export type RecordingWorkflowApi = Pick<RecordingSourcesPublicApi, 'getDraftSources'> & Pick<MediaPlanningPublicApi, 'listMediaPlans'>
  & Pick<MasterVersionsPublicApi, 'listMasterVersions'> & Pick<PreparationPublicApi, 'listPreparations'>
  & Pick<PreparedPublicApi, 'listPrepared'> & Pick<RecordingExecutionPublicApi, 'listExecutionAssets'>

function retainSelection(draft: MasterDraft, facts: RecordingWorkflowFacts, selection: RecordingWorkflowSelection, previous?: RecordingWorkflowFacts): RecordingWorkflowSelection {
  const result: RecordingWorkflowSelection = {}
  if (selection.path && ['direct', 'logic', 'prep'].includes(selection.path)) result.path = selection.path
  const plan = facts.plans.plans.find(value => value.id === selection.planId)
  if (!plan || previous && !sameRecordingFact(plan, previous.plans.plans.find(value => value.id === plan.id))) return result
  result.planId = plan.id
  const layout = facts.versions.layouts.find(value => value.id === selection.layoutId)
  if (!layout || !currentRecordingLayout(draft, facts, plan, layout) || previous && !sameRecordingFact(layout, previous.versions.layouts.find(value => value.id === layout.id))) return result
  result.layoutId = layout.id
  if (result.path === 'direct' || !result.path) return result
  const preparation = facts.preparations.workspaces.find(value => value.id === selection.preparationId)
  if (!preparation || !matchingPreparation(layout, preparation) || previous && !sameRecordingFact(preparation, previous.preparations.workspaces.find(value => value.id === preparation.id))) return result
  result.preparationId = preparation.id
  const prepared = facts.prepared.preps.find(value => value.id === selection.preparedId)
  if (prepared && matchingPrepared(facts, layout, preparation, prepared) && (!previous || sameRecordingFact(prepared, previous.prepared.preps.find(value => value.id === prepared.id)))) result.preparedId = prepared.id
  return result
}

export function createRecordingWorkflowController(options: { api: RecordingWorkflowApi; onChange?: () => void }) {
  const state: RecordingWorkflowState = { draftId: null, draftRevision: null, status: 'unread', selection: {}, error: '' }
  let alive = true, generation = 0, draft: MasterDraft | undefined
  const changed = () => { if (alive) options.onChange?.() }
  function reset(): void {
    if (!alive) return
    generation++; draft = undefined
    Object.assign(state, { draftId: null, draftRevision: null, status: 'unread', facts: undefined, selection: {}, error: '' })
    changed()
  }
  return {
    state,
    setDraft(value: MasterDraft | null): void {
      if (!alive) return
      if (!value) { reset(); return }
      if (state.draftId !== value.id || state.draftRevision !== value.revision) {
        generation++
        Object.assign(state, { draftId: value.id, draftRevision: value.revision, status: 'unread', facts: undefined, selection: {}, error: '' })
      }
      draft = structuredClone(value); changed()
    },
    async refresh(): Promise<void> {
      if (!alive || !draft) return
      const current = draft, token = ++generation, previous = state.facts
      state.status = 'loading'; state.error = ''; changed()
      try {
        const [sources, plans, versions, preparations, prepared, execution] = await Promise.all([
          options.api.getDraftSources(current.id), options.api.listMediaPlans(current.id), options.api.listMasterVersions(current.id),
          options.api.listPreparations(current.id), options.api.listPrepared(current.id), options.api.listExecutionAssets(current.id),
        ])
        if (!alive || token !== generation) return
        const facts: RecordingWorkflowFacts = { sources, plans, versions, preparations, prepared, execution }
        if (!recordingFactsMatchDraft(current, facts)) throw new Error('工作状态与当前草稿身份不一致')
        state.selection = retainSelection(current, facts, state.selection, previous)
        state.facts = facts; state.status = 'ready'
      } catch {
        if (!alive || token !== generation) return
        state.status = 'error'; state.error = '工作状态读取失败或草稿身份已变化，请刷新；已有历史不会被当作空数据。'
      }
      if (alive && token === generation) changed()
    },
    select(patch: Partial<RecordingWorkflowSelection>): void {
      if (!alive || !draft || state.status !== 'ready' || !state.facts) return
      const selected = { ...state.selection }
      if ('planId' in patch && patch.planId !== selected.planId) { delete selected.layoutId; delete selected.preparationId; delete selected.preparedId }
      if ('layoutId' in patch && patch.layoutId !== selected.layoutId || 'path' in patch && patch.path !== selected.path) { delete selected.preparationId; delete selected.preparedId }
      if ('preparationId' in patch && patch.preparationId !== selected.preparationId) delete selected.preparedId
      state.selection = retainSelection(draft, state.facts, { ...selected, ...patch }); changed()
    },
    reset,
    dispose(): void { alive = false; generation++ },
  }
}
