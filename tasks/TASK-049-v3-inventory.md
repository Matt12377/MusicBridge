# TASK-049：V3 库存领域、账本与录入

## 身份与授权

- Owner 目标“全部开始”授权按 V3 TODO 全阶段推进；保持线性依赖与真实验收边界。
- 基线 `5ed814a7f65bc02c200039379006929f4aced112`，分支 `codex/task-049-v3-inventory`。
- 上一 TASK-048 自动通过，正式页面体验与既有 V2 对比度 carryover 保留。

## 范围

SQLite 库存仓库、型号/版次/时长 SKU、批次数量、唯一实体编号、幂等事务账本；安全的公开合同与 Main/Preload/Core 通路；正式收藏页面录入、详情、补充库存、单盘实例化/旧录音登记、预留/取消及可用状态和保护规则。同一版次不同时长归为一个型号；未知不自动转成空白。真实录音完成、擦除与归池暂不开放，永久身份及历史不被抹掉。

## 允许修改

- `packages/contracts/src/{collection.ts,index.ts,ipc.ts,validator.ts,errors.ts}` 与 `test/validator.test.ts`。
- `packages/bridge-core/src/collection/`、`src/{runtime.ts,utility-main.ts}`；`test/{collection-repository.test.ts,utility-ipc.test.ts,runtime.test.ts}`。
- `apps/desktop/src/main/{index.ts,startup-test-config.ts}`、`src/preload/{api.ts,index.ts}`。
- `apps/desktop/src/renderer/src/components/collection/` 与 `composables/useCollection.ts`。
- `apps/desktop/e2e/v1-ui.spec.ts`、`test/{preload.test.ts,startup-test-config.test.ts,renderer.test.ts}`。
- 本任务定义、索引、`project/{WAVE-5.yaml,STATUS.json,V3_EXECUTION_PLAN.md}`、`docs/adr/ADR-009-v3-collection-storage.md`、`reports/TASK-049_RESULT.md`。

## 验收

1. 合同正反例及真实生产 IPC 断言 RED → GREEN，不以环境失败代替。
2. 8 → Pool 7 + Copy 1；Legacy Used 转出守恒；重复命令、并发相同命令、失败回滚、进程重开不双计、不复用 ID。
3. 冲突的命令 ID/版本、负数、小数、过量、未分类库存、保留线与受保护型号被拒绝且无写入。
4. 模型与时长正确归组；列表和详情有界分页；所有记录在应用私有 data 目录，未接入或损坏时明确错误，不清库、不拖垮 V2。
5. 正式 UI 可录入并在重启后读取；合成测试使用独立临时目录及真实 SQLite 实现，不写用户库存。
6. 新增行为与既有 V2 回归、security、Electron Gate；实现/报告/STATUS 分开提交。只记 Gate C 已覆盖子项，不把完整导入/目录 Gate C 标 PASS。

不改歌词规则，不接真实 Roon/账号/音乐目录/声卡，不 push 或发布。F-01 留待相关音频执行/归档阶段确认。
