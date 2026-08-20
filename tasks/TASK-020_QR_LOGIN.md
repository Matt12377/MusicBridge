# TASK-020 — 网易云扫码登录状态机

## 目标

实现二维码创建、轮询、扫描、确认、过期、取消与凭据落库。

## 状态

idle → creating → waiting → scanned → authorized  
waiting/scanned → expired/cancelled/error

## 规则

- QR 图片可传给 Renderer；Cookie 不可。
- 轮询有超时和取消。
- 成功后验证账号状态再保存。
- 退出删除凭据与 Provider 会话。

## Exit Gate

- 实机扫码成功。
- 过期/取消/重复扫码测试通过。
- 重启应用后登录状态恢复。
