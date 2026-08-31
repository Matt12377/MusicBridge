# TASK-068：参考目录与版次修订

## 身份与授权

基线 `b95ef2c26dc0bdbf89c64d8c99f79ad8f2b4a83a`，独立分支 `codex/task-068-reference-catalog`。Owner已授权完整队列持续开发与GPT-5.6 Sol / High互斥范围并行。不push/main合并/发布，不读取真实书籍/Excel/照片/库存或Provider/Roon。TASK067保持clean。本任务只有本地合成验证，不代表《磁带大全（中文版）》数据已导入清洗或Owner接受。

## 完整范围

PRD25/26/31与GateC09/C11：ReferenceSourceVersion保存资料版本、书籍/来源身份和实际结构化Source Pack的SHA256；CatalogRevision保存整理后的不可变目录。参考项与用户库存CollectionModel分开，资料登记和浏览不增加库存。Canonical项保存Reference ID、Book ID、品牌、系列、Edition、型号、已知时长、IEC、年代/时期、参考图或明确无图、来源页、备注和置信度。重复书页/时长不能产生多份收藏分母。

采用显式输入的有界结构化JSON Source Pack：可由用户选择JSON或粘贴，先严格预览，明确确认后记录原UTF-8包与Hash。禁止自动读取目录、网络抓图或把示例当实际书籍。参考图必须标为参考，不能算拥有实物证据。先登记原始资料版本，再预览/确认发布目录revision，二者不能混为同一可改写记录。

目录按书籍/参考集合保持修订链与当前指针。发布预检有基线/指纹，重复commandId原回执，改参/过期版本冲突。合并多个旧canonical项可映射既有确认Ownership且只算一次；拆分必须把旧匹配置Needs Review，不能自动把一个用户型号计为两个；新增只影响新revision分母。没有明确映射不能猜测转移。不可变历史完成度snapshot及升级前后差异保留。

支持明确确认/候选/未匹配的库存型号到canonical关联，以及明确Missing/Unknown区分。默认无确认信息为Unknown，疑似版次不自动Owned/Missing；同一库存型号不能在一个revision确认贡献两个canonical。候选与拆分待审不贡献已确认拥有数量。库存账本、用户照片、实物ID和历史归档不改写。本任务实现修订与关联基础；TASK070接Want List和完整完成度展示，不能反过来缺失本任务历史snapshot语义。

## 边界与路径

- Contracts智能体独占新的reference-catalog.ts及必要index/ipc/validator/command-outbox合同与合同测试，先给明确API再实现。
- Store智能体独占新的collection/reference-catalog-store.ts及相关Core tests、collection repository/types迁移接线；schema15属于collection快照。先与合同对齐，不改Main/UI。原schema14备份继续可读，后续新schema备份恢复需要覆盖。
- UI智能体独占collection内参考目录组件/controller/相关desktop test；沿用ui-ux-pro-max与现有tokens/导航，只在收藏上下文增加入口，不改App/Main/preload共享文件。
- root负责Main/preload、runtime/utility、outbox UI label、备份恢复schema兼容与E2E，以及任务/ADR/STATUS/TODO/WAVE/报告。共享文件先交接。

## 验证与接续

所有新生产行为先RED；合同非法字段/私有路径/有界包、SHA原字节、重复页去重、事务幂等/冲突/撤销、合并/拆分/新增历史、Unknown/Missing、库存守恒、旧schema14及新schema15备份恢复、实际Renderer/Electron冷启、无自动播放/写库存均需证据。所有新稳定写命令接TASK067显式outbox白名单和原工作库scope，不能增加无scope旧handler。

SPEC后QUALITY，修复/复审最多两轮；最终verify/security/Electron/完整E2E/control/boundaries/cycles、候选blob与独立三提交。TASK069从本任务最终HEAD接续。F-01、R-020容量、真实目录/账号/硬件和Owner验收继续保留。
