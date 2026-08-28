<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { RecordingRecordDetail, RecordingVisualAbsence } from '@music-bridge/contracts'
import type { RecordingRecordState } from './recording-record-controller'
import RecordingReplicaPanel from './RecordingReplicaPanel.vue'
import RecordingPrintPanel from './RecordingPrintPanel.vue'
defineProps<{ detail: RecordingRecordDetail; state: RecordingRecordState }>()
const emit = defineEmits<{ visual: [id: string]; imageError: [] }>()
const printOpen = ref(false), printTrigger = ref<HTMLButtonElement>()
async function closePrint(): Promise<void> { printOpen.value = false; await nextTick(); printTrigger.value?.focus({ preventScroll: true }) }
const replicaOpen = ref(false), replicaTrigger = ref<HTMLButtonElement>()
async function closeReplica(): Promise<void> { replicaOpen.value = false; await nextTick(); replicaTrigger.value?.focus({ preventScroll: true }) }
const absence = (value: RecordingVisualAbsence) => ({ 'not-provided': '未提供', 'not-implemented': '尚未实现', 'not-applicable': '不适用' })[value.reason]
const frame = (value: number) => value.toLocaleString('zh-CN')
</script>
<template>
  <section data-testid="recording-record-detail" aria-label="录音档案详情">
    <h3 tabindex="-1">录音档案详情</h3>
    <h4>{{ detail.plan.master.title }}</h4>
    <p>这是首次完成时保存的历史快照；后续重录、修改资料或删除原照片均不改写它。</p>
    <button ref="replicaTrigger" type="button" @click="replicaOpen = true">Digital Replica</button>
    <RecordingReplicaPanel v-if="replicaOpen" :key="detail.record.id" :detail="detail" @close="closeReplica" />
    <button ref="printTrigger" type="button" @click="printOpen = true">J-Card 与印刷文件</button>
    <RecordingPrintPanel v-if="printOpen" :key="detail.record.id" :detail="detail" @close="closePrint" />
    <dl><dt>档案编号</dt><dd>{{ detail.record.id }}</dd><dt>实体编号</dt><dd>{{ detail.record.completion.physicalId }}</dd><dt>首次完成时间</dt><dd>{{ detail.record.completion.endedAt }}</dd><dt>快照来源</dt><dd>{{ detail.record.media.snapshotSource === 'completion' ? '完成时快照' : '旧记录，仅保留冻结计划证据' }}</dd><dt>介质</dt><dd>{{ detail.record.media.descriptor ? `${detail.record.media.descriptor.brand} · ${detail.record.media.descriptor.name}` : '历史品牌与系列未知，未用当前资料补填' }}</dd><dt>长度</dt><dd>{{ detail.record.media.lengthMinutes === null ? '未知' : `${detail.record.media.lengthMinutes} 分钟` }}</dd><dt>原始来源</dt><dd>{{ ({ 'blank-pool': '空白库存', 'legacy-registration': '旧录音登记', unclassified: '未分类' })[detail.record.media.origin] }}</dd></dl>
    <div class="notice"><p>软件播放完成：已完成</p><p>实体录制确认：{{ detail.record.completion.physicalRecordingConfirmedAt }}</p><p>最终核验完成：{{ detail.record.completion.finalVerificationCompleteAt }}</p><p>这是历史完成证据，不代表此实体当前仍是这份内容。</p></div>
    <section v-for="side in detail.record.completion.sides" :key="side.side" class="card">
      <h4>{{ side.side === 'Program' ? '连续节目' : `${side.side} 面` }}</h4>
      <p>目标 {{ frame(side.frameCount) }} 帧 · 源已读 {{ frame(side.sourceFramesRead) }} 帧 · 已提交 {{ frame(side.submittedFrames) }} 帧 · 已消费 {{ frame(side.consumedFrames) }} 帧</p>
      <p>源读取结束：{{ side.sourceEof ? '已确认' : '未确认' }} · 驱动排空：{{ side.backendDrained ? '已确认' : '未确认' }}</p>
      <p>实体已停止：{{ side.physicalStopConfirmedAt ?? '未确认' }}</p>
    </section>
    <details><summary>冻结计划、曲目与执行谱系</summary>
      <dl><dt>计划</dt><dd>{{ detail.plan.id }} · 第 {{ detail.plan.sequence }} 版</dd><dt>母版</dt><dd>{{ detail.plan.master.id }}</dd><dt>布局</dt><dd>{{ detail.plan.layout.id }}</dd><dt>Prepared</dt><dd>{{ detail.plan.prepared?.id ?? '未使用（Direct）' }}</dd><dt>执行资产</dt><dd>{{ detail.plan.execution.assetId }}</dd><dt>归档引用</dt><dd>{{ detail.plan.archive.operationId }} · {{ detail.plan.archive.sourcePolicy }}</dd><dt>保留政策</dt><dd>执行音频永久保留；原始源遵循冻结归档政策。缺依赖不承诺重建。</dd><dt>执行格式</dt><dd>{{ detail.plan.profileSnapshot.settings.format.sampleRate }} Hz · {{ detail.plan.profileSnapshot.settings.format.channelCount }} 声道 · {{ detail.plan.profileSnapshot.settings.format.outputSampleFormat }}</dd><dt>配置快照</dt><dd>{{ detail.plan.profileSnapshot.settings.profile.content.name }} · {{ detail.plan.profileSnapshot.settings.profile.id }}</dd><dt>降噪</dt><dd>{{ detail.plan.profileSnapshot.settings.effective.noiseReduction ?? '未设定' }}</dd><dt>计划 Hash</dt><dd><code>{{ detail.plan.contentHash }}</code></dd><dt>档案 Hash</dt><dd><code>{{ detail.record.contentHash }}</code></dd></dl>
      <ol><li v-for="track in detail.plan.master.content.tracks" :key="track.trackId">{{ track.metadata.title }} · {{ track.metadata.artist ?? '艺术家未知' }}</li></ol>
      <details><summary>完整冻结参数与每面音频摘要</summary><pre>{{ JSON.stringify(detail.plan.profileSnapshot.settings.effective, null, 2) }}</pre><p v-for="side in detail.record.completion.sides" :key="side.side">{{ side.side }} · Recipe <code>{{ side.recipeHash }}</code><br>音频 <code>{{ side.audioSha256 }}</code><br>PCM <code>{{ side.pcmSha256 }}</code></p></details>
    </details>
    <section aria-label="档案视觉附件" data-testid="recording-record-visuals">
      <h4>完成时视觉附件</h4><p>Artwork：{{ detail.record.visuals.artwork.state === 'captured' ? `完成时已保存第 ${detail.record.visuals.artwork.version.sequence} 版` : absence(detail.record.visuals.artwork) }} · J-Card：{{ absence(detail.record.visuals.jCard) }}</p>
      <p v-if="detail.record.visuals.photos.state === 'not-captured'">单盘照片：{{ absence(detail.record.visuals.photos) }}。不使用型号照片替代。</p>
      <template v-else><p>已保存 {{ detail.record.visuals.photos.attachments.length }} 张同实体照片；按需读取，每次显示一张。</p>
        <div class="actions"><button v-for="(photo, index) in detail.record.visuals.photos.attachments" :key="photo.id" type="button" :disabled="state.visualPhase === 'loading' && state.visualId === photo.id" @click="emit('visual', photo.id)">{{ state.visualId === photo.id && state.visualPhase === 'error' ? '重试照片' : '加载照片' }} {{ index + 1 }}</button></div>
        <p v-if="state.visualPhase === 'loading'" role="status">正在读取此张历史照片…</p><p v-if="state.visualError" role="alert">{{ state.visualError }}</p>
        <figure v-if="state.visual"><img :src="state.visual.image.dataUrl" :width="state.visual.image.width" :height="state.visual.image.height" alt="此实体完成时保存的历史单盘照片" @error="emit('imageError')"><figcaption>只读历史照片 · 不改变当前单盘照片</figcaption></figure>
      </template>
    </section>
  </section>
</template>
