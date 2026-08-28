<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { CommandOutboxState, CommandOutboxTrackedCommand, CommandOutboxView } from '@music-bridge/contracts'
import { canRetryOutboxItem, createCommandOutboxController, outboxErrorMessage } from './command-outbox/controller.js'

const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const retryConfirm = ref<Record<string, boolean>>({})
const dismissConfirm = ref<Record<string, boolean>>({})
const visibleCount = ref(20)
const controller = createCommandOutboxController({ api: window.musicBridge, onChange: (value) => { state.value = value } })
const state = shallowRef(controller.state)
const entries = computed(() => state.value.overview?.entries.filter((item) => !item.acknowledged && item.state !== 'dismissed') ?? [])
const visibleEntries = computed(() => entries.value.slice(0, visibleCount.value))
const labels: Record<CommandOutboxTrackedCommand, string> = {
  'referenceCatalog.registerSource': '登记参考资料版本', 'referenceCatalog.publishRevision': '发布参考目录修订', 'referenceCatalog.setMatch': '确认目录关联与缺失状态',
  'collection.receive': '库存入库', 'collection.materialize': '登记实物副本', 'collection.updateCopy': '更新实物副本',
  'collection.setPolicy': '更新库存使用策略', 'collection.addPhoto': '添加库存照片', 'collection.changePhoto': '修改库存照片',
  'physicalMusic.saveRelease': '保存实体音乐发行', 'physicalMusic.saveLegacy': '保存既有录音',
  'physicalMusic.addPhoto': '添加实体音乐照片', 'physicalMusic.removePhoto': '移除实体音乐照片',
  'physicalLinks.confirm': '确认实体关系', 'physicalLinks.relocate': '调整实体位置', 'physicalLinks.register': '登记实体关系',
  'physicalLinks.remove': '移除实体关系', 'physicalLinks.absence': '登记实体缺失',
  'recordingDrafts.append': '追加录音草稿', 'recordingDrafts.update': '更新录音草稿',
  'recordingSources.chooseRoot': '选择来源目录', 'recordingSources.choose': '选择来源文件',
  'recordingSources.revoke': '撤销来源授权', 'recordingSources.cancel': '取消来源检查',
  'recordingSources.confirm': '确认来源证据', 'recordingSources.recheck': '重新检查来源',
  'recordingMedia.save': '保存载体规划', 'recordingMedia.reserve': '预留载体库存', 'recordingMedia.release': '释放载体预留',
  'recordingVersions.freeze': '冻结录音版本', 'recordingVersions.cancel': '取消录音版本',
  'recordingPreparation.chooseDestination': '选择准备目录', 'recordingPreparation.revoke': '撤销准备目录授权',
  'recordingPreparation.start': '开始文件准备', 'recordingPreparation.cancel': '取消文件准备',
  'recordingPrepared.choose': '选择准备文件', 'recordingPrepared.revoke': '撤销准备文件授权',
  'recordingPrepared.startImport': '开始导入准备文件', 'recordingPrepared.cancel': '取消准备文件导入', 'recordingPrepared.freeze': '冻结准备文件',
  'recordingProfiles.save': '保存录音配置', 'recordingProfiles.saveSession': '保存录音会话配置',
  'recordingExecution.start': '生成执行资产', 'recordingExecution.cancel': '取消执行资产生成',
  'recordingArchive.choose': '选择归档目录', 'recordingArchive.initialize': '初始化归档目录',
  'recordingArchive.revokeRoot': '撤销归档授权', 'recordingArchive.start': '开始归档',
  'recordingArchive.cancel': '取消归档', 'recordingArchive.resume': '继续归档',
  'recordingBackups.choose': '选择备份或恢复目录', 'recordingBackups.start': '开始备份维护',
  'recordingBackups.cancel': '取消备份维护', 'recordingBackups.revoke': '撤销备份目录授权',
  'recordingBackups.activate': '切换恢复工作库',
}
const stateLabels: Record<CommandOutboxState, string> = {
  pending: '已记录，待确认', sending: '正在处理', uncertain: '结果未知',
  succeeded: '已成功，待确认', rejected: '已拒绝，需核对', dismissed: '已放弃跟踪',
}
function nativeChoice(item: CommandOutboxView): boolean { return item.command.includes('.choose') }
function oldDataset(item: CommandOutboxView): boolean { return item.datasetId !== state.value.overview?.datasetId }
function busy(item: CommandOutboxView): boolean { return state.value.busyIds.includes(item.id) }
function retryLabel(item: CommandOutboxView): string {
  if (item.command === 'recordingBackups.activate') return oldDataset(item) ? '恢复切换回执' : '恢复原激活回执'
  return nativeChoice(item) ? '恢复选择回执或重新选择' : '按原命令重试'
}
function confirmationLabel(item: CommandOutboxView): string {
  if (nativeChoice(item)) return '我确认恢复原选择回执；若未曾完成，重新选择文件或目录'
  if (oldDataset(item) && item.command === 'recordingBackups.activate') return '我确认仅恢复原切换回执，不重新执行切换'
  return '我已核对该操作及上述影响，确认恢复原操作'
}
function recoveryHint(item: CommandOutboxView): string {
  if (item.command === 'recordingBackups.activate' && oldDataset(item)) return '仅查询原切换的持久回执，不停止播放、不重启 Core，也不会重新执行旧工作库中的操作。'
  if (item.command === 'recordingBackups.activate') return '先查询原激活结果；已激活不会再次停止播放或重启 Core。继续未完成的激活可能停止播放、重启 Core，并丢弃未保存的编辑。'
  if (nativeChoice(item)) return '先查询原选择回执；若没有完成回执，本次确认后可重新选择文件或目录。应用重启不会自动打开选择器。'
  return '重试保留原命令和原始参数；不会增加数量、更换引用或修改版本来绕过冲突。'
}
function timeLabel(value: string): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
async function act(action: 'retry' | 'dismiss' | 'ack', item: CommandOutboxView): Promise<void> {
  const confirmed = action === 'retry' ? retryConfirm.value[item.id] : dismissConfirm.value[item.id]
  await controller.act(action, item.id, confirmed)
  retryConfirm.value[item.id] = false
  dismissConfirm.value[item.id] = false
}
function close(): void { dialog.value?.close(); emit('close') }
onMounted(async () => {
  await nextTick()
  dialog.value?.showModal()
  dialog.value?.querySelector<HTMLElement>('#outbox-title')?.focus({ preventScroll: true })
  void controller.start()
})
onUnmounted(() => { controller.dispose(); dialog.value?.close() })
</script>

<template>
  <dialog ref="dialog" class="outbox-panel" aria-labelledby="outbox-title" aria-describedby="outbox-boundary" @cancel.prevent="close">
    <header>
      <div><p class="kicker">操作恢复</p><h2 id="outbox-title" tabindex="-1">未确认操作</h2></div>
      <button type="button" @click="close">关闭</button>
    </header>
    <p id="outbox-boundary" class="boundary">这里只显示持久保存的操作状态。应用重启不会自动重试；放弃跟踪不等于撤销业务。播放与凭据操作不在此列表中。</p>
    <div class="summary">
      <p class="muted">{{ entries.length }} 项待确认操作</p>
      <button type="button" :disabled="state.loading" @click="controller.refresh()">{{ state.loading ? '读取中…' : '刷新状态' }}</button>
    </div>
    <p v-if="state.overview" class="dataset">当前工作库 <code>{{ state.overview.datasetId }}</code></p>
    <p v-if="state.error" class="feedback" role="alert">{{ state.error }}</p>
    <p v-if="state.notice" class="feedback" role="status">{{ state.notice }}</p>
    <p v-if="state.pollingPaused" class="muted">自动状态查询已暂停。需要时可手动刷新；没有自动重试任何操作。</p>
    <p v-if="!state.overview && state.loading" role="status">正在读取持久操作记录…</p>
    <p v-else-if="state.overview && entries.length === 0 && !state.error" class="empty">没有待确认操作。</p>
    <ol class="entries">
      <li v-for="item in visibleEntries" :key="item.id" class="entry" :data-outbox-id="item.id" :aria-busy="busy(item)">
        <div class="entry-heading"><h3>{{ labels[item.command] }}</h3><span class="state">{{ stateLabels[item.state] }}</span></div>
        <p class="muted">{{ item.command }} · {{ timeLabel(item.updatedAt) }}</p>
        <p class="dataset">来源工作库 <code>{{ item.datasetId }}</code><span>{{ oldDataset(item) ? '其他工作库' : '当前工作库' }}</span></p>
        <p v-if="oldDataset(item) && item.command !== 'recordingBackups.activate'" class="feedback">此操作属于其他工作库，不能在当前工作库重试。请重新加载相关页面，并核对来源工作库的业务记录。</p>
        <p v-else-if="oldDataset(item)" class="feedback">工作库已变化。这里只能恢复原切换回执；请重新加载相关页面以查看当前工作库。</p>
        <p v-if="item.errorCode" class="feedback">{{ outboxErrorMessage(item.errorCode) }}</p>
        <p v-if="state.itemErrors[item.id]" class="feedback" role="alert">{{ state.itemErrors[item.id] }}</p>
        <p class="hint">{{ recoveryHint(item) }}</p>
        <p v-if="item.state === 'sending'" role="status">正在等待当前操作回执，不会重复发送。</p>
        <template v-if="item.state === 'succeeded'">
          <p>操作已成功。请核对相关页面的业务记录后确认；确认仅隐藏此条待处理记录。</p>
          <button type="button" :disabled="busy(item)" @click="act('ack', item)">{{ busy(item) ? '确认中…' : '成功结果已确认' }}</button>
        </template>
        <template v-else>
          <div v-if="canRetryOutboxItem(item, state.overview?.datasetId)" class="action-group">
            <label class="check"><input v-model="retryConfirm[item.id]" type="checkbox" :disabled="busy(item)">{{ confirmationLabel(item) }}</label>
            <button type="button" class="primary" :disabled="busy(item) || !retryConfirm[item.id]" @click="act('retry', item)">{{ busy(item) ? '处理中…' : retryLabel(item) }}</button>
          </div>
          <div class="action-group">
            <label class="check"><input v-model="dismissConfirm[item.id]" type="checkbox" :disabled="busy(item) || item.state === 'sending'">我确认仅放弃跟踪；这不会撤销已发生的业务变更</label>
            <button type="button" :disabled="busy(item) || item.state === 'sending' || !dismissConfirm[item.id]" @click="act('dismiss', item)">放弃跟踪</button>
          </div>
        </template>
      </li>
    </ol>
    <button v-if="visibleCount < entries.length" type="button" @click="visibleCount += 20">显示更多（还剩 {{ entries.length - visibleCount }} 项）</button>
  </dialog>
</template>

<style scoped>
.outbox-panel { box-sizing: border-box; width: min(760px, calc(100vw - 40px)); max-height: calc(100dvh - 40px); padding: 28px; border: 1px solid var(--mb-glass-border); border-radius: 18px; background: var(--mb-bg-base); color: var(--mb-text-primary); overflow: auto; overscroll-behavior: contain; }
.outbox-panel::backdrop { background: rgb(0 0 0 / .66); }
header, .summary, .entry-heading { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
header { align-items: flex-start; }
.kicker { margin: 0 0 8px; color: var(--mb-accent); font-size: 12px; }
h2 { margin: 0; font-size: 24px; line-height: 1.35; }
h3 { margin: 0; font-size: 17px; line-height: 1.5; }
p { font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }
.boundary, .feedback { padding: 14px 16px; border: 1px solid var(--mb-glass-border); border-radius: 10px; background: var(--mb-glass-clear); }
.boundary { margin: 24px 0 16px; border-left: 3px solid var(--mb-accent); }
.muted, .hint, .dataset { color: var(--mb-text-secondary); font-size: 13px; }
.dataset { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
code { font-size: 12px; overflow-wrap: anywhere; }
.entries { list-style: none; margin: 16px 0; padding: 0; }
.entry { padding: 20px 0; border-top: 1px solid var(--mb-glass-border); }
.state { font-size: 13px; line-height: 1.5; font-weight: 600; }
.action-group { margin-top: 16px; }
.check { display: flex; gap: 10px; align-items: flex-start; min-height: 44px; font-size: 13px; line-height: 1.7; cursor: pointer; }
.check input { flex-shrink: 0; width: 18px; height: 18px; margin: 3px 0 0; accent-color: var(--mb-accent); }
button { min-height: 44px; max-width: 100%; padding: 10px 14px; border: 1px solid var(--mb-glass-border); border-radius: 8px; background: var(--mb-bg-base); color: var(--mb-text-primary); font: inherit; font-size: 13px; cursor: pointer; overflow-wrap: anywhere; }
button:disabled { opacity: .5; cursor: not-allowed; }
.primary { background: var(--mb-accent); color: var(--mb-bg-deep); border-color: var(--mb-accent); font-weight: 600; }
.empty { padding: 24px 0; }
:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
@media (max-width: 600px) { .outbox-panel { width: calc(100vw - 24px); padding: 20px; } }
@media (hover: hover) and (pointer: fine) { button:not(:disabled):hover { border-color: var(--mb-accent); } }
</style>
