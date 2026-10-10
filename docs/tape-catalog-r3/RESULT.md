# TAPE-CATALOG-R3 隔离实现与验证结果

已完成完整磁带资料 ZIP 的受控归档、参考目录导入和品牌 → 型号 → 原书年代／版次浏览。资料与个人库存继续分开：导入 634 条资料不会产生个人磁带、购买记录或拥有事实。CLI 与开发验证继续使用 Node.js 22。

本报告的完成范围是独立分支中的实现、本地完整检查和实际来源资料的隔离 Electron 观察。生产 profile 导入、协调合流、远端 CI 与 Owner 成品试用仍待各自流程。

## 分支与证据身份

| 项目 | 身份 |
| --- | --- |
| 任务 | `TAPE-CATALOG-R3` |
| base SHA | `c0b945a2b8d0f6f3ee2d9ea9d2cb50a787dc7f95` |
| 分支 | `codex/tape-catalog-r3-import` |
| 实现提交 | `ff02c6b2fd248748fe7d461259f5749dda86fa0c` |
| 报告提交与下一任务基线 | 承载本报告的独立提交；精确最终身份见外置 `evidence/closing-identity.json` |
| checkout／独立 common-dir | `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-tape-r3-Tjy8hr/workspace`／该目录的 `.git` |
| 本地证据根 | `/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-tape-r3-Tjy8hr` |
| 隔离 profile | 上述证据根下的 `musicbridge-ui-e2e-tape-r3-final` |
| 开发运行时 | Node.js `22.23.2`；Corepack pnpm `10.17.1` |
| Electron 观察运行时 | 官方身份门禁验证的 Electron `43.4.0`，mock 钥匙串，离线测试模式 |
| 远端只读核对 | 仓库 HEAD `05256eb867e37574e16f23eab877026a229a1703`；本任务分支无远端 ref，未 push |

源 ZIP 为 `/Users/yihe/Desktop/MusicBridge磁带资料库_r3_真实照片增强版_20261001.zip`，SHA-256 为 `ba412eea07a260f672565e491fff20468ec86ccb9979f3a694e8122d79af8ab5`。原包全条目审计与重复归档未改变源文件身份。

`ARTIFACTS.json` 记录 37 项证据／截图／日志的精确路径、尺寸与 SHA-256；相对路径均相对于上表的证据根。证据和全量来源资产保留在外置任务目录，没有提交到 Git。

## 最终行为

- Main 使用本地文件选择器读取完整 ZIP；流式校验、复制并完整保留 20,773 个原始条目。包内 README、脚本和 SQLite 都作为来源文件归档，没有执行。旧小型 JSON／ZIP 合同限额继续保留。
- 归档按 ZIP 哈希绑定原始正文、图片和来源 manifest。安全路径、文件类型、CRC、SHA、原始身份和读取前后文件状态均有检查；相同内容复用同一档案，异常已有目录拒绝覆盖。
- 目录登记与发布继续走既有唯一 Core 作者和持久 outbox。事务失败回滚；保留 ID 生成完整一对一映射，延续旧匹配状态。身份变化、移除、合并或拆分需要重新核对，不静默改写旧关联。
- 预览绑定 dataset、当前目录修订、库存与匹配基线。确认前和异步档案校验后再次检查资料库身份；恢复或切换资料库后的旧预览被拒绝。
- “全部磁带资料”提供 34 个品牌、329 组型号、634 条年代／版次资料及直接搜索。型号分组同时区分品牌、系列与 IEC；未知年代和缺图条目保留。
- 详情读取原书全文、依据、修正说明和原尺寸 cutout；列表沿用原书 wall。真实照片与不透明展示素材分别说明来源，保留水印和原书主图关系。
- “添加到我的收藏”沿用原录入功能，仅带入品牌、型号、介质与带型。数量为 0，年份、版次、时长为空，识别状态为尚未识别；保存仍使用原库存校验。“关联已有库存”直达既有关联审核入口，拥有事实仍来自用户明确确认和实际库存。
- 正常、待激活和已恢复资料库均使用同一 profile 的私有档案根，恢复后嵌套数据库路径不会使正文和原图读取偏离。

公共文件用途与旧测试夹具适配见 `EXECUTION_SCOPE.json`。本分支未修改 mobile 合同、播放转换、`core-environment.ts`、共享 `project/STATUS.json`、POSTRUST 台账或 MBM-003 文档。

## 来源计数与文字覆盖

| 分母／项目 | 实际计数 |
| --- | ---: |
| 参考条目／UI 型号组／品牌 | 634／329／34 |
| 最终原书图片资产 manifest | 1,744 |
| 有合格主图／缺主图条目 | 618／16 |
| 真实照片引用／独立照片文件 | 235／198 |
| 不透明展示关联 | 159 |
| 可读取逻辑图片资源 | 3,882 = 1,744 wall + 1,744 cutout + 235 照片引用 + 159 展示引用 |
| 原文 manifest 页／文字面板 | 122／787 |
| 与参考条目关联的独立面板 | 619，其中 473 有转录、146 为空 |
| 未关联到参考条目的来源面板 | 168，仍完整归档 |
| 参考条目与面板的关联次数 | 986，其中 766 非空转录、220 空转录 |
| 有至少一个非空转录的参考条目 | 489 |
| 仅有空转录关联的参考条目 | 145 |
| 同时含非空和空转录的参考条目 | 75 |
| 没有任何面板关联的参考条目 | 0 |
| 有摘要的参考条目 | 509 |
| 独立／合并产品正文、仅共享背景、无产品正文类别 | 422／67／145 |

220 是空转录的**关联次数**，不是型号数、独立面板数或缺文字条目数。766 也不能当作独立面板数。逐参考条目的明细保存在 `evidence/text-coverage.json`；所有 634 条的最新 Main 投影逐条检查见 `evidence/text-projection-final.json`。早期原包 Gate JSON 中 `fullTextTranscriptionCount` 字段的 766 同样表示非空转录关联次数。

源为空的正文保留空值和明确限制提示；仅共享正文的 67 条另作说明。没有进行 OCR 或补写原书全文。源资料的生产年份验证均为 false；256 条供应时长为空，继续按未知显示。原书标题中的年份与包装标签时长分别显示依据，不提升为已确认生产年份或完整供应范围。

16 条缺主图的原因分别为遮挡 10、质量不合格 2、归属不明 3、没有独立照片 1。原书透明主图替换为真实照片的数量为 0。FUJI Range-6 的 r3 时长纠正保留完整来源依据，并显示从 46／60／90 改为 46／60 分钟。

## 验证结果

| 检查 | 退出码／结果 | 证据 |
| --- | --- | --- |
| 全量原 ZIP 只读审计 | 0；全部 CRC／SHA 校验 | `evidence/cassette-archive/` |
| 实际完整包隔离导入 | 0；634 条、618 主图、16 缺图；旧匹配保留 | `evidence/actual-import-final2/actual-import.json` |
| 故障回滚、同命令／新命令重复导入、冷开 | 0；修订和档案身份复用 | 同上 |
| 同 profile 实际备份、验证、恢复、激活和冷开 | 0；正文／原图可读，旧 dataset 预览拒绝 | `evidence/same-profile-restore/same-profile-restore.json` |
| 全部参考条目文字投影 | 0；766 原文、220 空转录提示、纠正与覆盖限制完整 | `evidence/text-projection-final.json` |
| 离线隔离 Electron 实际操作 | 0；三层浏览、搜索、原图、缺图原因、录入与关联入口、重复导入和重启 | `evidence/electron-app-sealed/electron-observation.json` 与 10 张截图 |
| 应用观察后的当前 head 与库存核对 | 0；仍为原导入 head、2 个历史修订、1 个合成库存型号／2 盘 | `evidence/after-app-head-and-inventory.json` |
| `corepack pnpm@10.17.1 verify` | 0；类型检查、全测试、完整构建、preload 依赖检查通过 | `logs/verify-sealed.log` |
| 生产模式 `startup-gate.mjs --keychain=mock` | 0；`DESKTOP_STARTUP_MOCK_PASS=production` | `logs/startup-production.log` |
| control-plane／boundaries | 均 0，PASS | `logs/control-plane-sealed.log`／`logs/boundaries-sealed.log` |
| 源码与实现提交绑定 | 0；42 个变更源码文件和全部 1,777 个冻结输入均匹配提交 | `evidence/source-commit-binding.json` |

完整测试分为 contracts 286 通过、Core 主阶段 2,795 通过／2 条既有条件跳过、排队 Stop 独立阶段 8 通过、desktop 1,690 通过；合计 **4,779 通过、0 失败、2 跳过**。跳过项是原生输出与原生租约相关的显式条件测试，没有启用额外原生标志。

原包 Core Gate 中，114 个非 reference 表逐行内容哈希守恒，合成既有库存保持 1 个型号、2 盘。非空旧照片、个人录音、实体数字关联及各匹配状态还由行为测试覆盖。真实 outbox 路径另由 Electron 操作验证；持久命令回执按既有流程写入。

隔离 Electron 两次正常关闭均为退出码 0、无 signal；页面错误为空，离线阻断层在窗口创建前安装，外部访问尝试为 0。系统钥匙串、真实 Provider、Roon、真实音频与 Owner 验收未作为这些结果的一部分。

早期检查的失败记录继续保留：一次完整验证因运行期间更新 Main 说明而被输入冻结门禁拒绝；最终冻结后整套重跑通过。桌面 VM 夹具补齐既有显示函数的真实导入，原断言保留；TMPDIR 改为外置任务子目录后路径门禁通过。观察脚本也按实际组合框名称和既有“确认关闭”流程调整后重跑。早期 Node 25 定向结果不作为最终开发验证依据。

## 交接与保留事项

现有备份流程的资料库元数据保留 archive 哈希和关联，但备份包**不包含独立磁带档案字节**。本次同 profile 恢复成功依赖该 profile 下的完整档案仍存在且校验有效。跨机器恢复需另保留原 ZIP，在新 profile 重新准备档案；缓存目录的文件身份封印不能当作可移植备份。

生产导入由协调线核验 profile 身份、可恢复备份、前后库存／照片／录音／关联守恒与不冲突时点后安排。随后按协调线认可的 MBM-003 封存基线合流，检查公共文件交叉并重新验证。当前分支仍从 c0 基线派生，没有自行引入 003 的播放修复。

本任务没有 push，也没有远端 CI 或 Owner 成品试用结论。远端 ref 只读核对已成功；初次默认 TLS 连接失败后，临时 HTTP/1.1 重试成功，没有修改 Git 配置。原 MusicBridge checkout 的分支、HEAD 与三项未跟踪 WIP 保留；共享资料库和 003 设备联测没有被占用。

最终分支 HEAD、实现／报告提交、工作区清洁、原 checkout 身份、远端核对与报告文件哈希收于外置 `evidence/closing-identity.json`。下一任务从该最终报告提交派生；正式合流和发布时点仍由协调线确定。
