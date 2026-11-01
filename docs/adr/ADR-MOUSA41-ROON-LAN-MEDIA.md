# Mousa 4.1：已配对 Roon Core 的局域网媒体入口

状态：Owner 于 2026-11-01 批准实施；真实播放结果单独记录。

保留 Roon 播放系统、AudioInput 及原队列。正常桌面启动使用官方发现和配对，同局域网不自动启动 SSH；旧 SSH 入口保留为手动回退。

可信桌面源码向 Utility 注入媒体能力。只有实际配对 socket 提供明确的私有 IPv4 本地地址和 Core 地址后，才创建同进程能力并绑定该本地地址的随机可用端口。公告使用监听成功后的实际端口；未就绪时拒绝发布，不能给远端 Core 回退到回环 URL。环境变量、Renderer 和公开 IPC 不能启用此能力。

媒体入口只允许精确 Core peer 的 GET/HEAD：本地 `/local-stream/`、已登记的网易云 `/stream/`、固定 PNG 图标。原 token、TTL、来源租约、上游 HTTPS 校验、Range 与流式读取复用。控制、账户、诊断与原 Gateway 监听仍限回环；不开放 health、任意 URL 转发或错误原文。没有子网回退。

配对失效、换网或退出时先同步撤销公告和旧监听连接，再等待其收尾；迟到的监听和 SDK 回调不能接管新一代。局部网络重绑不关闭原本地租约注册器。媒体就绪之后才向适配器开放播放。Core 目标恢复兼容固定官方 SDK 的配对字段，不改授权 token；多 Core 选择仍走官方 Pair。

诊断沿现有有界导出 ring，分别记录停止旧会话、会话建立、play 派发、媒体请求、首个非空音频块与本次 Playing；HEAD、图标、旧 Zone 状态和迟到回调不能作为本次播放成功。报告不含媒体 token、完整 URL、Provider 凭据或 Roon session。

合成 HTTP/SDK、工程构建、真实 Mac/mini 取流与播放、Owner 听感验收分别记录。真实播放仍超时意味着修复未通过，不能以已替换 SSH 代替。IPv6、公网/Tailscale 与媒体服务迁往 mini 属于后续范围。
