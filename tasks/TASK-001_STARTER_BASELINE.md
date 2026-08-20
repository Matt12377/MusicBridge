# TASK-001 — Starter 安装、lockfile 与自动基线

## 目标

在不改变功能和依赖版本的前提下完成依赖安装、生成 lockfile，并建立自动测试基线。

## 前置

TASK-000 为 PASS，Node 22.x 可用。

## 操作

1. 记录安装前 package.json 与固定 commit。
2. 执行 `npm install`，生成 `package-lock.json`。
3. 不升级任何依赖；若固定 Git 依赖无法安装，停止并报告。
4. 运行：

```bash
npm run doctor
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

5. 检查仓库不存在 `.env`、Cookie、音频文件和完整 URL。
6. 记录所有通过/失败，不为了通过删除测试。

## 允许修改

- `package-lock.json`
- 安装兼容所必需的最小配置修复（必须逐项说明）
- 测试或类型声明的最小修复
- `reports/TASK-001_RESULT.md`

## Exit Gate

- lockfile 存在且固定依赖未漂移。
- typecheck、test、build 通过，或明确 BLOCKED。
- audit 结果有记录。
