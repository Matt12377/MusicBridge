# TASK-013 — safeStorage 凭据保险库

## 目标

建立 Main 进程凭据保险库，为扫码登录做准备；迁移 POC Cookie，但不实现扫码。

## 规则

- 使用 safeStorage 异步 API。
- Renderer 永远不能读取凭据。
- Core 通过受控请求短暂获得凭据。
- logout/delete 测试。
- safeStorage 不可用时拒绝保存，不退化为明文。

## Exit Gate

- 秘密扫描通过。
- IPC 响应中无 Cookie。
- 加密存储、读取、删除、损坏恢复测试通过。
