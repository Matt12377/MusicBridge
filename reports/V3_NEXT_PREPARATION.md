# 下一首应用侧等待修复

日期：2026-09-04。

- Base：`316180d05175a76714a6d2fc781b6f397b38ecf6`。
- 分支：`codex/playback-next-preparation`。
- 实现：`15e7726a6682c3f72bb7b18d464c5222295b9054`。
- 报告提交：本文件与 STATUS/TODO 的文档提交；后继从最终报告 HEAD 继续。

## 根因与范围

Controller 原先在下一首真正开始时才解析 Provider URL 并做 Gateway 预检，已知队列中的下一首没有提前准备。这段请求位于停止当前歌曲之后，增加无声等待。

本轮只消除应用侧这段重复串行工作：当前曲目已播放时，在内存中准备紧邻下一首元数据、URL 与 Range bytes=0-0 预检；不保存音频文件、不缓存整轨、不注册额外流，也不提前发起 Roon 播放。Smart/原生 Roon 队列不走此路径。

一次最多一个背景准备请求；队列变更后旧结果不能成为新曲目。来源 URL 按原解析时间计时并预留 30 秒安全余量；过期后回到正常解析。准备失败不改变当前播放/认证状态，实际播放时由既有流程处理错误。停止、清空、退出和非自然终态释放准备结果；已发出的 Provider 请求按既有超时结束。

## 新鲜验证

- RED：新增两项测试证明原实现没有下一首准备；补充停止入口测试证明停止后错误复用准备结果。
- GREEN：Controller + Roon Adapter 122/122，exit 0，0 skip。
- 新增覆盖：无额外会话/流、无重复解析/预检、准备失败、停止清理、TTL 到期、请求期间队列替换。
- Bridge Core typecheck、Desktop production build、control-plane、boundaries、diff --check 均 exit 0。
- 最新构建重启后，通过真实辅助功能树确认主页推荐/歌单已加载；连接状态显示 Core 已就绪、Roon 已连接、Provider 已登录及播放设备已选择。未自动触发播放，不把连接状态当作真实听感验收。

## 明确保留的边界

Roon `track` 模式每首会话及整轨缓冲未修改，原真实环境约 5–6 秒等待仍需重新测量；不能用上述软件测试宣称秒切或无缝播放。官方 [Roon Connect 示例](https://github.com/RoonLabs/roon-connect-stream-example/blob/main/lib.mjs) 只展示 begin_session / slot=play，本轮没有凭未核验的 next 槽语义改造播放协议。Owner 后续在已启动的新构建中验收切歌、seek、暂停恢复和停止。

没有重新导入、迁移或改写个人收藏数据库，没有新的容量窗口、真实播放自动操作、合并、打包安装或发布。
