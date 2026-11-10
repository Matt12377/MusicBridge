# Mousa 4.1 — Tailscale 单 IP 连接、共享身份与安全换路

## 结论与身份

- 分支：`codex/mousa-4-1-tailscale-connect`。
- Desktop base：`ed2b2af30dcab7b0afb55f299e941bbbb2b8c225`。
- Desktop 实现：`c6d7bbe59efeb746ede850b3222ea7a280f5ef6d`。
- iOS base：`62f95453a2b7b1a6d8e94718a20dda57eab40d5d`。
- iOS 实现：`ba15c1ad3e377a9f9d906b055454e9876818aa87`。
- 报告提交身份：本报告和 [STATUS](../project/STATUS.json) 的独立结果提交；用下列命令取得，避免将实现提交冒充最终交付 HEAD。

```bash
git log -1 --format=%H -- reports/MOUSA_4_1_TAILSCALE_CONNECT_2026-11-10.md
git rev-parse HEAD
```

**工程实现和相应软件门禁完成；标准 Desktop dev 已切换，Duo Production 127 已原位升级并启动。真实跨 VPN、Duo 完整换路/听感和 Owner 验收未完成，`ownerAccepted: false`。**

执行边界沿用 [冻结范围](MOUSA_4_1_TAILSCALE_EXECUTION_SCOPE.md)。未安装、登录或配置 VPN，未修改代理/防火墙/系统安全设置，未打包或安装 Release Mac App，未重启 Roon，未操作其他手机。

## 已实现

### Desktop

- 同一已开启的移动服务按实际本机接口，提供一个 LAN 和一个可用 Tailscale IPv4 HTTPS 入口；最多两个，禁止 wildcard/public 地址。Control API 与原 Stream Gateway 仍只在 loopback。
- 原主入口的 serverId、authKey、证书及已有设备授权保留。辅助入口使用独立受保护叶证书，但共享原 backend、认证、播放、队列、资源、幂等和撤销，不建立第二份逻辑 Mac。
- 单 IP 发现与受保护的连接路径合同均限制在 32 KiB；默认端口 45391。自定义端口保留高级入口并明确提示，不伪称仅输 IP 即可访问任意端口。
- 两个入口复用原生六位 SRP 提示、120 秒期限和全局尝试/频率预算；具体 origin 与 pin 绑定，短码不进入 Renderer。旧资料导入/一次性许可入口保留。
- 设置页提供 Tailscale 状态、IP、复制 IP 和同网/VPN 环境说明，不代替用户安装或配置 Tailscale。

主要接点：[移动设置](../apps/desktop/src/main/mobile-settings.ts)、[辅助监听](../apps/desktop/src/main/mobile-auxiliary-listener.ts)、[双路径投影](../apps/desktop/src/main/mobile-endpoint-projection.ts)、[SRP](../packages/bridge-core/src/mobile/pairing-bootstrap.ts)、[合同](../packages/contracts/src/mobile-connection-paths.ts)、[设置 UI](../apps/desktop/src/renderer/src/components/settings/MobileConnectionSettings.vue)。

### iOS 协同

- 仅输入 Tailscale IPv4，读取受限的公开描述，再使用 Mac 原生六位码完成 SRP。发现阶段信任为临时值，证明成功前不持久化信任或发送已有凭据。
- 通过已认证且 pinned 的路径描述、保护存储的随机 scope nonce 和原凭据形成共享身份；不以设备名称、相同 serverId 字符串或普通 alias 索引合并授权。
- Auto 冷启动优先已验证健康 LAN；健康播放不主动追逐首选路径。强制 LAN/Tailscale 不静默回退。仅明确网络故障可选择已验证备用路径；TLS、身份、认证、busy、未知错误不触发降级。
- 切换前暂停，保存原队列和位置，退休旧 Source/认证 actor，等待在途网络、确认和持久化尾部及已准入 journal 操作；迟到回包不能重新授权或污染新会话。
- UNKNOWN 只解决原 intent/body/key，未解决或关闭之前不发新 grant。恢复不 prepare/load/grant/autoplay；磁盘保存失败也有原 authority/nonce 绑定的内存暂停快照。
- 只允许从完整提交的受保护 profile 恢复真正缺失的公开 pin；已有变更/拒绝的 pin、TLS 或失配 scope 不被偷偷修复。
- 四个 Swift 外部依赖版本和最低 iOS 18 目标保持不变，未引入新的依赖或系统版本升级。

## 软件门禁

| Gate | 结果 | 退出码/边界 |
|---|---:|---|
| Desktop TypeScript | PASS | 0 |
| Desktop 全移动服务兼容回归 | 200/200，0 fail，0 skip | 0；含当前任务与旧 Main/HTTP/认证行为 |
| 网络/身份/设置专项子集 | 65/65 | 0；为上述回归的重叠子集，不重复加总 |
| Contracts 双路径 | 5/5 | 0 |
| Core SRP | 26/26 | 0 |
| Core mc1/mc2 目录、刷新与身份边界 | 36/36 | 0 |
| 真实 SQLite Owner/Reader/锁 + 双 HTTPS 软件 Gate | 5/5，0 skip | 0；合成媒体、隔离数据，不是物理 VPN 或听感 |
| Desktop boundary/control-plane | PASS | 0；control-plane 从真实 Git 工作树执行 |
| MBClient 官方隔离 runner | 251/251，0 fail | 0 |
| MBPlayback 官方隔离 runner | 672/672，0 fail | 0；含静音合成 AVPlayer/资源 HTTP，不代表实际听感 |
| 实际 App 源码 harness | 255/255，0 skip | 0；冻结并校验源码、锁版本，非复制业务实现 |
| Production scheme 原生 generic iOS Debug build | BUILD SUCCEEDED | 0；不签名的软件构建 |
| 同 scheme Duo 127 原签名构建、严格签名验证 | PASS | 均 0；复用原团队/原 profile/原 application identifier |
| iOS 展示边界 + 实际 Production 产品隔离 | PASS | 0 |
| 边界守卫自测 | 10/10 | 0 |

### 保留的失败与修正证据

1. 广回归首次为 199/200：旧 Main 测试仍要求所有刷新使目录游标失效。原 dev 副本的游标实现和该测试与任务 base 字节身份一致，原副本同样复现失败。当前既有 mc2 合同明确允许同 device epoch 内刷新后继续；mc1 仍严格跨代拒绝。仅更新过时测试，保留旧 token 和旧待发送回包拒绝，并实际验证后续 3 项；未改变生产目录/认证合同。重跑 200/200，Core 相关 36/36。
2. 首次 control-plane 错在没有 Git 历史的外置构建副本；从真实工作树重跑 PASS。这不是已有 SOURCE_NAMED_CHECK 两项 carryover。
3. 直接运行全量 Swift 测试时未设置隔离 HTTP/媒体环境，出现 fixture 环境错误；保留原日志后改用仓库官方外置 runner，最终全绿。无依赖升级、关闭校验或以 skip 代替通过。
4. App 测试先暴露保护 scopeChanged 的恢复分类不完整，补入要求重新验证的安全状态后完整 255/255、原生编译通过。旧引擎事实测试按已有 3 秒位置合并合同校正，仍只接受实际 engine event。
5. 当前 Desktop 运行回执第一次探针误用了产物文件名，按实际产物修正后退出 0；非产品启动错误。原生 AX 检查只证实正常打开窗口/部分导航，未完整核对新控件，不能写为视觉通过。

## 实际运行与 Duo 原位升级

### Desktop

- 重新核对旧进程 argv/cwd、原 Core 父子关系及 loopback 监听所有者，读取实际 Desktop playback 为 idle；只使用原实例托盘的正常“退出 Mousa”。原 dev 托管 job 自然退出 0，确认原 Main/Core 均消失、真实 profile 的 Core 端口空闲后才启动新实例。
- 新实例严格使用 `corepack pnpm@10.17.1 dev:desktop`。运行副本与实现提交的关键源文件逐字节一致，Main/Core 与该外置工作副本的实际 cwd/父子关系已核对，编译产物 hash 留在私有回执。
- 实际移动服务的两个监听都属于该 Main，分别绑定当前本机 LAN/Tailscale 的精确 IPv4；未监听 wildcard。Control/Stream 均属于该 Core 且仍为 loopback。实际 Desktop playback 为 idle；未发新播放指令，未强杀或重启 Roon。
- 正常原生托盘已打开当前 dev 窗口。有限 AX 导航检查没有形成完整的新控件/布局证据；不推定当前视觉、全部按钮或 Owner 已接受。

### Duo

- 新鲜只读核对原授权物理目标，原 Production 126 已安装，原 profile 仍有效并覆盖同一目标；没有改用其他设备、创建 profile、注册设备或恢复账号。
- 以已提交 iOS 源码构建 127，前后源码快照不变；严格签名、原团队、原 profile、原 application identifier 均核对。
- `126 → 127` 仅原位安装，安装后读取版本为 127。安装前后一个现有 queue 文件逐字节 SHA-256 相等；未卸载、清空或重置数据。
- 启动退出 0，之后再次只读观察到 Production 进程。只启用了既有只读 restore trace 参数，没有音频探针、自动播放、强制终止、VPN 操作。
- 只读诊断文件回收退出 1（CoreDevice 7000）；回读 App Support 有 Playback，但没有 Diagnostics 目录，未取得可用于证明实际 LAN 冷恢复的记录。原因未确定，不能将此写作实际 LAN 恢复通过或已确认的登录失败；不清凭据、不重配对、不越界加调试入口。
- 该次新鲜 apps 清单确认 Duo **没有安装 Tailscale**。因此无法完成真实跨 VPN 连接和双设备物理换路证明；没有安装/登录/修改 VPN 以凑验收。

## 未闭合与下一基线

- 实际 Duo LAN 冷恢复、IP 六位码配对及 LAN/Tailscale 物理切换尚无本轮完整证据；Duo 缺少 Tailscale 是明确的跨 VPN 环境缺口。
- 不宣称无缝音频。真实声音、队列/位置物理换路、全部 iOS 控件、横竖屏/大字/浅深色完整视觉矩阵及 Owner 接受仍待真实使用证据。
- 保留两个既存 SOURCE_NAMED_CHECK 失败和本地歌词实际播放覆盖的历史 carryover；本轮没有将它们改写为通过。
- 下一任务只能从本分支**最终报告提交且已核对远端一致的 HEAD** 创建独立工作树；不能从实现提交或本轮开始的 base 倒退分支，也不在本轮继续未经授权的任务。
- 普通推送目标为 Desktop `origin` 和 iOS `github` 的同名任务分支；不 force push、不合并 main。最终本地/远端 HEAD、清洁树和报告身份由私有 post-push 收据复核。

## 私有证据索引（不随 Git 上传）

下列均在已授权外置私有证据根；不在报告中复制真实 IP、设备标识、团队、证书、凭据、媒体元数据或签名 URL。

```text
DESKTOP_TYPECHECK_4_PRIVATE.log
DESKTOP_MOBILE_FULL_1_PRIVATE.log
DESKTOP_MOBILE_CURSOR_BASELINE_1_PRIVATE.log
DESKTOP_MOBILE_FULL_2_PRIVATE.log
DESKTOP_CURSOR_COMPAT_1_PRIVATE.log
DESKTOP_CONTRACTS_1_PRIVATE.log
DESKTOP_SRP_CORE_1_PRIVATE.log
DESKTOP_SHARED_OWNER_3_PRIVATE.log
DESKTOP_BOUNDARIES_1_PRIVATE.log
DESKTOP_CONTROL_PLANE_2_PRIVATE.log
DESKTOP_CONTROL_PLANE_3_PRIVATE.log
client-full-2/validation.json
playback-full-2/validation.json
app-playback-5/validation.json
IOS_NATIVE_BUILD_2_PRIVATE.log
IOS_DUO_127_BUILD_RECEIPT_PRIVATE.json
IOS_DUO_127_BOUNDARIES_PRIVATE.log
DESKTOP_NATIVE_TRAY_QUIT_20261110_PRIVATE.json
DESKTOP_CURRENT_DEV_RECEIPT_20261110_PRIVATE.json
DUO_127_UPGRADE_RECEIPT_PRIVATE.json
DUO_127_LAUNCH_RECEIPT_PRIVATE.json
DUO_127_POST_LAUNCH_SUMMARY_PRIVATE.json
```
