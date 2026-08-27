# TASK-054：授权源目录、只读验证与草稿源绑定

## 当前身份

基线 `5994fc4afdaf27e6e5e97ca9411aa23879808dc8`，分支 `codex/task-054-v3-source-evidence`。全部自动 Gate 已通过。实现提交 `1e2341b71914c9dc484977d372edd752e7fde5be`。本报告独立提交，报告 SHA 由后续 STATUS 锁定；TASK-055 从最终状态锁定 HEAD 接续。

## 实现

Main 原生选择器明确授权目录与选取文件；Renderer 仅持有 UUID，不接收绝对路径，也不能指定任意文件路径。Root 规范路径和设备/目录身份仅存 Core 本地数据库。撤销授权不删除原件、绑定或历史。

Schema 6 与库存、实体音乐、草稿共用事务 SQLite。源取得方式、完整文件 SHA-256、技术探测、修改时间、校验时间、外部引用保存方式、可用状态和人工曲目确认分别记录。实际源当前满足条件时才返回 SourceLockEligible；仅选 Roon 曲目、导出来源、类似元数据或完成 Hash 都不能单独满足。

源任务持久化，重复操作返回同一任务。取消、撤销、内容变化、草稿移除与迟到结果分别受控；重启中的未完成任务显示中断，不自动重播。数据库暂时无法保存结果时不产生未处理后台拒绝，恢复后只补记失败。相同完整 Hash 的显式重新定位保留内容身份并追加证据历史；不同内容不借相近名称自动重连。

只读文件访问使用 O_RDONLY/O_NOFOLLOW、Root/路径组件检查、打开前后 FD/路径身份与完成后复核。完整 Hash 按块读取；仅将有界技术头部交给固定 music-metadata 11.15.0（MIT），不解析用户封面或标签。首批标准 WAV、FLAC、未压缩 AIFF；其他格式及 DSD 转换明确阻断。64 GiB、15 分钟读取循环期限、16 MiB 头部、2048 技术块、两个并行任务。操作系统已经挂起的网络文件 I/O 无强行终止保证；取消仍立即禁止提交结果。

技术头部探测不代表逐帧解码、音频载荷 Hash、声学指纹、执行资产或声音输出验收。源保存方式目前仅 externalReferenceOnly，不冒充归档；最终 Freeze/编译需要重新核对完整源输入。

## RED 与故障定位

- 正式 IPC 初始 UNKNOWN_IPC_COMMAND；仓库没有 source 能力；真实 Electron 页面没有源绑定入口。
- Main→Core→SQLite 完成映射后，草稿旧合同仍恒为 sourceLockEligible=false；现改为当前源证据投影。
- 120 秒 WAV 被通用 Buffer 探测器按 16 MiB 前缀裁成 95.109 秒；改为按已验证数据块边界与帧格式计算时长，技术探测仅消费有界头部。
- 含点路径段未显式拒绝、修改时间缺少独立字段，以及数据库同时拒绝完成/失败写入的后台拒绝，均先有断言失败后修复。

新工作树初次 Playwright 启动等待 Electron 运行文件超时，仅为环境失败；安装已固定的 Electron 运行文件后重新取得 UI 行为 RED。macOS 临时目录别名造成合成 fixture 与规范 Root 不同，fixture 改为规范路径，不放宽生产路径验证。一次元数据解析实验使用 objectMode 流失败，仅为实验，不作为产品通过证据。

## 最终 Gate

- verify：exit 0，Contracts 35、Core 494、Desktop 168 项全部通过。
- security：exit 0，22 项通过。
- Electron：exit 0，4 项通过。
- Playwright：exit 0，41/41 通过。首轮 40 通过、1 条旧导航文案断言失败；按已实现能力更新文案断言后全量复跑通过，原导航/播放行为断言保留。
- control-plane/boundaries/cycles：PASS，115 files；control-plane 只验证旧 WAVE-3。
- git diff --check：exit 0。

源测试包含合成的真实编码 FLAC、AIFF、WAV、全量大文件 Hash、截断、符号链接、越界、取消、重定位、离线/丢失/撤销、内容变化、草稿失效、数据库恢复和不可变账本。Schema 5→6 失败回滚保持草稿与旧账本。界面使用合成 Roon 和隔离临时音频，不代表真实 Roon、用户音乐文件或听感证据。

## Gate A / 后续边界

A-01～A-08、A-10/A-11 的本次源绑定自动部分已覆盖；A-09 仅验证未支持路径拒绝，未实现或认证转换。实际 Source Root 样本、Freeze/编译输入再验证及完整 Gate A 尚待完成。没有正式录音或库存预留。

TASK-055 接入分面规划、初步库存推荐和明确预留。后续保留 Master/Layout 冻结、Logic/执行谱系、输出引擎与设备 Gate B、归档/J-Card/备份、参考目录、Source Picker 实体/数字入口、通用 outbox 与完整 A～E/Owner。

F-01、真实目录/账号/硬件、旧歌词验收及两项 V2 视觉遗留不变。主代理完成规格与代码自查，没有子代理或独立审查声明。无 push/main 合并、打包发布、签名或公证。

本地最终证据：`reports/runtime/task-054-final-imb2bcgr/`；中间与 RED 证据：`reports/runtime/task-054-development/`（均不提交 Git）。720/1440 源面板无横向溢出，局部 axe serious/critical 为 0；已实际查看最终面板顶部和证据区截图。原生选择回执丢失重试只有一个任务，真正退出应用并无 Roon fixture 重启后仍保留源绑定。

远端 main 核验为 `90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098`，没有 TASK-054 远端分支。
