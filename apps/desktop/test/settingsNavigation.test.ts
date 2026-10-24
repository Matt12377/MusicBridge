import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_STORAGE_KEY,
  createSettingsNavigation,
  nextSettingsCategory,
  type SettingsCategory,
} from '../src/renderer/src/composables/useSettingsNavigation.js'

const categories = ['application', 'library', 'playback', 'roon', 'account', 'advanced'] as const
const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

test('设置按用户任务分为六类，生产与开发模式顺序一致', () => {
  assert.deepEqual(SETTINGS_CATEGORIES, categories)
  for (const mode of ['production', 'development'] as const) {
    assert.deepEqual(createSettingsNavigation(mode, memoryStorage()).visibleCategories.value, categories)
  }
})

test('首次进入或旧存储无效时默认通用，不将账户当作首次入口', () => {
  const storage = memoryStorage()
  assert.equal(createSettingsNavigation('production', storage).activeCategory.value, 'application')
  for (const stale of ['', 'general', 'local-library', 'diagnostics', '__proto__']) {
    storage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, stale)
    assert.equal(createSettingsNavigation('production', storage).activeCategory.value, 'application')
  }
})

test('历史五类ID继续恢复原任务，新增音乐库可独立记住且只保存分类ID', () => {
  for (const category of ['account', 'playback', 'roon', 'application', 'advanced'] as const) {
    const storage = memoryStorage()
    storage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, category)
    const navigation = createSettingsNavigation('production', storage)
    assert.equal(navigation.activeCategory.value, category)
    navigation.selectCategory('library')
    assert.equal(createSettingsNavigation('production', storage).activeCategory.value, 'library')
    assert.deepEqual([...storage.values.entries()], [[SETTINGS_CATEGORY_STORAGE_KEY, 'library']])
    navigation.selectCategory('unknown' as SettingsCategory)
    assert.equal(navigation.activeCategory.value, 'library')
    assert.equal(storage.getItem(SETTINGS_CATEGORY_STORAGE_KEY), 'library')
  }
})

test('偏好读取或写入不可用时，仍可进入通用并切换设置', () => {
  const navigation = createSettingsNavigation('production', {
    getItem() { throw new Error('合成偏好读取失败') },
    setItem() { throw new Error('合成偏好写入失败') },
  })
  assert.equal(navigation.activeCategory.value, 'application')
  assert.doesNotThrow(() => navigation.selectCategory('library'))
  assert.equal(navigation.activeCategory.value, 'library')
})

test('设置上下及左右键按六类顺序环绕，Home与End直达首尾', () => {
  for (const mode of ['production', 'development'] as const) {
    categories.forEach((category, index) => {
      const previous = categories[(index + categories.length - 1) % categories.length]!
      const next = categories[(index + 1) % categories.length]!
      for (const key of ['ArrowUp', 'ArrowLeft']) assert.equal(nextSettingsCategory(category, key, mode), previous)
      for (const key of ['ArrowDown', 'ArrowRight']) assert.equal(nextSettingsCategory(category, key, mode), next)
      assert.equal(nextSettingsCategory(category, 'Home', mode), 'application')
      assert.equal(nextSettingsCategory(category, 'End', mode), 'advanced')
    })
  }
})

test('设置键盘只消费导航键，选择结果持久保存且保留生产高级入口', () => {
  const storage = memoryStorage(), navigation = createSettingsNavigation('production', storage)
  let prevented = 0
  const press = (key: string) => navigation.onKeydown({ key, preventDefault() { prevented++ } } as KeyboardEvent)
  press('PageDown'); press('Enter'); press(' ')
  assert.equal(navigation.activeCategory.value, 'application'); assert.equal(prevented, 0)
  press('ArrowDown')
  assert.equal(navigation.activeCategory.value, 'library'); assert.equal(prevented, 1)
  press('End')
  assert.equal(navigation.activeCategory.value, 'advanced'); assert.equal(prevented, 2)
  assert.equal(storage.getItem(SETTINGS_CATEGORY_STORAGE_KEY), 'advanced')
  press('Home')
  assert.equal(navigation.activeCategory.value, 'application'); assert.equal(prevented, 3)
})
