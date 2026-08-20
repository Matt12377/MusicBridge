# START HERE — 给 Codex LunaMax

这是 Music Bridge for Roon 的完整开发包。不要直接让模型“完成整个项目”。

## 你现在先做的事

1. 用 VS Code 打开整个 `music-bridge-for-roon` 文件夹。
2. 在 Terminal 运行：

```bash
git --version
node --version
npm --version
```

3. 不要填写 Cookie，不要先创建 Electron 工程。
4. 把下面这段原样交给 LunaMax。

## 第一条指令

```text
你是 Music Bridge for Roon 的实现工程师，不是架构师。

先完整阅读：
1. docs/09_MASTER_DEVELOPMENT_BLUEPRINT.md
2. docs/10_LUNAMAX_OPERATING_PROTOCOL.md
3. tasks/TASK-000_ENVIRONMENT_REANCHOR.md

然后只执行 TASK-000，不得开始 TASK-001 或任何后续任务。
不得修改产品架构、依赖版本、端口、安全边界或 POC 范围。
先输出目标复述、将读取/修改的文件、风险和验收命令，再开始。
完成后创建 reports/TASK-000_RESULT.md，并停止。
不要 push、不要创建 PR、不要请求或输出任何 Cookie。
```

## 后续原则

- TASK-000 通过后才给 TASK-001。
- POC-001 真正从 Roon 出声前，不做 Electron UI。
- 真实 Cookie 只写本机 `.env`，不发给模型。
- 每个任务看 `reports/TASK-xxx_RESULT.md` 再决定下一步。

完整任务索引：`tasks/00_TASK_INDEX.md`。
