# RUST-005：不可变快照的有界查询索引

状态：可选只读索引完成，本地完整 Rust/软件 Gate 和两轮独立审查通过。部分筛选完整路径有收益，无筛选首屏未改善；生产默认继续 Node。

## 身份

- base SHA：`d2676884a537bf3d232ed2cc957fef11b6d5cfeb`，RUST-004 最终报告提交。
- 分支：`codex/rust-core-005-query-index`；工作树：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/rust-core-005`。
- 实现提交：`2ab380f5b897f73e60e8d479e1a69d180200638f`。
- 报告提交由 `git log -1 --format=%H -- reports/RUST-005_BOUNDED_QUERY_INDEX.md` 解析；下一分支基线为最终报告 HEAD，不在本文写自引用 SHA。
- 对应远端分支 `git ls-remote --exit-code --heads origin refs/heads/codex/rust-core-005-query-index` 退出 2、无匹配引用；没有 push。报告提交后复核 HEAD、清洁工作树、远端与旧工作树/产物，记录于证据根 `FINAL_IDENTITY.json`。
- 4 个明确 gpt-6.1-sol/high 子代理分别实现 Native、TS、实际进程差分/成本和独立审查，按平台槽位分批；主代理整合、Gate、报告。未派生更多代理。

## 行为变化

旧 Native 每次查询扫描 JSON 并重建行端 ASCII lower 搜索文本，TS 回执校验也重新投影全库。本期在每代完整不可变快照建立一次品牌/年代/未知/四种库存 posting 与衍生字段；选择最小候选后复核所有 AND，保持原导出 ordinal、分页前筛选、total、hasMore 和完整 DTO。Native 无筛选直接切片，其余只收集页内 DTO；没有全量 matches 中间向量。

Native 在完整 commitBoot 准入前构建，重复合法 v2 boot 复用，部分 v3 上传不能查询或建立完整事实；close/fatal 释放索引。TS 索引绑定 copySnapshot 的深拷贝冻结结果，在合法 boot ACK 后构建完成才 ready，并计入原整体期限和请求预算；异常/超时失败关闭，close/fatal 清引用。内部 posting 不暴露，返回数组不能改内部结构，不保存无界请求结果或跨代索引。

参数 NFKC/trim/空白合并/Unicode lower 与行端仅 ASCII lower 的不对称保持，字面 `%`/`_` 不当通配符，未知年份与重叠库存正确。TS 继续验证公开 DTO、身份、页参数/total 和逐项深比较，原 `filterCollectionSnapshot` 原样保留为独立线性参照；Native 新测试保留旧线性谓词，真正的 SQLite 作为另一事实 oracle。

每代的 row/ordinal O(N)，字符串 O(已有字段总文本)，posting 最多 7N（all、品牌、年/unknown、四种重叠库存）。这是假设既有合法 DTO/容量下的结构界限，不是实测硬 RSS 上限。保留公开 208 命令、worker 1、v1/v2/v3、旧 2,000/4 MiB 和显式 5,000/8 MiB、128/40 分块、版本前后探测、代次、unknown 回执、借用来源与最多一个 child。没有新增 Cargo 依赖、数据库作者或默认应用路径。

决策：[ADR-042](../docs/adr/ADR-042-bounded-query-index.md)；冻结范围：[RUST-005](../tasks/RUST-005-bounded-query-index.md)；传输：[v3](../docs/contracts/rust-readonly-sidecar-v3.md)；进度：[TODO](../project/RUST_CORE_TODO.md)；机器证据：[JSON](RUST-005_EVIDENCE.json)。

## 验证

全部构建、缓存、临时两库和日志在挂载且可写的外置 LifeWeave 卷。证据根：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-005-yfoq1e5k`。

| 检查 | 最终结果 |
|---|---|
| rustc/cargo 1.95.0、fmt、clippy -D warnings、locked test/build、依赖边界 | 各退出 0；Rust 旧 40＋新 3＝43 通过，新 Native 差分 2,800 组 |
| 原 Sidecar / Node 原子 / 版本 / 路由 / 大快照 / TS 大快照 | 35 / 9 / 11 / 36 / 13 / 21 通过，无失败或跳过 |
| TS 查询索引 | 新 6 项通过；与旧三套 targeted 共 98 通过 |
| 实际 Node 两库 → 固定 Rust | 原 23＋新 1＝24 通过，无失败/跳过；新 0/100/2,000/5,000 四规模 72 完整页、432 筛选页、16 写后页一致 |
| 全工作区类型 / 生产 build | 各退出 0 |
| 全量软件单元 | Contracts 254 / Core 2,138 / Desktop 1,239，共 3,631 通过，0 失败；原 2 项 native 条件 skip 名称与 RUST-004 相同，无新增 skip |
| control-plane / boundaries / cycles | 各退出 0，cycles 381 文件 |
| diff / JSON | 各退出 0，明确路径暂存，实现/报告分开提交后复核最终身份 |

四规模真实写命令验证：空库 receive 新增库存重叠型号；非空库 materialize/reserve 把旧 blank 命中变为 reserved，保持 5,000 上限。版本变化使旧路由 stale，显式 invalidate/refresh 使用新 snapshotId 和新索引，旧 TS 快照参照仍保留旧事实。完整读取 DTO 与真实 Node、独立线性结果均一致，不只核 ID。

最终 Rust manifest `rust-gate/run-SoxVwn/manifest.json` SHA-256：`b88b42678e0063689532b6c27e814909e0e714cf9453ef3835172eea6d506f8e`；16 步退出 0/signal=null、294 份源码与日志摘要匹配，43 Rust / 155 JS（含实际 24）。release binary SHA-256：`03624a10a1c9314842907142fd0cfb3931dd68edcb88a5dff6ea645832124a14`。完整软件 manifest `software-final/software-manifest.json` SHA-256：`f847cb2674993ca1ad249a4a0940c7bd0d9a675793856e0533ac47c5a3106f74`；六步退出 0，1,055 份代码/测试/构建文件开始、结束和当前相同。全冻结 1,226 文件直到最终 Gate 未改变；报告整理仅改元数据/文档报告。

两轮独立审查剩余 P1/P2 为 0；第二轮只核最终新证据与身份，没有重跑全套或第三轮。`review-final.json` SHA-256：`851e1288e0390672166671d731feb08eab348609500f9d226ea644555904438f`，首轮文件保留。源码、22 份步骤日志、四份成本 JSON 和新旧模块/二进制摘要逐项匹配。

本次优化以差分保护语义，不把相同结果的新增回归或速度波动当作行为 RED。初期手工 receive 测试用了非法的 partial 状态，改为 candidate 后预检及正式 Gate 通过；初次工具输出没有单独失败日志，不能虚构。冻结前还修正测试专属随机路径硬编码和旧对照仅记录任意模块 SHA 的问题，改为通用外置真实路径准入及固定旧模块/binary pin；正式独立 run 目录通过，旧通过日志保留。

## 完整成本与结论

同一 5,000 型号真实合成 Node Owner/库、相同版本及完整模型事实，先旧 RUST-004，再本期 RUST-005；每阶段六种工作量先同样 6 次未计时预热，再各 10 次计时样本。完整 Rust 包含两次 Node 版本 RPC、真实进程往返及完整 TS DTO/事实核验，不只测原生循环。

| 工作量 | Node 中位 ms | 旧 RUST-004 完整 ms | 本期 RUST-005 完整 ms |
|---|---:|---:|---:|
| 无筛选首屏 | 1.780 | 1.895 | 1.938 |
| 品牌＋库存 | 7.042 | 2.906 | 1.813 |
| 字面百分号/下划线 | 6.141 | 4.793 | 2.043 |
| Unicode | 6.758 | 4.635 | 2.059 |
| 年代 | 3.877 | 2.218 | 1.846 |
| 空结果 | 4.224 | 1.506 | 0.379 |

TS 5,000 型号索引纯建立中位 **3.049 ms**（10 次）；单列线性与索引纯 filter 原始样本，纯调用不包含 JSON copy/freeze、分页、线程/进程或 DTO/深比较。Native 建立已计入实际 boot/整段刷新，未单独剥离原生构建耗时。

整段刷新旧 **345.167 ms** / 新 **330.699 ms**；自然关闭旧 **4.320 ms** / 新 **4.738 ms**，新关闭是在写后换代后测量。两阶段各 60 次 warm Rust 查询和 120 次版本 RPC；额外预热的 6 次查询/12 RPC 单列。四规模各初始加写后两次导出，共 8 次本期 child，另 1 个旧基线；峰值 1，9 个均 code=0/signal=null，借用来源 prepare/boot/close 均 0。

旧基线绑定提交 `d2676884a537bf3d232ed2cc957fef11b6d5cfeb` 三个模块与固定二进制 `1e2b5164591204772196f987009ae254bda2fcb807471f5ff917ec65b5c105ea`，载入前和结束后复核，直接加载旧 router/sidecar/线性 helper，是旧完整路径而非旧 Native 配新 TS。最终索引成本 JSON SHA-256：`2e59b2a081d9be9967fcfab1dab9856fbb84c71e568d7faac8bf41ba24c7845a`；无本机旧产物的环境仍执行新全差分与成本，旧对照明确 NOT_RUN，独立无 baseline 预检无跳过通过；未运行远端 CI。

本轮部分筛选有收益，无筛选旧 1.895 / 新 1.938 ms，没有改善。顺序 warm 样本未控制 OS 缓存、GC 或调度，刷新是单次观测，不能把约 14 ms 差值归因于索引，也不证明冷盘、真实库或普遍应用加速。保留建立成本和完整路径，以此评估后续可选集成，不能直接默认启用。

## Carryover 与交接

生产 Node、唯一数据库作者保持。真实用户数据/迁移、Provider/Roon、播放、录音、Owner 验收、全量 Electron E2E、系统 Keychain、安装替换、打包签名、remote CI、push 与 main merge 未执行；MBR-004 真实恢复及 Gate B/P4/P5 原 carryover 不提升。

大于 5,000/8 MiB、后台失效推送、正式应用启用、持久化写入或完整命令迁移仍分别待办。旧工作树/WIP/产物保留，下一任务从最终报告 HEAD 接续。持续开发目标保持，本阶段本地证据不等于产品或设备验收。
