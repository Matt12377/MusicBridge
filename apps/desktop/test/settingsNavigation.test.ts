import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SETTINGS_CATEGORIES,
  createSettingsNavigation,
  nextSettingsCategory,
  type SettingsCategory,
} from '../src/renderer/src/composables/useSettingsNavigation.js'

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

test('Settings categories keep the requested order and wrap keyboard movement', () => {
  assert.deepEqual(SETTINGS_CATEGORIES, ['account', 'playback', 'roon', 'application', 'advanced'])
  assert.equal(nextSettingsCategory('account', 'ArrowLeft', 'production'), 'advanced')
  assert.equal(nextSettingsCategory('application', 'ArrowRight', 'production'), 'advanced')
  assert.equal(nextSettingsCategory('application', 'End', 'production'), 'advanced')
  assert.equal(nextSettingsCategory('account', 'Home', 'production'), 'account')
  assert.equal(nextSettingsCategory('application', 'ArrowRight', 'development'), 'advanced')
})

test('Settings navigation remembers only an allowed non-sensitive category', () => {
  const storage = memoryStorage()
  storage.setItem('musicbridge.settings.category', 'roon')
  const production = createSettingsNavigation('production', storage)
  assert.equal(production.activeCategory.value, 'roon')
  production.selectCategory('advanced')
  assert.equal(production.activeCategory.value, 'advanced')
  production.selectCategory('application')
  assert.equal(production.activeCategory.value, 'application')
  assert.equal(storage.getItem('musicbridge.settings.category'), 'application')

  storage.setItem('musicbridge.settings.category', 'advanced')
  const productionAfterDevelopment = createSettingsNavigation('production', storage)
  assert.equal(productionAfterDevelopment.activeCategory.value, 'advanced')
  const development = createSettingsNavigation('development', storage)
  assert.equal(development.activeCategory.value, 'advanced')
})

test('Settings keyboard navigation ignores unrelated keys and exposes bounded Advanced in production', () => {
  const storage = memoryStorage()
  const navigation = createSettingsNavigation('production', storage)
  const before = navigation.activeCategory.value as SettingsCategory
  navigation.onKeydown({ key: 'PageDown', preventDefault() {} } as KeyboardEvent)
  assert.equal(navigation.activeCategory.value, before)
  navigation.onKeydown({ key: 'ArrowRight', preventDefault() {} } as KeyboardEvent)
  assert.equal(navigation.activeCategory.value, 'playback')
  navigation.onKeydown({ key: 'End', preventDefault() {} } as KeyboardEvent)
  assert.equal(navigation.activeCategory.value, 'advanced')
})
