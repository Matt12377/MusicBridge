# TASK-079 真实 Gate 运行手册

状态：**PREPARED / NOT RUN**。本手册固定未来真实资料、设备与 Owner 验收的取证顺序；它没有枚举、打开或配置设备，也没有读取真实资料、Logic、Roon 或凭据。当前候选仍为 `formalReady=false`。

## 1. 身份与证据边界

- 任务基线固定为 `fac7363b4a6481591e207dda7cca77f0ae8d3cd4`；每次实际窗口另记录候选 Git SHA、冻结授权 SHA、测量计划 SHA 和匿名环境指纹。任一身份漂移即停止，旧证书不沿用。
- Git 只保存 `project/V3_OWNER_EVIDENCE_TEMPLATE.json`。实际收据与原始产物固定留在忽略目录 `reports/runtime/task-079-v3-final-acceptance/`，不得写入真实目录、设备序列号、账号、Zone、Cookie、Token、绝对路径或原始命令行。
- 设备只用 `interface-01`、`recorder-01` 等匿名别名。配置 seal 必须覆盖后端/驱动/固件版本、匿名设备单元、线缆路由、声道映射、样本格式、采样率、缓冲、时钟、输出电平、转换器、dither、匿名物理目标、匿名测量装置、校准 Hash 与测量计划 Hash；禁止序列号、系统 UID、主机名或真实路径。
- 技术收据和 Owner 观察分开。技术 PASS 不生成 Owner accepted；Owner accepted 也不能覆盖技术 pending/failed。任何单份收据都保持 `ready=false`。
- 每个运行窗口按不透明 ID 在忽略目录 `receipts/` 新建独立收据，禁止覆盖旧窗口；不把真实值回写跟踪模板。固定校验入口为：

```bash
node scripts/ci/verify-v3-owner-evidence.mjs --receipt-id <匿名收据ID>
```

入口只从固定本地根按安全 ID 解析收据。每份技术收据的全部附件必须位于 `receipts/<receipt-id>/` 独占窗口；逐组件拒绝软链接/硬链接并在读取后复核组件身份、大小和 SHA-256，同时拒绝收据或附件被 Git 跟踪。附件当前只允许严格 UTF-8 的 JSON/plain/CSV；JSON 在解析转义后扫描敏感键和值，未实现安全元数据解析前不接受 WAV/PNG/PDF。失败只输出稳定错误码，不打印私密值。默认无参数入口只校验空模板，输出独立的 `V3_OWNER_EVIDENCE_TEMPLATE=PASS`，不能与真实收据通过混淆。

技术 PASS 的 `caseEvidence` 必须与唯一 `case-evidence` JSON 附件逐字节语义一致；B-13 捕获、B-14 三层事件和 B-15 旧证书还要解析各自独立附件交叉验证。`failed/timed-out/stopped/inconclusive` 必须保存对应的非 PASS 事实并使用 Gate 白名单 reason code，不能仅修改 verdict。Owner accepted 只接受已有首次 seal、同候选/tree/矩阵且更早的技术 PASS；rejected/deferred 与技术 PASS 正交，可在技术失败或未运行时如实保存。

正式 CLI 不信任 candidate manifest 自报的聚合摘要：它从 manifest 列出的每个受控相对路径读取精确 `candidateCommit:<relativePath>` Git blob，逐文件重算 SHA-256，再复核聚合摘要。候选提交不存在、路径重复/越界、blob 缺失或任一摘要不符时都拒绝。收据、授权、Plan、Preflight 与 B-14 三层事件的时间戳必须是规范 UTC ISO（`YYYY-MM-DDTHH:mm:ss.sssZ`）；仅能被 `Date.parse` 解析但不规范的文本不能进入证据链。

Readiness CLI 还会在当前 TASK-079 Git 仓库中核对证据基础设施检查点：分支必须正确，每个 base/实现/报告/最终 SHA 必须解析为真实 commit，两段链必须按祖先关系线性连接，最后一个 candidate closure 必须是当前 HEAD 的祖先。只复制 STATUS 文本、交换提交顺序或指向另一个仓库不能通过。

receipt seal 用独占创建、`fsync`、回读和同 ID 不同内容拒绝来发现正常历史漂移；它不是数字签名，也不对抗拥有本机文件写权限的恶意用户同时删除或替换收据与 seal。若未来需要该威胁模型，必须引入 Owner 控制签名或外部只追加账本，不能把本地 seal 描述成不可抵赖证明。

## 2. 准入顺序

每个步骤必须有独立收据；前一步不是 PASS 时不执行下一步。

1. Owner 明确本次只读资料范围及设备操作范围；凭据由 Owner 交互输入，不进入聊天、Shell 参数、日志或收据。
2. 冻结候选、真实资料匿名清单、Backend/Profile/版本、声卡/卡座/线缆/路由、采样率、声道、缓冲、时钟、输出电平及可丢弃介质。
3. 冻结测量计划：共同单调时基或校准关系、故障注入时刻、输出端无声判据、测量误差、每类样本数、超时与失败保留策略。
4. 新建 Plan/Preflight，确认未自动切换设备、系统扬声器、Roon Zone、来源或当前 Attempt。
5. 先执行 Gate A、C、D、E 所需真实输入/库存/谱系/持久化前置；精确引用各自收据身份后才进入 Gate B。
6. Gate B 全部 B-01～B-15 在同一冻结配置族完成；配置指纹改变时立即降为未认证，另开新窗口。
7. 再执行真实录音、可听 Replica、J-Card 实体打印、U-01～U-10 产品场景。
8. Owner 对冻结矩阵 103 项逐条记录 accepted、rejected 或 deferred。只有聚合器未来独立复核全部技术 Gate 与 Owner 决定后，才有资格讨论 `formalReady=true`；本手册不提供升级入口。

## 3. Gate B 逐项取证

| ID | 操作 | 必须保存的独立证据 | PASS 条件 |
|---|---|---|---|
| B-01 | 三首固定源编译 | 源匿名清单、Execution Asset/Manifest Hash、帧级核验 | Formal 播放前完成；运行时零逐首转换 |
| B-02 | 两个默认曲间边界 | 最终执行文件逐帧/逐样本报告 | 每段零样本为 `Fs × 5`；96 kHz 时各 480,000 帧 |
| B-03 | 带原始首尾静音源 | 编译前后静音段位置与帧数 | 原静音保留，听感间隔不被误判 |
| B-04 | 已含间隔的 Prepared Render | Render 合规结论与 Derivative 谱系 | 合规时不再加 Gap；不合规时新建独立 Derivative |
| B-05 | 混合采样率/格式 | 转换配置、最终格式、完整谱系 | 编译期统一；运行期不切布局或采样率 |
| B-06 | Smart/在线回退/Shuffle/Radio/普通队列 | 每种禁止路径的负例与后端/来源身份 | 全部拒绝；失败不换源、不换后端 |
| B-07 | A 面结束 | 输出状态、Attempt 状态、人工翻面前快照 | 停在等待翻面；B 面未自动开始 |
| B-08 | DAT Continuous | 容量、配置与连续执行状态 | 不进入 A/B 流程；不声称未验证 Track ID 写入 |
| B-09 | Roon 外部切歌、Zone/输出变化 | 输出端测量、事件、Attempt 状态、禁止回退证据 | Interrupted；安全停止且不把外部接管当独占成功 |
| B-10 | 拔出声卡、路由/采样率变化 | 输出端测量、配置前后指纹、设备占用清理 | Interrupted；不回退系统扬声器/其他设备，不续播 |
| B-11 | 资产读取失败、网络故障、underrun | 输出端测量、失败事件、来源/后端不变证明 | Interrupted；无替代内容 |
| B-12 | 引擎/应用强退并重启 | 退出前后状态、进程组/设备占用、恢复结果 | 未结束 Attempt 恢复为 Interrupted；不 Completed、不自动新录音 |
| B-13 | 故障提示 | 正式输出捕获及独立通路说明 | 正式音频输出没有通知音；仅静默提示或已确认独立通路 |
| B-14 | EOF、设备排空、实体完成 | 三个互不替代的时间与回执 | 三层全部明确后才 Completed |
| B-15 | 修改设备/软件/缓冲配置 | 修改前后配置指纹及证书匹配结果 | 旧认证不覆盖新配置；新证据匹配或保持未认证 |

## 4. 输出端测量合同

B-09～B-12 每类故障必须从真实输出端保存逐样本原始数据及汇总，不能只保存汇总。B-13 的输出捕获、B-14 的三层回执与 B-15 的配置指纹是额外证据，不能被 B-09～B-12 的延迟样本代替。

- `T_detect`：故障实际发生到被识别。
- `T_engine_cutoff`：识别后停止提交新帧，所有必测样本最大值必须 `≤ 100 ms`。
- `T_backend_tail`：停止提交后，输出端达到冻结无声判据。
- `T_total = T_detect + T_engine_cutoff + T_backend_tail`：所有必测样本最大值必须 `≤ 2000 ms`。
- `T_physical_stop`：用户停止实体设备的时间，只能另行记录，不计入或替代引擎能力。

每段报告 `sampleCount`、`timeoutCount`、P50、P95、P99 和 max。统计必须从原始样本重算；任一超时、缺样本、测量误差缺失、分位数顺序错误、阈值超限或结果反推阈值时，PASS 收据拒绝。ACK、EOF、进程退出、UI 状态或 FakeDriver 不能作为输出端无声测量。

## 5. 当前待冻结配置

| 项目 | 当前值 | 状态 |
|---|---|---|
| 声卡品牌候选 | RME / Apogee | 仅计划，型号未定 |
| 录音机 | Sony 卡座 | 仅计划，型号未定 |
| 连接、路由、线缆 | 未提供 | PENDING |
| Backend/Profile/版本 | 未提供 | PENDING |
| 采样率、声道、缓冲、时钟 | 未提供 | PENDING |
| 输出电平、无声阈值、测量误差 | 未提供 | PENDING |
| 样本数、超时、故障注入范围 | 未提供 | PENDING |
| 可丢弃介质与实体停止方法 | 未提供 | PENDING |

品牌意向不是兼容性或认证证据。以上任一项未冻结时不得执行 Gate B。

## 6. 立即停止条件

- 操作超出 Owner 本次授权，或需要新的设备枚举、打开、路由、发声、录音、拔插、时钟/缓冲变化、故障注入。
- 真实资料/设备身份、候选、授权、Plan、Preflight、测量计划或共同时间基漂移。
- 出现系统扬声器/其他设备回退、Roon Zone/来源/Attempt 自动切换、非预期写入、通知音进入正式输出。
- 任一故障样本失败、超时、越过 100/2000 ms 阈值，或 ACK/EOF/进程退出被当成实际无声。
- 产物丢失、Hash/大小改变、路径越界或任一路径组件为软链接。
- 进程组、设备占用或输出未确认释放。失败与超时证据原样保留，不自动重试。
- 同一问题三次修复仍失败，停止第四次试修并转架构裁决。

## 7. 未完成项

本手册及空模板可验证不代表任何真实 Gate 已运行。当前仍未执行：真实 Source Roots/照片/Excel/Logic/Roon、Gate A～E、B-01～B-15 实机测量、正式录音、可听 Replica、实体打印、U-01～U-10 和 Owner 103 项决定。
