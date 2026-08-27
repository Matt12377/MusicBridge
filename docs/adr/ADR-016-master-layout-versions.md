# ADR-016：不可变母版、布局与源复核

状态：TASK-056 采用；不代表完整 Gate D、录音执行 Plan Freeze 或输出认证通过。

## 背景

TASK-055 的规划使用毫秒估算并明确 `executionReady=false`。V3 要求内容身份与物理布局独立，冻结曲序不能被分面操作静默改写。源容器精确帧数也不能从舍入后的毫秒反推。

## 决策

- `SourceTechnical` 增加可选 `sampleFrames` 和 `frameEvidence=container-declared`，旧源快照仍可读取。新的冻结必须具备配对帧证据；缺失时要求重新校验。WAV 数据块、AIFF COMM 和 FLAC STREAMINFO 提供容器声明帧数，不声称逐帧完整解码。
- `MasterContent` 冻结全局曲目顺序、元数据、源 SHA-256/大小/技术信息、逐曲 Transition 与 Keep With Next。内容摘要不包含私有路径、定位 ID 或验证时间，相同内容重新定位不会创建另一内容身份。
- `LayoutVersion` 引用一个 MasterVersion，锁定 Cassette A/B 或 DAT Program、标称容量、逐曲源绑定引用、起止帧、静音、物理预留快照与 Planned Timeline Hash。只改分面、Lead-in/Tail、介质容量或规划采样率复用母版；改曲序、源内容或 Transition 提出新母版并明确确认。
- 每个 Layout 有显式规划采样率。源帧数采用整数有理数 `nearest-half-up-v1` 换算，不累计浮点误差；同面边界添加 Gap，末曲/跨面不添加，空面不添加 Lead-in/Tail。后续编译器必须对照该计划验证实际输出帧数，不得只复用规划数值宣称编译完成。
- 预览不写冻结版本。确认只携带规划 ID、时基和提案摘要，Renderer 不能提交自造曲目、文件内容或时间线。后台任务逐首重读已授权源，核对完整 Hash、技术与帧证据，结束时再次确认全部源可用。
- Source Root 撤权通知所有引用它的冻结任务立即中止读取。取消、撤权和迟到结果不能提交；重启仅把未完成任务置为 interrupted，不重播文件读取。
- SQLite schema 8 在单事务写入 Master、Layout、完成状态和追加账本。提交前再次核对草稿/源身份、规划、预留/收藏保护和版本谱系。数据库触发器禁止 UPDATE/DELETE 冻结对象及账本；幂等 commandId 重试不生成重复版本。
- 冻结历史不读取当前草稿来解释旧曲目，UI 用冻结 MasterContent 展示历史时间线。原音频只读，公开合同不含私有路径或文件身份串。

## 边界与后续

本阶段单草稿最多 100 个母版/布局、1000 个冻结任务，复核并发有界。当前只涵盖单盘 Cassette A/B 或 DAT 连续节目，多介质 Layout 扩展保留。容量仍是标称值，不是实测安全长度；源帧数是容器证据，不是解码认证。

`status=frozen` 仅说明内容/布局快照锁定，所有布局仍为 `executionReady=false`。Logic/PREP、RenderTimeline/Conformance、Execution Asset、RecordingPlanVersion、Profile/Artwork 快照、完整 Gate A～E、真实录音与 Owner 验收仍须后续实现取证。F-01 未决，不引入自动源复制、执行音频清理或归档承诺。

稳定命令支持当前面板内回执重试，后台状态/历史可在冷启动读取。通用跨 Renderer/应用重启 outbox 仍是原计划 carryover；不能把本次恢复等同 outbox 完成。
