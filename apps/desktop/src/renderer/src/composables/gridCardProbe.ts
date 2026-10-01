import type { RoonLibraryItem } from '@music-bridge/contracts'
export function prepareRoonCardProbe(element: HTMLElement, item: RoonLibraryItem): void {
  const copy = element.querySelector('.roon-album-copy'); if (!copy) return
  const small = copy.querySelectorAll('small'); small[1]?.remove()
  if (item.year) { const year = element.ownerDocument.createElement('small'); year.textContent = String(item.year); copy.append(year) }
}
