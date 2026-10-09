# MBM-001 配对与只读曲库

从MBM-000最终报告R `c6c4745dfc7fe4242b8a2682798e00605649b12e`建立独立任务分支。现有Owner开发、验证、提交和普通推送授权持续有效，常规步骤不重复审批。

实施范围、固定政策与9项独立移动验收见 `docs/postrust/MBM-001/EXECUTION_SCOPE.json`、`MOBILE_ACCEPTANCE.json` 和 `REUSE_AND_INTEGRATION.md`。001实现受控私有HTTPS、设备配对/鉴权/刷新/撤销与只读目录/搜索/稳定分页/当前选图；既有loopback、Node默认、唯一SQLite作者、源只读与可选Rust读OFF保持。

先验证真实HTTP→auth→Owner→raw codec，覆盖失效/撤销/重启/回执/改库与跨scope负例，再检查正式App入口与生命周期。Root执行编译、测试、App、精确Source Gate、自然CI与独立报告/ordinary push，完整结果与退出码绑定精确提交。原18/156、有效17/150及013八项PARTIAL不变，真实服务/设备/音频/Owner单列。

交付后从最终R进入MBM-002；不提前开发002-004。
