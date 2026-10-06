# MBRS-007 队列与恢复行为映射

基线为006最终独立报告 `b464dd2066346121a26824da516969b726f0cfe0`。本文件登记本轮软件候选与证据边界。新Core行为41项、合同新2项及桌面新2项已在有限检查中通过；最终任务Gate和来源CI单独登记。原11AT的文字、kind和真实验收责任保持，移动MBM任务不插入。

| 接缝 | 本轮行为与资格 | 验证边界 |
| --- | --- | --- |
| 原Controller队列 | 独立entry/MB queue身份、精确revision、原索引入口兼容；编辑须匹配当前queue/revision/成员 | 同曲重复条目、过期revision、等待期间重排/移除、stop/save/capture await失效、重复/不完整重排、native身份混入、异步前缀补页 |
| 新具名IPC | `playback.editQueue`、`playback.playQueueEntry`、`playback.queueLocalEdition`，仅经原Main/Core校验及preload的`editPlaybackQueue`、`playQueueEntry`、`queueLocalEdition` | 闭合字段、稳定entry/queue/revision成员资格；私有Owner load/save不进入通用Renderer dispatch |
| 本地发行队列 | ACTIVE关联、来源提供的盘轨和发行版本；有限物化到5000，超限与坏曲明确失败 | 乱序插入、多disc、重复轨号、inactive、不同发行、201项以上与超5000；冷恢复显式点播同Owner按已存edition ID/revision重取明确版事实，变更/缺失拒绝 |
| 唯一Dataset Owner | 同一SQLite连接、schema33逻辑队列表、闭合DTO、单CAS事务及ACK后成功 | 实际Owner/SQLite保存、迁移、恢复、失败回滚与未知提交；不只DTO roundtrip |
| NEXT资源 | 固定两个lane、各自单调attempt，仅紧邻下一项；保持当前ACTIVE可读 | PREPARED30s、16历史owner/16票据/8FD上限、取消/late capture/open/register、真实quiet后复用 |
| 提升与SDK | 先revalidate来源/entry/target/fence，再保留同一票据/lease/attempt提升；准备不派发SDK | 受控Adapter真实调用点与FD资格；不能以HTTP完成声明Playing或gapless |
| 自然结束与控制 | 同owner/entry/generation的可归因自然结束只前进一次；普通SessionEnded不猜自然结束 | 重复/旧终态、UNKNOWN、pause/resume/seek/快切、接管/断连/重连零自动send |
| 冷启恢复 | 只安装逻辑队列到idle；显式用户动作后重新解析，不恢复旧会话资格或自动播放 | Owner新epoch/旧dataset/损坏/CAS、SQLite冷开和新Controller、Boot零FD/SDK、ACK选择位置与公开投影一致、保存期间shutdown join |
| 原来源与consumer | 保留网易云/native及原UI；声明的跨源组合通过真实Controller受控测试；不支持的恢复明确说明 | 云序列与local转换、紧凑事件/IPC/具名preload、stable key与明确失败状态 |

持久化独立预算为5000条、16MiB UTF8、最多1 save与1 load flight；沿同Owner消息/事务，不修改006 capture result的64KiB专属合同。只存逻辑身份、来源/修订、顺序及必要偏好，禁止路径、临时URL、secret、内部oid、FD/SAB/ticket/lane/target闭包；最大合法UTF8与实际磁盘内容需测试。数据库备份/恢复的schema32→33验证同步更新，原Frozen/Prepared/Archive/source hash不重写。

native运行期引用不落库，持久快照只保留闭合的`UNSUPPORTED_NATIVE_RESTORE`来源意图。替换队列分配新queueId，durable CAS修订继续单调前进；旧queueId或修订的编辑请求拒绝。公开编辑成功、后继派发与保存ACK的顺序需以实际行为测试覆盖。

备份激活若改变dataset，启动保留旧队列记录并明确需要重新核对，不能自动改旧记录dataset或让旧队列阻断整个新dataset Boot。用户后续明确新建/替换队列须形成新queueId、当前dataset及新来源/目标资格，以准确旧revision CAS保存；不把旧sourceSnapshot悄悄重绑，也不以未保存的volatile状态冒充成功。损坏且修订无法确认时保留原件并固定失败。

本机只操作自有合成fixtures。真实Roon排序/控制对应AT01/04，真实同格式边界及跨格式重锁对应AT05/06，均尚未运行。能力、控制结果、顺序提交和音频无缝分别登记；不能把有限预备、自然顺序提交、Fake或HTTP成功当无缝证据。CUE片段尚unsupported，显式整文件为独立意图，不暗替代。

当前生产默认保持Node，optional Rust OFF。006真实20样本、001/002/004/005真实验收、003历史25拒绝的物理原因UNKNOWN、上游许可及移动合同采纳继续保留。main合并、安装、LAN部署、真实账号/曲库写入及发布不在本轮软件范围。

所有实际本地entry启动和NEXT准备共用compact-v1能力授权，包括冷恢复后的entry/index/上一首/下一首；legacy明确拒绝且零捕获/注册/SDK，原云/native仍兼容。稳定entry始终绑定受理对象及queue/revision，不退化为等待后的数字槽位；本次cursor CAS真实ACK后先安装同候选的逻辑选择位置，再核派发意图。Stop会阻止SDK，却不会让公开选择位置落后于已提交磁盘；更晚的ACK快照不得被旧候选回退覆盖。
