/** 网格行几何与线性歌曲窗口分离；行高来自当前CSS度量，不把第一行外推整库。 */
export interface GridRows { tops: readonly number[]; heights: readonly number[]; totalHeight: number; columns: number }
export function createGridRows(heights: readonly number[], columns: number, gap: number): GridRows {
  const cols = Math.max(1, Math.floor(columns)), space = Math.max(0, gap), tops: number[] = [], rows: number[] = []
  let top = 0
  for (let i = 0; i < heights.length; i += cols) {
    const height = Math.max(1, ...heights.slice(i, i + cols)); tops.push(top); rows.push(height); top += height + space
  }
  return { tops, heights: rows, totalHeight: Math.max(0, top - (rows.length ? space : 0)), columns: cols }
}
export function gridRowAt(rows: GridRows, position: number): number {
  let low = 0, high = rows.tops.length
  while (low < high) { const middle = (low + high) >>> 1; if (rows.tops[middle]! + rows.heights[middle]! <= position) low = middle + 1; else high = middle }
  return low
}
export function gridWindowIndices(rows: GridRows, itemCount: number, viewportStart: number, viewportEnd: number, overscan = 2, focusedIndex?: number): number[] {
  const indices: number[] = []
  if (viewportEnd > 0 && viewportStart < rows.totalHeight && viewportEnd > viewportStart) {
    const first = Math.max(0, gridRowAt(rows, Math.max(0, viewportStart)) - overscan)
    const last = Math.min(rows.tops.length, gridRowAt(rows, viewportEnd) + 1 + overscan)
    for (let index = first * rows.columns; index < Math.min(itemCount, last * rows.columns); index++) indices.push(index)
  }
  if (focusedIndex !== undefined && focusedIndex >= 0 && focusedIndex < itemCount) {
    const first = Math.floor(focusedIndex / rows.columns) * rows.columns
    for (let i = first; i < Math.min(itemCount, first + rows.columns); i++) if (!indices.includes(i)) indices.push(i)
  }
  return indices.sort((a, b) => a - b)
}
