import type { PublicRoonStatus } from '@music-bridge/contracts'

export interface RoonLibraryMessageContext {
  roonStatus?: PublicRoonStatus
  remoteCoreDevelopment?: boolean
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

export function roonLibraryMessage(
  error: unknown,
  context: RoonLibraryMessageContext = {},
): string {
  const code = readErrorCode(error)
  if (
    context.remoteCoreDevelopment &&
    context.roonStatus === 'discovering' &&
    (code === 'ROON_LIBRARY_UNAVAILABLE' || code === 'NOT_READY')
  ) {
    return 'Roon Dev Mac 扩展尚未启用，请在 Roon 设置 → 扩展中启用“Music Bridge for Roon — Dev Mac”后重试。'
  }

  switch (code) {
    case 'ROON_LIBRARY_UNAVAILABLE':
    case 'NOT_READY':
      return 'Roon Library 暂时不可用，请确认 Core 已配对。'
    case 'ROON_LIBRARY_REQUEST_FAILED':
      return 'Roon Library 请求失败，请检查 Core 连接。'
    case 'ROON_LIBRARY_INVALID_REFERENCE':
    case 'INVALID_IPC_REQUEST':
      return '这个 Roon 条目已过期，请返回专辑列表后重试。'
    default:
      return 'Roon Library 暂时无法读取，请稍后重试。'
  }
}
