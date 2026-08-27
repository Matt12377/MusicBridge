<script setup lang="ts">
const emit = defineEmits<{ 'open-collection': [] }>()
</script>

<template>
  <section class="recording-view" data-component="RecordingView" aria-labelledby="recording-heading">
    <header class="recording-heading">
      <div>
        <p class="recording-kicker">个人录音</p>
        <h2 id="recording-heading">从喜欢的音乐开始。</h2>
        <p class="recording-subtitle">选好音乐，再为它找到一盘合适的磁带。</p>
      </div>
      <div class="recording-secondary" aria-label="录音资料">
        <button type="button" disabled aria-describedby="recording-secondary-status">母版</button>
        <button type="button" disabled aria-describedby="recording-secondary-status">录音记录</button>
        <span id="recording-secondary-status">尚未接入</span>
      </div>
    </header>

    <ol class="recording-steps" aria-label="录音准备步骤">
      <li aria-current="step"><span>01</span><strong>选择音乐</strong></li>
      <li><span>02</span><strong>选择磁带</strong></li>
      <li><span>03</span><strong>确认与预检</strong></li>
    </ol>

    <div class="recording-start">
      <div class="recording-symbol" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25"><path d="M9 18V6l10-2v12M9 10l10-2" /><ellipse cx="6" cy="18" rx="3" ry="2.5" /><ellipse cx="16" cy="16" rx="3" ry="2.5" /></svg>
      </div>
      <h3>这一盘，想录些什么？</h3>
      <p class="recording-description">从 Roon 中挑选一张专辑，或编排自己的精选。<br>曲目确定后，再根据空白磁带库存推荐合适的型号与时长。</p>
      <button class="recording-primary" type="button" disabled aria-describedby="recording-status">从 Roon 选择音乐</button>
      <p id="recording-status" class="recording-status">选曲与录音引擎尚未接入，当前不会操作播放设备。</p>
    </div>

    <footer class="recording-footer">
      <p>先整理收藏也可以，选曲前不需要预留磁带。</p>
      <button type="button" @click="emit('open-collection')">查看空白磁带收藏 <span aria-hidden="true">→</span></button>
    </footer>
  </section>
</template>

<style scoped>
.recording-view { max-width: 1120px; margin: 0 auto; padding: 32px 36px 40px; }
.recording-heading { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.recording-kicker { margin: 0 0 10px; color: var(--mb-accent); font-size: 12px; letter-spacing: .08em; }
h2 { margin: 0; font-size: clamp(22px, 2.4vw, 30px); letter-spacing: -.035em; line-height: 1.3; }
.recording-subtitle { margin: 12px 0 0; color: var(--mb-text-secondary); font-size: 13px; line-height: 1.7; }
.recording-secondary { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 10px; }
.recording-secondary button { min-height: 34px; padding: 0 12px; border: 1px solid var(--mb-glass-border); border-radius: 8px; color: var(--mb-text-primary); background: transparent; font-size: 12px; }
.recording-secondary span { color: var(--mb-text-secondary); font-size: 11px; }
.recording-steps { display: flex; gap: 20px; margin: 32px 0 24px; padding: 0; list-style: none; }
.recording-steps li { display: flex; flex: 1; align-items: center; gap: 10px; padding: 0 0 16px; border-bottom: 1px solid var(--mb-glass-border); color: var(--mb-text-secondary); }
.recording-steps li[aria-current="step"] { border-color: var(--mb-accent); color: var(--mb-accent); }
.recording-steps span { font-size: 11px; font-variant-numeric: tabular-nums; }
.recording-steps strong { font-size: 13px; font-weight: 500; }
.recording-start { display: flex; min-height: 320px; align-items: center; flex-direction: column; justify-content: center; padding: 36px 24px; border: 1px solid var(--mb-glass-border); border-radius: 18px; background: var(--mb-bg-base); text-align: center; }
.recording-symbol { display: grid; width: 62px; height: 62px; place-items: center; margin-bottom: 22px; border: 1px solid var(--mb-glass-border); border-radius: 16px; color: var(--mb-accent); background: var(--mb-accent-soft); }
.recording-symbol svg { width: 29px; height: 29px; }
h3 { margin: 0; font-size: 22px; font-weight: 550; letter-spacing: -.02em; }
.recording-description { max-width: 410px; margin: 16px 0 24px; color: var(--mb-text-secondary); font-size: 13px; line-height: 1.9; }
.recording-primary { min-height: 40px; padding: 0 22px; border-radius: 9px; color: var(--mb-bg-deep); background: var(--mb-accent); font-size: 13px; font-weight: 600; }
.recording-status { margin: 20px 0 0; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.8; }
.recording-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 22px; }
.recording-footer p { margin: 0; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.8; }
.recording-footer button { min-height: 36px; padding: 0; color: var(--mb-accent); background: transparent; font-size: 12px; }
.recording-footer button:hover { color: var(--mb-accent-hover); }
@media (max-width: 900px) {
  .recording-view { padding: 24px 20px; }
  .recording-heading { flex-wrap: wrap; gap: 20px; }
  .recording-steps { gap: 12px; }
  .recording-start { padding: 28px 18px; }
}
</style>
