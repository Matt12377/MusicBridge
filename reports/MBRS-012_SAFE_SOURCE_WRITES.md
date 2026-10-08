# MBRS-012 受控源写、独立备份与明确恢复

歌曲标签、内嵌封面和目录封面在有限格式、字段和属性范围内可预览执行，保留歌曲/资产ID并提高修订，生成具体撤销或恢复计划。源写默认OFF，只能经可信Main给具体计划签发权限；旧MB-only入口保持。

九条原产品AT仍PARTIAL；真实用户库、Provider、Roon、NAS、设备、听感和Owner为NOT_RUN。Node为唯一SQLite作者、schema34、可选Rust OFF，旧011 SOURCE_FILES和旧读模块保持只读；010真实检索/拖入与录音Gate B/P4/P5 carryover保持。

Base `09370f19d4422be3b387047999a0722961c52e1e`；最终源码S5 `7166e12d7474957041f5d747db5dc9300f7e9ee7`，单父直接继承S4 `a30818185b7e30110cb9156110e955a8f191a90e`，分支 `codex/mbrs-012-source-writes`；base累计147路径、直接变化6路径均取实际Git清单。报告提交由 `git log -1 --format=%H -- reports/MBRS-012_SAFE_SOURCE_WRITES.md` 解析，不写自引用SHA；源码/报告各普通push。

## 具体行为与安全边界

Renderer不接触路径、FD或权限材料；原最终按钮经Main和独立私有端口执行。accepted、COMPLETED、UNKNOWN分开；UNKNOWN不自动重放/重新签发，冷启动先装共享读取保护。撤销/恢复生成新READY，复核修订、原件及外部改动。同卷库外quarantine与无覆盖link仍保留非原子窗口、备份、journal和恢复材料；ACK未知与回滚不移除材料/保护。四word共享表、2048总槽和128单批不变。

Native FLAC及严格ID3v2.4.0 MPEG1 LayerIII仅固定前部标签区，audioStart不变、空间不足拒写。六字段set/remove保留非目标多值、未知frame/block、顺序、编码/span和音频payload。PNG/JPEG及目录创建/替换/原缺失恢复分别覆盖；有限Mac provenance-only/空属性profile绑定实际证明，未知xattr/ACL/flags拒写。Frozen/Prepared/录音历史Hash、默认OFF与具体Main授权不扩大；原body六字段/op九字段/schema1保持。

## 四次源码自然CI失败与原证据

S1 `5a27b640007413c7a94c2bdf04f89b7eeeb25776` 新增UI观察用例失败，自己的012 Gate skipped。真实SFC Promise未完成即断言在本机受控延迟可复现；25ms真实SHA延迟RED后等待原事件GREEN，CI物理WebCrypto延迟未测量。S2 `5d33ebe11ed1faf128e05dcb9fea6271aea3cd47` 原002 Gate失败，自己的012仍skipped；本地Core41 RED40pass/1fail、201窗口实际消费202，窄修同步水位/本源域增量后GREEN41。202是单独本地RED证据，不称读取远程raw assertion；原67 Gate与预算保留。

S3 `7aa5985d056fead250bf4413f07e8ff7b661b957` 自己的012 Gate实际failure，前序002～011及014成功，自然verify run37730091186/job113157013948保留。完整失败zip的平台digest/整包hash及选定summary、sanitized logs、Reader binding/admission有Root实读收据；9/10阶段、contracts88/88，Core216阶段exit null/SIGKILL/timedOut true、180012.168717ms、观察到close；无overflow/capture/preparation/group failure，Desktop122未跑。远程Core没有完整最终counts、单容量case时长或raw assertion。

S4 `a30818185b7e30110cb9156110e955a8f191a90e` 的首次自然4workflow/6job为4成功、2失败：verify37737372808/job113179885984自己的012 Core216实际180008.195358ms timeout、exit null/SIGKILL/close，contracts88/88，Core最终counts不完整、Desktop122未跑；Electron37737372881/job113179885361在原069第141行page.reload的30000ms load导航等待失败，后续恢复业务断言未到达。原Hosted113用例为107通过、1失败、5条件skip，准确分成1私有014B＋4原native。完整verify job日志raw101与Electron两个选定range成员、解压长度/CRC/SHA分别绑定原生产者；Electron整480MB zip未完整下载/digest核验。具体远程Core单case根因及具体load阻塞资源均未证明。

前三轮各5job成功/1verify失败，第四轮4成功/verify与Electron双失败；全部attempt1、自然push，不取消、不重跑。原UI、水位、文本守卫完整对象及旧87/App88/Gate94封存为历史，原执行head/图不重写。S3文本守卫窄修及18630零错差分、31/17快检、工作树86与精确94属于原S4资格证据；不能借为S5当前生产产物。见[四次失败与当前修复](../docs/postrust/MBRS-012/evidence/ci-ui-repair.json)。

## 当前数据捕获与加载屏障窄修

只有三个生产/测试路径：012 UTF-8计数仅对typeof string且全串ASCII使用length，其它字符串/运行时值仍用原TextEncoder；私有码点排序以双独立偏移逐codePointAt、首异提前返回，保持相同排序符号，不建码点数组。walk/Reflect/descriptor/canonical encode和JSON转义后字节预算不变，孤立代理在捕获仍拒绝，旧011/014 canonical、预算、原capacity断言和426测试数均不变。

原17合同case只在原canonical用例增加67593字符串＋4非string运行时值对原编码器的差分、32keys×32插入旋转的独立旧排序/完整canonical/SHA及精确JSON UTF-8 B−1/B/B+1预算。旧S4 helper带初新增断言、优化helper105b各17/17真实通过；原全部assert字节未删除。106先因新增测试表达式的TS2352止于contracts-types，未到Core，该原失败保留；修正绑定原编码器runtime alias后106b原10阶段426/426。

069仅将reload同步屏障改为domcontentloaded并保留原首页可见assert、添加真实Core ready轮询；原三case名、全部业务assert、120s case/30s navigation/5s expect、retries0保留。受控104 RED在真实背景图片请求hold时原load超时，GREEN在图片请求仍hold时实际完成原业务断言；请求侧等待后原continue没有伪造响应内容，也不证明完整资源load完成。103实际是无扰动原S4通过，初install路径失败已明确纠正，不计受控RED；受控本机结果不反推远程具体图片根因。

本机CPU102采样walk32.029%、原TextEncoder23.329%、码点比较8.550%，范围是单个原capacity用例CPU样本。106b Core实际84303.880667ms、原capacity22754.322791ms，是本机观测；不冒充远程同case时长或受控性能benchmark，原180000ms阶段/420000ms总/4194304输出预算与runner判定保持。

## 当前完整回归、Gate与提交绑定

verify107原标准命令自然退出0，4701总、4699通过、2既有native条件skip，包含类型、单元和生产构建。1422当前源/测试图 `a6bedf5cf85c5ea87faba0baf67fed88581f4157cf3a8644f9fefebe3ac97260`、623产品图 `7d78de3b2922a620bef46168f42195888afac13af1ae60da4ba419ef403a6168`。工作树106b与精确提交Gate114各10阶段426/426（88/216/122）、无fail/skip/cancel/todo；fresh Reader/Worker、类型和自然close/exit0/null实际完成。

精确Gate114为1460声明输入，全Git为2400实际blob、合并图1461；逐项对应最终S5提交字节。范围是声明输入，不等于完整工具链传递闭包。见[精确Gate](../docs/postrust/MBRS-012/evidence/source-gate.json)、[源码绑定](../docs/postrust/MBRS-012/evidence/source-identity.json)、[当前verify107](../docs/postrust/MBRS-012/evidence/local-standard-verify.json)。

旧E2E58原完整命令exit1：113总、108通过、1个私有014B基线准备失败、4原native skip；保留原P1/P0/103表/35 retained后B59单项原assert1/1 exit0，去重适用109/109，`fullOriginalCommandExitCodeWasZero:false`保留在整个旧对象。旧App37/build33、verify72/App73/Gate79、verify87/App88/Gate94仍为原执行，最终SOURCE与旧E2E图差异实算为 `["apps/desktop/e2e/task-069.spec.ts", "apps/desktop/test/mbrs012-ui.test.ts", "packages/bridge-core/src/collection/local-catalog-store.ts", "packages/contracts/src/local-catalog.ts", "packages/contracts/src/local-source-writes-data.ts", "packages/contracts/test/mbrs012/source-writes-contract.test.ts"]`，旧build33产品差异为 `["packages/bridge-core/src/collection/local-catalog-store.ts", "packages/contracts/src/local-catalog.ts", "packages/contracts/src/local-source-writes-data.ts"]`，不沿用旧4/2或原两差异。

首次本机112原完整test:e2e实际exit1，113总/108通过/1失败/4原native skip。私有014B在原第217行Main evaluate安装showOpenDialog回调时观察到Promise GC，原103和冷启动断言尚未完成。首轮完整report、原head/图/退出独立封存，无修改无隐藏；这不是第五次SOURCE自然CI。无源码/test变化的112b只运行原B，1/1通过、原103/9persisted writes/两自然关闭证明属于单项诊断，不代替完整原113命令，也不证明具体GC原因或修复。

当前112逻辑域绑定112c无DEBUG完整原test:e2e命令，实际自然退出0，113总/109通过/0失败/4原native skip，retries0，无flaky；069三原case实际通过。原私有014B使用既有封存P1的独立真实副本与四个真实私有环境输入、原103及保留资产assert实际通过，未借Hosted条件skip。C的源1422/产品623图绑定当前S5；原命令包括重新build/privateCore，其独占112C before/after产物清单分别封存，after 956份身份 `80bcce57f34be6032bcd20ee85d26e0ff7cc3032bfb4a6d61f97390ccea7f5b1`，不要求跨build相等，也不借App108的956图替代。见[原58/B59与独立当前112](../docs/postrust/MBRS-012/evidence/local-e2e.json)。

## 当前生产App108及独立输出

App108仅使用verify107当次生产构建，956产物身份 `4bab695330a072365847704b8310641466d54eae380146fee5706e6e0935136f` 在App运行前后保持。13 plans为默认OFF 1BLOCKED＋6正向/6逆向COMPLETED、14实际操作、3次自然关闭0/null、外联/pageerrors0；冷启动历史和修订保持。真实Main/Core/SQLite覆盖两格式标签、PNG内嵌/目录、两曲batch和undo。本App没有JPEG、HTTP lease、活动播放/录音lease或应用故障注入；旧88输出不替代本轮108。见[当前生产App108](../docs/postrust/MBRS-012/evidence/production-app.json)。

独立核验未导入writer，6音频payload/非目标span/order/ffprobe/完整PCM、14安全操作、7恢复、57全FD及144真实工具（28媒体/116属性）通过；独立inode备份、0600备份/0700目录、属性和目录缺失恢复分别核验，Root110再次逐材料哈希。脚本/EXECUTION/RESULT/Root110全部本轮108，不借旧88/73或Core202材料；后续重编dist不重写App108当时产物证明。见[独立输出](../docs/postrust/MBRS-012/evidence/independent-app-outputs.json)。

AT05原同Owner/Gateway ID/revision1→2→3、旧URL404空body/新HTTP完整bytes/undo原SHA，AT06原inverse READY和新grant后等长外部改写两窗口，保留Root51/56原证明并在新Gate重跑。属于有限本地软件，不提升为真实Roon/native播放或Owner。

## 源码与独立报告

最终源码 S5 的首次自然 push CI 为4条workflow、6个job，全部success，自己的012 Gate实际成功；5份制品仅核唯一、未过期、平台digest及精确生产者元数据。只有本轮S5成功source制品内容未下载的范围；S2/S3失败制品选定内容读取、S4原verify job完整日志与Electron两个选定range内容分别记录。S1/S2自己的012 skipped、S3/S4自己的012 failure保留；前三轮各5job成功/1verify失败，第四轮4job成功/verify与Electron双失败，不取消、不重跑。S4的Core216实际180008.195358ms timeout及Electron069 load等待失败不据本机profile认定单case或具体远端资源根因。本机当前112c完整原命令109通过/4原native skip与原S4 Hosted107通过/1失败/1私有B＋4native skip分别保留。报告自身CI和最终seal仍须提交后实际核验。见[源码CI](../docs/postrust/MBRS-012/evidence/source-ci.json)。

R仅17指定路径及允许的交付字段/引用，单父直接继承最终S5。R普通push、自然2workflow/3job、实际report-only或full模式、远端HEAD/clean由之后私有 `MBRS012_FINAL_DELIVERY_RECEIPT.json` 实际封存。报告CI和最终seal不预写PASS，不创建第三个自封口提交。

原18任务/156AT、有效17/150保持，015取消六AT为N_A非PASS非completed；九AT只追加evidence_refs，真实层仍未跑。013从实际sealed R继续，随后016→017→mobile。常规开发测试与提交push已有授权；Owner负责最后试用及需本人操作的设备/系统权限/听感。安装、公证、main合并和发布未验。
