# ADR-006：macOS Beta 分发策略

## 状态

已接受，TASK-040 与 TASK-041 实施时生效。

## 决策

V1 Beta 以 arm64 macOS 为目标，产出可复验的未签名 unpacked App/DMG；若 Owner 提供合法签名与公证环境，才额外执行 hardened runtime、最小 entitlements、签名和 notarization。签名材料不通过聊天、仓库或 CI 日志传递。

签名条件缺失时，报告明确标记 `SIGNING_CREDENTIALS_PENDING`，候选包只作为内部 Beta candidate，不声称公开可分发。每个包绑定源码 commit、bundle/ASAR SHA-256、版本和安装 smoke 证据。

## 后果

发布流程必须可重跑、可审计、可回滚；签名失败不能通过关闭安全配置或改变架构来绕过。TASK-041 统一记录已签名、未签名、安装和已知问题状态。
