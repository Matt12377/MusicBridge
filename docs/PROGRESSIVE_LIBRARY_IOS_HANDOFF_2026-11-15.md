# iOS 会话交接：资料库渐进可用

## 分工与基线

- 本会话只开发桌面/Core；不修改、构建、签名、安装或部署 iOS。
- 桌面起始基线：`399f5ddc534a8baad9e857eb126a73a0a08cbcc4`。
- 桌面第一项分支：`codex/mousa-4-1-progressive-library-shell`，目录 `worktree/progressive-library-shell`。
- 目标、阶段与安全约束见 `docs/adr/ADR-MOUSA-4-1-PROGRESSIVE-LIBRARY.md`。

## 当前接口承诺

第一项仅拆桌面应用壳/设置启动门禁，不改变 iOS HTTP DTO、SRP、配对、authority/profile、LAN/Tailscale 路由、资源票据或队列恢复合同。既有客户端无需为此更新。后续如确需跨端合同变化，将先在本文件列出版本和兼容行为，不能要求旧 iPhone Air 客户端同步升级才能使用。

## iOS 可并行处理的边界

1. 页面导航、外观、关于可独立于资料库完全就绪；具体连接、查询和播放控件分别按真实服务资格开放。
2. 分页结果的总量会随着扫描提交增长，不能把总量变化等同于空库，也不能把旧快照卡片直接转为可播放身份。
3. 取消/切库/换 epoch 后，晚到页必须丢弃；按当前接口的分页/游标契约消费，不能猜测未公布的新字段。
4. 播放仍由唯一服务端权威与原队列控制；不自动播放，不把新扫描曲目自动追加到已建立队列；暂停恢复不自动 prepare/load/grant。
5. LAN/Tailscale 仍是同一 authority/credentials 的不同路由，不能建立第二配对身份或控制会话。

## 状态

第一项应用壳/设置已实现，提交 `966445257469ff1a4e3250f5f6c9cc725e73609a`；[第一项报告](../reports/MOUSA_4_1_PROGRESSIVE_LIBRARY_SHELL_2026-11-15.md)随独立报告提交交付。188 项相关回归通过，桌面/测试类型检查及官方 Electron development/production 隔离 mock-keychain 启动均退出 0。完整桌面集仍有在未修改起始提交复现的旧 VM 夹具债务，不宣称全绿。

iOS 当前不需要为第一项更新接口。下一项处理每 100 张的动态分页；新增能力的兼容边界须在实现后更新，不能预先按猜测字段接入。本文件不是部署许可或真机音频验收；Owner 接受与真实音频均未认证。
