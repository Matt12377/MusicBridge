# WAVE-2 阶段验证报告

## 当前结论

**WAVE-2：PARTIAL，TASK-023 实机高阶 Gate carryover。**

TASK-020、TASK-021、TASK-022 已有各自报告并完成对应 Owner Gate。TASK-023 自动 Gate、Core Mac 部署、运行健康与 Electron App 重启恢复已通过，但需要真实播放或真实故障触发的场景尚未全部执行，因此 WAVE-2 暂不能标记为完整 PASS。

## 阶段组成

| TASK | 当前状态 | 依据 |
|---|---|---|
| TASK-020 | PASS | 真实扫码授权与重启恢复已记录 |
| TASK-021 | PASS | 真实桌面库界面 Gate 已记录 |
| TASK-022 | PASS | 两首歌曲自然完整播放、Signal Path 无损、队列结束无残留已记录 |
| TASK-023 | PARTIAL | 自动 Gate、部署与 App 重启恢复通过；真实错误/降级场景待 Owner 实机操作 |

## Git 与远端

- 阶段分支：`codex/wave-2-desktop-core`
- 当前 HEAD：`91abdce2b38db54e292189e16e88d5a99bcfa034`
- 本地与远端分支：本轮部署前已一致；本轮报告变更提交后将再次核对
- TASK-023 实现提交：`bb69fd9b891c192ce8032d93b7aae0383eccece9`
- 此前“未部署新提交”的文字属于提交前记录；本报告已补入本轮部署证据。
- 未创建 PR、未合并、未 force-push。

## 自动阶段 Gate

- `corepack pnpm@10.17.1 verify`：PASS
- Contracts：12/12 PASS
- Bridge Core：127/127 PASS
- Desktop：26/26 PASS
- TypeScript 类型检查：PASS
- 生产构建与未签名 arm64 App 打包：PASS
- Desktop startup / Core crash 自动 Gate：PASS
- safeStorage credential vault 自动 Gate：PASS
- `corepack pnpm@10.17.1 doctor`：PASS
- `git diff --check`：PASS
- `package.json` 与 `pnpm-lock.yaml`：无变化
- 自动化秘密字段与日志脱敏测试：PASS

## Core Mac 部署与运行态

- 当前运行 release：`91abdce2b38db54e292189e16e88d5a99bcfa034`
- bundle SHA-256：`ae23ccf9b041d7df30c3c5220d9da6147d4916c8fc6bee89fc37a8dd02ce9699`
- release metadata：commit、bundle、ASAR 匹配，权限 `600`
- 旧 Music Bridge App：已停止；新 App：已启动
- Bridge health：PASS
- Provider：`configured`
- Roon：`ready`
- `activeStreamCount=0`
- `activePlayback` 不存在，播放状态 `idle`
- 38501/38502：仅 loopback 监听
- Roon Core：未停止、未重启
- 本地 staging/archive 与远端临时 archive：部署后均已清理

## Electron App 重启恢复

本轮在不触碰 Roon Core 的前提下停止并重新启动当前 App：

- App 旧进程停止：PASS
- 新 App health：PASS
- Provider 状态恢复：PASS
- Roon ready 恢复：PASS
- 活动流/活动播放保持归零：PASS
- loopback-only 保持：PASS

## TASK-023 尚未关闭的实机 Gate

以下项目的自动 Gate 均已通过，但本轮没有擅自播放歌曲、注入真实 Roon 故障或破坏真实登录状态：

1. 实际音质降级提示。
2. 过期播放地址的一次刷新。
3. Roon `MediaError`。
4. Roon `ZoneLost`。
5. Provider 登录过期与恢复。
6. 真实曲目元数据/封面读取。

这些项目需要 Owner 安排测试歌曲或人工操作；不能用 Fake 或旧 POC 证据替代。TASK-030 暂不可开始。

## 阶段安全边界

- 未执行歌曲播放、队列播放或 `POST /v1/play`。
- 未停止、未重启 Roon Core。
- 未读取或输出凭据、账号资料、二维码内容、配置文件内容、完整播放地址或 Provider 原始响应。
- 未修改端口、loopback-only 安全规则、Roon 配对、Provider 依赖或产品架构边界。
- 未开始 TASK-030 及之后任务。

## 最终状态

**WAVE-2：PARTIAL，TASK-023 实机高阶 Gate carryover。**

TASK-023 报告已同步本轮真实部署、运行态和 App 重启恢复证据。等待 Owner 决定是否安排剩余真实 Gate；在 TASK-023 关闭前不开始 TASK-030。
