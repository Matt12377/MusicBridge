import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { playbackFailureNotice } from '../src/renderer/src/playback-notice.js'

const issue = { code: 'ROON_MEDIA_ERROR' as const, message: 'Roon 报告媒体错误，请重试', retryable: true, action: 'retry' as const, diagnosticId: 'synthetic-diagnostic' }
const input = { ready: true, diagnostics: false, unconfirmed: false, snapshot: { state: 'error' as const, lastIssue: issue } }

test('播放失败即使清除了 currentTrack 也在普通页面持续可见', () => {
  assert.equal(playbackFailureNotice(input), issue.message)
  assert.equal(playbackFailureNotice({ ...input, snapshot: { state: 'error' } }), '播放未成功，请查看诊断后重试。')
})

test('准备中、恢复成功、不同代同步与诊断页不展示陈旧失败', () => {
  for (const state of ['idle', 'preparing', 'playing', 'paused'] as const) {
    assert.equal(playbackFailureNotice({ ...input, snapshot: { state, lastIssue: issue } }), undefined)
  }
  assert.equal(playbackFailureNotice({ ...input, ready: false }), undefined)
  assert.equal(playbackFailureNotice({ ...input, diagnostics: true }), undefined)
  assert.equal(playbackFailureNotice({ ...input, snapshot: undefined }), undefined)
})

test('未确认请求保留原核对入口，不以错误横幅提供自动重签重放', () => {
  assert.equal(playbackFailureNotice({ ...input, unconfirmed: true }), undefined)
})

test('页面遗失原请求时仍识别 Core UNKNOWN，不把未知结果误报为可重试失败', () => {
  const base = { phase: 'FAILED', ownership: 'MB_OWNED', queue_owner: 'MB' } as const
  const locals = [
    { ...base, phase: 'SUBMISSION_UNKNOWN' as const },
    { ...base, ownership: 'UNKNOWN' as const },
    { ...base, queue_owner: 'UNKNOWN' as const },
  ]
  for (const local of locals) {
    const message = playbackFailureNotice({ ...input, snapshot: { ...input.snapshot, local } })
    assert.match(message!, /结果尚未确认.*核对原请求.*不会重复提交/u)
    assert.doesNotMatch(message!, /重试/u)
    assert.equal(playbackFailureNotice({ ...input, unconfirmed: true, snapshot: { ...input.snapshot, local } }), undefined)
  }
})

test('App 以同一个通知区域展示失败，入口仅查看诊断而不放开底栏重放', async () => {
  const app = await readFile(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
  assert.match(app, /onActionMessage: message => \{ actionError\.value = message; showToast\(message\) \}/u)
  assert.match(app, /playbackFailureMessage \|\| catalogPlaybackRecovery\.message\.value/u)
  assert.match(app, /:role="playbackFailureMessage \? 'alert' : 'status'"/u)
  assert.match(app, /v-else-if="playbackFailureMessage"[^>]*@click="navigate\('diagnostics'\)">查看诊断/u)
  assert.match(app, /:current-track="currentTrack"/u)
  assert.doesNotMatch(app, /@toggle-playback="retryLastPlaybackAction"/u)
})
