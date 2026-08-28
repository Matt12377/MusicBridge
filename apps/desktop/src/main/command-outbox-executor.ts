import type { OpenDialogOptions } from 'electron'
import {
  isCommandOutboxDispatchResult,
  isCommandOutboxExecute,
  isCommandOutboxRequest,
  isCommandOutboxResult,
  isRestoreActivationView,
  type CommandOutboxRequest,
} from '@music-bridge/contracts'
import type { CoreSupervisor } from './core-supervisor.js'
import type { StoredCommandOutboxEntry } from './command-outbox-store.js'

export type CommandOutboxPickOptions = Pick<OpenDialogOptions, 'title' | 'message' | 'properties' | 'filters' | 'defaultPath'>
type ExecutorSupervisor = Pick<CoreSupervisor, 'request' | 'requestInternal' | 'activateRestoredDataset'>

function fail(code: 'INVALID_IPC_REQUEST' | 'INVALID_IPC_RESPONSE' | 'OUTBOX_SCOPE_MISMATCH'): never {
  throw Object.assign(new Error(`操作恢复未完成。 [${code}]`), { code })
}

function capturedRequest(entry: StoredCommandOutboxEntry): CommandOutboxRequest {
  const request: unknown = structuredClone({ datasetId: entry.datasetId, command: entry.command, payload: entry.payload })
  if (!isCommandOutboxRequest(request) || request.payload.commandId !== entry.commandId) return fail('INVALID_IPC_REQUEST')
  return request
}

/** 只执行已持久确认的请求；目录路径仅在本次原生选择与私有 Core 请求间流动。 */
export function createCommandOutboxExecutor(options: {
  supervisor: ExecutorSupervisor
  pick: (options: CommandOutboxPickOptions) => Promise<{ canceled: boolean; filePaths: string[] }>
}) {
  const { supervisor } = options

  async function pick(dialogOptions: CommandOutboxPickOptions): Promise<string | null> {
    const selected = await options.pick(dialogOptions)
    return selected.canceled || !selected.filePaths[0] ? null : selected.filePaths[0]
  }

  async function executeRequest(request: CommandOutboxRequest): Promise<unknown> {
    if (isCommandOutboxExecute(request)) {
      const response = await supervisor.request('commandOutbox.execute', request)
      if (!isCommandOutboxResult(response) || response.command !== request.command) return fail('INVALID_IPC_RESPONSE')
      return response.result
    }
    const { datasetId } = await supervisor.request('commandOutbox.context', {})
    if (datasetId !== request.datasetId) return fail('OUTBOX_SCOPE_MISMATCH')
    const scope = request.datasetId
    switch (request.command) {
      case 'recordingSources.chooseRoot': {
        const prior = await supervisor.requestInternal('recordingSources.rootReceipt', request.payload, scope)
        if (prior.root) return prior.root
        const absolutePath = await pick({ title: '授权只读源目录', message: '只允许读取所选目录中的音频，不改写原件。可随时撤销授权。', properties: ['openDirectory'] })
        return absolutePath === null ? null : supervisor.requestInternal('recordingSources.authorize', { ...request.payload, absolutePath }, scope)
      }
      case 'recordingSources.choose': {
        const selection = request.payload
        const prior = await supervisor.request('recordingSources.job', { id: selection.commandId })
        // 由既有幂等 start 核对完整 selection；仅凭任务 ID 不能恢复改参请求。
        if (prior.job) return supervisor.requestInternal('recordingSources.start', { selection, absolutePath: '/already-selected' }, scope)
        const context = await supervisor.requestInternal('recordingSources.context', { id: selection.rootId }, scope)
        const absolutePath = await pick({ title: selection.relocateBindingId ? '重新定位相同内容' : '选择实际音频文件',
          message: '只能选择已授权目录内的普通文件。选择后只读校验，不会开始录音。', defaultPath: context.absolutePath,
          properties: ['openFile'], filters: [{ name: '无损源音频', extensions: ['wav', 'wave', 'flac', 'aiff', 'aif'] }] })
        return absolutePath === null ? null : supervisor.requestInternal('recordingSources.start', { selection, absolutePath }, scope)
      }
      case 'recordingPreparation.chooseDestination': {
        const prior = await supervisor.requestInternal('recordingPreparation.authorizationReceipt', request.payload, scope)
        if (prior.destination) return prior.destination
        const absolutePath = await pick({ title: '选择 Logic 工作区目标目录', message: '只在所选目录内新建独立工作区，不覆盖已有文件；不能选择音乐库源目录。', properties: ['openDirectory', 'createDirectory'] })
        return absolutePath === null ? null : supervisor.requestInternal('recordingPreparation.authorize', { ...request.payload, absolutePath }, scope)
      }
      case 'recordingPrepared.choose': {
        const prior = await supervisor.requestInternal('recordingPrepared.selectionReceipt', request.payload, scope)
        if (prior.selection) return prior.selection
        const absolutePath = await pick({ title: `选择 ${request.payload.side} 面原始 Render`, message: '只读取这一个 WAV；预览后须另行确认保存独立原始副本。不会授权扫描所在目录。',
          properties: ['openFile'], filters: [{ name: '原始 WAV', extensions: ['wav'] }] })
        return absolutePath === null ? null : supervisor.requestInternal('recordingPrepared.select', { ...request.payload, absolutePath }, scope)
      }
      case 'recordingArchive.choose': {
        const prior = await supervisor.requestInternal('recordingArchive.authorizationReceipt', request.payload, scope)
        if (prior.root) return prior.root
        const absolutePath = await pick({ title: '选择归档父目录', message: '本次选择不创建归档文件。返回后须明确确认初始化，再预览内容并确认归档；不能选择音乐库源目录。', properties: ['openDirectory'] })
        return absolutePath === null ? null : supervisor.requestInternal('recordingArchive.authorize', { ...request.payload, absolutePath }, scope)
      }
      case 'recordingBackups.choose': {
        const prior = await supervisor.requestInternal('recordingBackups.authorizationReceipt', request.payload, scope)
        if (prior.root) return prior.root
        const titles = { 'backup-destination': '选择备份目标目录', 'backup-source': '选择已有备份目录', 'restore-destination': '选择隔离恢复目标目录' }
        const absolutePath = await pick({ title: titles[request.payload.kind], message: '本次选择只记录目录授权，不创建或覆盖文件。备份和恢复需要在返回界面后单独确认。', properties: ['openDirectory'] })
        return absolutePath === null ? null : supervisor.requestInternal('recordingBackups.authorize', { ...request.payload, absolutePath }, scope)
      }
      case 'recordingBackups.activate':
        return supervisor.activateRestoredDataset(request.payload, scope)
      default:
        return fail('INVALID_IPC_REQUEST')
    }
  }

  return {
    async execute(entry: StoredCommandOutboxEntry): Promise<unknown> {
      const request = capturedRequest(entry)
      const result = await executeRequest(request)
      if (!isCommandOutboxDispatchResult({ command: request.command, result })) return fail('INVALID_IPC_RESPONSE')
      return result
    },
    async recoverAcrossDataset(entry: StoredCommandOutboxEntry): Promise<{ found: boolean; result?: unknown }> {
      const request = capturedRequest(entry)
      if (request.command !== 'recordingBackups.activate') return { found: false }
      // 唯一允许跨工作库的恢复路线：Core 按完整原请求核验持久回执，不进入激活执行。
      const { activation } = await supervisor.requestInternal('recordingBackups.activationReceipt', request.payload)
      if (activation === null) return { found: false }
      if (!isRestoreActivationView(activation) || activation.restoreJobId !== request.payload.restoreJobId) return fail('INVALID_IPC_RESPONSE')
      return ['active', 'superseded', 'failed', 'rolled-back'].includes(activation.state)
        ? { found: true, result: activation } : { found: false }
    },
  }
}
