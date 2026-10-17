import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import type { TrackSummary } from '@music-bridge/contracts'
import { mountVueSfc } from './support/mbf-vue-host.js'

const component = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/renderer/src/components/media/TrackTable.vue')
const track = (id: string, version: string): TrackSummary => ({ id, title: id === 'regular' ? '普通音轨' : 'CUE 段落', artists: ['合成作者'], album: '合成专辑', version })
const regular = track('regular', 'FLAC'), cue = track('cue', 'CUE 分段')

test('正式TrackTable逐曲guard覆盖按钮、Enter、doubleclick及context播放/入队/下一首', async t => {
  const plays: string[] = [], queues: string[] = [], nexts: string[] = []
  const f = await mountVueSfc(t, component, { tracks: [regular, cue], showArtwork: false, playableTrackIds: new Set(['regular']), onPlay: (value: TrackSummary) => plays.push(value.id), onQueue: (value: TrackSummary) => queues.push(value.id), 'onPlay-next': (value: TrackSummary) => nexts.push(value.id) })
  const row = (name: string) => f.all().find(element => element.matches('.track-row') && f.text(element).includes(name))!
  const button = (label: string) => f.all().find(element => element.props['aria-label'] === label)!
  const menu = (label: string) => f.all().find(element => element.props.role === 'menuitem' && f.text(element) === label)!
  assert.equal(button('播放 普通音轨').props.disabled, false); assert.equal(button('播放 CUE 段落').props.disabled, true)
  // 即使绕过DOM disabled主动调用处理器，资格检查仍必须生效。
  await f.dispatch(button('播放 CUE 段落'), 'onClick')
  await f.dispatch(row('CUE 段落'), 'onKeydown', { key: 'Enter' }); await f.dispatch(row('CUE 段落'), 'onDblclick')
  await f.dispatch(row('CUE 段落'), 'onContextmenu')
  for (const action of ['播放', '加入队列', '下一首播放']) { assert.equal(menu(action).props.disabled, true); await f.dispatch(menu(action), 'onClick') }
  assert.deepEqual([plays, queues, nexts], [[], [], []])
  await f.dispatch(button('播放 普通音轨'), 'onClick'); await f.dispatch(row('普通音轨'), 'onKeydown', { key: 'Enter' }); await f.dispatch(row('普通音轨'), 'onDblclick')
  for (const action of ['播放', '加入队列', '下一首播放']) {
    await f.dispatch(button('打开 普通音轨 的更多操作'), 'onClick'); assert.equal(menu(action).props.disabled, false); await f.dispatch(menu(action), 'onClick')
  }
  assert.deepEqual(plays, ['regular', 'regular', 'regular', 'regular']); assert.deepEqual(queues, ['regular']); assert.deepEqual(nexts, ['regular'])
})

test('不可直送的segment仍保留真实leading选择与信息slot，子控件Enter不冒泡成播放', async t => {
  const selected: string[] = [], details: string[] = [], plays: string[] = []
  const f = await mountVueSfc(t, component, { tracks: [regular, cue], showArtwork: false, playableTrackIds: new Set(['regular']), onPlay: (value: TrackSummary) => plays.push(value.id) }, {
    slots: vue => ({
      'row-leading': ({ track }: { track: TrackSummary }) => vue.h('input', { type: 'checkbox', 'aria-label': `选择 ${track.title}`, onChange: () => selected.push(track.id) }),
      'row-detail': ({ track }: { track: TrackSummary }) => vue.h('button', { type: 'button', 'aria-label': `查看 ${track.title} 的原信息菜单`, onClick: () => details.push(track.id) }, '详情'),
    }),
  })
  const checkbox = f.all().find(element => element.props['aria-label'] === '选择 CUE 段落')!, detail = f.all().find(element => element.props['aria-label'] === '查看 CUE 段落 的原信息菜单')!
  assert.equal(!!checkbox.props.disabled, false); assert.equal(!!detail.props.disabled, false)
  await f.dispatch(checkbox, 'onChange'); await f.dispatch(detail, 'onClick')
  const row = checkbox.closest('.track-row')!; await f.dispatch(row, 'onKeydown', { target: checkbox, key: 'Enter' })
  assert.deepEqual(selected, ['cue']); assert.deepEqual(details, ['cue']); assert.deepEqual(plays, [])
  assert.equal(f.all().find(element => element.props.role === 'table')?.props['aria-colcount'], 4)
  f.props.busy = true; await f.settle(); await f.dispatch(detail, 'onClick'); assert.deepEqual(details, ['cue', 'cue'])
})

test('显式playableSet与busy变化即时约束已打开context，不能由旧菜单绕过资格', async t => {
  const ids: string[] = []
  const f = await mountVueSfc(t, component, { tracks: [regular, cue], showArtwork: false, playableTrackIds: new Set(['regular']), onPlay: (value: TrackSummary) => ids.push(value.id), onQueue: (value: TrackSummary) => ids.push(value.id), 'onPlay-next': (value: TrackSummary) => ids.push(value.id) })
  await f.dispatch(f.all().find(element => element.props['aria-label'] === '打开 普通音轨 的更多操作'), 'onClick')
  f.props.playableTrackIds = new Set<string>(); await f.settle()
  for (const button of f.all().filter(element => element.props.role === 'menuitem')) { assert.equal(button.props.disabled, true); await f.dispatch(button, 'onClick') }
  f.props.playableTrackIds = new Set(['regular']); f.props.busy = true; await f.settle()
  for (const button of f.all().filter(element => element.props.role === 'menuitem')) { assert.equal(button.props.disabled, true); await f.dispatch(button, 'onClick') }
  const row = f.all().find(element => element.matches('.track-row') && f.text(element).includes('普通音轨'))!
  await f.dispatch(row, 'onKeydown', { key: 'Enter' }); await f.dispatch(row, 'onDblclick'); assert.deepEqual(ids, [])
})

test('省略playableSet时保持旧默认：busy禁播放，但入队和下一首仍可请求', async t => {
  const plays: string[] = [], queues: string[] = [], nexts: string[] = []
  const f = await mountVueSfc(t, component, { tracks: [cue], showArtwork: false, busy: true, onPlay: (value: TrackSummary) => plays.push(value.id), onQueue: (value: TrackSummary) => queues.push(value.id), 'onPlay-next': (value: TrackSummary) => nexts.push(value.id) })
  const more = () => f.all().find(element => element.props['aria-label'] === '打开 CUE 段落 的更多操作')!
  const menu = (label: string) => f.all().find(element => element.props.role === 'menuitem' && f.text(element) === label)!
  const row = f.all().find(element => element.matches('.track-row'))!
  await f.dispatch(row, 'onKeydown', { key: 'Enter' }); await f.dispatch(row, 'onDblclick')
  await f.dispatch(f.all().find(element => element.props['aria-label'] === '播放 CUE 段落'), 'onClick')
  await f.dispatch(more(), 'onClick'); assert.equal(menu('播放').props.disabled, true); await f.dispatch(menu('播放'), 'onClick')
  assert.equal(menu('加入队列').props.disabled, false); await f.dispatch(menu('加入队列'), 'onClick')
  await f.dispatch(more(), 'onClick'); assert.equal(menu('下一首播放').props.disabled, false); await f.dispatch(menu('下一首播放'), 'onClick')
  assert.deepEqual(plays, []); assert.deepEqual(queues, ['cue']); assert.deepEqual(nexts, ['cue'])
  f.props.busy = false; await f.settle(); await f.dispatch(row, 'onKeydown', { key: 'Enter' }); await f.dispatch(row, 'onDblclick')
  assert.deepEqual(plays, ['cue', 'cue'])
})
