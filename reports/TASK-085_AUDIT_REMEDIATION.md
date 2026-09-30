# TASK-085 外审整改证据与失败归因（软件自动化阶段检查点）

**C3固定实现 `a2dc3b9` 的本机完整回归与远端verify、Electron、security全部通过；仍不放行合并 main、替换本机 App、TASK-085/V3完成或真实设备验收。** 本轮保留原CI红灯、三checkout同环境基线及每轮失败，112个历史失败标题均已绑定C3完整自动化通过证据。C3本机/远端Contracts208、Core1557通过/0失败/2原跳过、Desktop863全部通过；Electron原104项100通过/0失败/4原跳过，进程Gate4/4。早期C、C2红灯仍作为历史证据保存；真实设备、独立Original Master/Project对象及Owner验收未补齐。

本轮使用GPT-6.1-sol，报告代理high，禁止GPT-6-sol及代理再派子代理。报告代理仅读代码/日志并写本报告与新机器台账，不代主代理提交推送、不操作安装App，不连接真实源、账号、Roon或声卡。所有本机临时/证据在外置LifeWeave卷。既有结果和覆盖报告由主代理管理，本报告不倒写历史。

## 1. 身份、最新结果与证据边界

| 身份 | SHA |
| --- | --- |
| pre-V3/main任务基线 | `05256eb867e37574e16f23eab877026a229a1703` |
| 父报告快照 | `5edd878010594c7daabc3e5f9eeb1c9d2b87a237` |
| 七文件代码增量 | `2ab45fa919513f512edc9cf3c5800c23779ad0f9` |
| 固定外审快照 | `6d6c1c4c5f28acc9967cff3ef48ef8f91d7c6b5c` |
| 第一整改实现C（已推） | `d0bc464c9c7e345e1f0506dba6b96b459552a805` |
| 第二整改实现C2（已推，verify绿/Electron红） | `5d13179999431b30e53740e8330ab887189cd3f7` |
| 第三整改实现C3（已推，本机/远端完整自动化通过） | `a2dc3b996d28313549a1ab7695b01ed268691e6d` |
| 整改报告提交 | `null`，最终从Git历史解析 |

报告提交最终以`git log -1 --format=%H -- reports/TASK-085_AUDIT_REMEDIATION.md reports/TASK-085_FAILURE_LEDGER.json`解析，不让报告自引用尚不存在的SHA。下一任务基线须最终报告提交及Gate确认，不预填为C/C2/C3。main仍05256eb，安装App未替换。

证据根为`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-task085-audit-99ar22`。以下日志/JSON实际位于该根，没有`json/`子目录。每条机器失败记录包含名称、文件、基线/当前表现、根因或待归因、生产/测试判断、修复及重跑证据；所有红日志保留。

| 验证层（C、C2历史与C3最终） | 实际结果 | 原始文件 |
| --- | --- | --- |
| 本地完整标准verify R2 | exit0：Contracts208/208；Core1559=1557 pass/0 fail/2 skip；Desktop863/863；全部生产build及Preload门禁通过 | `verify-final-r2.log/.exit` |
| 同环境serial全Core | exit0：1559=1557 pass/0 fail/2 skip | `core-final-serial.tap/.exit` |
| 同环境serial全Desktop | exit0：863 pass/0 fail/0 skip | `desktop-unit-final.tap/.exit` |
| 最后Renderer补丁后Vue类型检查 | exit0 | `desktop-final-renderer-typecheck.log/.exit` |
| boundaries/cycles静态Gate | exit0 | `boundaries.log/.exit`、`cycles-final.log/.exit` |
| 正式Electron startup/crash/safeStorage Gate | exit0：4/4，0skip | `root-electron-gates.log/.exit` |
| 正式Electron全E2E R1 | **exit1：104=82 pass/18 fail/4既有skip** | `root-electron-full.log/.json/.exit`、`root-electron-results-summary.json` |
| 新远端verify | **completed failure：Contracts208/208；Core1559=1554 pass/3 fail/2 skip；Desktop/build未到达** | `ci-d0bc464-verify.log`、metadata/artifacts metadata |
| 新远端Electron | **completed failure：104=82 pass/18 fail/4 skip，与本机C失败名单完全相同** | `ci-d0bc464-electron.log`、clean log、local difference JSON |
| 新远端security | completed success，不能代替verify/Electron | `ci-remediation-runs.json` |
| C2完整标准verify R3 | **exit0：Contracts208/208；Core1559=1557/0/2；Desktop863/863；三包生产build/Preload通过** | `verify-final-r3.log/.exit` |
| C2静态control-plane/boundaries/cycles | exit0 | `*-c2-final.log/.exit` |
| C3完整标准verify R4 | **exit0：Contracts208/208；Core1559=1557通过/0失败/2原跳过；Desktop863/863；生产build、类型检查和Preload门禁通过** | `verify-final-r4.log/.exit` |
| C3 control-plane/boundaries/cycles | exit0 | `*-c3-final.log/.exit` |
| C3本机完整Electron R3 | **exit0：104=100通过/0失败/4原跳过，0flaky、0套件外错误，280585.75ms（4.7分钟）** | `root-electron-full-r3.log/.json/.exit`、`root-electron-r3-results-summary.json` |
| C3本机进程Gate | exit0：4通过/0失败/0跳过，32946.045042ms | `root-electron-gates-r3.log/.exit` |
| C3远端verify | **completed success，208/1557通过＋2原跳过/863，与本机计数一致** | `ci-a2dc3b9-verify-run-api.json`、`ci-a2dc3b9-verify.log`及artifact命令日志 |
| C3远端Electron与进程Gate | **completed success：104=100通过/0失败/4原跳过（11.1分钟）；Gate4通过/0失败/0跳过，88977.674ms** | `ci-a2dc3b9-electron-run-api.json`、`ci-a2dc3b9-electron.log` |
| C3远端security（static-security） | completed success，绑定确切C3 | `c3-final-validation-manifest.json` |
| C2完整Electron/远端 | **R2原104范围exit1：92pass/8fail/4原skip，另worker teardown错误；远端verify成功、Electron已completed failure（90/10/4＋1worker错误）、security成功** | `root-electron-full-r2.log`、`ci-c2-runs.json` |

[C远端verify](https://github.com/Matt12377/MusicBridge/actions/runs/36689363781)、[C远端Electron](https://github.com/Matt12377/MusicBridge/actions/runs/36689363699)、[C security](https://github.com/Matt12377/MusicBridge/actions/runs/36689363650)均绑定C，后续状态以新metadata为准。本地pass、远端pass、实际设备与Owner接受分开。


C远端Electron原始终态已经补齐：run36689363699 completed failure，104=82/18/4；`ci-d0bc464-electron-local-difference.json`中ciOnly/localOnly均空，未出现跨环境新增标题。旧`ci-d0bc464-electron-metadata.json`是in_progress历史采样，不能拿它代替已结束日志与新run查询。C2远端[verify](https://github.com/Matt12377/MusicBridge/actions/runs/36691621215)、[Electron](https://github.com/Matt12377/MusicBridge/actions/runs/36691621219)其中verify已completed success、Electron已completed failure，[security](https://github.com/Matt12377/MusicBridge/actions/runs/36691621245)成功，身份与状态见`ci-c2-runs.json`。

C的实现采样`implementation-source-before-electron.json`覆盖66路径，Hash为`a658eda3c3035c1c285b399f9ecd7b154d81bf4bdcf225df19789726088725b8`，主代理按采样逐文件核对后提交。这是Electron前实现采样，不是verify开始Hash，也不自动证明整个验证期间源码不变。C Electron构建目录`root-electron-build-manifest.json`采样44文件Hash，包括目录现有文件；不声称44文件均本次生成，不是签名安装包或App替换。C2的10路径清单`implementation-c2-source.json/.patch`绑定5d13179；C3的8路径清单`implementation-c3-source.json` Hash为`d2d63c1fa14c91b771707f87b1584b54bc84ba04a8bf730928229a37dd528303`，`implementation-c3-source-commit-verification.json`全8路径匹配C3，difference空。前期定向按真实阶段保留；随后冻结C3已完成新的完整本机/远端验证。

## 2. 原红灯、可靠基线与范围差异

| 原固定CI快照 | Core | Electron |
| --- | --- | --- |
| 5edd878 | 1543=1497 pass/44 fail/2 skip | 103=51 pass/48 fail/4 skip |
| 6d6c1c4 | 1547=1503 pass/42 fail/2 skip | 103=58 pass/41 fail/4 skip |

[父verify](https://github.com/Matt12377/MusicBridge/actions/runs/36333174562)、[父Electron](https://github.com/Matt12377/MusicBridge/actions/runs/36333174505)、[固定快照verify](https://github.com/Matt12377/MusicBridge/actions/runs/36335402226)、[固定快照Electron](https://github.com/Matt12377/MusicBridge/actions/runs/36335402270)均已失败，不能继续写“刚启动等待”。本次独立GitHub API检查固定6d的实际四项为dependency-audit SUCCESS、static-security SUCCESS、macos-electron-gate FAILURE、verify FAILURE，没有assert-release-tag-required检查。外审用户文本曾称标签约束通过，与本次实际名称不同；不据此推测外审工具差异的原因，也不以两项安全检查通过替代产品验证；6d当次无上传artifact，当前仅能保存原日志和元数据，不声称取回不存在的附件。实际检查名称证据为`ci-6d6c1c4-check-runs-final.json`。外审未取得新完整日志的边界由本次取证补齐，既有报告历史不改写。

父子CI失败名称Core少2、Electron少7，无新增失败名。名称差集不能证明没有回归，也不能证明同名失败根因一致；Core总数多4与七文件增量对应。原台账保留父44+48=92条，本轮补新执行Desktop16，共108条。固定6d当次仍42+41=83个失败；C本地Core/Desktop原60条全通过，原48 Electron失败30通过、18仍红。另保存C新增远端主流程3条`C-REMOTE-001..003`，累计遇到112个唯一失败标题（另含C2新CI-only Zone规格）；不把它们塞回原基线。112为历史遇到标题数，当前C3自动化失败为0；每条保存原红灯与当前完整重跑结果，不把历史112写成当前112个失败。

本地有效基线使用Node22.23.2、固定Corepack pnpm10.17.1。各checkout的`@music-bridge`局部依赖指向自身并独立构建Contracts，共享第三方依赖。先在每个checkout执行`corepack pnpm@10.17.1 --filter @music-bridge/contracts run build`；各`packages/bridge-core`与`apps/desktop`运行`node --import tsx --test --test-concurrency=1 --test-reporter=tap test/*.test.ts`，shell展开该checkout全部对应测试。TMPDIR采用本轮外置证据根，DEV_BUILD_ROOT/DEV_CACHE_ROOT采用已批准外置路径。

| 同本机基线 | Core prepared | Desktop全unit | 原Electron全量 |
| --- | --- | --- | --- |
| pre-V3 05256eb | 1369=1368 pass/0 fail/1 skip，exit0 | 763/763，exit0 | 99=95 pass/0 fail/4 skip，exit0 |
| parent 5edd878 | 1543=1497 pass/44 fail/2 skip，exit1 | 862=846 pass/16 fail/0 skip，exit1 | 103=54 pass/45 fail/4 skip，exit1 |
| snapshot 6d6c1c4 | 1547=1503 pass/42 fail/2 skip，exit1 | 862=846 pass/16 fail/0 skip，exit1 | 103=59 pass/40 fail/4 skip，exit1 |

原始日志为`{parent,snapshot,pre-v3}-core-prepared.tap/.exit`、`{parent,snapshot,pre-v3}-desktop-unit.tap/.exit`、`{parent,snapshot,pre-v3}-electron-full.log/.json/.exit`，E2E逐例摘要及`electron-three-baseline-comparison.json`保留。

初次`local-5edd878-core.tap`、`local-6d6c1c4-core.tap`因依赖symlink、Contracts dist缺失/可能跨root依赖未形成有效代码基线；保留为环境误跑，不能计算代码pass/fail。另误指定不存在`tsconfig.main.json`的`desktop-unit-main-typecheck.log`exit1同样不计源代码失败，正确配置检查exit0。旧路径检查`e2e-temporary-root-check.log`在repo根无法解析tsx未执行helper，也与实际helper故障分开。

pre-V3整体绿不证明新增范围全部正确。Core原44失败有31精确名称在pre-V3通过、5个schema标题近似匹配、8个新增/改名未匹配；Desktop16有15精确匹配、1缺席；Electron48有44精确匹配、4新增/重名缺席。机器台账记录该边界，不能一概定为生产回归或历史旧测试。Desktop16在父/子本机均同名失败，是首推范围已存在，非七文件新增；它们此前CI因Core先红未执行，标记`newly_executed_desktop_failures`。

父本机45失败对父CI48，只有070大目录、085-print本机外置路径、v1 Home Settings三项CI失败本机通过；子本机40失败对CI41，只有085-print路径例差异。跨环境差异不是整改成果。父→子本机45→40少5（072计划/取消核验、073无设备面板、074明确Plan历史/三层事实），无新增名，仍不能宣称无回归。

## 3. 已修复的Core/Desktop原因与保护

| 归因 | 修改为何符合合同 | 保留保护与证据 |
| --- | --- | --- |
| 当前schema30 vs旧21/22/24/28终点 | 只更新当前正式迁移终点，历史源版本保持原值 | 旧列事实、外键、回滚、拒篡改均保留；serial全Core通过 |
| 人工降级残留新表/trigger | 固定历史DDL创建旧库，不能只改user_version | 故障前后原表/列逐列或字节核对、默认值/外键/rollback；全Core通过 |
| 新表导致旧事实直接全表比较失配 | 历史事实按旧库原表原列投影，新表另核完整性 | 不删除历史守恒；全Core通过 |
| Formal受理后启动失败 | 可信受理返回失败Attempt与原根因、零提交帧、静止证据 | 不补造EOF/drain，不把未知资源状态终态化；全Core通过 |
| EOF/drain后异步verified | 精确Attempt/run等待持久verified，不能只setImmediate | 最终同事务pending+verified屏障保留；全Core通过 |
| Stop之后第二连接篡改 | 先等coordinator.close完成资源收尾再篡改 | 原备份/恢复拒绝与历史字节守恒保留；全Core通过 |
| Begin零受理外包装码 | NOT_ACCEPTED同时核causeCode COPY_UNAVAILABLE | 禁止复用停止实体、原根因保留；全Core通过 |
| output-run追加反复使对象证书失效 | 两个单行mutations精确声明，复用原证书避免历史PDF反复Hash | schema/data_version/额外写/trigger仍失效；完整Core及2失效负例通过 |
| Desktop Print13夹具INVALID_HISTORY | actual master.content/layout.timeline Hash代替占位值，生产严格校验不变 | 原13保留，新增Hash/recipe漂移拒绝、原Record/result不变；863全通过 |
| Plan preview DTO、Replica/Reference清单3例 | 补显式outputSelection endpoint/generation、control第7入口、ZIP preview/receipts只读入口 | missing/UID/假认证、CAS/op/frame、路径/凭据/分页/写command拒绝保留；863全通过 |

固定DDL出处另存`packages/bridge-core/test/fixtures/HISTORICAL_SCHEMA_PROVENANCE.md`：1～6取557cb78b旧定义；9～13取62a20a6d；21为main05256eb干净合成库正式创建；23为固定21加6d正式workspace22/print-version23迁移。helper仅用于合成测试，生产不调用；既有14～20带数据旧原件保留。

对象证书补丁独立静态审查：register/settle仍在BEGIN IMMEDIATE内检查身份/phase，每次实际INSERT精确1行，不支持不存在的幂等0写。SQLite total_changes必须精确变化；schema哈希、外连接data_version、总写入戳、未知trigger、beforeCommit、rollback仍导致失效，候选COMMIT后发布。热路径允许固定3个trigger名称+精确schema/变更戳和单行delta；trigger SQL精确验证属于repository冷开output-run schema审计，不称热事务逐条重验SQL。最终同事务精确pending+verified与输出关闭/输入末验未删除。已查范围未确认新增绕过，两个负例实证未知barrier trigger、额外行delta、外部真实提交后重新核验；不推广为全部设备安全证明。

保留的红迭代：Core focused R1 350=347 pass/3 fail，原因历史22 rollback误改30、遗漏snapshot终点22、schema15旧列投影；修复后R2 5=4 pass/1 fail，新负例外连接no-op未改变data_version；改真实revision+1后`output-certificate-negative-r3.tap`2/2 exit0。标准verify R1 Contracts208/208、Core1557/0/2、Desktop846/16/0 exit1，build未到达；这些红灯不被R2覆盖删除。Desktop定向`desktop-unit-focused-r1.tap`26/26 exit0；serial Desktop原862+新增1冻结Hash负例=863，原16全部保留通过。Core原1547+主流程3+异常7+证书2=1559，新增12已纳入完整verify和serial范围，不靠删测/新skip变绿。

## 4. Electron历史失败与C2断言复核

C本机完整104范围中17failed+1timedOut=18失败，原4skip保持；18全匹配原48失败名。下列为实际新症状，不先替所有失败判为测试问题。

| 台账ID | C失败症状 | C2修改/目前状态 |
| --- | --- | --- |
| E2E-004 | 240长草稿标题scrollWidth超过clientWidth | 标题容器min-width/overflow-wrap生产修复；C3完整本机/远端通过 |
| E2E-005 | 唯一下一步未打开Source | 当前合同先metadata估算，再source；新断言保留Roon估算、masters0与源失败恢复 |
| E2E-006/007/009/037/038 | 旧dialog Picker定位或后续超时 | 改真实inline section；Esc关闭与刷新后焦点恢复生产修复；业务/冷启/回执断言保留 |
| E2E-010 | 隐藏details中的规划combobox不可见，未进入迟到竞态 | 显式展开details，明确选择及竞态断言保留；迟到竞态已在C3完整本机/远端通过 |
| E2E-019 | 多页PDF img strict3 | count精确等于artifact.pageCount且每页高<=360；旧字节/导出零写保留 |
| E2E-021 | 078仍schema21 vs30 | 仅当前终点30，7盘/Replica/备份事实保留 |
| E2E-034 | 关联确认disabled | 补真实必填确认/更正理由，确认与重启重新定位保留 |
| E2E-041/042 | 预留入口旧文案；实心rgb背景与透明inline不符 | 新准确入口/确认；保留disabled/回执/数量；以workbench不存在+inline可见核子页独占 |
| E2E-044 | 冷启ZIP工作区为空 | 生产子组件等待history再挂载，原选中身份/冷启断言保留 |
| E2E-045/046 | 原Render核对按钮disabled | 用户显式选择保存目标，禁用/取消零写/核对证据保留 |
| E2E-047/048 | Axe旧dialog[open]根null reporter | 改实际archive/backup inline根，serious/critical仍必须零 |

C2十文件静态复核未发现删测试或新增skip。Roon/保存目标显式选择与真实合同相符；metadata估算不替代锁源/冻结，因此新masters0保护有必要。PDF由单img改每页及总页数更严格。旧实心背景断言原意阻止底层草稿干扰，当前已获批准连续玻璃与子页独占下，用workbench不存在和实际inline可见保留该保护，不能只因为新实现不满足旧颜色就删断言。C2完整标准verify通过而完整Electron本机/远端失败；这些静态判断当时没有充当行为通过。C3随后通过新的完整本机/远端原范围回归，历史症状与整改迭代仍分别保留。

此前C已经通过的修复也保留归因：069/070 schema终点、077确认文案与renderer指纹、085严格本机/hosted证据根、inline子页与实际草稿入口。CollectionView v-for ref数组被当单实例canLeave是首推生产回归方向（05256无ref/guard，bbc2f7b新增），C改逐个守卫；不能统一归为测试旧定位。Source inline焦点用既有refreshAfterClose，不降低dirty/待回执离开保护。

E2E `ui-e2e-network-guard.ts`属于测试基础设施。真实Electron原HTTPS→data重定向失败，改两精确合成URL本地Response；`offline-image-guard-final.log`exit0，两个白名单160×160加载、3越界拒绝与计数正确，不作为正式App生产网络能力。`e2e-temporary-root-check-02.log`四种合成env exit0（本机外置通过、private/tmp拒绝、hosted真实RUNNER_TEMP通过、缺runner根拒绝），不是实际CI通过；原env入口错误日志保留。

## 5. 干净库主流程、Renderer一致性与录音故障层

Core `main-journey-final.log`3/3通过：源失败恢复、Track/Program编排、冻结身份/归档、默认拒绝及合成Attempt冷启；主动取消无成功档案、冷启不续录；取消后须显式处置及新冻结Plan，旧失败/新谱系分离。输出driver为fake，使用正式Core归档文件输入consumer实际读取PCM并核对帧数/Hash；这一真实Core文件输入层与下文7项合成租期生命周期测试分开，不是真设备采集。

C新增正式生产Electron `task-085-main-journey.spec.ts`单项通过（3072ms）：干净工作库源→草稿→母版/布局→Session→执行/归档/Plan、默认拒绝及冷启不造Attempt，对象身份与持久事实核对。该例使用API合成夹具经正式Main/Preload/Outbox/IPC创建链路，并对UI选择/预检/冷启作行为核对；当前实际持久合同是源binding、draft、master/layout，没有独立Original Master/Project对象。不能宣称全段由用户UI点击完成，也不能替代真实采集；C全量18失败作为历史保留，C3通过后也不扩展为独立Original Master/Project对象或全段UI手点证据。

另确认正式Renderer选plan一致性问题：selectWorkflow成功只存引用，首次显示默认A/B/待估算，冷启却读取plan.spec。C在明确planId、持久回执、同draft/generation后同步spec/baseline，并加dirty/splitDirty/revision复查及current selection.planId==accepted.planId，阻止迟到覆写新编辑/新选择。首次与冷启一致已被新正式流程例验证；等待期间用户编辑和旧选择迟到竞态仍待专门行为证据，未定本批新增P0/P1。

外审函数名需校正：5edd/6d未找到resolveInputCaptureProfile/finishClose，实际store.capture/finishHandle；`c-output-attempt-bound-snapshot-diff.log`只保存attempt-coordinator.ts从5edd到6d的单文件差异，不是全部七文件增量证据；全七文件范围以2ab45fa提交及原增量清单核对。保持外审超时/迟到/取消/关闭失败诉求，不把无法对应的名称泛称物理输入录音成功。

`c-output-attempt-audit-final.log`7/7 exit0，Core types0：start拒绝/失败回执及重复Begin、authorize超时晚返回不造Attempt、start超时迟到handle关闭才释放租期、Stop/晚start保留用户终因、close拒绝保留租期与failedbarrier阻断新输出、close超时有界失败等真正完成后释放、重复Promise/冲突命令及Stop回执不重复清理。两文件recording-output-attempt-audit.test.ts/helpers/output-attempt-audit-fixture.ts采用合成OUTPUT驱动及合成输入租期生命周期；私有acquireInputLease不打开设备或音频FD，readFrames调用会assert.fail，release仅记录合成生命周期。7/7证明这些注入故障下的状态、回执及合成租期清理顺序，不证明真实FD释放、物理input capture、真实设备流关闭或Gate B认证。正式Core文件输入与实际PCM帧数/Hash证据来自另述v3-main-journey3/3，不能移入7/7范围。

C2完整R2中Picker 240字符曲目键盘返回例已通过，实际包含Escape关闭及trigger焦点断言。静态发现Escape冒泡与恢复监听的特殊事件边界尚未复现为缺陷，不据此定生产故障，也不推论全部键盘事件已覆盖；完整R2其他8项失败，因此整体仍未通过。

## 6. 新CI可移植性失败及证据保全

C远端verify三失败均为新主流程创建夹具时access固定本机外置根ENOENT；Linux不存在该路径，未进入业务断言。分类新增测试hosted/local临时目录可移植性问题，不能把生产录音定故障，也不能隐去失败。原42Core未在本轮再次失败；Desktop与build因Core失败未执行，不借本地通过写成远端通过。新增3条记录本地C通过、远端C失败和C2实际Linux重跑通过，原108基线条目保留。

C2 helper只在GITHUB_ACTIONS=true且RUNNER_ENVIRONMENT=github-hosted时采用绝对RUNNER_TEMP；本机要求LifeWeave真实mount、明确外置TMPDIR、realpath包含且可写，拒绝系统临时根，不创建假Volumes。实现已推，C2完整本地verify3例通过；本机通过本身不等于Linux通过；远端C2及C3完整verify工作流已成功，完整原始日志/产物已取回且实际Linux新主流程3例通过。

`.github/workflows/verify.yml`保留原完整verify命令，pipefail+tee保存完整日志、always artifact14天；Electron同样补always产物保存，不缩范围。C verify红灯实际artifact11085790138已上传，metadata与下载目录`ci-d0bc464-verify-artifacts/`保存，证明新证据保全生效，不改写旧6d“无上传artifact”。

C2远端verify run36691621215已completed success，metadata中verify与dependency-audit两个job均success。完整原始日志及artifact已取回，独立核对Contracts208/208、Core1559=1557/0/2、Desktop863/863。`ci-5d13179-verify.log` Hash为`198eb51fb859c0287f76aff6923afaa4632dd94c5f6c8fcb34f5068610e405bb`；artifact内verify.log Hash为`20adc943be4065878ef31804aa4dfc897bb9e02d204eb0f9f40e29c7708d044f`，不能混同API包装日志与原命令tee日志字节。C2本机R2已结束exit1：104=92pass/8fail/4原skip，另worker teardown30s超时不属于任何单例，不伪增为第9个测试失败。原48失败标题中40通过、8失败；新增正式主流程保持通过。相对C的18减少10个，仍不宣布全量绿灯。

保留C2 R2历史的8项失败：071多规划返回execution后details新挂载收起（E2E010），078备份旧dialog locator（021），v1草稿下一步source期望实际media（037），冷启分面预留编号不显示（041），Logic210s超时（044），两PREP保存目标label不可达（045/046），备份旧库raw Buffer字节不等（048）。每条保留新的完整error与C2身份；这些后继症状不能当时就全部写成定位失配；C3已确认库存选择持久引用与Main退出两处生产问题，备份验证窗口按退出点重新隔离，后续归因和定向结果见下文。worker teardown错误列出DAT/母版/Logic执行过的规格，独立保存，不据此推翻通过单例或隐去套件失败。C3生产/测试修改与具体证据由主代理决定，本报告不操作源码。

C3已提交推送的生产修复：mediaChanged使用子页accepted.result精确plan.id持久写workspace引用，并加seq/draft/spec/revisionfence；Escape.stop防自身关闭键触发interaction取消焦点恢复。已冻结C3；规划冷启先定向通过，随后完整原104本机/远端均通过，C2/R2红灯不改写。048原旧库字节采样发生在第二次App启动之前，差异窗口包含冷开、UI、播放与激活；C3以真实旧Core退出点隔离字节基线及旧collection_*事实，具体证据见下文，不仅凭Buffer变化定激活缺陷或物理漂移。

C2远端Electron终态已由canonical `ci-5d13179-electron-run-api.json`确认：run36691621219、head5d13179、completed failure。新CI完整日志已保存：104=90通过/10失败/4原跳过、1worker teardown错误；相对本机92/8/4，CI-only为合法大目录分页与Zone加载提示两例、localOnly空。大目录属于原E2E003，Zone是新暴露C2-REMOTE-001，不能硬判为新增生产回归；一次gh旧remoteview EOF产生的`ci-5d13179-electron-metadata.json`为0字节，不作为有效证据或引用。

C2真实CI逐例解析后，原48台账有39通过/9失败，本机为40通过/8失败；新增Zone加载规格原来不在108条中，parent/snapshot/pre-V3/C/C2本机都精确通过，CI在固定100ms等待后loading提示不可见而失败，单列`C2-REMOTE-001`（原108＋C新主流程3＋Zone1＝112唯一失败标题），后续C3通过held Promise控制可靠时序，并在完整本机/远端通过，旧CI瞬态失败保留。不能缩原104范围，也不能仅因本机复现不了就剔除CI失败。

C1 Electron artifact现已完整下载并通过CRC与安全entry路径检查：43928094字节、3176 entries，zip Hash `419c3b15438a9a115eaedcd6af5214ecc34a98d797df8e2181336482710b018d`，证据`ci-d0bc464-electron-artifact-full-download.json`。早期partial与下载失败仍保存；这是新C上传/取回的artifact，旧6d无artifact事实不变。

J09后继诊断已确认**真实生产退出缺陷**：`j09-diagnostic-r3-uncaught-results/.../logic-main-uncaught.jsonl`明确记录`TypeError: Object has been destroyed`，stack为Object.unlisten（dist4687）→revoke（1737）→BrowserWindow.closed（1750）；`j09-diagnostic-r3-native-results/.../logic-will-quit-native-sample.txt`中Main在NSAlert runModal。生产`apps/desktop/src/main/index.ts:1279`的onInvalidated cleanup在closed后再次读取window.webContents getter，对已销毁原生窗口抛异常；Electron原生错误弹窗阻止最终进程退出，所以Coreexit0、outboxclose/willquit到达不能证明Main退出或case通过。

此前Inspector互等/驱动关闭假设撤回；Debugger ending只是未定位阶段观察。setImmediate退出或Inspector特殊关闭workaround不进入最终方案，所有红诊断及late test.info回调/worker错误保留。主代理已最小改为登记时捕获contents对象，cleanup对该EventEmitter解除监听，避免closed后访问窗口getter；修改已在C3冻结提交；最后J09定向1/1退出0，正常close约210ms、关闭前捕获ChildProcess的exit0、uncaught0及两次accepted/rejectedZIP原号/历史/Hash/不覆盖冷启均通过，随后冻结C3完整104本机/远端通过，未扩展为真实设备或Owner验收。

独立git blame确认该cleanup行来自TASK085首推bbc2f7ba；它不是6d七文件或C2新增。**“原七文件抽查未确认新增P0/P1”与“后继运行现在确认首推生产退出缺陷”属于不同证据范围，必须同时保留。** 不泛称整个分支此前已证明无严重问题，也不把parent/snapshot早期停在offline图片的不同症状全部重定为该关闭根因。

C2 Electron artifact11086578974已完整取回：有效ZIP为`ci-5d13179-electron-artifact.zip`，47557267字节、SHA`909a860184bf50ead0089d9f082e82e2a75e8169baddb55b60bed6c68e1b47c9`，3195 entries/290209576解压字节，CRC/PATH PASS；root结果`ci-5d13179-electron-artifact-full-download.json`为COMPLETE。重复下载的`ci-5d13179-electron-artifact-full.zip`仅3996691字节、exit-15，另留duplicate-aborted记录，不能与有效ZIP混同。C1完整artifact及原partial同样留存。

J09确定根因使本轮不再只剩测试合同适配；必须验证实际生产退出修复。报告代理未改生产或测试，也未提交/推送。

C3定向历史必须按真实运行分别记录：`root-electron-focused-r3`10项6通过/4失败、exit1；`root-electron-focused-r3-followup`4项3通过/1失败、exit1；`root-electron-j09-final-focused-r3`最后J09单项1通过/0失败、exit0、8.6秒。`electron-c3-focused-closure.json`逐项记录所有失败、后继症状和最新通过；10个C2 CI失败各自有定向通过，**不是一次10/10，也不替代冻结C3完整104**。J09首轮后继失败为close后重读electronApp.process的测试观测错误；改关闭前捕获ChildProcess后，最后一轮是第三次冷启本来恢复Logic子页、旧测试仍找工作台入口；明确核冷启子页后通过，原pending清除/ENOENT/history/原号/Hash/不覆盖断言保留。生产destroyed-window异常与这些后继测试错误分开。

排序测试现在先证明direction不能跨默认A/B（提示、save disabled、持久曲序不变），用户明确移至A后才同面排序，reverse/冷启/删除保护继续保留。PREP明确选择准确已完成Render importJobId，新增未选择报告disabled，REJECTED、两帧差异、原件字节与冷启保护不删除。大目录分页同时核每页API metadata与UI，不仅同12条数量；Zone held Promise先loading再释放loaded，原真实状态断言保留。

备份证据`backup-c3-boundary-evidence.json`中第二launch前Hash9f2dc4d9...与真实旧Core exit0瞬间Hash620e8f47...不等，旧基线跨运行写入窗口不适于隔离“退出后激活不改旧库”。新同步退出点基线不可覆写，原激活及candidate冷启bytes.equals均保留并定向通过，同时核collection_*行before/after与原modelsIDs；不声称collection_*已覆盖inventory_lots/inventory_ledger/physical_copies全部库存账本表。没有以移除字节保护消除失败。

C3最终完整结果已核对：标准verify R4、原104项Electron与进程Gate均退出0，远端[verify](https://github.com/Matt12377/MusicBridge/actions/runs/36698688790)、[Electron](https://github.com/Matt12377/MusicBridge/actions/runs/36698688779)、[security](https://github.com/Matt12377/MusicBridge/actions/runs/36698688704)均completed success且head精确为a2dc3b996d28313549a1ab7695b01ed268691e6d。`ci-a2dc3b9-check-runs.json`的实际四项检查为macos-electron-gate、verify、dependency-audit、static-security，均SUCCESS；security工作流唯一job为static-security，不绑定发布标签约束结论。原始日志和API已实际取回，不能以早期in_progress采样倒退最终状态。`c3-final-validation-manifest.json`现保存23个日志、产物、比较与实际检查文件Hash及三个检查身份；原13项Hash保持不变，新增完整附件回执、真实check/security job、原6d实际checks及文档阶段3静态Gate的日志/退出。新版manifest整体Hash已在机器台账重算，不沿用旧整体Hash。

`root-electron-r3-post-verification.json`及Gate后核对中sourceDiff为空、44个构建文件Hash全部不变。`electron-baseline-to-c3-comparison.json`逐名保存父本机45失败、快照本机40失败在C3完整原范围通过；4个原有skip与pre-V3/父/快照完全同名单，没有新增skip。Core原42、父44，Desktop原16以及C新增3路径、C2新增Zone问题均绑定当前完整通过；旧失败截图、堆栈、原始日志及后继诊断不删除。完整回归通过仅表示这一自动化范围闭合，不将早期假设全部追认成已独立证明的单一根因。

C3 Electron artifact11089895294已完整取回并校验通过：49937334字节、3225个ZIP entries、292279051解压字节，SHA1383c3cf5bfb6ffa4b78eb94929333ac64781294eb75d8073ab49346865684ff；CRC与安全路径PASS，remoteDigestMatched=true，与GitHub元数据digest完全匹配。最终回执`ci-a2dc3b9-electron-artifact-full-download.json`为COMPLETE；有效ZIP为`ci-a2dc3b9-electron-artifact.zip`，解包目录为`ci-a2dc3b9-electron-artifacts`。首次gh api下载1200秒超时的32964608字节部分文件`ci-a2dc3b9-electron-artifact-timeout.partial.zip`与`ci-a2dc3b9-electron-artifact-timeout.json`仍保留；随后有界Range续传308.2秒成功，没有覆盖或删除原partial，不把部分文件算完整附件。C3 verify原始日志与artifact命令日志已完整取回，SHA分别为99666fff907778662ed3ff96c8b8e8eca67135f9c2ed194f2049856a33d8ca57与5382ebbcb60b947180395fed6eea906b673677bdc5a0fa0e515e022ff932b46a；Electron完整原日志SHA9374c959a4e4cfc2d34313689da876aeb37be29579173ff3e251841ef80687ea。API包装原日志与tee命令日志字节分开记录。

## 7. 保留的验收阻断与下一证据

C3已完成新的标准verify、原104 Electron、进程Gate及三个远端检查，原有跳过名单保持；全量失败阻断在这一自动化范围已闭合。C/C2红灯与诊断仍留存，完整附件及初次超时记录现已取回，最终字节索引已补齐。下一实现变化后不自动延用C3绿灯身份。主流程使用合成API夹具，独立Original Master/Project对象与完整用户UI路径仍未覆盖；真实设备和Owner验收阻断继续保留。

63映射29已接入/13部分接入/6可发现或占位/15待验证或补齐不是完成率；MVP30不是30项已验收。Session/Track模板/Program/真实采集证据/失败链/导出迁移回滚/产品撤销状态须绑定具体证据才可升级，当前不因底层合同自动升级覆盖台账。

真实设备正常采集/主动取消/异常中断、真实源/Roon/账号、听感、实体打印、安装/发布、Gate B及Owner接受均NOT_RUN。无设备revoke1/1与合成输出故障矩阵不能互替；真实设备需用户明确授权。P4/P5与WAVE-3/4 carryover继续保留，旧冻结078～084容量authority/window不重放。即使后续全自动化通过，也不自动合main、替换App或宣布V3完成。

## 原始证据字节索引

机器台账同时保存路径与更多Hash；以下是当前关键日志/manifest字节，不是源码或构建物整体摘要。

| 文件 | SHA-256 |
| --- | --- |
| `ci-5edd878-electron.log` | `35c989861ada19a2d791e7b758d4a7709e0a13320dcfb133dbda831ce453d0bc` |
| `ci-5edd878-verify.log` | `a6ce273e43287b67325de9628b313938ed9d2500d20b212fb0c9c3be59f3183e` |
| `ci-6d6c1c4-electron.log` | `57b97d4e4693a084a3314510caff23bb0f92e685c49769c91450c7a3b1f0c6e7` |
| `ci-6d6c1c4-verify.log` | `a448c7491b3c16100898b2705724e0bfa50bbf8d795506dcd983dd24d6997c6b` |
| `root-electron-full.log` | `19836ed81be559a5a2be989cd8f9c37ab9b6ed27c2c72f938cc61b8b24d32343` |
| `root-electron-results-summary.json` | `373d38a26163ea67c8ffb8920f5e01513a6374629715d234489c5d053d845acc` |
| `ci-d0bc464-verify.log` | `08f9f29d0ae2367e0ee94ffdf1ac3a2a50669773ce07d8b919de65592b6389f6` |
| `implementation-c2-source.json` | `f9dbde3a83ee9b13acdbdf6df1f8f566cb29eb41de763e64673858498d8200b0` |
| `ci-a2dc3b9-electron-artifact.zip`（49937334字节，COMPLETE） | `1383c3cf5bfb6ffa4b78eb94929333ac64781294eb75d8073ab49346865684ff` |
| `ci-a2dc3b9-electron-artifact-timeout.partial.zip`（32964608字节，历史超时，不完整） | `1535142fa6f13eb3bf07d0de5624f0809de055a67efdf37fb640ea88a8fef181` |
