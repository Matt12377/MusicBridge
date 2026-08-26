export function shouldRefreshVisibleRoonCollection(
  event: 'core.ready' | 'roon.changed',
  previousRoonStatus: string | undefined,
  nextRoonStatus: string,
): boolean {
  if (nextRoonStatus !== 'ready') return false
  return event === 'core.ready' || previousRoonStatus !== 'ready'
}
