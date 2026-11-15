# Mousa 4.1 第三项：安全冷启动历史核验与内部服务边界

## 身份和范围

- 独立分支：`codex/mousa-4-1-progressive-library-audit`。
- 基线：`ad52961f7064ec731d868e1330fcedc751be08bc`；从第二项最终报告 HEAD 接续。
- 实现提交：`f077b65c82086245209d974977a70c78364e2a93`。
- 本报告提交身份：`git log -1 -- reports/MOUSA_4_1_PROGRESSIVE_LIBRARY_AUDIT_2026-11-15.md`，避免报告自引用 SHA。
- 本项不部署、不启动或替换当前用户实例，不使用真实资料库、账号或音频，不修改或操作 iOS。关键启动软件保护通过；另有实际复现的原基线可选 MPC8 格式债务，未写成通过。

## 1. 测量而非猜测

使用第二项已经真实提交的自有合成 SQLite：80,000 条 track/asset/file-state、8,000 张专辑、401 个 batch。原件只读，前后完整 SHA-256 一致；容量重开只对新私有目录中的克隆操作。

最初怀疑的 receipt 索引不是瓶颈：prepare/commit receipt 表达式索引本来就存在，401+401 次查询合计约 49.5ms，因此本项没有增加冗余索引或 schema 迁移。独立 CPU 探针发现，大部分时间消耗在逐文件重复把整批 request/result 原文传过 SQLite→JS。

| 同一合成原件的应用级全核 | 原基线 | 本项原事务有界复用 |
|---|---:|---:|
| catalog 完整审计 | 5724.612ms | 5714.649ms |
| scan 完整审计 | 22081.500ms | 8670.740ms |
| 两域合计 | 27806.112ms | 14385.390ms |
| batch 原文 get | 独立 CPU 探针 80401 次 | 802 次 |

总审计约减少 **48.3%**，scan 约减少 **60.7%**。802 次仍包括原 401 次全 batch 核验和 401 次 file memo 首次取得；不是零读取或跳过 batch guard。每个真实 file-state 仍遍历，主水位和 temp 水位各实际 get **80,002 次**。

这是同机、同一合成原件的应用级冷核；没有清操作系统页缓存，测试前后的完整内容哈希也会读文件。不把它称作物理磁盘冷启动，不将本机合成数字外推到用户库，不把两域核验耗时等同于整个应用或首屏耗时。

## 2. 产品边界

- [启动审计服务](../packages/bridge-core/src/collection/local-library-startup-audit.ts)仅组织原事务内两域完整核验与既有安全缓存复用。任一域失败或取消，清除两域派生证明，不发布部分就绪。
- [同步读 session](../packages/bridge-core/src/collection/local-scan-audit-read-session.ts)只在原启动事务的同一次完整同步核验内使用。逐行及发布前检查实际 total_changes、data_version、main/temp schema、user_version、foreign_keys 与事务状态；变化即拒绝，而非降级为 cache miss。
- [原 scan 语义核验](../packages/bridge-core/src/collection/local-scan-store.ts)仍验证真实 file-state、原始 guard、跨表/批、receipt、catalog/ledger、CUE、搬迁和完成快照。普通迁移、备份恢复及普通读方仍逐项重读 batch 原文。
- 原 32 条 statement 总预算包含两条水位语句；原 memo 的 64 项、4MiB 原文、32MiB 保守分配预算不扩大。scope 关闭或失败后不续用，不跨连接、调用或异步间隔借用证明。
- [repository 原启动作者](../packages/bridge-core/src/collection/repository.ts)继续拥有基础/recording/来源检查、queue 检查、扫描与 attempt 关键恢复、唯一原 COMMIT 和 Owner 交付顺序。新服务不提交、不发 Source 许可，不提前宣告 Core 业务 ready。
- 复用的是既有内容指纹、物理身份、实现/runtime/schema 密封缓存，不用 mtime 或大小当内容证明。没有增加 writer、Owner、队列或播放 route，源写默认 OFF。

没有通过删除历史、缩小 guard、跳过全局检查或将完整核验简单移到后台来获得以上数字；独立壳仍可用，业务与播放资格仍在原控制流内等待关键条件闭合。

## 3. 实际冷/暖重开和首 100 张

[显式 80,000 条专项](../apps/desktop/test/progressive-library/cold-audit-80000.test.ts)只克隆自有合成原件，走真实 repository、关键恢复和 Owner 读服务。冷开完整两域核验；保存原内容绑定缓存后，暖开复用证明且不重放 catalog/scan 阶段。两次各返回前 100 张/总 8000 张，当前第一专辑详情 10 曲，原件 SHA 不变。

| 最终专项计时 | 实测 |
|---|---:|
| 冷 repository 完整启动/恢复 | 17558.495ms |
| 冷开之后首次 Owner 查询 100 张 | 6884.245ms |
| 显式保存既有内容绑定缓存 | 1811.306ms |
| 暖开前读取和验证缓存候选 | 1429.944ms |
| 暖 repository 完整启动/恢复 | 1948.124ms |
| 暖开之后首次 Owner 查询 100 张 | 299.884ms |

首个查询计时从 repository 启动完成之后开始，不能把 299.884ms 冒充完整暖启动。冷开首次成员目录建立仍有约 6.88 秒成本；本项没有隐瞒或宣称它已被消除。

这里是实际 repository 与 Owner 服务，不是 DatasetOwner 独立进程、Electron 跨进程传输、Parser、播放请求或实际音频。合成源目录为空，详情可浏览不表示这些合成条目可以实际发声。容量缓存使用与既有单元测试相同的显式测试实现版本参数，**不替代或 override 打包 App 的实现 seal**。正式 production/development 隔离启动另取官方身份收据。

## 4. 软件和隔离 Gate

各组有交叠，不将它们累加为唯一测试总数。

| Gate | 结果 | 退出码/说明 |
|---|---|---|
| 标准外置 build-only | 通过 | 0 |
| Core 标准主集 | 3845 通过，0 失败，0 取消，2 原有显式原生 skip | 0；共 3847 |
| Core 原隔离 queued-Stop 集 | 8/8 | 0 |
| 启动服务、事务 scope、缓存保护 | 38/38，无 skip/cancel | 0 |
| 扩展持久扫描、权限恢复、快照/搬迁与读权保护 | 208 通过，1 已复现原基线可选 MPC8 失败，无 skip/cancel | **1**；共 209，不标绿 |
| 桌面完整集 | 3120/3120，无 skip/cancel | 0 |
| 80,000 条克隆冷/暖专项 | 1/1，无 skip/cancel | 0 |
| 桌面 Vue、E2E 测试、Core 测试类型 | 均通过 | 各 0 |
| boundaries / 实际源 Git control-plane | 均通过 | 各 0 |
| 官方 Electron 43.4.0 身份 | 官方 ZIP 与实际执行树验证 | 0；本项外置工作区新收据 |
| production 隔离 mock-keychain 启动 | 通过 | 0 |
| development 隔离 mock-keychain 启动 | 通过 | 0 |
| diff 格式 | 通过 | 0 |

Core 实际 fresh 准备使用标准 contracts/Core/固定 Worker 编译；Reader/CUE 声明来自这一次真实编译收据，在各阶段前后检查源及产物未变，不复用历史 dist 伪装 fresh。Native 不使用旧工作区身份收据，不覆盖官方执行身份，不接真实 Keychain、资料库或 Roon。

### 旧夹具的可复现修复

未改优化的独立基线副本实际复现了旧假设：普通 Reader.close 不是共享常驻 Rust 池关闭；已不再逐文件发 JS worker-start/exit；freeze 保存原两槽上限而非夹具 Reader 的一槽；重连需要当前 Zone 订阅回报。

测试改为实际 Rust readId settled→同源 FD 释放/EBADF→read-complete 顺序，进程级池由测试根关闭，重连夹具转发当前 subscription。保留原权限、ID/raw/manual、回执和零自动重播断言，不改产品行为取绿。原 APE 及 TTA/FLAC/MPC7 混合的原 Main/claims/搬迁/冷读保护独立运行并通过，避免被可选格式债务遮住。

### 保留的有界可选格式债务

原严格五族 Gate 期望 10 条全部 accepted，其中 MPC8 合成输入在基线和候选的同一固定 Native 媒体二进制上均真实返回 **PARSE_FAILED**，导致 8 accepted/2 rejected。逐格式实读、原字节哈希和 FD 收口在两版一致。

**没有把期望改为 8 或 skip 掉来消除失败**，没有改本任务外的 Rust 解析器，也没有签发新的五族资格。该五族失败保留并单独报告；不将“关键启动保护已通过”写成“所有 Core Gate 全绿”。

## 5. 未认证和下一项

- 尚未实测真实资料库、实际 Roon/输出设备音频、真实 Keychain、Chromium 视觉或 Owner 使用接受。
- 完整原生输出的两项显式 opt-in 标准 unit skip 不冒充原生通过；隔离 mock-keychain 启动不等于实际音频。
- 首个合格播放命令的受控计时与播放优先/稳定播放低预算扫描继续第四项；本项未放宽原播放准备期门禁。
- iOS HTTP、配对、authority、Source 和队列合同不变，见[交接说明](../docs/PROGRESSIVE_LIBRARY_IOS_HANDOFF_2026-11-15.md)及[ADR](../docs/adr/ADR-MOUSA-4-1-PROGRESSIVE-LIBRARY.md)。
- 下一独立分支只在实现/报告普通推送、远端 HEAD 一致及工作区干净复核后，从本项最终报告 HEAD 创建。

## 6. Git 交付口径

实现与本报告/状态提交分开；仅普通推送本独立分支，不合并 main 或替换现有运行实例。提交后的独立私有收据复核本地 HEAD、origin 对应分支、最新报告提交和干净工作区，动态身份查询见上方。机器读取的当前状态见[STATUS](../project/STATUS.json)，有界遗留项见[风险登记](../project/RISK_REGISTER.md)。
