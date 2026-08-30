<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { RecordingAttempt, RecordingAttemptEndReason, RecordingAttemptSide, RecordingPlanVersion } from '@music-bridge/contracts'
import { createRecordingAttemptController } from './recording-attempt-controller'

const props = defineProps<{ plan?: RecordingPlanVersion }>()
const controller = createRecordingAttemptController({ api: window.musicBridge, onChange: () => { state.value = { ...controller.state } } })
const state = shallowRef({ ...controller.state })
const heading = ref<HTMLElement>(), detailHeading = ref<HTMLElement>()
let disposed = false
const statusLabels: Record<RecordingAttempt['status'], string> = { 'in-progress': '进行中', completed: '已完成', aborted: '用户中止', failed: '启动失败', interrupted: '已中断' }
const phaseLabels: Record<RecordingAttempt['phase'], string> = { outputting: '输出中', draining: '源已读完，等待驱动排空', 'awaiting-physical-stop': '等待实体停止确认', 'awaiting-flip': '等待翻面确认', 'awaiting-side-b': '等待明确开始 B 面', 'final-verification': '等待最终人工确认', finished: '本次流程已结束' }
const sideLabels = { A: 'A 面', B: 'B 面', Program: '连续节目（Program）' }
const sidePhaseLabels: Record<RecordingAttemptSide['phase'], string> = { pending: '尚未开始', outputting: '输出中', draining: '等待驱动排空', 'awaiting-physical-stop': '等待实体停止确认', complete: '此面已完成', aborted: '用户中止', failed: '启动失败', interrupted: '已中断' }
const reasonLabels: Record<RecordingAttemptEndReason, string> = { 'user-stop': '用户明确停止', 'backend-start-failed': '后端启动失败', 'backend-failure': '后端异常', 'external-track-change': '外部切换曲目', 'zone-changed': '播放区域改变', 'device-lost': '设备断开', 'route-changed': '输出路由改变', 'format-changed': '执行格式改变', 'source-read-failed': '源文件读取失败', underrun: '输出欠载', 'app-restarted': '应用重启，未自动恢复输出', 'backend-timeout': '后端超时', 'plan-changed': '计划依赖改变', 'protocol-error': '输出协议异常' }
const actions = computed(() => {
  void state.value
  return {
    stop: controller.canStop(), retry: controller.canRetry(),
    physical: state.value.attempt?.sides.filter(side => controller.canConfirm('physical-stop', side.side)) ?? [],
    flip: controller.canConfirm('flip'), physicalRecording: controller.canConfirm('physical-recording'), final: controller.canConfirm('final-verification'),
  }
})
const hasConfirmation = computed(() => actions.value.physical.length || actions.value.flip || actions.value.physicalRecording || actions.value.final)
const fact = (value: boolean | string | undefined) => value ? '已确认' : '未确认'
const frames = (value: number) => value.toLocaleString('zh-CN')
watch(() => props.plan, value => { controller.setPlan(value); void controller.refresh() }, { immediate: true, flush: 'sync' })
async function act(event: Event, operation: () => Promise<void>): Promise<void> {
  const origin = event.currentTarget as HTMLElement | null
  const restore = typeof document !== 'undefined' && !!origin && document.activeElement === origin
  const planId = props.plan?.id
  await operation(); await nextTick()
  if (!disposed && restore && props.plan?.id === planId && (document.activeElement === document.body || document.activeElement === origin)) (detailHeading.value ?? heading.value)?.focus()
}
onBeforeUnmount(() => { disposed = true; controller.dispose() })
</script>

<template>
  <section class="attempt-panel" data-testid="recording-attempt-panel" aria-labelledby="recording-attempt-title">
    <h4 id="recording-attempt-title" ref="heading" tabindex="-1">5 · 正式录音尝试</h4>
    <div class="boundary" role="note"><strong>Gate B 仍为 NOT_RUN，不能开始正式录音。</strong><p>无设备检查不授予输出许可。这里不播放音频、不自动开始或继续 B 面；查看历史也不改变实体库存。</p></div>
    <button type="button" disabled aria-describedby="recording-attempt-blocked">开始正式录音</button>
    <p id="recording-attempt-blocked" class="muted">当前 formalReady=false。开始 A 面／连续节目与开始 B 面均被阻断。</p>
    <p v-if="!state.plan">请先明确查看一份已冻结计划；不会自动选择历史或开始录音。</p>
    <template v-else>
      <p>当前计划第 {{ state.plan.sequence }} 版 · <code>{{ state.plan.id }}</code></p>
      <div class="actions"><button type="button" :disabled="state.listPhase === 'loading'" @click="act($event, () => controller.refresh())">刷新录音尝试</button></div>
      <div aria-live="polite">
        <p v-if="state.listPhase === 'loading'">正在读取这份计划的录音尝试…</p>
        <p v-else-if="state.listPhase === 'error'" role="alert">{{ state.listError }}</p>
        <template v-else-if="state.listPhase === 'ready' && state.page">
          <p v-if="!state.page.total">这份计划尚无正式录音尝试；未生成演示记录。</p>
          <template v-else>
            <p class="muted">共 {{ state.page.total }} 次 · 每页最多 25 条；请明确选择要查看的记录。</p>
            <ol class="history"><li v-for="item in state.page.items" :key="item.id"><p>{{ statusLabels[item.status] }} · {{ item.createdAt }}</p><button type="button" :aria-label="`查看录音尝试 ${item.id}`" :disabled="state.reading" @click="act($event, () => controller.select(item.id))">查看录音尝试 {{ item.id }}</button></li></ol>
            <nav class="actions" aria-label="录音尝试分页"><button type="button" :disabled="state.page.offset === 0" @click="act($event, () => controller.refresh(state.page!.offset - 25))">上一页录音尝试</button><button type="button" :disabled="!state.page.hasMore" @click="act($event, () => controller.refresh(state.page!.offset + 25))">下一页录音尝试</button></nav>
          </template>
        </template>
      </div>
      <div v-if="state.selectedId" class="detail" data-testid="recording-attempt-detail">
        <h5 id="recording-attempt-detail-title" ref="detailHeading" tabindex="-1">本次录音事实</h5>
        <button type="button" :disabled="state.reading || state.sending" @click="act($event, controller.readSelected)">重新读取本次状态</button>
        <p class="muted">状态不会自动刷新。关闭页面不发送停止命令；如需停止，请明确点击“停止本次录音”。</p>
        <p v-if="state.reading" role="status">正在重新读取本次事实…</p>
        <p v-if="state.detailError" role="alert">{{ state.detailError }}</p>
        <div v-if="state.stopId" class="actions"><button type="button" :disabled="!actions.stop" @click="act($event, controller.stop)">停止本次录音</button></div>
        <template v-if="state.attempt">
          <p class="state" aria-live="polite">{{ statusLabels[state.attempt.status] }} · {{ phaseLabels[state.attempt.phase] }}</p>
          <p v-if="state.attempt.reason">终止原因：{{ reasonLabels[state.attempt.reason] }}。终止事实不会被迟到的成功回执抹掉。</p>
          <dl><dt>本次记录</dt><dd><code>{{ state.attempt.id }}</code> · 修订 {{ state.attempt.revision }}</dd><dt>实体副本</dt><dd>{{ state.attempt.physicalId }}</dd><dt>记录更新时间</dt><dd>{{ state.attempt.updatedAt }}</dd></dl>
          <div class="facts" aria-live="polite" aria-atomic="true"><p>软件播放完成：{{ state.attempt.softwarePlaybackComplete ? '已完成' : '未完成' }}</p><p>实体录制确认：{{ fact(state.attempt.physicalRecordingConfirmedAt) }}</p><p>最终核验完成：{{ fact(state.attempt.finalVerificationCompleteAt) }}</p></div>
          <p class="muted">源读完不等于驱动排空，软件完成不等于实体录制完成。停止应答、资源静止和实体停止也分别确认。</p>
          <section v-for="side in state.attempt.sides" :key="side.side" class="side">
            <h6>{{ sideLabels[side.side] }} · {{ sidePhaseLabels[side.phase] }}</h6>
            <p>源已读取 {{ frames(side.sourceFramesRead) }} / {{ frames(side.frameCount) }} 帧 · 已提交 {{ frames(side.submittedFrames) }} 帧 · 已消费 {{ frames(side.consumedFrames) }} 帧</p>
            <dl><dt>源读取结束</dt><dd>{{ fact(side.sourceEof) }}</dd><dt>驱动排空</dt><dd>{{ fact(side.backendDrained) }}</dd><dt>引擎停止提交</dt><dd>{{ fact(side.engineStoppedSubmitting) }}</dd><dt>停止请求应答</dt><dd>停止请求应答：{{ fact(side.stopAcknowledged) }}</dd><dt>资源静止</dt><dd>资源静止：{{ fact(side.cleanupQuiescent) }}</dd><dt>实体已停止</dt><dd>{{ fact(side.physicalStopConfirmedAt) }}</dd></dl>
          </section>
          <div v-if="hasConfirmation" class="confirmation">
            <label class="check" for="recording-attempt-confirm"><input id="recording-attempt-confirm" type="checkbox" :checked="state.confirmed" @change="controller.setConfirmed(($event.target as HTMLInputElement).checked)">我已现场核实下方将确认的事实；本勾选本身不表示录音完成</label>
            <div class="actions"><button v-for="side in actions.physical" :key="side.side" type="button" :disabled="!state.confirmed" @click="act($event, () => controller.confirm('physical-stop', side.side))">确认 {{ sideLabels[side.side] }}实体已停止</button><button v-if="actions.flip" type="button" :disabled="!state.confirmed" @click="act($event, () => controller.confirm('flip'))">确认已翻面</button><button v-if="actions.physicalRecording" type="button" :disabled="!state.confirmed" @click="act($event, () => controller.confirm('physical-recording'))">确认实体录制完成</button><button v-if="actions.final" type="button" :disabled="!state.confirmed" @click="act($event, () => controller.confirm('final-verification'))">确认最终核验完成</button></div>
          </div>
          <div v-if="state.attempt.phase === 'awaiting-side-b'"><p>已确认翻面，仍需新的明确开始操作。当前 Gate B 未认证，不能继续 B 面。</p><button type="button" disabled>明确开始 B 面</button></div>
          <p v-if="state.attempt.status !== 'in-progress'" class="muted">本次可能已写入介质；不会自动恢复为空白或已擦除，也不会自动登记实体音乐库。</p>
          <details><summary>查看本次固定谱系与完整性摘要</summary><p>计划 <code>{{ state.attempt.planVersionId }}</code></p><p>计划 Hash <code>{{ state.attempt.planContentHash }}</code></p><p>执行资产 <code>{{ state.attempt.executionAssetId }}</code></p><template v-for="side in state.attempt.sides" :key="side.side"><p>{{ sideLabels[side.side] }} Recipe <code>{{ side.recipeHash }}</code></p><p>音频 Hash <code>{{ side.audioSha256 }}</code></p><p>PCM Hash <code>{{ side.pcmSha256 }}</code></p></template></details>
        </template>
      </div>
    </template>
    <div aria-live="polite"><p v-if="state.sending">正在等待操作回执；尚不能确认输出已停止。</p><p v-if="state.notice">{{ state.notice }}</p></div>
    <div v-if="state.operationError" role="alert"><p>{{ state.operationError }}</p><p v-if="state.pending">原操作属于记录 <code>{{ state.pending.snapshot.id }}</code>；请在原计划和记录内手动重试。</p><button v-if="state.pending" type="button" :disabled="!actions.retry" @click="act($event, controller.retry)">重试原操作</button></div>
  </section>
</template>

<style scoped>
.attempt-panel{min-width:0;margin:20px 0;padding:18px;border:1px solid var(--mb-glass-border);border-radius:10px;color:var(--mb-text-primary)}h4{margin:0 0 12px;font-size:18px}h5{margin:0 0 12px;font-size:16px}h6{margin:0;font-size:15px}p,dd,li{font-size:14px;line-height:1.75;overflow-wrap:anywhere}.muted,dt{color:var(--mb-text-secondary)}.boundary{border-left:3px solid var(--mb-accent);padding-left:14px;margin-bottom:16px}.boundary strong{font-size:15px}.actions{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0}button{box-sizing:border-box;min-width:0;max-width:100%;min-height:44px;padding:10px 12px;background:var(--mb-bg-base);color:var(--mb-text-primary);border:1px solid var(--mb-glass-border);border-radius:8px;font:inherit;font-size:14px;overflow-wrap:anywhere}button,summary{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.5}.history{padding-left:22px}.history li{padding-bottom:12px}.detail{margin-top:20px;border-top:1px solid var(--mb-glass-border);padding-top:20px}.facts{border-left:3px solid var(--mb-accent);padding-left:14px}.side{margin:18px 0;padding:14px;border:1px solid var(--mb-glass-border);border-radius:8px}.state{font-weight:600}dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px}dt{font-size:13px;line-height:1.75}dd{margin:0;min-width:0}.check{display:flex;align-items:flex-start;gap:12px;min-height:44px;font-size:14px;line-height:1.75}.check input{width:18px;height:18px;flex-shrink:0;accent-color:var(--mb-accent)}summary{min-height:44px;padding:12px 0;box-sizing:border-box;font-size:14px}code{font-size:12px;white-space:normal;overflow-wrap:anywhere}:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}button:not(:disabled):active{transform:scale(.97)}@media(hover:hover) and (pointer:fine){button:not(:disabled):hover{border-color:var(--mb-accent)}}@media(max-width:600px){.attempt-panel{padding:14px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:8px}}@media(prefers-reduced-motion:reduce){button:not(:disabled):active{transform:none}}
</style>
