import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, readdirSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual, types } from 'node:util'
import { validateIpcRequest, validateIpcResponseForCommand, validateIpcInternalResponseForCommand, isCollectionId, isCollectionModel } from '@music-bridge/contracts'
import { filterCollectionSnapshot, projectCollectionFilter } from '../../../../packages/bridge-core/src/rust-core/collection-query.js'
import { PACKAGED_ROUTE_FILTER_MATRIX } from '../../src/main/packaged-route-main-probe.js'

const kinds = ['default-node', 'node-diagnostic', 'rust-diagnostic', 'pin-rejected'] as const
type Kind = typeof kinds[number]
const external = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const commit = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const reject = (): never => { throw Object.assign(new Error('包内路由证据未准入。'), { code: 'RUST_PACKAGED_ROUTE_EVIDENCE_REJECTED' }) }
function check(value: unknown): asserts value { if (!value) reject() }
function same(left: unknown, right: unknown) { check(isDeepStrictEqual(left, right)) }
function exact(value: any, keys: readonly string[]) { check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))) }
function onlyData(value: unknown, depth = 0, visiting = new Set<object>()): void {
  check(depth < 40)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { check(Number.isFinite(value)); return }
  check(typeof value === 'object' && value !== null && !types.isProxy(value))
  check(!visiting.has(value)); visiting.add(value)
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
  check(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null)
  check(Object.getOwnPropertySymbols(value).length === 0)
  const fields = Object.getOwnPropertyDescriptors(value)
  check(!array || Object.keys(fields).length === (value as unknown[]).length + 1)
  for (const [key, field] of Object.entries(fields)) {
    if (array && key === 'length') continue
    check(field.enumerable && Object.hasOwn(field, 'value') && (!array || /^(?:0|[1-9][0-9]*)$/u.test(key)))
    onlyData(field.value, depth + 1, visiting)
  }
  visiting.delete(value)
}
function externalPath(file: unknown): asserts file is string {
  check(typeof file === 'string' && file.startsWith(external + '/') && path.resolve(file) === file && file.length <= 1024 && !file.includes('\0'))
}
function bytesAt(file: unknown, limit = 64 * 1024 * 1024, executable = false) {
  externalPath(file); check(realpathSync(file) === file)
  const before = lstatSync(file, { bigint: true })
  check(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(limit)
    && (before.mode & 0o022n) === 0n && (!executable || (before.mode & 0o111n) !== 0n))
  const bytes = readFileSync(file), after = lstatSync(file, { bigint: true })
  check(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every(key => before[key as keyof typeof before] === after[key as keyof typeof after]))
  return bytes
}
function tree(directory: string) {
  const entries: any[] = []
  function visit(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = path.relative(directory, file).replaceAll(path.sep, '/'), info = lstatSync(file)
      if (info.isSymbolicLink()) { check(realpathSync(file).startsWith(directory + '/')); entries.push({ path: relative, kind: 'symlink', target: readlinkSync(file) }) }
      else if (info.isDirectory()) visit(file)
      else { check(info.isFile()); entries.push({ path: relative, kind: 'file', sha256: digest(readFileSync(file)), bytes: info.size, mode: info.mode & 0o777 }) }
    }
  }
  visit(directory); return entries
}

export interface RustPackagedRouteExpectedIdentity {
  sourceCommit: string
  sourceSha256: string
  packages: Record<Kind, any>
  runs: Record<Kind, { path: string; sha256: string }>
}
export interface RustPackagedRouteEvidenceReport {
  schemaVersion: 1; task: 'RUST-012'; state: 'PASS'; sourceCommit: string; sourceSha256: string
  packages: Record<Kind, any>; runs: Record<Kind, { receipt: any; evidence: { path: string; sha256: string } }>
  productionDefault: 'Node'; soleDatabaseWriter: 'Node'; candidateDiagnostics: 'COMPILE_TIME_ONLY'
  ownerAcceptance: 'NOT_RUN'; rendererAcceptance: 'NOT_RUN'; realServices: 'NOT_RUN'; installation: 'NOT_RUN'; push: 'NOT_RUN'
}
function packageFor(value: any, kind: Kind, sourceCommit: string) {
  exact(value, ['candidateIdentity', 'verification', 'compile'])
  const identity = value.candidateIdentity, verification = value.verification, compiled = value.compile
  exact(compiled, ['diagnostics', 'coreEntry', 'manifestPin', 'snapshotProfile'])
  check(compiled.diagnostics === (kind !== 'default-node'))
  check(compiled.coreEntry === (kind === 'default-node' ? 'core-entry.ts' : kind === 'node-diagnostic' ? 'packaged-node-core-entry.ts' : 'packaged-rust-core-entry.ts'))
  check(kind === 'default-node' || kind === 'node-diagnostic' ? compiled.manifestPin === null && compiled.snapshotProfile === null : sha(compiled.manifestPin) && compiled.snapshotProfile === 'v2-2000')
  exact(identity, ['appPath', 'resourcesDirectory', 'executable', 'executableSha256', 'manifestSha256', 'native', 'asar', 'fuses', 'infoPlistSha256', 'bundleCDHash', 'bundleFiles'])
  externalPath(identity.appPath); check(identity.appPath.endsWith('.app') && realpathSync(identity.appPath) === identity.appPath)
  check(identity.resourcesDirectory === path.join(identity.appPath, 'Contents/Resources') && path.dirname(identity.executable) === path.join(identity.appPath, 'Contents/MacOS'))
  check(digest(bytesAt(identity.executable, 64 * 1024 * 1024, true)) === identity.executableSha256)
  exact(identity.native, ['manifest', 'manifestSha256', 'binaryPath', 'binarySha256', 'cdHash'])
  check(identity.native.binaryPath === path.join(identity.resourcesDirectory, 'rust-core/darwin-arm64/bin/musicbridge-rust-core'))
  const manifestBytes = bytesAt(path.join(identity.resourcesDirectory, 'rust-core/darwin-arm64/manifest.json'), 64 * 1024)
  check(digest(manifestBytes) === identity.manifestSha256 && identity.native.manifestSha256 === identity.manifestSha256)
  same(JSON.parse(manifestBytes.toString()), identity.native.manifest)
  const manifest = identity.native.manifest, binary = bytesAt(identity.native.binaryPath, 64 * 1024 * 1024, true)
  exact(manifest, ['schemaVersion', 'kind', 'platform', 'arch', 'protocolVersion', 'source', 'binary'])
  exact(manifest.source, ['commit', 'sha256']); exact(manifest.binary, ['relativePath', 'sha256', 'size', 'cdHash'])
  check(manifest.schemaVersion === 1 && manifest.kind === 'musicbridge-rust-readonly-resource' && manifest.platform === 'darwin' && manifest.arch === 'arm64'
    && manifest.protocolVersion === 2 && manifest.source.commit === sourceCommit && sha(manifest.source.sha256)
    && manifest.binary.relativePath === 'bin/musicbridge-rust-core' && manifest.binary.size === binary.length && digest(binary) === manifest.binary.sha256
    && identity.native.binarySha256 === manifest.binary.sha256 && identity.native.cdHash === manifest.binary.cdHash
    && binary.length >= 32 && binary.readUInt32LE(0) === 0xfeedfacf && binary.readUInt32LE(4) === 0x0100000c)
  same(readdirSync(path.dirname(identity.native.binaryPath)), ['musicbridge-rust-core'])
  same(readdirSync(path.join(identity.resourcesDirectory, 'rust-core/darwin-arm64')).sort(), ['bin', 'manifest.json'])
  if (kind === 'rust-diagnostic') check(compiled.manifestPin === identity.manifestSha256)
  if (kind === 'pin-rejected') check(compiled.manifestPin !== identity.manifestSha256)
  exact(identity.asar, ['path', 'sha256', 'headerSha256', 'main', 'defaultEntries'])
  check(identity.asar.path === path.join(identity.resourcesDirectory, 'app.asar') && identity.asar.main === 'dist/main/index.js'
    && digest(bytesAt(identity.asar.path, 512 * 1024 * 1024)) === identity.asar.sha256 && sha(identity.asar.headerSha256))
  check(Array.isArray(identity.asar.defaultEntries) && identity.asar.defaultEntries.length === 2)
  identity.asar.defaultEntries.forEach((entry: any, at: number) => { exact(entry, ['path', 'sha256']); check(entry.path === ['dist/main/index.js', 'dist/main/core.js'][at] && sha(entry.sha256)) })
  check(digest(bytesAt(path.join(identity.appPath, 'Contents/Info.plist'), 1024 * 1024)) === identity.infoPlistSha256)
  same(tree(identity.appPath), identity.bundleFiles)
  exact(identity.fuses, ['version', '0', '1', '2', '3', '4', '5', '6', '7', '8'])
  check(identity.fuses.version === '1'); Object.entries({ 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49, 6: 48, 7: 48, 8: 49 }).forEach(([key, setting]) => check(identity.fuses[key] === setting))
  exact(verification, ['platform', 'arch', 'nativeSignature', 'bundleSignature', 'asarIntegrity'])
  check(verification.platform === 'darwin' && verification.arch === 'arm64')
  for (const [signature, cdHash] of [[verification.nativeSignature, identity.native.cdHash], [verification.bundleSignature, identity.bundleCDHash]]) {
    exact(signature, ['verified', 'adHoc', 'cdHash']); check(signature.verified === true && signature.adHoc === true && commit(cdHash) && signature.cdHash === cdHash)
  }
  same(verification.asarIntegrity, { algorithm: 'SHA256', hash: identity.asar.headerSha256 })
  return identity
}
const eventFields: Record<string, readonly string[]> = {
  'main.diagnosticsInstalled': [], 'main.channelCreated': [], 'main.diagnosticPortTransferred': [], 'main.coreReady': [],
  'main.beforeQuit': [], 'main.willQuit': [], 'main.coreKill': [], 'main.diagnosticRejected': [], 'main.coreEvidenceOverflow': [],
  'main.coreFork': ['entryPath', 'args'], 'main.coreSpawn': ['pid'], 'main.coreExit': ['code', 'pid'],
  'main.request': ['request'], 'main.response': ['reply'], 'main.refreshRequested': ['ordinal'], 'main.refreshReply': ['reply'],
  'main.probePhase': ['phase', 'datasetId'], 'main.probeComplete': ['datasetId', 'seedModels', 'finalModels', 'matrixRequests'],
  'core.diagnosticsInstalled': ['mode'], 'core.diagnosticPortBound': [], 'core.diagnosticRejected': [],
  'core.controllerDelivered': ['keys', 'frozen', 'status'], 'core.resourceValidated': ['binary', 'manifestSha256', 'manifest'],
  'core.publicRequest': ['request'], 'core.publicReply': ['reply', 'command'], 'core.ready': [], 'core.closedStatus': ['mode'],
  'core.explicitRefreshStarted': ['ordinal', 'mode'], 'core.explicitRefreshCompleted': ['ordinal', 'mode'], 'core.explicitRefreshFailed': ['ordinal', 'mode'],
  'node.spawn': ['threadId', 'hostPid', 'entry'], 'node.exit': ['threadId', 'code'], 'node.prepare': [], 'node.prepared': ['identity'],
  'node.boot': [], 'node.bootComplete': [], 'node.closeStarted': [], 'node.closeCompleted': [],
  'node.dispatch': ['request'], 'node.reply': ['requestId', 'command', 'result'], 'node.dispatchFailed': ['requestId', 'command'],
  'node.snapshotVersion': ['version'], 'node.snapshotExport': ['epoch', 'datasetId', 'snapshotId', 'modelCount', 'modelsSha256'],
  'node.versionedSnapshotExport': ['version', 'snapshotId', 'modelCount', 'modelsSha256'],
  'rust.spawn': ['pid', 'binary'], 'rust.request': ['pid', 'frame'], 'rust.validated-reply': ['pid', 'frame'],
  'rust.exit': ['pid', 'code', 'signal', 'closeAcknowledged', 'pendingRequests'], 'rust.kill-request': ['pid', 'signal', 'reason'],
}
const withStatus = new Set(['core.publicRequest', 'core.publicReply', 'core.ready', 'core.closedStatus', 'core.explicitRefreshStarted', 'core.explicitRefreshCompleted'])
function statusFor(value: any) {
  exact(value, Object.hasOwn(value, 'router') ? ['phase', 'router'] : ['phase'])
  check(['new', 'prepared', 'booting', 'ready', 'closed'].includes(value.phase))
  if (value.router) {
    const router = value.router, keys = ['phase', 'generation', 'epoch', 'datasetId']
    for (const key of ['snapshotId', 'revision']) if (Object.hasOwn(router, key)) keys.push(key)
    exact(router, keys); check(['node', 'refreshing', 'rust', 'stale', 'closed'].includes(router.phase) && Number.isSafeInteger(router.generation) && router.generation >= 0
      && isCollectionId(router.epoch) && typeof router.datasetId === 'string')
    if (router.snapshotId !== undefined) check(isCollectionId(router.snapshotId))
    if (router.revision !== undefined) check(isCollectionId(router.revision))
  }
}
function runtimeFor(run: any, expected: any, kind: Kind, identity: any) {
  exact(run, ['receipt', 'evidence']); exact(run.evidence, ['path', 'sha256']); exact(expected, ['path', 'sha256']); same(run.evidence, expected)
  check(sha(run.evidence.sha256)); const bytes = bytesAt(run.evidence.path, 32 * 1024 * 1024)
  check(digest(bytes) === run.evidence.sha256); same(JSON.parse(bytes.toString()), run.receipt)
  const value = run.receipt
  exact(value, ['schemaVersion', 'executable', 'expectedExecutableSha256', 'evidenceDirectory', 'kind', 'executableSha256', 'executableSha256After',
    'profileDirectory', 'tmpDirectory', 'startedAt', 'mainPid', 'events', 'mainExit', 'timedOut', 'forceKilled', 'parseErrors', 'stdoutSha256',
    'stderrSha256', 'stdoutBytes', 'stderrBytes', 'startupReady', 'startupFailed', 'completion'])
  check(value.schemaVersion === 1 && value.kind === kind && value.executable === identity.executable
    && value.expectedExecutableSha256 === identity.executableSha256 && value.executableSha256 === identity.executableSha256 && value.executableSha256After === identity.executableSha256)
  externalPath(value.evidenceDirectory); externalPath(value.tmpDirectory); externalPath(value.profileDirectory)
  check(run.evidence.path === path.join(value.evidenceDirectory, 'runtime-evidence.json') && path.dirname(value.tmpDirectory) === value.evidenceDirectory
    && path.basename(value.tmpDirectory).startsWith('runtime-tmp-') && path.dirname(value.profileDirectory) === value.tmpDirectory
    && path.basename(value.profileDirectory).startsWith(kind === 'default-node' ? 'musicbridge-task036-startup-' : 'musicbridge-ui-diagnostics-'))
  for (const directory of [value.evidenceDirectory, value.tmpDirectory, value.profileDirectory]) check(realpathSync(directory) === directory && lstatSync(directory).isDirectory())
  check(Number.isSafeInteger(value.mainPid) && value.mainPid > 0 && Number.isFinite(Date.parse(value.startedAt))
    && value.completion === 'closed' && value.timedOut === false && value.forceKilled === false && value.parseErrors === 0
    && sha(value.stdoutSha256) && sha(value.stderrSha256) && Number.isSafeInteger(value.stdoutBytes) && value.stdoutBytes > 0
    && Number.isSafeInteger(value.stderrBytes) && value.stderrBytes >= 0 && value.stdoutBytes <= 32 * 1024 * 1024)
  exact(value.mainExit, ['code', 'signal']); check(value.mainExit.signal === null)
  check(Array.isArray(value.events) && value.events.length < 10000)
  if (kind === 'default-node') { check(value.mainExit.code === 0 && value.startupReady === true && value.startupFailed === false); same(value.events, []); return value }
  check(value.startupReady === false && value.startupFailed === (kind === 'pin-rejected'))
  check(value.mainExit.code === (kind === 'pin-rejected' ? 1 : 0))
  const streams = new Map<string, { sequence: number; elapsedMs: number }>()
  for (const event of value.events) {
    exact(event, ['schemaVersion', 'actor', 'sequence', 'elapsedMs', 'pid', 'event', 'data'])
    check(event.schemaVersion === 1 && ['main', 'core'].includes(event.actor) && Number.isSafeInteger(event.pid) && event.pid > 0
      && Number.isSafeInteger(event.sequence) && event.sequence > 0 && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && typeof event.event === 'string')
    if (event.actor === 'main') check(event.pid === value.mainPid && event.event.startsWith('main.'))
    else check(!event.event.startsWith('main.'))
    const key = event.actor + ':' + event.pid, previous = streams.get(key)
    check(event.sequence === (previous?.sequence ?? 0) + 1 && event.elapsedMs >= (previous?.elapsedMs ?? 0)); streams.set(key, event)
    const required = eventFields[event.event]; check(required)
    const fields = [...required]
    if (withStatus.has(event.event) && Object.hasOwn(event.data, 'status')) { fields.push('status'); statusFor(event.data.status) }
    if (event.event === 'main.probePhase' && event.data.phase === 'write-fallback') fields.push('commandId')
    exact(event.data, fields)
  }
  return value
}
const entries = (events: any[], name: string) => events.filter(event => event.event === name)
function single(events: any[], name: string) { const found = entries(events, name); check(found.length === 1); return found[0] }
function envelope(request: any) { check(validateIpcRequest(request).ok && isCollectionId(request.id)) }
function replyFor(reply: any, request: any) {
  check(reply.id === request.id && reply.ok === true && (request.command === 'recordingPrintWorker.claim'
    ? validateIpcInternalResponseForCommand(reply, request.command).ok : validateIpcResponseForCommand(reply, request.command).ok))
  // 原Main的空租约轮询属于内部IPC；仅接受空租约，不扩展录音验收。
  if (request.command === 'recordingPrintWorker.claim') same(reply.result, { lease: null })
  exact(reply, ['version', 'id', 'ok', 'result'])
}
function diagnosticFor(runtime: any, identity: any, mode: 'node' | 'rust' | 'rejected') {
  const events = runtime.events, main = events.filter((event: any) => event.actor === 'main')
  single(main, 'main.diagnosticsInstalled')
  const spawns = entries(main, 'main.coreSpawn'), forks = entries(main, 'main.coreFork'), exits = entries(main, 'main.coreExit')
  check(spawns.length === (mode === 'rejected' ? 2 : 1) && forks.length === spawns.length && exits.length === spawns.length)
  check(new Set(spawns.map((event: any) => event.data.pid)).size === spawns.length)
  for (const fork of forks) { check(fork.data.entryPath === path.join(identity.resourcesDirectory, 'app.asar/dist/main/core.js')); same(fork.data.args, []) }
  const corePids = new Set(spawns.map((event: any) => event.data.pid))
  check(events.filter((event: any) => event.actor === 'core').every((event: any) => corePids.has(event.pid)))
  for (const spawn of spawns) {
    check(Number.isSafeInteger(spawn.data.pid) && spawn.data.pid > 0)
    const exit = exits.filter((event: any) => event.data.pid === spawn.data.pid); check(exit.length === 1 && exit[0].sequence > spawn.sequence)
    check(exit[0].data.code === (mode === 'rejected' ? 1 : 0))
    const core = events.filter((event: any) => event.actor === 'core' && event.pid === spawn.data.pid)
    check(single(core, 'core.diagnosticsInstalled').data.mode === (mode === 'node' ? 'node' : 'rust'))
    single(core, 'core.diagnosticPortBound')
  }
  if (mode === 'rejected') {
    check(!events.some((event: any) => /^(?:node\.|rust\.)/u.test(event.event) || ['core.resourceValidated', 'core.ready', 'main.coreReady', 'main.probeComplete', 'core.controllerDelivered'].includes(event.event)))
    return
  }
  check(!events.some((event: any) => ['main.coreKill', 'rust.kill-request', 'main.diagnosticRejected', 'main.coreEvidenceOverflow', 'core.diagnosticRejected', 'core.explicitRefreshFailed', 'node.dispatchFailed'].includes(event.event)))
  const core = events.filter((event: any) => event.actor === 'core'), pid = spawns[0].data.pid
  const worker = single(core, 'node.spawn'), workerExit = single(core, 'node.exit')
  check(worker.data.hostPid === pid && Number.isSafeInteger(worker.data.threadId) && worker.data.threadId > 0
    && worker.data.entry === pathToFileURL(path.join(identity.resourcesDirectory, 'app.asar/dist/main/dataset-owner.js')).href
    && workerExit.data.threadId === worker.data.threadId && workerExit.data.code === 0 && workerExit.sequence > worker.sequence)
  for (const name of ['node.prepare', 'node.prepared', 'node.boot', 'node.bootComplete', 'node.closeStarted', 'node.closeCompleted', 'core.ready', 'core.closedStatus']) single(core, name)
  const ownerIdentity = single(core, 'node.prepared').data.identity
  exact(ownerIdentity, ['epoch', 'datasetId']); check(isCollectionId(ownerIdentity.epoch) && typeof ownerIdentity.datasetId === 'string')
  for (const event of core) {
    if (event.data.status?.router) check(event.data.status.router.epoch === ownerIdentity.epoch && event.data.status.router.datasetId === ownerIdentity.datasetId)
    if (event.event === 'node.snapshotVersion' || event.event === 'node.versionedSnapshotExport') {
      exact(event.data.version, ['epoch', 'datasetId', 'revision'])
      check(event.data.version.epoch === ownerIdentity.epoch && event.data.version.datasetId === ownerIdentity.datasetId && isCollectionId(event.data.version.revision))
    }
  }
  check(single(core, 'node.prepare').sequence < single(core, 'node.prepared').sequence
    && single(core, 'node.prepared').sequence < single(core, 'node.boot').sequence && single(core, 'node.boot').sequence < single(core, 'node.bootComplete').sequence
    && single(core, 'node.bootComplete').sequence < single(core, 'core.ready').sequence
    && single(core, 'node.closeStarted').sequence < workerExit.sequence && workerExit.sequence < single(core, 'node.closeCompleted').sequence
    && single(core, 'node.closeCompleted').sequence < single(core, 'core.closedStatus').sequence)
  const completed = single(main, 'main.probeComplete')
  same(completed.data, { datasetId: ownerIdentity.datasetId, seedModels: 3, finalModels: 4, matrixRequests: 12 })
  const before = entries(main, 'main.beforeQuit'); check(before.length === 2)
  const will = single(main, 'main.willQuit')
  check(completed.sequence < before[0].sequence && before[0].sequence < exits[0].sequence && exits[0].sequence < before[1].sequence && before[1].sequence < will.sequence)
  const requests = entries(main, 'main.request'), responses = entries(main, 'main.response'), publicRequests = entries(core, 'core.publicRequest'), publicReplies = entries(core, 'core.publicReply')
  const requestIds = new Set<string>()
  for (const event of requests) {
    const request = event.data.request; envelope(request); check(!requestIds.has(request.id)); requestIds.add(request.id)
    const received = publicRequests.filter((entry: any) => entry.data.request.id === request.id)
    const returned = publicReplies.filter((entry: any) => entry.data.reply.id === request.id), delivered = responses.filter((entry: any) => entry.data.reply.id === request.id)
    check(received.length === 1 && returned.length === 1 && delivered.length === 1)
    same(received[0].data.request, request); check(returned[0].data.command === request.command && received[0].sequence < returned[0].sequence && event.sequence < delivered[0].sequence)
    replyFor(delivered[0].data.reply, request); same(returned[0].data.reply, delivered[0].data.reply)
    if (request.command !== 'core.shutdown') check(request.expectedDatasetId === undefined || request.expectedDatasetId === ownerIdentity.datasetId)
  }
  check(publicRequests.length === requests.length && publicReplies.length === responses.length && requests.length === responses.length)
  const lookup = (request: any) => responses.find((event: any) => event.data.reply.id === request.id).data.reply.result
  const nodeRequests = entries(core, 'node.dispatch'), nodeReplies = entries(core, 'node.reply')
  for (const event of nodeRequests) {
    const request = event.data.request; envelope(request)
    const sourceReply = nodeReplies.filter((reply: any) => reply.data.requestId === request.id)
    check(sourceReply.length === 1 && sourceReply[0].sequence > event.sequence && sourceReply[0].data.command === request.command)
    check(requestIds.has(request.id))
    const original = requests.find((entry: any) => entry.data.request.id === request.id).data.request
    // 原Rust router仅在缺省时填入既有Node身份；不是任意请求改写或另一次Main调用。
    same(request, mode === 'rust' && original.expectedDatasetId === undefined ? { ...original, expectedDatasetId: ownerIdentity.datasetId } : original)
    same(sourceReply[0].data.result, lookup(request))
  }
  check(nodeReplies.length === nodeRequests.length && new Set(nodeRequests.map((event: any) => event.data.request.id)).size === nodeRequests.length)
  const writes = requests.filter((event: any) => event.data.request.command === 'commandOutbox.execute')
  check(writes.length === 5)
  const names = ['Alpha 合成磁带', 'Beta 合成磁带', 'Gamma 合成 DAT', 'Delta 合成追加', 'Delta 合成追加']
  const descriptors = [
    { brand: '合成甲', name: names[0], edition: '诊断', year: 1991, format: 'cassette', tapeType: 'II', identification: 'verified' },
    { brand: '合成乙', name: names[1], edition: '诊断', year: null, format: 'cassette', tapeType: 'unknown', identification: 'unidentified' },
    { brand: 'Synthetic', name: names[2], edition: '诊断', year: 2001, format: 'dat', tapeType: 'dat', identification: 'verified' },
    { brand: '合成写后', name: names[3], edition: '诊断', year: 1995, format: 'cassette', tapeType: 'II', identification: 'verified' },
  ]
  writes.forEach((event: any, at: number) => {
    const request = event.data.request
    exact(request.payload, ['datasetId', 'command', 'payload']); check(request.payload.datasetId === ownerIdentity.datasetId && request.payload.command === 'collection.receive')
    const payload = request.payload.payload
    check(isCollectionId(payload.commandId) && payload.model.name === names[at] && payload.lengthMinutes === 60)
    same(payload.model, descriptors[Math.min(at, 3)])
    same(payload.quantities, { openedBlank: 1, sealedBlank: 0, legacyUsed: 0, unclassified: 0 })
    check(nodeRequests.some((entry: any) => entry.data.request.id === request.id))
  })
  check(new Set(writes.map((event: any) => event.data.request.payload.payload.commandId)).size === 4)
  same(writes[3].data.request.payload, writes[4].data.request.payload); same(lookup(writes[3].data.request), lookup(writes[4].data.request))
  const lists = requests.filter((event: any) => event.data.request.command === 'collection.list')
  check(lists.length === 16)
  // 各profile保留自己的随机ID：同profile的原Node回退是四型号完整DTO参照。
  const fallback = lookup(lists[13].data.request), replay = lookup(lists[14].data.request), resumed = lookup(lists[15].data.request)
  check(fallback.total === 4 && fallback.items.length === 4 && fallback.items.every(isCollectionModel)); same(fallback, replay); same(replay, resumed)
  const fullModels = fallback.items, seedModels = fullModels.filter((model: any) => model.name !== 'Delta 合成追加')
  check(seedModels.length === 3 && fullModels.find((model: any) => model.name === 'Delta 合成追加')?.counts.openedBlank === 1)
  writes.slice(0, 4).forEach((event: any) => {
    const result = lookup(event.data.request); check(result.command === 'collection.receive')
    check(fullModels.some((model: any) => model.id === result.result.modelId && model.name === event.data.request.payload.payload.model.name))
  })
  fullModels.forEach((model: any) => {
    const descriptor = descriptors.find(value => value.name === model.name); check(descriptor)
    Object.entries(descriptor).forEach(([key, value]) => same(model[key], value))
    check(model.counts.openedBlank === 1 && model.counts.total === 1)
  })
  lists.forEach((event: any, at: number) => {
    const request = event.data.request, payload = at >= 1 && at <= 12 ? PACKAGED_ROUTE_FILTER_MATRIX[at - 1]! : { page: { offset: 0, limit: 25 } }
    same(request.payload, payload)
    const source = at === 0 ? [] : at <= 12 ? seedModels : fullModels
    const filtered = filterCollectionSnapshot(source, payload.filter ?? {}), items = filtered.slice(payload.page.offset, payload.page.offset + payload.page.limit)
    same(lookup(request), { offset: payload.page.offset, limit: payload.page.limit, items, total: filtered.length, hasMore: payload.page.offset + items.length < filtered.length })
  })
  const mainRefresh = entries(main, 'main.refreshRequested'), mainRefreshReplies = entries(main, 'main.refreshReply')
  const refreshStarted = entries(core, 'core.explicitRefreshStarted'), refreshCompleted = entries(core, 'core.explicitRefreshCompleted')
  check(mainRefresh.length === 2 && mainRefreshReplies.length === 2 && refreshStarted.length === 2 && refreshCompleted.length === 2)
  for (const at of [0, 1]) {
    same(mainRefresh[at].data, { ordinal: at + 1 }); check(mainRefresh[at].sequence < mainRefreshReplies[at].sequence)
    check(refreshStarted[at].data.ordinal === at + 1 && refreshCompleted[at].data.ordinal === at + 1 && refreshStarted[at].data.mode === mode && refreshCompleted[at].data.mode === mode
      && refreshStarted[at].sequence < refreshCompleted[at].sequence)
    const reply = mainRefreshReplies[at].data.reply
    exact(reply, mode === 'rust' ? ['schemaVersion', 'type', 'ordinal', 'mode', 'status'] : ['schemaVersion', 'type', 'ordinal', 'mode'])
    check(reply.schemaVersion === 1 && reply.type === 'rust012.refreshed' && reply.ordinal === at + 1 && reply.mode === mode)
    if (mode === 'rust') same(reply.status, refreshCompleted[at].data.status)
  }
  check(writes[2].sequence < mainRefresh[0].sequence && mainRefreshReplies[0].sequence < lists[1].sequence
    && lists[12].sequence < writes[3].sequence && writes[3].sequence < lists[13].sequence && lists[13].sequence < writes[4].sequence
    && writes[4].sequence < lists[14].sequence && lists[14].sequence < mainRefresh[1].sequence && mainRefreshReplies[1].sequence < lists[15].sequence)
  const shutdown = requests.filter((event: any) => event.data.request.command === 'core.shutdown'); check(shutdown.length === 1)
  const closed = single(core, 'core.closedStatus'); check(closed.data.mode === mode)
  if (mode === 'node') {
    check(!events.some((event: any) => event.event.startsWith('rust.') || ['core.resourceValidated', 'core.controllerDelivered'].includes(event.event)))
    check(lists.every((event: any) => nodeRequests.some((entry: any) => entry.data.request.id === event.data.request.id)))
    return
  }
  const resource = single(core, 'core.resourceValidated'); same(resource.data, { binary: { path: identity.native.binaryPath, sha256: identity.native.binarySha256 }, manifestSha256: identity.manifestSha256, manifest: identity.native.manifest })
  check(resource.sequence < worker.sequence)
  const deliveredController = single(core, 'core.controllerDelivered'); same(deliveredController.data.keys, ['refresh', 'invalidate', 'getStatus']); check(deliveredController.data.frozen === true)
  statusFor(deliveredController.data.status); check(deliveredController.data.status.phase === 'new')
  statusFor(closed.data.status); check(closed.data.status.phase === 'closed' && closed.data.status.router?.phase === 'closed')
  const childSpawns = entries(core, 'rust.spawn'), childExits = entries(core, 'rust.exit')
  check(childSpawns.length === 3 && childExits.length === 3 && new Set(childSpawns.map((event: any) => event.data.pid)).size === 3)
  const nativeDispatches = new Map<string, any>()
  for (const [index, spawn] of childSpawns.entries()) {
    check(Number.isSafeInteger(spawn.data.pid) && spawn.data.pid > 0); same(spawn.data.binary, { path: identity.native.binaryPath, sha256: identity.native.binarySha256 })
    const exit = childExits.filter((event: any) => event.data.pid === spawn.data.pid); check(exit.length === 1)
    same(exit[0].data, { pid: spawn.data.pid, code: 0, signal: null, closeAcknowledged: true, pendingRequests: 0 }); check(exit[0].sequence > spawn.sequence && exit[0].sequence < closed.sequence)
    if (index > 0) check(childExits.find((event: any) => event.data.pid === childSpawns[index - 1].data.pid).sequence < spawn.sequence)
    const sent = entries(core, 'rust.request').filter((event: any) => event.data.pid === spawn.data.pid), acknowledgements = entries(core, 'rust.validated-reply').filter((event: any) => event.data.pid === spawn.data.pid)
    check(sent.length === acknowledgements.length && sent.length === [4, 15, 4][index])
    const models = index === 0 ? [] : index === 1 ? seedModels : fullModels
    const scope = sent[0].data.frame
    check(isCollectionId(scope.requestId) && scope.epoch === ownerIdentity.epoch && scope.datasetId === ownerIdentity.datasetId && isCollectionId(scope.snapshotId))
    const wireIds = new Set<string>()
    for (const [at, event] of sent.entries()) {
      const request = event.data.frame, replies = acknowledgements.filter((entry: any) => entry.data.frame.requestId === request.requestId)
      check(replies.length === 1 && replies[0].sequence > event.sequence); const reply = replies[0].data.frame
      exact(request, ['protocolVersion', 'requestId', 'epoch', 'datasetId', 'snapshotId', 'sequence', 'operation', 'payload'])
      exact(reply, ['protocolVersion', 'requestId', 'epoch', 'datasetId', 'snapshotId', 'sequence', 'operation', 'ok', 'result'])
      check(request.protocolVersion === 2 && reply.protocolVersion === 2 && request.sequence === at + 1 && reply.sequence === request.sequence
        && request.epoch === scope.epoch && request.datasetId === scope.datasetId && request.snapshotId === scope.snapshotId
        && isCollectionId(request.requestId) && !wireIds.has(request.requestId) && reply.ok === true); wireIds.add(request.requestId)
      for (const key of ['requestId', 'epoch', 'datasetId', 'snapshotId', 'operation']) check(reply[key] === request[key])
      const operation = at === 0 ? 'prepare' : at === 1 ? 'commitBoot' : at === sent.length - 1 ? 'close' : 'dispatch'
      check(request.operation === operation)
      if (operation === 'prepare') {
        same(request.payload, { models }); same(reply.result, { epoch: scope.epoch, datasetId: scope.datasetId, snapshotId: scope.snapshotId, readOnly: true, capabilities: ['collection.list'], modelCount: models.length })
        const exports = entries(core, 'node.versionedSnapshotExport').filter((entry: any) => entry.data.snapshotId === scope.snapshotId)
        check(exports.length === 1 && exports[0].sequence < event.sequence && exports[0].data.modelCount === models.length && exports[0].data.modelsSha256 === digest(JSON.stringify(models)))
        check(exports[0].data.version.epoch === scope.epoch && exports[0].data.version.datasetId === scope.datasetId)
      } else if (operation === 'dispatch') {
        exact(request.payload, ['request', 'filterProjection']); const original = request.payload.request
        check(requestIds.has(original.id) && !nativeDispatches.has(original.id)); same(original, requests.find((entry: any) => entry.data.request.id === original.id).data.request)
        same(request.payload.filterProjection, projectCollectionFilter(original.payload.filter ?? {})); same(reply.result, lookup(original)); nativeDispatches.set(original.id, request)
      } else { same(request.payload, {}); check(reply.result === null) }
    }
    const lastReply = acknowledgements.find((event: any) => event.data.frame.operation === 'close'); check(lastReply.sequence < exit[0].sequence)
  }
  check(nativeDispatches.size === 14)
  lists.forEach((event: any, at: number) => {
    const request = event.data.request, routedNode = nodeRequests.some((entry: any) => entry.data.request.id === request.id)
    check(routedNode === (at === 13 || at === 14)); check(nativeDispatches.has(request.id) === !routedNode)
    for (const entry of [publicRequests.find((value: any) => value.data.request.id === request.id), publicReplies.find((value: any) => value.data.reply.id === request.id)]) {
      check(entry.data.status?.phase === 'ready' && entry.data.status.router?.phase === (routedNode ? 'stale' : 'rust'))
    }
  })
  // 相同Core事件流内约束写后撤销及刷新；不要求异步转发stdout与Main数组全球邻接。
  const firstWrite = publicRequests.find((event: any) => event.data.request.id === writes[3].data.request.id)
  const afterWrite = publicReplies.find((event: any) => event.data.reply.id === writes[3].data.request.id)
  check(firstWrite.sequence < afterWrite.sequence && afterWrite.data.status.router.phase === 'stale')
  for (const at of [13, 14]) {
    const read = publicRequests.find((event: any) => event.data.request.id === lists[at].data.request.id)
    check(read.data.status.router.phase === 'stale' && read.data.status.router.generation > refreshCompleted[0].data.status.router.generation)
    check(!childSpawns.some((event: any) => event.sequence > afterWrite.sequence && event.sequence < read.sequence))
  }
  check(refreshCompleted.every((event: any) => event.data.status.phase === 'ready' && event.data.status.router.phase === 'rust')
    && refreshCompleted[1].data.status.router.generation > refreshCompleted[0].data.status.router.generation)
}

/** 可信expected由root独立回读最终包与运行收据；验收器同步只读，不执行应用或签名。 */
export function acceptRustPackagedRouteEvidence(report: unknown, expectedIdentity: unknown) {
  try {
    onlyData(report); onlyData(expectedIdentity)
    const value = report as any, expected = expectedIdentity as RustPackagedRouteExpectedIdentity
    exact(expected, ['sourceCommit', 'sourceSha256', 'packages', 'runs'])
    exact(value, ['schemaVersion', 'task', 'state', 'sourceCommit', 'sourceSha256', 'packages', 'runs', 'productionDefault', 'soleDatabaseWriter',
      'candidateDiagnostics', 'ownerAcceptance', 'rendererAcceptance', 'realServices', 'installation', 'push'])
    check(value.schemaVersion === 1 && value.task === 'RUST-012' && value.state === 'PASS' && commit(value.sourceCommit)
      && value.sourceCommit === expected.sourceCommit && sha(value.sourceSha256) && value.sourceSha256 === expected.sourceSha256)
    check(value.productionDefault === 'Node' && value.soleDatabaseWriter === 'Node' && value.candidateDiagnostics === 'COMPILE_TIME_ONLY')
    for (const key of ['ownerAcceptance', 'rendererAcceptance', 'realServices', 'installation', 'push']) check(value[key] === 'NOT_RUN')
    exact(value.packages, kinds); exact(expected.packages, kinds); exact(value.runs, kinds); exact(expected.runs, kinds)
    same(value.packages, expected.packages)
    const identities = {} as Record<Kind, any>, runtimes = {} as Record<Kind, any>
    for (const kind of kinds) { identities[kind] = packageFor(value.packages[kind], kind, value.sourceCommit); runtimes[kind] = runtimeFor(value.runs[kind], expected.runs[kind], kind, identities[kind]) }
    check(new Set(kinds.map(kind => identities[kind].appPath)).size === 4 && new Set(kinds.map(kind => runtimes[kind].profileDirectory)).size === 4)
    check(identities['default-node'].asar.defaultEntries[0].sha256 !== identities['node-diagnostic'].asar.defaultEntries[0].sha256)
    check(new Set(kinds.slice(1).map(kind => identities[kind].asar.defaultEntries[0].sha256)).size === 1)
    diagnosticFor(runtimes['node-diagnostic'], identities['node-diagnostic'], 'node')
    diagnosticFor(runtimes['rust-diagnostic'], identities['rust-diagnostic'], 'rust')
    diagnosticFor(runtimes['pin-rejected'], identities['pin-rejected'], 'rejected')
    return Object.freeze({ state: 'PASS' as const, task: 'RUST-012' as const, packagedReadonlyRoute: 'PASS' as const, ownerAcceptance: 'NOT_RUN' as const, rendererAcceptance: 'NOT_RUN' as const })
  } catch { return reject() }
}
