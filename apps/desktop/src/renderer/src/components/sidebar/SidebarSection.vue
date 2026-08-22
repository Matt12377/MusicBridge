<script setup lang="ts">
defineProps<{
  title: string
  expanded: boolean
}>()
</script>

<template>
  <section class="sidebar-section" :aria-label="title">
    <h2 class="sidebar-section-title">{{ title }}</h2>
    <div class="sidebar-section-content"><slot /></div>
  </section>
</template>
