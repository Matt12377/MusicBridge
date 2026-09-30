# 固定历史数据库夹具

本轮新增的 `collection-schemaN-empty.sql` 保存历史 DDL，不调用当前生产迁移来推导预期值，也不只降低 `PRAGMA user_version`。

| 版本 | 固定来源 |
| --- | --- |
| 1～6 | `557cb78bf1048732bb30638de6440368787bda0d` 的历史表定义，复用既有 `helpers/legacy-schema.ts` 中保存的字面量 |
| 9～13 | `62a20a6db58c5a94a537f84032931e89da20a5b4` 中保存的历史 DDL，按准备、导回、Profile、执行、归档顺序累计 |
| 21 | `05256eb867e37574e16f23eab877026a229a1703` 的正式 Repository 在干净合成库创建的 schema21；保存 sqlite_schema 中的表、索引、触发器定义 |
| 23 | 固定 schema21 加上 `6d6c1c4c5f28acc9967cff3ef48ef8f91d7c6b5c` 的 workspace22 与 print-version23 正式迁移所生成的 DDL |

`rebuildLegacySchema()` 仅重建合成测试数据库：复制历史已有列，移除所有新表和触发器，然后按上述固定 DDL 建表、填回原行、核对外键和版本。库存序列的默认初始化行由原合成库的实际序列替换。生产代码不调用这个 helper。

既有 schema14～20 的带数据 SQL 原件继续保留。`historicalRows()` 依据这些原件确定旧表和旧列，逐列比较迁移前后的旧事实；新增列默认值、当前版本、完整性、外键、故障回滚和篡改拒绝由各迁移规格继续独立断言。新增表不混入旧事实集合，也不因此获得验收通过。
