import type { PublicRoonStatus } from '@music-bridge/contracts'

export interface RoonLibraryMessageContext {
  roonStatus?: PublicRoonStatus
  remoteCoreDevelopment?: boolean
}

export function readPublicIpcErrorCode(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  if (typeof error !== 'object' || error === null) return undefined
  if ('code' in error && typeof error.code === 'string') return error.code
  const message = 'message' in error && typeof error.message === 'string'
    ? error.message
    : undefined
  return message?.match(/\[([A-Z][A-Z0-9_]{1,63})\]/u)?.[1]
}

export function roonLibraryMessage(
  error: unknown,
  context: RoonLibraryMessageContext = {},
): string {
  const code = readPublicIpcErrorCode(error)
  if (
    context.remoteCoreDevelopment &&
    context.roonStatus === 'discovering' &&
    (code === 'ROON_LIBRARY_UNAVAILABLE' || code === 'NOT_READY')
  ) {
    return 'Roon Dev Mac 扩展尚未启用，请在 Roon 设置 → 扩展中启用“Music Bridge for Roon — Dev Mac”后重试。'
  }
  if (
    (context.roonStatus === 'disconnected'
      || (context.roonStatus === 'discovering' && !context.remoteCoreDevelopment))
    && (code === 'ROON_LIBRARY_UNAVAILABLE'
      || code === 'ROON_LIBRARY_REQUEST_FAILED'
      || code === 'NOT_READY')
  ) {
    return 'Roon Core 未连接。'
  }

  switch (code) {
    case 'ROON_CORE_NOT_CONNECTED':
      return 'Roon Core 未连接。'
    case 'ROON_LIBRARY_UNAVAILABLE':
      return 'Roon Library service 不可用。'
    case 'NOT_READY':
      return 'Roon Library 暂时不可用，请确认 Core 已配对。'
    case 'ROON_LIBRARY_REQUEST_FAILED':
      return 'Roon Library 请求失败，请检查 Core 连接。'
    case 'ROON_ALBUM_HIERARCHY_INVALID':
      return 'Roon 返回的专辑层级无效，请返回列表后重试。'
    case 'ROON_TRACK_ACTION_UNAVAILABLE':
      return '这首曲目的 Roon 播放操作不可用。'
    case 'ROON_IMAGE_DECODE_FAILED':
      return 'Roon 封面解码失败。'
    case 'ROON_LIBRARY_INVALID_REFERENCE':
    case 'INVALID_IPC_REQUEST':
      return '这个 Roon 条目已过期，请返回专辑列表后重试。'
    default:
      return 'Roon Library 暂时无法读取，请稍后重试。'
  }
}
