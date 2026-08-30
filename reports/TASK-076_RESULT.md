# TASK-076：Digital Replica历史核验与只读会话

## 身份与授权

- 基线：`7f890be5badee3e9ea08355729e29c5aefeec377`，分支`codex/task-076-digital-replica`。
- 实现提交：`8aef55b44ab147c6e07d28c541473030cbce0c6a`。报告提交由最终STATUS锁定；077从本任务最终HEAD创建独立分支。
- Owner授权持续软件开发至079，代理统一GPT-5.6 Sol / High。仅本地提交，不push、不合并main、不安装发布。当前无设备，计划RME/Apogee声卡与Sony卡座不等于具体设备或操作授权。

## 交付与边界

1. 明确历史Record→冻结Plan→执行资产/归档谱系，选择实际执行音频或原始Render及A/B/Program。Direct无原件；Prepared原件与派生执行分别验证，空B不制造音频。旧源目录离线、当前预留变化不重解释历史，不自动转码、重建、替换或重复烘焙间隔。
2. FINALIZED归档核对owner、清单、角色/名称、冻结Hash和完整WAV/PCM；原件从实际字节取得编码，PCM证据标为verified-render-bytes。恢复只认当前live binding，metadata恢复不回退旧路径。O_RDONLY/O_NOFOLLOW、单链接、句柄/路径身份、实时撤权、完整文件/PCM及归档末验均保留。
3. 新独立租期按冻结时长限定准备/消费/末验，最多6小时音频、准备和末验各15分钟，消费另有120秒收口余量；旧source默认15分钟不放宽。私有synthetic runner本轮仍最多15分钟，不称已实测6小时或实时停止。超时只撤销signal，不race释放仍在消费的FD。
4. 六固定dataset scope API贯通Preload/Main/Core：status、inspect、cancelRead、start、get、stop。等待scope前复制选择，scope仅取得一次，无自动outbox、重播、路径、设备或provider公共参数；错误只按固定码，不透出原始message/stack。
5. 单执行槽、有限run/read账本、不驱逐取消ID；取消先到留tombstone，相同请求不重跑，异体冲突。源读取/提交/消费/EOF/drain和PCM分别核验，首终因不被迟到成功覆盖。driver真实close及输入末验之后才终态/退槽，迟到句柄也收口。Attempt新执行同步双向互斥，历史读取和Stop不加新锁。
6. 历史详情局部Digital Replica界面：不自动核验或选版本/面，音频可核验与后端blocked分开。取消失败保留同readId，ACK不冒充原读取结束，迟到结果不回填，关闭/卸载/切Record隔离，键盘焦点返回，Hash摘要可展开。

**本次完成的是本地软件阶段，不是可听Replica或PRD全部实机验收。** 普通与合成App runtime均无provider，status始终blocked，start映射NOT_READY且不建会话，播放按钮禁用。仅私有Core测试可注入synthetic-only消费；没有HTML audio、系统默认设备或测试provider后门。Gate B=NOT_RUN、formalReady=false；没有设备枚举/打开/测试音/录音，也没有真实Provider/Roon/Owner验收。

没有新增schema/库存/录音会话永久表；Record、Attempt、当前内容与库存保持不变。schema仍20，备份恢复沿已有完整流程。

## 最终本地自动验证

| Gate | 实际结果 | exit |
| --- | --- | --- |
| 修后完整verify（类型、单元、生产构建） | Contracts174 / Core1066 / Desktop532，全PASS、零skip | 0 |
| 安全 | 29/29 | 0 |
| Electron生命周期、崩溃、冷启保险库 | 4/4 | 0 |
| 完整E2E | 88/88、双native、零skip，188.524秒 | 0 |
| control / boundaries / cycles | PASS / PASS / 241文件PASS | 0 |
| native pin | 16/16与075基线SHA256相同 | 0 |
| diff检查、候选身份 | 34代码/测试文件不变，精确40路径实现提交 | 0 |

最终代码/测试候选：`489612f88769a67e09a9cda713b77258a0fdc3946cacc5c8ff7b1365f5ffc591`。安全/Electron在最终输入两文件修复期间使用未变的对应范围；修后完整verify重新构建，随后独占完整E2E，无build与E2E重叠。真实窗口六API证明无设备阻断、取消先到、冷启不恢复会话和不改档案；UI场景使用独立真实归档/事务生成的只读DTO，不伪称窗口执行过正式录音或播放。

所有命令和原失败证据保管于`reports/runtime/task-076-digital-replica/`。首轮E2E六个产物保留在`first-e2e/test-results`；最终157个产物整体移入`test-results`，迁移前后逐字节Hash一致。日志旧apps/desktop/test-results路径对应上述保管位置。root实际查看720/1440顶区与720选择区截图，面板无横向溢出、axe无serious/critical；不是Owner视觉接受。

## RED/GREEN与两阶段审查

- 合同：模块/六入口RED，非作者发现sampleFormat数组经String转换被误收；真实RED→primitive守卫12/12，root独立复现GREEN。有限R2先SPEC后QUALITY通过。
- 输入：真实Direct/Prepared归档、离线、硬链、完整backup→isolate→prepare→binding、metadata无回退、撤权及四种PCM；消费时Manifest变化真实RED→末验修复。root另发现纯inspect缺末验，实际改磁盘Manifest仍verified的RED保留；作者仅两文件修复，13/13，root复现GREEN，有限R2通过。原verify174/1065/532虽通过，不覆盖这个P2；最终完整重跑为174/1066/532。
- 会话：已完成read占并发槽、Attempt缺反向锁、close超时状态、晚completion拒绝、早到progress非法DTO均有真实RED→GREEN。最终新16+原Attempt21共37/37，root独立执行通过。原早到进度测试未正常收口的失败保留，修测试清理后再取得正常退出RED，不当作正常Gate。
- 接线：公开入口缺失、Core UNKNOWN_IPC_COMMAND和inspect误用短期限均有RED；实际Preload VM/Main/client/Supervisor组合49/49，实际Core service2/2。非作者限定12接线文件SPEC→QUALITY通过，不将参与会话作者称为整个任务全新独立审查。
- UI：缺模块/入口、旧Host加载依赖和取消后残留错误都有记录；最终新19+旧20共39/39。原075仅改两行loader，不改断言。名称带GREEN的早期失败日志按实际exit1记录，DAT fixture纠错不称产品RED。root SPEC→QUALITY与实际Electron验证通过。

未开展第三轮重复审查，未因可选观察项扩大范围。没有以编译、单个selector或合成driver替代真实设备证据。

## 保留与接续

R020大库冷启、R021旧CDP退出FAIL、R022真实HAL静止/测量、R023全历史/照片闭包和搜索容量仍保留至078及独立实机验证。073真实HAL与Gate B、可听Replica正式provider接线、Source Roots/Logic/Provider/Roon和最终Owner接受仍未完成。F01永久执行资产保留不变。

下一项TASK077：Cassette完成时自动生成基础J-Card、不可变Printed Artifact、Master Artwork版本归属、正确物理尺寸PDF与原生保存、历史模板/图像不回写、完整备份恢复和双库显示。仅只读就绪资料已完成，实施必须从076最终HEAD另建树；078全链路和079真实验收范围不缩减。
