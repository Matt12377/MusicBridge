# ADR-MBRS-002：原文件只读规则的有限 Organizer 例外

日期：2026-10-04。状态：本轮隔离设计有效规则；生效提交由提交后本文件最后提交解析。`library_write_enabled` 默认 OFF；此记录不授权任何具体源文件写入。

普通扫描、标签分析、播放与默认封面选择继续只读原文件。MB_ONLY 编辑仅写应用库 / 缓存，不占无关音频的排他锁。旧录音 reader / 编译模块仍不可写原文件，旧严格 Hash / 技术 / Frozen / Prepared / Archive 合同保持，原历史文档及审计原件不改写。

唯一有限例外是后续 SOURCE_FILES Organizer：具体根 / 文件 / 字段 / 改名移动 / `plan_hash` 被明确授权，且 writer 已通过保护测试后，才能执行。执行前重新核 root revision、asset revision、完整资源集合、冻结及活动读者；取统一物理资源排他锁，再备份、journal、回读和恢复。客户端 approval、schema 合法或此 ADR 均不等于操作许可。别名、硬链接、共享 cover.jpg、CUE 和歌词纳入同一资源集合。

播放 / 暂停 / 预取 / 录音持有资源时默认延期或拒绝源写，不强停音频挪文件。旧 Frozen 来源即使没有新 asset ID 仍保护；保全旧精确字节的版本化需另有明确方案与许可。逻辑 AssetID 可保留但 file_revision 增加，历史 DigitalSourceBinding 仍指旧精确内容，不能用“声音未变”替换旧整文件 Hash。

MBRS-014 为 MBRS-012/013 的硬保护前置。当前没有新 writer、锁或源操作，规则记录只能满足设计层，不能单独勾选源写应用验收。后续测试需覆盖活动读者、Frozen / Prepared / Archive、硬链接别名、未知结果 / 恢复与未授权拒绝。
