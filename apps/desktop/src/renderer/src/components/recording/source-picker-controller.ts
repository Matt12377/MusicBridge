import type { CollectionMatrixRow, DigitalAlbumDetail, DigitalRuntime, Page, PhysicalLinksPublicApi, RoonLibraryItem, RoonLibraryPage, TypedIpcEvent } from '@music-bridge/contracts'

export type SourcePickerApi = Pick<PhysicalLinksPublicApi, 'searchPhysicalRoonAlbums' | 'getCollectionMatrix' | 'getDigitalAlbum' | 'getDigitalRuntime'> & {
  getRoonAlbumTracks(reference: string, page: { offset: number; limit: number }): Promise<RoonLibraryPage>
}
export type SourceTab = 'roon' | 'relations'
export interface SourceSelection { item: RoonLibraryItem; albumReference: string; digitalId?: string; stale: boolean }
export interface SourcePickerState {
  tab: SourceTab
  albums?: RoonLibraryPage
  matrix?: Page<CollectionMatrixRow>
  digital?: DigitalAlbumDetail
  runtime?: DigitalRuntime
  album?: RoonLibraryItem
  tracks?: RoonLibraryPage
  trackDigitalId?: string
  selected: readonly SourceSelection[]
  loading: boolean
  offline: boolean
  error: string
}
export const relationLabels = { exact: 'Exact · 用户确认同版', probable: 'Probable · 可能同版', related: 'Related · 相关版本' }
export const runtimeLabels = { available: '当前 Roon 链接可用', 'needs-resolution': '链接待重新定位，收藏关系已保留', unavailable: '当前 Roon 不可用，收藏关系已保留' }

export function matrixStatus(row: CollectionMatrixRow): string {
  if (row.digitalState === 'confirmed-missing') return 'Physical Only · 已确认没有数字版本'
  if (row.physicalState === 'confirmed-missing') return 'Digital Only · 已确认未收藏原版实物'
  if (!row.digitalId) return '数字版本未核实，不视为缺少'
  if (row.physicalState === 'unchecked') return '原版实物未核实，不视为缺少'
  return '已登记数字与实体关系'
}
export function relationSummary(detail: DigitalAlbumDetail) {
  const result = { exactCd: 0, exactCassette: 0, probable: 0, related: 0 }
  for (const { link, release } of detail.links) {
    if (link.relation === 'exact') {
      if (release.kind === 'cd') result.exactCd += release.quantity
      else if (release.kind === 'cassette') result.exactCassette += release.quantity
    } else result[link.relation] += release.quantity
  }
  return result
}
export function sourceTabForKey(current: SourceTab, key: string): SourceTab | undefined {
  if (key === 'Home') return 'roon'
  if (key === 'End') return 'relations'
  if (key === 'ArrowLeft' || key === 'ArrowRight') return current === 'roon' ? 'relations' : 'roon'
  return undefined
}
export function sourceRoonAvailability(event: TypedIpcEvent): boolean | undefined {
  if (event.event !== 'core.ready' && event.event !== 'core.health' && event.event !== 'roon.changed') return undefined
  return event.payload.state.runtime === 'ready' && ['paired', 'ready'].includes(event.payload.state.roon)
}

/** 只持有本次对话框的运行期引用；不写库存、关系或草稿。 */
export class SourcePickerController {
  state: SourcePickerState = { tab: 'roon', selected: [], loading: false, offline: false, error: '' }
  private alive = true
  private generation = 0
  private connectionGeneration = 0
  private localRead = false
  constructor(private readonly api: SourcePickerApi, private readonly changed: (state: SourcePickerState) => void = () => {}) {}
  private patch(update: Partial<SourcePickerState>): void {
    if (!this.alive) return
    this.state = { ...this.state, ...update }
    this.changed(this.state)
  }
  private current(token: number): boolean { return this.alive && token === this.generation }
  private begin(update: Partial<SourcePickerState> = {}, localRead = false): number {
    const token = ++this.generation
    this.localRead = localRead
    this.patch({ loading: true, error: '', ...update })
    return token
  }
  private invalidateDigital(id: string, reference?: string): void {
    const selected = this.state.selected.map(selection => selection.digitalId === id && (!reference || selection.albumReference !== reference) ? { ...selection, stale: true } : selection)
    this.patch({ selected })
  }
  private acceptRuntime(id: string, runtime: DigitalRuntime): void {
    this.invalidateDigital(id, runtime.status === 'available' ? runtime.reference : undefined)
    if (this.state.digital?.album.id === id) this.patch({ runtime })
  }
  setTab(tab: SourceTab): void {
    if (this.state.tab === tab) return
    ++this.generation
    this.localRead = false
    this.patch({ tab, album: undefined, tracks: undefined, trackDigitalId: undefined, loading: false, error: '' })
  }
  async loadAlbums(query: string, offset = 0): Promise<void> {
    const token = this.begin({ album: undefined, tracks: undefined, trackDigitalId: undefined, albums: undefined })
    try {
      if (this.state.offline) throw new Error('Roon 离线')
      const albums = await this.api.searchPhysicalRoonAlbums(query, { offset, limit: 20 })
      if (this.current(token)) this.patch({ albums })
    } catch {
      if (this.current(token)) this.patch({ error: 'Roon 专辑暂时不可用，请检查连接后重试。未确认选曲不会保存。' })
    } finally { if (this.current(token)) this.patch({ loading: false }) }
  }
  async loadMatrix(query: string, offset = 0): Promise<void> {
    const token = this.begin({ digital: undefined, runtime: undefined, album: undefined, tracks: undefined, matrix: undefined }, true)
    try {
      const matrix = await this.api.getCollectionMatrix({ offset, limit: 24 }, query)
      if (this.current(token)) this.patch({ matrix })
    } catch {
      if (this.current(token)) this.patch({ error: '收藏关系暂时无法读取，请重试。读取失败不代表没有收藏。' })
    } finally { if (this.current(token)) this.patch({ loading: false }) }
  }
  async openDigital(id: string): Promise<void> {
    const previous = this.state.digital?.album.id === id ? this.state.digital : undefined
    const token = this.begin({ digital: previous, runtime: undefined, album: undefined, tracks: undefined, trackDigitalId: undefined }, true)
    let detailRead = false
    try {
      const digital = await this.api.getDigitalAlbum(id)
      if (!this.current(token)) return
      if (digital.album.id !== id) throw new Error('本地对象不一致')
      detailRead = true
      this.patch({ digital })
      const connection = this.connectionGeneration
      const runtime = this.state.offline ? { status: 'unavailable' as const } : await this.api.getDigitalRuntime(id)
      if (this.current(token) && connection === this.connectionGeneration) this.acceptRuntime(id, runtime)
    } catch {
      if (this.current(token)) {
        this.invalidateDigital(id)
        this.patch({ error: detailRead ? 'Roon 运行状态暂时无法读取；本地收藏关系已保留，请刷新关联状态。' : '收藏详情暂时无法读取，请重试；不推测专辑身份。' })
      }
    } finally { if (this.current(token)) this.patch({ loading: false }) }
  }
  async loadRoonTracks(album: RoonLibraryItem, offset = 0): Promise<void> {
    const token = this.begin({ album, tracks: undefined, trackDigitalId: undefined })
    try {
      if (this.state.offline) throw new Error('Roon 离线')
      const tracks = await this.api.getRoonAlbumTracks(album.reference, { offset, limit: 30 })
      if (this.current(token)) this.patch({ tracks })
    } catch {
      if (this.current(token)) this.patch({
        selected: this.state.selected.map(selection => selection.albumReference === album.reference ? { ...selection, stale: true } : selection),
        error: '曲目无法读取，可能是 Roon 链接已失效。请重新浏览专辑。',
      })
    } finally { if (this.current(token)) this.patch({ loading: false }) }
  }
  async loadRelationTracks(offset = 0): Promise<void> {
    const digital = this.state.digital
    if (!digital) return
    const id = digital.album.id
    const token = this.begin({ tracks: undefined, trackDigitalId: id })
    try {
      const runtime = this.state.offline ? { status: 'unavailable' as const } : await this.api.getDigitalRuntime(id)
      if (!this.current(token)) return
      this.acceptRuntime(id, runtime)
      if (runtime.status !== 'available' || !runtime.reference) {
        this.patch({ album: undefined, error: '当前 Roon 引用不可用；收藏关系已保留。请在收藏页明确处理连接或重新定位。' })
        return
      }
      const reference = runtime.reference
      this.patch({ album: { ...digital.album.metadata, reference, kind: 'album' } })
      const tracks = await this.api.getRoonAlbumTracks(reference, { offset, limit: 30 })
      if (!this.current(token)) return
      // 请求期间也可能撤权、断线或换引用，不能把迟到曲目当作当前结果。
      const current = await this.api.getDigitalRuntime(id)
      if (!this.current(token)) return
      this.acceptRuntime(id, current)
      if (current.status !== 'available' || current.reference !== reference) {
        this.patch({ album: undefined, error: 'Roon 引用已变化或失效；请重新核对关联状态，未恢复旧曲目。' })
        return
      }
      this.patch({ tracks })
    } catch {
      if (this.current(token)) {
        this.invalidateDigital(id)
        this.patch({ runtime: undefined, error: '关联曲目或 Roon 运行状态无法读取，请刷新关联状态；本地关系已保留。' })
      }
    } finally { if (this.current(token)) this.patch({ loading: false }) }
  }
  backFromTracks(): void {
    ++this.generation
    this.localRead = false
    this.patch({ album: undefined, tracks: undefined, trackDigitalId: undefined, loading: false, error: '' })
  }
  backToMatrix(): void {
    this.backFromTracks()
    this.patch({ digital: undefined, runtime: undefined })
  }
  toggle(item: RoonLibraryItem, checked: boolean): void {
    if (!this.alive) return
    const existing = this.state.selected.find(selection => selection.item.reference === item.reference)
    if (!checked) { this.patch({ selected: this.state.selected.filter(selection => selection.item.reference !== item.reference) }); return }
    const current = this.state.tracks?.items.find(track => track.reference === item.reference && track.kind === 'track')
    if (!current || !this.state.album || this.state.loading || this.state.offline || (!existing && this.state.selected.length >= 100)) return
    if (existing && !existing.stale) return
    const selection: SourceSelection = { item: current, albumReference: this.state.album.reference, digitalId: this.state.trackDigitalId, stale: false }
    this.patch({ selected: existing ? this.state.selected.map(entry => entry === existing ? selection : entry) : [...this.state.selected, selection] })
  }
  selectedReferences(): string[] {
    if (!this.alive || this.state.offline || this.state.selected.some(selection => selection.stale)) return []
    return this.state.selected.map(selection => selection.item.reference)
  }
  async validateSelection(): Promise<boolean> {
    if (!this.selectedReferences().length || this.state.loading) return false
    const token = this.begin()
    const selected = this.state.selected
    try {
      const ids = [...new Set(selected.flatMap(selection => selection.digitalId ? [selection.digitalId] : []))]
      for (const id of ids) {
        const runtime = await this.api.getDigitalRuntime(id)
        if (!this.current(token)) return false
        this.acceptRuntime(id, runtime)
      }
      return this.current(token) && this.selectedReferences().length === selected.length
    } catch {
      if (this.current(token)) this.patch({ selected: this.state.selected.map(selection => selection.digitalId ? { ...selection, stale: true } : selection), error: '所选关系的 Roon 状态无法核实，请重新读取并选择曲目。' })
      return false
    } finally { if (this.current(token)) this.patch({ loading: false }) }
  }
  setRoonAvailable(available: boolean): void {
    if (available) { this.patch({ offline: false }); return }
    ++this.connectionGeneration
    // 本地矩阵和详情独立于 Roon；只取消运行期目录、曲目与确认读取。
    if (!this.localRead) ++this.generation
    this.patch({ offline: true, loading: this.localRead && this.state.loading, albums: undefined, tracks: undefined, runtime: this.state.digital ? { status: 'unavailable' } : undefined,
      selected: this.state.selected.map(selection => ({ ...selection, stale: true })),
      error: 'Roon 当前不可用；收藏关系和选择顺序已保留。旧选择需重新读取并勾选，不能直接加入草稿。',
    })
  }
  dispose(): void { this.alive = false; ++this.generation }
}
