import { createLocalWorkbenchManagementBoundary, createLocalWorkbenchMainAssembly, type LocalWorkbenchRootMainAuthor, type LocalWorkbenchRootMainRequest, type LocalWorkbenchMainPreparationContext } from '../src/main/local-library-workbench/service.js'
import { createLocalLyricsMainService, createLocalLyricsMainProviderBridge, type LocalLyricsProviderMainContext } from '../src/main/local-library-workbench/lyrics-service.js'
import { lyricsPhysicalDigest, type LocalLyricsPhysicalBinding } from '../../../packages/bridge-core/src/library/lyrics-source-format.js'
import { captureSourceWritesLyricsGrantRequest, captureSourceWritesLyricsVerifyReply, type SourceWritesLyricsGrantRequest, type SourceWritesLyricsVerifyReply } from '../../../packages/bridge-core/src/collection/source-writes-authority.js'
import { CoreSupervisor, CoreIpcError, type CoreMessagePort, type CoreChildProcess } from '../src/main/core-supervisor.js'
import { captureDatasetLyricsProviderRequest, captureDatasetLyricsProviderReply, assertDatasetLyricsProviderReplyForRequest, datasetWorkbenchMeta, datasetWorkbenchFrames, type DatasetLyricsProviderRequest, type DatasetLyricsProviderReply } from '../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { parseLocalLyricsSearch } from '../../../packages/bridge-core/src/collection/local-library-lyrics/providers.js'
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { closeRustMediaWorkerPool } from '../../../packages/bridge-core/src/library/rust-media-worker.js'
import { localAlbumPhase, localAlbumMatch, localAlbumLink, localAlbumRejectCode } from '../../../packages/bridge-core/src/shared/local-album-read-trace-node.js'
import { logLibraryOperation } from '../../../packages/bridge-core/src/shared/library-operation-log.js'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as dto from '@music-bridge/contracts'
import type { PhotoDecoderImage } from '../src/main/collection-photos.js'
import type { CommonsTransportResponse, PinnedArtworkTransport } from '../src/main/commons-artwork-provider.js'
import { normalizeLocalArtwork, normalizeLocalArtworkInWorker } from '../src/main/local-artwork-image.js'
import { registerLocalArtworkNavigationPhysical } from '../src/main/local-library-workbench/providers/artwork-web-navigation.js'
import { createLocalArtworkProviders, createLocalArtworkWebNavigation, createLocalNameTransport } from '../src/main/local-library-workbench/providers/index.js'
import { createLocalWorkbenchService, type LocalWorkbenchOwnerPorts, type LocalWorkbenchServiceOptions } from '../src/main/local-library-workbench/service.js'
import type { LocalWorkbenchMainContext, LocalWorkbenchMainRequest } from '../src/main/local-library-workbench/workbench-ipc.js'
import type { LocalWorkbenchResolvedReadCapture } from '../../../packages/bridge-core/src/collection/local-library-workbench/read-service.js'
import { createLocalWorkbenchPlanRegistry } from '../../../packages/bridge-core/src/collection/local-library-workbench/plan-registry.js'
import { createLocalNamePlanDraft, localNameModelPrompts, parseLocalNameProposal } from '../../../packages/bridge-core/src/collection/local-library-workbench/name-proposal.js'
import { buildLocalCuePlan } from '../../../packages/bridge-core/src/collection/local-library-workbench/cue-plan.js'
import { parseCueText } from '../../../packages/bridge-core/src/library/cue-text-reader.js'
import {
  LocalWorkbenchPlanError, type LocalWorkbenchAlbumCapture, type LocalWorkbenchCatalogMemberCapture, type LocalNameProposal, type LocalWorkbenchRegistrySnapshot, type LocalWorkbenchRegistryPersistence,
  type LocalCueAudioProbe, type LocalCueFormatQualification,
} from '../../../packages/bridge-core/src/collection/local-library-workbench/types.js'

// join本文件实际src规范化器使用的共享Rust池，不能以退出测试进程代替真实关闭。
after(async () => { await closeRustMediaWorkerPool() })

const datasetId = '11111111-1111-4111-8111-111111111111', otherDataset = '22222222-2222-4222-8222-222222222222'
const trackId = '33333333-3333-4333-8333-333333333333', assetId = '44444444-4444-4444-8444-444444444444'
const rootId = '55555555-5555-4555-8555-555555555555', sourceRootId = '66666666-6666-4666-8666-666666666666'
const reference: dto.LocalWorkbenchCapture = { albumId: 'album-a', readToken: 'read-a' }
const selected: dto.LocalWorkbenchAlbumRef = { albumId: reference.albumId, rootId, title: '合成原专辑', artist: '合成原作者', trackIds: [trackId] }
const fileRequest = { datasetId, capture: reference }
const inputRequest = () => ({ ...fileRequest, bytes: new Uint8Array(jpeg()), mime: 'image/jpeg', label: '合成手动封面' })
function segment(marker: number, body: Buffer): Buffer { const header = Buffer.from([255, marker, 0, 0]); header.writeUInt16BE(body.length + 2, 2); return Buffer.concat([header, body]) }
/** 压缩结构、native decoder、网络与文件许可全部合成；不证明真实 native 或数据库/音乐运行。 */
function jpeg(width = 1, height = 1): Buffer {
  const quantizer = Buffer.alloc(65, 1); quantizer[0] = 0
  const table = (value: number) => { const bytes = Buffer.alloc(18); bytes[0] = value; bytes[1] = 1; return bytes }
  const frame = Buffer.from([8, 0, 1, 0, 1, 1, 1, 17, 0]); frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3)
  return Buffer.concat([Buffer.from([255, 216]), segment(219, quantizer), segment(196, Buffer.concat([table(0), table(16)])),
    segment(192, frame), segment(218, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([63, 255, 217])])
}
function decoder(width = 1, height = 1): PhotoDecoderImage { return { isEmpty: () => false, getSize: () => ({ width, height }), resize: size => decoder(size.width, size.height), toJPEG: () => jpeg(width, height) } }
const context = (signal = new AbortController().signal, dataset = datasetId): LocalWorkbenchMainContext => ({ datasetId: dataset, signal })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function response(bytes: Uint8Array, mime: string): CommonsTransportResponse {
  return { statusCode: 200, headers: { 'content-type': mime, 'content-length': String(bytes.length) }, body: (async function* () { yield bytes })(), destroy() {}, closed: Promise.resolve() }
}
function original(plan: dto.LocalWorkbenchPlan, commandId = 'command-a'): dto.LocalWorkbenchApplyRequest {
  return { commandId, datasetId: plan.datasetId, planId: plan.planId, expectedRevision: plan.revision,
    planHash: plan.planHash, contextFingerprint: plan.contextFingerprint, kind: plan.kind }
}
function receipt(request: dto.LocalWorkbenchApplyRequest, plan: dto.LocalWorkbenchPlan, state: dto.LocalWorkbenchReceipt['state'] = 'succeeded'): dto.LocalWorkbenchReceipt {
  return { commandId: request.commandId, datasetId: request.datasetId, planId: request.planId, planHash: request.planHash,
    state, message: null, items: plan.items.map(item => ({ itemId: item.itemId, albumId: item.albumId, label: item.label,
      state: state === 'succeeded' ? 'applied' : state === 'cancelled' ? 'cancelled' : 'unknown', message: null })) }
}
interface FixtureOptions { maxCandidateBytes?: number; maxCandidates?: number; transport?: PinnedArtworkTransport; modelContent?: string; decode?: LocalWorkbenchServiceOptions['decode']; navigation?:LocalWorkbenchServiceOptions['navigation'] }
interface NameWirePayload { model: string; messages: readonly { role: string; content: string }[]; stream: boolean; keep_alive?: string }
async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  let clock = 1_000_000, capturedRevision = 'album-1', availability: LocalWorkbenchResolvedReadCapture['availability'] = 'online'
  const events: string[] = [], network: URL[] = [], nameRequests: Array<{ url: string; body: NameWirePayload; headers: Headers }> = [], navigated: URL[] = [], external: URL[] = []
  // 原合成transport/nav只声明本fixture的生命周期，不充当真实Main或公网证明。
  let fixtureResourcesAlive=true;t.after(()=>{fixtureResourcesAlive=false})
  const captured = (): LocalWorkbenchAlbumCapture => ({ ...reference, revision: capturedRevision, rootId, directoryId: 'directory-a', editionId: null,
    artistName: selected.artist, albumName: selected.title, directoryName: '合成目录', manualLocks: { artistName: false, albumName: false },
    nameSources: { artistName: 'raw', albumName: 'raw' }, members: [{ trackId, assetId, fileName: '合成.flac', title: '合成曲目', artist: null, album: null,
      rootRevision: 'root-1', fileRevision: 'file-1', locationRevision: 'location-1', metadataRevision: 'metadata-1' }] })
  const resolved = (): LocalWorkbenchResolvedReadCapture => ({ datasetId, datasetRevision: 'dataset-1', capture: captured(), availability,
    group: { summary: { id: reference.albumId, kind: 'source-directory', rootId, editionId: null, title: selected.title, artists: [selected.artist], year: null,
      versionLabel: null, trackCount: 1, representativeTrackId: trackId, revision: capturedRevision, artworkAvailable: false, statuses: ['missing-artwork'] },
      directory: '合成目录', issues: [], members: [{ disc: 1, trackNumber: 1, sequence: 1, editionLink: null, statuses: [], fact: { relative: '合成目录/合成.flac',
        rawMetadata: { title: '合成曲目' }, hasArtwork: false, artworkRevision: null,
        summary: { track: { id: trackId, assetId, selectionRevision: '1', segment: null }, asset: { id: assetId, libraryRootId: rootId, sourceRootId,
          rootRevision: 'root-1', fileRevision: 'file-1', locationRevision: 'location-1', sampleFrames: null, timebaseHz: null },
          metadata: { title: '合成曲目' }, versionTokens: [] } } }] },
    directoryFacts: { revision: 'scan-1', files: [], cues: [] }, provenance: [{ trackId, override: null }] })
  let stored: LocalWorkbenchRegistrySnapshot | null = null, planNumber = 0
  const registry = await createLocalWorkbenchPlanRegistry({ datasetId, now: () => clock, makePlanId: () => 'plan-' + ++planNumber,
    persistence: { load: async () => stored, save: async (next, expected) => { assert.equal(expected, stored?.revision ?? 0); events.push('持久:' + next.revision); stored = structuredClone(next) } },
    writer: { revalidate: async () => ({ valid: true }), apply: async (request, plan) => { events.push('应用:' + request.commandId); assert.ok(stored?.entries.find(item => item.plan.planId === plan.planId)?.original); return receipt(request, plan, request.commandId === 'name-command' ? 'unknown' : 'succeeded') },
      readOriginalReceipt: async () => null, cancel: async request => { const plan = stored?.entries.find(item => item.plan.planId === request.original.planId)?.plan; assert.ok(plan); events.push('取消:' + request.cancelCommandId); return receipt(request.original, plan, 'cancelled') } } })
  const capabilities: dto.LocalWorkbenchCapabilitiesReply = { capabilities: Object.fromEntries(dto.LOCAL_WORKBENCH_CAPABILITIES.map(key => [key, { available: true }])),
    artworkSources: [{ id: 'aggregate', label: '豆瓣与 iTunes', kind: 'aggregate', availability: { available: true } }, { id: 'google-web', label: 'Google 网页', kind: 'web', availability: { available: true } }],
    artworkImportFormats: ['image/jpeg', 'image/png', 'image/tiff', 'image/webp'].map(mime => ({ mime, label: mime, availability: { available: true } })),
    aiBackends: (['ollama', 'vllm', 'cloud'] as const).map(id => ({ id, label: '合成 ' + id, availability: { available: true } })),
    cueFormats: [{ id: 'flac', label: '合成 FLAC 资格', availability: { available: true } }], existingActions: { finder: { available: true } } }
  const preparations = new Map<string, dto.LocalAiBackend>(), proposals = new Map<string, LocalNameProposal>()
  let preparedNumber = 0
  const owner: LocalWorkbenchOwnerPorts = {
    read: {
      readAlbums: async request => { events.push('读取'); return { datasetId, snapshotId: 'snapshot-a', albums: request.albums.map(album => ({ album: structuredClone(album), capture: { ...reference }, availability,
        issues: [], currentArtwork: null, cueSheets: [{ cueId: 'cue-a', label: '合成 CUE', eligible: true }] })) } },
      resolveCapture: async request => { events.push('回核'); if (request.datasetId !== datasetId || request.capture.albumId !== reference.albumId || request.capture.readToken !== reference.readToken) throw new LocalWorkbenchPlanError('CHANGED', '原捕获不一致。'); return resolved() },
      prepareNameSuggestion: async request => { const preparationId = 'preparation-' + ++preparedNumber; preparations.set(preparationId, request.backend); events.push('准备名称'); return { preparationId, backend: request.backend, ...localNameModelPrompts(captured()) } },
      completeNameSuggestion: async (id, content) => { assert.equal(preparations.get(id), content.backend); preparations.delete(id); events.push('校验名称'); const result = parseLocalNameProposal(content.content, captured(), content.backend); if (result.status === 'ready') proposals.set(result.proposal.candidateId, result.proposal); return result },
      cancelNamePreparation: id => { events.push('收口名称'); return preparations.delete(id) },
      prepareNamePreview: async request => { events.push('预览名称'); return { draft: createLocalNamePlanDraft(request.selections.map(item => ({ capture: captured(), proposal: proposals.get(item.candidateId)! }))), capture: { datasetId, datasetRevision: 'dataset-1', albums: [captured()] } } },
      prepareArtworkPreview: async ({ resolved: value, artwork }) => { events.push('预览封面'); return { draft: { kind: 'artwork', scope: 'MB_ONLY', relationship: value.capture.editionId === null ? 'create-on-apply' : 'existing',
        albumIds: [value.capture.albumId], state: 'ready', blockers: [], items: [{ itemId: 'artwork-item-' + value.capture.albumId, albumId: value.capture.albumId, label: artwork.sourceLabel, changes: [] }] },
        capture: { datasetId, datasetRevision: value.datasetRevision, albums: [structuredClone(value.capture)], artwork: [structuredClone(artwork)] } } },
    }, registry,
    readCapabilities: async () => structuredClone(capabilities),
    readLocalArtwork: async () => { events.push('本地封面'); return { status: 'ready', items: [{ origin: 'local-independent', sourceIdentity: 'real-owner-image-reference', sourceLabel: '合成 cover.jpg', base64: jpeg().toString('base64') }] } },
    prepareCuePreview: async (request, target) => {
      await target.withDirectory(async authorized => { assert.equal(authorized, '/合成受控目录'); events.push('受保护目标') }, context())
      const assetReference = { assetId, libraryRootId: rootId, sourceRootId, rootRevision: 'root-1', fileRevision: 'file-1', locationRevision: 'location-1' }
      const parsed = parseCueText('FILE "合成.flac" WAVE\nTRACK 01 AUDIO\nTITLE "合成曲目"\nINDEX 01 00:00:00\n', new Map([['合成.flac', [assetReference]]]))
      const audio: LocalCueAudioProbe[] = [{ assetReference, sourceLabel: '合成.flac', evidence: 'audio-pcm-read', readRevision: 'pcm-1', sampleRate: 44100, totalPcmFrames: 44100 }]
      const format: LocalCueFormatQualification = { formatId: 'flac', revision: 'format-1', codec: 'flac', extension: 'flac', lossless: true, evidence: 'encoder-tag-audio-roundtrip', available: true }
      const selections = [{ album: captured(), cueId: 'cue-a', cueRevision: 'cue-1', parsed, audio }]
      const value = buildLocalCuePlan({ selections, target: request.target, format, pregapPolicy: 'append-to-previous' })
      events.push('预览分轨'); return { draft: value.draft, capture: { datasetId, datasetRevision: 'dataset-1', albums: [captured()],
        cueSheets: [{ albumId: reference.albumId, cueId: 'cue-a', revision: 'cue-1' }], cueOutputs: value.outputs, audio,
        target: { ...request.target, revision: target.revision }, format } }
    },
    openExisting: async request => { events.push('原入口:' + request.action); return { opened: true } },
  }
  const nameTransport = createLocalNameTransport({ getConfiguration: backend => ({ baseUrl: backend === 'cloud' ? 'https://private-synthetic.example' : 'http://127.0.0.1:11434', model: '私有合成模型' }),
    resolveSecret: backend => backend === 'cloud' ? 'synthetic-main-secret' : null,
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as NameWirePayload; nameRequests.push({ url: String(url), body, headers: new Headers(init?.headers) })
      const content = options.modelContent ?? '{"artistName":"合成新作者","albumName":"合成新专辑","reason":"根据合成标签事实整理。"}'
      return body.messages.length === 0 ? new Response('{"done":true}', { headers: { 'content-type': 'application/json' } })
        : String(url).includes('/api/chat') ? new Response(JSON.stringify({ message: { content }, done: true }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
          : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
  const transport: PinnedArtworkTransport = options.transport ?? (async url => {
    network.push(url)
    if (url.hostname === 'search.douban.com') return response(Buffer.from('<script>window.__DATA__ = ' + JSON.stringify({ items: [{ id: 1, title: '合成豆瓣专辑', abstract: '合成豆瓣作者', cover_url: 'https://img9.doubanio.com/view/subject/m/public/s3737076.jpg', url: 'https://music.douban.com/subject/1/' }] }) + ';</script>'), 'text/html')
    if (url.hostname === 'itunes.apple.com') return response(Buffer.from(JSON.stringify({ results: [{ collectionType: 'Album', collectionId: 2, artistName: '合成 iTunes 作者', collectionName: '合成 iTunes 专辑', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music1/v4/album/100x100bb.jpg', collectionViewUrl: 'https://music.apple.com/cn/album/synthetic/2' }] })), 'application/json')
    return response(jpeg(), 'image/jpeg')
  })
  const serviceOptions: LocalWorkbenchServiceOptions = {
    owner, names: nameTransport, artwork: createLocalArtworkProviders({ transport, readTransportAvailability:signal=>fixtureResourcesAlive&&!signal.aborted,
      normalize: async (bytes, signal) => (await normalizeLocalArtworkInWorker(bytes, signal)).image, now: () => clock }),
    navigation: options.navigation??createLocalArtworkWebNavigation({ readPortAvailability:(_mode,signal)=>fixtureResourcesAlive&&!signal.aborted, navigate: (url,context) => { navigated.push(url); registerLocalArtworkNavigationPhysical(context.signal,{closed:Promise.resolve(),abort(){}}) }, openExternal: url => { external.push(url) } }),
    nativeChooser: {
      chooseArtwork: async () => ({ label: '合成原生图片', read: async () => { events.push('许可读图'); return new Uint8Array(jpeg()) }, close: async () => { events.push('关闭文件许可') } }),
      chooseCueTarget: async () => ({ target: { choiceId: 'target-a', label: '合成独立目标', independent: true }, revision: 'target-1', assertCurrent: async () => { events.push('回核目标') },
        withDirectory: async operation => operation('/合成受控目录'), close: async () => { events.push('关闭目标许可') } }),
      closeReadResources: async () => { events.push('关闭选择器读取') },
    },
    artworkSources: { aggregate: { kind: 'provider', source: 'douban-itunes', country: 'CN' }, 'google-web': { kind: 'web', source: 'google-images' } },
    decode: options.decode ?? (() => decoder()), now: () => clock, candidateTtlMs: 1000, ...(options.maxCandidateBytes ? { maxCandidateBytes: options.maxCandidateBytes } : {}),
    ...(options.maxCandidates ? { maxCandidates: options.maxCandidates } : {}),
  }
  const service = createLocalWorkbenchService(serviceOptions)
  t.after(() => service.close())
  async function ask<K extends dto.LocalWorkbenchCommand>(command: K, payload: dto.LocalWorkbenchCommandPayloads[K], ctx = context()): Promise<dto.LocalWorkbenchCommandResults[K]> {
    const value = await service.request({ command, payload } as LocalWorkbenchMainRequest, ctx)
    assert.ok(dto.isLocalWorkbenchCommandResult(command, value, payload), '实际返回必须通过原闭集合同')
    return value as dto.LocalWorkbenchCommandResults[K]
  }
  return { service, ask, events, network, nameRequests, navigated, external, capabilities, owner, serviceOptions, registry, preparations,
    snapshot: () => stored, setRevision: (revision: string) => { capturedRevision = revision }, setAvailability: (value: typeof availability) => { availability = value }, advance: (ms: number) => { clock += ms } }
}

test('15项闭集命令执行实际名称/图搜/导入链与原registry；预览不调用writer', async t => {
  const f = await fixture(t), observed = new Set<dto.LocalWorkbenchCommand>()
  const ask = async <K extends dto.LocalWorkbenchCommand>(command: K, payload: dto.LocalWorkbenchCommandPayloads[K]) => { observed.add(command); return f.ask(command, payload) }
  assert.equal((await ask('localWorkbench.capabilities', {})).artworkImportFormats.length, 4)
  assert.equal((await ask('localWorkbench.read', { albums: [selected] })).albums[0]?.capture.readToken, reference.readToken)
  const local = await ask('localWorkbench.artwork.local', fileRequest); assert.equal(local[0]?.origin, 'local-independent')
  const found = await ask('localWorkbench.artwork.search', { ...fileRequest, query: '合成专辑', sourceId: 'aggregate' })
  assert.equal(found.candidates.length, 2); assert.deepEqual(found.candidates.map(item => item.sourceLabel), ['豆瓣', 'iTunes'])
  assert.equal(f.network.find(url => url.hostname === 'itunes.apple.com')?.searchParams.get('country'), 'CN')
  const file = await ask('localWorkbench.artwork.file', fileRequest); assert.ok(file); assert.equal(f.events.filter(item => item === '关闭文件许可').length, 1)
  const imported = await ask('localWorkbench.artwork.import', inputRequest())
  const artwork = await ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: imported.candidateId })
  const ai = await ask('localWorkbench.ai.suggest', { ...fileRequest, backend: 'cloud' })
  assert.equal(ai.candidates[0]?.title, '合成新专辑'); assert.equal(f.nameRequests[0]?.headers.get('authorization'), 'Bearer synthetic-main-secret')
  assert.equal(JSON.parse(f.nameRequests[0]!.body.messages[1]!.content).albumName, selected.title)
  const name = await ask('localWorkbench.ai.preview', { datasetId, captures: [reference], selections: [{ albumId: reference.albumId, candidateId: ai.candidates[0]!.candidateId }] })
  assert.equal(name.items[0]?.changes.find(item => item.field === 'album')?.before, selected.title)
  const target = await ask('localWorkbench.cue.target', {}); assert.ok(target)
  const cue = await ask('localWorkbench.cue.preview', { datasetId, captures: [reference], cueSelections: [{ albumId: reference.albumId, cueId: 'cue-a' }], outputFormat: 'flac', target, sourceDisposition: 'retain' })
  assert.equal(cue.tracks[0]?.frameCount, 44100); assert.ok(f.events.includes('受保护目标'))
  assert.equal(f.events.some(item => item.startsWith('应用:')), false)
  const applied = await ask('localWorkbench.plan.apply', original(artwork)); assert.equal(applied.state, 'succeeded')
  assert.deepEqual(await ask('localWorkbench.plan.receipt', original(artwork)), applied)
  assert.equal((await ask('localWorkbench.plan.apply', original(name, 'name-command'))).state, 'unknown')
  const cancelled = await ask('localWorkbench.plan.cancel', { original: original(name, 'name-command'), cancelCommandId: 'cancel-name-command' }); assert.equal(cancelled.state, 'cancelled')
  assert.deepEqual(await ask('localWorkbench.existing.open', { action: 'finder', albums: [selected] }), { opened: true })
  assert.deepEqual([...observed].sort(), [...dto.LOCAL_WORKBENCH_COMMANDS].sort())
  const publicJson = JSON.stringify({ local, found, file, imported, artwork, ai, name, target, cue, applied, cancelled })
  assert.doesNotMatch(publicJson, /https?:|private-synthetic|synthetic-main-secret|imageUrl|sourcePageUrl|compatibleOriginalBytes|\/合成受控目录/u)
  const privateCopy = await f.service.readPrivateArtwork({ datasetId, candidateId: imported.candidateId })
  assert.deepEqual(privateCopy.compatibleOriginalBytes, new Uint8Array(jpeg()))
  assert.equal(f.snapshot()?.entries[0]?.capture.artwork?.[0]?.candidateId, imported.candidateId)
  privateCopy.compatibleOriginalBytes.fill(0)
  assert.deepEqual((await f.service.readPrivateArtwork({ datasetId, candidateId: imported.candidateId })).compatibleOriginalBytes, new Uint8Array(jpeg()))
})

test('捕获、工作库、TTL及字节预算围栏拒绝候选复用，不签发替代计划', async t => {
  const f = await fixture(t), imported = await f.ask('localWorkbench.artwork.import', inputRequest())
  await assert.rejects(f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: imported.candidateId }, context(undefined, otherDataset)), /当前工作库/u)
  await assert.rejects(f.ask('localWorkbench.artwork.preview', { datasetId, capture: { ...reference, readToken: 'other-read' }, candidateId: imported.candidateId }), /捕获不一致/u)
  await assert.rejects(f.service.readPrivateArtwork({ datasetId: otherDataset, candidateId: imported.candidateId }), /副本已失效/u)
  f.setRevision('album-2')
  await assert.rejects(f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: imported.candidateId }), /原专辑读取已变化/u)
  f.setRevision('album-1'); f.advance(1001)
  await assert.rejects(f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: imported.candidateId }), /已过期/u)
  assert.equal(f.snapshot(), null)
  const limited = await fixture(t, { maxCandidateBytes: 1 })
  await assert.rejects(limited.ask('localWorkbench.artwork.import', inputRequest()), /缓存超过预算/u)
  assert.equal(limited.service.inspect().artworkCandidates, 0)
})

test('格式与能力按真实资格判断，离线和未接入不会生成假候选或触发transport', async t => {
  const f = await fixture(t)
  f.setAvailability('offline')
  await assert.rejects(f.ask('localWorkbench.ai.suggest', { ...fileRequest, backend: 'ollama' }), /离线/u)
  assert.equal(f.nameRequests.length, 0)
  await assert.rejects(f.ask('localWorkbench.artwork.search', { ...fileRequest, sourceId: 'aggregate', query: '合成' }), /离线/u)
  assert.equal(f.network.length, 0)
  f.setAvailability('online'); f.capabilities.capabilities['artwork-file'] = { available: false, reason: '合成原生入口尚未接入。' }
  await assert.rejects(f.ask('localWorkbench.artwork.file', fileRequest), /原生入口尚未接入/u)
  assert.equal(f.events.includes('许可读图'), false)
  f.capabilities.artworkImportFormats = f.capabilities.artworkImportFormats.map(item => item.mime === 'image/jpeg' ? { ...item, availability: { available: false, reason: '合成 JPEG 解码器不支持。' } } : item)
  await assert.rejects(f.ask('localWorkbench.artwork.import', inputRequest()), /解码器不支持/u)
  f.capabilities.artworkImportFormats = f.capabilities.artworkImportFormats.map(item => item.mime === 'image/jpeg' ? { ...item, availability: { available: true } } : item)
  await assert.rejects(f.ask('localWorkbench.artwork.import', { ...inputRequest(), mime: 'image/png' }), /格式与实际输入不一致/u)
  assert.equal(f.service.inspect().artworkCandidates, 0)
})

test('模型原JSON由Core校验，失败收口准备；修改捕获后不能预览旧名称', async t => {
  const malformed = await fixture(t, { modelContent: '{"artistName":"合成","albumName":"合成","command":"私有指令"}' })
  await assert.rejects(malformed.ask('localWorkbench.ai.suggest', { ...fileRequest, backend: 'vllm' }), /限定的artistName/u)
  assert.equal(malformed.preparations.size, 0); assert.equal(malformed.service.inspect().nameCandidates, 0)
  const f = await fixture(t), result = await f.ask('localWorkbench.ai.suggest', { ...fileRequest, backend: 'ollama' })
  assert.equal(f.preparations.size, 0); f.setRevision('album-2')
  await assert.rejects(f.ask('localWorkbench.ai.preview', { datasetId, captures: [reference], selections: [{ albumId: reference.albumId, candidateId: result.candidates[0]!.candidateId }] }), /原读取已变化/u)
  assert.equal(f.snapshot(), null)
})

test('受控网页内嵌与显式外部入口分别保留，手动远程导入只返回安全候选', async t => {
  const f = await fixture(t)
  const web = await f.ask('localWorkbench.artwork.search', { ...fileRequest, sourceId: 'google-web', query: '合成专辑' })
  assert.deepEqual(web.candidates, [])
  assert.deepEqual(web.sources.map(source => ({ source: source.source, status: source.status })), [{ source: 'web', status: 'opened' }])
  assert.equal(f.navigated.length, 1); assert.equal(f.external.length, 0)
  assert.deepEqual(await f.service.navigateWebSource({ ...fileRequest, sourceId: 'google-web', query: '合成专辑', external: true }, context()), { opened: true })
  assert.equal(f.external.length, 1)
  const candidate = await f.service.importRemoteSource({ ...fileRequest, source: { url: 'https://images.synthetic.example/cover.jpg', label: '合成远程图片' } }, context())
  assert.equal(candidate.origin, 'manual'); assert.ok(dto.isLocalWorkbenchArtworkCandidate(candidate, reference.albumId))
  assert.doesNotMatch(JSON.stringify(candidate), /https?:|images\.synthetic|imageUrl/u)
  await assert.rejects(f.service.importRemoteSource({ ...fileRequest, source: { url: 'https://127.0.0.1/cover.jpg' } }, context()), /输入|来源|规则/u)
  await assert.rejects(f.service.readPrivateArtwork({ datasetId: otherDataset, candidateId: candidate.candidateId }), /失效/u)
})

test('读取消和关闭等待真实端口收口，迟到图字节不能进入候选', async t => {
  const f = await fixture(t), local = deferred<dto.LocalArtworkSourceCopies>(), chooser = deferred<void>()
  f.owner.readLocalArtwork = async () => { f.events.push('等待本地图'); return local.promise }
  f.serviceOptions.nativeChooser.closeReadResources = async () => chooser.promise
  const controller = new AbortController()
  let settled = false, closing = false
  const pending = f.ask('localWorkbench.artwork.local', fileRequest, context(controller.signal)).then(() => { settled = true }, error => { settled = true; assert.equal(error.name, 'AbortError') })
  for (let at = 0; at < 5; at++) await tick()
  assert.ok(f.events.includes('等待本地图')); controller.abort()
  const close = f.service.closeReadResources().then(() => { closing = true })
  await tick(); assert.equal(settled, false); assert.equal(closing, false)
  local.resolve({ status: 'ready', items: [{ origin: 'local-independent', sourceIdentity: 'late-source', sourceLabel: '迟到图', base64: jpeg().toString('base64') }] })
  await pending; assert.equal(f.service.inspect().artworkCandidates, 0); assert.equal(closing, false)
  chooser.resolve(); await close; assert.equal(closing, true)
})

test('取消后迟到的原生文件仍关闭许可；取消面板读取不会撤回原应用', async t => {
  const f = await fixture(t), choice = deferred<Awaited<ReturnType<LocalWorkbenchServiceOptions['nativeChooser']['chooseArtwork']>>>()
  let fileClosed = 0
  f.serviceOptions.nativeChooser.chooseArtwork = async () => choice.promise
  const controller = new AbortController(), pending = f.ask('localWorkbench.artwork.file', fileRequest, context(controller.signal))
  const rejection = assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError')
  for (let at = 0; at < 5; at++) await tick()
  controller.abort(); choice.resolve({ label: '合成晚返回文件', read: async () => { assert.fail('取消后不能读取文件') }, close: async () => { fileClosed++ } })
  await rejection; assert.equal(fileClosed, 1); assert.equal(f.service.inspect().artworkCandidates, 0)
  const imported = await f.ask('localWorkbench.artwork.import', inputRequest()), plan = await f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: imported.candidateId })
  const cancelledPanel = new AbortController(); cancelledPanel.abort()
  const value = await f.ask('localWorkbench.plan.apply', original(plan), context(cancelledPanel.signal))
  assert.equal(value.state, 'succeeded'); assert.deepEqual(f.events.filter(item => item.startsWith('应用:')), ['应用:command-a'])
})

test('冻结image与原回执条目必须一致，陌生原命令及错回包不被接受', async t => {
  const f = await fixture(t), item = await f.ask('localWorkbench.artwork.import', inputRequest())
  const prepare = f.owner.read.prepareArtworkPreview
  f.owner.read.prepareArtworkPreview = async (...args) => { const value = await prepare(...args); value.capture.artwork = value.capture.artwork?.map(art => ({ ...art, candidateId: 'substituted-candidate' })); return value }
  await assert.rejects(f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: item.candidateId }), /同一图片/u)
  assert.equal(f.snapshot(), null); f.owner.read.prepareArtworkPreview = prepare
  const plan = await f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: item.candidateId })
  await assert.rejects(f.ask('localWorkbench.plan.apply', { ...original(plan), planHash: '0'.repeat(64) }), /冻结计划不一致/u)
  assert.equal(f.events.some(event => event.startsWith('应用:')), false)
  f.owner.registry = { ...f.registry, apply: async request => ({ ...receipt(request, plan), items: [] }) }
  await assert.rejects(f.ask('localWorkbench.plan.apply', original(plan)), /条目不一致/u)
})

test('原图随原计划持久化，新Main会话只读恢复较大owned副本，不拿小display或重新下载替代', async t => {
  // 自有32px像素经过真实Rust编码；合成说明段保证原副本显著大于display，不假定编码器输出几字节JPEG。
  const owned = readFileSync(new URL('../../../packages/bridge-core/test/fixtures/mbrs012-source/owned-cover-32.jpg', import.meta.url))
  const input = Buffer.concat([owned.subarray(0, 2), ...Array.from({ length: 4 }, () => segment(254, Buffer.alloc(60_000, 65))), owned.subarray(2)])
  const f = await fixture(t, { decode: () => decoder(32, 32) })
  const item = await f.ask('localWorkbench.artwork.import', { ...fileRequest, bytes: new Uint8Array(input), mime: 'image/jpeg', label: '仓库自有图像副本' })
  const plan = await f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: item.candidateId })
  const frozen = f.registry.readArtworkCapture({ datasetId, planId: plan.planId, candidateId: item.candidateId })
  assert.ok(frozen); assert.equal(frozen.artwork.image.original.bytes, input.length)
  assert.ok(frozen.artwork.image.original.bytes > frozen.artwork.image.display.bytes * 100)
  assert.notEqual(frozen.artwork.image.original.sha256, frozen.artwork.image.display.sha256)
  assert.deepEqual(Buffer.from(frozen.artwork.originalBase64, 'base64'), input)
  f.advance(10 * 60_000 + 1)
  const restored = createLocalWorkbenchService(f.serviceOptions); t.after(() => restored.close())
  assert.equal(restored.inspect().artworkCandidates, 0)
  const privateCopy = await restored.readPrivateArtwork({ datasetId, planId: plan.planId, candidateId: item.candidateId })
  assert.deepEqual(privateCopy.compatibleOriginalBytes, new Uint8Array(input))
  assert.equal(createHash('sha256').update(privateCopy.compatibleOriginalBytes).digest('hex'), frozen.artwork.image.original.sha256)
  assert.equal(f.network.length, 0); assert.equal(f.nameRequests.length, 0)
  await assert.rejects(restored.readPrivateArtwork({ datasetId, planId: 'other-plan', candidateId: item.candidateId }), /持久捕获/u)
  await assert.rejects(restored.readPrivateArtwork({ datasetId: otherDataset, planId: plan.planId, candidateId: item.candidateId }), /持久捕获/u)
  assert.equal(f.snapshot()?.entries[0]?.original, null, '只读恢复不赋予应用授权或创建新命令')
})

test('close开始即拒绝新写，已受理应用先收口再释放独立目标许可；closeReadResources只关闭读取', async t => {
  const f = await fixture(t), item = await f.ask('localWorkbench.artwork.import', inputRequest())
  const plan = await f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: item.candidateId })
  await f.ask('localWorkbench.cue.target', {})
  const gate = deferred<dto.LocalWorkbenchReceipt>(), started = deferred<void>()
  let applications = 0, closeDone = false
  f.owner.registry = { ...f.registry, apply: async () => { applications++; started.resolve(); return gate.promise } }
  const accepted = f.ask('localWorkbench.plan.apply', original(plan))
  await started.promise; await f.service.closeReadResources()
  assert.equal(f.service.inspect().writes, 1)
  assert.equal(f.events.includes('关闭目标许可'), false)
  const closing = f.service.close().then(() => { closeDone = true })
  await assert.rejects(f.ask('localWorkbench.plan.apply', original(plan, 'late-command')), /不再接受新命令/u)
  await tick(); assert.equal(closeDone, false); assert.equal(applications, 1)
  assert.equal(f.events.includes('关闭目标许可'), false)
  assert.deepEqual((await f.service.readPrivateArtwork({ datasetId, planId: plan.planId, candidateId: item.candidateId })).compatibleOriginalBytes, new Uint8Array(jpeg()))
  gate.resolve(receipt(original(plan), plan)); assert.equal((await accepted).state, 'succeeded')
  await closing; assert.equal(closeDone, true); assert.equal(f.events.filter(item => item === '关闭目标许可').length, 1)
})

test('新Main会话从实际持久registry恢复含未知条目的原操作，精确查询原回执且零次再次应用', async t => {
  const f = await fixture(t), first = (await f.owner.read.resolveCapture(fileRequest)).capture
  const member = first.members.find((value): value is LocalWorkbenchCatalogMemberCapture => value.assetId !== null)
  assert.ok(member, '夹具必须来自实际成功目录成员，不把扫描失败记录补造成资产')
  const second: LocalWorkbenchAlbumCapture = { ...structuredClone(first), albumId: 'album-b', readToken: 'read-b', directoryId: 'directory-b',
    albumName: '合成另一专辑', directoryName: '合成另一目录', members: [{ ...structuredClone(member),
      trackId: '77777777-7777-4777-8777-777777777777', assetId: '88888888-8888-4888-8888-888888888888', fileName: '合成另一曲目.flac' }] }
  const nameDraft = (albums: readonly LocalWorkbenchAlbumCapture[]) => createLocalNamePlanDraft(albums.map(capture => {
    const parsed = parseLocalNameProposal('{"artistName":"合成整理作者","albumName":"合成整理专辑"}', capture, 'ollama')
    assert.ok(parsed.status === 'ready'); return { capture, proposal: parsed.proposal }
  }))
  let stored: LocalWorkbenchRegistrySnapshot | null = null, signed = 0, initialApplications = 0
  const persistence: LocalWorkbenchRegistryPersistence = {
    load: async requestedDataset => { assert.equal(requestedDataset, datasetId); return structuredClone(stored) },
    save: async (snapshot, expected) => { assert.equal(expected, stored?.revision ?? 0); stored = structuredClone(snapshot) },
  }
  const initialRegistry = await createLocalWorkbenchPlanRegistry({ datasetId, persistence, now: () => 1_000_000, makePlanId: () => 'restart-plan-' + ++signed,
    writer: { revalidate: async () => ({ valid: true }), apply: async (request, plan) => {
      initialApplications++
      const value = receipt(request, plan)
      if (request.commandId !== 'original-partial-command') return value
      const partial: dto.LocalWorkbenchReceipt = { ...value, state: 'partial', items: value.items.map((item, index): dto.LocalWorkbenchItemResult => ({ ...item, state: index === 0 ? 'applied' : 'unknown' })) }
      return partial
    }, readOriginalReceipt: async () => { assert.fail('初次应用不能借查询伪造原回执') } } })
  const initial = createLocalWorkbenchService({ ...f.serviceOptions, owner: { ...f.owner, registry: initialRegistry } })
  t.after(() => initial.close())
  const completedPlan = await initialRegistry.issuePlan(nameDraft([first]), { datasetId, datasetRevision: 'dataset-1', albums: [first] })
  await initial.request({ command: 'localWorkbench.plan.apply', payload: original(completedPlan, 'completed-before-restart') }, context())
  const plan = await initialRegistry.issuePlan(nameDraft([first, second]), { datasetId, datasetRevision: 'dataset-1', albums: [first, second] })
  const command = original(plan, 'original-partial-command')
  const applied = await initial.request({ command: 'localWorkbench.plan.apply', payload: command }, context())
  assert.ok(dto.isLocalWorkbenchReceipt(applied, command, plan)); assert.equal(applied.state, 'partial')
  assert.deepEqual(applied.items.map(item => item.state), ['applied', 'unknown'])
  assert.equal(initialRegistry.operations().find(operation => operation.request.commandId === command.commandId)?.state, 'unknown')
  await initial.close()

  let restoredApplications = 0, restoredRevalidations = 0, replacementPlans = 0
  const queried: dto.LocalWorkbenchApplyRequest[] = [], settled = receipt(command, plan)
  const restoredRegistry = await createLocalWorkbenchPlanRegistry({ datasetId, persistence, now: () => 2_000_000,
    makePlanId: () => { replacementPlans++; return 'forbidden-replacement-plan' },
    writer: { revalidate: async () => { restoredRevalidations++; return { valid: true } },
      apply: async () => { restoredApplications++; assert.fail('恢复和回执查询不得再次应用') },
      readOriginalReceipt: async request => { queried.push(structuredClone(request)); assert.deepEqual(request, command); return settled } } })
  const owner: LocalWorkbenchOwnerPorts = { ...f.owner, registry: restoredRegistry }
  const restored = createLocalWorkbenchService({ ...f.serviceOptions, owner }); t.after(() => restored.close())
  const missingOperations = { ...restoredRegistry }; Reflect.deleteProperty(missingOperations, 'operations')
  assert.throws(() => createLocalWorkbenchService({ ...f.serviceOptions, owner: { ...owner, registry: missingOperations } }), /完整的原 Owner/u)
  const readRequest: LocalWorkbenchMainRequest = { command: 'localWorkbench.read', payload: { albums: [selected] } }
  const read = await restored.request(readRequest, context())
  assert.ok(dto.isLocalWorkbenchReadback(read, readRequest.payload))
  assert.equal(read.pendingOperations?.length, 1, '终态操作不进入待确认列表，未依据当前所选专辑裁剪原批次')
  assert.deepEqual(read.pendingOperations?.[0], restoredRegistry.operations().find(operation => operation.request.commandId === command.commandId))
  assert.deepEqual(read.pendingOperations?.[0]?.request, command)
  assert.equal(read.pendingOperations?.[0]?.state, 'unknown'); assert.equal(read.pendingOperations?.[0]?.receipt?.state, 'partial')
  assert.deepEqual(queried, [], '读取恢复只投影原登记簿，不自行查询或重发')

  const pending = read.pendingOperations![0]!
  owner.registry = { ...restoredRegistry, operations: () => [{ ...pending, request: { ...command, planHash: '0'.repeat(64) } }] }
  await assert.rejects(restored.request(readRequest, context()), /持久原操作列表/u)
  owner.registry = { ...restoredRegistry, operations: () => Array.from({ length: 101 }, (_, index) => ({ ...pending, request: { ...command, commandId: 'overflow-command-' + index },
    receipt: pending.receipt === null ? null : { ...pending.receipt, commandId: 'overflow-command-' + index } })) }
  await assert.rejects(restored.request(readRequest, context()), /未截取列表/u)
  owner.registry = restoredRegistry

  assert.deepEqual(await restored.request({ command: 'localWorkbench.plan.receipt', payload: pending.request }, context()), settled)
  assert.deepEqual(queried, [command])
  const after = await restored.request(readRequest, context()); assert.ok(dto.isLocalWorkbenchReadback(after, readRequest.payload))
  assert.deepEqual(after.pendingOperations, [])
  assert.equal(initialApplications, 2); assert.equal(restoredApplications, 0); assert.equal(restoredRevalidations, 0); assert.equal(replacementPlans, 0)
  assert.equal(restoredRegistry.inspect().entries.length, 2)
  assert.deepEqual(restoredRegistry.inspect().entries.find(entry => entry.plan.planId === plan.planId)?.original, command)
  assert.equal(f.network.length, 0); assert.equal(f.nameRequests.length, 0)
})

test('异步Owner端口等待真实登记簿回包、原图冷恢复和准备取消；close等待收口且不再次应用', async t => {
  const f = await fixture(t), image = await f.ask('localWorkbench.artwork.import', inputRequest())
  const artworkPlan = await f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: image.candidateId })
  const names = await f.ask('localWorkbench.ai.suggest', { ...fileRequest, backend: 'vllm' })
  const namePlan = await f.ask('localWorkbench.ai.preview', { datasetId, captures: [reference], selections: [{ albumId: reference.albumId, candidateId: names.candidates[0]!.candidateId }] })
  const command = original(namePlan, 'name-command')
  assert.equal((await f.ask('localWorkbench.plan.apply', command)).state, 'unknown')
  const operationsStarted = deferred<void>(), operationsGate = deferred<void>(), frozenStarted = deferred<void>(), frozenGate = deferred<void>()
  const planStarted = deferred<void>(), planGate = deferred<void>(), cancellationStarted = deferred<string>(), cancellationGate = deferred<void>()
  const queries: { datasetId: string; planId: string; candidateId: string }[] = [], planQueries: string[] = []
  const cancelPreparation = f.owner.read.cancelNamePreparation
  f.owner.read.cancelNamePreparation = async id => { cancellationStarted.resolve(id); await cancellationGate.promise; return await cancelPreparation(id) }
  f.owner.registry = { ...f.registry,
    operations: async () => { operationsStarted.resolve(); await operationsGate.promise; return f.registry.operations() },
    readArtworkCapture: async request => { queries.push(structuredClone(request)); frozenStarted.resolve(); await frozenGate.promise; return f.registry.readArtworkCapture(request) },
    getPlan: async planId => { planQueries.push(planId); planStarted.resolve(); await planGate.promise; return f.registry.getPlan(planId) },
  }
  f.advance(1001)
  const cold = createLocalWorkbenchService(f.serviceOptions); t.after(() => cold.close())
  assert.equal(cold.inspect().artworkCandidates, 0)
  const controller = new AbortController(), readRequest: LocalWorkbenchMainRequest = { command: 'localWorkbench.read', payload: { albums: [selected] } }
  let readDone = false
  const cancelledRead = cold.request(readRequest, context(controller.signal)).finally(() => { readDone = true })
  const readRejected = assert.rejects(cancelledRead, error => error instanceof Error && error.name === 'AbortError')
  await operationsStarted.promise; await tick(); assert.equal(readDone, false)
  controller.abort(); await tick(); assert.equal(readDone, false, '取消仍等待Owner原RPC物理返回')
  operationsGate.resolve(); await readRejected
  const read = await cold.request(readRequest, context()); assert.ok(dto.isLocalWorkbenchReadback(read, readRequest.payload))
  assert.deepEqual(read.pendingOperations?.[0]?.request, command)

  await cold.request({ command: 'localWorkbench.cue.target', payload: {} }, context())
  let privateDone = false, closeDone = false
  const restored = cold.readPrivateArtwork({ datasetId, planId: artworkPlan.planId, candidateId: image.candidateId }).then(value => { privateDone = true; return value })
  await frozenStarted.promise; assert.equal(cold.inspect().privateArtworkReads, 1)
  const suggestion = cold.request({ command: 'localWorkbench.ai.suggest', payload: { ...fileRequest, backend: 'cloud' } }, context())
  const suggestionRejected = assert.rejects(suggestion, error => error instanceof Error && error.name === 'AbortError')
  assert.ok(await cancellationStarted.promise)
  const closing = cold.close().then(() => { closeDone = true })
  await assert.rejects(cold.request({ command: 'localWorkbench.plan.apply', payload: command }, context()), /不再接受新命令/u)
  await tick(); assert.equal(closeDone, false); assert.equal(privateDone, false)
  assert.equal(f.events.includes('关闭目标许可'), false)
  cancellationGate.resolve(); await suggestionRejected; await tick()
  assert.equal(closeDone, false); assert.equal(f.events.includes('关闭目标许可'), false)
  frozenGate.resolve(); await planStarted.promise; await tick()
  assert.equal(privateDone, false); assert.equal(closeDone, false, '原图和原计划两个RPC均完成后才能释放许可')
  planGate.resolve()
  assert.deepEqual((await restored).compatibleOriginalBytes, new Uint8Array(jpeg()))
  await closing
  assert.deepEqual(queries, [{ datasetId, planId: artworkPlan.planId, candidateId: image.candidateId }]); assert.deepEqual(planQueries, [artworkPlan.planId])
  assert.equal(cold.inspect().privateArtworkReads, 0); assert.equal(cold.inspect().reads, 0)
  assert.equal(f.events.filter(item => item === '关闭目标许可').length, 1)
  assert.deepEqual(f.events.filter(item => item.startsWith('应用:')), ['应用:name-command'])
  assert.deepEqual(f.registry.operations().find(operation => operation.request.commandId === command.commandId)?.request, command)
  await assert.rejects(cold.readPrivateArtwork({ datasetId, planId: artworkPlan.planId, candidateId: image.candidateId }), /不再接受私有原图读取/u)
  assert.equal(f.network.length, 0)
})


const main407Dataset='71111111-1111-4111-8111-111111111111', main407Epoch='72222222-2222-4222-8222-222222222222'
const main407Session='73333333-3333-4333-8333-333333333333', main407Command='74444444-4444-4444-8444-444444444444'
function main407Author():LocalWorkbenchRootMainAuthor {
  return {binding:Object.freeze({datasetId:main407Dataset,ownerEpoch:main407Epoch,childGeneration:1,authorityRef:{}}),assertCurrent:async()=>{},request:async()=>{throw Error('此测试不允许以Owner替代Main本地设置')},requestOwner:async()=>{throw Error('此测试未安装Owner18端点')}}
}
const main407Settings: dto.LocalNameSettings={revision:'name-407',backend:'ollama',ollama:{endpoint:'http://localhost:11434',model:'qwen3:8b'},vllm:{endpoint:'http://localhost:8000',model:''},cloud:{endpoint:'https://example.org/v1',model:'',keyConfigured:false}}

test('Main专辑显示捕获仅用实时只读核验，原工作台捕获不降级且关闭撤销旧读函数', async t => {
  const f = await fixture(t)
  let full = 0, reads = 0
  const author: LocalWorkbenchRootMainAuthor = { ...main407Author(), async assertCurrent() { full++ }, async assertReadCurrent() { reads++ } }
  const assembly = createLocalWorkbenchMainAssembly({ currentAuthor: () => author, createResources: () => ({ service: f.service,
    names: { read: async () => main407Settings, save: async () => main407Settings, securityPrompt: async () => ({ configured: false, cancelled: true }) }, close: () => f.service.close() }) })
  try {
    await assembly.activate(author)
    const originalFull = full, read = await assembly.captureReadAuthor(main407Dataset)
    await read(); await read()
    assert.equal(reads, 3); assert.equal(full, originalFull)
    const write = await assembly.captureAuthor(main407Dataset); await write()
    assert.equal(full, originalFull + 2); assert.equal(reads, 3)
    await assert.rejects(assembly.captureReadAuthor(main407Epoch), /不属于/u)
    await assembly.closeReadResources()
    await assert.rejects(read(), /换代/u)
    assert.equal(reads, 3)
  } finally { await assembly.close() }
})

test('Main只读捕获不缓存身份许可，await期间作者换代拒绝，旧实现保守回到原实时核验', async t => {
  const f = await fixture(t), started = deferred<void>(), release = deferred<void>()
  let full = 0
  const first: LocalWorkbenchRootMainAuthor = { ...main407Author(), async assertCurrent() { full++ } }
  let author = first
  const assembly = createLocalWorkbenchMainAssembly({ currentAuthor: () => author, createResources: () => ({ service: f.service,
    names: { read: async () => main407Settings, save: async () => main407Settings, securityPrompt: async () => ({ configured: false, cancelled: true }) }, close: async () => {} }) })
  try {
    await assembly.activate(first)
    const baseline = full, original = await assembly.captureReadAuthor(main407Dataset)
    await original(); assert.equal(full, baseline + 2)
    first.assertReadCurrent = async () => { started.resolve(); await release.promise }
    const pending = original(), rejected = assert.rejects(pending, /换代/u)
    await started.promise
    author = { ...first, binding: { ...first.binding, childGeneration: 2, authorityRef: {} } }
    release.resolve(); await rejected
  } finally { release.resolve(); await assembly.close() }
})

test('Main三名称设置命令只消费本地设置端口，实际配置回执不替换为opened或Owner请求',async()=>{
  const author=main407Author(),calls:string[]=[]
  const boundary=createLocalWorkbenchManagementBoundary({assertTrusted(){},isAccepting:()=>true,currentAuthor:()=>author,
    nameSettings:{async read(context){await context?.assertCurrent();calls.push('read');return main407Settings},async save(_request,context){await context.assertCurrent();calls.push('save');return {...main407Settings,revision:'name-408'}},async securityPrompt(_request,context){await context.assertCurrent();calls.push('secure');return{configured:true,cancelled:false}}}})
  assert.deepEqual(await boundary.nameSettings({}, {datasetId:main407Dataset,command:'name.settings.read',payload:{}}),main407Settings)
  const input={expectedRevision:main407Settings.revision,backend:main407Settings.backend,ollama:main407Settings.ollama,vllm:main407Settings.vllm,cloud:{endpoint:main407Settings.cloud.endpoint,model:main407Settings.cloud.model}}
  const saved=await boundary.nameSettings({}, {datasetId:main407Dataset,command:'name.settings.save',payload:{commandId:main407Command,settings:input}})
  assert.equal((saved as dto.LocalNameSettings).revision,'name-408')
  assert.deepEqual(await boundary.nameSettings({}, {datasetId:main407Dataset,command:'name.settings.securityPrompt',payload:{commandId:main407Command,backend:'cloud'}}),{configured:true,cancelled:false})
  assert.deepEqual(calls,['read','save','secure']);await boundary.close()
})

test('Main真实人工等待跨过2秒仍保留原身份，输入结束后才启动原2000ms最终Owner回核',async()=>{
  const author=main407Author(),prompt=deferred<{configured:boolean;cancelled:boolean}>(),started=deferred<void>()
  const boundary=createLocalWorkbenchManagementBoundary({assertTrusted(){},isAccepting:()=>true,currentAuthor:()=>author,
    nameSettings:{read:async()=>main407Settings,save:async()=>main407Settings,securityPrompt:async(_request,context)=>{await context.assertCurrent();started.resolve();return prompt.promise}}})
  let settled=false;const running=boundary.nameSettings({}, {datasetId:main407Dataset,command:'name.settings.securityPrompt',payload:{commandId:main407Command,backend:'cloud'}}).finally(()=>{settled=true})
  await started.promise;await new Promise(resolve=>setTimeout(resolve,2100));assert.equal(settled,false);assert.equal(boundary.pending(),1)
  prompt.resolve({configured:false,cancelled:true});assert.deepEqual(await running,{configured:false,cancelled:true});await boundary.close()
})

test('人工目录许可离开原Owner后不送进新代，revoke仍等待已启动Native任务关闭',async()=>{
  const author=main407Author();let current:LocalWorkbenchRootMainAuthor|undefined=author
  const native=deferred<dto.LocalLibraryImportChoice|null>(),started=deferred<void>()
  const boundary=createLocalWorkbenchManagementBoundary({assertTrusted(){},isAccepting:()=>true,currentAuthor:()=>current,prepareLibraryImport:async context=>{await context.assertCurrent();started.resolve();return native.promise}})
  const running=boundary.management({}, {datasetId:main407Dataset,command:'library.import.prepare',payload:{}}),rejected=assert.rejects(running,/撤销|身份/u)
  await started.promise;current={...author,binding:{...author.binding,childGeneration:2,authorityRef:{}}};boundary.revoke()
  let closed=false;const closing=boundary.close().then(()=>{closed=true});await tick();assert.equal(closed,false);native.resolve(null)
  await rejected;await closing;assert.equal(closed,true)
})

function main407Grant(request: dto.LocalLyricsSaveRequest):SourceWritesLyricsGrantRequest {
  const hash='a'.repeat(64),binding:LocalLyricsPhysicalBinding={datasetId:main407Dataset,ownerEpoch:main407Epoch,commandId:request.commandId,sessionId:request.sessionId,
    libraryId:'75555555-5555-4555-8555-555555555555',albumId:'76666666-6666-4666-8666-666666666666',captureId:'77777777-7777-4777-8777-777777777777',trackId:'78888888-8888-4888-8888-888888888888',candidateId:'79999999-9999-4999-8999-999999999999',
    rootRevision:'root-1',fileRevision:'file-1',locationRevision:'location-1',metadataRevision:hash,intentFingerprint:hash,bodySha256:hash,kind:'lrc',originalIntentSha256:hash,originalRequestSha256:lyricsPhysicalDigest(request),groupCaptureSha256:hash,protectionSha256:hash,memberCount:1,resourceCount:1,targetCount:1}
  return captureSourceWritesLyricsGrantRequest({version:1,type:'lyrics-source-grant-request',purpose:'LYRICS',requestId:'70000000-0000-4000-8000-000000000001',sequence:1,revision:1,authorityId:'70000000-0000-4000-8000-000000000002',expiresAtMs:Date.now()+2000,binding,bindingSha256:lyricsPhysicalDigest(binding)})
}
function main407Echo(q:SourceWritesLyricsGrantRequest,request:dto.LocalLyricsSaveRequest,failed=false):SourceWritesLyricsVerifyReply {
  const originalBinding={...q.binding,...(failed?{ownerEpoch:'70000000-0000-4000-8000-000000000003'}:{})}
  return captureSourceWritesLyricsVerifyReply({version:1,type:'lyrics-source-verify-reply',purpose:'LYRICS',requestId:'70000000-0000-4000-8000-000000000004',sequence:1,epoch:main407Epoch,datasetId:main407Dataset,grantRequestId:q.requestId,authorityId:q.authorityId,binding:q.binding,bindingSha256:q.bindingSha256,revision:q.revision,
    result:{originalBinding,request,phase:failed?'FAILED':'PREPARED',revision:q.revision,recordOwnerEpoch:originalBinding.ownerEpoch,currentOwnerEpoch:main407Epoch,physicalClosed:failed,protectionReleased:failed,unresolved:false,ledgerSequence:1,originalIntentSha256:q.binding.originalIntentSha256,originalRequestSha256:q.binding.originalRequestSha256,groupCaptureSha256:q.binding.groupCaptureSha256,protectionSha256:q.binding.protectionSha256,jobOrigin:null}})
}
function main407Context(author:LocalWorkbenchRootMainAuthor):LocalWorkbenchMainPreparationContext{return{binding:author.binding,signal:new AbortController().signal,assertCurrent:()=>author.assertCurrent(author.binding)}}

test('歌词Main无真实UI原save条目时拒绝许可，不用合法JSON或actor字段默认granted',async()=>{
  const author=main407Author(),request={sessionId:main407Session,commandId:main407Command,embed:false};let queries=0
  const main=createLocalLyricsMainService({currentAuthor:()=>author,verifyOriginal:async q=>{queries++;return main407Echo(q,request)}})
  const result=await main.produce(main407Grant(request),{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})
  assert.equal(result.decision,'rejected');assert.equal(result.nonce,null);assert.equal(queries,0);await main.close()
})

test('歌词Main只在真实UI原body与完整Owner回声逐值相等后授nonce，坏哈希保持拒绝路径',async()=>{
  const author=main407Author(),request={sessionId:main407Session,commandId:main407Command,embed:false};let bad=false
  const main=createLocalLyricsMainService({currentAuthor:()=>author,verifyOriginal:async q=>{const result=main407Echo(q,request);if(bad)result.result.protectionSha256='b'.repeat(64);return result}})
  await main.accept({family:'lyrics',command:'localLyrics.save',payload:request},main407Context(author))
  const granted=await main.produce(main407Grant(request),{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000});assert.equal(granted.decision,'granted');assert.match(granted.nonce!,/^[a-f0-9-]{36}$/u)
  const original=main407Grant(request),embedBinding={...original.binding,kind:'embed' as const},withoutEmbed=captureSourceWritesLyricsGrantRequest({...original,binding:embedBinding,bindingSha256:lyricsPhysicalDigest(embedBinding)})
  await assert.rejects(main.produce(withoutEmbed,{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}),'原embed=false不得因合法原body/hash获得embed许可')
  bad=true;await assert.rejects(main.produce(main407Grant(request),{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}));await main.close()
})

test('歌词Main明确failed冷重试保留旧immutable epoch并核本代echo，receipt读取不产生新许可',async()=>{
  const author=main407Author(),request={sessionId:main407Session,commandId:main407Command,embed:true}
  const main=createLocalLyricsMainService({currentAuthor:()=>author,verifyOriginal:async q=>main407Echo(q,request,true)})
  await main.accept({family:'lyrics',command:'localLyrics.receipt',payload:{sessionId:request.sessionId,commandId:request.commandId}},main407Context(author))
  assert.equal((await main.produce(main407Grant(request),{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})).decision,'rejected')
  await main.accept({family:'lyrics',command:'localLyrics.save.retry',payload:{sessionId:request.sessionId,commandId:request.commandId}},main407Context(author))
  assert.equal((await main.produce(main407Grant(request),{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})).decision,'granted');await main.close()
})

function main407ProviderContext(author:LocalWorkbenchRootMainAuthor):LocalLyricsProviderMainContext{return{binding:author.binding,signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}}
test('固定五源Main桥只取真实合成响应，QQ songid与Kugou私有accesskey映射完整原候选',async()=>{
  const author=main407Author(),urls:URL[]=[]
  const raws:Record<string,unknown>={netease:{code:200,result:{songs:[{id:1,name:'合成曲目',ar:[{name:'合成艺人'}],al:{name:'合成专辑'},dt:1000}]}},qq:{code:0,data:{song:{list:[{songid:2,songname:'合成曲目',singer:[{name:'合成艺人'}],albumname:'合成专辑',interval:1}]}}},kugou:{status:200,candidates:[{id:'3',accesskey:'synthetic-key',song:'合成曲目',singer:'合成艺人',duration:1000}]},kuwo:{TOTAL:'1',abslist:[{MUSICRID:'MUSIC_4',NAME:'合成曲目',ARTIST:'合成艺人',ALBUM:'合成专辑',DURATION:'1'}]},lrclib:[{id:5,trackName:'合成曲目',artistName:'合成艺人',albumName:'合成专辑',duration:1,plainLyrics:'合成正文'}]}
  const bridge=createLocalLyricsMainProviderBridge({currentAuthor:()=>author,transport:async url=>{urls.push(url);const source=url.hostname==='music.163.com'?'netease':url.hostname==='c.y.qq.com'?'qq':url.hostname==='lyrics.kugou.com'?'kugou':url.hostname==='search.kuwo.cn'?'kuwo':'lrclib';return response(Buffer.from(JSON.stringify(raws[source])),'application/json')}})
  const query={title:'合成曲目',artist:'合成艺人',album:'合成专辑',language:'',version:'original' as const,durationMs:1000}
  for(const [index,source]of dto.LOCAL_LYRICS_SOURCES.entries()){
    const operationId=`71000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,call={command:'lyricsProviderStart' as const,payload:{operationId,source,operation:'search' as const,input:query,expiresAtMs:Date.now()+15000}}
    await bridge.execute(call,main407ProviderContext(author));await bridge.execute({command:'lyricsProviderJoin',payload:{operationId}},main407ProviderContext(author))
    const result=await bridge.execute({command:'lyricsProviderRead',payload:{operationId,offset:0}},main407ProviderContext(author));assert.ok('bytes'in result);assert.equal(result.state,'complete');assert.equal(result.eof,true);assert.equal(result.sha256,createHash('sha256').update(result.bytes).digest('hex'))
    const parsed=JSON.parse(Buffer.from(result.bytes).toString('utf8')) as Record<string,unknown>;assert.ok(parsed);assert.equal(parseLocalLyricsSearch(source,parsed).length,1,'Main规范结果必须由真实Core五源parser消费')
    if(source==='kugou')assert.equal(Buffer.from(result.bytes).includes(Buffer.from('synthetic-key')),false,'访问键不得转入Owner规范响应')
    const again=await bridge.execute(call,main407ProviderContext(author));assert.ok('state'in again);assert.equal(again.state,'complete')
  }
  assert.equal(urls.length,5);await bridge.close()
})

test('Provider cancel不冒充join，原HTTP关闭未确认时Main close仍等待且坏关闭永不PASS',async()=>{
  const author=main407Author(),closed=deferred<void>(),body=deferred<void>(),started=deferred<void>()
  const bridge=createLocalLyricsMainProviderBridge({currentAuthor:()=>author,transport:async()=>{started.resolve();return{statusCode:200,headers:{'content-type':'application/json'},body:(async function*(){await body.promise;yield Buffer.from('[]')})(),destroy(){},closed:closed.promise}}})
  const operationId='71000000-0000-4000-8000-000000000020';await bridge.execute({command:'lyricsProviderStart',payload:{operationId,source:'lrclib',operation:'search',input:{title:'合成',artist:'合成',album:'',language:'',version:'original',durationMs:null},expiresAtMs:Date.now()+15000}},main407ProviderContext(author));await started.promise
  assert.deepEqual(await bridge.execute({command:'lyricsProviderCancel',payload:{operationId}},main407ProviderContext(author)),{operationId,cancelRequested:true})
  let joined=false;const join=bridge.execute({command:'lyricsProviderJoin',payload:{operationId}},main407ProviderContext(author)).then(()=>{joined=true});await tick();assert.equal(joined,false);body.resolve();await tick();assert.equal(joined,false);closed.resolve();await join;assert.equal(joined,true);await bridge.close()
  const bad=createLocalLyricsMainProviderBridge({currentAuthor:()=>author,transport:async()=>({...response(Buffer.from('[]'),'application/json'),closed:Promise.reject(Error('合成关闭拒绝'))})})
  await bad.execute({command:'lyricsProviderStart',payload:{operationId,source:'lrclib',operation:'search',input:{title:'合成',artist:'合成',album:'',language:'',version:'original',durationMs:null},expiresAtMs:Date.now()+15000}},main407ProviderContext(author))
  await assert.rejects(bad.execute({command:'lyricsProviderJoin',payload:{operationId}},main407ProviderContext(author)));await assert.rejects(bad.close())
})


test('Main原作者装配在同dataset换代时先join旧资源，旧代读取不能进入新服务',async t=>{
  const f=await fixture(t),first=main407Author();let author:LocalWorkbenchRootMainAuthor|undefined=first
  const oldClose=deferred<void>(),created:LocalWorkbenchRootMainAuthor[]=[]
  const assembly=createLocalWorkbenchMainAssembly({currentAuthor:()=>author,createResources:actual=>{created.push(actual);return{service:f.service,names:{read:async()=>main407Settings,save:async()=>main407Settings,securityPrompt:async()=>({configured:false,cancelled:true})},close:()=>actual===first?oldClose.promise:Promise.resolve()}}})
  await assembly.activate(first);const original=await assembly.captureAuthor(main407Dataset)
  const second={...first,binding:{...first.binding,childGeneration:2,authorityRef:{}}};author=second
  const pending=assembly.activate(second);await tick();assert.equal(created.length,1);await assert.rejects(original(),/换代/u)
  oldClose.resolve();await pending;assert.deepEqual(created,[first,second]);await assembly.close()
})

test('全库歌词许可必须原job真实受理及原SHA库链，stop后不能仅凭capture与embed继续授写',async()=>{
  const author=main407Author(),save={sessionId:main407Session,commandId:main407Command,embed:false},q=main407Grant(save)
  const jobId='71000000-0000-4000-8000-000000000040',library={datasetId:main407Dataset,libraryId:q.binding.libraryId,captureId:'71000000-0000-4000-8000-000000000041'}
  const start={family:'lyrics' as const,command:'localLyrics.job.start' as const,payload:{commandId:jobId,library,embed:false}}
  const echo=main407Echo(q,save);echo.result.jobOrigin={jobId,originalJobRequestSha256:lyricsPhysicalDigest(start.payload),library,watermark:'actual-controlled-original-watermark',phase:'running'}
  let actualEcho=echo
  const main=createLocalLyricsMainService({currentAuthor:()=>author,verifyOriginal:async()=>actualEcho})
  await main.accept(start,main407Context(author))
  const job:dto.LocalLyricsJobSnapshot={jobId,library,state:'running',totalAlbums:1,processedAlbums:0,savedAlbums:0,reviewAlbumIds:[],failedAlbumIds:[],unknownAlbumIds:[],sidecars:0,embedded:0,inspectionFailures:0,revision:1}
  await main.observe(start,job,main407Context(author))
  assert.equal((await main.produce(q,{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})).decision,'granted')
  const changedSave={...save,embed:true},changedGrant=main407Grant(changedSave),wrongEmbed=main407Echo(changedGrant,changedSave)
  wrongEmbed.result.jobOrigin={...echo.result.jobOrigin};actualEcho=wrongEmbed
  await assert.rejects(main.produce(changedGrant,{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}),'原job.start embed=false不能被合法原库链提升为true')
  actualEcho=echo
  echo.result.jobOrigin.originalJobRequestSha256='c'.repeat(64)
  await assert.rejects(main.produce(q,{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000}))
  await main.accept({family:'lyrics',command:'localLyrics.job.stop',payload:{jobId}},main407Context(author))
  assert.equal((await main.produce(q,{signal:new AbortController().signal,deadlineAtMs:performance.now()+2000})).decision,'rejected');await main.close()
})

test('Provider结果按60KiB完整分块与EOF哈希读取，超1MiB和未知源不制造成功响应',async()=>{
  const author=main407Author(),raw=Buffer.from(JSON.stringify({plainLyrics:'a'.repeat(160000)})),oversized=Buffer.alloc(1024*1024+1,65);let huge=false,calls=0
  const bridge=createLocalLyricsMainProviderBridge({currentAuthor:()=>author,transport:async()=>{calls++;return response(huge?oversized:raw,'application/json')}})
  const operationId='71000000-0000-4000-8000-000000000050'
  const start={command:'lyricsProviderStart' as const,payload:{operationId,source:'lrclib' as const,operation:'body' as const,input:{id:'1'},expiresAtMs:Date.now()+15000}}
  await bridge.execute(start,main407ProviderContext(author));await bridge.execute({command:'lyricsProviderJoin',payload:{operationId}},main407ProviderContext(author))
  const chunks:Buffer[]=[];let offset=0,eof=false
  while(!eof){const read=await bridge.execute({command:'lyricsProviderRead',payload:{operationId,offset}},main407ProviderContext(author));assert.ok('bytes'in read);assert.ok(read.bytes.byteLength<=60*1024);assert.equal(read.totalBytes,raw.length);assert.equal(read.sha256,createHash('sha256').update(raw).digest('hex'));chunks.push(Buffer.from(read.bytes));offset+=read.bytes.byteLength;eof=read.eof}
  assert.deepEqual(Buffer.concat(chunks),raw)
  huge=true;const other='71000000-0000-4000-8000-000000000051';await bridge.execute({...start,payload:{...start.payload,operationId:other}},main407ProviderContext(author));await bridge.execute({command:'lyricsProviderJoin',payload:{operationId:other}},main407ProviderContext(author))
  const rejected=await bridge.execute({command:'lyricsProviderRead',payload:{operationId:other,offset:0}},main407ProviderContext(author));assert.ok('bytes'in rejected);assert.equal(rejected.state,'failed');assert.equal(rejected.failure,'BUDGET');assert.equal(rejected.totalBytes,null);assert.equal(rejected.eof,false)
  await assert.rejects(bridge.execute({...start,payload:{...start.payload,operationId:'71000000-0000-4000-8000-000000000052',source:'unknown' as dto.LocalLyricsSource}},main407ProviderContext(author)));assert.equal(calls,2);await bridge.close()
})


test('Main关闭只拒新Provider操作，原实际登记ID的cancel和join跨作者撤销仍确认物理关闭',async()=>{
  const original=main407Author();let current:LocalWorkbenchRootMainAuthor|undefined=original
  const body=deferred<void>(),physical=deferred<void>(),started=deferred<void>()
  const bridge=createLocalLyricsMainProviderBridge({currentAuthor:()=>current,transport:async()=>{started.resolve();return{statusCode:200,headers:{'content-type':'application/json'},body:(async function*(){await body.promise;yield Buffer.from('[]')})(),destroy(){},closed:physical.promise}}})
  const operationId='71000000-0000-4000-8000-000000000070',start={command:'lyricsProviderStart' as const,payload:{operationId,source:'lrclib' as const,operation:'search' as const,input:{title:'合成',artist:'合成',album:'',language:'',version:'original' as const,durationMs:null},expiresAtMs:Date.now()+15000}}
  await bridge.execute(start,main407ProviderContext(original));await started.promise;current=undefined
  let allClosed=false;const closing=bridge.close().then(()=>{allClosed=true})
  await assert.rejects(bridge.execute({...start,payload:{...start.payload,operationId:'71000000-0000-4000-8000-000000000071'}},main407ProviderContext(original)))
  await assert.rejects(bridge.execute({command:'lyricsProviderRead',payload:{operationId,offset:0}},main407ProviderContext(original)))
  assert.deepEqual(await bridge.execute({command:'lyricsProviderCancel',payload:{operationId}},main407ProviderContext(original)),{operationId,cancelRequested:true})
  let joined=false;const join=bridge.execute({command:'lyricsProviderJoin',payload:{operationId}},main407ProviderContext(original)).then(v=>{joined=true;return v})
  await tick();assert.equal(joined,false);assert.equal(allClosed,false);body.resolve();await tick();assert.equal(joined,false);physical.resolve()
  assert.deepEqual(await join,{operationId,physicalClosed:true});await closing;assert.equal(allClosed,true)
  await assert.rejects(bridge.execute({command:'lyricsProviderJoin',payload:{operationId:'71000000-0000-4000-8000-000000000099'}},main407ProviderContext(original)))
})

test('Supervisor实际主port闭集消费五源并发，原Owner关闭仍收cancel与join且每个reply严格回声',async()=>{
  class Port implements CoreMessagePort {
    listener:((event:{data:unknown})=>void)|undefined;sent:unknown[]=[];closed=false
    on(_event:'message',listener:(event:{data:unknown})=>void){this.listener=listener}
    start(){}close(){this.closed=true}
    postMessage(message:unknown){this.sent.push(message);onMainPost(message)}
    receive(data:unknown){this.listener?.({data})}
  }
  class Child implements CoreChildProcess {
    listeners:Array<(code:number)=>void>=[];postMessage(){}
    once(_event:'exit',listener:(code:number)=>void){this.listeners.push(listener)}
    kill(){this.exit();return true}exit(){for(const f of this.listeners.splice(0))f(0)}
  }
  const port=new Port(),child=new Child(),body=deferred<void>(),physical=deferred<void>(),responses=new Map<string,(r:DatasetLyricsProviderReply)=>void>()
  let shutdownId:string|undefined,author:LocalWorkbenchRootMainAuthor|undefined,sequence=0,requests=0
  const bridge=createLocalLyricsMainProviderBridge({currentAuthor:()=>author,transport:async url=>{
    requests++;const data=url.hostname==='music.163.com'?{code:200,result:{songs:[]}}:url.hostname==='c.y.qq.com'?{code:0,data:{song:{list:[]}}}:url.hostname==='lyrics.kugou.com'?{status:200,candidates:[]}:url.hostname==='search.kuwo.cn'?{TOTAL:'0',abslist:[]}:[]
    return{statusCode:200,headers:{'content-type':'application/json'},body:(async function*(){await body.promise;yield Buffer.from(JSON.stringify(data))})(),destroy(){},closed:physical.promise}
  }})
  const supervisor=new CoreSupervisor({entryPath:'synthetic-utility',cwd:'.',playbackEventProtocol:null,dependencies:{createChannel:()=>({port1:new Port(),port2:port}),fork:()=>{queueMicrotask(()=>port.receive({version:dto.IPC_VERSION,event:'core.ready',payload:{state:{runtime:'ready',roon:'disconnected',provider:'missing',activeStreamCount:0,activePlaybackPresent:false}}}));return child}}})
  supervisor.configurePrivateLyricsProviderBridge({execute:(request,context)=>{
    switch(request.command){
      case 'lyricsProviderStart':return bridge.execute({command:request.command,payload:request.payload as import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetLyricsProviderStart},context)
      case 'lyricsProviderRead':return bridge.execute({command:request.command,payload:request.payload as {operationId:string;offset:number}},context)
      case 'lyricsProviderCancel':return bridge.execute({command:request.command,payload:request.payload as {operationId:string}},context)
      case 'lyricsProviderJoin':return bridge.execute({command:request.command,payload:request.payload as {operationId:string}},context)
    }
  },revokeOwner:binding=>bridge.revokeOwner(binding)})
  function onMainPost(input:unknown){
    const raw=input as Record<string,unknown>
    if(raw.command==='commandOutbox.context')queueMicrotask(()=>port.receive({version:1,id:raw.id,ok:true,result:{datasetId:main407Dataset}}))
    else if(raw.command==='core.shutdown')shutdownId=String(raw.id)
    else if(raw.type==='musicbridge.workbench.frame'&&raw.lane==='request'&&raw.part==='end'){
      const meta=datasetWorkbenchMeta(input as import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchFrame)
      for(const frame of datasetWorkbenchFrames(meta,'response',{epoch:main407Epoch,datasetId:main407Dataset,ready:true}))queueMicrotask(()=>port.receive(frame))
    }else if(raw.type==='musicbridge.lyrics.provider-reply'){
      const reply=captureDatasetLyricsProviderReply(input);const receive=responses.get(reply.requestId);assert.ok(receive);responses.delete(reply.requestId);receive(reply)
    }
  }
  function call(command:DatasetLyricsProviderRequest['command'],payload:DatasetLyricsProviderRequest['payload']):Promise<DatasetLyricsProviderReply>{
    const request=captureDatasetLyricsProviderRequest({version:1,type:'musicbridge.lyrics.provider-request',requestId:crypto.randomUUID(),sequence:++sequence,epoch:main407Epoch,datasetId:main407Dataset,command,payload,expiresAtMs:Date.now()+2000})
    return new Promise(resolve=>{responses.set(request.requestId,reply=>{assertDatasetLyricsProviderReplyForRequest(reply,request);resolve(reply)});port.receive(request)})
  }
  try{
    await supervisor.start();author=await supervisor.createWorkbenchRootMainAuthor()
    const ids=dto.LOCAL_LYRICS_SOURCES.map((_source,index)=>`71000000-0000-4000-8000-${String(80+index).padStart(12,'0')}`)
    const starts=await Promise.all(dto.LOCAL_LYRICS_SOURCES.map((source,index)=>call('lyricsProviderStart',{operationId:ids[index]!,source,operation:'search',input:{title:'合成',artist:'合成',album:'',language:'',version:'original',durationMs:null},expiresAtMs:Date.now()+15000})))
    assert.ok(starts.every(reply=>reply.ok));assert.equal(requests,5)
    author=undefined;const shutting=supervisor.shutdown();await tick();assert.ok(shutdownId)
    const cancels=await Promise.all(ids.map(operationId=>call('lyricsProviderCancel',{operationId})));assert.ok(cancels.every(reply=>reply.ok&&'cancelRequested'in reply.result&&reply.result.cancelRequested))
    let settled=false;const joins=Promise.all(ids.map(operationId=>call('lyricsProviderJoin',{operationId}))).then(v=>{settled=true;return v});await tick();assert.equal(settled,false)
    body.resolve();await tick();assert.equal(settled,false);physical.resolve();const joined=await joins
    assert.ok(joined.every(reply=>reply.ok&&'physicalClosed'in reply.result&&reply.result.physicalClosed))
    port.receive({version:1,id:shutdownId,ok:true,result:{stopped:true}});child.exit();await shutting;await supervisor.joinPrivateLyricsProviderBridge();await bridge.close()
    assert.equal(port.closed,true);assert.equal(responses.size,0)
  }finally{body.resolve();physical.resolve();const stopped=supervisor.shutdown();if(shutdownId)port.receive({version:1,id:shutdownId,ok:true,result:{stopped:true}});child.exit();await stopped;await bridge.close();await supervisor.joinPrivateLyricsProviderBridge()}
})


// 418仅使用隔离MessagePort和新建普通目录；不启动AppKit、不连接真实Owner/媒体。
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { once as eventOnce } from 'node:events'
import { mkdtemp, mkdir, open, rename, lstat, realpath, readFile, writeFile, type FileHandle } from 'node:fs/promises'
import { constants as directoryConstants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createLocalWorkbenchNativeChooser, createLocalWorkbenchDirectoryMainBridge, type LocalWorkbenchDirectoryUiContext } from '../src/main/local-library-workbench/native-chooser.js'
import { createUtilitySourceWritesBridge, type SourceWritesUtilityPort } from '../../../packages/bridge-core/src/shared/source-writes-utility-port.js'
import { attachDatasetOwnerWorkerPort } from '../../../packages/bridge-core/src/collection/dataset-owner-worker.js'
import { createSourceWritesMainActor, captureSourceWorkbenchDirectoryBinding, captureSourceWorkbenchDirectoryUi, captureSourceWorkbenchDirectoryRequest,
  captureSourceWorkbenchDirectoryReply, captureSourceWorkbenchDirectoryRegistrationRequest, captureSourceWorkbenchDirectoryRegistrationReply,
  assertSourceWorkbenchDirectoryRegistrationReplyForRequest, consumeSourceWorkbenchDirectoryReply, requestWorkbenchDirectoryApproval,
  assertSourceWorkbenchDirectoryApproval, type SourceWorkbenchDirectoryBinding, type SourceWorkbenchDirectoryUi, type SourceWorkbenchDirectoryPhysical,
  type SourceWorkbenchDirectoryRequest, type SourceWorkbenchDirectoryReply, type SourceWorkbenchDirectoryOwnerDomain, type SourceWorkbenchDirectoryRegistrationReply } from '../../../packages/bridge-core/src/collection/source-writes-authority.js'
import type { OwnedDatasetDomain, DatasetOwnerResponse } from '../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { authorizeSourceDirectory } from '../../../packages/bridge-core/src/recording/source-files.js'
import { registerLocalAlbumIpc, runLocalAlbumMainRead } from '../src/main/local-library-workbench/album-ipc.js'
import { isLocalAlbumMainResponse, type LocalAlbumMainRequest } from '../../../packages/bridge-core/src/collection/local-album-browser/main-protocol.js'

class Directory418Port implements SourceWritesUtilityPort {
  readonly listeners=new Map<Function,Function>()
  closed=false
  constructor(readonly physical:MessagePort){physical.once('close',()=>{this.closed=true})}
  on(event:'message',listener:(event:{data:unknown;ports?:readonly unknown[]})=>void):unknown
  on(event:'close'|'messageerror',listener:()=>void):unknown
  on(event:'message'|'close'|'messageerror',listener:((event:{data:unknown;ports?:readonly unknown[]})=>void)|(()=>void)):unknown{
    const wrapped=event==='message'?(data:unknown)=>(listener as (event:{data:unknown})=>void)({data}):listener;this.listeners.set(listener,wrapped);return this.physical.on(event,wrapped as never)
  }
  off(event:'message',listener:(event:{data:unknown;ports?:readonly unknown[]})=>void):unknown
  off(event:'close'|'messageerror',listener:()=>void):unknown
  off(event:'message'|'close'|'messageerror',listener:Function):unknown{const original=this.listeners.get(listener);if(original){this.physical.off(event,original as never);this.listeners.delete(listener)}return this}
  start(){this.physical.start()}close(){this.physical.close()}postMessage(value:unknown){this.physical.postMessage(value)}
}
const directory418Ui=():SourceWorkbenchDirectoryUi=>captureSourceWorkbenchDirectoryUi({family:'management',command:'library.import.prepare',commandId:null,requestSha256:lyricsPhysicalDigest({command:'library.import.prepare',payload:{}})})
function directory418Binding(ui=directory418Ui()):SourceWorkbenchDirectoryBinding{const now=Date.now();return captureSourceWorkbenchDirectoryBinding({datasetId:main407Dataset,ownerEpoch:main407Epoch,childGeneration:1,kind:ui.family==='management'?'library':'cue',choiceId:randomUUID(),revision:'a'.repeat(64),issuedAtMs:now,expiresAtMs:now+600000,originalUi:ui})}
function directory418Reply(q:SourceWorkbenchDirectoryRequest,physical:SourceWorkbenchDirectoryPhysical|null,decision:SourceWorkbenchDirectoryReply['decision']='approved'):SourceWorkbenchDirectoryReply{return captureSourceWorkbenchDirectoryReply({version:1,type:'workbench-directory-reply',purpose:'WORKBENCH_DIRECTORY',requestId:q.requestId,sequence:q.sequence,authorityId:q.authorityId,command:q.command,binding:q.binding,ui:q.ui,requestSha256:lyricsPhysicalDigest(q),decision,nonce:decision==='approved'?randomUUID():null,validUntilMs:decision==='approved'?q.binding.expiresAtMs:null,physical:decision==='approved'?physical:null})}
async function directory418Path(label:string){const parent=process.env.TMPDIR;if(!parent?.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/'))throw Error('418隔离目录必须在外置LifeWeave');return mkdtemp(path.join(parent,label+'-'))}

async function directory418Fixture(t:test.TestContext,includeDomain=true){
  const directory=await directory418Path('directory418'),library=path.join(directory,'library'),target=path.join(directory,'target');await mkdir(library);await mkdir(target)
  const sourceChannels=new MessageChannel(),ownerChannels=new MessageChannel(),sourceMain=new Directory418Port(sourceChannels.port2),sourceUtility=new Directory418Port(sourceChannels.port1)
  const utility=createUtilitySourceWritesBridge(sourceUtility),sourceClosed=eventOnce(utility.port,'close'),ownerClosed=eventOnce(ownerChannels.port2,'close');let ownerEnded=false;void ownerClosed.then(()=>{ownerEnded=true})
  const roots=new Map<string,{binding:SourceWorkbenchDirectoryBinding;handle:FileHandle;physical:SourceWorkbenchDirectoryPhysical;actor:ReturnType<typeof createSourceWritesMainActor>}>(),events:string[]=[],requests:SourceWorkbenchDirectoryRequest[]=[]
  const approvedLibraries525=new Map<string,import('../src/main/local-library-workbench/native-chooser.js').LocalWorkbenchApprovedLibraryDirectory>()
  const directoryRegistrations525:{command:'register'|'release';choiceId:string}[]=[];let domainDispatchCalls525=0
  let sourceActor:ReturnType<typeof createSourceWritesMainActor>|undefined,closeGate:Promise<void>|undefined,sourceWritesCalls=0,ownerSequence=0
  const ownerWait=new Map<string,(value:DatasetOwnerResponse)=>void>();ownerChannels.port1.on('message',(value:DatasetOwnerResponse)=>{const fn=ownerWait.get(value.requestId);if(fn){ownerWait.delete(value.requestId);fn(value)}})
  function ownerCall(operation:'prepare'|'commitBoot'|'close'):Promise<DatasetOwnerResponse>{const request={version:1,type:'request',epoch:main407Epoch,requestId:randomUUID(),sequence:++ownerSequence,operation};return new Promise(resolve=>{ownerWait.set(request.requestId,resolve);ownerChannels.port1.postMessage(request)})}
  const domain:OwnedDatasetDomain & Partial<SourceWorkbenchDirectoryOwnerDomain>={datasetId:main407Dataset,commitBoot(){events.push('commit')},dispatch:async()=>{domainDispatchCalls525++;throw Error('此探针禁止通用dispatch')},failureForError:(id)=>({version:1,id,ok:false,error:{code:'NOT_READY',message:'合成有限Owner未就绪'}}),dispatchSourceWritesMain:async()=>{sourceWritesCalls++;throw Error('目录许可不得调用SourceWrites写入')},
    async close(before){await closeGate;for(const item of roots.values()){await item.handle.close()}roots.clear();await before?.();events.push('owner-close')},
    ...(includeDomain?{
      async registerWorkbenchDirectory(binding:SourceWorkbenchDirectoryBinding,context:Parameters<SourceWorkbenchDirectoryOwnerDomain['registerWorkbenchDirectory']>[1]){
        assert.equal(context.identity.epoch,main407Epoch);assert.equal(context.identity.datasetId,main407Dataset);assert.equal(context.mainActor,sourceActor)
        const approval=await requestWorkbenchDirectoryApproval(context.mainActor,'approve',binding,binding.originalUi,context.signal,context.deadlineAtMs)
        const physical=assertSourceWorkbenchDirectoryApproval(approval,context.mainActor,binding,binding.originalUi),original=await authorizeSourceDirectory(physical.path)
        assert.equal(original.path,physical.path);assert.equal(original.dev,physical.dev);assert.equal(original.ino,physical.ino)
        if(binding.kind==='cue'&&[...roots.values()].some(item=>physical.path===item.physical.path||physical.path.startsWith(item.physical.path+'/')||item.physical.path.startsWith(physical.path+'/')))throw Error('独立目标不能重叠原输入根')
        const handle=await open(physical.path,directoryConstants.O_RDONLY|directoryConstants.O_DIRECTORY|directoryConstants.O_NOFOLLOW)
        const info=await handle.stat({bigint:true}),named=await lstat(physical.path,{bigint:true});assert.equal(await realpath(physical.path),physical.path);assert.equal(info.dev,named.dev);assert.equal(info.ino,named.ino);assert.equal(String(info.birthtimeNs),physical.birthtimeNs)
        roots.set(binding.choiceId,{binding,handle,physical,actor:context.mainActor});events.push('owner-open:'+binding.kind)
        return binding.kind==='library'?{kind:'library' as const,choice:{choiceId:binding.choiceId,label:path.basename(physical.path),suggestedRole:'catalog' as const,evidence:['实际受控目录身份已回核']}}:{kind:'cue' as const,choiceId:binding.choiceId,revision:binding.revision}
      },
      async revokeWorkbenchDirectory(binding:SourceWorkbenchDirectoryBinding,context:Parameters<SourceWorkbenchDirectoryOwnerDomain['revokeWorkbenchDirectory']>[1]){
        const item=roots.get(binding.choiceId);if(item){assert.equal(item.actor,context.mainActor);assert.deepEqual(item.binding,binding);await closeGate;await requestWorkbenchDirectoryApproval(context.mainActor,'revoke',binding,binding.originalUi,context.signal,context.deadlineAtMs);await item.handle.close();roots.delete(binding.choiceId);events.push('owner-fd-close:'+binding.kind)}
        return{choiceId:binding.choiceId,revision:binding.revision,revoked:true as const,physicalClosed:true as const}
      },
    }:{}),
  }
  attachDatasetOwnerWorkerPort(ownerChannels.port2,{privateSourceWritesPort:utility.port,prepare:async(epoch,_projection,actor)=>{assert.equal(epoch,main407Epoch);sourceActor=actor;return domain}})
  assert.equal((await ownerCall('prepare')).ok,true);assert.equal((await ownerCall('commitBoot')).ok,true)
  class Primary implements CoreMessagePort{listener:((event:{data:unknown})=>void)|undefined;closed=false;on(_event:'message',cb:(event:{data:unknown})=>void){this.listener=cb}start(){}close(){this.closed=true}receive(data:unknown){this.listener?.({data})}postMessage(value:unknown){onMainPost(value)}}
  class Child implements CoreChildProcess{listeners:Array<(code:number)=>void>=[];postMessage(){}once(_event:'exit',cb:(code:number)=>void){this.listeners.push(cb)}kill(){this.exit();return true}exit(){for(const fn of this.listeners.splice(0))fn(0)}}
  const primary=new Primary(),child=new Child();let current:LocalWorkbenchRootMainAuthor|undefined,bridge:ReturnType<typeof createLocalWorkbenchDirectoryMainBridge>,prompt:string=library,promptGate:Promise<void>|undefined,albumReply:((call:LocalAlbumMainRequest)=>Promise<unknown>)|undefined,identityReadRequests=0
  function onMainPost(input:unknown){const raw=input as Record<string,unknown>;if(raw.command==='commandOutbox.context')queueMicrotask(()=>primary.receive({version:1,id:raw.id,ok:true,result:{datasetId:main407Dataset}}));else if(raw.command==='core.shutdown')queueMicrotask(()=>{primary.receive({version:1,id:raw.id,ok:true,result:{stopped:true}});child.exit()});else if(raw.type==='musicbridge.workbench.frame'&&raw.lane==='request'&&raw.part==='end'){const meta=datasetWorkbenchMeta(input as import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchFrame);if(meta.kind==='context.identity')identityReadRequests++;for(const frame of datasetWorkbenchFrames(meta,'response',{epoch:main407Epoch,datasetId:main407Dataset,ready:true}))queueMicrotask(()=>primary.receive(frame))}else if(raw.type==='local-album-main-request'&&albumReply)void albumReply(input as LocalAlbumMainRequest).then(result=>primary.receive({version:1,type:'local-album-main-response',id:raw.id,datasetId:raw.datasetId,command:(input as LocalAlbumMainRequest).request.command,ok:true,result}))}
  const supervisor=new CoreSupervisor({entryPath:'controlled-directory418',cwd:directory,playbackEventProtocol:null,sourceWritesPort:true,dependencies:{createChannel:()=>({port1:new Primary(),port2:primary}),createSourceWritesChannel:()=>({port1:sourceUtility,port2:sourceMain}),fork:()=>{queueMicrotask(()=>primary.receive({version:1,event:'core.ready',payload:{state:{runtime:'ready',roon:'disconnected',provider:'missing',activeStreamCount:0,activePlaybackPresent:false}}}));return child}}})
  supervisor.configurePrivateWorkbenchDirectoryProducer((request,context)=>{requests.push(request);return bridge.produce(request,context)})
  const chooser=createLocalWorkbenchNativeChooser({assertCurrent:async context=>{if(!current||context.datasetId!==current.binding.datasetId)throw Error('实际Main作者已撤销');await current.assertCurrent(current.binding)},promptHost:{async request(_mode,signal){await promptGate;if(signal.aborted)return{cancelled:true,value:null};return{cancelled:false,value:prompt}},async join(){await promptGate},async close(){await promptGate}},registerLibraryDirectory:(object,context)=>{const actual=bridge.registerLibraryDirectory(object,context);void actual.then(choice=>{approvedLibraries525.set(choice.choiceId,object)},()=>{});return actual},registerCueTarget:(object,context)=>bridge.registerCueTarget(object,context),revokeDirectory:object=>bridge.revokeDirectory(object)})
  bridge=createLocalWorkbenchDirectoryMainBridge({currentAuthor:()=>current,chooser,registration:(command,binding,actual,signal)=>{directoryRegistrations525.push({command,choiceId:binding.choiceId});return supervisor.requestWorkbenchDirectoryRegistration(command,binding,actual,signal)},ownerClosed:actual=>supervisor.waitWorkbenchDirectoryOwnerClosed(actual)})
  await supervisor.start();current=await supervisor.createWorkbenchRootMainAuthor()
  const boundary=createLocalWorkbenchManagementBoundary({assertTrusted(){},isAccepting:()=>supervisor.status==='ready',currentAuthor:()=>current,cancelLibraryImport:(request,context)=>bridge.cancelLibraryChoice(request.choiceId,context),acceptDirectoryRequest:(request,context)=>bridge.enter(request,context),prepareLibraryImport:context=>chooser.chooseLibrary({datasetId:context.binding.datasetId,signal:context.signal,assertCurrent:context.assertCurrent,...(context.directoryUiToken?{directoryUiToken:context.directoryUiToken}:{})})})
  async function close(){await boundary.close();if(ownerEnded)await supervisor.shutdown();await bridge.close();await chooser.closeReadResources();if(!ownerEnded){const r=await ownerCall('close');assert.equal(r.ok,true);}await ownerClosed;await sourceClosed;utility.close();ownerChannels.port1.close();await supervisor.shutdown();await supervisor.joinPrivateWorkbenchDirectoryProducer();assert.equal(roots.size,0);assert.equal(ownerWait.size,0);assert.equal(sourceWritesCalls,0)}
  t.after(async()=>{closeGate=undefined;promptGate=undefined;if(!current)current=await supervisor.createWorkbenchRootMainAuthor();try{await close()}catch{for(const item of roots.values())await item.handle.close().catch(()=>{});roots.clear();utility.close();ownerChannels.port1.close();ownerChannels.port2.close();await supervisor.shutdown();throw Error('418隔离资源关闭未通过')}})
  return{directory,library,target,chooser,bridge,boundary,supervisor,roots,requests,events,approvedLibraries525,directoryRegistrations525,get identityReadRequests(){return identityReadRequests},get domainDispatchCalls525(){return domainDispatchCalls525},get sourceWritesCalls525(){return sourceWritesCalls},get author(){return current!},setAuthor(value:LocalWorkbenchRootMainAuthor|undefined){current=value},setPrompt(value:string){prompt=value},setPromptGate(value:Promise<void>|undefined){promptGate=value},setCloseGate(value:Promise<void>|undefined){closeGate=value},setAlbumReply(value:(call:LocalAlbumMainRequest)=>Promise<unknown>){albumReply=value},get actor(){return sourceActor!},ownerClosed,closeSource(){sourceMain.close()},async chooseLibrary(){return boundary.management({}, {datasetId:main407Dataset,command:'library.import.prepare',payload:{}}) as Promise<dto.LocalLibraryImportChoice>},async chooseCue(){const ctx:LocalWorkbenchDirectoryUiContext={datasetId:main407Dataset,signal:new AbortController().signal,assertCurrent:()=>current!.assertCurrent(current!.binding)};ctx.directoryUiToken=await bridge.enter({command:'localWorkbench.cue.target',payload:{}},ctx);return chooser.chooseCueTarget(ctx)}}
}

test('418：实际Source端口品牌只认原actor与原body，JSON、额外字段、跨用途和撤销不能自签',async()=>{
  const channel=new MessageChannel(),other=new MessageChannel(),actor=createSourceWritesMainActor(channel.port1),foreign=createSourceWritesMainActor(other.port1),binding=directory418Binding(),ui=binding.originalUi
  const physical={path:'/Volumes/LifeWeave/Developer/CommandLine/tmp/controlled418',dev:'1',ino:'2',birthtimeNs:'3',mode:'16832',uid:'501',gid:'20'}
  channel.port1.on('message',raw=>{assert.equal(consumeSourceWorkbenchDirectoryReply(actor,raw),true)})
  channel.port2.on('message',raw=>{const q=captureSourceWorkbenchDirectoryRequest(raw);channel.port2.postMessage(directory418Reply(q,physical,q.command==='revoke'?'revoked':'approved'))})
  try{const approval=await requestWorkbenchDirectoryApproval(actor,'approve',binding,ui,new AbortController().signal);assert.deepEqual(assertSourceWorkbenchDirectoryApproval(approval,actor,binding,ui),physical)
    assert.throws(()=>assertSourceWorkbenchDirectoryApproval(structuredClone(approval),actor,binding,ui));assert.throws(()=>assertSourceWorkbenchDirectoryApproval(approval,foreign,binding,ui));assert.throws(()=>assertSourceWorkbenchDirectoryApproval(approval,actor,binding,{...ui,requestSha256:'b'.repeat(64)}))
    assert.throws(()=>captureSourceWorkbenchDirectoryRequest({version:1,type:'workbench-directory-request',purpose:'LYRICS',requestId:randomUUID(),sequence:1,authorityId:actor.authorityId,command:'approve',binding,ui,expiresAtMs:Date.now()+2000}));assert.throws(()=>captureSourceWorkbenchDirectoryBinding({...binding,path:physical.path}));await requestWorkbenchDirectoryApproval(actor,'revoke',binding,ui,new AbortController().signal);assert.throws(()=>assertSourceWorkbenchDirectoryApproval(approval,actor,binding,ui))
  }finally{channel.port1.close();channel.port2.close();other.port1.close();other.port2.close()}
})

test('418：Main真实选择对象经Utility与Worker反向许可，Owner独立重开FD且默认源写未调用',async t=>{
  const f=await directory418Fixture(t),choice=await f.chooseLibrary();assert.equal(choice.suggestedRole,'catalog');assert.equal(f.roots.size,1);assert.equal(f.requests[0]!.command,'approve');assert.equal(f.requests[0]!.binding.originalUi.requestSha256,lyricsPhysicalDigest({command:'library.import.prepare',payload:{}}))
  f.setPrompt(f.target);const target=await f.chooseCue();assert.ok(target);assert.equal(f.roots.size,2);assert.equal(f.events.filter(event=>event.startsWith('owner-open:')).length,2)
  assert.equal(Object.hasOwn(choice,'path'),false);assert.equal(Object.hasOwn(target.target,'path'),false);assert.equal(f.roots.get(target.target.choiceId)!.handle.fd>=0,true)
  await assert.rejects(f.supervisor.waitWorkbenchDirectoryOwnerClosed({...f.author.binding,authorityRef:{}}),/身份/u);await assert.rejects(f.supervisor.requestWorkbenchDirectoryRegistration('register',f.roots.get(choice.choiceId)!.binding,{...f.author.binding},new AbortController().signal),/作者/u)
  const held=f.roots.get(target.target.choiceId)!,gate=deferred<void>(),started=deferred<void>();const work=target.withDirectory(async physical=>{assert.equal(physical,f.target);started.resolve();await gate.promise}, {signal:new AbortController().signal});const rejected=assert.rejects(work,/FD|撤销|关闭/u);await started.promise
  let closed=false;const closing=target.close().then(()=>{closed=true});const deadline=performance.now()+1000;while(f.requests.at(-1)?.command!=='revoke'&&performance.now()<deadline)await tick();assert.equal(f.requests.at(-1)?.command,'revoke');assert.equal(closed,false);assert.equal(held.handle.fd>=0,true)
  gate.resolve();await rejected;await closing;assert.equal(held.handle.fd,-1);assert.equal(f.roots.size,1);assert.deepEqual(f.requests.slice(-1).map(request=>request.command),['revoke'])
})

test('418：原confirm完整body才能revalidate，换role、换原command目标、未受理与伪token均拒绝',async t=>{
  const f=await directory418Fixture(t),choice=await f.chooseLibrary(),item=f.roots.get(choice.choiceId)!,context=main407Context(f.author)
  const original:LocalWorkbenchRootMainRequest={family:'management',command:'library.import.confirm',payload:{commandId:main407Command,choiceId:choice.choiceId,role:'album'}}
  const ui=captureSourceWorkbenchDirectoryUi({family:'management',command:'library.import.confirm',commandId:main407Command,requestSha256:lyricsPhysicalDigest({command:original.command,payload:original.payload})})
  await assert.rejects(requestWorkbenchDirectoryApproval(f.actor,'revalidate',item.binding,ui,context.signal),/拒绝/u)
  await f.bridge.enter(original,context);const approval=await requestWorkbenchDirectoryApproval(f.actor,'revalidate',item.binding,ui,context.signal);assert.deepEqual(assertSourceWorkbenchDirectoryApproval(approval,f.actor,item.binding,ui),item.physical)
  await assert.rejects(f.bridge.enter({...original,payload:{...original.payload,role:'container'}},context),/不能变更/u)
  f.setPrompt(f.target);const forged={datasetId:main407Dataset,signal:context.signal,directoryUiToken:{},assertCurrent:context.assertCurrent};await assert.rejects(f.chooser.chooseCueTarget(forged),/原UI/u)
  const actual:LocalWorkbenchDirectoryUiContext={datasetId:main407Dataset,signal:context.signal,assertCurrent:context.assertCurrent};actual.directoryUiToken=await f.bridge.enter({command:'localWorkbench.cue.target',payload:{}},actual);const target=await f.chooser.chooseCueTarget(actual);assert.ok(target);await assert.rejects(f.chooser.chooseCueTarget(actual),/原UI/u);await target.close();assert.equal(f.roots.size,1)
})

test('418：缺Domain注册端点保持NOT_READY且关闭实际MainFD，不把choice或方法存在冒充许可',async t=>{
  const f=await directory418Fixture(t,false);await assert.rejects(f.chooseLibrary(),/未确认/u);assert.equal(f.roots.size,0);assert.equal(f.bridge.pending(),0);assert.equal(f.requests.length,0)
})

test('418：CUE与已授权输入根重叠真实拒绝，原库仍可用，失败目标先撤销再关闭',async t=>{
  const f=await directory418Fixture(t),library=await f.chooseLibrary();await assert.rejects(f.chooseCue(),/未确认/u);assert.equal(f.roots.size,1);assert.ok(f.roots.has(library.choiceId));assert.equal(f.bridge.pending(),1)
})

test('418：人工目录等待不占Owner2秒，等待期间换代后不派注册、不留打开FD',async t=>{
  const f=await directory418Fixture(t),gate=deferred<void>();f.setPromptGate(gate.promise)
  let settled=false;const pending=f.chooseLibrary().finally(()=>{settled=true}),rejected=assert.rejects(pending,/撤销|身份/u)
  await new Promise(resolve=>setTimeout(resolve,2050));assert.equal(settled,false);assert.equal(f.requests.length,0);assert.equal(f.roots.size,0)
  const old=f.author;f.setAuthor(undefined);f.boundary.revoke();gate.resolve();await rejected;f.setPromptGate(undefined);f.setAuthor(old)
})

test('418：目录namespace替换后revalidate不授许可，close仍等待原Owner与Main FD真实quiet',async t=>{
  const f=await directory418Fixture(t),choice=await f.chooseLibrary(),item=f.roots.get(choice.choiceId)!,old=path.join(f.directory,'library-old');await rename(f.library,old);await mkdir(f.library)
  const original:LocalWorkbenchRootMainRequest={family:'management',command:'library.import.confirm',payload:{commandId:main407Command,choiceId:choice.choiceId,role:'catalog'}}
  await assert.rejects(f.bridge.enter(original,main407Context(f.author)),/身份|namespace|目录/u);assert.equal(item.handle.fd>=0,true)
  const gate=deferred<void>();f.setCloseGate(gate.promise);let done=false;const closing=f.bridge.close().then(()=>{done=true});await tick();assert.equal(done,false);assert.equal(item.handle.fd>=0,true);gate.resolve();await closing;assert.equal(item.handle.fd,-1);assert.equal(f.bridge.pending(),0);f.setCloseGate(undefined)
})

function directory418MainAlbumInstaller(){
  const ts=createRequire(import.meta.url)('typescript') as typeof import('typescript'),file=readFileSync(new URL('../src/main/index.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('main.ts',file,ts.ScriptTarget.ES2023,true)
  const fn=ast.statements.find((node):node is import('typescript').FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='registerCurrentLocalAlbumIpc');assert.ok(fn,'必须执行Main实际装配函数')
  const compiled=ts.transpileModule(fn.getText(ast),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText
  return Function('registerLocalAlbumIpc','isLocalAlbumMainResponse','CoreIpcError','randomUUID','registerPerformanceHandler','requireTrustedRenderer','publicIpcFailure','state',
    'with(state){'+compiled+';return registerCurrentLocalAlbumIpc}')
}

test('418：实际Main装配三个本地专辑handler，完整Supervisor读取与可信frame/Owner代际撤销组合',async t=>{
  const f=await directory418Fixture(t),calls:LocalAlbumMainRequest[]=[],query:dto.LocalAlbumQuery={query:'',rootId:null,filter:'all',offset:0,limit:60},album:dto.LocalAlbumSummary={id:'directory:controlled418',kind:'source-directory',rootId,editionId:null,title:'受控专辑',artists:[],year:null,versionLabel:null,trackCount:0,representativeTrackId:null,revision:'revision418',artworkAvailable:false,artworkState:'unknown',statuses:[]}
  const page:dto.LocalAlbumPage={...query,total:1,hasMore:false,items:[album],counts:{all:1,'missing-artwork':0,'has-artwork':0,'cue-unsplit':0,'metadata-issue':0,'parse-failed':0,'loose-audio':0,'track-named-audio':0,'missing-lyrics':0}}
  const track:dto.LocalAlbumTrackQuery={albumKey:album.id,rootId:album.rootId,offset:0,limit:100},art:dto.LocalAlbumArtworkRequest={albumKey:album.id,rootId:album.rootId,editionId:null,representativeTrackId:null,revision:album.revision}
  const frame={},event={senderFrame:frame},handlers=new Map<string,(event:{senderFrame:object},value:unknown)=>Promise<unknown>>();let trusted=true,current=f.author
  const serviceFixture=await fixture(t);const assembly=createLocalWorkbenchMainAssembly({currentAuthor:()=>current,createResources:()=>({service:serviceFixture.service,names:{read:async()=>main407Settings,save:async()=>main407Settings,securityPrompt:async()=>({configured:false,cancelled:true})},close:async()=>{}})})
  await assembly.activate(current)
  const install=directory418MainAlbumInstaller()(registerLocalAlbumIpc,isLocalAlbumMainResponse,CoreIpcError,randomUUID,(channel:string,handler:(event:{senderFrame:object},value:unknown)=>Promise<unknown>)=>{assert.equal(channel,'localAlbum:request');handlers.set(channel,handler)},()=>{if(!trusted)throw Error('页面失效');return{webContents:{mainFrame:frame}}},()=>{throw Error('不可信frame')},{AsyncLocalStorage,runLocalAlbumMainRead,localAlbumPhase,localAlbumMatch,localAlbumLink,localAlbumRejectCode,logLibraryOperation,get quitAfterCoreShutdown(){return false},get coreSupervisor(){return f.supervisor},get localWorkbenchRootMainAuthor(){return current},get localWorkbenchMainAssembly(){return assembly}})
  install(f.supervisor,assembly);const handler=handlers.get('localAlbum:request');assert.ok(handler)
  f.setAlbumReply(async call=>{calls.push(call);return call.request.command==='localAlbum.query'?page:call.request.command==='localAlbum.tracks'?{...track,total:0,hasMore:false,items:[],album}:{...art,image:null}})
  const identityBefore=f.identityReadRequests
  assert.deepEqual(await handler(event,{datasetId:main407Dataset,command:'localAlbum.query',payload:query}),page);assert.equal(f.identityReadRequests,identityBefore+2,'Main每个query只发送首末两件真实context.identity RPC')
  assert.equal((await handler(event,{datasetId:main407Dataset,command:'localAlbum.tracks',payload:track}) as dto.LocalAlbumTrackPage).items.length,0);assert.equal(f.identityReadRequests,identityBefore+4)
  assert.deepEqual(await handler(event,{datasetId:main407Dataset,command:'localAlbum.artwork',payload:art}),{...art,image:null});assert.equal(f.identityReadRequests,identityBefore+6)
  await assert.rejects(handler({senderFrame:{}},{datasetId:main407Dataset,command:'localAlbum.query',payload:query}),/frame/u);await assert.rejects(handler(event,{datasetId:main407Dataset,command:'localAlbum.apply',payload:query}),/无效/u);assert.equal(calls.length,3)
  const late=deferred<void>(),started=deferred<void>();f.setAlbumReply(async call=>{calls.push(call);started.resolve();await late.promise;return page})
  const pending=handler(event,{datasetId:main407Dataset,command:'localAlbum.query',payload:query}),rejected=assert.rejects(pending,/撤销|改变|换代/u);await started.promise;current={...main407Author(),binding:{...current.binding,ownerEpoch:randomUUID(),childGeneration:2,authorityRef:{}}};await assembly.activate(current);late.resolve();await rejected;trusted=false;await assert.rejects(handler(event,{datasetId:main407Dataset,command:'localAlbum.query',payload:query}),/页面/u);await assembly.close()
})


test('418：实际物理bridge拒额外字段与端口，Worker缺闭集不进入Domain方法',async t=>{
  const f=await directory418Fixture(t);const binding=directory418Binding();assert.throws(()=>captureSourceWorkbenchDirectoryRegistrationRequest({version:1,type:'workbench-directory-registration-request',purpose:'WORKBENCH_DIRECTORY',requestId:randomUUID(),sequence:1,command:'register',binding,expiresAtMs:Date.now()+2000,rootPath:f.library}));assert.throws(()=>captureSourceWorkbenchDirectoryUi({...binding.originalUi,secret:'合成非法字段'}));assert.equal(f.roots.size,0)
  const physical=new MessageChannel(),parent=new Directory418Port(physical.port1),bridge=createUtilitySourceWritesBridge(parent),closed=eventOnce(bridge.port,'close')
  const handler=[...parent.listeners.entries()].find(([listener])=>listener.name==='receiveUtility')?.[0] as ((event:{data:unknown;ports:unknown[]})=>void)|undefined;assert.ok(handler)
  handler({data:{version:1,type:'workbench-directory-registration-request',purpose:'WORKBENCH_DIRECTORY',requestId:randomUUID(),sequence:1,command:'register',binding,expiresAtMs:Date.now()+2000},ports:[{}]});await closed;bridge.close();physical.port1.close();physical.port2.close()
})

test('418：目录响应迟到与错误整件SHA撤回actor，不延长原2秒或把port close当已批准',async()=>{
  for(const corrupt of [false,true]){const channel=new MessageChannel(),actor=createSourceWritesMainActor(channel.port1),binding=directory418Binding(),closed=eventOnce(channel.port1,'close'),physical={path:'/Volumes/LifeWeave/Developer/CommandLine/tmp/controlled418',dev:'1',ino:'2',birthtimeNs:'3',mode:'16832',uid:'501',gid:'20'}
    channel.port2.on('message',raw=>{const q=captureSourceWorkbenchDirectoryRequest(raw);if(corrupt)channel.port2.postMessage({...directory418Reply(q,physical),requestSha256:'f'.repeat(64)})})
    const start=performance.now();try{await assert.rejects(requestWorkbenchDirectoryApproval(actor,'approve',binding,binding.originalUi,new AbortController().signal,performance.now()+100));await closed;assert.ok(performance.now()-start<2000);assert.equal(actor.active,false);assert.throws(()=>assertSourceWorkbenchDirectoryApproval({purpose:'WORKBENCH_DIRECTORY'},actor,binding,binding.originalUi))}finally{channel.port1.close();channel.port2.close()}
  }
})


test('418：登记后Source物理port关闭先等Domain quiet关闭Owner FD，旧approval无法恢复品牌',async t=>{
  const f=await directory418Fixture(t),choice=await f.chooseLibrary(),item=f.roots.get(choice.choiceId)!,gate=deferred<void>();f.setCloseGate(gate.promise)
  f.closeSource();await tick();await tick();assert.equal(item.handle.fd>=0,true);assert.equal(f.roots.size,1)
  gate.resolve();await f.ownerClosed;assert.equal(item.handle.fd,-1);assert.equal(f.roots.size,0);assert.equal(f.actor.active,false);f.setCloseGate(undefined)
})

test('暖关闭467：实际chooser读取封口保原批准目录FD，最终关闭等待原Owner release再销毁',async t=>{
  const f=await directory418Fixture(t),choice=await f.chooseLibrary(),item=f.roots.get(choice.choiceId)!;assert.ok(item.handle.fd>=0);
  await f.chooser.closeReadResources();assert.ok(item.handle.fd>=0);assert.equal(f.bridge.pending(),1);assert.equal(f.roots.size,1);
  await assert.rejects(f.chooseLibrary(),{code:'NOT_READY'});
  const gate=deferred<void>();f.setCloseGate(gate.promise);let closed=false;const closing=f.chooser.closeApprovedDirectories().then(()=>{closed=true;});
  try{await tick();await tick();assert.equal(closed,false);assert.ok(item.handle.fd>=0);}finally{gate.resolve();}
  await closing;assert.equal(item.handle.fd,-1);assert.equal(f.roots.size,0);assert.equal(f.bridge.pending(),0);f.setCloseGate(undefined);
  t.diagnostic('实际Chooser/批准品牌/Node目录FD与专用port；Core host受控，完整Main工厂由独立Gate验证。');
});
test('暖关闭467：原Main装配先封读取而不销毁写资源，最终close才退休原代且重复封口保持同一Promise',async t=>{
  const f=await fixture(t),author=main407Author(),read=f.service.closeReadResources,full=f.service.close,events:string[]=[];let resourceCloses=0;
  t.mock.method(f.service,'closeReadResources',()=>{events.push('reads');return read.call(f.service);});
  t.mock.method(f.service,'close',()=>{events.push('service-close');return full.call(f.service);});
  const assembly=createLocalWorkbenchMainAssembly({currentAuthor:()=>author,createResources:()=>({service:f.service,names:{read:async()=>main407Settings,save:async()=>main407Settings,securityPrompt:async()=>({configured:false,cancelled:true})},async close(){resourceCloses++;await f.service.close();}})});
  await assembly.activate(author);const sealing=assembly.closeReadResources();assert.equal(assembly.closeReadResources(),sealing);await sealing;
  assert.deepEqual(events,['reads']);assert.equal(resourceCloses,0);await assert.rejects(assembly.captureAuthor(author.binding.datasetId),/真实Owner|Main|绑定/u);await assert.rejects(assembly.activate(author),/撤销/u);
  await assembly.close();assert.equal(resourceCloses,1);assert.ok(events.indexOf('service-close')>events.indexOf('reads'));
});


// 487只注册候选；此切片不运行行为。transport/Owner受控，原factory和新建FileHandle确实由被测代码join。
import { localLibraryManagementDigest } from '../../../packages/bridge-core/src/collection/local-library-workbench/owner-journal.js'
import type { LocalWorkbenchLibraryRemovalReference, LocalWorkbenchLibraryReadersFence } from '../src/main/local-library-workbench/service.js'
const readers487RootB='85555555-5555-4555-8555-555555555555'
const readers487TrackB='83333333-3333-4333-8333-333333333333',readers487AssetB='84444444-4444-4444-8444-444444444444',readers487SourceB='86666666-6666-4666-8666-666666666666'
const readers487CaptureB:dto.LocalWorkbenchCapture={albumId:'album-487-b',readToken:'read-487-b'}
function readers487Removal(commandId='remove-readers-487',libraryIds:readonly string[]=[rootId]):LocalWorkbenchLibraryRemovalReference {
  const payload={commandId,libraryIds:[...libraryIds]}
  return {datasetId,ownerEpoch:main407Epoch,...payload,originalSha256:localLibraryManagementDigest({command:'library.remove',request:payload})}
}
async function readers487File(t:test.TestContext,label:string,bytes:Uint8Array,cleanup=true){
  const directory=await directory418Path('readers487-'+label),material=path.join(directory,'original.bin');await writeFile(material,bytes)
  const handle=await open(material,'r');if(cleanup)t.after(async()=>{if(handle.fd>=0)await handle.close()})
  return {material,handle,before:Buffer.from(bytes)}
}
async function readers487SecondLibrary(f:Awaited<ReturnType<typeof fixture>>){
  const resolveOriginal=f.owner.read.resolveCapture.bind(f.owner.read),base=await resolveOriginal(fileRequest,context())
  const copy=structuredClone(base),second:LocalWorkbenchResolvedReadCapture={...copy,capture:{...copy.capture,...readers487CaptureB,rootId:readers487RootB,artistName:'乙库作者',albumName:'乙库专辑',members:copy.capture.members.map(member=>member.trackId===null?member:{...member,trackId:readers487TrackB,assetId:readers487AssetB})},group:{...copy.group,summary:{...copy.group.summary,id:readers487CaptureB.albumId,rootId:readers487RootB,title:'乙库专辑',representativeTrackId:readers487TrackB}}}
  for(const member of second.group.members){member.fact.summary.asset={...member.fact.summary.asset,id:readers487AssetB,libraryRootId:readers487RootB,sourceRootId:readers487SourceB};member.fact.summary.track={...member.fact.summary.track,id:readers487TrackB,assetId:readers487AssetB}}
  second.provenance=second.provenance.map(item=>({...item,trackId:readers487TrackB}))
  f.owner.read.resolveCapture=async(request,ctx)=>request.capture.albumId===readers487CaptureB.albumId&&request.capture.readToken===readers487CaptureB.readToken?structuredClone(second):resolveOriginal(request,ctx)
  return second
}
function readers487Fence(original:LocalWorkbenchLibraryRemovalReference,libraryId=rootId):LocalWorkbenchLibraryReadersFence{
  return {commandId:original.commandId,originalSha256:original.originalSha256,libraryId,datasetId:original.datasetId,ownerEpoch:original.ownerEpoch}
}

test('C03-Main487：原remove意图与实际binding闭集匹配，迟到HTTP producer和真实响应FD关闭前不签quiet且乙库可继续',async t=>{
  const producer=deferred<CommonsTransportResponse>(),started=deferred<void>(),destroyed=deferred<void>(),release=deferred<void>(),fd=await readers487File(t,'late-http',Buffer.from('{"results":[]}'))
  const closed=destroyed.promise.then(async()=>{await release.promise;await fd.handle.close()})
  const late:CommonsTransportResponse={statusCode:200,headers:{'content-type':'application/json','content-length':String(fd.before.length)},body:(async function*(){yield new Uint8Array(await fd.handle.readFile())})(),destroy(){destroyed.resolve()},closed}
  t.after(()=>{producer.resolve(late);release.resolve()})
  let bReads=0
  const f=await fixture(t,{transport:async url=>{if(url.searchParams.get('term')==='甲库待关闭'){started.resolve();return producer.promise}bReads++;return response(Buffer.from('{"results":[]}'),'application/json')}})
  f.serviceOptions.artworkSources={aggregate:{kind:'provider',source:'itunes'},'google-web':{kind:'web',source:'google-images'}}
  await readers487SecondLibrary(f)
  const author:LocalWorkbenchRootMainAuthor={...main407Author(),binding:Object.freeze({...main407Author().binding,datasetId})}
  const assembly=createLocalWorkbenchMainAssembly({currentAuthor:()=>author,createResources:()=>({service:f.service,names:{read:async()=>main407Settings,save:async()=>main407Settings,securityPrompt:async()=>({configured:false,cancelled:true})},close:()=>f.service.close()})})
  t.after(()=>assembly.close());await assembly.activate(author)
  const remove=readers487Removal(),input=readers487Fence(remove)
  await assert.rejects(assembly.stopLibraryReaders(input,author.binding),/匹配Main意图/u);assert.equal(f.service.inspectLibraryReaders(rootId).retired,false)
  const preparation:LocalWorkbenchMainPreparationContext={binding:author.binding,signal:new AbortController().signal,assertCurrent:async()=>author.assertCurrent(author.binding)}
  const registered=await assembly.registerLibraryRemovalIntent({family:'management',command:'library.remove',payload:{commandId:remove.commandId,libraryIds:[rootId]}},preparation)
  assert.deepEqual(registered,remove);assert.equal(f.service.inspectLibraryReaders(rootId).retired,false,'登记不预先join')
  await assert.rejects(assembly.registerLibraryRemovalIntent({family:'management',command:'library.remove',payload:{commandId:remove.commandId,libraryIds:[readers487RootB]}},preparation),/command\/body/u)
  for(const changed of [{...input,originalSha256:'a'.repeat(64)},{...input,ownerEpoch:'wrong-epoch'},{...input,datasetId:otherDataset},{...input,libraryId:readers487RootB}])await assert.rejects(assembly.stopLibraryReaders(changed,author.binding),/匹配Main意图/u)
  await assert.rejects(assembly.stopLibraryReaders({...input,extra:'不在闭集'} as LocalWorkbenchLibraryReadersFence,author.binding),/闭集/u)
  await assert.rejects(assembly.stopLibraryReaders(input,{...author.binding,authorityRef:{}}),/匹配Main意图/u)
  const work=f.ask('localWorkbench.artwork.search',{...fileRequest,sourceId:'aggregate',query:'甲库待关闭'}),cancelled=assert.rejects(work);await started.promise
  let quiet=false;const stopped=assembly.stopLibraryReaders(input,author.binding).then(()=>{quiet=true})
  t.after(async()=>{producer.resolve(late);release.resolve();await Promise.allSettled([stopped,cancelled])})
  await tick();await tick();assert.equal(quiet,false);assert.ok(fd.handle.fd>=0)
  const other={datasetId,capture:readers487CaptureB,sourceId:'aggregate',query:'乙库可继续'}
  assert.equal((await f.ask('localWorkbench.artwork.search',other)).candidates.length,0)
  producer.resolve(late);await destroyed.promise;await tick();assert.equal(quiet,false);assert.ok(fd.handle.fd>=0)
  assert.equal((await f.ask('localWorkbench.artwork.search',other)).candidates.length,0)
  release.resolve();await stopped;await cancelled;assert.equal(fd.handle.fd,-1);await assert.rejects(fd.handle.stat(),{code:'EBADF'})
  assert.equal(bReads,2);assert.equal(f.service.inspectLibraryReaders(readers487RootB).retired,false)
  assert.deepEqual(await readFile(fd.material),fd.before);await assert.rejects(f.ask('localWorkbench.artwork.search',{...fileRequest,sourceId:'aggregate',query:'甲库新读取'}))
  await assembly.stopLibraryReaders(input,author.binding)
  t.diagnostic('实际Main装配/service/provider原Promise+隔离FileHandle；HTTP与Owner端点受控，不是OwnerSQL durable running、专用port或完整Main2000ms证据。')
})

test('C03-Main487：单专辑NAME按原request取消并join迟到Response的实际FD，原工厂随后仍接受乙请求',async t=>{
  const producer=deferred<Response>(),started=deferred<void>(),bodyCancelled=deferred<void>(),release=deferred<void>(),fd=await readers487File(t,'late-name',Buffer.from('原NAME响应材料'))
  let calls=0
  const names=createLocalNameTransport({getConfiguration:()=>({baseUrl:'http://127.0.0.1:8000',model:'合成模型'}),fetch:async()=>{calls++;if(calls===1){started.resolve();return producer.promise}return new Response('data: {"choices":[{"delta":{"content":"乙请求可继续"}}]}\n\ndata: [DONE]\n',{headers:{'content-type':'text/event-stream'}})}})
  const late=new Response(new ReadableStream<Uint8Array>({async cancel(){bodyCancelled.resolve();await release.promise;await fd.handle.close()}}),{headers:{'content-type':'text/event-stream'}})
  t.after(()=>{producer.resolve(late);release.resolve()})
  const f=await fixture(t);f.serviceOptions.names=names;await readers487SecondLibrary(f)
  const work=f.ask('localWorkbench.ai.suggest',{...fileRequest,backend:'vllm'}),cancelled=assert.rejects(work);await started.promise
  const remove=readers487Removal('remove-name-487');let quiet=false;const originalStop=f.service.stopLibraryReaders(remove,rootId),stopped=originalStop.then(()=>{quiet=true})
  assert.equal(f.service.stopLibraryReaders(remove,rootId),originalStop)
  t.after(async()=>{producer.resolve(late);release.resolve();await Promise.allSettled([stopped,cancelled])})
  await tick();assert.equal(quiet,false);assert.ok(fd.handle.fd>=0)
  producer.resolve(late);await bodyCancelled.promise;await tick();assert.equal(quiet,false);assert.ok(fd.handle.fd>=0)
  release.resolve();await stopped;await cancelled;assert.equal(fd.handle.fd,-1);assert.equal(f.preparations.size,0)
  const next=names.suggest({backend:'vllm',systemPrompt:'乙原请求',userPrompt:'乙原请求'},new AbortController().signal)
  assert.equal((await next).content,'乙请求可继续');await names.join(next);assert.equal(calls,2)
  assert.deepEqual(await readFile(fd.material),fd.before);assert.equal(f.service.inspectLibraryReaders(readers487RootB).retired,false)
  t.diagnostic('受控fetch producer，实际NAME品牌工厂/Response.cancel/FileHandle；乙原工厂请求保持可用，不声称SQL或真实模型运行。')
})

async function readers487Navigation(t:test.TestContext,external:boolean){
  const started=deferred<void>(),release=deferred<void>(),fd=await readers487File(t,external?'external-navigation':'internal-navigation',Buffer.from('原导航启动材料'))
  let bStarts=0
  const port=async(url:URL,context:{signal:AbortSignal})=>{
    assert.ok(['甲导航 封面','乙导航 封面'].includes(url.searchParams.get('q') ?? ''),'原导航URL必须使用真实工厂的封面查询')
    if(url.searchParams.get('q')==='甲导航 封面'){
      const originalClosed=deferred<void>()
      if(!external)registerLocalArtworkNavigationPhysical(context.signal,{closed:originalClosed.promise,abort(){}})
      started.resolve();await release.promise;await fd.handle.close();originalClosed.resolve()
    }else{bStarts++;if(!external)registerLocalArtworkNavigationPhysical(context.signal,{closed:Promise.resolve(),abort(){}})}
  }
  t.after(()=>release.resolve())
  let portAccepting=true;t.after(()=>{portAccepting=false})
  const navigation=createLocalArtworkWebNavigation({readPortAvailability:(_mode,signal)=>portAccepting&&!signal.aborted,navigate:port,openExternal:port}),f=await fixture(t,{navigation});await readers487SecondLibrary(f)
  const work=f.service.navigateWebSource({...fileRequest,sourceId:'google-web',query:'甲导航',external},context()),cancelled=assert.rejects(work);await started.promise
  const remove=readers487Removal(external?'remove-external-487':'remove-internal-487');let quiet=false;const stopped=f.service.stopLibraryReaders(remove,rootId).then(()=>{quiet=true})
  t.after(async()=>{release.resolve();await Promise.allSettled([stopped,cancelled])})
  await tick();await tick();assert.equal(quiet,false);assert.ok(fd.handle.fd>=0)
  assert.deepEqual(await f.service.navigateWebSource({datasetId,capture:readers487CaptureB,sourceId:'google-web',query:'乙导航',external},context()),{opened:true})
  assert.equal(bStarts,1);assert.equal(quiet,false);release.resolve();await stopped;await cancelled;assert.equal(fd.handle.fd,-1)
  assert.deepEqual(await readFile(fd.material),fd.before);assert.equal(f.service.inspectLibraryReaders(readers487RootB).retired,false)
  t.diagnostic('只证明实际导航工厂等待原自有启动Promise/隔离FD；不关闭或证明用户外部浏览器，不声称真实Electron页面退出。')
}
test('C03-Main487：应用内导航等原producer启动Promise物理收尾，abortable包装不冒quiet且乙库可继续',async t=>readers487Navigation(t,false))
test('C03-Main487：显式外部打开仅join自有启动Promise，不关闭用户浏览器或乙库',async t=>readers487Navigation(t,true))

test('C03-Main487：冷私有图按原冻结capture/root关联并等待真实FD回读收尾，清库不删除不可变原计划与字节',async t=>{
  const f=await fixture(t),image=await f.ask('localWorkbench.artwork.local',fileRequest),plan=await f.ask('localWorkbench.artwork.preview',{...fileRequest,candidateId:image[0]!.candidateId})
  const query={datasetId,planId:plan.planId,candidateId:image[0]!.candidateId},frozen=f.registry.readArtworkCapture(query);assert.ok(frozen)
  const fd=await readers487File(t,'cold-private',Buffer.from(JSON.stringify(frozen))),started=deferred<void>(),release=deferred<void>()
  let reads=0
  t.after(()=>release.resolve())
  const cold=createLocalWorkbenchService({...f.serviceOptions,owner:{...f.owner,registry:{...f.owner.registry,async readArtworkCapture(actual){reads++;assert.deepEqual(actual,query);started.resolve();await release.promise;const bytes=await fd.handle.readFile();await fd.handle.close();return JSON.parse(bytes.toString('utf8')) as typeof frozen}}}})
  t.after(()=>cold.close())
  const work=cold.readPrivateArtwork(query),cancelled=assert.rejects(work);await started.promise
  const remove=readers487Removal('remove-private-487');let quiet=false;const stopped=cold.stopLibraryReaders(remove,rootId).then(()=>{quiet=true})
  t.after(async()=>{release.resolve();await Promise.allSettled([stopped,cancelled])})
  await tick();assert.equal(quiet,false);assert.ok(fd.handle.fd>=0)
  release.resolve();await stopped;await cancelled;assert.equal(fd.handle.fd,-1);assert.equal(reads,1)
  assert.deepEqual(f.registry.readArtworkCapture(query),frozen);assert.deepEqual(await readFile(fd.material),fd.before)
  assert.equal(f.network.length,0);assert.equal(f.events.filter(value=>value.startsWith('应用:')).length,0)
  t.diagnostic('实际原registry+service读取新建FD；持久载荷端点受控，未证明真实Owner SQL或SourceWrites读取许可。')
})

test('C03-Main487：实际响应FD.close故障保原producer UNKNOWN，join/cancel/close重复拒收且材料不删',async t=>{
  const fd=await readers487File(t,'fd-close-fault',Buffer.from('{"results":[]}'),false),destroyed=deferred<void>(),nativeClose=fd.handle.close.bind(fd.handle)
  const fault=t.mock.method(fd.handle,'close',async()=>{throw Error('487隔离原FileHandle.close故障')})
  t.after(async()=>{fault.mock.restore();if(fd.handle.fd>=0)await nativeClose()})
  const closed=destroyed.promise.then(async()=>{await fd.handle.close()});void closed.catch(()=>{})
  const provider=createLocalArtworkProviders({transport:async()=>({statusCode:200,headers:{'content-type':'application/json','content-length':String(fd.before.length)},body:(async function*(){yield new Uint8Array(await fd.handle.readFile())})(),destroy(){destroyed.resolve()},closed}),normalize:bytes=>normalizeLocalArtwork(bytes,()=>decoder())})
  const work=provider.search({query:'甲原请求',source:'itunes'},new AbortController().signal)
  provider.associateOriginal(work,{datasetId,libraryId:rootId});await work
  await assert.rejects(provider.join(work));await assert.rejects(provider.cancelOriginal(work));await assert.rejects(provider.join(Promise.resolve(await work)))
  const closure=provider.close();assert.equal(provider.close(),closure);await assert.rejects(closure);assert.ok(fd.handle.fd>=0);await fd.handle.stat()
  assert.throws(()=>provider.retireLibrary({datasetId,libraryId:rootId}));assert.deepEqual(await readFile(fd.material),fd.before)
  t.diagnostic('隔离实际FileHandle在close接点注入故障，factory真实join；不是完整软件、真实HTTP或Native物理证书。')
})

test('C03-Main487：原私有capture缺失时即使逻辑Map已空仍保UNKNOWN，不猜currenttrack且同原stop不翻绿',async t=>{
  const f=await fixture(t),events=[...f.events]
  await assert.rejects(f.service.readPrivateArtwork({datasetId,candidateId:'missing-original-capture-487'}))
  assert.equal(f.service.inspect().privateArtworkReads,0);assert.equal(f.service.inspect().reads,0)
  const remove=readers487Removal('remove-unknown-487'),original=f.service.stopLibraryReaders(remove,rootId)
  await assert.rejects(original,/归属未知|空Map/u);assert.equal(f.service.stopLibraryReaders(remove,rootId),original);await assert.rejects(f.service.stopLibraryReaders(remove,rootId))
  assert.equal(f.service.inspectLibraryReaders(rootId).unknown,true);assert.deepEqual(f.events,events);assert.equal(f.network.length,0)
  assert.equal(f.service.inspectLibraryReaders(readers487RootB).retired,false)
  t.diagnostic('缺原捕获是正式C03开放项；此负例只证明拒收，不代替缺失关联或完整按库退出实现。')
})

test('C03-Main487：只清原库无引用候选，保乙库副本及原冻结计划引用，并按原operation清独占provider缓存',async t=>{
  const f=await fixture(t);await readers487SecondLibrary(f)
  const selectedA=(await f.ask('localWorkbench.artwork.local',fileRequest))[0]!
  const plan=await f.ask('localWorkbench.artwork.preview',{...fileRequest,candidateId:selectedA.candidateId})
  const unreferenced=(await f.ask('localWorkbench.artwork.import',inputRequest())).candidateId
  const selectedB=(await f.ask('localWorkbench.artwork.local',{datasetId,capture:readers487CaptureB}))[0]!
  const originalPlan=f.registry.getPlan(plan.planId),originalFrozen=f.registry.readArtworkCapture({datasetId,planId:plan.planId,candidateId:selectedA.candidateId})
  assert.equal(f.service.inspect().artworkCandidates,3)
  await f.service.stopLibraryReaders(readers487Removal('remove-cache-487'),rootId)
  assert.equal(f.service.inspect().artworkCandidates,2);assert.deepEqual(f.registry.getPlan(plan.planId),originalPlan);assert.deepEqual(f.registry.readArtworkCapture({datasetId,planId:plan.planId,candidateId:selectedA.candidateId}),originalFrozen)
  assert.equal((await f.service.readPrivateArtwork({datasetId,candidateId:selectedB.candidateId})).capture.albumId,readers487CaptureB.albumId)
  await assert.rejects(f.service.readPrivateArtwork({datasetId,candidateId:unreferenced}))
  // 独立原factory证明cache选择性：甲独占可清；乙与未关联Legacy引用不推定无ref。
  const provider=createLocalArtworkProviders({transport:async()=>response(jpeg(),'image/jpeg'),normalize:bytes=>normalizeLocalArtwork(bytes,()=>decoder())});t.after(()=>provider.close())
  const a=provider.importRemoteSource({url:'https://example.org/a.jpg'},new AbortController().signal);provider.associateOriginal(a,{datasetId,libraryId:rootId});const aImage=await a;await provider.join(a)
  const b=provider.importRemoteSource({url:'https://example.org/b.jpg'},new AbortController().signal);provider.associateOriginal(b,{datasetId,libraryId:readers487RootB});const bImage=await b;await provider.join(b)
  const legacy=provider.readCandidate(bImage.candidateId,new AbortController().signal);await legacy;await provider.join(legacy)
  provider.retireLibrary({datasetId,libraryId:rootId});const removed=provider.readCandidate(aImage.candidateId,new AbortController().signal);await assert.rejects(removed);await provider.join(removed)
  const kept=provider.readCandidate(bImage.candidateId,new AbortController().signal);assert.ok((await kept).bytes.length>0);await provider.join(kept)
  t.diagnostic('实际service/registry/provider选择性缓存；Owner持久化仍受控，未执行真实文件删除、生产DB或完整C03清理。')
})

test('C03-Main487：内部原producer成功但没有同signal自有closed登记仍是UNKNOWN，克隆Promise和空Map不授quiet',async()=>{
  assert.throws(()=>registerLocalArtworkNavigationPhysical(new AbortController().signal,{closed:Promise.resolve(),abort(){}}))
  const navigation=createLocalArtworkWebNavigation({async navigate(){}})
  const original=navigation.navigate({source:'google-images',query:'无物理登记'},new AbortController().signal)
  assert.deepEqual(await original,{opened:true})
  await assert.rejects(navigation.join(original));await assert.rejects(navigation.cancelOriginal(original))
  await assert.rejects(navigation.join(Promise.resolve({opened:true})))
  const closure=navigation.close();assert.equal(navigation.close(),closure);await assert.rejects(closure)
  await assert.rejects(navigation.join(original))
})

// 真实Main service/Provider归一化链，网页port及网络仍为受控夹具，不称Electron拖图或真实站点。
test('网页拖图Main：原引用导入和失败地址备用均回原capture，只生成候选并阻止重放', async t => {
  const requests: string[] = []
  let captureId = '', captured: { url: string; ageMs: number } | null = { url: 'https://images.example.com/original.jpg', ageMs: 100 }
  const closed = deferred<void>()
  let portAccepting=true;t.after(()=>{portAccepting=false})
  const navigation=createLocalArtworkWebNavigation({readPortAvailability:(_mode,signal)=>portAccepting&&!signal.aborted,navigate(_url, ctx) { captureId = ctx.captureId; registerLocalArtworkNavigationPhysical(ctx.signal, { closed: closed.promise, abort: () => closed.resolve(), async readCapturedImage(ref: string) { assert.ok(ref.startsWith(captureId + '.')); return captured } }) } })
  const f = await fixture(t, {navigation, transport: async url => { requests.push(url.pathname); return response(url.pathname === '/page' ? Buffer.from('<html>受控非图片页面</html>') : jpeg(), url.pathname === '/page' ? 'text/html' : 'image/jpeg') } })
  await f.ask('localWorkbench.artwork.search', { ...fileRequest, sourceId: 'google-web', query: '原专辑封面' })
  const first = await f.ask('localWorkbench.artwork.import', { ...fileRequest, webCaptureId: captureId + '.1', label: '原网页拖图' })
  assert.equal(first.albumId, reference.albumId); assert.deepEqual(requests, ['/original.jpg']); assert.equal(f.events.some(event => event.startsWith('应用:')), false)
  await assert.rejects(f.ask('localWorkbench.artwork.import', { ...fileRequest, webCaptureId: captureId + '.1', label: '旧拖图重放' }))
  captured = { url: 'https://images.example.com/fallback.jpg', ageMs: 30000 }
  const second = await f.ask('localWorkbench.artwork.import', { ...fileRequest, text: 'https://images.example.com/page', webCaptureId: captureId + '.2', label: '失败地址的原备用图' })
  assert.notEqual(second.candidateId, first.candidateId); assert.deepEqual(requests, ['/original.jpg', '/page', '/fallback.jpg'])
  captured = { url: 'https://images.example.com/expired.jpg', ageMs: 30001 }
  await assert.rejects(f.ask('localWorkbench.artwork.import', { ...fileRequest, webCaptureId: captureId + '.3', label: '过期拖图' }))
  assert.deepEqual(requests, ['/original.jpg', '/page', '/fallback.jpg']); assert.equal(f.events.some(event => event.startsWith('应用:')), false)
})

test('网页拖图Main：原捕获变化和下载失败保留已选原候选，不借新窗口或执行writer', async t => {
  let reads = 0
  const closed = deferred<void>(); let captureId = ''
  let portAccepting=true;t.after(()=>{portAccepting=false})
  const navigation=createLocalArtworkWebNavigation({readPortAvailability:(_mode,signal)=>portAccepting&&!signal.aborted,navigate(_url, ctx) { captureId = ctx.captureId; registerLocalArtworkNavigationPhysical(ctx.signal, { closed: closed.promise, abort: () => closed.resolve(), async readCapturedImage() { reads++; return { url: 'https://images.example.com/failing.jpg', ageMs: 0 } } }) } })
  const f = await fixture(t, {navigation, transport: async () => response(Buffer.from('受控非图片'), 'text/plain') })
  const prior = await f.ask('localWorkbench.artwork.import', inputRequest()), plan = await f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: prior.candidateId })
  await f.ask('localWorkbench.artwork.search', { ...fileRequest, sourceId: 'google-web', query: '原专辑封面' })
  await assert.rejects(f.ask('localWorkbench.artwork.import', { ...fileRequest, webCaptureId: captureId + '.1', label: '下载失败的原图' }))
  assert.equal(reads, 1); const retained = await f.ask('localWorkbench.artwork.preview', { ...fileRequest, candidateId: prior.candidateId }); assert.equal(retained.kind, 'artwork'); assert.deepEqual(retained.albumIds, plan.albumIds)
  f.setRevision('album-changed')
  await assert.rejects(f.ask('localWorkbench.artwork.import', { ...fileRequest, webCaptureId: captureId + '.2', label: '旧捕获拖图' }))
  assert.equal(reads, 1); assert.equal(f.events.some(event => event.startsWith('应用:')), false)
})

// 执行index原hook生成的隔离脚本；浏览器document事件为受控VM，不替代Electron物理拖放。
test('原网页拖图hook：刷新document后的序号不复用，旧拖图不能读取新页面图片且仅可信drag记录', async () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('      const dragWorld = 1001, dragSlot'), end = source.indexOf("      context.signal.addEventListener('abort', cancel", start)
  assert.ok(start > 0 && end > start)
  const handlers = new Map<string, () => void>(), captureId = '35bb416a-7501-458a-b054-17ce2b32ffac'
  let events: ((event: unknown) => void)[] = [], frame = createContext({})
  class Image { constructor(readonly src: string) {} get currentSrc() { return this.src } }
  const newDocument = () => { events = []; frame = createContext({ HTMLImageElement: Image, performance: { now: () => 1000 }, document: { addEventListener(_name: string, handler: (event: unknown) => void) { events.push(handler) } } }) }
  const window = { webContents: { on(name: string, handler: () => void) { handlers.set(name, handler) }, executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) { return Promise.resolve(runInContext(scripts[0]!.code, frame)) } } }
  const lowered = ts.transpileModule('(function(window,context,cancel){' + source.slice(start, end) + '; return () => dragCaptureReady;})', { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  const install = new Function('return ' + lowered.outputText)() as (window: object, context: object, cancel: () => void) => () => Promise<unknown>
  const ready = install(window, { captureId }, () => { throw new Error('原hook不应安装失败') })
  const drag = (url: string, isTrusted = true) => { let ref = ''; for (const handle of events) handle({ isTrusted, dataTransfer: { setData(_kind: string, value: string) { ref = value } }, composedPath: () => [new Image(url)] }); return ref }
  newDocument(); handlers.get('dom-ready')!(); await ready()
  assert.equal(drag('https://images.example.com/untrusted.jpg', false), '')
  const old = drag('https://images.example.com/old.jpg'); assert.equal(old, captureId + '.1')
  newDocument(); handlers.get('dom-ready')!(); await ready()
  const current = drag('https://images.example.com/current.jpg'); assert.equal(current, captureId + '.1025')
  assert.equal(runInContext(`globalThis.__musicbridgeTakeArtworkDrag(${JSON.stringify(old)})`, frame), null)
  const image = runInContext(`globalThis.__musicbridgeTakeArtworkDrag(${JSON.stringify(current)})`, frame) as { url: string; ageMs: number }
  assert.equal(image.url, 'https://images.example.com/current.jpg'); assert.equal(image.ageMs, 0)
  assert.equal(runInContext(`globalThis.__musicbridgeTakeArtworkDrag(${JSON.stringify(current)})`, frame), null)
  const next = drag('https://images.example.com/next.jpg'); assert.equal(next, captureId + '.1026')
})


import { datasetWorkbenchJson as directoryOwnerBodyJson, datasetWorkbenchSha as directoryOwnerBodySha } from '../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'

// 沿418真实Main/Source端口与目录FD夹具；Owner request为受控格式探针，不证明完整SQL导入或Electron/Main资格。
async function directoryOwnerCanonicalFixture(t: test.TestContext) {
  const f = await directory418Fixture(t), originalAuthor = f.author
  type Confirm = Extract<LocalWorkbenchRootMainRequest, { family: 'management'; command: 'library.import.confirm' }>
  const accepted: LocalWorkbenchRootMainRequest[] = [], ownerCalls: Confirm[] = []
  const approvals: { ui: SourceWorkbenchDirectoryUi; physical: Readonly<SourceWorkbenchDirectoryPhysical> }[] = []
  const author: LocalWorkbenchRootMainAuthor = { ...originalAuthor, async request(body, context) {
    assert.equal(f.author, author); assert.deepEqual(context.binding, originalAuthor.binding)
    await originalAuthor.assertCurrent(context.binding)
    if (body.family !== 'management' || body.command !== 'library.import.confirm') throw Error('此Owner格式探针只允许原confirm')
    const item = f.roots.get(body.payload.choiceId); assert.ok(item)
    ownerCalls.push(structuredClone(body))
    const ui = captureSourceWorkbenchDirectoryUi({ family: body.family, command: body.command, commandId: body.payload.commandId,
      requestSha256: directoryOwnerBodySha(directoryOwnerBodyJson({ command: body.command, payload: body.payload })) })
    const proof = await requestWorkbenchDirectoryApproval(f.actor, 'revalidate', item.binding, ui, context.signal, context.deadlineAtMs)
    const physical = assertSourceWorkbenchDirectoryApproval(proof, f.actor, item.binding, ui)
    assert.deepEqual(physical, item.physical); assert.equal((await item.handle.stat({ bigint: true })).ino.toString(), physical.ino)
    approvals.push({ ui, physical })
    // 只返回合法running合同，不能以目录批准冒充真实库注册/scan或succeeded。
    return { commandId: body.payload.commandId, kind: body.command, state: 'running', libraryIds: [], message: null }
  } }
  f.setAuthor(author)
  const boundary = createLocalWorkbenchManagementBoundary({ assertTrusted() {}, isAccepting: () => f.supervisor.status === 'ready', currentAuthor: () => f.author,
    acceptDirectoryRequest: (body, context) => { accepted.push(structuredClone(body)); return f.bridge.enter(body, context) } })
  t.after(() => boundary.close())
  return { f, author, boundary, accepted, ownerCalls, approvals,
    confirm: (payload: dto.LocalLibraryManagementPayloads['library.import.confirm']) => boundary.management({}, { datasetId: main407Dataset, command: 'library.import.confirm', payload }) }
}

test('目录原正文：真实MainBoundary受理hook与MainDirectoryBridge批准Owner格式confirm，同command改正文role或choice均拒绝', async t => {
  const h = await directoryOwnerCanonicalFixture(t), choice = await h.f.chooseLibrary(), item = h.f.roots.get(choice.choiceId)!
  const payload: dto.LocalLibraryManagementPayloads['library.import.confirm'] = { commandId: randomUUID(), choiceId: choice.choiceId, role: 'album' }, original = structuredClone(payload)
  const pending = h.confirm(payload); payload.role = 'container'
  const result = await pending
  assert.deepEqual(result, { commandId: original.commandId, kind: 'library.import.confirm', state: 'running', libraryIds: [], message: null })
  assert.equal(h.accepted.length, 1); assert.deepEqual(h.accepted[0], { family: 'management', command: 'library.import.confirm', payload: original })
  assert.equal(h.ownerCalls.length, 1); assert.deepEqual(h.ownerCalls[0]!.payload, original); assert.equal(h.approvals.length, 1)
  const ui = h.approvals[0]!.ui, q = h.f.requests.at(-1)!
  assert.equal(q.command, 'revalidate'); assert.deepEqual(q.ui, ui); assert.deepEqual(q.binding, item.binding)
  assert.equal(ui.family, 'management'); assert.equal(ui.command, 'library.import.confirm'); assert.equal(ui.commandId, original.commandId)
  assert.equal(ui.requestSha256, directoryOwnerBodySha(directoryOwnerBodyJson({ command: 'library.import.confirm', payload: original })))
  assert.notEqual(ui.requestSha256, lyricsPhysicalDigest({ family: 'management', command: 'library.import.confirm', payload: original }), '不能由两端人工同含family哈希绕过Owner格式')
  assert.equal(item.handle.fd >= 0, true); assert.deepEqual(h.approvals[0]!.physical, item.physical)
  await assert.rejects(h.confirm({ ...original, role: 'container' }), /NOT_READY/u)
  const other = await h.f.chooseLibrary(); assert.notEqual(other.choiceId, choice.choiceId)
  await assert.rejects(h.confirm({ ...original, choiceId: other.choiceId }), /NOT_READY/u)
  await assert.rejects(h.boundary.management({}, { datasetId: main407Dataset, command: 'library.import.confirm', payload: { ...original, extra: true } }), /INVALID_IPC_REQUEST/u)
  await assert.rejects(h.boundary.nameSettings({}, { datasetId: main407Dataset, command: 'library.import.confirm', payload: original }), /INVALID_IPC_REQUEST/u)
  assert.throws(() => captureSourceWorkbenchDirectoryUi({ ...ui, family: 'workbench' }), /GRANT_MISMATCH/u)
  await assert.rejects(h.f.bridge.enter({ family: 'workbench', command: 'library.import.confirm', payload: original } as unknown as LocalWorkbenchRootMainRequest, main407Context(h.author)), /GRANT_MISMATCH/u)
  assert.throws(() => captureSourceWorkbenchDirectoryRequest({ ...q, ui: { ...ui, command: 'library.cue.start' } }), /GRANT_MISMATCH/u)
  assert.equal(h.ownerCalls.length, 1); assert.equal(h.approvals.length, 1, '坏正文/choice/family不得到达Owner或获得第二批准')
  await h.confirm(original); assert.equal(h.ownerCalls.length, 2); assert.equal(h.approvals.length, 2, '原合法正文仍可在原2000ms重新物理回核，不由坏正文撤销它')
})

test('目录原正文：Owner格式一致不绕响应期限或原作者窗口，namespace替换后仍拒绝并关闭原实际FD', async t => {
  const h = await directoryOwnerCanonicalFixture(t), choice = await h.f.chooseLibrary(), item = h.f.roots.get(choice.choiceId)!
  const payload: dto.LocalLibraryManagementPayloads['library.import.confirm'] = { commandId: randomUUID(), choiceId: choice.choiceId, role: 'catalog' }
  await h.confirm(payload); const q = h.f.requests.at(-1)!, ui = h.approvals[0]!.ui
  const expired = captureSourceWorkbenchDirectoryRequest({ ...q, requestId: randomUUID(), sequence: q.sequence + 1, expiresAtMs: Date.now() - 1 })
  await assert.rejects(h.f.bridge.produce(expired, { signal: new AbortController().signal, deadlineAtMs: performance.now() + 2000 }), /响应资格/u)
  const late = await h.f.bridge.produce(q, { signal: new AbortController().signal, deadlineAtMs: performance.now() - 1 })
  assert.equal(late.decision, 'rejected'); assert.equal(late.nonce, null); assert.equal(late.physical, null)
  const aborted = new AbortController(); aborted.abort()
  const cancelled = await h.f.bridge.produce(q, { signal: aborted.signal, deadlineAtMs: performance.now() + 2000 })
  assert.equal(cancelled.decision, 'rejected'); assert.equal(cancelled.physical, null)
  h.f.setAuthor({ ...h.author, binding: { ...h.author.binding, childGeneration: 2, authorityRef: {} } })
  try { await assert.rejects(requestWorkbenchDirectoryApproval(h.f.actor, 'revalidate', item.binding, ui, new AbortController().signal), /Main拒绝/u) }
  finally { h.f.setAuthor(h.author) }
  assert.equal(h.approvals.length, 1); assert.equal(item.handle.fd >= 0, true)
  await rename(h.f.library, path.join(h.f.directory, '原目录已移动')); await mkdir(h.f.library)
  assert.notEqual((await lstat(h.f.library, { bigint: true })).ino, (await item.handle.stat({ bigint: true })).ino)
  await assert.rejects(h.confirm(payload), /NOT_READY/u)
  assert.equal(h.ownerCalls.length, 1); assert.equal(h.approvals.length, 1, '同hash不能越过实际Main目录namespace/FD检查')
  await h.boundary.close(); await h.f.bridge.close(); await h.f.chooser.closeReadResources()
  assert.equal(item.handle.fd, -1); await assert.rejects(item.handle.stat(), error => (error as NodeJS.ErrnoException).code === 'EBADF')
  assert.equal(h.f.roots.size, 0); assert.equal(h.f.bridge.pending(), 0); assert.ok(h.f.events.includes('owner-fd-close:library'))
})


// 原Owner RPC/decoder 为受控组件；只验证Main能力合成，真实Native由Root原Main链执行。
import { createLocalWorkbenchTransportOwner as capabilityTransportOwner } from '../src/main/local-library-workbench/service.js'
import { isDatasetWorkbenchOwnerResult } from '../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
function capabilityOwner(base:dto.LocalWorkbenchCapabilitiesReply):LocalWorkbenchOwnerPorts {
  const original=main407Author(),binding=Object.freeze({...original.binding,datasetId})
  const author:LocalWorkbenchRootMainAuthor={...original,binding,async requestOwner<C extends import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerCommand>(command:C,_payload:import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerPayloads[C],context:Parameters<LocalWorkbenchRootMainAuthor['requestOwner']>[2]):Promise<import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerResults[C]>{
    assert.equal(context.binding,binding);assert.equal(context.binding.authorityRef,binding.authorityRef);assert.equal(context.signal.aborted,false)
    assert.equal(command,'capabilities.read');return structuredClone(base) as import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerResults[C]
  }}
  return capabilityTransportOwner(author)
}
function capabilityCoreReply():dto.LocalWorkbenchCapabilitiesReply {
  const capabilities:dto.LocalWorkbenchCapabilitiesReply['capabilities']={}
  for(const key of dto.LOCAL_WORKBENCH_CAPABILITIES)capabilities[key]={available:false,reason:'组件Owner未授此能力。'}
  for(const key of ['read','artwork-local','artwork-preview','ai-preview'] as const)capabilities[key]={available:true}
  return {capabilities,artworkSources:[],artworkImportFormats:[],aiBackends:[],cueFormats:[{id:'flac',label:'未取得Native资格的组件FLAC',availability:{available:false,reason:'未运行Native资格。'}}],existingActions:{finder:{available:false,reason:'尚无实际Main路由。'}}}
}
async function capabilityService(t:import('node:test').TestContext,base:dto.LocalWorkbenchCapabilitiesReply,options:{decode?:LocalWorkbenchServiceOptions['decode'];names?:LocalWorkbenchServiceOptions['names'];owner?:LocalWorkbenchOwnerPorts}={}) {
  const f=await fixture(t),service=createLocalWorkbenchService({...f.serviceOptions,owner:options.owner??capabilityOwner(base),decode:options.decode??f.serviceOptions.decode,names:options.names??f.serviceOptions.names})
  t.after(()=>service.close());return {f,service,async read(ctx=context()){const value=await service.request({command:'localWorkbench.capabilities',payload:{}},ctx);assert.ok(dto.isLocalWorkbenchCapabilitiesReply(value));return value}}
}

test('Main能力合成：原Owner未接Main的drop与格式由完整解码回读补足，Native/CUE/writer不授假绿',async t=>{
  const base=capabilityCoreReply(),before=structuredClone(base),h=await capabilityService(t,base),result=await h.read()
  assert.equal(result.capabilities['artwork-drop']?.available,true)
  assert.deepEqual(result.artworkImportFormats.map(format=>format.mime),['image/jpeg','image/png','image/tiff','image/webp'])
  assert.equal(result.artworkImportFormats.find(format=>format.mime==='image/jpeg')?.availability.available,true)
  assert.equal(result.artworkImportFormats.find(format=>format.mime==='image/png')?.availability.available,true)
  for(const key of ['read','artwork-local','artwork-preview','cue-preview','apply','receipt','cancel-application','existing-actions'] as const)assert.deepEqual(result.capabilities[key],before.capabilities[key])
  assert.equal(result.capabilities['artwork-file']?.available,false,'组件未提供原Native host状态，不能补文件选择资格')
  assert.deepEqual(result.cueFormats,before.cueFormats);assert.deepEqual(result.existingActions,before.existingActions);assert.equal(result.capabilities['artwork-search']?.available,true);assert.deepEqual(result.artworkSources.map(source=>({id:source.id,kind:source.kind,available:source.availability.available})),[{id:'aggregate',kind:'aggregate',available:true},{id:'google-web',kind:'web',available:true}])
  assert.deepEqual(base,before);assert.equal(h.f.network.length,0);assert.equal(h.f.nameRequests.length,0)
})

test('Main能力合成：decode函数存在但空图/异常/不完整展示回读均不取得drop资格',async t=>{
  for(const decode of [()=>({...decoder(),isEmpty:()=>true}),()=>{throw Error('自有组件decoder不可用')},()=>({...decoder(),toJPEG:()=>Buffer.from([255,216,255,217])})]){
    const base=capabilityCoreReply(),h=await capabilityService(t,base,{decode}),result=await h.read()
    assert.equal(result.capabilities['artwork-drop']?.available,false);assert.ok(result.artworkImportFormats.every(format=>!format.availability.available))
    assert.deepEqual(result.capabilities.apply,base.capabilities.apply);assert.deepEqual(result.capabilities['cue-preview'],base.capabilities['cue-preview']);assert.deepEqual(result.cueFormats,base.cueFormats)
    await h.service.close()
  }
})

test('Main能力合成：实际names配置动态更新backend可调用状态，零HTTP且不回显端点/凭据',async t=>{
  const configured=new Set<dto.LocalAiBackend>(['ollama']);let fetches=0,badConfiguration=false
  const names=createLocalNameTransport({getConfiguration:backend=>configured.has(backend)?{baseUrl:badConfiguration?'invalid://configuration':backend==='cloud'?'https://self-owned-synthetic.invalid/v1':'http://127.0.0.1:11434',model:'组件配置模型'}:null,resolveSecret:()=> 'synthetic-only-private-secret',fetch:async()=>{fetches++;throw Error('能力读取不能调用真实Provider')}})
  const h=await capabilityService(t,capabilityCoreReply(),{names}),first=await h.read()
  assert.deepEqual(first.aiBackends.filter(backend=>backend.availability.available).map(backend=>backend.id),['ollama'])
  configured.clear();configured.add('vllm');const second=await h.read();assert.deepEqual(second.aiBackends.filter(backend=>backend.availability.available).map(backend=>backend.id),['vllm'])
  badConfiguration=true;const invalidConfiguration=await h.read();assert.ok(invalidConfiguration.aiBackends.every(backend=>!backend.availability.available));assert.equal(invalidConfiguration.capabilities['artwork-drop']?.available,true);badConfiguration=false;
  configured.clear();const third=await h.read();assert.equal(third.capabilities['ai-preview']?.available,false);assert.ok(third.aiBackends.every(backend=>!backend.availability.available));assert.equal(fetches,0)
  const publicText=JSON.stringify([first,second,third]);assert.equal(publicText.includes('synthetic-only-private-secret'),false);assert.equal(publicText.includes('127.0.0.1'),false);assert.equal(publicText.includes('组件配置模型'),false)
})

test('Main能力合成：克隆Owner不能恢复Main装配，配置等待时取消/换代拒绝迟到能力',async t=>{
  const base=capabilityCoreReply(),original=capabilityOwner(base);let calls=0
  const clone={...original},cloned=await capabilityService(t,base,{owner:clone,decode:()=>{calls++;return decoder()}})
  assert.deepEqual(await cloned.read(),base);assert.equal(calls,0)
  const gate=deferred<null>(),entered=deferred<void>(),controller=new AbortController();let current=true
  const names=createLocalNameTransport({getConfiguration:async()=>{entered.resolve();return gate.promise},fetch:async()=>{throw Error('配置观察不能HTTP')}})
  const h=await capabilityService(t,base,{names}),ctx={...context(),signal:controller.signal,assertCurrent:async()=>{if(!current)throw Error('原Main作者已换代')}}
  const pending=h.read(ctx),rejected=assert.rejects(pending)
  try{await entered.promise;current=false;controller.abort();gate.resolve(null);await rejected}finally{gate.resolve(null);await h.service.close()}
})

// 以下只验证原Main能力合成与资源状态消费；Owner RPC及图片/host正文为自有受控组件。
// 不把此夹具当作实际Main、AppKit、公网Provider或Native资格。
async function resourceAvailabilityService(t:import('node:test').TestContext,options:{uninstalled?:boolean;cloneOwner?:boolean;providerAvailability?:(signal:AbortSignal)=>boolean|Promise<boolean>;webAvailability?:(mode:'navigate'|'refresh'|'openExternal',signal:AbortSignal)=>boolean|Promise<boolean>}={}){
  const f=await fixture(t),base=capabilityCoreReply(),state={provider:true,providerAnswers:[] as boolean[],providerCalls:0,navigate:true,external:true,hostCreated:true,hostClosed:false,hostPending:false,artwork:true,cue:true,current:true,requests:0,transportCalls:0}
  const original=main407Author(),binding=Object.freeze({...original.binding,datasetId})
  const guard=async()=>{if(!state.current)throw Error('本组件原Main作者已撤销')}
  const author:LocalWorkbenchRootMainAuthor={...original,binding,assertCurrent:guard,async requestOwner<C extends import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerCommand>(command:C,payload:import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerPayloads[C],ctx:Parameters<LocalWorkbenchRootMainAuthor['requestOwner']>[2]):Promise<import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerResults[C]>{
    assert.equal(ctx.binding,binding);await guard();assert.equal(ctx.signal.aborted,false)
    if(command==='capabilities.read')return structuredClone(base) as import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerResults[C]
    if(command==='read.resolveCapture'){
      const value=await f.owner.read.resolveCapture(payload as Parameters<LocalWorkbenchOwnerPorts['read']['resolveCapture']>[0],ctx)
      // 该组件经过真实Owner协议验证；逻辑修订使用原合同要求的十进制值。
      const result={...value,capture:{...value.capture,members:value.capture.members.map(member=>({...member,rootRevision:'1',fileRevision:member.fileRevision===null?null:'1',locationRevision:member.locationRevision===null?null:'1'}))},
        group:{...value.group,members:value.group.members.map(member=>({...member,fact:{...member.fact,summary:{...member.fact.summary,asset:{...member.fact.summary.asset,rootRevision:'1',fileRevision:'1',locationRevision:'1'}}}}))}}
      assert.ok(isDatasetWorkbenchOwnerResult(command,result,payload,binding.datasetId),'受控读取回包必须先通过原Owner闭集合同')
      return result as import('../../../packages/bridge-core/src/collection/dataset-owner-protocol.js').DatasetWorkbenchOwnerResults[C]
    }
    throw Error('本组件不模拟其他Owner行为')
  }}
  const owner=capabilityTransportOwner(author)
  const artwork=createLocalArtworkProviders({transport:async()=>{state.transportCalls++;return response(jpeg(),'image/jpeg')},normalize:bytes=>normalizeLocalArtwork(bytes,()=>decoder()),readTransportAvailability:signal=>{state.providerCalls++;return options.providerAvailability?options.providerAvailability(signal):!signal.aborted&&(state.providerAnswers.length?state.providerAnswers.shift()!:state.provider)}})
  const navigation=createLocalArtworkWebNavigation({readPortAvailability:(mode,signal)=>options.webAvailability?options.webAvailability(mode,signal):!signal.aborted&&(mode==='navigate'?state.navigate:state.external),navigate(_url,ctx){registerLocalArtworkNavigationPhysical(ctx.signal,{closed:Promise.resolve(),abort(){}})},openExternal(){}})
  const promptHost={async request(_mode:Parameters<NonNullable<Parameters<typeof createLocalWorkbenchNativeChooser>[0]['promptHost']>['request']>[0],signal:AbortSignal){await guard();assert.equal(signal.aborted,false);state.requests++;state.hostPending=true;try{return {cancelled:true,value:null}}finally{state.hostPending=false}},async join(){assert.equal(state.hostPending,false)},async close(){state.hostClosed=true;await this.join()},...(!options.uninstalled?{readAvailability(mode:string,signal:AbortSignal):dto.LocalWorkbenchAvailability{return state.hostCreated&&!state.hostClosed&&!state.hostPending&&!signal.aborted&&(mode==='artwork'?state.artwork:mode==='cue-target'?state.cue:true)?{available:true}:{available:false,reason:'本组件原prompt host未确认可调用。'}}}:{})}
  const chooser=createLocalWorkbenchNativeChooser({assertCurrent:async ctx=>{assert.equal(ctx.datasetId,datasetId);await guard();await ctx.assertCurrent?.()},promptHost,registerCueTarget:async()=>{},registerLibraryDirectory:async()=>{throw Error('本组件不登记库目录')}})
  const service=createLocalWorkbenchService({...f.serviceOptions,owner:options.cloneOwner?{...owner}:owner,artwork,navigation,nativeChooser:chooser,
    artworkSources:{aggregate:{kind:'provider',source:'douban-itunes'},douban:{kind:'provider',source:'douban'},itunes:{kind:'provider',source:'itunes'},'google-web':{kind:'web',source:'google-images'},'bing-web':{kind:'web',source:'bing-images'},'douban-web':{kind:'web',source:'douban-web'}}})
  t.after(()=>service.close())
  const ctx=(signal=new AbortController().signal):LocalWorkbenchMainContext=>({...context(signal),assertCurrent:guard})
  async function ask<C extends dto.LocalWorkbenchCommand>(command:C,payload:dto.LocalWorkbenchCommandPayloads[C],actual=ctx()):Promise<dto.LocalWorkbenchCommandResults[C]>{const value=await service.request({command,payload} as LocalWorkbenchMainRequest,actual);assert.ok(dto.isLocalWorkbenchCommandResult(command,value,payload));return value as dto.LocalWorkbenchCommandResults[C]}
  return {f,base,state,service,artwork,navigation,chooser,ctx,ask,read:(actual=ctx())=>ask('localWorkbench.capabilities',{},actual)}
}

test('私有资源能力接线：来源逐行原map与聚合OR，文件合取真实格式/Owner，picker不补Native资格',async t=>{
  const h=await resourceAvailabilityService(t),before=structuredClone(h.base);h.state.providerAnswers=[false,true]
  const result=await h.read()
  assert.deepEqual(result.artworkSources.map(row=>({id:row.id,kind:row.kind,available:row.availability.available})),[
    {id:'aggregate',kind:'aggregate',available:true},{id:'douban',kind:'provider',available:false},{id:'itunes',kind:'provider',available:true},
    {id:'google-web',kind:'web',available:true},{id:'bing-web',kind:'web',available:true},{id:'douban-web',kind:'web',available:true}])
  assert.equal(h.state.providerCalls,2,'同次来源状态按原两源精确消费，不靠Owner空来源列表')
  assert.equal(result.capabilities['artwork-search']?.available,true);assert.equal(result.capabilities['artwork-file']?.available,true)
  assert.equal(result.capabilities['cue-preview']?.available,false);assert.deepEqual(result.cueFormats,before.cueFormats);assert.deepEqual(h.base,before)
  assert.equal(h.state.transportCalls,0);assert.equal(h.state.requests,0)
  h.base.capabilities.read={available:false,reason:'原Owner读取尚未授准入'};const noRead=await h.read()
  assert.equal(noRead.capabilities['artwork-file']?.available,false);assert.equal(noRead.capabilities['artwork-drop']?.available,false);assert.ok(noRead.artworkSources.every(source=>!source.availability.available))
  h.base.capabilities.read={available:true};h.base.capabilities['cue-preview']={available:true};h.state.cue=false
  const noPicker=await h.read();assert.equal(noPicker.capabilities['cue-preview']?.available,false);assert.deepEqual(noPicker.cueFormats,before.cueFormats)
})

test('私有资源能力接线：remote关闭不禁原本地bytes/dataURI，远程请求前必须有原transport状态',async t=>{
  const h=await resourceAvailabilityService(t);h.state.provider=false
  const available=await h.read();assert.equal(available.capabilities['artwork-drop']?.available,true)
  assert.equal(available.artworkSources.filter(row=>row.kind!=='web').every(row=>!row.availability.available),true)
  const bytes=await h.ask('localWorkbench.artwork.import',inputRequest());assert.equal(bytes.albumId,reference.albumId)
  const text=await h.ask('localWorkbench.artwork.import',{...fileRequest,text:'data:image/jpeg;base64,'+jpeg().toString('base64'),label:'原组件dataURI'})
  assert.equal(text.albumId,reference.albumId);assert.equal(h.state.transportCalls,0)
  await assert.rejects(h.ask('localWorkbench.artwork.import',{...fileRequest,text:'https://example.com/original-image.jpg',label:'合成明确URL'}))
  await assert.rejects(h.service.importRemoteSource({...fileRequest,source:{url:'https://example.com/original-image.jpg',label:'合成明确URL'}},h.ctx()))
  assert.equal(h.state.transportCalls,0,'remote未就绪时不能开始HTTP，也不能影响已取得的本地bytes候选')
})

test('私有资源能力接线：网页内嵌/显式外部逐mode，缺host与关闭状态不由方法存在补true',async t=>{
  const h=await resourceAvailabilityService(t,{uninstalled:true});h.state.provider=false;h.state.navigate=false;h.state.external=true
  const result=await h.read();assert.equal(result.capabilities['artwork-search']?.available,false);assert.equal(result.capabilities['artwork-file']?.available,false)
  assert.ok(result.artworkSources.every(source=>!source.availability.available))
  assert.equal((await h.service.navigateWebSource({...fileRequest,sourceId:'google-web',query:'合成明确外部',external:true},h.ctx())).opened,true)
  await assert.rejects(h.service.navigateWebSource({...fileRequest,sourceId:'google-web',query:'合成内嵌',external:false},h.ctx()))
  await h.navigation.close();const closed=await h.read();assert.ok(closed.artworkSources.filter(row=>row.kind==='web').every(row=>!row.availability.available))
  await assert.rejects(h.service.navigateWebSource({...fileRequest,sourceId:'google-web',query:'关闭后外部',external:true},h.ctx()))
  assert.equal(h.state.requests,0);assert.equal(h.state.transportCalls,0)
})

test('私有资源能力接线：克隆Owner/换作者/原close与迟到hook均不能授新可用状态',async t=>{
  const clone=await resourceAvailabilityService(t,{cloneOwner:true});assert.deepEqual(await clone.read(),clone.base);assert.equal(clone.state.providerCalls,0);assert.equal(clone.state.requests,0)
  const h=await resourceAvailabilityService(t);h.state.current=false;await assert.rejects(h.read());assert.equal(h.state.providerCalls,0);h.state.current=true
  await h.chooser.closeReadResources();assert.equal((await h.read()).capabilities['artwork-file']?.available,false)
  const f=await fixture(t),gate=deferred<boolean>(),entered=deferred<void>(),controller=new AbortController();let current=true
  const artwork=createLocalArtworkProviders({transport:async()=>{throw Error('本例不发网络')},normalize:bytes=>normalizeLocalArtwork(bytes,()=>decoder()),readTransportAvailability:async()=>{entered.resolve();return gate.promise}})
  const service=createLocalWorkbenchService({...f.serviceOptions,owner:capabilityOwner(capabilityCoreReply()),artwork});t.after(()=>service.close())
  const actual={...context(controller.signal),assertCurrent:async()=>{if(!current)throw Error('原Main已经换代')}}
  const pending=service.request({command:'localWorkbench.capabilities',payload:{}},actual),rejected=assert.rejects(pending)
  try{await entered.promise;current=false;controller.abort();gate.resolve(true);await rejected}finally{gate.resolve(false);await service.close()}
  assert.equal(controller.signal.aborted,true)
})

test('局部封面动作：未完成的远程状态不阻塞本地bytes与dataURI导入',async t=>{
  const entered=deferred<void>(),gate=deferred<boolean>()
  const h=await resourceAvailabilityService(t,{providerAvailability:()=>{entered.resolve();return gate.promise}})
  const payloads=[inputRequest(),{...fileRequest,text:'data:image/jpeg;base64,'+jpeg().toString('base64'),label:'本地自有图片文本'}]
  for(const payload of payloads){
    const pending=h.ask('localWorkbench.artwork.import',payload)
    try{
      const first=await Promise.race([pending.then(()=> 'local-complete' as const),entered.promise.then(()=> 'unrelated-provider' as const)])
      assert.equal(first,'local-complete','本地图片不能先等待无关远程状态')
      assert.equal((await pending).albumId,reference.albumId)
    }finally{gate.resolve(false);await Promise.allSettled([pending])}
  }
  assert.equal(h.state.providerCalls,0);assert.equal(h.state.transportCalls,0);assert.equal(h.state.requests,0)
})

test('局部封面动作：未完成的内嵌状态不阻塞显式外部打开',async t=>{
  const entered=deferred<void>(),gate=deferred<boolean>()
  const h=await resourceAvailabilityService(t,{webAvailability:(mode,signal)=>{if(mode==='navigate'){entered.resolve();return gate.promise}return !signal.aborted}})
  h.state.provider=false
  const pending=h.service.navigateWebSource({...fileRequest,sourceId:'google-web',query:'自有明确外部请求',external:true},h.ctx())
  try{
    const first=await Promise.race([pending.then(()=> 'external-complete' as const),entered.promise.then(()=> 'unrelated-navigation' as const)])
    assert.equal(first,'external-complete','外部打开不能先等待内嵌导航状态')
    assert.equal((await pending).opened,true)
  }finally{gate.resolve(false);await Promise.allSettled([pending])}
  assert.equal(h.state.transportCalls,0);assert.equal(h.state.requests,0)
})

test('CD21公开search external按原capture与自身端口，navigate关闭仍可调用而改capture/非web/跨dataset拒', async t => {
  let shell = 0, navigate = 0
  const navigation = createLocalArtworkWebNavigation({ readPortAvailability: mode => mode === 'openExternal', navigate() { navigate++ }, openExternal(url) { shell++; assert.equal(url.hostname, 'www.google.com'); assert.equal(url.searchParams.get('q'), '合成 & 查询 封面') } })
  const f = await fixture(t, { navigation }), request = { ...fileRequest, sourceId: 'google-web', query: '合成 & 查询', webAction: 'external' as const }
  const reply = await f.ask('localWorkbench.artwork.search', request)
  assert.deepEqual(reply, { candidates: [], sources: [{ source: 'web', country: null, status: 'opened', candidateCount: 0, previewFailureCount: 0, truncated: false, message: null }] }); assert.equal(shell, 1); assert.equal(navigate, 0)
  await assert.rejects(f.ask('localWorkbench.artwork.search', { ...request, capture: { ...reference, readToken: '伪原token' } }))
  await assert.rejects(f.ask('localWorkbench.artwork.search', { ...request, datasetId: otherDataset }))
  await assert.rejects(f.ask('localWorkbench.artwork.search', { ...request, sourceId: 'aggregate' }))
  assert.equal(shell, 1); assert.equal(navigate, 0); assert.equal(f.events.includes('writer'), false)
})
test('CD21 Main原owned reload执行真正reload，旧document立即封、新序号不重置、closed和原signal撤销不能报成功', async () => {
  const { EventEmitter } = await import('node:events'), source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('      const dragWorld = 1001, dragSlot'), end = source.indexOf('      // 打开完成与自有窗口退出分别记账', start)
  assert.ok(start >= 0 && end > start)
  const captureId = '35bb416a-7501-458a-b054-17ce2b32ffac', original = new AbortController(), reloadSignal = new AbortController(), reloads = new Map<string, { signal: AbortSignal; reload(context: { signal: AbortSignal; originalSignal: AbortSignal; captureId: string }): Promise<void> }>()
  let frame = createContext({}), dragHandlers: ((event: unknown) => void)[] = [], count = 0, destroyed = false
  class Image { constructor(readonly src: string) {} get currentSrc() { return this.src } }
  const document = () => { dragHandlers = []; frame = createContext({ HTMLImageElement: Image, performance: { now: () => 1000 }, document: { addEventListener(_event: string, handler: (event: unknown) => void) { dragHandlers.push(handler) } } }) }
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, reload() { count++ }, executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]) { return Promise.resolve(runInContext(scripts[0]!.code, frame)) } })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => destroyed })
  const cancel = () => { if (!destroyed) { destroyed = true; contents.emit('destroyed') } }
  const lowered = ts.transpileModule('(function(window,context,url,cancel,assertCurrent,webReloads,syncWebViewport){' + source.slice(start, end) + '; return { ready:()=>dragCaptureReady, current:()=>dragDocumentReady, epoch:()=>dragDocumentGeneration };})', { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  const install = new Function('return ' + lowered.outputText)() as (window: object, context: object, url: URL, cancel: () => void, assertCurrent: () => Promise<void>, reloads: object, syncWebViewport: () => Promise<void>) => { ready(): Promise<unknown>; current(): boolean; epoch(): number }
  const installed = install(window, { signal: original.signal, captureId }, new URL('https://www.google.com/search?tbm=isch&q=original'), cancel, async () => {}, reloads, async () => {})
  const drag = (url: string) => { let ref = ''; for (const handle of dragHandlers) handle({ isTrusted: true, dataTransfer: { setData(_name: string, value: string) { ref = value } }, composedPath: () => [new Image(url)] }); return ref }
  document(); contents.emit('dom-ready'); await installed.ready(); const old = drag('https://images.example.com/old.jpg'); assert.equal(old, captureId + '.1')
  const epoch = installed.epoch(), refresh = reloads.get(captureId)!.reload({ signal: reloadSignal.signal, originalSignal: original.signal, captureId }); let settled = false; void refresh.then(() => { settled = true })
  await tick(); assert.equal(count, 1); assert.equal(installed.current(), false); assert.ok(installed.epoch() > epoch); assert.equal(settled, false)
  document(); contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); contents.emit('dom-ready'); await refresh
  const fresh = drag('https://images.example.com/fresh.jpg'); assert.equal(fresh, captureId + '.1025'); assert.equal(runInContext(`globalThis.__musicbridgeTakeArtworkDrag(${JSON.stringify(old)})`, frame), null)
  assert.equal(installed.current(), true); assert.equal(count, 1)
  await assert.rejects(reloads.get(captureId)!.reload({ signal: reloadSignal.signal, originalSignal: new AbortController().signal, captureId })); assert.equal(count, 1)
  const second = reloads.get(captureId)!.reload({ signal: reloadSignal.signal, originalSignal: original.signal, captureId }), rejected = assert.rejects(second)
  await tick(); reloadSignal.abort(); await rejected; assert.equal(destroyed, true); assert.equal(count, 2)
})

// CD01只验真实Node目录FD与受控原Source端口；不授AppKit、Native或普通App资格。
function droppedCd01(f: Awaited<ReturnType<typeof directory418Fixture>>, absolute: string) {
  return f.boundary.prepareDroppedLibrary({}, main407Dataset, prepared => f.chooser.chooseDroppedLibrary(absolute, {
    datasetId: prepared.binding.datasetId, signal: prepared.signal, assertCurrent: prepared.assertCurrent,
    ...(prepared.directoryUiToken ? { directoryUiToken: prepared.directoryUiToken } : {}),
  }))
}
test('CD01：真实拖入目录直接沿原UI审批和Owner FD登记，未调用另一个chooser且关闭真实根FD', async t => {
  const f = await directory418Fixture(t); f.setPrompt(path.join(f.directory, '不得使用此chooser路径'))
  const choice = await droppedCd01(f, f.library); assert.ok(choice)
  assert.equal(choice.suggestedRole, 'catalog'); assert.equal(f.roots.size, 1)
  assert.equal(f.requests[0]!.binding.originalUi.requestSha256, lyricsPhysicalDigest({ command: 'library.import.prepare', payload: {} }))
  const original = f.roots.get(choice.choiceId)!, fd = original.handle.fd
  assert.equal(original.physical.path, f.library); assert.ok(fd >= 0)
  assert.equal((await import('node:fs')).fstatSync(fd).isDirectory(), true)
  await f.chooser.closeApprovedDirectories()
  assert.equal(original.handle.fd, -1); assert.equal(f.roots.size, 0); assert.equal(f.bridge.pending(), 0)
  assert.throws(() => (requireCd01Fs()).fstatSync(fd), { code: 'EBADF' })
})
function requireCd01Fs() { return createRequire(import.meta.url)('node:fs') as typeof import('node:fs') }

test('CD01：文件、符号链接和非绝对路径拒绝，无原Owner登记且原文件字节不变', async t => {
  const f = await directory418Fixture(t), file = path.join(f.directory, '原文件.bin'), link = path.join(f.directory, '库链接')
  const bytes = Buffer.from('CD01原文件保留'); await writeFile(file, bytes); await (await import('node:fs/promises')).symlink(f.library, link)
  for (const absolute of [file, link, 'library', f.library + '/..', f.library + '\0']) await assert.rejects(droppedCd01(f, absolute), { code: 'NOT_READY' })
  assert.equal(f.roots.size, 0); assert.equal(f.requests.length, 0); assert.equal(f.bridge.pending(), 0)
  assert.deepEqual(await readFile(file), bytes)
})

test('CD01：审批前替换原inode或改成链接均拒绝，不把新目录当原drop对象', async t => {
  for (const replacement of ['directory', 'symlink'] as const) {
    const f = await directory418Fixture(t), old = path.join(f.directory, '原拖入目录'), bytes = Buffer.from('不得改写')
    await writeFile(path.join(f.library, '保留.bin'), bytes)
    let checks = 0
    await assert.rejects(f.boundary.prepareDroppedLibrary({}, main407Dataset, prepared => f.chooser.chooseDroppedLibrary(f.library, {
      datasetId: prepared.binding.datasetId, signal: prepared.signal,
      ...(prepared.directoryUiToken ? { directoryUiToken: prepared.directoryUiToken } : {}),
      async assertCurrent() {
        await prepared.assertCurrent()
        if (++checks === 2) {
          await rename(f.library, old)
          if (replacement === 'directory') await mkdir(f.library)
          else await (await import('node:fs/promises')).symlink(f.target, f.library)
        }
      },
    })), { code: 'NOT_READY' })
    assert.equal(f.requests.length, 0); assert.equal(f.roots.size, 0)
    assert.deepEqual(await readFile(path.join(old, '保留.bin')), bytes)
  }
})

test('CD01：共享库选择互斥，取消或撤作者后保原task至FD关闭，不接受迟到choice', async t => {
  for (const change of ['cancel', 'author'] as const) {
    const f = await directory418Fixture(t), started = deferred<Parameters<typeof f.bridge.registerLibraryDirectory>[0]>(), gate = deferred<void>()
    const register = f.bridge.registerLibraryDirectory, author = f.author
    t.mock.method(f.bridge, 'registerLibraryDirectory', async (approved: Parameters<typeof register>[0], ctx: Parameters<typeof register>[1]) => { started.resolve(approved); await gate.promise; return register.call(f.bridge, approved, ctx) })
    const running = droppedCd01(f, f.library), rejected = assert.rejects(running, { code: 'NOT_READY' }), approved = await started.promise
    const physical = await f.chooser.inspectHeldDirectory(approved, { datasetId: main407Dataset, signal: new AbortController().signal })
    assert.equal(physical.path, f.library); assert.equal(f.boundary.pending(), 1)
    await assert.rejects(droppedCd01(f, f.target), { code: 'NOT_READY' })
    await assert.rejects(f.chooseLibrary(), { code: 'NOT_READY' }); assert.equal(f.requests.length, 0)
    if (change === 'cancel') f.boundary.revoke(); else f.setAuthor(undefined)
    assert.equal(f.boundary.pending(), 1); gate.resolve(); await rejected
    await f.chooser.closeReadResources()
    await assert.rejects(f.chooser.inspectHeldDirectory(approved, { datasetId: main407Dataset, signal: new AbortController().signal }))
    assert.equal(f.boundary.pending(), 0); assert.equal(f.roots.size, 0); assert.equal(f.bridge.pending(), 0)
    f.setAuthor(author)
  }
})

test('CD01：drop原2秒到期撤响应但等原callback收口，可信来源和工作库先核且公开prepare仍拒路径', async () => {
  const author = main407Author(), started = deferred<LocalWorkbenchMainPreparationContext>(), gate = deferred<void>()
  let calls = 0
  const boundary = createLocalWorkbenchManagementBoundary<{ trusted: boolean }>({ assertTrusted(event) { if (!event.trusted) throw new Error('非原主页面') }, isAccepting: () => true, currentAuthor: () => author })
  const callback = async (prepared: LocalWorkbenchMainPreparationContext) => { calls++; started.resolve(prepared); await gate.promise; return null }
  await assert.rejects(boundary.prepareDroppedLibrary({ trusted: false }, main407Dataset, callback), /原主页面/u)
  await assert.rejects(boundary.prepareDroppedLibrary({ trusted: true }, otherDataset, callback), { code: 'OUTBOX_SCOPE_MISMATCH' })
  await assert.rejects(boundary.management({ trusted: true }, { datasetId: main407Dataset, command: 'library.import.prepare', payload: { path: '/伪Renderer路径' } }), { code: 'INVALID_IPC_REQUEST' })
  assert.equal(calls, 0)
  const running = boundary.prepareDroppedLibrary({ trusted: true }, main407Dataset, callback), prepared = await started.promise
  await assert.rejects(running, { code: 'TIMEOUT' }); assert.equal(prepared.signal.aborted, true); assert.equal(calls, 1); assert.equal(boundary.pending(), 1)
  let closed = false; const closing = boundary.close().then(() => { closed = true }); await tick(); assert.equal(closed, false)
  gate.resolve(); await closing; assert.equal(boundary.pending(), 0); assert.equal(closed, true)
})


// 525目录层仍为受控Supervisor/Domain＋真实Node端口/FD；不冒默认Owner、SQL冷读或Native资格。
import directoryFs525 from 'node:fs/promises'
import { fstatSync as directoryFstat525 } from 'node:fs'
import { syncBuiltinESMExports as directorySync525 } from 'node:module'
import { DatabaseSync as DirectoryDatabase525 } from 'node:sqlite'

function observeDirectoryCancel525(t:test.TestContext,paths:readonly string[]){
  const originalOpen=directoryFs525.open,opened:{path:string;handle:FileHandle;fd:number}[]=[],pending=new Set<Promise<void>>(),errors:unknown[]=[],sqlCalls:string[]=[]
  const observedOpen:typeof originalOpen=(...args)=>{
    const actual=Reflect.apply(originalOpen,directoryFs525,args) as ReturnType<typeof originalOpen>
    if(typeof args[0]==='string'&&paths.includes(args[0])){const file=args[0],observed=actual.then(handle=>{opened.push({path:file,handle,fd:handle.fd})},error=>{errors.push(error)});pending.add(observed);void observed.then(()=>pending.delete(observed),error=>{errors.push(error);pending.delete(observed)})}
    return actual
  }
  Object.defineProperty(observedOpen,'length',{value:originalOpen.length});assert.equal(observedOpen.length,originalOpen.length)
  const originalPrepare=Object.getOwnPropertyDescriptor(DirectoryDatabase525.prototype,'prepare')!,originalExec=Object.getOwnPropertyDescriptor(DirectoryDatabase525.prototype,'exec')!
  assert.equal(typeof originalPrepare.value,'function');assert.equal(typeof originalExec.value,'function')
  const observedPrepare=function(this:DirectoryDatabase525,...args:Parameters<DirectoryDatabase525['prepare']>){sqlCalls.push('prepare');return Reflect.apply(originalPrepare.value,this,args) as ReturnType<DirectoryDatabase525['prepare']>}
  const observedExec=function(this:DirectoryDatabase525,...args:Parameters<DirectoryDatabase525['exec']>){sqlCalls.push('exec');return Reflect.apply(originalExec.value,this,args) as ReturnType<DirectoryDatabase525['exec']>}
  Object.defineProperty(observedPrepare,'length',{value:originalPrepare.value.length});Object.defineProperty(observedExec,'length',{value:originalExec.value.length})
  assert.equal(observedPrepare.length,originalPrepare.value.length);assert.equal(observedExec.length,originalExec.value.length)
  directoryFs525.open=observedOpen;directorySync525()
  Object.defineProperty(DirectoryDatabase525.prototype,'prepare',{...originalPrepare,value:observedPrepare});Object.defineProperty(DirectoryDatabase525.prototype,'exec',{...originalExec,value:observedExec})
  t.after(()=>{try{assert.equal(directoryFs525.open,observedOpen);assert.equal(DirectoryDatabase525.prototype.prepare,observedPrepare);assert.equal(DirectoryDatabase525.prototype.exec,observedExec)}finally{directoryFs525.open=originalOpen;directorySync525();Object.defineProperty(DirectoryDatabase525.prototype,'prepare',originalPrepare);Object.defineProperty(DirectoryDatabase525.prototype,'exec',originalExec)}})
  return{opened,sqlCalls,async join(){await Promise.allSettled([...pending]);assert.deepEqual(errors,[])}}
}

test('Main-only取消525：原2秒Main边界不forward或accept其他族，跨dataset作者失权拒迟到取消',async t=>{
  const author=main407Author(),gate=deferred<void>(),started=deferred<void>();let current:LocalWorkbenchRootMainAuthor|undefined=author,cancels=0,forwards=0,hooks=0
  const observedAuthor:LocalWorkbenchRootMainAuthor={...author,request:async()=>{forwards++;throw Error('Main取消不得forward Owner')},requestOwner:async()=>{forwards++;throw Error('Main取消不得借Owner18端点')}};current=observedAuthor
  const boundary=createLocalWorkbenchManagementBoundary<{trusted:boolean}>({assertTrusted(event){assert.equal(event.trusted,true)},isAccepting:()=>true,currentAuthor:()=>current,
    acceptDirectoryRequest:async()=>{hooks++;throw Error('取消不得新受理目录许可')},acceptNameRequest:async()=>{hooks++;throw Error('取消不得受理NAME')},acceptLyricsRequest:async()=>{hooks++;throw Error('取消不得受理歌词')},observeNameResult:async()=>{hooks++;throw Error('取消不得观察NAME')},
    cancelLibraryImport:async(request,context)=>{await context.assertCurrent();cancels++;started.resolve();await gate.promise;await context.assertCurrent();return{choiceId:request.choiceId,released:true}}})
  t.after(async()=>{gate.resolve();await boundary.close()})
  const value={datasetId:main407Dataset,command:'library.import.cancel',payload:{choiceId:randomUUID()}}
  await assert.rejects(boundary.management({trusted:false},value));await assert.rejects(boundary.management({trusted:true},{...value,datasetId:'75555555-5555-4555-8555-555555555555'}),{code:'OUTBOX_SCOPE_MISMATCH'})
  assert.equal(cancels,0)
  const running=boundary.management({trusted:true},value),rejected=assert.rejects(running,{code:'OUTBOX_SCOPE_MISMATCH'})
  await started.promise;assert.equal(boundary.pending(),1);current={...observedAuthor,binding:{...observedAuthor.binding,childGeneration:2,authorityRef:{}}};gate.resolve();await rejected;await tick()
  assert.equal(cancels,1);assert.equal(forwards,0);assert.equal(hooks,0);assert.equal(boundary.pending(),0)
})

test('Main-only取消525：Main原2000ms届满撤响应但仍join原任务，迟到released不重签或forward',async t=>{
  const author=main407Author(),gate=deferred<void>(),started=deferred<void>();let originalSignal:AbortSignal|undefined,forwards=0,hooks=0,closed=false
  const current:LocalWorkbenchRootMainAuthor={...author,request:async()=>{forwards++;throw Error('取消不得forward')},requestOwner:async()=>{forwards++;throw Error('取消不得forward Owner18')}}
  const boundary=createLocalWorkbenchManagementBoundary({assertTrusted(){},isAccepting:()=>true,currentAuthor:()=>current,acceptDirectoryRequest:async()=>{hooks++;return undefined},acceptNameRequest:async()=>{hooks++;return undefined},
    cancelLibraryImport:async(request,context)=>{originalSignal=context.signal;started.resolve();await gate.promise;return{choiceId:request.choiceId,released:true}}})
  t.after(async()=>{gate.resolve();await boundary.close()})
  const began=performance.now(),running=boundary.management({}, {datasetId:main407Dataset,command:'library.import.cancel',payload:{choiceId:randomUUID()}})
  const rejected=assert.rejects(running,{code:'TIMEOUT'});await started.promise;await rejected
  assert.ok(performance.now()-began>=1900);assert.equal(originalSignal?.aborted,true);assert.equal(boundary.pending(),1)
  const closing=boundary.close().then(()=>{closed=true});await tick();assert.equal(closed,false);gate.resolve();await closing
  assert.equal(closed,true);assert.equal(boundary.pending(),0);assert.equal(forwards,0);assert.equal(hooks,0)
})

test('Main-only取消525：原Source端口关闭Owner和Main两真实目录FD，重复choice只release一次零通用SQL扫描入口',async t=>{
  const f=await directory418Fixture(t),observation=observeDirectoryCancel525(t,[f.library])
  const choice=await f.chooseLibrary();await observation.join();assert.equal(observation.opened.length,2)
  const owner=f.roots.get(choice.choiceId)!,main=observation.opened.find(row=>row.handle!==owner.handle)!;assert.ok(main)
  const ownerOpen=observation.opened.find(row=>row.handle===owner.handle)!;assert.ok(ownerOpen);assert.notEqual(main.fd,ownerOpen.fd)
  assert.equal(directoryFstat525(main.fd,{bigint:true}).ino,directoryFstat525(ownerOpen.fd,{bigint:true}).ino);assert.ok((await main.handle.stat()).isDirectory());assert.ok((await owner.handle.stat()).isDirectory())
  const approved=f.approvedLibraries525.get(choice.choiceId)!;assert.ok(approved)
  const value={datasetId:main407Dataset,command:'library.import.cancel',payload:{choiceId:choice.choiceId}}
  assert.deepEqual(await f.boundary.management({},value),{choiceId:choice.choiceId,released:true})
  assert.equal(f.roots.size,0);assert.equal(f.bridge.pending(),0)
  for(const row of observation.opened){await assert.rejects(row.handle.stat(),{code:'EBADF'});assert.throws(()=>directoryFstat525(row.fd),{code:'EBADF'})}
  await assert.rejects(f.chooser.inspectHeldDirectory(approved,{datasetId:main407Dataset,signal:new AbortController().signal,assertCurrent:()=>f.author.assertCurrent(f.author.binding)}))
  assert.deepEqual(await f.boundary.management({},value),{choiceId:choice.choiceId,released:true})
  assert.deepEqual(f.directoryRegistrations525.filter(row=>row.command==='release'),[{command:'release',choiceId:choice.choiceId}]);assert.equal(f.requests.filter(row=>row.command==='revoke').length,1)
  assert.equal(f.sourceWritesCalls525,0);assert.equal(f.domainDispatchCalls525,0);assert.deepEqual(observation.sqlCalls,[])
})

test('Main-only取消525：确认首目录校验await前占原choice，竞赛和跨作者cue未知choice皆拒且两FD保留',async t=>{
  const f=await directory418Fixture(t),observation=observeDirectoryCancel525(t,[f.library,f.target]),choice=await f.chooseLibrary(),author=f.author,approved=f.approvedLibraries525.get(choice.choiceId)!,original=approved.assertCurrent,gate=deferred<void>(),entered=deferred<void>()
  const context=main407Context(author),body={family:'management' as const,command:'library.import.confirm' as const,payload:{commandId:randomUUID(),choiceId:choice.choiceId,role:'artist' as const}}
  approved.assertCurrent=async actual=>{entered.resolve();await gate.promise;return original.call(approved,actual)}
  const confirming=f.bridge.enter(body,context)
  try{
    await entered.promise;await assert.rejects(f.bridge.cancelLibraryChoice(choice.choiceId,context),/不能取消/u)
    gate.resolve();assert.ok(await confirming);await assert.rejects(f.bridge.cancelLibraryChoice(choice.choiceId,context),/不能取消/u)
  }finally{gate.resolve();try{await confirming}finally{approved.assertCurrent=original}}
  await observation.join();assert.equal(observation.opened.filter(row=>row.path===f.library).length,2);for(const row of observation.opened)assert.ok((await row.handle.stat()).isDirectory())
  await assert.rejects(f.bridge.cancelLibraryChoice(randomUUID(),context))
  const foreign={...context,binding:{...author.binding,authorityRef:{}}};await assert.rejects(f.bridge.cancelLibraryChoice(choice.choiceId,foreign))
  f.setPrompt(f.target);const cue=await f.chooseCue();assert.ok(cue);await assert.rejects(f.bridge.cancelLibraryChoice(cue.target.choiceId,context))
  assert.equal(f.roots.size,2);assert.equal(f.directoryRegistrations525.filter(row=>row.command==='release').length,0);assert.equal(f.domainDispatchCalls525,0);assert.equal(f.sourceWritesCalls525,0);assert.deepEqual(observation.sqlCalls,[])

  // 未确认的独立choice作正对照，排除confirmationAccepted提前拒绝遮住作者围栏。
  const pendingDirectory525=path.join(f.directory,'未确认作者对照525');await mkdir(pendingDirectory525);f.setPrompt(pendingDirectory525)
  const pendingChoice525=await f.chooseLibrary(),pendingOwner525=f.roots.get(pendingChoice525.choiceId)!,pendingApproved525=f.approvedLibraries525.get(pendingChoice525.choiceId)!
  assert.notEqual(pendingChoice525.choiceId,choice.choiceId);assert.notEqual(pendingChoice525.choiceId,cue.target.choiceId);assert.ok(pendingOwner525);assert.ok(pendingApproved525)
  const beforeForeign525=f.roots.size,registrationsBeforeForeign525=f.directoryRegistrations525.length,requestsBeforeForeign525=f.requests.length
  await assert.rejects(f.bridge.cancelLibraryChoice(pendingChoice525.choiceId,foreign))
  assert.equal(f.roots.size,beforeForeign525);assert.equal(f.directoryRegistrations525.length,registrationsBeforeForeign525);assert.equal(f.requests.length,requestsBeforeForeign525)
  assert.equal(f.roots.get(pendingChoice525.choiceId),pendingOwner525);assert.ok((await pendingOwner525.handle.stat()).isDirectory())
  assert.equal((await f.chooser.inspectHeldDirectory(pendingApproved525,{datasetId:main407Dataset,signal:context.signal,assertCurrent:context.assertCurrent})).path,pendingDirectory525)
  const pendingFd525=pendingOwner525.handle.fd
  assert.deepEqual(await f.bridge.cancelLibraryChoice(pendingChoice525.choiceId,context),{choiceId:pendingChoice525.choiceId,released:true})
  assert.equal(f.roots.size,beforeForeign525-1);assert.equal(f.roots.has(pendingChoice525.choiceId),false)
  await assert.rejects(pendingOwner525.handle.stat(),{code:'EBADF'});assert.throws(()=>directoryFstat525(pendingFd525),{code:'EBADF'})
  await assert.rejects(f.chooser.inspectHeldDirectory(pendingApproved525,{datasetId:main407Dataset,signal:context.signal,assertCurrent:context.assertCurrent}))
  assert.deepEqual(f.directoryRegistrations525.slice(registrationsBeforeForeign525),[{command:'release',choiceId:pendingChoice525.choiceId}]);assert.equal(f.requests.slice(requestsBeforeForeign525).filter(row=>row.command==='revoke').length,1)
  assert.equal(f.sourceWritesCalls525,0);assert.equal(f.domainDispatchCalls525,0);assert.deepEqual(observation.sqlCalls,[])
})

test('移除闭环：Main原身份initial与intent完整检查共用30秒，资源join超过2秒仍可成功',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const started=deferred<void>(),release=deferred<void>(),author=main407Author(),libraryId=randomUUID()
  let fullChecks=0,remaining=0,signal:AbortSignal|undefined
  author.assertCurrent=async()=>{fullChecks++}
  author.request=async(request,context)=>{
    assert.equal(request.family,'management');assert.equal(request.command,'library.remove')
    remaining=context.deadlineAtMs-performance.now();signal=context.signal;started.resolve();await release.promise
    return {commandId:main407Command,kind:'library.remove',state:'succeeded',libraryIds:[libraryId],message:null}
  }
  const boundary=createLocalWorkbenchManagementBoundary({assertTrusted(){},isAccepting:()=>true,currentAuthor:()=>author,
    async acceptNameRequest(request,context){if(request.family==='management'&&request.command==='library.remove'){await context.assertCurrent();await context.assertCurrent()}return undefined}})
  t.after(async()=>{release.resolve();await boundary.close()})
  const pending=boundary.management({}, {datasetId:main407Dataset,command:'library.remove',payload:{commandId:main407Command,libraryIds:[libraryId]}})
  const observed=pending.then(value=>({value}),error=>({error}))
  await started.promise
  assert.ok(remaining>29000&&remaining<=30000,'只有完整remove取得原30秒剩余期限')
  assert.equal(fullChecks,3,'没有以identityOnly替代原三次完整检查')
  t.mock.timers.tick(2100);await tick();assert.equal(signal?.aborted,false)
  release.resolve();const result=await observed;assert.ok('value'in result);assert.equal(fullChecks,4)
})

test('移除闭环：普通Main管理命令仍2秒，超时只撤回响应并保留实际flight到settle',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const started=deferred<void>(),release=deferred<void>(),author=main407Author(),libraryId=randomUUID()
  let remaining=0,signal:AbortSignal|undefined
  author.request=async(_request,context)=>{remaining=context.deadlineAtMs-performance.now();signal=context.signal;started.resolve();await release.promise
    return {commandId:main407Command,kind:'library.rename',state:'succeeded',libraryIds:[libraryId],message:null}}
  const boundary=createLocalWorkbenchManagementBoundary({assertTrusted(){},isAccepting:()=>true,currentAuthor:()=>author})
  t.after(async()=>{release.resolve();await boundary.close()})
  const pending=boundary.management({}, {datasetId:main407Dataset,command:'library.rename',payload:{commandId:main407Command,libraryId,name:'原合成名称'}})
  const rejected=assert.rejects(pending,error=>error instanceof Error&&'code'in error&&error.code==='TIMEOUT')
  await started.promise;assert.ok(remaining>1000&&remaining<=2000)
  t.mock.timers.tick(2001);await rejected;assert.equal(signal?.aborted,true);assert.equal(boundary.pending(),1)
  release.resolve();await tick();assert.equal(boundary.pending(),0)
})

test('移除闭环：Main移除30秒到期拒绝迟到成功，实际join结束前不清flight',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const started=deferred<void>(),release=deferred<void>(),author=main407Author(),libraryId=randomUUID()
  let signal:AbortSignal|undefined
  author.request=async(_request,context)=>{signal=context.signal;started.resolve();await release.promise
    return {commandId:main407Command,kind:'library.remove',state:'succeeded',libraryIds:[libraryId],message:null}}
  const boundary=createLocalWorkbenchManagementBoundary({assertTrusted(){},isAccepting:()=>true,currentAuthor:()=>author})
  t.after(async()=>{release.resolve();await boundary.close()})
  const pending=boundary.management({}, {datasetId:main407Dataset,command:'library.remove',payload:{commandId:main407Command,libraryIds:[libraryId]}})
  const rejected=assert.rejects(pending,error=>error instanceof Error&&'code'in error&&error.code==='TIMEOUT')
  await started.promise;t.mock.timers.tick(29000);await tick();assert.equal(signal?.aborted,false)
  t.mock.timers.tick(1001);await rejected;assert.equal(signal?.aborted,true);assert.equal(boundary.pending(),1)
  release.resolve();await tick();assert.equal(boundary.pending(),0)
})
