# TASK-043：LocalTrackSignature 与有界匹配仓库

## 目标

为 Roon 本地曲目建立不依赖 runtime reference 的稳定签名，并实现只保存 `CONFIRMED/MANUAL` 正向映射的有界、严格、原子仓库。

## 基线与分支

- 基线：TASK-042 合并后的最新 `main`。
- 分支：`codex/task-043-local-track-signature-repository`。

## 允许范围

- `packages/bridge-core/src/lyrics-matching/signature.ts`
- `packages/bridge-core/src/lyrics-matching/repository.ts`
- `packages/bridge-core/test/local-track-signature.test.ts`
- `packages/bridge-core/test/lyrics-match-repository.test.ts`
- 必要的 RuntimeOptions 依赖注入类型，不接真实 Resolver
- 本任务结果报告和 `project/STATUS.json`

不得新增网络请求、IPC、Renderer 或歌词加载逻辑。

## RED

至少覆盖：

- 同 title/artists/album/duration/version 在不同 Roon runtime reference 下得到相同 signature key；
- artists 顺序变化、重复值和 duration 的亚秒舍入差异保持同一 signature key；
- version、artist 或显著 duration 改变会改变签名；
- NFKC、大小写、有限标点和空白变化可规范化；
- 签名与持久记录不包含 item_key、runtime reference、媒体路径或歌词；
- 只接受数字 NetEase Track ID；
- 只持久化 `CONFIRMED/MANUAL`；
- schema、额外字段、超长字段、重复 key、非法时间戳或超限记录 fail closed；
- 4096 容量与确定性 LRU 淘汰；
- 自动记录 algorithmVersion 失效，MANUAL 不因算法升级失效；
- 并发 mutation 串行，写失败回滚内存；
- 临时文件、原子 rename、0600 文件和损坏文件拒绝覆盖。

## GREEN

- canonical signature 字段只有 title、artists、album、durationMs、version。
- signature key 使用 SHA-256 的 128-bit 十六进制投影。
- repository API 只提供 get/set/touch/delete/list-bounded，不暴露底层文件。
- `NONE/REJECTED/POSSIBLE/AMBIGUOUS` 只允许由后续 Resolver 放入内存 negative cache。
- 文件路径必须依赖注入；本任务不使用 `process.cwd()` 决定正式位置。

## Gate

- focused RED/GREEN；
- bridge-core typecheck/test；
- 临时目录权限和故障注入测试；
- `git diff --check`；
- 不得产生真实用户数据文件。

实现提交：`feat(lyrics): persist bounded local track matches`。

报告：`reports/TASK-043_RESULT.md`。
