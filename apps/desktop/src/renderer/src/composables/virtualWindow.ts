export interface VirtualWindow {
  start: number
  end: number
  topSpacer: number
  bottomSpacer: number
  totalHeight: number
}

export function calculateVirtualWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 8,
): VirtualWindow {
  const count = Math.max(0, Math.floor(itemCount))
  const height = Math.max(1, rowHeight)
  const viewport = Math.max(1, viewportHeight)
  const safeScrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, count * height - viewport)))
  const firstVisible = Math.floor(safeScrollTop / height)
  const lastVisibleExclusive = Math.ceil((safeScrollTop + viewport) / height)
  const start = Math.max(0, firstVisible - Math.max(0, overscan))
  const end = Math.min(count, lastVisibleExclusive + Math.max(0, overscan))
  const totalHeight = count * height
  return {
    start,
    end,
    topSpacer: start * height,
    bottomSpacer: Math.max(0, totalHeight - end * height),
    totalHeight,
  }
}
