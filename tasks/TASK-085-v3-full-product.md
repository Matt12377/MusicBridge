# TASK-085：V3 全功能预览迁入正式 MusicBridge

## 身份与授权

- 基线：`05256eb867e37574e16f23eab877026a229a1703`；分支：`codex/task-085-v3-full-product`；阶段实现提交：`bbc2f7baa40fd671f603aa37817ba6f9018d6ebf`（308 个实现路径逐文件核对后提交）。六份任务/报告元数据尚待报告提交，最终 HEAD 和远端身份尚未生成或核验；不把实现提交当作发布接受。
- Owner 要求在现有 MusicBridge 分支落实全功能交互预览；这不是再建一份独立 HTML，也不代表真实账号、真实 Roon、声卡、实体打印、发布或 Owner 验收已获授权。
- 输入包：外置卷 `Developer/CommandLine/tmp/musicbridge-v3-fullpreview-PQiNBB/MusicBridge_V3_FullPreview_v1.0`。其中 `docs/全功能映射.json` 固定 63 个原编号，SHA-256 `1ef13a409299d132ba3e7a505c2cb3517234415631a2cc487ea6347d4091dce8`；`docs/PRD_MVP30对照.json` 固定 30 项，SHA-256 `c6c60dd839964c462c328ec7c8a71abe275ae7b78316bd37e1e495a471d50d76`。开发包自身基线 `d98eff24…` 是输入身份，不覆盖当前仓库后续有效决定。
- 全量追踪与反向索引见 [TASK-085 覆盖台账](../reports/TASK-085_COVERAGE.md)；结果与未完成验证见 [结果报告](../reports/TASK-085_RESULT.md)。

## 产品合同

保留现有 V2 播放、Zone 与用户数据；V3 仅有“实物收藏”和“录音”两个一级入口。收藏的磁带库存与实体音乐、录音工作台、精确源、分面/选带、固定版本、Logic、执行、档案、打印、备份恢复必须通过正式仓库和已授权适配器连成用户任务，不把原型 `localStorage`、模拟 Hash、模拟设备资格或示例曲目搬进生产。底层对象及不可变谱系继续保留，但普通操作以“当前制作 / 下一步 / 为什么受阻”表达。

Owner 本轮最终视觉选择：保留现有浅深主题与连续背景，采用新包的页面结构和绿色主操作；不另建深色侧栏或背景系统。阶段 Electron 截图只能证明取证视口与操作，不能代替整轮 Owner 视觉接受。

关键不变量：Pool 转单盘守恒；永久 Physical ID 跨视图不双计；Unknown 不充空白或缺藏；Wanted 与 Owned 正交；预留由服务端原子校验，取消须按归属；同名曲目不等于锁定来源；原始 Render、母版、档案、Printed Artifact 不覆盖；软件 EOF、输出排空、实体确认与 Formal Record 分开。备份无内容字节不称完整，恢复不自动续录或重放旧命令。

## 实施与验证顺序

1. 先形成收藏单盘 → 我的制作 → 指定草稿/规划 → 选带/明确预留 → 返回同盘的正式闭环；工作库上下文和 Outbox 共用固定 dataset 身份，迟到读写不能覆盖新选择。执行前保留录音页未保存/未确认回执的离开保护。
2. 接通源、Logic、Profile/执行资产/计划、Attempt/档案、Digital Replica、J-Card/多页打印、目录/导入和备份恢复，逐段保留失败、取消、返回与持久证据；不因为某段原型只能模拟就缩减 PRD 范围。
3. 每个垂直段用隔离合成工作库，从 repository → utility IPC → Preload/Outbox → 正式 Electron App 核对持久结果、重启与错误路径；记录浅深主题、窄窗口与 V2 回归。原型截图或 Renderer 覆写响应不能证明正式闭环。
4. 定向测试及新受影响的 071～077 回归之后，执行适当范围的 typecheck、build、静态 Gate 和正式 App 操作。旧冻结 078～084 容量窗口、Gate B、真实账号/Roon/设备、实体打印及 Owner 接受均不在本次自动重放范围。

自动测试、正式 App、真实源与设备、Owner 接受、提交与 push 分开报告。构建/测试临时目录、日志和结果包只能放已挂载可写的外置 `/Volumes/LifeWeave/Developer/CommandLine/`；不得回落本机 `/tmp`。保留既有未跟踪 `worktree/`，不得 reset、clean、stash、提交或推送无关内容。

## 交付 Gate

- 覆盖台账逐条对应原 63 编号和 PRD MVP 30 项，按完整用户任务列明入口、操作、结果、失败/返回与持久证据；未知及未测明确保持未测。
- 报告记载基线 SHA、实现/报告提交、每项验证命令与退出码、精确测试快照身份、外置日志/截图位置、carryover 和下一分支基线。
- 致命安全、登录恢复、真实输出/播放、凭据或 Gate B 依赖不得被假成功绕过。未获 Owner 新授权不安装 App、不访问真实音乐库、不启动真实播放或签发容量 authority。

## 2026-09-27 阶段检查点

Preload sandbox 的运行时领域包解析导致过正式 App 空白页；改为 type-only 与本地信封校验并加入构建/首启依赖门禁后，聚焦 11/11、Contracts/Core/Desktop 类型检查及生产构建在该时点退出 0。旧失败保留；后续共享树变更须重新验证。

J05 正式 Electron 合成切片已由页面完成发行/逐件、归属照片、关系更正/撤销及冷启保留（`task085-j05-formal-electron-02`，1/1、退出 0）；不代表真实账号或完整收藏验收。J09 正式 Electron 已取得原生 ZIP 另存、预览批准、拒写、原 WAV 字节与冷启历史证据，但 `-06` 因关闭后焦点落到 BODY 而退出 1，`-07` 在 720 窄窗点击诊断中超时退出 1；不能标为全绿。

多盘定向新行为/旧导出兼容 7/7，较宽聚焦 65/67：旧库迁移回归两处失败待定根，须保留历史 schema 边界及失败回滚证据。新设备选择与 Plan 公共合同定向 12/12、Contracts typecheck/build 退出 0；Core 仍在接线，Gate B 生产受信记录为空，正式输出持续阻断。详见阶段结果与覆盖台账，最终提交/远端 HEAD/全量 Gate 均未完成。

## 2026-09-28 阶段外审检查点

正式 Core 已条件接入设备选择、Gate B 准入与 Attempt 输出 provider；默认未认证仍拒绝正式 Begin。冷启精确撤销后的 `engine-cutoff` 与 `cleanup-quiescent` 分别持久化并重读确认，不补造 Stop ACK、EOF、drain 或完成态。可信未受理 typed 错误只在首面 Begin 映射公开 `ATTEMPT_NOT_ACCEPTED`；预检到 Begin 间库存漂移仍可能落入保守未知回执，Renderer 保留原 `pendingBegin`，是待收口活性边界。

阶段定向：Core runner/lease/recovery/barrier/Attempt 101 项中 100 pass、1 原生 helper 跳过，另 Attempt IPC 1/1；Desktop Record/Workflow/Collection Return/Page Journey/Attempt Panel 84/84；Desktop typecheck、control-plane、boundaries、cycles（336 files）、Preload 沙盒依赖检查均退出 0。074 Electron 三例只有默认拒绝/零新增/冷启不续播 1 例通过，其余 2 例因测试 helper 的页面控件定位超时，未进入产品断言；072、073 在本阶段快照未运行。历史 master-versions schema7 与 preparation schema8 两例定向退出 1：前者旧库 DDL 夹具复制引用未复制的 `recording_records`，未进入迁移；后者已进入失败注入且 `user_version===8` 回滚断言通过，但 `sqlite_master` 中以 `preparation_%` 开头的 schema 对象仍有 9 项，旧对象清单断言失败。不能据此推断生产迁移完整通过或回滚版本损坏。

以上仅支持“进行中外审检查点”，不支持完整 `verify`、正式 Electron 全链、真实 Gate B/设备/听感、Owner 接受或发布声明。原生租约撤销测试需显式受控无设备 helper，本轮跳过；冷启恢复仍为合成验证。外置证据在 `/Volumes/LifeWeave/Developer/CommandLine/tmp/task085-evidence-AcHUQA/MANIFEST.md`，含日志 SHA、实际 argv、退出码和实现路径清单。未跟踪 `apps/desktop/test-results/` 与 `worktree/` 保留，不清理也不进入实现提交。阶段实现提交为 `bbc2f7baa40fd671f603aa37817ba6f9018d6ebf`；报告提交不能在自身文件中预填自身 SHA，故元数据 `reportCommit` 保持 null，提交后以 `git log -1 --format=%H -- reports/TASK-085_RESULT.md reports/TASK-085_COVERAGE.md` 解析，不以基线 SHA 代替。
