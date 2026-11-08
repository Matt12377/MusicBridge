# 本地 FLAC 歌词读取与严格匹配兜底

## 身份与范围

- 分支：`codex/mousa-4-1-local-flac-lyrics`
- Base：`e7d1bacc784c8fd0807f4a5cf67bdc5853799460`
- 实现提交：`6a21c32de7268a137e41355cf4f1828df4d5b623`
- 报告提交：包含本报告的提交；下一独立任务从该最终 HEAD 创建。
- 本轮增加有界 FLAC Vorbis 同步歌词读取，并在有效本地不可用结果后复用既有严格版本匹配与人工选择。保留原 Source/FD/ticket/attempt/generation 保护，不改音频、登录保险库或 Tailscale。

## 工程验证

| 检查 | 结果 |
| --- | --- |
| 定向 Core 回归 | 192 passed / 0 failed / exit 0 |
| 定向 Desktop 回归 | 16 passed / 0 failed / exit 0 |
| Core、Desktop、Desktop E2E typecheck | 各 exit 0 |
| control-plane、boundaries（真实 Git 工作树） | 各 exit 0 |
| Production build、arm64 package | 各 exit 0 |
| ASAR 内全部 38 个编译输出字节对照、静态 native pins、fresh media worker | PASS / exit 0 |
| 包签名 deep/strict 检查 | exit 0 |
| 包内 FLAC 定向回归 | 3 passed / exit 0 |
| 隔离启动、utility crash/restart、mock vault、mock recovery | 4 gates PASS |
| 验证镜像与官方构建镜像 native 输入 | 17 个 Git 绑定文件字节相等，各目录归属身份分别核验 PASS |

跨镜像目录归属 ID 最初被错误地要求相等，附加检查因此失败；代码证明其为真实路径/dev/inode 身份而非内容摘要。更正为分别验证归属并逐个比较 Git 原生源输入后通过，没有放宽产品完整性 Gate。早期测试配置/Buffer 类型错误均已修正后重跑；归档无 Git 历史的 control-plane 错误由真实工作树 Gate 校验闭合。

## 产物与安装边界

- Production arm64 build：`20261108.132224`。
- ASAR SHA-256：`d75a3dddf9d034462af6a072a12d1858514822f9ae65f0b5568c05dbd46f1c11`。
- 已提供应用归档；Owner 随后表示已自行替换。另以只读方式核对安装包版本与 ASAR 摘要一致。
- 代理自动安装尝试在正常退出等待超时后停止，尚未执行删除/覆盖；未强杀。不能将 Owner 自行安装写成代理安装成功。
- 自动验证全为合成数据/隔离 profile，没有真实 Provider、真实 Roon 控制或真实听感验收。Owner 正常使用与真实曲目反馈独立于自动 Gate。

## Bounded carryover 与后续

Owner 后续实际文件反馈揭示：常见 LRC `id` 元信息被严格解析器拒绝；另一有效同名 LRC 的文件层读取正常，但原播放会话失败点尚未闭合。不得把本轮合成测试 PASS 扩展为全部真实曲库歌词验收。后续独立分支补充兼容性、原会话链路诊断及多份 WAV 只读抽样，不修改音乐/LRC，不自行重启或替换 App。

本轮未执行 main 合并或 GitHub push；对应远端任务 ref 未发布。远端状态在交接时只读复核，不输出远端 URL 或凭据。
