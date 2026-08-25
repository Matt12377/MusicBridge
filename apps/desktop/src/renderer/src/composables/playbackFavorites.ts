import type {
  FavoriteEntityDescriptor,
  RoonLibraryItem,
  TrackSummary,
} from '@music-bridge/contracts'

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function optionalNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function favoriteDescriptorForTrack(track: TrackSummary): FavoriteEntityDescriptor {
  const artist = optionalText(track.artists.join('、'))
  return {
    kind: 'track',
    title: track.title,
    ...(artist !== undefined ? { artist } : {}),
    ...(optionalText(track.album) !== undefined ? { album: track.album } : {}),
    ...(optionalNumber(track.durationMs) !== undefined ? { durationMs: track.durationMs } : {}),
  }
}

export function favoriteDescriptorForRoonItem(item: RoonLibraryItem): FavoriteEntityDescriptor {
  if (item.kind !== 'track' && item.kind !== 'album' && item.kind !== 'artist') {
    throw new TypeError('Only Roon track, album, and artist entities can be favorited')
  }
  const descriptor: FavoriteEntityDescriptor = {
    kind: item.kind,
    title: item.title,
    ...(optionalText(item.subtitle) !== undefined ? { subtitle: item.subtitle } : {}),
    ...(optionalText(item.artist) !== undefined ? { artist: item.artist } : {}),
    ...(optionalText(item.album) !== undefined ? { album: item.album } : {}),
    ...(optionalNumber(item.durationMs) !== undefined ? { durationMs: item.durationMs } : {}),
    ...(optionalNumber(item.trackNumber) !== undefined ? { trackNumber: item.trackNumber } : {}),
    ...(optionalNumber(item.discNumber) !== undefined ? { discNumber: item.discNumber } : {}),
    ...(optionalNumber(item.year) !== undefined ? { year: item.year } : {}),
    ...(optionalText(item.version) !== undefined ? { version: item.version } : {}),
  }
  return descriptor
}

export function resolveFavoriteToggle(state: {
  netease: boolean
  local: boolean
}): boolean {
  return !(state.netease && state.local)
}
