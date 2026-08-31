import { RENDERER_ENTRY_PATH, RENDERER_HOST, RENDERER_SCHEME } from '../src/main/renderer-protocol.js'

interface WindowPage {
  url(): string
  isClosed(): boolean
  waitForLoadState(state: 'domcontentloaded'): Promise<unknown>
}

interface WindowApplication<Page extends WindowPage> {
  firstWindow(): Promise<Page>
  windows(): Page[]
  waitForEvent(event: 'window', options?: { signal?: AbortSignal }): Promise<Page>
}

export async function waitForMainWindow<Page extends WindowPage>(application: WindowApplication<Page>): Promise<Page> {
  const inspected = new Set<Page>()
  let next = await application.firstWindow()
  for (;;) {
    const controller = new AbortController()
    const following = application.waitForEvent('window', { signal: controller.signal })
    const candidates = [next, ...application.windows()]
    for (const candidate of candidates) {
      if (inspected.has(candidate)) continue
      try {
        await candidate.waitForLoadState('domcontentloaded')
      } catch (error) {
        if (!candidate.isClosed()) throw error
        inspected.add(candidate)
        continue
      }
      inspected.add(candidate)
      const url = new URL(candidate.url())
      if (url.protocol === `${RENDERER_SCHEME}:` && url.hostname === RENDERER_HOST && url.pathname === RENDERER_ENTRY_PATH) {
        controller.abort()
        await following.catch(() => undefined)
        return candidate
      }
    }
    next = await following
  }
}
