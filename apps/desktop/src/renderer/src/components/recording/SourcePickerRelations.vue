<script setup lang="ts">
import { computed } from 'vue'
import { matrixStatus, relationLabels, relationSummary, runtimeLabels, type SourcePickerState } from './source-picker-controller'

const props = defineProps<{ state: SourcePickerState; blocked: boolean; query: string }>()
const emit = defineEmits<{ load: [offset: number]; open: [id: string]; tracks: []; back: []; refresh: []; 'update:query': [value: string] }>()
const summary = computed(() => props.state.digital ? relationSummary(props.state.digital) : undefined)
</script>

<template>
  <section data-testid="source-picker-relations" aria-label="已登记收藏关系">
    <template v-if="state.digital">
      <section data-testid="source-picker-relation-detail" aria-label="数字关联详情">
        <header><h3 tabindex="-1" data-relation-heading>数字关联详情</h3><button type="button" :disabled="blocked" @click="emit('back')">返回收藏关系列表</button></header>
        <h4>{{ state.digital.album.metadata.title }}</h4>
        <p>{{ [state.digital.album.metadata.artist, state.digital.album.metadata.year, state.digital.album.metadata.version].filter(Boolean).join(' · ') || '版本资料待核实' }}</p>
        <p v-if="state.runtime" role="status">{{ runtimeLabels[state.runtime.status] }}</p>
        <p v-else>Roon 运行状态尚未核实，暂不可选曲。</p>
        <div class="counts" v-if="summary"><span>Exact · CD {{ summary.exactCd }} / 磁带 {{ summary.exactCassette }}</span><span>Probable · 实物 {{ summary.probable }}</span><span>Related · 实物 {{ summary.related }}</span></div>
        <div class="actions"><button type="button" data-relation-tracks :disabled="blocked || state.loading || state.offline || state.runtime?.status !== 'available'" @click="emit('tracks')">从此数字关联选择曲目</button><button type="button" :disabled="blocked || state.loading" @click="emit('refresh')">刷新关联状态</button></div>
        <p v-if="state.runtime?.status !== 'available'">可保留本地关系继续浏览；连接或重新定位请在收藏页明确处理。这里不会按标题搜索替代版本。</p>
        <article v-for="item in state.digital.links" :key="item.link.id" class="relation-card">
          <h4>{{ item.release.title }}</h4><p>{{ item.release.artist }}</p>
          <p>{{ relationLabels[item.link.relation] }} · {{ item.release.kind === 'cd' ? '原版 CD' : '原版磁带' }} × {{ item.release.quantity }}</p>
          <p v-if="item.link.ripFromCdConfirmed">CD Rip · 用户单独确认；不代表音频源已校验</p>
        </article>
        <p v-if="!state.digital.links.length">{{ state.digital.album.physicalAbsenceConfirmed ? 'Digital Only · 已确认未收藏原版实物' : '原版实物未核实，不视为缺少' }}</p>
      </section>
    </template>
    <template v-else>
      <form @submit.prevent="emit('load', 0)"><label>搜索已登记收藏关系<input :value="query" maxlength="240" placeholder="专辑或艺术家" @input="emit('update:query', ($event.target as HTMLInputElement).value)"></label><button :disabled="blocked || state.loading">筛选收藏关系</button></form>
      <div class="relation-grid">
        <article v-for="row in state.matrix?.items" :key="row.id" class="relation-card">
          <h4>{{ row.title }}</h4><p>{{ row.artist || '艺术家待核实' }}</p>
          <div class="counts"><span>{{ row.digitalId ? 'Exact · ' : '实物 · ' }}CD {{ row.cd }} / 磁带 {{ row.cassette }}</span><span v-if="row.uncertainRelations">Probable / Related · 待核实关系 {{ row.uncertainRelations }}</span></div>
          <p>{{ matrixStatus(row) }}</p>
          <button v-if="row.digitalId" type="button" :data-digital-id="row.digitalId" :aria-label="`查看已登记专辑 ${row.title}`" :disabled="blocked || state.loading" @click="emit('open', row.digitalId)">查看数字关联详情</button>
          <p v-else>没有已登记的数字关联，暂不可从此记录选曲。</p>
        </article>
      </div>
      <p v-if="state.matrix && !state.matrix.items.length && !state.loading">没有符合条件的收藏关系。矩阵不会凭标题推测对应版本。</p>
      <p>数字对象的 CD / 磁带数量只统计 Exact；Probable 与 Related 在详情中分别列出。未核实不视为缺少。</p>
      <nav v-if="state.matrix && state.matrix.total > state.matrix.limit" aria-label="收藏关系分页"><button type="button" :disabled="blocked || state.loading || !state.matrix.offset" @click="emit('load', Math.max(0, state.matrix.offset - 24))">上一页</button><span>{{ state.matrix.offset + 1 }}–{{ state.matrix.offset + state.matrix.items.length }} / {{ state.matrix.total }}</span><button type="button" :disabled="blocked || state.loading || !state.matrix.hasMore" @click="emit('load', state.matrix.offset + 24)">下一页</button></nav>
    </template>
    <p class="boundary">收藏关系只说明登记信息，不是 Source Lock，也不证明拥有可用音频。浏览和选曲不播放、不新增库存、不写入关系。</p>
  </section>
</template>

<style scoped>
section,.relation-card{min-width:0}header,form,nav,.actions,.counts{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header{justify-content:space-between}h3{font-size:16px;margin:14px 0}h4{font-size:14px;margin:0;overflow-wrap:anywhere}p{font-size:12px;line-height:1.8;color:var(--mb-text-secondary);overflow-wrap:anywhere}.counts{font-size:12px;line-height:1.8}.actions{margin:16px 0}button,input{font:inherit;color:var(--mb-text-primary);box-sizing:border-box;min-height:40px;max-width:100%;padding:8px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);font-size:13px;overflow-wrap:anywhere}button:disabled{opacity:.5;cursor:not-allowed}label{display:grid;gap:8px;margin:14px 0;font-size:13px;flex:1;min-width:160px}input{width:100%;min-width:0}.relation-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:12px}.relation-card{padding:16px;border:1px solid var(--mb-glass-border);border-radius:10px;margin:12px 0}.relation-grid .relation-card{margin:0}nav{justify-content:flex-end;margin:18px 0;font-size:12px}.boundary{border-top:1px solid var(--mb-divider);padding-top:12px}
</style>
