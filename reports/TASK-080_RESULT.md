# TASK-080 结果报告：Clean-clone 容量 Authority 接线

## 身份

- 分支：`codex/task-080-capacity-authority-harness`
- 基线：`d98eff24c0085ad8a340457f58dc3334709ca241`
- RED 提交：`85398f7cfb2eeb3b6cd71f368a62a84de13b4c5d`
- 实现提交：`bb421f55ddc8c0c5b7d3b1986e4e53a74624c290`
- PR #21 集成提交：`d98eff24c0085ad8a340457f58dc3334709ca241`

## 结果

TASK-080 的自动软件范围为 GREEN。clean-clone 入口仍可完成固定依赖安装、contracts 构建和实际 `os.tmpdir()` 空间预检，但不再直接启动容量 benchmark：

1. 没有 issuer 收据时，入口返回 `AUTHORITY_REQUIRED`，不启动 benchmark，也不输出正式容量 `PASS`。
2. 收据必须为 `ISSUED_NOT_EXECUTED`，并精确绑定 window SHA、候选 root/branch/HEAD、installed supervisor、consumer 可执行文件及唯一固定命令；任一漂移均 fail-closed。
3. 合法收据只会被消费一次；consumer 非零、signal 或 spawn 异常只报告 authority 消费失败，不生成容量分类。
4. Bridge Core benchmark 模块已删除可绕过 authority 的生产 `main`，仅保留纯编排测试缝；正式结论继续由既有 supervisor close/receipt 链形成。

## TDD 与验证证据

- 初始 RED：无 authority 时旧入口仍直接运行 benchmark 并返回 `PASS`，目标测试退出 1。
- 直接入口 RED：benchmark 模块仍含生产 `main()` 与 production dependencies，目标测试退出 1。
- 聚焦测试：`node --test scripts/ci/test/run-v3-capacity-clean-clone.test.mjs`，9/9 PASS，退出 0。
- 相邻 benchmark：`node --test --import tsx packages/bridge-core/test/capacity-clean-clone-benchmark.test.ts`，5/5 PASS，退出 0。
- Bridge Core typecheck：退出 0。
- 标准验证：Node v22.23.2 下 `corepack pnpm@10.17.1 verify`，退出 0。
- 静态 Gate：`CONTROL_PLANE=PASS`、`BOUNDARIES=PASS`、`CYCLES=PASS files=259`，均退出 0。
- 格式检查：`git diff --check`，退出 0。
- 干净提交上的真实 CLI：Node v22.23.2、无收据时空间预检 `READY`，输出 `CAPACITY_GATE=AUTHORITY_REQUIRED`，退出 4；未运行 benchmark。

默认 shell 的 Node v25.6.1 被入口按项目 Node 22 固定门槛拒绝为 `HARNESS_BUG`，随后使用固定 Node v22.23.2 完成上述真实 CLI 与全量验证；这不是产品失败，也未触发正式容量流程。

## 明确保留的边界

- 未签发、未消费任何新 authority/window。
- 未启动 installed supervisor、child 或105轮正式 benchmark；正式样本数仍为0。
- 未升级 Gate E 正式容量、Gate B、真实设备、真实 Roon、Logic、实体纸张或 Owner 产品验收。
- Ready/merge、正式窗口和发布仍是独立阶段；本报告只支持软件实现进入外部 Draft 评审。

## Carryover

外部评审通过后可独立决定是否将本分支合入 `v3-integration`。任何正式容量运行仍须基于届时精确候选 HEAD 做 fresh audit，由既有 issuer 唯一签发新收据，并在明确窗口内消费；历史 terminal/nonreplay 窗口不得重放。
