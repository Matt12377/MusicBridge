# MBP-003B：先播放与按需补队列的软件交付

本步骤固定实现 `77101e160cfe9d5f1fdaa244ce92cc670cd7424a` 通过原完整本地软件 Gate。与已完成003A共同组成MBP-003，总进度6/11。继续006、005、007、008、009；没有放行main、正式App替换或V3设备验收。

- 基线：`02125604ab19a62f85a7b75d84b400f9d0e3f105`（MBP-004最终报告）。
- 分支：`codex/mbp-003b-demand-queue`。
- 首个实现：`1fff4d99963fb48f9ebb26194031b38f1f08900d`。
- 最终实现：`77101e160cfe9d5f1fdaa244ce92cc670cd7424a`。
- 报告提交：包含本文件的提交；用 `git log -1 --format=%H -- reports/MBP-003B_DEMAND_QUEUE.md` 解析，避免自引用SHA。
- 下一分支基线：本报告最终HEAD。

## 最终行为

Roon公开页返回可选opaque playbackContextHandle。选中曲目先派发，首次确认后最多预取一页；Renderer不先收完整专辑或歌单。Core从已授权公开窗口同步取得initial，随后使用独立owned Browse session，UI取消不破坏已接受续播。scope/service/Zone失效及非法handle在停止旧播放前拒绝。缺字段和显式回滚开关保留旧合同，不对无效handle静默降级。

补页在控制串行通道外进行，以租期、generation、Zone和当前对象核对后短提交；prefix/suffix保留原QueueItem对象。Next/Previous、自然推进和手工队列索引使用接受时对象锚；Stop、替换和clear立即撤销补页，迟到返回不能重启或污染新队列。手动append/insert在独立事务中补齐来源，失败时可见队列和游标保持原样；容量5000包含新增预留项，不切片伪成功。

后台曲目有response-only可信roonItem，保持收藏和重播。动作快照使用原ReferenceMap内有界路径；每次独立action session重新验证并在实际派发处核scope和Zone。保留003A实际SDK完成屏障、未知Stop资源锁与录音保护。

## 验证

| 原范围 | 结果 | 退出码 |
| --- | --- | --- |
| 完整verify | Contracts237；Core1802通过+原2跳过；Desktop1020；三包类型/生产构建通过 | 0 |
| 原mock Electron启动/恢复 | 4/4 | 0 |
| 原完整Electron E2E | 108项：104通过、原4条件跳过，零失败/零flaky | 0 |
| control-plane / boundaries | 通过 | 各0 |
| cycles | 350文件，无新增循环 | 0 |
| 整批git diff --check | 通过 | 0 |

837源码文件，Gate前、verify后和全部Gate后SHA均为 `dc33ee87495aa18f7c4f93a6611971af6ef0276c32f9494a184897bb96dcabdc`。源码指纹定义、每次实际退出码与完整日志Hash见 `reports/MBP-003B_EVIDENCE.json`；外置根 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mbp-003b-root-J0mXVv`。没有缩小原范围、删除保护断言或新增skip。

作者最终定向：Core5规格128、Controller145、Renderer9文件75、runtime/Utility85、Main/Preload11；Root合同新增7项。50/500/5000条生产runtime合成组合均先派发所选曲目，随后最多读1页、窗口不超过101条；这是调用顺序和工作量证据，不是真实Roon毫秒成绩。

首个固定实现完整verify在Contracts新测试helper参数类型处退出2，尚未到达测试及完整构建。后续提交只添加IpcCommand类型注解，生产逻辑和行为断言不改；新固定实现重新跑原全量。Root早期并行标准typecheck含共享pretypecheck构建，不能称独立隔离；最终verify顺序重建全部三包。新增Core测试一次尾随空格导致staged diff退出2，纯空白修正后退出0；原记录保留。

## 独立审计与失败证据

两轮独立集成复审已封存。真实RED捕获prefix补页期间数字索引变更导致错播，以及数组值冒充context.error枚举；两份外部行为规格原断言保留，最终2/2、退出0。审计production输入绑定首个实现，最终提交仅测试类型delta，软件Gate覆盖最终代码。首次30文件manifest核对因新增Core测试一处尾空格失败，已按精确空白delta复核；不把该轮失败伪称指纹原样。

其他实际RED包括Core缺handle、源根数量变更退休；Controller边缘多读、队列外切歌撤销、事务编辑与Stop前后对象锚；Renderer首次派发与取消/迟到恢复；Root合同、实际Main handler和Utility。命令入口错误、search load夹具不遵守offset/count、async assert.throws及类型错误均不计生产RED。详细作者日志和最终manifest已Hash封存。

## carryover与证据边界

- 本地sourceEpoch仅表示遍历身份，owned epoch独立，不能证明上游数据永远不变。保留路径/索引/hint复核，源根数量不匹配退休。
- 原生Transport没有权威ended原因。仅新鲜同Zone/完整曲目身份、无手动意图、2秒内playing观测、已知时长尾部±1秒时保守推断续播。缺时长/位置或外部中途停止保留手动Next；近尾部外部Stop无法可靠区分，不声称设备级结束证明。
- 保留数据和实际RPC预算不等同RSS。取消/释放不提前回收未真正完成的SDK工作预算。
- 真实账号、Roon、音频、设备录音、GateB认证、main合并、正式App替换/发布均未执行。
- 前一报告0212560的远端已结束：security、Electron E2E和verify作业通过；verify工作流因dependency-audit失败，原始日志确认11moderate/7high。后续009闭合依赖，不能标全CI绿。
- 本分支远端CI在报告创建时未执行；push与远端HEAD核对单列，不替代软件或实机验收。

## 回滚

`MUSIC_BRIDGE_INCREMENTAL_ROON_QUEUE=0`不发新handle、拒绝提供的handle，回到既有全collect。回滚不提供等价性能证明，不产生第二所有权协调器。
