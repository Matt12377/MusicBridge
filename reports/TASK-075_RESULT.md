# TASK-075：录音档案、检索与双库同步

## 身份与授权

- 基线`af572126a2abeefdf361e8db2c9ac4a457b7a8be`，分支`codex/task-075-recording-records`。
- 实现提交：`f84bd8e2f9d3b7d79163496950acc545ff649155`。报告提交由最终STATUS锁定；076从本任务最终HEAD创建独立分支。
- Owner已授权持续软件开发至079，代理GPT-5.6 Sol / High；仅本地提交，不push、不合并main、不安装发布。无设备不阻断软件开发，不产生真实输出/设备操作授权。

## 交付

1. 首次Completed与Record、当前内容和实体usage同事务原子登记；冻结首次完成事件、完整Plan、执行谱系和完成时本盘JPEG。cleanup不改首次快照，照片源行删除不影响不可变字节；预算/事务失败完整回滚。没有新增库存或第二份实物。
2. schema20真迁移19：旧physical_copies逐列守恒、旧Completed从冻结证据补Record并显式legacy-plan-only，无当前descriptor/照片回填。新备份/隔离恢复验证Record、事件、permit、回执和照片闭包；坏旧19先拒绝，未提交新schema再报错。
3. 当前内容confirmed/unknown/erased与旧档案分离；五类明确preview+人工确认处置，CAS/命令回执幂等，重录许可绑定实体/内容/目标MediaPlan与前序Attempt。Begin完整准入后才消费许可，取消不回blank或增加数量；普通reserve/edit不能绕过专用许可。
4. 六个固定dataset scope API。Preload先clone再等待固定scope，Main严格来源/信封/白名单，Core强制scope并固定安全错误。无path/SQL/设备/注册Completed入口；人工处置不进入自动outbox，失败只能手动同DTO重试。
5. 录音档案搜索、三编号检索、分页和独立历史/当前面板。冻结标题、曲目、Artist、品牌/系列、设备参数、日期可查；照片按需单张读取和重试。双库用同physicalId同一盘，unknown不借旧标题，正式投影不能经legacy编辑改写。
6. 原生dialog、明确五动作、pending可恢复退出、代际/成功写入revision下界、防旧回执覆盖与键盘焦点恢复。无自动选择历史、预览、确认、开录或播放；Artwork缺失明确、J-Card待077。

**生产Gate B=NOT_RUN、formalReady=false。** 没有真实Provider/Roon、授权源文件、设备枚举/打开/测试音/录音。照片窗口场景来自独立真实Core事务的合成Completed DTO，由测试Main只读展示，不是本窗口真实正式录音。

## 最终本地自动验证

| Gate | 结果 | exit |
| --- | --- | --- |
| 类型、单元及生产构建 verify | Contracts162 / Core1035 / Desktop505，全部PASS、零skip | 0 |
| 安全 | 29/29 | 0 |
| Electron启动/崩溃/冷启保险库 | 4/4 | 0 |
| 完整E2E | 86/86，双native开启、零skip，183.65秒 | 0 |
| E2E最终类型 | 包含074/075及两处schema20终点 | 0 |
| control / boundaries / cycles | PASS / PASS / 234文件PASS | 0 |
| 固定native | 16/16原SHA256相同 | 0 |

66个代码/测试文件指纹`c60e2ae0a5c6531846fe9e1f65fd8debc0d7b6da95cae52e5cf655d9e5a5a396`。完整verify后仅追加双库E2E断言与两个旧E2E的schema版本终点，生产及单元候选不变；最后类型和独占完整E2E通过。

完整E2E首轮84/86，两个失败都为旧TASK069/070期待19而实际20；只改PRAGMA user_version断言，原库存数量19没有改变，来源行/账本/外键/冷启断言均保留。最终86/86是整套重跑，不是仅失败用例重试。

早期双库focused与verify尾段有潜在构建重叠，不作为最终封版依据；后续Electron完成后独占完整E2E已覆盖该场景。一个直接类型命令误用根node_modules路径而启动失败，改为Desktop的tsc后exit0；不把启动失败计作行为RED。

所有命令/退出码、原RED及失败产物留`reports/runtime/task-075-recording-records/`；336个E2E产物整体移入其`test-results/`且逐字节Hash一致，原日志中的apps/desktop/test-results相对路径对应此保管位置。未覆盖旧Gate。

## RED/GREEN和审查

- Store真实缺表/schema19不等20 RED；首次完成、照片预算/回滚、hash重签来源绑定、坏19迁移前拒绝、backup schema20白名单、许可目标编辑/离线篡改与无Attempt current普通reserve缺口都有实际失败证据。作者新28/28、旧schema279/279；root独立focused28/28并完整Core1035通过。
- 合同confirmed录音在reserved/unknown状态携带冻结标题曾错误拒绝，真实14/15→53/53；保留unknown/erased不带旧标题和旧无recordingState规则。
- Preload/Main/Core缺接口/UNKNOWN_IPC_COMMAND与错误映射均有RED，最终Preload9、IPC12、utility43通过；实际六API场景验证冷启、幂等、无Completed与库存守恒。
- UI最初缺模块RED，三值来源、同实体旧详情回退、pending无current隐藏恢复入口分别RED→GREEN；最终模块20、组合44通过。角色定位真实2/3失败改一行语义combobox后3/3通过，不放宽断言。
- 先SPEC后QUALITY：Core由root，合同/IPC由非作者R2，UI由root，E2E/ADR由非作者R2；修复重审不超两轮。root随后只增加双库导航/同实体revision/焦点/无legacy编辑/数量断言，自查并由最终完整E2E验证，不开启第三轮委派审查。
- root已查看720和1440实际截图；指定区域axe无serious/critical，截图仅覆盖滚动至事实与照片区域，不代替Owner视觉接受。

## 保留与接续

R020大库2秒ready、R021旧CDP15秒退出FAIL、R022真实HAL静止/无声测量全部保留。R023扩至Record照片全闭包验证和全量检索，078必须做容量/Stop/冷启测量优化；本任务不声称实时100ms停止保证。

073真实HAL/Gate B、Owner计划RME/Apogee和Sony具体设备/接线/测量、真实Source Roots/Logic/Provider/Roon与最终Owner接受均未执行。F01永久执行音频保留已批准。

下一项TASK076：按历史Record精确选择当年执行音频/原始Render，验证归档对象与激活恢复binding，显式会话与取消，不走当前Plan预留/当前Master或在线同名歌曲，不修改旧Record/Attempt/库存。077、078、079范围保留。
