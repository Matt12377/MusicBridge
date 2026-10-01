import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { PlaybackSnapshot, PlaybackStreamStamp } from '@music-bridge/contracts'
import type { MusicBridgePublicApi } from '../src/preload/api.js'
import { usePlaybackSession } from '../src/renderer/src/composables/application/usePlaybackSession.js'

interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, unknown> }
async function mounted(t: test.TestContext, name: 'player/PlayerProgress' | 'NowPlayingView') {
  const { parse, compileScript } = await import('@vue/compiler-sfc'), ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const filename = new URL(`../src/renderer/src/components/${name}.vue`, import.meta.url)
  const { descriptor, errors } = parse(await readFile(filename, 'utf8')); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'playback-stream-ui', inlineTemplate: true })
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const details = await import('../src/renderer/src/components/player/details.js'), clock = await import('../src/renderer/src/components/player/playbackClock.js')
  const status = await import('../src/renderer/src/roon-queue-context-status.js')
  const load = (path: string) => path === 'vue' ? vue : path.endsWith('details.js') ? details
    : path.endsWith('playbackClock.js') ? clock : path.endsWith('roon-queue-context-status.js') ? status
    : path.endsWith('.vue') ? { default: { render: () => null } } : require(path)
  const component = { exports: {} as { default: import('vue').Component } }
  class Input { constructor(public value: string) {} }
  new Function('require', 'module', 'exports', 'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLInputElement', 'performance', compiled)(
    load, component, component.exports, () => 1, () => undefined, Input, { now: () => 0 })
  const node = (tag = ''): Host => ({ tag, text: '', children: [], parent: null, props: {} })
  const renderer = vue.createRenderer<Host, Host>({
    createElement: node, createText(value) { const result = node('#text'); result.text = value; return result }, createComment: () => node('#comment'),
    setText(target, value) { target.text = value }, setElementText(target, value) { target.text = value; target.children = [] }, patchProp(target, key, _old, value) { target.props[key] = value },
    insert(child, parent, anchor) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; if (i < 0) parent.children.push(child); else parent.children.splice(i, 0, child) },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = null }, parentNode: target => target.parent,
    nextSibling: target => target.parent?.children[(target.parent?.children.indexOf(target) ?? -1) + 1] ?? null,
  })
  const track = { id: '1', title: '合成曲目', artists: ['合成艺人'], album: '合成专辑', durationMs: 180000 }
  const snapshot: PlaybackSnapshot = { state: 'playing', source: 'netease', selectedZoneId: 'zone-a', currentTrack: track, positionMs: 10000,
    queue: { items: [], index: -1, hasNext: false, hasPrevious: false }, canNext: false, canPrevious: false, canStop: true, canPause: true, canResume: false }
  const props = vue.reactive({ snapshot, allowed: true, playbackState: snapshot, currentTrack: track, clockIdentity: 'owner-1',
    lyricsSnapshot: { status: 'unavailable', lines: [], activeLineIndex: -1, timingSource: 'static' }, qualityLabel: () => '实际音质', playbackIssueMessage: () => '',
    trackLikeState: 'idle', trackLikeAvailable: true, playbackSource: 'netease', seekAllowed: true, localLyricsMatchState: { status: 'hidden', candidates: [], canRevoke: false } })
  const callbacks: Array<(position?: number) => void> = []
  let session: ReturnType<typeof usePlaybackSession> | undefined
  const app = renderer.createApp({ render: () => vue.h(component.exports.default, { ...props, onSeek: (position: number, settle: (position?: number) => void) => {
    callbacks.push(settle); if (session) void session.seekPlayback(position, settle)
  } }) })
  const root = node('root'); app.mount(root); t.after(() => app.unmount()); await vue.nextTick()
  const all = (): Host[] => { const result: Host[] = []; const walk = (n: Host) => { result.push(n); n.children.forEach(walk) }; walk(root); return result }
  const input = () => all().find(n => n.tag === 'input' && n.props.type === 'range')!
  const event = (value: number) => ({ target: new Input(String(value)) })
  const update = async (position: number, owner = props.clockIdentity) => { props.clockIdentity = owner; props.snapshot = { ...snapshot, positionMs: position }; props.playbackState = props.snapshot; await vue.nextTick() }
  function connect(value: ReturnType<typeof usePlaybackSession>): void {
    session = value
    const stop = vue.watch(() => [value.playbackState.value, value.playbackClockIdentity.value], () => {
      if (value.playbackState.value) { props.snapshot = value.playbackState.value; props.playbackState = value.playbackState.value }
      props.clockIdentity = value.playbackClockIdentity.value ?? ''
    }, { immediate: true, flush: 'sync' })
    t.after(stop)
  }
  return { input, event, callbacks, update, connect, flush: vue.nextTick, snapshot }
}
for (const component of ['player/PlayerProgress', 'NowPlayingView'] as const) {
  test(`MBP006 mounted ${component} 拖动与在途确认抵抗progress，同曲新owner撤旧草稿`, async t => {
    const h = await mounted(t, component)
    ;(h.input().props.onInput as (e: unknown) => void)(h.event(50000)); await h.flush()
    await h.update(11000); assert.equal(Number(h.input().props.value), 50000)
    ;(h.input().props.onChange as (e: unknown) => void)(h.event(50000)); await h.flush()
    assert.equal(h.callbacks.length, 1, 'seek只派发一次')
    assert.equal(Number(h.input().props.value), 50000); assert.equal(typeof h.callbacks[0], 'function')
    await h.update(12000); assert.equal(Number(h.input().props.value), 50000)
    await h.update(0, 'owner-2'); assert.equal(Number(h.input().props.value), 0)
    h.callbacks[0]!(50000); await h.flush(); assert.equal(Number(h.input().props.value), 0)
  })
  test(`MBP006 mounted ${component} seek确认保护旧位置，失败恢复设备观测`, async t => {
    const h = await mounted(t, component)
    ;(h.input().props.onChange as (e: unknown) => void)(h.event(50000)); await h.flush()
    assert.equal(typeof h.callbacks[0], 'function'); h.callbacks[0]!(50000); await h.flush()
    await h.update(11000); assert.equal(Number(h.input().props.value), 50000)
    ;(h.input().props.onChange as (e: unknown) => void)(h.event(30000)); await h.flush()
    h.callbacks[1]!(undefined); await h.flush(); assert.equal(Number(h.input().props.value), 11000)
  })
  test(`MBP006 mounted ${component} 实际Session旧ACK/旧full保留草稿直到晚设备观测`, async t => {
    const h = await mounted(t, component)
    const instance = '30000000-0000-4000-8000-000000000001'
    const stamp = (sequence: number, generation = 1): PlaybackStreamStamp => ({ coreInstanceId: instance, sequence, generation,
      queueRevision: 1, trackId: '1', selectedZoneId: 'zone-a', source: 'netease' })
    let reply!: (value: { positionMs: number }) => void
    const ack = new Promise<{ positionMs: number }>(resolve => { reply = resolve })
    const api = { getPlaybackStreamSnapshot: async () => ({ stamp: stamp(1), snapshot: h.snapshot }), seek: () => ack,
      getLyrics: async () => ({ status: 'unavailable', lines: [], activeLineIndex: -1, timingSource: 'static' }),
      getTrackLikeStatus: async () => ({ liked: false }) } as unknown as MusicBridgePublicApi
    const session = usePlaybackSession({ api, getSelectedZone: () => ({ zoneId: 'zone-a', displayName: '合成Zone', selected: true, seekAllowed: true }),
      getZoneLifecycleStatus: () => 'selected', getSelectedQuality: () => 'auto', getMatchResult: () => undefined, getPendingMatch: () => undefined,
      onMatchTracks: () => undefined, getRoonPlaybackContext: () => undefined, resolveFavoriteDescriptor: () => { throw new Error('不可调用') },
      onEnterNowPlaying: () => undefined, clearActionError: () => undefined, onActionMessage: () => undefined, onError: e => { throw e }, onToast: () => undefined })
    t.after(() => session.dispose()); await session.initializePlaybackStream(); h.connect(session); await h.flush()
    ;(h.input().props.onChange as (e: unknown) => void)(h.event(50000)); await h.flush()
    assert.equal(h.callbacks.length, 1, 'seek只派发一次')
    assert.equal(session.playbackSyncStatus.value, 'ready')
    assert.equal(session.playbackState.value!.currentTrack?.durationMs, 180000)
    assert.equal(Number(h.input().props.value), 50000, '派发seek后仍显示草稿')
    session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(2), snapshot: { ...h.snapshot, positionMs: 10000 } } })
    reply({ positionMs: 10000 }); await new Promise<void>(resolve => setImmediate(resolve)); await h.flush()
    assert.equal(Number(h.input().props.value), 50000)
    assert.equal(session.playbackState.value!.positionMs, 10000)
    session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(3), positionMs: 11000 } }); await h.flush()
    assert.equal(Number(h.input().props.value), 50000)
    session.acceptPlaybackStreamEvent({ event: 'playback.progress', payload: { stamp: stamp(4), positionMs: 50000 } }); await h.flush()
    assert.equal(Number(h.input().props.value), 50000); assert.equal(session.playbackState.value!.positionMs, 50000)
    session.acceptPlaybackStreamEvent({ event: 'playback.snapshot', payload: { stamp: stamp(5, 2), snapshot: { ...h.snapshot, positionMs: 0 } } }); await h.flush()
    assert.equal(Number(h.input().props.value), 0)
  })
}
