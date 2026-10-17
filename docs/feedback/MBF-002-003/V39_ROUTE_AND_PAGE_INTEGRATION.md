# V3.9：本地专辑通道与正式页面接线提案

本文基于隔离分支 `codex/mbf-002-003-local-library`，base 为 `479e746bb7106a4dac158fe616290220de03a53a`。新模块已实现，原共享装配仍由 MusicBridge V3.9 在 MBF-004 封板后串行实施；本文的拟新增方法与差异不是已经接通的正式功能。调度 Root 审边界，本线交付最小接线规格及 helper。原播放、SourceWrites、搬迁、Organizer、数据集、队列和保险库的作者身份不转移到 Renderer。

## 已实现与仍需实施的准确位置

| 位置 | 本线已实现 | V3.9 尚需实施 |
| --- | --- | --- |
| contracts/local-album-library.ts | query/tracks/artwork 三命令、页上限200、DTO和原请求回声核对 | 接入原 API 名称清单及真正 contextBridge |
| collection/dataset-owner-protocol.ts | 显式 localAlbumRead 操作及 album 负载、projection规范化输入输出闭集 | Client/worker/domain 实际分派与错误通道 |
| collection/local-album-browser/owner-protocol.ts | isLocalAlbumOwnerReadRequest/Result，命令和原分页/目标回声核对 | 在实际 Client.pending 保存原完整 request 并调用结果核对 |
| collection/local-album-browser/main-protocol.ts | Main私有请求/回复闭集、id/DS/command绑定与固定中文错误 | MainSupervisor、utility实际传输与生命周期 |
| collection/local-album-browser/owner-runtime.ts | 同原repository读模型、真实FD/读取准入、物理收尾及规范化请求 | 原domain唯一组合，原Main nativeImage规范化回程 |
| main/local-library-workbench/album-ipc.ts | 固定 localAlbum:request 入口、可信sender/DS前后核对 | 原Main注册，并绑定真实当前工作库和Supervisor |
| preload/local-album-client.ts | 固定3方法、前后DS围栏及强结果核对 | 原preload/index.ts与api.ts接口、方法清单、创建参数 |
| renderer/local-library-browser 与 local-browser | 专辑墙、详情、来源/筛选、分页、真实trackId、选中范围与返回滚动/焦点 | App和LocalLibraryView默认挂载，原维护对话框全部保留 |
| renderer/local-library-workbench 与 local-workbench | 工作台Controller、原命令恢复、封面/AI/CUE/原入口UI | 原Main依赖、registry/完整writer/CUE Actor/settings/Vault真实装配 |

Root批准的纯snapshot共享journal提案及transport提案单列在proposals；未应用，不能把helper通过改写成共享writer或正式App通过。

## 1. 原 Owner Client / worker / domain 的最小差异

`dataset-owner-client.ts` 的现有 `rpc(operation, request?, expectedDatasetId?, local?, queue?, edition?, mobile?)` 只增加一个类型化 album 参数；`PendingRequest`同时保存原album及expectedDatasetId。生成消息只用 operation='localAlbumRead'、现有epoch/sequence/requestId，禁止把三命令混进通用dispatch的前缀授权。

```ts
// 拟增加；其他rpc调用不改变参数意义。
album?: LocalAlbumOwnerReadRequest
// message 与 PendingRequest 分别附同一份已验证、structuredClone后的 album。
...(album === undefined ? {} : { album })
```

返回端的方法规格：

```ts
async readLocalAlbum(album: LocalAlbumOwnerReadRequest,
  expectedDatasetId: string): Promise<LocalAlbumOwnerReadResult> {
  if (!isLocalAlbumOwnerReadRequest(album) || !identity || closing || failed || exited
    || !bootCommitted || identity.datasetId !== expectedDatasetId) {
    throw new DatasetOwnerTransportError('not-sent')
  }
  const captured = structuredClone(album)
  const result = await rpc('localAlbumRead', undefined, expectedDatasetId,
    undefined, undefined, undefined, undefined, captured)
  if (!identity || closing || failed || exited || identity.datasetId !== expectedDatasetId
    || !isLocalAlbumOwnerReadResult(result, captured)) {
    throw new DatasetOwnerTransportError('unknown')
  }
  return result
}
```

实际receive分支必须在resolve前用Pending中的captured核对，不能只在以上方法拿到回复后才核。旧 `isDatasetOwnerResponse` 对generic DTO的通过不证明此命令/分页正确。错epoch/operation/requestId、错误DS及已关闭代际沿原fatal/drain处理；未知prefix依旧拒绝。

`dataset-owner-worker.ts` 在 `validateIpcRequest(request.request)` 的通用尾部分支**之前**增加：

```ts
if (request.operation === 'localAlbumRead') {
  // 已经通过原isDatasetOwnerRequest；仍核现有epoch/boot/closing和完整album。
  if (!bootCommitted || closing || failed || !request.album || !domain.readLocalAlbum
    || request.expectedDatasetId !== boundDatasetId || domain.datasetId !== boundDatasetId) {
    // 用固定、类型化未就绪失败；不能执行后续通用dispatch。
    reject(request, /* 原NOT_READY失败 */)
    return
  }
  const pending = domain.readLocalAlbum(request.album)
  dispatches.add(pending)
  try { reply(request, await pending) }
  catch (error) { /* 用下述专辑错误闭集封送 */ }
  finally { dispatches.delete(pending) }
  return
}
```

上段的失败注释是待实施点，不是空成功或可直接粘贴编译的实现。专辑业务错误包含 SNAPSHOT_CHANGED/CONTENT_LIMIT_EXCEEDED，原PublicErrorCode没有这两项。V3.9应给**仅localAlbumRead的私有失败**增加闭集 `{code,message}`，Client明确识别后Main使用 `localAlbumMainFailure`；普通Owner response/failure格式保持原义。错误来自真实 `LocalAlbumReadError` 或明确未就绪事实，固定中文表重建，未知异常只返回UNAVAILABLE。不能解析任意异常message、借INTERNAL_ERROR丢失预算信息、把源路径或底层栈带给Renderer。

`dataset-domain.ts` 在创建现有 localRelocation/localArtwork 后，唯一组合：

```ts
const localAlbumRuntime = createLocalAlbumOwnerRuntime({
  repository: collection,
  ...(options.projection ? { projection: options.projection } : {}),
  assertCurrent: () => {
    assertOpen()
    if (!scanBootReady) throw new CollectionError('INVENTORY_UNAVAILABLE', '本地专辑Owner尚未就绪。')
  },
  readRootViews: () => localRelocation.roots(),
  // nameEnhancements只接真实AI结果作者；纯registry snapshot不能作为修订。
})
```

domain新增 `localAlbums: localAlbumRuntime.localAlbums` 和类型化 `readLocalAlbum`，使用已实现 `dispatchLocalAlbumRead(domain, request)` 并加入现有 pendingDispatches。关闭时先调用 runtime.close 物理取消/等待FD与准入释放，再等在途dispatch，最后原collection连接关闭；若收尾未核实按原failures保留连接，不能finally无条件释放DB。

## 2. utility包裹与 Main 的真实回程

`utility-main.ts` 非Fake分支现有datasetOwnerEndpoint包裹对象逐方法转发。即使Node source有新方法，包裹对象也会丢掉它。必须从 **source** 明确转发：

```ts
...(source.readLocalAlbum ? {
  readLocalAlbum: (request: LocalAlbumOwnerReadRequest, datasetId: string) =>
    source.readLocalAlbum!(request, datasetId),
} : {}),
```

Node保持默认；不能为展示专辑启用可选Rust或构造第二作者。旧读取/写入/移动端/播放转发全部保留。

`attachCoreRuntimePort` 在原通用IPC validator前新增 `local-album-main-request` 独立分支，先 `isLocalAlbumMainRequest`，再核beforeReady已commitBoot、当前endpoint身份等于call.datasetId、关闭状态和在途上限。只调用 `endpoint.readLocalAlbum(call.request, call.datasetId)`；结果先 `isLocalAlbumOwnerReadResult`，返回 `LocalAlbumMainResponse`并绑定原id/DS/command。保存 flights，关闭封入口后等待自然收口，不把允许的DTO传到任意原command。MainSupervisor独立Map保存原call和child代际；接收只用 `isLocalAlbumMainResponse(response, original)`，未知、迟到或其它child消息不能完成当前promise。停止/exit让待决读取拒绝，不能换数据库重试。

实际 `normalizeLocalAlbumArtwork` 尚有一段utility→Main空缺。现有 `project` 只处理scanRead三方法，其余转给Roon projection gateway；该gateway没有图片规范化能力。不能把Electron nativeImage假设成Owner/utility可用，也不能把“未接通”返回null冒充缺图。

V3.9须实现一个仅可信child可发送的 **私有规范化**消息，不注册Renderer IPC：闭集带id/当前Owner epoch/DS/copies，使用现有 `isDatasetProjectionPayload('normalizeLocalAlbumArtwork', ...)`。Main保存启动代际与实际当前DS，处理前后核对，字节按已实现normalizer限4项、每项4MiB、合计8MiB；Main真实调用：

```ts
const normalizeAlbumCopies = createLocalAlbumArtworkNormalizer(
  bytes => nativeImage.createFromBuffer(Buffer.from(bytes)),
)
// 在可信child/owner/DS均核对后：
const result = await normalizeAlbumCopies(call.copies)
// 再核同一代际/DS，并用isDatasetProjectionResult规范化闭集后回复原id。
```

utility的project在Roon gateway前处理该明确命令并等待Main物理收尾。Main失败/关闭/超时或有图但解码失败必须拒绝，不返回ready+null。选中已保存图片走原DB副本；没有成功Probe不能标missing。此读取零stage/apply/createEdition；透明色展示/TIFF/WebP转换沿新normalizer，真实Electron解码仍必须单独验。

`main/index.ts` 实际注册 `registerLocalAlbumIpc`，ipcMain.handle适配原registerPerformanceHandler、assertTrusted适配requireTrustedRenderer。本线 `album-ipc.ts` 现已将assertDataset改为 `void | Promise<void>` 并在读取前/回复前真正await；等待后再次核可信页面。异步闭包须实读原commandOutbox.context并核当前DS和Supervisor启动代际，不能信Renderer传来的DS，也不能把async函数塞进旧void端口却漏await。若V3.9选择Main身份快照，必须由原Owner/真实context签发且切库/child代际同步失效，不用Renderer值更新缓存。`read`只调用拟新增 `supervisor.requestLocalAlbum(request, datasetId)`。workbench注册沿service/IPC原实现，所需writer、native chooser、配置/Vault分别按另两份提案装配。

## 3. preload固定方法和正式页面

`preload/api.ts` 将LocalAlbumLibraryPublicApi、LocalWorkbenchPublicApi加入MusicBridgePublicApi；原PUBLIC_API_KEYS方法清单显式追加3个专辑方法及local-workbench-client.ts返回的17个具名方法（15命令方法加requestLocalWorkbenchRead/cancelLocalWorkbenchRead），不能删旧方法。createPreloadApi的新增最后参数接实际clients，无能力时保持明确 unavailable，不返回假成功。`preload/index.ts` 用现有invokeScoped/getDatasetId创建两clients并传给factory，AbortSignal仅由工作台read nonce/cancel通道承担，不穿contextBridge。原preload.test.ts对keys顺序有明确断言，集成时同步追加新keys且原keys顺序保留。

`App.vue` 在现有useLocalLibrary旁组合：

```ts
const localAlbums = useLocalAlbumBrowser({ api: {
  queryAlbums: request => api.queryLocalAlbums(request),
  queryAlbumTracks: request => api.getLocalAlbumTracks(request),
  getArtwork: request => api.getLocalAlbumArtwork(request),
} })
// capabilities由api.localWorkbenchCapabilities()实读并严格核对后取得；
// 原入口委派由LocalLibraryView真实业务函数注入。
const localWorkbench = useLocalLibraryWorkbench({ ports:
  createLocalWorkbenchRendererPorts({ api, capabilities, openExistingAction }),
})
```

以上capabilities和openExistingAction须真实提供，不得注入Fake或虚构available。能力读取失败保留不可用和重试，不在Vue setup使用顶层await导致整个正式App未挂载。进入本地页激活localAlbums、离页deactivate、卸载dispose。旧localLibrary保留roots/播放target/原详情与所有维护业务；V3.9给旧session增加仅上下文激活的模式，避免默认专辑墙仍并行加载旧平面全库分页。返回outbox/写入成功后刷新真实上下文和专辑当前页/详情，切库则释放三sessions及旧captures，不能原intent重新绑定新DS。

`LocalLibraryView.vue` 新增albumSession/workbench props，默认主体改为 `LocalAlbumBrowser`；旧单曲详细信息用明确open-track入口保留，SourceWrites/搬迁/Organizer/历史/目录设置对话框和状态入口继续挂载。不要在封面墙上继续同时展示整条旧平面TrackTable。Browser不接session/model，明确传 `:state="props.albumSession.snapshot.value"`、`:roots="model.roots"`、`:playback-pending="model.actionBusy"`，readAvailable和managementAvailable取实际工作库就绪/真实capabilities，不能常量true掩盖未装配。

| LocalAlbumBrowser事件 | 实际应绑定 |
| --- | --- |
| search({query,rootId,filter}) | model新增一次性setScope，校验三条件后只resetScope/readGallery一次；不能顺次调用setRoot/setFilter/search制造3套全库查询 |
| select(album,scrollTop) / back | openAlbum(album,{scrollTop}) / closeAlbum() |
| retry / load-more | refresh() / loadMore() |
| retry-detail / load-more-tracks | refreshAlbum() / loadMoreTracks() |
| ensure-artwork / retry-artwork | ensureArtwork(album) / retryArtwork(album) |
| update:scrollTop | setScrollTop(value) |
| play / queue / play-next | 调旧session.playTrack(trackId,'PLAY_NOW'/'APPEND_MB_QUEUE'/'PLAY_NEXT_MB_QUEUE')；只把真实接受回执接入原播放状态 |
| open-track | 原session.selectTrack(trackId)，显示原详情；关闭返回该专辑且保留滚动/焦点 |
| workbench / workbench-batch | 按下述显式映射取得Controller.open所需ref；Main/Owner实际inspect完整组，不用页面100/200首充当完整专辑 |

批量事件有 `{albumKey,rootId,revision,kind,title,artists,editionId,representativeTrackId}`；单项只有 `{action,albumId?,editionId?,trackId?}`，不能直接传给严格Controller。单项albumId先在当前真实summary（选中详情或已读墙）查找；批量先逐项核当前summary的id/root/revision，过期先刷新，不拿事件显示文本造身份。随后只投影公共ref：

```ts
const refs: LocalWorkbenchAlbumRef[] = summaries.map(summary => ({
  albumId: summary.id,
  title: summary.title,
  artist: summary.artists.join('、'),
  rootId: summary.rootId,
  ...(summary.editionId ? { editionId: summary.editionId } : {}),
  trackIds: [], // 完整成员由Owner inspect取得；不把代表曲目冒充全部。
}))
await localWorkbench.open({ action: event.action, albums: refs })
```

`revision/albumKey/artists/representativeTrackId`不混入strict公共ref。真实revision由新Owner完整读取签发capture，后续preview/apply再核。无albumId的页头入口可打开空选择提示及真实目录/设置入口，Controller不会读取或构造专辑；用户明确选择后才读完整组，不能自动取第一页/第一张或把当前页叫全库。

页面按原正式开放式封面墙和连续背景布局，新组件已复用原CSS语义与Bootstrap Icons。playableTrackIds不能覆盖原Info/多选入口；离线、未分CUE/无真实track、繁忙状态只有播放/队列入口按真实事实限制。详情显示实际元数据/文件报告，不能把文件参数叫实际音频。

`LocalLibraryWorkbench` props为model，close先Controller.close，仅取消准备读取，已派发原command保留。原 `openExisting` 在Main委派到真实旧业务并以明确ack返回，AI/扫描/目录设置进原设置页面；没有真实入口的歌词保持明确未接入，不能写保存成功或伪造旧CoverDrop已具备该能力。

## 4. 具体集成后的验证门禁

1. 真实Owner Worker→utility→Main→preload三命令往返；错DS/epoch/命令/分页与关闭后的迟到回包拒绝，原数据库只有一个作者，关闭等待FD/准入/规范化实际结算。
2. 原同一目录重复加入保持唯一root与真实多专辑；全量counts、稳定跨页、未知封面/成功缺图/离线恢复、raw/人工更正/关系与来源修订均按真实事实显示。30万合法域与31万原冷开拒绝另留实际容量结果，查询延迟/内存不得用小样通过代替。
3. 正式App默认封面墙，打开真实专辑显示真实曲目/图；键盘、多选、详情回退与原页面一致；目录/设置/队列/历史/维护每个旧入口可到达。
4. 正式Electron nativeImage覆盖PNG/JPEG/TIFF/WebP真实owned样本、透明色与解码失败。网络provider与AI端点/物理取消/Vault另验，合成transport不叫真实模型质量。
5. 共享journal原cold guard、完整专辑原子writer及真实CUE Actor按各自提案验证；纯preview/原命令落账不使自己的capture过期；失败无半组，未知提交只查原回执。
6. MBF-001由V3.9独立完成真实文件→Roon/选定目标→实际声音、进度、队列与切歌验证，再与MBF-002/003正式App共同封口；截图文件报告、组件测试与DB查询均不能替代音频证据。

本线没有执行上述正式装配、Main原生操作、真实Provider/模型、正式App、Roon/声音或Owner验收。最后只在三个问题工程验证与正式应用验证均有新鲜证据后通知Owner试用。
