import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { MOBILE_DSD_PCM_PROCESSING_REASON, isMobileErrorEnvelope, isMobileResource, isMobileUIContentCapabilities,
  mobileCommonResponseSnapshot, type MobileResource, type MobileReplyMap, type MobileSession } from '@music-bridge/contracts'
import { MobileAuthPersistenceError, MobileServiceError } from '../../../../packages/bridge-core/src/mobile/types.js'
import { mobileDsdOptionsForOwner } from '../../src/main/mobile-dsd-bootstrap.js'
import { DSD_TEST_REQUEST, buffered, deferred, isSessionReplyBody, mobileDsdMainFixture, readyResource } from './mobile-dsd-main-fixture.js'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function createSession(f: ReturnType<typeof mobileDsdMainFixture>, token: string): Promise<MobileSession> {
  const path = '/mobile/v1/sessions', reply = await f.control('createSession', path, token, { clientInstanceId: 'client.dsd-owned' }, 'session.original')
  buffered(reply); await reply.beforeSend?.(); const decoded = f.decode('createSession', path, reply)
  assert.equal(decoded.category, 'success'); if (decoded.category !== 'success') throw new Error('会话未建立。')
  if (!isSessionReplyBody(decoded.body)) throw new Error('会话完整body未符合原Session schema。')
  return decoded.body
}
function successResource(f: ReturnType<typeof mobileDsdMainFixture>, operation: 'createResource' | 'getResource' | 'renewResource', path: string, reply: Parameters<typeof f.decode>[2]): MobileResource {
  const decoded = f.decode(operation, path, reply)
  assert.equal(decoded.category, 'success'); if (decoded.category !== 'success') throw new Error('资源回包未成功。')
  if (!isMobileResource(decoded.body)) throw new Error('资源完整body未符合原Resource schema。')
  return decoded.body
}
function errorCode(decoded: MobileReplyMap['createResource']): string {
  assert.equal(decoded.category, 'error')
  if (decoded.category !== 'error' || !isMobileErrorEnvelope(decoded.body)) throw new Error('错误完整body未符合原Error schema。')
  return decoded.body.error.code
}
const sourceCalls = (f: ReturnType<typeof mobileDsdMainFixture>, operation: string) => f.calls.filter(input => input.kind === 'media-source' && input.request.operation === operation)

test('003编译pin未注入时不构造可加载Owner配置，不借目录存在授予资格', () => {
  assert.equal(mobileDsdOptionsForOwner({}, { platform: 'darwin', arch: 'arm64', entryDirectory: '/owned/desktop/dist/main', resourcesDirectory: '/owned/resources' }, '/owned/data'), undefined)
})

test('003未显式安装时旧002能力快照和挂载边界保持，不向Owner索取DSD资格', { timeout: 10_000 }, async t => {
  const f = mobileDsdMainFixture(t, { enableDsd: false }); f.activate(); const token = await f.pair()
  assert.equal(f.service.dsdBackend, undefined)
  const caps = await f.service.playbackBackend!.resourceCapabilities(token.accessToken, 'session.owned', f.origin, new AbortController().signal)
  assert.equal(Object.hasOwn(caps, 'resourceDsdToPcm'), false)
  assert.equal(caps.capabilitySnapshotIdentity, 'mbm002:server.dsd-owned')
  assert.equal(sourceCalls(f, 'capabilities').length, 0)
})

test('003认证能力采用Owner私有闭集资格且基础八字段不被新DSD字段扩权', { timeout: 10_000 }, async t => {
  const f = mobileDsdMainFixture(t, { qualified: false }); f.activate()
  await assert.rejects(f.ui(null), (error: unknown) => error instanceof MobileServiceError && error.status === 401)
  assert.equal(sourceCalls(f, 'capabilities').length, 0)
  const token = await f.pair(), reply = await f.ui(token.accessToken); await reply.beforeSend?.()
  const caps = f.decode('getUIContentCapabilities', '/mobile/v1/ui/capabilities', reply)
  assert.equal(caps.category, 'success'); if (caps.category !== 'success') throw new Error('能力回包未成功。')
  assert.deepEqual(structuredClone(caps.body), { version: '1.0.0', addedAlbums: 'unsupported', neteaseDailyRecommendations: 'unsupported',
    lyrics: 'unsupported', resourceFormatBitDepth: true, resourceDsdToPcm: false })
  f.state.qualified = true
  const qualified = await f.ui(token.accessToken); await qualified.beforeSend?.()
  const newCaps = f.decode('getUIContentCapabilities', '/mobile/v1/ui/capabilities', qualified)
  if (!isMobileUIContentCapabilities(newCaps.body)) throw new Error('能力完整body未符合原UIContentCapabilities schema。')
  assert.equal(newCaps.category === 'success' && newCaps.body.resourceDsdToPcm, true)
  const request = await f.request('getCapabilities', '/mobile/v1/capabilities', { token: token.accessToken })
  const base = await f.service.backend.dispatch({ operation: 'getCapabilities', request, accessToken: token.accessToken, signal: new AbortController().signal })
  const decodedBase = f.decode('getCapabilities', '/mobile/v1/capabilities', base)
  assert.equal(decodedBase.category, 'success')
  if (decodedBase.category !== 'success') throw new Error('基础能力回包未成功。')
  const baseBody = mobileCommonResponseSnapshot('capabilities', decodedBase.body)
  assert.equal(baseBody.ok, true); if (!baseBody.ok) throw new Error('基础能力完整body未符合原Capabilities schema。')
  assert.deepEqual(Object.keys(decodedBase.body).sort(), ['contractVersion', 'hls', 'localPlayback', 'maxConcurrentSessions', 'neteasePlayback', 'preparedVariants', 'qualityProfiles', 'transcoding'].sort())
  assert.equal(baseBody.value.transcoding, false); assert.equal(baseBody.value.preparedVariants, false)
})

test('003能力发送前再核资格和设备epoch，不发送迟到的合格快照或未经闭集的true', { timeout: 10_000 }, async t => {
  const f = mobileDsdMainFixture(t); f.activate(); const token = await f.pair()
  const reply = await f.ui(token.accessToken); f.state.qualified = false
  await assert.rejects(reply.beforeSend!(), (error: unknown) => error instanceof MobileServiceError && error.status === 503)
  f.state.qualified = true
  const beforeRevoke = await f.ui(token.accessToken), principal = await f.service.auth.authenticate(token.accessToken)
  await f.service.auth.revokeDevice(principal.deviceId)
  await assert.rejects(beforeRevoke.beforeSend!(), (error: unknown) => error instanceof MobileServiceError && error.status === 401)
  const fresh = mobileDsdMainFixture(t); fresh.activate(); const freshToken = await fresh.pair()
  fresh.state.malformedCapabilities = true
  await assert.rejects(fresh.ui(freshToken.accessToken), (error: unknown) => error instanceof MobileAuthPersistenceError && error.outcome === 'unknown')
  fresh.state.malformedCapabilities = false
  const beforeForeign = sourceCalls(fresh, 'capabilities').length
  await assert.rejects(fresh.ui(freshToken.accessToken, new AbortController().signal, 'https://127.0.0.2'),
    (error: unknown) => error instanceof MobileServiceError && error.status === 503)
  assert.equal(sourceCalls(fresh, 'capabilities').length, beforeForeign)
  const sourceMismatch = mobileDsdMainFixture(t); sourceMismatch.activate(); const sourceToken = await sourceMismatch.pair()
  const session = await createSession(sourceMismatch, sourceToken.accessToken); sourceMismatch.state.malformedSource = true
  const path = `/mobile/v1/sessions/${session.id}/resources`
  const invalid = await sourceMismatch.control('createResource', path, sourceToken.accessToken, DSD_TEST_REQUEST, 'malformed.source')
  buffered(invalid); assert.equal(invalid.status, 503); assert.equal(sourceMismatch.state.active.size, 0)
})

test('003短begin回202且没有media，GET到ready后原POST回执不升级并保留原准备窗口', { timeout: 10_000 }, async t => {
  const f = mobileDsdMainFixture(t); f.activate(); const token = await f.pair(), session = await createSession(f, token.accessToken)
  const path = `/mobile/v1/sessions/${session.id}/resources`, first = await f.control('createResource', path, token.accessToken, DSD_TEST_REQUEST, 'resource.original')
  buffered(first); await first.beforeSend?.(); assert.equal(first.status, 202)
  const pending = successResource(f, 'createResource', path, first)
  assert.equal(pending.state, 'preparing'); assert.equal(Object.hasOwn(pending, 'media'), false)
  assert.equal(pending.processing.mode, 'dsd_to_pcm'); assert.deepEqual(structuredClone(pending.sourceAudio), f.sourceAudio)
  const selection = await f.begun
  assert.deepEqual(selection.acceptedProcessingModes, ['dsd_to_pcm']); assert.ok(selection.preparationWindow)
  assert.deepEqual(selection.dsdTarget, { maxChannels: 2, accepts24Bit48KhzFlac: true })
  assert.ok(selection.preparationWindow.remainingPreparationMs > 0 && selection.preparationWindow.remainingPreparationMs <= 240_000)
  assert.equal(selection.preparationWindow.sessionExpiresAtMs, Date.parse(session.expiresAt))
  assert.ok(selection.preparationWindow.resourceExpiresAtMs <= selection.preparationWindow.sessionExpiresAtMs)
  f.state.ready = true
  const ready = await readyResource(f, session.id, pending.id, token.accessToken)
  assert.equal(ready.state, 'ready'); if (ready.state !== 'ready') throw new Error('准备未完成。')
  assert.deepEqual(structuredClone(ready.media.actualAudio), f.actualAudio)
  assert.equal(ready.processing.reason, MOBILE_DSD_PCM_PROCESSING_REASON); assert.equal(ready.media.seekable, true)
  const original = await f.control('createResource', path, token.accessToken, DSD_TEST_REQUEST, 'resource.original')
  buffered(original); await original.beforeSend?.(); assert.equal(original.status, 202); assert.equal(hash(original.body), hash(first.body))
  assert.equal(f.state.begins, 1); assert.equal(sourceCalls(f, 'prepare').length, 1)
})

test('003旧客户端DSD在转换前409且不发新mode回执，原正文不允许换许可', { timeout: 10_000 }, async t => {
  const f = mobileDsdMainFixture(t); f.activate(); const token = await f.pair(), session = await createSession(f, token.accessToken)
  const { acceptedProcessingModes: _optIn, ...oldRequest } = DSD_TEST_REQUEST
  const path = `/mobile/v1/sessions/${session.id}/resources`, rejected = await f.control('createResource', path, token.accessToken, oldRequest, 'old.original')
  buffered(rejected); assert.equal(rejected.status, 409)
  const decoded = f.decode('createResource', path, rejected)
  assert.equal(decoded.category, 'error'); if (decoded.category !== 'error') throw new Error('旧客户端应有限拒绝。')
  assert.equal(errorCode(decoded), 'UNSUPPORTED_FORMAT'); assert.equal(f.state.begins, 0)
  await assert.rejects(
    f.control('createResource', path, token.accessToken, DSD_TEST_REQUEST, 'old.original'),
    (error: unknown) => {
      assert.ok(error instanceof MobileServiceError)
      assert.equal(error.status, 409)
      assert.equal(error.code, 'IDEMPOTENCY_CONFLICT')
      return true
    },
  )
  assert.equal(f.state.begins, 0)
  for (const [index, format] of [
    { codec: 'flac', container: 'flac', maxSampleRateHz: 48_000, maxChannels: 1, maxBitsPerSample: 24 },
    { codec: 'flac', container: 'flac', maxSampleRateHz: 44_100, maxChannels: 2, maxBitsPerSample: 24 },
    { codec: 'flac', container: 'flac', maxSampleRateHz: 48_000, maxChannels: 2, maxBitsPerSample: 16 },
  ].entries()) {
    const invalidTarget = await f.control('createResource', path, token.accessToken,
      { ...DSD_TEST_REQUEST, formats: [format] }, `invalid.target.${index}`)
    buffered(invalidTarget); assert.equal(invalidTarget.status, 409)
    const body = f.decode('createResource', path, invalidTarget)
    assert.equal(errorCode(body), 'UNSUPPORTED_FORMAT')
    assert.equal(f.state.begins, 0, 'Owner声道及固定24/48目标准入必须先于begin。')
  }
  f.state.qualified = false
  await assert.rejects(
    f.control('createResource', path, token.accessToken, DSD_TEST_REQUEST, 'old.capability'),
    (error: unknown) => {
      assert.ok(error instanceof MobileServiceError)
      assert.equal(error.status, 409)
      assert.equal(error.code, 'UNSUPPORTED_FORMAT')
      return true
    },
  )
  assert.equal(f.state.begins, 0)
})

test('003ready跨首次240秒仍按原资源TTL续租，不重新begin或抹掉mode许可', { timeout: 10_000 }, async t => {
  const start = Date.now(); t.mock.timers.enable({ apis: ['Date'], now: start }); t.after(() => t.mock.timers.reset())
  const f = mobileDsdMainFixture(t, { ready: true }); f.activate(); const token = await f.pair(), session = await createSession(f, token.accessToken)
  const path = `/mobile/v1/sessions/${session.id}/resources`, first = await f.control('createResource', path, token.accessToken, DSD_TEST_REQUEST, 'ready.original')
  buffered(first); assert.equal(first.status, 201)
  const initial = successResource(f, 'createResource', path, first)
  assert.equal(initial.state, 'ready'); if (initial.state !== 'ready') throw new Error('资源未ready。')
  t.mock.timers.setTime(start + 240_001)
  const renewPath = `${path}/${initial.id}/renew`, renewed = await f.control('renewResource', renewPath, token.accessToken, {}, 'renew.original')
  buffered(renewed); await renewed.beforeSend?.()
  const current = successResource(f, 'renewResource', renewPath, renewed)
  assert.equal(current.state, 'ready'); if (current.state !== 'ready') throw new Error('续租未ready。')
  assert.deepEqual(structuredClone(current.sourceAudio), structuredClone(initial.sourceAudio))
  assert.deepEqual(structuredClone(current.media.actualAudio), structuredClone(initial.media.actualAudio))
  assert.equal(current.processing.mode, initial.processing.mode); assert.equal(current.processing.reason, initial.processing.reason)
  assert.equal(current.media.durationMs, initial.media.durationMs); assert.equal(current.media.seekable, initial.media.seekable)
  assert.equal(f.state.begins, 1); assert.equal(sourceCalls(f, 'prepare').length, 1)
  const original = await f.control('createResource', path, token.accessToken, DSD_TEST_REQUEST, 'ready.original')
  buffered(original); assert.equal(hash(original.body), hash(first.body)); assert.equal(original.status, 201)
})

test('003取消preparing要等原Owner quiet，关闭也不遗失在途收尾或重发begin', { timeout: 10_000 }, async t => {
  const f = mobileDsdMainFixture(t); f.activate(); const token = await f.pair(), session = await createSession(f, token.accessToken)
  const path = `/mobile/v1/sessions/${session.id}/resources`, initial = await f.control('createResource', path, token.accessToken, DSD_TEST_REQUEST, 'cancel.original')
  buffered(initial); const pending = successResource(f, 'createResource', path, initial)
  f.state.releaseGate = deferred<void>(); let completed = false
  const release = f.control('releaseResource', `${path}/${pending.id}`, token.accessToken).then(value => { completed = true; return value })
  await f.releaseEntered; assert.equal(completed, false); assert.equal(f.state.active.has(pending.id), true)
  f.state.releaseGate.resolve(); const released = await release; buffered(released); assert.equal(released.status, 204)
  assert.equal(released.body.length, 0); assert.equal(f.state.active.size, 0)
  await f.service.close(); assert.equal(f.state.begins, 1)
  await assert.rejects(f.ui(token.accessToken), (error: unknown) => error instanceof MobileServiceError && error.status === 503)
})
