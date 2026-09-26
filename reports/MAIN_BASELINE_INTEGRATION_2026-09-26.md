# 最新开发线整合到 `main`：代码基线结果（2026-09-26）

> 开发线代码基线已非强制快进到远端 `main` 的 `6042a36e9a14e27e8da03c101bf20a847a90c94a`，并已核对远端身份。包含本文最终版本的报告提交及最后一次文档同步尚未发生；最终 `main` HEAD 须在该提交和推送后再解析，不能把代码基线 SHA 当作最终报告 SHA。

## 授权、身份与快进条件

- Owner 已授权本轮工作完成后将最新开发线整合到 `main`。本次准备工作在 `/Volumes/LifeWeave/VSCode/MusicBridge/worktree/v3-ui` 的独立分支 `codex/main-baseline-integration` 进行；创建草稿前 HEAD 为 `6042a36e9a14e27e8da03c101bf20a847a90c94a`，该提交也是已推送的来源分支 `codex/roon-display-favorites-fixes` 当前远端 HEAD。Roon Display/收藏修复的实现提交是 `1daefda790c32948663dc76ddbf75fbe1fdc319e`；实现、补充报告与整合报告不得混作同一身份。
- 快进准备时 `origin/main` 为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，是 `6042a36` 的祖先；`git rev-list --left-right --count origin/main...HEAD` 为 `0 333`，`origin/main...HEAD` 的摘要为 768 个文件、120325 行新增、3287 行删除，整条差异的 `git diff --check` 退出码为 0。主任务在推送前重新 fetch 并复核远端仍为 `90d0aa8`、祖先关系与整条差异检查，再以非强制 push 将 `6042a36` 快进到远端 `main`；`git ls-remote` 确认远端 `main` 为 `6042a36e9a14e27e8da03c101bf20a847a90c94a`。未被工作树检出的本地 `main` 也通过 CAS `update-ref` 从 `90d0aa8` 推进到同一 SHA；本地 `main` 与 `origin/main` 目前一致。未创建 PR。
- **代码基线已合入，报告同步尚待完成**：`1daefda` 到 `6042a36` 的 Desktop、Bridge Core、Contracts、根 package 与 lockfile 生产路径无差异，安装版来源与已合入生产源码一致；本次最终报告只增加文档和状态记录，不改变产品实现。后续由主任务对包含本文最终版本的提交再次核对身份，以非强制方式同步到 `main` 与 `codex/main-baseline-integration`，并核对远端最终 HEAD。本文件不预写那次报告提交或 push 的结果。
- 原有未跟踪 `apps/desktop/test-results/`、`prototypes/metafine-study/` 保持原状，不纳入报告提交、不清理。本文及 `project/STATUS.json` 的本轮对象只记录控制面状态，保留文件中全部既有历史。

## 验证结论与两次远端尝试

- 来源修复分支已推送；针对实现 SHA `1daefda790c32948663dc76ddbf75fbe1fdc319e` 的远端 `security` 与 `verify` workflow 均为 success。完整 Electron E2E 的 [run #36235829560 attempt 1](https://github.com/Matt12377/MusicBridge/actions/runs/36235829560/attempts/1) 为 failure：94 pass、1 fail、4 skip。唯一失败停在 `task-067.spec.ts` 刷新后等待 `load` 的 30 秒超时，后续业务断言没有运行。
- verification 使用 Node 22.23.2 / pnpm 10.17.1 完成新鲜生产构建，`task-067` 的“回执落盘失败与 Renderer 刷新”定向用例 1/1 pass（3.0 秒），命令 exit 0；日志在 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-task067-7KnF8w/task067-local.log`。没有修改生产或测试源码。这是局部复测，不抹去首轮远端失败，也不能证明完整 Electron E2E 已通过或超时根因已修复。
- verification 仅对原 run 的失败 job 重跑一次。[run #36235829560 attempt 2](https://github.com/Matt12377/MusicBridge/actions/runs/36235829560/attempts/2) 的 head 仍是 `1daefda790c32948663dc76ddbf75fbe1fdc319e`，于 2026-09-26 11:07:16 UTC 完成、结论 success；全部 job steps 为 success，Playwright 单 worker 运行 99 项，95 pass、4 skip（8.3 分钟），原 `task-067` 刷新用例在 9.7 秒通过。两次 attempt 分开保留；一次失败后成功不能反推首次超时的根因，亦不声称源码或夹具通过修改得到修复。
- 本文件未发起新构建、测试、真实 Provider/Roon 操作或本机 App 操作；不能把本次祖先/差异检查写成工程或验收 Gate。

## 安装版与验收边界

- 本机 `/Applications/Music Bridge for Roon.app` 已由独立部署步骤更新，其包内与安装版 `app.asar` SHA-256 同为 `a13c7e7c08caaea15a3c9e8623e1359aed9405ed6d1046406ee894bab9c235ec`，来源是实现提交 `1daefda`，不是待产生的整合报告提交。旧版保留于 `/Volumes/LifeWeave/Developer/CommandLine/Backups/MusicBridge/2026-09-26-9leUJG/Music Bridge for Roon.app`。ad-hoc 整包签名与隔离 mock 启动 Gate 通过，未做 Developer ID 签名或公证。
- 普通 `open -a` 后观察到安装路径下的主/Helper/Renderer 进程及 LaunchServices check-in；只读 UI 查询超时，未确认主窗口与壳层就绪。同期 `SecurityAgent` 在前台，未读取对话框内容，不能判定是否为本 App 的钥匙串提示。未输入凭据、绕过系统提示或操作真实播放。
- 合并 `main` 不会自动改变安装版、真实 Roon/Provider、音频设备、歌词听感或 Owner 验收状态。Roon Display/收藏修复的既定范围和无身份迟到歌词 carryover 仍以 [本轮修复报告](ROON_DISPLAY_FAVORITES_FIXES_2026-09-26.md) 为准；真实播放与 Owner 验收独立待办。

## 报告提交与最后同步待办

| 项目 | 当前状态 |
|---|---|
| 本地定向复测与远端 E2E | 本地定向 1/1、exit 0；远端 attempt 1 failure、attempt 2 success，均绑定实现 SHA `1daefda` |
| 开发线代码基线快进到 `main` | 非强制 push 完成；远端与本地 `main` 均核对为 `6042a36e9a14e27e8da03c101bf20a847a90c94a` |
| 整合报告最终提交及最后文档同步 | 尚未创建或推送；以包含本文最终版本的提交解析，完成后再核对 `main` 与整合分支远端 HEAD |
| 工作区与未跟踪保留复核 | 本文与 `project/STATUS.json` 为待提交文档；原有两个未跟踪目录保留，最终提交时再复核 |
