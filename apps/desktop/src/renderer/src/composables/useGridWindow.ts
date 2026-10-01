import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { createGridRows, gridWindowIndices, gridRowAt } from './gridWindow.js'

export interface GridWindowOptions<T> {
  profile?: (item: T) => string
  prepareProbe?: (element: HTMLElement, item: T) => void
  enabled?: () => boolean
}
/** 与原CSS网格使用相同列宽和逐行最大高度。无图像/IPC的少量probe覆盖所有当前布局变体。 */
export function useGridWindow<T>(items: Readonly<Ref<readonly T[]>>, root: Ref<HTMLElement | null>, options: GridWindowOptions<T> = {}) {
  const layout = ref({ columns: 4, width: 920, columnGap: 24, rowGap: 28 })
  const viewport = ref({ start: 0, end: 620 })
  let trackWidths: number[] = [], trackLefts: number[] = [], declaredTracks = ''
  const revision = ref(0), focused = ref<number>(), heights = new Map<string, number>()
  const observedCards = new Set<HTMLElement>()
  let scrollRoot: HTMLElement | null = null, resize: ResizeObserver | undefined, disposed = false, queued = false
  const profile = (item: T) => options.profile?.(item) ?? 'default'
  const profiles = computed(() => items.value.map(profile))
  const representatives = computed(() => {
    const unique = new Map<string, { item: T; index: number }>()
    items.value.forEach((item, index) => { const key = `${index % layout.value.columns}:${profiles.value[index]}`; if (!unique.has(key)) unique.set(key, { item, index }) })
    return [...unique.values()]
  })
  const rows = computed(() => {
    void revision.value
    return createGridRows(items.value.map((_item, index) => heights.get(measurementKey(index)) ?? 280), layout.value.columns, layout.value.rowGap)
  })
  const enabled = () => options.enabled?.() !== false
  const indices = computed(() => enabled() ? gridWindowIndices(rows.value, items.value.length, viewport.value.start, viewport.value.end, 2, focused.value) : items.value.map((_item, i) => i))
  const columnWidth = (index = 0) => trackWidths[index % layout.value.columns] ?? Math.max(1, (layout.value.width - (layout.value.columns - 1) * layout.value.columnGap) / layout.value.columns)
  const measurementKey = (index: number) => `${columnWidth(index)}:${profiles.value[index]}`
  const columnLeft = (index: number) => trackLefts[index % layout.value.columns] ?? Array.from({ length: index % layout.value.columns }, (_v, column) => columnWidth(column) + layout.value.columnGap).reduce((sum, value) => sum + value, 0)
  const rendered = computed(() => indices.value.map(index => {
    const row = Math.floor(index / layout.value.columns)
    return { item: items.value[index]!, index, style: enabled() ? { position: 'absolute' as const, top: `${rows.value.tops[row]}px`, left: `${columnLeft(index)}px`, width: `${columnWidth(index)}px`, height: `${rows.value.heights[row]}px` } : undefined }
  }))
  const rootStyle = computed(() => enabled() ? { position: 'relative' as const, height: `${rows.value.totalHeight}px` } : undefined)
  const attrs = computed(() => ({ 'data-grid-window': enabled() ? 'true' : 'false', 'data-grid-start': indices.value[0] ?? 0, 'data-grid-end': (indices.value.at(-1) ?? -1) + 1, 'data-grid-columns': layout.value.columns, 'data-grid-total-height': rows.value.totalHeight, 'data-grid-rendered': indices.value.length, 'data-grid-measured': heights.size > 0 ? 'true' : 'false' }))

  // 测量副本从不克隆IMG/SOURCE，避免在移除前启动额外图片请求/解码。
  function cloneWithoutImages(element: Node): Node {
    const copy = element.cloneNode(false)
    for (const child of element.childNodes) if (!(child instanceof Element && /^(IMG|SOURCE)$/.test(child.tagName))) copy.appendChild(cloneWithoutImages(child))
    return copy
  }
  function measure(): void {
    queued = false
    const element = root.value
    if (disposed || !element || typeof element.getBoundingClientRect !== 'function' || typeof getComputedStyle !== 'function' || !enabled()) return
    if (!scrollRoot) {
      scrollRoot = element.closest<HTMLElement>('.content-scroll')
      scrollRoot?.addEventListener('scroll', schedule, { passive: true })
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(schedule); resize.observe(element); if (scrollRoot) resize.observe(scrollRoot); if (element.parentElement) resize.observe(element.parentElement)
      }
    }
    const css = getComputedStyle(element), width = element.getBoundingClientRect().width
    const tracks = css.gridTemplateColumns.split(/\s+/).filter(value => /^\d+(?:\.\d+)?px$/.test(value)).map(Number.parseFloat), columns = tracks.length || 1
    const columnGap = Number.parseFloat(css.columnGap) || 0, rowGap = Number.parseFloat(css.rowGap) || 0
    if (width <= 0) return
    if (layout.value.width !== width || layout.value.columns !== columns || layout.value.columnGap !== columnGap || tracks.join(',') !== declaredTracks) heights.clear()
    if (tracks.join(',') !== declaredTracks || layout.value.width !== width) { trackWidths = tracks; trackLefts = [] }
    declaredTracks = tracks.join(',')
    const port = scrollRoot?.getBoundingClientRect(), offset = port ? element.getBoundingClientRect().top - port.top - (scrollRoot?.clientTop ?? 0) + (scrollRoot?.scrollTop ?? 0) : 0
    const start = (scrollRoot?.scrollTop ?? 0) - offset, end = start + (scrollRoot?.clientHeight ?? 620)
    const previous = layout.value
    if (previous.width !== width || previous.columns !== columns || previous.columnGap !== columnGap || previous.rowGap !== rowGap) layout.value = { columns, width, columnGap, rowGap }
    if (viewport.value.start !== start || viewport.value.end !== end) viewport.value = { start, end }
    const oldRows = rows.value, anchorRow = gridRowAt(oldRows, Math.max(0, start)), anchorIndex = anchorRow * columns, anchorOffset = start - (oldRows.tops[anchorRow] ?? 0)
    const prototype = element.querySelector<HTMLElement>('[data-grid-index]')
    let changed = false
    if (prototype) for (const { index, item } of representatives.value) {
      const key = measurementKey(index); if (heights.has(key)) continue
      const probe = cloneWithoutImages(prototype) as HTMLElement
      probe.removeAttribute('data-grid-index'); probe.setAttribute('data-grid-probe', 'true'); probe.setAttribute('aria-hidden', 'true'); probe.setAttribute('inert', '')
      probe.querySelectorAll('img,source').forEach(image => image.remove())
      probe.querySelectorAll('[src],[srcset]').forEach(image => { image.removeAttribute('src'); image.removeAttribute('srcset') })
      Object.assign(probe.style, { position: 'relative', top: 'auto', left: 'auto', width: 'auto', height: 'auto', gridColumn: String(index % columns + 1), gridRow: '1', alignSelf: 'start', visibility: 'hidden', pointerEvents: 'none', transform: 'none' })
      options.prepareProbe?.(probe, item); element.append(probe)
      const rect = probe.getBoundingClientRect(), height = rect.height
      if (rect.width > 0) { trackWidths[index % columns] = rect.width; trackLefts[index % columns] = rect.left - element.getBoundingClientRect().left }
      probe.remove()
      if (height > 0) { heights.set(measurementKey(index), height); changed = true }
    }
    if (changed) {
      revision.value++
      const newRow = Math.floor(anchorIndex / columns), nextTop = rows.value.tops[newRow]
      if (scrollRoot && start > 0 && nextTop !== undefined) { const shift = nextTop + anchorOffset - start; if (Math.abs(shift) > .5) { scrollRoot.scrollTop += shift; schedule() } }
    }
    // 实际行校正只测窗口内的少量元素；不扫描未挂载5000张卡片。
    const cards = new Set(element.querySelectorAll<HTMLElement>('[data-grid-index]'))
    for (const card of observedCards) if (!cards.has(card)) { resize?.unobserve(card); observedCards.delete(card) }
    for (const card of cards) if (!observedCards.has(card)) { resize?.observe(card); observedCards.add(card) }
  }
  function schedule(): void {
    if (disposed || queued) return
    queued = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measure)
    else void nextTick(measure)
  }
  function onFocusIn(event: FocusEvent): void {
    const card = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-grid-index]')
    if (card) focused.value = Number(card.dataset.gridIndex)
  }
  function onFocusOut(): void {
    void nextTick(() => { if (!root.value?.contains?.(typeof document === 'undefined' ? null : document.activeElement)) focused.value = undefined })
  }
  function focusable(card: HTMLElement): HTMLElement[] {
    const selector = 'button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]'
    return [...(card.matches(selector) ? [card] : []), ...card.querySelectorAll<HTMLElement>(selector)]
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !enabled()) return
    const target = event.target as HTMLElement, card = target.closest<HTMLElement>('[data-grid-index]'); if (!card) return
    const current = Number(card.dataset.gridIndex), buttons = focusable(card), boundary = event.shiftKey ? buttons[0] : buttons.at(-1)
    if (target !== boundary) return
    const next = current + (event.shiftKey ? -1 : 1)
    if (next < 0 || next >= items.value.length || indices.value.includes(next)) return
    event.preventDefault(); focused.value = next
    const nextRow = Math.floor(next / layout.value.columns), oldRow = gridRowAt(rows.value, viewport.value.start)
    if (scrollRoot) scrollRoot.scrollTop += rows.value.tops[nextRow]! - (rows.value.tops[oldRow] ?? 0)
    schedule()
    void nextTick(() => { const nextCard = root.value?.querySelector<HTMLElement>(`[data-grid-index="${next}"]`); if (nextCard) { const choices = focusable(nextCard); (event.shiftKey ? choices.at(-1) : choices[0])?.focus() } })
  }
  watch(root, () => {
    scrollRoot?.removeEventListener('scroll', schedule); scrollRoot = null; resize?.disconnect(); resize = undefined; observedCards.clear(); schedule()
  })
  watch(items, (next, previous) => {
    if (focused.value !== undefined) {
      const key = (item: T | undefined) => { const value = item as { key?: string; reference?: string; favoriteId?: string; id?: string } | undefined; return value?.key ?? value?.reference ?? value?.favoriteId ?? value?.id }
      const currentKey = key(previous[focused.value]), nextIndex = currentKey === undefined ? -1 : next.findIndex(item => key(item) === currentKey)
      focused.value = nextIndex < 0 ? undefined : nextIndex
    }
    void nextTick(schedule)
  })
  watch(() => options.enabled?.(), () => { heights.clear(); revision.value++; void nextTick(schedule) })
  onMounted(() => {
    schedule(); if (typeof window !== 'undefined') window.addEventListener?.('resize', schedule)
    if (typeof document !== 'undefined') void document.fonts?.ready.then(() => { if (!disposed) { heights.clear(); revision.value++; schedule() } })
  })
  onUnmounted(() => { disposed = true; resize?.disconnect(); observedCards.clear(); scrollRoot?.removeEventListener('scroll', schedule); if (typeof window !== 'undefined') window.removeEventListener?.('resize', schedule) })
  return { rendered, rootStyle, attrs, onFocusIn, onFocusOut, onKeydown, refresh: schedule }
}
