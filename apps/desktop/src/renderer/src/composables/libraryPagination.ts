import type { Page } from '@music-bridge/contracts'

export function appendPage<T>(current: Page<T> | null, next: Page<T>): Page<T> {
  if (!current || next.offset === 0) return next
  const seen = new Set<string>()
  const hasStableId = next.items.every((item) => (
    typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string'
  ))
  const items = hasStableId
    ? [...current.items, ...next.items].filter((item) => {
        const id = (item as { id: string }).id
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
    : [...current.items, ...next.items]
  return {
    ...next,
    items,
  }
}
