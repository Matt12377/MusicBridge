# MBRS-008 实际复用关系

本任务从007最终独立报告8140124接续，G0引用RUST-016的有限阶段准入。Node仍是唯一业务写入Owner，Rust只读可选且默认关闭；不启动另一个播放、队列、数据库或源写入权威。

| 原复用项 | 当前实际接点 | 008增量 |
|---|---|---|
| Controller、PlaybackObservation | application/bridge-controller.ts、playback-event-publisher.ts、contracts/local-playback-compat.ts | 当前attempt的安全文件参数，四轴缺证据保持未测 |
| 唯一扫描与数据Owner | collection/local-scan-store.ts.privateCurrentFileState、local-source-tickets.ts | 受当前locator/revision/signature约束的accepted技术事实投影；不新开SQLite连接 |
| 原文件读取 | stream/gateway.ts、local-file-http.ts、local-file-source.ts、registry.ts、recording/source-files.ts | 私有审计消费者实际完整/Range字节核验；服务、FD/锁/取消边界不重写 |
| Roon Adapter | roon/adapter.ts、roon/types.ts、roon/sdk.ts | 不杜撰Signal Path/DSP/输出位深API；现有官方控制和回执保持 |
| 既有界面与事件围栏 | BottomPlayer.vue、NowPlayingView.vue、PlaybackInspector.vue、player/details.ts | 源文件/来源返回/Roon输出/四轴证据分开，本地来源明确；不新增永久页面或播放栏 |
| 旧录音与冻结来源 | recording/source-store.ts、SourceBinding、旧Gate B/P4/P5 | 维持严格读取/不可变历史；普通文件参数或新Q1不抵扣旧认证 |

解析报告只证明有界Reader报告过这些字段。stat只能拒绝可观察变化，不能认证NAS缓存或恢复时间戳的隐蔽原地修改。质量消费者/离线PCM分析不进入生产播放链，不新增捕获设备、转码、下载或缓存。原包Rust未完事项映射与003历史25超时仍保留。
