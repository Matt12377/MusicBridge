# RUST-016 CI、安全与可移植基线结果

本轮六组冻结修复已通过软件与真实CI Gate。C01历史夹具可移植、C06生产high审计及verify/Rust/Electron/E2E实际失败均有新鲜闭合证据。当前报告快照等待独立报告提交、远端身份与新G0记录；封存的000/015记录不重写。完整Rust迁移、真实服务、正式安装/发布及Owner验收未完成。

## 交付身份

- base：`dd2a7e537039d10151af840945a717701fb5ea1b`；隔离分支 `codex/rust-core-016-ci-security-portability`。
- 实现提交按顺序：`a1d45db8`、`2b20d351`、`e43b201b`、`043a56357a62966e4091da567d007332e5df223f`；结果报告独立提交。
- 报告提交解析：`git log -1 --format=%H -- reports/RUST-016_CI_SECURITY_PORTABILITY.md`；提交后HEAD/remote/clean与闭集由外置最终收据核。没有伪造自引用SHA。
- source06冻结76文件及其摘要、所有自然失败/成功原件在 [机器证据](RUST-016_EVIDENCE.json) 的外置引用中。报告/元数据更新仅改变当前入口，不借旧PASS覆盖后来源码。

## 改变与结果

| 冻结范围 | 最终行为 |
| --- | --- |
| CI上下文与输出根 | runner上下文在合法step解析；本机只写已挂载LifeWeave，真正hosted严格采用专用RUNNER_TEMP子树/realpath/dev约束。 |
| 合成profile边界 | 正式wrapper固定外置根；测试显式依赖注入可信reader，marker/nonce/OFFLINE/权限/关闭规则保留。 |
| Rust双host准备 | 完整原30项Gate一次运行后，两host按同run/source/binary/artifact闭集移交；不glob最新或伪造成功目录。 |
| Electron身份 | 固定官方43.4.0资产与npm integrity/checksum/ZIP→本平台exe/完整dist均实核，消费者不接受env自报SHA。 |
| 历史来源 | 4冻结片段保留原raw SHA、indices、提取器、producer/build identity；旧Source08缺字段仍拒绝，当前合法settings单独验证。 |
| Provider安全兼容 | API4.40.1唯一raw RSA换Node原生定宽实现；12exports/其他源码字节及64旧黄金不变，实际postimage为2fb5a857…；真实pnpm锁/patch后才删除exact父包未用forge边。 |

两正式源码审查至source02结束，四项P2已关闭，无剩余确认P1/P2。其后主控因实际Gate观察修正补丁格式、hosted夹具硬编码、两报告env、native fork的undefined可选env以及重试按钮定位；这些是实测处置，不升级为第三轮独审。官方Electron本机反证是undefined值同步`Invalid value for env`，省略或全string能启动；远端旧05日志没输出该TypeError，报告不补造远端stderr。

## 新鲜验证

本机完整Rust为source06/run-0VY4KW的30/30，自然exit0；同run两host及官方ZIP/dist消费者重核exit0。完整Electron12/12、完整E2E104通过+4原条件skip、0失败/0flaky，自然exit0。准备边界48/48、加密兼容82/82含64黄金、4历史原行为、标准high审计exit0，6moderate/0high/0critical保留。早期本机完整verify为source02的4142通过+2原条件skip；source06的完整verify由真实远端独立重新执行同计数，不能把旧本机结果冒称source06本机全量重跑。

source06真实GitHub四workflow全部自然attempt1/success、6job成功：[Rust Core 只读原型](https://github.com/Matt12377/MusicBridge/actions/runs/37167594003)、[electron-e2e](https://github.com/Matt12377/MusicBridge/actions/runs/37167593936)、[verify](https://github.com/Matt12377/MusicBridge/actions/runs/37167593888)、[security](https://github.com/Matt12377/MusicBridge/actions/runs/37167593953)。原日志、job/steps、artifact digest与双平台Rust各30项见机器证据。

原自然失败完整保留：首轮verify的4个startup VM准备失败；source03 hosted夹具失败；source04/05私有host启动失败及E2E未执行；本机旧E2E103+4+1定位歧义；native诊断01到边界前超时。目标RED、反事实移除patch/override、registry/cwd/golden准备失败以及JSON审计遇moderate退出1分别分类，不当作最新产品失败或PASS。

四system startup/crash/vault/recovery与两private explicitmock host层独立；host报告的systemKeychain NOT_RUN不覆盖system测试结果。所有这些仍非真实账号/Roon/音频、正式App安装或Owner验收。

## 当前准入与后续

本报告仅证明C01/C06软件+实际CI条件；已有Owner阶段交接指向 [原授权范围](../docs/postrust/MBRS-000/AUTHORITY_SCOPE.md#owner-current-session-explicit-phase-handoff)。独立报告commit/push后主控核精确remote HEAD与不变生产输入，再以新的ADMISSION_DECISION记录有限Node+Rust阶段准入，旧000的NOT_ADMITTED历史保留。新JSON只记录已核授权和事实，不自行授权真实文件/Zone/网络/发声/安装/发布。

下一任务为001隔离HTTP+官方薄SDK/原Adapter合同工具，从最终交付HEAD新建独立任务分支；已有两只读准备清单不是001实现或验收。缺真实Core/Zone/样本许可仅对应live BLOCKED_ENV，软件部分继续。Node dataset owner仍唯一业务库writer，Main仍唯一outbox writer；默认Node、可选Rust收藏只读OFF。原18task/156criteria与原14未完Rust框完整保留，后续平台/live/Owner和旧录音Gate分别登记。
