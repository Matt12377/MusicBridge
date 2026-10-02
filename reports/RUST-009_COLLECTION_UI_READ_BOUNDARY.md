# RUST-009：正式磁带收藏页面与刷新领取边界

状态：可选只读路径本地实现、适当验证和两轮独审完成；生产默认 Node，Owner 人工验收未执行。

## 身份与行为

base `ae8a53fb1206c65632d3b23c66b929965e89a7d3`；独立分支 `codex/rust-core-009-collection-ui-read-boundary`。程序冻结 V4 1104 文件，SHA `8b599889dca7d4a62ed7cd240dca6bbc475d1c3ade8dc29be5691486b7736f4f`。外置证据根为 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-009-8v4uf3j4`。实现提交 `a5e5add4955de6a36e488d1412a5965a9bfd5b6b`，1104份受测程序Git blob与冻结完全一致；独立报告提交由 `git log -1 --format=%H -- reports/RUST-009_COLLECTION_UI_READ_BOUNDARY.md` 解析，不写自引用SHA。下一任务从最终报告HEAD接续，最终HEAD/清洁/远端/原仓库WIP由外置 FINAL_IDENTITY.json 核验。

实际空白磁带页面的完成度、求购、已有历史与参考资料链此前会保守撤销候选。新增八条精确热 Node 纯读，与旧八条合计16条；仍由固定已boot Node Owner执行原验证/SELECT/解析/操作内Map/完整结果与错误，没有按领域前缀扩大。collection.list 继续原Rust投影/完整DTO/total/版本探测/readContext回退。

刷新撤销active之后的后台空领取新增同次refresh证书：generation/deadline/完整scope/version锁定，探测、导出与后探测一致，以及non-Proxy精确own-data lease:null才允许保留。首次await前登记完整窗口；发布与Node/Rust读成功或错误交付均受同代窗口完成屏障约束。真租约、异常/unknown、探测失败、版本变化、invalidate/close/fatal撤销自己仍拥有的代次；迟到窗口不伤新代，不复活候选。Node dispatch恰一次，原结果/错误保留，不重放。原整体期限、峰值一个child、协议/字节预算和1500ms worker不改。

## 已取得证据

最终Rust V4 Gate 30步退出0，43 Rust/479 JS，589输入、9引用产物与每步日志/bin身份匹配，旧004完整成本基线RUN；manifest `rust-gate/run-v3FMk0/manifest.json` SHA `f4c4e84053e0e89771327d9a813cc219a59787a97dcb95dc2adcf579cf96ed76`。

真实Electron05 5/5（4场景+报告）；完整实际验收50/50（原报告+49拒绝变体），零skip。默认Node100与静态Rust100/2000/5000使用原生产Main/Core/Owner/preload/实际Vue控件、原打印worker，来源为fresh合成两库和离线testBridge/mockkeychain。189动作/截图、295完整回执与独立SQLite参照；893来源/38编译产物全部当前匹配。manifest.sourceSha表示构建时Git base，未提交实现由sourceAggregateSha256绑定，不冒称已实现Git SHA。

默认Node零Rust/零私有导出；三Rust场景原保护设置表单通过durable outbox执行、成功、ack各一次，写后Node回退，可信refresh各一次恢复。导出受控等待约2827/2932/2346ms，均真实跨2次原1500ms claim；刷新后显式等待至少2次空claim保留。6个Rust child、4个Node Owner/Core utility/Electron host全自然退出，forcedCleanup=false，5000两个child各40 append ACK。

窗口以production UI_E2E show:false/accessory真实渲染，由Playwright操作与截图；没有Owner可见或人工验收结论。全部新宿主代码静态隔离，旧008 fixture及生产桌面Main/Renderer/preload不改。CLI为Node22.23.2；真实Electron43.4.0内嵌Node24.18.1，Chrome150.0.7871.224。

完整软件六步全部退出0：254 contracts + 2,422 core + 1,250 desktop = 3,926通过；仅保留原2 native条件skip，名称与008相同，零新增skip。生产build与control-plane/boundaries/cycles通过（384文件）；软件before=after=当前=冻结V4的1104源码。软件manifest SHA `57493945d4b93feaa3774642f9ec2c3e0b3c8e72b7c5b218967471bcda00180e`。默认生产入口 development / production mock-keychain startup分别退出0，保持Node，不调用私有Rust入口。

机器证据见 [RUST-009_EVIDENCE.json](RUST-009_EVIDENCE.json)；任务/合同/ADR分别见tasks/RUST-009、docs/contracts/rust-core-collection-ui-read-v1、ADR-046。两轮独审完成，剩余 P1/P2=0；最终收据 review-round2.json SHA `2fdbc2335cca27091d048ff216f274f15c6367c45a076a7312063f6201675662`。审读45份源码/合同/报告，95唯一日志、112编译产物、189截图、26退出后合成DB/WAL文件与资源身份一致。程序源码已冻结，之后只更新交付元数据。

## 失败、修补与范围

新50行为在旧router有效RED（9pass/41fail，零skip）。热Owner纯度最终18，最终新55+18+原领域38=111通过；旧五分类样例237/242修前失败保留，最小换表后242/242，原断言与数量保留。四个旧末次探测夹具按调用序号挂起，新增refresh前探测后停在child创建前；已改为实际boot帧/成功ACK定位，保留原期限、数量、failed/迟到/自然清理与不发布断言，增加spawn/boot实质证明。最终生命周期23/23和router/真实刷新43/43。局部首次指令缺必填costReport路径失败、两轮Gate失败、V3 PASS但manifest旧008元数据、最终V4修正身份全部保留；没有降低Gate或预算。

初期Proxy fixture then trap、合成bookId、类型、Electron temp profile与关闭后process引用、outbox原结果信封、production customscheme与Node close→exit→closed验收顺序等准备失败在日志账本保留。05完整真实验收通过，04只读schema诊断跳过过期源码身份，不能替代正式PASS。

本期依赖复用008已存在的外置Electron275文件/链接，APFS克隆前后src=dest SHA一致，未下载/安装/替换用户app；详细manifest与runner同名覆盖导致的准备收据重建保留，重建后完整内容SHA与原日志相同。008历史首次缓存I/O缺口仍carry，不能追认为合规。

实体音乐库、Roon/数字关系、ZIP预览暂存/导入、目录登记/发布/关联、编辑预览、求购保存/取消、capture及录音仍保守失效；没有因相邻页面扩大纯读范围。默认2000/4MiB、显式5000/8MiB、128每块/最多40/1MiB帧不扩大。观测耗时含fixture/DOM/oracle/wait，不当精确Core延迟或生产性能。

真实用户库/迁移/持久化所有权、账号/Provider/Roon/播放听感/录音、PDF/设备、系统钥匙串、签名/安装替换、Owner验收、远端CI/push/发布/main merge均NOT_RUN。默认Node与生产唯一数据库作者保持。MBR-004真实Roon根因/恢复与Gate B P4/P5 carryover不变。

下一步从最终报告HEAD建立独立任务，提供可见且持续交互的合成人工入口。只读审计已证明现自动Gate隐藏窗口并自动退出；新入口需可信show/focus/合成标题与terminal status/refresh/quit、有界新profile、同批产物/binary/Electron准入以及自然资源退出；人工结果由Owner明确反馈记录，自动测试不替代。

验证账本包含 60 份顶层命令收据，另绑定四轮 Rust 的内层步骤与六步软件记录；其中 15 份顶层收据非零退出，包含有效RED及准备/夹具失败；不把重跑相加为独立用例数量。最终提交与清洁/远端/原工作树核对写入外置FINAL_IDENTITY.json。
