# TASK-029：V1 完成控制面、CI 与契约冻结

## 基线

从 `wave-2-passed` 的最终提交创建 `codex/task-029-control-plane-ci`。本任务只建立 V1 的控制面、CI、安全扫描和固定 Provider wrapper contract tests，不改变产品行为、端口、Provider 版本、Roon 边界或 Stream Gateway 行为。

## 必须完成

1. 将 Lyrics 从 V1.1 Could 提升为 V1 Must/Should，并把 TASK-024、TASK-029 写入任务索引。
2. 建立根 `AGENTS.md`、`project/STATUS.json`、`project/WAVE-3.yaml`、`project/RISK_REGISTER.md` 和 ADR-004/005/006。
3. 建立 verify、security、electron-e2e 三个 GitHub Actions workflow。
4. CI 覆盖 Node 22、固定 Corepack/pnpm frozen lockfile、workspace tests/build/typecheck、cycle/boundary/security/loopback/secret/URL/query/audio/download/transcoding scan、production audit、合成 Electron startup 和 utilityProcess crash/restart。
5. 直接加载固定的 `@neteasecloudmusicapienhanced/api@4.40.1` module wrapper，以 Fake `request()` 验证 login status、QR key/create/check、search、liked/account、playlist/list/detail/tracks、song detail、song URL v1、lyric_new 的真实包装形状和请求边界。
6. CI 与本地等价命令不得读取真实 Provider 凭据、账号资料或连接真实 Roon。

## Gate

- 原有测试全部保留且通过；新增 wrapper contract tests 全部通过。
- `node scripts/ci/verify-control-plane.mjs` 与 `node scripts/ci/verify-boundaries.mjs` 通过。
- CI YAML 语法与本地等价命令通过；没有新增依赖或 lockfile 漂移。
- `git diff --check` 通过；工作区干净；报告不含秘密、用户内容、完整 URL 或内部地址。

实现提交：`chore: establish V1 completion control plane and CI`。

报告：`reports/TASK-029_RESULT.md`；报告提交：`docs: record TASK-029 verification`。
