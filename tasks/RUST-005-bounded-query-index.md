# RUST-005 — 不可变快照的有界查询索引

Owner 的持续开发授权从 RUST-004 最终报告 `d2676884a537bf3d232ed2cc957fef11b6d5cfeb` 接续，分支 `codex/rust-core-005-query-index`，工作树 `worktree/rust-core-005`。4 个显式 gpt-6.1-sol/high 子代理按槽位分批工作，禁止再派生；主代理整合、审查和验证。

## 问题与范围

RUST-004 的六种 warm 完整调用显示无筛选首屏 Rust 略慢，部分筛选较快。当前 Native 每次扫描 JSON 并重复 ASCII lower/拼接搜索文本；TS 对每次回执重复全量字符串投影、筛选和页比对。只优化已冻结快照的纯查询计算，保持完整事实和回执校验，记录建立索引与端到端查询成本。

生产默认继续 Node，Node 是唯一数据库作者。保持公开 208 命令、v1/v2/v3 帧、2,000/4 MiB 与显式 5,000/8 MiB、128/40 分块、UUID、版本/代次/整体期限、unknown 回执、借用来源与最多一个 child。没有真实用户库、迁移、Provider/Roon、播放/录音、安装、签名、push、发布、远端 CI 或 main merge。

## 冻结设计

- 每代不可变快照只建立一次索引；Native 在完整 commitBoot 准入查询前建立，部分上传不能建立可查询事实。close、fatal 和退役清理索引；重复合法 v2 boot 不重复建立。v1 无筛选分页结果保持。
- 按原导出 ordinal 建立 ASCII lower 品牌及搜索文本、品牌精确匹配、年代/未知与四种库存状态 posting。只保存每代有界衍生字符串、标量和 ordinal，每种 posting 按原次序且无重复。选择最小候选集合后检查所有 AND 条件，不能改变分页前筛选、total、hasMore、稳定顺序或完整 DTO。
- 查询端 NFKC/trim/空白合并/Unicode lower 与行端仅 ASCII lower 的不对称保持；字面 `%`/`_` 不当通配符。未知年份、重叠库存状态和完整照片/库存事实保持。
- TS 新内部索引绑定已深拷贝并冻结的 snapshot；不暴露内部 posting、不建立无界请求缓存、不取消 DTO/身份/总数/逐项深比较。旧 `filterCollectionSnapshot` 保留为独立线性参照；不得把改动后的索引同时充当自身唯一 oracle。
- 索引只按已有最多 5,000 型号/字段上限 O(总文本+N) 建立，posting 总 entries 不超过固定常数×N；不新增容量/API，不持有跨代快照或额外进程。不把代码上的有界结构称为已测硬 RSS 上限。

## 文件范围

1. Native 子代理：`native/rust-core/src/lib.rs`、必要新 `native/rust-core/tests/query_index.rs`，保留旧拒绝断言，不改 Cargo/lock。
2. TS 子代理：`packages/bridge-core/src/rust-core/collection-query.ts`、`readonly-sidecar.ts`、新 `test/rust-query-index.test.ts`；不改 Router/Node/合同。
3. 实际证据子代理：新 `packages/bridge-core/test/rust-core/indexed-query-integration.test.ts`，复用现有合成两库 helper；不改前两代理文件、现有 fixture/Gate/STATUS。验证 0/100/2,000/5,000 规模、组合/边界筛选、重复与写后换代；新增 Node/本期完整调用与 TS 线性/索引成本。
4. 第四子代理：最终只读独立审查，最多两轮，证据写外置目录，不改源码、不提交、不再派生。
5. 主代理：本任务、ADR-042、Gate、STATUS/TODO/风险、整合与结果报告。

## 验证与成本

保留旧全套；新增确定性差分不依赖易抖的性能断言。真实 Node 两库到 pinned 本期 Rust 的四种规模与固定筛选/分页须逐 DTO 一致；完全验证包含未知年份、库存重叠、Unicode/NFKC/ASCII 不对称、字面子串、offset 越界和稳定顺序。新旧 Node 写后刷新必须反映新事实且不重用旧索引。

六种工作量各 10 次 warm 样本，记录 Node、完整 Rust（两次版本 RPC＋往返＋TS 校验）、整段刷新和关闭。TS 索引建立与纯线性/索引对照另列。可通过测试专用环境 `MUSIC_BRIDGE_RUST_BASELINE_ROUTER`、`MUSIC_BRIDGE_RUST_BASELINE_BINARY`、`MUSIC_BRIDGE_RUST_BASELINE_SHA256` 加载 RUST-004 已提交模块和 pinned binary，在同一库逐阶段对照真正旧完整路径；记录模块 SHA、二进制 SHA、不同 snapshot/phase 与 sequential warm 限制，不同时持有两个 child。本机最终对照必须完成。远端 CI 无此本机产物时仍执行新差分/成本、旧路径对照明确 NOT_RUN，不条件跳过测试，不冒称远端通过。

本期成本输出 `MUSIC_BRIDGE_RUST_INDEX_COST_REPORT`，所有证据、缓存、临时两库、构建、日志必须在 `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-005-yfoq1e5k` 或外置共享 Caches。实际 Rust 使用现有 stable 1.95.0，不安装工具链。Node 22.23.2 / pnpm 10.17.1。

Rust fmt/clippy/locked test/build、固定依赖 Gate、新 TS 差分及实际进程 Gate；全软件 typecheck/unit/build/control-plane/boundaries/cycles；固定源/日志/二进制指纹、独立审查、diff/JSON、实现/报告分开提交、远端和最终 HEAD/清洁。下一分支从最终报告 HEAD 接续。TODO 待办在前、已完成在后。
