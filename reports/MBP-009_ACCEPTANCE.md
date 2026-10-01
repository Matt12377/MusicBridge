# MBP-009：全量软件验收与依赖安全收口

固定实现 `862876a1d4cd21e77a48a283b873d2b28094717a` 的原完整本地门禁及同 SHA 远端 verify、security、Electron 工作流全部通过。此前三轮红灯的原始证据和具体归因保留；本结论只覆盖软件范围。

基线：`6ac36f63ca044d74c838768a2f68490541d22647`（MBP-008最终报告）；开发分支：`codex/mbp-009-acceptance`。实现包含 `399d5a61` 的依赖/strict 修正、`bc36362d` 的导航屏障、`8f77a4eb` 的搜索定位与 `862876a1` 的归档静止屏障。独立报告提交由 `git log -1 --format=%H -- reports/MBP-009_ACCEPTANCE.md` 解析，机器状态在后续交付提交记录其完整 SHA；不把报告提交当作已验证的源码 SHA。

898 个固定源码文件 SHA256：`dd07d75f6b7b3e1e7beb92dfc66c2cac1a68aab994c7d3b9d479fad0ac535e8b`。锁文件 SHA256：`46de57baa6d1b1a360af8cbeabec1ced2a33223db1eda13c589bbd867e62b99a`。源码按冻结清单排序，将路径 UTF8、NUL、文件原字节、NUL 累加 SHA256；范围为 tracked apps/packages/scripts 中 ts/vue/mjs/cjs/json/yaml/yml/js 及 workspace 清单，包含 scripts/native/build-ffmpeg.mjs；不覆盖原生 C++/Objective-C 源或忽略的构建产物。本轮没有这些原生源的 Git 增量。报告、任务与进度文件另作差异检查。

## 最终改动及原保护

- 三条精确父依赖 override：API4.40.1 和 utils0.4.4 的 Axios1.19.0→1.20.0；get-uri6.0.5 的 basic-ftp5.3.1→6.2.1。保留直接依赖、父包、原 electron-vite 补丁和其他 importer；没有 audit ignore、阈值变更、audit fix 或无关批量升级。完整 YAML 逆向还原与真实 nested CJS 解析分别验证最小 delta。
- 完整 v1 加入原 strict E2E 配置：原17个 include 保留，现18个。正确来源取得30诊断/exit2→0诊断/exit0；首次外置配置找不到类型的入口失败另存。14处 ProcessEnv 注解、14处 defined-string launch 转换、AxeResults 类型及 recipe schemaVersion1 拒绝包含运行时保护，不称纯类型修改。
- task070 重载以 DOMContentLoaded、原首页和新增 Core ready 为屏障；原求购/outbox/幂等/历史/scope/SQLite 断言全部保留。
- v1 搜索可见性严格限定搜索歌曲表；相同曲名同时出现在合法底栏时不再产生全页定位歧义，仍要求 exact/strict/visible。表内重复标题仍失败，只有底栏有标题不能冒充搜索成功。
- seedRecordingPlan 等待归档 `phase=FINALIZED、active=false、issue=null` 后才固定身份。归档持久阶段之后还有文件巡检，内存运行记录在 finally 中撤下；阶段完成与资源静止不是同一屏障。task085 原完整冷启身份深相等、Plan、工作区、outbox、不造 Attempt、原字节及未认证输出断言未改。

原 v1 的1973个 expect 调用数量、228项注册签名、23个环境删除、100+100进度循环、0/396902帧保护保持；最终只有明确记录的搜索 locator 参数修正。各屏障 delta 逆向恢复后与对应父提交整份文件逐字相同。原108项、4项条件 skip、Core原2 skip、总超时/expect/导航超时不变，没有 `.first()` 或新 skip。

锁文件生成器曾移除原 SheetJS0.20.3 tarball integrity，已恢复原校验值并重新 frozen install，两次正式安装 exit0。版本/tarball规格不变；未取得安装前后 SheetJS 实物字节差分，旧证据过强字段的更正单列。

## 固定实现的原完整软件门禁

| 范围 | 新鲜结果 | 实际退出 |
| --- | --- | --- |
| verify/typecheck/三包生产构建 | Contracts254；Core1948+原2skip；Desktop1219；类型与构建全部通过 | 0 |
| 定向安全 | 29/29 | 0 |
| mock Electron启动/崩溃恢复/保险库/冷启动 | 4/4，真实系统钥匙串未验证 | 0 |
| 原完整 Electron E2E | 108项：104通过+原4跳过，0失败/0flaky；最终JSON已封存 | 0 |
| control-plane/boundaries/cycles/diff | 全部通过，cycles372文件 | 0 |
| 原production audit high门禁 | high0、critical0，另6moderate | 0 |

Node22.23.2、pnpm10.17.1。每个 runner 检查 LifeWeave 为真实可写外置 disk11s1；构建、缓存、临时文件、结果和日志均在外置卷。共享构建和测试由 Root 串行执行，源码在各门禁前后逐文件比对。最终完整 E2E JSON 单独封存，后续定向运行不会覆盖它。命令 argv、实际 exit、日志/产物 SHA 见机器证据。

## 同源码远端与失败归因

[verify与dependency-audit](https://github.com/Matt12377/MusicBridge/actions/runs/36910131425)、[security](https://github.com/Matt12377/MusicBridge/actions/runs/36910131539)、[macOS Electron](https://github.com/Matt12377/MusicBridge/actions/runs/36910131352) 均为 completed/success，绑定同一完整实现 SHA。Linux原完整 verify 254/1948+原2skip/1219、security29；macOS startup4、完整 E2E104+原4skip，0失败/0flaky。远端JSON四项skip名称与本地原四项逐一匹配。

全部原始日志已保存。最终verify ZIP187,196字节/SHA `c7825ce253a4bda557e244e51eb53f62de1695d8ded8554c21cdcc973c77b4f2`；最终macOS ZIP65,972,110字节/SHA `d9b4f67ba1e812d017c853fa4cad9c5d6819f5f1c329446ec891f268d6b3a6a0`。单次下载自然退出0，ZIP独立重算与远端API/上传摘要一致，选定日志/JSON经CRC校验；完整ZIP留存，非只保存绿色截图。

三个早期快照的红灯全部保留，不能只呈现最终绿灯：

| 固定快照 | 远端完整 Electron | 原因及修复保护 |
| --- | --- | --- |
| 399d5a61 | 103通过+原4跳过+1失败 | task070 default load 30秒超时；首页已有业务内容、冷启 pending 断言已过，后续断言未执行。隔离挂起装饰 PNG 证明 DOM/home/Core/outbox 可先就绪；未识别该次远端具体阻塞资源。bc 仅调整真实 reload 就绪屏障并增加 Core ready。 |
| bc36362d | 同 SHA 两次分别104+4通过、103+4+1失败 | task070均通过；后一轮 v1 全页严格定位匹配歌曲表与底栏两个合法曲名。同时确保两元素可见/count2，旧断言 RED1；相同夹具限定搜索表后整条原 case GREEN0。首次 grep 无测试和仅等待底栏而通过的运行不算 RED。 |
| 8f77a4eb | 103通过+原4跳过+1失败 | task085 初始归档快照 active=true、冷启false；其他身份相同。初始 identity 已从远端 ZIP 核对。实际 coordinator afterPhase 暂停 FINALIZED，复现同样完整深相等 RED1；等待完成/静止/无故障 GREEN0，冷启完整历史严格相等。首次外置 .ts 被当作CJS的入口失败另存；有效 .mts RED/GREEN单列。原主流程定向1/1 exit0，不能替代全量。 |

各失败 ZIP 独立 SHA256 与远端上传摘要相同，选定文件经 CRC 校验：399为65,694,497字节/SHA7fa1fedb…；bc为61,187,284字节/SHA1bf64b50…；8f为68,168,437字节/SHA42cce8e9…。原日志、JSON、错误快照与8f初始 identity 均封存。bc 本地完整 JSON 后来被定向默认路径覆盖，该轮仅以完整原始 stdout/exit/源码保护作为计数证据，不伪称完整 JSON 已封存。

base6ac至8f 的归档 coordinator/transaction、seed 与主流程四文件逐字相同；源码和受控机制支持夹具快照采早，不能据此断言整个分支没有生产缺陷。计划 UI 本来要求 FINALIZED 且 !active；只读预检未启动归档；Core 关闭先等 archive.close 再关仓库。独立只读审计支持三个具体屏障/定位修正，未删业务断言；它们不是全架构安全证明。

## HTTP、FTP及依赖审计

HTTP/FTP兼容执行绑定399；最终后三个 delta 仅变测试文件。最终只读身份校验确认全部生产/lock/已安装依赖字节相同，因此沿用旧执行证据，明确不是在最新 SHA 重新运行了兼容工具。

HTTP实际 Axios HTTP adapter/ClientRequest、生产 API search/login_status/weapi/song_url_v1 xeapi 到固定 loopback fixture，28用例/39请求，自然退出0、signal=null、未超时/无自动 retry。覆盖原字节、gzip、redirect、非2xx、timeout/abort、错误归一与独立 xeapi 加密响应。weapi只检查加密字段，未独立RSA解密。utils固定目标仅工具内改为 loopback，生产 unblock 禁用。22 agents销毁、socket0/server关闭，60 DNS方法护栏、DNS尝试0/外域连接0；源码/依赖前后同身份。

FTP四组 parser/CJS/API/未连接关闭断言与六个 loopback 组件 exit0：LIST、get-uri MDTM、MLSD回退、Unix缺modifiedAt的原ENOTFOUND、missing及cache ENOTMODIFIED。两条成功流各13原字节/SHA一致；错误/缓存不发 RETR。11个准入连接、60 DNS护栏、0实际DNS尝试；库socket在harness收口前关闭，最终socket0/listener0、自然退出0/signal=null。parser首次worker PATH缺/usr/sbin、FTP首次数字地址listen被DNS护栏拒绝均是工具失败；按明确根因仅修PATH/同步listen字面量处理，重新绑定后执行，保留原失败。两个8秒deadline仅覆盖worker，前后身份扫描在其之外。

兼容边界：不绕过 basic-ftp6 的 PASV host 收紧，仅127.0.0.1 EPSV；没有真实FTP/FTPS、独立PASV host、真实Provider/账号、Roon或设备证据。get-uri RETR中断后的Promise生命周期风险仅静态记录，未执行该故障、未修其生产代码。

新鲜779远端审计11moderate/8high；本轮原 plain `audit --prod --audit-level high` 为0high/0critical，另6moderate。默认本机镜像audit endpoint不存在的 exit1 保留；仅审计命令指定官方registry，不改全局设置。官方 JSON 为6moderate但 exit1，已核固定 pnpm10.17.1 JSON分支按总漏洞数返回1；plain high过滤分支实际exit0，不能冒充JSON exit0。

六项moderate继续保留：qs6.15.3（API→utils→express→qs）的 GHSA-x5fp-wj9c-mxmx、GHSA-4mjr-xmp4-gh2g；ip-address10.5.0（API→pac-proxy-agent→socks-proxy-agent→socks→ip-address）的 GHSA-rpw4-54j3-4h4q、GHSA-2vr4-cq9g-pvrc、GHSA-j6r3-76f7-8jcv、GHSA-h3mg-xc3c-68pw。审计通过不等于零漏洞或已证明真实应用不可达。

## 交付与尚未验收的范围

源码实现已非force推送，源阶段远端 HEAD 精确为862876a1…；报告与机器证据使用独立提交，之后只更新交付状态解析报告完整SHA。最终报告提交、交付提交及开发分支HEAD核对记录由 project/STATUS.json、project/PERFORMANCE_PLAN.json 的 reportCommit / deliveryCommitResolution 给出，实际push/clean/head/source复核另存 FINAL_DELIVERY_RECEIPT.json。源码CI绑定上述实现SHA；报告与状态提交不冒充另一次完整源码CI。下一分支基线为最终交付HEAD，仅作基线记录，不放行未授权真实验收。

性能结构及测量沿用各固定任务报告，完整进度见 project/PERFORMANCE_TODO.md。008的原135较小规模与99个原5000 phase按不同runner归档；baseline parent实际0/candidate parent实际3准确保留，不写成234项全部runner exit0。四条最终 Owner 路径2000合成控制p95约0.115–0.224ms满足20ms软件目标；它们不是实际UI/Roon时延。同 Owner 录音 Stop/PCM受控排队结果见008报告，不能替代设备验证。

P4/P5、真实Roon/音频、真实采集/异常中断、系统钥匙串、Gate B、Owner验收仍未执行；软件11/11不代表V3产品完成。未合并main、未替换正式本机App、未发布、未自动迁移或删除用户数据。原未跟踪 apps/desktop/test-results/、worktree/ 保留。回滚只在Owner另行明确授权后使用独立revert提交。
