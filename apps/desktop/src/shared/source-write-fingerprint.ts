import { localSourceWritesRequestCanonical, type LocalSourceWritesCommand, type LocalSourceWritesCommandPayloads } from '@music-bridge/contracts'

/** 同一闭集请求的指纹先于发送保存；UNKNOWN 只用它核对原回执。 */
export async function sourceWriteRequestFingerprint(command: LocalSourceWritesCommand, payload: unknown): Promise<string> {
  const text = localSourceWritesRequestCanonical(command, payload as LocalSourceWritesCommandPayloads[typeof command])
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}
