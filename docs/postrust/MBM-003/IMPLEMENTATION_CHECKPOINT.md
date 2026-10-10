# MBM-003 实现 Source 检查点

基线为 `b1a8de728086e7994bb69d7dee10782f646886dd`；当前独立分支为 `codex/mbm-003-lossless-dsd-transport`。本文件记录实现提交前的实际检查。固定 Source 的 SHA、全量新 Gate、首次自然 CI 和直接结果报告 R 由后续结果报告记录；此检查点不冒充该封存。

两端已实际采纳 1.7.0 合同：公开合同 147445 字节、SHA256 `3deaa9e238f24b7062945efacc775b604a60a5652b837b8c46378f0b89eeec21`；语义规范 6076 字节、SHA256 `698ca28f695b950c7409489b67929da523193856461f858df7047c1b48d2fa2a`。保留原40个操作和五种普通格式策略。DSF/DFF 的来源 clock/1-bit 与实际 FLAC 24-bit/48kHz 分开；物理输出 route 另行取证。

DSD 只在真实固定专用后端、唯一 Dataset Owner、独立缓存资格和客户端显式采纳同时成立时进入整曲转换。完成转换、整份输出核验和真实静止后才 ready；后续资源可复用缓存。缓存保持1个转换作业、4个等待资源、32份产物、每份2GiB、总共4GiB；活动产物不驱逐。原源与标签只读；原240秒准备预算、10秒排空预留和 ready 后按原TTL续租继续。

最后自查发现缓存真实只读 FD 的关闭拒绝会被包装成已排空错误。新增独立进程负例先执行 RED501：实际转换、完整Hash拒绝、精确FD及读保护仍保留后，在 `quiet=true` 处失败。修复保留该FD与容量、传播 `quiet=false`，并关闭后续作业及驱逐。新鲜 Core/固定 Worker 准备504后，缓存7项、Source3项及唯一Owner1项共11项实际通过，exit0、signal null、零失败/取消/跳过。原6项正常缓存检查与夹具保持。

标准 `corepack pnpm@10.17.1 verify` 在508实际exit0：类型检查、contracts 281/281、原Core 2775通过加2项原生显式开关跳过、独立排队Stop 8/8、原Desktop 1670/1670、production构建及沙盒Preload依赖检查通过。标准入口不自动包含新增003目录，因此新任务 Gate 仍独立必需。控制平面513与边界514均实际exit0。新鲜完整 Source Gate 预期80项；hosted适用65项，额外15项仅本机固定原生后端执行。

79项WIP Gate498在关闭失败修复之前通过，只作为未变化组件的适用历史证据；不把它重标为修复后的固定Source80项通过。新Source发布仍需要80项本机Gate和同Source首次自然4个workflow、6个job、5份制品。旧002精确Source/R软件证据复用；不重跑其构建、装机或听感。旧002真实carryover保留。

专用原生bundle使用既定FFmpeg 8.1.2来源与FD-only构建，manifest SHA256为 `233ff1404886db6183bc159fdc81e2d191cec9ddb6f43788f0a9228a13d1f6c7`。实际原生合成转换及源完整性检查不等于App、真实音乐品质、手机音频或Owner接受。缺失真实资格时不宣告DSD能力；不回落旧录音、系统FFmpeg或自报后端。

当前Mac新Source App、手机FLAC至少24/192、DSF/DFF、seek、断线/服务重启恢复及物理route/Owner证据仍待。iOS已固定软件Source `44304efd0528d5f345ed296e498b14d059486f77` 和直接报告 `810f1cfedf9502adaa6ff60bffaa4dcee9107a61`，既有合格候选继续复用，软件/安装不升级为真实音频通过。004、016、017均未启动；原12条003 AT、8项Owner聚合与18/156及17/150范围保持。
