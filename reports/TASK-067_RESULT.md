# TASK-067：持久命令outbox与工作库隔离

## 身份与授权

- 基线：`a64a31a6f7fca9ae34ea112faba1f9c7a2c530e2`（TASK-066最终锁定）。
- 分支：`codex/task-067-command-outbox`。
- 实现提交：`6cf657f613c738b6068d8247183038c7fb6e989a`；报告提交由最终STATUS锁定，最终HEAD由本机final-closeout.json与TASK-068基线双重锚定。
- Owner持续开发与GPT-5.6 Sol / High互斥并行授权。无push/main合并/发布，无真实Provider/Roon、用户音乐/照片/库存或硬件访问。

## 交付内容

1. Main私有 `command-outbox.v1.sqlite` 保存不可变原DTO、commandId、工作库ID和指纹；不随collection备份恢复回滚，不与Core维护库争用写连接。52个既有V3稳定命令入口全接入，原无scope领域写handler移除；读取、播放、凭据和硬件控制不进入outbox。
2. 先落盘再发送，Core成功后Main保存回执再回Renderer。Renderer接收后ack隐藏；ack失败保留待确认项，不把业务成功伪装为业务失败。冷启sending转uncertain且绝不自动重发；同会话明确再调用、面板明确重试保留原DTO与commandId。改参、明确业务冲突和旧工作库隔离均不绕过。
3. preload加载时固定编辑工作库，等待期间克隆原请求，切库后必须完整reload。Core维护schema3保存不透明数据集身份，实际repository最后执行边界再次核对；文件替换/新建换身份，恢复激活不能继承旧快照身份。
4. 七类原生选择/激活使用专用路线。人工恢复先查询原回执，无回执才按本次明确动作重新打开选择器；私有路径不进outbox。跨工作库只有激活终态可只读恢复，不停止播放、不再次重启Core。
5. PREP一次确认的多文件撤权使用1～3项专用批次：同scope、固定revoke、不同命令和目标，一个事务保存全部后才执行。尾项冲突或容量不足整批回滚；第一项执行失败不丢后续已持久意图。每项独立幂等和人工恢复，撤权不删除文件。
6. 全局“未确认操作”入口沿用原导航和tokens。公开概览只显示ID、命令、状态与安全错误码，无payload/result/path；分页和轮询有界，每项singleflight，重试与放弃跟踪分别确认，组件卸载不继续更新。旧scope项可查看但不可普通重试。

私有账本限制2 MiB单项请求、64 MiB总量和1000条。容量不足时仅清理已ack成功或已明确放弃跟踪的outbox项，与新写入同事务；不清未确认项、领域账本、源文件或音频，不改变F-01。合法可选undefined按JSON省略语义归一，未知字段仍拒绝。

## 自动Gate与审查

最终44个代码/测试/配置文件逐项Git blob核对一致，全部Gate已实际执行并读取退出码。

| 检查 | 结果 | 退出码 |
|---|---|---|
| verify：类型、Contracts、Core、Desktop与生产构建 | 82/82、827/827、279/279 | 0 |
| E2E类型 | tsc tsconfig.e2e.json | 0 |
| 安全 | 27/27 | 0 |
| Electron | 4/4 | 0 |
| 完整E2E | 54/54，含固定原生转换器，无skip | 0 |
| Control / Boundaries / Cycles | PASS / PASS / 178 files PASS | 0 |
| diff-check与候选一致性 | 44/44 | 0 |

SPEC第二轮有限复核P0/P1/P2=0；单文件E2E oracle修正由主任务验证，43个其余blob保持。QUALITY子审覆盖Main/preload/Core最后执行边界，主任务复核store/service/UI生命周期、容量事务和批次保留后裁决通过，未发现本任务阻塞项；保留R-020既有规模风险。没有第三轮SPEC或无限审查。前一候选53条E2E、中间53pass/1fixture fail及专项修正证据详见TASK-067_PROGRESS，不替代此最终54/54。

SPEC第一轮发现复合撤权P2并按原范围修复；第二轮仅复核该链路、undefined归一及授权修复文件，禁止第三轮派审。最新44文件初始精确匹配；与首轮候选对比为30文件不变、11文件修复、3文件新增。参与者做过部分实现，不称全新独立审查。

## 证据边界与接续

本机完整日志、候选Git blobs及Gate命令退出码位于 `reports/runtime/task-067-command-outbox/`。首候选、中间批次和最终候选日志分别使用 `final-*`、`batch-final-*` 和 `release-final-*`；最后一个仅为本机日志前缀，不执行发布。失败证据不覆盖。固定原生bundle13文件SHA-256与TASK066相同，不是签名、发布或硬件认证。

真实合成Electron覆盖Main结果落盘失败、Renderer刷新、SIGKILL冷启、工作库切换隔离、只读恢复激活回执；复合撤权新增首发前SIGKILL，合成预置授权记录，不冒充真实选择/音频导入流程。独立SQL核对原业务账本不重复，源文件字节保留。最终720截图由主任务查看，未确认面板两类恢复场景axe serious/critical为0且无横向溢出；实际Owner视觉验收单独等待。

下一任务TASK-068从本任务最终锁定HEAD建立独立分支，继续ReferenceSourceVersion、CatalogRevision、未知/缺失区分和合并拆分审核。新增写API必须显式接入本任务outbox有限白名单，不能恢复无scope入口。

完整V3、PRD30、A～E、U-01～U-10、实际Logic/输出后端/Owner验收未完成。F-01未决，不自动清理音频、不冻结正式Plan/Attempt；R-020大库冷启2秒ready与完整扫描的容量/超时策略仍由TASK-078/Gate E关闭。TASK-047真实歌词、TASK-061发布准入及历史视觉/Beta carryover不因此完成。
