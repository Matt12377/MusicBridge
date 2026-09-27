import type {
  MasterDraft, PutRecordingWorkspaceContextRequest, RecordingWorkspaceContext, RecordingWorkspacePagePosition,
  RecordingWorkspacePublicApi, RecordingWorkspaceSelection,
} from '@music-bridge/contracts'

export interface RecordingWorkspaceState {
  draftId: string | null
  draftRevision: number | null
  status: 'unread' | 'loading' | 'ready' | 'error'
  context: RecordingWorkspaceContext | null
  selection: RecordingWorkspaceSelection
  pagePosition: RecordingWorkspacePagePosition
  pending?: PutRecordingWorkspaceContextRequest
  writing: boolean
  error: string
}

const same = (left: RecordingWorkspaceSelection, right: RecordingWorkspaceSelection): boolean =>
  (['planId', 'layoutId', 'path', 'preparationId', 'preparedId', 'selectedPhysicalId'] as const).every(key => left[key] === right[key])

/** 保留用户已存的旧引用；只有用户明确改选时才清除下游身份。 */
export function patchWorkspaceSelection(selection: RecordingWorkspaceSelection, patch: Partial<RecordingWorkspaceSelection>): RecordingWorkspaceSelection {
  const next = { ...selection }
  if ('planId' in patch && patch.planId !== next.planId) { delete next.layoutId; delete next.preparationId; delete next.preparedId }
  if ('layoutId' in patch && patch.layoutId !== next.layoutId || 'path' in patch && patch.path !== next.path) { delete next.preparationId; delete next.preparedId }
  if ('preparationId' in patch && patch.preparationId !== next.preparationId) delete next.preparedId
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete next[key as keyof RecordingWorkspaceSelection]
    else Object.assign(next, { [key]: value })
  }
  return next
}

export function createRecordingWorkspaceController(options: { api: RecordingWorkspacePublicApi; onChange?: () => void }) {
  const state: RecordingWorkspaceState = { draftId: null, draftRevision: null, status: 'unread', context: null, selection: {}, pagePosition: 'my-work', writing: false, error: '' }
  let alive = true, generation = 0, inFlight: Promise<void> | undefined, queued = false
  const changed = () => { if (alive) options.onChange?.() }
  const hasChanges = () => !state.context || !same(state.selection, state.context.selection) || state.pagePosition !== state.context.pagePosition
  function reset(): void {
    generation++; queued = false
    Object.assign(state, { draftId: null, draftRevision: null, status: 'unread', context: null, selection: {}, pagePosition: 'my-work', pending: undefined, writing: false, error: '' })
    changed()
  }
  async function open(draft: MasterDraft): Promise<void> {
    const token = ++generation
    Object.assign(state, { draftId: draft.id, draftRevision: draft.revision, status: 'loading', context: null, selection: {}, pagePosition: 'workbench', pending: undefined, writing: false, error: '' })
    changed()
    try {
      const context = await options.api.getRecordingWorkspaceContext(draft.id)
      if (!alive || token !== generation) return
      if (context && context.draftId !== draft.id) throw new Error('工作上下文与草稿身份不一致')
      state.context = context; state.selection = { ...(context?.selection ?? {}) }; state.pagePosition = context?.pagePosition ?? 'workbench'; state.status = 'ready'
    } catch {
      if (!alive || token !== generation) return
      state.status = 'error'; state.error = '工作上下文读取失败，本次选择和页面位置尚未确认保存。请重新读取。'
    }
    changed()
  }
  function buildRequest(): PutRecordingWorkspaceContextRequest | undefined {
    if (!state.draftId || !state.draftRevision || state.status !== 'ready') return undefined
    return { commandId: crypto.randomUUID(), draftId: state.draftId, expectedDraftRevision: state.draftRevision, expectedContextRevision: state.context?.contextRevision ?? 0, selection: { ...state.selection }, pagePosition: state.pagePosition }
  }
  async function perform(request: PutRecordingWorkspaceContextRequest): Promise<void> {
    const token = generation
    state.pending = request; state.writing = true; state.error = ''; changed()
    try {
      const context = await options.api.putRecordingWorkspaceContext(request)
      if (!alive || token !== generation || state.draftId !== request.draftId) return
      if (context.draftId !== request.draftId || context.draftRevision !== request.expectedDraftRevision
        || context.contextRevision !== request.expectedContextRevision + 1 || !same(context.selection, request.selection)
        || context.pagePosition !== request.pagePosition) throw new Error('工作上下文回执身份不一致')
      state.context = context; state.pending = undefined; state.status = 'ready'
    } catch {
      if (!alive || token !== generation) return
      state.status = 'error'; state.error = '本次工作位置或版本选择尚未保存；草稿和历史没有因此改变。请重试原操作或重新读取工作库。'
    } finally {
      if (alive && token === generation) { state.writing = false; changed() }
    }
  }
  async function flush(): Promise<void> {
    if (!alive || state.status !== 'ready') return
    if (inFlight) {
      queued = true
      const earlier = inFlight, ownerGeneration = generation, ownerDraftId = state.draftId
      await earlier
      // 上一份草稿的迟到回执不能吞掉新草稿的显式选择。
      if (alive && generation === ownerGeneration && state.draftId === ownerDraftId && state.status === 'ready' && hasChanges()) await flush()
      return
    }
    const ownerGeneration = generation, ownerDraftId = state.draftId
    const run = async () => {
      do {
        if (generation !== ownerGeneration || state.draftId !== ownerDraftId) break
        queued = false
        if (!hasChanges()) break
        const request = buildRequest()
        if (!request) break
        await perform(request)
      } while (alive && generation === ownerGeneration && state.draftId === ownerDraftId && state.status === 'ready' && (queued || hasChanges()))
    }
    inFlight = run()
    try { await inFlight } finally { inFlight = undefined }
  }
  return {
    state,
    open,
    async choose(patch: Partial<RecordingWorkspaceSelection>): Promise<void> { if (state.status !== 'ready') return; state.selection = patchWorkspaceSelection(state.selection, patch); changed(); await flush() },
    async navigate(pagePosition: RecordingWorkspacePagePosition): Promise<void> { if (state.status !== 'ready') return; state.pagePosition = pagePosition; changed(); await flush() },
    async retry(): Promise<void> {
      if (!state.pending || state.writing || !alive) return
      const request = state.pending
      await perform(request)
      if (state.status === 'ready' && hasChanges()) await flush()
    },
    async reread(draft: MasterDraft): Promise<void> { await open(draft) },
    reset,
    dispose(): void { alive = false; generation++ },
  }
}
