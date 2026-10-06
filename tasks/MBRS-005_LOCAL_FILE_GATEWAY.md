# MBRS-005 · 生产原文件Gateway与统一读租约

版本：1.2｜状态：IN_PROGRESS｜范围：CORE。原任务规格与12条验收保持；实施边界见下方。

## 目标

在已有HTTP基础增加本地数据来源，不放松远程上游安全规则。

## 依赖与执行边界

硬依赖：MBRS-001、MBRS-002

任务依赖表示验收条件，不阻止提前编写隔离合同/mock；产品接入必须有G0记录。编号不是提交顺序。

先核对 [实际代码复用表](../docs/postrust/MBRS-000/REUSE_MAP_RESOLVED.md)、[Rust待办映射](../docs/postrust/MBRS-000/RUST_TO_MBRS_RESOLVED.json)、[现有本地对象合同](MBRS-002_LOCAL_SOURCE_CONTRACTS.md)。文件名是当前定位线索；迁移后使用等价后继实现，不恢复旧架构。

## 实施步骤

1. 以实际StreamGateway/Registry后继实现为基础，加入LocalFileSource和Lease；本地FD读取与远程fetch allowlist分开，不使用file://绕过secureGatewayFetch。

2. 租约固定asset/root revision与已打开句柄。PREPARED可在真实SessionBegan前存在，确认后绑定会话；URL secret只在服务端内存。

3. 完整GET、HEAD、单Range、If-Range与206/416；逐段对照原字节，不gzip、不转码、不重封装。固定多Range策略和整数/长度预算。

4. 同机loopback；异机只在批准LAN媒体接口暴露，控制IPC不外泄；advertised URL来自可信配置，Core可达性由实际请求证明。

5. 多个GET/HEAD/Range、暂停续期、当前/下一曲引用、有界FD/连接/缓冲与取消。HTTP完成不等于播放结束，不过早撤销seek资源。

6. 同Organizer和录音读者共享资源互斥；规范资源身份覆盖跨根别名、硬链接与共享cover文件。可观察替换/截断立即失效，不能在旧lease输出新旧混合字节。

7. 对任意第三方隐蔽原地修改明确能力限制；不借此无授权复制整个音乐库。错误、过期、关闭和异常自然收尾可复现。

## 验收

- [ ] **MBRS-AT-005-01 / integration / 1.1**：完整GET与源文件同hash，任意受测Range与准确切片一致，HEAD无body。

- [ ] **MBRS-AT-005-02 / unit / 1.1**：206/416/Content-Range/Length/后缀和开放Range正确，大整数/畸形多range有界。

- [ ] **MBRS-AT-005-03 / unit / 1.1**：If-Range和validator策略正确，不把新版文件放到旧lease；弱证据不冒充强ETag。

- [ ] **MBRS-AT-005-04 / security / 1.1**：任意path/URL、路径逃逸、链接越界、未授权根、无效secret与非GET/HEAD被拒绝。

- [ ] **MBRS-AT-005-05 / security / 1.1**：只有媒体读服务按批准LAN设置开放，控制IPC不外泄；日志/渲染层无secret。

- [ ] **MBRS-AT-005-06 / live_roon / 1.1**：实际Core成功完成探测/拉流/seek多请求，HEAD不消费一次性token。

- [ ] **MBRS-AT-005-07 / fault / 1.1**：暂停跨闲置期恢复、有限预取/取消与正常终态后lease资源正确。

- [ ] **MBRS-AT-005-08 / fault / 1.1**：文件改名/替换/截断、NAS离线、连接断开不混合字节、不泄露句柄或无限重试。

- [ ] **MBRS-AT-005-09 / integration / 1.1**：活跃/暂停读lease与写入独占互斥，确认后开始播放也能阻止源写操作。

- [ ] **MBRS-AT-005-10 / load / 1.1**：大文件和重复Range无随文件长度增长的常驻内存，慢读取不会阻塞UI控制。

- [ ] **MBRS-AT-005-11 / security / 1.2**：跨根别名、硬链接和共享cover资源通过统一物理资源身份协调读写，单按asset_id加锁不能绕过保护。

- [ ] **MBRS-AT-005-12 / unit / 1.2**：PREPARED租约可在SessionBegan前存在，ACTIVE/PAUSED绑定已确认会话；旧attempt不能重新激活。

## 交付物

- `本地Gateway增量`

- `AssetLease与锁协调`

- `HTTP/字节/安全测试`

- `NETWORK_ACCESS.md`

## 禁止

禁止任意path参数/目录列表/远程安全降级；禁止照搬8小时token宣称完整文件租约。

## 阻断处理

无异机测试只声明同机范围；缺本地文件服务不能暗中fallback原生播放。

## 证据与回退

结果报告按现有报告约定交代码范围、确切提交、命令/退出码、失败保留、证据层级及未完成项。产品测试不是包结构校验；纯设计/旧报告/上游支持不能替代新实机证据。

沿用 [AGENTS.md](../AGENTS.md) 的验证和回退要求，区分代码、数据库、文件及运行服务的恢复。共享交付只维护一个主实施任务，不复制实现或完成状态。

## 2026-10-06 实施冻结

从004最终报告 `52c9ffe0aec3c581fe4682a8fd3ba8edf1a74f58` 建立独立分支 `codex/mbrs-005-local-file-gateway`。Owner本轮明确授权持续开发到017、适时普通push，每完成一项更新待办；测试按改动风险选择，不机械重跑全量。授权及基线见 [执行记录](../docs/postrust/MBRS-005/EXECUTION_SCOPE.json)，当前有限G0见 [RUST-016准入范围](../docs/postrust/RUST-016/ADMISSION_SCOPE.md)。旧004交接里的“005未开始/本轮不执行”保留其历史时点，本轮授权已覆盖任务开始。

产品写作者维护bridge-core及必要Desktop私有启动胶水；主控只写Gate、workflow、任务、project和docs，再串行接管整合。保持Node dataset-owner Worker唯一业务库writer、BridgeController唯一播放/代际权威；不新增public IPC/path合同、第二队列或Rust默认路由。

复用已有StreamGateway/Registry和本地readonly descriptor。固定FD租约、单Range/HEAD、可观测变化失效、有限资源和取消清理为本任务主责。统一物理协调器由实际Core utility进程创建，Gateway与该Core内dataset-owner Worker共享，锁身份覆盖dev/ino别名；旧严格Hash读链不降级。Organizer实际源写与录音确认由原任务承担，本任务提供统一保护接缝，不默认开启library_write_enabled。

先在外置自建合成文件验证HTTP字节、Range边界、物理互斥、真实Worker启动和quiet后释放、旧远程安全和配置回归，并做受影响包的类型/构建检查；网络/生命周期改动在最终源提交执行适用CI。报告只有描述或状态变更时可引用精确源提交的成功结果，须明示“引用而非重跑”，并执行当前报告/控制面/边界检查。未验证的轻量判定不启用。

12条原AT不删减、不改kind。AT006保持live_roon；合成HTTP不代替实际Core请求和听感。AT005的LAN只验证准入拒绝/配置合同；本轮不开放真实LAN接口。真实NAS离线、真实大曲库、实际Roon/账号、最终Owner验收单列未完成。003历史25条超时不回填为通过，不重跑100k/300k、不触碰旧库或封存预算。
