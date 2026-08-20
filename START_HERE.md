# 从这里开始

这个压缩包不是“已经完成的播放器”，而是 **Music Bridge for Roon / POC-001 的可执行开发起点**。

最省事的使用方式：

1. 把整个目录交给 Codex。
2. 让 Codex 先读 `docs/05_CODEX_TASK_POC-001.md`。
3. Codex 只做 POC-001，不要提前做扫码登录、歌单、SwiftUI 或 Apple Music。
4. POC 必须在 **运行 Roon Server/Core 的同一台 Mac** 上做第一次实机验证。
5. 完成后，Codex 应提交 `reports/POC-001_RESULT.md`，附测试输出、Roon 扩展截图、Signal Path 截图与失败项。

在本目录运行：

```bash
cp .env.example .env
npm install
npm run doctor
npm run verify
npm run dev
```

另开一个终端：

```bash
npm run play -- <网易云歌曲ID> lossless
npm run state
npm run stop
```

详细步骤见 `docs/06_RUNBOOK_MACOS.md`。
