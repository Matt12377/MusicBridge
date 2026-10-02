# Rust Core 合成人工会话内部合同 v1

本合同只为本机隔离验收driver，不改变公共IPC、生产默认Node、Node唯一作者或Rust只读收藏协议/预算。

模式闭集node100（默认）、rust100、rust2000、rust5000分别选择原静态wrapper，固定2k/4MiB默认或明确5k/8MiB。每次全新外置合成profile，先预检完整组件及新driver身份与现有executable、后seed、后实际Main；进程环境离线testBridge/core、显式mock，不接真实服务或用户库。

Main实际窗口可见且明确合成标题。显示前由新可信driver冻结实际IPC允许列表；远程Core、账号、真实文件导入、播放、录音和输出的范围外IPC调用明确拒绝，原生文件选择与导出对话框也拒绝，并保留实际拒绝观测。offline变量不能代替该边界。原收藏浏览与合成policy写入仍经原handler和Node/outbox，保留原控件与preload。原Main托盘的上一首、下一首、停止不经过IPC，仍只作用于固定CORE_TEST_MODE的合成播放状态，属于未纳入人工验收的保留入口；不能据此声称所有播放入口已阻断或真实音频已验证。控制仅可信terminal status/refresh/quit，串行原刷新一次；无Renderer或环境开关，无自动写/刷新/重放。写后Node回退是合法结果，人工refresh恢复。默认30分钟有界会话，只承诺当前规模与期限。

状态必须区分 preflight / starting / ready / closing / closed / failed。ready必须实际可见原musicbridge页面、真实Node/Core/可选RustACK与至少两原后台空claim，并绑定session/mode/profile/scope/sourceAggregate/artifact/bin/Electron；不提供Owner通过。closed自然必须原app.quit、Owner close→exit→closed、Core exit0、每Rust prepare/boot/close ACK→exit0、Electron自然exit0、无forcedCleanup。正在运行、仅红点隐藏、强杀、缺ACK/身份或终止都不能完整PASS。

SIGINT、SIGTERM和SIGHUP由本期driver保存失败现场并通过原app.quit收口。Playwright信号实现按实际1.62.1依赖源码全摘要绑定；只隔离本次launch异步上下文中三条已核完整函数签名的新增监听器，保留既有与其他新监听器，恢复原注册方法。已有Playwright会话、源码/签名漂移或注册方法被其他调用方接管均拒绝，不能撤销其所有权。signalOwnership独立记录依赖身份、既有监听数量、精确隔离项和恢复结果；中断不能产生readiness或被标为自然会话PASS。

新严格验收只接受真实完整报告，并对缺漏/模式规模/身份/默认Rust/可见/claim/关闭/自然退出的负变体拒绝；不验证真实账号、数据迁移、音频、设备或安装。ownerAcceptance始终NOT_RUN，Owner聊天反馈单独记录；CLI没有accept命令。未经核实的sourceSha不得冒充实现提交；新driver/config/helper/test/launcher和旧组件输入产物都需独立绑定。
