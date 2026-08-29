# TASK-078：V3 全链路自动验收结果

## 身份与结论

- 基线：`c54cf8b71b493482d8ad061d38123c444d718ad0`
- 分支：`codex/task-078-v3-acceptance`
- 实现提交：`2656b904a168e6afcbfddc5453d8793d347710d7`
- 冻结候选：620 个受控文件，SHA-256 `9d53a9719e21f812fc6adc5907f53fd691e3d44b4f18880e676e2d8834c5d290`
- 报告提交：待本报告提交后由最终身份提交锁定
- GitHub：未 push；未合并 `main`；未签名、公证、安装或发布

TASK-078 的**本地自动软件子范围**通过：双 native 全量验证、Security、Electron mock、完整 E2E、控制/边界/循环、16 个固定 native pin 和 101 条 mapped fresh 证据均已得到新鲜退出码与原始日志。正式 V3 整门仍未通过：B-13、B-15 未映射，Gate B、真实设备、真实资料、实体打印和 Owner 接受均保持 `NOT_RUN`，`formalReady=false`。

## 主要实现

1. 为 R020 拆分 60 秒完整 Core 启动期限与 2 秒普通 IPC 期限，保持同代私有恢复 client、换代撤权与有界退出；补生命周期探针和测试专用 mock/system 钥匙串模式，生产默认仍为 system。
2. 贯通同一 7 盘合成数据集的库存、双库、Record、Replica 历史核验、真实 Main 打印 worker、J-Card、完整备份、隔离恢复、显式激活、旧 scope 拒绝、手动 reload 与再次冷启。浏览或恢复不自动重绑、不重放。
3. 修复未来 J-Card 的屏幕预览滚动条；旧 Artifact/PDF 不重写。实际 PDF 为 3 页、292.5×288pt，独立解析与 144 DPI 栅格检查通过；不冒充纸张、裁切或盒型验收。
4. 建立 R023 容量 fixture、父进程监督、generation/measure/queued-stop/print-write/cold/full-recovery 阶段与不可重放窗口证据。
5. 为 Attempt/Record/Print 增加有界对象审计证书、严格等价 raw 格式校验、receipt 前缀与预算凭证；未知写、外连接、DDL/PRAGMA、beforeCommit、rollback、COMMIT 失败或身份变化均回退完整审计。
6. 新回执复用已认证旧 Artwork/PDF 时，未认证回执仍强制读取 raw 重建指纹；已认证历史回执才可走 metadata 快路径，修复 4 条 Print 备份回归。
7. 建立 103 条验收索引与 fail-closed 校验器，绑定权威来源、精确测试声明、冻结候选 Git blob、原始成功行、收据、日志 SHA 和证据类型。

## 最终自动 Gate

| Gate | 结果 | 证据摘要 |
| --- | --- | --- |
| 双 native `pnpm verify` | PASS，exit 0 | Contracts 186/186、Bridge Core 1242/1242、Desktop 643/643；三包 0 fail、0 skip，生产 build PASS。fresh log SHA `80b3d255…`，receipt SHA `433c01b1…` |
| Security | PASS，exit 0 | 29/29，0 skip；fresh log SHA `ade3f487…` |
| Electron mock | PASS，exit 0 | 4/4，0 skip；fresh log SHA `fccbb4ed…`；明确不证明系统钥匙串 |
| Playwright E2E | PASS，exit 0 | 91/91，单 worker，mock keychain，双 native；fresh log SHA `b8f00ca3…`，receipt SHA `c6532f6a…` |
| 控制面 / 边界 / 循环 | PASS，均 exit 0 | `CONTROL_PLANE=PASS`、`BOUNDARIES=PASS`、`CYCLES=PASS files=259` |
| 矩阵规则 | PASS，exit 0 | 19/19，0 skip |
| 固定 native pin | PASS，exit 0 | `NATIVE_PINS=PASS count=16`；只核验，未重建 native 文件 |
| 103 条 strict fresh | PASS，exit 0 | 101 mapped passed、2 unmapped/pending、0 failed；`externalGate=NOT_RUN`、`formalReady=false` |
| 独立 fresh 矩阵审查 | PASS | P0/P1/P2 均为 0；135 个唯一 mapped case 与 evidence case 精确相等；[审查回执](TASK-078_FINAL_MATRIX_REVIEW.md) SHA `a550c5cd…` |

fresh verify 与 E2E 前后四次冻结候选均为同一 SHA。两份日志分别为 501,497B 与 14,510B，无 ANSI，低于 16MiB 上限。E2E 使用独立绝对输出目录；已有 `apps/desktop/test-results` 7 个文件最终与运行前逐文件 SHA 清单一致。

## RED 与修复证据

- Bridge Core 全量曾有 4 条 Print 备份测试失败：新、未认证的 complete receipt 复用旧对象 metadata 时拿不到 raw，无法重建回执指纹。修复后聚焦 94/94、Bridge Core 非 native 全量 1241 pass/1 个显式 opt-in skip，最终双 native 全量为 1242/1242、0 skip。
- 最终 native verify 首轮只剩一条 Desktop 静态断言失败。生产 `onReady(client)` 与生命周期探针顺序正确，测试仍匹配旧的 `onReady()`/外层 supervisor。更新语义顺序断言后定点 4/4、typecheck 与完整 verify 通过。
- fresh ingest 首轮把 TAP 正常汇总 `# todo 0` 误判为 TODO。收窄规则后接受零汇总，仍拒绝真实 `# TODO`、`# SKIP`；同一 manifest 严格 ingest 通过。
- 两次 E2E 路由探针发现根脚本和额外 `--` 不会把 output 选项按预期交给 Playwright。完整 91/91 与中断部分输出都原样保留；默认目录每次先完整保留，再从 runtime 中找到的逐字节相同副本恢复。最终改用 desktop 直达、无多余分隔符的命令，独立输出与默认目录保护均通过。

## R023 容量结果与限制

- history-limit 的 generation、measure 与 large queued-stop 已在独立窗口通过；失败、超时、慢样本和不可重放窗口均保留，没有回填或覆盖。
- objects-small 的 cold、完整备份、full recovery 与 queued-stop 已通过；Print claim/write 正式窗口 105/105 成功，正式 claim/complete 最大值均低于 2 秒。
- objects-limit 的共享对象证书与 10/25/50 records 非正式阶梯通过。阶梯生成耗时分别为 6.485s、16.586s、36.006s，Print 对象字节分别为 41,945,600、104,864,000、209,728,000，呈近线性增长；这不是正式容量 PASS。
- objects-limit 正式 window-02 未签发。2026-08-29T13:01:27.099079Z 的准入快照为可用 13,353,312,256B；计划生成 9,623,411,100B 并保留 10GiB 安全余量，要求 20,360,829,340B，短缺 7,007,517,084B。未降低阈值、未创建窗口、未签 authority、未重放 window-01。
- joint 正式大窗口继续等待 objects-limit 线性前置与安全存储准入；小档和非正式阶梯不替代它。

## 明确保留的外部门

- `B-13`：正式音频输出通知音隔离没有生产输出后端与专门实机证据，保持 unmapped/pending。
- `B-15`：真实设备、软件或缓冲配置变化后的证书失效与重新认证没有生产 Certified 记录，保持 unmapped/pending。
- 当前没有设备连接。Owner 后续计划使用 RME 或 Apogee 声卡与 Sony 卡座，但型号、连接、采样率、缓冲和测量配置尚未确定；本任务没有枚举、打开或配置设备。
- Gate B、真实 HAL、可听 Replica、正式录音、系统钥匙串、真实 Roon/Provider、用户 Source Roots/Excel/照片/资料、Logic、实体纸张/盒型和 Owner 产品/视觉接受均为 `NOT_RUN`。
- 旧系统钥匙串无 CDP 普通 Quit 失败证据保留；mock keychain 的正常退出只证明隔离软件路径。

## 接续

TASK-079 只能从 TASK-078 的最终身份提交建立。无设备时可继续准备真实环境清单与只读前置检查；任何真实声卡、卡座、输出、录音或 Owner 接受必须等待设备接入和明确操作范围。
