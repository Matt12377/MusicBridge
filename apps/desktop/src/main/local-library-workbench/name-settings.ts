import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import type { CredentialVault } from '../credential-vault.js'
import type { LocalNameBackend, LocalNameConfiguration } from './providers/name-transport.js'

type Configuration = Omit<dto.LocalNameSettings, 'revision' | 'cloud'> & { cloud: dto.LocalNameModelSettings }
export interface LocalNameSettingsContext {
  signal: AbortSignal
  /** 实际 Main/Utility/Owner 身份围栏；系统输入阶段不持有 Owner 的 2000ms 请求。 */
  assertCurrent(): void | Promise<void>
}
export interface LocalNameSecurePrompt {
  /** 仅实际 Main 原生安全输入调用；正文不进入 Renderer、日志、环境或命令参数。 */
  readSecret(context: LocalNameSettingsContext): Promise<string | null>
  join(): Promise<void>
  close(): Promise<void>
}
export interface LocalNameSettingsOptions {
  file: string
  vault: Pick<CredentialVault, 'read' | 'save'>
  securePrompt: LocalNameSecurePrompt
}
type SaveRecord = { commandId: string; input: dto.LocalNameSettingsInput; result: dto.LocalNameSettings }
type SecurityRecord = { commandId: string; configurationSha256: string; state: 'pending' | 'configured' | 'cancelled' }
type State = { schemaVersion: 1; revision: string; configuration: Configuration; saves: SaveRecord[]; security: SecurityRecord[] }
type SecretEnvelope = { schemaVersion: 1; purpose: 'local-name-cloud'; commandId: string; configurationSha256: string; secret: string }
const MAX_STATE = 32 * 1024 * 1024, MAX_RECEIPTS = 1024
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
const copy = <T>(value: T): T => structuredClone(value)
const fail = (message: string): never => { throw new Error(message) }
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const closed = (value: unknown, keys: string[]): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const cloudFingerprint = (configuration: Configuration): string => digest(configuration.cloud)
const validSecret = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && Buffer.byteLength(value, 'utf8') <= 8192 && !/[\u0000\r\n]/u.test(value)
// 从原 CoverDrop AppSettings 读取的默认值；空 vLLM 模型保持未配置，不假定本机已安装模型。
const defaults = (): State => ({ schemaVersion: 1, revision: 'name-settings-default-v1', configuration: {
  backend: 'ollama', ollama: { endpoint: 'http://127.0.0.1:11434', model: 'qwen3.5:4b-mlx' },
  vllm: { endpoint: 'http://127.0.0.1:8000', model: '' }, cloud: { endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' },
}, saves: [], security: [] })
function configuration(input: dto.LocalNameSettingsInput): Configuration {
  return { backend: input.backend, ollama: copy(input.ollama), vllm: copy(input.vllm), cloud: copy(input.cloud) }
}
function validConfiguration(value: unknown, revision: unknown): value is Configuration {
  if (!closed(value, ['backend', 'ollama', 'vllm', 'cloud']) || !dto.isLocalWorkbenchIdentity(revision)) return false
  return dto.isLocalNameSettingsPayload('name.settings.save', { commandId: 'settings-cold-verify', settings: { ...value, expectedRevision: revision } })
}
function assertState(value: unknown): asserts value is State {
  if (!closed(value, ['schemaVersion', 'revision', 'configuration', 'saves', 'security']) || value.schemaVersion !== 1
    || !validConfiguration(value.configuration, value.revision) || !Array.isArray(value.saves) || !Array.isArray(value.security)
    || value.saves.length + value.security.length > MAX_RECEIPTS) return fail('名称设置原件身份或完整账本无效，请保留原件。')
  const ids = new Set<string>()
  let previousRevision = defaults().revision, previousConfiguration = defaults().configuration
  for (const item of value.saves) {
    if (!closed(item, ['commandId', 'input', 'result']) || !dto.isLocalNameSettingsPayload('name.settings.save', { commandId: item.commandId, settings: item.input })
      || !dto.isLocalNameSettingsResult('name.settings.save', item.result, { commandId: item.commandId as string, settings: item.input as dto.LocalNameSettingsInput })
      || ids.has(item.commandId as string)) return fail('名称设置原命令回执无效，请保留原件。')
    const saved = item as unknown as SaveRecord
    if (saved.input.expectedRevision !== previousRevision || saved.result.revision === previousRevision
      || digest(configuration(saved.input)) !== digest({ backend: saved.result.backend, ollama: saved.result.ollama,
        vllm: saved.result.vllm, cloud: { endpoint: saved.result.cloud.endpoint, model: saved.result.cloud.model } })) return fail('名称设置原命令 CAS 链不完整，请保留原件。')
    previousRevision = saved.result.revision; previousConfiguration = configuration(saved.input)
    ids.add(item.commandId as string)
  }
  for (const item of value.security) {
    if (!closed(item, ['commandId', 'configurationSha256', 'state']) || !dto.isLocalWorkbenchIdentity(item.commandId)
      || typeof item.configurationSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.configurationSha256)
      || !['pending', 'configured', 'cancelled'].includes(String(item.state)) || ids.has(item.commandId)) return fail('安全输入原命令回执无效，请保留原件。')
    ids.add(item.commandId)
  }
  if (value.revision !== previousRevision || digest(value.configuration) !== digest(previousConfiguration)) return fail('名称设置当前值与完整 CAS 链不一致，请保留原件。')
}
function decodeSecret(value: string): SecretEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!closed(parsed, ['schemaVersion', 'purpose', 'commandId', 'configurationSha256', 'secret']) || parsed.schemaVersion !== 1
      || parsed.purpose !== 'local-name-cloud' || !dto.isLocalWorkbenchIdentity(parsed.commandId)
      || typeof parsed.configurationSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(parsed.configurationSha256) || !validSecret(parsed.secret)) return null
    return parsed as unknown as SecretEnvelope
  } catch { return null }
}

/** 唯一 Main 作者的持久 CAS 与原命令账本；凭据只写原 safeStorage 保险库。 */
export function createLocalNameSettings(options: LocalNameSettingsOptions) {
  if (!path.isAbsolute(options.file) || path.basename(options.file) !== 'local-name-settings.json') return fail('名称设置必须使用 Main 固定私有文件。')
  let closing = false, serial: Promise<void> = Promise.resolve(), closure: Promise<void> | undefined
  const prompts = new Map<string, Promise<dto.LocalNameSettingsResults['name.settings.securityPrompt']>>()
  async function fence(context?: LocalNameSettingsContext): Promise<void> {
    if (closing || context?.signal.aborted) return fail('名称设置作者已关闭或原操作已取消。')
    await context?.assertCurrent()
    if (closing || context?.signal.aborted) return fail('名称设置原身份已撤销，请核对原命令。')
  }
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = serial.then(work)
    serial = result.then(() => undefined, () => undefined)
    return result
  }
  async function load(): Promise<State> {
    let fd: FileHandle | undefined
    try {
      fd = await open(options.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      const before = await fd.stat({ bigint: true })
      if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n || before.uid !== BigInt(process.getuid!())
        || before.size <= 0n || before.size > BigInt(MAX_STATE) || await realpath(options.file) !== options.file) return fail('名称设置文件身份或预算无效，请保留原件。')
      const bytes = Buffer.alloc(Number(before.size) + 1), read = await fd.read(bytes, 0, bytes.length, 0)
      const after = await fd.stat({ bigint: true }), named = await lstat(options.file, { bigint: true })
      if (read.bytesRead !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
        || named.dev !== before.dev || named.ino !== before.ino || named.nlink !== 1n) return fail('名称设置读取期间改变，请核对原件。')
      const state: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)))
      assertState(state); return state
    } catch (error) { if (absent(error) && !fd) return defaults(); return fail('名称设置无法完整冷回读，请保留原件。') }
    finally { await fd?.close() }
  }
  async function persist(next: State, previous: State, context?: LocalNameSettingsContext): Promise<void> {
    assertState(next)
    const bytes = Buffer.from(JSON.stringify(next) + '\n', 'utf8')
    if (bytes.length > MAX_STATE) return fail('名称设置完整账本已达预算，未截断原回执。')
    await fence(context)
    const directory = path.dirname(options.file), parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const temp = options.file + '.' + randomUUID() + '.new'; let temporary: FileHandle | undefined, created = false
    try {
      const parentStat = await parent.stat({ bigint: true })
      if (!parentStat.isDirectory() || await realpath(directory) !== directory) return fail('名称设置父目录身份无效。')
      if (digest(await load()) !== digest(previous)) return fail('名称设置发生并发变化，请读取当前设置。')
      temporary = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true
      await temporary.writeFile(bytes); await temporary.sync(); await temporary.close(); temporary = undefined
      await fence(context)
      const named = await lstat(directory, { bigint: true })
      if (named.dev !== parentStat.dev || named.ino !== parentStat.ino || digest(await load()) !== digest(previous)) return fail('名称设置原 CAS 或目录身份已改变。')
      await rename(temp, options.file); created = false; await parent.sync()
      if (digest(await load()) !== digest(next)) return fail('名称设置发布后的整件回读未确认，请核对原命令。')
    } finally { await temporary?.close(); if (created) await unlink(temp); await parent.close() }
  }
  async function secret(): Promise<SecretEnvelope | null> {
    const actual = await options.vault.read()
    return actual.status === 'configured' ? decodeSecret(actual.credential) : null
  }
  async function snapshot(state: State): Promise<dto.LocalNameSettings> {
    const stored = await secret()
    return { revision: state.revision, ...copy(state.configuration), cloud: { ...copy(state.configuration.cloud), keyConfigured: stored?.configurationSha256 === cloudFingerprint(state.configuration) } }
  }
  async function read(context?: LocalNameSettingsContext): Promise<dto.LocalNameSettings> {
    await fence(context); const state = await exclusive(load), result = await snapshot(state); await fence(context); return result
  }
  async function save(request: dto.LocalNameSettingsPayloads['name.settings.save'], context: LocalNameSettingsContext): Promise<dto.LocalNameSettings> {
    if (!dto.isLocalNameSettingsPayload('name.settings.save', request)) return fail('名称设置输入无效，请核对当前后端模型。')
    const original = copy(request)
    return exclusive(async () => {
      await fence(context); const before = await load(), saved = before.saves.find(item => item.commandId === original.commandId)
      if (saved) { if (digest(saved.input) !== digest(original.settings)) return fail('原设置命令正文不同，不能复用该命令。'); return copy(saved.result) }
      if (before.security.some(item => item.commandId === original.commandId) || before.saves.length + before.security.length >= MAX_RECEIPTS) return fail('原设置命令已使用或回执预算已满。')
      if (before.revision !== original.settings.expectedRevision) return fail('名称设置版本已改变，请读取当前设置。')
      const next: State = { ...before, revision: randomUUID(), configuration: configuration(original.settings) }
      const result = await snapshot(next)
      next.saves = [...before.saves, { commandId: original.commandId, input: original.settings, result }]
      await persist(next, before, context); return copy(result)
    })
  }
  async function recoverSecurity(commandId: string, currentSha: string, context: LocalNameSettingsContext): Promise<dto.LocalNameSettingsResults['name.settings.securityPrompt'] | null> {
    return exclusive(async () => {
      await fence(context); const before = await load(), record = before.security.find(item => item.commandId === commandId)
      if (!record) return null
      if (record.state === 'cancelled') return { configured: false, cancelled: true }
      if (record.state === 'configured') return { configured: true, cancelled: false }
      const actual = await secret()
      if (actual?.commandId !== commandId || actual.configurationSha256 !== record.configurationSha256) return fail('原安全输入结果未确认，不能重新弹窗或换命令重发。')
      if (record.state === 'pending') {
        const next = copy(before); next.security.find(item => item.commandId === commandId)!.state = 'configured'
        await persist(next, before, context)
      }
      return { configured: true, cancelled: false }
    })
  }
  function securityPrompt(request: dto.LocalNameSettingsPayloads['name.settings.securityPrompt'], context: LocalNameSettingsContext): Promise<dto.LocalNameSettingsResults['name.settings.securityPrompt']> {
    if (!dto.isLocalNameSettingsPayload('name.settings.securityPrompt', request)) return Promise.reject(new Error('本地安全输入命令无效。'))
    const existing = prompts.get(request.commandId); if (existing) return existing
    const commandId = request.commandId
    const work = (async () => {
      await fence(context); const initial = await exclusive(load), currentSha = cloudFingerprint(initial.configuration)
      const original = await recoverSecurity(commandId, currentSha, context); if (original) return original
      await exclusive(async () => {
        await fence(context); const before = await load()
        if (before.security.some(item => item.state === 'pending') || before.saves.some(item => item.commandId === commandId)
          || before.saves.length + before.security.length >= MAX_RECEIPTS || cloudFingerprint(before.configuration) !== currentSha) return fail('另一个安全输入尚未确认或配置已改变，请核对原命令。')
        await persist({ ...before, security: [...before.security, { commandId, configurationSha256: currentSha, state: 'pending' }] }, before, context)
      })
      let entered: string | null = null
      try {
        entered = await options.securePrompt.readSecret(context)
        await options.securePrompt.join(); await fence(context)
        const before = await exclusive(load)
        if (cloudFingerprint(before.configuration) !== currentSha) return fail('输入期间云端配置已改变，未保存该凭据。')
        if (entered !== null) {
          if (!validSecret(entered)) return fail('本地安全输入无效，未保存凭据。')
          const envelope: SecretEnvelope = { schemaVersion: 1, purpose: 'local-name-cloud', commandId, configurationSha256: currentSha, secret: entered }
          await options.vault.save(JSON.stringify(envelope)); entered = null
          // 真正保险库写入后保留原命令；晚到的取消不能把已写入结果改称取消。
          return await recoverSecurity(commandId, currentSha, context) ?? fail('原安全输入回执未确认。')
        }
        return await exclusive(async () => {
          await fence(context); const prior = await load(), next = copy(prior)
          const record = next.security.find(item => item.commandId === commandId)
          if (!record || record.state !== 'pending') return fail('原安全输入回执已改变。')
          record.state = 'cancelled'; await persist(next, prior, context); return { configured: false, cancelled: true }
        })
      } finally { entered = null; await options.securePrompt.join() }
    })()
    prompts.set(commandId, work)
    void work.then(() => prompts.delete(commandId), () => prompts.delete(commandId))
    return work
  }
  return {
    read, save, securityPrompt,
    async getConfiguration(backend: LocalNameBackend): Promise<LocalNameConfiguration | null> {
      if (closing) return null
      const state = await exclusive(load), selected = state.configuration[backend]
      if (!selected.model.trim()) return null
      return { baseUrl: selected.endpoint, model: selected.model, ...(backend === 'cloud' ? { requiresSecret: true } : {}) }
    },
    async resolveSecret(backend: LocalNameBackend, configured: LocalNameConfiguration, signal: AbortSignal): Promise<string | null> {
      if (closing || signal.aborted || backend !== 'cloud') return null
      const state = await exclusive(load), target = state.configuration.cloud
      if (target.endpoint !== configured.baseUrl || target.model !== configured.model) return null
      const actual = await secret()
      if (closing || signal.aborted || actual?.configurationSha256 !== cloudFingerprint(state.configuration)) return null
      return actual.secret
    },
    close(): Promise<void> {
      if (!closure) { closing = true; closure = (async () => { await options.securePrompt.close(); await Promise.allSettled([...prompts.values()]); await serial; await options.securePrompt.join() })() }
      return closure
    },
  }
}
