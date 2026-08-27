# TASK-055：分面规划、库存推荐与明确预留

## 身份与结论

基线 `79ca787240226eefb87cba49c7f92c35232be45a`；分支 `codex/task-055-v3-layout-media-select`；实现提交 `557cb78bf1048732bb30638de6440368787bda0d`。本报告独立提交，报告 SHA 由下一 STATUS 锁定提交记录。后续任务从最终锁定 HEAD 创建，不从实现提交绕过报告。

本地自动验证通过；Owner 产品体验、真实目录/账号/设备、正式录音与完整 Gate A～E 未通过或未执行。没有 push、main 合并、签名、公证或发布。远端 main 仍为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，没有 TASK-055 远端分支。

接替 V3 时保留并续接已有 14 项未提交路径，起始文件指纹保存在本地证据目录。未 reset、stash、clean，未动其他 worktree WIP 或旧原型。当前任务无子代理。

## 完成的范围

- 正式 Renderer → Preload → Main → utility Core → SQLite 的分面、平衡、保存、预留和取消通路。
- Cassette 逐面容量与 DAT 单连续 Program；独立 Lead-in/Tail、同面实际相邻 Gap、逐曲覆盖、Keep With Next、强制面/首末曲约束和保持全局曲序的辅助平衡。未知曲长不填零。
- Roon 估算与实际源时长区分；绑定且确认后改用实际源时长，源变化/失效不能静默回退估算。规划保存输入摘要与修订，草稿/源变化或预留不可用时要求复核；已选磁带不自动替换。
- 现有 Pool/blank/erased Copy 推荐、型号/时长/照片与约束原因；排除录音、未知、预留及不可用库存。兼容性未知明确待确认；收藏保护与跨 SKU 型号最低保留量生效。
- Schema 7：单事务 Pool→Copy→Reservation，库存/规划双账本、永久实体序号、幂等回执与失败回滚。取消恢复 blank/erased，保留实体 ID，不返池、不增总数；库存页不能绕过规划归属取消。
- 既有录音页面的渐进面板；浏览不写入，保存不自动预留，明确选择并确认才分配；回执丢失可重试原操作，重启读取保留同一规划和预留。

## 新鲜验证

环境：Node 22.23.2、pnpm 10.17.1。所有音频、库存和 Roon 数据均为隔离合成夹具；真实 Main/Core/SQLite 路径不等于真实用户音乐或设备证据。

| Gate | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | exit 0；typecheck、单元测试、生产构建通过 |
| Contracts / Core / Desktop | 37/37、508/508、168/168；无失败、取消或跳过 |
| `test:security` | exit 0，22/22 |
| `test:electron` | exit 0，4/4，含合成凭据恢复和 Core 重启 |
| 完整 Playwright | exit 0，43/43（原 41 项 + 新增 2 项） |
| 新增分面 E2E | 2/2：不写入浏览、明确预留、冷启动、取消守恒；DAT、回执丢失重试、草稿变化与不自动换带 |
| 720/1440 面板 | 无横向溢出；局部 axe critical/serious 为 0；关闭后焦点回到触发按钮 |
| control-plane / boundaries / cycles | PASS / PASS / PASS，119 files；control-plane 仍针对旧 WAVE-3，WAVE-5 身份另行核验 |
| `git diff --check` | exit 0 |

源文件集成用例使用实际生成 WAV，验证未知估算、未确认绑定、完整校验与人工确认后真实时长，以及改写合成文件后的失效。库存迁移用例覆盖 schema 6→7 原子回滚与恢复、旧草稿/库存保留及双账本不可改写。预留用例覆盖数量守恒、重复回执、最后一盘互斥、源/草稿变化、Pool/Copy/序号/账本回滚、取消与实体复用。

## RED 与诊断记录

1. 接替后重新运行原 IPC 用例，得到真实 `UNKNOWN_IPC_COMMAND`（exit 1）；完成合同/运行期接线后通过。
2. 新界面 E2E 首次因未启用合成 Roon fixture 失败，仅作为测试环境诊断。启用与既有录音测试相同的 fixture 后，正式草稿页面缺少分面按钮，取得行为 RED（exit 1）。没有用环境失败代替功能 RED。
3. 新增七个业务 API 后，原 Preload 精确允许列表断言失败；按新合同同步允许列表与断言，仍维持无通用 IPC/路径能力。
4. 首轮截图发现半透明面板透出底层草稿文字；增加实际 computed-style 失败断言，改为既有不透明背景 token，复跑通过。
5. DAT E2E 的精确字段定位暴露 select 的名称包含选项文本。补充与可见标题一致的 aria-label，未放宽流程断言，复跑通过。

最终正式面板截图已查看，不代替 Owner 美观验收。所有测试生成的 `apps/desktop/test-results/` 已保留到本地忽略目录，未加入 Git。

## 两阶段自查与承接

先核对 TASK-055 七项范围及不自动播放/录音/换带边界，再检查事务归属、幂等、迁移、IPC allowlist、异步响应、焦点和当前 diff 范围。自查不是独立审查。

当前规划明确为毫秒、`executionReady=false`。标称磁带容量不是实测安全容量；设备勾选不是后端认证。尚未实现不可变 Master/LayoutVersion、最终输出时基的帧级 Manifest、多介质/Segment、Proposed Master、Logic Render 或正式冻结。下一段继续源帧证据、母版/布局版本与源输入复核，不把现有规划冒充最终资产。

候选分页展示并在页内按适配状态排序，当前不会跨页自动选择“最佳”介质。通用跨 Renderer/应用重启 outbox 仍保留，当前是会话内原请求重试和持久化幂等/冷启动读取恢复。完整 Gate C 仍缺 Excel 导入、参考目录及人工数据优先级的全链路项。

F-01 执行资产保留策略、真实 Source Roots/账号/硬件、TASK-047 真实歌词、签名分发和两项旧 V2 视觉 carryover 不变。Source Picker 实物/数字入口、Logic、归档/J-Card、备份和参考目录仍在完整 V3 目标内。

本地证据：`reports/runtime/task-055-final-ilsdaohb/`（日志、交接文件指纹与 Playwright 截图；忽略提交）。实现、报告、状态锁定与下一基线分别记录，不宣称整套 V3 完成。
