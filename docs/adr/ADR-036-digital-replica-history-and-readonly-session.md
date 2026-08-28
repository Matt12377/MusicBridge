# ADR-036：Digital Replica依据历史对象与只读会话

状态：TASK076实施决定；不是可听播放或设备认证证明。基线075最终7f890be5badee3e9ea08355729e29c5aefeec377。

## 决定

Replica从明确Record冻结的Plan和归档谱系解析actual-execution/original-render，面为A/B或Program。拒绝当前Master/Session/预留重捕获、同名搜索回退、自动转码/补间隔/重建。Direct执行资产已编译间隔；Prepared原始Render与实际执行各自选择。当前实体内容变化不改历史对象。原Render现在解析得到的PCM摘要标verified-render-bytes，不能冒充旧冻结执行证据。

只认FINALIZED归档唯一角色/名称/哈希对象，或当前激活恢复binding。恢复绑定存在时不可回退旧root；metadata-only恢复没有音频能力。持有O_RDONLY/O_NOFOLLOW单链接FD，校验完整文件与PCM、根/路径/句柄身份和实时授权，取消和末验不能跳过。正常归档发布清除暂存别名后单链接，不放宽nlink约束。

六固定scope IPC：status/inspect/cancelRead/start/get/stop，不进自动outbox，不接路径、设备、provider或认证参数。inspect是有界文件核验，Main采用既有35分钟文件请求上限，Core另有更短可取消阶段预算；start同步建立有限starting快照，后台执行，不能让一整面音频占据IPC请求。状态、启动派发与停止仍使用短IPC期限。

会话进程内、单活动执行slot、run/read ID预算不靠淘汰取消ID再允许同ID启动。相同请求取原结果，异body冲突；取消先到保存无假身份tombstone。源读/提交/消费/EOF/drain分开，首终因不被晚到成功反转；provider真实close及输入末验后才能宣称资源静止。关闭超时只能保持stopping，不能通过Promise.race释放仍使用的FD。

与Attempt的准入/输出/清理slot双向互斥，检查和占槽之间无await。等待翻面且slot已静止不会全局锁死历史读取/核验；不将读取或Stop挂在新互斥hook上。

## 当前软件与实机边界

生产和合成App runtime均不注入Replica provider，status blocked、start BACKEND_UNAVAILABLE映射NOT_READY且不创建会话。独立Core测试私有合成consumer可验证实际归档字节/帧及取消清理，合同明确synthetic-only/deviceOpened=false，不能称用户播放成功。UI将“音频已核验”和“后端不可用”分别显示，播放禁用；不借HTML audio或系统默认设备绕过当前设备授权。

旧15分钟源/输出检查默认限制保持。新长租期从冻结帧数/采样率推有限消费预算并保留准备、清理和末验边界，不滚动无限续期；当前合成runner的实际运行仍有限。OS I/O与driver close超时不等于底层已结束。

不新增永久录音、库存或会话业务表，不修改Record/Attempt/current，不改变F01永久保留政策；不自动清理或重建。R020-023、073真实HAL/Gate B、可听Replica及Owner验收继续单独待验。软件Gate最终记录在TASK076报告，不由本ADR推定。
