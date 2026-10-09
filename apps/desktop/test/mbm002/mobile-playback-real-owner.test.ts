import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { checkServerIdentity, type TLSSocket } from 'node:tls'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  MOBILE_API_RESPONSE_MAX_BYTES, MOBILE_OPERATION_TABLE, decodeMobileResponse,
  mobileCanonicalJson, validateIpcInternalRequest, validateIpcInternalResponseForCommand,
  validateIpcResponseForCommand, validateMobileMediaStreamHeaders, validateMobileMediaStreamCompletion,
  validateMobileReadyAudio, type IpcCommand, type IpcCommandPayloads, type IpcCommandResults,
  type IpcInternalCommand, type IpcRequest, type MobileAudioInfo, type MobileErrorEnvelope,
  type MobileHeaderPairs, type MobileJsonValue, type MobileOperationId, type MobilePairingClaim,
  type MobileReadyResource, type MobileReplyMap, type MobileResource, type MobileResourceRequest,
  type MobileResourceSemanticContext, type MobileSession, type MobileTokenPair, type MobileTrack,
  type MobileTrackPage,
} from '@music-bridge/contracts'
import type { DatasetDomain } from '../../../../packages/bridge-core/src/collection/dataset-domain.js'
import type { DatasetProjectionCommand, DatasetProjectionCommandPayloads, DatasetProjectionCommandResults,
  DatasetProjectionPort } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import type { MobileOwnerPrivateRequest, MobileOwnerPrivateResult } from '../../../../packages/bridge-core/src/mobile/types.js'
import type { MobileOwnerSourceRequest, MobileOwnerSourceResult } from '../../../../packages/bridge-core/src/mobile/source-protocol.js'
import type { MobileTlsIdentity } from '../../src/main/mobile-tls-identity.js'
import { audioFixture, loadFreshMetadataReader } from '../../../../packages/bridge-core/test/helpers/mbrs003-audio-fixtures.js'

/** 本轮 fresh Core/固定 Reader、单一真 SQLite Owner、生产 Main 与真实 loopback TLS。
 * 同进程私有端口不是 Electron/RPC 故障证明；合成 AES protector 不是系统保险库。
 * 只传自有原文件，不发声、不接 Provider/Roon，也不认证物理设备或 Owner 验收。
 */
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const valueHash = (value: unknown): string => hash(Buffer.from(JSON.stringify(value)))
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const formatCases = [
  { id: 'core-wav', codec: 'pcm_s16le', container: 'wav', contentType: 'audio/wav' },
  { id: 'core-m4a-alac', codec: 'alac', container: 'm4a', contentType: 'audio/mp4' },
] as const
type AudioId = typeof formatCases[number]['id']

async function wholeFile(file: string) {
  assert.equal(await realpath(file), file)
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await fd.stat({ bigint: true })
    assert.equal(before.isFile(), true); assert.equal(before.nlink, 1n)
    assert.ok(before.size > 0n && before.size <= 64n * 1024n * 1024n)
    const bytes = await fd.readFile(), after = await fd.stat({ bigint: true }), named = await lstat(file, { bigint: true })
    const axes = (v: typeof before) => [v.dev, v.ino, v.size, v.mode, v.uid, v.gid, v.nlink, v.mtimeNs, v.ctimeNs]
    assert.deepEqual(axes(after), axes(before)); assert.deepEqual(axes(named), axes(before))
    assert.equal(named.isSymbolicLink(), false); assert.equal(bytes.length, Number(before.size))
    return { bytes, sha256: hash(bytes), stat: before, axes: axes(before) }
  } finally { await fd.close() }
}

interface BoundFile { path: string; bytes: number; sha256: string }
interface BoundOutput extends BoundFile { sourcePath?: string; sourceSha256?: string; mtimeMs: number }
interface Preparation {
  schema: string; status: string; readerBindingSha256: string; inputsUnchanged: boolean; outputsUnchanged: boolean
  sourceInputs: BoundFile[]; outputs: BoundOutput[]
  stages: { name: string; compilerExit: number; startedMs: number; finishedMs: number }[]
}
let moduleFlight: ReturnType<typeof loadModules> | undefined
async function loadModules() {
  const reader = await loadFreshMetadataReader()
  const bindingFile = process.env.MBRS003_READER_BUILD_BINDING
  assert.ok(bindingFile && path.isAbsolute(bindingFile), '必须提供本轮 fresh Core/Reader 绑定。')
  const binding = await wholeFile(bindingFile), receiptFile = path.join(path.dirname(bindingFile), 'preparation-receipt.json')
  const receipt = await wholeFile(receiptFile), preparation = JSON.parse(receipt.bytes.toString('utf8')) as Preparation
  assert.equal(preparation.schema, 'core-test.reader-preparation.v1'); assert.equal(preparation.status, 'FRESH_READER_PREPARED')
  assert.equal(preparation.readerBindingSha256, binding.sha256)
  assert.equal(preparation.inputsUnchanged, true); assert.equal(preparation.outputsUnchanged, true)
  assert.equal(new Set(preparation.sourceInputs.map(row => row.path)).size, preparation.sourceInputs.length)
  assert.equal(new Set(preparation.outputs.map(row => row.path)).size, preparation.outputs.length)
  const compiler = preparation.stages.find(row => row.name === 'fresh-core-compiler')
  assert.ok(compiler); assert.equal(compiler.compilerExit, 0)
  assert.ok(compiler.startedMs > 0 && compiler.finishedMs >= compiler.startedMs)
  const checked: BoundFile[] = []
  const coreEntries = [
    'collection/dataset-domain', 'collection/repository', 'collection/local-source-tickets', 'collection/local-scan-coordinator',
    'collection/local-scan-store', 'recording/restore-dataset-runtime', 'recording/source-files', 'application/local-source-resolver',
    'library/metadata-reader', 'library/scan-read-admission', 'stream/local-file-source', 'stream/local-source-fence',
    'stream/physical-resource-locks', 'mobile/source-service', 'mobile/source-protocol', 'mobile/playback-types',
    'mobile/playback-service', 'mobile/playback-state', 'mobile/owner-service', 'mobile/owner-protocol',
    'mobile/types', 'mobile/auth-service', 'mobile/auth-crypto', 'mobile/sealed-state-store', 'mobile/catalog-service',
  ]
  for (const entry of coreEntries) {
    const sourcePath = `packages/bridge-core/src/${entry}.ts`, source = preparation.sourceInputs.find(row => row.path === sourcePath)
    assert.ok(source, '本轮准备收据必须覆盖真实 Core 接线源码。'); checked.push(source)
    for (const extension of ['.js', '.js.map', '.d.ts']) {
      const relative = `packages/bridge-core/dist/${entry}${extension}`, artifact = preparation.outputs.find(row => row.path === relative)
      assert.ok(artifact, '真实 Core 模块必须具有本轮编译的 JS/map/type。')
      assert.equal(artifact.sourcePath, sourcePath); assert.equal(artifact.sourceSha256, source.sha256)
      assert.ok(artifact.mtimeMs >= compiler.startedMs && artifact.mtimeMs <= compiler.finishedMs)
      const actual = await wholeFile(path.join(repositoryRoot, relative))
      assert.ok(actual.stat.mtimeNs >= BigInt(compiler.startedMs) * 1_000_000n
        && actual.stat.mtimeNs <= BigInt(compiler.finishedMs) * 1_000_000n)
      checked.push(artifact)
    }
  }
  for (const file of ['mobile-backend', 'mobile-playback-backend', 'mobile-https-server', 'mobile-media-response', 'mobile-tls-identity']) {
    const source = preparation.sourceInputs.find(row => row.path === `apps/desktop/src/main/${file}.ts`)
    assert.ok(source, '生产 Main 源码也必须属于本轮准备输入。'); checked.push(source)
  }
  const testInput = preparation.sourceInputs.find(row => row.path === 'apps/desktop/test/mbm002/mobile-playback-real-owner.test.ts')
  assert.ok(testInput, '不能以落盘前的旧准备收据执行本用例。'); checked.push(testInput)
  async function assertBoundBytes() {
    assert.equal((await wholeFile(bindingFile!)).sha256, binding.sha256)
    assert.equal((await wholeFile(receiptFile)).sha256, receipt.sha256)
    for (const row of checked) {
      assert.equal(path.posix.isAbsolute(row.path), false); assert.equal(row.path.split('/').includes('..'), false)
      const actual = await wholeFile(path.join(repositoryRoot, row.path))
      assert.equal(actual.bytes.length, row.bytes); assert.equal(actual.sha256, row.sha256)
    }
  }
  await assertBoundBytes()
  const domain = await import(pathToFileURL(path.join(repositoryRoot, 'packages/bridge-core/dist/collection/dataset-domain.js')).href) as typeof import('../../../../packages/bridge-core/src/collection/dataset-domain.js')
  const admission = await import(pathToFileURL(path.join(repositoryRoot, 'packages/bridge-core/dist/library/scan-read-admission.js')).href) as typeof import('../../../../packages/bridge-core/src/library/scan-read-admission.js')
  const locks = await import(pathToFileURL(path.join(repositoryRoot, 'packages/bridge-core/dist/stream/physical-resource-locks.js')).href) as typeof import('../../../../packages/bridge-core/src/stream/physical-resource-locks.js')
  const protocol = await import(pathToFileURL(path.join(repositoryRoot, 'packages/bridge-core/dist/mobile/owner-protocol.js')).href) as typeof import('../../../../packages/bridge-core/src/mobile/owner-protocol.js')
  // Main 生产工厂由当前 TS 实际执行；这层不冒充 Electron production bundle。
  const main = await import(new URL('../../src/main/mobile-backend.ts', import.meta.url).href) as typeof import('../../src/main/mobile-backend.js')
  const https = await import(new URL('../../src/main/mobile-https-server.ts', import.meta.url).href) as typeof import('../../src/main/mobile-https-server.js')
  const tls = await import(new URL('../../src/main/mobile-tls-identity.ts', import.meta.url).href) as typeof import('../../src/main/mobile-tls-identity.js')
  await assertBoundBytes()
  return { reader, domain, admission, locks, protocol, main, https, tls, assertBoundBytes }
}
const modules = () => moduleFlight ??= loadModules()
type Modules = Awaited<ReturnType<typeof modules>>
type Backend = ReturnType<Modules['main']['createMobileBackend']>
type SourceTrace = { request: MobileOwnerSourceRequest; result: MobileOwnerSourceResult | Extract<MobileOwnerPrivateResult, { kind: 'mobile-error' }> }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function bounded<T>(flight: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([flight, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('本用例有限等待未完成。')), ms) })]) }
  finally { if (timer) clearTimeout(timer) }
}

async function fixture(t: TestContext) {
  const inputs = await audioFixture(t), m = await modules()
  const directory = path.join(inputs.directory, 'mobile-real-owner'), data = path.join(directory, 'data'), media = path.join(directory, 'media')
  const cleanup: (() => Promise<void> | void)[] = []
  let closeFlight: Promise<void> | undefined
  async function close() {
    if (!closeFlight) closeFlight = (async () => {
      const failures: unknown[] = []
      for (const run of [...cleanup].reverse()) try { await run() } catch (error) { failures.push(error) }
      try { await assertOriginals(); await m.assertBoundBytes() } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, '真实 Owner/HTTPS 夹具未完全收口。')
    })()
    return closeFlight
  }
  t.after(close)
  for (const file of [directory, data, media]) { await mkdir(file, { mode: 0o700 }); await chmod(file, 0o700) }
  const originals = new Map<AudioId, Awaited<ReturnType<typeof wholeFile>>>()
  for (const format of formatCases) {
    const file = path.join(media, path.basename(inputs.entry(format.id).file))
    await writeFile(file, await inputs.bytes(format.id), { flag: 'wx', mode: 0o600 })
    originals.set(format.id, await wholeFile(file))
  }
  async function assertOriginals() {
    for (const format of formatCases) {
      const expected = originals.get(format.id); if (!expected) continue
      const actual = await wholeFile(path.join(media, path.basename(inputs.entry(format.id).file)))
      assert.equal(actual.bytes.length, expected.bytes.length); assert.equal(actual.sha256, expected.sha256)
      assert.deepEqual(actual.axes, expected.axes)
    }
  }
  let currentOwner: Awaited<ReturnType<typeof openOwner>> | undefined
  async function openOwner() {
    const epoch = randomUUID(), lifecycle: string[] = []
    const reader = m.reader.createMetadataReader({ concurrency: 1, maxPending: 1, onLifecycle(event) { lifecycle.push(event.type) } })
    const admission = m.admission.createScanReadAdmission({ isBusy: () => false })
    let domain: DatasetDomain | undefined, ownerClosing: Promise<void> | undefined
    const projection: DatasetProjectionPort = {
      async call<C extends DatasetProjectionCommand>(command: C, payload: DatasetProjectionCommandPayloads[C]): Promise<DatasetProjectionCommandResults[C]> {
        assert.ok(domain)
        if (command !== 'scanReadRelease') domain.assertOpen()
        const context = { datasetId: domain.datasetId, epoch }
        let result: unknown
        if (command === 'scanReadAcquire') result = admission.acquire(context)
        else if (command === 'scanReadWatchRevocation') result = await admission.watchRevocation(context, (payload as { permitId: string }).permitId)
        else if (command === 'scanReadRelease') result = admission.release(context, (payload as { permitId: string }).permitId)
        else throw new Error('此自有夹具不提供 Roon/Provider 投影。')
        return result as DatasetProjectionCommandResults[C]
      },
    }
    async function closeOwner() {
      if (!ownerClosing) ownerClosing = (async () => {
        try { await domain?.close() } finally { await reader.close(); admission.close() }
        assert.equal(lifecycle.filter(v => v === 'worker-start').length, lifecycle.filter(v => v === 'worker-exit').length)
        assert.equal(lifecycle.filter(v => v === 'lease-acquired').length, lifecycle.filter(v => v === 'lease-released').length)
        assert.deepEqual(admission.resourceCounts(), { permits: 0, revoked: 0, watches: 0, timers: 0, closed: true })
        assert.deepEqual(m.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 })
      })()
      return ownerClosing
    }
    cleanup.push(closeOwner)
    // testMode 仅禁用录音设备准入；Reader/源捕获/FD/统一锁全部使用实际实现。
    domain = await m.domain.prepareOwnedDatasetDomain({ dataDirectory: data, epoch, testMode: true, projection, scanMetadataReader: reader })
    assert.ok(domain.mobileMain)
    const beforeBoot = await domain.mobileMain({ kind: 'playback-load', datasetId: domain.datasetId })
    assert.equal('kind' in beforeBoot && beforeBoot.kind === 'mobile-error' && beforeBoot.status === 503, true)
    await domain.commitBoot()
    const database = await lstat(path.join(data, 'collection.v1.sqlite'))
    assert.equal(database.isFile() && !database.isSymbolicLink(), true)
    const active = domain
    async function command<C extends IpcCommand>(name: C, payload: IpcCommandPayloads[C], internal = false): Promise<IpcCommandResults[C]> {
      const request = { version: 1, id: randomUUID(), command: name, payload, expectedDatasetId: active.datasetId } as IpcRequest
      if (name === 'recordingSources.authorize') {
        // 原 Owner 的可信源授权入口使用 dispatch，原私有响应 guard 留住路径边界。
        const result = await active.dispatch(request), response = { version: 1, id: request.id, ok: true, result }
        const checked = validateIpcInternalResponseForCommand(response, 'recordingSources.authorize')
        assert.equal(checked.ok, true); assert.equal(validateIpcResponseForCommand(response, 'recordingSources.authorize').ok, false)
        if (!checked.ok || !checked.value.ok) throw new Error('真实源授权未通过原 Main 私有响应合同。')
        assert.deepEqual(Reflect.ownKeys(checked.value.result).sort(), ['authorized', 'availability', 'id', 'label'])
        return checked.value.result as IpcCommandResults[C]
      }
      if (internal) {
        assert.equal(validateIpcInternalRequest(request).ok, true)
        assert.ok(active.dispatchInternal)
        const result = await active.dispatchInternal(request)
        const checked = validateIpcInternalResponseForCommand({ version: 1, id: request.id, ok: true, result }, name as IpcInternalCommand)
        assert.equal(checked.ok, true)
        if (!checked.ok || !checked.value.ok) throw new Error('真实 Owner 私有回包校验失败。')
        return checked.value.result as IpcCommandResults[C]
      }
      const result = await active.dispatch(request)
      const checked = validateIpcResponseForCommand({ version: 1, id: request.id, ok: true, result }, name)
      assert.equal(checked.ok, true)
      if (!checked.ok || !checked.value.ok) throw new Error('真实 Owner 回包校验失败。')
      return checked.value.result
    }
    return { domain: active, epoch, lifecycle, command, close: closeOwner }
  }
  currentOwner = await openOwner()
  const source = await currentOwner.command('recordingSources.authorize', { commandId: randomUUID(), absolutePath: media })
  assert.equal(source.authorized, true); assert.equal(source.availability, 'ONLINE')
  const root = await currentOwner.command('localCatalog.registerRoot', { commandId: randomUUID(), sourceRootId: source.id, role: 'library' }, true)
  const scan = currentOwner.domain.localScan.start({ commandId: randomUUID(), libraryRootId: root.id, expectedRootRevision: root.revision })
  await bounded(currentOwner.domain.localScan.privateWait(scan.jobId), 20_000)
  const finished = currentOwner.domain.localScan.get(scan.jobId)
  assert.equal(finished.phase, 'completed')
  assert.deepEqual(finished.progress, { visited: '2', accepted: '2', rejected: '0' })
  assert.equal(currentOwner.lifecycle.filter(v => v === 'read-complete').length, 2)
  const page = await currentOwner.command('localCatalog.pageTracks', { offset: 0, limit: 200 })
  assert.equal(page.total, 2); assert.equal(page.items.length, 2)
  const facts = new Map<AudioId, { localTrackId: string; audio: MobileAudioInfo; durationMs: number }>()
  for (const format of formatCases) {
    const relative = path.basename(inputs.entry(format.id).file)
    const track = page.items.find(item => currentOwner!.domain.collection.localCatalog.privateAssetLocator(item.assetId).relative === relative)
    assert.ok(track)
    const detail = await currentOwner.command('localCatalog.trackDetail', { trackId: track.id })
    const observed = currentOwner.domain.collection.localScan.privateCurrentFileState(root.id, relative)
    assert.ok(observed?.value.readFacts); assert.equal(observed.value.outcome, 'accepted')
    assert.equal(observed.value.trackId, track.id); assert.equal(observed.value.assetId, track.assetId)
    const actual = currentOwner.domain.collection.localScan.privateDisplayFileParameters(track.id, detail.asset)
    assert.ok(actual); assert.ok(actual.bitsPerSample !== null && actual.durationMs !== null)
    assert.equal(actual.sampleRateHz, observed.value.readFacts.technical.sampleRateHz)
    assert.equal(actual.channels, observed.value.readFacts.technical.channels)
    assert.equal(actual.bitsPerSample, observed.value.readFacts.technical.bitsPerSample)
    const audio: MobileAudioInfo = { codec: format.codec, container: format.container,
      sampleRateHz: actual.sampleRateHz, channels: actual.channels, bitsPerSample: actual.bitsPerSample }
    facts.set(format.id, { localTrackId: track.id, audio, durationMs: actual.durationMs })
    const edition = await currentOwner.command('localCatalog.createEdition', { commandId: randomUUID(), title: `自有 ${format.id}`, edition: '原扫描文件' })
    await currentOwner.command('localCatalog.linkEditionTrack', { commandId: randomUUID(), editionId: edition.id, trackId: track.id, disc: 1, trackNumber: 1, sequence: 1 })
  }
  assert.deepEqual(m.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 })
  const protectorKey = randomBytes(32)
  cleanup.unshift(() => { protectorKey.fill(0) })
  const identity = await m.tls.loadOrCreateMobileIdentity({ directory: path.join(directory, 'identity'), hosts: ['127.0.0.1'], secretProtector: {
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', protectorKey, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', protectorKey, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  } })
  cleanup.unshift(() => { identity.authKey.fill(0) })
  const sourceTrace: SourceTrace[] = []
  let nextVerifyDelay: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined
  function delayNextRealVerifyReply() {
    assert.equal(nextVerifyDelay, undefined)
    const gate = { entered: deferred(), release: deferred() }
    nextVerifyDelay = gate; cleanup.push(gate.release.resolve)
    return gate
  }
  async function start(port = 0) {
    assert.ok(currentOwner)
    const owner = currentOwner
    async function requestOwner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
      assert.ok(owner.domain.mobileMain)
      const result = await owner.domain.mobileMain(request)
      assert.equal(m.protocol.isMobileOwnerPrivateResult(result, request), true)
      if (request.kind === 'media-source') {
        assert.ok('kind' in result && (result.kind === 'mobile-source-prepared' || result.kind === 'mobile-source-read'
          || result.kind === 'mobile-source-ack' || result.kind === 'mobile-error'))
        sourceTrace.push({ request: structuredClone(request.request), result: structuredClone(result) })
        if (request.request.operation === 'verify' && nextVerifyDelay && result.kind === 'mobile-source-ack') {
          const gate = nextVerifyDelay; nextVerifyDelay = undefined
          // 受控 transport delay：实际 Owner 已完成 verify；只延迟这一份原回执交付。
          gate.entered.resolve(); await gate.release.promise
        }
      }
      return result
    }
    const backend = m.main.createMobileBackend({ serverId: identity.serverId, datasetId: owner.domain.datasetId,
      authKey: new Uint8Array(identity.authKey), displayName: '自有真 Owner 媒体', environment: 'development', enablePlayback: true,
      requestOwner, assertCurrent: () => owner.domain.assertOpen(),
      resizeArtwork() { throw new Error('本用例不提供假封面缩放。') } })
    let server: ReturnType<Modules['https']['createMobileHttpsServer']> | undefined, closing: Promise<void> | undefined
    async function stop() {
      if (!closing) closing = (async () => {
        try { await server?.close() } finally { await backend.close() }
        const snapshot = backend.playbackSnapshot(); assert.ok(snapshot)
        assert.equal(snapshot.liveResources, 0); assert.equal(snapshot.preparing, 0); assert.equal(snapshot.readers, 0)
        assert.equal(snapshot.releasing, 0); assert.equal(snapshot.pendingPersistence, false); assert.equal(snapshot.closing, true)
        assert.deepEqual(m.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 })
      })()
      return closing
    }
    cleanup.push(stop)
    assert.ok(backend.playbackBackend)
    server = m.https.createMobileHttpsServer({ tls: { key: identity.privateKeyPEM, cert: identity.certificatePEM },
      host: '127.0.0.1', port, backend: backend.backend, playback: backend.playbackBackend })
    const listening = await server.start(); assert.equal(listening.certificateSha256, identity.certificateSha256)
    backend.activatePlayback(listening.baseUrl)
    const foreign = await owner.domain.mobileMain!({ kind: 'media-source', datasetId: randomUUID(), request: { operation: 'release', handle: randomUUID() } })
    assert.equal('kind' in foreign && foreign.kind === 'mobile-error' && foreign.status === 400, true)
    return { ...listening, identity, backend, owner, close: stop }
  }
  async function reopenOwner() {
    assert.ok(currentOwner); const originalId = currentOwner.domain.datasetId
    await currentOwner.close(); currentOwner = await openOwner()
    assert.equal(currentOwner.domain.datasetId, originalId)
  }
  return { inputs, m, data, media, originals, facts, identity, sourceTrace, start, reopenOwner,
    delayNextRealVerifyReply, assertOriginals, close }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
type Http = Awaited<ReturnType<Fixture['start']>>
interface RawReply { status: number; headers: [string, string][]; body: Uint8Array }
interface ClientOptions { method?: string; token?: string; body?: Uint8Array; key?: string; extraHeaders?: MobileHeaderPairs; capBytes?: number }

async function raw(h: Http, target: string, options: ClientOptions = {}): Promise<RawReply> {
  const url = new URL(target, h.baseUrl), origin = new URL(h.baseUrl)
  assert.equal(url.origin === origin.origin, true, '测试只访问当前自有 HTTPS origin。')
  const headers = ['Host', origin.host, 'Connection', 'close']
  if (options.token) headers.push('Authorization', `Bearer ${options.token}`)
  if (options.key) headers.push('Idempotency-Key', options.key)
  if (options.body) headers.push('Content-Type', 'application/json', 'Content-Length', String(options.body.length))
  for (const [name, value] of options.extraHeaders ?? []) headers.push(name, value)
  return await new Promise<RawReply>((resolve, reject) => {
    const failure = () => reject(new Error('自有 HTTPS 请求未完整结束。'))
    const request = httpsRequest({ hostname: origin.hostname, port: origin.port, path: url.pathname + url.search,
      method: options.method ?? 'GET', headers, ca: h.identity.certificatePEM, agent: false,
      checkServerIdentity(host, certificate) {
        const standard = checkServerIdentity(host, certificate); if (standard) return standard
        return hash(certificate.raw) === h.identity.certificateSha256 ? undefined : new Error('自有证书精确 pin 不匹配。')
      } }, response => {
      const socket = response.socket as TLSSocket
      try { assert.equal(socket.authorized, true); assert.equal(hash(socket.getPeerCertificate(true).raw) === h.identity.certificateSha256, true) }
      catch { request.destroy(); failure(); return }
      let bytes = 0; const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > (options.capBytes ?? MOBILE_API_RESPONSE_MAX_BYTES)) { request.destroy(); failure(); return }
        chunks.push(Buffer.from(chunk))
      })
      response.once('end', () => {
        const pairs: [string, string][] = []
        for (let index = 0; index < response.rawHeaders.length; index += 2) pairs.push([response.rawHeaders[index]!, response.rawHeaders[index + 1]!])
        resolve({ status: response.statusCode ?? 0, headers: pairs, body: new Uint8Array(Buffer.concat(chunks)) })
      })
      response.once('error', failure); response.once('aborted', failure)
    })
    request.once('error', failure); request.setTimeout(10_000, () => request.destroy()); request.end(options.body)
  })
}
function header(reply: RawReply, name: string): string | undefined {
  const pair = reply.headers.find(([key]) => key.toLowerCase() === name.toLowerCase()); return pair?.[1]
}
interface WireOptions { token?: string; key?: string; body?: unknown; resource?: MobileResourceSemanticContext }
async function wire<O extends MobileOperationId>(h: Http, operation: O, target: string,
  options: WireOptions = {}): Promise<{ raw: RawReply; decoded: MobileReplyMap[O] }> {
  const url = new URL(target, h.baseUrl), response = await raw(h, target, {
    method: MOBILE_OPERATION_TABLE[operation].method,
    ...(options.token === undefined ? {} : { token: options.token }), ...(options.key === undefined ? {} : { key: options.key }),
    ...(options.body === undefined ? {} : { body: Buffer.from(mobileCanonicalJson(options.body as MobileJsonValue)) }),
  })
  const checked = decodeMobileResponse(operation, { ...response, finalUrl: url.href }, { responseOrigin: h.baseUrl,
    requestPath: url.pathname, ...(options.resource === undefined ? {} : { resource: options.resource }) })
  assert.equal(checked.ok, true, '完整 HTTP 状态、headers、whole bytes 与可信 context 必须通过正式 codec。')
  if (!checked.ok) throw new Error('完整移动响应未通过正式 codec。')
  return { raw: response, decoded: checked.value }
}
type Wire<O extends MobileOperationId> = Awaited<ReturnType<typeof wire<O>>>
function success<O extends MobileOperationId>(response: Wire<O>): Exclude<MobileReplyMap[O]['body'], MobileErrorEnvelope | null> {
  assert.equal(response.decoded.category, 'success')
  return response.decoded.body as Exclude<MobileReplyMap[O]['body'], MobileErrorEnvelope | null>
}
function safeFailure<O extends MobileOperationId>(response: Wire<O>, status: number, code: string) {
  assert.equal(response.raw.status, status); assert.equal(response.decoded.category, 'error')
  assert.equal((response.decoded.body as MobileErrorEnvelope).error.code, code)
}
function sameWholeReply(a: RawReply, b: RawReply) {
  assert.equal(a.status, b.status); assert.equal(a.body.length, b.body.length)
  assert.equal(hash(a.body) === hash(b.body), true, '原回执 whole body 必须相等，失败报告不输出许可/票据/token。')
}
async function pair(h: Http, installationId = randomUUID()) {
  const permit = await h.backend.auth.issuePairing(), key = randomUUID()
  const body: MobilePairingClaim = { pairingSecret: permit.pairingSecret, installationId, deviceName: '自有合成设备' }
  const reply = await wire(h, 'claimPairing', '/mobile/v1/pairings/claim', { key, body })
  assert.equal(reply.raw.status, 201)
  const tokens = success(reply) as MobileTokenPair
  sameWholeReply(reply.raw, (await wire(h, 'claimPairing', '/mobile/v1/pairings/claim', { key, body })).raw)
  return { tokens, installationId }
}
async function session(h: Http, tokens: MobileTokenPair) {
  const body = { clientInstanceId: randomUUID() }, key = randomUUID()
  const reply = await wire(h, 'createSession', '/mobile/v1/sessions', { token: tokens.accessToken, key, body })
  assert.equal(reply.raw.status, 201); const value = success(reply) as MobileSession
  assert.equal(value.deviceId, tokens.deviceId)
  sameWholeReply(reply.raw, (await wire(h, 'createSession', '/mobile/v1/sessions', { token: tokens.accessToken, key, body })).raw)
  return { value, body, key, original: reply.raw }
}
async function catalog(f: Fixture, h: Http, tokens: MobileTokenPair) {
  const reply = await wire(h, 'listTracks', '/mobile/v1/tracks?source=local&limit=100', { token: tokens.accessToken })
  const page = success(reply) as MobileTrackPage; assert.equal(page.items.length, 2); assert.equal(page.nextCursor, null)
  const selected = new Map<AudioId, MobileTrack>()
  for (const format of formatCases) {
    const facts = f.facts.get(format.id); assert.ok(facts)
    const track = page.items.find(item => item.id.split(':')[2] === facts.localTrackId); assert.ok(track)
    assert.equal(track.source, 'local'); assert.deepEqual(structuredClone(track.audio), facts.audio)
    assert.equal(track.durationMs, facts.durationMs)
    const detail = success(await wire(h, 'getTrack', `/mobile/v1/tracks/${track.id}`, { token: tokens.accessToken })) as MobileTrack
    assert.equal(valueHash(detail) === valueHash(track), true)
    selected.set(format.id, track)
  }
  const capabilityReply = await wire(h, 'getCapabilities', '/mobile/v1/capabilities', { token: tokens.accessToken })
  const capabilities = success<'getCapabilities'>(capabilityReply)
  assert.equal(capabilities.localPlayback, true); assert.equal(capabilities.transcoding, false)
  assert.equal(capabilities.neteasePlayback, false)
  const expectedCapabilities = { contractVersion: '0.1.0', localPlayback: true, neteasePlayback: false, transcoding: false,
    hls: false, preparedVariants: false, qualityProfiles: ['auto', 'lossless'], maxConcurrentSessions: 2 }
  assert.deepEqual(Object.keys(capabilities).sort(), Object.keys(expectedCapabilities).sort())
  assert.deepEqual(structuredClone(capabilities), expectedCapabilities)
  // 核整个实际 HTTP 成功 body；内部资源资格不能作为 UI capability 或 SDK 位深采纳证据。
  assert.deepEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(capabilityReply.raw.body)) as unknown, expectedCapabilities)
  assert.equal(Object.getOwnPropertyDescriptor(capabilities, 'resourceFormatBitDepth'), undefined)
  assert.equal(Object.getOwnPropertyDescriptor(capabilities, 'resourceFormatBitDepthCapabilityVersion'), undefined)
  return selected
}
function requestFor(track: MobileTrack): MobileResourceRequest {
  assert.ok(track.audio.sampleRateHz && track.audio.channels && track.audio.bitsPerSample)
  return { trackId: track.id, versionId: track.versionId, contentRevision: track.contentRevision,
    quality: { profile: 'lossless', allowLossyFallback: false, preferredTransport: 'file' },
    formats: [{ codec: track.audio.codec, container: track.audio.container, maxSampleRateHz: track.audio.sampleRateHz,
      maxChannels: track.audio.channels, maxBitsPerSample: track.audio.bitsPerSample }] }
}
async function context(h: Http, tokens: MobileTokenPair, sessionId: string, track: MobileTrack,
  request: MobileResourceRequest, expectedResourceId: string | null = null): Promise<MobileResourceSemanticContext> {
  assert.ok(h.backend.playbackBackend)
  const caps = await h.backend.playbackBackend.resourceCapabilities(tokens.accessToken, sessionId, h.baseUrl, new AbortController().signal)
  assert.equal(caps.scope.deviceId, tokens.deviceId); assert.equal(caps.scope.serverId, h.identity.serverId)
  return { ...caps, request, source: track.source, sourceAudio: track.audio, expectedResourceId }
}
async function createResource(h: Http, tokens: MobileTokenPair, sessionId: string, track: MobileTrack, key = randomUUID()) {
  const request = requestFor(track), semantic = await context(h, tokens, sessionId, track, request)
  const target = `/mobile/v1/sessions/${sessionId}/resources`
  const response = await wire(h, 'createResource', target, { token: tokens.accessToken, key, body: request, resource: semantic })
  assert.ok(response.raw.status === 201 || response.raw.status === 202)
  const value = success(response) as MobileResource
  assert.equal(value.state, response.raw.status === 201 ? 'ready' : 'preparing')
  assert.deepEqual(structuredClone(value.sourceAudio), structuredClone(track.audio))
  return { id: value.id, sessionId, request, track, key, target, value, original: response.raw }
}
type Created = Awaited<ReturnType<typeof createResource>>
async function getResource(h: Http, tokens: MobileTokenPair, created: Created) {
  const semantic = await context(h, tokens, created.sessionId, created.track, created.request, created.id)
  return await wire(h, 'getResource', `${created.target}/${created.id}`, { token: tokens.accessToken, resource: semantic })
}
async function ready(h: Http, tokens: MobileTokenPair, created: Created): Promise<MobileReadyResource> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const reply = await getResource(h, tokens, created)
    assert.equal(reply.raw.status, 200); const value = success(reply) as MobileResource
    if (value.state === 'ready') {
      const semantic = await context(h, tokens, created.sessionId, created.track, created.request, created.id)
      assert.equal(validateMobileReadyAudio(value, created.request, semantic).ok, true)
      assert.deepEqual(structuredClone(value.sourceAudio), structuredClone(created.track.audio))
      assert.deepEqual(structuredClone(value.media.actualAudio), structuredClone(created.track.audio))
      assert.equal(value.processing.mode, 'direct'); assert.equal(value.processing.fromPreparedCache, false)
      assert.equal(value.media.transport, 'file'); assert.equal(value.media.seekable, true)
      assert.equal(value.media.durationMs, created.track.durationMs)
      assert.equal(new URL(value.media.url).origin === h.baseUrl, true)
      return value
    }
    assert.equal(value.state, 'preparing'); await pause(5)
  }
  throw new Error('原资源 GET 未在既定准备期限内 ready。')
}
async function readersQuiet(h: Http) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const snapshot = h.backend.playbackSnapshot(); assert.ok(snapshot)
    if (snapshot.readers === 0) return
    await pause(5)
  }
  throw new Error('真实 HTTP reader 未确认 quiet。')
}
function traceCount(f: Fixture, operation: MobileOwnerSourceRequest['operation'], handle?: string): number {
  return f.sourceTrace.filter(row => row.request.operation === operation
    && (handle === undefined || ('handle' in row.request ? row.request.handle : row.request.selection.resourceId) === handle)).length
}
function releaseQuiet(f: Fixture, handle: string) {
  const acknowledgements = f.sourceTrace.filter(row => row.request.operation === 'release' && row.request.handle === handle)
  assert.ok(acknowledgements.length > 0)
  assert.equal(acknowledgements.every(row => row.result.kind === 'mobile-source-ack' && row.result.quiet), true)
}
function physicalQuiet(f: Fixture) {
  assert.deepEqual(f.m.locks.physicalResourceLocks.combinedSnapshot(), { readers: 0, writers: 0, resources: 0 })
}
async function stream(h: Http, resource: MobileReadyResource, original: Uint8Array, options: {
  method?: 'GET' | 'HEAD'; range?: string; ifRange?: string; status: 200 | 206 | 400 | 416; start?: number; end?: number
}) {
  const method = options.method ?? 'GET', extraHeaders: [string, string][] = []
  if (options.range !== undefined) extraHeaders.push(['Range', options.range])
  if (options.ifRange !== undefined) extraHeaders.push(['If-Range', options.ifRange])
  const reply = await raw(h, resource.media.url, { method, extraHeaders, capBytes: original.length })
  assert.equal(reply.status, options.status); assert.equal(header(reply, 'accept-ranges'), 'bytes')
  const validated = validateMobileMediaStreamHeaders(method === 'HEAD' ? 'headMediaAsset' : 'getMediaAsset', options.status,
    reply.headers, original.length, options.ifRange === undefined ? options.range : undefined)
  assert.equal(validated.ok, true)
  if (!validated.ok) throw new Error('真实媒体 headers 未通过流式合同。')
  assert.equal(validateMobileMediaStreamCompletion(validated.value, reply.body.length).ok, true)
  const expected = method === 'HEAD' || options.status >= 400 ? new Uint8Array()
    : original.subarray(options.start ?? 0, (options.end ?? (original.length - 1)) + 1)
  assert.equal(reply.body.length, expected.length); assert.equal(hash(reply.body) === hash(expected), true)
  await readersQuiet(h)
  return reply
}
async function denyMedia(h: Http, resource: MobileReadyResource, status: number, code: string) {
  const rawReply = await raw(h, resource.media.url)
  assert.equal(rawReply.status, status)
  const url = new URL(resource.media.url), decoded = decodeMobileResponse('getMediaAsset', { ...rawReply, finalUrl: url.href },
    { responseOrigin: h.baseUrl, requestPath: url.pathname })
  assert.equal(decoded.ok, true)
  if (!decoded.ok) throw new Error('媒体安全失败回包未通过正式 codec。')
  assert.equal(decoded.value.category, 'error'); assert.equal((decoded.value.body as MobileErrorEnvelope).error.code, code)
}
async function remove(h: Http, tokens: MobileTokenPair, f: Fixture, created: Created) {
  const reply = await wire(h, 'releaseResource', `${created.target}/${created.id}`, { token: tokens.accessToken })
  assert.equal(reply.raw.status, 204); assert.equal(reply.raw.body.length, 0)
  releaseQuiet(f, created.id)
  assert.equal(h.backend.playbackSnapshot()?.readers, 0)
}

test('002真 Owner 的 WAV/ALAC 全字节与 Range/HEAD，原初始回执和受控延迟202均不改写', { timeout: 120_000 }, async t => {
  const f = await fixture(t), h = await f.start(), device = await pair(h), s = await session(h, device.tokens)
  const tracks = await catalog(f, h, device.tokens), actualInitialStatuses: number[] = []
  for (const format of formatCases) {
    const track = tracks.get(format.id); assert.ok(track)
    const gate = format.id === 'core-m4a-alac' ? f.delayNextRealVerifyReply() : undefined
    let created: Created
    try {
      created = await createResource(h, device.tokens, s.value.id, track)
      actualInitialStatuses.push(created.original.status)
      if (gate) {
        await bounded(gate.entered.promise, 10_000)
        assert.equal(created.original.status, 202); assert.equal(created.value.state, 'preparing')
        const pending = success(await getResource(h, device.tokens, created)) as MobileResource
        assert.equal(pending.state, 'preparing'); assert.equal(Object.hasOwn(pending, 'media'), false)
      }
    } finally { gate?.release.resolve() }
    const resource = await ready(h, device.tokens, created), original = f.originals.get(format.id); assert.ok(original)
    const prepares = traceCount(f, 'prepare', created.id)
    assert.equal(prepares, 1)
    const semantic = await context(h, device.tokens, s.value.id, track, created.request, created.id)
    sameWholeReply(created.original, (await wire(h, 'createResource', created.target,
      { token: device.tokens.accessToken, key: created.key, body: created.request, resource: semantic })).raw)
    assert.equal(traceCount(f, 'prepare', created.id), prepares, '查询原回执不能再次捕获/打开 FD。')
    const physical = f.m.locks.physicalResourceLocks.inspect([{ dev: String(original.stat.dev), ino: String(original.stat.ino) }])
    assert.ok(physical.readers > 0); assert.equal(physical.writers, 0)
    const full = await stream(h, resource, original.bytes, { status: 200 })
    assert.equal(header(full, 'content-type'), format.contentType)
    await stream(h, resource, original.bytes, { range: 'bytes=7-19', status: 206, start: 7, end: 19 })
    await stream(h, resource, original.bytes, { range: 'bytes=-17', status: 206, start: original.bytes.length - 17 })
    await stream(h, resource, original.bytes, { range: 'bytes=11-', status: 206, start: 11 })
    await stream(h, resource, original.bytes, { range: 'bytes=2-4', ifRange: 'changed-validator', status: 200 })
    const noBodyReads = traceCount(f, 'read', created.id)
    await stream(h, resource, original.bytes, { range: `bytes=${original.bytes.length}-`, status: 416 })
    for (const range of ['bytes=0-1,3-4', 'invalid-range']) {
      const invalid = await raw(h, resource.media.url, { extraHeaders: [['Range', range]] })
      assert.equal(invalid.status, 400); assert.equal(invalid.body.length, 0)
    }
    for (const range of ['bytes=0-1,3-4', 'invalid-range', 'bytes=999999999-']) {
      const head = await stream(h, resource, original.bytes, { method: 'HEAD', range, status: 200 })
      assert.equal(header(head, 'content-length'), String(original.bytes.length)); assert.equal(header(head, 'content-range'), undefined)
    }
    assert.equal(traceCount(f, 'read', created.id), noBodyReads, '416/坏 Range/D2 HEAD 不得读取源正文。')
    await remove(h, device.tokens, f, created); physicalQuiet(f)
    await denyMedia(h, resource, 410, 'RESOURCE_RELEASED')
    safeFailure(await getResource(h, device.tokens, created), 410, 'RESOURCE_RELEASED')
    await f.assertOriginals()
  }
  t.diagnostic(JSON.stringify({ boundary: '真实初始HTTP状态；第二格式仅控制原verify回执交付', actualInitialStatuses }))
  const closed = await wire(h, 'closeSession', `/mobile/v1/sessions/${s.value.id}`, { token: device.tokens.accessToken })
  assert.equal(closed.raw.status, 204); physicalQuiet(f)
})

test('002真 Owner refresh 保留媒体 epoch；renew 保留原回执和旧票原60秒期限，旧票到期新票仍可读', { timeout: 120_000 }, async t => {
  const f = await fixture(t), h = await f.start(), device = await pair(h), s = await session(h, device.tokens)
  const track = (await catalog(f, h, device.tokens)).get('core-wav'); assert.ok(track)
  const created = await createResource(h, device.tokens, s.value.id, track), first = await ready(h, device.tokens, created)
  const original = f.originals.get('core-wav'); assert.ok(original)
  const firstExpiry = Date.parse(first.media.expiresAt), firstLifetime = firstExpiry - Date.now()
  assert.ok(firstLifetime > 0 && firstLifetime <= 60_000, '使用生产原60秒票据，不注入时钟或调整TTL。')
  const beforeRefresh = await h.backend.auth.authenticate(device.tokens.accessToken)
  const refreshBody = { refreshToken: device.tokens.refreshToken }, refreshKey = randomUUID()
  const refreshedReply = await wire(h, 'refreshToken', '/mobile/v1/auth/refresh', { body: refreshBody, key: refreshKey })
  const refreshed = success(refreshedReply) as MobileTokenPair
  sameWholeReply(refreshedReply.raw, (await wire(h, 'refreshToken', '/mobile/v1/auth/refresh', { body: refreshBody, key: refreshKey })).raw)
  const afterRefresh = await h.backend.auth.authenticate(refreshed.accessToken)
  assert.equal(beforeRefresh.deviceId, afterRefresh.deviceId); assert.equal(beforeRefresh.deviceEpoch, afterRefresh.deviceEpoch)
  assert.ok(afterRefresh.generation > beforeRefresh.generation)
  safeFailure(await wire(h, 'getSession', `/mobile/v1/sessions/${s.value.id}`, { token: device.tokens.accessToken }), 401, 'UNAUTHORIZED')
  await stream(h, first, original.bytes, { range: 'bytes=1-9', status: 206, start: 1, end: 9 })
  // 与原票签发分开至少一秒；保留真实60秒绝对到期，而非延长旧票或伪造观察。
  await pause(1000)
  const renewKey = randomUUID(), semantic = await context(h, refreshed, s.value.id, track, created.request, created.id)
  const renewedReply = await wire(h, 'renewResource', `${created.target}/${created.id}/renew`,
    { token: refreshed.accessToken, key: renewKey, body: {}, resource: semantic })
  assert.equal(renewedReply.raw.status, 200); const second = success(renewedReply) as MobileReadyResource
  assert.equal(second.state, 'ready'); assert.equal(hash(Buffer.from(second.media.url)) === hash(Buffer.from(first.media.url)), false)
  assert.ok(Date.parse(second.media.expiresAt) > firstExpiry)
  sameWholeReply(renewedReply.raw, (await wire(h, 'renewResource', `${created.target}/${created.id}/renew`,
    { token: refreshed.accessToken, key: renewKey, body: {}, resource: semantic })).raw)
  assert.equal(traceCount(f, 'prepare', created.id), 1)
  await stream(h, first, original.bytes, { range: 'bytes=0-2', status: 206, start: 0, end: 2 })
  await stream(h, second, original.bytes, { range: 'bytes=-3', status: 206, start: original.bytes.length - 3 })
  // 到旧票最后五秒再作新的具体续租，避免把测试调度余量误当延长旧票。
  const beforeExpiry = firstExpiry - Date.now() - 5000
  assert.ok(beforeExpiry > 0 && beforeExpiry < 60_000)
  await pause(beforeExpiry)
  const latestReply = await wire(h, 'renewResource', `${created.target}/${created.id}/renew`,
    { token: refreshed.accessToken, key: randomUUID(), body: {}, resource: await context(h, refreshed, s.value.id, track, created.request, created.id) })
  const latest = success(latestReply) as MobileReadyResource
  assert.ok(Date.parse(latest.media.expiresAt) > Date.parse(second.media.expiresAt))
  const remaining = firstExpiry - Date.now() + 30
  assert.ok(remaining > 0 && remaining <= 60_030)
  await pause(remaining)
  assert.ok(Date.now() >= firstExpiry)
  await denyMedia(h, first, 401, 'TICKET_EXPIRED')
  await stream(h, latest, original.bytes, { range: 'bytes=0-4', status: 206, start: 0, end: 4 })
  assert.equal(h.backend.playbackSnapshot()?.liveResources, 1)
  await remove(h, refreshed, f, created); physicalQuiet(f)
  await denyMedia(h, latest, 410, 'RESOURCE_RELEASED'); await f.assertOriginals()
})

test('002两设备实际scope隔离，logout与同安装重新配对撤销原epoch且不污染另一设备', { timeout: 120_000 }, async t => {
  const f = await fixture(t), h = await f.start(), a = await pair(h), b = await pair(h)
  const aSession = await session(h, a.tokens), bSession = await session(h, b.tokens)
  const tracks = await catalog(f, h, a.tokens), wav = tracks.get('core-wav'), alac = tracks.get('core-m4a-alac')
  assert.ok(wav && alac); assert.equal(a.tokens.deviceId === b.tokens.deviceId, false)
  safeFailure(await wire(h, 'getSession', `/mobile/v1/sessions/${aSession.value.id}`, { token: b.tokens.accessToken }), 404, 'INVALID_REQUEST')
  const aCreated = await createResource(h, a.tokens, aSession.value.id, wav), aReady = await ready(h, a.tokens, aCreated)
  const bCreated = await createResource(h, b.tokens, bSession.value.id, alac), bReady = await ready(h, b.tokens, bCreated)
  safeFailure(await wire(h, 'releaseResource', `${aCreated.target}/${aCreated.id}`, { token: b.tokens.accessToken }), 404, 'INVALID_REQUEST')
  const logout = await wire(h, 'logout', '/mobile/v1/auth/logout', { token: a.tokens.accessToken, body: {} })
  assert.equal(logout.raw.status, 204); releaseQuiet(f, aCreated.id)
  await denyMedia(h, aReady, 403, 'DEVICE_REVOKED')
  const originalAlac = f.originals.get('core-m4a-alac'); assert.ok(originalAlac)
  await stream(h, bReady, originalAlac.bytes, { status: 200 })
  const a2 = await pair(h, a.installationId)
  assert.equal(a2.tokens.deviceId, a.tokens.deviceId)
  safeFailure(await wire(h, 'getSession', `/mobile/v1/sessions/${aSession.value.id}`, { token: a2.tokens.accessToken }), 403, 'DEVICE_REVOKED')
  const a2Session = await session(h, a2.tokens), a2Created = await createResource(h, a2.tokens, a2Session.value.id, wav)
  const a2Ready = await ready(h, a2.tokens, a2Created), a2Principal = await h.backend.auth.authenticate(a2.tokens.accessToken)
  const a3 = await pair(h, a.installationId), a3Principal = await h.backend.auth.authenticate(a3.tokens.accessToken)
  assert.equal(a3.tokens.deviceId, a2.tokens.deviceId); assert.ok(a3Principal.deviceEpoch > a2Principal.deviceEpoch)
  releaseQuiet(f, a2Created.id); await denyMedia(h, a2Ready, 403, 'DEVICE_REVOKED')
  safeFailure(await wire(h, 'getSession', `/mobile/v1/sessions/${a2Session.value.id}`, { token: a3.tokens.accessToken }), 403, 'DEVICE_REVOKED')
  await stream(h, bReady, originalAlac.bytes, { range: 'bytes=0-8', status: 206, start: 0, end: 8 })
  assert.equal(h.backend.playbackSnapshot()?.liveResources, 1)
  const closeB = await wire(h, 'closeSession', `/mobile/v1/sessions/${bSession.value.id}`, { token: b.tokens.accessToken })
  assert.equal(closeB.raw.status, 204); releaseQuiet(f, bCreated.id); physicalQuiet(f)
  await denyMedia(h, bReady, 410, 'SESSION_CLOSED'); await f.assertOriginals()
})

test('002生产 Main/唯一Owner真实关闭并同库冷重开，原回执仍原样但旧资源/票据不得重开FD', { timeout: 120_000 }, async t => {
  const f = await fixture(t), h = await f.start(), a = await pair(h), s = await session(h, a.tokens)
  const track = (await catalog(f, h, a.tokens)).get('core-wav'); assert.ok(track)
  const created = await createResource(h, a.tokens, s.value.id, track), oldReady = await ready(h, a.tokens, created)
  const original = f.originals.get('core-wav'); assert.ok(original)
  await stream(h, oldReady, original.bytes, { status: 200 })
  assert.equal(traceCount(f, 'prepare', created.id), 1)
  const port = Number(new URL(h.baseUrl).port)
  await h.close(); releaseQuiet(f, created.id); physicalQuiet(f)
  await f.reopenOwner()
  const cold = await f.start(port)
  assert.equal(cold.baseUrl === h.baseUrl, true); assert.equal(cold.identity.serverId, h.identity.serverId)
  assert.equal(cold.certificateSha256, h.certificateSha256)
  const oldPrepareCount = traceCount(f, 'prepare', created.id)
  const beforeReadCount = traceCount(f, 'read', created.id)
  const originalSession = await wire(cold, 'createSession', '/mobile/v1/sessions', { token: a.tokens.accessToken, key: s.key, body: s.body })
  sameWholeReply(s.original, originalSession.raw)
  const semantic = await context(cold, a.tokens, s.value.id, track, created.request, created.id)
  const originalResource = await wire(cold, 'createResource', created.target,
    { token: a.tokens.accessToken, key: created.key, body: created.request, resource: semantic })
  sameWholeReply(created.original, originalResource.raw)
  safeFailure(await getResource(cold, a.tokens, created), 503, 'SERVICE_RESTARTED')
  await denyMedia(cold, oldReady, 503, 'SERVICE_RESTARTED')
  assert.equal(traceCount(f, 'prepare', created.id), oldPrepareCount)
  assert.equal(traceCount(f, 'read', created.id), beforeReadCount)
  assert.equal(cold.backend.playbackSnapshot()?.liveResources, 0); physicalQuiet(f)
  // 新intent走新Owner完整源捕获；不把冷启动的旧GET或原回执当重开旧FD。
  const freshTrack = (await catalog(f, cold, a.tokens)).get('core-wav'); assert.ok(freshTrack)
  assert.equal(freshTrack.id, track.id); assert.equal(freshTrack.versionId, track.versionId); assert.equal(freshTrack.contentRevision, track.contentRevision)
  const fresh = await createResource(cold, a.tokens, s.value.id, freshTrack), freshReady = await ready(cold, a.tokens, fresh)
  assert.equal(fresh.id === created.id, false)
  await stream(cold, freshReady, original.bytes, { status: 200 })
  await remove(cold, a.tokens, f, fresh); physicalQuiet(f); await f.assertOriginals()
})
