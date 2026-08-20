# TASK-010 — 迁移到最小 pnpm workspace

## 目标

在 POC 已冻结后，将代码迁移为 `apps/desktop`、`packages/bridge-core`、`packages/contracts` 三 workspace；行为完全不变。

## 规则

- 先建立迁移映射，不重写业务代码。
- 保留所有 POC 测试与 CLI 实机能力。
- 依赖版本不升级。
- 提交 pnpm lockfile；npm lockfile 的去留写迁移说明。

## Exit Gate

- 根 `pnpm verify` 通过。
- Headless POC 仍可运行。
- 无循环依赖。
- contracts 不导入实现层。
