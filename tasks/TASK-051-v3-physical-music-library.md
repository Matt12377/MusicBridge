# TASK-051：实体音乐库与旧录音内容

## 身份

Owner 持续授权全部开发；基线 `7bd3d6fbf07079f683e00c615afbfe92fa475f31`，分支 `codex/task-051-v3-physical-music-library`。

## 范围与验收

- 原版 CD/磁带独立发行版 UUID，艺术家、专辑、版次、年份、厂牌、目录号、条码、地区、碟数、曲目、包装/品相、数量、位置、购买备注、照片；允许 Basic/Partial/Verified，明确为用户确认。
- 旧录音内容绑定已有 recorded Physical ID，保留历史补录来源，不新建实物、不伪造 Formal Recording。空白/未知副本不能直接补成录音。
- 同库分页/搜索/介质筛选；两种入口进入同一单盘。原版和自录明确分开，自录只计一盘；缺失内容明确标记。
- Schema 2 → 3 同库迁移及回滚；新增不可变音乐操作账本、命令幂等、revision 冲突。图片仍用有界展示副本，与库存图片区分归属。
- 正式 Main/Preload/Core/UI，原生照片选择复用 TASK-050；离线可读写实体数据。不改 V2 Library 或播放。
- 先记录正式 UI/IPC 行为 RED；覆盖 CRUD 补录、数量守恒、迁移、原命令重试、重启和窄窗/键盘/axe；完整 verify/security/Electron/E2E 与控制面检查。

## 允许修改

`packages/contracts/src/{physical-music.ts,collection.ts,index.ts,ipc.ts,validator.ts}` 与既有 validator 测试；`packages/bridge-core/src/collection/`、`src/utility-main.ts` 和既有 collection-repository/utility-ipc 测试；`apps/desktop/src/main/index.ts`、preload api/index、collection 组件与相关 composable、既有 preload/renderer/E2E 测试；TASK-051、索引、WAVE-5/STATUS/执行计划、ADR-011、结果报告和忽略的运行证据。

## 边界

TASK-052 紧接实现 Roon 双向关系、明确缺少状态、Provenance 与 Collection Matrix；本任务显示未关联，不凭名称猜测 Exact 或 Physical Only。正式新录音/J-Card 发布由后续录音归档完成。跨重启未确认命令 outbox 仍须后续补齐。F-01、真实账号/源目录/设备及 Owner 验收未授权，不 push/合并 main。

单盘合同增加可选 recordingTitle，只投影历史内容标题，满足型号详情直接展示录了什么；不改变 Physical ID 或库存状态。
