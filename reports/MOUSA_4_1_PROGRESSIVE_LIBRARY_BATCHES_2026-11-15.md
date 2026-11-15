# Mousa 4.1：渐进资料库第二项——每 100 张动态加载

## 身份与范围

- 起始提交：`815311e3efd29621e378c5ad8cb6c5118795f2fe`（第一项最终报告 HEAD）。
- 分支：`codex/mousa-4-1-progressive-library-batches`。
- 实现提交：`92bf6bd35184ed60029beb687c418dda6633b326`。
- 报告提交身份：`git log -1 -- reports/MOUSA_4_1_PROGRESSIVE_LIBRARY_BATCHES_2026-11-15.md`。
- 状态：**第二项软件验证完成，未部署、未取得真实音频或 Owner 使用接受**。四项连续任务尚未全部完成；下一项继续冷启动核验与服务边界，之后处理播放优先扫描。
- [阶段 ADR](../docs/adr/ADR-MOUSA-4-1-PROGRESSIVE-LIBRARY.md)与[iOS 交接](../docs/PROGRESSIVE_LIBRARY_IOS_HANDOFF_2026-11-15.md)同步更新；未修改、构建、安装或部署 iOS。

## 实现

1. [合同](../packages/contracts/src/local-album-library.ts)增加显式、可选的桌面版本化读能力：`localAlbum.queryVersioned` → `{ revision, page }`，每页 1–100 张、修订为 64 位小写十六进制。原 `localAlbum.query` 的闭集 DTO 和 200 上限不变；未知/隐藏字段、getter、稀疏数组、错原请求或坏修订拒绝，不把旧页伪装为版本化页。
2. [Owner](../packages/bridge-core/src/collection/local-album-browser/owner-port.ts)在**同一个原 Owner/库存读屏障及 seal**中共同捕获页与修订，沿原 Runtime 前台包装、Main/dataset/epoch/原请求复核转发。没有第二 Owner/writer、持久整库快照或钉住的 SQLite 事务。封面筛选把库存修订纳入成员身份；普通补图不使普通画廊重排。
3. [渐进 pass](../apps/desktop/src/renderer/src/composables/application/local-library-browser/progressive-pass.ts)只持有 ID/顺序/修订信息，与当前显示对象合并。每页立即发布、raw offset 按实际返回条数推进；漂移时去重并保留旧卡片，完整稳定且未被事件标脏的一轮才删除/规范排序。失败单页不推进状态，同一连续修订的跨页重复身份和计数矛盾拒绝。
4. [Renderer model](../apps/desktop/src/renderer/src/composables/application/local-library-browser/model.ts)合并在途扫描和封面成员事件，不反复取消已加载前缀；普通续页约 16ms，短轮及后台核对约 1000ms 合并。补齐成功最终发布时重入刷新的节奏保护，避免 1ms 重读风暴。切库/查询换代/停用后的晚到页不覆盖当前集合。
5. [App](../apps/desktop/src/renderer/src/App.vue)让新能力复用原 Core 就绪、换代和首次专辑上下文控制流，不另造旁路。Preload 的调用方原始请求在第一次 await 前复制，scope 等待期间的外部变更不能替换请求身份。
6. [专辑墙](../apps/desktop/src/renderer/src/components/library/local-browser/LocalAlbumGrid.vue)及[窗口化](../apps/desktop/src/renderer/src/composables/useGridWindow.ts)增加 opt-in 专辑身份锚点；按新行高恢复，用户主动滚动/容器改变时放弃旧锚点。保留原五列布局与主题；目录核对时明确“保留已显示的专辑”，不显示失真的混合项数/最新总量分数。
7. 成长专辑的详情仍由原实际读口取得，不把旧摘要当成播放资格；不自动播放，不追加/重建当前队列，不增加播放 route。100 是页上限，不是等待扫描攒够 100 张的最低提交阈值。

## 自动验证

均使用任务自有数据、批准的外置构建副本与明确的真实 Rust media-worker 二进制 SHA。没有连接真实 Provider、Roon、账号或曲库。

| 验证 | 最终结果 |
| --- | --- |
| 桌面完整单元集 | **3120/3120 通过，0 失败/cancelled/跳过，退出 0** |
| 渐进状态机聚焦集（包含在上述完整集内） | **13/13 通过** |
| Core 专辑/原请求/库存/歌词/权限撤销/队列等选定保护集 | **333/333 通过，0 失败/cancelled/跳过，退出 0**；不是整个 Core 全量集 |
| 80,000 条实际 SQLite 提交专项 | **1/1 通过，退出 0**，范围见下节 |
| 桌面 vue-tsc、E2E/test tsc、Core test tsc | 均退出 0 |
| 标准外置 build-only | 退出 0，不启动用户应用 |
| 官方 Electron 43.4.0 ZIP 与实际执行树身份 | 核验退出 0，未使用路径/版本覆盖 |
| production/development 原生启动，mock keychain | **两模式均退出 0**，原 marker、真实 close、正常退出要求保留 |
| Source/control-plane 边界与 diff --check | 最终均退出 0；control-plane 使用实际源工作树的 Git 历史 |
| 真实钥匙串/媒体解析/发声/Owner 视觉与使用接受 | **未运行 / 未接受** |

### TDD 与旧夹具修复

- 第一项报告中明确保留的旧 VM 夹具债务，在本项补齐真实 startup preview、desktopReadReady、displayDatasetId 及原打印 bootstrap 回调依赖；不删断言、不 skip。产品修改前完整基线已达到 **3101/3101**，最终 3120 项不再带这批失败。
- 状态机、协议/Owner 及组件的初始针对性保护先红后绿；另补充实际 App 首次上下文和 Main/Preload 的正反例。随后对“漂移之后同修订重复”“最终成功发布时刷新风暴”“scope 等待时调用方变更”“封面计数取消前缀”分别故障注入，均先红后绿。
- 既有默认 200 的桌面策略断言按真实 100 重新核算页数/offset；旧公共 DTO 的 200 上限另有保护，没有借此放宽请求或结果。
- 扩展 Core Gate 揭出旧撤销 Worker 合成 SQL 只投影六个旧字段，在进入撤销检查点前即失败；补齐当前正式 raw/effective 的文本/artist 列合同后，真实 Worker/SQLite/FD quiet 原断言通过。未延长原 15 秒限时或以置 flag 代替 FD 关闭。
- 原生执行接线要求显式恢复官方身份收据，并去掉 Harness 继承的 `ELECTRON_RUN_AS_NODE=1`；未改产品或弱化 Gate 来得到通过。早期接线失败日志与最终成功证据均私下保留。

## 80,000 条真实 SQL 合成专项

[独立容量 Gate](../apps/desktop/test/progressive-library/owner-80000.test.ts)实际执行原 repository、扫描 prepared/commit 作者、Owner 查询、Main/Preload 合同和 Renderer 状态机；Main/Preload 的投递桥是受控内存桥，不冒充 Electron 原生 IPC。

- 只授权新建的空合成来源目录，提供结构合法的受控 prepared metadata/解析事实，**没有运行 Parser、制造 80,000 个媒体文件或发声**。
- 第一批实际提交 100 条，分别属于 100 张尚在成长的专辑；扫描仍 `running`、accepted 仍为 100 时，Renderer 状态机在 **33.5ms** 发布首 100 张并能读取其中一张的 1 首详情。
- 随后实际提交其余 79,900 条；合计 **401 个原扫描批、80,000 tracks/assets/scan-file-state、8000 张专辑**。尾部合成写入约 56.4 秒仅是本机容量夹具耗时，不是音频扫描吞吐承诺。
- 401 次提交对应的画廊前缀读取仅 **2 次**；含尾页与完整稳定核对共 161 次版本化读取，最大页 **100 张**、并发上限 **1**，最终 8000 身份唯一、trackCount 合计 80,000。
- 旧首屏卡片再次打开时，从原当前详情读口得到 10 首，不因成长修订误拒绝。没有调用任何队列写入/播放命令。
- 新建的私有 SQLite 与机器证明保留给下一项冷启动测量。以上 **33.5ms 不代表 80,000 条旧库的冷启动耗时，也不包含真实 DOM/GPU 首绘、实际解析或音频接受**。

## 未变边界与剩余项

- 原唯一 DatasetOwner、writer、队列、`roon_audio_input` 新点播 route、Source 授权、资源锁/FD quiet 和默认源写 OFF 保留。没有数据库 Schema 迁移，没有删除历史记录或减少安全核验。
- 未更改 iOS HTTP DTO、配对、SRP、authority/profile、LAN/Tailscale、资源票据或队列恢复合同；桌面可选 IPC 不等于新发布的 iOS HTTP 能力。
- 未停止、重启、切换、部署或修改当前用户开发实例；未操作其他 iOS 会话工作树。
- 壳已独立、动态分页已验证；**旧库冷启动全历史核验和稳定播放期间扫描预算仍待第三、四项**。当前 scanner 的播放占有暂停策略未在本项修改。
- 合成几何/组件与空 profile 原生启动不代替真实 Chromium/GPU 视觉、真实媒体/设备/听感或 Owner 接受；这些接受项仍为 false。

## 下一项

完成本报告提交、普通推送及本地/远端最终 HEAD 与清洁状态复核后，从本项最终报告 HEAD 创建独立的安全冷启动/审计服务任务分支。继续原四项授权计划，**不在第二项停止**。
