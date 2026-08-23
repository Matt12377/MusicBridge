import type { Page } from '@music-bridge/contracts'

export function appendPage<T>(current: Page<T> | null, next: Page<T>): Page<T> {
  if (!current || next.offset === 0) return next
  return {
    ...next,
    items: [...current.items, ...next.items],
  }
}
