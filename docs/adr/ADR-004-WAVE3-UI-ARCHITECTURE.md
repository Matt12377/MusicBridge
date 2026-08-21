# ADR-004：WAVE-3 V1 桌面 UI 架构

## 状态

已接受，TASK-030 实施时生效。

## 背景

WAVE-2 已验证 Main、Preload、Renderer 与 Bridge Core 的边界，但当前 Renderer 仍是功能性空壳。V1 需要把搜索、个人音乐库、Now Playing、队列、设置和诊断组织成可维护的桌面界面，同时继续禁止 Renderer 触碰凭据、上游 URL、Roon session 或通用 IPC。

## 决策

采用单一桌面 Shell 加正式路由：Home、Search、Library、Playlist、Now Playing、Queue、Settings、Diagnostics。Shell 负责导航、全局状态摘要和底部播放栏；功能页只通过公开 Preload API 读取状态或发起已校验命令。Lyrics 先以临时 Now Playing panel 进入 TASK-024，TASK-030 再完成视觉整合。

视觉基线使用 graphite 背景、amber 强调色、清晰的状态层级和键盘可达控件。任何播放动作都必须显示请求质量与实际质量，公开 UI 不新增暂停、seek 或任意 URL 输入能力。

## 后果

路由和 UI 状态可以独立测试，Renderer 仍不具备 Node 能力；最终视觉验收集中在 TASK-030。此前空壳中的临时列表不被视为最终信息架构。
