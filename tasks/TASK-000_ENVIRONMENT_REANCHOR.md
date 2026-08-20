# TASK-000 — 环境与运行时重新锚定

## 目标

只确认开发环境和项目文件的真实状态，不实现任何功能、不安装 Electron。

## 必读

- `docs/09_MASTER_DEVELOPMENT_BLUEPRINT.md`
- `docs/10_LUNAMAX_OPERATING_PROTOCOL.md`
- `START_HERE.md`
- `package.json`

## 操作

1. 记录 macOS、CPU 架构、VS Code、Git、Node、npm 版本。
2. 确认 Node 为 22.x LTS；若不是，只报告，不擅自切换。
3. 列出项目目录与 Git 状态。
4. 检查 `.gitignore` 是否排除 `.env`、node_modules、dist、日志和音频文件。
5. 检查端口 38501/38502 是否被占用。
6. 不读取、不请求 Cookie。
7. 不执行 `npm install`；该动作属于 TASK-001。

## 允许修改

- 仅 `reports/TASK-000_RESULT.md`。
- 如果 `.gitignore` 存在明确的秘密泄漏缺口，可提出建议，但本任务不改。

## 验收

报告必须包含命令、原始版本摘要、工作区状态、端口状态和阻塞项。

## 停止条件

完成报告后停止，不开始 TASK-001。
