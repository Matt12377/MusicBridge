import childProcess from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, realpath, mkdir, mkdtemp, readFile, writeFile, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { types } from 'node:util'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const externalRoot = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
export const COLLECTION_SCALE_KINDS = ['default-node', 'scale-0', 'scale-100', 'scale-2000', 'scale-2001', 'scale-5000', 'scale-5001']
export const COLLECTION_SCALE_PROFILE_PREFIXES = Object.freeze(Object.fromEntries(COLLECTION_SCALE_KINDS.map(kind => [kind, kind === 'default-node' ? 'musicbridge-task036-startup-' : 'musicbridge-ui-diagnostics-'])))
const kinds = new Set(COLLECTION_SCALE_KINDS)
const countFor = kind => kind === 'default-node' ? 0 : Number(kind.slice(6))
const prefix = 'RUST015_EVIDENCE '
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const inside = value => typeof value === 'string' && value.startsWith(externalRoot + '/') && path.resolve(value) === value && !value.includes('\0')
const eventFields = {"main.rendererIpcDrained":["scope","pendingCount","requestCount","replyCount","rejectedCount"],"main.domResetSkipped":["reason"],"main.domExecution":["actionId","durationMs","scope"],"main.supervisorLifecycle": ["event", "pid", "code", "reason", "attempt", "delayMs"], "main.diagnosticsInstalled": ["modelCount", "clock", "serialization"], "main.channelCreated": [], "main.coreFork": ["entryPath", "args"], "main.coreSpawn": ["pid"], "main.coreExit": ["code", "pid"], "main.request": ["actionId", "request", "requestJsonBytes", "requestSha256", "invokeId", "catalogOrdinal"], "main.response": ["actionId", "reply", "requestId", "command", "durationMs", "replyJsonBytes", "replySha256", "invokeId", "catalogOrdinal"], "main.lifecycle": ["event", "code", "durationMs"], "main.ipcRequest": ["actionId", "invokeId", "channel", "args", "sender", "catalogOrdinal"], "main.ipcReply": ["actionId", "invokeId", "channel", "result", "durationMs", "catalogOrdinal"], "main.ipcRejected": ["actionId", "invokeId", "channel", "code", "durationMs"], "main.profileValidated": ["directory", "nonce", "modelCount", "markerSha256", "seedReceiptSha256", "profileDev", "profileIno", "completedPath", "completedMarkerSha256", "phase"], "main.window": ["webContentsId", "rendererPid", "frameUrl", "visible", "bounds"], "main.domAction": ["actionId", "operation", "workload", "iteration", "mode", "mechanism", "isTrusted"], "main.domSettled": ["actionId", "pollCount", "durationMs", "scope", "snapshot", "settingsStatusSelection"], "main.rendererProbeComplete": ["phase", "modelCount", "commandIds", "outboxIds", "policyModelId", "policyRevision", "nonce", "completedMarkerSha256"], "main.probeFailed": ["code", "reason"], "main.warmSample": ["actionId", "workload", "iteration", "mode", "warmup", "reply", "selection"], "main.preferenceSaved": ["actionId", "enabled", "durationMs"], "main.preferenceRejected": ["actionId", "enabled", "durationMs"], "main.controlRequest": ["actionId", "request"], "main.controlReply": ["actionId", "requestId", "generationNonce", "response", "durationMs"], "main.controlClosed": ["pendingCount"], "main.closeCost": ["durationMs", "scope", "outboxCloseIncluded"], "core.diagnosticsInstalled": [], "core.publicPortObserved": [], "core.resourceValidated": ["binary", "manifestSha256", "manifest"], "core.publicRequest": ["request", "status"], "core.publicReply": ["reply", "requestId", "command", "durationMs", "status"], "core.ready": ["status"], "core.closedStatus": ["status"], "core.cost": ["stage", "durationMs", "outcome", "snapshotProfile", "requestId", "generation", "snapshotId", "datasetId", "epoch", "revision", "operation", "modelCount", "encodedBytes"], "node.spawn": ["threadId", "hostPid", "entry"], "node.exit": ["threadId", "code"], "node.prepare": [], "node.prepared": ["identity", "durationMs"], "node.boot": [], "node.bootComplete": ["durationMs"], "node.closeStarted": [], "node.closeCompleted": ["durationMs"], "node.closeRejected": ["durationMs"], "node.dispatch": ["request"], "node.reply": ["requestId", "command", "result", "durationMs"], "node.dispatchFailed": ["requestId", "command", "durationMs"], "node.largeSnapshotExport": [], "node.snapshotOperation": ["operation", "outcome", "durationMs", "value", "jsonBytes", "sha256"], "node.snapshotVersion": ["version"], "node.snapshotExport": ["epoch", "datasetId", "snapshotId", "modelCount", "modelsSha256"], "node.versionedSnapshotExport": ["version", "snapshotId", "modelCount", "modelsSha256"], "rust.spawn": ["pid", "binary"], "rust.request": ["pid", "frame"], "rust.validated-reply": ["pid", "frame"], "rust.exit": ["pid", "code", "signal", "closeAcknowledged", "pendingRequests"], "rust.kill-request": ["pid", "signal", "reason"], "renderer.diagnosticsInstalled": ["clock", "paintScope"], "renderer.actionContext": ["kind", "actionId", "operation", "workload", "iteration", "mode", "mechanism", "isTrusted"], "renderer.trigger": ["kind", "actionId", "operation", "workload", "iteration", "mode", "domEvent", "isTrusted", "target", "durationMs"], "renderer.begin": ["observationId", "action", "generation", "layer", "request", "actionId", "startScope", "triggerSequence", "triggerDomEvent", "catalogOrdinal"], "renderer.observationRejected": ["reason", "observationId", "actionId", "kind", "operation", "workload", "iteration", "mode", "layer", "generation", "request", "triggerSequence", "triggerDomEvent", "catalogOrdinal"], "renderer.invokeReply": ["observationId", "actionId", "kind", "operation", "workload", "iteration", "mode", "layer", "generation", "request", "durationMs", "result", "triggerSequence", "triggerDomEvent", "catalogOrdinal"], "renderer.invokeRejected": ["observationId", "actionId", "kind", "operation", "workload", "iteration", "mode", "layer", "generation", "request", "durationMs", "triggerSequence", "triggerDomEvent", "catalogOrdinal"], "renderer.commit": ["observationId", "actionId", "kind", "operation", "workload", "iteration", "mode", "layer", "generation", "request", "durationMs", "result", "triggerSequence", "triggerDomEvent", "catalogOrdinal"], "renderer.discarded": ["observationId", "actionId", "kind", "operation", "workload", "iteration", "mode", "layer", "generation", "request", "durationMs", "phase", "triggerSequence", "triggerDomEvent", "catalogOrdinal"], "renderer.nextTick": ["observationId", "actionId", "kind", "operation", "workload", "iteration", "mode", "layer", "generation", "request", "durationMs", "triggerSequence", "triggerDomEvent", "catalogOrdinal"], "renderer.paint": ["observationId", "actionId", "kind", "operation", "workload", "iteration", "mode", "layer", "generation", "request", "durationMs", "scope", "triggerSequence", "triggerDomEvent", "catalogOrdinal"], "main.coreReady": [], "main.beforeQuit": [], "main.willQuit": [], "main.coreKill": [], "main.coreEvidenceOverflow": [], "main.coreEvidenceRejected": ["reason", "rawBytes", "rawSha256", "rawLinePath", "rawSaved"], "main.observationRejected": [], "main.rendererEvidenceRejected": [], "core.observationRejected": []}
function noPrivateFields(value, depth = 0) {
  if (depth > 40) throw new Error('事件层级超限。')
  if (!value || typeof value !== 'object') return
  if (types.isProxy(value)) throw new Error("事件代理对象未准入。");
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor,"value")) throw new Error("事件访问器未准入。");
    const child = descriptor.value
    if (/^(?:credential|cookie|token|password|secret|authorization|stack)$/iu.test(key)) throw new Error('事件包含私有字段。')
    noPrivateFields(child, depth + 1)
  }
}
export function parseCollectionScaleEvent(value) {
  exact(value, ['schemaVersion', 'actor', 'sequence', 'elapsedMs', 'pid', 'event', 'data'])
  if (value.schemaVersion !== 1 || !['main', 'core', 'renderer'].includes(value.actor) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.event !== 'string' || !/^(?:main|core|node|rust|renderer)\.[a-zA-Z][a-zA-Z-]*$/u.test(value.event)) throw new Error('不合规规模事件。')
  if (!eventFields[value.event] || Object.keys(value.data).some(key=>!eventFields[value.event].includes(key))) throw new Error("事件字段未准入。");
  exact(value.data, Object.keys(value.data)); noPrivateFields(value.data)
  if(Object.hasOwn(value.data,'durationMs')&&(!Number.isFinite(value.data.durationMs)||value.data.durationMs<0)) throw new Error('阶段时长无效。');
  const actor=value.event.startsWith("renderer.")?"renderer":value.event.startsWith("main.")?"main":"core"; if(value.actor!==actor) throw new Error("事件actor不一致。");
  if (value.event === 'main.rendererIpcDrained') {
    const data=value.data;exact(data,['scope','pendingCount','requestCount','replyCount','rejectedCount'])
    if(data.scope!=='before-original-quit'||data.pendingCount!==0||data.rejectedCount!==0||!Number.isSafeInteger(data.requestCount)||data.requestCount<0||!Number.isSafeInteger(data.replyCount)||data.replyCount<0)throw new Error('原UI invoke收口观察字段无效。')
  }
  if (value.event === 'main.domSettled') {
    exact(value.data,['actionId','pollCount','durationMs','scope','snapshot','settingsStatusSelection'])
    const selection=value.data.settingsStatusSelection
    if(selection!==null){exact(selection,['observationId','generation','invokeId','requestId','paintRendererSequence']);if(typeof selection.observationId!=='string'||!selection.observationId||typeof selection.invokeId!=='string'||!selection.invokeId||!uuid(selection.requestId)||!Number.isSafeInteger(selection.generation)||selection.generation<1||!Number.isSafeInteger(selection.paintRendererSequence)||selection.paintRendererSequence<1)throw new Error('settings最新status观察身份无效。')}
  }
  if (value.event === 'main.coreEvidenceRejected') {
    const data=value.data;exact(data,['reason','rawBytes','rawSha256','rawLinePath','rawSaved'])
    if(!['INVALID_JSON','FORWARD_FAILED','INCOMPLETE_FRAGMENT'].includes(data.reason)||!Number.isSafeInteger(data.rawBytes)||data.rawBytes<0||data.rawBytes>16*1024*1024||!/^[a-f0-9]{64}$/u.test(data.rawSha256)||typeof data.rawSaved!=='boolean')throw new Error('Core拒绝原件字段不合规。')
    if(data.rawSaved){
      if(typeof data.rawLinePath!=='string'||!inside(data.rawLinePath)||path.normalize(data.rawLinePath)!==data.rawLinePath||!/^musicbridge-ui-diagnostics-[A-Za-z0-9._-]+$/u.test(path.basename(path.dirname(data.rawLinePath)))||!new RegExp(`^rust015-core-rejected-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}-${value.pid}-[1-4]\\.bin$`,'u').test(path.basename(data.rawLinePath)))throw new Error('Core拒绝原件路径未准入。')
    }else if(data.rawLinePath!==null)throw new Error('未保存的Core原件不得声明路径。')
  }
  if (value.event === 'main.warmSample') {
    exact(value.data,['actionId','workload','iteration','mode','warmup','reply','selection']); exact(value.data.selection,['finalSubmitRendererSequence','observationId','generation','catalogOrdinal','invokeId','requestId','paintRendererSequence'])
    for(const key of ['finalSubmitRendererSequence','generation','catalogOrdinal','paintRendererSequence'])if(!Number.isSafeInteger(value.data.selection[key])||value.data.selection[key]<1)throw new Error('暖样本私有观察身份无效。')
    for(const key of ['observationId','invokeId','requestId'])if(typeof value.data.selection[key]!=='string'||!value.data.selection[key])throw new Error('暖样本私有观察身份缺失。')
  }
  if (value.event === 'main.ipcRequest' && value.data.channel === 'commandOutbox:submit' && value.data.args?.[0]?.request?.command !== 'collection.setPolicy') throw new Error('规模候选仅允许原保护策略写入。')
  return value
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('运行参数不是闭集数据对象。')
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every(key => fields[key]?.enumerable && Object.hasOwn(fields[key], 'value'))) throw new Error('运行参数字段未准入。')
  return Object.fromEntries(keys.map(key => [key, fields[key].value]))
}
/** 保留真实零读，但不把它混入正RSS样本；不推断零读根因。 */
export function recordCollectionScaleRssReading(rss,reading) {
  exact(reading,['pid','elapsedMs','rssKiB','psStatus'])
  if(!Number.isSafeInteger(reading.pid)||reading.pid<1||!Number.isFinite(reading.elapsedMs)||reading.elapsedMs<0||reading.elapsedMs>600000||!Number.isSafeInteger(reading.rssKiB)||reading.rssKiB<0||reading.psStatus!==0)throw new Error('RSS原读数不合规。')
  if(reading.rssKiB===0)rss.zeroReadings.push(reading)
  else {const {psStatus,...sample}=reading;rss.samples.push(sample)}
}
async function directoryIdentity(directory) {
  const identity = await lstat(directory, { bigint: true })
  if (!identity.isDirectory() || identity.isSymbolicLink() || await realpath(directory) !== directory || (identity.mode & 0o022n) !== 0n) throw new Error('外置目录真实身份无效。')
  return identity
}
async function safeRead(file, limit = 512 * 1024 * 1024) {
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
export async function validateCollectionScaleRunOptions(supplied) {
  const options = exact(supplied, ['executable', 'expectedExecutableSha256', 'evidenceDirectory', 'kind', 'launch'])
  if (!kinds.has(options.kind) || !validSha(options.expectedExecutableSha256) || !inside(options.executable) || !/\.app\/Contents\/MacOS\/[^/]+$/u.test(options.executable) || !inside(options.evidenceDirectory)) throw new Error('候选身份或外置证据范围无效。')
  const launchFields = Object.getOwnPropertyDescriptors(options.launch ?? {})
  const type = launchFields.type && Object.hasOwn(launchFields.type, 'value') ? launchFields.type.value : null
  const launch = exact(options.launch, type === 'fresh' ? ['type'] : ['type', 'priorReceiptPath', 'priorReceiptSha256'])
  if (type !== 'fresh' && type !== 'cold' || type === 'cold' && (options.kind === 'default-node' || !inside(launch.priorReceiptPath) || !validSha(launch.priorReceiptSha256))) throw new Error('候选launch合同无效。')
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
export function collectionScalePriorClosed(receipt, kind) {
  if (receipt.schemaVersion !== 1 || receipt.kind !== kind || receipt.launch?.type !== 'fresh' || receipt.completion !== 'closed' || receipt.mainExit?.code !== 0 || receipt.mainExit?.signal !== null || receipt.timedOut || receipt.forceKilled || receipt.parseErrors || receipt.startupFailed || !Array.isArray(receipt.events)) return false
  const seen = name => receipt.events.filter(value => value.event === name)
  const lifecycle = name => receipt.events.some(value => value.event === 'main.lifecycle' && value.data.event === name)
  return seen('main.rendererProbeComplete').length === 1 && seen('main.rendererProbeComplete')[0].data.phase === 'fresh'
    && lifecycle('outbox-close-end') && lifecycle('will-quit') && !lifecycle('outbox-close-timeout')
    && seen('main.coreExit').length === 1 && seen('main.coreExit')[0].data.code === 0
    && seen('node.exit').length === 1 && seen('node.exit')[0].data.code === 0 && seen('node.closeCompleted').length === 1
    && !seen('main.coreKill').length && !seen('rust.kill-request').length
    && seen('rust.spawn').length === seen('rust.exit').length && seen('rust.exit').every(value => value.data.code === 0 && value.data.signal === null && value.data.closeAcknowledged === true && value.data.pendingRequests === 0)
}
async function profileIdentity(profileDirectory, kind) {
  if (!inside(profileDirectory) || !(kind === 'default-node' ? /^musicbridge-task036-startup-[A-Za-z0-9._-]+$/u : /^musicbridge-ui-diagnostics-[A-Za-z0-9._-]+$/u).test(path.basename(profileDirectory))) throw new Error('profile范围无效。')
  const identity = await directoryIdentity(profileDirectory)
  if ((identity.mode & 0o077n) !== 0n) throw new Error('profile权限无效。')
  const markerPath = path.join(profileDirectory, 'rust015-profile.json'), markerBytes = await safeRead(markerPath, 1024), marker = exact(JSON.parse(markerBytes.toString()), ['schemaVersion', 'kind', 'nonce', 'modelCount', 'seedReceipt'])
  if (marker.schemaVersion !== 1 || marker.kind !== 'rust015-synthetic-profile' || !uuid(marker.nonce) || ![0,100,2000,2001,5000,5001].includes(marker.modelCount)) throw new Error('profile标记无效。')
  exact(marker.seedReceipt, ['path', 'sha256']); if (marker.seedReceipt.path !== path.join(profileDirectory, 'rust015-seed.json') || !validSha(marker.seedReceipt.sha256) || sha(await safeRead(marker.seedReceipt.path)) !== marker.seedReceipt.sha256) throw new Error('seed收据身份变化。')
  return { modelCount: marker.modelCount, seedReceipt: marker.seedReceipt, profileDev: String(identity.dev), profileIno: String(identity.ino), markerPath, markerSha256: sha(markerBytes), nonce: marker.nonce }
}
export async function runCollectionScaleCandidate(supplied) {
  const options = await validateCollectionScaleRunOptions(supplied)
  let tmpDirectory, profileDirectory, priorReceiptSha256 = null, seedTool = null
  if (options.launch.type === 'fresh') {
    tmpDirectory = await mkdtemp(path.join(options.evidenceDirectory, 'runtime-tmp-'))
    profileDirectory = await mkdtemp(path.join(tmpDirectory, COLLECTION_SCALE_PROFILE_PREFIXES[options.kind]))
    const tool = fileURLToPath(new URL('./collection-scale-seed.ts', import.meta.url)), loader = fileURLToPath(import.meta.resolve('tsx'))
    const node = '/Users/yihe/.nvm/versions/node/v22.23.2/bin/node', nonce = randomUUID(), modelCount = countFor(options.kind)
    const argv = ['--import', loader, '--input-type=module', '--eval', `import {seedCollectionScaleProfile} from ${JSON.stringify(pathToFileURL(tool).href)}; seedCollectionScaleProfile(${JSON.stringify(profileDirectory)}, ${modelCount}, ${JSON.stringify(nonce)});`]
    const tick = performance.now(), sourceBytes = await readFile(tool), loaderBytes = await readFile(loader)
    const seeded = childProcess.spawnSync(node, argv, { cwd: path.dirname(tool), env: { TMPDIR: tmpDirectory, TSX_DISABLE_CACHE: '1' }, timeout: 120_000, encoding: null, maxBuffer: 2 * 1024 * 1024 })
    const toolLog = Buffer.concat([seeded.stdout ?? Buffer.alloc(0), seeded.stderr ?? Buffer.alloc(0)]), logPath = path.join(options.evidenceDirectory, 'seed-tool.log')
    await writeFile(logPath, toolLog, { flag: 'wx', mode: 0o600 })
    seedTool = { executable: node, argv, source: { path: tool, sha256: sha(sourceBytes), bytes: sourceBytes.length }, loader: { path: loader, sha256: sha(loaderBytes), bytes: loaderBytes.length }, exit: { code: seeded.status, signal: seeded.signal }, durationMs: performance.now() - tick, log: { path: logPath, sha256: sha(toolLog), bytes: toolLog.length } }
    if (seeded.status !== 0 || seeded.signal !== null || seeded.error || sha(await readFile(tool)) !== sha(sourceBytes) || sha(await readFile(loader)) !== sha(loaderBytes)) {
      await writeFile(path.join(options.evidenceDirectory, 'seed-failure.json'), JSON.stringify(seedTool, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); throw new Error('App启动前Node夹具seed失败。')
    }
    const seedPath = path.join(profileDirectory, 'rust015-seed.json'), seedBytes = await safeRead(seedPath)
    await writeFile(path.join(profileDirectory, 'rust015-profile.json'), JSON.stringify({ schemaVersion: 1, kind: 'rust015-synthetic-profile', nonce, modelCount, seedReceipt: { path: seedPath, sha256: sha(seedBytes) } }) + '\n', { flag: 'wx', mode: 0o600 })
  } else {
    const bytes = await safeRead(options.launch.priorReceiptPath), prior = JSON.parse(bytes.toString())
    if (sha(bytes) !== options.launch.priorReceiptSha256 || !collectionScalePriorClosed(prior, options.kind) || prior.executable !== options.executable || prior.executableSha256 !== options.expectedExecutableSha256 || prior.executableSha256After !== options.expectedExecutableSha256 || !inside(prior.tmpDirectory) || !inside(prior.profileDirectory) || !prior.profileDirectory.startsWith(prior.tmpDirectory + '/')) throw new Error('冷启前次实际自然关闭收据无效。')
    const identity = await profileIdentity(prior.profileDirectory, options.kind)
    if (['profileDev', 'profileIno', 'markerSha256', 'nonce'].some(key => identity[key] !== prior[key])) throw new Error('冷启profile身份变化。')
    const completedBytes = await safeRead(path.join(prior.profileDirectory, 'rust015-completed.json'), 1024 * 1024), completed = JSON.parse(completedBytes.toString()), completion = prior.events.find(value => value.event === 'main.rendererProbeComplete').data
    if (sha(completedBytes) !== prior.completedMarkerSha256 || prior.completedMarkerSha256 !== completion.completedMarkerSha256 || completed.nonce !== identity.nonce || completed.modelCount !== countFor(options.kind) || completed.kind !== 'rust015-completed-profile' || !Array.isArray(completed.commandIds) || completed.commandIds.length !== (countFor(options.kind) ? 1 : 0) || !Array.isArray(completed.outboxIds) || completed.outboxIds.length !== completed.commandIds.length) throw new Error('冷启完成标记未准入。')
    tmpDirectory = prior.tmpDirectory; profileDirectory = prior.profileDirectory; priorReceiptSha256 = sha(bytes)
  }
  const identity = await profileIdentity(profileDirectory, options.kind); if (identity.modelCount !== countFor(options.kind)) throw new Error('编译规模与profile事实期待错配。'); const lockPath = path.join(profileDirectory, 'rust015-runtime.lock')
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await lock.writeFile(JSON.stringify({ schemaVersion: 1, nonce: identity.nonce }) + '\n')
    const environment = { TMPDIR: tmpDirectory, DEV_BUILD_ROOT: '/Volumes/LifeWeave/Developer/CommandLine', DEV_CACHE_ROOT: '/Volumes/LifeWeave/Developer/CommandLine/Caches', LANG: 'zh_CN.UTF-8' }
    if (options.kind === 'default-node') Object.assign(environment, { MUSIC_BRIDGE_STARTUP_TEST: '1', MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: profileDirectory })
    else Object.assign(environment, { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: profileDirectory })
    const stdoutHandle = await open(path.join(options.evidenceDirectory, 'stdout.log'), 'wx', 0o600), stderrHandle = await open(path.join(options.evidenceDirectory, 'stderr.log'), 'wx', 0o600)
    let outputWrites = Promise.resolve(); const appendBytes=async(handle,bytes)=>{let offset=0;while(offset<bytes.length){const written=await handle.write(bytes,offset,bytes.length-offset);if(written.bytesWritten<=0)throw new Error('原stdout/stderr证据写入不完整。');offset+=written.bytesWritten}}
    const rss = { intervalMs: 100, scope: 'bounded-runtime-ps-sampling', clock: 'runtime-performance', samples: [], zeroReadings: [], errors: [] }, activePids = new Set(), runtimeTick = performance.now()
    const launchId = randomUUID(), startedAt = new Date().toISOString(), events = [], raw = [], lifecycle = [], stdoutHash = createHash('sha256'), stderrHash = createHash('sha256'), decoder = new StringDecoder('utf8')
    let stdoutBytes = 0, stderrBytes = 0, buffer = '', parseErrors = 0, timedOut = false, forceKilled = false, spawnFailed = false, startupReady = false, startupFailed = false, stderrTail = ''
    const argv = ['--use-mock-keychain'], cwd = path.dirname(options.executable)
    const child = childProcess.spawn(options.executable, argv, { cwd, env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }), mainPid = child.pid ?? null
    if (mainPid) activePids.add(mainPid)
    const rssTimer = setInterval(() => { for (const pid of activePids) { const p = childProcess.spawnSync('/bin/ps', ['-p', String(pid), '-o', 'rss='], { encoding: 'utf8', timeout: 1000 }); if (p.status === 0 && /^\s*\d+\s*$/u.test(p.stdout)) { try { recordCollectionScaleRssReading(rss,{pid,elapsedMs:performance.now()-runtimeTick,rssKiB:Number(p.stdout.trim()),psStatus:0}) } catch { rss.errors.push({pid,code:'PS_READING_REJECTED'}) } } else if (p.error) rss.errors.push({ pid, code: 'PS_FAILED' }); } }, 100)
    const mainExit = await new Promise(resolve => {
      const timer = setTimeout(() => { timedOut = true; forceKilled = true; child.kill('SIGKILL') }, 600_000)
      child.once('error', () => { spawnFailed = true })
      child.stdout.on('data', chunk => {
        stdoutBytes += chunk.length; stdoutHash.update(chunk); outputWrites = outputWrites.then(() => appendBytes(stdoutHandle,chunk))
        if (stdoutBytes > 512 * 1024 * 1024) { forceKilled = true; child.kill('SIGKILL'); return }
        buffer += decoder.write(chunk)
        while (buffer.includes('\n')) {
          const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
          if (line === 'DESKTOP_STARTUP_READY') startupReady = true
          if (line === 'DESKTOP_STARTUP_FAIL') startupFailed = true
          if (line.startsWith(prefix)) {
            try {
              const value = parseCollectionScaleEvent(JSON.parse(line.slice(prefix.length)))
              events.push(value); raw.push(line + '\n'); if (['main.coreSpawn','rust.spawn'].includes(value.event)) activePids.add(value.data.pid); if (['main.coreExit','rust.exit'].includes(value.event)) activePids.delete(value.data.pid)
            } catch { parseErrors++ }
          } else if (line.startsWith('TASK078_LIFECYCLE ')) {
            try { const value = JSON.parse(line.slice('TASK078_LIFECYCLE '.length)); if (['bootstrap-start', 'data-prepared', 'core-spawn', 'core-ready-received', 'onready-complete', 'supervisor-ready', 'core-exit', 'ui-loaded', 'before-quit', 'print-stop-requested', 'print-stop-settled', 'print-stop-failed', 'remote-stop-start', 'remote-stop-end', 'core-shutdown-start', 'core-shutdown-end', 'outbox-close-start', 'outbox-close-end', 'outbox-close-timeout', 'app-quit-reissued', 'will-quit'].includes(value.phase)) lifecycle.push(value) } catch { parseErrors++ }
          }
        }
      })
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length; stderrHash.update(chunk); outputWrites = outputWrites.then(() => appendBytes(stderrHandle,chunk))
        const marker = 'DESKTOP_STARTUP_FAIL', text = stderrTail + chunk.toString('utf8')
        if (text.includes(marker)) startupFailed = true
        stderrTail = text.slice(-(marker.length - 1))
      })
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    clearInterval(rssTimer); await outputWrites; await stdoutHandle.close(); await stderrHandle.close()
    buffer += decoder.end(); if (buffer.startsWith(prefix)) parseErrors++
    const rawBytes = Buffer.from(raw.join('')), rawPath = path.join(options.evidenceDirectory, 'raw-evidence.jsonl')
    await writeFile(rawPath, rawBytes, { flag: 'wx', mode: 0o600 })
    let completedMarkerSha256 = null
    try { completedMarkerSha256 = sha(await safeRead(path.join(profileDirectory, 'rust015-completed.json'), 1024 * 1024)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const receipt = { schemaVersion: 1, ...options, seedTool, rss, launchId, executableSha256: options.expectedExecutableSha256, executableSha256After: sha(await safeRead(options.executable, 1024 * 1024 * 1024)), profileDirectory, tmpDirectory, ...identity, completedMarkerSha256, priorReceiptSha256, startedAt, mainPid,
      actualLaunch: { executable: options.executable, argv, cwd, env: environment }, events, lifecycle, rawEvidence: { path: rawPath, sha256: sha(rawBytes), bytes: rawBytes.length },
      mainExit, timedOut, forceKilled, parseErrors, stdoutSha256: stdoutHash.digest('hex'), stderrSha256: stderrHash.digest('hex'), stdoutBytes, stderrBytes, streams: { stdout: { path: path.join(options.evidenceDirectory, 'stdout.log'), sha256: sha(await safeRead(path.join(options.evidenceDirectory, 'stdout.log'), 512*1024*1024)), bytes: stdoutBytes }, stderr: { path: path.join(options.evidenceDirectory, 'stderr.log'), sha256: sha(await safeRead(path.join(options.evidenceDirectory, 'stderr.log'), 512*1024*1024)), bytes: stderrBytes } }, startupReady, startupFailed,
      completion: spawnFailed ? 'spawn-error' : timedOut ? 'timeout' : forceKilled ? 'forced-close' : 'closed' }
    await writeFile(path.join(options.evidenceDirectory, 'runtime-evidence.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return receipt
  } finally { await lock.close(); await unlink(lockPath) }
}
