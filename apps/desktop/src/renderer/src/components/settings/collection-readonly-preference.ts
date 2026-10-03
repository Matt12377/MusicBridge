import { readonly, ref } from 'vue'
import { isCollectionReadonlySettings, type CollectionReadonlyPublicApi, type CollectionReadonlySettings } from '@music-bridge/contracts'

export function createCollectionReadonlyPreference(api: Pick<CollectionReadonlyPublicApi, 'getCollectionReadonlySettings' | 'setCollectionReadonlyEnabled'>) {
  const settings = ref<CollectionReadonlySettings>({ schemaVersion: 1, enabled: false, mode: 'node', state: 'off' })
  const requested = ref(false), error = ref(''), saving = ref(false)
  let generation = 0, read = 0, active = true
  const accept = (value: CollectionReadonlySettings): void => {
    if (!isCollectionReadonlySettings(value)) throw new Error('收藏查询设置回执无效。')
    settings.value = { ...value }; requested.value = value.enabled
  }
  async function reload(): Promise<void> {
    const own = generation, ownRead = ++read
    try { const value = await api.getCollectionReadonlySettings(); if (active && own === generation && ownRead === read && !saving.value) accept(value) }
    catch { if (active && own === generation && ownRead === read) error.value = '查询设置暂时无法读取；标准库存查询仍可使用。' }
  }
  async function select(enabled: boolean): Promise<void> {
    if (!active || typeof enabled !== 'boolean') return
    const own = ++generation; ++read
    requested.value = enabled; saving.value = true; error.value = ''
    try { const value = await api.setCollectionReadonlyEnabled(enabled); if (active && own === generation) accept(value) }
    catch { if (active && own === generation) { requested.value = settings.value.enabled; error.value = '偏好未保存，请重试；上次已保存设置仍保留。' } }
    finally { if (active && own === generation) { saving.value = false; void reload() } }
  }
  return { settings: readonly(settings), requested: readonly(requested), error: readonly(error), saving: readonly(saving), reload, select,
    close() { active = false; generation++; read++ } }
}
