import assert from 'node:assert/strict'
import test from 'node:test'
import { createGridRows, gridWindowIndices } from '../src/renderer/src/composables/gridWindow.js'
test('007 行高取每行最大值、最后无多余gap，年份/状态不按首行平均外推', () => {
  const rows = createGridRows([240, 260, 240, 300, 240], 2, 28)
  assert.deepEqual(rows.tops, [0, 288, 616]); assert.deepEqual(rows.heights, [260, 300, 240]); assert.equal(rows.totalHeight, 856)
})
test('007 不同grid起点/完全离窗为空，5000末行可达而不是clamp未看见的grid', () => {
  const rows = createGridRows(Array(5000).fill(240), 5, 28)
  assert.deepEqual(gridWindowIndices(rows, 5000, -900, -100), []); assert.deepEqual(gridWindowIndices(rows, 5000, rows.totalHeight + 1, rows.totalHeight + 500), [])
  const last = gridWindowIndices(rows, 5000, rows.totalHeight - 620, rows.totalHeight)
  assert.equal(last.at(-1), 4999); assert.ok(last.length <= 35)
})
test('007 焦点只增加离散一行，不把远处焦点到当前窗口之间5000项挂载', () => {
  const rows = createGridRows(Array(5000).fill(240), 4, 28)
  const indices = gridWindowIndices(rows, 5000, 100_000, 100_620, 2, 1)
  assert.deepEqual(indices.slice(0, 4), [0, 1, 2, 3]); assert.ok(indices.length <= 36); assert.ok(!indices.includes(100))
})
test('007 resize换列与空dataset保持总高/索引正确', () => {
  assert.equal(createGridRows([], 4, 28).totalHeight, 0)
  assert.equal(createGridRows([200, 220, 200, 200], 2, 24).totalHeight, 444)
  assert.deepEqual(gridWindowIndices(createGridRows([200, 220, 200, 200], 4, 24), 4, 0, 620), [0, 1, 2, 3])
})

test('007 R1 收藏probe按当前状态重建重试布局，保留取消收藏且不继承另一状态按钮', async () => {
  const { prepareFavoriteCardProbe } = await import('../src/renderer/src/composables/gridCardProbe.js')
  type Button = { textContent: string; disabled: boolean; type: string; className: string; remove: () => void }
  const buttons: Button[] = [], label = { textContent: '' }, open = { disabled: true }
  function button(textContent: string): Button { const value = { textContent, disabled: false, type: 'button', className: 'text-button', remove() { const i = buttons.indexOf(value); if (i >= 0) buttons.splice(i, 1) } }; return value }
  const remove = button('取消收藏'); buttons.push(remove)
  const actions = { querySelectorAll: () => [...buttons], get firstChild() { return buttons[0] }, insertBefore(value: Button) { buttons.unshift(value) } }
  const element = { querySelector: (selector: string) => selector === '.favorite-entity-status' ? label : selector === '.favorite-open' ? open : actions, ownerDocument: { createElement: () => button('') } } as unknown as HTMLElement
  prepareFavoriteCardProbe(element, { message: '当前资料库未找到，收藏仍保留', ready: false, retry: true, resolving: true })
  assert.equal(label.textContent, '当前资料库未找到，收藏仍保留'); assert.equal(open.disabled, true); assert.deepEqual(buttons.map(b => [b.textContent, b.disabled]), [['重试匹配', true], ['取消收藏', false]])
  prepareFavoriteCardProbe(element, { message: '点击打开', ready: true, retry: false, resolving: false })
  assert.equal(open.disabled, false); assert.deepEqual(buttons, [remove])
  prepareFavoriteCardProbe(element, { message: '暂时无法连接资料库，点击重试', ready: false, retry: true, resolving: false })
  assert.equal(open.disabled, true); assert.deepEqual(buttons.map(b => [b.textContent, b.disabled]), [['重试匹配', false], ['取消收藏', false]])
  prepareFavoriteCardProbe(element, { message: '正在匹配资料库…', ready: false, retry: false, resolving: true })
  assert.deepEqual(buttons, [remove]); assert.equal(open.disabled, true)
})
