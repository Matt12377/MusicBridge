import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, readdirSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual, types } from 'node:util'
import { validateIpcRequest, validateIpcResponseForCommand, isCollectionId } from '@music-bridge/contracts'
import { isDatasetVersionedCollectionSnapshot } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { filterCollectionSnapshot, projectCollectionFilter } from '../../../../packages/bridge-core/src/rust-core/collection-query.js'
import { OFFLINE_PROTOCOL_FILTERS } from './rust-offline-candidate-protocol.js'

const external = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const commit = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const reject = (): never => { throw Object.assign(new Error('候选证据未准入。'), { code: 'RUST_OFFLINE_EVIDENCE_REJECTED' }) }
function check(value: unknown): asserts value { if (!value) reject() }
function exact(value: any, keys: readonly string[]) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)))
}
/** 不运行 getter/Proxy，也不允许循环、私有对象或隐藏字段进入报告。 */
function dataOnly(value: unknown, depth = 0, visiting = new Set<object>()): void {
  check(depth < 40)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { check(Number.isFinite(value)); return }
  check(typeof value === 'object' && value !== null && !types.isProxy(value))
  const object = value as object
  check(!visiting.has(object)); visiting.add(object)
  const array = Array.isArray(object), prototype = Object.getPrototypeOf(object)
  check(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null)
  check(Object.getOwnPropertySymbols(object).length === 0)
  const descriptors = Object.getOwnPropertyDescriptors(object)
  check(!array || Object.keys(descriptors).length === (object as unknown[]).length + 1)
  for (const [key, field] of Object.entries(descriptors)) {
    if (array && key === 'length') continue
    check(field.enumerable && Object.hasOwn(field, 'value'))
    if (array) check(/^(?:0|[1-9][0-9]*)$/u.test(key))
    dataOnly(field.value, depth + 1, visiting)
  }
  visiting.delete(object)
}
function externalPath(file: unknown): asserts file is string {
  check(typeof file === 'string' && file.startsWith(external + '/') && file.length <= 1024 && !file.includes('\0') && path.resolve(file) === file)
}
function bytesAt(file: unknown, limit = 64 * 1024 * 1024, executable = false) {
  externalPath(file)
  check(realpathSync(file) === file)
  const before = lstatSync(file, { bigint: true })
  check(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(limit)
    && (before.mode & 0o022n) === 0n && (!executable || (before.mode & 0o111n) !== 0n))
  const bytes = readFileSync(file), after = lstatSync(file, { bigint: true })
  check(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every(key => before[key as keyof typeof before] === after[key as keyof typeof after]))
  return bytes
}
function verifyLog(log: any, limit: number) {
  exact(log, ['path', 'sha256']); check(hash(log.sha256))
  const bytes = bytesAt(log.path, limit); check(digest(bytes) === log.sha256)
  return bytes.toString('utf8')
}
function actualTree(directory: string) {
  const entries: any[] = []
  function visit(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = path.relative(directory, file).replaceAll(path.sep, '/'), info = lstatSync(file)
      if (info.isSymbolicLink()) {
        check(realpathSync(file).startsWith(directory + '/'))
        entries.push({ path: relative, kind: 'symlink', target: readlinkSync(file) })
      } else if (info.isDirectory()) visit(file)
      else { check(info.isFile()); entries.push({ path: relative, kind: 'file', sha256: digest(readFileSync(file)), bytes: info.size, mode: info.mode & 0o777 }) }
    }
  }
  visit(directory); return entries
}
function lifecycleFor(value: any, log: string) {
  check(Array.isArray(value) && value.length > 0 && value.length <= 256)
  const parsed = log.split(/\r?\n/u).filter(line => line.startsWith('TASK078_LIFECYCLE ')).map(line => JSON.parse(line.slice('TASK078_LIFECYCLE '.length)))
  check(isDeepStrictEqual(parsed, value))
  let previous = -1
  for (const item of value) {
    exact(item, item.phase === 'core-exit' ? ['phase', 'elapsedMs', 'exitCode'] : ['phase', 'elapsedMs'])
    check(typeof item.phase === 'string' && Number.isFinite(item.elapsedMs) && item.elapsedMs >= previous)
    previous = item.elapsedMs
    check(!['print-stop-failed', 'outbox-close-timeout'].includes(item.phase))
  }
  const index = (phase: string) => {
    const found = value.map((entry: any, at: number) => entry.phase === phase ? at : -1).filter((at: number) => at >= 0)
    check(found.length === (phase === 'before-quit' ? 2 : 1)); return found[0] as number
  }
  for (const phase of ['bootstrap-start', 'data-prepared', 'core-spawn', 'core-ready-received', 'onready-complete', 'supervisor-ready', 'ui-loaded']) check(index(phase) < index('before-quit'))
  const close = ['before-quit', 'core-shutdown-start', 'core-exit', 'core-shutdown-end', 'app-quit-reissued', 'will-quit']
  for (let at = 1; at < close.length; at++) check(index(close[at - 1]!) < index(close[at]!))
  const secondBeforeQuit = value.findIndex((entry: any, at: number) => entry.phase === 'before-quit' && at > index('before-quit'))
  check(index('app-quit-reissued') < secondBeforeQuit && secondBeforeQuit < index('will-quit'))
  check(value[index('core-exit')].exitCode === 0)
  check(log.split(/\r?\n/u).filter(line => line === 'DESKTOP_STARTUP_READY').length === 1 && !log.includes('DESKTOP_STARTUP_FAIL'))
}
function validateProtocol(value: any, identity: any) {
  exact(value, ['schemaVersion', 'task', 'kind', 'state', 'resourcesDirectory', 'evidenceDirectory', 'manifestSha256', 'binary', 'modelCount',
    'snapshot', 'nodeSessions', 'databasesBefore', 'databasesAfter', 'closedDatabases', 'comparisons', 'writeRejection', 'rust', 'forcedCleanup', 'ownerAcceptance', 'packagedRustMainCoreRoute', 'evidence'])
  check(value.schemaVersion === 1 && value.task === 'RUST-011' && value.kind === 'external-node-to-packaged-rust-protocol' && value.state === 'PASS')
  externalPath(value.evidenceDirectory); check(value.resourcesDirectory === identity.resourcesDirectory && value.manifestSha256 === identity.manifestSha256)
  exact(value.binary, ['path', 'sha256']); check(value.binary.path === identity.native.binaryPath && value.binary.sha256 === identity.native.binarySha256)
  check(value.evidence.path === path.join(value.evidenceDirectory, 'protocol-report.json'))
  const { evidence, ...persisted } = value
  check(isDeepStrictEqual(JSON.parse(verifyLog(evidence, 16 * 1024 * 1024)), persisted))
  check(value.modelCount === 100 && isDatasetVersionedCollectionSnapshot(value.snapshot) && value.snapshot.snapshot.models.length === 100)
  const snapshot = value.snapshot.snapshot
  check(isCollectionId(snapshot.epoch) && isCollectionId(snapshot.snapshotId))
  check(Array.isArray(value.nodeSessions) && value.nodeSessions.length === 2)
  for (const [at, session] of value.nodeSessions.entries()) {
    exact(session, ['role', 'threadId', 'identity', 'acknowledgements', 'exitCode', 'closeRequested'])
    check(session.role === ['initialize', 'query'][at] && Number.isSafeInteger(session.threadId) && session.threadId > 0 && session.exitCode === 0 && session.closeRequested === true)
    exact(session.identity, ['epoch', 'datasetId']); check(isCollectionId(session.identity.epoch) && session.identity.datasetId === snapshot.datasetId)
    check(Array.isArray(session.acknowledgements))
    const operations = at === 0 ? ['prepare', 'commitBoot', 'close'] : ['prepare', 'commitBoot', 'exportVersionedCollectionSnapshot', 'close']
    check(session.acknowledgements.length === operations.length)
    const requestIds = new Set<string>()
    for (const [index, ack] of session.acknowledgements.entries()) {
      exact(ack, ['operation', 'requestId', 'epoch', 'ok'])
      check(ack.operation === operations[index] && ack.ok === true && ack.epoch === session.identity.epoch && isCollectionId(ack.requestId) && !requestIds.has(ack.requestId)); requestIds.add(ack.requestId)
    }
  }
  check(isDeepStrictEqual(value.nodeSessions[1].identity, { epoch: snapshot.epoch, datasetId: snapshot.datasetId }))
  check(value.nodeSessions[0].threadId !== value.nodeSessions[1].threadId)
  const databaseNames = ['collection.v1.sqlite', 'collection.v1.sqlite-wal', 'backup-maintenance.v1.sqlite', 'backup-maintenance.v1.sqlite-wal']
  check(isDeepStrictEqual(value.databasesBefore, value.databasesAfter))
  for (const identities of [value.databasesBefore, value.databasesAfter, value.closedDatabases]) {
    check(Array.isArray(identities) && identities.length === databaseNames.length)
    for (const [at, db] of identities.entries()) {
      exact(db, ['name', 'exists', 'size', 'sha256']); check(db.name === databaseNames[at] && typeof db.exists === 'boolean')
      check(db.exists ? Number.isSafeInteger(db.size) && db.size >= 0 && hash(db.sha256) : db.name.endsWith('-wal') && db.size === 0 && db.sha256 === null)
    }
  }
  for (const db of value.closedDatabases) {
    const file = path.join(value.evidenceDirectory, 'synthetic-data', db.name); externalPath(file)
    if (db.exists && db.size > 0) { const bytes = bytesAt(file); check(bytes.length === db.size && digest(bytes) === db.sha256) }
    else if (db.exists) { check(lstatSync(file).isFile() && realpathSync(file) === file && lstatSync(file).size === 0 && db.sha256 === digest(Buffer.alloc(0))) }
    else { try { lstatSync(file); reject() } catch (error) { check((error as NodeJS.ErrnoException).code === 'ENOENT') } }
  }
  check(Array.isArray(value.comparisons) && value.comparisons.length === OFFLINE_PROTOCOL_FILTERS.length * 4)
  const ids = new Set<string>()
  for (const [at, comparison] of value.comparisons.entries()) {
    exact(comparison, ['request', 'expected', 'actual'])
    const request = comparison.request, valid = validateIpcRequest(request)
    check(valid.ok && request.command === 'collection.list' && request.expectedDatasetId === snapshot.datasetId && !ids.has(request.id)); ids.add(request.id)
    const filter = OFFLINE_PROTOCOL_FILTERS[Math.floor(at / 4)]!, offset = [0, 31, 99, 100][at % 4]!
    check(isDeepStrictEqual(request.payload, { page: { offset, limit: 25 }, filter }))
    const models = filterCollectionSnapshot(snapshot.models, filter), items = models.slice(offset, offset + 25)
    check(isDeepStrictEqual(comparison.expected, { offset, limit: 25, items, total: models.length, hasMore: offset + items.length < models.length }))
    check(isDeepStrictEqual(comparison.actual, comparison.expected) && validateIpcResponseForCommand({ version: 1, id: request.id, ok: true, result: comparison.actual }, 'collection.list').ok)
  }
  exact(value.writeRejection, ['request', 'code'])
  check(value.writeRejection.code === 'UNSUPPORTED_COMMAND' && value.writeRejection.request.command === 'collection.setPolicy'
    && validateIpcRequest(value.writeRejection.request).ok && value.writeRejection.request.expectedDatasetId === snapshot.datasetId)
  exact(value.rust, ['pid', 'spawnPath', 'requests', 'acknowledgements', 'exit', 'killCalls'])
  check(Number.isSafeInteger(value.rust.pid) && value.rust.pid > 0 && value.rust.spawnPath === identity.native.binaryPath && value.rust.killCalls === 0)
  exact(value.rust.exit, ['code', 'signal']); check(value.rust.exit.code === 0 && value.rust.exit.signal === null)
  const requests = value.rust.requests, replies = value.rust.acknowledgements
  check(Array.isArray(requests) && Array.isArray(replies) && requests.length === value.comparisons.length + 3 && replies.length === requests.length)
  const operations = ['prepare', 'commitBoot', ...value.comparisons.map(() => 'dispatch'), 'close']
  const wireIds = new Set<string>()
  for (const [at, request] of requests.entries()) {
    const reply = replies[at]
    exact(request, ['protocolVersion', 'requestId', 'epoch', 'datasetId', 'snapshotId', 'sequence', 'operation', 'payload'])
    exact(reply, ['protocolVersion', 'requestId', 'epoch', 'datasetId', 'snapshotId', 'sequence', 'operation', 'ok', 'result'])
    check(request.operation === operations[at] && reply.operation === request.operation && request.sequence === at + 1 && reply.sequence === request.sequence
      && request.protocolVersion === 2 && reply.protocolVersion === 2 && isCollectionId(request.requestId) && reply.requestId === request.requestId
      && request.epoch === snapshot.epoch && reply.epoch === snapshot.epoch && request.datasetId === snapshot.datasetId && reply.datasetId === snapshot.datasetId
      && request.snapshotId === snapshot.snapshotId && reply.snapshotId === snapshot.snapshotId && reply.ok === true)
    check(!wireIds.has(request.requestId)); wireIds.add(request.requestId)
    if (request.operation === 'prepare') check(isDeepStrictEqual(request.payload, { models: snapshot.models }) && isDeepStrictEqual(reply.result,
      { epoch: snapshot.epoch, datasetId: snapshot.datasetId, snapshotId: snapshot.snapshotId, readOnly: true, capabilities: ['collection.list'], modelCount: 100 }))
    else if (request.operation === 'dispatch') check(isDeepStrictEqual(request.payload, { request: value.comparisons[at - 2].request,
      filterProjection: projectCollectionFilter(OFFLINE_PROTOCOL_FILTERS[Math.floor((at - 2) / 4)]!) })
      && isDeepStrictEqual(reply.result, value.comparisons[at - 2].actual))
    else check(isDeepStrictEqual(request.payload, {}) && reply.result === null)
  }
  check(value.forcedCleanup === false && value.ownerAcceptance === 'NOT_RUN' && value.packagedRustMainCoreRoute === 'NOT_IN_SCOPE')
}
export interface RustOfflineExpectedIdentity {
  sourceCommit: string
  sourceSha256: string
  candidateIdentity: any
  verification: any
}

/** 期望身份由主代理独立读最终文件/签名/Fuse；本函数只读文件并校验，不运行服务。 */
export function acceptRustOfflineCandidateEvidence(report: unknown, expectedIdentity: unknown) {
  try {
    dataOnly(report); dataOnly(expectedIdentity)
    const value = report as any, expected = expectedIdentity as RustOfflineExpectedIdentity
    exact(expected, ['sourceCommit', 'sourceSha256', 'candidateIdentity', 'verification'])
    exact(value, ['schemaVersion', 'task', 'state', 'sourceCommit', 'sourceSha256', 'candidateIdentity', 'verification', 'protocol', 'defaultNode',
      'ownerAcceptance', 'packagedRustMainCoreRoute', 'productionDefault', 'installation', 'realServices', 'implicitDownload'])
    check(value.schemaVersion === 1 && value.task === 'RUST-011' && value.state === 'PASS' && commit(value.sourceCommit) && hash(value.sourceSha256)
      && value.sourceCommit === expected.sourceCommit && value.sourceSha256 === expected.sourceSha256)
    check(value.ownerAcceptance === 'NOT_RUN' && value.packagedRustMainCoreRoute === 'NOT_IN_SCOPE' && value.productionDefault === 'Node'
      && value.installation === 'NOT_RUN' && value.realServices === 'NOT_RUN' && value.implicitDownload === false)
    check(isDeepStrictEqual(value.candidateIdentity, expected.candidateIdentity) && isDeepStrictEqual(value.verification, expected.verification))
    const identity = value.candidateIdentity
    exact(identity, ['appPath', 'resourcesDirectory', 'executable', 'executableSha256', 'manifestSha256', 'native', 'asar', 'fuses', 'infoPlistSha256', 'bundleCDHash', 'bundleFiles'])
    externalPath(identity.appPath); check(identity.appPath.endsWith('.app') && realpathSync(identity.appPath) === identity.appPath)
    check(identity.resourcesDirectory === path.join(identity.appPath, 'Contents/Resources'))
    check(typeof identity.executable === 'string' && path.dirname(identity.executable) === path.join(identity.appPath, 'Contents/MacOS'))
    check(digest(bytesAt(identity.executable, 64 * 1024 * 1024, true)) === identity.executableSha256)
    exact(identity.native, ['manifest', 'manifestSha256', 'binaryPath', 'binarySha256', 'cdHash'])
    check(identity.native.binaryPath === path.join(identity.resourcesDirectory, 'rust-core/darwin-arm64/bin/musicbridge-rust-core'))
    const manifestBytes = bytesAt(path.join(identity.resourcesDirectory, 'rust-core/darwin-arm64/manifest.json'), 64 * 1024)
    check(digest(manifestBytes) === identity.manifestSha256 && identity.native.manifestSha256 === identity.manifestSha256)
    check(isDeepStrictEqual(JSON.parse(manifestBytes.toString()), identity.native.manifest))
    check(digest(bytesAt(identity.native.binaryPath, 64 * 1024 * 1024, true)) === identity.native.binarySha256)
    const manifest = identity.native.manifest
    exact(manifest, ['schemaVersion', 'kind', 'platform', 'arch', 'protocolVersion', 'source', 'binary'])
    exact(manifest.source, ['commit', 'sha256']); exact(manifest.binary, ['relativePath', 'sha256', 'size', 'cdHash'])
    check(manifest.schemaVersion === 1 && manifest.kind === 'musicbridge-rust-readonly-resource' && hash(manifest.source.sha256)
      && manifest.binary.relativePath === 'bin/musicbridge-rust-core')
    const binaryBytes = bytesAt(identity.native.binaryPath, 64 * 1024 * 1024, true)
    check(binaryBytes.length === manifest.binary.size && binaryBytes.length >= 32 && binaryBytes.readUInt32LE(0) === 0xfeedfacf
      && binaryBytes.readUInt32LE(4) === 0x0100000c)
    check(isDeepStrictEqual(readdirSync(path.join(identity.resourcesDirectory, 'rust-core/darwin-arm64')).sort(), ['bin', 'manifest.json'])
      && isDeepStrictEqual(readdirSync(path.dirname(identity.native.binaryPath)), ['musicbridge-rust-core']))
    check(manifest.platform === 'darwin' && manifest.arch === 'arm64' && manifest.protocolVersion === 2 && manifest.binary.sha256 === identity.native.binarySha256
      && manifest.binary.cdHash === identity.native.cdHash && manifest.source.commit === value.sourceCommit)
    exact(identity.asar, ['path', 'sha256', 'headerSha256', 'main', 'defaultEntries'])
    check(identity.asar.path === path.join(identity.resourcesDirectory, 'app.asar') && identity.asar.main === 'dist/main/index.js'
      && hash(identity.asar.headerSha256) && digest(bytesAt(identity.asar.path, 512 * 1024 * 1024)) === identity.asar.sha256)
    check(Array.isArray(identity.asar.defaultEntries) && identity.asar.defaultEntries.length === 2)
    for (const [at, entry] of identity.asar.defaultEntries.entries()) { exact(entry, ['path', 'sha256']); check(entry.path === ['dist/main/index.js', 'dist/main/core.js'][at] && hash(entry.sha256)) }
    check(digest(bytesAt(path.join(identity.appPath, 'Contents/Info.plist'), 1024 * 1024)) === identity.infoPlistSha256)
    check(isDeepStrictEqual(actualTree(identity.appPath), identity.bundleFiles))
    exact(identity.fuses, ['version', '0', '1', '2', '3', '4', '5', '6', '7', '8'])
    check(identity.fuses.version === '1' && Object.entries({ 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49, 6: 48, 7: 48, 8: 49 }).every(([key, setting]) => identity.fuses[key] === setting))
    exact(value.verification, ['platform', 'arch', 'nativeSignature', 'bundleSignature', 'asarIntegrity'])
    check(value.verification.platform === 'darwin' && value.verification.arch === 'arm64')
    for (const [signature, cdHash] of [[value.verification.nativeSignature, identity.native.cdHash], [value.verification.bundleSignature, identity.bundleCDHash]]) {
      exact(signature, ['verified', 'adHoc', 'cdHash']); check(signature.verified === true && signature.adHoc === true && commit(cdHash) && signature.cdHash === cdHash)
    }
    exact(value.verification.asarIntegrity, ['algorithm', 'hash']); check(value.verification.asarIntegrity.algorithm === 'SHA256' && value.verification.asarIntegrity.hash === identity.asar.headerSha256)
    validateProtocol(value.protocol, identity)
    const startup = value.defaultNode
    exact(startup, ['executable', 'args', 'profileDirectory', 'flags', 'keychain', 'ready', 'lifecycle', 'exit', 'forcedCleanup', 'log', 'observation'])
    check(startup.executable === identity.executable && isDeepStrictEqual(startup.args, ['--use-mock-keychain']) && startup.keychain === 'mock'
      && startup.ready === true && startup.forcedCleanup === false)
    exact(startup.flags, ['startupTest', 'coreTestMode', 'uiE2e', 'offline']); check(Object.values(startup.flags).every(flag => flag === true))
    externalPath(startup.profileDirectory); check(/^musicbridge-task036-startup-[A-Za-z0-9._-]+$/u.test(path.basename(startup.profileDirectory)))
    check(realpathSync(startup.profileDirectory) === startup.profileDirectory && lstatSync(startup.profileDirectory).isDirectory())
    exact(startup.exit, ['code', 'signal']); check(startup.exit.code === 0 && startup.exit.signal === null)
    lifecycleFor(startup.lifecycle, verifyLog(startup.log, 16 * 1024 * 1024))
    const observation = JSON.parse(verifyLog(startup.observation, 1024 * 1024))
    exact(observation, ['kind', 'executable', 'executableSha256', 'argv', 'cwd', 'profileDirectory', 'profileWasFresh', 'environmentKeys', 'environmentFlags',
      'readyMarkerCount', 'failureMarkerCount', 'lifecycle', 'electronExit', 'forcedCleanup', 'spawnError', 'observationError', 'observedRustChildCount',
      'processObservation', 'ownerWorkerExit', 'durationMs', 'log'])
    check(observation.kind === 'packaged-default-node' && observation.executable === identity.executable && observation.executableSha256 === identity.executableSha256
      && isDeepStrictEqual(observation.argv, startup.args) && observation.cwd === startup.profileDirectory && observation.profileDirectory === startup.profileDirectory
      && observation.profileWasFresh === true && observation.readyMarkerCount === 1 && observation.failureMarkerCount === 0
      && observation.forcedCleanup === false && observation.spawnError === null && observation.observationError === null
      && observation.observedRustChildCount === 0 && observation.processObservation === 'bounded-50ms-ps-sampling-plus-default-entry-identity'
      && observation.ownerWorkerExit === 'NOT_INDEPENDENTLY_OBSERVED' && Number.isFinite(observation.durationMs) && observation.durationMs > 0
      && isDeepStrictEqual(observation.lifecycle, startup.lifecycle) && isDeepStrictEqual(observation.log, startup.log))
    exact(observation.electronExit, ['code', 'signal', 'closed']); check(observation.electronExit.code === 0 && observation.electronExit.signal === null && observation.electronExit.closed === true)
    check(Array.isArray(observation.environmentKeys) && observation.environmentKeys.length === new Set(observation.environmentKeys).size
      && observation.environmentKeys.every((key: string) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'DEV_BUILD_ROOT', 'DEV_CACHE_ROOT',
        'MUSIC_BRIDGE_STARTUP_TEST', 'MUSIC_BRIDGE_CORE_TEST_MODE', 'MUSIC_BRIDGE_UI_E2E', 'MUSIC_BRIDGE_UI_E2E_OFFLINE', 'MUSIC_BRIDGE_STARTUP_USER_DATA_DIR'].includes(key)))
    check(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'MUSIC_BRIDGE_STARTUP_TEST', 'MUSIC_BRIDGE_CORE_TEST_MODE', 'MUSIC_BRIDGE_UI_E2E',
      'MUSIC_BRIDGE_UI_E2E_OFFLINE', 'MUSIC_BRIDGE_STARTUP_USER_DATA_DIR'].every(key => observation.environmentKeys.includes(key)))
    check(isDeepStrictEqual(observation.environmentFlags, { MUSIC_BRIDGE_STARTUP_TEST: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E: '1',
      MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_STARTUP_USER_DATA_DIR: startup.profileDirectory }))
    return Object.freeze({ state: 'PASS' as const, task: 'RUST-011' as const, packagedRustMainCoreRoute: 'NOT_IN_SCOPE' as const, ownerAcceptance: 'NOT_RUN' as const })
  } catch { return reject() }
}
