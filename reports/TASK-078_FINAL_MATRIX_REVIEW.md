# TASK-078 最终矩阵独立审查报告

## 结论

**PASS。P0 = 0，P1 = 0，P2 = 0。**

本报告只认证 TASK-078 矩阵索引、fresh 软件证据、候选身份和映射闭包。它不认证真实设备、真实 Roon/Provider、实体录制、听感或 Owner 验收；这些边界继续由 `externalGate = "NOT_RUN"` 与 `formalReady = false` 表达。

审查工作树：`/Users/yihe/VSCode/MusicBridge/worktree/task-078-v3-acceptance`

分支：`codex/task-078-v3-acceptance`

候选基线：`c54cf8b71b493482d8ad061d38123c444d718ad0`

## 审查对象

| 对象 | SHA256 |
| --- | --- |
| `project/V3_ACCEPTANCE.json` | `12f15170b25f578ba06d4def53060b58096fd57bf378d0e28f8ca2a7fe4ba944` |
| `reports/runtime/task-078-v3-acceptance/final-matrix-proposal-01.json` | `12f15170b25f578ba06d4def53060b58096fd57bf378d0e28f8ca2a7fe4ba944` |

本报告固化时，正式矩阵已经采用完成独立审查的 proposal；`cmp -s` 返回 0，两份文件当前字节级相同。审查阶段确认 proposal 相对原 pending 矩阵只录入 3 条 fresh evidence，并只把 101 个 mapped entry 的 `freshGate` 更新为 passed；来源条款、mapping、gap、external requirements、B-13/B-15 和顶层外部门边界没有改变。

## 证据身份与哈希闭包

| 对象 | SHA256 |
| --- | --- |
| `candidate-final-fresh-01.json` | `9d53a9719e21f812fc6adc5907f53fd691e3d44b4f18880e676e2d8834c5d290` |
| `run-fresh-gate.py` | `12c9e6193099c3122fc5bf61a71f0e850b8a9397d855a7266498885af6d8eccf` |
| `final-verify-01.log` | `80b3d255fbbe158510f7666ee26542a907a087f7f9b38bbd3f3643f2e3b119f0` |
| `final-verify-01.json` 收据 | `433c01b198bb04098674c96d6f44b62903d86724ebc7a5d3124c8efdce3e22bb` |
| `final-e2e-01.log` | `b8f00ca3e51e70c0f4ec07b8c20af7d031fb217bf7ba24c8f9700d538ac8a801` |
| `final-e2e-01.json` 收据 | `c6532f6aed6dda35fc522514a71da41a8758db8fda11b1ada17c3a8bfae115db` |
| `final-ingest-01.json` manifest | `df2de16ce4a7f8b4fe2d608ccb17c82322c7a9446fd22fa26251ad822b5602ad` |

独立检查得到：候选枚举 620 个文件，缺失 0，Git blob SHA 不匹配 0。两份收据的 `logSha256` 与日志一致，`runnerSha256` 与 runner 一致，`exitCode = 0`，`nativeGate = true`，`outputNativeGate = true`。这些 native 标志只表示启用了合成原生软件门，不构成真实设备认证。

## 矩阵与 case coverage

- entries：103。
- mapped 且 fresh passed：101。
- unmapped 且 fresh pending：2。
- failed：0。
- evidence：3 条。
- evidence cases：`110 synthetic + 7 software + 18 native-no-device = 135`。
- 唯一 mapped case 三元组 `(path, testName, evidenceKind)`：135。
- 唯一 evidence case 三元组 `(path, testName, kind)`：135。
- 两个集合精确相等；缺失 0、额外 0、重复 0、kind 错配 0。

边界条目保持如下：

| 条目 | status | freshGate | evidenceIds |
| --- | --- | --- | --- |
| B-13 | `unmapped` | `pending` | `[]` |
| B-15 | `unmapped` | `pending` | `[]` |

顶层状态保持：

- `externalGate = "NOT_RUN"`
- `formalReady = false`

## TAP `# todo 0` 解析复核

`final-fresh-ingest-draft.mjs` 允许 Node TAP 的零计数汇总行 `# todo 0`，但仍拒绝真实 TODO/SKIP：

- 普通全绿 TAP：接受。
- `test(..., { todo: "0" })`：Node TAP 同时输出 case directive `# TODO 0` 和汇总 `# todo 1`，整份日志被拒绝。
- 普通 TODO：被 `# TODO ...`/`# todo 1` 拒绝。
- SKIP：被 `# SKIP` 拒绝。
- mapped case 匹配层另行排除任何带 `TODO` 或 `SKIP` 的成功行，不能把 directive 行计为 passed case。

本次实际 inline 探针结果：

```text
pass             exitCode=0 accepted=true  todoSummary="# todo 0" skippedSummary="# skipped 0"
todoZeroReason   exitCode=0 accepted=false todoSummary="# todo 1" directive="ok 1 - todo # TODO 0"
todoReason       exitCode=0 accepted=false todoSummary="# todo 1" directive="ok 1 - todo # TODO later"
skip             exitCode=0 accepted=false skippedSummary="# skipped 1" directive="ok 1 - skip # SKIP"
```

正式 verify 日志中的三个 TAP 汇总分别为 186/186、1242/1242、643/643，均为 `fail 0`、`skipped 0`、`todo 0`；正式 E2E 日志为 `91 passed`。

## 实际运行的只读校验命令与退出码

### 1. 对象 SHA256

```bash
sha256sum project/V3_ACCEPTANCE.json reports/runtime/task-078-v3-acceptance/final-matrix-proposal-01.json reports/runtime/task-078-v3-acceptance/candidate-final-fresh-01.json reports/runtime/task-078-v3-acceptance/run-fresh-gate.py reports/runtime/task-078-v3-acceptance/final-verify-01.log reports/runtime/task-078-v3-acceptance/final-verify-01.json reports/runtime/task-078-v3-acceptance/final-e2e-01.log reports/runtime/task-078-v3-acceptance/final-e2e-01.json
```

退出码：`0`。

### 2. 正式矩阵与 proposal 字节比较

```bash
cmp -s project/V3_ACCEPTANCE.json reports/runtime/task-078-v3-acceptance/final-matrix-proposal-01.json
```

退出码：`0`。

### 3. 正式矩阵严格 fresh validator

```bash
node scripts/ci/verify-v3-acceptance.mjs --require-fresh
```

退出码：`0`。输出摘要：

```text
entryCount=103 mapped=101 unmapped=2 pending=2 passed=101 failed=0 externalGate=NOT_RUN formalReady=false
```

### 4. 精确集合与边界断言

```bash
python3 - <<'PY'
import json
from pathlib import Path
a=json.loads(Path('project/V3_ACCEPTANCE.json').read_text())
b=json.loads(Path('reports/runtime/task-078-v3-acceptance/final-matrix-proposal-01.json').read_text())
assert a == b
assert len(a['entries']) == 103
assert sum(e['status'] == 'mapped' for e in a['entries']) == 101
assert sum(e['status'] == 'unmapped' for e in a['entries']) == 2
assert sum(e['freshGate']['state'] == 'passed' for e in a['entries']) == 101
assert sum(e['freshGate']['state'] == 'pending' for e in a['entries']) == 2
assert a['externalGate'] == 'NOT_RUN' and a['formalReady'] is False
for entry_id in ('B-13', 'B-15'):
    e=next(x for x in a['entries'] if x['id'] == entry_id)
    assert e['status'] == 'unmapped' and e['freshGate'] == {'state':'pending','evidenceIds':[]}
inv={(m['path'],m['testName'],m['evidenceKind']) for e in a['entries'] for m in e['mappings']}
ev={(c['path'],c['testName'],e['kind']) for e in a['evidence'] for c in e['cases']}
assert len(inv) == len(ev) == 135 and inv == ev
assert sum(len(e['cases']) for e in a['evidence']) == 135
PY
```

退出码：`0`。

### 5. fresh ingest check-only 与非重放边界

录入前独立审查实际运行：

```bash
node reports/runtime/task-078-v3-acceptance/final-fresh-ingest-draft.mjs --manifest reports/runtime/task-078-v3-acceptance/final-ingest-01.json
```

录入前退出码：`0`，得到 `mapped=101 / passed=101 / unmapped=2 / pending=2 / externalGate=NOT_RUN / formalReady=false`，且 `productionMatrixWritten=false`。

正式矩阵采用 proposal 后再次运行同一命令，退出码：`1`，错误码：`PENDING_BASE_REQUIRED`。这是生成器的预期非重放保护：它只接受 evidence 为空、所有 freshGate 均 pending 的基矩阵；正式矩阵已录入后不能重复生成或覆盖。

### 6. Node TAP TODO/SKIP inline 探针

```bash
node <<'NODE'
const { spawnSync } = require('node:child_process')
const accepted = log => !/^\s*not ok\b/mu.test(log)
  && !/#\s*SKIP\b/imu.test(log)
  && !/#\s*TODO(?!\s+0\s*$)\b/imu.test(log)
  && !/^\s*[✘✖]\s+\d+\s+/mu.test(log)
  && !/^\s*[1-9]\d*\s+(?:failed|skipped|timed out|interrupted)\b/mu.test(log)
const samples = {
  pass: "const test=require('node:test'); test('pass',()=>{})",
  todoZeroReason: "const test=require('node:test'); test('todo',{todo:'0'},()=>{}); test('pass',()=>{})",
  todoReason: "const test=require('node:test'); test('todo',{todo:'later'},()=>{}); test('pass',()=>{})",
  skip: "const test=require('node:test'); test('skip',{skip:true},()=>{}); test('pass',()=>{})"
}
const expected = { pass: true, todoZeroReason: false, todoReason: false, skip: false }
for (const [name, source] of Object.entries(samples)) {
  const run = spawnSync(process.execPath, ['--test-reporter=tap'], {
    input: source, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }
  })
  if (run.status !== 0 || accepted(run.stdout) !== expected[name]) process.exit(1)
}
NODE
```

退出码：`0`。

## 执行边界

本轮只编辑本报告。未修改源码、`project/STATUS.json` 或矩阵；未运行完整 verify/E2E/Electron/App 等重型 Gate；未操作真实设备、真实账号或凭据；未 push。
