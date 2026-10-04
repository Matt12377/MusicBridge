# RUST-016：CI、安全与历史证据可移植基线

状态：限定软件与实际CI Gate通过、独立报告已交付、有限G0已录入；最终证据round2由提交后外置原件解析。基线：`dd2a7e537039d10151af840945a717701fb5ea1b`（MBRS-000 最终报告）；分支：`codex/rust-core-016-ci-security-portability`。MBRS-000 实现 `a83c39b`、报告 `dd2a7e5` 已正常推送，本轮实际身份由外置收据核，不改封存000/015。

Owner 已明确连续执行 v1.2；本任务为 C01+C06 唯一 Rust 基线前置修复，允许隔离离线实现与合成验证。产品 G0 继续 NOT_ADMITTED，直到真实受影响 CI / 安全 Gate 闭合；本任务不接入本地曲库 / 播放、不移交 Node writer 或 Main outbox。仅一个产品写作者 gpt-6.1-sol/high；主控串行安装 / 构建 / tests / 报告 / push，两个审计角色只读，不派生代理。

## 冻结范围

1. `.github/workflows/{verify,rust-core,electron-e2e}.yml`：非法 job.env runner 上下文迁到合法步骤；verify 明确真实 hosted runner 专用 TMPDIR；Electron 同 job 完整执行一次原 verify:rust，并复用该成功 run 两 host trees，不 glob 最新、不伪造目录、不加 skip。
2. `apps/desktop/src/main/{packaged-renderer-main-probe,collection-scale-main-probe,collection-scale-core-observer}.ts`、新增 `synthetic-profile-root.ts`、受控 test helper 与原三份 test：提取无环境选择的严格 profile / marker 校验；测试显式依赖注入可信根。正式 wrapper 和 index 默认保持固定 LifeWeave 外置根；静态 diagnostics、OFFLINE、nonce、dev、realpath、0700/0600、闭集字段、seed SHA、完成标记及关闭规则不削弱。
3. 两 `apps/desktop/scripts/rust-*-host-gate.mjs`、两 `apps/desktop/e2e/rust-*-host.vite.config.ts`、新共享 `build-storage-root.mjs` / 类型声明 / 负例、`scripts/ci/verify-rust-core.mjs` 与成功 receipt 消费器：真正 hosted 与本机目录分别严核，输出 / TMP / cache同批准根；源 / Rust binary / 全量 artifacts / aggregate / 本次 PASS 绑定，两根向本 job 显式传递。业务路由和所有原 Rust 检查 / 预算保持。
4. 固定官方 Electron 43.4.0 平台资产校验与只读身份验证器，替换 collection 测试的本机 arm64 exe 常量，并在 main / startup / Playwright配置消费：锁文件 npm integrity、固定官方 checksum、已核 ZIP推导真实本平台exe及完整dist输入。env只选 receipt，不能自报expected SHA；不重复下载已有合格cache，不引入新完整运行架构。平台 / 文件 / 链接 / Framework / 资源串改都拒绝。
5. `apps/desktop/test/rust-core/collection-scale-{cost,evidence}.test.ts`、新 repo-relative历史fragment helper、四冻结片段 / provenance、来源说明与提取器：保留全部原事件与断言、原raw SHA / indices、提取算法 / producer manifest / build identity。Source08原15事件仍按原缺selection/paint拒绝；独立当前合法settingsFixture精准测discarded，不能补旧字段造正例。CI不读取外置raw、不missing skip。
6. 精确 API4.40.1源码 patch、`pnpm-workspace.yaml` / `pnpm-lock.yaml`、离线crypto兼容测试 / 64+官方旧包黄金向量 / 独立模幂：仅其唯一forge raw RSA调用改Node22 `RSA_NO_PADDING`，按模数宽左补零，weapi逆序 / 参数与全部12exports保持。源码完整替换后才删除exact parent已不用的forge依赖；原生产 audit high阈值与官方registry真实执行，不伪版本 / ignore / 降阈值 / 删除Provider功能。

上述新文件具体命名由实现时的文件清单绑定，所有变更必须可归因到这些六组。`AGENTS.md`、STATUS、Rust TODO、PostRust台账 / 报告由主控最后整合，写作者不并行编辑。额外范围必须先向主控说明原因。

## 第一轮 RED 与分步执行

本轮冻结依赖初始 install exit0，初始树 clean。旧生产 audit RED02 对官方 `https://registry.npmjs.org` 退出1：6 moderate+1 high，node-forge GHSA-86w9-cpqp-85rv、patched None；外置 `gates/rust016-baseline-audit-red-02/output.log` SHA256 `753ac6140fbe651da11c97d93eb7e6c87c51e3cb1a9a8a9b6cc7f1ea5d032ae5`。首次npmmirror audit端点准备失败原件保留，不混为产品RED。

第一批新行为 RED 直接调用既有 `createCollectionScaleMainProbe`：传入显式 profileReader，当前应忽略该依赖，导致期望调用一次 / 必须传播reader拒绝的断言失败。使用原合格外置受控fixture，不以缺函数、编译错误或不存在目录冒充行为失败。附带独立工作流 job.env runner上下文检查，当前 Rust 工作流应失败；这是配置结构证据，不是远端运行。

主控串行运行后才交回实现。写作者不得自行重跑构建 / App / 性能实验或动 lock / patch抢先制造GREEN。后续各组用明确根因负例和适用回归，冻结后只跑所需最终Gate；不为文档消费者重复13个App。

首批命令（在新树并明确外置 TMPDIR / 输出目录）：

```bash
cd apps/desktop
node --import tsx --test --test-name-pattern='RUST016 受控profileReader' test/collection-scale-observation.test.ts
cd ../..
node --test scripts/ci/test/rust016-workflow-context.test.mjs
```

`test-name-pattern`排除仅用于本轮有效RED的 focused行为；所有其它原测试仍须后续适用完整回归，不将focused排除数升级成最终PASS。

## 完成证据与边界

六组精确源 / lock / patch / fixture及实际命令、退出 / timeout / skip分开保存；至少有效正例和针对目标原因的拒绝。Linux完整 verify、Rust各目标真正执行、全部Electron子项及后续E2E、安全实际audit分别记录。新远端不通过不宣称C06全闭合，本地验证不替代远端；历史raw可移植也不冒称新App / 真实服务。

当前不连接Provider真实账号 / Roon、不发声、不扫描真实全库、不源写、不改DSP/音量、不重启真实Core、不合并main / 正式安装 / 发布。根 / 文件 / Zone / live、旧录音Gate B/P4/P5、媒体完整包、Developer ID / 公证 / 其它平台和Owner最终反馈分别保留。

回退只撤本轮精确CI / 测试准备 / 依赖补丁与锁变更；没有用户数据库或源文件变更。安全替代回退后必须恢复OPEN / NOT_ADMITTED，不用卸除补丁后的旧高危依赖宣称安全PASS。实现与独立结果报告提交由主控完成，下一任务从报告最终HEAD接续。

## 写作者首批实现交接（尚待主控GREEN）

首批行为RED实际完成：2个profileReader断言失败（旧实现调用0次、未传播拒绝），1个workflow上下文断言失败；contracts-build退出0，无模块缺失/skip/cancel冒充。实现已保留原RED断言。所有新源码/fixture/patch由本次freeze收据绑定；写作者没有运行安装、测试、构建或提交。

真实patch源码已替换唯一forge调用，workspace已登记exact patch与删除已不用forge边。锁文件刻意交主控通过真实pnpm生成：先 `corepack pnpm@10.17.1 install --lockfile-only --ignore-scripts --registry https://registry.npmjs.org`，再原frozen install。不得手写模拟patch hash。实际安装后crypto SHA应为 `2fb5a857004faf85f669f0c5bf2755d53859bf27011dfe0410969f62bc8570a6`；原64黄金与12exports差分入口是 `apps/desktop/test/provider-crypto-native-rsa.test.ts`。

最终验证由主控按以下明确入口串行排班，全部指定外置私有0700 TMPDIR；这段列出待执行入口，不宣称通过：

```bash
corepack pnpm@10.17.1 verify
node --test scripts/ci/test/build-storage-root.test.mjs scripts/ci/test/rust016-workflow-context.test.mjs scripts/ci/test/rust-electron-host-receipt.test.mjs scripts/ci/test/electron-archive-tree.test.mjs
cd apps/desktop
node --import tsx --test --test-name-pattern='成本05实际|Source08原settings|当前合法settings完整选择' test/rust-core/collection-scale-cost.test.ts test/rust-core/collection-scale-evidence.test.ts
cd ../..
corepack pnpm@10.17.1 audit --prod --audit-level high --registry https://registry.npmjs.org
node scripts/ci/prepare-rust-electron-hosts.mjs
node apps/desktop/scripts/prepare-electron-identity.mjs
```

两个prepare在本轮新目录写自然成功receipt并打印精确路径；本机后续测试显式设置所打印 `MUSIC_BRIDGE_RUST_HOSTS_RECEIPT`、两host root与 `MUSIC_BRIDGE_ELECTRON_IDENTITY_RECEIPT`，CI由本job的GITHUB_ENV传递。不得取glob最新或借失败run目录。Rust prepare一次完整原verify:rust构建/类型/协议/组件/成本与验收，父进程固定本次CARGO_TARGET_DIR，完整成功后才核run/source/artifact闭集并移交；它不代表Electron验收。旧host单独build/components入口保留，Electron消费必须使用这一完整成功链。

Electron官方installer安装到本轮依赖树只属于离线Gate准备，不是正式App安装；如果当前dist已经存在，仍独立核官方ZIP与完整实际树。当前只准入已pin官方43.4.0 darwin-arm64/x64资产；不把ZIP SHA冒充exe SHA，不消费env自报expected。随后运行完整test:electron、test:e2e，安全静态入口和Linux/macOS远端CI分别记录真实退出。补丁取消与精准override取消各保存独立敏感性证据，再恢复本轮精确配置；不能改原high标准。

C01 focused入口仅运行原Source05两行为、Source08原拒绝与合法settings精准discarded，共4项；原七签包/完整外置图270验收仍属既有独立App验证，不能为了clean CI无差别重放、补造正例或加missing skip。


## 第1轮四项定点修复（待主控复验）

正式CI审计P1=0/P2=4、所有权审计已提交。源码写权仅在主控交回后用于这四项：startup在合法mode/keychain CLI后、首次mkdir/spawn前核真实Electron；原VM明确stub官方身份外部边界并核调用/拒绝；prepare-Electron在任何下载/落盘前严格核TMPDIR且下载/receipt复用同值；两host CLI默认build并删除不可满足all广告/分支；xlsx resolution恢复原HEAD同一URL的原SHA512。未改生产API补丁/override/golden、业务coordinator/writer或主控元数据。

两个host脚本build/components入口继续原合同，明确electron/acceptance消费本轮完整prepare的成功树与收据；不新增第二pipeline或单host fallback。原完整Rust producer两调用与human-session构建均已显式build；本轮不重写历史任务/报告。新增廉价入口为 `scripts/ci/test/electron-preparation-order.test.mjs` 与 `scripts/ci/test/rust-host-gate-cli.test.mjs`，已接原verify工作流明确离线边界步骤。startup原test新增调用/拒绝及非法mode覆盖，仍保留mock/system参数、marker与自然close断言。

写作者只执行 `git diff --check`，不运行安装、测试、构建、App或Core。root接回后先frozen install、startup原test及上述精准边界测试/fullverify，随后一次原Rust prepare、官方Electron身份与Gate；正式审计第2轮依据最新freeze与真实收据。提取器已有输出保护P3仅记bounded carryover，原冻结提取器/历史事件字节不改。


## 主控后续实测处置与结果

两正式源码审查已结束，四P2关闭；实际CI随后暴露hosted夹具硬编码和private host env包含undefined，本机完整E2E暴露两同名重试按钮定位歧义。主控按原边界修复，原生产根/正式Core环境白名单/所有业务断言/原skip不削弱；新增12条实际wrapper行为测试接原verify准备步骤（共48）。两末尾报告路径显式传入。补丁格式修正由真实pnpm重新生成锁hash，没有手写锁身份。

最终source06实现043a5635：原Rust30、完整Electron12、完整E2E104+4原skip、真实远端四workflow六job均自然成功，完整verify远端4142+2原skip，原标准high审计0/6moderate。全部旧失败、反事实、原始stdout/退出和来源SHA保留，见reports/RUST-016_CI_SECURITY_PORTABILITY.md与RUST-016_EVIDENCE.json。两formal源码审查只对各freeze作结论，主控后续处置不冒称第三独审。第四角色仅最终证据round2封存。

本轮C01/C06软件及实际CI条件通过；报告commit/push和闭集重核后新记录有限G0，原000/015历史不改。下一001仅隔离合成HTTP与官方薄SDK/原Adapter合同，缺真实样本/Zone/Core/网络许可不偷偷播放。完整迁移、原14未完框、旧录音/平台/live/Owner另保留。

报告提交已实际解析为 `e37b3ad70a23c2c80e649a462626046473ad75cd`，remote/clean/source06闭集与原18task156AT均实核。新ADMISSION_DECISION符合原schema，mode=EXPLICIT_PHASE_HANDOFF/decision=ADMITTED，准确指向已有Owner授权及本轮范围；完整迁移/真实动作/Owner不由G0软件记录授权。准入记录与当前入口单独提交，下一001从最终HEAD接续；第四最终证据round2外置封存仍待本次提交后解析。
