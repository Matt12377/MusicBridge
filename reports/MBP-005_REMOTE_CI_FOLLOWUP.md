# MBP-005 固定报告提交的远端 CI 后续

核对提交为 `4ac88f5a9a3a3ae8ae36d1da14c02a284dd098c3`；本记录新增于后继 MBP-007 分支，不修改此前固定本地证据的含义。

远端 security 36835564017、Electron E2E 36835563971 已通过；verify 工作流 36835564019 失败。其中 verify 作业 110282023366 的 Contracts 250、Core 1877（原2跳过）通过，Desktop 1133通过/1失败，未进入生产构建；独立 dependency-audit 作业 110282023674 仍为11 moderate/7 high失败。

唯一失败测试是 `MBP005：50/500/5000合成条目逐页读取，pool只留最多8窗口页并报告精确bytes`。全部业务断言已执行，随后测试把观测JSON写入固定的本机证据目录，Linux报ENOENT。这是新增测试的可移植性缺陷，不能归为旧问题，也不能把整个verify称为通过。

MBP-007内的对应修正只将观测JSON改为Node TestContext的TAP诊断，保留50/500/5000、8页、8MiB、保留item数等原断言；测试无需额外文件系统目录。Root同时为原account.changed真实App函数夹具注入新网格epoch及图片clear端口，保留账户恢复/不重复profile/daily保护并增加一次同步失效断言。该文件49/49、0跳过、退出0；新提交仍需原全量Gate与远端CI，局部通过不替代。

原作业日志、测试产物及实际退出码保存在 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mbp-007-root-gorkf37p/`。下载到的原verify.log SHA256为 `6bcddae8de37a9311847c3920b39607064aada5df1839db11256fdabe2c212a6`。依赖问题继续在MBP-009闭合，真实账号/Roon/录音设备/main/App替换/发布未执行。
