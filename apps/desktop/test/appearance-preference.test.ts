import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppearancePreference } from '../src/renderer/src/appearance.js'

test('默认浅色，恢复保存的深色；无效值不进入主题状态', () => {
  for (const [stored, expected] of [[null, 'light'], ['dark', 'dark'], ['light', 'light'], ['system', 'light']]) {
    const applied: string[] = []
    const pref = createAppearancePreference({ read: () => stored, write: () => {}, apply: value => applied.push(value) })
    assert.equal(pref.theme.value, expected)
    assert.deepEqual(applied, [expected])
  }
})

test('手动切换即时应用并持久化，相同值不重复写入', () => {
  let stored: string | null = null
  const applied: string[] = [], written: string[] = []
  const deps = { read: () => stored, write: (value: string) => { stored = value; written.push(value) }, apply: (value: string) => applied.push(value) }
  const pref = createAppearancePreference(deps)
  pref.select('dark'); pref.select('dark')
  assert.deepEqual(written, ['dark'])
  assert.equal(createAppearancePreference(deps).theme.value, 'dark')
  pref.select('light')
  assert.equal(stored, 'light')
  assert.equal(pref.theme.value, 'light')
})

test('本地存储不可用时仍能切换，异常不会阻断应用启动', () => {
  const pref = createAppearancePreference({ read: () => { throw Error('不可读') }, write: () => { throw Error('不可写') }, apply: () => {} })
  assert.equal(pref.theme.value, 'light')
  assert.doesNotThrow(() => pref.select('dark'))
  assert.equal(pref.theme.value, 'dark')
})
