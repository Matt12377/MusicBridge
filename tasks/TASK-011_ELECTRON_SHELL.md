# TASK-011 — Electron/Vue 安全空壳

## 目标

创建 Electron 43.x 稳定线 + Vue 3 + TypeScript 的安全桌面空壳，不接网易云、不启动真实播放。

## 必须配置

- nodeIntegration false
- contextIsolation true
- sandbox true
- 本地资源
- CSP
- deny window.open
- deny navigation
- Preload 白名单 API

## 页面

仅显示应用版本、Core 未连接占位、Roon/NetEase 状态占位。

## Exit Gate

- 开发与生产 build 均可启动。
- 安全配置有自动/结构测试。
- Renderer 无 Node 权限。
