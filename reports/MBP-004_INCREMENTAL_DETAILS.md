# MBP-004：增量详情、游标身份与缓存准入

基线 `c91c53774d709fe45c09c0c1da8fb78ba6b2c7a1`，开发分支 `codex/mbp-004-incremental-details`；固定实现 `0df9fb591a153286e0a2c962917c88dbd4704340`。报告由包含本文件的独立提交解析。软件验收完成后本任务计入总数，MBP-003仍须B步骤完成。

Roon详情取得当前页足够的有效条目后即可返回，后续遍历检查点保留在Core。专辑多碟保持DFS及原始sourceIndex；歌单/流派保持根直接条目优先；艺术家在发现Albums/Discography分组时保持分组优先、排除根直接曲目。没有权威分类标记的全部direct艺术家或非常晚出现group仍须线性分类，不能用猜测改变业务顺序。

响应增加可选sourceEpoch、complete、nextOffset，请求仍offset/limit。epoch表示本地遍历代，不代表上游不可变快照；动作继续稳定路径、原索引与hint重验证。root total保留SDK原始行口径，detail total只在有效EOF确定；complete和当前页hasMore独立。Renderer消费实际nextOffset，拒绝混合代际，最多一次重新读取0后给可重试错误；父详情、滚动、关联选择器和未知总数保持一致。

Core详情32上下文、单组8192/全局32768描述符；记录128KiB、单上下文32MiB、全局128MiB、路径32MiB。艺人封面key单项32KiB、缓存4MiB与2048条双限额，fallback同时验证实际offset/count和结构字节。公共实体、图片引用各32MiB并保留各65536计数。重复key扣旧加新，拒绝发生在set前，clear/delete清账；既有引用不因新引用挤压而静默失效。所有数值为保守保留数据准入，不能解释为实际RSS或Electron传输字节。

取消、超时、作用域、Zone与服务换代检查在请求与提交处生效；真实SDK未回调的预算继续占用，迟到回执不能污染新上下文。普通失败可重用已提交raw检查点，错误页不推进或伪EOF。`MUSIC_BRIDGE_INCREMENTAL_ROON_DETAILS=0`在创建service时选择旧策略，两个缓存不混；旧策略仍有原全量读取及旧上限，不能声称相同性能。

## 行为失败、夹具调整与独立审计

合同新增6项实际RED为2失败/4通过；首GREEN候选误改Provider白名单，修正为仅RoonLibraryPage接受新字段，并新增Provider拒绝保护。最终合同230/230。公共分页3项实际RED；新增引用字节2项实际RED。最终公共23/23；首字节候选22/23的失败是新case误期望私有错误码，改为既有公开REQUEST_FAILED，不改生产映射或旧断言。

Core冷5000专辑/歌单/组优先艺人与raw游标4项、Zone中途切换1项实际RED；最后艺人图片准入4项实际RED。最终两规格63/63、类型通过。此前58项指纹绑定旧a8605106源码，不能覆盖最终f97cae50的图片补修。新缓存预算和生命周期case中没有实际RED记录的，仅记GREEN。首次根目录无法找到tsx属于命令入口错误，不冒充行为RED。

Renderer分页8项、选择器2项实际RED，最终80/80（58原项+22新项）、类型通过。首次选择器按钮夹具选择错误与新mock返回类型错误单列，不当生产缺陷；既有断言与skip保留。独立边界初始20项实际RED，最终23/23；unknown-root-red文件运行时已GREEN，不根据文件名制造RED。独立23重跑绑定图片补修前Core，最终统一verify覆盖当前源码及该文件。

既有fixture调整：root原投影深等仍保留，附加验证响应字段；genre count1返回3行改为合法count3，过滤断言不减；artist未知首屏total改为EOF后确定，TopTracks排除与导航保留；旧8491条拒绝case明确旧回滚策略，默认5000增量另测。公共artist封面fixture将count1却offset1仍有行改成count2/root、count1/detail，原图片隐私、四lane及后页保护保留。独立invalidatecase先要求旧descriptor明确过期，再重读root授权，继续检查旧迟到零commit/newUUID/session。Renderer旧mounted resolver补真实分页helper、新session harness捕获详情上下文，没有删除限制断言。

独立审计两轮检查生命周期、原索引、游标、混代和缓存；第二轮定位图片fallback/list.image_key准入遗漏，同任务补修并只复核指定delta。Root额外封堵公共引用Map字节绕过。最后冻结SHA及原始日志见证据JSON，未以局部通过代替完整Gate。

## 固定软件门禁

| 检查 | 结果 | 退出码 |
| --- | --- | --- |
| 原完整verify | Contracts230、Core1744+原2skip、Desktop997；三层类型、三包构建与Preload通过 | 0 |
| 原Electron启动/恢复 | mock 4/4，零skip | 0 |
| 原完整Electron E2E | 104通过+原4条件skip（108），零失败/零flaky | 0 |
| control-plane / boundaries / cycles | 全通过，cycles348文件 | 各0 |
| git diff --check | 通过 | 0 |

合成结构对照：50/500/5000同形专辑和歌单首屏均1次load/5条raw，组优先artist均2次load/10条raw。MBP-001此前250条首屏读取全250；这些只证明调用数，不是实际Roon毫秒、真实听感或内存测量。首次播放上下文目前仍由Renderer读齐；先播后补留给003B，不能将本任务称为已完成Play first。

Node22.23.2、pnpm10.17.1；外置LifeWeave挂载且可写，日志/缓存/临时产物全部在外置根。verify保留原范围，仅Node测试并发1；Electron明确mock钥匙串，Playwright原worker1、原条件skip。源码830文件SHA256 `422ce0a376fb22c4eb1898f8254bdb52873dfa506ded1e5b4ac6a5f3a9b90f62`，最终Gate前后相同才确认固定身份。

本报告创建时开发分支push及远端HEAD核对待执行；CI另列，不能用本地结果声称远端通过。前任务MBR-002固定a838a00远端verify作业、security、Electron通过，但verify工作流独立dependency-audit失败（11 moderate/7 high），保留到MBP-009处理。真实Mac/Roon、账号、音频、录音设备、Owner钥匙串验收均未执行；main合并、安装App替换、GateB与发布未改动。无关未跟踪apps/desktop/test-results/与worktree/保留。

下一分支从本报告最终HEAD创建，连续推进003B，再006/005/007/008/009。各阶段仅绑定自身证据，不扩大为V3或真实设备验收。
