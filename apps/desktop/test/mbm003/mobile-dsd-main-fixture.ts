import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  MOBILE_OPERATION_TABLE, MOBILE_DSD_PCM_PROCESSING_REASON, MOBILE_RESOURCE_SCHEMAS,
  decodeMobileRequest, decodeMobileResponse, isMobileResource, mobileSchemaSnapshot,
  type MobileDecodedRequest, type MobileOperationId, type MobileReplyMap,
  type MobileResource, type MobileResourceCodecContext, type MobileResourceRequest, type MobileSession, type MobileTokenPair,
} from '@music-bridge/contracts'
import { createMobileBackend } from '../../src/main/mobile-backend.js'
import { isMobileOwnerPrivateRequest, isMobileOwnerPrivateResult } from '../../../../packages/bridge-core/src/mobile/owner-protocol.js'
import { MobileServiceError, type Mobile001BackendReply, type MobileOwnerPrivateRequest,
  type MobileOwnerPrivateResult, type MobileSealedState } from '../../../../packages/bridge-core/src/mobile/types.js'
import type { Mobile002BackendReply, Mobile002Operation } from '../../src/main/mobile-playback-backend.js'
import type { MobilePlaybackSourceRequest } from '../../../../packages/bridge-core/src/mobile/source-types.js'

/** 真Main/auth/播放actor/完整codec；Owner存储、资格与源端口受控，不证明转换器或FD。 */
export const DSD_TEST_ORIGIN = 'https://127.0.0.1'
export const DSD_TEST_DATASET = '31000000-0000-4000-8000-000000000001'
export const DSD_TEST_REQUEST: MobileResourceRequest = {
  trackId: 'local:track.dsd-owned', versionId: 'local:version.dsd-owned', contentRevision: 'revision.dsd-owned',
  quality: { profile: 'auto', allowLossyFallback: false, preferredTransport: 'file' },
  formats: [{ codec: 'flac', container: 'flac', maxSampleRateHz: 48_000, maxChannels: 2, maxBitsPerSample: 24 }],
  acceptedProcessingModes: ['dsd_to_pcm'],
}
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const copy = (state: MobileSealedState): MobileSealedState => state.kind === 'missing'
  ? { ...state } : { ...state, sealed: new Uint8Array(state.sealed) }

export function mobileDsdMainFixture(t: TestContext, options: { enableDsd?: boolean; qualified?: boolean; ready?: boolean } = {}) {
  const calls: MobileOwnerPrivateRequest[] = []
  const stored: { auth: MobileSealedState; playback: MobileSealedState } = {
    auth: { kind: 'missing', datasetId: DSD_TEST_DATASET, revision: 0 },
    playback: { kind: 'missing', datasetId: DSD_TEST_DATASET, revision: 0 },
  }
  const begun = deferred<MobilePlaybackSourceRequest>(), statusEntered = deferred<void>(), releaseEntered = deferred<void>()
  const state = { qualified: options.qualified ?? true, ready: options.ready ?? false, hostCurrent: true,
    malformedCapabilities: false, malformedSource: false, begins: 0, reads: 0, releases: 0,
    releaseGate: null as ReturnType<typeof deferred<void>> | null, active: new Set<string>() }
  const sourceAudio = { codec: 'dsd', container: 'dsf', sampleRateHz: 2_822_400, bitsPerSample: 1, channels: 2 }
  const actualAudio = { codec: 'flac', container: 'flac', sampleRateHz: 48_000, bitsPerSample: 24, channels: 2 }
  // 这些字节仅用于HTTP输送，不冒充经过原生转换/解码的FLAC文件。
  const mediaBytes = new Uint8Array([102, 76, 97, 67, ...Array.from({ length: 92 }, (_, i) => i)])
  function sourceResult(handle: string): MobileOwnerPrivateResult {
    const processing = { mode: 'dsd_to_pcm' as const, reason: MOBILE_DSD_PCM_PROCESSING_REASON, fromPreparedCache: false }
    if (!state.ready) return { kind: 'mobile-source-preparing', source: { handle, preparing: true,
      sourceAudio: { ...sourceAudio }, processing, durationMs: 1000, seekable: true } }
    return { kind: 'mobile-source-prepared', source: { handle, sourceAudio: { ...sourceAudio }, actualAudio: { ...actualAudio },
      processing, contentType: 'audio/flac', size: mediaBytes.length, durationMs: 1000, seekable: true } }
  }
  async function requestOwner(request: MobileOwnerPrivateRequest): Promise<MobileOwnerPrivateResult> {
    assert.equal(isMobileOwnerPrivateRequest(request), true, '整份Main私有请求必须属于真实闭集。')
    calls.push(structuredClone(request))
    let result: MobileOwnerPrivateResult
    if (request.kind === 'load' || request.kind === 'playback-load') result = copy(stored[request.kind === 'load' ? 'auth' : 'playback'])
    else if (request.kind === 'save' || request.kind === 'playback-save') {
      const name = request.kind === 'save' ? 'auth' : 'playback', previous = stored[name]
      if (request.request.expectedRevision !== previous.revision) result = { kind: 'conflict', datasetId: request.datasetId, currentRevision: previous.revision }
      else {
        stored[name] = { kind: 'sealed', datasetId: request.datasetId, revision: previous.revision + 1,
          commitId: request.request.commitId, sealed: new Uint8Array(request.request.sealed) }
        result = { kind: 'saved', datasetId: request.datasetId, revision: previous.revision + 1, commitId: request.request.commitId }
      }
    } else {
      assert.equal(request.kind, 'media-source', '本夹具不提供虚假目录或选图事实。')
      if (request.kind !== 'media-source') throw new Error('受控Owner操作不受支持。')
      const input = request.request
      if (input.operation === 'capabilities') {
        if (state.malformedCapabilities) return { kind: 'mobile-source-capabilities', resourceDsdToPcm: null } as unknown as MobileOwnerPrivateResult
        result = { kind: 'mobile-source-capabilities', resourceDsdToPcm: state.qualified }
      } else if (input.operation === 'prepare') {
        if (!state.qualified || input.selection.acceptedProcessingModes?.[0] !== 'dsd_to_pcm'
          || input.selection.dsdTarget?.accepts24Bit48KhzFlac !== true || input.selection.dsdTarget.maxChannels < sourceAudio.channels) {
          result = { kind: 'mobile-error', status: 409, code: 'UNSUPPORTED_FORMAT', retryable: false, outcome: null }
        } else {
          state.begins++; state.active.add(input.selection.resourceId); begun.resolve(structuredClone(input.selection))
          if (state.malformedSource) return { ...sourceResult(input.selection.resourceId), source: { handle: 'foreign-handle' } } as unknown as MobileOwnerPrivateResult
          result = sourceResult(input.selection.resourceId)
        }
      } else if (input.operation === 'status') {
        statusEntered.resolve()
        result = state.active.has(input.handle) ? sourceResult(input.handle)
          : { kind: 'mobile-error', status: 410, code: 'RESOURCE_RELEASED', retryable: false, outcome: null }
      } else if (input.operation === 'read') {
        state.reads++
        result = { kind: 'mobile-source-read', handle: input.handle, readId: input.readId, start: input.start,
          bytes: new Uint8Array(mediaBytes.subarray(input.start, input.start + input.maxBytes)) }
      } else {
        if (input.operation === 'release') {
          state.releases++; releaseEntered.resolve(); await state.releaseGate?.promise; state.active.delete(input.handle)
        }
        result = { kind: 'mobile-source-ack', operation: input.operation, handle: input.handle,
          readId: input.operation === 'close-read' ? input.readId : null, quiet: true }
      }
    }
    assert.equal(isMobileOwnerPrivateResult(result, request), true, '正常整份Owner回包必须经过真实协议检查。')
    return result
  }
  const service = createMobileBackend({ serverId: 'server.dsd-owned', datasetId: DSD_TEST_DATASET,
    authKey: new Uint8Array(32).fill(83), displayName: '合成DSD Main', environment: 'development',
    enablePlayback: true, ...(options.enableDsd === false ? {} : { enableDsd: true }), requestOwner,
    assertCurrent() { if (!state.hostCurrent) throw new MobileServiceError(503, 'BUSY') },
    resizeArtwork() { throw new Error('本夹具不提供图片端口。') } })
  t.after(async () => { state.releaseGate?.resolve(); state.hostCurrent = true; await service.close() })
  let origin = DSD_TEST_ORIGIN
  function activate(value = DSD_TEST_ORIGIN) { service.activatePlayback(value); origin = value }
  async function pair(): Promise<MobileTokenPair> {
    const permit = await service.auth.issuePairing()
    return service.auth.claim({ pairingSecret: permit.pairingSecret, installationId: 'installation.dsd-owned', deviceName: '合成客户端' }, 'pair.dsd-owned')
  }
  async function request(operation: MobileOperationId, path: string, options: { body?: unknown; key?: string; token?: string } = {}): Promise<MobileDecodedRequest<unknown>> {
    const bytes = options.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(options.body))
    const headers: [string, string][] = options.body === undefined ? [] : [['Content-Type', 'application/json'], ['Content-Length', String(bytes.length)]]
    if (options.key) headers.push(['Idempotency-Key', options.key])
    if (options.token) headers.push(['Authorization', `Bearer ${options.token}`])
    const capabilities = operation === 'createResource'
      ? await service.playbackBackend!.resourceCapabilities(options.token ?? null, path.split('/')[4]!, origin, new AbortController().signal) : undefined
    const decoded = decodeMobileRequest(operation, { method: MOBILE_OPERATION_TABLE[operation].method, path, headers, query: [], body: bytes },
      { responseOrigin: origin, requestPath: path, ...(capabilities ? { resourceCapabilities: capabilities } : {}) })
    assert.equal(decoded.ok, true, '测试只发送完整合法HTTP请求，不绕过codec。')
    if (!decoded.ok) throw new Error('合成HTTP请求不合法。')
    return decoded.value
  }
  async function control(operation: Mobile002Operation, path: string, token: string, body?: unknown, key?: string): Promise<Mobile002BackendReply> {
    const requestValue = await request(operation, path, { token, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { key }) })
    return service.playbackBackend!.dispatch({ operation, request: requestValue, accessToken: token,
      signal: new AbortController().signal, origin, headers: [['Authorization', `Bearer ${token}`]] })
  }
  function decode<O extends MobileOperationId>(operation: O, path: string, reply: Mobile001BackendReply & { resourceContext?: import('@music-bridge/contracts').MobileResourceSemanticContext }): MobileReplyMap[O] {
    const decoded = decodeMobileResponse(operation, { status: reply.status, headers: reply.headers, body: reply.body, finalUrl: `${origin}${path}` },
      { responseOrigin: origin, requestPath: path, ...(reply.resourceContext ? { resource: reply.resourceContext } : {}) })
    assert.equal(decoded.ok, true, '真实Main完整回复必须经过原wire decoder。')
    if (!decoded.ok) throw new Error('Main完整回复不合法。')
    return decoded.value
  }
  async function ui(token: string | null, signal = new AbortController().signal, requestOrigin = origin) {
    assert.ok(service.dsdBackend)
    return service.dsdBackend.dispatch({ operation: 'getUIContentCapabilities', request: await request('getUIContentCapabilities', '/mobile/v1/ui/capabilities'),
      accessToken: token, signal, origin: requestOrigin })
  }
  return { service, state, calls, begun: begun.promise, statusEntered: statusEntered.promise, releaseEntered: releaseEntered.promise,
    sourceAudio, actualAudio, mediaBytes, activate, pair, request, control, decode, ui,
    get origin() { return origin } }
}

export function buffered(reply: Mobile002BackendReply): asserts reply is Mobile002BackendReply & { kind: 'buffered' } {
  assert.equal(reply.kind, 'buffered')
}
/** 委托原Session schema，不以成功category替联合body签发类型。 */
export function isSessionReplyBody(value: unknown): value is MobileSession {
  return mobileSchemaSnapshot<MobileSession>(MOBILE_RESOURCE_SCHEMAS.Session!, value, MOBILE_RESOURCE_SCHEMAS).ok
}
export async function readyResource(f: ReturnType<typeof mobileDsdMainFixture>, sessionId: string, resourceId: string, token: string): Promise<MobileResource> {
  const path = `/mobile/v1/sessions/${sessionId}/resources/${resourceId}`, expires = Date.now() + 4000
  do {
    const reply = await f.control('getResource', path, token); buffered(reply); await reply.beforeSend?.()
    const decoded = f.decode('getResource', path, reply)
    assert.equal(decoded.category, 'success')
    if (!isMobileResource(decoded.body)) throw new Error('状态查询未返回完整合法Resource。')
    if (decoded.category === 'success' && decoded.body.state === 'ready') return decoded.body
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  } while (Date.now() < expires)
  throw new Error('受控状态查询未到达ready。')
}
export function dsdContext(origin: string, serverId: string, sessionId: string, bits = true): MobileResourceCodecContext {
  return { scope: { serverId, deviceId: 'device.dsd-owned', sessionId }, responseOrigin: origin, now: new Date().toISOString(),
    resourceFormatBitDepth: bits, resourceDsdToPcm: true, capabilityVersion: '1.0.0', capabilitySnapshotIdentity: 'cap.dsd-owned' }
}
