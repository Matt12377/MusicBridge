# TASK-050：实物照片与收藏墙结果

## 范围与身份

本任务实现型号/已有单盘实物照片、原生导入、代表图、收藏墙筛选及 SQLite schema 1 → 2 迁移。图片不增加库存、不批量分配编号、不修改原文件。下一任务继续实体音乐库，Roon 双向关系单独验证。

基线 `71eca199f2678c9dfe6ba765193e09ef4207d89a`；分支 `codex/task-050-v3-collection-photos`。实现提交 `542d8cd2c18890cda32046c848b433165a80cbc8`；本报告独立提交，报告 SHA 由后续 STATUS 锁定提交记录。TASK-051 从最终锁定 HEAD 建立。

## 实现

- 原生文件选择器只读 PNG/JPEG 普通文件：25 MiB、4000 万像素、单边 16000 上限；头部与原生解码两层校验，缩到最长边 1200，JPEG 85，展示副本最多 1 MiB。
- 型号最多 24 张；可绑定已有单盘，校验归属。相同展示字节、相同归属去重。SHA-256、BLOB、照片引用和账本同事务；不存来源路径、文件名或原图 EXIF。
- 首图默认代表图，可切换、移除并回退；图片读取校验 Hash。读取失败不冒充空库，可重新加载。
- 收藏墙按关键词、品牌、年代在分页前筛选；Vue 筛选数据转为普通对象再进 IPC。
- 新增类型化业务 API、Main 白名单、Preload/Core 验证。现有播放、歌词与设备选择逻辑不修改。

## RED、调试与验证

照片入口先在正式 Renderer 中复现缺失按钮；原库存已真正入库。另覆盖 IPC 未识别/筛选未生效、照片读取失败后的重试入口。编译或非法 fixture 失败不作为行为 RED。

并发回归捕获首次 `PRAGMA user_version` 的 SQLite 261 恢复锁冲突。将有界 busy timeout 前移至首次读取前；添加持锁子进程测试并验证并发相同命令仍只提交一次。两条并发测试重复 10 次通过。

第一次完整 E2E 为 29/30：快速关闭再打开弹窗时，旧 close 通知清空了当前 preview。新增延迟通知故障注入，确定性 RED 后只在仍关闭时清理；完整照片流程重复 3 次通过。没有增大超时或跳过断言。

所有最终命令使用 Node 22.23.2 / pnpm 10.17.1，按 verify → security → Electron → E2E 顺序运行。

| 检查 | 结果 |
|---|---|
| verify（类型、单元、生产构建） | exit 0；Contracts 31、Core 448、Desktop 167，全部通过 |
| security | exit 0；22/22 |
| Electron 生命周期 | exit 0；4/4 |
| 完整 Playwright | exit 0；30/30 |
| control-plane / boundaries / cycles | PASS / PASS / PASS，102 files；control-plane 仍检查 WAVE-3 |
| diff / 暂存检查 | exit 0 |

正式 Electron 使用合成图片验证 PNG/JPEG 导入、取消、非法文件、去重、1200×750 尺寸、代表图/回退、单盘归属、失败重载、移除取消、原文件字节不变及完整应用重启持久化。UI 在 720/1440 宽度检查无横向溢出；弹窗/新增页面 axe critical/serious 为 0，键盘打开关闭和焦点返回通过。查看了截图，图片等比显示；合成图不代表实物照片审美验收。

最终日志 `/tmp/musicbridge-task-050-final2-{verify,security,electron,e2e}.log`，本地证据 `reports/runtime/task-050-final-2b1clorq/`。失败证据保留于 `reports/runtime/task-050-full-e2e-dialog-red/`、`task-050-dialog-close-red/` 和既有照片/重试 RED 目录。未删除用户旧 test-results。

## 两阶段自查与边界

先核对任务规格、图片归属/库存守恒/迁移/原文件只读及错误恢复，再检查事务、有限读取、验证器、IPC 白名单与组件生命周期。由主代理自查，未使用子代理，不宣称独立审查。

真实照片、Roon、录音设备和 Owner 验收均未执行；完整 A～E/U Gate 不标 PASS。PRD 仍 FREEZE_PENDING。无 push、main 合并、签名、公证或发布；远端 main 核验为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，无远端本任务分支。

保留 TASK-049 跨应用重启未确认命令 outbox、F-01 执行资产保留策略、TASK-047 真实歌词验收、V2 闲置设备提示对比度。旧侧栏在窄窗后切回宽窗的收起状态有文字裁切视觉现象，侧栏未在本任务修改，后续总体验收复查。原版实体库、Roon 关系、音频引擎与归档尚未因照片任务完成。
