# TASK-051：实体音乐库与历史录音内容结果

## 结论与身份

原版 CD/磁带、历史自录同库浏览与编辑已接通正式 Main → Core → SQLite。原版保持发行版 UUID，旧录音保持原 Physical ID；补录不会增加库存或冒充正式录音完成。Roon 关系由下一 TASK-052 接入，不凭标题推断发行版或 CD Rip。

- 基线：`7bd3d6fbf07079f683e00c615afbfe92fa475f31`。
- 分支：`codex/task-051-v3-physical-music-library`。
- 实现提交：`48cb797ef9ccd895cd31babeb2c0d133b8b74faf`。
- 本报告独立提交；报告 SHA 由后续 STATUS 锁定提交记录。TASK-052 从最终锁定 HEAD 建立。

## 实现

1. Schema 2 → 3 增加发行版、历史内容、原版照片与不可变音乐操作账本；旧库存/照片/账本保持，失败整体回滚。
2. 原版字段涵盖艺术家、专辑、版次、年份、厂牌、目录号、条码、地区、碟数、曲目、包装/品相、数量、存放位置、购买备注、磁带类型及 NR。Basic/Partial/Verified 是资料阶段；Verified 明确为用户核实，需有版次。
3. CD 曲目按碟号，磁带按 A/B 面；历史 DAT 连续曲目。未知时长不推测。非法介质/分面、超量、额外路径与无效编号在合同/Core 拒绝。
4. 历史补录只允许已登记的 legacy recorded 副本；型号详情显示录音标题，可进入音乐详情并返回同一型号/单盘。自录每盘只计一次，不转成商业原版。
5. 原版照片复用只读原生选择器和有界展示副本；独立发行版归属、内容去重、移除确认。首张作为卡片代表图。照片不改变原文件或空白库存。
6. 分页/关键词/介质筛选在 Core 执行。UI 的发行信息、品相和曲目折叠显示；回执未知保留原命令重试，不把异常显示成成功。

## 行为 RED 与调试

正式 UI 的“添加实体音乐”按钮 disabled、正式 IPC 返回 UNKNOWN_IPC_COMMAND，均保留失败证据。历史内容已保存但型号详情没有 recordingTitle 的断言为另一行为 RED；增加只读投影后通过。

第一次实现检查发现原版照片 INSERT 的占位符数量与六列表不符，Core 事务测试捕获；修正后聚焦 51/51。Vue 模板收窄后遗留 music 判断导致类型失败，移除死分支。首次 UI 保存已成功，测试使用过窄的完整文本定位失败；另两处定位误选隐藏标签页编号/含选项文本的 label，按真实 region/combobox 角色修正。未放松数量、身份或持久化断言。

## 最终 Gate

所有最终命令显式使用 Node 22.23.2、Corepack pnpm 10.17.1；共享构建目录的 Gate 串行执行。

| Gate | 结果 |
|---|---|
| verify：类型、单元、生产构建 | exit 0；Contracts 32/32、Core 453/453、Desktop 167/167 |
| security | exit 0；22/22 |
| Electron 生命周期 | exit 0；4/4 |
| Playwright 全量 | exit 0；33/33 |
| control-plane / boundaries / cycles | PASS / PASS / PASS，104 files；旧 control-plane 仍检查 WAVE-3 |
| diff / 暂存检查 | exit 0 |

新增三条 E2E 覆盖：原版 CD 保存/编辑数量/照片/完整退出重启/筛选/原文件不变；旧录音 A/B 曲目双库往返与总量一盘；读取失败不显示空库、提交后回执丢失只保存一条。UI 及照片弹窗在 720/1440 下无横向溢出，音乐详情 axe serious/critical 为 0，键盘焦点返回通过。实际查看了合成数据截图，不代表 Owner 美观验收。

最终日志 `/tmp/musicbridge-task-051-final-{verify,security,electron,e2e}.log`；本地证据 `reports/runtime/task-051-final-idmn4qfl/`。入口/IPC RED、第一次界面定位失败和聚焦 GREEN 分别保留在 `reports/runtime/task-051-*`。没有删除用户原有证据。

## 自查与边界

先按规格核对身份、数量、历史/正式区分、迁移、离线与错误恢复；再检查类型化 IPC、输入/输出校验、事务幂等、分页及 UI 生命周期。主代理自查，未使用子代理，不声称独立审查。

真实账号、Roon、库存照片、录音硬件和 Owner 验收未执行。完整 A～E 与 V3 尚未完成，PRD 仍 FREEZE_PENDING。Roon 双向关系、正式新录音发布/J-Card 和跨重启未确认命令 outbox 尚待后续任务。F-01、TASK-047 真实歌词、V2 对比度与旧侧栏视觉 carryover 保留。

无 push、main 合并、签名、公证或发布。远端 main 核验为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，无远端本任务分支；下一任务沿当前最终锁定 HEAD 推进。
