<script setup lang="ts">
import {defineAsyncComponent,markRaw,ref,watch,onMounted,onUnmounted} from 'vue'
import type {LocalRootView,ScanJobRecord,LocalTrack,LocalRelocationCandidates,LocalRelocationSelection} from '@music-bridge/contracts'
import type { LocalWorkbenchLibrary } from '../../composables/application/local-library-workbench/library.js'
import {useLocalRelocationPlans} from '../../composables/application/useLocalRelocationPlans.js'
const props=withDefaults(defineProps<{managementOnly?:boolean;workspace?:LocalWorkbenchLibrary;relocationSession?:ReturnType<typeof useLocalRelocationPlans>}>(),{managementOnly:false})
const emit=defineEmits<{updated:[]}>()
const rootsLoaded=ref(false), libraryNames=ref<Record<string,string>>({}), cleanupConfirmed=ref(false)
watch(()=>props.workspace?.state.value, state=>{for(const item of state?.libraries??[])if(libraryNames.value[item.libraryId]===undefined)libraryNames.value[item.libraryId]=item.label},{immediate:true})
const api=window.musicBridge,roots=ref<LocalRootView[]>([]),jobs=ref<ScanJobRecord[]>([]),tracks=ref<LocalTrack[]>([]),offset=ref(0),hasMore=ref(false),jobOffset=ref(0),jobHasMore=ref(false),readError=ref(''),actionError=ref(''),busy=ref(false),selection=ref<LocalRelocationSelection|null>(null),candidates=ref<LocalRelocationCandidates|null>(null),confirming=ref(false),titles=ref<Record<string,string>>({})
const relocation=props.relocationSession??markRaw(useLocalRelocationPlans({api,onApplied:()=>{if(live){void reload();emit('updated')}}}))
const RelocationDialog=!props.relocationSession&&relocation.capable?defineAsyncComponent(()=>import('../library/LocalRelocationDialog.vue')):null
const phases:Record<ScanJobRecord['phase'],string>={pending:'等待扫描',running:'扫描中',paused:'已暂停',completed:'已完成',failed:'未完成',cancelled:'已取消'}
const availability={ONLINE:'可读取',SOURCE_ROOT_OFFLINE:'目录离线',REVOKED:'许可已撤销'}
const scanFailureMessages:Record<NonNullable<ScanJobRecord['failureCode']>,string>={ROOT_UNAVAILABLE:'源目录无法读取，请检查目录是否在线及读取权限；音乐库保留。',ROOT_REVISION_CHANGED:'源目录关联已改变，请核对当前目录后重新开始扫描；音乐库保留。',SCAN_READ_FAILED:'扫描读取未完成，请检查源目录和读取权限；音乐库保留。',CHECKPOINT_INVALID:'无法确认上次扫描的进度，请重新开始扫描；音乐库保留。'}
function scanFailureMessage(code:string){return Object.hasOwn(scanFailureMessages,code)?scanFailureMessages[code as keyof typeof scanFailureMessages]:'扫描未获确认，音乐库保留。'}
let live=true,generation=0,timer:ReturnType<typeof setTimeout>|undefined,lastCatalogState:string|undefined
async function reload(){
 clearTimeout(timer);const current=++generation
 try{
  const [nextRoots,page,nextTracks]=await Promise.all([api.listLocalLibraryRoots(),api.localLibraryScan('localScan.page',{offset:jobOffset.value,limit:200}),props.managementOnly?Promise.resolve({items:[] as LocalTrack[],hasMore:false}):api.listLocalLibraryTracks({offset:offset.value,limit:50})])
  const entries=await Promise.all(nextTracks.items.map(async track=>{try{return [track.id,(await api.getLocalLibraryMetadata(track.id)).effective.title||'来源未提供标题'] as const}catch{return [track.id,'标题暂未读取'] as const}}))
  if(!live||current!==generation)return
  titles.value=Object.fromEntries(entries);roots.value=nextRoots;rootsLoaded.value=true;jobs.value=page.items;jobHasMore.value=page.hasMore;tracks.value=[...nextTracks.items];hasMore.value=nextTracks.hasMore;readError.value=''
  const state=JSON.stringify([nextRoots.map(v=>[v.root.id,v.root.revision,v.availability]),page.items.map(v=>[v.jobId,v.progress.accepted,v.phase])])
  if(lastCatalogState!==undefined&&lastCatalogState!==state)emit('updated')
  lastCatalogState=state
 }catch{if(live&&current===generation)readError.value='读取未获确认，现有音乐库保留。'}finally{if(live&&current===generation)timer=setTimeout(()=>{void reload()},1500)}
}
// 只识别已确认的扫描冲突；未知结果与其他入口错误不能据此变参重试。
function confirmedScanConflict(cause:unknown){return cause instanceof Error&&/^(?:Error invoking remote method ['"]localLibrary:request['"]: (?:Error: )?)?\[INVENTORY_CONFLICT\](?:\s|$)/u.test(cause.message)}
async function action(work:()=>Promise<unknown>,scanControl=false){if(busy.value)return;busy.value=true;actionError.value='';try{await work();if(live){clearTimeout(timer);await reload();emit('updated')}}catch(cause){if(live){if(scanControl&&confirmedScanConflict(cause)){actionError.value='任务状态已更新，操作未执行。请刷新状态后重试。';clearTimeout(timer);await reload()}else actionError.value='操作未获确认。请核对任务状态或未确认操作，不要更换参数重试。'}}finally{busy.value=false}}
async function choose(){await action(()=>api.chooseLocalLibraryRoot(crypto.randomUUID()))}
async function scan(root:LocalRootView){await action(()=>api.localLibraryScan('localScan.start',{commandId:crypto.randomUUID(),libraryRootId:root.root.id,expectedRootRevision:root.root.revision}))}
// 仅明确的工作区扫描点击委托此原入口；按当前投影再核根与修订，不借旧库名或旧checkbox。
async function scanLibrary(request:{libraryRootId:string;expectedRootRevision:string}):Promise<void>{
 const root=roots.value.find(value=>value.root.id===request.libraryRootId)
 if(!live||busy.value||!root||root.availability!=='ONLINE'||root.root.revision!==request.expectedRootRevision){actionError.value='当前目录或修订尚未核实，请刷新后重新扫描。';return}
 await scan(root)
}
defineExpose({scanLibrary})
async function control(job:ScanJobRecord,operation:'pause'|'resume'|'cancel'){await action(()=>api.localLibraryScan(`localScan.${operation}`,{commandId:crypto.randomUUID(),jobId:job.jobId,expectedRevision:job.jobRevision}),true)}
async function remount(root:LocalRootView){await action(async()=>{const target=await api.chooseRecordingSourceRoot(crypto.randomUUID());if(!target)return;if(!window.confirm(`确认将“${root.label}”重新关联到“${target.label}”？旧对象与记录保留；随后需显式增量扫描。`))return;await api.relinkLocalLibraryRoot({commandId:crypto.randomUUID(),rootId:root.root.id,expectedRevision:root.root.revision,targetSourceRootId:target.id,userConfirmed:true})})}
async function previewRoot(root:LocalRootView){if(busy.value||relocation.busy.value||relocation.unknown.value)return;await relocation.openRoot({libraryRootId:root.root.id,expectedRootRevision:root.root.revision},root.label)}
async function relocationPolicy(event:Event){const input=event.target as HTMLInputElement;await relocation.setPolicy(input.checked);input.checked=relocation.context.value?.policy.enabled??false}
async function locate(track:LocalTrack){await action(async()=>{const asset=await api.getLocalLibraryAsset(track.assetId),root=roots.value.find(x=>x.root.id===asset.libraryRootId);if(!root)throw new Error('根未就绪');const body={assetId:asset.id,expectedFileRevision:asset.fileRevision,expectedLocationRevision:asset.locationRevision,expectedRootRevision:root.root.revision};const result=await api.chooseLocalRelocationCandidates(body);if(live){selection.value=body;candidates.value=result;confirming.value=false}})}
async function confirm(id:string){if(!selection.value||!confirming.value)return;const body={...selection.value,commandId:id,userConfirmed:true as const};await action(async()=>{await api.confirmLocalRelocation(body);if(live){selection.value=null;candidates.value=null;confirming.value=false}})}
async function jobPage(direction:number){jobOffset.value=Math.max(0,jobOffset.value+direction*200);clearTimeout(timer);await reload()}
async function page(direction:number){offset.value=Math.max(0,offset.value+direction*50);clearTimeout(timer);await reload()}
watch(()=>relocation.isOpen.value,open=>{if(!open&&live&&relocation.capable)void relocation.activateSettings()})
onMounted(()=>{void props.workspace?.read();void props.workspace?.readNameSettings();void reload();if(relocation.capable)void relocation.activateSettings()});onUnmounted(()=>{live=false;generation++;clearTimeout(timer);if(!props.relocationSession)relocation.dispose()})
</script>
<template>
 <article class="settings-card settings-glass-panel" data-testid="local-library-settings">
  <div class="panel-heading"><div><p class="section-kicker">本地数字音乐</p><h3>只读扫描与重新定位</h3></div><button :disabled="busy" @click="choose">授权源目录并加入音乐库</button></div>
  <section v-if="props.workspace" aria-label="完整音乐库管理">
   <p v-if="props.workspace.error.value" role="alert">{{props.workspace.error.value}}</p><p v-if="props.workspace.notice.value" role="status">{{props.workspace.notice.value}}</p>
   <button type="button" :disabled="props.workspace.pending.value||props.workspace.busy.value" @click="props.workspace.prepareImport()">选择文件夹并确认库结构</button>
   <section v-if="props.workspace.importChoice.value" aria-label="目录角色确认"><h4>{{props.workspace.importChoice.value.label}}</h4><ul><li v-for="item in props.workspace.importChoice.value.evidence" :key="item">{{item}}</li></ul>
    <label>目录角色<select v-model="props.workspace.role.value" :disabled="props.workspace.locked.value"><option value="catalog">音乐库</option><option value="artist">歌手目录</option><option value="album">单张专辑</option><option value="container">包含多个音乐库</option></select></label>
    <button type="button" :disabled="props.workspace.locked.value" @click="props.workspace.confirmImport()">确认角色并导入</button><button type="button" :disabled="props.workspace.locked.value" @click="props.workspace.discard()">取消角色确认</button>
   </section>
   <p>点击切换库的选择；Shift按当前库顺序连续选择，Cmd/Ctrl保留多库选择。</p><button type="button" :disabled="props.workspace.selectionLocked.value" @click="props.workspace.selectLibraries(props.workspace.state.value?.libraries.map(value=>value.libraryId)??[])">全选当前音乐库</button><button type="button" :disabled="props.workspace.selectionLocked.value" @click="props.workspace.selectLibraries([])">取消所有库选择</button>
   <ul aria-label="持久多库选择"><li v-for="library in props.workspace.state.value?.libraries??[]" :key="library.libraryId">
    <label><input type="checkbox" :checked="props.workspace.selectedLibraryIds.value.includes(library.libraryId)" :disabled="props.workspace.selectionLocked.value" @click.prevent="props.workspace.selectLibraryAt(library.libraryId,$event.shiftKey)">{{library.label}}</label> · {{library.online?'目录在线':'目录离线'}} · {{library.scanState}} · {{library.totalAlbums}} 张 / {{library.totalTracks}} 首
    <label>本地显示名<input v-model="libraryNames[library.libraryId]" maxlength="256" :disabled="props.workspace.locked.value"></label><button type="button" :disabled="props.workspace.locked.value" @click="props.workspace.rename(library.libraryId,libraryNames[library.libraryId]||'')">保存本地库名称</button>
    <label><input type="checkbox" :checked="library.watching" :disabled="props.workspace.locked.value" @change="props.workspace.watchLibrary(library.libraryId,($event.target as HTMLInputElement).checked)">监听文件变化并局部刷新</label>
    <button type="button" :disabled="props.workspace.locked.value||!library.latestSnapshotId" @click="props.workspace.snapshot(library.libraryId,'load')">加载上次扫描快照</button><button type="button" :disabled="props.workspace.locked.value" @click="props.workspace.snapshot(library.libraryId,'retry')">仅重试原快照保存</button>
   </li></ul>
   <label>扫描并发（1–24）<input v-model.number="props.workspace.scanConcurrency.value" type="number" min="1" max="24" :disabled="props.workspace.locked.value"></label><button type="button" :disabled="props.workspace.locked.value" @click="props.workspace.save()">保存扫描设置</button>
   <details><summary>清理选中库的本地记录</summary><p>先停止并等待库任务收口，仅清专属记录、快照和无引用缓存；源音乐、已保存封面/LRC及其他库引用保留。</p><label><input v-model="cleanupConfirmed" type="checkbox" :disabled="props.workspace.locked.value">我已核对选中的 {{props.workspace.selectedLibraryIds.value.length}} 个音乐库</label><button type="button" :disabled="props.workspace.locked.value||!cleanupConfirmed||!props.workspace.selectedLibraryIds.value.length" @click="props.workspace.remove()">移除选中库本地记录</button></details>
   <ul aria-label="库原操作结果"><li v-for="operation in props.workspace.operations.value" :key="operation.commandId">{{operation.kind}} · {{operation.state}} <span v-if="operation.message">{{operation.message}}</span><button v-if="operation.state==='running'||operation.state==='unknown'" type="button" :disabled="props.workspace.writing.value" @click="props.workspace.readOriginal(operation.commandId)">查询原库操作</button></li></ul>
   <button type="button" :disabled="props.workspace.busy.value" @click="props.workspace.read()">刷新完整库状态</button>
  </section>
  <p class="settings-note">扫描只读取音频标签，不改源文件。暂停可继续；取消保留已入库对象。目录离线与权限变化不会删除音乐库。</p>
  <p v-if="readError" role="alert">{{readError}}</p><p v-if="actionError" role="alert">{{actionError}}</p>
  <p v-if="rootsLoaded&&roots.length===0">尚未加入源目录。</p>
  <ul><li v-for="root in roots" :key="root.root.id"><strong>{{root.label}}</strong> · {{availability[root.availability]}} <button :disabled="busy||root.availability!=='ONLINE'" @click="scan(root)">增量扫描</button><button :disabled="busy" @click="remount(root)">重新关联目录</button><button v-if="relocation.capable" :disabled="busy||relocation.busy.value||relocation.unknown.value" @click="previewRoot(root)">预览目录重关联</button></li></ul>
  <section v-if="relocation.capable" aria-label="具体文件搬迁设置"><h4>文件搬迁与重关联</h4><p class="settings-note">默认关闭。开启后仍需完整预览与具体计划确认；目标完整验证并登记后，源材料默认保留，清理另用具体按钮。</p><label><input type="checkbox" aria-label="允许具体文件搬迁" :checked="relocation.context.value?.policy.enabled??false" :disabled="relocation.busy.value||relocation.unknown.value||relocation.datasetChanged.value||!relocation.context.value||relocation.contextFailed.value||!relocation.qualified.value" @change="relocationPolicy">允许具体文件搬迁</label><p v-if="relocation.context.value?.qualification.issue" role="status">{{relocation.issue(relocation.context.value.qualification.issue)}}</p><p v-if="!relocation.qualified.value" class="settings-note">搬迁资格尚未通过，文件动作保持关闭；原扫描、播放与找回继续可用。</p><p v-if="relocation.error.value" role="alert">{{relocation.error.value}}</p><p v-if="relocation.notice.value" role="status">{{relocation.notice.value}}</p><button :disabled="relocation.busy.value" @click="relocation.reconcile()">重新读取搬迁设置与原命令</button><button :disabled="relocation.busy.value" @click="relocation.openHistory()">搬迁历史与恢复</button></section>
  <ul aria-label="扫描任务"><li v-for="job in jobs" :key="job.jobId">{{phases[job.phase]}} · 已处理 {{job.progress.visited}} / 收录 {{job.progress.accepted}} / 拒绝 {{job.progress.rejected}} <span v-if="job.failureCode">{{scanFailureMessage(job.failureCode)}}</span><button v-if="job.phase==='pending'||job.phase==='running'" :disabled="busy" @click="control(job,'pause')">暂停</button><button v-if="job.phase==='paused'" :disabled="busy" @click="control(job,'resume')">继续</button><button v-if="job.phase==='pending'||job.phase==='running'||job.phase==='paused'" :disabled="busy" @click="control(job,'cancel')">取消</button></li></ul>
  <button :disabled="busy||jobOffset===0" @click="jobPage(-1)">上一页任务</button><button :disabled="busy||!jobHasMore" @click="jobPage(1)">下一页任务</button>
  <template v-if="!props.managementOnly"><p>曲目（每页50条）</p><ul><li v-for="track in tracks" :key="track.id">{{titles[track.id]||'标题暂未读取'}} <button :disabled="busy||track.segment!==null" @click="locate(track)">外部改名后重新定位</button></li></ul>
  <button :disabled="busy||offset===0" @click="page(-1)">上一页</button><button :disabled="busy||!hasMore" @click="page(1)">下一页</button></template>
  <section v-if="candidates"><p>多个候选保留独立身份，不按同名文件自动合并。文件大小、修改时间和文件对象的观察不能证明内容相同，也不能确认录音来源。</p><label><input v-model="confirming" type="checkbox">我已核对并明确选择下方文件；保留原曲目、已保存的原始标签和人工更正</label><ul><li v-for="candidate in candidates.candidates" :key="candidate.id">{{candidate.relativeLabel}} · {{candidate.size}} 字节 · {{candidate.evidence==='same-inode-observation'?'观察到相同文件对象':'需要人工核对'}} <button :disabled="busy||!confirming" @click="confirm(candidate.id)">确认这个候选</button></li></ul><button @click="candidates=null;selection=null">关闭候选</button></section>
  <RelocationDialog v-if="RelocationDialog&&relocation.isOpen.value" :session="relocation" />
 </article>
</template>
