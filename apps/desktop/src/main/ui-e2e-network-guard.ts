import type { Session } from 'electron'

const syntheticCoverUrl = 'https://p1.music.126.net/synthetic-cover.jpg'
const syntheticAvatarUrl = 'https://p1.music.126.net/synthetic-avatar.jpg'
const syntheticImage = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" fill="#6274a5"/><circle cx="80" cy="80" r="60" fill="#e0aac5"/><circle cx="80" cy="80" r="16" fill="#f6eef2"/></svg>')}`

export interface UiE2eNetworkEvidence {
  installedBeforeWindow: true
  localCoverResponses: number
  localAvatarResponses: number
  blockedExternalAttempts: number
  blockedHosts: string[]
}

/** 仅在显式离线 UI E2E 中启用；在建窗前将合成封面改为内嵌字节，其他 HTTP(S) 一律拒绝。 */
export function installUiE2eNetworkGuard(targetSession: Session): UiE2eNetworkEvidence {
  const evidence: UiE2eNetworkEvidence = {
    installedBeforeWindow: true, localCoverResponses: 0, localAvatarResponses: 0,
    blockedExternalAttempts: 0, blockedHosts: [],
  }
  targetSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (details.url === syntheticCoverUrl) {
      evidence.localCoverResponses++
      callback({ redirectURL: syntheticImage })
      return
    }
    if (details.url === syntheticAvatarUrl) {
      evidence.localAvatarResponses++
      callback({ redirectURL: syntheticImage })
      return
    }
    evidence.blockedExternalAttempts++
    const host = new URL(details.url).hostname
    if (!evidence.blockedHosts.includes(host)) evidence.blockedHosts.push(host)
    callback({ cancel: true })
  })
  return evidence
}
