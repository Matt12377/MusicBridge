import { computed, nextTick, shallowRef, watch } from 'vue'
import type { LocalAlbumSummary } from '@music-bridge/contracts'
import type { SidebarSource } from '../../components/navigation.js'
import type { usePageJourney } from '../application/usePageJourney.js'
import type { useLocalAlbumBrowser } from '../application/local-library-browser/useLocalAlbumBrowser.js'
import { waitForGridWindowLayout } from '../useGridWindow.js'
import type { CatalogReturnLocation, useCatalogExperience } from './useCatalogExperience.js'

interface CatalogAlbumOrigin {
  view: 'search' | 'roon-artists'
  source: SidebarSource
  scrollTop: number
  location: CatalogReturnLocation
}
export interface CatalogAlbumNavigationOptions {
  journey: Pick<ReturnType<typeof usePageJourney>, 'currentView' | 'sidebar' | 'contentScroll' | 'navigate'>
  catalog: Pick<ReturnType<typeof useCatalogExperience>, 'captureReturnLocation'>
  browser: Pick<ReturnType<typeof useLocalAlbumBrowser>, 'activate' | 'openAlbumReference' | 'closeAlbum'>
  selectAlbumView(): void
  afterRender?: () => Promise<void>
}

/** 共用原本地专辑详情；导航只由点击/返回执行，异步读取永远不写当前页面。 */
export function useCatalogAlbumNavigation(options: CatalogAlbumNavigationOptions) {
  const { journey, browser } = options, afterRender = options.afterRender ?? (() => nextTick())
  const origin = shallowRef<CatalogAlbumOrigin | null>(null)
  let generation = 0, routeEpoch = 0, disposed = false
  let layoutController: AbortController | undefined
  const clear = () => { generation++; origin.value = null; layoutController?.abort(); layoutController = undefined }
  const stop = watch(journey.currentView, view => {
    routeEpoch++
    if (layoutController || origin.value && view !== 'local-library') clear()
  }, { flush: 'sync' })

  async function open(album: LocalAlbumSummary): Promise<void> {
    if (disposed) return
    const view = journey.currentView.value
    const parent: CatalogAlbumOrigin | null = view === 'search' || view === 'roon-artists' ? {
      view, source: { ...journey.sidebar.activeSource.value }, scrollTop: journey.contentScroll.value?.scrollTop ?? 0,
      location: options.catalog.captureReturnLocation(view === 'search' ? 'search' : 'artists'),
    } : null
    clear(); const current = generation
    browser.closeAlbum(); options.selectAlbumView(); origin.value = parent
    // 不走侧栏“切换来源”的清理路径；原 journey 离页门禁及读生命周期仍然执行。
    journey.navigate('local-library', false)
    if (journey.currentView.value !== 'local-library') { clear(); return }
    const route = routeEpoch
    const valid = () => !disposed && current === generation && route === routeEpoch && journey.currentView.value === 'local-library'
    await afterRender()
    if (!valid()) return
    await browser.activate()
    if (!valid()) return
    await browser.openAlbumReference({ albumKey: album.id, rootId: album.rootId, revision: album.revision })
  }

  async function back(): Promise<void> {
    if (disposed) return
    const parent = origin.value
    clear(); browser.closeAlbum()
    if (!parent || journey.currentView.value !== 'local-library' || !parent.location.isCurrent()) return
    const parentIsVisible = () => journey.currentView.value === parent.view
    journey.navigate(parent.view, false)
    if (!parentIsVisible() || !parent.location.restore()) return
    journey.sidebar.setActiveSource(parent.source)
    const current = generation, route = routeEpoch
    const controller = new AbortController(); layoutController = controller
    const valid = () => !disposed && current === generation && route === routeEpoch && parentIsVisible() && parent.location.isCurrent()
    try {
      await afterRender()
      if (!valid()) return
      const ready = await waitForGridWindowLayout(journey.contentScroll.value, controller.signal)
      if (ready && valid()) journey.contentScroll.value?.scrollTo({ top: parent.scrollTop })
    } finally { if (layoutController === controller) layoutController = undefined; controller.abort() }
  }

  return { backLabel: computed(() => origin.value?.location.label), open, back, clear,
    dispose() { if (disposed) return; disposed = true; clear(); stop() } }
}
