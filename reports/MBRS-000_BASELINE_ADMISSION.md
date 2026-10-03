# MBRS-000 真实基线、唯一主责与有限准入记录

已交付本轮基线记录，产品 G0 仍 **NOT_ADMITTED**。当前 Node 控制面、业务库 Worker 和 Main outbox 作者保持；默认 OFF 的收藏只读 Rust 不等于完整 Rust 迁移。新产品 App、真实 Roon/账号/音频、源文件写入及 Owner 使用均未运行。

## 身份与范围

- base：`044e6b24edf81b64030d4c96741082670532971c`，对应 RUST-015 最终报告；其实现 `8c58fdee4309a781dbf6640d8aeba46bb8fe1bd3` 为祖先，015 远端分支 HEAD 与最终报告精确相同。
- 本任务分支：`codex/mbrs-000-baseline-admission`；实现：`a83c39b552ba949c16a3bfe717e4e7183d617334`，仅24明确路径，生产 apps/packages/native 源码未修改。
- 报告提交及下一分支基线：`git log -1 --format=%H -- reports/MBRS-000_BASELINE_ADMISSION.md`；提交后完整 HEAD/远端/清洁/报告摘要另存外置收据，避免报告自引用。
- Owner 本轮明确换届与连续执行 v1.2。实际主会话 gpt-6.1-sol/max、三个实际 gpt-6.1-sol/high，已核 session turn_context；一个写作者、两只读调查者，主控串行接管整合，无派生代理。

8份指定交接原件字节/SHA全部匹配，执行包97文件/96内部校验和匹配，015六个Git输入与工作树字节匹配。当前保护快照覆盖83旧注册树（含两个原不存在树），HEAD/status及常规dirty文件前后均匹配；未 reset/clean/stash，旧015和其它WIP未写。

## 实际交付与复用

`docs/postrust/MBRS-000/`保存BASELINE、DATA_OWNERSHIP、12复用项（实际路径/声明行/blob/SHA/最小delta）、14原始未完框逐项唯一主责、非自动授权的ADMISSION、原18任务和156验收冻结输入与失败台账。`project/POSTRUST_PLAN.json`逐字保留126+30需求，TODO同时展示完成与待办。

AGENTS和ADR-MBRS-001/002/003落实有限规则：普通读链仍只读，SOURCE_FILES默认OFF且仅后续逐计划授权；活动/暂停/预取/录音读者及Frozen/Prepared/Archive默认阻止源写，MB_ONLY不占无关音频锁，旧Hash/历史/FFmpeg/OutputNative/J-Card保留。本期新增本地点播仅roon_audio_input，复用原coordinator/Adapter/Gateway/UI，不造第二队列或writer。

已有StreamRegistry token和output-run-lease没有被写成完整本地FD/全局资源锁；该缺口明确由后继005/014设计、012保护接入。原业务数据库仍Node Worker唯一写入，Main outbox独立唯一写入，新表不是Rust writer迁移。

## 新鲜验证与独审

| 验证 | 退出/结果 | 范围 |
|---|---|---|
| `node --test scripts/ci/verify-postrust-baseline.test.mjs` | 0；13 pass、0 fail/skip/cancel | 当前记录正例；G0非法提升、丢TODO、第二writer、改需求并重封摘要、跨路线/拟Rust依赖环、假App/live/Owner等针对性负例 |
| `node scripts/ci/verify-postrust-baseline.mjs` | 0；18任务/156验收/14原框/12复用，G0 NOT_ADMITTED | 独立包SHA pin、Git输入/符号、结构及DAG |
| control-plane / boundaries | 各0 | 未改生产边界的工程回归 |
| `git diff --cached --check` | 0 | 24实现路径；报告暂存后再次核 |
| 新任务首轮独审 | 无确认P1/P2 | 20写作者文件加4主控整合及当前状态增量；没有重审已封存015第三轮 |

最终行为轮只计13项，不累加准备轮。提交前用于测试的HEAD仍是base、受测字节包含本实现工作区；实现Git身份由本次24路径提交绑定，报告提交不冒充受测程序。详细日志/退出/摘要见 `MBRS-000_EVIDENCE.json`。

000验收八项仅基线/规则记录PASS；000-02因继承CI/安全未闭合为PARTIAL，000-03因本地route实际接入未实施为PARTIAL。App/live/Owner全部NOT_RUN。基线交付完成不等待整体G0，从而不形成000/G0循环；产品集成仍依G0。

## 继承失败、未完与下一主责

本轮重新读取015最终真实CI、完整原日志和页面：static-security37138111583成功；verify37138111546失败（desktop1313 pass/18准备失败，生产audit失败）；Electron37138111555失败（4系统合成子项通过/2Rust helper编译树导入失败，Playwright步骤未执行）；Rust37138110858工作流校验失败、零job，不能称Rust测试已通过或失败。完整收据绑定044e6b24；不按复合credential标题认定真实凭据fatal。

C01+C06唯一新主责为RUST-016-ci-security-portability，先修严格受控可移植目录、真实宿主编译输出、工作流上下文、Source05/08冻结原始片段与针对原因负例、保留Provider功能的依赖安全。node-forge官方公告无发布修复版；Node22原生raw-RSA兼容替代只是后续候选，当前未实施，不ignore/降低audit、不虚构版本或删Provider功能。

其它控件、成本、推送、索引、相邻领域、持久化兼容、平台媒体、live和Owner等10拟议Rust任务仅PLANNED/NOT_STARTED，来源及scope/DAG保留。转交仍OPEN。旧Source15的4051软件/2原skip及七包两普通CUA只引用未改收藏范围，不替代新产品或远端失败。C02、C03～C05、完整媒体/签名公证/x64/universal、安装/真实服务、旧录音Gate B/P4/P5、GE与Owner分别保留。

下一任务从本任务最终报告HEAD新建独立codex/分支；原015树保持封存，不迁真实数据或争用Core。本报告为push前快照，推送由已授权隔离审计分支在提交后身份核对完成；actual push/remote/clean另存外置AUDIT_PUSH收据，不补写旧报告历史。

## 回退

本期没有生产数据库、源文件或服务变更；代码/记录回退仅作用于本隔离分支，保留所有用户WIP。后续代码/数据库、Organizer文件journal和运行服务分别演练，不用旧备份覆盖新增用户数据，不以关闭feature撤销磁盘修改。main合并、正式App替换、发布及具体真实操作均未执行。
