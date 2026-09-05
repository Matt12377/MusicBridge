import { onScopeDispose, shallowRef, watch, type Ref } from 'vue'

export interface AmbientArtworkResource {
  src: string
  release: () => void
}

export async function decodeAmbientImage(src: string): Promise<void> {
  const image = new Image()
  image.decoding = 'async'
  image.src = src
  await image.decode()
}

/** 先准备下一幅画面，再更新显示；迟到的成功或失败不能覆盖当前选择。 */
export function useAmbientArtwork(
  source: Readonly<Ref<string | undefined>>,
  defaultSrc: string,
  load: (src: string) => Promise<void | AmbientArtworkResource> = decodeAmbientImage,
) {
  const artwork = shallowRef({ src: defaultSrc, isCover: false })
  const resources = new Map<string, () => void>()
  let generation = 0
  const stop = watch(source, async src => {
    const ticket = ++generation
    if (!src) {
      artwork.value = { src: defaultSrc, isCover: false }
      return
    }
    try {
      const resource = await load(src)
      if (ticket !== generation) {
        resource?.release()
        return
      }
      if (resource) {
        resources.get(resource.src)?.()
        resources.set(resource.src, resource.release)
      }
      artwork.value = { src: resource?.src ?? src, isCover: true }
    } catch {
      if (ticket === generation) artwork.value = { src: defaultSrc, isCover: false }
    }
  }, { immediate: true })
  // 离场动画结束后释放旧 Roon 封面，避免淡出期间 blob URL 被提前撤销。
  Object.assign(artwork, {
    releaseFrame(src: string) {
      if (src === artwork.value.src) return
      resources.get(src)?.()
      resources.delete(src)
    },
  })
  onScopeDispose(() => {
    stop()
    generation += 1
    for (const release of resources.values()) release()
    resources.clear()
  })
  return artwork as typeof artwork & { releaseFrame: (src: string) => void }
}
