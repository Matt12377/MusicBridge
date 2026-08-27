# TASK-043 结果报告：LocalTrackSignature 与有界匹配仓库

> 2026-08-27 集成补录：Owner 已授权整条歌词功能线集成 main；本文未合并表述保留为历史状态，最新边界见 [WAVE-4 集成补录](WAVE-4_INTEGRATION_ADDENDUM.md)。

## 身份

- 分支：`codex/task-043-local-track-signature-repository`
- 直接基线：`40bde67dd552f1286ae491c4887928e12f7718dc`（TASK-042 最终未合并 HEAD）
- 实现提交：`fe17c5e978258d3f85a7ff3d66f436a86751904d`
- PR：[#9](https://github.com/Matt12377/MusicBridge/pull/9)，base=`codex/task-042-local-lyrics-match-domain`，保持 Open
- Owner 策略：各 Slice 线性堆叠，完整功能和最终验收前不合并。

## 实现

- `LocalTrackSignature` 只含 canonical title、artists、album、durationMs、version；不接纳 runtime reference、item_key、媒体路径或歌词。
- 规范化执行 NFKC、大小写、有限标点和空白；artists 去重稳定排序；duration 四舍五入到最近 1 秒。
- key 为 canonical JSON 的 SHA-256 前 128 bit（32 位十六进制）。title/artists 必填且所有字段有长度/数量上限。
- 仓库只接受正整数形式的 NetEase Track ID 和 `CONFIRMED/MANUAL`。
- schemaVersion=1，严格拒绝额外字段、超长字段、key/签名不一致、重复 key、非法时间戳、未知状态及超过 4096 条的文件。
- 自动确认记录受 algorithmVersion 约束；MANUAL 在算法升级后仍有效。
- mutation 串行；set/touch/delete 在持久化失败时恢复完整内存快照。
- 文件路径必须显式注入；无路径时仅内存工作，不使用 `process.cwd()`。
- 持久化使用唯一临时文件、0600、原子 rename；新建数据目录固定 0700，失败后删除临时文件且不覆盖损坏源文件。
- 容量最多 4096，按 lastUsedAt 和 signature key 确定性 LRU 淘汰；API 仅提供 get/set/touch/delete/listBounded。

## TDD 与验证

- RED：12 项中 9 项行为失败；固定 key 无法区分 version/artist/duration，仓库正向映射未实现。模块可加载且测试确实执行。
- focused GREEN：13/13，覆盖稳定签名、隐私字段、正向状态、算法失效、LRU、并发串行、权限、回滚、损坏文件和严格 schema。
- bridge-core 全量：371/371。
- bridge-core typecheck：PASS；production build：PASS。
- `CONTROL_PLANE=PASS`、`BOUNDARIES=PASS`、`CYCLES=PASS files=95`。
- 精确暂存后的 `git diff --cached --check`：PASS。

## 审查与边界

规格审查先通过：只新增任务允许的 signature/repository 与两个 focused 测试，没有网络、IPC、Renderer、Resolver、Coordinator 或真实歌词加载。代码质量审查随后通过，并修正了 JSON 字段顺序不应影响合法性及系统时钟回拨不得破坏时间戳单调性两个问题。

所有文件测试均位于系统临时目录；没有生成或读取真实用户数据，没有连接 Provider、NetEase 账号或 Roon。自动 GREEN、PR/CI、真实设备验收和 Owner 接受保持分离。

## 结论

**TASK-043 本地自动与合成 Gate 通过；PR #9 保持未合并。下一基线为本任务最终报告/身份 HEAD，进入 TASK-044。**
