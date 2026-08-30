# TASK-056：源帧证据、不可变母版与布局版本

## 身份与结论

基线 `d64f2b2979b580b2771efea4cb6b935806f17dea`；分支 `codex/task-056-v3-master-layout-versions`；实现提交 `a3d6274f21181ed10d01a83cc820552a976bc58f`。报告独立提交，报告 SHA 由下一 STATUS 锁定提交记录。下一任务从最终锁定 HEAD 创建。

本地最终自动验证通过。真实 Source Roots、Provider/Roon、设备、正式录音及 Owner 产品接受没有执行；完整 Gate A～E 未通过。没有 push、main 集成、签名、公证或发布。远端 main 核验为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，无 TASK-056 远端分支。

## 实现范围

- WAV/AIFF/FLAC 有界技术头部探测保存容器声明的精确采样帧数。旧快照兼容，但缺帧证据不能进入本次冻结；没有把容器声明冒充完整解码认证。
- 独立 MasterContent 和 LayoutVersion。冻结曲目、全局曲序、源内容 SHA-256、技术证据及 Transition；分面、容量、Lead-in/Tail、规划采样率变化不创建另一母版。源重新定位不改变内容身份。
- Planned Timeline 保存源绑定引用、源帧数/时基、每面曲目起止帧、静音、容量和 Hash。采用整数有理数 nearest-half-up-v1；五秒在 96 kHz 精确为 480000 帧，末曲/跨面不多加，空面无留白。
- 后台冻结任务逐首完整重验授权源 Hash/技术帧证据，再核对全部源可用、草稿/规划/预留与版本谱系。撤权立即通知读取任务中止；变化、撤权、取消均阻止提交。
- Schema 8 原子写入母版、布局、任务完成状态和追加账本；失败完整回滚。冻结表与账本禁止 SQL UPDATE/DELETE。稳定 commandId 重试不重复创建；未完成任务重启后 interrupted，不自动重读或重播。
- 正式 Renderer → Preload → Main → utility Core → SQLite 接线。录音页提供版本入口、创建/复用提案、显式确认、取消、状态及历史。历史曲名/时间线读取冻结内容，不按当前草稿重新解释。

## 最终验证

环境：显式使用 Node 22.23.2 和 Corepack pnpm 10.17.1。所有文件、库存和 Roon 元数据均为隔离合成数据。实际 Electron/Main/Core/SQLite 通路不等于用户音乐或真实设备验收。

| Gate | 结果 |
|---|---|
| `corepack pnpm@10.17.1 verify` | exit 0；最终 typecheck、单元测试及生产构建通过 |
| Contracts / Core / Desktop | 39/39、526/526、168/168；无失败、取消或跳过 |
| `test:security` | exit 0，22/22 |
| `test:electron` | exit 0，4/4 |
| 完整 Playwright | exit 0，44/44；最终候选完整重跑通过 |
| 母版冻结正式 E2E | 精确源、预留、确认、回执丢失重试、冷启动历史一致性 |
| 1440/720 面板 | 无横向溢出；局部 axe critical/serious 为 0；关闭恢复触发器焦点；最终截图已查看 |
| control-plane / boundaries / cycles | PASS/PASS/PASS，123 files；control-plane 仍针对旧 WAVE-3，WAVE-5 身份单独核对 |
| `git diff --check` | exit 0 |

## RED 与诊断证据

1. 源证据原本丢失 44101 帧，只保留舍入后的 1000ms；新增测试失败，增加独立精确帧字段后通过。合同也拒绝仅有帧数、仅有证据类型或帧数与采样率/时长不一致。
2. 版本仓库初始不存在的断言、正式 IPC 返回 undefined、Preload 精确允许列表和正式 UI 缺少版本按钮均取得失败证据。新 planner 模块缺失仅记为脚手架诊断，不作为行为 Gate。
3. 撤权测试先证明仍在读取的版本任务没有收到 abort，接入内部撤权通知后通过；草稿/预留冲突最初误报 IO_ERROR，修正为 INPUT_CHANGED。
4. PRD 附录复核要求 Planned Timeline 直接保存逐曲 source_binding_id；原字段缺失测试失败，补齐后进入最终重跑。
5. E2E 夹具最初把现有 native picker 返回值误当包装对象，以及错误假定单专辑有两首歌，均先修正测试夹具；这些环境失败不算产品 RED。采样率 select 精确标签补充 aria-label 后，原流程断言不变并通过。
6. 六个旧迁移测试通过“删掉新表”模拟旧 schema，但遗漏新版本表，导致迁移重建冲突；补全旧 schema 夹具，保留原业务数据/账本与回滚断言，没有在生产迁移中放宽保护。
7. 初始 shell 默认 Node 25 与工程要求不符，诊断后所有最终 Gate 显式在 Node 22.23.2 重跑；不以早期非标准运行作为最终证据。

## 两阶段自查与承接

先逐项对照 TASK-056 六项范围和 PRD Master/Layout/Planned Timeline 条款，检查来源证据、内容/布局身份独立、确认边界及历史不变；再检查迁移事务、幂等、撤权/取消、冷启动、IPC 合同、生命周期清理与 UI 焦点。没有子代理，自查不等于独立审查或 Owner 验收。

所有 Layout 仍为 `executionReady=false`。当前容量是磁带标称容量，不是实测安全录制容量；规划采样率不是设备认证。内容/布局 Frozen 不是 RecordingPlanVersion、Compiled Asset、Prepared Master 或正式录音许可。

完整 Gate D 仍有 Logic Preparation/PREP、RenderTimeline/Conformance、Execution Derivative、Plan 兼容性和 Profile/Artwork/J-Card Snapshot。下一任务继续独立 Logic Preparation Workspace，再接 PREP 导入与实际 Marker 确认；F-01 不由本任务选择。单盘之外的多介质 Layout、Source Picker 实体/数字关系入口、通用跨重启 outbox、归档/备份、参考目录/Excel 和完整 A～E、Owner 验收保留在 V3 总目标内。

当前版本数量有界（每草稿 100 个母版/布局、1000 个任务）。UI 支持会话内原请求重试，后台任务/冻结历史支持冷启动读取；不宣称通用 outbox 已完成。已完成历史不因源撤权或当前草稿变化被删除。

本地证据：`reports/runtime/task-056-final-607kl1m3/`。测试生成的 `apps/desktop/test-results/` 在提交前保留到该忽略目录，不纳入 Git。TASK-047 真实歌词、V2 两项视觉 carryover、用户数据/硬件、main/push 和发布边界保持不变。
