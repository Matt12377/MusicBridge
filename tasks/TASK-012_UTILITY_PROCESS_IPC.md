# TASK-012 — Bridge Core utilityProcess 与 typed IPC

## 目标

让现有 Bridge Core 在 Electron utilityProcess 中运行，通过 contracts 定义的 MessagePort/IPC 与 Main 通信。

## 规则

- Core 不导入 Electron Renderer。
- 先实现 health/ping/state，不接 UI 功能。
- Main 监控 Core；崩溃自动重启最多一次。
- 所有消息 schema 校验、request id、timeout。

## Exit Gate

- Core ready/health/state 可在 UI 显示。
- 故意崩溃有确定状态和报告。
- Headless 测试仍通过。
