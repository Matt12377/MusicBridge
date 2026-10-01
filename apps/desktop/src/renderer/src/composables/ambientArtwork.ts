import { onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import { artworkError, decodeArtworkUrl } from '../artwork-image.js'

export interface AmbientArtworkResource { src: string; release: () => void }
export interface AmbientArtworkLoadOptions { signal: AbortSignal }
function waitAmbientResource(work: Promise<void | AmbientArtworkResource>, signal: AbortSignal): Promise<void | AmbientArtworkResource> {
  return new Promise((resolve, reject) => {
    let done = false
    const abort = () => { if (done) return; done = true; signal.removeEventListener('abort', abort); reject(artworkError('ARTWORK_CANCELLED', '背景封面等待已取消')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void work.then(resource => {
      if (done) { resource?.release(); return }
      done = true; signal.removeEventListener('abort', abort); resolve(resource)
    }, error => {
      if (done) return
      done = true; signal.removeEventListener('abort', abort); reject(error)
    })
  })
}
/** 本地等待有界；真实decode占用在decodeArtworkUrl原Promise结算后才归还。 */
export async function decodeAmbientImage(src: string, options?: { signal?: AbortSignal }): Promise<void> {
  if (options?.signal?.aborted) throw artworkError('ARTWORK_CANCELLED', '背景封面读取已取消')
  const work = decodeArtworkUrl(src, 'playing')
  await new Promise<void>((resolve, reject) => {
    let done = false
    const finish = (error?: unknown) => {
      if (done) return
      done = true; clearTimeout(timer); options?.signal?.removeEventListener('abort', abort)
      if (error) reject(error); else resolve()
    }
    const abort = () => finish(artworkError('ARTWORK_CANCELLED', '背景封面读取已取消'))
    const timer = setTimeout(() => finish(artworkError('ARTWORK_TIMEOUT', '背景封面读取超时')), 10000)
    options?.signal?.addEventListener('abort', abort, { once: true })
    if (options?.signal?.aborted) abort()
    void work.then(() => finish(), error => finish(error))
  })
}

/** 准备下一帧；每个frame token独立持lease，同URL重入也不提前释放淡出帧。 */
export function useAmbientArtwork(
  source: Readonly<Ref<string | undefined>>,
  defaultSrc: string,
  load: (src: string, options: AmbientArtworkLoadOptions) => Promise<void | AmbientArtworkResource> = decodeAmbientImage,
) {
  let sequence = 0, generation = 0
  const nextToken = () => `artwork-frame-${++sequence}`
  const artwork = shallowRef({ src: defaultSrc, isCover: false, frameToken: nextToken() })
  const resources = new Map<string, { src: string; release: () => void }>()
  let controller: AbortController | undefined
  const stop = watch(source, async src => {
    const ticket = ++generation
    controller?.abort(); controller = undefined
    if (!src) { artwork.value = { src: defaultSrc, isCover: false, frameToken: nextToken() }; return }
    const owned = new AbortController(); controller = owned
    let ownTimeout = false
    const timer = setTimeout(() => { ownTimeout = true; owned.abort() }, 10000)
    try {
      let resource: void | AmbientArtworkResource
      const deadline = Date.now() + 10000
      for (let attempt = 0; ; attempt++) {
        try {
          if (owned.signal.aborted) throw artworkError('ARTWORK_CANCELLED', '背景封面等待已取消')
          resource = await waitAmbientResource(load(src, { signal: owned.signal }), owned.signal)
          break
        }
        catch (error) {
          const delay = attempt === 0 ? 150 : 450
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ARTWORK_BUSY' || attempt >= 2 || Date.now() + delay >= deadline) throw error
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); owned.signal.removeEventListener('abort', abort); reject(artworkError('ARTWORK_CANCELLED', '背景封面等待已取消')) }
            const timer = setTimeout(() => { owned.signal.removeEventListener('abort', abort); resolve() }, delay)
            owned.signal.addEventListener('abort', abort, { once: true }); if (owned.signal.aborted) abort()
          })
        }
      }
      if (ticket !== generation || owned.signal.aborted) {
        resource?.release()
        if (ticket === generation && ownTimeout) artwork.value = { src: defaultSrc, isCover: false, frameToken: nextToken() }
        return
      }
      if (resource && resources.size >= 128) { resource.release(); throw artworkError('ARTWORK_BUSY', '背景封面帧预算已满') }
      const frameToken = nextToken()
      if (resource) resources.set(frameToken, resource)
      artwork.value = { src: resource?.src ?? src, isCover: true, frameToken }
    } catch (error) {
      if (ticket === generation && (ownTimeout || !owned.signal.aborted) && (ownTimeout || !(error instanceof Error && 'code' in error && error.code === 'ARTWORK_BUSY'))) artwork.value = { src: defaultSrc, isCover: false, frameToken: nextToken() }
    } finally { clearTimeout(timer); if (controller === owned) controller = undefined }
  }, { immediate: true })
  const invalidate = () => {
    generation++; controller?.abort(); controller = undefined
    for (const resource of resources.values()) resource.release()
    resources.clear(); artwork.value = { src: defaultSrc, isCover: false, frameToken: nextToken() }
  }
  Object.assign(artwork, {
    invalidate,
    releaseFrame(tokenOrSrc: string) {
      if (tokenOrSrc === artwork.value.frameToken) return
      let token = tokenOrSrc
      // 兼容旧调用，仅无歧义旧src可释放；正式背景按token调用。
      if (!resources.has(token)) {
        if (tokenOrSrc === artwork.value.src) return
        const matches = [...resources.entries()].filter(([, resource]) => resource.src === tokenOrSrc)
        if (matches.length !== 1) return
        token = matches[0]![0]
      }
      resources.get(token)?.release(); resources.delete(token)
    },
  })
  onScopeDispose(() => { stop(); invalidate() })
  return artwork as typeof artwork & { releaseFrame(tokenOrSrc: string): void; invalidate(): void }
}
