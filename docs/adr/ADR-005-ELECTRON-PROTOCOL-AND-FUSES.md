# ADR-005：Electron 协议与 Fuses 安全边界

## 状态

已接受，TASK-030 与 TASK-040 实施时生效。

## 决策

生产 Renderer 使用严格的 `musicbridge://app/` 协议，只允许应用自身的固定页面路径和受控资源；导航、窗口打开、权限请求和任意外部协议默认拒绝。Renderer 继续保持 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity=true`，CSP 不允许 `unsafe-eval` 或任意网络连接。

TASK-040 打包时启用 Electron Fuses，关闭 Node CLI inspect、run-as-node、环境变量选项和远程模块等不需要的能力；Fuse 结果必须在包 Gate 中验证。协议和 Fuse 变更不能把凭据、Provider 原始响应或 Roon 内部标识引入 Renderer。

## 后果

本地开发与生产加载路径需要显式区分，测试必须覆盖协议、CSP、sender/origin、权限和 Fuse 配置。未签名包也必须满足同一安全配置。
