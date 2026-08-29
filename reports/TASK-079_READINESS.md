# TASK-079：无设备 readiness 阶段报告

## 身份与结论

- 基线：`fac7363b4a6481591e207dda7cca77f0ae8d3cd4`
- 分支：`codex/task-079-v3-final-acceptance`
- 工作树：`worktree/task-079-v3-final-acceptance`
- TASK-078 软件矩阵：SHA256 `12f15170b25f578ba06d4def53060b58096fd57bf378d0e28f8ca2a7fe4ba944`
- 实现提交：`1f102fba93e42d0f84b985c04d84af08b06b2231`
- 报告提交：`93feee20c2edbd027546b44cc908aee27ef785b1`
- GitHub：未 push；未合并 `main`；未安装、签名、公证或发布

本阶段完成的是**无设备就绪控制面**，当前结论固定为 `READY=false`。验证器确认清单结构、TASK-078冻结身份、TASK-079控制身份和所有外部门保持fail-closed；它不认证声卡、卡座、真实输入、Logic/Roon、可听Replica、实录、实体打印或Owner接受。

## 实现

1. 新增 `project/V3_OWNER_ACCEPTANCE.json`：精确绑定TASK-078最终提交和冻结矩阵；Owner 103条决定全部为`pending`，`real-input`、`real-logic`、`real-roon`、`hardware`、`owner`五类全部为`not-run`，证据列表为空。
2. 新增 `scripts/ci/verify-v3-owner-readiness.mjs`：严格字段、固定矩阵SHA/基线、103/101/2实际内容、B-13/B-15、STATUS/WAVE身份、设备与外部门状态、相对路径及符号链接保护。默认模式验证“清单可信且仍阻断”；`--require-ready`在当前条件下必须失败。
3. 新增13项Node测试，覆盖身份和摘要漂移、矩阵与清单双改、fresh/B-13/B-15越级、Owner/外部项漏重或提前通过、设备品牌意向误升级、STATUS矛盾、文件/目录符号链接、未知字段和稳定错误码。
4. 新增TASK-079任务规格并更新WAVE-5、STATUS、任务索引和可见TODO面板。没有增加设备发现、设备操作、真实资料读取或自动验收入口。

## RED / GREEN

- RED-01：先运行新测试，因`verify-v3-owner-readiness.mjs`不存在而得到`ERR_MODULE_NOT_FOUND`、exit 1。
- GREEN-01：首轮实现后7/7通过；随后增加STATUS/WAVE身份与实际矩阵派生，9/9通过。
- RED-02：同计数篡改矩阵并同步自报hash时未被拒绝，定点测试9/10；加入冻结SHA硬锚后关闭。
- RED-03：独立SPEC审查指出STATUS外部门可与清单矛盾、CLI错误未归一和缺实际符号链接回归；新增RED后修复，最终focused 13/13通过。

## 当前验证

| 入口 | 结果 | 含义 |
| --- | --- | --- |
| Node 22 `--check` | PASS，exit 0 | readiness验证器语法有效 |
| Node 22 focused tests | PASS，13/13，0 skip | fail-closed结构、身份和回归用例通过 |
| readiness默认CLI | PASS，exit 0 | `ready=false`、Owner pending 103、外部not-run 5、设备未连接且未授权 |
| readiness `--require-ready` | 预期FAIL，exit 1，`READY_REQUIRED` | 当前外部条件不允许最终验收，不是自动Gate故障 |
| 标准 `pnpm verify` | PASS，exit 0 | typecheck、全部既有软件测试与production build通过 |
| 控制面 / 边界 / 循环 | PASS，均exit 0 | `CONTROL_PLANE=PASS`、`BOUNDARIES=PASS`、`CYCLES=PASS files=259` |
| `git diff --check` | PASS，exit 0 | 当前改动无空白错误 |

TASK-078严格fresh入口依赖其原工作树中未跟踪的runtime日志和收据；新工作树没有复制约3.6GB运行证据，因此该入口在这里会返回`PATH_UNAVAILABLE`。TASK-078已在原任务完成严格验证、独立审查和三提交封版；TASK-079以固定矩阵SHA、最终提交和103/101/2内容复核继承封条，不复制大证据、不重放fresh ingest，也不把缺少旧runtime解释为新失败或重跑授权。

## 仍未运行

- 当前没有设备连接。RME/Apogee仅为声卡品牌候选，Sony仅为卡座品牌计划；型号、驱动/固件、连接、采样率、声道、缓冲、时钟、电平、测量装置、共同时基、无声判据、样本量和故障矩阵均未冻结。
- `deviceOperationsAuthorization=NOT_GRANTED`；未枚举、打开、配置、发声、拔插、录音或注入故障，Gate B保持`NOT_RUN`。
- Source Roots、真实Excel、照片、Logic工程/Render、Roon/Provider会话和凭据均未读取。
- B-13、B-15保持unmapped/pending；系统钥匙串旧Quit FAIL、objects-limit/joint正式容量、可听Replica、实体纸张/盒型和Owner产品/视觉接受继续独立保留。

## 接续条件

设备接入后，先由Owner明确当次操作范围并冻结精确配置和测量计划，再按TASK-079规格依次执行真实资料授权、Gate B、Gate A/C/D/E真实样本、Replica/录音/打印和Owner逐项验收。任何缺样本、超时、超阈值、身份漂移或未预期设备/数据操作都停止；ACK、EOF、进程退出或FakeDriver不能代替输出端无声和实体停止证据。
