# V3 软件收尾结果

状态：`AUTOMATED_CLOSEOUT_PASS_OWNER_ACCEPTANCE_PENDING`

## 候选身份

- 分支：`codex/task-084-capacity-path-remap`
- 收尾起点：`67df2986d35aa98aa067b49c7efa1d92dc262c5d`
- 收尾路由提交：`c84887645ace7775f71128a8773f4d772700fa3d`
- 最终候选：`2623511aee684b59f00fb91dedcb4e060da53694`
- 打包护栏修复：`53c1ae8f751e11e8540ee2ee569e0700f1326fa7`
- Remote Core 验收返工：`2623511aee684b59f00fb91dedcb4e060da53694`
- 结果报告提交：本文件提交后记录

## 最终自动验证

以下是本次收尾的分层新鲜证据。完整仓库验证只执行一次；最终候选随后仅增加本地打包身份配置及其回归测试，使用聚焦验证、生产构建和实际打包闭合，不重复消耗全量容量/SQLite套件。

- `c848876…` 标准 `corepack pnpm@10.17.1 verify`：exit 0；Contracts 186/186、Bridge Core 全套、Desktop 645/645、生产构建均通过。Bridge Core 保留 1 条明确需要真实固定 native 的条件 skip，不升级为实机证据。
- `c848876…` Control Plane：`PASS`，exit 0。
- `c848876…` Boundaries：`PASS`，exit 0。
- `c848876…` Cycles：`PASS files=259`，exit 0。
- `c848876…` production startup Gate（mock keychain）：`DESKTOP_STARTUP_MOCK_PASS=production`，exit 0；真实系统钥匙串仍未据此通过。
- `53c1ae8…` 打包配置回归：3/3 pass，exit 0；明确 `mac.identity=null` 与 Fuses ad-hoc 重签，不开启发布签名。
- `53c1ae8…` 固定 native 身份：复用 TASK-078 已核验本机构建；FFmpeg manifest SHA-256=`d552121ea60fdc4d86e7e697503e6208152679f1fad58d1ed48a59a79af597cc`，Output manifest SHA-256=`d9641cd76bb6c93633b3e026ea329d9a4121d123d9a1f1646f86a8bb27fad22a`，复制前 `NATIVE_SOURCE_PACKAGE=PASS`。
- `53c1ae8…` production build：exit 0，编译产物重新捕获两份固定 native manifest。
- `53c1ae8…` macOS arm64 本地打包：exit 0。
- `53c1ae8…` 候选包启动/退出 smoke（mock keychain）：READY=true、markerSeen=true、closed=true、code=0、signal=null。
- DMG：`hdiutil verify` 为 `VALID`；App：`codesign --verify --deep --strict` 通过，签名身份为 ad-hoc。
- Draft PR #26 在首次收尾时指向 `53c1ae8…`；验收返工 `2623511…` 已继续推送到同一分支，新的远端检查独立观察，不提前写成全绿。
- `2623511…` 验收返工：RED 证明生产构建隐藏“高级”且 Main 拒绝 Remote Core；GREEN 后 Desktop typecheck、设置/Renderer/Preload/Remote Core 聚焦 54/54、Desktop security 29/29、Boundaries、production build 与 production startup Gate 均 exit 0。
- `2623511…` 重打包：macOS arm64 打包 exit 0；包内启动/退出 smoke 为 READY=true、markerSeen=true、closed=true、code=0、signal=null；DMG 与 App 再次通过镜像及代码签名校验。

## 产物

- App：`apps/desktop/release/mac-arm64/Music Bridge for Roon.app`
- DMG：`apps/desktop/release/MusicBridge-0.1.0-beta.2-arm64.dmg`（151,326,201 bytes）
- DMG SHA-256：`3b58041b6d3da75197f03676e3f46ef846387f525d790ab2e30e7c98d2890a74`
- Blockmap SHA-256：`b90f3f8c105a322c8c73564e455d6493ba3ab46397ddd668baff4b00c233f55e`
- 签名/公证：仅本地 ad-hoc；Developer ID 签名与公证均 `NOT_RUN`（独立发布 Gate）。

## 人工验收交接

候选 `.app` 已通过本机启动和包内启动/退出 smoke。自动读取 Electron 窗口辅助功能树此前连续三次超时，按调试阈值停止；因此没有把首屏、“高级”可见性、Mac mini 实连或视觉质量写成通过。Owner 按 `project/V3_OWNER_ACCEPTANCE_CHECKLIST.md` 实际执行 A-01～A-15 后记录接受、拒绝或延期。

## 外部门

正式 capacity、真实设备/Gate B、真实 Roon/Logic/输入、可听 Replica、实体纸张和 Owner 产品接受均保持 `NOT_RUN` 或 `PENDING`。软件 Gate 不能替代这些结果。
