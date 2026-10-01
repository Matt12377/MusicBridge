import type { RoonLibraryItem } from '@music-bridge/contracts'
export function prepareRoonCardProbe(element: HTMLElement, item: RoonLibraryItem): void {
  const copy = element.querySelector('.roon-album-copy'); if (!copy) return
  const small = copy.querySelectorAll('small'); small[1]?.remove()
  if (item.year) { const year = element.ownerDocument.createElement('small'); year.textContent = String(item.year); copy.append(year) }
}

/** 收藏状态的测量副本包含真实条件按钮；不能借另一张卡片的ready布局测missing。 */
export function prepareFavoriteCardProbe(element: HTMLElement, state: { message: string; ready: boolean; retry: boolean; resolving: boolean }): void {
  const label = element.querySelector('.favorite-entity-status'); if (label) label.textContent = state.message
  const open = element.querySelector<HTMLButtonElement>('.favorite-open'); if (open) open.disabled = !state.ready
  const actions = element.querySelector('.favorite-entity-actions'); if (!actions) return
  for (const button of actions.querySelectorAll('button')) if (button.textContent?.trim() === '重试匹配') button.remove()
  if (state.retry) {
    const retry = element.ownerDocument.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.textContent = '重试匹配'; retry.disabled = state.resolving
    actions.insertBefore(retry, actions.firstChild)
  }
}
