# 本地歌词：SMB 重挂载签名与 LRC 元信息兼容修复

## 身份

- 分支：`codex/mousa-4-1-local-lyrics-followup`
- Base（前轮最终报告 HEAD）：`ae967c5a64896aed356afadba044718a24a26b70`
- 实现提交：`f1bf2bb7f5f36d19b17501073a459f5fb73fad36`
- 报告提交：包含本报告的最终提交；下一独立任务从该最终 HEAD 创建。

## 根因与修复

1. 普通播放已消费原 Owner 批准的 SMB 重新挂载证明，把历史 stat 签名中的已授权旧 dev 映射到当前 dev。歌词读取却把历史签名直接交给通用元数据租期，因 `CONTENT_CHANGED` 在旁置歌词 stat 之前退出。同一文件实际存在、LRC 可解析也会失败。本轮只在普通本地歌词入口复用 `sourcePlaybackExpectedSignature`，不改历史观察、SQL、Source 授权或通用元数据/旧录音租期；实际 FD、命名位、其余四字段、原 ticket/currentness、deadline 及释放责任保持原保护。
2. 严格 LRC 元信息白名单缺少常见 `id` 标签，使整份同步正文无效。本轮兼容 `id/length/language/tool` 非时序元信息；不据此声明网络来源、猜编码或伪造时间。坏 offset、坏时间戳、纯文本、控制符、非法 UTF-8 继续整体拒绝。

原文件级测试此前只证明独立文件能读，不能等同于应用原播放票据的读取成功。本轮追加了原目录记录的只读比对和 Owner 真正签发票据的合成复现，区分证据层级；没有伪造真实 SourceFacts 或播放 ticket。

## 自动验证（全部合成，无真实账号/曲库）

| 检查 | 结果 |
| --- | --- |
| 修复前新增复现 | 4 个预期失败、1 个保护用例通过 / exit 1 |
| 修复后定向 Core（9 个文件，含原 Owner v1/v2、剩余 stat 字段、根绑定/撤权/过期、旧录音与真实 Rust 元数据读取保护） | 85 passed / 0 failed / 0 skipped / exit 0 |
| 定向 Desktop 歌词/来源回归 | 27 passed / 0 failed / 0 skipped / exit 0 |
| Core typecheck（含本轮测试） | exit 0 |
| Desktop 与 E2E typecheck | exit 0 |
| fresh Reader 编译源/工具/输出声明首末重核 | 未漂移 |
| control-plane、boundaries、diff check | 各 exit 0 |

首个新增合成 fixture 误用了已有库根的重叠目录，被原保护正确拒绝。改为独立临时目录后重新做红绿对照；未放宽目录保护。镜像首次独立诊断缺 contracts 编译输出，补齐固定编译后成功；不是产品故障。自动 Gate 未使用后述真实文件抽样。

## 独立真实文件只读抽样（非 CI、非 Roon/听感验收）

- 两个不同专辑目录内 12 份 WAV，另加一份反馈涉及的 FLAC，共 13 份。
- 所有样本历史签名在旧读取方式下均触发 `CONTENT_CHANGED`；原重挂载证明只映射 dev 后，其余四字段精确匹配。
- 11 份 WAV 与 1 份 FLAC 成功取得同名 LRC（共 12 份 ready）；另 1 份 WAV 确实无同名 LRC、包内真实 Rust reader 也返回零嵌词候选，正确报告无本地同步歌词，不伪造或强行算通过。
- 两个反馈样本分别得到 77 与 42 行同步正文；另有一个 WAV 样本同样被旧 `id` 白名单拒绝，新解析器得到 68 行。
- ready 文件读取耗时 5–19 ms。无词哨兵含冷启动 Native Worker 共 1823 ms，仍在原 2000 ms 预算内，只读 272 字节音频元数据；没有读取 PCM、整文件 hash、解码、Provider 或播放控制。
- 每件结束零未释放租期；原音频/LRC 不写入，应用数据库仅 read-only/query-only 读取原目录/扫描事实，没有 SQL 写操作。不把真实文件路径、标题、歌词或账户信息放入本报告、STATUS 或 Git；逐件收据仅存放任务私有目录。

## 构建与交付

- Production arm64 build：`20261108.143009`，实现源固定为上述实现提交，干净官方 Git 构建镜像；Electron `43.4.0`。
- 生产编译、打包、38 个包内编译输出逐字节对照、17 个 Native Git 输入与验证镜像对照、Native 归属/摘要、应用与交付副本 deep/strict 签名、最终 ZIP 完整性均 exit 0。
- 另外直接核对实际 ASAR 的歌词函数：常见元信息、原观察映射、受保护 FD 消费映射后的签名、原 Owner ticket 调用四项均 PASS，不以源码测试替代包内实现身份。
- 隔离启动、utility crash/restart、mock vault、mock credential recovery：4 gates PASS / exit 0；独立合成 profile 和 mock keychain，不接触真实账号、Roon 或实际 profile。
- ASAR SHA-256：`5671a5bf5e707bd661a2d3a5ade664b10159a9741fefdd9c4818f0864a91cc05`。
- ZIP SHA-256：`d2f17c34336987071ad19eee615ea5976f744a746605a4fd678906a3a2d9336f`。
- 初次打包因子进程找不到裸 `pnpm` 入口而失败，尚未进入包验证。补充任务私有的固定 Corepack/pnpm `10.17.1` 入口后，在全新输出目录重打包通过；原失败目录保留，没有覆盖/删除或绕过 Gate，不修改全局工具配置。
- 归档内为 `Mousa.app`，仅交付候选。运行中的 App 未替换、退出或重启。
- 任务分支普通 push 与远端最终 HEAD 在报告提交后独立核对，结果记录于任务私有交接收据；不把构建成功等同于 main 合并或生产安装。

## 验收边界

未调用真实 Provider 或真实 Roon 控制，没有真实听感/播放会话最终验收，不写 Owner 接受。原 G0、历史播放/录音/登录验收 carryover 不因本轮合成 Gate 自动放行。Tailscale 未更改。安装和 main 合并未执行。
