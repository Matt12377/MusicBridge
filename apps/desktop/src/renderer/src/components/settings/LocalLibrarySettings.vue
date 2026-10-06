<script setup lang="ts">
import {ref,onMounted,onUnmounted} from 'vue'
import type {LocalRootView,ScanJobRecord,LocalTrack,LocalRelocationCandidates,LocalRelocationSelection} from '@music-bridge/contracts'
const api=window.musicBridge,roots=ref<LocalRootView[]>([]),jobs=ref<ScanJobRecord[]>([]),tracks=ref<LocalTrack[]>([]),offset=ref(0),hasMore=ref(false),jobOffset=ref(0),jobHasMore=ref(false),error=ref(''),busy=ref(false),selection=ref<LocalRelocationSelection|null>(null),candidates=ref<LocalRelocationCandidates|null>(null),confirming=ref(false),titles=ref<Record<string,string>>({})
const phases:Record<ScanJobRecord['phase'],string>={pending:'等待扫描',running:'扫描中',paused:'已暂停',completed:'已完成',failed:'未完成',cancelled:'已取消'}
const availability={ONLINE:'可读取',SOURCE_ROOT_OFFLINE:'目录离线',REVOKED:'许可已撤销'}
const scanFailureMessages:Record<NonNullable<ScanJobRecord['failureCode']>,string>={ROOT_UNAVAILABLE:'源目录无法读取，请检查目录是否在线及读取权限；音乐库保留。',ROOT_REVISION_CHANGED:'源目录关联已改变，请核对当前目录后重新开始扫描；音乐库保留。',SCAN_READ_FAILED:'扫描读取未完成，请检查源目录和读取权限；音乐库保留。',CHECKPOINT_INVALID:'无法确认上次扫描的进度，请重新开始扫描；音乐库保留。'}
function scanFailureMessage(code:string){return Object.hasOwn(scanFailureMessages,code)?scanFailureMessages[code as keyof typeof scanFailureMessages]:'扫描未获确认，音乐库保留。'}
let live=true,generation=0,timer:ReturnType<typeof setTimeout>|undefined
async function reload(){clearTimeout(timer);const current=++generation;try{const [nextRoots,page,nextTracks]=await Promise.all([api.listLocalLibraryRoots(),api.localLibraryScan('localScan.page',{offset:jobOffset.value,limit:200}),api.listLocalLibraryTracks({offset:offset.value,limit:50})]);const entries=await Promise.all(nextTracks.items.map(async track=>{try{return [track.id,(await api.getLocalLibraryMetadata(track.id)).effective.title||'来源未提供标题'] as const}catch{return [track.id,'标题暂未读取'] as const}}));if(!live||current!==generation)return;titles.value=Object.fromEntries(entries);roots.value=nextRoots;jobs.value=page.items;jobHasMore.value=page.hasMore;tracks.value=[...nextTracks.items];hasMore.value=nextTracks.hasMore}catch{if(live&&current===generation)error.value='读取未获确认，现有音乐库保留。'}finally{if(live&&current===generation)timer=setTimeout(()=>{void reload()},1500)}}
// 只识别已确认的扫描冲突；未知结果与其他入口错误不能据此变参重试。
function confirmedScanConflict(cause:unknown){return cause instanceof Error&&/^(?:Error invoking remote method ['"]localLibrary:request['"]: (?:Error: )?)?\[INVENTORY_CONFLICT\](?:\s|$)/u.test(cause.message)}
async function action(work:()=>Promise<unknown>,scanControl=false){if(busy.value)return;busy.value=true;error.value='';try{await work();if(live){clearTimeout(timer);await reload()}}catch(cause){if(live){if(scanControl&&confirmedScanConflict(cause)){error.value='任务状态已更新，操作未执行。请刷新状态后重试。';clearTimeout(timer);await reload()}else error.value='操作未获确认。请核对任务状态或未确认操作，不要更换参数重试。'}}finally{busy.value=false}}
async function choose(){await action(()=>api.chooseLocalLibraryRoot(crypto.randomUUID()))}
async function scan(root:LocalRootView){await action(()=>api.localLibraryScan('localScan.start',{commandId:crypto.randomUUID(),libraryRootId:root.root.id,expectedRootRevision:root.root.revision}))}
async function control(job:ScanJobRecord,operation:'pause'|'resume'|'cancel'){await action(()=>api.localLibraryScan(`localScan.${operation}`,{commandId:crypto.randomUUID(),jobId:job.jobId,expectedRevision:job.jobRevision}),true)}
async function remount(root:LocalRootView){await action(async()=>{const target=await api.chooseRecordingSourceRoot(crypto.randomUUID());if(!target)return;if(!window.confirm(`确认将“${root.label}”重新关联到“${target.label}”？旧对象与记录保留；随后需显式增量扫描。`))return;await api.relinkLocalLibraryRoot({commandId:crypto.randomUUID(),rootId:root.root.id,expectedRevision:root.root.revision,targetSourceRootId:target.id,userConfirmed:true})})}
async function locate(track:LocalTrack){await action(async()=>{const asset=await api.getLocalLibraryAsset(track.assetId),root=roots.value.find(x=>x.root.id===asset.libraryRootId);if(!root)throw new Error('根未就绪');const body={assetId:asset.id,expectedFileRevision:asset.fileRevision,expectedLocationRevision:asset.locationRevision,expectedRootRevision:root.root.revision};const result=await api.chooseLocalRelocationCandidates(body);if(live){selection.value=body;candidates.value=result;confirming.value=false}})}
async function confirm(id:string){if(!selection.value||!confirming.value)return;const body={...selection.value,commandId:id,userConfirmed:true as const};await action(async()=>{await api.confirmLocalRelocation(body);if(live){selection.value=null;candidates.value=null;confirming.value=false}})}
async function jobPage(direction:number){jobOffset.value=Math.max(0,jobOffset.value+direction*200);clearTimeout(timer);await reload()}
async function page(direction:number){offset.value=Math.max(0,offset.value+direction*50);clearTimeout(timer);await reload()}
onMounted(()=>{void reload()});onUnmounted(()=>{live=false;generation++;clearTimeout(timer)})
</script>
<template>
 <article class="settings-card settings-glass-panel" data-testid="local-library-settings">
  <div class="panel-heading"><div><p class="section-kicker">本地数字音乐</p><h3>只读扫描与重新定位</h3></div><button :disabled="busy" @click="choose">授权源目录并加入音乐库</button></div>
  <p class="settings-note">扫描只读取音频标签，不改源文件。暂停可继续；取消保留已入库对象。目录离线与权限变化不会删除音乐库。</p>
  <p v-if="error" role="alert">{{error}}</p>
  <p v-if="roots.length===0">尚未加入源目录。</p>
  <ul><li v-for="root in roots" :key="root.root.id"><strong>{{root.label}}</strong> · {{availability[root.availability]}} <button :disabled="busy||root.availability!=='ONLINE'" @click="scan(root)">增量扫描</button><button :disabled="busy" @click="remount(root)">重新关联目录</button></li></ul>
  <ul aria-label="扫描任务"><li v-for="job in jobs" :key="job.jobId">{{phases[job.phase]}} · 已处理 {{job.progress.visited}} / 收录 {{job.progress.accepted}} / 拒绝 {{job.progress.rejected}} <span v-if="job.failureCode">{{scanFailureMessage(job.failureCode)}}</span><button v-if="job.phase==='pending'||job.phase==='running'" :disabled="busy" @click="control(job,'pause')">暂停</button><button v-if="job.phase==='paused'" :disabled="busy" @click="control(job,'resume')">继续</button><button v-if="job.phase==='pending'||job.phase==='running'||job.phase==='paused'" :disabled="busy" @click="control(job,'cancel')">取消</button></li></ul>
  <button :disabled="busy||jobOffset===0" @click="jobPage(-1)">上一页任务</button><button :disabled="busy||!jobHasMore" @click="jobPage(1)">下一页任务</button>
  <p>曲目（每页50条）</p><ul><li v-for="track in tracks" :key="track.id">{{titles[track.id]||'标题暂未读取'}} <button :disabled="busy||track.segment!==null" @click="locate(track)">外部改名后重新定位</button></li></ul>
  <button :disabled="busy||offset===0" @click="page(-1)">上一页</button><button :disabled="busy||!hasMore" @click="page(1)">下一页</button>
  <section v-if="candidates"><p>多个候选保留独立身份，不按同名文件自动合并。文件大小、修改时间和文件对象的观察不能证明内容相同，也不能确认录音来源。</p><label><input v-model="confirming" type="checkbox">我已核对并明确选择下方文件；保留原曲目、已保存的原始标签和人工更正</label><ul><li v-for="candidate in candidates.candidates" :key="candidate.id">{{candidate.relativeLabel}} · {{candidate.size}} 字节 · {{candidate.evidence==='same-inode-observation'?'观察到相同文件对象':'需要人工核对'}} <button :disabled="busy||!confirming" @click="confirm(candidate.id)">确认这个候选</button></li></ul><button @click="candidates=null;selection=null">关闭候选</button></section>
 </article>
</template>
