# ADR-023：归档确认、执行谱系与后台生命周期

状态：TASK-063 本地实现；不决定 F-01 长期保留政策。

## 决策

Main 原生选择归档父目录，只将候选授权存入 Core SQLite；Renderer 不传路径。明确初始化时，先持久化带随机 nonce 的 owner 意图，再新建应用独立子目录。文件成功而 DB 提交失败时，用同一意图核对恢复，不接管不匹配目录。Source Root 授权前拒绝与已初始化或已有初始化意图的归档路径重叠，任一包含方向都拒绝。

预览仅核对冻结执行资产和源文件、生成文件描述与容量提案；不创建归档操作或归档文件。用户明确选择 Reference Dependent 或 Preserve Exact Sources，然后另行确认归档。稳定命令和确认内容写入不可变账本；重复 start 先返回原操作，无需已离线的原输入重新参与。重复 cancel 不取消后来的 resume。

实际音频、转换中间文件、原执行 Manifest 与冻结 Master/Layout/执行参数事实必须归档。Prepared 额外保存原始 Render 和原 Manifest；引用路径可让同 Hash 同时承担 raw-render/execution-audio，两条引用共享一个内容对象。精确源复制使用冻结 Hash/长度与当前明确授权绑定，不按同名猜测。清单纯函数与原发布流程共享，保持原字节格式。

后台复制和读取有独立 AbortSignal、期限与撤权订阅。Root 初始化也受关闭/撤权/期限约束。恢复与普通读取分别推进，旧恢复不阻塞取消新读取。文件阶段和 SQLite 提交沿用 ADR-022；当前 FINALIZED 只代表历史事务完成，当前可用性必须重读 Hash。已提交引用不伪撤销，取消/失败文件不自动删除。

## 范围与后果

本阶段仅归档已准备的执行事实，不冻结 RecordingPlan/Attempt，不改变实体库存或录音完成状态。只有支持已验证硬链接/fsync语义的本地文件系统获得当前证据；多应用实例共写、NAS/FAT、完整备份/恢复和 Quarantine 管理仍待后续。保留政策显示 unresolved-no-automatic-deletion，formalReady 始终 false。

UI 内联在现有执行资产窗口，源政策初始未选，初始化/内容确认分步显示；未知回执保持原命令重试，返回保留原参数界面与焦点。所有真实目录、账号、输出设备与 Owner 验收仍由后续明确操作取得，自动Gate与本地提交不替代这些证据。
