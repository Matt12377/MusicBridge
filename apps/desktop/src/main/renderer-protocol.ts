import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export const RENDERER_SCHEME = 'musicbridge'
export const RENDERER_HOST = 'app'
export const RENDERER_ENTRY_PATH = '/index.html'

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function decodePathname(pathname: string): string | undefined {
  try {
    const decoded = decodeURIComponent(pathname)
    if (!decoded.startsWith('/') || decoded.includes('\u0000')) return undefined
    return decoded
  } catch {
    return undefined
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function isAllowedRendererRequest(urlValue: string, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  try {
    const url = new URL(urlValue)
    const pathname = decodePathname(url.pathname)
    return (
      url.protocol === `${RENDERER_SCHEME}:` &&
      url.hostname === RENDERER_HOST &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      pathname !== undefined &&
      pathname !== '/'
    )
  } catch {
    return false
  }
}

export async function getRendererAssetPath(
  rendererRoot: string,
  requestPath: string,
): Promise<string> {
  const decoded = decodePathname(requestPath)
  if (!decoded || decoded === '/' || decoded.endsWith('/')) {
    throw new Error('Renderer asset path is not a file')
  }

  const root = await realpath(rendererRoot)
  const candidate = path.resolve(root, `.${decoded}`)
  if (!isWithinRoot(root, candidate)) throw new Error('Renderer asset traversal denied')

  const resolved = await realpath(candidate)
  if (!isWithinRoot(root, resolved)) throw new Error('Renderer asset symlink escape denied')
  const details = await stat(resolved)
  if (!details.isFile()) throw new Error('Renderer asset is not a file')
  return resolved
}

export function rendererContentType(requestPath: string): string {
  const extension = path.extname(requestPath).toLowerCase()
  return MIME_TYPES[extension] ?? 'application/octet-stream'
}
