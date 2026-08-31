import type { CommandOutboxOverview, CommandOutboxPublicApi, CommandOutboxView } from '@music-bridge/contracts'
import { readPublicIpcErrorCode } from '../../roonLibraryMessages.js'

export interface CommandOutboxPanelState {
  overview: CommandOutboxOverview | null
  loading: boolean
  error: string | null
  itemErrors: Readonly<Record<string, string>>
  busyIds: readonly string[]
  notice: string | null
  pollingPaused: boolean
}

export function canRetryOutboxItem(item: CommandOutboxView, currentDatasetId: string | undefined): boolean {
  return currentDatasetId !== undefined && item.canRetry && !item.acknowledged
    && item.state !== 'sending' && item.state !== 'succeeded' && item.state !== 'dismissed'
    && (item.datasetId === currentDatasetId || item.command === 'recordingBackups.activate')
}

export function outboxErrorMessage(error: unknown): string {
  switch (readPublicIpcErrorCode(error)) {
    case 'NOT_READY':
    case 'CORE_UNAVAILABLE':
      return 'Core 暂时不可用。操作仍保留，请稍后刷新状态。'
    case 'INVENTORY_CONFLICT':
    case 'OUTBOX_CONFLICT':
    case 'BACKUP_CONFLICT':
      return '操作存在冲突。请核对业务记录；不会修改原命令来绕过冲突。'
    case 'DATASET_MISMATCH':
    case 'OUTBOX_DATASET_MISMATCH':
    case 'OUTBOX_SCOPE_MISMATCH':
      return '工作库已变化。请重新加载相关页面；旧工作库操作不能在当前工作库重试。'
    case 'INVALID_IPC_REQUEST':
      return '操作参数已不适用，请刷新状态并核对原业务记录。'
    default:
      return '暂时无法完成操作。原操作仍保留，请刷新状态后再决定是否重试。'
  }
}

export function createCommandOutboxController(options: {
  api: CommandOutboxPublicApi
  onChange?: (state: CommandOutboxPanelState) => void
  schedule?: (callback: () => void, delayMs: number) => number
  cancel?: (id: number) => void
  pollLimit?: number
}) {
  let state: CommandOutboxPanelState = { overview: null, loading: false, error: null, itemErrors: {}, busyIds: [], notice: null, pollingPaused: false }
  let active = false
  let revision = 0
  let timer: number | undefined
  let polls = 0
  let readFlight: Promise<void> | undefined
  const flights = new Map<string, { action: string; promise: Promise<void> }>()
  const schedule = options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs))
  const cancel = options.cancel ?? ((id) => window.clearTimeout(id))
  const pollLimit = Math.min(40, Math.max(0, options.pollLimit ?? 40))

  function update(patch: Partial<CommandOutboxPanelState>): void {
    if (!active) return
    state = { ...state, ...patch }
    options.onChange?.(state)
  }
  function stopTimer(): void {
    if (timer !== undefined) cancel(timer)
    timer = undefined
  }
  function queuePoll(): void {
    if (!active || timer !== undefined || flights.size > 0 || state.error) return
    const unsettled = state.overview?.entries.some((item) =>
      !item.acknowledged && ['pending', 'sending', 'uncertain'].includes(item.state))
    if (!unsettled) return
    if (polls >= pollLimit) { update({ pollingPaused: true }); return }
    timer = schedule(() => {
      timer = undefined
      polls++
      void refresh()
    }, 1500)
  }
  function refresh(): Promise<void> {
    if (!active) return Promise.resolve()
    if (readFlight) return readFlight
    stopTimer()
    const requestRevision = ++revision
    update({ loading: true })
    const promise = Promise.resolve().then(async () => {
      try {
        const overview = await options.api.getCommandOutbox()
        if (active && requestRevision === revision) update({ overview, error: null })
      } catch {
        if (active && requestRevision === revision) update({ error: '暂时无法读取待确认操作。保留的列表可能不是最新状态，请稍后刷新。' })
      } finally {
        if (requestRevision === revision) update({ loading: false })
        if (readFlight === promise) { readFlight = undefined; queuePoll() }
      }
    })
    readFlight = promise
    return promise
  }
  function itemError(id: string, message: string): void {
    update({ itemErrors: { ...state.itemErrors, [id]: message } })
  }
  function act(action: 'retry' | 'dismiss' | 'ack', id: string, confirmed = false): Promise<void> {
    if (!active) return Promise.resolve()
    const running = flights.get(id)
    if (running) return running.action === action ? running.promise : Promise.resolve()
    const item = state.overview?.entries.find((candidate) => candidate.id === id)
    if (!item || item.acknowledged || item.state === 'dismissed') return Promise.resolve()
    if (action !== 'ack' && !confirmed) {
      itemError(id, '请先勾选该操作的确认说明。')
      return Promise.resolve()
    }
    if (action === 'retry' && item.datasetId !== state.overview?.datasetId && item.command !== 'recordingBackups.activate') {
      itemError(id, '来源工作库与当前工作库不同。请重新加载相关页面；旧操作不能在当前工作库重试。')
      return Promise.resolve()
    }
    if (action === 'retry' && !canRetryOutboxItem(item, state.overview?.datasetId)) {
      itemError(id, '此操作当前不可重试，请刷新状态并核对业务结果。')
      return Promise.resolve()
    }
    if (action === 'ack' && item.state !== 'succeeded') return Promise.resolve()
    stopTimer()
    ++revision
    readFlight = undefined
    const itemErrors = { ...state.itemErrors }
    delete itemErrors[id]
    update({ itemErrors, busyIds: [...state.busyIds, id], notice: null, loading: false })
    const promise = Promise.resolve().then(async () => {
      try {
        const result = action === 'retry' ? await options.api.retryCommandOutbox({ id, userConfirmed: true })
          : action === 'dismiss' ? await options.api.dismissCommandOutbox({ id, userConfirmed: true })
          : await options.api.acknowledgeCommandOutbox({ id })
        if (!active) return
        if (result.id !== id) throw new Error('[INVALID_IPC_RESPONSE]')
        if (state.overview) update({ overview: {
          ...state.overview,
          entries: state.overview.entries.map((candidate) => candidate.id === id ? result : candidate),
        } })
        update({ notice: action === 'dismiss' ? '已放弃跟踪；这不等于撤销业务，已发生的变更仍保留。'
          : action === 'ack' ? '成功结果已确认，已从待确认列表隐藏。' : '已查询或重试原操作，请核对更新后的状态。' })
      } catch (error) {
        itemError(id, outboxErrorMessage(error))
      } finally {
        if (active) {
          ++revision
          readFlight = undefined
          await refresh()
        }
        flights.delete(id)
        update({ busyIds: state.busyIds.filter((busyId) => busyId !== id) })
        queuePoll()
      }
    })
    flights.set(id, { action, promise })
    return promise
  }
  return {
    get state() { return state },
    start(): Promise<void> { active = true; return refresh() },
    refresh,
    act,
    dispose(): void { active = false; ++revision; stopTimer() },
  }
}
