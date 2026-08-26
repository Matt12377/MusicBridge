export async function switchRoonZoneAfterStop(options: {
  hasActivePlayback: boolean
  stop: () => Promise<unknown>
  select: () => void
}): Promise<void> {
  if (options.hasActivePlayback) await options.stop()
  options.select()
}
