# ADR-050：签名候选包的原控件与持久账本

状态：RUST-013 实施；生产默认 Node。

RUST-012 原 Main typed 请求没有创建原 Renderer 和持久命令 outbox，旧原控件 Gate 使用包外 fork wrapper。选择独立编译静态 Main 观察与固定 DOM 驱动，保留最终签名、固定 core.js、原安全 IPC/preload/Vue/outbox 和包内资源定位。原 form/button 事件走实际 Main 账本及唯一 Node 业务作者，不以直接 API 调用替代控件。

使用 26 次原入库跨越原 limit24 分页，原保护保存单写，私有可信刷新及同 profile 冷启；关闭后独立只读对照两类数据库。固定 DOM 的 isTrusted=false 与普通 computer use 分开记录；Main 完整结果不冒称独立 Renderer 完整 DTO。原错误态“刷新库存”仍只重读，正式快照刷新入口另冻合同。

计时仅实际 Main 同时钟 request/reply 往返，DOM 等待另列。签名包本期行为、生产启用、真实服务和完整数据库迁移分开验收。详见 [合同](../contracts/RUST-013_PACKAGED_RENDERER_VALIDATION_V1.md)。
