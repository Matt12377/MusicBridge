import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalRootView, ScanJobRecord } from '@music-bridge/contracts'
import { localLibraryScanPresentation } from '../src/renderer/src/composables/application/local-library-browser/scan-presentation.js'

const root: LocalRootView = { root: { id: 'root-a', sourceRootId: 'source-a', revision: '1', role: 'library' }, label: '合成音乐目录', availability: 'ONLINE' }
function scan(phase: ScanJobRecord['phase'], overrides: Partial<ScanJobRecord> = {}): ScanJobRecord {
  return { schemaVersion: '1.2', jobId: 'job-a', datasetId: 'dataset-a', libraryRootId: root.root.id, sourceRootId: root.root.sourceRootId,
    rootRevision: root.root.revision, jobRevision: '1', checkpointRef: null, phase, progress: { visited: '9', accepted: '7', rejected: '2' }, failureCode: null, ...overrides }
}

test('共享音乐库只在目录读取成功且没有根时引导添加，已有根0专辑保持原音乐库身份', () => {
  const unread = localLibraryScanPresentation({ roots: [], rootsLoaded: false, jobs: [], hasMusic: false })
  assert.equal(unread.onboarding, false)
  assert.equal(localLibraryScanPresentation({ roots: [], rootsLoaded: true, jobs: [], hasMusic: false }).onboarding, true)
  const empty = localLibraryScanPresentation({ roots: [root], rootsLoaded: true, jobs: [], hasMusic: false })
  assert.equal(empty.onboarding, false)
  assert.match(empty.rows[0]!.message, /尚未读取到扫描任务/u)
  assert.match(empty.emptyCopy, /已保存的目录/u)
})

test('扫描中的空音乐库显示原任务进度，已收录专辑出现后仍保留轻量扫描计数', () => {
  for (const hasMusic of [false, true]) {
    const value = localLibraryScanPresentation({ roots: [root], rootsLoaded: true, jobs: [scan('running')], hasMusic })
    assert.equal(value.onboarding, false)
    assert.match(value.rows[0]!.message, /已处理 9 · 收录 7 · 跳过 2/u)
    assert.match(value.rows[0]!.message, /专辑会陆续显示/u)
  }
})

test('手动暂停与读取错误保持不同状态，暂停文案不会声称自动继续', () => {
  const paused = localLibraryScanPresentation({ roots: [root], rootsLoaded: true, jobs: [scan('paused')], hasMusic: false })
  assert.match(paused.rows[0]!.message, /扫描已暂停/u)
  assert.match(paused.rows[0]!.message, /设置中继续/u)
  assert.doesNotMatch(paused.rows[0]!.message, /自动/u)
  const failed = localLibraryScanPresentation({ roots: [root], rootsLoaded: true, jobs: [scan('failed', { failureCode: 'SCAN_READ_FAILED' })], hasMusic: false })
  assert.equal(failed.rows[0]!.phase, 'failed')
  assert.match(failed.rows[0]!.message, /读取源目录时发生错误/u)
})

test('旧根修订与来源的任务不能冒充当前扫描，离线根也不会显示首次添加', () => {
  for (const job of [scan('completed', { rootRevision: 'old' }), scan('completed', { sourceRootId: 'other-source' })]) {
    const value = localLibraryScanPresentation({ roots: [root], rootsLoaded: true, jobs: [job], hasMusic: false })
    assert.equal(value.onboarding, false)
    assert.equal(value.rows[0]!.phase, 'unconfirmed')
    assert.doesNotMatch(value.rows[0]!.message, /收录 7/u)
  }
  const offline = localLibraryScanPresentation({ roots: [{ ...root, availability: 'SOURCE_ROOT_OFFLINE' }], rootsLoaded: true, jobs: [], hasMusic: false })
  assert.equal(offline.onboarding, false)
  assert.match(offline.rows[0]!.message, /源目录离线/u)
})

test('完成后已存在音乐的普通浏览页收起扫描提示，完成但0音乐继续显示真实空库状态', () => {
  assert.equal(localLibraryScanPresentation({ roots: [root], rootsLoaded: true, jobs: [scan('completed')], hasMusic: true }).rows.length, 0)
  const empty = localLibraryScanPresentation({ roots: [root], rootsLoaded: true, jobs: [scan('completed', { progress: { visited: '0', accepted: '0', rejected: '0' } })], hasMusic: false })
  assert.equal(empty.onboarding, false)
  assert.match(empty.rows[0]!.message, /扫描完成/u)
  assert.match(empty.rows[0]!.message, /尚未发现可收录音乐/u)
})

test('扫描进度保留公开十进制精度，不把字符串计数转换成有损数值', () => {
  const value = localLibraryScanPresentation({ roots: [root], rootsLoaded: true,
    jobs: [scan('running', { progress: { visited: '9007199254740993', accepted: '9007199254740992', rejected: '0' } })], hasMusic: true })
  assert.match(value.rows[0]!.message, /已处理 9007199254740993 · 收录 9007199254740992/u)
})
