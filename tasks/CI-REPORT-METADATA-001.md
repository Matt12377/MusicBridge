# CI-REPORT-METADATA-001：报告机器状态的精确证据摘要

首次镜像修复 Source `d3d86c6db8d27485d2d763b81cd5e8925ee15af6` 已获得首次自然四 workflow、六 job 和完整 193 项工具 CI 资格。其唯一直接 Report `1b5345d13d9617c1770a361841d805305d06d038` 的首次 CI 失败：完整 GitHub API 元数据被写入机器状态，公开头像查询 URL 与通知接口模板触发原 `status-secret-or-url` 检查。两个历史报告失败和已通过的 Source 证据均保留。

本任务从真实失败 Report `1b5345d13d9617c1770a361841d805305d06d038` 建立独立分支 `codex/ci-report-metadata-001`。本次 Source 的唯一直接父为该失败 Report，本次 Report 的唯一直接父为实际新 Source。只创建普通新增提交并普通 push，不改写历史、不 rerun、不手工 dispatch，不从原产品 Source 产生第二份直接报告。

## 精确范围

Source 固定十三条路径：新增本任务、`CI_REPORT_METADATA_CORRECTION.json`、`CI_REPORT_METADATA_SCOPE.json`、`ci-report-metadata-admission.mjs`、`verify-ci-report-metadata.mjs`、`ci-report-metadata.test.mjs`；修改两条 CI 路由、四个 workflow 和 `project/STATUS.json`。模式和完整字节指纹由 `docs/postrust/MBM-004/CI_REPORT_METADATA_SCOPE.json` 固定。

STATUS 唯一允许的 Source 语义差异是 `.mobileContentMultidevice.ciRepair.sourceCi` 的公开摘要投影，其余字段完全保持。完整 Source1 对象仍保存在 `docs/postrust/MBM-004/CI_EVIDENCE.json#/ciRepair/sourceCi`、其他四份原报告 JSON 及原外置收据。摘要只包含固定身份、run/job 结论、日志与完整工具 ZIP 指纹，以固定 JSON 指针和完整对象的规范 SHA256 绑定证据。规范编码沿用现有模块：对象键递归排序、数组保序、紧凑 `JSON.stringify`、UTF8；摘要自身不取得完整收据资格。

写入从真实父提交的原始字节出发，只替换授权值或插入本次报告域。保护域的大整数、数字类型和原始数字 token 不得因 JSON 整份解析再序列化而改变；准入与行为测试同时覆盖超过 JavaScript 安全整数范围的时间戳。

原 control-plane、CI-REPORT-MIRROR-001 的 correction、scope、admission、Gate、20 项测试和历史资格保持字节。原 MBM-004 产品 `16507120ab52d4843012e6888ad521138d8336d6` 的产品源码、测试、依赖、合同、114 条 Scope 和全部原 producer 保持；不改安全规则，不递归删除完整证据中的 URL。原 18 任务/156 验收项、有效 17/150、MBRS-015 六项 N_A 和全部真实验收状态不变。

Report 精确修改原八条报告路径。四份非 STATUS JSON 仅新增本域完整 `ciReportMetadata`，STATUS 仅新增对应公开摘要，三份 Markdown 仅尾追加。本次完整对象保存在 `CI_EVIDENCE.json#/ciReportMetadata`；摘要绑定该对象，不让被摘要对象引用自己的摘要。报告提交时自身 `reportSha/reportCi` 为 null，实际 Report 自身 CI 由外置收据绑定真实 SHA。

## 验证与完成条件

本次 Source 和 Report 的真实状态投影在发布前各执行未修改的 control-plane。新工具 Gate 固定三个阶段：原十一文件 173 项执行一次，原 control-plane 独立执行，新十六项 metadata 行为执行一次；总 TAP 189 项，控制面不计 TAP。每阶段 90 秒，共用 180 秒绝对截止。必须取得完整 raw、准确次数、自然退出和自有 PID/组/已观察后代物理关闭，Source 输入前后相同才签发资格。仅清理本次 Gate 亲自创建并确认关闭的临时目录。

CI 新路由优先识别本任务的真实 Source/Report，严格检查十三/八路径、唯一父链及全部冻结字节。继承的旧标记作为具体历史校验，未知分支和坏标记仍拒绝；不能靠名字、记录中的 PASS 或路径前缀取得资格。Report 分类须先完成真实 Git 准入，再读取父 Source 的首次自然 CI。

Source 首次自然 push 要求四 workflow/六 job，Report 首次自然 push 要求 verify/security 两 workflow/三 job。各自只接纳一个实际新工具 ZIP，核全日志、完整 ZIP 和全部成员；已下载的原五个产品 ZIP 不再下载，原产品类型、测试、编译、Rust、Electron/App 明确复用 165 的证据，不能写成本次执行通过。旧 001 的二十项历史测试不在新 HEAD 机械重跑；新路由与摘要行为取得本次证据。

Source 和其唯一直接 Report 自身 CI 都收口后，才建立后续集成基线，依次推进 Tape、完整 Feedback、016、017。后续集成必须有自己的精确 Scope 和继承历史路由。本任务没有正式 App、真实服务、设备、音频或 Owner 验收证据，这些状态仍为 `NOT_RUN`。

## Source2 必要修正与双基线（2026-10-11）

首次 Source `dfad0c8e0e0f906c3a7456b0151b3aaba7e5547c` 的自然 CI 五个 job 通过，verify 新十六项行为十五项通过、第十一项 workflowMirror 综合 status 为 1；阶段自然退出，无超时，完整 raw 和全部已观察进程关闭。TAP 没有子命令 stderr，实际失败位置与原严格路径规则的根因推导分别记录。Linux 最小策略探针覆盖旧错误批准根拒绝、正确父级批准根允许。

Source2 沿用本任务和原分支，只普通追加提交。累计范围基线仍为失败 Report `1b5345d13d9617c1770a361841d805305d06d038` 的原十三条路径；实际新 Source 的唯一直接父必须是已推送失败 Source `dfad0c8e0e0f906c3a7456b0151b3aaba7e5547c`。两种身份均进入 correction/scope/admission，累计十三条及相对实际父的七条增量分别冻结，不接受任意中间父链。失败 Source 的原十三路径、tree、Scope 和完整证据固定为 Git 历史快照；没有成功自身 CI，也没有 Report，不能被新 Source 的资格覆盖。

七条必要修改为本任务、correction、scope、admission、Gate、test 和 verify workflow。其他六条累计范围叶保持失败 Source 字节，Source2 的五份原报告 JSON 与三份 Markdown 均保持实际父原字节。原 mirror 六条叶、产品 Scope/114路径、原 producer 和证据保留，不变更 storage 或 source-pinned mirror 规则。

第十一项 fixture helper 使用 DEV_BUILD_ROOT=path.dirname(root)，真实新准入 guard、原 mirror、两历史对象 preparation 仍逐项执行，各阶段保留 status/rejectedAt/stdout/stderr 供归因。Linux 策略 RED/GREEN 添加在同一行为内，其他十五项要求保留。verify 上传改为十二条完整显式根层文件，失败 tmp 留在执行端，不进入 artifact，不靠增大预算解决上传膨胀。

失败 ZIP 的平台声明总大小 75,949,897 字节；本次诊断只读三段 2,549,577 字节、十二根成员完整字节及 CRC，未读 whole ZIP 或核 whole SHA256，无成功资格。Source2 和其唯一直接八路径 Report 必须各自 fresh189 Gate 与首次自然自身 CI，预算、全 raw、自然关闭、whole ZIP 十二成员和完整日志要求均保持；不 rerun/dispatch/改写失败历史，也不机械重跑旧 metadata16 或 mirror20，不重复五个产品包、构建或 App。
