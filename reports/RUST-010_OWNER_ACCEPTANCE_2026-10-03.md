# RUST-010：合成控件接受与代理开发验证补充

2026-10-03：Owner 已按手册打开合成窗口，确认原控件可用。开发期间的测试现由代理完成，Owner 只负责最终成品的使用反馈；保护设置单写、Node 回退及刷新恢复不再作为 Owner 的中间待办。

## 本次结果

代理使用当前程序和已绑定的隔离产物，在全新合成 profile 中复验默认 Node 与 Rust 100 / 2,000 / 5,000 四种模式。三个 Rust 场景均通过原表单保存保护设置，产生唯一 Node outbox 命令，观察到 Rust 撤回后回退 Node，再由一次显式刷新恢复 Rust。

关闭后的两库只读对照逐项确认：每个 Rust 场景只有一条 succeeded 且 acknowledged=1 的 `collection.setPolicy` 命令；模型落盘值为 collector、最低未开封保留数量 1，revision 恰好增加 1。数据库读取前后 SHA 不变。96 项实际收据准入全部通过，零失败、零跳过。

四个正常模式与实际默认 CLI 共五个会话均自然收口，Electron / Core / Node Owner 退出 0，六个 Rust 子进程自然退出 0，没有强制清理。另一个受控启动中断保留 driver=1、failed、无 readiness，资源自然退出 0；它是失败收口负例，不计入正常会话数。已查看 rust100 与 rust5000 刷新后的实际截图。

## Owner 反馈的范围

Owner 已确认的是合成窗口原控件可用。此前回复对保护设置保存及回退链路“不确定”，因此不补写这些人工动作。最新的两个完整历史会话收据可严格核验；rust100 有一次成功的终端刷新和自然退出，但 outbox 为零，不能单凭该收据推定人工保存。两份停留在 closing、缺最终 driver 退出身份的尝试仍保留为未准入，不改写为成功。

新的三次单写及回退/刷新结果是代理开发测试。原 runtime 收据的 ownerAcceptance 保持 NOT_RUN；聊天中的合成控件接受单独记为 ACCEPTED_SYNTHETIC_CONTROLS_ONLY。最终成品使用反馈留在交付阶段，不再要求 Owner 操作中间测试脚本。

## 身份与验证证据

- 原任务 base：`5fc369a46b37fec4ad50ebb909aa1f2c4bc09d09`；实现：`cffb57998e5a6e29da7244f1132eb73a7530e623`；初始结果报告：`fb3316d9c5b47f66e4fc9b478f73063c8abe6a9e`，亦为本补充的 base。
- 分支：`codex/rust-core-010-synthetic-owner-session`；工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-010`。本补充提交由 `git log -1 --format=%H -- reports/RUST-010_OWNER_ACCEPTANCE_2026-10-03.md` 解析，下一任务使用补充后的最终 HEAD。
- 初始 [结果报告](RUST-010_SYNTHETIC_OWNER_SESSION.md) 和 [机器证据](RUST-010_EVIDENCE.json) 保持字节不变，它们记录初始交付时 Owner 未执行的历史状态。本次 [机器补充](RUST-010_OWNER_ACCEPTANCE_2026-10-03.json) 与 [当前 STATUS](../project/STATUS.json) 记录最新结果。
- 本次只修改验收责任、项目指导和状态/文档，不改程序、默认入口或 Rust binary。原 1,110 冻结输入中 1,109 不变，唯一差异为 AGENTS.md 的可复用控件/测试责任约定；不再声称全部 1,110 仍匹配旧冻结。新驱动 8 个输入、组件 898 个输入及 38 个产物重新核验匹配。复用固定 06 产物，没有重新构建或重跑完整软件。
- 只读历史会话核验、产物复用准入、新鲜四模式 smoke、实际 96 项准入及关闭后落盘核验的退出码均为 0；五份命令收据和日志 SHA 见机器补充。
- 当前开发验证：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-010-9ytao7v6/AGENT_DEVELOPMENT_VALIDATION_20261003.json`，SHA `98a42129c951590e81e8a9fa182c60b32c12d2afd217310fc5b03893df938b2c`；历史会话核验：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-010-9ytao7v6/OWNER_FEEDBACK_SESSION_EVIDENCE_20261003.json`，SHA `9212ab6dffa538d7c912c3e2a07cdb53a90f72043434a0785271a7f4a9fce73a`。新鲜 smoke 与准入位于外置 `agent-validation-07/`，不覆盖原 human-gate-06。
- 最终 HEAD、报告 blob、远端、其他工作树及保留 WIP 由外置 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-010-9ytao7v6/OWNER_ACCEPTANCE_FINAL_IDENTITY_20261003.json` 绑定。原手册存在用户未提交修改，SHA `9ce5ddaf4ac511cfa9690812f53a587bc29ffe97f098f00b2b6ce20dd7a5b610`；保留原字节、不暂存，不宣称整个工作区清洁。

## 延续边界

当前仍是可选只读 Rust 第一阶段，生产默认与数据库唯一写入作者均为 Node。真实账号 / Roon / 播放 / 录音、用户数据迁移、Rust 生产持久化、设备 / PDF、系统钥匙串、签名 / 安装替换、远端 CI / push / 发布 / main merge 均未执行。本次不把合成测试或控件反馈扩大为整体 Rust 迁移完成。

MBR-004 真实 Roon 根因/恢复、Gate B P4/P5、008 历史缓存准备边界、外置固定产物漂移拒绝与三个未纳入验收的托盘合成动作继续保留。后续进度见 [TODO](../project/RUST_CORE_TODO.md)。
