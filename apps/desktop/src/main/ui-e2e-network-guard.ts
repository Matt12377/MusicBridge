import type { Session } from 'electron'

const syntheticCoverUrl = 'https://p1.music.126.net/synthetic-cover.jpg'
const syntheticAvatarUrl = 'https://p1.music.126.net/synthetic-avatar.jpg'
const syntheticImage = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="#6274a5"/><circle cx="80" cy="80" r="60" fill="#e0aac5"/><circle cx="80" cy="80" r="16" fill="#f6eef2"/></svg>'

export interface UiE2eNetworkEvidence {
  installedBeforeWindow: true
  localCoverResponses: number
  localAvatarResponses: number
  blockedExternalAttempts: number
  blockedHosts: string[]
}

/** 仅在显式离线 UI E2E 中启用；在建窗前为精确合成 URL 返回本地字节，其他 HTTP(S) 一律拒绝。 */
export function installUiE2eNetworkGuard(targetSession: Session): UiE2eNetworkEvidence {
  const evidence: UiE2eNetworkEvidence = {
    installedBeforeWindow: true, localCoverResponses: 0, localAvatarResponses: 0,
    blockedExternalAttempts: 0, blockedHosts: [],
  }
  // Chromium 拒绝将 HTTPS 图片重定向到 data:；协议响应保持原 URL 并且从不转发上游。
  targetSession.protocol.handle('https', request => {
    if (request.url === syntheticCoverUrl) evidence.localCoverResponses++
    else if (request.url === syntheticAvatarUrl) evidence.localAvatarResponses++
    else return Response.error()
    return new Response(syntheticImage, { headers: { 'content-type': 'image/svg+xml' } })
  })
  targetSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (details.url === syntheticCoverUrl || details.url === syntheticAvatarUrl) {
      callback({})
      return
    }
    evidence.blockedExternalAttempts++
    const host = new URL(details.url).hostname
    if (!evidence.blockedHosts.includes(host)) evidence.blockedHosts.push(host)
    callback({ cancel: true })
  })
  return evidence
}
