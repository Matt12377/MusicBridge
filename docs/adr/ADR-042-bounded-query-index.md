# ADR-042：不可变快照的有界查询索引

状态：RUST-005 可选只读原型；生产默认继续 Node。

RUST-004 完整调用的六种 warm 工作量显示部分筛选获益，而无筛选首屏 Rust 略慢。现有 Native 每次扫描 JSON 并重建 ASCII lower 搜索字符串，TS 每次校验也重建衍生字段。只看原生循环耗时会遗漏版本探测、线程/管道和完整事实核验，因此优化和结论都以完整路径为准。

选择每代已完整提交的不可变快照建立一次有界索引。行端只缓存 ASCII lower 品牌、搜索文本和已校验的年份/库存标量；品牌、年代/未知、四种重叠库存状态存有序 ordinal posting。查询选最小候选，复核所有 AND 条件，再分页与返回完整 DTO。所有 posting 按原导出顺序，没有重复；不引入请求级缓存、排序或无界 n-gram 倒排，也不扩大容量。

TS 绑定已深拷贝冻结的事实，同样构建内部有界索引以完成查询回执校验；公开 DTO、身份、分页、total 和逐项深比较继续执行。旧线性 filterCollectionSnapshot 保持，独立 TS 差分和真实 SQLite 差分共同约束实现。参数端 NFKC/trim/空白合并/Unicode lower、行端仅 ASCII lower 的不对称以及字面百分号/下划线仍使用旧合同。

Native 在完整 commitBoot 准入前构建，TS 在合法 boot ACK 后构建完成才 ready，仍计入既有启动期限。close、fatal、换代清理索引，不复用旧库存或持有另一代。索引持有的字符串与 ordinal 受既有 5,000 型号和字段预算限制；posting 总条数是固定常数乘 N。此结构保证可推导的规模上限，不能当作已测硬 RSS 上限。

代价是每代的额外建立时间与衍生内存。测量同时记录 TS 建立/纯查询、整段刷新、六种完整 warm 调用和自然关闭。本机以旧 RUST-004 已提交模块和 pinned 二进制顺序对照，保持一次一个 child，并记录模块/二进制身份；没有本机旧产物的远端环境只运行新差分，旧对照明确 NOT_RUN。本地结果不证明冷盘、真实库或远端 CI。

v1/v2/v3、公开 API、生产 Node、数据库唯一作者及来源借用边界保持。任务见 [RUST-005](../../tasks/RUST-005-bounded-query-index.md)，生命周期见 [路由 v1](../contracts/rust-readonly-router-v1.md)，传输见 [sidecar v3](../contracts/rust-readonly-sidecar-v3.md)。默认启用、打包签名、持久化迁移、真实账号/设备/Owner 验收仍单列。
