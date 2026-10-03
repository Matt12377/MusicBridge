import childProcess from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, realpath, mkdir, mkdtemp, readFile, writeFile, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { types } from 'node:util'
import { StringDecoder } from 'node:string_decoder'

const externalRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
const kinds = new Set(['default-node', 'node-renderer', 'rust-renderer', 'pin-rejected'])
const prefix = 'RUST013_EVIDENCE '
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const inside = value => typeof value === 'string' && value.startsWith(externalRoot + '/') && path.resolve(value) === value && !value.includes('\0')
const eventFields = {
  'main.diagnosticsInstalled': [], 'main.channelCreated': [], 'main.diagnosticPortTransferred': [], 'main.coreReady': [], 'main.beforeQuit': [], 'main.willQuit': [], 'main.coreKill': [], 'main.diagnosticRejected': [], 'main.coreEvidenceOverflow': [], 'main.coreEvidenceRejected': [], 'main.observationRejected': [],
  'main.coreFork': ['entryPath', 'args'], 'main.coreSpawn': ['pid'], 'main.coreExit': ['code', 'pid'],
  'main.request': ['actionId', 'request', 'requestJsonBytes', 'requestSha256'], 'main.response': ['actionId', 'reply', 'requestId', 'command', 'durationMs', 'replyJsonBytes', 'replySha256'],
  'main.refreshRequested': ['ordinal'], 'main.refreshReply': ['reply'], 'main.probePhase': ['phase'], 'main.lifecycle': ['event', 'actionId'],
  'main.ipcRequest': ['actionId', 'invokeId', 'channel', 'args', 'sender'], 'main.ipcReply': ['actionId', 'invokeId', 'channel', 'result'], 'main.ipcRejected': ['actionId', 'invokeId', 'channel', 'code'],
  'main.profileValidated': ['profileDirectory', 'profileDev', 'profileIno', 'markerSha256', 'nonce'], 'main.window': ['webContentsId', 'rendererPid', 'frameUrl', 'visible', 'bounds'],
  'main.domAction': ['actionId', 'operation', 'control', 'mechanism', 'isTrusted'], 'main.domSettled': ['actionId', 'pollCount', 'elapsedMs', 'snapshot'], 'main.screenshot': ['actionId', 'path', 'sha256', 'bytes', 'width', 'height'],
  'main.rendererProbeComplete': ['phase', 'fixtureCount', 'fixtureSha256', 'commandIds', 'modelIds', 'policyModelId', 'policyRevision', 'nonce', 'completedMarkerSha256'], 'main.probeFailed': ['code'],
  'core.diagnosticsInstalled': ['mode'], 'core.diagnosticPortBound': [], 'core.diagnosticRejected': [], 'core.controllerDelivered': ['keys', 'frozen', 'status'], 'core.resourceValidated': ['binary', 'manifestSha256', 'manifest'],
  'core.publicRequest': ['request'], 'core.publicReply': ['reply', 'command'], 'core.ready': [], 'core.closedStatus': ['mode'], 'core.explicitRefreshStarted': ['ordinal', 'mode'], 'core.explicitRefreshCompleted': ['ordinal', 'mode'], 'core.explicitRefreshFailed': ['ordinal', 'mode'],
  'node.spawn': ['threadId', 'hostPid', 'entry'], 'node.exit': ['threadId', 'code'], 'node.prepare': [], 'node.prepared': ['identity'], 'node.boot': [], 'node.bootComplete': [], 'node.closeStarted': [], 'node.closeCompleted': [],
  'node.dispatch': ['request'], 'node.reply': ['requestId', 'command', 'result'], 'node.dispatchFailed': ['requestId', 'command'], 'node.snapshotVersion': ['version'], 'node.snapshotExport': ['epoch', 'datasetId', 'snapshotId', 'modelCount', 'modelsSha256'], 'node.versionedSnapshotExport': ['version', 'snapshotId', 'modelCount', 'modelsSha256'],
  'rust.spawn': ['pid', 'binary'], 'rust.request': ['pid', 'frame'], 'rust.validated-reply': ['pid', 'frame'], 'rust.exit': ['pid', 'code', 'signal', 'closeAcknowledged', 'pendingRequests'], 'rust.kill-request': ['pid', 'signal', 'reason'],
}
const withStatus = new Set(['core.publicRequest', 'core.publicReply', 'core.ready', 'core.closedStatus', 'core.explicitRefreshStarted', 'core.explicitRefreshCompleted'])
function noPrivateFields(value, depth = 0) {
  if (depth > 40) throw new Error('事件层级超限。')
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:credential|cookie|token|password|secret|authorization|stack)$/iu.test(key)) throw new Error('事件包含私有字段。')
    noPrivateFields(child, depth + 1)
  }
}
function safeEvent(value) {
  exact(value, ['schemaVersion', 'actor', 'sequence', 'elapsedMs', 'pid', 'event', 'data'])
  if (value.schemaVersion !== 1 || !['main', 'core'].includes(value.actor) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || !Number.isSafeInteger(value.pid) || value.pid < 1 || !Object.hasOwn(eventFields, value.event)) throw new Error('不合规诊断事件。')
  const keys = [...eventFields[value.event]]
  if (withStatus.has(value.event) && Object.hasOwn(value.data, 'status')) keys.push('status')
  if (value.event === 'main.domAction' && ['receive-save', 'detail-open'].includes(value.data.control)) keys.push('fixtureIndex')
  if (value.event === 'main.lifecycle' && Object.hasOwn(value.data, 'code')) keys.push('code')
  exact(value.data, keys); noPrivateFields(value.data)
  if (value.event === 'main.ipcRequest' && value.data.channel === 'commandOutbox:submit' && !['collection.receive', 'collection.setPolicy'].includes(value.data.args?.[0]?.request?.command)) throw new Error('候选观察不接受其他领域写入。')
  return value
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('运行参数不是闭集数据对象。')
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every(key => fields[key]?.enumerable && Object.hasOwn(fields[key], 'value'))) throw new Error('运行参数字段未准入。')
  return Object.fromEntries(keys.map(key => [key, fields[key].value]))
}
async function directoryIdentity(directory) {
  const identity = await lstat(directory, { bigint: true })
  if (!identity.isDirectory() || identity.isSymbolicLink() || await realpath(directory) !== directory || (identity.mode & 0o022n) !== 0n) throw new Error('外置目录真实身份无效。')
  return identity
}
async function safeRead(file, limit = 32 * 1024 * 1024) {
  if (!inside(file)) throw new Error('文件范围未准入。')
  const before = await lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit) || (before.mode & 0o022n) !== 0n || await realpath(file) !== file) throw new Error('文件真实身份无效。')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('文件读取身份变化。')
    const bytes = await handle.readFile(), after = await lstat(file, { bigint: true })
    if (['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some(key => before[key] !== after[key])) throw new Error('文件读取期间变化。')
    return bytes
  } finally { await handle.close() }
}
/** launch只用于外部profile管理，绝不传入应用作为动作/入口/路由选择器。 */
export async function validateRustPackagedRendererRunOptions(supplied) {
  const options = exact(supplied, ['executable', 'expectedExecutableSha256', 'evidenceDirectory', 'kind', 'launch'])
  if (!kinds.has(options.kind) || !validSha(options.expectedExecutableSha256) || !inside(options.executable) || !/\.app\/Contents\/MacOS\/[^/]+$/u.test(options.executable) || !inside(options.evidenceDirectory)) throw new Error('候选身份或外置证据范围无效。')
  const launchFields = Object.getOwnPropertyDescriptors(options.launch ?? {})
  const type = launchFields.type && Object.hasOwn(launchFields.type, 'value') ? launchFields.type.value : null
  const launch = exact(options.launch, type === 'fresh' ? ['type'] : ['type', 'priorReceiptPath', 'priorReceiptSha256'])
  if (type !== 'fresh' && type !== 'cold' || type === 'cold' && (!['node-renderer', 'rust-renderer'].includes(options.kind) || !inside(launch.priorReceiptPath) || !validSha(launch.priorReceiptSha256))) throw new Error('候选launch合同无效。')
  const volume = await directoryIdentity('/Volumes/LifeWeave'), temporary = await directoryIdentity(externalRoot)
  if (volume.dev !== temporary.dev) throw new Error('外置LifeWeave卷不可用。')
  const binary = await lstat(options.executable, { bigint: true })
  if ((binary.mode & 0o111n) === 0n || sha(await safeRead(options.executable, 1024 * 1024 * 1024)) !== options.expectedExecutableSha256) throw new Error('签后可执行文件身份变化。')
  let current = externalRoot
  for (const segment of path.relative(externalRoot, options.evidenceDirectory).split(path.sep)) {
    current = path.join(current, segment)
    try { await mkdir(current, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if ((await directoryIdentity(current)).dev !== temporary.dev) throw new Error('证据目录越过外置卷。')
  }
  return Object.freeze({ ...options, launch: Object.freeze(launch) })
}
function priorClosed(receipt, kind) {
  const events = receipt.events
  if (receipt.schemaVersion !== 1 || receipt.kind !== kind || receipt.launch?.type !== 'fresh' || receipt.completion !== 'closed' || receipt.mainExit?.code !== 0 || receipt.mainExit?.signal !== null || receipt.timedOut || receipt.forceKilled || receipt.parseErrors || receipt.startupFailed || !Array.isArray(events)) return false
  const seen = event => events.filter(value => value.event === event)
  const lifecycle = event => events.some(value => value.event === 'main.lifecycle' && value.data.event === event)
  if (seen('main.rendererProbeComplete').length !== 1 || seen('main.rendererProbeComplete')[0].data.phase !== 'fresh' || !lifecycle('outbox-close-end') || !lifecycle('will-quit') || lifecycle('outbox-close-timeout') || seen('main.coreKill').length || seen('rust.kill-request').length) return false
  if (seen('main.coreExit').length !== 1 || seen('main.coreExit')[0].data.code !== 0 || seen('node.exit').length !== 1 || seen('node.exit')[0].data.code !== 0 || seen('node.closeCompleted').length !== 1) return false
  return kind !== 'rust-renderer' || seen('rust.spawn').length === 3 && seen('rust.exit').length === 3 && seen('rust.exit').every(value => value.data.code === 0 && value.data.signal === null && value.data.closeAcknowledged === true && value.data.pendingRequests === 0)
}
async function profileIdentity(profileDirectory) {
  if (!inside(profileDirectory) || !/^musicbridge-(?:ui-diagnostics|task036-startup)-[A-Za-z0-9._-]+$/u.test(path.basename(profileDirectory))) throw new Error('profile范围无效。')
  const identity = await directoryIdentity(profileDirectory)
  if ((identity.mode & 0o077n) !== 0n) throw new Error('profile权限无效。')
  const markerPath = path.join(profileDirectory, 'rust013-profile.json'), markerBytes = await safeRead(markerPath, 1024), marker = exact(JSON.parse(markerBytes.toString()), ['schemaVersion', 'kind', 'nonce'])
  if (marker.schemaVersion !== 1 || marker.kind !== 'rust013-synthetic-profile' || !uuid(marker.nonce)) throw new Error('profile标记无效。')
  return { profileDev: String(identity.dev), profileIno: String(identity.ino), markerPath, markerSha256: sha(markerBytes), nonce: marker.nonce }
}
export async function runRustPackagedRendererCandidate(supplied) {
  const options = await validateRustPackagedRendererRunOptions(supplied)
  let tmpDirectory, profileDirectory, priorReceiptSha256 = null
  if (options.launch.type === 'fresh') {
    tmpDirectory = await mkdtemp(path.join(options.evidenceDirectory, 'runtime-tmp-'))
    profileDirectory = await mkdtemp(path.join(tmpDirectory, options.kind === 'default-node' ? 'musicbridge-task036-startup-' : 'musicbridge-ui-diagnostics-'))
    await writeFile(path.join(profileDirectory, 'rust013-profile.json'), JSON.stringify({ schemaVersion: 1, kind: 'rust013-synthetic-profile', nonce: randomUUID() }) + '\n', { flag: 'wx', mode: 0o600 })
  } else {
    const bytes = await safeRead(options.launch.priorReceiptPath), prior = JSON.parse(bytes.toString())
    if (sha(bytes) !== options.launch.priorReceiptSha256 || !priorClosed(prior, options.kind) || prior.executable !== options.executable || prior.executableSha256 !== options.expectedExecutableSha256 || prior.executableSha256After !== options.expectedExecutableSha256 || !inside(prior.tmpDirectory) || !inside(prior.profileDirectory) || !prior.profileDirectory.startsWith(prior.tmpDirectory + '/')) throw new Error('冷启前次实际自然关闭收据无效。')
    const identity = await profileIdentity(prior.profileDirectory)
    if (['profileDev', 'profileIno', 'markerSha256', 'nonce'].some(key => identity[key] !== prior[key])) throw new Error('冷启profile身份变化。')
    const completedBytes = await safeRead(path.join(prior.profileDirectory, 'rust013-completed.json'), 1024 * 1024), completed = JSON.parse(completedBytes.toString()), completion = prior.events.find(value => value.event === 'main.rendererProbeComplete').data
    if (sha(completedBytes) !== prior.completedMarkerSha256 || prior.completedMarkerSha256 !== completion.completedMarkerSha256 || completed.nonce !== identity.nonce || completed.fixtureSha256 !== completion.fixtureSha256 || !Array.isArray(completed.models) || completed.models.length !== 26 || !Array.isArray(completed.commandIds) || completed.commandIds.length !== 27) throw new Error('冷启完成标记未准入。')
    tmpDirectory = prior.tmpDirectory; profileDirectory = prior.profileDirectory; priorReceiptSha256 = sha(bytes)
  }
  const identity = await profileIdentity(profileDirectory), lockPath = path.join(profileDirectory, 'rust013-runtime.lock')
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await lock.writeFile(JSON.stringify({ schemaVersion: 1, nonce: identity.nonce }) + '\n')
    const environment = { TMPDIR: tmpDirectory, DEV_BUILD_ROOT: '/Volumes/LifeWeave/Developer/CommandLine', DEV_CACHE_ROOT: '/Volumes/LifeWeave/Developer/CommandLine/Caches', LANG: 'zh_CN.UTF-8' }
    if (options.kind === 'default-node') Object.assign(environment, { MUSIC_BRIDGE_STARTUP_TEST: '1', MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: profileDirectory })
    else Object.assign(environment, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profileDirectory })
    const launchId = randomUUID(), startedAt = new Date().toISOString(), events = [], raw = [], lifecycle = [], stdoutHash = createHash('sha256'), stderrHash = createHash('sha256'), decoder = new StringDecoder('utf8')
    let stdoutBytes = 0, stderrBytes = 0, buffer = '', parseErrors = 0, timedOut = false, forceKilled = false, spawnFailed = false, startupReady = false, startupFailed = false, stderrTail = ''
    const argv = ['--use-mock-keychain'], cwd = path.dirname(options.executable)
    const child = childProcess.spawn(options.executable, argv, { cwd, env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }), mainPid = child.pid ?? null
    const mainExit = await new Promise(resolve => {
      const timer = setTimeout(() => { timedOut = true; forceKilled = true; child.kill('SIGKILL') }, 240_000)
      child.once('error', () => { spawnFailed = true })
      child.stdout.on('data', chunk => {
        stdoutBytes += chunk.length; stdoutHash.update(chunk)
        if (stdoutBytes > 32 * 1024 * 1024) { forceKilled = true; child.kill('SIGKILL'); return }
        buffer += decoder.write(chunk)
        while (buffer.includes('\n')) {
          const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
          if (line === 'DESKTOP_STARTUP_READY') startupReady = true
          if (line === 'DESKTOP_STARTUP_FAIL') startupFailed = true
          if (line.startsWith(prefix)) {
            try {
              const value = safeEvent(JSON.parse(line.slice(prefix.length)))
              events.push(value); raw.push(line + '\n')
            } catch { parseErrors++ }
          } else if (line.startsWith('TASK078_LIFECYCLE ')) {
            try { const value = JSON.parse(line.slice('TASK078_LIFECYCLE '.length)); if (['bootstrap-start', 'data-prepared', 'core-spawn', 'core-ready-received', 'onready-complete', 'supervisor-ready', 'core-exit', 'ui-loaded', 'before-quit', 'print-stop-requested', 'print-stop-settled', 'print-stop-failed', 'remote-stop-start', 'remote-stop-end', 'core-shutdown-start', 'core-shutdown-end', 'outbox-close-start', 'outbox-close-end', 'outbox-close-timeout', 'app-quit-reissued', 'will-quit'].includes(value.phase)) lifecycle.push(value) } catch { parseErrors++ }
          }
        }
      })
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length; stderrHash.update(chunk)
        const marker = 'DESKTOP_STARTUP_FAIL', text = stderrTail + chunk.toString('utf8')
        if (text.includes(marker)) startupFailed = true
        stderrTail = text.slice(-(marker.length - 1))
      })
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    buffer += decoder.end(); if (buffer.startsWith(prefix)) parseErrors++
    const rawBytes = Buffer.from(raw.join('')), rawPath = path.join(options.evidenceDirectory, 'raw-evidence.jsonl')
    await writeFile(rawPath, rawBytes, { flag: 'wx', mode: 0o600 })
    let completedMarkerSha256 = null
    try { completedMarkerSha256 = sha(await safeRead(path.join(profileDirectory, 'rust013-completed.json'), 1024 * 1024)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const receipt = { schemaVersion: 1, ...options, launchId, executableSha256: options.expectedExecutableSha256, executableSha256After: sha(await safeRead(options.executable, 1024 * 1024 * 1024)), profileDirectory, tmpDirectory, ...identity, completedMarkerSha256, priorReceiptSha256, startedAt, mainPid,
      actualLaunch: { executable: options.executable, argv, cwd, env: environment }, events, lifecycle, rawEvidence: { path: rawPath, sha256: sha(rawBytes), bytes: rawBytes.length },
      mainExit, timedOut, forceKilled, parseErrors, stdoutSha256: stdoutHash.digest('hex'), stderrSha256: stderrHash.digest('hex'), stdoutBytes, stderrBytes, startupReady, startupFailed,
      completion: spawnFailed ? 'spawn-error' : timedOut ? 'timeout' : forceKilled ? 'forced-close' : 'closed' }
    await writeFile(path.join(options.evidenceDirectory, 'runtime-evidence.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return receipt
  } finally { await lock.close(); await unlink(lockPath) }
}
