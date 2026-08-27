import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { CollectionDetail, CollectionModel, CollectionMutationResult, Page } from '@music-bridge/contracts'

const firstPage = { offset: 0, limit: 24 }

export function useCollection() {
  const catalog = shallowRef<Page<CollectionModel>>()
  const detail = shallowRef<CollectionDetail>()
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const notice = ref('')
  const pending = shallowRef<(() => Promise<CollectionMutationResult>)>()
  let listGeneration = 0
  let detailGeneration = 0
  let active = true

  async function load(offset = catalog.value?.offset ?? 0): Promise<void> {
    const generation = ++listGeneration
    loading.value = true
    try {
      const result = await window.musicBridge.listCollection({ ...firstPage, offset })
      if (active && generation === listGeneration) { catalog.value = result; if (!pending.value) error.value = '' }
    } catch {
      if (active && generation === listGeneration) error.value = '无法读取库存。请重试；现有数据不会被清空。'
    } finally { if (active && generation === listGeneration) loading.value = false }
  }
  async function openModel(modelId: string, offset = 0): Promise<void> {
    const generation = ++detailGeneration
    try {
      const result = await window.musicBridge.getCollectionModel(modelId, { offset, limit: 20 })
      if (active && generation === detailGeneration) { detail.value = result; if (!pending.value) error.value = '' }
    } catch {
      if (active && generation === detailGeneration) error.value = '无法读取型号详情，请刷新后重试。'
    }
  }
  function closeModel(): void { ++detailGeneration; detail.value = undefined }

  async function retry(): Promise<boolean> {
    if (!pending.value || saving.value) return false
    saving.value = true
    error.value = ''
    try {
      const result = await pending.value()
      pending.value = undefined
      notice.value = '库存已保存'
      await load()
      if (detail.value?.model.id === result.modelId) await openModel(result.modelId, detail.value.lots.offset)
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : ''
      if (message.includes('INVENTORY_CONFLICT') || message.includes('INVALID_IPC_REQUEST')) {
        // 明确拒绝代表没有提交；可以刷新后重新编辑。未知结果则只允许重放原命令。
        pending.value = undefined
        error.value = '操作未提交：请检查数量、库存状态和保护设置，刷新后重试。'
      } else {
        error.value = '尚未确认保存结果。请重试原操作；重复请求不会重复增加库存。'
      }
      return false
    } finally { saving.value = false }
  }
  async function mutate(operation: () => Promise<CollectionMutationResult>): Promise<boolean> {
    if (saving.value || pending.value) return false
    notice.value = ''
    pending.value = operation
    return retry()
  }
  onMounted(() => { void load() })
  onUnmounted(() => { active = false; ++listGeneration; ++detailGeneration })
  return { catalog, detail, loading, saving, error, notice, pending, blocked: computed(() => saving.value || !!pending.value), load, openModel, closeModel, mutate, retry }
}
