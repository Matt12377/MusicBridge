<script setup lang="ts">
defineProps<{ message?: string | null; pending?: boolean; legacy?: boolean }>()
const emit = defineEmits<{ retry: [] }>()
</script>
<template>
  <p v-if="message" class="persistent-error" role="status">{{ message }} <button type="button" class="inline-action" :disabled="pending" @click="emit('retry')">重新读取</button></p>
  <p v-if="legacy" class="lede">当前接口未提供完整歌单版本，无法确认分页来自同一份歌单。</p>
</template>
