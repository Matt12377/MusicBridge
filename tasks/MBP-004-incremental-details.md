# MBP-004：Roon详情增量读取

本任务由Owner已授权的11项性能/正确性计划覆盖，基线为MBP-003A最终报告HEAD `c91c53774d709fe45c09c0c1da8fb78ba6b2c7a1`；独立分支codex/mbp-004-incremental-details。保留Electron/Vue/Node/TS与所有收藏、录音、播放数据和作用域准入，不做main合并/发布/真实账户操作。

详情首屏不等待全专辑/作品集/歌单遍历，按raw页原子调度，当前有效页足够即返回。私有context保存raw offset、稳定路径、header/碟状态、有效条目累计、待遍历groups/stack、完成状态、UUID sourceEpoch；每页提交前验证read作用域、context对象、session generation和Zone。保持MBP002取消/期限/共享读取/实际未返回RPC预算和4artist image lanes。取消/timeout会话轮换后旧context无效，新UUID；普通页失败可恢复已成功checkpoint，错误页不推进、不缓存迟到结果。

响应仅加optional sourceEpoch UUID/complete/nextOffset；请求依旧offset/limit，不放宽Provider通用分页。complete为全遍历EOF，缓存完整第一页仍可能hasMore=true；detail total只在有效总数确定后返回，root total保留原SDK原始行总数口径，不能当成过滤后的可见条目总数。root nextOffset消费实际raw行（包括过滤行），detail nextOffset消费有效条目；失败不可短页冒充EOF或跳过未发布条目。实际offset必须正确且下一游标严格前进（末页空页可保持位置）。旧请求和旧缺字段响应保持兼容。

遍历顺序：album DFS/多碟header与原sourceIndex；genre/playlist direct根项先、分组后；artist任一有效Albums/Discography组存在即忽略根direct，首group可立即增量读取，root EOF无group才direct。协议没有分类权威标记，因此大型all-direct或非常晚出现group仍可能线性分类，这是明确性能边界；保留旧业务语义、不猜分类、不因总数大直接拒绝。50/500/5000同形group-first、album、playlist首屏调用数须近恒定；预算限制针对每次扫描工作/深度/容器/内存，不新增原可读101..1000直列的拒绝阈值。

Core上下文/page/path/reference保存有界；pending/pinned不驱逐或安全拒绝，释放后的旧reference仅稳定重定位或明确过期，不能错指不同实体。增量缓存与legacy缓存含实现版本不混用；incrementalDetails依赖参数默认true，false保留旧阅读路径用于可验证回滚。公开服务invalidateReadContexts optional钩子接入Public scope旋转/失去或替换service；Core同时检查Zone变化。sourceEpoch为本地遍历代，不声称上游mutation快照，动作仍原pathSignature/sourceIndex/hint重验证和授权。

Renderer按nextOffset而非去重显示长度加载；有无混epoch/不同epoch先拒混，再最多一次重读0，重复换代给可重试错误，不能无限循环。保留generation、read scope、父详情/scroll/pending恢复；已知失效才重读。未知总数文案“已加载N”。完整播放队列仍全读完/5000容量/跨epoch零派发，先播后补留给003B。源选择和实体关联的实际next/previous入口同样适配raw游标，非固定步长的上一页使用已访问游标。

Root独占合同/src/roon.ts、validator.ts及其行为测试、Core public-library.ts和相关测试、可选adapter开关连接、任务/进度/报告与统一Gate。Core代理独占library.ts、roon-library.test.ts、library-read-lifecycle.test.ts；Renderer代理独占启动分配的12生产/8既有测试及必要独立详情测试；第三代理先写独立mbp-004增量边界测试文件（无跨写），完成后独立只读审计。所有代理使用gpt-6.1-sol high，不生成子代理、不build共享dist、commit或push。需要contracts新类型时Root先生成合同dist，代理直接Node22 --import tsx在各package目录执行，不触发pretest共享build。

先留能捕获全量读取/错误游标的RED，再实施并针对行为GREEN；原断言保护不得随意删除，修改夹具需说明当前协议与保留的保护。冻结实现及源码指纹后依次原完整verify、明确mock Electron4项、完整E2E108项、控制/边界/cycles/diff Gate；只保留原skip。独立实现/报告提交与开发分支push，核对remote SHA和WIP保留，之后003B继续；真实硬件、Roon听感、账号和GateB认证独立未执行。
