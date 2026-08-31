# ADR-013：录音草稿与 Roon 浏览引用分离

## 决策

选曲后先建立 Draft Master，不从普通播放队列推断母版。草稿使用本地 UUID，每次添加的草稿曲目也拥有独立 UUID；同名或同一 Roon 曲目可由用户在不同追加操作中再次选择，不能按标题自动合并。删除与排序仅针对已有草稿曲目 ID，未改曲目身份不变。

Core 从当前 Roon 公共目录取得安全曲目快照，不信任 Renderer 提供的标题、曲长或来源证明。快照不包含 runtime reference、itemKey、session、封面引用或为了 UI 显示而填充的未知字段占位文字。运行引用仅由协调器在内存保存，最多 4096 条；重启保留草稿，试听链接待重新定位，不自动认领同名内容。

## 存储与校验

统一 collection.sqlite 的 Schema 5 增加 master_drafts 和不可变 master_drafts_ledger。迁移在同一事务中完成，失败保留旧 Schema 4、库存、音乐与已确认关系。命令以 UUID 与规范化请求指纹幂等；revision 拒绝陈旧编辑，事务中断不留下半份草稿。

一个草稿最多 200 首，一次明确选择最多 100 首，读写分页均有边界。标题和节目类型可编辑；修改请求只能保留、删除、重排已存在的曲目，不能注入新的元数据或曲目身份。

## 时间与来源

本阶段草稿始终 sourceLockEligible=false，不允许 Freeze 或正式录音。Compilation 的初步估算为已知曲长之和加相邻边界 5 秒；Concert 和 Continuous Program 不自动追加间隔。任何曲长未知时总时长保持未知。此数值只是草稿估算，不是 Source Lock、精确帧级 Timeline、库存适配或执行资产证明。

后续 Source Binding 必须独立保存 Acquisition、Verification、Preservation、Availability 和用户映射关系；实际源文件验证后再作正式时长、布局、库存和冻结判断。不可把本次元数据快照升级为文件 Hash。

## UI 与证据

现有录音页提供跨专辑选曲、草稿列表、标题/类型/排序/删除与明确保存。取消不写入；回执未知保留原命令重试；明确拒绝刷新后重新确认。所有试听均来自显式用户动作，不在选曲、保存或页面切换时自动播放。

合成 Roon 服务仅用于自动 Gate，正式 Main/Core/SQLite 路径保持一致。合成目录不会提供试听成功证据。真实 Roon、音乐 Source Roots、设备与 Owner 验收仍须独立完成。

后续仍需实际 Source Binding、Source Picker 中的实物/数字关系入口、完整 Layout/库存推荐、版本冻结、录音归档及跨重启未确认命令 outbox；此切片不消除完整 PRD 或 F-01 的未完成项。
