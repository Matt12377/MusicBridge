# MBM-000 移动公共合同采纳

本任务从 MBRS-013 最终报告 `d3174bce575aa817b27ba05d39a40d3050b77be4` 接续，独立分支为 `codex/mbm-000-mobile-contracts`。Owner 已授权连续开发、检查、源码及独立报告提交和普通推送；常规步骤不重复审批。后继为 MBM-001，必须从本任务最终报告基线开始。

Mac 主代理唯一维护公共合同、共享配置、Git 索引和实际命令执行；现有三名子代理按五份 DTO/codec 与四份测试、独立 Gate、完整样例三组独占协作。iOS 原主代理维护其独立源码、测试、工程和 Git；本任务不改两端主工作区中的未提交内容。

## 输入与版本

`docs/postrust/MBM-000/INPUT_LOCK.json` 锁定 013 的源码与报告、iOS 的实际已提交源码 `fc332b5973d9b9c6d608aa8e683d65cef4d2c0e3` 和报告 `26ef98f11dd1db187c496020b9564c226c50bd1e`、31 份 iOS 输入、22 个 Mac 复用点、基础 20 操作和 UI 20 操作。G0 证明提交和整份输入身份，不能代替 codec、客户端或服务运行。

唯一权威合同为 `packages/contracts/mobile/openapi.json`。原基础 YAML 和 UI JSON 按完整字节保存在 `docs/postrust/MBM-000/inputs/`，不改原输入。权威文档版本 `1.6.0`，ServerInfo 与 Capabilities 的 `contractVersion` 继续 `0.1.0`，UIContentCapabilities 的 `version` 继续 `1.0.0`。INPUT_LOCK 的既有 `mobileWireApiVersion` 仅指后者，其解释在 ADOPTION 明列；不能替换服务器握手版本，也不增加任何公开 hash 响应字段。离线整份 SHA 锁只在采纳 manifest 中使用。

40 个原操作的方法、路径和 operationId 保持。唯一成功状态差异是 D2：HEAD 媒体由原输入的 200/206 收敛为 200，报告完整 Content-Length、没有正文、忽略 Range 与 If-Range。GET 仍区分完整 200、有效单段 206、越界 416，畸形或多段为 400。原桌面 loopback Gateway 行为和冻结验证保持。

## 本任务实现与边界

新增移动域独立 DTO、纯 codec、HTTP 方法/路径/状态映射及完整兼容样例，按 ADOPTION 和 COMPATIBILITY_MATRIX 完成下列规则。

- POST 资源 201 只允许 ready，202 只允许 preparing；GET 200 可 ready/preparing/failed。failed 必须带嵌套 error；media 与 failure 按状态互斥。
- 基础与位深扩展请求均完整闭合。只有可信 UI 能力明确 true 时可接受实际存在的 maxBitsPerSample；true 且没有该字段仍接受基础请求。格式能力使用同一完整 codec/container 组合，不拼接不同格式的最大参数。
- sourceAudio、actualAudio 和 processing 分别记录真实事实。已知 FLAC 采样率、位深和声道必须保留，未知信息不猜值；无损可播放服务在 MBM-003 实施。
- 出站字段按白名单生成，入站扩展有界。请求原始 UTF-8 总量最多 256KiB，响应最多 2MiB；歌词最多 2000 行，每行实际 UTF-8 最多 4096 字节，同时受整份预算约束，不截断数组或冒充部分成功。内容超限明确返回 CONTENT_LIMIT_EXCEEDED。
- 24 小时只是安全重试提示 normalizer 上限，不给既有 retryAfterMs JSON 新增最大值，不改客户端准备期限。保留实际已有 claimPairing、refreshToken、createSession、createResource、renewResource 五个 POST 每次调用最多一次 timedOut/interrupted 后同原 path/key/body 的回执恢复，以及 closeSession、releaseResource 两个 DELETE 对自己原路径的幂等清理恢复一次。pendingRefreshKey 保留原意图；取消后的创建恢复只清理自己的资源、不发布成功。UI 四项写入及 logout、reportObservation 不新增丢回复自动重放。所有不确定结果均禁止新 key/body/意图或第二次执行业务；HTTP 状态或跳转不触发丢回复重放。明确 401 后已有单路刷新与一次原请求恢复保留，相同业务 key/body，不当作 UNKNOWN 已执行结果；既有有界只读重试、RESOURCE_BUSY 退避与准备期限保持。服务端先查相同 key/body 的原回执，不能第二次执行；原 202 回执不改写为后续 ready 的 201，没有新增命令查询端点。
- 不透明 ID 使用兼容 ECMA 与 Python JSON Schema 的严格全串结尾；禁止任何尾部 LF/CR/NUL/Unicode 换行，不依赖不同验证器对 `$` 的不同解释。基础与 UI 输入的旧 pattern 字节保留，变化只进入采纳合同与新 codec/负例。
- 内容 source/account/version/revision、分页 cursor 与 CAS 使用同一快照。个人歌单 POST 必须能消费真实 HTTP 201；空歌单不能带非空封面，首曲无封面不得用后曲补图。已有同快照首曲上下文时核对跨字段事实；未知首曲不制造推断或新 wire 字段。

本阶段不启动移动服务器、TLS/配对服务、转码、真实 Provider、音频引擎或设备测试。既有 Control API 与 Stream Gateway 仍只绑定 loopback；Node 为默认与唯一 SQLite 写入作者，可选 Rust 只读 OFF，源文件写入开关保持 OFF。

## 独立移动验收

| 条目 | 达成条件 | 当前证据 |
| --- | --- | --- |
| MBMAT-000-01 | 核对双方已提交输入、013 封存和隔离分支；保留主工作区 WIP | G0 已核输入身份 |
| MBMAT-000-02 | 唯一权威完整合同、40 操作、local refs、三个版本与差异台账锁定 | PASS：Mac独立schema60/128及iOS49正/70负；合同整份同hash |
| MBMAT-000-03 | 闭合请求、可信能力与原始 UTF-8 总量限制正负例 | PASS：完整raw正文与可信context正负例 |
| MBMAT-000-04 | 资源状态、媒体状态及无损三轴事实正负例 | PASS：合同软件层；真实媒体和听感未运行 |
| MBMAT-000-05 | 个人歌单 HTTP201/空封面、内容身份/CAS/cursor/歌词正负例 | PASS：Mac完整HTTP与实际iOS合成消费者 |
| MBMAT-000-06 | 同次 fresh contracts build、types、四显式行为文件；原始日志自然0、零skip、源码与编译输出末尾复核 | 本地候选PASS 33/33；精确Source提交Gate待执行 |
| MBMAT-000-07 | 双端实际源码/独立报告/普通远端身份、同整份合同哈希及各自实际兼容 Gate；登记下一基线 | iOS最终交付已核；Mac Source/报告CI及final seal待执行 |

上述 7 项属于移动独立账本，不抵扣 MBRS 原 18 任务/156 AT、有效 17 任务/150 AT；015 的六项继续 Owner 取消 N_A，013 八项继续 PARTIAL，真实 Roon、NAS、跨卷、音频、设备与 Owner 缺口保留。

## 验证与交付

实际入口为 `node scripts/ci/verify-mbm000-contract-adoption.mjs --output-root=<外置私有任务目录>`，Gate 自身检查为 `node --test scripts/ci/test/verify-mbm000-contract-adoption.test.mjs`。TEST_SCOPE 必须从四个真实测试源码枚举完整名称与用例数，不以 40 操作数量充当测试数。AJV2020 使用直接锁定依赖与真实 whole-body 样例；格式检查、纯 codec 行为、实际 iOS 消费者三层分别记录。

本机先确认外置 LifeWeave 实际挂载和可写，所有构建、缓存、临时目录、完整日志与结果放外置根；固定 Node22 和 pnpm10.17.1。Gate 三阶段为 fresh-contracts-build、contracts-types、mobile-contract-behavior；独立新预算每阶段120000ms、总360000ms、关闭宽限10000ms，原 MBRS 门禁预算不改。

完成后分开提交源码与结果报告，正常推送审计分支，核对首次自然 CI、远端 exact HEAD 与工作区 clean。最终成对采纳是本阶段交付条件，不倒置为启动条件；源/报告自引用身份通过实际 Git 解析，不制造第三个自封存提交。报告陈述实际软件证据及未执行的服务/设备/音频/Owner 层。

## 源码冻结前实际软件验证（2026-10-09）

Mac完整fresh Gate035自然退出0，33/33、零skip，196完整HTTP样例与128独立schema样例通过；425声明输入、222编译件、四个实际消费回执及移动15件闭包前后复核。Gate自身20项、报告准入新旧共33项实际通过。全工作区024为4721/4719、2项原native条件skip，保留其候选执行身份；最终Source证据须在提交后重新绑定，不以此候选日志替代。

iOS源码bc72069f73e342479190beda7f230b79ea91d9f0、唯一父源码的报告8ba6b9777b67d23dc89cc1edca7412e128398256已普通推送并独立核对远端与clean。137独立Swift用例零fail/skip、schema49正/70负另计、347Source输入、Mock/Production未签名generic Simulator编译与实际Production隔离通过。两端整份合同145918B/ee79461bf672e78c4ac29945d794e46286c92b0f909ced85bc4534a8a6de57bb相同。

MBMAT-000-01～05软件层已验证；06的本地候选验证通过，精确Source提交Gate待执行；07仍待Mac源码/报告首次自然CI和最终远端clean封存。pairedAdoptionComplete=false是此Source准备快照；最终成对交付以报告中的精确Source证据、报告自然CI和外置最终收据解析。服务、音频、真机、UI运行和Owner验收未执行；不修改原18/156、有效17/150或013八PARTIAL。
