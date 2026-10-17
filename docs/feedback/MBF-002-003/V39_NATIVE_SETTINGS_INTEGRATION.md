# MBF-002/003 → MusicBridge V3.9：原生资源与设置装配提案

本文件是共享源码的只读审查与最小改动提案，**没有应用下列共享差异**。本线主代理交付隔离模块及提案，调度 Root 审核边界；MusicBridge V3.9 在 MBF-004 封板后串行实施旧入口、唯一 Owner、持久 journal、保险库、扫描及 CUE Actor 装配。required 接口是实际装配要求，不代表对应产品能力已经可用。

- 当前工作树：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mbf-002-003-7tvk_82n/workspace`。
- 当前分支：`codex/mbf-002-003-local-library`；基线/HEAD：`479e746bb7106a4dac158fe616290220de03a53a`。下列 MB 引用针对本线当前未提交源码，不能仅凭 HEAD 复现所有新模块。
- CoverDrop 固定来源：`/Volumes/LifeWeave/Swift/CoverDrop`，commit `93fa28f3245da50cf9b5341e0df1466fa4f6a0e7`。原功能检查只用 `git show <固定 SHA>:<文件>`，没有读取其脏树源码。
- 本轮没有启动真实 App、访问真实 Provider/云端、枚举媒体、启动 Scanner、选择/授予真实目录许可、读取凭据或修改数据库。文中的路径都是源码路径；没有用户媒体路径、原图 URL 或密钥值。

相关完整边界仍以 `WORKBENCH_SHARED_PORTS.md`、`WORKBENCH_IMPLEMENTATION.md`、`COVERDROP_FEATURE_MAP.md/.json` 为准。本文补原生资源与设置的具体缺口，不覆盖那三份文档或另立共享实现权限。

## 1. 固定 CoverDrop 的真实入口

以下文件路径都相对于上述 CoverDrop 固定源。行号用于定位固定提交，不能用当前工作树同名文件代替。

| 原文件 / 定位 | 原调用与行为 | MB 装配需要保留的语义 |
| --- | --- | --- |
| `CoverDrop/App/AppModel.swift:244`；`Features/LibraryHome/LibraryHomeView.swift:363` | `selectLibrary(id: LibraryRecord.ID?)`；侧栏普通点击、Shift 范围、Cmd 切换、多库记录菜单 | 选库与选择记录保持独立；批次只来自明确的记录/专辑集合。 |
| `CoverDrop/App/AppModel.swift:344` | `removeLibraries(ids: Set<LibraryRecord.ID>) async`；拒绝正在扫描的记录，调用 `libraryStore.remove(id:)`、清本库界面状态、重新加载记录 | 移除的是库记录，不删除音乐、不撤销共享源授权、不抹历史。 |
| `CoverDrop/App/AppModel.swift:368`；`Infrastructure/Persistence/UserDefaultsLibraryStore.swift` | `renameLibrary(id:displayName:) async`；非空显示名写回记录；`save(_:)`、`remove(id:)` 只持久记录 | 显示名属于库记录，不等于文件夹改名。 |
| `CoverDrop/Domain/Models/AppSettings.swift`；`App/AppModel.swift:262` | `Scan.minimumConcurrentAlbums = 1`、默认 12、最大 24；`updateScanMaxConcurrentAlbums(_:)` 保存钳位整数 | 设置要真正影响后续扫描任务；不能只改工作台显示数字。 |
| `CoverDrop/Infrastructure/FileSystem/FileSystemLibraryScanner.swift:33,134` | `scan(libraryURL:role:progress:)` 在开始时取并发值；`scanAlbumsConcurrently` 用有界任务组处理专辑，专辑内文件顺序处理 | 1–24 是专辑调度并发，与 Reader 工作线程数不同。 |
| `CoverDrop/Domain/Protocols/ScanSnapshotStoring.swift`；`Infrastructure/Persistence/SQLiteScanSnapshotStore.swift:58` | `latestSnapshot(for:) async throws`、`loadSnapshot(at:expectedLibrary:)`；另有带异步 progress 的重载 | 最新快照是真实持久身份，加载校验库 ID、根、角色与 schema，并显示 locating/reading/converting。 |
| `CoverDrop/App/AppModel.swift:739` | `loadLatestScanSnapshotForSelectedLibrary() async`；加载后还原名称建议/状态、启动变化监听、展示封面墙 | 不能用“重扫”或当前 catalog 查询冒充原最新快照加载。 |
| `CoverDrop/Infrastructure/FileSystem/FSEventsLibraryChangeMonitor.swift:12`；`App/AppModel.swift:2051,2120,2211` | `events(for:) -> AsyncThrowingStream`，FileEvents/NoDefer、0.25 秒 latency；合并变化范围后只重读命中专辑 | 必须是源变化监听与局部刷新；UI 轮询任务状态不能代替它。无命中/无法局刷时原版也不自动全量重扫。 |
| `CoverDrop/App/AppModel.swift:2391` | `markInternalCoverWrite(forAlbumFolder:libraryID:)` 给内部写路径设短时忽略窗口 | MB 应使用真实回执/源修订标记去重；不能将原绝对路径或宽泛忽略规则放入 Renderer。 |
| `CoverDrop/Domain/Models/AppSettings.swift`；`Features/Settings/AppSettingsView.swift:315,568,582` | 后端 `local/vllm/cloud`，持久 URL/model；`saveSettings()` 与 `saveAPIKey()` 分开 | Ollama/vLLM/cloud 和私有端点、模型、云密钥保存/清除都须保留。 |
| `CoverDrop/App/AppEnvironment.swift:69` | UserDefaults 配置、Keychain APIKey store、三个 provider、SQLite snapshot、FSEvents、FFmpeg splitter 真正组成环境 | MB 需要真实配置/保险库/原生组件，不能把三个下拉值当作已集成。 |
| `CoverDrop/App/AppModel.swift:1581`；`Infrastructure/Audio/FFmpegCueTrackSplitter.swift:18,38,57,92,169` | `splitCueSheetInPlace(albumID:cueSheetID:)`；`splitCueSheet(_:outputDirectory:progress:)`；实际探测、CD75→PCM、标签写入、重名避让和 `CFDropSplitRange` | 保留实际分轨、原格式族及 pregap 规则；MB 冻结范围改为明确的独立输出，不能照搬原专辑目录就地写。 |

## 2. Main 原生选择器与真正只读文件

### 2.1 原代码可复用的位置

`apps/desktop/src/main/index.ts` 的 `registerIpcHandlers(supervisor: CoreSupervisor, credentialVault: CredentialVault): void` 内已有 `pickLocalLibrary(options: CommandOutboxPickOptions)`：串行 `sourcePickerBusy`、检查主窗口/退出状态，调用 `dialog.showOpenDialog(mainWindow, options)` 并在 `finally` 释放 busy。现有 `installLocalArtworkHandlers` 使用该 picker 和 `nativeImage.createFromBuffer(bytes)`，但旧 picker 过滤器仅有 PNG/JPEG。

`apps/desktop/src/main/local-artwork-image.ts:259` 已有：

```ts
readLocalArtworkFile(absolutePath: string): Promise<Uint8Array>
```

它先核普通文件/非符号链接/4 MiB 大小，再 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开，核真实 FD 身份、有界读取、读后身份和当前名字，最后 `await handle.close()`。该 helper 不接收 AbortSignal；取消时仍须等待它实际完成/关闭，不得用 `Promise.race` 把取消返回当作 FD 已关闭。它不是目录授权，也不能读 Renderer 任意提交的路径。

本线新 `apps/desktop/src/main/local-library-workbench/service.ts` 已要求以下**精确**许可接口：

```ts
interface LocalWorkbenchApprovedArtworkFile {
  label: string
  read(context: { signal: AbortSignal }): Promise<Uint8Array>
  close(): Promise<void>
}
interface LocalWorkbenchApprovedCueTarget {
  target: LocalCueOutputTarget // { choiceId, label, independent: true }
  revision: string
  assertCurrent(context: { signal: AbortSignal }): Promise<void>
  withDirectory<T>(operation: (authorizedPath: string) => Promise<T>,
    context: { signal: AbortSignal }): Promise<T>
  close(): Promise<void>
}
interface LocalWorkbenchNativeChooser {
  chooseArtwork(context: LocalWorkbenchMainContext): Promise<LocalWorkbenchApprovedArtworkFile | null>
  chooseCueTarget(context: LocalWorkbenchMainContext): Promise<LocalWorkbenchApprovedCueTarget | null>
  closeReadResources(): Promise<void>
}
```

### 2.2 最小差异提案（尚未应用）

1. V3.9 新增 Main `local-library-workbench/native-chooser.ts`，实现上述接口；复用原串行 picker，登记每个已受理选择/读取 Promise，并在关闭时等真实调用收口。选择取消返回 null，迟到许可立即关闭，错误只返回固定公开文案。
2. 新工作台图像 picker 的过滤器如下；旧图像服务不因此自动获得 TIFF/WebP 原输入合同：

```ts
filters: [{ name: 'PNG / JPEG / TIFF / WebP',
  extensions: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp'] }]
```

3. 只有 Main picker 返回的单一路径可进入 `readLocalArtworkFile`。新许可封装将该路径保留私有、禁止重复读/关闭后读，读前读后检查 signal，`close()` 等实际在途 read 收口。普通 Renderer 只得到安全候选；不能得到路径或此许可对象。
4. `normalizeImportedLocalArtwork(bytes, decode)` 已有合成边界测试：TIFF/WebP 在 native 解码前核单帧、尺寸/像素/结构预算，转换 JPEG 后再走旧严格规范化。`LocalArtworkImage.original` 是兼容 PNG/JPEG 副本，TIFF/WebP 的原输入 mime/hash 只在私有 capture.input 保存。Electron 是否真的能解该图仍待真实 Gate，失败要如实显示，保留入口。
5. 目标 picker 复用 `properties: ['openDirectory']`，但不能直接把 `filePaths[0]` 包成 `independent: true`。新目标许可要记录真实目录 dev/ino、无符号链接祖先、父目录身份、能力/容量观察和修订；与完整源根/文件/输出位置核独立性，避免目标位于源树、源文件/硬链接别名或既有产物。目录替换、撤销、卸载后 `assertCurrent/withDirectory` 必须失败。
6. 目标许可及实际路径仅在 Main/受保护 Actor；公开 `choiceId` 是寻址标识，不授文件系统权利。service 已受理 apply 仍持有许可，读面板关闭不能提前释放。重启不可仅凭持久 choiceId 恢复写权限：只读对账保留，确需新文件动作须重新获得真实许可及新明确计划。

`collection-photos.ts` 的 25 MiB 图片入口不能代替封面 4 MiB 合同；`recordingSources.chooseRoot` 也不能顺带把输出目录加入音乐库或给 CUE 源写权限。

## 3. CUE：Owner 捕获 → 原生资格 → 独立输出 Actor

### 3.1 当前存在的函数与尚缺的执行者

| 当前源码 | 精确签名 / 事实 | 仍需 V3.9 实现 |
| --- | --- | --- |
| `packages/bridge-core/src/collection/local-library-workbench/read-service.ts:394` | `resolveCueFacts(request: LocalWorkbenchArtworkRequest & { cueId: string }, context?: LocalWorkbenchReadContext)` → Promise `{capture, cueId, cueRevision, parsed}` | 经真正 Owner Worker RPC 调用；不能 Main 自造 capture。 |
| `packages/bridge-core/src/library/cue-text-reader.ts` 与上项 | FILE 只绑定原资产；六字段 `assetId/libraryRootId/sourceRootId/rootRevision/fileRevision/locationRevision`；原 CD75 声明、`NOT_VERIFIED`、`endFrames: null` | 实际只读 FD、PCM 帧探测、稳定源 readRevision。文本解析不是音频资格。 |
| `packages/bridge-core/src/collection/local-library-workbench/cue-plan.ts` | `buildLocalCuePlan(input: LocalCueDraftInput)` → `{draft, outputs}`；`localCueCdFramesToPcm(cdFrames, sampleRate)` | 纯函数不打开文件、不编码、不生成产物。 |
| `apps/desktop/src/main/local-library-workbench/service.ts` | `owner.prepareCuePreview(request: LocalCueSplitInput, target: LocalWorkbenchApprovedCueTarget, context: ReadContext)` → Promise `{draft: cue, capture: LocalWorkbenchPlanCapture}` | required 真实探测/格式/目标端口还须装配；不能返回手写 probe 或预设 available。 |
| `packages/bridge-core/src/collection/local-library-workbench/types.ts:159` | `LocalWorkbenchProtectedWriter.revalidate/apply/readOriginalReceipt/cancel?`；apply 收原 request、plan、capture | 真完整专辑 MB_ONLY writer 和 CUE 独立产物 Actor、逐轨 journal/receipt/取消仍须落实。 |
| `packages/bridge-core/src/collection/local-library-workbench/plan-registry.ts` | `issuePlan/apply/readOriginalReceipt/cancel/operations`；原 command 先 durable CAS，unknown 只查原回执 | helper 接入原 Owner ledger 与 Worker 路由；内存测试 persistence 不代表正式持久装配。 |

建议 V3.9 新增独立 `local-cue-output-actor`/私有固定协议，而不是扩大普通 `localWorkbench`、`localScan` 或已有 012 源写命令的权限。新协议的文件和方法名由 V3.9 定稿，下面的顺序不声称该 Actor 当前已存在。

### 3.2 `prepareCuePreview` 最小调用顺序

1. 用请求 captures 中精确 albumId/readToken，逐项调用真实 Owner `resolveCapture` 与 `resolveCueFacts`，核 cueSelections 一一对应、同 dataset/水位、完整源修订、online。CUE FILE 字符串不成为路径输入。
2. 通过真正源 Author/只读端口取得被绑定资产的 FD；Actor 必须用同 FD 实测 sampleRate、totalPcmFrames，返回 `LocalCueAudioProbe`，其 evidence 只能是实际 `audio-pcm-read`。
3. 从正式 native 资格登记读与 `outputFormat` 精确相同的 `LocalCueFormatQualification`，evidence 固定 `encoder-tag-audio-roundtrip`。标签与回读必须测过；格式未可用时保留禁用项及原因。
4. `await target.assertCurrent(context)`，在私有 `withDirectory` 范围核独立目标、现存名字、不覆盖/容量与 namespace。该回调不生成最终音频，也不授源写权限。
5. 调用已有纯 `buildLocalCuePlan`；在同一捕获集合冻结 `albums/cueSheets/cueOutputs/audio/target + revision/format` 到 PlanCapture。重读原 Owner 水位；任何变更拒绝，不签替代捕获。
6. 交已有 registry `issuePlan`，由它产生原 planId/hash/context/expiry；Main 不自造可执行计划。预览没有创建曲目音频或 MB 发行关系。

最小冻结结构如下，`selections`、`qualifiedFormat`、`datasetRevision` 都必须来自以上真实端口；这段是装配提案，不是可独立运行的 stub：

```ts
const prepared = buildLocalCuePlan({
  selections, target: target.target, format: qualifiedFormat,
  pregapPolicy: 'append-to-previous',
})
const capture: LocalWorkbenchPlanCapture = {
  datasetId: request.datasetId, datasetRevision,
  albums: selections.map(item => item.album),
  cueSheets: selections.map(item => ({
    cueId: item.cueId, revision: item.cueRevision, albumId: item.album.albumId,
  })),
  cueOutputs: prepared.outputs,
  audio: selections.flatMap(item => [...item.audio]),
  target: { ...target.target, revision: target.revision },
  format: qualifiedFormat,
}
return { draft: prepared.draft, capture }
```

原 pregap 规则已在纯函数实现：CD75→PCM 整数截断；首轨明确 INDEX00 时从源帧 0 开始；每个非末轨结束于下一轨 INDEX01，因此前轨包含后轨 pregap；末轨止于实际总帧。不能把 CD75 值直接当 PCM 位置，也不能从时长小数推测总帧。

### 3.3 FD、namespace 与 physical claims 必须同实际生命周期

原可复用低层函数及边界：

- `packages/bridge-core/src/recording/source-files.ts:386`：`withCheckedReadonlyMetadataSource<T>(root, relative, expectedSignature, signal, consume, assertCurrent?, onLeaseEvent?): Promise<T>`。真正 `O_RDONLY/O_NOFOLLOW`、FD/stat/名字/根核对，await consume 后关闭 FD，再释放 guard；关闭失败保留未确认状态。metadata budget/consume 合同不是 CUE 解码器，不能把 PCM 操作硬塞入旧 Reader。
- 同文件 `withReadonlySourcePublicationClaims(sources, signal, consume)`：多源 FD/namespace/physical read claims 与 verify/commit 范围，可给新 Actor 定义源校验证据；具体使用需匹配其持有/释放合同。`openLocalPlaybackReadonlySource` 是播放用途、允许原授权硬链接且不做全内容 hash，不能代替 CUE 全源证书。
- `stream/source-namespace-claims.ts`：`captureSourceNamespace(root, relative)`、`acquireSourceNamespaceRead(names, coordinator?)`、`acquireSourceNamespaceWrite(scope, coordinator?)`；复用同一实际 coordinator。
- `stream/physical-resource-claims.ts`：`acquirePhysicalReadClaims`、`acquirePhysicalWriteClaims`、FD descriptors 注册/关闭。源 CUE/音频只取 read；输出名字取 write；实际 FD dev/ino 来自 fstat，不来自 DTO。
- namespace write 的 `SourceNamespaceOriginBinding` 需要真实 `datasetId/originPlanId/planHash/contextFingerprint/journalSequence/projectionFingerprint`。仅有 planId 不足以取得写 claims；后两项须原持久 journal/projection 真返回，不能手填。
- `retainSourceNamespaceWrite`、`assertSourceNamespaceHeld`、`delegateSourceNamespaceRecovery`、`releaseSourceNamespaceWrite/resolveSourceNamespaceRecovery` 已有；未确认子进程/FD/发布结果时 retain，不能收到 cancel 消息即 release。
- `shared/source-writes-utility-port.ts` 的 `createUtilitySourceWritesBridge` 及 `collection/source-writes-publisher.ts` 的 `publishSourceWrites` 属已有具体源写许可/发布方案；可审查复用其底层有界 IO、同步和无覆盖策略，不可用该 grant 启动 CUE 独立输出。

Actor 执行顺序必须是：原 command durable → 核 capture/计划/目标/资格 → 获取真实读取和输出 claims → 只给子进程固定继承 FD → 私有临时文件 → 每轨真实标签、帧/音频和内容 hash 回读 → 无覆盖发布 → durable 逐轨 receipt/manifest → 确认进程退出且 FD 实际关闭 → 释放相应 claims。源音频/CUE/封面及原关系全部 retain；成功后导入新产物是另一次明确动作。

独立输出要使用“创建新名字且已存在即失败”的发布原语，不用会覆盖目标的 rename。预览后出现重名，执行应失败并保持原计划，不静默编号重签；如果将来采用编号避让，选定名字必须先进入新明确冻结计划。写后断电/Actor崩溃/取消可产生 partial/unknown，保留临时/清单与 claims 恢复证据，按原 command/plan/hash 只读对账；不得自动重放 apply、删除未知产物或把 partial 当整专辑成功。

### 3.4 八项格式的实际差异

固定 CoverDrop `encoderName(for:) / fileExtension(for:)` 对应下表。当前 MB `recording/ffmpeg-build-policy.ts` 固定 FFmpeg 8.1.2：`--enable-protocol=fd`，demuxer wav/aiff/flac，**muxer 只有 wav、encoder 只有 pcm_s16le/pcm_s24le/pcm_s32le/pcm_f32le**。这只是源码构建策略，不是已打包二进制的实测资格。

| 原格式族 / 新 codec | 原编码器 / 扩展名 | 当前 MB 策略与 V3.9 必须补的资格 |
| --- | --- | --- |
| FLAC / `flac` | flac / .flac | 有解码器，未启用该编码器/muxer；须真实编码、标签、回读。 |
| ALAC / `alac` | alac / .m4a | 未启用该编码器/容器；须新增受审构建及实际 roundtrip。 |
| MP3 / `mp3` | libmp3lame / .mp3 | 未启用；须依赖/许可证/打包与有损输出资格。 |
| Vorbis / `vorbis` | libvorbis / .ogg | 未启用；须实际 Ogg、标签与音频资格。 |
| Opus / `opus` | libopus / .opus | 未启用；须采样率/编码延迟、标签与回读资格。 |
| WavPack / `wavpack` | wavpack / .wv | 未启用；须编码/标签/回读资格。 |
| PCM WAV / `pcm-wav` | 小端 PCM / .wav | 当前启用部分 PCM encoder/WAV muxer；新 CUE Actor、标签及帧 roundtrip 仍未验证，不能仅凭 flags 可用。 |
| PCM AIFF / `pcm-aiff` | 大端 PCM / .aiff | 当前未启用 AIFF muxer/大端 encoder；须真实构建与 roundtrip。 |

原未知 codec 回退 FLAC 是原实际行为，不表示任意未知源能被解码。V3.9 必须保留明确的“FLAC 回退”资格/原因，先核真实源 decoder 与 FLAC 输出资格，再生成写明转换的计划。不能自动使用系统 ffmpeg、下载未经固定审查的二进制或放宽 network/path 协议。

## 4. 库显示名、移除和多库：记录语义先补齐

### 4.1 当前公开 API 确实存在什么

`apps/desktop/src/preload/local-library-client.ts` 的 `createLocalLibraryClient(invoke, scope, write)` 当前提供：

```ts
listLocalLibraryRoots() // localRelocation.roots, {}
chooseLocalLibraryRoot(commandId)
relinkLocalLibraryRoot({ commandId, rootId, expectedRevision,
  targetSourceRootId, userConfirmed: true })
localLibraryScan('localScan.start', { commandId, libraryRootId,
  expectedRootRevision })
localLibraryScan('localScan.pause' | 'localScan.resume' | 'localScan.cancel',
  { commandId, jobId, expectedRevision })
localLibraryScan('localScan.get', { jobId })
localLibraryScan('localScan.page', { offset, limit }) // limit ≤ 200
localLibraryScan('localScan.receipt', { commandId })
```

这些是真调用名/参数。尚无库记录显示名、记录移除、扫描并发保存、历史快照加载和变化监听 API。

当前 `packages/contracts/src/local-catalog.ts`：`LibraryRoot = { id, sourceRootId, role, revision }`，没有 displayName；`LOCAL_CATALOG_OPERATIONS` 没有 rename-root/remove-root。`local-relocation-coordinator.ts` 的 `roots()` 从真实 SourceStore capability.label 得到 `LocalRootView.label`。`recording/source-store.ts` 的 `revoke({commandId,id})` 会改变共享授权，不能代替移除库记录；源可能还被录音、冻结引用或别的逻辑库使用。

### 4.2 最小差异提案（新调用名仅为待审提案）

| 待审新增项 | 必须的实际 Owner 行为 | 不能用作替代的旧命令 |
| --- | --- | --- |
| 库记录显示名命令：`localLibraryRecords.rename`，入参 `{commandId, libraryRootId, expectedRevision, displayName}` | trim、非空/有界/无路径凭据文本、CAS 与 durable receipt；label 是该 libraryRootId 的记录覆盖层，原 root/capability/音频路径不变；冷核支持新 operation。 | relink、文件搬迁、修改共享 SourceRoot.label。 |
| 库记录移除命令：`localLibraryRecords.remove`，入参 `{commandId, selections:[{libraryRootId, expectedRevision}]}` | 明确所选记录；拒绝活动 scan/尚未收口任务；追加记录隐藏/移除事实并回执，保留 catalog资产/历史/原引用；真正 root revision/移除字段及 ledger operation 需 V3.9 定稿。 | `recordingSources.revoke`、源目录删除、清空 catalog、强制取消未知写。 |
| 根列表读取增加真实记录 label/状态 | 从 Owner 的记录事实投影，在 `LocalRootView`/相应新读合同与 guard 同步升级；旧 `LibraryRoot` strict guard 不能静默多塞字段。 | Renderer 本地别名 Map 当持久成功。 |
| 多库选择与恢复 | 复用既有设置内根列表和本地浏览器入口；普通单选、Shift/Cmd/Ctrl 选择；每库保留搜索/过滤/滚动和根身份，不新增永久侧栏。 | 同名合库、在“全部”视图隐式选中全部批量写。 |

上述命令尚不存在，不得直接发给当前 `localLibrary:request` ordinary 闭集。V3.9 必须同时补合同/validator、command outbox 或同级持久原命令入口、唯一 Owner 冷核/事务/回执、固定 Worker 路由、Main/Preload 和真实 UI；不能只增一个 UI button 或 prefix forwarding。记录移除是否保留可恢复 tombstone、与原历史模型的确切兼容策略，需要 V3.9 设计并接受后实施，不在本线擅自删记录。

现有浏览查询的单 root 与“全部根”读不等于任意 rootIds 多选查询。如果增加多库聚合，需闭集 rootIds/分页/watermark 合同，或显式有界逐根读后合并；保持 albumKey/rootId/revision 真实身份，不按名称合并。专辑批量入口使用本线现有 `workbench-batch` 真引用；零曲目/CUE 专辑也可选择，具体能力由 Owner 证据判断。

## 5. 扫描 1–24、最近快照与 FSEvents 局刷

### 5.1 并发必须是新实际调度能力

当前 `packages/bridge-core/src/collection/local-scan-coordinator.ts:99` 默认 `createMetadataReader({concurrency:1,maxPending:1,...})`，`execute(jobId, signal)` 中逐 relative await item/cueItem；`library/metadata-reader-types.ts` 的 Reader 并发仅允许 `1 | 2`，另有 32 MiB 读取、64 MiB 分配及 3 秒固定预算。它不是 CoverDrop 的 1–24 专辑任务组。

最小提案：V3.9 新增持久扫描设置及专辑边界调度，在**新任务开始**冻结 `maxConcurrentAlbums` 与 settingsRevision；默认 12、范围 1–24。任务 resume 延用原值，设置变化只影响以后创建的任务。保留 Reader 实际资格/池规模和既有 admission、媒体忙退让、撤销监听、FD join、短事务/CAS；不能把 `concurrency:24` 塞进旧 Reader 或提高固定资源预算。

新专辑调度需要真实有界待处理队列、确定性 checkpoint/提交排序、逐根/root revision 核对、pause/cancel 收口和并发恢复测试。parser v4、metadata worker 与扫描作者继续属于 V3.9；本线不改其实现。公开 `localScan.start` 目前严格三字段，不能追加 `concurrency`/目录路径后声称已启用。并发应由 Owner 保存的设置在受理新 job 时捕获，或由正式升级的新闭集合同承载。

`LocalWorkbenchReadback.settings` 已允许 `{scanConcurrency: 1..24, aiBackend, aiModelLabel}`，仅是显示投影。无真实保存/调度时应省略或显示不可用原因，禁止硬填 12 宣称设置生效。

### 5.2 最近快照不能由当前查询拼成

当前 `localScan.page/get` 只返回真实任务记录，catalog/目录事实是当前持久视图；原 `ScanJobRecord` 没有原 CoverDrop 的 `ScanSnapshotSummary`/历史完整专辑加载合同。`local-scan-store.ts` 的已有只读事实 accessor 可作为新 read view 的基础，尚不能宣称“加载最近完成快照”已实现。

V3.9 的最小增量应是同 Owner 的最近完成扫描身份、完成水位和有界只读分页：包含 dataset/libraryRootId/rootRevision/jobId、完成时刻/实际状态、cursor/schema版本及真实记录数量；只选择确实完成的任务，partial/failed 不冒充 complete。若既有 append facts 能在冻结水位完整重建，可避免新数据库；若无法还原历史，必须明确新持久 snapshot 所需字段/兼容范围，不能拿本次 current 查询冒充旧快照。

加载只读，核 dataset/root/角色/schema/watermark 后还原浏览与名称建议状态；分 locating/reading/converting 或真实对应阶段，不显示虚假的成功时间。库离线时允许已保存事实浏览，封面/源读取仍显示来源不可用；不触发媒体枚举或重扫。

### 5.3 变化监听与局刷的最小增量

`apps/desktop/src/renderer/src/components/settings/LocalLibrarySettings.vue` 的约 1.5 秒 `reload()` 轮询只是 roots/扫描任务读取；当前没有等同原 FSEvents 的源变化监听组件。

V3.9 应新增 Main/native 或受控 Owner 源监听 adapter，生命周期绑定真正 sourceRoot 许可和 dataset epoch：

1. 使用实际 FSEvents FileEvents 能力，原生 stream stop/invalidate/release 后才报告关闭。事件私有绝对路径先核受授权根，再映射真实 directory/albumKey；Renderer 只收“哪些原身份需要刷新”，不收路径。
2. 有界合并、去抖、每根单局刷任务；根切换/撤销/卸载/关闭时取消并 await 原 listener/读取收口，旧代际事件丢弃。
3. 只重读实际命中的目录/专辑并按原 root/file/location revision 提交。新建、删除、rename、watch丢事件、MustScanSubDirs 等须有明确受控处理；证据不足提示“需要明确扫描”，不能自动扩大到全库。
4. 内部已确认源写按真实原 receipt/revision 定向去重；MB_ONLY artwork 不碰源目录，无需制造源事件。短时忽略不能吞用户同时改动。
5. 首次没有完成事实、路径无法映射或平台不支持时如实显示不可用/需要明确扫描；不能伪造“实时刷新已开启”。

是否使用一个新固定 native helper 或已有 Electron 能力由 V3.9 验证；本提案不把通用 `fs.watch` 当 FSEvents 全语义保证，不新增默认实验依赖。

## 6. Ollama/vLLM/cloud 设置与固定本地保险库

### 6.1 原配置与当前 transport 的精确接点

固定 CoverDrop 默认 local 为 `http://127.0.0.1:11434` / `qwen3.5:4b-mlx`；vLLM 为 `http://127.0.0.1:8000` / 空模型（由 Owner 配置）；cloud 为 `https://api.deepseek.com` / `deepseek-chat`。保留原 backend 可用范围，`local` 在本线公共合同映射为 `ollama`，不能偷偷丢弃 cloud 或把空模型写成假已配置。

现有 `apps/desktop/src/main/local-library-workbench/providers/name-transport.ts` 已提供真实 adapter 与私有注入：

```ts
interface LocalNameConfiguration {
  baseUrl: string; model: string; requiresSecret?: boolean; keepAlive?: string
}
getConfiguration(backend: 'ollama' | 'vllm' | 'cloud'):
  LocalNameConfiguration | null | Promise<LocalNameConfiguration | null>
resolveSecret?(backend, configuration, signal): string | null | Promise<string | null>
suggest({ backend, systemPrompt, userPrompt }, signal): Promise<LocalNamePrivateContent>
stop(): Promise<void>
close(): Promise<void>
```

Ollama 用原 `/api/chat` NDJSON、`think:false`、`keep_alive:'30s'` 与原两键名称 JSON；vLLM/cloud 是 `/v1/chat/completions` SSE。cloud 只允许 HTTPS；端点禁 userinfo/query/hash，凭据只进 Main Authorization header，不跟重定向、不自动重试；停止后 Ollama 实际 unload 请求仍需真实结果。配置/正文/token 不进入普通公开 DTO，模型正文还须 Core parser 验证。

### 6.2 最小持久配置/保险库提案

`apps/desktop/src/main/credential-vault.ts` 已有真正 `CredentialVault({filePath, storage: AsyncSafeStorage})` 和 `save(value)/read()/delete()`；加密先核 safeStorage 可用，私有目录/0600 文件/原子替换。`index.ts:2087` 的 `prepareCoreDataDirectory()` 当前实例写 `netease.credential`，它是网易云 Cookie 保险库。`credential-provisioning.ts` 的 verify/set/clear 属网易 Cookie 流程，不能改成云模型 Key 校验。

V3.9 新增私有名称配置 store 与固定本地输入通道，单独使用 `local-name-cloud.credential`（提案文件名），不覆盖 `netease.credential`，不自动读取、迁移或删除原 CoverDrop Keychain。端点/model 保存在 Main 私有配置；云密钥只经批准的本机交互输入及 vault 流动，不走聊天、argv、Shell 或普通 Renderer 工作台 DTO。

普通 Renderer 保持仅选择 backend/sourceId；设置入口可打开 Main 管理的本机配置窗口/面板。该私有输入通道需要 V3.9 实现并审查：固定窗口身份、closed 请求、仅保存/删除动作、Key 不回显、不读取明文给普通 Preload、没有任意 vault key/filePath 参数；公开只返回配置可用性与安全模型标签。不能将安全通道的 required 接口当成窗口已存在，也不能照搬原 SwiftUI APIKey 的明文加载到 MB Renderer。

真实 assembly 的最小接法示意如下；`nameSettings` 是**待新增的 Main 私有 store**，并非当前存在的对象。示例不读真实凭据、不含密钥值：

```ts
const nameCloudVault = new CredentialVault({
  filePath: path.join(dataDirectory, 'local-name-cloud.credential'),
  storage: safeStorage,
})
const names = createLocalNameTransport({
  getConfiguration: backend => nameSettings.readPrivate(backend),
  resolveSecret: async (backend, _configuration, signal) => {
    if (backend !== 'cloud') return null // 原 vLLM 无 Key 模式继续支持
    if (signal.aborted) throw new Error('名称请求已取消。')
    const result = await nameCloudVault.read()
    if (signal.aborted) throw new Error('名称请求已取消。')
    return result.status === 'configured' ? result.credential : null
  },
})
```

该接法仍需真实保存/清除/错误状态投影；`missing/invalid/unavailable` 精确区分，safeStorage 不可用不回落明文。后续若支持需 Key 的 vLLM，要另给明确固定私有条目及配置字段，不将 cloud Key 无条件发送 LAN 服务。配置保存只改变以后请求；改变端点/model/凭据 revision 后取消旧请求/准备与候选，不能把旧响应或旧 token 用到新设置。设置来源/当前 dataset 与候选绑定仍按原 service/capture 围栏。

## 7. Worker RPC、私有原图与关闭顺序

实际 Main 与唯一 Owner 之间经 utility/Worker RPC，不能以同进程 Core fixture 代替可装配证据。本线 service 已将同步可读方法兼容为 `T | Promise<T>`：`registry.getPlan/readArtworkCapture/operations`、`read.cancelNamePreparation`。其他 required Owner 方法本来返回 Promise；V3.9 需按固定协议逐项映射，不使用通用 invoke。

- `localWorkbench.read` await 原 `registry.operations()` 后检查 context/signal，严格验证完整列表，再投影本 dataset unknown/running 到 `pendingOperations`；partial 含未知项沿 registry 计算 unknown。≤100 项及总 2 MiB，超预算整包报有限错误，不截取。恢复只查原 request/command/plan/hash，不重签或重发 apply。
- `readPrivateArtwork({datasetId, planId, candidateId})` 现在返回 Promise。原应用/冷恢复 await 精确 `readArtworkCapture` 与 `getPlan`，从持久 frozen `originalBase64` 恢复兼容原图，复核原 metadata/hash；无 display fallback、无再次 Provider 下载，不能靠 TTL Map 恢复。
- AI suggest 的 finally await 真 `cancelNamePreparation(preparationId)`，RPC 发出不等于 Owner 已释放准备。
- 关闭开始即拒绝新普通命令/写；`closeReadResources` 只关闭读链并等真实准备/IO 收口，不撤销已受理 write。完整 close 等已有 writes，然后停止新私有图读并 await 在途恢复 RPC，最后关闭 target/name 资源并清字节。实际未收口的 FD/Actor/claims 不能作为“关闭完成”。

V3.9 的 Worker 协议、Owner 实例和 Main 生命周期还需实际连接；本线新增异步行为 fixture 只模拟真实端口延迟，并消费实际 Core registry 值，没有启动 Worker/Electron。

## 8. 最小共享差异切片与验证顺序

以下是精确原接点和新增模块的提案，全部由 V3.9 串行装配；新文件名可在正式实现时定稿，不能把建议路径列入“已写”清单。

| 切片 | 原共享接点 / 建议新实现 | 验证要求 |
| --- | --- | --- |
| Native chooser 与资源关闭 | 原 `apps/desktop/src/main/index.ts` 的 picker/registration/shutdown；建议新 `local-library-workbench/native-chooser.ts` | 合成取消/迟到/目录替换/无覆盖；真实 Electron PNG/JPEG/TIFF/WebP 及选择/卸载关闭 Gate。 |
| Worker 与持久 writer | 原 `dataset-owner-{worker,client,protocol}.ts`、`dataset-services.ts`、`dataset-domain.ts`、Owner journal/cold核；已有 `owner-journal.ts`/registry/read-service | 真 RPC 同 dataset/闭集、CAS原command先落账、未知只查原回执、重启原图大副本与 pending 操作、close不提早释放。 |
| CUE 实际执行 | 新固定私有 CUE Actor/protocol；原 source-files、claims/admission/FD工具；原 `ffmpeg-build-policy.ts` 受审升级 | PCM 真实帧、八格式各自编码/标签/音频/帧 Gate、独立目录、源不变、取消/崩溃/断电 partial/unknown、无覆盖/retain/原回读。 |
| 记录与设置 | 原 Contracts/local catalog ledger/store/coordinator、command-outbox、Main/Preload；原 `LocalLibrarySettings.vue`/`SettingsView.vue` | 显示名不改路径、移除不撤销共享源/不删历史、活动任务拒绝、CAS/冷核、多个根明确选择。 |
| 扫描/快照/变化监听 | 原 `local-scan-{store,coordinator}.ts`/Reader admission；新 settings/snapshot view/FSEvents adapter | 1/12/24实际调度、旧Reader预算与FD退出、resume原设置、真实快照水位、局刷范围、丢事件/离线/撤销、无自动全量扫描。 |
| 名称配置/保险库 | 原 private dataDirectory、`CredentialVault`；新固定本地输入面板与 nameSettings；现有 `name-transport.ts` | 合成 vault/config/RPC测试；真实 safeStorage 保存/清除、不回显/不泄露；真实模型质量与付费请求须单独 Owner 放行和记录。 |
| 原入口与浏览返回 | 原 Main/index、Preload/index、`App.vue`、`LocalLibraryView.vue` 与设置导航 | 默认专辑墙、原工作台全部入口、搜索/过滤/滚动/多选返回；既有播放不变，浅深色/末尾避让，Owner 成品试用。 |

本轮已实际报告的上一快照证据：Core 恢复合同 7/7、Main 11 + UI 21 + IPC 5 = 37/37，退出 0；Core tsc 退出 0。后续 service fixture 的成功成员 union 类型已定点修正；新增 service 第 12 条异步 Owner 端口/原图冷恢复/关闭行为及当前 desktop tsc 由本线主代理统一必要复验，**本文件不预先写通过**，无改动 Provider/Name 29 项不重复计数。

本文新增的是只读审查与提案，未运行产品测试/构建/真实 native Gate。合成行为、类型检查、正式装配、普通运行、真实内容/编码质量、Owner 接受分别记账。原八格式、原云端与多库/局刷能力仍在正式完成范围内；未接入的项目必须显示准确能力原因，不能以提案或 required 端口结项。
