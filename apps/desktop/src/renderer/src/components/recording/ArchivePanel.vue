<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ArchiveRootView, ArchiveSourcePolicy, ArchiveProposal, ArchiveHistory, ArchiveOperationView, ArchiveCheck, ArchiveIssue, ExecutionAsset } from '@music-bridge/contracts'

const props = defineProps<{ draftId: string; asset: ExecutionAsset }>()
const emit = defineEmits<{ close: []; state: [busy: boolean] }>()
const api = window.musicBridge
const roots = shallowRef<readonly ArchiveRootView[]>([]), history = shallowRef<ArchiveHistory>()
const rootId = ref(''), policy = ref<ArchiveSourcePolicy | ''>('')
const root = computed(() => roots.value.find(r => r.id === rootId.value))
const operations = computed(() => history.value?.operations.filter(op => op.assetId === props.asset.id) ?? [])
const initialized = ref(false), confirmed = ref(false), proposal = shallowRef<ArchiveProposal>()
const loading = ref(true), busy = ref(false), error = ref(''), notice = ref('')
const pending = shallowRef<() => Promise<void>>()
const readId = ref(''), aborting = ref(false), checks = ref<Record<string, ArchiveCheck>>({})
const blocked = computed(() => loading.value || busy.value || !!pending.value || !!readId.value)
const canPreview = computed(() => !blocked.value && root.value?.state === 'ready' && !!policy.value)
const rootLabels: Record<ArchiveRootView['state'], string> = { selected: '已选择，未初始化', initializing: '正在初始化', ready: '可用', offline: '离线', 'recovery-required': '需要检查或恢复', revoked: '已撤权' }
const issues: Record<ArchiveIssue, string> = { ARCHIVE_ROOT_INVALID: '归档目录身份或授权失效', ARCHIVE_RECOVERY_REQUIRED: '需要检查目录、文件或恢复操作', ARCHIVE_DISK_FULL: '归档空间不足', SOURCE_INVALID: '源文件失效', CANCELLED: '已中断；部分文件保留', IO_ERROR: '文件读写未完成' }
const roles = { 'execution-audio': '实际执行音频', 'conversion-intermediate': '转换中间音频', 'raw-render': '原始 Render', 'exact-source': '精确源文件', manifest: '原始清单', metadata: '冻结事实' }
const phases: Record<ArchiveOperationView['phase'], string> = { REQUESTED: '已接受确认', INTENT_WRITTEN: '正在复制', STAGED: '正在校验暂存文件', VERIFIED: '正在发布内容对象', PROMOTED: '正在提交引用', DB_COMMITTED: '正在完成归档', FINALIZED: '归档已完成；尚未开始录音。' }
const size = (bytes: number): string => bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(2)} MiB` : `${(bytes / 1024 ** 3).toFixed(2)} GiB`
const short = (id: string): string => id.slice(0,8)
let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined
watch(blocked, value => emit('state', value), { immediate: true })
function invalidate(): void { proposal.value = undefined; confirmed.value = false }
watch([rootId, policy], () => { invalidate(); initialized.value = false })
watch(() => root.value?.state, state => { if (state !== 'ready') invalidate() })
async function refresh(initial = false): Promise<void> {
  if (initial) loading.value = true
  try {
    const [r,h] = await Promise.all([api.listArchiveRoots(), api.listArchives(props.draftId)])
    if (!alive) return
    roots.value = r.roots; history.value = h
    if (timer) clearTimeout(timer)
    if (h.operations.some(op => op.active)) timer = setTimeout(() => { void refresh() }, 700)
  } catch { if (alive) error.value = '归档状态暂时无法读取，已有历史不会被清空。' }
  finally { if (alive && initial) loading.value = false }
}
async function retry(): Promise<void> {
  if (!pending.value || busy.value) return
  busy.value = true; error.value = ''
  try { await pending.value(); if (alive) { pending.value = undefined; invalidate(); await refresh() } }
  catch (cause) {
    if (!alive) return
    if (/\[(INVENTORY_CONFLICT|INVALID_IPC_REQUEST|BAD_REQUEST)\]/u.test(cause instanceof Error ? cause.message : '')) {
      pending.value = undefined; invalidate(); error.value = '归档请求未接受，请核对文件、目录授权和容量后重新预览。'
    } else error.value = '归档操作回执尚未确认，请重试原操作；不会建立第二份归档。'
  } finally { if (alive) busy.value = false }
}
function mutate(operation: () => Promise<void>): void { if (blocked.value) return; pending.value = operation; void retry() }
function choose(): void {
  const commandId = crypto.randomUUID()
  mutate(async () => { const selected = await api.chooseArchiveRoot(commandId); if (alive) { if (selected) rootId.value = selected.id; notice.value = selected ? '仅选择了父目录，尚未创建归档文件。' : '已取消目录选择。' } })
}
function initialize(): void {
  if (!root.value || !initialized.value) return
  const request = { commandId: crypto.randomUUID(), id: root.value.id, userConfirmed: true as const }
  mutate(async () => { const result = await api.initializeArchiveRoot(request); if (alive) { initialized.value = false; notice.value = result.state === 'ready' ? '归档目录已就绪。' : '目录仍需检查，尚不能归档。' } })
}
function revoke(): void {
  if (!root.value || root.value.state === 'revoked') return
  const request = { commandId: crypto.randomUUID(), id: root.value.id }
  mutate(async () => { await api.revokeArchiveRoot(request); if (alive) { checks.value = {}; notice.value = '已撤销归档写入与读取授权；文件和历史保留。' } })
}
async function preview(): Promise<void> {
  if (!canPreview.value || !policy.value) return
  const id = crypto.randomUUID(), token = ++generation
  readId.value = id; error.value = ''; notice.value = ''; invalidate()
  try { const result = await api.previewArchive({ readId: id, assetId: props.asset.id, rootId: rootId.value, sourcePolicy: policy.value }); if (alive && token === generation) proposal.value = result }
  catch { if (alive && token === generation) error.value = '归档预览未通过。请检查执行音频、PREP 原件及所选源政策需要的文件和授权。' }
  finally { if (alive && readId.value === id) readId.value = '' }
}
function start(): void {
  const p = proposal.value; if (!p || !confirmed.value || p.availableBytes < p.requiredBytes) return
  const request = { commandId: crypto.randomUUID(), assetId: p.assetId, rootId: p.rootId, sourcePolicy: p.sourcePolicy, proposalFingerprint: p.proposalFingerprint, userConfirmed: true as const }
  mutate(async () => { await api.startArchive(request); if (alive) notice.value = '确认已接受，复制与校验在后台继续。' })
}
function control(op: ArchiveOperationView, action: 'cancel' | 'resume'): void {
  const request = { commandId: crypto.randomUUID(), id: op.id }
  mutate(async () => { await (action === 'cancel' ? api.cancelArchive(request) : api.resumeArchive(request)); if (alive) { delete checks.value[op.id]; notice.value = action === 'cancel' ? '已请求中断；已提交引用不会撤销，部分文件不会删除。' : '已请求恢复原归档，不新建操作。' } })
}
async function verify(op: ArchiveOperationView): Promise<void> {
  if (blocked.value) return
  const id = crypto.randomUUID(), token = ++generation; readId.value = id; error.value = ''; delete checks.value[op.id]
  try { const result = await api.verifyArchive({ id: op.id, readId: id }); if (alive && token === generation) checks.value[op.id] = result }
  catch { if (alive && token === generation) error.value = '本次归档核验未完成，请检查目录后重试。' }
  finally { if (alive && readId.value === id) readId.value = '' }
}
async function stopRead(): Promise<void> {
  if (!readId.value || aborting.value) return
  const id = readId.value; aborting.value = true
  try { await api.cancelArchiveRead(id); if (alive) { ++generation; readId.value = ''; notice.value = '本次归档读取已取消。' } }
  catch { if (alive) error.value = '取消读取的回执未确认，请重试取消。' }
  finally { if (alive) aborting.value = false }
}
onMounted(() => { void refresh(true) })
onBeforeUnmount(() => { alive = false; ++generation; if (timer) clearTimeout(timer); if (readId.value) void api.cancelArchiveRead(readId.value).catch(() => undefined); emit('state', false) })
</script>
<template>
  <section class="archive-panel" aria-labelledby="archive-title">
    <div class="heading"><div><p class="kicker">执行资产 · {{ short(asset.id) }}</p><h3 id="archive-title" tabindex="-1" autofocus>归档执行资产</h3></div><button :disabled="blocked" @click="emit('close')">返回执行资产</button></div>
    <p class="boundary">保存实际执行音频、原始清单和冻结事实。PREP 同时保存原始 Render，派生文件不覆盖原件。这里不开始录音，不改变实体库存；F-01 保留期限仍待决定，不自动删除文件。</p>
    <fieldset :disabled="blocked">
      <legend>1 · 归档目录</legend>
      <label>所选归档目录<select v-model="rootId"><option value="">请选择归档目录</option><option v-for="r in roots" :key="r.id" :value="r.id">{{ r.label }} · {{ rootLabels[r.state] }} · {{ short(r.id) }}</option></select></label>
      <div class="actions"><button @click="choose">选择归档父目录</button><button v-if="root && root.state !== 'revoked'" @click="revoke">撤销此归档目录授权</button></div>
      <div v-if="root && ['selected','initializing','recovery-required'].includes(root.state)" class="confirmation">
        <p>仅初始化应用自己的独立子目录和归属标记；此时不会复制音频。若上次初始化中断，重试会核对原归属，不接管其他目录。</p>
        <label class="check"><input v-model="initialized" type="checkbox">我确认在所选父目录中新建独立归档目录</label>
        <button :disabled="!initialized" @click="initialize">确认初始化归档目录</button>
      </div>
    </fieldset>
    <fieldset :disabled="blocked">
      <legend>2 · 精确源文件政策</legend>
      <label>精确源文件政策<select v-model="policy"><option value="">请明确选择，不默认复制源文件</option><option value="reference-dependent">只归档执行必需文件，原始曲目源仍依赖外部引用</option><option value="preserve-exact-sources">同时复制冻结 Hash 对应的精确曲目源文件</option></select></label>
      <p class="muted">两种政策都会保存实际执行音频；PREP 原始 Render 始终保存。精确源复制只读已明确授权并匹配冻结 Hash 的曲目，不扫描整库、不写音频标签。</p>
      <button :disabled="!canPreview" @click="preview">预览归档内容</button>
    </fieldset>
    <section v-if="proposal" class="confirmation" aria-labelledby="archive-confirm-title">
      <h4 id="archive-confirm-title">确认归档内容</h4>
      <p>M {{ short(proposal.masterVersionId) }} / L {{ short(proposal.layoutVersionId) }} · {{ proposal.objectCount }} 个独立内容对象</p>
      <p>复制 {{ size(proposal.copyBytes) }} · 含预留空间 {{ size(proposal.requiredBytes) }} · 当前可用 {{ size(proposal.availableBytes) }}</p>
      <p class="muted">同一内容承担多个角色时只存一份字节。复制预算保守计算，确认后再次核对容量。</p>
      <details><summary>查看 {{ proposal.files.length }} 条文件引用</summary><article v-for="file in proposal.files" :key="`${file.role}:${file.name}`" class="file"><strong>{{ roles[file.role] }} · {{ file.name }}</strong><p>{{ size(file.size) }}</p><code>{{ file.sha256 }}</code></article></details>
      <p v-if="proposal.availableBytes < proposal.requiredBytes" role="alert">归档空间不足，不能开始。</p>
      <label class="check"><input v-model="confirmed" type="checkbox" :disabled="blocked">我确认归档以上内容和源文件政策；不开始录音</label>
      <button class="primary" :disabled="blocked || !confirmed || proposal.availableBytes < proposal.requiredBytes" @click="start">确认并开始归档</button>
    </section>
    <div v-if="readId" class="message" role="status"><p>正在完整读取并核验文件，耗时取决于文件大小与存储速度。</p><button :disabled="aborting" @click="stopRead">{{ aborting ? '正在取消读取…' : '取消归档读取' }}</button></div>
    <p v-if="loading || busy" role="status">正在读取归档状态或等待回执…</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="error" class="message" role="alert"><p>{{ error }}</p><button v-if="pending" :disabled="busy" @click="retry">重试归档原操作</button><button v-else :disabled="blocked" @click="error = ''; refresh(true)">刷新归档状态</button></div>
    <section aria-labelledby="archive-history-title">
      <h4 id="archive-history-title">归档记录</h4>
      <p class="muted">历史完成不代表文件此刻仍可用。核验结果仅对应标注时间，也不构成正式录音或 Owner 验收。</p>
      <p v-if="history && !operations.length">此执行资产尚无归档。</p>
      <article v-for="op in operations" :key="op.id" class="operation">
        <h5>{{ short(op.id) }} · {{ roots.find(r => r.id === op.rootId)?.label ?? '原归档目录' }}</h5>
        <p>{{ phases[op.phase] }}</p><p v-if="op.issue" class="muted">{{ issues[op.issue] }}</p>
        <p>{{ op.sourcePolicy === 'preserve-exact-sources' ? '已选择复制精确源' : '曲目源仍依赖外部引用' }} · {{ op.objectCount }} 个内容对象 · {{ size(op.copyBytes) }}</p>
        <p class="muted">{{ new Date(op.createdAt).toLocaleString() }} · {{ op.active ? '后台进行中；返回后继续' : '当前无后台写入' }}</p>
        <div class="actions"><button v-if="op.active && !['DB_COMMITTED','FINALIZED'].includes(op.phase)" :disabled="blocked" @click="control(op, 'cancel')">中断此归档</button><button v-if="!op.active && op.phase !== 'FINALIZED'" :disabled="blocked || roots.find(r => r.id === op.rootId)?.state !== 'ready'" @click="control(op, 'resume')">恢复此归档</button><button v-if="!op.active && ['DB_COMMITTED','FINALIZED'].includes(op.phase)" :disabled="blocked" @click="verify(op)">重新核验归档</button></div>
        <p v-if="checks[op.id]" role="status">{{ checks[op.id]!.state === 'verified' ? '本次归档完整性核验通过' : `本次归档核验未通过：${issues[checks[op.id]!.reason!]}` }}</p>
        <p v-if="checks[op.id]" class="muted">核验时间：{{ new Date(checks[op.id]!.checkedAt).toLocaleString() }}。</p>
      </article>
    </section>
  </section>
</template>
<style scoped>
.archive-panel{min-width:0}.heading,.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.actions{justify-content:flex-start;margin:14px 0}.kicker{font-size:12px;color:var(--mb-accent)}h3{font-size:22px;margin:0}h4{font-size:18px;margin:0 0 12px}h5{font-size:14px;margin:0;overflow-wrap:anywhere}p{font-size:14px;line-height:1.75;overflow-wrap:anywhere}.muted{color:var(--mb-text-secondary);font-size:13px}.boundary,.confirmation,.message{padding:18px;border:1px solid var(--mb-glass-border);border-radius:10px;margin:18px 0}.boundary{border-left:3px solid var(--mb-accent)}.confirmation{border-color:var(--mb-accent)}fieldset{border:0;border-top:1px solid var(--mb-glass-border);padding:20px 0;min-width:0;margin:20px 0}legend{font-size:15px;font-weight:600;padding-right:12px}label{display:grid;gap:8px;font-size:13px;min-width:0}select,button{box-sizing:border-box;min-height:44px;padding:9px 12px;border:1px solid var(--mb-glass-border);border-radius:8px;background:var(--mb-bg-base);color:var(--mb-text-primary);font:inherit;font-size:13px;min-width:0;max-width:100%}select{width:100%}button{cursor:pointer;overflow-wrap:anywhere}button:disabled{opacity:.5;cursor:not-allowed}.primary{background:var(--mb-accent);color:var(--mb-bg-deep);font-weight:600}.check{display:flex;gap:10px;align-items:flex-start;min-height:44px;line-height:1.7;cursor:pointer;margin:16px 0}.check input{width:18px;height:18px;flex-shrink:0;margin:2px 0;accent-color:var(--mb-accent)}.operation{padding:18px;border:1px solid var(--mb-glass-border);border-radius:10px;margin:18px 0}.file{padding:14px 0;border-top:1px solid var(--mb-glass-border);font-size:13px;overflow-wrap:anywhere}code{font-size:12px;line-height:1.75;overflow-wrap:anywhere;white-space:normal}summary{min-height:44px;line-height:1.7;padding:12px 0;box-sizing:border-box;cursor:pointer}:focus-visible{outline:2px solid var(--mb-accent);outline-offset:3px}@media(max-width:600px){.boundary,.confirmation,.message,.operation{padding:14px}}@media(hover:hover) and (pointer:fine){button:not(:disabled):hover{border-color:var(--mb-accent)}}
</style>
