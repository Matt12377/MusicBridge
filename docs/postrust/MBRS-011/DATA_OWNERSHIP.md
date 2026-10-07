# MBRS-011 写入所有权与恢复边界

实际基线 `db4cded876e8eda7755d781ed4827dfc38332a10`。延续同一 owned-dataset SQLite 和唯一 `node-dataset-owner-worker`。Renderer/preload/Main 不打开业务 SQLite；Rust 为 OFF，扫描和 Organizer 都进入原 Dataset Owner。Main 的 outbox 仍是原独立命令持久化机制，不成为业务对象第二作者。

人工显示信息继续由 `local_catalog_overrides` 权威保存，来源标签仍在原 observation 历史。版本说明与分组建议是明确 MB 注记，不能冒充原始标签、发行身份或自动合并。未带注记的旧 override 请求保留已有注记，清空必须明确表达；撤销使用新的 CAS 修订，旧 revision 和历史不删除。

Organizer 在原 `local_catalog_ledger` 扩展有类型的私有事件。提议按 header/item 拆分，单行沿用 64KiB 预算，整计划另设 2MiB / 100 曲目边界；旧十二类目录事件保持原语义。新增私有事件须更新同一冷核和行数/字节审计，不绕开损坏拒绝。确认与全部 override 子回执在同一有界同步事务中提交；失败回滚、unknown 与冷恢复由持久事件对账，不自动重播。

代码与数据的回退分开。沿用 schema34 的 DDL 不表示旧 schema34 程序认识新私有事件或注记：旧构建可能安全拒绝冷开。禁止把库号相同当可直接降级，也不删除新事件、注记或用旧备份覆盖新用户数据。014 负责旧域兼容与保护的适用边界，完整文件 writer 未交付前源写继续 OFF。

源文件、冻结资产和音频没有本轮写入作者变更。MB_ONLY 不取无关音频排他锁；SOURCE_FILES 计划不可凭结构或客户端 approval 取得执行资格，统一全资源保护缺证时不执行。
