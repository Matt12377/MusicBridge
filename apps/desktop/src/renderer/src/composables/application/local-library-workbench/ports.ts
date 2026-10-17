import * as dto from '@music-bridge/contracts'
import { localWorkbenchLyricsResultKeyMatches } from './types'
import type { LocalWorkbenchPortContext, LocalWorkbenchPorts, LocalWorkbenchLyricsResultKey, LocalWorkbenchLyricsOriginalEntry, LocalWorkbenchLibraryResultKey } from './types'

const aborted = (): Error => { const error = new Error('整理读取已取消。'); error.name = 'AbortError'; return error }
export interface LocalWorkbenchRendererPortOptions {
  api: dto.LocalWorkbenchPublicApi
  capabilities: dto.LocalWorkbenchCapabilitiesReply
  /** 现有 UI 流程由正式装配入口委托；沿原源写与重定位授权走。 */
  openExistingAction?: NonNullable<LocalWorkbenchPorts['openExistingAction']>
  /** 仅实际Renderer路由；它不改变Core/Native/Provider能力，也不能覆盖Main Finder。 */
  localExistingRoutes?: {
    datasetId(): string | null
    generation(): number
    current(): boolean
    availability(action: Exclude<dto.LocalWorkbenchExistingAction, 'finder'>): dto.LocalWorkbenchAvailability
    opened(action: Exclude<dto.LocalWorkbenchExistingAction, 'finder'>, albums: readonly dto.LocalWorkbenchAlbumRef[]): boolean
  }
  makeRequestId?: () => string
}

/** 等待真实读取 Promise 收口，不以 UI 丢弃迟到结果冒充后台资源已关闭。 */
export function createLocalWorkbenchRendererPorts(options: LocalWorkbenchRendererPortOptions): LocalWorkbenchPorts {
  if (!dto.isLocalWorkbenchCapabilitiesReply(options.capabilities)) throw new Error('整理能力读取无效，请重新加载。')
  const makeRequestId = options.makeRequestId ?? (() => crypto.randomUUID())
  const existingActions = structuredClone(options.capabilities.existingActions), localRoutes = options.localExistingRoutes
  const localActions = dto.LOCAL_WORKBENCH_EXISTING_ACTIONS.filter((action): action is Exclude<dto.LocalWorkbenchExistingAction, 'finder'> => action !== 'finder')
  if (localRoutes && options.openExistingAction) for (const action of localActions) Object.defineProperty(existingActions, action, { enumerable: true,
    get: () => localRoutes.current() && localRoutes.datasetId() ? localRoutes.availability(action) : { available: false, reason: '原工作库或维护页面尚未就绪。' } })
  async function openExistingAction(request: dto.LocalWorkbenchExistingRequest): Promise<dto.LocalWorkbenchExistingReply> {
    const delegate = options.openExistingAction ?? options.api.openLocalWorkbenchExisting.bind(options.api)
    if (!dto.isLocalWorkbenchCommandPayload('localWorkbench.existing.open', request)) return { opened: false, reason: '原维护输入无效，请重新读取。' }
    if (!localRoutes || !options.openExistingAction || request.action === 'finder') return delegate(request)
    const expected = structuredClone(request), datasetId = localRoutes.datasetId(), generation = localRoutes.generation()
    if (expected.action === 'finder') return delegate(expected)
    const current = () => !!datasetId && localRoutes.current() && localRoutes.datasetId() === datasetId && localRoutes.generation() === generation
    if (!dto.isLocalWorkbenchCommandPayload('localWorkbench.existing.open', expected) || !current()) return { opened: false, reason: '原工作库或维护选择已变化，请重新读取。' }
    const availability = localRoutes.availability(expected.action)
    if (!availability.available) return { opened: false, reason: availability.reason }
    const result = await delegate(expected)
    if (!current() || !dto.isLocalWorkbenchCommandResult('localWorkbench.existing.open', result, expected)
      || !result.opened || !localRoutes.opened(expected.action, expected.albums)) return { opened: false, reason: '原维护入口尚未在同一工作库和选择中打开。' }
    return { opened: true }
  }
  async function read<C extends dto.LocalWorkbenchReadCommand>(command: C, payload: dto.LocalWorkbenchCommandPayloads[C], context: LocalWorkbenchPortContext): Promise<dto.LocalWorkbenchCommandResults[C]> {
    if (context.signal.aborted) throw aborted()
    const request = { command, payload, requestId: makeRequestId() } as dto.LocalWorkbenchReadRequestEnvelope<C>
    if (!dto.isLocalWorkbenchReadRequestEnvelope(request)) throw new Error('整理读取身份无效。')
    const cancellation: { promise: Promise<dto.LocalWorkbenchCancelReadReply> | null } = { promise: null }
    const cancel = (): void => {
      if (cancellation.promise) return
      cancellation.promise = options.api.cancelLocalWorkbenchRead({ requestId: request.requestId })
      // 即便 IPC 返回失败，也必须继续等待原读取结束；不会自动重发。
      void cancellation.promise.catch(() => undefined)
    }
    const running = options.api.requestLocalWorkbenchRead<C>(request)
    context.signal.addEventListener('abort', cancel, { once: true })
    if (context.signal.aborted) cancel()
    try {
      const result = await running
      if (context.signal.aborted) throw aborted()
      if (!dto.isLocalWorkbenchReadResult<C>(result, request)) throw new Error('整理读取结果身份无效。')
      return result
    } finally {
      context.signal.removeEventListener('abort', cancel)
      if (cancellation.promise) await cancellation.promise.catch(() => undefined)
    }
  }
  return {
    ...structuredClone(options.capabilities),
    existingActions,
    async readAlbums(request, context) {
      if (request.albums.every(value => value.trackIds.length === 0)) {
        if (context.signal.aborted) throw aborted()
        const albums = request.albums.map(value => { if (!value.rootId || !value.revision) throw new Error('作者捕获缺少原目录或版本。'); return { albumId: value.albumId, rootId: value.rootId, revision: value.revision } })
        const result = await options.api.localLibraryManagement('library.albums.capture', { albums })
        if (context.signal.aborted) throw aborted()
        return result
      }
      return read('localWorkbench.read', request, context)
    },
    findArtworkCandidates: (request, context) => read('localWorkbench.artwork.local', request, context),
    searchArtworkCandidates: (request, context) => read('localWorkbench.artwork.search', request, context),
    chooseArtworkFile: (request, context) => read('localWorkbench.artwork.file', request, context),
    importArtworkBytes: (request, context) => read('localWorkbench.artwork.import', request, context),
    previewArtwork: (request, context) => read('localWorkbench.artwork.preview', request, context),
    suggestAlbumName: (request, context) => read('localWorkbench.ai.suggest', request, context),
    previewAi: (request, context) => read('localWorkbench.ai.preview', request, context),
    chooseCueOutputTarget: context => read('localWorkbench.cue.target', {}, context),
    previewCueSplit: (request, context) => read('localWorkbench.cue.preview', request, context),
    applyPlan: options.api.applyLocalWorkbenchPlan.bind(options.api),
    readOriginalReceipt: options.api.readLocalWorkbenchReceipt.bind(options.api),
    cancelApplication: options.api.cancelLocalWorkbenchPlan.bind(options.api),
    openExistingAction,
  }
}

/** 原结果只读接点：使用原job和原捕获，不进入查询、选择、prepare或当前保存状态。 */
export function createLocalWorkbenchResultReaders(options: {
  api: Pick<dto.LocalWorkbenchPublicApi, 'localLibraryManagement'> & Pick<dto.LocalAlbumLibraryPublicApi, 'getLocalAlbumTracks'> & {
    localLibraryLyrics<C extends dto.LocalLyricsCommand>(command:C,payload:dto.LocalLyricsCommandPayloads[C]):Promise<dto.LocalLyricsCommandResults[C]>
  }
  datasetId(): string | null
  generation(): number
  lyricsKeyCurrent(key: LocalWorkbenchLyricsResultKey): boolean
  libraryKeyCurrent(key: LocalWorkbenchLibraryResultKey): boolean
}) {
  const invalid = (): never => { throw new Error('原结果身份或读取上下文已变化；原任务继续保留。') }
  function fence(context: LocalWorkbenchPortContext, matches: () => boolean, expectedDataset?: string): () => void {
    const datasetId=options.datasetId(),generation=options.generation()
    const check=():void=>{
      if(context.signal.aborted)throw aborted()
      if(!datasetId||expectedDataset!==undefined&&datasetId!==expectedDataset||options.datasetId()!==datasetId||options.generation()!==generation||!matches())invalid()
    }
    check();return check
  }
  async function readLyricsEntry(key:LocalWorkbenchLyricsResultKey,context:LocalWorkbenchPortContext):Promise<LocalWorkbenchLyricsOriginalEntry|null> {
    const expected=structuredClone(key),check=fence(context,()=>options.lyricsKeyCurrent(expected),expected.library.datasetId)
    const value=await options.api.localLibraryLyrics('localLyrics.job.read',{jobId:expected.jobId,albumId:expected.albumId});check()
    if(!value||!localWorkbenchLyricsResultKeyMatches(expected,value,{commandId:expected.jobId,library:expected.library,embed:false})||!Object.hasOwn(value,'originalEntry'))return invalid()
    const entry=value.originalEntry
    if(entry===null)return null
    if(!dto.isLocalLyricsJobOriginalEntry(entry)||entry.scope.datasetId!==expected.library.datasetId||entry.scope.libraryId!==expected.library.libraryId||entry.scope.albumId!==expected.albumId)return invalid()
    // entry.captureId与库capture不同是合法原事实，不能用expected.library.captureId重造。
    return structuredClone(entry)
  }
  async function readLyricsFacts(key:LocalWorkbenchLyricsResultKey,entry:LocalWorkbenchLyricsOriginalEntry,context:LocalWorkbenchPortContext):Promise<{album:dto.LocalAlbumSummary;trackPage:dto.LocalAlbumTrackPage;capture:null}> {
    const expected=structuredClone(key),original=structuredClone(entry),check=fence(context,()=>options.lyricsKeyCurrent(expected),expected.library.datasetId)
    if(!dto.isLocalLyricsScope(original.scope)||original.scope.datasetId!==expected.library.datasetId||original.scope.libraryId!==expected.library.libraryId||original.scope.albumId!==expected.albumId)return invalid()
    const query={albumKey:original.scope.albumId,rootId:original.scope.libraryId,offset:0,limit:100}
    const page=await options.api.getLocalAlbumTracks(query);check()
    if(!dto.isLocalAlbumTrackPage(page,query,page.album))return invalid()
    // 原scope捕获key不证明专辑readToken；当前曲目页也不能签发该引用。
    return {album:structuredClone(page.album),trackPage:structuredClone(page),capture:null}
  }
  async function readLibraryResult(key:LocalWorkbenchLibraryResultKey,context:LocalWorkbenchPortContext):Promise<{album:dto.LocalAlbumSummary;trackPage:dto.LocalAlbumTrackPage;capture:dto.LocalWorkbenchCapture}> {
    const expected=structuredClone(key),check=fence(context,()=>options.libraryKeyCurrent(expected)),datasetId=options.datasetId()
    const request={jobId:expected.jobId,offset:0,limit:1,albumId:expected.albumId}
    const value=await options.api.localLibraryManagement('library.job.read',request);check()
    if(!value||!dto.isLocalLibraryManagementResult('library.job.read',value,request)||value.captureId!==expected.captureId||value.kind!==expected.kind)return invalid()
    const entry=value.originalEntry
    if(!dto.isLocalLibraryJobOriginalEntry(entry)||entry.datasetId!==datasetId||entry.album.albumId!==expected.albumId)return invalid()
    const query={albumKey:entry.album.albumId,rootId:entry.album.rootId!,offset:0,limit:100}
    const page=await options.api.getLocalAlbumTracks(query);check()
    if(!dto.isLocalAlbumTrackPage(page,query,page.album)||page.album.revision!==entry.album.revision||page.total!==entry.album.trackCount)return invalid()
    return {album:structuredClone(page.album),trackPage:structuredClone(page),capture:structuredClone(entry.capture)}
  }
  return {readLyricsEntry,readLyricsFacts,readLibraryResult}
}
