import { constants } from 'node:fs'
import { open, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isCollectionReadonlySettings, type CollectionReadonlySettings, type CollectionRefreshResult } from '@music-bridge/contracts'
import { CollectionReadonlyControlError } from './collection-readonly-control-protocol.js'

export interface CollectionReadonlyControl {
  getStatus(): Promise<CollectionReadonlySettings>
  setEnabled(enabled: boolean): Promise<CollectionReadonlySettings>
  refresh(): Promise<{ refreshed: boolean; status: CollectionReadonlySettings }>
  close(): void
}
const off = (): CollectionReadonlySettings => ({ schemaVersion: 1, enabled: false, mode: 'node', state: 'off' })

/** 固定 Main 文件，读取拒绝别名/大文件；坏配置只恢复安全默认。 */
export async function readCollectionReadonlyPreference(file: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size > 4096 || info.nlink !== 1) return false
    const bytes = Buffer.alloc(4097), read = await handle.read(bytes, 0, bytes.length, 0)
    if (read.bytesRead > 4096) return false
    const value: unknown = JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const keys = Reflect.ownKeys(value)
    return keys.length === 2 && keys.includes('schemaVersion') && keys.includes('enabled')
      && (value as { schemaVersion?: unknown }).schemaVersion === 1 && (value as { enabled?: unknown }).enabled === true
  } catch { return false } finally { await handle?.close().catch(() => {}) }
}
export async function writeCollectionReadonlyPreference(file: string, enabled: boolean): Promise<void> {
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, enabled }) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally { await unlink(temporary).catch(() => {}) }
}

/** 保存串行，但控制不等待旧 ON；成功保存顺序才是持久意图顺序。 */
export function createCollectionReadonlySettings(options: {
  file: string
  read?: typeof readCollectionReadonlyPreference
  write?: typeof writeCollectionReadonlyPreference
}) {
  let enabled = false, revision = 0, operation = 0, readSequence = 0
  let status = off(), control: CollectionReadonlyControl | undefined
  let saving: Promise<void> = Promise.resolve()
  let refreshFlight: { control: CollectionReadonlyControl; revision: number; promise: Promise<CollectionRefreshResult> } | undefined
  const snapshot = (): CollectionReadonlySettings => ({ ...status, enabled })
  const unavailable = (error?: unknown): void => {
    const blocked = error instanceof CollectionReadonlyControlError && error.code === 'RUST_BLOCKED'
    status = { schemaVersion: 1, enabled, mode: 'node', state: blocked ? 'blocked' : enabled ? 'failed' : 'off', ...(blocked ? { errorCode: 'RUST_BLOCKED' as const } : enabled ? { errorCode: 'RUST_UNAVAILABLE' as const } : {}) }
  }
  function accept(value: CollectionReadonlySettings, expected: CollectionReadonlyControl, ownRevision: number, ownOperation: number): boolean {
    if (control !== expected || ownRevision !== revision || ownOperation !== operation || !isCollectionReadonlySettings(value) || value.enabled !== enabled) return false
    status = { ...value }; return true
  }
  async function apply(expected: CollectionReadonlyControl, ownRevision: number): Promise<CollectionReadonlySettings> {
    const ownOperation = ++operation, intent = enabled
    status = { schemaVersion: 1, enabled, mode: 'node', state: intent ? 'enabling' : 'closing' }
    try { if (accept(await expected.setEnabled(intent), expected, ownRevision, ownOperation)) operation++ }
    catch (error) { if (control === expected && revision === ownRevision && operation === ownOperation) { unavailable(error); operation++ } }
    return snapshot()
  }
  return {
    snapshot,
    async restore(): Promise<void> { enabled = await (options.read ?? readCollectionReadonlyPreference)(options.file); revision++; unavailable() },
    attach(next: CollectionReadonlyControl): void {
      control?.close(); control = next; operation++; unavailable()
      // 默认关闭只持有轻量通道，不发送启用或刷新。
      if (enabled) void apply(next, revision)
    },
    detach(): void { control?.close(); control = undefined; operation++; unavailable() },
    async get(): Promise<CollectionReadonlySettings> {
      const expected = control, ownRevision = revision, ownOperation = operation, ownRead = ++readSequence
      if (expected) {
        try { const result = await expected.getStatus(); if (ownRead === readSequence) accept(result, expected, ownRevision, ownOperation) }
        catch (error) { if (ownRead === readSequence && expected === control && revision === ownRevision && operation === ownOperation) unavailable(error) }
      }
      return snapshot()
    },
    async set(value: boolean): Promise<CollectionReadonlySettings> {
      if (typeof value !== 'boolean') throw new Error('收藏查询偏好必须为boolean。')
      const persisted = saving.catch(() => {}).then(async () => {
        await (options.write ?? writeCollectionReadonlyPreference)(options.file, value)
        enabled = value; revision++; return revision
      })
      saving = persisted.then(() => {}, () => {})
      const ownRevision = await persisted
      const expected = control
      if (ownRevision !== revision) return snapshot()
      if (!expected) { unavailable(); return snapshot() }
      return apply(expected, ownRevision)
    },
    refresh(): Promise<CollectionRefreshResult> {
      if (refreshFlight && refreshFlight.control === control && refreshFlight.revision === revision) return refreshFlight.promise
      const expected = control, ownRevision = revision, ownOperation = ++operation
      if (!expected) { unavailable(); return Promise.resolve({ schemaVersion: 1, refreshed: false, settings: snapshot() }) }
      const work = (async (): Promise<CollectionRefreshResult> => {
        try {
          const result = await expected.refresh()
          const accepted = accept(result.status, expected, ownRevision, ownOperation)
          if (accepted) operation++
          return { schemaVersion: 1, refreshed: accepted && result.refreshed && status.mode === 'rust' && status.state === 'ready', settings: snapshot() }
        } catch (error) {
          if (expected === control && revision === ownRevision && operation === ownOperation) { unavailable(error); operation++ }
          return { schemaVersion: 1, refreshed: false, settings: snapshot() }
        }
      })()
      refreshFlight = { control: expected, revision: ownRevision, promise: work }
      void work.finally(() => { if (refreshFlight?.promise === work) refreshFlight = undefined }).catch(() => {})
      return work
    },
  }
}

/** 检查真实sender和闭集参数必须在任何偏好或控制副作用之前。 */
export function installCollectionReadonlyHandlers<Event>(options: {
  handle(channel: string, listener: (event: Event, ...args: unknown[]) => unknown): void
  requireTrusted(event: Event): unknown
  reject(): never
  settings: Pick<ReturnType<typeof createCollectionReadonlySettings>, 'get' | 'set' | 'refresh'>
}) {
  options.handle('collection:readonly-settings', (event, ...args) => { options.requireTrusted(event); if (args.length) return options.reject(); return options.settings.get() })
  options.handle('collection:set-readonly-enabled', (event, ...args) => { options.requireTrusted(event); if (args.length !== 1 || typeof args[0] !== 'boolean') return options.reject(); return options.settings.set(args[0]) })
  options.handle('collection:refresh', (event, ...args) => { options.requireTrusted(event); if (args.length) return options.reject(); return options.settings.refresh() })
}
