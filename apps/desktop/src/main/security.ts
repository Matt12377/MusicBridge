export type DesktopBuildMode = 'development' | 'production'

export function buildBrowserWindowWebPreferences() {
  return Object.freeze({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
  })
}

export function buildContentSecurityPolicy(_mode: DesktopBuildMode): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data: https://*.music.126.net",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function isNavigationAllowed(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'musicbridge:' &&
      url.hostname === 'app' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/index.html' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

export function getWindowOpenDecision(): { action: 'deny' } {
  return { action: 'deny' }
}

export function isTrustedRendererSender(options: {
  senderId: number
  windowId: number
  frameUrl: string
}): boolean {
  if (options.senderId !== options.windowId) return false
  try {
    const url = new URL(options.frameUrl)
    return (
      url.protocol === 'musicbridge:' &&
      url.hostname === 'app' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/index.html' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}
