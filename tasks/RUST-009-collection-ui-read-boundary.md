# RUST-009 — 正式磁带收藏只读页面与刷新期间领取边界

Owner 已授权持续实际开发。从 RUST-008 最终报告 HEAD `ae8a53fb1206c65632d3b23c66b929965e89a7d3` 接续；独立分支 `codex/rust-core-009-collection-ui-read-boundary`，工作树 `worktree/rust-core-009`，证据目录 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-009-8v4uf3j4`。当前范围审计和后续实现、验证、审查分开记录。

## 问题与完整目标

RUST-008 真实 Electron 证据停留在主页，通过原 preload 调用 API，未证明实际收藏页面。磁带墙的初始化与详情已落在旧读取集合，但完成度面板首先并行读取 sources 与 wants，随后选目录才读 current；参考来源和已有历史阅读也有未准入命令。另一个缺口是 refresh 撤销活动候选之后，后台 1,500 ms 空领取仍按潜在写撤销本次刷新。

本期证明正式空白磁带收藏页面的现有只读浏览、筛选、分页、型号详情、完成度/求购/历史及参考目录既有资料阅读。沿用现有 Vue 页面、原 preload、生产 Main/CoreSupervisor/utilityProcess、共享桌面 adapter、生产 Node Owner 与真实后台打印工作器。不得用直接 API 调用或藏掉入口替代实际页面验收。

## 冻结实现范围

1. 已成功 boot、固定且已打开的 Owner 连接上，保留旧八条 Node 纯读并增加八条精确命令：`collectionProgress.current`、`collectionProgress.wants`、`collectionProgress.wantHistory`、`collectionProgress.snapshots`、`collectionProgress.snapshot`、`referenceCatalog.snapshot`、`referenceCatalog.source`、`referenceCatalog.sourceZipReceipts`。辅助链须保留原验证、预算、SELECT、解析/指纹与错误；操作内 Map 不跨请求复用。不按领域前缀扩展。`collection.list` 继续保持原 Rust 路由、完整 DTO/total、版本探测和 readContext 回退。
2. 条件 `recordingPrintWorker.claim` 仍是 Node 作者操作，不是纯读。活动候选保留旧证明条件；无 active 的刷新窗口只能借用该次 refresh 的 generation 和完整 scope/version 证书。前后探测同 scope、同版本，精确 non-Proxy own-data `lease:null`，与已捕获的导出版本一致才允许保留。首次 await 前登记完整条件窗口；从导出到上传、boot 与最终发布必须受同一围栏和读取/发布完成屏障保护。窗口关闭前不得发布候选或交付同代读的成功/错误。
3. 真租约、原异常/unknown、辅助探测失败、版本/身份变化、invalidate/close/fatal 均撤销自己仍拥有的代次；旧窗口迟到不得伤新代次或重新挂回候选。Node 原 dispatch 恰好一次，原结果/错误不能被辅助探测覆盖。保持原整体单调期限、最多一个 child、旧 child 关闭 ACK/自然退出、无自动刷新或重放。不能停止后台工作器、变更 1,500 ms interval 或缩短测试工作量取得绿灯。
4. 新静态隔离 collection 宿主与编译配置使用固定 binary pin、100/2,000 的原默认 profile，以及明确 5,000 的 `v3-5000` profile。运行时 Renderer/env/公开 IPC/父启动消息均不能选择 Rust。第二私有端口仅限安全观察、可信显式刷新和固定只读参照；传输延迟只在隔离测试 seam，不改生产协议/超时/工作器。
5. 新合成数据必须含两版目录、匹配/未知项目、非空求购及历史、完成度与旧目录快照、有效合成图片，以及可分页的库存详情。只在候选建立前由 Node/合成夹具写入，启动运行期生产 Node 仍唯一作者；不读写真实用户库。默认 Node 与可选 Rust 以真实页面控件走同一读取链。
6. 真实 Electron 场景覆盖默认 Node/零 Rust/零私有导出，显式 Rust 100/2,000/5,000 基础页面及现有只读面板。绑定 locator 交互、DOM/截图、request/reply id、完整安全 DTO/SQLite 参照、真实 Rust ACK、generation/scope/PID 与自然退出。至少跨两次真实空 claim，并通过隔离受控等待证明 refresh 导出或 v3 上传窗口确实跨过原后台 claim；不得依赖机器恰好很快。
7. 合成详情保护设置表单通过原 durable outbox 写一次，证明候选撤销、Node 回退、真实页面反映结果；可信显式 refresh 只一次，再证明页面读取和空领取保持。该写回退仅验证既有行为，不给 Rust 写权限。

## 不在本期准入的入口

实体音乐库、数字关系/Roon runtime、库存导入与 ZIP 预览暂存、编辑预览、目录登记/发布/关联、求购保存/取消、完成度捕获以及录音都不因相邻页面自动进入纯读闭集。写与未经审定命令继续保守失效，原 Node 行为保留。这不是整个产品所有页面、真实用户启用或持久化迁移验收。

原默认 2,000 型号/4 MiB、显式 5,000/8 MiB、每块 128 型号/最多 40 块/1 MiB 帧及累计预算不扩大；保留旧协议、公开合同、默认生产入口和唯一作者。

## 文件分工与模型

本期四个子代理均 `gpt-6.1-sol/high`，主代理按 Owner 要求 `gpt-6.1-sol/max`；用户最新要求覆盖 AGENTS 旧 3/max 条款。平台最多四个活动槽含主代理，因此三个作者并行，释放名额后第四个独审，不再派生。

- 子代理 1：`packages/bridge-core/src/rust-core/readonly-router.ts`、新 `packages/bridge-core/test/rust-readonly-collection-ui.test.ts` 与 `rust-collection-ui-node-purity.test.ts`。八条完整纯度/固定连接证据及刷新领取并发 RED→GREEN。
- 子代理 2：新 `scripts/ci/rust-collection-evidence.mjs` 与 `scripts/ci/test/rust-collection-evidence.test.mjs`。独立验收 parser、造假/缺漏拒绝行为；与宿主作者协调证据 schema，不改其文件。
- 子代理 3：新 `apps/desktop/e2e/private-rust-collection-*`、`rust-collection-host.vite.config.ts`、`rust-collection-host.tsconfig.json`、`electron-gate/rust-collection-host.test.ts`、`scripts/rust-collection-host-gate.mjs` 与新 `test/helpers/rust-collection-host-*`。合成 seed、静态入口、实际页面/后台并发与自然退出证据。旧 008 fixture/Gate 原文保留；需扩充共享 seam 时先协调主代理。
- 子代理 4：只读独立审查，保存外置收据；不写生产代码、不重复整个 Gate。

主代理负责合同/ADR/任务索引/STATUS/TODO、CI 自动 Gate、外置环境、整合审查及实现/报告独立提交。旧负分类样例只作最小重分类：`rust-readonly-node-reads.test.ts` 的 source 与 current 各两个 outcome，分别改为未准入的 `referenceCatalog.previewSourceZip` 和仍有写副作用的 `collectionProgress.capture`；`rust-readonly-main-boundary.test.ts` 一项 current 改为未准入的 `referenceCatalog.previewSourceZip`。合计五个分类样例，保留原所有断言、数量、unknown/关闭/原回执与单次执行；修前分类失败保留，不把旧合同更新说成生产缺陷。最终 Gate 另发现 `rust-core-owner-lifecycle.test.ts` 的末次探测夹具按第二次调用挂起，新增加刷新前版本锁定后会停在 child 创建前；主代理将该夹具改为按实际 `commitBoot` 帧挂起，保留 500ms 整体期限、候选恰一次启动/清理、failed/禁止 ready 与原 23 项测试数量，新增实际 boot 帧恰一次断言。首轮失败、原夹具和新冻结 V2 分别保留。同根因补审另外两条原 router 的末次探测夹具和一条真实 refresh 集成夹具，统一以实际 boot 帧/成功 ACK 定位，保持原测试数量、期限和行为断言，并增加真实候选观察；最终冻结为 V3。

## 验证与交付

先用新行为测试在旧 router 捕获纯读撤销及刷新窗口失败，再修实现；Node 固定连接检查成功/错误前后 stamp 与持久化事实不变，并证明两次操作间作者修改会进入下一次结果，不能复用操作缓存。刷新领取覆盖 export 前/后、上传中、boot 后发布前、多窗口、迟到、异常、真写、Proxy/getter、版本/scope 变化及关闭立即唤醒。保留旧生命周期、差分、预算与安全断言。

保留既有 27 步 Rust Gate、RUST-004 完整路径成本基线 RUN，增加本期 Core 纯度/行为及隔离 UI 构建；真实 Electron 与其完整验收 parser 另列，条件缺失为失败，不使用 skip 或 Worker 模拟替代。新专用 tsconfig 覆盖所有新 entry/spec/fixture/config。完成匹配源码的完整 typecheck/unit/build/control-plane/boundaries/cycles 与必要默认 mock-keychain startup。审查最多两轮，报告完整退出码、首次失败、各源码/编译产物/binary/日志/资源身份、carryover 和 Git 基线。

构建、缓存、tmp、合成 profile、截图和日志均在已核实挂载且可写的 LifeWeave 外置卷。使用现有 Electron executable 的明确路径并核身份，禁止隐式安装/下载；Node 22.x、pnpm 10.17.1、已安装固定 Rust。008 首次缓存偏差保留，不由本期正确配置覆盖旧证据缺口。

真实 Provider/Roon/账号/播放/录音、用户数据库/迁移、系统钥匙串、Owner 验收、设备/PDF、安装/签名/应用替换、远端 CI/push/发布/main merge 均未授权执行。MBR-004 及 Gate B P4/P5 原 carryover 保留。下一任务从本期最终报告 HEAD 接续。
