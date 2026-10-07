import { computed, ref, shallowRef } from 'vue'
import {
  LOCAL_ARTWORK_INPUT_BYTES, isAlbumEdition, isCollectionId, isCommandOutboxOverview, isCommonsArtworkSource, isCoverArtArchiveSource,
  isLocalArtworkContext, isLocalArtworkQuery, isLocalArtworkSelection, isLocalCatalogText,
  type ApplyLocalArtworkSelection, type CommandOutboxOverview, type CommandOutboxPublicApi,
  type CreateLocalArtworkEdition, type LocalArtworkCandidate, type LocalArtworkContext, type LocalArtworkOrigin, type LocalArtworkSearchProvider,
  type LocalArtworkPublicApi, type LocalArtworkSelection, type LocalArtworkTarget,
} from '@music-bridge/contracts'

interface Options {
  api: LocalArtworkPublicApi & Partial<Pick<CommandOutboxPublicApi, 'getCommandOutbox'>>
  onApplied?: () => void
}
interface Pending<T> { request: T; datasetId: string | null; confirmed: 'succeeded' | 'rejected' | null }
const originLabels: Record<LocalArtworkOrigin, string> = { 'local-independent': '本地独立封面', embedded: '文件内嵌封面', manual: '手选图片', provider: '远程候选' }
const musicProvider = 'cover-art-archive-v1', commonsProvider = 'commons-cc0-v1'
const providerLabels: Record<LocalArtworkSearchProvider, string> = { 'cover-art-archive-v1': '音乐发行封面 · MusicBrainz / CAA', 'commons-cc0-v1': 'CC0 补充图库 · Wikimedia Commons' }
function supportedProviders(mode: LocalArtworkContext['remoteProvider']): LocalArtworkSearchProvider[] {
  return mode === 'music-and-commons-v1' ? [musicProvider, commonsProvider] : mode === musicProvider ? [musicProvider] : mode === commonsProvider ? [commonsProvider] : []
}
/** 只整理展示文本；来源发行记录不变成本地目录的发行或音质判定。 */
export function localArtworkCandidatePresentation(candidate: LocalArtworkCandidate | null | undefined) {
  const source = candidate?.remoteSource
  if (candidate?.provider === musicProvider && isCoverArtArchiveSource(source)) {
    return { label: [source.releaseTitle, source.artist || '艺人未提供', source.releaseDate ?? '日期未提供', source.country ?? '国家未提供'].join(' · '), origin: 'Cover Art Archive · 音乐发行封面', searchText: [source.releaseTitle, source.artist, source.releaseDate, source.country, source.releaseId].filter(Boolean).join(' '),
      notice: '封面权利状态未核实；仅用于 MusicBridge 显示，文件写回仍需独立整理计划。',
      fields: [
        { label: '发行', text: source.releaseTitle }, { label: '艺人', text: source.artist || '未提供' }, { label: '发行日期', text: source.releaseDate ?? '未提供' }, { label: '国家', text: source.country ?? '未提供' },
        { label: '来源发行页', text: source.releaseUrl }, { label: '来源发行身份', text: source.releaseId }, { label: '封面图片身份', text: source.imageId },
        { label: '前封面', text: source.front ? '是' : '否' }, { label: 'CAA 审核', text: `${source.approved ? '已审核' : '尚未审核'}（审核状态不代表图片许可）` },
        { label: '封面权利', text: '未核实' }, { label: '核心元数据许可', text: 'MusicBrainz 核心元数据为 CC0；不代表封面图片许可' }, { label: '来源图片版本', text: '原始封面；展示使用独立 JPEG 副本' },
      ] }
  }
  if (candidate?.provider === commonsProvider && isCommonsArtworkSource(source)) {
    return { label: candidate.sourceLabel, origin: 'Wikimedia Commons · CC0 补充图库', searchText: `${source.title} ${source.author ?? ''}`, notice: 'CC0 1.0 · 逐文件准入，其他许可不显示。',
      fields: [{ label: '作者文本', text: source.author ?? '未提供作者文本' }, { label: '来源文件页', text: source.title }, { label: '来源地址', text: source.descriptionUrl }, { label: '许可策略', text: 'CC0 1.0 · 逐文件准入' }, { label: '来源页面修订', text: String(source.pageRevision) }] }
  }
  return { label: candidate?.sourceLabel ?? '', origin: candidate ? originLabels[candidate.origin] : '', searchText: '', notice: '', fields: [] as Array<{ label: string; text: string }> }
}
const sameTarget = (a: LocalArtworkTarget | null, b: LocalArtworkTarget | null) => !!a && !!b
  && a.trackId === b.trackId && a.editionId === b.editionId
  && a.expectedEditionRevision === b.expectedEditionRevision && a.expectedTrackRevision === b.expectedTrackRevision
  && a.expectedSourceRevision === b.expectedSourceRevision

export function useLocalArtwork(options: Options) {
  const isOpen = ref(false), context = shallowRef<LocalArtworkContext | null>(null)
  const loading = ref(false), searching = ref(false), remoteSearching = ref(false), picking = ref(false), importing = ref(false)
  const applying = ref(false), creating = ref(false), error = ref(''), notice = ref('')
  const query = ref(''), remoteQuery = ref(''), origin = ref<LocalArtworkOrigin | 'all'>('all'), editionTitle = ref('')
  const remoteProvider = ref<LocalArtworkSearchProvider>(musicProvider)
  const selectedCandidateId = ref<string | null>(null), comparisonIds = ref<string[]>([])
  const pendingApply = shallowRef<ApplyLocalArtworkSelection | null>(null)
  const pendingEdition = shallowRef<CreateLocalArtworkEdition | null>(null), appliedCount = ref(0)
  let applyBinding: Pending<ApplyLocalArtworkSelection> | null = null, editionBinding: Pending<CreateLocalArtworkEdition> | null = null
  let trackId: string | null = null, editionId: string | null = null, datasetId: string | null = null, remoteQueryTarget: string | null = null
  let generation = 0, readGeneration = 0, lookupGeneration = 0, outboxGeneration = 0, disposed = false, datasetChanged = false
  const target = computed(() => context.value?.target ?? null)
  const remoteProviders = computed(() => [musicProvider, commonsProvider].map(value => ({ value: value as LocalArtworkSearchProvider, label: providerLabels[value as LocalArtworkSearchProvider], enabled: !!context.value && supportedProviders(context.value.remoteProvider).includes(value as LocalArtworkSearchProvider) })))
  const remoteEnabled = computed(() => !!context.value && supportedProviders(context.value.remoteProvider).includes(remoteProvider.value))
  const lookupBusy = computed(() => searching.value || remoteSearching.value || picking.value || importing.value)
  const busy = computed(() => loading.value || lookupBusy.value || applying.value || creating.value)
  const selectedCandidate = computed(() => context.value?.candidates.find(c => c.id === selectedCandidateId.value) ?? null)
  const filteredCandidates = computed(() => {
    const text = query.value.trim().toLocaleLowerCase()
    return (context.value?.candidates ?? []).filter(c => {
      const presentation = localArtworkCandidatePresentation(c)
      return (origin.value === 'all' || c.origin === origin.value)
        && (!text || `${c.sourceLabel} ${presentation.label} ${presentation.origin} ${presentation.searchText} ${c.original.sha256}`.toLocaleLowerCase().includes(text))
    })
  })
  const comparisonCandidates = computed(() => (context.value?.candidates ?? []).filter(c => comparisonIds.value.includes(c.id)))
  const canApply = computed(() => !!target.value && !!selectedCandidate.value && !busy.value && !pendingApply.value && !pendingEdition.value
    && Date.parse(selectedCandidate.value.expiresAt) > Date.now())
  const canRestoreDefault = computed(() => !!target.value && !busy.value && !pendingApply.value && !pendingEdition.value
    && context.value?.selection?.mode !== 'local-default')
  const current = (scope: number) => !disposed && isOpen.value && scope === generation
  const unknownMessage = '保存结果未确认，保留原请求与当前封面。请重新读取核对；不会自动重发。'

  function notifyApplied(): void {
    appliedCount.value++
    try { options.onApplied?.() } catch { notice.value = '封面选择已保存，列表刷新暂未完成，请稍后重新读取。' }
  }
  function receiveContext(value: unknown, expectedTrack: string, expectedEdition: string | null, lookupTarget?: LocalArtworkTarget): LocalArtworkContext {
    if (!isLocalArtworkContext(value) || value.trackId !== expectedTrack
      || expectedEdition !== null && value.target?.editionId !== expectedEdition
      || lookupTarget && !sameTarget(value.target, lookupTarget)) throw new Error('封面上下文身份不一致')
    return value
  }
  function putContext(value: LocalArtworkContext): void {
    context.value = value
    const key = value.target ? `${value.target.trackId}:${value.target.editionId}` : null
    const providers = supportedProviders(value.remoteProvider)
    if (key !== remoteQueryTarget || !providers.includes(remoteProvider.value)) remoteProvider.value = providers.includes(musicProvider) ? musicProvider : providers.includes(commonsProvider) ? commonsProvider : musicProvider
    if (key !== remoteQueryTarget) {
      remoteQueryTarget = key
      const title = value.editions.find(e => e.id === value.target?.editionId)?.title.trim().slice(0, 80).trim() ?? ''
      remoteQuery.value = isLocalArtworkQuery(title) ? title : ''
    }
    if (!value.candidates.some(c => c.id === selectedCandidateId.value)) selectedCandidateId.value = null
    comparisonIds.value = comparisonIds.value.filter(id => value.candidates.some(c => c.id === id))
  }
  function isRequestedSelection(selection: LocalArtworkSelection | null, request: ApplyLocalArtworkSelection): boolean {
    return !!selection && selection.editionId === request.target.editionId
      && selection.revision === String(BigInt(request.expectedSelectionRevision ?? '0') + 1n)
      && (request.candidateId === null ? selection.mode === 'local-default' : selection.mode === 'manual' && selection.candidate?.id === request.candidateId)
  }
  function terminal(overview: CommandOutboxOverview, binding: Pending<{ commandId: string }> | null, command: string) {
    if (!binding?.datasetId || overview.datasetId !== binding.datasetId || overview.datasetId !== datasetId) return null
    const entry = overview.entries.find(v => v.datasetId === binding.datasetId && v.commandId === binding.request.commandId && v.command === command)
    return entry?.state === 'succeeded' || entry?.state === 'rejected' ? entry.state : binding.confirmed
  }
  function applyTerminals(overview: CommandOutboxOverview, originalApply = applyBinding, originalEdition = editionBinding): boolean {
    let changed = false
    const applyState = terminal(overview, originalApply, 'localArtwork.apply')
    if (applyState && originalApply && applyBinding === originalApply && pendingApply.value === originalApply.request) {
      applyBinding = null; pendingApply.value = null; changed = true
      if (current(generation) && sameTarget(target.value, originalApply.request.target)) {
        error.value = applyState === 'rejected' ? '原封面选择请求已拒绝，请读取最新选择后再操作。' : ''
        notice.value = applyState === 'succeeded' ? '原保存命令已确认，正在读取当前封面。' : '原封面选择请求已拒绝；没有重发原请求。'
        if (applyState === 'succeeded') notifyApplied()
      }
    }
    const editionState = terminal(overview, originalEdition, 'localArtwork.createEdition')
    if (editionState && originalEdition && editionBinding === originalEdition && pendingEdition.value === originalEdition.request) {
      editionBinding = null; pendingEdition.value = null; changed = true
      if (current(generation) && trackId === originalEdition.request.trackId) {
        error.value = editionState === 'rejected' ? '原建立发行请求已拒绝，请重新读取后再操作。' : ''
        notice.value = editionState === 'succeeded' ? '原建立发行命令已确认，请从发行列表中明确选择。' : '原建立发行请求已拒绝；没有重复建立。'
      }
    }
    return changed
  }
  async function readOutbox(): Promise<boolean> {
    if (!options.api.getCommandOutbox || !isOpen.value || disposed) return false
    const scope = generation, reading = ++outboxGeneration, originalApply = applyBinding, originalEdition = editionBinding
    try {
      const overview = await options.api.getCommandOutbox()
      if (!current(scope) || reading !== outboxGeneration || !isCommandOutboxOverview(overview)) return false
      datasetId ??= overview.datasetId
      datasetChanged = overview.datasetId !== datasetId
      if (datasetChanged) { error.value = '工作库已变化，保留原工作库的选择与待确认请求；请返回原工作库核对。'; return false }
      return applyTerminals(overview, originalApply, originalEdition)
    } catch { return false }
  }
  function observeOutbox(overview: CommandOutboxOverview): void {
    if (disposed || !isCommandOutboxOverview(overview) || overview.datasetId !== datasetId) return
    if (applyBinding) applyBinding.confirmed = terminal(overview, applyBinding, 'localArtwork.apply')
    if (editionBinding) editionBinding.confirmed = terminal(overview, editionBinding, 'localArtwork.createEdition')
    if (isOpen.value && applyTerminals(overview)) { outboxGeneration++; void readContext() }
  }
  async function captureDataset(): Promise<string | null> {
    if (!options.api.getCommandOutbox) return null
    const overview = await options.api.getCommandOutbox()
    if (!isCommandOutboxOverview(overview)) throw new Error('工作库身份未确认')
    datasetId ??= overview.datasetId
    if (overview.datasetId !== datasetId) throw new Error('工作库已改变')
    return overview.datasetId
  }
  async function readContext(): Promise<void> {
    if (!trackId || !isOpen.value || disposed) return
    if (datasetChanged) { loading.value = false; return }
    const scope = generation, reading = ++readGeneration, originalTrack = trackId, originalEdition = editionId
    const previous = context.value
    loading.value = true; error.value = ''
    try {
      const result = await options.api.getLocalArtworkContext({ trackId: originalTrack, editionId: originalEdition })
      if (!current(scope) || reading !== readGeneration) return
      const value = receiveContext(result, originalTrack, originalEdition)
      putContext(value)
      const request = pendingApply.value
      if (request && sameTarget(value.target, request.target)) {
        error.value = unknownMessage
        if (isRequestedSelection(value.selection, request)) notice.value = '当前选择已核对，与原请求一致；原命令终态仍未确认。'
      } else if (pendingEdition.value?.trackId === originalTrack) error.value = '建立发行结果未确认，原请求保留。请核对发行列表与操作结果，不要重复建立。'
    } catch {
      if (current(scope) && reading === readGeneration) error.value = previous ? '封面刷新失败，保留上次成功读取的选择与候选。' : '封面暂时无法读取，请重试；已保存的选择保留。'
    } finally { if (current(scope) && reading === readGeneration) loading.value = false }
  }
  function cancelLookup(): void {
    lookupGeneration++; searching.value = false; remoteSearching.value = false; picking.value = false; importing.value = false
    const original = target.value
    if (original) void options.api.cancelLocalArtworkLookup({ ...original }).catch(() => { /* 取消失败也不能重新接收旧响应。 */ })
  }
  async function open(nextTrack: string, nextEdition: string | null = null): Promise<void> {
    if (disposed || !isCollectionId(nextTrack) || nextEdition !== null && !isCollectionId(nextEdition)) return
    const keep = trackId === nextTrack && editionId === nextEdition
    cancelLookup(); generation++; readGeneration++; outboxGeneration++
    isOpen.value = true; trackId = nextTrack; editionId = nextEdition
    error.value = ''; notice.value = ''; query.value = ''; origin.value = 'all'; selectedCandidateId.value = null; comparisonIds.value = []
    if (!keep) { context.value = null; editionTitle.value = ''; remoteQuery.value = ''; remoteQueryTarget = null; remoteProvider.value = musicProvider }
    const scope = generation
    await readOutbox()
    if (current(scope)) await readContext()
  }
  async function refresh(): Promise<void> {
    if (applying.value || creating.value || disposed || !isOpen.value) return
    cancelLookup()
    const scope = generation
    await readOutbox()
    if (current(scope)) await readContext()
  }
  async function reconcile(): Promise<void> {
    const original = pendingApply.value
    if (original && (trackId !== original.target.trackId || target.value?.editionId !== original.target.editionId)) {
      await open(original.target.trackId, original.target.editionId)
      return
    }
    const creation = pendingEdition.value
    if (creation && trackId !== creation.trackId) { await open(creation.trackId); return }
    await refresh()
  }
  function filter(text: string, source: LocalArtworkOrigin | 'all' = origin.value): void { query.value = text; origin.value = source }
  function selectCandidate(id: string): void {
    if (context.value?.candidates.some(c => c.id === id)) selectedCandidateId.value = id
  }
  function toggleComparison(id: string): void {
    if (!context.value?.candidates.some(c => c.id === id)) return
    if (comparisonIds.value.includes(id)) comparisonIds.value = comparisonIds.value.filter(value => value !== id)
    else if (comparisonIds.value.length < 2) comparisonIds.value = [...comparisonIds.value, id]
    else notice.value = '可同时比较两张候选，请先取消一张。'
  }
  async function lookup(kind: 'search' | 'remote' | 'pick' | 'drop', file?: File): Promise<void> {
    if (!target.value || busy.value || pendingApply.value || pendingEdition.value || !isOpen.value) return
    const remoteText = remoteQuery.value.trim()
    const provider = remoteProvider.value
    if (kind === 'remote') {
      if (!isLocalArtworkQuery(remoteText) || /[\u0000-\u001f\u007f]/u.test(remoteQuery.value)) { error.value = '请输入 1 至 80 个字符的搜索关键词，不接受网址或控制字符。'; return }
      if (!remoteEnabled.value) { error.value = '当前远程来源尚未启用，可选择可用来源、查找本地候选或手选图片。'; return }
    }
    const original = Object.freeze({ ...target.value }), scope = generation, operation = ++lookupGeneration
    const flag = kind === 'search' ? searching : kind === 'remote' ? remoteSearching : kind === 'pick' ? picking : importing
    flag.value = true; error.value = ''; notice.value = ''
    try {
      let result: LocalArtworkContext | null
      if (kind === 'drop') {
        if (!file || file.size <= 0 || file.size > LOCAL_ARTWORK_INPUT_BYTES) { error.value = '请选择不超过 4 MiB 的 PNG 或 JPEG 图片。'; return }
        if (!/\.(?:png|jpe?g)$/iu.test(file.name) || file.type && !['image/png', 'image/jpeg'].includes(file.type)) { error.value = '只接受 PNG 或 JPEG 图片。'; return }
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (!current(scope) || operation !== lookupGeneration || !sameTarget(target.value, original)) return
        if (bytes.byteLength !== file.size || bytes.byteLength > LOCAL_ARTWORK_INPUT_BYTES) { error.value = '图片读取大小不一致，请重新选择不超过 4 MiB 的图片。'; return }
        result = await options.api.importLocalArtworkBytes({ target: original, bytes })
      } else if (kind === 'remote') result = await options.api.searchLocalArtworkCandidates(Object.freeze({ target: original, query: remoteText, provider }))
      else result = await (kind === 'pick' ? options.api.chooseLocalArtworkFile(original) : options.api.findLocalArtworkCandidates(original))
      if (!current(scope) || operation !== lookupGeneration || !sameTarget(target.value, original) || result === null) return
      putContext(receiveContext(result, original.trackId, original.editionId, original))
      notice.value = kind === 'remote'
        ? context.value?.candidates.some(c => c.provider === provider) ? `${providerLabels[provider]}候选已读取，选择后点击“保存选图”。` : '本次没有可用的远程候选，当前已保存封面保留。可修改关键词或手选图片。'
        : context.value?.candidates.length ? '候选已读取，选择后点击“保存选图”。' : '没有可用的本地候选，可手选 PNG 或 JPEG 图片。'
    } catch {
      if (current(scope) && operation === lookupGeneration) error.value = kind === 'remote'
        ? '远程查图暂未完成，保留当前封面与已有候选。请稍后明确重试。'
        : '图片读取失败，保留当前封面与已有候选。请检查源文件或重新选择图片。'
    } finally { if (current(scope) && operation === lookupGeneration) flag.value = false }
  }
  const search = () => lookup('search'), searchRemote = () => lookup('remote'), pick = () => lookup('pick'), drop = (file: File) => lookup('drop', file)
  async function save(candidateId: string | null): Promise<void> {
    if (!target.value || busy.value || pendingApply.value || pendingEdition.value || !isOpen.value) return
    if (candidateId !== null && !context.value?.candidates.some(c => c.id === candidateId && Date.parse(c.expiresAt) > Date.now())) {
      error.value = '候选已失效，请重新读取后再选择。'; return
    }
    const original = Object.freeze({ ...target.value }), scope = generation
    const expectedSelectionRevision = context.value?.selection?.revision ?? null
    applying.value = true; error.value = ''; notice.value = ''; readGeneration++; cancelLookup()
    let binding: Pending<ApplyLocalArtworkSelection> | null = null
    try {
      const ownerDataset = await captureDataset()
      if (!current(scope) || !sameTarget(target.value, original)) return
      const request = Object.freeze({ commandId: crypto.randomUUID(), target: original, candidateId, expectedSelectionRevision })
      binding = { request, datasetId: ownerDataset, confirmed: null }; applyBinding = binding; pendingApply.value = request
      const result = await options.api.applyLocalArtworkSelection(request)
      if (disposed || applyBinding !== binding) return
      if (!isLocalArtworkSelection(result) || !isRequestedSelection(result, request)) throw new Error('封面保存回执不一致')
      applyBinding = null; pendingApply.value = null
      if (current(scope) && sameTarget(target.value, original) && context.value) {
        context.value = { ...context.value, selection: result }; notice.value = candidateId === null ? '已恢复本地默认封面。' : '封面选择已保存。'
        notifyApplied()
      }
    } catch {
      if (binding && applyBinding === binding) {
        if (current(scope)) error.value = unknownMessage
        const reconciled = await readOutbox()
        if (reconciled && current(scope)) await readContext()
      } else if (!binding && current(scope)) error.value = '工作库身份暂时无法核对，尚未派发封面保存。请重新读取。'
    } finally { applying.value = false }
  }
  const apply = () => selectedCandidateId.value === null ? Promise.resolve() : save(selectedCandidateId.value)
  const restoreDefault = () => save(null)
  async function createEdition(title = editionTitle.value): Promise<void> {
    if (!context.value || busy.value || pendingEdition.value || pendingApply.value || !isOpen.value) return
    const text = title.trim()
    if (!isLocalCatalogText(text)) { error.value = '请填写 1 至 512 个字符的独立发行名称。'; return }
    const original = context.value, scope = generation
    creating.value = true; error.value = ''; notice.value = ''; readGeneration++; cancelLookup()
    let binding: Pending<CreateLocalArtworkEdition> | null = null
    try {
      const ownerDataset = await captureDataset()
      if (!current(scope) || context.value?.trackId !== original.trackId || context.value.trackRevision !== original.trackRevision) return
      const request = Object.freeze({ commandId: crypto.randomUUID(), trackId: original.trackId, expectedTrackRevision: original.trackRevision, title: text })
      binding = { request, datasetId: ownerDataset, confirmed: null }; editionBinding = binding; pendingEdition.value = request
      const edition = await options.api.createLocalArtworkEdition(request)
      if (disposed || editionBinding !== binding) return
      if (!isAlbumEdition(edition)) throw new Error('独立发行回执不一致')
      editionBinding = null; pendingEdition.value = null
      if (current(scope)) { await open(original.trackId, edition.id); notice.value = '独立发行已建立，请查找候选或手选图片。' }
    } catch {
      if (binding && editionBinding === binding) {
        if (current(scope)) error.value = '建立发行结果未确认，保留原请求。请重新读取核对，不要重复建立。'
        const reconciled = await readOutbox()
        if (reconciled && current(scope)) await readContext()
      } else if (!binding && current(scope)) error.value = '工作库身份暂时无法核对，尚未派发建立发行。'
    } finally { creating.value = false }
  }
  function close(): void {
    cancelLookup(); generation++; readGeneration++; outboxGeneration++; isOpen.value = false; loading.value = false
    selectedCandidateId.value = null; comparisonIds.value = []
  }
  function dispose(): void { close(); disposed = true }
  return { isOpen, context, target, loading, searching, remoteSearching, remoteEnabled, picking, importing, applying, creating, lookupBusy, busy, error, notice,
    query, remoteQuery, remoteProvider, remoteProviders, providerLabels, origin, editionTitle, selectedCandidateId, selectedCandidate, filteredCandidates, comparisonIds, comparisonCandidates,
    pendingApply, pendingEdition, appliedCount, canApply, canRestoreDefault, open, refresh, reconcile, filter, selectCandidate,
    toggleComparison, search, searchRemote, pick, drop, apply, restoreDefault, createEdition, cancelLookup, observeOutbox, close, dispose, originLabels }
}
