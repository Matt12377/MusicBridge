<script setup lang="ts">
import { inject } from 'vue'
import { appearanceKey } from '../../appearance.js'
const appearance = inject(appearanceKey)!
</script>

<template>
  <article class="settings-card settings-glass-panel appearance-settings">
    <div class="panel-heading"><div><p class="section-kicker">外观</p><h3 id="appearance-heading">主题</h3></div></div>
    <fieldset class="appearance-options" aria-labelledby="appearance-heading" aria-describedby="appearance-description">
      <label v-for="option in ([{ value: 'light', title: '浅色', note: '柔和明亮的磨砂玻璃' }, { value: 'dark', title: '深色', note: '安静的蓝灰色氛围' }] as const)" :key="option.value" class="appearance-option" :class="{ selected: appearance.theme.value === option.value }">
        <input type="radio" name="appearance-theme" :value="option.value" :checked="appearance.theme.value === option.value" @change="appearance.select(option.value)" />
        <span class="appearance-swatch" :class="'is-' + option.value" aria-hidden="true"><span></span><i></i></span>
        <span class="appearance-option-copy"><strong>{{ option.title }}</strong><small>{{ option.note }}</small></span>
      </label>
    </fieldset>
    <p id="appearance-description" class="muted-copy">切换立即生效，并记住你的选择。两种主题都会随当前音乐封面变化，暂停时保留背景。</p>
  </article>
</template>
