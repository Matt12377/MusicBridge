# 本地媒体服务的网络范围

本文件说明005代码的准入合同，不授权或声称已完成真实LAN部署、Roon请求、音频或Owner验收。当前自动验证只在loopback服务自有合成文件；实际网络和播放器会话由006及最终真实验收继续取证。

默认沿用现有loopback Gateway。新增本地路径为 `/local-stream/<memory-secret>`，secret是服务端随机生成的256位能力，仅保留内存；没有路径、目录列表、上游URL或会话参数。只允许GET/HEAD，未知secret、额外query、转义路径和其它方法统一拒绝。公告URL取可信启动配置，不从Host、Origin或请求地址推导；Logger只记录method/routeClass/rangeClass。

异机能力单独使用 `createTrustedLocalMediaNetwork`，字段为 `bindAddress`、`port`、`advertisedBaseUrl`、`allowedPeers`。源码factory只接受指定RFC1918 IPv4、有效端口、相同地址端口的HTTP origin及1～16个明确peer；拒绝0.0.0.0、公网地址、凭据、子路径、query/hash。返回对象通过私有WeakSet身份准入，环境变量、Renderer或普通clone不能启用该listener。设置须由后续可信Core组合层取得具体批准后传入；当前没有默认LAN开关或已部署声明。

该独立listener只路由本地媒体读，逐连接核对peer白名单；不开放health、控制、IPC、旧remote fetch或诊断资产。原control与远程proxy继续loopback，既有SSRF/fetch allowlist不变。代码支持不等于Core可达；实际请求、probe、反复seek、网络断开与恢复须另取实证。白名单不是完整LAN信任证明，真实应用仍需明确地址/peer及Owner批准的网络范围。

本地流不gzip、不下载缓存、不转码、不重封装。完整GET返回200，单Range返回准确206，越界416，多Range/畸形或超安全整数拒绝。HEAD无body且不消耗一次性资格。stat派生ETag明确为弱证据；所有If-Range条件保守回完整200，不把弱ETag或秒级mtime冒充强校验器。64KiB按块读取并遵循背压，文件最大64GiB；默认同时8个lease，每lease最多4个请求，全局8个本地请求。

PREPARED允许确认SessionBegan前探测，初始30秒；ACTIVE/PAUSED只接受可信confirmed session，续期5分钟、总租期上限12小时。HTTP完成仅结束单次请求，暂停/seek仍持有固定FD与物理读保护；006须接入实际BridgeController的currentness、会话确认、暂停、结束和取消。任何错误、过期或停止先中止响应，再join实际I/O，确认FD关闭后才释放保护；不能通过超时clear强行宣布quiet。

租约须把私有catalog/root/location/selection观察和实际打开句柄关联，打开前后及每块read后核物理signature、命名路径与目录链。缺可信物理观察不证明旧catalog修订对应当前bytes。可观测改名、替换、截断、撤权或read错误撤销租约，不重开新路径续流。stat/远程文件系统缓存无法证明隐蔽原地修改不存在；没有据此复制整个音乐库或宣称对任意第三方修改提供快照隔离。

Core utility与其dataset-owner Worker共享同一32772字节SAB协调器：2048物理资源槽，单次集合最多128项，共享读计数最多65535，写准入原子独占整个集合。key来自实际FD的dev/ino，覆盖跨根别名、硬链接及共享cover；旧Scanner/录音的严格Hash、nlink及原预算不降低。无法确认关闭、I/O quiet或Owner崩溃时保守保锁，Core退出后才重新建表；当前没有把失败保锁冒充透明恢复或真实Organizer源写已开放。

原AT005-06仍为live_roon，当前NOT_RUN。合成HTTP、Worker和受控故障证明软件接缝；真实LAN/NAS、Roon/Core/Zone和听感保持未验证。
