# TASK-068：参考资料与不可变目录修订

## 身份与授权

- 基线：`b95ef2c26dc0bdbf89c64d8c99f79ad8f2b4a83a`，TASK-067 最终锁定。
- 分支：`codex/task-068-reference-catalog`。
- 实现提交：`14a9cfdde0f5b35b88b09d79ab5c3302a682f61b`。报告提交由最终 STATUS 锁定，最终 HEAD 由本机 final-closeout.json 与 TASK-069 基线锚定。
- Owner 持续开发与 GPT-5.6 Sol / High 并行授权；无 push、main 合并或发布。全部资料、库存、文件及音频验证使用合成数据，不读取真实书籍、Excel、用户库存、Provider/Roon 或硬件。

## 交付内容

1. ReferenceSourceVersion 与 CatalogRevision 分离。原 UTF-8 Source Pack、SHA-256 和来源元数据不可变；解析允许首 BOM，保存与摘要保留原 BOM、空白和 CRLF。只接受用户明确选择或粘贴的有界 JSON，默认无书籍数据，不自动抓图或扫描目录。
2. Canonical 项保存 referenceId/bookId、品牌、系列、版次、型号、时长、IEC、年代、参考图或明确无图、页码、备注和置信度。重复页与时长不增加分母；同 ID 的冲突元数据和不同 ID 的同一 canonical 身份均拒绝。
3. 每本资料有独立目录修订链与当前指针。发布需明确确认、当前版本和包含匹配/库存事实的预览指纹；同 commandId 重复返回原回执，改参或过期基线拒绝。显式多合一保留既有确认但只计一次；一拆多将原关联转为待复核，不猜测迁移。
4. 关联审核区分 confirmed、candidate、needs-review 与 unmatched。默认 Unknown，Missing 只由用户明确声明；候选和待复核不算 Owned。同一库存型号不能确认贡献两个 canonical，目录操作不增加库存或修改照片、永久编号及既有归档。
5. 发布和审核保存不可变历史完成度 snapshot；当前读取另算 currentCounts/currentEntries，后续库存变动不重写旧快照。历史按版次分页读取摘要，快照按 ID 单独读取，支持只读前后比较。
6. 收藏页 tablist 旁提供“参考目录与版次”入口，四步分别为资料来源、整理发布、关联审核、历史快照。包含可读条目表单、显式合并/拆分映射、高级 JSON 草案辅助、独立确认、原命令重试和关闭提示。不增加侧栏或自动写入。
7. 九个公开 API 接入正式 Main/preload/Core 链路；三项写操作只经 TASK-067 持久 outbox 和原工作库 scope，Main 新 handler 仅提供有限读取/预览。冷启不投递；回执丢失后的人工恢复不产生第二份来源或账本事件。
8. collection schema14→15 事务迁移，新增六张参考表及不可变触发器。固定旧库证明原库存、照片、实物编号和账本守恒。旧 schema14 备份继续只读可验证，新 schema15 执行目录完整性校验，并支持 SQLite 快照、隔离恢复及默认/激活工作库冷启。

输入上限为 1 MiB / 500 条 Source Pack；目录存储预检限制单行 8 MiB、总数据 128 MiB、20,000 行，超限同事务拒绝，不删除来源或历史。只读校验检查原文 Hash、修订链、匹配/快照引用、当前快照一致性和不可变 schema。

## 自动 Gate

最终 **37 个代码/测试/配置文件**逐项 Git blob 一致，固定原生包 **13 文件** SHA-256 一致。所有退出码均现场取得。

| 检查 | 结果 | 退出码 |
|---|---|---|
| verify：类型、合同、Core、Desktop 与生产构建 | 95/95、847/847、291/291 | 0 |
| E2E TypeScript | 随桌面 typecheck 执行 | 0 |
| 安全 | 27/27 | 0 |
| Electron | 4/4 | 0 |
| 默认完整 E2E 调用 | 56 通过，1 项固定 native 因 opt-in 跳过 | 0 |
| 固定 native 显式专项 | MUSIC_BRIDGE_NATIVE_GATE=1，1/1 通过，无 skip | 0 |
| Control / Boundaries / Cycles | PASS / PASS / 182 files PASS | 0 |
| diff-check / 候选身份 | 37/37 一致 | 0 |

两次 E2E 调用使用同一候选和同一已核定原生包，合计 **57 个不同用例均执行通过**；不宣称某次单一调用有 57 pass 且零 skip。固定 native 专项实际运行转换、文件验证和冷启动，不代表硬件、签名或发布准入。

实际新 Electron 用例覆盖九 API、重复原命令、合并/拆分、历史冷启、四步页面确认，以及 Main 来源登记成功回执写盘失败后的冷启与人工恢复。独立 SQLite oracle 核对目录账本不重复、参考操作不增加库存。720 窄窗无横向溢出，页面审核状态 axe serious/critical 为 0；主任务查看了布局截图，Owner 视觉接受仍未完成。

## 审查与失败证据

独立 SPEC 两轮最终 PASS、独立 QUALITY 两轮最终 PASS，最终 P0/P1/P2=0，没有第三轮派审。QUALITY 第一轮唯一 P2 为四个枚举 guard 的字符串强制转换允许数组穿透；四项实际 RED 后收紧类型，原包/setMatch/IPC/outbox 拒绝路径全部覆盖。

初次全量类型检查暴露两个测试构造问题；随后 Core 840/847 的七项失败来自旧测试模拟历史 schema 时残留新参考表。修正只涉及夹具 SQL/最终版本与类型断言，保留旧故障、账本和历史断言；定向 94/94 及最终 Core 847/847 均通过。UI 首次下拉框测试选择器失败经 DOM 诊断定位，改为实际 combobox 无障碍名称精确选择，没有放宽生产验证。详见 TASK-068_PROGRESS。

本机证据目录为 `reports/runtime/task-068-reference-catalog/`，包括行为 RED/GREEN、初次/二次集成失败、最终 Gate、原生专项、候选 blobs、审查记录和截图。测试输出只作本机证据，不进入实现提交；没有删除或改写用户数据。

## 接续与未完成边界

TASK-069 从本任务最终锁定 HEAD 创建独立分支，继续非破坏 Excel 导入。工作簿原字节 Hash、Source Row、跨 revision 重排识别与人工确认、已用/未知数量、保护人工资料和库存账本均需独立实现与验证；本任务不表示实际《磁带大全》或 Excel 已导入整理。

完整 V3、Gate A～E、U-01～U-10、TASK-070 完整完成度/Want List、真实账号/资料/Logic/硬件和 Owner 接受未完成。F-01 未决，不自动删除音频、不冻结正式 Plan/Attempt；R-020 大库完整扫描与 2 秒 ready 策略继续交 TASK-078/Gate E。TASK-047 真实歌词、TASK-061 发布准入及既有 Beta/视觉 carryover 不因此关闭。
