# Mousa Tailscale — 授权执行范围与验收合同

## 起点

Owner 已在规划后明确授权自主实施，不逐步要求人工操作。单代理串行执行，禁止派生。

- Desktop：`codex/mousa-4-1-tailscale-connect`，base `ed2b2af30dcab7b0afb55f299e941bbbb2b8c225`。
- iOS：同名独立分支，base `62f95453a2b7b1a6d8e94718a20dda57eab40d5d`。
- 两个 base 均为已核对远端 HEAD 的上一搜索任务最终报告提交，旧 worktree 和用户 WIP 保留。

## 产品合同

1. 手机连接页新增 `Tailscale`，首版只输入 Tailscale IPv4；端口、公开证书交换、协议和版本检测在后台进行。
2. 首次使用原 SRP 六位短码，Mac 原生窗口显示、两分钟有效；不把短码返回 HTTP、写入日志或送入 Renderer。
3. 同一可信 Mac 共用设备授权。已验证的局域网与 Tailscale 端点为一个逻辑连接，不以同名或 serverId 字符串作为信任证明。
4. 默认自动：新连接优先可验证的局域网，失败尝试已信任的 Tailscale；健康连接不因另一地址出现立即抢切。保留仅局域网、仅 Tailscale，指定模式不暗中回退。
5. 保留队列、位置和可信配对。只读探测不创建播放意图。无法确认旧请求/资源状态时安全暂停、查原记录，不自动重发或重新签名。不得未经实测宣称无缝音频。
6. 已有局域网服务、主 serverId、鉴权密钥、证书及旧客户端继续可用。新增地址使用独立端点证书，不覆盖旧主身份；通过已认证连接登记可信路径。

## 服务与安全合同

- 标准新增 Tailscale HTTPS 入口沿用移动服务标准端口；不改旧局域网自定义端口，不扫其他端口。
- 独立移动 HTTPS listener 绑定精确本机地址；不绑定通配公网地址，不动 loopback Control API/Stream Gateway。
- 两个 listener 共用同一 backend、auth、资源与播放状态；撤销设备同时作用于两条路径。
- 新公开只读 identify 入口仅返回现有公开连接资料格式；未配对资料为临时、不可信候选，只有 SRP 成功才可持久采纳。
- 可信路径列表只在 bearer 鉴权后提供，闭集、限大小、无重定向，列出的证书需按地址和 SHA 核验。
- 新媒体地址只能由同一服务器在显式允许的 listener 源站上生成并通过 codec 验证；内部会话与票据保持唯一。不在客户端替换任意 URL，不放宽同源、TLS、设备 epoch 或票据保护。
- 原生移动服务默认 OFF、loopback-only 偏好不自动拓宽；自动辅助 listener 仅在明确启用的非 loopback 移动服务下运行。
- 网络变化只增删自有辅助 listener；不为 Tailscale 重启 Core、Roon 或清空手机配对。辅助失败不拖垮仍健康的主服务。
- 同一配对只保留一份权威凭据与刷新状态；端点别名不得产生独立刷新令牌分支。旧认证 flight 必须被确认收口，不把不确定刷新静默变成新配对。

## 验证合同

- 合成测试先红后绿：地址/闭集解析、证书派生与旧身份保持、双 listener 隔离、同一 auth 撤销、跨 listener 证明拒绝、媒体投影与票据、端点登记、Keychain 别名、模式选择、防抖、迟到响应、UNKNOWN 只查不重放。
- 旧配对、原自动恢复、资源与会话账本、搜索和边界 Gate 必须回归。
- Desktop 只用固定 Corepack dev，不打包/安装 macOS 发行 App；只验证本任务精确新窗口与从属 Core。
- 仅 Duo 构建原位升级，不卸载、不清文档、不操作其他设备。当前基线为 Production 126。
- 已只读核对 Mac Tailscale 为 Running、有本机地址；Duo 当前没有安装 Tailscale。后者限制真实手机跨 VPN 测试，不安装/代登录账户或跳过系统 VPN 授权。可继续实现与合成 Gate，Duo 旧 LAN 兼容另验；不能将 Mac 本机访问 Tailscale 地址冒称手机跨网络通过。
- 私有设备标识、实际地址、证书/签名细节、账户、媒体元数据和原始诊断留在本机私有证据目录，不进 Git。

## 交付

实现与报告分别提交；Desktop 普通 push `origin`、iOS 普通 push `github`，核对远端 HEAD、报告身份、干净工作树和未改变的历史状态记录。`ownerAccepted: false`。两项旧 SOURCE_NAMED_CHECK 与本地歌词覆盖 carryover 保留。
