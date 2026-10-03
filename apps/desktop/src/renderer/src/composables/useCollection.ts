import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { CollectionDetail, CollectionFilter, CollectionModel, CollectionMutationResult, Page } from '@music-bridge/contracts'

const firstPage = { offset: 0, limit: 24 }

export function useCollection() {
  const catalog = shallowRef<Page<CollectionModel>>()
  const detail = shallowRef<CollectionDetail>()
  const filter = ref<CollectionFilter>({})
  const loading = ref(false)
  const saving = ref(false)
  const refreshing = ref(false)
  const error = ref('')
  const notice = ref('')
  const pending = shallowRef<(() => Promise<CollectionMutationResult>)>()
  let listGeneration = 0
  let detailGeneration = 0
  let active = true
  let refreshGeneration = 0
  let requestedOffset = 0
  let requestedDetail: { modelId: string; offset: number } | undefined

  async function load(offset = catalog.value?.offset ?? 0): Promise<void> {
    requestedOffset = offset
    const generation = ++listGeneration
    loading.value = true
    try {
      const result = await window.musicBridge.listCollection({ ...firstPage, offset }, { ...filter.value })
      if (active && generation === listGeneration) { catalog.value = result; if (!pending.value) error.value = '' }
    } catch {
      if (active && generation === listGeneration) error.value = '无法读取库存。请重试；现有数据不会被清空。'
    } finally { if (active && generation === listGeneration) loading.value = false }
  }
  async function openModel(modelId: string, offset = 0): Promise<void> {
    requestedDetail = { modelId, offset }
    const generation = ++detailGeneration
    try {
      const result = await window.musicBridge.getCollectionModel(modelId, { offset, limit: 20 })
      if (active && generation === detailGeneration) { detail.value = result; if (!pending.value) error.value = '' }
    } catch {
      if (active && generation === detailGeneration) error.value = '无法读取型号详情，请刷新后重试。'
    }
  }
  function closeModel(): void { ++detailGeneration; requestedDetail = undefined; detail.value = undefined }

  async function refresh(): Promise<void> {
    if (!active || refreshing.value || saving.value || pending.value) return
    const generation = ++refreshGeneration
    ++listGeneration; ++detailGeneration
    refreshing.value = true; loading.value = false; notice.value = ''
    try {
      const result = await window.musicBridge.refreshCollection()
      if (!active || generation !== refreshGeneration) return
      // 刷新等待期间的筛选/翻页/详情意图始终优先，旧读取不能回跳。
      await load(requestedOffset)
      if (!active || generation !== refreshGeneration) return
      const selected = requestedDetail
      if (selected) await openModel(selected.modelId, selected.offset)
      if (active && generation === refreshGeneration && !error.value) notice.value = result.refreshed
        ? '库存已刷新，Rust 收藏查询已就绪。'
        : result.settings.state === 'failed' || result.settings.state === 'blocked'
          ? '已通过标准查询刷新库存；Rust 查询暂不可用。' : '库存已通过标准查询刷新。'
    } catch {
      if (active && generation === refreshGeneration) error.value = '库存刷新未完成。原有数据保留，请重试。'
    } finally { if (active && generation === refreshGeneration) refreshing.value = false }
  }

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
    if (saving.value || pending.value || refreshing.value) return false
    notice.value = ''
    pending.value = operation
    return retry()
  }
  async function addPhoto(physicalId?: string): Promise<void> {
    if (saving.value || pending.value || refreshing.value || !detail.value) return
    const modelId = detail.value.model.id
    saving.value = true; error.value = ''; notice.value = ''
    try {
      const image = await window.musicBridge.pickCollectionPhoto()
      saving.value = false
      if (!image || !active) return
      const request = { commandId: crypto.randomUUID(), modelId, image, ...(physicalId ? { physicalId } : {}) }
      await mutate(() => window.musicBridge.addCollectionPhoto(request))
    } catch {
      error.value = '照片未导入。请选择 25 MB、4000 万像素以内的有效 PNG / JPEG 普通文件；原文件未修改。'
    } finally { saving.value = false }
  }
  onMounted(() => { void load() })
  onUnmounted(() => { active = false; ++listGeneration; ++detailGeneration; ++refreshGeneration })
  return { catalog, detail, filter, loading, saving, refreshing, error, notice, pending, blocked: computed(() => saving.value || !!pending.value || refreshing.value), load, refresh, openModel, closeModel, mutate, retry, addPhoto }
}
