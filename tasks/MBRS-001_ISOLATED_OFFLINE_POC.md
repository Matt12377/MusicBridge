# MBRS-001 首批隔离软件执行范围

原PostRust v1.2连续执行目标不变；原MBRS001九验收ID、层级和断言完整引用，原包不改。下一树从RUST016最终HEAD 6f1cc0edcb0c59b78a2dfd0828b8e6196e816e47建立，独立分支codex/mbrs-001-isolated-offline-poc。R16、000、015及全部原WIP封存保护。

只允许自建两份同basename不同字节的合成小样本、loopback隔离HTTP、锁定官方AudioInput薄SDK背后的Fake moo及原Adapter；不读真实音频/用户库/凭据，不真实discovery/Core/Zone/播放，不源写/增强/Browse/Resolver，不正式runtime/UI或第二coordinator/writer。不改src/、lock、Provider、Rust源/既有Gate或AGENTS。工具不能接受live、任意file/root/Zone参数。

唯一写作者product_writer，文件范围首批：packages/bridge-core/scripts/mbrs001/{file-http.ts,fake-roon-sdk.ts,attempt.ts,offline-poc.ts,tsconfig.json,test/file-http.test.ts,test/official-adapter.test.ts,test/attempt-lifecycle.test.ts}及scripts/ci/verify-mbrs001-offline.mjs；标准CI如需接线仅.github/workflows/verify.yml新增明确offline Gate step，必须先主控确认与共享根兼容。所有metadata/task/report当前入口由root独占，不与写作者并改。

采用最少可归因切片：先提供真正可执行的固定FD完整GET/HEAD控制路径及代表Range行为断言，令新增Range合同在有效输入下产生行为RED；不得用missing module/function/type/目录准备错误造RED。root串行安装/适用准备/noEmit/RED后才交Range及其余Fake/lease合同GREEN。新工具最终检查显式nested noEmit/tests+原adapter/gateway/registry定点回归+一次offline复现，不能默认unit发现nested测试。没有必要的旧Rust/App/签包不重放。

实现冻结沿两准备报告并采用六项精确补充：HEAD忽略Range且完整长度零body；单GET Range闭/开/suffix/416，If-Range匹配206/不匹配完整200；固定FD-position并发读，禁止从URL构造路径；revoke中止在途request并等refs归零才actual FD close，current/paused不因一次HTTP完成释放；官方薄SDK真实string/object回调与早期end no-op；独立Fake账本确认SessionBegan、同session end请求、实际关闭确认，未知不能自报closed。Time与seek单位只测可观察字段/参数转换，不用shape推所有单位错误。

cancel-before-SessionBegan、Playing后SessionEnded-only、timeout晚到SessionBegan/Playing及stop UNKNOWN各有精准控制/负例；旧attempt回调不能撤销新token/FD。原Adapter观察缺口先如实捕获；首批不默改生产Adapter、不Fake抹平缺口。无法关闭真实远端=UNCONFIRMED，本地finally实际FD/HTTP/listeners/timers归零单列。两same-name samples重复新attempt，不接全局队列或数据库。

样本、build/cache/tmp、命令/log/result全部LifeWeave任务根，目录0700，输出wx新run而不覆盖。Fake精确请求仅内存断言；落盘归约attempt/sample aliases、字段形状、byte SHA/size、资源计数，能力URL/token/session handle/真实路径不入Git、公开日志或Renderer。正式生产默认Node、Rust只读OFF。

AT02/08/09可取得明确合成软件证据；AT06/07须保持软件范围/unknown/真实重复点播的未证部分，不能一律全PASS。AT01/03/04/05 live_roon保持BLOCKED_ENV，不因Fake通过改层级。四原交付物：DIRECT_STREAM_POC_RESULT、API_BEHAVIOR_NOTES、复现工具、格式初测矩阵；各WAV/FLAC/MP3等live解码/出声仍NOT_TESTED。

root负责串行Gate、整合、两轮最多独审及普通commit/push/远端身份；四子角色按硬槽位轮换。初始完整prepare/Gate失败保留且不冒产品RED，敏感性/目标失败精确归因，后续仅新变化/失败/实质风险才扩大重测。

## 原验收身份与首批执行

原规格 tasks/MBRS-001.md SHA256：e493714ff02a21c4d37980122a699d5b9fbf2ba5c880efc0346614c279ae2ad3。以下ID、层级、断言取自冻结v1.2台账，未改原包；状态在运行后分别记录。

- MBRS-AT-001-01 / live_roon：至少一个Roon未入库本地文件经官方AudioInput真实播放，无Browse/内部协议匹配前置。
- MBRS-AT-001-02 / integration：整文件GET和代表Range内容与原文件一致，HEAD无body；不是系统音频回采。
- MBRS-AT-001-03 / live_roon：同名不同内容样本分别选中正确源，Playing/Time与attempt相关。
- MBRS-AT-001-04 / live_roon：Core能访问网关的真实地址，部署记录没有把异机loopback当可用地址。
- MBRS-AT-001-05 / live_roon：pause/resume/seek及track/channel行为逐项记录，不将许可字段当功能证明。
- MBRS-AT-001-06 / integration：超时/取消/终态关闭了所属会话和媒体资源，无旧回调处理新会话。
- MBRS-AT-001-07 / integration：内部增强关闭且本地库无映射表时仍能重复完成新点播。
- MBRS-AT-001-08 / integration：真实音频/路径/secret不入Git，POC没有改变Rust迁移工作区或自动写音乐。
- MBRS-AT-001-09 / integration：POC隔离资源与正式产品分开，使用已有Adapter可行时复用；未新增通用播放器框架。

依赖固定 pnpm 10.17.1、Node 22.x；root 串行冻结 install --frozen-lockfile --ignore-scripts、contracts build、nested noEmit与代表Range RED。最终自动入口为 node scripts/ci/verify-mbrs001-offline.mjs --output-root=<经共享存储策略准入的唯一外置或真实 hosted 目录>，显式执行noEmit、nested新测试、原Adapter/Gateway/Registry回归和一次offline复现，保留命令、原始log、exit与来源身份。未知CLI参数及不合格root必须首写前拒绝，所有现场资源等待实际关闭。
