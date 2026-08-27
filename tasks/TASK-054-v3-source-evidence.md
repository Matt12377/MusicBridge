# TASK-054：授权源目录、只读文件校验与源绑定

## 身份与边界

Owner 持续授权全部开发。基线 `5994fc4afdaf27e6e5e97ca9411aa23879808dc8`，分支 `codex/task-054-v3-source-evidence`。真实账号、源目录与硬件仍未授权本轮自动访问，自动验证仅使用隔离生成的合成音频。

## 范围

1. 在录音上下文通过原生目录选择器明确授权 Source Root；只保存本地目录能力和 Root UUID，Renderer 不接收绝对路径。允许明确撤销授权，不删除源文件或既有历史绑定。
2. 在已授权 Root 内通过原生文件选择器选取实际音频，Core 校验归属、普通文件、链接/路径穿越及文件身份后只读访问。Root 暂离线与单文件丢失分开，不自动扩展读取范围。
3. 完整 SHA-256、技术参数、文件大小/修改时间/快照时间独立保存。Acquisition、Verification、Preservation、Availability、用户曲目映射分别记录；Roon 桌面导出不自动获得校验或原件同一性证明。
4. 大文件校验使用可查询、可取消、有稳定命令 ID 的后台任务。回执重试幂等；重启中的未完成任务显示中断，不伪装完成或自动重播。校验中内容变化、撤销授权、越界、格式不支持都拒绝提交有效绑定。
5. 用户核对后明确确认当前文件与草稿曲目对应。文件选择、完整 Hash 或技术探测单独都不够 Source Lock。重新校验发现变化撤销可用证据，不能凭旧标记继续冻结；相同 Hash 的显式重新定位不改内容身份。
6. 草稿显示源绑定及验证情况，不在此任务完成 Layout/母版 Freeze/执行资产/归档。最终 Freeze 与编译必须再次核对当前输入，不能依赖历史验证快照。
7. 数据迁移、文件读取取消与回滚、不可变操作记录、元数据/引用隐私、跨重启和正式 Main→Core→SQLite 界面验证。Source Picker 的实体/数字关联入口继续作为后续集成承接项，不忽略完整 PRD。

## 允许修改

- Contracts 新 `source-evidence.ts`、`master-drafts.ts`、index/ipc/validator/errors 及相关既有测试。
- Core `src/recording/`、collection/repository、runtime/utility-main、必要的只读源文件模块；扩展既有 repository/runtime/utility 测试，新源校验与协调器测试可用于新边界。
- Desktop main 源选择器/IPC、core-supervisor 及相关测试（仅必要协议支持）、preload、recording 组件及相关 composable、既有 E2E；Electron 构建配置仅在新依赖打包需要时调整。
- Core/Desktop package.json 与 pnpm-lock.yaml 可引入精确固定的 `music-metadata@11.15.0`（MIT，已查询注册表），无安装脚本、无在线音频读取。必要的源探测模块只在 Core 运行。
- 当前任务/索引/WAVE-5/STATUS/执行计划、ADR-014、结果报告和本地证据。

## Gate A 与未完成项

逐项取证 A-01～A-11 的自动可验证部分，未支持转换的格式明确阻断，不伪造转换谱系。真实文件绑定样本必须等 Owner 指定 Source Roots 后另行执行。不能将合成通过写成完整 Gate A/真实验收通过。

保留 F-01、正式输出 Gate B、库存完整 Gate C、版本/归档 Gate D/E、跨 Renderer/应用重启通用 outbox、旧真实歌词及视觉 carryover。无 push、main 合并、原件改写或真实录音。
