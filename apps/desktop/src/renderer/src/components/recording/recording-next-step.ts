import type {
  DraftSourceSnapshot, ExecutionHistory, FrozenPrepared, LayoutVersion, MasterDraft, MediaPlan,
  PreparationHistory, PreparedHistory, PreparationWorkspace, VersionHistory,
} from '@music-bridge/contracts'

export interface RecordingWorkflowFacts {
  sources: DraftSourceSnapshot
  plans: { draftId: string; plans: readonly MediaPlan[] }
  versions: VersionHistory
  preparations: PreparationHistory
  prepared: PreparedHistory
  execution: ExecutionHistory
}
/** 仅为本次 Renderer 工作上下文；不创建正式 RecordingPlan。 */
export interface RecordingWorkflowSelection {
  planId?: string
  layoutId?: string
  path?: 'direct' | 'logic' | 'prep'
  preparationId?: string
  preparedId?: string
}
export interface RecordingWorkflowState {
  draftId: string | null
  draftRevision: number | null
  status: 'unread' | 'loading' | 'ready' | 'error'
  facts?: RecordingWorkflowFacts
  selection: RecordingWorkflowSelection
  error: string
}
export type RecordingNextAction =
  | { type: 'retry-pending' | 'save-draft' | 'refresh' | 'pick-source' | 'media' | 'versions' | 'choose-context' | 'execution' }
  | { type: 'source'; trackId: string }
  | { type: 'preparation'; layoutId?: string }
  | { type: 'prepared'; preparationId?: string }
export interface RecordingNextStep {
  step: 1 | 2 | 3
  title: string
  description: string
  label: string
  action: RecordingNextAction
  disabled: boolean
  formalReady: false
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export const sameRecordingFact = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right)

/** IPC 已验证 DTO；此处再核对本次草稿及每条记录身份，拒绝异步串线。 */
export function recordingFactsMatchDraft(draft: MasterDraft, facts: RecordingWorkflowFacts): boolean {
  if (Object.values(facts).some(value => value.draftId !== draft.id)) return false
  const tracks = facts.sources.tracks
  if (tracks.length !== draft.tracks.length || new Set(tracks.map(track => track.trackId)).size !== tracks.length
    || tracks.some(track => !draft.tracks.some(value => value.id === track.trackId) || track.jobs.some(job => job.draftId !== draft.id || job.trackId !== track.trackId))) return false
  return [facts.plans.plans, facts.versions.masters, facts.versions.layouts, facts.versions.jobs, facts.preparations.workspaces,
    facts.preparations.jobs, facts.prepared.preps, facts.prepared.jobs, facts.execution.assets, facts.execution.jobs]
    .every(items => items.every(item => item.draftId === draft.id))
}

export function currentRecordingLayout(draft: MasterDraft, facts: RecordingWorkflowFacts, plan: MediaPlan, layout: LayoutVersion): boolean {
  if (plan.draftId !== draft.id || plan.draftRevision !== draft.revision || plan.requiresReview || plan.sourceBasis !== 'verified-sources'
    || !plan.reservation || layout.draftId !== draft.id || layout.planId !== plan.id
    || !sameRecordingFact(layout.spec, plan.spec) || !sameRecordingFact(layout.reservation, plan.reservation)) return false
  const master = facts.versions.masters.find(item => item.id === layout.masterVersionId)
  if (!master || master.draftId !== draft.id || master.content.programType !== draft.programType || master.content.tracks.length !== draft.tracks.length) return false
  return master.content.tracks.every((track, index) => {
    const saved = draft.tracks[index], source = facts.sources.tracks.find(value => value.trackId === track.trackId), binding = source?.binding
    const rule = plan.spec.rules.find(value => value.trackId === track.trackId)
    return saved?.id === track.trackId && sameRecordingFact(saved.metadata, track.metadata) && !!binding?.sourceLockEligible
      && binding.availability === 'ONLINE' && binding.userConfirmed && !source?.jobs.some(job => job.state === 'running')
      && binding.sha256 === track.source.sha256 && binding.size === track.source.size && sameRecordingFact(binding.technical, track.source.technical)
      && track.transitionAfterMs === (rule?.gapAfterMs ?? plan.spec.defaultGapMs) && track.keepWithNext === (rule?.keepWithNext ?? false)
  })
}
export function matchingPreparation(layout: LayoutVersion, preparation: PreparationWorkspace): boolean {
  return preparation.draftId === layout.draftId && preparation.layoutVersionId === layout.id && preparation.masterVersionId === layout.masterVersionId
}
export function matchingPrepared(facts: RecordingWorkflowFacts, layout: LayoutVersion, preparation: PreparationWorkspace, prepared: FrozenPrepared): boolean {
  const master = facts.versions.masters.find(value => value.id === layout.masterVersionId)
  return matchingPreparation(layout, preparation) && prepared.draftId === layout.draftId && prepared.preparationId === preparation.id
    && prepared.layoutVersionId === layout.id && prepared.masterVersionId === layout.masterVersionId && prepared.contentHash === master?.contentHash
    && prepared.plannedTimelineHash === layout.timelineHash && sameRecordingFact(prepared.plannedTimeline, layout.timeline)
    && ['MATCHED', 'ACCEPTED_VARIANCE'].includes(prepared.conformance.status)
}

export function recordingWorkflowChoices(facts: RecordingWorkflowFacts, selection: RecordingWorkflowSelection) {
  const layouts = facts.versions.layouts.filter(layout => layout.planId === selection.planId)
  const layout = layouts.find(value => value.id === selection.layoutId)
  const preparations = layout ? facts.preparations.workspaces.filter(value => matchingPreparation(layout, value)) : []
  const preparation = preparations.find(value => value.id === selection.preparationId)
  const prepared = layout && preparation ? facts.prepared.preps.filter(value => matchingPrepared(facts, layout, preparation, value)) : []
  return { plans: facts.plans.plans, layouts, preparations, prepared }
}

export function getRecordingNextStep(input: {
  draft?: MasterDraft; pending: boolean; dirty: boolean; busy: boolean; workflow: RecordingWorkflowState
}): RecordingNextStep {
  const { draft, workflow } = input
  const next = (step: 1 | 2 | 3, title: string, description: string, label: string, action: RecordingNextAction, disabled = input.busy): RecordingNextStep => ({ step, title, description, label, action, disabled, formalReady: false })
  if (input.pending) return next(1, '先核对原操作', '上次草稿操作尚未取得明确结果，请核对或重试同一操作，不创建替代命令。', '核对原草稿操作', { type: 'retry-pending' })
  if (input.dirty) return next(1, '先保存当前修改', '未保存的标题、节目类型或曲序不能与历史规划混用。也可以在草稿工具中撤销修改。', '保存当前草稿', { type: 'save-draft' })
  if (input.busy) return next(1, '草稿操作进行中', '等待当前操作取得明确结果。', '等待草稿操作', { type: 'refresh' }, true)
  if (!draft) return next(1, '先选择这一盘的音乐', '选曲只保存草稿，不播放、不锁定来源，也不预留磁带。', '为这一盘选择音乐', { type: 'pick-source' })
  if (workflow.status !== 'ready' || workflow.draftId !== draft.id || workflow.draftRevision !== draft.revision || !workflow.facts || !recordingFactsMatchDraft(draft, workflow.facts)) {
    return next(1, workflow.status === 'loading' ? '正在读取工作状态' : '工作状态尚未确认', workflow.status === 'error' ? workflow.error : '需读取当前草稿的源、规划和历史；未读取或读取失败不代表尚未配置。', '刷新工作状态', { type: 'refresh' }, workflow.status === 'loading')
  }
  const facts = workflow.facts, selected = workflow.selection
  if (!draft.tracks.length) return next(1, '草稿还没有曲目', '先选择音乐，再检查实际源文件。', '为当前草稿添加音乐', { type: 'pick-source' })
  const running = facts.sources.tracks.find(track => track.jobs.some(job => job.state === 'running'))
  if (running) return next(1, '源文件验证进行中', '源验证任务尚未结束，请在源文件面板查看结果；已有绑定不能覆盖运行中的任务。', '查看源验证任务', { type: 'source', trackId: running.trackId })
  for (const track of draft.tracks) {
    const binding = facts.sources.tracks.find(value => value.trackId === track.id)?.binding
    const availability = { SOURCE_ROOT_OFFLINE: '源目录离线', MISSING: '源文件缺失', CONTENT_CHANGED: '源文件内容已变化', REVOKED: '源目录授权已撤销', ONLINE: '源文件待确认' }
    if (!binding || !binding.sourceLockEligible || !binding.userConfirmed || binding.availability !== 'ONLINE' || !binding.technical.sampleFrames || binding.technical.frameEvidence !== 'container-declared') {
      return next(1, binding ? availability[binding.availability] : '需要实际源文件', `${track.metadata.title}：请绑定、校验并明确确认实际文件和帧数。Roon 或收藏关系不能代替源证据。`, '处理曲目源文件', { type: 'source', trackId: track.id })
    }
  }
  const plan = facts.plans.plans.find(value => value.id === selected.planId)
  if (!plan) return facts.plans.plans.length
    ? next(2, '选择本次媒体规划', '已有规划是历史集合，请明确选择本次继续哪一份。', '选择本次工作上下文', { type: 'choose-context' })
    : next(2, '为音乐规划介质', '计算分面并选择合适的磁带；浏览和计算不会自动预留库存。', '规划本次磁带与分面', { type: 'media' })
  if (plan.requiresReview || plan.draftRevision !== draft.revision || plan.sourceBasis !== 'verified-sources' || plan.layout.constraints.length) return next(2, '媒体规划需要复核', '草稿、源、分面输入或库存条件已变化，旧规划不能作为当前依据。', '复核本次媒体规划', { type: 'media' })
  if (!plan.reservation) return next(2, '本次规划尚未预留磁带', '只有明确确认后才预留实物；已有冻结布局不代表仍持有当前预留。', '为本次规划预留磁带', { type: 'media' })
  if (facts.versions.jobs.some(job => job.planId === plan.id && job.state === 'running')) return next(3, '母版冻结进行中', '请查看本次规划的冻结任务，不能用旧版本替代运行结果。', '查看母版冻结任务', { type: 'versions' })
  const layouts = facts.versions.layouts.filter(value => value.planId === plan.id && currentRecordingLayout(draft, facts, plan, value))
  const layout = facts.versions.layouts.find(value => value.id === selected.layoutId)
  if (!layout) return layouts.length
    ? next(3, '选择本次冻结布局', '明确选择与当前规划一致的布局；其关联母版一并确定。', '选择本次工作上下文', { type: 'choose-context' })
    : next(3, '确认母版与冻结布局', '需要与当前曲序、源内容、分面规格及预留一致的冻结版本。', '核对本次母版与布局', { type: 'versions' })
  if (!currentRecordingLayout(draft, facts, plan, layout)) return next(3, '所选冻结布局已不匹配', '所选布局的母版、当前源内容、规划规格或预留不一致。历史仍保留，请核对当前版本。', '核对本次母版与布局', { type: 'versions' })
  if (!selected.path) return next(3, '选择本次处理路径', '请明确选择 Direct、Logic 工作区或已有 PREP，不根据历史自动决定。', '选择本次工作上下文', { type: 'choose-context' })
  let preparedId: string | undefined
  if (selected.path !== 'direct') {
    const prepareAction: RecordingNextAction = { type: 'preparation', layoutId: layout.id }
    if (facts.preparations.jobs.some(job => job.layoutVersionId === layout.id && job.state === 'running')) return next(3, 'Logic 工作区准备进行中', '请查看所选布局对应的导出任务；导出完成不证明 Render 已验证。', '查看本次工作区任务', prepareAction)
    const preparations = facts.preparations.workspaces.filter(value => matchingPreparation(layout, value))
    const preparation = preparations.find(value => value.id === selected.preparationId)
    if (!preparation) return preparations.length && !selected.preparationId
      ? next(3, '选择本次 Logic 工作区', '请明确选择对应本次母版与布局的工作区。', '选择本次工作上下文', { type: 'choose-context' })
      : next(3, '需要对应的 Logic 工作区', '创建或核对所选布局的工作副本；不自动导出文件。', '处理本次 Logic 工作区', prepareAction)
    const preparedAction: RecordingNextAction = { type: 'prepared', preparationId: preparation.id }
    if (facts.prepared.jobs.some(job => job.preparationId === preparation.id && job.state === 'running')) return next(3, '原始 Render 导入进行中', '请查看本次工作区的导入结果，不把其他工作区的 PREP 当作本次结果。', '查看本次 Render 导入', preparedAction)
    const prepared = facts.prepared.preps.find(value => value.id === selected.preparedId)
    if (!prepared) return facts.prepared.preps.some(value => matchingPrepared(facts, layout, preparation, value))
      ? next(3, '选择本次 PREP 版本', '请明确选择经过独立验证、对应本次工作区和布局的 PREP。', '选择本次工作上下文', { type: 'choose-context' })
      : next(3, '需要核对原始 Render', '工作区导出不等于完成 PREP，请导入、核对并确认原始 Render。', '处理本次 Render 与 PREP', preparedAction)
    if (!matchingPrepared(facts, layout, preparation, prepared)) return next(3, '所选 PREP 谱系不匹配', 'PREP 的工作区、母版内容或规划时间线不一致，请重新核对。', '复核本次 PREP 版本', preparedAction)
    preparedId = prepared.id
  }
  const modeMatches = (mode: string) => selected.path === 'direct' ? ['direct', 'direct-converted'].includes(mode) : ['prepared-reference', 'prepared-derivative'].includes(mode)
  const runningExecution = facts.execution.jobs.some(job => job.layoutVersionId === layout.id && modeMatches(job.mode) && job.state === 'running')
  const published = facts.execution.assets.some(asset => asset.layoutVersionId === layout.id && asset.masterVersionId === layout.masterVersionId && modeMatches(asset.mode) && asset.preparedVersionId === preparedId)
  return next(3, runningExecution ? '执行资产准备进行中' : '检查本次执行参数与资产', `${runningExecution ? '请查看所选布局与路径的任务。' : published ? '已有对应发布历史，当前文件可用性仍需显式核验。' : '请在执行面板确认参数、目录与资产检查。'}正式预检仍待 TASK072 / F-01；这里不会开始正式录音。`, runningExecution ? '查看本次执行资产任务' : '检查本次执行资产', { type: 'execution' })
}
