import { ref, shallowRef } from 'vue'
import { isLocalPlayReceipt, type LocalPlayAccepted, type LocalPlayReceipt, type LocalPlayRequest, type LocalSourceUnsupported, type PlaybackSnapshot } from '@music-bridge/contracts'
import { localPlaySubmissionResolved } from '../../components/player/details.js'

/** 读取原回执与真实播放观察；任何missing或未知结果都不授权重发。 */
export function useCatalogPlaybackRecovery(options: {
  readReceipt(request: LocalPlayRequest): Promise<LocalPlayReceipt>
  getSnapshot(): PlaybackSnapshot | null
}) {
  const request = shallowRef<LocalPlayRequest | null>(null), message = ref(''), checking = ref(false)
  function begin(original: LocalPlayRequest): void { request.value = structuredClone(original); message.value = '播放请求正在处理中，等待原服务确认。' }
  function observe(snapshot: PlaybackSnapshot | null): void {
    if (request.value && localPlaySubmissionResolved(snapshot, request.value)) { request.value = null; message.value = '' }
  }
  function owns(expected: LocalPlayRequest | null): boolean {
    return !!expected && request.value?.request_id === expected.request_id && request.value.action === expected.action
  }
  function accept(result: LocalPlayAccepted | LocalSourceUnsupported, expected: LocalPlayRequest | null = request.value): void {
    // 真实观察可能先于受理回包；已闭合或已换请求时，旧运输结果不得复活提示。
    if (!expected || !owns(expected)) return
    if (result.status === 'accepted' && (result.request_id !== expected.request_id || result.action !== expected.action)) return
    if (result.status === 'unsupported') { request.value = null; message.value = ''; return }
    message.value = '播放请求已受理，等待原播放器的真实状态确认。'
    observe(options.getSnapshot())
  }
  function fail(error: unknown, expected: LocalPlayRequest | null = request.value): void {
    if (!owns(expected)) return
    const outcome = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'outcome') : undefined
    if (outcome && Object.hasOwn(outcome, 'value') && outcome.value === 'not-sent') { request.value = null; message.value = ''; return }
    message.value = '播放请求的结果尚未确认，请核对原请求；暂不重复提交。'
    observe(options.getSnapshot())
  }
  async function check(): Promise<void> {
    const original = request.value
    if (!original || checking.value) return
    checking.value = true
    try {
      const receipt = await options.readReceipt(structuredClone(original))
      if (request.value !== original) return
      if (!isLocalPlayReceipt(receipt) || receipt.request_id !== original.request_id || receipt.action !== original.action) throw new Error('原播放回执身份无效。')
      if (receipt.status === 'missing') message.value = '当前服务没有原提交的回执，结果仍未确认；不会重发，请核对原播放器或导出诊断。'
      else if (receipt.status === 'pending') message.value = '原播放请求仍在处理，可以稍后再次核对；不会新增或重发点播。'
      else if (receipt.status === 'rejected') { request.value = null; message.value = '原播放请求已明确拒绝，请核对歌曲和目标后重新选择。' }
      else if (receipt.status === 'received') { accept(receipt.result); if (receipt.result.status === 'unsupported') message.value = '原播放请求不支持此来源，可核对目标后重新选择。' }
      observe(options.getSnapshot())
    } catch { if (request.value === original) message.value = '原回执暂时无法读取，原请求和未确认状态保留。' }
    finally { checking.value = false }
  }
  return { request, message, checking, begin, accept, fail, observe, check }
}
