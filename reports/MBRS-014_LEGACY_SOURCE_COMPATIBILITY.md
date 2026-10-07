# MBRS-014 旧收藏、录音与冻结来源兼容结果

本地发行现可通过独立、可追溯关系关联旧实体发行、数字记录和当前录音来源。确认、解除与逆向撤销沿既有 Outbox 执行；原对象及其业务历史保持独立，未建立本地关联的 Roon/native 入口继续保留。活动读者、录音与 Frozen/Prepared/Archive 来源加入保守资源保护，为后续写回与移动提供拒绝依据。

本次是有限软件交付。八条原产品 AT 总体均 PARTIAL，真实用户库、真实 Roon/NAS/音频/录音设备与 Owner 最终试用未跑。Node 仍是唯一 SQLite 作者、schema34，Rust 只读及源写 OFF；012/013 的实际 writer 未由本任务提前实现。010 在线封面检索失败、真实拖入未跑及旧 Gate B/P4/P5 等 carryover 保持。

Base `b33357c09e6bded2b4c6c5acfcf7330e68366a5f`，主要实现 `b17963fe32e7a73fe0c5ee34f4ae3febebaa38f1`，CI总预算修正 `c4bd13c1b4ab020461f831790c64414090db28dd`，Electron触发修正 `bdf3dfe36606a1dd4c0e9a8b52e4189e49474f13`，最终交付源码及取消测试同步修正 `5700f7a63ee963b656a6c2b4a795eb8af0b70ca0`；分支 `codex/mbrs-014-legacy-source-compatibility`，91 个明确路径。报告提交由 `git log -1 --format=%H -- reports/MBRS-014_LEGACY_SOURCE_COMPATIBILITY.md` 解析，内容不写自引用 SHA。私有 profile、原始数据库、运行夹具、日志和截图未上传。

## 验证与源码身份

标准 `corepack pnpm@10.17.1 verify` 实际退出0：4666总、4664通过、0失败、2既有条件 skip，contracts/Core/Desktop 与 E2E 类型检查、生产 main/preload/renderer 构建通过。014 有界 Gate 为404/404（contracts56、Core225、Desktop123），10阶段；与全量覆盖有交集，计数不累加。本地标准验证在最后的取消测试同步修订前执行；修订后原011完整门禁再次226/226，最终源码014门禁及自然CI独立重新核验。Gate 自身20/20，control-plane、boundaries、cycles均退出0。提交后再次对精确实现 SHA 执行404/404与10阶段，1379个声明输入前后不变且全部匹配 Git blob。

656个实际 build003 生产输入与1379个 Gate 声明输入合并为1437个不同 Git blob，逐项与实现 SHA 核对；实际 App E2E 源码也精确匹配。build003源身份 `2e7259aea6f15323fb153241918962e212b0c61bf3e6f256c81ce50b1e1cf571`、905个当次生产输出身份 `5db3b54e3c44fc80ea0fddd0487672bdece95564c57536e00a63b8b128cd0702`，App05前后都不变。范围是声明输入，未声称完整编译器/工具链传递闭包。见[精确源码 Gate](../docs/postrust/MBRS-014/evidence/source-gate.json)与[源码、构建及 App 绑定](../docs/postrust/MBRS-014/evidence/source-identity.json)。

标准验证会独立重建 Core：656个生产源仍精确相同、904个旧输出字节相同，唯一差异是自动生成的 metadata-reader-worker.bundle.build.json 构建收据。其生成器包含当次时间；历史完整收据没有另存，因此只报告实际单文件差异，不声称完整旧收据仅两个字段相异。这是独立重建的收据变化，不是 App05运行期间输出漂移；初次过严的905全等核对失败也保留。见[本地验证](../docs/postrust/MBRS-014/LOCAL_VALIDATION.json)。

直接父实现 SHA 的自然 push CI 为4条workflow、6个job，全部首次运行success，014自己的Gate实际成功。标准类型/构建、安全、依赖审计、Rust双平台、Electron启动/故障恢复和生产E2E按各自步骤核对；没有重跑或取消。见[源码CI](../docs/postrust/MBRS-014/evidence/source-ci.json)。Root完整读取精确最终source的公开verify job日志，并按实际标准步骤边界核266/2769/8/1623四组，总4666、4664通过、2既有skip，与旧本地回归分开记录。最终成功运行的CI制品只核公开生产者与digest元数据，未下载内容；历史失败011的原artifact另已完整下载校验并记录。Hosted Electron实际107 passed、5 skipped（12.6m）：014 A实际通过，014 B因没有私有P1明确NOT_RUN，其余4项是原生输出/执行资产条件用例。Root已完整读取公开job日志并核汇总、5个具体跳过名及生产者SHA；不替代本机2/2，也不计真实设备通过。

## 生产 App 与非空旧数据

实际生产 build003 上 A/B 两项2/2通过、0 skip，合计四次正常退出0/null。A使用自制非零 PCM/WAV：真实扫描、具体发行、实体新建、关系确认/解除/撤销及冷启动历史；B从自有非空 P1 派生副本进入实体、数字、当前来源三种关系，同样各确认/解除/撤销，随后更改 MB 显示与选图、查看磁带墙/旧照片、打开关闭参考目录并确认回入口焦点。A3+B9共12条持久请求都正常 ACK，冷启动 identity/状态精确保持，没有自动重放；外联尝试与 pageerrors 均0。B旧扫描授权使用原公共缓存指纹，原生选择回调调用0；不把它报成新原生授权。原180/240秒预算与旧测试断言保持。见[生产 App](../docs/postrust/MBRS-014/PRODUCTION_APP.json)。

B的103张原表全部比较 schema、列与 typed cells，100张原值不变。其余三张仅按具体真实动作派生：ZIP唯一样本epoch从1→2→3；工作位置source rev1→workbench rev2→cold source rev3；ledger按对应实际命令 UUID、完整闭集请求指纹、结果 JSON 与各次 boot 时间窗核对，首次两行在冷启动后逐字节保持。没有整表或历史行豁免，业务历史例外0；原P1基线103表本身未改。Frozen/Prepared/版本/录音完整事实、35份保留文件及原 PDF Hash 均保持。B沿用旧静音源，与A的非零源分开记录，不能把它作为非零播放证据。

P0/P1由自有合法流程生成，未播种用户 SQL。P1是历史 build001 的原打印 worker 完成旧 pending request，原 J-Card UI 导出，只替换原生输出目的地回调。P0→P1精确变化六表：ZIP session及print artifacts/events/jobs/objects/receipts；其余115张表 typed cells不变，121张表 schema/列全部相同，四个打印对象、完整receipt指纹与Hash链被核对。原 App诊断中有6次被原安全守卫捕获的 NOT_READY sender错误，pageerrors0、完整打印与正常退出成立，未宣称日志零错误，也未绕过守卫。见[非空基线](../docs/postrust/MBRS-014/NONEMPTY_BASELINE.json)。

原 PDF `c564ec453502b5ac1ee1ea94ba8024ce857afe60eb3b48d4345ddbf97f9c95ad` 为158036字节、3页，Poppler渲染退出0，Root逐页查看文字、折线、侧脊与曲目没有明显裁切或重叠。历史打印未捕获当前封面时使用原默认画面符合冻结事实；纸面和Owner接受未验证。Root另查看App05四张实际截图；未把程序界面查看或合成生产 E2E提升为 CUA 普通操作、真实账号或 Owner认可，014 CUA 未跑。

## 实现与失败修正

六个闭集公共 API 和三种 Outbox 命令复用可信 Main/preload/Core 唯一作者。关系只增加独立边、CAS修订与append-only历史，不按相同名称或封面猜测映射。来源要求准确文件身份、长度、Hash与范围；未知/未核事实保守阻断，真实自有 FD、共享状态 CAS/ABA、Owner RPC、claim、Prepared发布与 COMMIT未知保护都有定向证据。它们不是可对非协作外部进程提供的操作系统排他锁，也不是012/013 writer已可用。见[资源保护](../docs/postrust/MBRS-014/SOURCE_PROTECTION_REVIEW.json)。

初轮Core224/222/2与Desktop123/122/1的过期预览暴露时间基准不一致：TTL和createdAt分取当前时间。新增确定性回归先实际RED1/0/1，再使用单一时间基准GREEN1/1；新Desktop fixture同样修为单基准。最后404/404覆盖修正。

生产AB01–04失败均保留：新测试的隐式ARIA选择、只读SQLite consumer误建sidecar、旧懒加载照片未自然滚入视区、原来源步骤未关闭造成旧离页守卫拦截、新比较漏计正常工作位置派生，以及原参考目录v-for ref返回数组导致focus异常。只修新夹具/观察与真实局部focus根因：immutable读与精确既有SHM核对、不删除失败记录；实际关闭原步骤；逐行核工作位置；将连接的原生按钮从ref数组中取出。原模板/样式、旧guard/loader/断言及超时不改，重新build003后AB05才2/2通过。Root自己的TODO替换曾范围过宽，已从冻结base恢复，只更新本任务当前段及014行；其余任务和历史逐字节保持，私有错误diff与纠正收据均保留。

首个源码自然CI中，标准回归与002～011门禁成功，014刚开始24秒即因整作业30分钟总期限被平台取消；后续报告准入、whitespace和历史片段步骤skipped，不计PASS。平台failure annotation原文和完整job日志私有保留。c4bd13c仅把整作业预算30→45分钟，但没有触发路径过滤之外的Electron，实际只有3workflow，不冒充4条准入。bdf3dfe只补verify配置变更的Electron push触发；PR原已无过滤。产品用例期限、断言、覆盖及必需四workflow保持，656生产源字节全不变，未手动重跑或取消原运行；bdf3dfe自己的综合CI随后在011 Core匿名case36失败：55/54，014跳过，未触及总作业或步骤期限。完整91,306,854字节原artifact按平台SHA核对，匿名日志定位到确认后取消用例；原断言内容未公开，不能断定CI实际失败分支。Root保持原生产工厂与断言，在真实lstat增加40ms的私有诊断下稳定复现旧200轮轮询提前耗尽（1项实际失败），改用实际同步确认事件后同条件1/1通过。仅该测试函数同步和finally清理改变，原case名、全部断言、55项计数和时限保持；原011完整门禁226/226通过。48份冻结旧输入字节原样，唯一已准入的preload六方法增量也不变；656生产源逐项相同，未声称另跑App。最终5700f7a以自己的自然CI和精确Git绑定交付，b179及bdf的107/5分别只属于其原源码，不混用。

## 原验收、交付与下一任务

八条原文字、ID、kind与introduced_in不改，分层结论见[状态矩阵](../docs/postrust/MBRS-014/STATE_MATRIX.json)。01为自有schema34迁移/身份软件与App部分；02为独立关系；03保持历史的MB显示/选图已覆盖，源标签/路径等012/013未执行；04资源保护软件通过，真实活动录音设备未跑；05旧未关联入口软件与合成App覆盖；06原打印/PDF/墙/照片覆盖，纸面未验；07不重导/不重编号，未导入的新资料包单立内容任务；08保留FFmpeg/OutputNative/Execution Asset软件与历史资产，真实设备及Gate B/P4/P5继续独立。全部总体PARTIAL、live/Owner NOT_RUN。

原015由Owner直接取消且未开始，6AT为N_A；历史18任务/156AT保留，当前有效17任务/150AT，不将取消计为通过或待做。下一012从本报告最终clean且远端一致的HEAD创建独立分支，然后013→016→017→移动正式采纳。真实Roon/可读FLAC/NAS、移动后再播与设备/听感按各自证据补齐，不重扫原100k/300k。Owner只做最终可启动成品试用及确实无法代办的设备接入，开发、验证、提交和推送沿持续授权推进，不逐项索取审批。

本报告自身普通push、2条workflow/3个job、远端HEAD与工作区clean须在提交后由私有 MBRS014_FINAL_DELIVERY_RECEIPT.json 核验；此处不预先标通过。下个任务只从实际最终报告HEAD接续。schema34新增事件不是可安全降版证明；安装、公证、main合并和发布尚未做。有限软件链路封存不等于完整产品AT或真实听感通过。
