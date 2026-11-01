import { onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import type { LocalAlbumBrowserSnapshot } from './local-library-browser/types.js'

export const STARTUP_LIBRARY_PREVIEW_KEY = 'musicbridge.library-startup-preview.v1'
const MAX_BYTES = 768 * 1024, MAX_IMAGE = 128 * 1024, MAX_ALBUMS = 15
export interface StartupLibraryPreview {
  version: 1
  datasetId: string
  savedAt: number
  albums: { title: string; artists: string; edition: string; image: string | null }[]
}
type PreviewStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096
const image = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_IMAGE && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)

/** 上次真实浏览的显示副本；没有曲目、Source票据或可执行的专辑身份。 */
export function readStartupLibraryPreview(storage: PreviewStorage, now = Date.now()): StartupLibraryPreview | null {
  try {
    const raw = storage.getItem(STARTUP_LIBRARY_PREVIEW_KEY)
    if (!raw || raw.length > MAX_BYTES) return null
    const value = JSON.parse(raw) as StartupLibraryPreview
    if (value?.version !== 1 || !text(value.datasetId) || !value.datasetId || !Number.isSafeInteger(value.savedAt)
      || value.savedAt > now || now - value.savedAt > 7 * 24 * 60 * 60 * 1000
      || !Array.isArray(value.albums) || !value.albums.length || value.albums.length > MAX_ALBUMS
      || !value.albums.every(album => album && text(album.title) && text(album.artists) && text(album.edition) && (album.image === null || image(album.image)))) return null
    return value
  } catch { return null }
}

export function saveStartupLibraryPreview(storage: PreviewStorage, datasetId: string, snapshot: LocalAlbumBrowserSnapshot, now = Date.now()): boolean {
  if (!datasetId || !snapshot.loaded || snapshot.stale || snapshot.error || snapshot.query || snapshot.rootId !== null || snapshot.filter !== 'all') return false
  let imageBytes = 0
  const albums = snapshot.items.slice(0, MAX_ALBUMS).map(album => {
    const artwork = snapshot.artwork[album.id], candidate = artwork?.status === 'ready' ? artwork.grid?.dataUrl ?? artwork.dataUrl : null
    const cover = image(candidate) && imageBytes + candidate.length <= MAX_BYTES / 2 ? candidate : null
    imageBytes += cover?.length ?? 0
    return { title: album.title, artists: album.artists.join('、'), edition: album.versionLabel ?? '', image: cover }
  })
  try {
    const raw = JSON.stringify({ version: 1, datasetId, savedAt: now, albums } satisfies StartupLibraryPreview)
    if (raw.length > MAX_BYTES) return false
    storage.setItem(STARTUP_LIBRARY_PREVIEW_KEY, raw)
    return true
  } catch { return false }
}

/** 与实时浏览模型分开；后台就绪只替换画面，不补发历史卡片操作。 */
export function useStartupLibraryPreview(options: {
  storage: PreviewStorage; ready: Ref<boolean>; datasetId: () => string | undefined; snapshot: () => LocalAlbumBrowserSnapshot
}) {
  const preview = shallowRef(readStartupLibraryPreview(options.storage))
  let timer: ReturnType<typeof setTimeout> | undefined
  watch([options.ready, options.datasetId, options.snapshot], () => {
    if (!options.ready.value) return
    preview.value = null
    const datasetId = options.datasetId()
    if (!datasetId || !options.snapshot().active || timer) return
    timer = setTimeout(() => {
      timer = undefined
      const current = options.datasetId()
      if (options.ready.value && current === datasetId) saveStartupLibraryPreview(options.storage, datasetId, options.snapshot())
    }, 600)
  })
  onScopeDispose(() => { if (timer) clearTimeout(timer) })
  return preview
}
