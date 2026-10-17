import { isIP } from 'node:net'
import { fail, queryText } from './boundaries.js'

export type LocalArtworkSearchSource = 'douban-itunes' | 'douban' | 'itunes'
export type LocalArtworkWebSource = 'douban-web' | 'bing-images' | 'google-images'

/** 所有返回 URL 仅供 Main 的受控 transport/navigation port 使用。 */
export function checkedRemoteArtworkUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return fail('candidate')
  const match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/iu.exec(value)
  // 先看原 authority，避免 URL 将显式 :443 吞掉；不接受 IP 字面量或 userinfo。
  if (!match || /[:@\[\]]/u.test(match[1]!)) return fail('candidate')
  let url: URL
  try { url = new URL(value) } catch { return fail('candidate') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || isIP(url.hostname)
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/iu.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/iu.test(url.hostname)
    || /%(?:00|0a|0d|2f|5c)/iu.test(url.pathname)
    || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu.test(value.split(/[?#]/u)[0]!)) return fail('candidate')
  return url
}

export function checkedProviderImageUrl(value: unknown, source: 'douban' | 'itunes'): URL {
  const url = checkedRemoteArtworkUrl(value)
  if (url.search) return fail('candidate')
  if (source === 'douban') {
    if (!/^img\d{1,2}\.doubanio\.com$/u.test(url.hostname)
      || !/^\/view\/subject\/[sml]\/public\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png)$/u.test(url.pathname)) return fail('candidate')
  } else if (!/^is\d{1,2}(?:-ssl)?\.mzstatic\.com$/u.test(url.hostname)
    || !url.pathname.startsWith('/image/thumb/') || url.pathname.includes('//')
    || !/\/(?:\d{1,4}x\d{1,4}bb|1200x1200bb)\.jpg$/u.test(url.pathname)) return fail('candidate')
  return url
}

export function largeProviderImageUrl(url: URL, source: 'douban' | 'itunes'): URL {
  const large = new URL(url.href)
  if (source === 'douban') large.pathname = large.pathname.replace(/\/[sm]\/public\//u, '/l/public/')
  else large.pathname = large.pathname.slice(0, large.pathname.lastIndexOf('/') + 1) + '1200x1200bb.jpg'
  return checkedProviderImageUrl(large.href, source)
}

export function checkedProviderPageUrl(value: unknown, source: 'douban' | 'itunes'): URL | null {
  if (value === undefined || value === null) return null
  try {
    const url = checkedRemoteArtworkUrl(value)
    if (source === 'douban') {
      if (url.hostname !== 'music.douban.com' || !/^\/subject\/\d+\/?$/u.test(url.pathname) || url.search) return null
    } else if (url.hostname !== 'music.apple.com' || !/^\/[a-z]{2}\/album\/[\w%.-]+\/\d+\/?$/u.test(url.pathname)
      || [...url.searchParams.keys()].some(key => key !== 'uo') || (url.searchParams.has('uo') && url.searchParams.get('uo') !== '4')) return null
    return url
  } catch { return null }
}

export function artworkSearchUrl(source: 'douban' | 'itunes', query: string, country: string, limit: number): URL {
  const name = queryText(query)
  const url = new URL(source === 'douban' ? 'https://search.douban.com/music/subject_search' : 'https://itunes.apple.com/search')
  if (source === 'douban') { url.searchParams.set('search_text', name); url.searchParams.set('cat', '1003') }
  else {
    url.searchParams.set('term', name); url.searchParams.set('country', country)
    url.searchParams.set('media', 'music'); url.searchParams.set('entity', 'album'); url.searchParams.set('limit', String(limit))
  }
  return url
}

export function artworkWebUrl(source: LocalArtworkWebSource, query: string): URL {
  const name = queryText(query)
  if (source === 'douban-web') return artworkSearchUrl('douban', name, 'CN', 50)
  if (source === 'bing-images') { const url = new URL('https://www.bing.com/images/search'); url.searchParams.set('q', `${name} 封面`); return url }
  if (source === 'google-images') { const url = new URL('https://www.google.com/search'); url.searchParams.set('tbm', 'isch'); url.searchParams.set('q', `${name} 封面`); return url }
  return fail('input')
}
