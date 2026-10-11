# MBM-004 内容与多设备

本任务按已有持续授权执行，正式分支为 `codex/mbm-004-content-multidevice`，唯一基线为共同最终报告 `479e746bb7106a4dac158fe616290220de03a53a`。共享 Main、IPC、Owner、合同实现与 CI 已由协调线释放。原工作区及其他任务未提交内容继续保留。

复用原 Main branded 设备认证、原 Core 网易云客户端和唯一 Dataset Owner，接入既有十九操作：最近添加、网易云日推与红心只读、发现歌单/新专/排行榜/收藏页/FM、精确完整歌词、整专/单曲收藏、个人歌单创建/加歌和首曲封面。客户端上游红心写入、歌单删除/改名、额外后台均不在范围内。

唯一公开合同保持 1.7.0、40 操作和固定正文哈希。绑定 server/dataset/device/设备 epoch、取得时 access generation、Owner epoch、真实账号和 Provider epoch。普通 token 刷新保留原媒体租约，撤销/换账号拒绝旧正文和迟到资源。每设备独立 session/resource 不控制家庭 Roon 队列。所有四写由唯一 Owner 做 CAS、持久回执和原提交只读 UNKNOWN 恢复，不因超时再签写入意图。

完整歌词按精确源/version/content 身份查询；本地只读同目录同名授权 sidecar，网易云只读原实际源。错误不变成 missing，过限和坏行不静默裁剪。最近添加时间采用实际 create-edition 入库账本，不用文件 mtime。封面和媒体保持来源元数据与实际音频事实，FLAC 至少 24-bit/192kHz 保规格；仅既有 DSD 整曲→PCM24/48→独立 FLAC 缓存策略继续使用。Range、续租、释放、有限槽位及物理 quiet 沿原资源纪律。

代码和行为检查、构建、自然 CI、普通应用、真实账号/iPhone/音频、两设备和家庭 Roon、Owner 最终试用分别记录。软件 Gate 必须包含新 Owner 持久组合、Main/Core 私有 RPC、完整 HTTP 及实际网易云适配器的受控正负例；本轮 004 路由不能被继承的 Tape 标记截获，旧分支和未知任务的严格拒绝继续保留。真实缺项保持 NOT_RUN，不抵扣原 17 个有效任务/150 项验收；015 继续取消。

独立 Source 直接接上述基线，直接 Report 接 Source。Source 冻结文件清单、完整字节/hash、当前类型和组合检查；自然 CI 绑定具体 Source，报告只复用已核首轮 producer/artifact 身份，原始日志与制品完整内容另行消费。报告提交不能修改已验证产品或提高真实证据层。

Owner 2026-10-11 最新要求：远端仅在 004 双端整合、016 综合回归、017 最终交付关键节点推送。中间模块、局部修复、测试和临时报告留本地；每任务仍更新本地 TODO/机器台账。若门禁要求 Source CI 先于直接 Report，仅执行此节点必要的两次普通推送；不回撤已发布历史、不强推、不跳 Gate。常规已授权步骤不再逐项审批。最终成品试用由 Owner 完成，开发测试和日志判断由 Codex 负责。

本地库普通应用与正常退出重开 61 首的开发检查已由实际 UI 证据确认，未重扫或播放；它不证明本任务双端、音频或最终试用通过。

本期一并处理已授权的 MBF-001 三个有限软件切片：A 为 Main 本地 prepare 的请求期限分类；B 为原九字段点播回执只读核对、原意图实际 UNKNOWN 保护及有限脱敏 Roon 阶段诊断；C 为固定 Metadata Worker 的有界完整 WAVE fmt/GUID 解释、准确 codec/lossless 与当代 parserVersion v4。C 仅涉及 Reader Worker/types/父 Reader/扫描协调器四个产品文件及七个精确测试接点。本期 Source 对实际全部字节重新绑定并真实重编译，历史 Tape Common/signed-stat 准入、预算与冻结证据保持原身份。

MBF-001 的 received accepted 只表示原请求已受理，不证明 Playing。未确认提交不新增 UUID 或重新派发；原 request/曲目/资产修订/Core/Zone 的实际 Playing/Paused，或该原意图安全结束后，才解除保护。诊断使用有限枚举、时间与实际 HTTP 阶段，不输出上游 URL、路径、凭据、SDK session 身份或响应正文。格式软件检查不能推断真实失败文件的 SubFormat、实际媒体送达或声音根因；普通 App 的原未知意图由调度在同一原 Core/Zone/session 中核对后，再进入候选窗口。

MBF-002/003 的专辑浏览与完整 CoverDrop 功能在反馈独立分支实现；其九个已释放共享接点不在本期编辑范围。V3.9 在004封版后负责串行接线、整合磁带兼容与反馈成果，随后推进016。开发测试、候选与普通应用回归由 Codex 完成，全部三个反馈修复后再交 Owner 最终试用。
