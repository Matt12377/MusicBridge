import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Writable } from 'node:stream'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { MobileServiceError } from '../../../../packages/bridge-core/src/mobile/types.js'
import { createMobileRangeTimingProbe, copyMobileRangeTimingSnapshot, type MobileRangeTimingContext, type MobileRangeTimingSnapshot } from '../../src/main/mobile-range-timing.js'
import { MainDiagnosticRecorder, writeDiagnosticReport, type DiagnosticReportWriteInput } from '../../src/main/diagnostics.js'
import { sendMobileMediaResponse, getMobileMediaReleaseCompletion, MobileMediaResponseError, type MobileMediaReader, type MobileMediaReply, type MobileMediaResponseLimits } from '../../src/main/mobile-media-response.js'

const requestId = '11111111-1111-4111-8111-111111111111'
const claim = { requestId, method: 'GET', operation: 'getMediaAsset', range: 'bytes=0-262143' }
const content = Buffer.alloc(262144, 73)
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
/** 原Writable的真实callback/drain；不声称真实TLS/Owner/媒体设备证据。 */
class Response extends Writable {
  headersSent = false
  statusCode = 0
  readonly chunks: Buffer[] = []
  private held: (() => void)[] = []
  constructor(private automatic = true) { super({ highWaterMark: 16, autoDestroy: false }) }
  writeHead(status: number, _headers: string[]) { this.statusCode = status; this.headersSent = true; return this }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk)); if (this.automatic) setImmediate(callback); else this.held.push(callback)
  }
  flush(): void { for (const callback of this.held.splice(0)) callback() }
}
function fixture(t: TestContext, options: { automatic?: boolean; advance?(amount: number): void; reader?: MobileMediaReader; authority?(): Promise<void> } = {}) {
  const socket = new Socket(), request = new IncomingMessage(socket), response = new Response(options.automatic ?? true), controller = new AbortController()
  request.method = 'GET'
  let offset = 0, closes = 0, authorities = 0
  const pulls: number[] = []
  const reader = options.reader ?? {
    async read(maxBytes: number) {
      pulls.push(maxBytes); options.advance?.(13)
      if (offset === content.length) return null
      const chunk = content.subarray(offset, Math.min(offset + maxBytes, content.length)); offset += chunk.length; return chunk
    },
    async close() { closes++; options.advance?.(19) },
  }
  const reply: MobileMediaReply = { operation: 'getMediaAsset', status: 206, expectedBodyBytes: content.length, fullContentLength: content.length * 2,
    headers: [['Content-Type', 'audio/wav'], ['Content-Length', String(content.length)], ['Content-Range', 'bytes 0-262143/524288'], ['Accept-Ranges', 'bytes']],
    rangeRequested: claim.range, resourceAbortSignal: new AbortController().signal, ticketExpiresAtMs: Date.now() + 60_000, reader,
    async beforeSend() { authorities++; options.advance?.(11); await options.authority?.() },
  }
  t.after(() => { controller.abort(); response.flush(); response.destroy(); socket.destroy() })
  return { request, response, http: response as unknown as ServerResponse, controller, reply, pulls,
    bytes: () => Buffer.concat(response.chunks), closes: () => closes, authorities: () => authorities }
}
async function send(f: ReturnType<typeof fixture>, timing?: MobileRangeTimingContext, limits: Readonly<MobileMediaResponseLimits> = {}): Promise<void> {
  let error: unknown, failed = false
  try { await sendMobileMediaResponse(f.request, f.http, f.reply, f.controller.signal, limits, timing) }
  catch (failure) { failed = true; error = failure; throw failure }
  finally { timing?.finish(failed ? 'reject' : 'ok', error) }
}

test('单Range诊断：默认关闭保持原字节与调用，闭集副本及Main私有0600导出拒绝毒字段', async t => {
  let clockCalls = 0
  const off = createMobileRangeTimingProbe({ now() { clockCalls++; throw new Error('关闭时不应读取时钟。') } })
  assert.equal(off.claim(claim), undefined)
  const f = fixture(t); await send(f, off.claim(claim))
  assert.deepEqual(f.bytes(), content); assert.deepEqual(f.pulls, [65536, 65536, 65536, 65536, 1])
  assert.equal(f.authorities(), 5); assert.equal(f.closes(), 1); assert.equal(clockCalls, 0)
  assert.equal(off.snapshot().claimed, false); assert.deepEqual(off.snapshot().records, [])
  let clock = 0
  const on = createMobileRangeTimingProbe({ enabled: true, now: () => clock, epochNow: () => 1800000000000 })
  for (const invalid of [{ ...claim, method: 'HEAD' }, { ...claim, range: 'bytes=0-1' }, { ...claim, range: 'bytes=0-' },
    { ...claim, ifRange: 'private-never-recorded' }, { ...claim, requestId: '非原UUID' }]) assert.equal(on.claim(invalid), undefined)
  const context = on.claim(claim); assert.ok(context)
  const opening = context.start('open'); clock += 2; context.end(opening); context.reply(206, content.length)
  for (let index = 0; index < 100; index++) { const span = context.start('read', 1); clock++; context.end(span, { bytes: 1 }) }
  const original = new MobileServiceError(401, 'UNAUTHORIZED')
  const business = context.start('before-write-authority', 1); clock++; context.reject(business, original)
  const cleanup = context.start('close-wait'); clock++; context.reject(cleanup, new MobileMediaResponseError('RELEASE_TIMEOUT'), 'pending')
  const actual = context.start('actual-close'); clock++; context.end(actual, { quiet: 'confirmed' }); context.finish('reject', original)
  assert.equal(on.claim({ ...claim, requestId: '22222222-2222-4222-8222-222222222222' }), undefined)
  const snapshot = on.snapshot(); assert.ok(copyMobileRangeTimingSnapshot(snapshot)); assert.ok(snapshot.records.length <= 40)
  assert.ok(snapshot.droppedRecords > 0); assert.equal(snapshot.firstBusinessFailure?.stage, 'before-write-authority')
  assert.equal(snapshot.firstCleanupFailure?.stage, 'close-wait'); assert.equal(snapshot.terminal, true)
  const serialized = JSON.stringify(snapshot); assert.equal(serialized.includes(requestId), false); assert.doesNotMatch(serialized, /private-never-recorded|ticket|Cookie|https?:|\/Users\//u)
  let getters = 0, traps = 0
  const getter = { ...snapshot, records: [Object.defineProperty({ ...snapshot.records[0] }, 'stage', { enumerable: true, get() { getters++; return 'open' } })] }
  const proxy = new Proxy(snapshot, { ownKeys() { traps++; return [] }, getPrototypeOf() { traps++; return null } })
  const poisoned = { ...snapshot, records: [{ ...snapshot.records[0], path: '/private-untrusted' }] }
  const nonFinite = { ...snapshot, records: [{ ...snapshot.records[0], durationMs: Number.NaN }] }
  for (const raw of [getter, proxy, poisoned, nonFinite]) assert.equal(copyMobileRangeTimingSnapshot(raw), null)
  assert.equal(getters, 0); assert.equal(traps, 0)
  const tmp = process.env.TMPDIR, hosted = process.env.RUNNER_TEMP
  assert.ok(typeof tmp === 'string' && path.isAbsolute(tmp) && (tmp.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/')
    || process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
      && typeof hosted === 'string' && path.isAbsolute(hosted) && tmp.startsWith(hosted + path.sep)))
  const directory = await mkdtemp(path.join(tmp, 'mb-single-range-export-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const recorder = new MainDiagnosticRecorder(), localAlbum = { schema: 'v39.local-album-safe-trace.v1' as const, records: [], firstRejects: [], droppedRecords: 0 }
  const input: DiagnosticReportWriteInput = { platform: { platform: 'darwin', arch: 'arm64', appVersion: 'synthetic', electronVersion: '43.4.0', nodeVersion: '22.0.0' },
    main: recorder.snapshot(), core: { ...recorder.snapshot(), component: 'core' },
    privateEvidence: { version: 1, localAlbum, localPlayback: [], mobileRangeTiming: snapshot } }
  const output = path.join(directory, 'accepted.json'); await writeDiagnosticReport(output, input)
  assert.equal((await stat(output)).mode & 0o777, 0o600)
  const report = JSON.parse(await readFile(output, 'utf8')) as { privateEvidence: Record<string, unknown> }
  assert.deepEqual(report.privateEvidence, { version: 1, localAlbum, localPlayback: [], mobileRangeTiming: snapshot })
  await assert.rejects(writeDiagnosticReport(path.join(directory, 'rejected.json'), { ...input,
    privateEvidence: { ...input.privateEvidence!, mobileRangeTiming: poisoned as unknown as MobileRangeTimingSnapshot } }), /安全闭集/u)
  assert.deepEqual(await readdir(directory), ['accepted.json'])
});

test('单Range诊断：四块加原EOF的读取与写前检查分桶，write等待真实callback和drain且仅关闭一次', async t => {
  let clock = 0
  const probe = createMobileRangeTimingProbe({ enabled: true, now: () => clock, epochNow: () => 1800000000000 }), context = probe.claim(claim)
  assert.ok(context); const opening = context.start('open'); clock += 7; context.end(opening); context.reply(206, content.length)
  const f = fixture(t, { automatic: false, advance: amount => { clock += amount } }), flight = send(f, context)
  t.after(async () => { f.controller.abort(); f.response.flush(); await flight.catch(() => undefined) })
  for (let ordinal = 1; ordinal <= 4; ordinal++) {
    await settle(); assert.equal(f.pulls.length, ordinal); assert.equal(f.response.chunks.length, ordinal)
    assert.equal(probe.snapshot().records.filter(row => row.stage === 'write').length, ordinal - 1)
    await settle(); assert.equal(f.pulls.length, ordinal, '背压未drain前不能提前拉下一块。')
    clock += 17; f.response.flush()
  }
  await flight; await getMobileMediaReleaseCompletion(f.reply)
  const snapshot = probe.snapshot(); assert.ok(copyMobileRangeTimingSnapshot(snapshot))
  assert.deepEqual(f.bytes(), content); assert.deepEqual(f.pulls, [65536, 65536, 65536, 65536, 1]); assert.equal(f.authorities(), 5); assert.equal(f.closes(), 1)
  assert.deepEqual(snapshot.records.filter(row => row.stage === 'read').map(row => [row.ordinal, row.durationMs, row.bytes]),
    [[1, 13, 65536], [2, 13, 65536], [3, 13, 65536], [4, 13, 65536]])
  assert.deepEqual(snapshot.records.filter(row => row.stage === 'write').map(row => row.durationMs), [17, 17, 17, 17])
  assert.deepEqual(snapshot.records.filter(row => row.stage === 'before-write-authority').map(row => row.durationMs), [11, 11, 11, 11])
  assert.equal(snapshot.records.find(row => row.stage === 'initial-authority')?.durationMs, 11)
  assert.equal(snapshot.records.find(row => row.stage === 'open')?.durationMs, 7)
  assert.equal(snapshot.records.filter(row => row.stage === 'eof-read').length, 1)
  assert.equal(snapshot.records.find(row => row.stage === 'actual-close')?.quiet, 'confirmed')
  assert.equal(snapshot.firstBusinessFailure, null); assert.equal(snapshot.firstCleanupFailure, null); assert.equal(snapshot.droppedRecords, 0)
  assert.equal(f.response.writableFinished, true); assert.equal(f.response.listenerCount('drain'), 0); assert.equal(f.request.listenerCount('aborted'), 0)
});

test('单Range诊断：sink或时钟失败不重放，原业务错误不被cleanup覆盖，取消后真实close落定才确认quiet', async t => {
  for (const mode of ['sink', 'clock'] as const) {
    let clock = 0, sinkCalls = 0
    const probe = createMobileRangeTimingProbe({ enabled: true,
      now: mode === 'clock' ? () => { throw new Error('私密时钟失败') } : () => ++clock,
      sink() { sinkCalls++; throw new Error('私密sink失败') } })
    const context = probe.claim(claim); assert.ok(context)
    const f = fixture(t); await send(f, context); await getMobileMediaReleaseCompletion(f.reply)
    assert.deepEqual(f.bytes(), content); assert.equal(f.closes(), 1); assert.equal(f.pulls.length, 5); assert.equal(f.authorities(), 5)
    assert.equal(probe.snapshot().clockFault, mode === 'clock'); assert.equal(probe.snapshot().terminal, true)
    if (mode === 'clock') { assert.equal(sinkCalls, 0); assert.deepEqual(probe.snapshot().records, []) } else assert.ok(sinkCalls > 0)
  }
  for (const stage of ['reader', 'authority'] as const) {
    const probe = createMobileRangeTimingProbe({ enabled: true }), context = probe.claim(claim); assert.ok(context)
    const original = new MobileServiceError(401, 'UNAUTHORIZED'); let closes = 0, reads = 0, authorities = 0
    const reader: MobileMediaReader = { async read() { reads++; if (stage === 'reader') throw original; return content.subarray(0, 65536) },
      async close() { closes++; throw new Error('私密cleanup正文不能覆盖原业务错误') } }
    const f = fixture(t, { reader, async authority() { authorities++; if (stage === 'authority' && authorities === 2) throw original } })
    await assert.rejects(send(f, context), error => error === original)
    await assert.rejects(getMobileMediaReleaseCompletion(f.reply)!, MobileMediaResponseError)
    assert.equal(closes, 1); assert.equal(reads, 1); assert.equal(f.bytes().length, 0)
    assert.equal(probe.snapshot().firstBusinessFailure?.stage, stage === 'reader' ? 'read' : 'before-write-authority')
    assert.equal(probe.snapshot().firstBusinessFailure?.code, 'UNAUTHORIZED'); assert.equal(probe.snapshot().firstCleanupFailure?.code, 'RELEASE_FAILED')
    assert.equal(probe.snapshot().records.some(row => row.quiet === 'confirmed'), false)
  }
  // span尚未建立或已结束时的业务拒绝仍必须先保留，不能被随后close失败改成cleanup。
  for (const kind of ['reply', 'limits', 'headers', 'close-only'] as const) for (const enabled of [false, true]) {
    const probe = createMobileRangeTimingProbe({ enabled }), context = probe.claim(claim)
    let offset = 0, reads = 0, closes = 0
    const reader: MobileMediaReader = { async read(max) { reads++; if (offset === content.length) return null
      const bytes = content.subarray(offset, Math.min(offset + max, content.length)); offset += bytes.length; return bytes },
      async close() { closes++; throw new Error('合成close失败，不能覆盖首业务错误') } }
    const f = fixture(t, { reader })
    if (kind === 'reply') f.reply.expectedBodyBytes = 1
    if (kind === 'headers') t.mock.method(f.response, 'writeHead', () => { throw new Error('合成writeHead业务错误') })
    const code = kind === 'reply' ? 'INVALID_REPLY' : kind === 'limits' ? 'INVALID_LIMITS' : kind === 'headers' ? 'WRITE_FAILED' : 'RELEASE_FAILED'
    await assert.rejects(send(f, context, kind === 'limits' ? { idleMs: 5001 } : {}), error => error instanceof MobileMediaResponseError && error.code === code)
    await assert.rejects(getMobileMediaReleaseCompletion(f.reply)!, MobileMediaResponseError)
    assert.equal(closes, 1); assert.equal(reads, kind === 'close-only' ? 5 : 0)
    if (enabled) {
      const snapshot = probe.snapshot(); assert.ok(copyMobileRangeTimingSnapshot(snapshot))
      assert.equal(snapshot.firstBusinessFailure?.code ?? null, kind === 'close-only' ? null : code)
      assert.equal(snapshot.firstCleanupFailure?.code, 'RELEASE_FAILED')
      assert.equal(snapshot.records.find(row => row.stage === 'http-terminal')?.role, kind === 'close-only' ? 'cleanup' : 'business')
      if (kind !== 'close-only') assert.equal(snapshot.firstBusinessFailure?.stage, 'sender-failure')
    }
  }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 }); t.after(() => t.mock.timers.reset())
  for (const enabled of [false, true]) {
    const probe = createMobileRangeTimingProbe({ enabled }), context = probe.claim(claim)
    const closing = deferred<void>(), gate = deferred<void>(); let closes = 0, reads = 0, original: unknown
    const reader: MobileMediaReader = { async read() { reads++; return null }, async close() { closes++; closing.resolve(); await gate.promise } }
    const f = fixture(t, { reader }); f.reply.expectedBodyBytes = 1
    const flight = send(f, context, { releaseMs: 20 })
    const refused = assert.rejects(flight, error => { original = error; return error instanceof MobileMediaResponseError && error.code === 'INVALID_REPLY' })
    let actual: Promise<void> | undefined
    t.after(async () => { gate.resolve(); await flight.catch(() => undefined); await actual?.catch(() => undefined) })
    await closing.promise; t.mock.timers.tick(20); await refused
    actual = getMobileMediaReleaseCompletion(f.reply); assert.ok(actual); assert.equal(closes, 1); assert.equal(reads, 0)
    if (enabled) {
      assert.equal(probe.snapshot().firstBusinessFailure?.code, 'INVALID_REPLY')
      assert.equal(probe.snapshot().firstCleanupFailure?.code, 'RELEASE_TIMEOUT')
      assert.equal(probe.snapshot().records.find(row => row.stage === 'http-terminal')?.role, 'business')
      assert.equal(probe.snapshot().records.some(row => row.quiet === 'confirmed'), false)
    }
    gate.resolve(); await actual
    if (enabled) { assert.equal(probe.snapshot().firstBusinessFailure?.code, 'INVALID_REPLY'); assert.equal(probe.snapshot().firstCleanupFailure?.code, 'RELEASE_TIMEOUT') }
    assert.ok(original instanceof MobileMediaResponseError); assert.equal(original.code, 'INVALID_REPLY'); assert.equal(closes, 1)
  }
  const probe = createMobileRangeTimingProbe({ enabled: true }), context = probe.claim(claim); assert.ok(context)
  const entered = deferred<void>(), late = deferred<Uint8Array | null>(), closeEntered = deferred<void>(), closeGate = deferred<void>()
  let closes = 0, reads = 0, readSignal: AbortSignal | undefined, original: unknown
  const reader: MobileMediaReader = { async read(_max, signal) { reads++; readSignal = signal; entered.resolve(); return late.promise },
    async close() { closes++; closeEntered.resolve(); await late.promise; await closeGate.promise } }
  const f = fixture(t, { reader })
  const flight = sendMobileMediaResponse(f.request, f.http, f.reply, f.controller.signal, { releaseMs: 20 }, context)
  const refused = assert.rejects(flight, error => { original = error; return error instanceof MobileMediaResponseError && error.code === 'ABORTED' })
  let actual: Promise<void> | undefined
  t.after(async () => { late.resolve(null); closeGate.resolve(); await flight.catch(() => undefined); await actual?.catch(() => undefined) })
  await entered.promise; f.controller.abort(); await closeEntered.promise; t.mock.timers.tick(20); await refused
  context.finish('reject', original); actual = getMobileMediaReleaseCompletion(f.reply); assert.ok(actual)
  let quiet = false; void actual.then(() => { quiet = true }); await settle(); assert.equal(quiet, false)
  assert.equal(probe.snapshot().records.some(row => row.quiet === 'confirmed'), false)
  assert.equal(probe.snapshot().firstBusinessFailure?.stage, 'read'); assert.equal(probe.snapshot().firstCleanupFailure?.code, 'RELEASE_TIMEOUT')
  late.resolve(content.subarray(0, 65536)); closeGate.resolve(); await actual; await settle()
  assert.equal(quiet, true); assert.equal(closes, 1); assert.equal(reads, 1); assert.equal(readSignal?.aborted, true); assert.equal(f.bytes().length, 0)
  assert.equal(probe.snapshot().records.find(row => row.stage === 'actual-close')?.quiet, 'confirmed')
  assert.equal(probe.snapshot().firstBusinessFailure?.code, 'ABORTED'); assert.equal(probe.snapshot().firstCleanupFailure?.code, 'RELEASE_TIMEOUT')
});
