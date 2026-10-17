# MBF-002/003 工作台共享接线与新 AI/CUE 计划边界

对照基线：`479e746bb7106a4dac158fe616290220de03a53a`。公共 DTO 已统一在 `packages/contracts/src/local-library-workbench.ts`，Renderer 的 `types.ts` 重导出 DTO 并保留可注入执行端口。本文第 2 节是初始建议路径清单；实际已写模块与准确 API 见 `WORKBENCH_IMPLEMENTATION.md`，不把尚未采用的建议路径当作存在文件或接入证据。

已复用 Root 提供的 `MBF002003_IMPLEMENTATION_SLICES01.md`（SHA256 `2a827249c9a417507b488873e632d83af369ff47dc6c219260c2b38d3405abfe`）及其 34 路径清单。原方案“无云端”不是本轮范围，本清单保留固定源实际云端配置与保险库通道；不迁移旧 CoverDrop Keychain、不发真实付费请求。完整源范围见 `COVERDROP_FEATURE_MAP.md/.json`。

## 1. 可以直接复用的现有服务

| 流程 | 精确共享路径 | 接线方式及边界 |
| --- | --- | --- |
| 曲目/根/扫描 | `apps/desktop/src/preload/local-library-client.ts`、`apps/desktop/src/main/local-library-ipc.ts`、`packages/bridge-core/src/collection/local-catalog-store.ts`、`local-scan-store.ts` | 读取现有 catalog、根、逐文件失败与扫描记录；不从普通浏览触发重扫。MBF001-C 的 metadata worker/types/reader/scan coordinator parser v4 继续由 V3.9 独占。 |
| 名称和目录纯规则 | `packages/contracts/src/local-name-rules.ts`、`packages/bridge-core/src/library/local-name-rules.ts` | 复用 `cleanArtistName/cleanAlbumName/resolveAlbumNameCandidates/discoverAlbumDirectoryCandidates`；原文、版本和人工锁独立保留。它们不提供 AI 请求。 |
| 图像资格/本地内嵌图/现有远端来源 | `apps/desktop/src/main/local-artwork-ipc.ts`、`local-artwork-image.ts`、`music-cover-art-provider.ts`、`commons-artwork-provider.ts`；`packages/bridge-core/src/collection/local-artwork-service.ts`、`local-artwork-store.ts` | 保留图像预算、来源限制和现有旧 target 完整校验。新草稿通过捕获身份接入，不能把旧 editionId 变 nullable 或让循环单曲 createEdition 代替整专辑安全绑定。 |
| MB 信息整理 | `apps/desktop/src/renderer/src/composables/application/useLocalOrganizer.ts`、`components/library/LocalOrganizerDialog.vue`；`packages/bridge-core/src/collection/local-organizer-service.ts`、`local-organizer-store.ts` | 工作台 `openExistingAction('mb-info')` 委托原预览/confirm/undo；AI选择应用以实际候选转 MB_ONLY 计划，不把手工输入叫模型输出。 |
| 精确源写与恢复 | `apps/desktop/src/renderer/src/composables/application/useLocalSourceWrites.ts`、`components/library/LocalSourceWritesDialog.vue`；`apps/desktop/src/main/local-source-writes-ipc.ts`；`packages/bridge-core/src/collection/local-source-writes-service.ts` | 委托原具体 TAGS/封面计划。默认 OFF、有限格式资格、grant、资源锁、备份、journal、回读与恢复保持。新工作台字段不构成授权。 |
| 改名/移动/历史 | `apps/desktop/src/renderer/src/composables/application/useLocalRelocationPlans.ts`、`components/library/LocalRelocationDialog.vue`；`apps/desktop/src/main/local-relocation-ipc.ts`；`packages/bridge-core/src/collection/local-relocation-service.ts`、`local-relocation-coordinator.ts` | 只向原流程传明确曲目/asset集合，去重同物理源；不把展示分组变文件路径，unknown查询原journal命令。 |
| CUE只读事实与资源协调 | `packages/bridge-core/src/library/cue-text-reader.ts`、`cue-sidecar-reader.ts`；`packages/bridge-core/src/stream/physical-resource-claims.ts`、`physical-resource-locks.ts` | `parseCueText` 的 75fps 声明事实不是已验证可执行 PCM 区间；只读票据/FD仍由原作者取得与释放。 |

## 2. 必须新增或协调的精确文件集合

本轮三个角色严格区分：本线主代理负责隔离模块、验证和具体最小 diff 提案；调度 Root 审核任务边界；MusicBridge V3.9 在 MBF-004 封板后串行实施共享最终实现与正式集成。新完整全专辑 writer、journal注册/worker路由、旧 Main/index/Preload/App/LocalLibraryView、保险库配置/CUE Actor 均归 MusicBridge V3.9 后续串行装配，不能写成调度 Root 独占接线。下表记录已选择模块，原34个建议路径仍以其原文件为历史方案，不把未采用路径写成当前实现。

| 切片 | 新独占路径 | 共享串行接点 |
| --- | --- | --- |
| 专辑浏览/成员/八筛选 | `packages/contracts/src/local-album-library.ts`；`packages/bridge-core/src/collection/local-album-browser/{grouping,sql-read,read-service,owner-port,owner-runtime,owner-protocol}.ts` | `local-catalog-store.ts`、`local-scan-store.ts`、`dataset-services.ts`、`dataset-dispatch.ts`、`dataset-owner-protocol.ts`。失败音频无 trackId 时保留真实拒绝归属；完整 inspect 不用代表曲目代替成员。 |
| 无发行候选及最终安全绑定 | `packages/contracts/src/local-library-workbench.ts`；`packages/bridge-core/src/collection/local-library-workbench/{types,read-service,plan-registry}.ts`；`apps/desktop/src/main/local-library-workbench/{service,artwork-import-normalizer}.ts` | 旧 artwork service/store、唯一 Owner transaction。候选不建发行，明确应用再按完整成员修订保存关系；选中兼容原图 `originalBase64` 与缩略图独立冻结、同 Owner 持久化。 |
| 原搜索来源 | `apps/desktop/src/main/local-library-workbench/providers/{artwork-providers,artwork-web-navigation,artwork-urls,boundaries}.ts` | 保留 CAA/Commons；豆瓣+iTunes聚合及豆瓣/Bing/Google网页分别接入。导航/图片捕获走受控来源，不放宽 arbitrary URL 边界。 |
| 名称 AI | `packages/bridge-core/src/collection/local-library-workbench/{name-proposal,read-service}.ts`；`apps/desktop/src/main/local-library-workbench/providers/name-transport.ts` | 原 Owner 读取、MB_ONLY 采纳、可信 Main transport、持久配置与保险库状态。Ollama/vLLM/cloud 三后端保留；原两个名称键兼容，模型理由为可选真实字段。 |
| 设置/多库/局刷 | 工作台 `existing.open` 和 `LocalWorkbenchReadback.settings`；现有来源根、扫描、设置与 `apps/desktop/src/main/credential-vault.ts` | 本线主代理准备最小 diff，调度 Root 核界，MusicBridge V3.9 最终装配；保留多库明确选择、记录显示名/移除、并发1–24、最新快照、FSEvents局刷与云端配置。未接入逐项显示不可用，不能以入口存在结项。 |
| CUE独立输出 | `packages/bridge-core/src/collection/local-library-workbench/{cue-plan,read-service,plan-registry}.ts`；Main `service.ts` 的 required `prepareCuePreview` 端口 | MusicBridge V3.9 连接真实 PCM/格式资格、Main Actor、源只读许可、共享物理/namespace claims、独立目标/无覆盖发布/原回读恢复。纯模块不会生成产物；新许可不能拿012/013 grant顶替。 |
| 持久原命令 | `packages/bridge-core/src/collection/local-library-workbench/owner-journal.ts` | 新 helper 已写，`local-workbench-v1` 分块事件需要串行接原 ledger operation 闭集、冷核和同 Owner guarded CAS；不新建 DB/table/schema，不以内存或文件替代持久账本。 |
| 统一路由/生命周期 | `apps/desktop/src/main/local-library-workbench/workbench-ipc.ts`、`apps/desktop/src/preload/local-workbench-client.ts`、Renderer `local-library-workbench/ports.ts` | 15 个公开闭集命令、11 个 read envelope 和独立取消读取；本线产具体提案，调度 Root 审界，MusicBridge V3.9 串行接原 Main/preload、Owner worker/client/protocol/runtime。 |

## 3. AI 的纯输入、候选与最终计划

1. UI 请求仅传 dataset、作者 readToken、明确选中的 albumId 与 backend。端点、绝对源路径、Credential、Reader FD、权限不来自 Renderer；Main 使用真实持久配置与保险库状态。
2. 唯一 Owner 捕获完整成员/根/track/file/location修订和人工锁，生成 `snapshotId/contextFingerprint`。有界提示摘要可以只采样原版本的12曲；完整被影响成员集不能随摘要截断。
3. `packages/bridge-core/src/collection/local-library-workbench/name-proposal.ts` 的 `buildLocalNameModelInput/localNameModelPrompts` 只将已保存原目录名/艺人/专辑/有界标签事实组成模型输入。多个逻辑段的同一真实音频文件只计一次；完整授权成员不去掉。纯模块不联网、访问FS或写DB。
4. 同文件 `parseLocalNameProposal` 兼容原 `artistName/albumName` 两键 JSON，可接收严格的可选 `reason`；缺 reason 时明确标注后端来源和“模型未提供理由”，不伪称模型说明了原因。拒绝重复键、坏JSON、超预算、额外字段、角色指令、错误目标；候选展示 before/after，不能用UI手工表单代造。
5. `suggestAlbumName` 返回建议，零业务写入。单项/批次逐项 queued/running/ready/failed/cancelled；停止中断当前请求并取消未开始项。过时代际与已取消批次的迟到响应丢弃。
6. 用户明确选择实际候选后调用 `previewAi`。作者冻结 dataset、完整成员、candidateIds、before/after、人工锁、revision、planHash、contextFingerprint、expiresAt；scope固定MB_ONLY。人工锁冲突进入blocked，不静默覆盖。
7. `applyPlan` 仅按原冻结计划执行；开始前创建一个原commandId并保留请求。unknown/running只调用 `readOriginalReceipt`，不得重新生成UUID或重发confirm。逐项回执保留失败/未写/未知，合成测试不能当真实模型质量通过。

## 4. CUE 的纯输入、区间与独立产物计划

1. UI仅选明确专辑/具体cueId、后端公开的合格格式及Main签发targetChoiceId。目标必须独立，原音频/CUE/封面/曲目/收藏/冻结引用保持；输出后加入库为另一次明确动作。
2. Owner捕获CUE与音频真实关联及根/file/location修订，取得只读票据/FD；文本 FILE 行只查捕获表，不成为路径授权。Main探测采样率、位深、总PCM帧数与实际编码器资格。
3. `packages/bridge-core/src/collection/local-library-workbench/cue-plan.ts` 的 `buildLocalCuePlan` 只接受已捕获的75fps INDEX00/01、明确pregap策略及实际PCM探测信息；纯换算PCM startFrame/frameCount，检查整数溢出、排序、重叠、负值、空轨和末轨越界。输出每轨区间、来源、轨序、标签、最终格式/编码及独立文件名。
4. `previewCueSplit` 冻结完整源/目标闭集与实际轨清单、无覆盖目标状态、容量和claims、revision/hash/context、资格/限制。预览不会生成音频；NOT_VERIFIED/endFrames=null不能直接变可执行区间。
5. 计划scope固定INDEPENDENT_OUTPUT、sourceDisposition固定retain。最终应用重核原计划和修订；沿真实Actor/claims读取原FD，先私有临时产物→标签与音频/帧/Hash回读→无覆盖发布→清单。新writer只写独立输出，不取得源写授权、不挪用Tape产品身份。
6. 保留原codec对应的格式能力登记（FLAC、ALAC、MP3、Vorbis、Opus、WavPack、PCM WAV/AIFF及冷门FLAC回退）。格式未资格通过时列不可用，不用空菜单遮掉原功能；有损再编码要按实际计划说明。
7. 取消是明确原任务取消命令；关闭UI不表示已生成文件被撤销。partial/failed/cancelled/unknown逐轨可见，重启只读对账原command/plan；不删恢复材料，不重签重放，不将partial登记为完整专辑。

## 5. 当前作者交付范围

已写工作台 UI/控制器、公共闭集合同、Core 名称/CUE纯计划、完整捕获读取和持久 registry 边界。控制器保留原 command、迟到围栏、候选预览和逐项结果；读取复用原连接及本线已串行添加的只读 accessor。当前源码自有Core48、Renderer21；同Owner journal6另计。恢复接点当前实际复验合同7/7、Main11/UI21/IPC5共37/37、contracts build及Core tsc exit0；desktop类型复验仍待新fixture与真实RPC async ports适配收口，本轮exit1保留。历史原52批41通过/11失败、修后定向read11/11、旧35/39批分别保持其快照，不重放无改模块也不拿旧绿覆盖新语义。正式共享 writer/设置/保险库/CUE Actor/旧入口与原Owner持久登记仍由 MusicBridge V3.9 后续集成，调度 Root 审边界；软件 Gate、正式 App、真实模型/产物与 Owner 接受分别记录。准确日志见 `WORKBENCH_IMPLEMENTATION.md`。

## 6. 原共享新增点与最小 diff 准备

| 原文件/域 | 必需串行改动 | 已准备内容与边界 |
| --- | --- | --- |
| `packages/bridge-core/src/collection/local-catalog-store.ts` 的冷核/guarded事务/回执 | 在普通 `LOCAL_CATALOG_OPERATIONS` 解码前用私有完整codec登记 `local-workbench-v1`；把 `privateWorkbenchSnapshot`、`privateWorkbenchCompareAndSwap` 接同一 Owner 原连接，在一个 `BEGIN IMMEDIATE` 核 expectedRevision、追加全部 chunk+commit。 | `owner-journal.ts` 提供完整 validator/CAS events/64KiB单行与32MiB整体预算；纯snapshot不是普通实体result，不能只把新字符串加到原公开operation数组或跳过冷核。没有 schema 迁移；业务原子writer/provenance另见 `V39_ATOMIC_WRITER_INTEGRATION.md`，尚未实现。 |
| 原 Owner worker/client/protocol/runtime：`dataset-owner-worker.ts`、`dataset-owner-client.ts`、`dataset-owner-protocol.ts`、`dataset-services.ts`、`dataset-domain.ts` | 给工作台读取、准备、精确原计划读取和原命令应用/回执/取消配置强类型固定调用；实例仅归当前 dataset Owner，关闭时先停受理再等待实际 actor/FD/claims 退出。 | 公共15命令与11可取消读在新合同完整闭集；不能按前缀放行、传任意channel或把 Renderer AbortSignal 跨 bridge 当已物理取消。本线准备固定 Owner 消息最小diff，调度 Root 核界，MusicBridge V3.9 最终落实，不在本文声称旧协议已登记。 |
| 原Owner→Main→Renderer的原操作恢复投影 | 冷启动按durable `registry.operations()`只读取回原plan/request/receipt；Renderer按完整原身份恢复unknown/逐项结果后只查原command。 | 已补原readback可选pendingOperations与通用isLocalWorkbenchOperation，Main严格核完整真实列表再投影unknown/running，Controller整批核后原子恢复。最多100项/总2MiB，错库/改写原计划/隐藏字段拒，缺字段不清原unknown，终态不倒退；不新签/重发apply。新增冷开/迟到合同7与Main/UI/IPC37定向通过；正式Owner持久端口与App入口仍需MusicBridge V3.9实际装配。 |
| 原目录/封面业务事务：`local-catalog-store.ts`、`local-artwork-store.ts`、原 Organizer writer | MB_ONLY 名称采纳与无发行封面最终安全绑定，按捕获完整组/根/track/asset/metadata修订同一事务核对；封面恢复用原图字节，不用缩略图或重新下载。 | `LocalWorkbenchProtectedWriter` 是 required 真 writer；`revalidate` 不授写权，`apply` 自身重核。禁止对每曲独立 createEdition/link/override 循环造成部分关系提交；人工/AI作者只能来自真实 durable 父子结果证明。 |
| 原 source/stream/Main actor 生命周期 | CUE 取得真实源只读 FD 与精确独立目标许可、namespace/physical claims、固定编码器实际资格、临时输出/回读/无覆盖发布/恢复清单；源文件保留。 | 纯 `cue-plan` 只有实际 CD75 和 PCM 帧输入；`prepareCuePreview`、writer apply/read/cancel 必须挂真实 actor。关闭 UI、read nonce取消和已派发写取消分别处理，unknown只读原账本。 |
| 原设置、来源根、多库、扫描、保险库与 App 入口 | 保留原全部设置与多选流程，云端凭据沿批准保险库；挂正式默认墙/工作台与原维护入口。 | 本线逐项准备最小diff，调度 Root 审边界，MusicBridge V3.9 在004封板后串行实施；parser v4/metadata worker/扫描装配仍由 MusicBridge V3.9 独占。不迁旧 Keychain，不发真实付费请求，未接入仍明确不可用。 |

## 7. Main service 的精确装配要求

`apps/desktop/src/main/local-library-workbench/service.ts` 已写 `createLocalWorkbenchService` 15命令闭集调度。required Owner ports 为 read 的完整读取/解析/名称准备与验收/名称封面预览/取消准备，registry 的 issuePlan/apply/readOriginalReceipt/cancel/getPlan/readArtworkCapture/operations，以及 readCapabilities/readLocalArtwork/prepareCuePreview/openExisting。required Main ports 为 names transport、artwork providers、受控 navigation、decode、artworkSources 映射与 native granted chooser；真实既有记录与受保护入口决定能力可用性，不能用全false capability空壳宣布B完成。

`readPrivateArtwork({datasetId,planId?,candidateId})` 的临时候选读取与持久恢复分开；原应用/重启必须提供精确 planId，经 registry.readArtworkCapture读取冻结 originalBase64并再次核实际原图身份。无缓存、无planId或持久身份不一致直接拒绝，不以display/再次下载补图。原生chooser签发实际有限读/独立目录许可，公开路径或choiceId不能造许可。

Main新service/closed IPC、Preload client和Renderer ports已有源文件；其正式入口与原Owner/保险库/CUE Actor是否装配，只以MusicBridge V3.9日志和正式Gate为准。本线提案、调度 Root 边界审查和最终装配三层分别记录。

本线主代理已准备但尚未应用的journal SQL最小提案位于任务目录 `checks/SHARED_WORKBENCH_JOURNAL_PROPOSAL.patch`。它与原32MiB helper配套，按原dataset-identity实读恢复多个dataset各自CAS链，保留原command且不重签；该提案正在送调度Root审边界，文件存在不构成原Owner共享登记/最终实现证据。
