# MBR-001：播放正确性与基线 UI 回归闭环

## 身份

基线：7a6a19105480be456778dfa4369379f224665e39。
分支：codex/mbr-001-playback-correctness。
首个实现：2b79715a7147d142f91b630dcc19571c734cc45e。
最终实现：4c36e9554900591b367add7edfc16985690f7a03。报告提交由包含本文件的独立报告 commit 解析；该固定实现本地完整软件 Gate 通过；远端 CI 尚待本报告提交 push 后验证。

## 已实现行为

- Controller 的 terminal 处理同时核对 token、播放 generation 和停止意图；旧/重复回调不能清空新播放，也不能误触发下一曲。Stop 失败保留原身份和状态证据，明确提供停止重试，不伪造 idle。
- Adapter 停止未知时保留资源作用域与关闭回调；迟到 SessionBegan 不会启动播放，重复停止共享在途请求，旧关闭回执可证明停止完成。各 Zone 独立 revision，seek tick 不冒充新曲观测。同名/别名需要元数据与时长佐证，时长冲突拒绝。
- Renderer 旧集合分页与 append/Stop 回执在 await 返回后重验 generation；新播放和 Stop 使旧集合补齐失效。停止失败的重试继续重试停止，原生 Roon 引用不误走网易云播放。
- TrackTable 与 RoonBrowseDetail 的行 Enter 只处理行自身，子按钮 Enter/Space 不再冒泡启动另一播放。新增真实 Chromium/Electron 组件操作回归。
- 修正 performance-trace 测试把 macOS 外置 TMPDIR 写死到 Linux CI 的问题，继承当前环境；没有把诊断局部通过扩成真实播放结论。

UI 回归补充：设置视图保留收藏 source 时，单次父按钮现在执行导航；窄窗口 CSS 隐藏文字时，两个分类按钮仍有独立 aria-label。这两处实际缺陷各有真实 Vue RED 1/1 → GREEN；最终整个侧栏 8/8。旧 UI 夹具迁到当前侧栏两库与型号四页，并实际操作可见按钮。

## 首个固定实现证据（2b79715）

源码指纹：814 文件，SHA-256 483c7839c87bbe31957f3f0648de228784a3f3b0d74f803d58b8143b60724f73。
过滤规则为 git tracked apps/packages/scripts 的 ts/vue/mjs/cjs/json/yaml/yml/js，加根 package.json/pnpm-lock.yaml/pnpm-workspace.yaml；排序后按 path\0bytes\0 计算。与 MBP-001 旧 793 文件过滤规则不同，不比较文件数增量。

| 验证 | 结果 | 退出码 |
| --- | --- | --- |
| Controller 新增行为 RED | 17 项中 15 fail / 2 pass | 1 |
| Controller 新增 GREEN / 全 Controller / 原生相关 | 17 / 89 / 53 pass | 各 0 |
| Adapter 首轮 RED | 7 / 7 fail | 1 |
| Adapter 最终 / Trace | 80 / 9 pass | 合并 0 |
| Renderer 新增 RED | 5 / 5 fail | 1 |
| Renderer 相关回归 | 65 pass | 0 |
| 实际 Chromium 键盘 | 1 pass | 0 |
| Core / Desktop 严格类型 | 各通过 | 各 0 |
| 原完整 verify | Contracts 222 pass；Core 1609 pass / 原有2 skip；Desktop 878 pass；生产构建与 preload 门禁通过 | 0 |
| 原完整 Electron 启动/崩溃恢复/Mock keychain | 4 pass | 0 |
| 原完整 Electron E2E | 84 pass / 19 fail / 原有4条件skip，107 total | 1 |
| Static control-plane / boundaries / cycles / diff-check | 通过 | 各 0 |

E2E 19 项仍红灯，不以 verify 或局部测试替代；在原范围完成夹具/导航修复后重跑。

日志根：/Volumes/LifeWeave/Developer/CommandLine/tmp/mbr-001-root-9Sklh3/。
verify-r1.log SHA256 4632b3f17e12486b542b8382c5135957b7bbde9d510bc4b993e1e4ce5113921a。
electron-gate-r1.log SHA256 75a1d598263bbb41666ce8846df3202f86a47c662ebe025c7bf4df39510e4868。
full-e2e-r1.log SHA256 d678aee7a547fda7a79db05ea824e86c030d6a06266e8d20f32af46414632cc2。
full-e2e-r1-report.json SHA256 d5c16faa2a1a7d10cd9f21f124e7ac708519c1db49a65c78788f27c5b062f599。

## 原断言调整的契约依据

Adapter 旧别名成功夹具新增真实元数据佐证（240 秒时长）；仍保留别名确认成功保护，同时新增无佐证与时长冲突不能确认的反例。不得只为旧实现不满足旧断言就默认断言错误。
收藏 UI 依据 Owner 已确定的侧栏展开项、型号四个独立页面与全宽响应式墙迁移：

- 旧顶层 tab 已改侧栏普通 button；检查父级展开、子项 current 与实际 region，Enter/Space 保留。左右/Home/End 则在真正的型号详情 tablist 验证，四页仅显示一个 panel。
- 拆封/登记在“我的库存”，单盘和录音在“实体磁带”，汇总/保护在“概览”，照片在“资料照片”。原库存守恒、明确确认前零写入、永久 ID、制作归属、幂等、冷启不变。
- 原固定三列与图片自然高断言已失配当前容器响应式布局。改为按可用宽度核对列数、等宽/间距/换行、媒体 8:5、contain/边界和滚动入口，保留浅深色与 720 窄窗。
- 懒照片先滚入真实媒体容器再验证原 1200px；进入音乐详情时对真正的“查看藏品详情”按钮发送 Enter。原图字节、离屏零读取、失败单图重试+1、横竖尺寸、代表图及库存数量仍检查。
- 详情 physical ID 使用当前“编号：ID”精确文本，仍核对同盘关联。自动 PDF 用既有正式主窗口 helper，隐藏 worker、PDF 内容/hash、八 API 和取消零写不变。
- 未新增 skip/fixme/force/includeHidden，没有更改原生产期限、Task-070 的 500×25 数据及完整品牌/系列/8MiB 断言。完整失败归因见 MBP-001_REMOTE_FAILURE_ATTRIBUTION.md。

## 保留边界

软件 Fake 和合成 Electron 验证，不连接真实 Provider/Roon，不使用系统钥匙串，不执行设备录音。
真实 Mac/Roon/audio、正常采集/取消/设备断开、Owner验收、main合并、正式App替换和发布均 NOT_RUN；Gate B 未认证继续阻断。
本任务没有实现通用播放准备 latest-wins、快控制通道、真分页、页面缓存、小进度事件、封面预算和 SQL 优化；由后续独立任务闭环。
远端 MBP-001 的大目录超时在 2b 本地通过，不能因此证明远端性能回归不存在。详见独立失败归因报告。
下一任务 MBP-002 从本任务最终报告 HEAD 创建，沿用原全量范围和独立提交。

## 最终实现 Gate（4c36e95）

源码指纹：815 文件，SHA-256 03643c43af840e6d294bf51685549d6475fbd4f7a306e834572c0badfa629f21，过滤规则同本报告首个固定实现。

- 定向 75 项首次：67 pass / 7 fail / 原条件 1 skip，exit 1。
- 7 个失败路径第二次：6 pass / 1 fail，exit 1；剩余照片测试发送 Enter 到不可交互 article，改实际详情按钮后 1/1 pass，exit 0。上述均不是全量通过结论。
- 原完整 verify：Contracts 222、Core 1609（原有 2 skip）、Desktop 880 pass；严格类型、生产构建与 preload 门禁通过，exit 0。
- control-plane / boundaries / cycles（342 文件）exit 0。
- Electron 启动/恢复门禁：4/4 pass，exit 0，Mock keychain；原完整 E2E：103 pass / 原有 4 条件 skip / 0 fail，107 total，单 worker，exit 0，4.8 分钟。
- dev push 和远端 HEAD：本报告 commit 为待推送身份，提交后核对；远端 CI 不由本地通过代替。

源码已在全部 Gate 后复算，815 文件指纹与开始一致。完整外置日志路径与 SHA-256 见 MBR-001_EVIDENCE.json；历史失败与中间失败结果完整保留。改动源文件清单为 git diff 7a6a191..4c36e95 --name-only，可按两个实现提交分别审阅。

回滚只回退本任务固定代码提交或切回基线开发分支；不删除用户库、工作树、原图和报告，不动 main 与已安装 App。下一分支基线必须使用包含本报告的最终 HEAD。
