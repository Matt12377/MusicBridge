<script setup lang="ts">
import { collectionModelLabel } from './collection-display'
import { nextTick, ref } from 'vue'
import type { CollectionDetail, CollectionPhoto, CollectionChangePhotoRequest } from '@music-bridge/contracts'
import CollectionPhotoView from './CollectionPhoto.vue'
const props = defineProps<{ detail: CollectionDetail; busy: boolean }>()
const emit = defineEmits<{ add: [physicalId?: string]; change: [request: CollectionChangePhotoRequest] }>()
const preview = ref<CollectionPhoto>()
const viewer = ref<HTMLDialogElement>()
const removing = ref<string>()
const refresh = ref(0)
async function show(photo: CollectionPhoto): Promise<void> { preview.value = photo; await nextTick(); viewer.value?.showModal() }
function onClose(): void {
  // 上一次 close 事件可能晚于重新打开，只清理仍处于关闭状态的预览。
  if (!viewer.value?.open) preview.value = undefined
}
function change(photo: CollectionPhoto, action: CollectionChangePhotoRequest['action']): void {
  removing.value = undefined
  emit('change', { commandId: crypto.randomUUID(), modelId: props.detail.model.id, photoId: photo.id, expectedRevision: props.detail.model.revision, action })
}
</script>
<template>
  <section class="photos" aria-label="实物照片">
    <header><div><h3>实物照片 <span>{{ detail.photos?.length ?? 0 }} / 24</span></h3><p>照片只用于展示，不会增加库存。点击照片查看大图。</p></div><div class="photo-tools"><button v-if="detail.photos?.length" :disabled="busy" @click="refresh++">重新加载照片</button><button :disabled="busy || (detail.photos?.length ?? 0) >= 24" @click="emit('add')">添加实物照片</button></div></header>
    <div v-if="detail.photos?.length" class="photo-grid">
      <figure v-for="(photo, index) in detail.photos" :key="photo.id">
        <button class="photo-open" :aria-label="`查看实物照片 ${index + 1}`" @click="show(photo)"><CollectionPhotoView :key="`${photo.id}:${refresh}`" :photo="photo" :alt="`${collectionModelLabel(detail.model)} 实物照片 ${index + 1}`" /></button>
        <figcaption><span>{{ photo.physicalId ?? '型号实物照片' }}</span><span v-if="detail.model.featuredPhoto?.id === photo.id" class="featured">收藏墙代表图</span></figcaption>
        <div class="photo-actions"><button :disabled="busy || detail.model.featuredPhoto?.id === photo.id" @click="change(photo, 'feature')">设为代表图</button><button :disabled="busy" @click="removing = photo.id">移除照片</button></div>
        <div v-if="removing === photo.id" class="remove-confirm" role="group" aria-label="确认移除照片"><p>仅移除应用内副本，原文件和库存不变。</p><button :disabled="busy" @click="change(photo, 'remove')">确认移除</button><button @click="removing = undefined">取消</button></div>
      </figure>
    </div>
    <p v-else class="no-photo">添加型号照片即可开始，无需为每盘磁带建立编号。支持 PNG / JPEG，原文件保持不变。</p>
    <dialog ref="viewer" aria-label="实物照片大图" @close="onClose"><button class="close-preview" @click="viewer?.close()">关闭大图</button><div v-if="preview" class="preview-image"><CollectionPhotoView :photo="preview" :alt="`${collectionModelLabel(detail.model)} 实物照片大图`" interactive /></div></dialog>
  </section>
</template>
<style scoped>
.photos { margin: 26px 0; }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
h3 { margin: 0; font-size: 17px; } h3 span { margin-left: 8px; color: var(--mb-text-secondary); font-size: 12px; font-weight: 400; }
p { color: var(--mb-text-secondary); font-size: 12px; line-height: 1.8; margin: 8px 0; }
.photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(210px, 100%), 1fr)); gap: 18px; }
figure { min-width: 0; margin: 0; } button { min-height: 38px; padding: 8px 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; color: var(--mb-text-primary); background: var(--mb-glass-clear); font-size: 12px; }
.photo-open { display: block; width: 100%; aspect-ratio: 1.6; padding: 8px; border-radius: 12px; overflow: hidden; }
figcaption { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--mb-text-secondary); margin: 12px 0; overflow-wrap: anywhere; }
.featured { color: var(--mb-accent); } .photo-actions, .photo-tools { display: flex; flex-wrap: wrap; gap: 8px; }
.no-photo { padding: 20px; border: 1px dashed var(--mb-glass-border); border-radius: 12px; }
button:disabled { opacity: .5; cursor: not-allowed; } .remove-confirm { margin-top: 8px; padding: 12px; background: var(--mb-bg-base); border-radius: 8px; } .remove-confirm button { margin-right: 8px; }
dialog { width: min(900px, calc(100vw - 48px)); max-height: calc(100dvh - 48px); box-sizing: border-box; padding: 18px; border: 1px solid var(--mb-glass-border); border-radius: 16px; color: var(--mb-text-primary); background: var(--mb-bg-base); }
dialog::backdrop { background: #000b; } .close-preview { display: block; margin: 0 0 14px auto; } .preview-image { height: min(65dvh, 650px); }
</style>
