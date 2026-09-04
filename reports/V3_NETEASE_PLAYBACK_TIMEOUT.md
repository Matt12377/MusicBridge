# 网易云播放超时诊断与错误分类修复

## 身份

- 分支：`codex/netease-playback-timeout-diagnosis`
- 基线：`1c82a439af91ef519092d6b5c328465174079ddc`
- 实现：`b1d4342e9ee7ff53762f4fb3b63eb1f4151941cd`
- 报告身份：包含本文件的独立报告提交；下一步从该提交继续。

## 已确认与未确认

- 当前运行实例来源于本工作树。终端曾有未连接错误，之后播放命令被 IPC 包装为 INTERNAL_ERROR。
- 只读 Control API 播放状态实际为 error / ROON_TIMEOUT；Roon 控制连接存在但 Transport 为 loading，activeStreamCount 为零。界面显示 Provider 已登录。
- 当前没有 SSH 隧道进程，Gateway 的远程开发健康检查返回 NOT_FOUND。代码确认该部署需要既有远程音频隧道，普通发现连接不能证明音频可达。
- 这证明了一个需要恢复的运行环境条件，但尚未通过恢复后播放验证排除其他问题；不能宣称网易云全部歌单已恢复，也不认定自动连接设置被改写。
- 界面控制多次返回 elementHasNoFrame / noWindowsAvailable，重连控制工具后仍不能可靠操作设置。未绕过权限、读取凭据或直接写设置。

## 有界修复

公开错误合同及 Core IPC 映射保留 ROON_TIMEOUT，使用固定中文说明，不透传内部错误、URL 或会话内容。现有 Renderer 已识别这个类别。单曲和替换队列路径均覆盖。

## 新鲜验证

- TDD RED：新增播放超时 IPC 测试 exit 1，实际 INTERNAL_ERROR 与预期 ROON_TIMEOUT 不同。
- GREEN：utility-ipc 与 validator 共 86 项通过、0 失败、0 跳过，exit 0；新测试同时验证接收端合同及内部详情不泄漏。
- contracts build、bridge-core typecheck、desktop typecheck、desktop production build：exit 0。
- verify-boundaries：PASS / exit 0；git diff --check：exit 0。
- 当前应用没有重启加载新构建；没有真实出声、完整 CI、发布或 Owner 验收声明。

## 下一步

在既有设置中恢复 Remote Core 开发连接，检查健康状态为可用后验证一首歌及队列。需保留当前目标与凭据，不扩大网络暴露；自动启动选项由用户明确选择。账号、歌单、库存数据未修改。本报告不包含个人目标地址或运行标识。
