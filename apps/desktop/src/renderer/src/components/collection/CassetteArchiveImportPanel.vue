<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, triggerRef } from 'vue'
import { createCassetteArchiveImportController } from './cassette-catalog-controller'

const emit = defineEmits<{ close: []; imported: [] }>()
const dialog = ref<HTMLDialogElement>()
const controller = createCassetteArchiveImportController({ api: window.musicBridge,
  onChange: () => triggerRef(state), onImported: () => emit('imported') })
const state = shallowRef(controller.state)
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => controller.dispose())
function close(): void { if (!state.value.busy) emit('close') }
</script>

<template>
  <dialog ref="dialog" class="cassette-import" aria-labelledby="cassette-import-title" @cancel.prevent="close">
    <header><div><p class="eyebrow">磁带资料 · 完整来源包</p><h2 id="cassette-import-title">导入完整磁带资料 ZIP</h2></div><button type="button" :disabled="state.busy" @click="close">关闭</button></header>
    <p>原书资料、主辅图与照片参考一起导入参考目录。已有库存与关联保留；资料条目不会自动变成“我的磁带”。</p>
    <button class="choose-file" type="button" :disabled="state.busy || !!state.pendingRequest" @click="controller.pickArchive()">{{ state.preview ? '重新选择完整 ZIP' : '选择完整 ZIP' }}</button>
    <p v-if="state.busy" role="status">正在处理资料包，请稍候…</p>
    <p v-if="state.error" class="feedback error" role="alert">{{ state.error }}</p>
    <p v-if="state.notice" class="feedback" role="status">{{ state.notice }}</p>

    <section v-if="state.preview" class="preview" aria-label="完整资料包预览">
      <h3>{{ state.preview.summary.title }}</h3><p>{{ state.preview.summary.sourceVersion }} · {{ state.preview.summary.bookId }}</p>
      <dl class="summary-counts">
        <div><dt>资料条目</dt><dd>{{ state.preview.summary.itemCount }}</dd></div>
        <div><dt>原书主图</dt><dd>{{ state.preview.summary.primaryCount }}</dd></div>
        <div><dt>缺主图条目</dt><dd>{{ state.preview.summary.missingPrimaryCount }}</dd></div>
        <div><dt>全部图片资产</dt><dd>{{ state.preview.summary.assetCount }}</dd></div>
        <div><dt>真实照片参考</dt><dd>{{ state.preview.summary.realPhotoCount }}</dd></div>
        <div><dt>展示用素材</dt><dd>{{ state.preview.summary.opaqueDisplayCount }}</dd></div>
      </dl>
      <p>本次版次变化：新增 {{ state.preview.delta.addedReferenceIds.length }} · 移除 {{ state.preview.delta.removedReferenceIds.length }} · 资料字段更新 {{ state.preview.delta.updatedReferenceIds?.length ?? 0 }} 项 · 合并 {{ state.preview.delta.merged }} · 拆分 {{ state.preview.delta.split }}</p>
      <details v-if="state.preview.delta.addedReferenceIds.length || state.preview.delta.removedReferenceIds.length || state.preview.delta.updatedReferenceIds?.length"><summary>查看全部受影响的资料 ID</summary><h4 v-if="state.preview.delta.addedReferenceIds.length">新增</h4><ul><li v-for="id in state.preview.delta.addedReferenceIds" :key="`added-${id}`">{{ id }}</li></ul><h4 v-if="state.preview.delta.removedReferenceIds.length">移除</h4><ul><li v-for="id in state.preview.delta.removedReferenceIds" :key="`removed-${id}`">{{ id }}</li></ul><h4 v-if="state.preview.delta.updatedReferenceIds?.length">资料字段更新</h4><ul><li v-for="id in state.preview.delta.updatedReferenceIds ?? []" :key="`updated-${id}`">{{ id }}</li></ul></details>
      <p>缺图条目继续保留。原书年份、未知信息与照片来源按资料原样展示，不推断生产年或拥有事实。</p>
      <details><summary>查看资料包身份</summary><p>{{ state.preview.summary.zipBytes.toLocaleString('zh-CN') }} 字节</p><code>{{ state.preview.summary.sha256 }}</code></details>
      <button class="primary" type="button" :disabled="state.busy || !!state.pendingRequest" @click="controller.importArchive(true)">确认导入并发布资料</button>
    </section>
    <section v-if="state.pendingRequest" class="feedback" aria-label="恢复完整资料包导入">
      <h3>等待原操作明确回执</h3><p>重试使用原命令与原资料包身份。关闭面板后，可从全局未确认操作继续核对。</p>
      <div class="actions"><button type="button" :disabled="state.busy" @click="controller.retry()">重试原操作</button><button type="button" :disabled="state.busy" @click="controller.releasePending()">退出本地重试</button></div>
    </section>
    <section v-if="state.result" class="preview" aria-label="完整资料包导入结果"><h3>已发布版次 {{ state.result.revision.sequence }}</h3><p>{{ state.result.revision.items.length }} 条资料 · 当前明确拥有 {{ state.result.currentCounts.owned }} 条。拥有事实沿用已确认关联与实际库存。</p><button class="primary" type="button" @click="close">查看全部磁带资料</button></section>
  </dialog>
</template>

<style scoped>
.cassette-import { box-sizing: border-box; width: min(760px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 24px; overflow: auto; border: 1px solid var(--mb-glass-border); border-radius: 16px; background: var(--mb-bg-base); color: var(--mb-text-primary); font-size: 13px; line-height: 1.7; }
.cassette-import::backdrop { background: #0009; } header, .actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; } .actions { justify-content: flex-start; flex-wrap: wrap; }
h2 { margin: 0; font-size: 23px; } h3 { margin: 0 0 8px; font-size: 16px; } p { color: var(--mb-text-secondary); } .eyebrow { margin: 0 0 6px; color: var(--mb-accent); font-size: 12px; }
button { min-height: 44px; padding: 9px 13px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-glass-clear); color: var(--mb-text-primary); font: inherit; cursor: pointer; } button:disabled { opacity: .5; cursor: default; } .primary { border-color: var(--mb-accent); color: var(--mb-accent); font-weight: 650; }
.preview, .feedback { padding: 18px; margin: 18px 0; border: 1px solid var(--mb-glass-border); border-radius: 10px; background: var(--mb-glass-clear); } .error { border-left: 3px solid var(--mb-accent); }
.summary-counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 18px 0; } dt { color: var(--mb-text-secondary); font-size: 12px; } dd { margin: 4px 0 0; font-size: 24px; font-variant-numeric: tabular-nums; }
details { margin: 14px 0; } summary { min-height: 36px; cursor: pointer; } code { overflow-wrap: anywhere; font-size: 11px; }
:where(button, summary):focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; } button:active:not(:disabled) { transform: scale(.98); }
@media (max-width: 540px) { .cassette-import { padding: 18px; } .summary-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
