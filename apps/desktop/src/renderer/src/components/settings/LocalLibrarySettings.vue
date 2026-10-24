<script setup lang="ts">
import {computed,defineAsyncComponent,markRaw,ref,watch,onMounted,onUnmounted} from 'vue'
import {logLibraryOperation} from '../../../../../../../packages/bridge-core/src/shared/library-operation-log.js'
import type {LocalRootView,ScanJobRecord,LocalTrack,LocalRelocationCandidates,LocalRelocationSelection,LocalLibraryManagedRoot,LocalLibraryManagementOperation} from '@music-bridge/contracts'
import type { LocalWorkbenchLibrary } from '../../composables/application/local-library-workbench/library.js'
import {useLocalRelocationPlans} from '../../composables/application/useLocalRelocationPlans.js'
import {controlLocalLibraryScan} from '../../composables/application/local-library-browser/scan-control.js'
const props=withDefaults(defineProps<{managementOnly?:boolean;workspace?:LocalWorkbenchLibrary;relocationSession?:ReturnType<typeof useLocalRelocationPlans>}>(),{managementOnly:false})
const emit=defineEmits<{updated:[];'scan-observed':[];organize:[]}>()
const rootsLoaded=ref(false), libraryNames=ref<Record<string,string>>({}), cleanupConfirmed=ref(false)
const confirmedLibraries=ref<readonly LocalLibraryManagedRoot[]|null>(null)
let confirmedWorkspace=props.workspace
watch([()=>props.workspace,()=>props.workspace?.state.value],([workspace,state])=>{
 if(workspace!==confirmedWorkspace){confirmedLibraries.value=null;confirmedWorkspace=workspace}
 if(state){confirmedLibraries.value=state.libraries;for(const item of state.libraries)if(libraryNames.value[item.libraryId]===undefined)libraryNames.value[item.libraryId]=item.label}
},{immediate:true})
const api=window.musicBridge,roots=ref<LocalRootView[]>([]),jobs=ref<ScanJobRecord[]>([]),tracks=ref<LocalTrack[]>([]),offset=ref(0),hasMore=ref(false),jobOffset=ref(0),jobHasMore=ref(false),readError=ref(''),actionError=ref(''),busy=ref(false),selection=ref<LocalRelocationSelection|null>(null),candidates=ref<LocalRelocationCandidates|null>(null),confirming=ref(false),titles=ref<Record<string,string>>({})
const currentJobs=ref<ScanJobRecord[]>([]),fileRecoveryOpen=ref(false)
const relocation=props.relocationSession??markRaw(useLocalRelocationPlans({api,onApplied:()=>{if(live){void reload();emit('updated')}}}))
const RelocationDialog=!props.relocationSession&&relocation.capable?defineAsyncComponent(()=>import('../library/LocalRelocationDialog.vue')):null
const phases:Record<ScanJobRecord['phase'],string>={pending:'等待扫描',running:'扫描中',paused:'已暂停',completed:'已完成',failed:'未完成',cancelled:'已取消'}
const addFeedback=computed(()=>props.workspace?.addFeedback?.value??null)
const removeFeedback=computed(()=>props.workspace?.removeFeedback?.value??null)
const availability={ONLINE:'可读取',SOURCE_ROOT_OFFLINE:'目录离线',REVOKED:'许可已撤销'}
const libraryScanStates:Record<LocalLibraryManagedRoot['scanState'],string>={idle:'就绪',queued:'等待扫描',running:'扫描中',paused:'扫描已暂停',complete:'扫描完成',failed:'扫描未完成',cancelled:'扫描已取消',offline:'目录离线'}
const operationStates:Record<LocalLibraryManagementOperation['state'],string>={running:'处理中',succeeded:'已完成',partial:'部分完成',failed:'未完成',unknown:'结果待确认',cancelled:'已取消'}
const operationNames:Record<string,string>={'library.import.confirm':'添加音乐库','library.rename':'更新音乐库名称','library.remove':'移除本地记录','library.snapshot.load':'恢复扫描快照','library.snapshot.retry':'保存扫描快照','library.settings.save':'保存扫描设置','library.watch.set':'更新文件监听','library.ai.start':'整理音乐信息','library.cue.start':'专辑分轨'}
interface LibraryCard {id:string;label:string;root:LocalRootView|null;managed:LocalLibraryManagedRoot|null;job:ScanJobRecord|null}
const libraryCards=computed<LibraryCard[]>(()=>{
 // 管理回读决定成员；原始目录为恢复与历史保留，不能补回已移除的库。
 const removed=props.workspace?.confirmedRemovedLibraryIds?.value??[]
 const managed=(confirmedLibraries.value??[]).filter(library=>!removed.includes(library.libraryId))
 const ids=props.workspace?managed.map(library=>library.libraryId):roots.value.filter(root=>root.root.role==='library').map(root=>root.root.id)
 return ids.map(id=>{
  const library=managed.find(value=>value.libraryId===id)??null,root=roots.value.find(value=>value.root.id===id)??null
  // 历史翻页不改变主卡片；只消费与当前根、来源、修订一致的最近任务。
  const job=root?[...currentJobs.value].reverse().find(value=>value.libraryRootId===id&&value.sourceRootId===root.root.sourceRootId&&value.rootRevision===root.root.revision&&(!props.workspace?.state.value||value.datasetId===props.workspace.state.value.datasetId))??null:null
  return {id,label:library?.label??root?.label??'音乐库',root,managed:library,job}
 })
})
const librariesConfirmed=computed(()=>props.workspace?confirmedLibraries.value!==null:rootsLoaded.value)
const selectedLibraryNames=computed(()=>props.workspace?.state.value?.libraries.filter(library=>props.workspace?.selectedLibraryIds.value.includes(library.libraryId)).map(library=>library.label)??[])
function onlineLabel(card:LibraryCard){return card.root?availability[card.root.availability]:card.managed?.online?'目录在线':'目录离线'}
function needsLibraryUpdate(card:LibraryCard){return !!card.root&&card.root.root.role==='library'&&BigInt(card.root.root.revision)>1n&&!card.job}
function awaitingScan(card:LibraryCard){return !needsLibraryUpdate(card)&&!!card.managed&&['queued','running','paused'].includes(card.managed.scanState)&&(!card.job||!['pending','running','paused'].includes(card.job.phase))}
function scanLabel(card:LibraryCard){return needsLibraryUpdate(card)?'目录已重新关联，尚未更新音乐库':card.job&&(card.job.phase==='cancelled'||card.job.phase==='failed')?`更新未完成 · ${phases[card.job.phase]}`:awaitingScan(card)&&card.managed?`${libraryScanStates[card.managed.scanState]} · 进度待确认`:card.job?phases[card.job.phase]:card.managed?libraryScanStates[card.managed.scanState]:'扫描状态待确认'}
function libraryLabel(job:ScanJobRecord){return libraryCards.value.find(card=>card.id===job.libraryRootId)?.label??'音乐库扫描'}
function operationName(kind:string){return Object.hasOwn(operationNames,kind)?operationNames[kind]:'音乐库操作'}
watch(()=>props.workspace?.selectedLibraryIds.value,()=>{cleanupConfirmed.value=false})
const scanFailureMessages:Record<NonNullable<ScanJobRecord['failureCode']>,string>={ROOT_UNAVAILABLE:'源目录无法读取，请检查目录是否在线及读取权限；音乐库保留。',ROOT_REVISION_CHANGED:'源目录关联已改变，请核对当前目录后重新开始扫描；音乐库保留。',SCAN_READ_FAILED:'扫描读取未完成，请检查源目录和读取权限；音乐库保留。',CHECKPOINT_INVALID:'无法确认上次扫描的进度，请重新开始扫描；音乐库保留。'}
function scanFailureMessage(code:string){return Object.hasOwn(scanFailureMessages,code)?scanFailureMessages[code as keyof typeof scanFailureMessages]:'扫描未获确认，音乐库保留。'}
let live=true,generation=0,timer:ReturnType<typeof setTimeout>|undefined,lastRootState:string|undefined,lastScanState:string|undefined
async function reload(){
 clearTimeout(timer);const current=++generation
 try{
  const [nextRoots,page,nextTracks]=await Promise.all([api.listLocalLibraryRoots(),api.localLibraryScan('localScan.page',{offset:jobOffset.value,limit:200}),props.managementOnly||!fileRecoveryOpen.value?Promise.resolve({items:[] as LocalTrack[],hasMore:false}):api.listLocalLibraryTracks({offset:offset.value,limit:50})])
  if(!live||current!==generation)return
  // 主卡片保持最新一页的真实进度；高级历史仍使用用户选择的原分页。
  const latestOffset=page.total>0?Math.floor((page.total-1)/200)*200:0
  const latestPage=latestOffset===jobOffset.value?page:await api.localLibraryScan('localScan.page',{offset:latestOffset,limit:200})
  if(!live||current!==generation)return
  const entries=await Promise.all(nextTracks.items.map(async track=>{try{return [track.id,(await api.getLocalLibraryMetadata(track.id)).effective.title||'来源未提供标题'] as const}catch{return [track.id,'标题暂未读取'] as const}}))
  if(!live||current!==generation)return
  titles.value=Object.fromEntries(entries);roots.value=nextRoots;rootsLoaded.value=true;jobs.value=page.items;currentJobs.value=latestPage.items;jobHasMore.value=page.hasMore;tracks.value=[...nextTracks.items];hasMore.value=nextTracks.hasMore;readError.value=''
  const rootState=JSON.stringify(nextRoots.map(v=>[v.root.id,v.root.sourceRootId,v.root.revision,v.root.role,v.availability,v.label]))
  const scanState=JSON.stringify(latestPage.items.map(v=>[v.jobId,v.progress.accepted,v.phase]))
  if(lastRootState!==undefined&&lastRootState!==rootState)emit('updated')
  else if(lastScanState!==undefined&&lastScanState!==scanState)emit('scan-observed')
  lastRootState=rootState;lastScanState=scanState
 }catch{if(live&&current===generation)readError.value='读取未获确认，现有音乐库保留。'}finally{if(live&&current===generation)timer=setTimeout(()=>{void reload()},1500)}
}
// 只识别已确认的扫描冲突；未知结果与其他入口错误不能据此变参重试。
function confirmedScanConflict(cause:unknown){return cause instanceof Error&&/^(?:Error invoking remote method ['"]localLibrary:request['"]: (?:Error: )?)?\[INVENTORY_CONFLICT\](?:\s|$)/u.test(cause.message)}
async function action(work:()=>Promise<unknown>,scanControl=false){if(busy.value)return;busy.value=true;actionError.value='';try{const completed=await work();if(live&&completed!==false){clearTimeout(timer);await reload();emit('updated')}}catch(cause){if(live){if(scanControl&&confirmedScanConflict(cause)){actionError.value='任务状态已更新，操作未执行。请刷新状态后重试。';clearTimeout(timer);await reload()}else actionError.value='操作未获确认。请核对任务状态或未确认操作，不要更换参数重试。'}}finally{busy.value=false}}
async function choose(){await action(async()=>{
 if(props.workspace)return props.workspace.addMusicLibrary()
 const started=performance.now();logLibraryOperation('ui','add.request','start',{roots:roots.value.length})
 const root=await api.chooseLocalLibraryRoot(crypto.randomUUID())
 if(!root){logLibraryOperation('ui','add.request','cancelled',{elapsedMs:performance.now()-started});return false}
 logLibraryOperation('ui','add.selected','complete',{elapsedMs:performance.now()-started})
 await api.localLibraryScan('localScan.start',{commandId:crypto.randomUUID(),libraryRootId:root.id,expectedRootRevision:root.revision})
 logLibraryOperation('ui','add.confirmed','complete',{elapsedMs:performance.now()-started,roots:roots.value.length+1})
})}
function readAddResult(){const commandId=addFeedback.value?.commandId;if(commandId)void props.workspace?.readOriginal(commandId)}
async function removeLibraries(){if(props.workspace)await action(()=>props.workspace!.remove())}
async function readRemoveResult(){const commandId=removeFeedback.value?.commandId;if(commandId&&props.workspace)await action(async()=>{await props.workspace!.readOriginal(commandId);return removeFeedback.value?.phase==='removed'})}
async function scan(root:LocalRootView){await action(async()=>{
 const started=performance.now();logLibraryOperation('ui','scan.request','start')
 try{
  await api.localLibraryScan('localScan.start',{commandId:crypto.randomUUID(),libraryRootId:root.root.id,expectedRootRevision:root.root.revision})
  logLibraryOperation('ui','scan.request','complete',{elapsedMs:performance.now()-started})
 }catch(cause){logLibraryOperation('ui','scan.request','error',{elapsedMs:performance.now()-started});throw cause}
})}
// 仅明确的工作区扫描点击委托此原入口；按当前投影再核根与修订，不借旧库名或旧checkbox。
async function scanLibrary(request:{libraryRootId:string;expectedRootRevision:string}):Promise<void>{
 const root=roots.value.find(value=>value.root.id===request.libraryRootId)
 if(!live||busy.value||!root||root.availability!=='ONLINE'||root.root.revision!==request.expectedRootRevision){actionError.value='当前目录或修订尚未核实，请刷新后重新扫描。';return}
 await scan(root)
}
defineExpose({scanLibrary})
async function control(job:ScanJobRecord,operation:'pause'|'resume'|'cancel'){await action(()=>controlLocalLibraryScan(api,job,operation,crypto.randomUUID()),true)}
async function remount(root:LocalRootView){await action(async()=>{const target=await api.chooseRecordingSourceRoot(crypto.randomUUID());if(!target)return;if(!window.confirm(`确认将“${root.label}”重新关联到“${target.label}”并自动增量更新音乐库？原对象与记录保留，文件来源会在扫描确认后更新。`))return;await api.relinkLocalLibraryRoot({commandId:crypto.randomUUID(),rootId:root.root.id,expectedRevision:root.root.revision,targetSourceRootId:target.id,userConfirmed:true})})}
async function previewRoot(root:LocalRootView){if(busy.value||relocation.busy.value||relocation.unknown.value)return;await relocation.openRoot({libraryRootId:root.root.id,expectedRootRevision:root.root.revision},root.label)}
async function relocationPolicy(event:Event){const input=event.target as HTMLInputElement;await relocation.setPolicy(input.checked);input.checked=relocation.context.value?.policy.enabled??false}
async function locate(track:LocalTrack){await action(async()=>{const asset=await api.getLocalLibraryAsset(track.assetId),root=roots.value.find(x=>x.root.id===asset.libraryRootId);if(!root)throw new Error('根未就绪');const body={assetId:asset.id,expectedFileRevision:asset.fileRevision,expectedLocationRevision:asset.locationRevision,expectedRootRevision:root.root.revision};const result=await api.chooseLocalRelocationCandidates(body);if(live){selection.value=body;candidates.value=result;confirming.value=false}})}
async function confirm(id:string){if(!selection.value||!confirming.value)return;const body={...selection.value,commandId:id,userConfirmed:true as const};await action(async()=>{await api.confirmLocalRelocation(body);if(live){selection.value=null;candidates.value=null;confirming.value=false}})}
async function jobPage(direction:number){jobOffset.value=Math.max(0,jobOffset.value+direction*200);clearTimeout(timer);await reload()}
async function page(direction:number){offset.value=Math.max(0,offset.value+direction*50);clearTimeout(timer);await reload()}
watch(fileRecoveryOpen,()=>{if(live)void reload()})
watch(candidates,value=>{if(value)fileRecoveryOpen.value=true})
watch(()=>relocation.isOpen.value,open=>{if(!open&&live&&relocation.capable)void relocation.activateSettings()})
onMounted(()=>{void props.workspace?.read();void reload();if(relocation.capable)void relocation.activateSettings()});onUnmounted(()=>{live=false;generation++;clearTimeout(timer);if(!props.relocationSession)relocation.dispose()})
</script>
<template>
  <article class="settings-card settings-glass-panel local-library-settings" data-testid="local-library-settings">
    <header class="library-heading">
      <div class="heading-copy"><p class="section-kicker">本地音乐</p><h3>音乐库与扫描</h3><p class="settings-note">管理音乐文件夹，查看收录与扫描进度。</p></div>
      <button type="button" class="primary-button" :disabled="busy||props.workspace?.addingLibrary.value||props.workspace?.pending.value" @click="choose">{{props.workspace?.addingLibrary.value?(addFeedback?.phase==='choosing'?'正在选择音乐文件夹…':'正在确认添加…'):'添加音乐文件夹并扫描'}}</button>
    </header>

    <div v-if="addFeedback||removeFeedback||readError||actionError||props.workspace?.error.value||props.workspace?.notice.value" class="library-feedback">
      <div v-if="addFeedback" data-testid="library-add-feedback">
        <p :role="addFeedback.phase==='failed'||addFeedback.phase==='unconfirmed'?'alert':'status'">{{addFeedback.message}}</p>
        <button v-if="addFeedback.phase==='unconfirmed'&&addFeedback.commandId" type="button" :disabled="props.workspace?.writing.value||props.workspace?.addingLibrary.value" @click="readAddResult">查询原添加结果</button>
      </div>
      <div v-if="removeFeedback" data-testid="library-remove-feedback">
        <p :role="removeFeedback.phase==='failed'||removeFeedback.phase==='unconfirmed'?'alert':'status'">{{removeFeedback.message}}</p>
        <button v-if="removeFeedback.phase==='unconfirmed'" type="button" :disabled="busy||props.workspace?.writing.value" @click="readRemoveResult">查询原移除结果</button>
      </div>
      <p v-if="readError" role="alert">{{readError}}</p>
      <p v-if="actionError" role="alert">{{actionError}}</p>
      <p v-if="props.workspace?.error.value" role="alert">{{props.workspace.error.value}}</p>
      <p v-if="props.workspace?.notice.value" role="status">{{props.workspace.notice.value}}</p>
    </div>

    <section aria-label="完整音乐库管理" class="library-overview">
      <div v-if="props.workspace&&libraryCards.length" class="library-selection">
        <span>已选 {{props.workspace.selectedLibraryIds.value.length}} 个音乐库</span>
        <div class="button-row"><button type="button" class="quiet-button" :disabled="props.workspace.selectionLocked.value" @click="props.workspace.selectLibraries(props.workspace.state.value?.libraries.map(value=>value.libraryId)??[])">全选当前音乐库</button><button type="button" class="quiet-button" :disabled="props.workspace.selectionLocked.value||!props.workspace.selectedLibraryIds.value.length" @click="props.workspace.selectLibraries([])">取消所有库选择</button></div>
      </div>

      <div v-if="!librariesConfirmed&&!readError" class="library-empty" role="status"><h4>正在读取音乐库</h4><p class="settings-note">已有目录与扫描记录会显示在这里。</p></div>
      <div v-else-if="librariesConfirmed&&!libraryCards.length" class="library-empty"><h4>添加你的第一个音乐库</h4><p class="settings-note">选择音乐文件夹后自动扫描，专辑会陆续出现在本地音乐中。</p></div>

      <ul v-else class="library-list" aria-label="持久多库选择">
        <li v-for="card in libraryCards" :key="card.id" class="library-card" :class="{'is-selected':props.workspace?.selectedLibraryIds.value.includes(card.id)}">
          <div class="library-card-main">
            <div class="library-identity">
              <label v-if="props.workspace&&card.managed" class="library-check"><input type="checkbox" :aria-label="`选择音乐库 ${card.label}`" :checked="props.workspace.selectedLibraryIds.value.includes(card.id)" :disabled="props.workspace.selectionLocked.value" @click.prevent="props.workspace.selectLibraryAt(card.id,$event.shiftKey)"><span class="visually-hidden">选择 {{card.label}}</span></label>
              <div class="library-copy"><div class="library-title"><h4>{{card.label}}</h4><span class="status-pill" :class="{'is-online':card.root?card.root.availability==='ONLINE':card.managed?.online}">{{onlineLabel(card)}}</span></div><p v-if="card.managed" class="library-counts"><span><strong>{{card.managed.totalAlbums}}</strong> 张专辑</span><span><strong>{{card.managed.totalTracks}}</strong> 首曲目</span><span v-if="card.managed.watching">自动监听已开启</span></p><p v-else class="settings-note">专辑与曲目计数待确认</p></div>
            </div>
            <div class="library-card-actions">
              <button v-if="card.job&&(card.job.phase==='pending'||card.job.phase==='running')" type="button" :disabled="busy" @click="control(card.job,'pause')">暂停扫描</button>
              <button v-else-if="card.job?.phase==='paused'" type="button" class="primary-button" :disabled="busy" @click="control(card.job,'resume')">继续扫描</button>
              <button v-else-if="awaitingScan(card)" type="button" :disabled="busy" @click="reload">刷新扫描状态</button>
              <button v-else type="button" :disabled="busy||!card.root||card.root.availability!=='ONLINE'||props.workspace?.locked.value" @click="card.root&&scan(card.root)">{{needsLibraryUpdate(card)||card.job?.phase==='cancelled'||card.job?.phase==='failed'?'更新音乐库':'增量扫描'}}</button>
            </div>
          </div>

          <div class="library-scan" aria-label="当前扫描进度">
            <div class="scan-heading"><span class="scan-state" aria-live="polite">{{scanLabel(card)}}</span><span v-if="readError" class="settings-note">上次读取的结果</span></div>
            <dl v-if="card.job&&!awaitingScan(card)" class="scan-counts"><div><dt>已处理</dt><dd>{{card.job.progress.visited}}</dd></div><div><dt>已收录</dt><dd>{{card.job.progress.accepted}}</dd></div><div><dt>已跳过</dt><dd>{{card.job.progress.rejected}}</dd></div></dl>
            <p v-else-if="awaitingScan(card)" class="settings-note">正在读取这次扫描的进度，请稍后刷新状态。</p>
            <p v-else-if="card.managed?.scanState==='failed'" class="settings-note">上次扫描未完成，具体原因请在任务历史中查看。</p>
            <p v-else-if="!card.job&&(!card.managed||card.managed.scanState==='idle')" class="settings-note">扫描会读取目录封面与音频内嵌封面，已有音乐会保留。</p>
            <p v-if="card.job?.failureCode&&!awaitingScan(card)" class="scan-failure" role="status">{{scanFailureMessage(card.job.failureCode)}}</p>
            <button v-if="card.job&&(card.job.phase==='pending'||card.job.phase==='running'||card.job.phase==='paused')" type="button" class="quiet-button" :disabled="busy" @click="control(card.job,'cancel')">取消这次扫描</button>
          </div>

          <details v-if="props.workspace&&card.managed" class="library-options"><summary>音乐库选项</summary><div class="tool-content">
            <div class="field-action"><label class="field">本地显示名<input v-model="libraryNames[card.id]" maxlength="256" :disabled="props.workspace.locked.value"></label><button type="button" :disabled="props.workspace.locked.value" @click="props.workspace.rename(card.id,libraryNames[card.id]||'')">保存本地库名称</button></div>
            <label class="check-row"><input type="checkbox" :checked="card.managed.watching" :disabled="props.workspace.locked.value" @change="props.workspace.watchLibrary(card.id,($event.target as HTMLInputElement).checked)"><span>监听文件变化并局部刷新<small>自动发现此目录中的新增与变更。</small></span></label>
            <div class="button-row"><button type="button" :disabled="props.workspace.locked.value||!card.managed.latestSnapshotId" @click="props.workspace.snapshot(card.id,'load')">加载上次扫描快照</button><button type="button" :disabled="props.workspace.locked.value" @click="props.workspace.snapshot(card.id,'retry')">仅重试原快照保存</button></div>
          </div></details>
        </li>
      </ul>
      <p class="settings-note scan-note">扫描进度会保存。中断后自动继续，手动暂停后保持暂停；取消扫描会保留已收录的音乐。</p>
      <button v-if="props.workspace" type="button" class="quiet-button refresh-library" :disabled="busy||props.workspace.busy.value" @click="props.workspace.read()">刷新完整库状态</button>
    </section>

    <section v-if="props.workspace" class="library-organize" aria-label="封面与音乐整理"><div><h4>整理音乐与补充封面</h4><p class="settings-note">缺少封面时，可手动选图或批量补图。扫描不会自动联网匹配。</p></div><button type="button" :disabled="!props.workspace.state.value?.libraries.length||props.workspace.addingLibrary.value||props.workspace.pending.value" @click="emit('organize')">打开整理与补图工作台</button></section>

    <section class="advanced-tools" aria-label="音乐库高级工具">
      <div class="advanced-heading"><h4>高级工具</h4><p class="settings-note">需要调整目录、恢复记录或找回文件时再展开。</p></div>

      <details v-if="props.workspace" class="tool-section" :open="!!props.workspace.importChoice.value"><summary><span>目录导入与角色<small>手动确认歌手、专辑或多库目录结构</small></span></summary><div class="tool-content">
        <p class="settings-note">普通添加会采用已识别的目录角色，需要调整时可先选择文件夹再确认。</p>
        <button type="button" :disabled="props.workspace.addingLibrary.value||props.workspace.pending.value||props.workspace.busy.value" @click="props.workspace.prepareImport()">选择文件夹并确认库结构</button>
        <section v-if="props.workspace.importChoice.value" class="import-confirmation" aria-label="目录角色确认"><h4>{{props.workspace.importChoice.value.label}}</h4><ul class="evidence-list"><li v-for="item in props.workspace.importChoice.value.evidence" :key="item">{{item}}</li></ul><label class="field">目录角色<select v-model="props.workspace.role.value" :disabled="props.workspace.locked.value"><option value="catalog">音乐库</option><option value="artist">歌手目录</option><option value="album">单张专辑</option><option value="container">包含多个音乐库</option></select></label><div class="button-row"><button type="button" class="primary-button" :disabled="props.workspace.locked.value" @click="props.workspace.confirmImport()">确认角色并导入</button><button type="button" :disabled="props.workspace.locked.value" @click="props.workspace.discard()">取消角色确认</button></div></section>
      </div></details>

      <details v-if="props.workspace" class="tool-section"><summary><span>后台扫描强度<small>调整同时推进的目录数</small></span></summary><div class="tool-content"><p class="settings-note">目录调度范围为 1–24。新扫描共用八个文件读取槽位；未完成的旧任务保留原读取强度。较低目录强度可减轻磁盘与网络目录负担。</p><div class="field-action"><label class="field compact-field">同时推进的目录数<input v-model.number="props.workspace.scanConcurrency.value" type="number" min="1" max="24" :disabled="props.workspace.locked.value"></label><button type="button" :disabled="props.workspace.locked.value" @click="props.workspace.save()">保存扫描设置</button></div></div></details>

      <details v-if="props.workspace" class="tool-section"><summary><span>移除音乐库记录<small>从本机移除选中库，保留源音乐文件</small></span></summary><div class="tool-content"><p class="settings-note">先在上方选择音乐库。移除前会停止并等待相关任务结束，仅清理专属记录、快照和无引用缓存；源音乐、已保存的封面与歌词，以及其他库的引用会保留。</p><p class="selected-libraries">{{selectedLibraryNames.length?`已选：${selectedLibraryNames.join('、')}`:'尚未选择音乐库'}}</p><label class="check-row"><input v-model="cleanupConfirmed" type="checkbox" :disabled="props.workspace.locked.value"><span>我已核对选中的 {{props.workspace.selectedLibraryIds.value.length}} 个音乐库</span></label><button type="button" class="danger-button" :disabled="busy||props.workspace.locked.value||!cleanupConfirmed||!props.workspace.selectedLibraryIds.value.length" @click="removeLibraries">移除选中库本地记录</button></div></details>

      <details class="tool-section"><summary><span>重新关联目录<small>音乐文件夹位置改变后，更新目录关联</small></span></summary><div class="tool-content"><p class="settings-note">保留原音乐库与记录。选择新目录并确认后会自动增量更新；此前已关联的音乐库，可使用上方的“更新音乐库”或“增量扫描”重新确认文件来源，无需再次选择目录。手动暂停、取消或失败的原任务不会因重复确认而重新启动。</p><p v-if="!roots.length" class="settings-note">{{rootsLoaded?'尚未加入源目录。':'目录尚未读取。'}}</p><ul v-else class="tool-list"><li v-for="root in roots" :key="root.root.id"><div class="row-copy"><strong>{{root.label}}</strong><small>{{availability[root.availability]}}</small></div><div class="button-row"><button type="button" :disabled="busy" @click="remount(root)">重新关联目录</button><button v-if="relocation.capable" type="button" :disabled="busy||relocation.busy.value||relocation.unknown.value" @click="previewRoot(root)">预览目录重关联</button></div></li></ul></div></details>

      <details v-if="relocation.capable" class="tool-section" :open="relocation.unknown.value||relocation.datasetChanged.value"><summary><span>文件搬迁与恢复<small>具体文件的搬迁设置、历史与恢复</small></span></summary><section class="tool-content" aria-label="具体文件搬迁设置"><p class="settings-note">默认关闭。开启后仍需完整预览与具体计划确认；目标验证并登记后，源材料默认保留，清理另用具体按钮。</p><label class="check-row"><input type="checkbox" aria-label="允许具体文件搬迁" :checked="relocation.context.value?.policy.enabled??false" :disabled="relocation.busy.value||relocation.unknown.value||relocation.datasetChanged.value||!relocation.context.value||relocation.contextFailed.value||!relocation.qualified.value" @change="relocationPolicy"><span>允许具体文件搬迁</span></label><p v-if="relocation.context.value?.qualification.issue" role="status">{{relocation.issue(relocation.context.value.qualification.issue)}}</p><p v-if="!relocation.qualified.value" class="settings-note">搬迁资格尚未通过，文件动作保持关闭；扫描、播放与找回继续可用。</p><p v-if="relocation.error.value" role="alert">{{relocation.error.value}}</p><p v-if="relocation.notice.value" role="status">{{relocation.notice.value}}</p><div class="button-row"><button type="button" :disabled="relocation.busy.value" @click="relocation.reconcile()">重新读取搬迁设置与原命令</button><button type="button" :disabled="relocation.busy.value" @click="relocation.openHistory()">搬迁历史与恢复</button></div></section></details>

      <details class="tool-section"><summary><span>任务历史与操作记录<small>查看扫描详情与尚未确认的操作结果</small></span></summary><div class="tool-content">
        <h4>扫描任务</h4><p v-if="!jobs.length" class="settings-note">{{rootsLoaded?'这一页没有扫描任务。':'扫描任务尚未读取。'}}</p>
        <ul v-else class="tool-list" aria-label="扫描任务"><li v-for="job in jobs" :key="job.jobId"><div class="row-copy"><strong>{{libraryLabel(job)}}</strong><small>{{phases[job.phase]}} · 已处理 {{job.progress.visited}} · 收录 {{job.progress.accepted}} · 未收录 {{job.progress.rejected}}</small><p v-if="job.failureCode" class="settings-note">{{scanFailureMessage(job.failureCode)}}</p></div><div class="button-row"><button v-if="job.phase==='pending'||job.phase==='running'" type="button" :disabled="busy" @click="control(job,'pause')">暂停</button><button v-if="job.phase==='paused'" type="button" :disabled="busy" @click="control(job,'resume')">继续</button><button v-if="job.phase==='pending'||job.phase==='running'||job.phase==='paused'" type="button" :disabled="busy" @click="control(job,'cancel')">取消</button></div></li></ul>
        <div class="pagination"><button type="button" :disabled="busy||jobOffset===0" @click="jobPage(-1)">上一页任务</button><span>每页最多 200 项</span><button type="button" :disabled="busy||!jobHasMore" @click="jobPage(1)">下一页任务</button></div>
        <template v-if="props.workspace"><h4 class="history-heading">音乐库操作</h4><p v-if="!props.workspace.operations.value.length" class="settings-note">暂无本次操作记录。</p><ul v-else class="tool-list" aria-label="库原操作结果"><li v-for="operation in props.workspace.operations.value" :key="operation.commandId"><div class="row-copy"><strong>{{operationName(operation.kind)}}</strong><small>{{operationStates[operation.state]}}</small><p v-if="operation.message" class="settings-note">{{operation.message}}</p></div><button v-if="operation.state==='running'||operation.state==='unknown'" type="button" :disabled="props.workspace.writing.value" @click="props.workspace.readOriginal(operation.commandId)">查询原库操作</button></li></ul></template>
      </div></details>

      <details v-if="!props.managementOnly" class="tool-section" :open="fileRecoveryOpen" @toggle="fileRecoveryOpen=($event.currentTarget as HTMLDetailsElement).open"><summary><span>逐曲找回文件<small>文件在外部改名或移动后，人工核对候选位置</small></span></summary><div class="tool-content"><p class="settings-note">每页显示 50 首曲目。选定曲目后核对文件，不按同名自动合并。</p><p v-if="!tracks.length" class="settings-note">这一页没有可显示的曲目。</p><ul v-else class="tool-list"><li v-for="track in tracks" :key="track.id"><div class="row-copy"><strong>{{titles[track.id]||'标题暂未读取'}}</strong></div><button type="button" :disabled="busy||track.segment!==null" @click="locate(track)">外部改名后重新定位</button></li></ul><div class="pagination"><button type="button" :disabled="busy||offset===0" @click="page(-1)">上一页</button><span>每页最多 50 首</span><button type="button" :disabled="busy||!hasMore" @click="page(1)">下一页</button></div>
        <section v-if="candidates" class="relocation-candidates" aria-label="找回文件候选"><h4>核对新的文件位置</h4><p class="settings-note">每个候选保留独立身份。文件大小、修改时间和文件对象的观察不能证明内容相同，也不能确认录音来源。</p><label class="check-row"><input v-model="confirming" type="checkbox"><span>我已核对并明确选择下方文件；保留原曲目、已保存的原始标签和人工更正</span></label><ul class="tool-list"><li v-for="candidate in candidates.candidates" :key="candidate.id"><div class="row-copy"><strong>{{candidate.relativeLabel}}</strong><small>{{candidate.size}} 字节 · {{candidate.evidence==='same-inode-observation'?'观察到相同文件对象':'需要人工核对'}}</small></div><button type="button" :disabled="busy||!confirming" @click="confirm(candidate.id)">确认这个候选</button></li></ul><button type="button" @click="candidates=null;selection=null">关闭候选</button></section>
      </div></details>
    </section>
    <p class="library-footnote">本地音乐与 CoverDrop 共用音乐库、扫描结果和封面缓存。</p>
    <RelocationDialog v-if="RelocationDialog&&relocation.isOpen.value" :session="relocation" />
  </article>
</template>

<style scoped>
.local-library-settings { display: grid; gap: 20px; min-width: 0; padding: 22px; color: var(--mb-text-primary); border: 1px solid var(--mb-glass-border); border-radius: 20px; background: var(--mb-glass-clear); backdrop-filter: blur(16px) saturate(140%); font-size: 13px; }
.local-library-settings h3, .local-library-settings h4, .local-library-settings p { margin: 0; }
.local-library-settings h3 { font-size: 20px; letter-spacing: -.025em; line-height: 1.35; }
.local-library-settings h4 { font-size: 14px; font-weight: 650; line-height: 1.45; }
.local-library-settings .section-kicker { margin-bottom: 5px; color: var(--mb-text-secondary); font-size: 11px; letter-spacing: .04em; }
.local-library-settings .settings-note { color: var(--mb-text-secondary); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.library-heading, .library-selection, .library-organize, .library-card-main, .tool-list > li { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.heading-copy { display: grid; gap: 5px; min-width: 0; }
.local-library-settings button { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; gap: 6px; min-height: 34px; max-width: 100%; padding: 7px 12px; border: 1px solid var(--mb-glass-border); border-radius: 10px; color: var(--mb-text-primary); background: var(--mb-glass-clear); font: inherit; font-size: 12px; font-weight: 550; line-height: 1.4; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, transform 120ms ease-out; }
.local-library-settings button.primary-button { border-color: color-mix(in srgb, var(--mb-accent) 45%, var(--mb-glass-border)); color: var(--mb-accent); background: color-mix(in srgb, var(--mb-accent) 10%, var(--mb-glass-clear)); }
.local-library-settings button.quiet-button { min-height: 30px; padding: 5px 8px; border-color: transparent; background: transparent; color: var(--mb-text-secondary); }
.local-library-settings button.danger-button { border-color: color-mix(in srgb, var(--mb-accent) 45%, var(--mb-glass-border)); }
.local-library-settings button:disabled { opacity: .45; cursor: not-allowed; }
.local-library-settings button:active:not(:disabled) { transform: scale(.98); }
.local-library-settings button:focus-visible, .local-library-settings summary:focus-visible, .local-library-settings input:focus-visible, .local-library-settings select:focus-visible { outline: 2px solid var(--mb-accent); outline-offset: 3px; }
.button-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.library-feedback { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--mb-glass-border); border-radius: 12px; background: var(--mb-glass-clear); line-height: 1.6; }
.library-overview { display: grid; gap: 12px; min-width: 0; }
.library-selection { gap: 10px; color: var(--mb-text-secondary); font-size: 12px; }
.library-list, .tool-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.library-card { min-width: 0; overflow: hidden; border: 1px solid var(--mb-glass-border); border-radius: 15px; background: color-mix(in srgb, var(--mb-glass-clear) 75%, transparent); }
.library-card.is-selected { border-color: color-mix(in srgb, var(--mb-accent) 40%, var(--mb-glass-border)); }
.library-card-main { padding: 16px; }
.library-identity { display: flex; align-items: flex-start; gap: 11px; min-width: 0; }
.library-check { display: flex; align-items: center; min-height: 23px; }
.library-copy { display: grid; gap: 7px; min-width: 0; }
.library-title { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; min-width: 0; }
.library-title h4 { overflow-wrap: anywhere; font-size: 15px; }
.status-pill { flex: 0 0 auto; padding: 3px 7px; border-radius: 6px; color: var(--mb-text-secondary); background: var(--mb-glass-clear); font-size: 10px; font-weight: 550; line-height: 1.4; }
.status-pill.is-online { color: var(--mb-accent); }
.library-counts { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 13px; color: var(--mb-text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.library-counts strong { color: var(--mb-text-primary); font-weight: 600; }
.library-card-actions { display: flex; align-items: center; gap: 8px; }
.library-scan { display: grid; gap: 9px; margin: 0 16px 14px; padding: 11px 12px; border: 1px solid var(--mb-glass-border); border-radius: 10px; }
.scan-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.scan-state { color: var(--mb-text-secondary); font-size: 12px; font-weight: 550; }
.scan-counts { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 0; font-variant-numeric: tabular-nums; }
.scan-counts > div { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.scan-counts dt { color: var(--mb-text-secondary); font-size: 11px; }
.scan-counts dd { margin: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 600; }
.scan-failure { font-size: 12px; line-height: 1.6; }
.library-scan > button, .tool-content > button, .refresh-library { justify-self: start; }
.local-library-settings .scan-note { max-width: 70ch; }
.library-options { border-top: 1px solid var(--mb-glass-border); }
.local-library-settings summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 16px; border-radius: 10px; list-style: none; cursor: pointer; user-select: none; }
.local-library-settings summary::-webkit-details-marker { display: none; }
.local-library-settings summary::after { content: '+'; flex: 0 0 auto; color: var(--mb-text-secondary); font-size: 18px; font-weight: 400; line-height: 1; }
.local-library-settings details[open] > summary::after { content: '−'; }
.library-options > summary { padding-block: 10px; color: var(--mb-text-secondary); font-size: 12px; }
.library-organize { padding: 16px 0; border-top: 1px solid var(--mb-glass-border); border-bottom: 1px solid var(--mb-glass-border); }
.library-organize > div { display: grid; gap: 5px; }
.advanced-tools { display: grid; gap: 8px; min-width: 0; }
.advanced-heading { display: grid; gap: 4px; margin-bottom: 4px; }
.tool-section { min-width: 0; border: 1px solid var(--mb-glass-border); border-radius: 12px; }
.tool-section > summary { font-size: 13px; font-weight: 550; }
.tool-section > summary > span { display: grid; gap: 3px; }
.tool-section > summary small { color: var(--mb-text-secondary); font-size: 11px; font-weight: 400; line-height: 1.5; }
.tool-content { display: grid; gap: 13px; padding: 4px 16px 16px; min-width: 0; }
.library-options .tool-content { padding-top: 4px; }
.field-action { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 10px; }
.field { display: grid; flex: 1 1 180px; gap: 7px; min-width: 0; color: var(--mb-text-secondary); font-size: 12px; }
.compact-field { flex: 0 1 160px; }
.local-library-settings input:not([type='checkbox']), .local-library-settings select { box-sizing: border-box; width: 100%; min-width: 0; min-height: 36px; padding: 8px 10px; border: 1px solid var(--mb-glass-border); border-radius: 9px; color: var(--mb-text-primary); background: var(--mb-glass-clear); font: inherit; }
.local-library-settings input[type='checkbox'] { flex: 0 0 auto; width: 15px; height: 15px; margin: 2px 0; accent-color: var(--mb-accent); cursor: pointer; }
.check-row { display: flex; align-items: flex-start; gap: 9px; line-height: 1.6; }
.check-row > span { display: grid; gap: 2px; min-width: 0; }
.check-row small { color: var(--mb-text-secondary); font-size: 11px; }
.import-confirmation, .relocation-candidates { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--mb-glass-border); border-radius: 10px; }
.evidence-list { margin: 0; padding-left: 18px; color: var(--mb-text-secondary); font-size: 12px; line-height: 1.65; }
.selected-libraries { overflow-wrap: anywhere; line-height: 1.6; }
.tool-list { gap: 0; }
.tool-list > li { min-width: 0; padding: 12px 0; border-bottom: 1px solid var(--mb-glass-border); }
.tool-list > li:first-child { padding-top: 0; }
.tool-list > li:last-child { padding-bottom: 0; border-bottom: 0; }
.row-copy { display: grid; flex: 1 1 180px; gap: 5px; min-width: 0; overflow-wrap: anywhere; }
.row-copy strong { font-size: 12px; font-weight: 550; }
.row-copy small { color: var(--mb-text-secondary); font-size: 11px; line-height: 1.55; font-variant-numeric: tabular-nums; }
.pagination { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding-top: 4px; }
.pagination > span { color: var(--mb-text-secondary); font-size: 11px; }
.local-library-settings .history-heading { padding-top: 12px; border-top: 1px solid var(--mb-glass-border); }
.library-footnote { color: var(--mb-text-secondary); font-size: 11px; line-height: 1.6; }
@media (hover: hover) and (pointer: fine) {
  .local-library-settings button:hover:not(:disabled), .local-library-settings summary:hover { background: color-mix(in srgb, var(--mb-accent) 5%, var(--mb-glass-clear)); }
  .local-library-settings button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--mb-accent) 35%, var(--mb-glass-border)); }
}
@media (max-width: 640px) {
  .local-library-settings { gap: 17px; padding: 16px; }
  .library-heading, .library-organize, .library-card-main { align-items: flex-start; flex-direction: column; gap: 12px; }
  .library-selection { align-items: flex-start; flex-wrap: wrap; }
  .library-card-actions { align-self: flex-end; }
  .tool-list > li { align-items: flex-start; flex-wrap: wrap; gap: 10px; }
  .tool-list .button-row { justify-content: flex-start; }
  .library-organize > button { align-self: flex-start; }
}
@media (prefers-reduced-motion: reduce) {
  .local-library-settings button { transition: background-color 150ms ease, border-color 150ms ease; }
  .local-library-settings button:active:not(:disabled) { transform: none; }
}
</style>
