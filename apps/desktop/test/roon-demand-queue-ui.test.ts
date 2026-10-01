import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { PlaybackSnapshot, PlaybackQueueSnapshot } from '@music-bridge/contracts'

interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown> }

async function mounted(t: test.TestContext, name: 'inspector/PlaybackInspector' | 'NowPlayingView', context: PlaybackQueueSnapshot['context']) {
  const { parse, compileScript } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default, require = createRequire(import.meta.url)
  const vue = require('vue') as typeof import('vue')
  const filename = new URL(`../src/renderer/src/components/${name}.vue`, import.meta.url)
  const { descriptor, errors } = parse(await readFile(filename, 'utf8'), { filename: `${name}.vue` })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'roon-demand-queue-ui', inlineTemplate: true })
  const virtualWindow = await import('../src/renderer/src/composables/virtualWindow.js')
  const details = await import('../src/renderer/src/components/player/details.js')
  const clock = await import('../src/renderer/src/components/player/playbackClock.js')
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const component = { exports: {} as { default: import('vue').Component } }
  const load = (path: string) => path === 'vue' ? vue
    : path.endsWith('virtualWindow.js') ? virtualWindow
    : path.endsWith('details.js') ? details
    : path.endsWith('playbackClock.js') ? clock
    : path.endsWith('roon-queue-context-status.js') ? contextStatusModule
    : path.endsWith('.vue') ? { default: { render: () => null } } : require(path)
  const contextStatusModule = await import('../src/renderer/src/roon-queue-context-status.js')
  new Function('require', 'module', 'exports', 'requestAnimationFrame', 'cancelAnimationFrame', compiled)(
    load, component, component.exports, () => 1, () => undefined)
  const node = (tag = ''): Host => ({ tag, text: '', children: [], parent: null, props: {} })
  const renderer = vue.createRenderer<Host, Host>({
    createElement: node, createText(value) { const result = node('#text'); result.text = value; return result }, createComment: () => node('#comment'),
    setText(target, value) { target.text = value }, setElementText(target, value) { target.text = value; target.children = [] },
    patchProp(target, key, _old, value) { target.props[key] = value },
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
      child.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(child)
      else parent.children.splice(index, 0, child)
    },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null },
    parentNode: target => target.parent,
    nextSibling: target => target.parent?.children[(target.parent?.children.indexOf(target) ?? -1) + 1] ?? null,
  })
  const track = { id: '1', title: '正在试听的合成曲目', artists: ['合成艺人'], album: '合成专辑' }
  const state: PlaybackSnapshot = { state: 'playing', source: 'roon', currentTrack: track, positionMs: 0,
    queue: { items: [{ trackId: '1', track, qualityPreference: 'auto', preferredSource: 'roon' }], index: 0, hasNext: true, hasPrevious: true, ...(context ? { context } : {}) },
    canNext: true, canPrevious: true, canStop: true, canPause: true, canResume: false }
  const root = node('root'), app = renderer.createApp(component.exports.default, {
    playbackState: state, currentTrack: track, qualityLabel: () => '未知',
    lyricsSnapshot: { status: 'unavailable', lines: [], activeLineIndex: -1, timingSource: 'static' },
    playbackIssueMessage: () => '', trackLikeState: 'idle', trackLikeAvailable: false,
    playbackSource: 'roon', seekAllowed: true, localLyricsMatchState: { status: 'hidden', candidates: [], canRevoke: false },
  })
  app.mount(root); t.after(() => app.unmount()); await vue.nextTick()
  const text = (current = root): string => current.text + current.children.map(child => text(child)).join(' ')
  const all = (current = root): Host[] => [current, ...current.children.flatMap(child => all(child))]
  return { text, all, state }
}

test('MBP003B：挂载队列未读后缘不伪报已经播放完', async t => {
  const view = await mounted(t, 'inspector/PlaybackInspector', { beforeComplete: false, afterComplete: false, loading: false })
  assert.doesNotMatch(view.text(), /队列已播放完/u)
  assert.match(view.text(), /后续曲目尚未读取/u)
  assert.match(view.text(), /已加载 0 首/u)
})

for (const error of ['retryable', 'expired', 'capacity'] as const) {
  test(`MBP003B：挂载播放页显示${error}后台错误，当前曲仍可暂停`, async t => {
    const view = await mounted(t, 'NowPlayingView', { beforeComplete: false, afterComplete: false, loading: false, error })
    assert.match(view.text(), error === 'retryable' ? /读取失败.*切歌.*重试/u : error === 'expired' ? /上下文已过期/u : /容量限制/u)
    assert.equal(view.state.state, 'playing')
    const pause = view.all().find(node => node.tag === 'button' && node.props['aria-label'] === '暂停')
    assert.ok(pause)
    assert.equal(pause.props.disabled, false)
  })
}

test('MBP003B：挂载播放页加载邻近曲目时保留Next和Previous能力', async t => {
  const view = await mounted(t, 'NowPlayingView', { beforeComplete: false, afterComplete: false, loading: true })
  assert.match(view.text(), /正在读取邻近曲目/u)
  for (const label of ['上一首', '下一首']) {
    const button = view.all().find(node => node.tag === 'button' && node.props['aria-label'] === label)
    assert.ok(button); assert.equal(button.props.disabled, false)
  }
})

test('MBP003B：旧队列没有context时仍显示原完成文案', async t => {
  const view = await mounted(t, 'inspector/PlaybackInspector', undefined)
  assert.match(view.text(), /队列已播放完/u)
  assert.doesNotMatch(view.text(), /后续曲目尚未读取|已加载/u)
})
