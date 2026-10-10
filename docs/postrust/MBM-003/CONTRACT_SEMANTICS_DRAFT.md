# MBM-003 合同与处理语义草案

本草案已有完整可读合同文件 `contract-preview/openapi.json`。文档候选版本1.7.0、40个操作；生产唯一canonical仍是002的1.6.0。双方核对本草案身份和行为后，Root串行迁入公开合同及编解码器，再固定实际生产字节。这里不请求Owner重新批准范围，不将草案写成实现或验收通过。

## 显式协商

- `Processing.mode`仅增加`dsd_to_pcm`；原五项及其语义保留。
- `UIContentCapabilities.resourceDsdToPcm`可省略、不可null、缺省false，独立于位深能力。
- 两个封闭ResourceRequest分支增加可选`acceptedProcessingModes:["dsd_to_pcm"]`。旧请求无此字段，服务端必须在转换前返回原409 UNSUPPORTED_FORMAT，不能给旧客户端含新mode的202/failed响应。
- 服务端真实能力为true、客户端明确声明、当前源为真实DSD、请求目标实际能接FLAC24/48，四项同时成立才准入。可信上下文绑定原server/device/session和能力快照。UNKNOWN只读原回执；改变支持列表要新intent，不能改写旧202。

## 音频事实

DSD请求采用auto、allowLossyFallback=false、preferredTransport=file。真实DSF/DFF的codec、调制采样率、1-bit及声道进入sourceAudio；MHz不受PCM格式能力768k上限限制。actualAudio在ready时只取实际FLAC产物：48000Hz、24bit和真实声道，seekable/file。不是DSD源不得使用新mode；DSD不得使用direct/remux/lossless_conversion/resample伪装。原FLAC仍按lossless+false保持采样率、位深和声道，24/192不走DSD转换分支。

## 整曲与生命周期

私有Owner短begin/status请求管理独立有界转换任务。先捕获真实只读源事实并持久化原202；整曲转换完成、退出状态成功和实际产物核验全部成立才ready，不能预填输出长度或规格。公开GET轮询不延长原5分钟resource/orphan或30分钟session期限；转换截止必须在这些原剩余期限内，过期后原资源不复活。原direct准备10秒、元数据15秒/2MiB、媒体建立10秒/idle5秒、60秒绝对票据和64KiB背压不放宽。ready之后才签发媒体票。

缓存由唯一Owner管理独立目录和配额，key绑定真实来源身份与转换参数/实现。活动读锁、FD、转换进程与产物验证在release/撤销/退出时确认静止，再回执。整曲首次合格后才能复用；未知或不完整产物不得注册ready。原文件和标签不改，前后真实身份、长度及整份SHA分别取证。

## 对端采纳与验证

iOS需核对完整合同候选及本语义，明确closedmode、请求opt-in、能力缺省、DSD源MHz与实际PCM分离、FLAC24/192能力，再由双方固定采纳身份。正负例涵盖ready/preparing/failed全部状态的mode门控、旧客户端零转换、DSD错mode/错PCM规格、非DSD冒用、原FLAC保真和原幂等回执。之后三作者按独占文件范围实现，Root整合必要Gate及首次自然CI。真实iPhone播放、seek、断连恢复和物理输出规格分别记录；002原真实carryover保留。
