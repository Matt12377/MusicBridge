import { computed, ref, shallowRef, toRaw } from 'vue'
import { isLocalAiNameCandidate, isLocalWorkbenchAlbumRef, isLocalWorkbenchArtworkCandidate, isLocalWorkbenchPlan, isLocalWorkbenchReadback, isLocalWorkbenchReceipt, isLocalWorkbenchOperation, isLocalWorkbenchArtworkSearchReply, isLocalWorkbenchCommandPayload } from '@music-bridge/contracts'
import type {
  LocalAiAlbumResult, LocalAiBackend, LocalAiNameCandidate, LocalCueOutputTarget, LocalWorkbenchAction,
  LocalWorkbenchAlbumRef, LocalWorkbenchAlbumSnapshot, LocalWorkbenchApplyRequest, LocalWorkbenchArtworkCandidate,
  LocalWorkbenchAvailability, LocalWorkbenchCapability, LocalWorkbenchExistingAction, LocalWorkbenchOpenRequest,
  LocalWorkbenchOperation, LocalWorkbenchPlan, LocalWorkbenchPortContext, LocalWorkbenchPorts,
  LocalWorkbenchReadback, LocalWorkbenchReceipt, LocalWorkbenchItemResult, LocalWorkbenchCueRef, LocalWorkbenchFieldChange, LocalWorkbenchSaveParticipant, LocalWorkbenchPane, LocalWorkbenchArtworkSourceOutcome, LocalWorkbenchWebAction, LocalArtworkSearchSource,
} from './types.js'

export const LOCAL_WORKBENCH_ALBUM_LIMIT = 100
const text = (value: unknown, empty = false): value is string =>
  typeof value === 'string' && value.length <= 2048 && (empty || value.length > 0) && !/[\u0000-\u001f\u007f]/u.test(value)
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every(value => b.includes(value))
const unavailable = (reason: string): LocalWorkbenchAvailability => ({ available: false, reason })
function copy<T>(value: T): T { return structuredClone(toRaw(value)) }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
/** 图像只能消费作者规范化的公开图片副本，工作台不发任意图片网络请求。 */
export function isLocalWorkbenchPreviewUrl(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && value.length <= 1_500_000
    && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)
}
function validAlbum(value: LocalWorkbenchAlbumRef): boolean {
  return isLocalWorkbenchAlbumRef(value)
}
function validArtwork(value: LocalWorkbenchArtworkCandidate, albumId: string): boolean {
  return isLocalWorkbenchArtworkCandidate(value, albumId)
}
function validAiCandidate(value: LocalAiNameCandidate, albumId: string): boolean {
  return isLocalAiNameCandidate(value, albumId)
}
function safeFailure(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && 'publicMessage' in value && text(value.publicMessage)) return value.publicMessage
  return fallback
}

export const localWorkbenchFieldLabels = { title: '标题', artist: '艺术家', album: '专辑', year: '年份', disc: '碟号', track: '曲序' } as const
export const localWorkbenchResultLabels = { applied: '已应用', 'not-written': '未写入', failed: '失败', unknown: '结果未确认', cancelled: '已取消' } as const
export const localWorkbenchExistingActionLabels: Record<LocalWorkbenchExistingAction, string> = {
  'mb-info': '整理 MB 信息', 'source-tags': '预览源标签写回', 'source-cover': '预览源封面写回',
  rename: '预览文件改名', move: '预览文件移动', 'organizer-history': '整理与恢复历史',
  libraries: '音乐库与多库管理', 'scan-settings': '扫描并发设置', 'ai-settings': '智能解析设置',
  'scan-history': '读取上次扫描', 'scan-refresh': '扫描与局部刷新', finder: '在 Finder 中显示', lyrics: '歌词',
}

export interface LocalWorkbenchOptions {
  ports: LocalWorkbenchPorts
  makeCommandId?: () => string
  now?: () => number
  saveParticipants?: readonly LocalWorkbenchSaveParticipant[]
}

/** 读取/建议可取消；已派发应用独立保留原command，关闭面板不会伪造撤销。 */
export function useLocalLibraryWorkbench(options: LocalWorkbenchOptions) {
  const ports = options.ports, now = options.now ?? Date.now
  const makeCommandId = options.makeCommandId ?? (() => crypto.randomUUID())
  const isOpen = ref(false), action = ref<LocalWorkbenchPane>('overview')
  const albums = shallowRef<readonly LocalWorkbenchAlbumRef[]>([]), readback = shallowRef<LocalWorkbenchReadback | null>(null)
  const focusedAlbumId = ref(''), error = ref(''), notice = ref('')
  const loading = ref(false), lookingUp = ref(false), suggesting = ref(false), previewing = ref(false)
  const applying = ref(false), readingReceipt = ref(false), cancellingApplication = ref(false), delegating = ref(false)
  const artworkCandidates = shallowRef<readonly LocalWorkbenchArtworkCandidate[]>([])
  const artworkOutcomes = shallowRef<readonly LocalWorkbenchArtworkSourceOutcome[]>([]), artworkCountry = ref('US'), lastArtworkQuery = ref('')
  const webWindows=new Map<string,{datasetId:string;capture:string;query:string}>(),lastArtworkSourceId=ref('')
  const selectedArtworkId = ref<string | null>(null), comparisonIds = shallowRef<readonly string[]>([])
  const selectedArtworkDispatch = ref<string | null>(null)
  const aiResults = shallowRef<readonly LocalAiAlbumResult[]>([]), aiBackend = ref<LocalAiBackend>('ollama')
  const cueSelections = shallowRef<Readonly<Record<string, string>>>({})
  const cueFormat = ref(''), cueTarget = shallowRef<LocalCueOutputTarget | null>(null)
  const plan = shallowRef<LocalWorkbenchPlan | null>(null), operations = shallowRef<readonly LocalWorkbenchOperation[]>([])
  const resultCommandId = ref<string | null>(null)
  let generation = 0, receiptReadSequence = 0, abort: AbortController | null = null, disposed = false
  let delegatedPane: { owner: number; expected: LocalWorkbenchPane; next: LocalWorkbenchPane | null } | null = null
  const cancelCommands = new Map<string, string>()
  const leavePrompt = ref(false), savingAll = ref(false), discarding = ref(false)
  let pendingDeparture: (() => void) | null = null
  const participants = options.saveParticipants ?? []
  const hasPendingChanges = computed(() => selectedArtworkId.value !== null || selectedAiCount.value > 0
    || !!plan.value && !activeOperation.value || participants.some(value => value.pending.value))
  const leaveLocked = computed(() => applying.value || cancellingApplication.value || readingReceipt.value || savingAll.value || discarding.value
    || unresolvedOperations.value.length > 0 || participants.some(value => value.locked.value))
  function canLeave(): boolean { return !leaveLocked.value && !hasPendingChanges.value }
  function requestLeave(resume: () => void): boolean {
    if (canLeave()) return true
    pendingDeparture = resume; leavePrompt.value = true
    return false
  }
  function continueEditing(): void { pendingDeparture = null; leavePrompt.value = false }
  async function discardPending(): Promise<boolean> {
    if (leaveLocked.value) { error.value = '写入或原结果尚未确认，请停止并核对原回执后再离开。'; return false }
    discarding.value = true
    try {
      // 歌词由Owner先停止、实际join并保存discard记录；响应前保留当前页面与选择。
      for (const value of participants) if (!await value.discard()) return false
      if (disposed) return false
      cancelPreparation(); selectedArtworkId.value = null; selectedArtworkDispatch.value = null; comparisonIds.value = []; aiResults.value = []; plan.value = null
      return true
    } catch { error.value = '丢弃结果尚未确认，保留原目标，请核对原状态后再离开。'; return false }
    finally { discarding.value = false }
  }
  function finishDeparture(): void {
    if (!canLeave()) return
    const resume = pendingDeparture; pendingDeparture = null; leavePrompt.value = false; resume?.()
  }
  async function discardBeforeLeave(): Promise<void> { if (leavePrompt.value && await discardPending()) finishDeparture() }
  async function savePending(): Promise<boolean> {
    if (leaveLocked.value || busy.value) { error.value = '原任务仍在进行或结果未知，请先核对原回执。'; return false }
    const binding = readback.value ? canonical(readback.value.albums.map(value => value.capture)) : null
    // 封面先完成；同一context的歌词只能在原封面结果明确后保存。
    if (selectedArtworkId.value !== null) {
      await previewArtwork()
      if (plan.value?.kind !== 'artwork' || !canApply.value) return false
      await applyPreview()
      if (selectedArtworkId.value !== null || unresolvedOperations.value.length) return false
    }
    if (selectedAiCount.value > 0) {
      await previewAi(); if (plan.value?.kind !== 'ai' || !canApply.value) return false
      await applyPreview(); if (selectedAiCount.value > 0 || unresolvedOperations.value.length) return false
    }
    if (plan.value && !activeOperation.value) {
      if (!canApply.value) return false
      await applyPreview(); if (plan.value && !activeOperation.value || unresolvedOperations.value.length) return false
    }
    if (binding !== (readback.value ? canonical(readback.value.albums.map(value => value.capture)) : null)) { error.value = '保存目标已变化，保留当前待保存内容，请重新核对。'; return false }
    savingAll.value = true
    try { for (const value of participants) if (value.pending.value && !await value.save()) return false }
    finally { savingAll.value = false }
    return canLeave()
  }
  async function saveBeforeLeave(): Promise<void> { if (await savePending()) finishDeparture() }


  const busy = computed(() => loading.value || lookingUp.value || suggesting.value || previewing.value || applying.value
    || readingReceipt.value || cancellingApplication.value || delegating.value)
  const unresolvedOperations = computed(() => operations.value.filter(value => value.state === 'unknown' || value.state === 'running'))
  const mutationLocked = computed(() => busy.value || unresolvedOperations.value.length > 0)
  const canRevokeArtwork = computed(() => selectedArtworkId.value !== null && selectedArtworkDispatch.value === null
    && !mutationLocked.value && !leaveLocked.value && !activeOperation.value)
  const focusedAlbum = computed(() => readback.value?.albums.find(value => value.album.albumId === focusedAlbumId.value) ?? null)
  const visibleArtworkCandidates = computed(() => artworkCandidates.value.filter(value => value.albumId === focusedAlbumId.value))
  const selectedArtwork = computed(() => visibleArtworkCandidates.value.find(value => value.candidateId === selectedArtworkId.value) ?? null)
  const comparisonCandidates = computed(() => visibleArtworkCandidates.value.filter(value => comparisonIds.value.includes(value.candidateId)))
  const activeOperation = computed(() => plan.value ? operations.value.find(value => value.request.datasetId === plan.value!.datasetId
    && value.request.planId === plan.value!.planId && value.request.planHash === plan.value!.planHash) ?? null : null)
  const resultOperation = computed(() => activeOperation.value ?? operations.value.find(value => value.request.commandId === resultCommandId.value) ?? null)
  const selectedAiCount = computed(() => aiResults.value.filter(value => value.state === 'ready' && value.selectedCandidateId !== null).length)
  const aiCompleted = computed(() => aiResults.value.filter(value => !['queued', 'running'].includes(value.state)).length)
  const phase = computed(() => loading.value ? '正在读取' : suggesting.value ? '正在生成建议' : lookingUp.value ? '正在读取候选'
    : previewing.value ? '正在准备预览' : applying.value ? '正在应用'
      : activeOperation.value ? activeOperation.value.state === 'unknown' ? '等待原回执' : '逐项结果'
        : plan.value ? '等待明确应用' : '候选与建议')
  const canApply = computed(() => !!plan.value && plan.value.state === 'ready' && !mutationLocked.value && !activeOperation.value
    && Date.parse(plan.value.expiresAt) > now() && availability('apply').available)

  const backendOptions = computed(() => (['ollama', 'vllm', 'cloud'] as const).map(id => ports.aiBackends?.find(value => value.id === id)
    ?? { id, label: id === 'ollama' ? '本地 Ollama' : id === 'vllm' ? 'vLLM' : '云端 API', availability: unavailable('此模型后端尚未接入。') }))
  const artworkSources = computed<readonly LocalArtworkSearchSource[]>(() => {
    const originals = [
      { id: 'douban-itunes', label: '豆瓣 + iTunes 聚合', kind: 'aggregate' as const },
      { id: 'douban-web', label: '豆瓣网页', kind: 'web' as const },
      { id: 'bing-web', label: 'Bing 图片', kind: 'web' as const },
      { id: 'google-web', label: 'Google 图片', kind: 'web' as const },
    ]
    return [...(ports.artworkSources ?? []), ...originals.filter(value => !ports.artworkSources?.some(item => item.id === value.id))
      .map(value => ({ ...value, availability: unavailable('此原搜索来源尚未接入。') }))]
  })
  const artworkImportFormats = computed(() => {
    const originals = [
      { mime: 'image/jpeg', label: 'JPEG' }, { mime: 'image/png', label: 'PNG' },
      { mime: 'image/tiff', label: 'TIFF' }, { mime: 'image/webp', label: 'WebP' },
    ]
    return [...(ports.artworkImportFormats ?? []), ...originals.filter(value => !ports.artworkImportFormats?.some(item => item.mime === value.mime))
      .map(value => ({ ...value, availability: ['image/jpeg', 'image/png'].includes(value.mime)
        ? availability('artwork-drop') : unavailable('此原图片格式的归一化资格尚未接入。') }))]
  })
  const cueFormats = computed(() => {
    const originals = [
      { id: 'flac', label: 'FLAC' }, { id: 'alac', label: 'ALAC' }, { id: 'mp3', label: 'MP3' },
      { id: 'vorbis', label: 'Vorbis' }, { id: 'opus', label: 'Opus' }, { id: 'wavpack', label: 'WavPack' },
      { id: 'wav', label: 'PCM WAV' }, { id: 'aiff', label: 'PCM AIFF' },
    ]
    return [...(ports.cueFormats ?? []), ...originals.filter(value => !ports.cueFormats?.some(item => item.id === value.id))
      .map(value => ({ ...value, availability: unavailable('此原输出格式的编码与回读资格尚未接入。') }))]
  })

  function current(owner: number): boolean { return !disposed && isOpen.value && owner === generation }
  function context(): { owner: number; context: LocalWorkbenchPortContext } {
    abort?.abort(); abort = new AbortController()
    return { owner: ++generation, context: { signal: abort.signal } }
  }
  function availability(key: LocalWorkbenchCapability): LocalWorkbenchAvailability {
    const declared = ports.capabilities?.[key]
    if (declared?.available === false) return declared
    const wired: Record<LocalWorkbenchCapability, boolean> = {
      read: !!ports.readAlbums, 'artwork-local': !!ports.findArtworkCandidates, 'artwork-search': !!ports.searchArtworkCandidates,
      'artwork-file': !!ports.chooseArtworkFile, 'artwork-drop': !!ports.importArtworkBytes, 'artwork-preview': !!ports.previewArtwork,
      'ai-preview': !!ports.previewAi, 'cue-preview': !!ports.previewCueSplit && !!ports.chooseCueOutputTarget,
      apply: !!ports.applyPlan, receipt: !!ports.readOriginalReceipt, 'cancel-application': !!ports.cancelApplication,
      'existing-actions': !!ports.openExistingAction,
    }
    return wired[key] ? { available: true } : unavailable('此能力尚未接入，当前内容保留。')
  }
  function existingAvailability(key: LocalWorkbenchExistingAction): LocalWorkbenchAvailability {
    return ports.openExistingAction ? ports.existingActions?.[key] ?? unavailable('此原维护入口尚未接入。')
      : unavailable('此原维护入口尚未接入。')
  }
  function requireCapability(key: LocalWorkbenchCapability): boolean {
    const value = availability(key)
    if (!value.available) { error.value = value.reason; return false }
    return true
  }
  function editable(): boolean {
    if (mutationLocked.value) {
      if (unresolvedOperations.value.length) error.value = '原操作结果尚未确认，请先查询原回执；不会重复应用。'
      return false
    }
    return !disposed && isOpen.value
  }
  function onlineAlbum(albumId = focusedAlbumId.value): LocalWorkbenchAlbumSnapshot | null {
    const value = readback.value?.albums.find(item => item.album.albumId === albumId)
    if (!value || value.availability !== 'online') { error.value = '此专辑来源离线或读取身份尚未确认，请先恢复并重新读取。'; return null }
    return value
  }
  function clearPreview(): void { plan.value = null; notice.value = '' }
  function cancelPreparation(): void {
    abort?.abort(); abort = null; generation++
    loading.value = lookingUp.value = suggesting.value = previewing.value = false
    aiResults.value = aiResults.value.map(value => ['queued', 'running'].includes(value.state)
      ? { ...value, state: 'cancelled', message: '已取消建议读取；原字段保留。' } : value)
  }
  function close(): boolean {
    if (!canLeave()) { requestLeave(() => { close() }); return false }
    cancelPreparation(); receiptReadSequence++; isOpen.value = false; delegating.value = false;webWindows.clear()
    return true
  }
  function dispose(): void { cancelPreparation(); receiptReadSequence++; pendingDeparture = null; disposed = true; isOpen.value = false;webWindows.clear() }

  function validateReadback(value: LocalWorkbenchReadback, expected: readonly LocalWorkbenchAlbumRef[]): void {
    if (!isLocalWorkbenchReadback(value, { albums: expected })) throw new Error('读取合同无效')
    if (!value || !text(value.datasetId) || !text(value.snapshotId) || !Array.isArray(value.albums)
      || !sameSet(value.albums.map(item => item.album?.albumId), expected.map(item => item.albumId))) throw new Error('读取身份不一致')
    for (const item of value.albums) {
      const original = expected.find(value => value.albumId === item.album?.albumId)!
      if (!validAlbum(item.album) || !sameSet(item.album.trackIds, original.trackIds) || item.capture?.albumId !== original.albumId
        || !text(item.capture.readToken) || !['online', 'offline', 'unavailable'].includes(item.availability)
        || !Array.isArray(item.issues) || !item.issues.every((issue: string) => text(issue)) || !Array.isArray(item.cueSheets)
        || item.cueSheets.length > 100 || new Set(item.cueSheets.map((cue: LocalWorkbenchCueRef) => cue.cueId)).size !== item.cueSheets.length
        || item.cueSheets.some((cue: LocalWorkbenchCueRef) => !text(cue.cueId) || !text(cue.label) || typeof cue.eligible !== 'boolean'
          || cue.reason !== undefined && !text(cue.reason))
        || item.currentArtwork !== null && (!text(item.currentArtwork.label) || !isLocalWorkbenchPreviewUrl(item.currentArtwork.previewUrl))) throw new Error('专辑读取事实无效')
    }
  }
  async function read(): Promise<void> {
    if (busy.value || !isOpen.value || disposed || !requireCapability('read')) return
    const expected = albums.value, { owner, context: ctx } = context()
    loading.value = true; error.value = ''
    try {
      const value = await ports.readAlbums!({ albums: copy(expected) }, ctx)
      if (!current(owner)) return
      validateReadback(value, expected)
      if (unresolvedOperations.value.some(operation => operation.request.datasetId !== value.datasetId)) throw new Error('原命令工作库身份已变化')
      restoreOperations(value.pendingOperations, value.datasetId)
      readback.value = freeze(copy(value)); clearPreview()
      const selections: Record<string, string> = {}
      for (const album of value.albums) {
        const eligible = album.cueSheets.filter(item => item.eligible)
        if (eligible.length === 1) selections[album.album.albumId] = eligible[0]!.cueId
      }
      cueSelections.value = selections
      if (!focusedAlbumId.value || !value.albums.some(item => item.album.albumId === focusedAlbumId.value)) focusedAlbumId.value = value.albums[0]?.album.albumId ?? ''
    } catch (value) { if (current(owner)) error.value = safeFailure(value, '专辑读取失败，保留上次内容；请恢复来源后重新读取。') }
    finally { if (current(owner)) loading.value = false }
  }
  async function open(request: LocalWorkbenchOpenRequest, captured?: LocalWorkbenchReadback): Promise<void> {
    if (isOpen.value && !requestLeave(() => { void open(request, captured) })) return
    cancelPreparation(); receiptReadSequence++; applying.value = readingReceipt.value = cancellingApplication.value = delegating.value = false
    isOpen.value = true; action.value = request.action; error.value = ''; notice.value = ''
    readback.value = null; plan.value = null; artworkOutcomes.value = []; artworkCandidates.value = []; selectedArtworkId.value = null; comparisonIds.value = []
    selectedArtworkDispatch.value = null
    resultCommandId.value = null
    aiResults.value = []; cueTarget.value = null; cueSelections.value = {}
    if (!Array.isArray(request.albums) || request.albums.length < 1 || request.albums.length > LOCAL_WORKBENCH_ALBUM_LIMIT
      || request.albums.some(value => !validAlbum(value)) || new Set(request.albums.map(value => value.albumId)).size !== request.albums.length) {
      albums.value = []; focusedAlbumId.value = ''; error.value = '请明确选择 1 至 100 张专辑；选择身份需保持完整。'; return
    }
    albums.value = freeze(copy(request.albums)); focusedAlbumId.value = request.albums[0]!.albumId
    aiBackend.value = backendOptions.value.find(value => value.availability.available)?.id ?? 'ollama'
    cueFormat.value = cueFormats.value.find(value => value.availability.available)?.id ?? ''
    if (captured) {
      try {
        validateReadback(captured, request.albums); restoreOperations(captured.pendingOperations, captured.datasetId)
        readback.value = freeze(copy(captured))
        const eligible: Record<string,string> = {}
        for (const album of captured.albums) { const choices = album.cueSheets.filter(value => value.eligible); if (choices.length === 1) eligible[album.album.albumId] = choices[0]!.cueId }
        cueSelections.value = eligible
      } catch (cause) { error.value = safeFailure(cause, '作者捕获身份无效，尚未打开任何写入。') }
    } else await read()
  }
  function openLibrary(): void {
    if (isOpen.value && !requestLeave(openLibrary)) return
    cancelPreparation(); isOpen.value = true; action.value = 'library'; albums.value = []; readback.value = null
    focusedAlbumId.value = ''; plan.value = null; selectedArtworkId.value = null; artworkCandidates.value = []; artworkOutcomes.value = []; aiResults.value = []
    selectedArtworkDispatch.value = null
  }
  function setAction(next: LocalWorkbenchPane): void {
    // 原维护回调只暂存同次内部跳转，须等真实委托成功且原上下文仍有效。
    if (delegating.value) {
      if (delegatedPane && current(delegatedPane.owner) && next === delegatedPane.expected) delegatedPane.next = next
      return
    }
    if (!busy.value) {
      action.value = next; error.value = ''
    }
  }
  function focusAlbum(albumId: string): void {
    if (albumId !== focusedAlbumId.value && !requestLeave(() => focusAlbum(albumId))) return
    if (!busy.value && albums.value.some(value => value.albumId === albumId)) {
      focusedAlbumId.value = albumId; selectedArtworkId.value = null; comparisonIds.value = []; clearPreview(); error.value = ''
    }
  }
  function mergeArtwork(values: readonly LocalWorkbenchArtworkCandidate[], albumId: string): void {
    if (!Array.isArray(values) || values.length > 100 || !sameSet(values.map(value => value.candidateId), values.map(value => value.candidateId))
      || values.some(value => !validArtwork(value, albumId))) throw new Error('封面候选无效')
    const replacements = new Set(values.map(value => value.candidateId))
    artworkCandidates.value = freeze(copy([...artworkCandidates.value.filter(value => value.albumId !== albumId || !replacements.has(value.candidateId)), ...values]))
  }
  function webArtworkAvailability(sourceId:string,action:LocalWorkbenchWebAction,query?:string):LocalWorkbenchAvailability {
    const source=artworkSources.value.find(value=>value.id===sourceId)
    if(source?.kind!=='web')return unavailable('所选来源不是原网页端口。')
    const available=action==='navigate'?source.webActions?.navigate??source.availability:source.webActions?.[action]??unavailable('此原网页动作尚未接入。')
    if(!available.available||action!=='refresh')return available
    const album=focusedAlbum.value,original=album&&webWindows.get(canonical([readback.value?.datasetId,album.capture,sourceId]))
    return original&&album&&original.datasetId===readback.value?.datasetId&&original.capture===canonical(album.capture)
      &&(query===undefined||original.query===query.trim())?available:unavailable('请先打开同一专辑与搜索词的原网页。')
  }
  async function lookupArtwork(kind: 'local' | 'search' | 'file' | 'drop', input?: { query?: string; sourceId?: string; country?: string; webAction?:LocalWorkbenchWebAction; bytes?: Uint8Array; mime?: string; text?: string; webCaptureId?: string; label?: string }): Promise<void> {
    if (!editable()) return
    const capability = kind === 'local' ? 'artwork-local' : kind === 'search' ? 'artwork-search' : kind === 'file' ? 'artwork-file' : 'artwork-drop'
    const webAction=input?.webAction??'navigate'
    if(kind!=='search'||webAction==='navigate'){if(!requireCapability(capability))return}
    else if(!ports.searchArtworkCandidates){error.value='原网页读取端口尚未接入。';return}
    const album = onlineAlbum(), datasetId = readback.value?.datasetId
    if (!album || !datasetId) return
    if (kind === 'search') {
      const source = artworkSources.value.find(value => value.id === input?.sourceId)
      const available=source?.kind==='web'?webArtworkAvailability(source.id,webAction,input?.query):source?.availability
      if(source?.kind!=='web'&&webAction!=='navigate'){error.value='此来源不支持网页动作。';return}
      if(!available?.available||!text(input?.query)||input!.query!.trim().length>256){error.value=available?.available===false?available.reason:'请填写明确搜索词并选择可用来源。';return}
    }
    if (kind === 'drop' && input?.text === undefined && input?.webCaptureId === undefined) {
      const format = artworkImportFormats.value.find(value => value.mime === input?.mime)
      if (!format?.availability.available) { error.value = format?.availability.available === false ? format.availability.reason : '此图片格式的归一化资格尚未接入。'; return }
      if (!(input?.bytes instanceof Uint8Array) || input.bytes.length < 1 || input.bytes.length > 4 * 1024 * 1024 || !text(input.label)) {
        error.value = '请选择不超过 4 MB 的合格图片。'; return
      }
    }
    if (kind === 'drop' && input?.text !== undefined) {
      if (input.bytes !== undefined || input.mime !== undefined || !isLocalWorkbenchCommandPayload('localWorkbench.artwork.import', { datasetId, capture: album.capture, text: input.text, label: input.label, ...(input.webCaptureId ? { webCaptureId: input.webCaptureId } : {}) })) { error.value = '请明确拖入一张图片、图片data URI或HTTPS图片地址；不能传本地路径。'; return }
      if (input.text.startsWith('https:')) {
        try { const url = new URL(input.text); if (url.username || url.password || url.protocol !== 'https:') throw new Error('地址无效') }
        catch { error.value = '图片地址不能含登录凭据，请使用HTTPS图片地址。'; return }
      }
    }
    if (kind === 'drop' && input?.webCaptureId !== undefined && input.text === undefined
      && (input.bytes !== undefined || input.mime !== undefined || !isLocalWorkbenchCommandPayload('localWorkbench.artwork.import', { datasetId, capture: album.capture, webCaptureId: input.webCaptureId, label: input.label }))) {
      error.value = '网页拖图引用已失效，请从当前封面网页重新拖入。'; return
    }
    const { owner, context: ctx } = context(); lookingUp.value = true; error.value = ''
    const request = { datasetId, capture: copy(album.capture) }
    try {
      let values: readonly LocalWorkbenchArtworkCandidate[] = []
      if (kind === 'local') values = await ports.findArtworkCandidates!(request, ctx)
      else if (kind === 'search') {
        const reply = await ports.searchArtworkCandidates!({ ...request, query: input!.query!.trim(), sourceId: input!.sourceId!, country: (input!.country ?? artworkCountry.value).toUpperCase(), ...(input?.webAction?{webAction:input.webAction}:{}) }, ctx)
        if (!current(owner)) return
        if (!isLocalWorkbenchArtworkSearchReply(reply, album.album.albumId)) throw new Error('独立来源结果无效')
        values = reply.candidates; artworkOutcomes.value = freeze(copy([...artworkOutcomes.value.filter(value => !reply.sources.some(next => next.source === value.source)), ...reply.sources])); lastArtworkQuery.value = input!.query!.trim()
        lastArtworkSourceId.value=input!.sourceId!
        if(artworkSources.value.find(value=>value.id===input!.sourceId)?.kind==='web'){
          if(reply.sources.length!==1||reply.sources[0]?.status!=='opened'||reply.candidates.length)throw new Error('原网页动作回执无效')
          if(webAction!=='external'){
            const capture=canonical(album.capture),key=canonical([datasetId,album.capture,input!.sourceId])
            for(const [previous,value] of webWindows)if(value.datasetId===datasetId&&value.capture===capture)webWindows.delete(previous)
            if(webWindows.size>=24)webWindows.delete(webWindows.keys().next().value!)
            webWindows.set(key,{datasetId,capture,query:input!.query!.trim()})
          }
          if(webAction!=='navigate'){notice.value=webAction==='refresh'?'原网页已刷新，已有封面候选与保存计划保留。':'已由系统打开固定来源网页，已有封面候选与保存计划保留。';return}
        }
      }
      else if (kind === 'file') { const candidate = await ports.chooseArtworkFile!(request, ctx); if (candidate) values = [candidate] }
      else values = [await ports.importArtworkBytes!(input!.text !== undefined ? { ...request, text: input!.text, label: input!.label!, ...(input!.webCaptureId ? { webCaptureId: input!.webCaptureId } : {}) }
        : input!.webCaptureId !== undefined ? { ...request, webCaptureId: input!.webCaptureId, label: input!.label! }
          : { ...request, bytes: input!.bytes!.slice(), mime: input!.mime!, label: input!.label! }, ctx)]
      if (!current(owner)) return
      mergeArtwork(values, album.album.albumId); clearPreview()
      notice.value = values.length ? '候选已读取；选择和预览后再明确保存。' : kind === 'file' ? '已取消选图，当前封面保留。' : '此来源没有返回可用候选，当前封面保留。'
    } catch (value) { if (current(owner)) error.value = safeFailure(value, '封面候选读取失败，当前封面与已有候选保留。') }
    finally { if (current(owner)) lookingUp.value = false }
  }
  async function retryArtworkSource(source: LocalWorkbenchArtworkSourceOutcome['source'], country: string | null): Promise<void> {
    const sourceId = source==='web'?lastArtworkSourceId.value:artworkSources.value.find(value => value.id === source && value.availability.available)?.id
    if (!sourceId) { error.value = '此独立来源端口暂不可用，已有候选保留。'; return }
    await lookupArtwork('search', { query: lastArtworkQuery.value, sourceId, ...(country ? { country } : {}) })
  }
  function selectArtwork(candidateId: string): void {
    if (editable() && visibleArtworkCandidates.value.some(value => value.candidateId === candidateId)) {
      if (candidateId !== selectedArtworkId.value) selectedArtworkDispatch.value = null
      selectedArtworkId.value = candidateId; clearPreview(); error.value = ''
    }
  }
  function revokeArtwork(): void {
    if (!canRevokeArtwork.value || disposed || !isOpen.value) return
    // 只撤销尚未派发的封面草稿；歌词、AI、原图和原请求继续保留。
    selectedArtworkId.value = null; comparisonIds.value = []
    if (plan.value?.kind === 'artwork') clearPreview()
  }
  function toggleComparison(candidateId: string): void {
    if (busy.value || !visibleArtworkCandidates.value.some(value => value.candidateId === candidateId)) return
    comparisonIds.value = comparisonIds.value.includes(candidateId) ? comparisonIds.value.filter(value => value !== candidateId)
      : [...comparisonIds.value.slice(-1), candidateId]
  }
  function validatePlan(value: LocalWorkbenchPlan, kind: LocalWorkbenchPlan['kind'], expectedAlbumIds: readonly string[]): void {
    if (!isLocalWorkbenchPlan(value)) throw new Error('预览合同无效')
    if (!value || value.kind !== kind || value.datasetId !== readback.value?.datasetId || !text(value.planId) || !text(value.revision)
      || !text(value.planHash) || !text(value.contextFingerprint) || !Number.isFinite(Date.parse(value.expiresAt))
      || !Array.isArray(value.albumIds) || !sameSet(value.albumIds, expectedAlbumIds) || !['ready', 'blocked'].includes(value.state)
      || !Array.isArray(value.blockers) || value.blockers.some(item => !text(item)) || value.state === 'ready' && value.blockers.length
      || !Array.isArray(value.items) || !value.items.length || value.items.length > 9900
      || new Set(value.items.map(item => item.itemId)).size !== value.items.length
      || !sameSet([...new Set(value.items.map(item => item.albumId))], expectedAlbumIds)
      || value.items.some(item => !text(item.itemId) || !expectedAlbumIds.includes(item.albumId) || !text(item.label)
        || !Array.isArray(item.changes) || item.changes.some((change: LocalWorkbenchFieldChange) => !Object.hasOwn(localWorkbenchFieldLabels, change.field)
          || !text(change.reason) || change.before !== null && !text(change.before, true) || change.after !== null && !text(change.after, true)))) throw new Error('预览身份无效')
    if (kind === 'cue') {
      if (value.kind !== 'cue' || value.scope !== 'INDEPENDENT_OUTPUT' || value.sourceDisposition !== 'retain'
        || value.target?.independent !== true || value.target.choiceId !== cueTarget.value?.choiceId || !text(value.target.label)
        || !Array.isArray(value.tracks) || value.tracks.length !== value.items.length
        || !sameSet(value.tracks.map(track => track.itemId), value.items.map(item => item.itemId))
        || value.tracks.some(track => !Number.isSafeInteger(track.sequence) || track.sequence < 1 || !text(track.sourceLabel)
          || !Number.isSafeInteger(track.startFrame) || track.startFrame < 0 || !Number.isSafeInteger(track.frameCount) || track.frameCount < 1
          || !Number.isSafeInteger(track.sampleRate) || track.sampleRate < 1 || !Number.isSafeInteger(track.startFrame + track.frameCount)
          || !text(track.outputName) || /[\\/]/u.test(track.outputName) || !text(track.outputFormat))) throw new Error('独立输出预览无效')
    } else if (value.scope !== 'MB_ONLY') throw new Error('工作台预览不能授权源写')
    if (value.kind === 'artwork' && !['existing', 'create-on-apply'].includes(value.relationship)) throw new Error('封面关系预览无效')
  }
  async function runPreview(kind: LocalWorkbenchPlan['kind'], expectedAlbumIds: readonly string[], run: (context: LocalWorkbenchPortContext) => Promise<LocalWorkbenchPlan>): Promise<void> {
    const { owner, context: ctx } = context(); previewing.value = true; error.value = ''; plan.value = null
    try {
      const value = await run(ctx)
      if (!current(owner)) return
      validatePlan(value, kind, expectedAlbumIds); plan.value = freeze(copy(value))
      notice.value = value.state === 'blocked' ? '此计划有阻断项，尚未应用。' : '请核对以下变化，再明确应用。'
    } catch (value) { if (current(owner)) error.value = safeFailure(value, '预览暂时无法确认；尚未应用，候选与原文件保留。') }
    finally { if (current(owner)) previewing.value = false }
  }
  async function previewArtwork(): Promise<void> {
    if (!editable() || !requireCapability('artwork-preview')) return
    const album = onlineAlbum(), selected = selectedArtwork.value, datasetId = readback.value?.datasetId
    if (!album || !selected || !datasetId) return
    await runPreview('artwork', [album.album.albumId], ctx => ports.previewArtwork!({ datasetId, capture: copy(album.capture), candidateId: selected.candidateId }, ctx))
  }
  function setAiBackend(backend: LocalAiBackend): void {
    if (editable() && backendOptions.value.some(value => value.id === backend)) { aiBackend.value = backend; aiResults.value = []; clearPreview() }
  }
  function updateAi(albumId: string, patch: Partial<LocalAiAlbumResult>): void {
    aiResults.value = aiResults.value.map(value => value.albumId === albumId ? { ...value, ...patch } : value)
  }
  async function requestAiSuggestions(): Promise<void> {
    if (!editable()) return
    const backend = backendOptions.value.find(value => value.id === aiBackend.value)
    if (!backend?.availability.available || !ports.suggestAlbumName) { error.value = backend?.availability.available === false ? backend.availability.reason : '此模型后端尚未接入。'; return }
    if (!readback.value) { error.value = '请先读取明确选择的专辑。'; return }
    const source = readback.value, selectedBackend = aiBackend.value, { owner, context: ctx } = context()
    suggesting.value = true; error.value = ''; clearPreview()
    aiResults.value = source.albums.map(value => ({ albumId: value.album.albumId, state: 'queued', candidates: [], selectedCandidateId: null, message: null }))
    try {
      for (const album of source.albums) {
        if (!current(owner)) return
        if (album.availability !== 'online') { updateAi(album.album.albumId, { state: 'failed', message: '来源离线或读取不可用；原字段保留。' }); continue }
        updateAi(album.album.albumId, { state: 'running' })
        try {
          const result = await ports.suggestAlbumName({ datasetId: source.datasetId, capture: copy(album.capture), backend: selectedBackend }, ctx)
          if (!current(owner)) return
          if (!result || result.albumId !== album.album.albumId || !Array.isArray(result.candidates) || !result.candidates.length || result.candidates.length > 8
            || new Set(result.candidates.map(value => value.candidateId)).size !== result.candidates.length
            || result.candidates.some(value => !validAiCandidate(value, album.album.albumId))) throw new Error('模型候选无效')
          updateAi(album.album.albumId, { state: 'ready', candidates: freeze(copy(result.candidates)), message: null })
        } catch (value) {
          if (!current(owner)) return
          updateAi(album.album.albumId, { state: 'failed', candidates: [], message: safeFailure(value, '模型建议失败或内容无效；原字段保留，可重新请求。') })
        }
      }
      if (current(owner)) notice.value = '建议已逐项返回；选择候选并预览后再应用。失败项仍可见。'
    } finally { if (current(owner)) suggesting.value = false }
  }
  function selectAiCandidate(albumId: string, candidateId: string | null): void {
    if (!editable()) return
    const result = aiResults.value.find(value => value.albumId === albumId)
    if (!result || result.state !== 'ready' || candidateId !== null && !result.candidates.some(value => value.candidateId === candidateId)) return
    updateAi(albumId, { selectedCandidateId: candidateId }); clearPreview(); error.value = ''
  }
  async function previewAi(): Promise<void> {
    if (!editable() || !requireCapability('ai-preview') || !readback.value) return
    const selections = aiResults.value.filter(value => value.state === 'ready' && value.selectedCandidateId)
      .map(value => ({ albumId: value.albumId, candidateId: value.selectedCandidateId! }))
    if (!selections.length) { error.value = '请先选择实际返回的 AI 候选。'; return }
    const selectedIds = selections.map(value => value.albumId), source = readback.value
    const captures = source.albums.filter(value => selectedIds.includes(value.album.albumId)).map(value => copy(value.capture))
    await runPreview('ai', selectedIds, async ctx => {
      const value = await ports.previewAi!({ datasetId: source.datasetId, captures, selections }, ctx)
      if (!sameSet(value.candidateIds, selections.map(item => item.candidateId))) throw new Error('预览候选不一致')
      return value
    })
  }
  function selectCue(albumId: string, cueId: string): void {
    if (!editable()) return
    const album = readback.value?.albums.find(value => value.album.albumId === albumId)
    if (!album || cueId && !album.cueSheets.some(value => value.cueId === cueId && value.eligible)) return
    const next = { ...cueSelections.value }; if (cueId) next[albumId] = cueId; else delete next[albumId]
    cueSelections.value = next; clearPreview()
  }
  function setCueFormat(format: string): void {
    if (editable() && cueFormats.value.some(value => value.id === format && value.availability.available)) { cueFormat.value = format; clearPreview() }
  }
  async function chooseCueTarget(): Promise<void> {
    if (!editable() || !requireCapability('cue-preview')) return
    const { owner, context: ctx } = context(); previewing.value = true; error.value = ''
    try {
      const value = await ports.chooseCueOutputTarget!(ctx)
      if (!current(owner) || value === null) return
      if (!text(value.choiceId) || !text(value.label) || value.independent !== true) throw new Error('目标无效')
      cueTarget.value = freeze(copy(value)); clearPreview()
    } catch (value) { if (current(owner)) error.value = safeFailure(value, '独立输出目录尚未确认，原选择保留。') }
    finally { if (current(owner)) previewing.value = false }
  }
  async function previewCue(): Promise<void> {
    if (!editable() || !requireCapability('cue-preview') || !readback.value) return
    const source = readback.value, target = cueTarget.value
    const format = cueFormats.value.find(value => value.id === cueFormat.value)
    const selections = Object.entries(cueSelections.value).map(([albumId, cueId]) => ({ albumId, cueId }))
    if (!selections.length || !target || !format?.availability.available) { error.value = '请明确选择 CUE、合格输出格式与独立输出目录。'; return }
    const selectedIds = selections.map(value => value.albumId)
    const selected = source.albums.filter(value => selectedIds.includes(value.album.albumId))
    if (selected.some(value => value.availability !== 'online')) { error.value = '所选 CUE 来源离线，请恢复后再预览。'; return }
    await runPreview('cue', selectedIds, ctx => ports.previewCueSplit!({
      datasetId: source.datasetId, captures: selected.map(value => copy(value.capture)), cueSelections: selections,
      outputFormat: format.id, target: copy(target), sourceDisposition: 'retain',
    }, ctx))
  }
  function validateReceipt(receipt: LocalWorkbenchReceipt, operation: LocalWorkbenchOperation): void {
    if (!isLocalWorkbenchReceipt(receipt, operation.request, operation.plan)) throw new Error('原回执合同无效')
    const request = operation.request
    if (!receipt || receipt.commandId !== request.commandId || receipt.datasetId !== request.datasetId || receipt.planId !== request.planId
      || receipt.planHash !== request.planHash || !['succeeded', 'partial', 'failed', 'unknown', 'running', 'cancelled'].includes(receipt.state)
      || !Array.isArray(receipt.items) || !sameSet(receipt.items.map(value => value.itemId), operation.plan.items.map(value => value.itemId))
      || receipt.items.some(value => !operation.plan.items.some(item => item.itemId === value.itemId && item.albumId === value.albumId && item.label === value.label)
        || !Object.hasOwn(localWorkbenchResultLabels, value.state) || !text(value.label) || value.message !== null && !text(value.message))
      || receipt.state === 'succeeded' && receipt.items.some(value => value.state !== 'applied')) throw new Error('原回执身份无效')
  }
  function putOperation(value: LocalWorkbenchOperation): void {
    operations.value = operations.value.map(item => item.request.commandId === value.request.commandId ? freeze(copy(value)) : item)
  }
  function mergedReceipt(operation: LocalWorkbenchOperation, incoming: LocalWorkbenchReceipt): LocalWorkbenchOperation {
    const items = incoming.items.map(item => {
      const known = operation.receipt?.items.find(value => value.itemId === item.itemId)
      return item.state === 'unknown' && known && known.state !== 'unknown' ? known : item
    })
    const receipt = { ...incoming, items }, state = receipt.state === 'running' ? 'running'
      : items.some(item => item.state === 'unknown') ? 'unknown' : receipt.state
    return freeze(copy({ ...operation, receipt, state }))
  }
  function restoreOperations(pending: readonly LocalWorkbenchOperation[] | undefined, datasetId: string): void {
    // 缺字段/空列表不能清掉内存里尚未确认的原请求；整个回显先核完，再原子更新。
    if (pending === undefined) return
    const next = [...operations.value]
    for (const operation of pending) {
      if (!isLocalWorkbenchOperation(operation, datasetId) || !['unknown', 'running'].includes(operation.state)) throw new Error('持久原操作回显无效')
      const index = next.findIndex(value => value.request.commandId === operation.request.commandId)
      if (index < 0) {
        if (next.some(value => value.request.datasetId === datasetId && value.request.planId === operation.request.planId)) throw new Error('同一冻结计划不能恢复为新命令')
        next.push(freeze(copy(operation))); continue
      }
      const known = next[index]!
      if (canonical(known.request) !== canonical(operation.request) || canonical(known.plan) !== canonical(operation.plan)) throw new Error('持久回显改变了原命令或冻结计划')
      if (!['unknown', 'running'].includes(known.state) || operation.receipt === null) continue
      next[index] = mergedReceipt(known, operation.receipt)
    }
    operations.value = next
    if (!resultCommandId.value) resultCommandId.value = next.find(value => value.request.datasetId === datasetId && ['unknown', 'running'].includes(value.state))?.request.commandId ?? null
  }
  function receiveReceipt(value: LocalWorkbenchReceipt, operation: LocalWorkbenchOperation): void {
    validateReceipt(value, operation)
    const latest = operations.value.find(item => item.request.commandId === operation.request.commandId)
    // 已核到终态后，较早HTTP调用的迟到running/unknown不能使原操作倒退。
    if (latest && !['unknown', 'running'].includes(latest.state)) return
    // 批次标题不能掩盖尚未确认的单项；已完成/失败项继续保留，原命令继续可查询。
    putOperation(mergedReceipt(latest ?? operation, value))
    if (!['unknown', 'running'].includes(value.state) && !value.items.some(item => item.state === 'unknown')) {
      // 原终态来自作者已闭合回执；较早transport仍等待不能将该任务重新视为活跃writer。
      applying.value = false; cancellingApplication.value = false
    }
    if (value.state === 'succeeded' && plan.value?.planId === operation.plan.planId) {
      if (operation.plan.kind === 'artwork') { selectedArtworkId.value = null; comparisonIds.value = [] }
      if (operation.plan.kind === 'ai') aiResults.value = aiResults.value.map(item => operation.plan.albumIds.includes(item.albumId) ? { ...item, selectedCandidateId: null } : item)
    }
  }
  async function applyPreview(): Promise<void> {
    const value = plan.value
    if (!value || !editable() || !requireCapability('apply') || activeOperation.value) return
    if (value.state !== 'ready' || Date.parse(value.expiresAt) <= now()) { error.value = '计划已过期或存在阻断项，请重新读取并预览。'; return }
    const request: LocalWorkbenchApplyRequest = freeze({
      commandId: makeCommandId(), datasetId: value.datasetId, planId: value.planId,
      expectedRevision: value.revision, planHash: value.planHash, contextFingerprint: value.contextFingerprint, kind: value.kind,
    })
    if (!text(request.commandId) || operations.value.some(item => item.request.commandId === request.commandId)) { error.value = '原命令身份无法建立，尚未应用。'; return }
    const operation: LocalWorkbenchOperation = freeze({ request, plan: value, receipt: null, state: 'unknown' })
    if (value.kind === 'artwork' && selectedArtworkId.value !== null) selectedArtworkDispatch.value = request.commandId
    resultCommandId.value = request.commandId
    operations.value = [...operations.value, operation]; applying.value = true; error.value = ''
    const owner = generation
    try {
      const receipt = await ports.applyPlan!(copy(request))
      if (disposed) return
      receiveReceipt(receipt, operation)
      const latest = operations.value.find(item => item.request.commandId === operation.request.commandId)
      if (current(owner)) notice.value = latest?.state === 'succeeded' ? '原回执确认已应用，请核对逐项结果。'
        : latest?.state === 'unknown' || latest?.state === 'running' ? '原操作尚未确认，请查询同一原回执。' : '原回执已返回，请核对各项完成与失败。'
    } catch (value) {
      const latest = operations.value.find(item => item.request.commandId === operation.request.commandId)
      if (!disposed && latest && ['unknown', 'running'].includes(latest.state)) putOperation({ ...latest, state: 'unknown' })
      if (current(owner)) error.value = safeFailure(value, '应用结果尚未确认，原请求已保留；请查询原回执，不会重复应用。')
    } finally { if (current(owner)) applying.value = false }
  }
  async function readOriginalReceipt(commandId?: string): Promise<void> {
    if (readingReceipt.value || loading.value || lookingUp.value || previewing.value || disposed || !requireCapability('receipt')) return
    const operation = operations.value.find(value => value.request.commandId === commandId) ?? unresolvedOperations.value[0]
    if (!operation || !['unknown', 'running'].includes(operation.state)) return
    resultCommandId.value = operation.request.commandId
    const owner = generation, sequence = ++receiptReadSequence
    readingReceipt.value = true; error.value = ''
    try {
      const value = await ports.readOriginalReceipt!(copy(operation.request))
      if (disposed) return
      if (value === null) {
        if (current(owner) && sequence === receiptReadSequence) notice.value = '尚未查到原回执，原请求继续保留；没有重新应用。'
        return
      }
      receiveReceipt(value, operation)
      if (current(owner) && sequence === receiptReadSequence) notice.value = '已读取同一原命令的逐项结果。'
    } catch (value) { if (current(owner) && sequence === receiptReadSequence) error.value = safeFailure(value, '原回执暂时无法读取，原请求保留；没有重新应用。') }
    finally { if (sequence === receiptReadSequence) readingReceipt.value = false }
  }
  async function cancelApplication(commandId: string): Promise<void> {
    if (cancellingApplication.value || disposed || !requireCapability('cancel-application')) return
    const operation = unresolvedOperations.value.find(value => value.request.commandId === commandId)
    if (!operation || cancelCommands.has(commandId)) return
    resultCommandId.value = operation.request.commandId
    const cancelCommandId = makeCommandId()
    if (!text(cancelCommandId) || operations.value.some(value => value.request.commandId === cancelCommandId)
      || [...cancelCommands.values()].includes(cancelCommandId)) { error.value = '取消命令身份无法建立，尚未请求取消。'; return }
    cancelCommands.set(commandId, cancelCommandId)
    const owner = generation
    cancellingApplication.value = true; error.value = ''
    try {
      const result = await ports.cancelApplication!({ original: copy(operation.request), cancelCommandId })
      if (!disposed) receiveReceipt(result, operation)
    }
    catch (value) { if (current(owner)) error.value = safeFailure(value, '取消结果尚未确认；原任务和取消请求保留，请查询原回执。') }
    finally { if (current(owner)) cancellingApplication.value = false }
  }
  function resultItems(operation: LocalWorkbenchOperation): readonly LocalWorkbenchItemResult[] {
    return operation.receipt?.items ?? operation.plan.items.map(value => ({
      itemId: value.itemId, albumId: value.albumId, label: value.label, state: 'unknown', message: '尚未收到此项的原结果。',
    }))
  }
  async function openExisting(action: LocalWorkbenchExistingAction): Promise<boolean> {
    if (!editable()) return false
    const value = existingAvailability(action)
    if (!value.available) { error.value = value.reason; return false }
    const owner = generation
    const expected: LocalWorkbenchPane | null = action === 'lyrics' ? 'lyrics'
      : ['libraries', 'scan-settings', 'scan-history', 'scan-refresh'].includes(action) ? 'library' : null
    const pane = expected ? { owner, expected, next: null as LocalWorkbenchPane | null } : null
    delegatedPane = pane
    let opened = false
    delegating.value = true; error.value = ''
    try {
      const result = await ports.openExistingAction!({ action, albums: copy(albums.value) })
      if (!current(owner)) return false
      if (!result.opened) { error.value = result.reason; return false }
      opened = true
      if (!['lyrics', 'libraries', 'scan-settings', 'scan-history', 'scan-refresh'].includes(action)) close(); return true
    } catch (value) { if (current(owner)) error.value = safeFailure(value, '原维护流程暂时无法打开，当前选择保留。'); return false }
    finally {
      if (delegatedPane === pane) delegatedPane = null
      if (current(owner)) {
        delegating.value = false
        if (opened && pane?.next) setAction(pane.next)
      }
    }
  }

  return {
    leavePrompt, leaveLocked, savingAll, discarding, hasPendingChanges, canLeave, requestLeave, continueEditing, discardBeforeLeave, saveBeforeLeave, savePending, discardPending,
    isOpen, action, albums, readback, focusedAlbumId, focusedAlbum, error, notice, busy, loading, lookingUp, suggesting, previewing,
    applying, readingReceipt, cancellingApplication, mutationLocked, unresolvedOperations, phase, canApply, canRevokeArtwork, plan, operations, activeOperation, resultOperation,
    artworkOutcomes, artworkCountry, lastArtworkQuery, retryArtworkSource, artworkCandidates, visibleArtworkCandidates, selectedArtworkId, selectedArtwork, comparisonIds, comparisonCandidates, artworkSources, artworkImportFormats,
    aiResults, aiBackend, backendOptions, aiCompleted, selectedAiCount, cueSelections, cueFormat, cueTarget, cueFormats,
    availability, existingAvailability, open, openLibrary, read, close, dispose, cancelPreparation, setAction, focusAlbum,
    lookupArtwork, webArtworkAvailability, selectArtwork, revokeArtwork, toggleComparison, previewArtwork, setAiBackend, requestAiSuggestions, selectAiCandidate, previewAi,
    selectCue, setCueFormat, chooseCueTarget, previewCue, applyPreview, readOriginalReceipt, cancelApplication, resultItems, openExisting,
  }
}
export type LocalWorkbenchController = ReturnType<typeof useLocalLibraryWorkbench>
