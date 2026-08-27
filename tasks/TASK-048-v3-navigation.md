# TASK-048：V3 收藏与录音导航基础

## 授权与身份

- Owner 于 2026-08-27 认可 Preview 02 并授权开始开发。
- 基线：`b0e1ff8ec83ac9aaebbe90e8ecb14c4a5832e7f4`，即 V3 文档准备提交。
- 分支：`codex/task-048-v3-navigation`；工作树：`worktree/task-048-v3-navigation`。
- 本任务仅正式 Renderer 导航与页面基础，A～E 技术 Gate、真实设备及录音均不执行。

## 交付与验收

1. 现有侧栏新增“收藏”“录音”两入口；原 Roon 收藏明确命名，不丢弃 V2 入口、播放器或设备选择。
2. 收藏页提供空白磁带收藏、实体音乐库两个可键盘切换的视图；离开再回来保留本次会话选项，搜索取消也回到正确视图。
3. 录音独立页面展示从选曲到库存推荐、预检的顺序。未接入的选曲/录入/正式录音明确不可用，不假造成功、库存数量、已有照片或录音记录。
4. 不增加 V3 概览页、设备页、第二套侧栏或旧五区域导航。母版/录音记录为录音页的次级位置。
5. 通过实际 Electron Renderer 行为验证导航不调用播放变更 IPC，不停止现有合成播放、不换 Zone、不改队列；底部播放器保留。
6. 720×480 与 1440×900 页面无内容横向溢出，键盘焦点可见，新增 V3 页面关键/严重 axe 问题为零；既有整页检查继续运行。V2 闲置播放器未选设备提示的对比度问题已通过主页对照复现，作为明确 carryover，不扩本任务生产样式范围。

## 允许修改

- `apps/desktop/src/renderer/src/App.vue`
- `apps/desktop/src/renderer/src/components/navigation.ts`
- `apps/desktop/src/renderer/src/components/sidebar/MusicSidebar.vue`
- `apps/desktop/src/renderer/src/components/sidebar/SidebarNavRow.vue`
- `apps/desktop/src/renderer/src/components/sidebar/SidebarIcon.vue`
- 新建 `apps/desktop/src/renderer/src/components/collection/CollectionView.vue`
- 新建 `apps/desktop/src/renderer/src/components/recording/RecordingView.vue`
- `apps/desktop/e2e/v1-ui.spec.ts`
- `tasks/00_TASK_INDEX.md`、本任务定义、`project/WAVE-5.yaml`、`project/STATUS.json`、`reports/TASK-048_RESULT.md`

不改 Main/Preload/IPC/Provider/Roon 适配器、公开合同、数据库、现有歌词逻辑、包版本和锁文件。不导入 `prototypes/` 资源或样例库存，不连接真实账号和声卡。

## 验证与交付纪律

先新增现有 E2E 中的行为测试，在尚无新入口的正式构建上取得断言 RED，再实现并复跑 GREEN。运行 `verify`、`test:security`、`test:electron`、完整桌面 E2E，以及 control-plane / boundaries / cycles 和 `git diff --check`。旧 control-plane 验证器仍校验 WAVE-3；本任务额外核对 WAVE-5 与 STATUS 的任务/分支/base 一致。

实现与结果报告分别本地提交；报告提交身份用后续 STATUS 锁定提交记录。无 push、main 合并、发布或真实录音。下一任务候选为库存领域、持久化与录入，应单独明确 Schema、幂等转移及照片安全边界；本任务不提前实现。
