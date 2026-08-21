# TASK-024：V1 同步歌词

## 目标

在固定 Provider `@neteasecloudmusicapienhanced/api@4.40.1` 的 `lyric_new` 能力上，增加受限的 Now Playing 歌词读取与同步。歌词只存在内存和公开合同中，不进入 Roon metadata、原生歌词 UI、日志或持久化数据库。

## 合同

公开合同只允许以下有限字段：

- `LyricsStatus`：`idle | loading | ready | instrumental | unavailable | error`。
- `LyricWord`：`startMs`、`endMs`、`text`。
- `LyricLine`：`startMs`、可选 `endMs`、`text`、可选 translation、romanization、words。
- `LyricsSnapshot`：`status`、`lines`、`activeLineIndex`、可选 `activeWordIndex`、`timingSource`。
- `timingSource`：`roon-time | estimated | static`。

不暴露 Provider 原始响应、Cookie、上游 URL、Provider key、内部 ID、账号资料或完整歌词原文到日志/报告。

## 解析与同步

- 支持 LRC 行时间戳、实际存在的 YRC/逐字时间、翻译、罗马音、纯音乐/无歌词、乱序、重复、未知字段和 malformed rows。
- 对行数、文字长度、逐字数量和总内存设置上限；超限安全截断或转为 `unavailable`。
- 优先使用可靠的 Roon Audio Input `Time`；否则使用以 Playing 为锚点的单调时钟并标记 `estimated`；两者都不可靠时只显示 `static`，不伪造逐字同步。
- 以 playback generation 和 track identity 防止旧请求覆盖当前曲目；stop/next/previous 必须使旧请求失效。
- active line 推送频率不高于每 250ms；使用最多 50 首曲目的内存 LRU，不落盘。

## Gate

自动测试和本地 capability smoke 必须覆盖：普通歌词、翻译、实际存在的逐字时间、instrumental/unavailable、malformed/oversized、乱序/重复和 stale switch。报告只记录布尔 capability，不记录歌词正文或曲目标识。

实现提交：`feat: add synchronized NetEase lyrics`。

报告：`reports/TASK-024_RESULT.md`；报告提交：`docs: record TASK-024 verification`。
