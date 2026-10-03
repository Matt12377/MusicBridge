# RUST-011 私有资源合同 v1

本任务只冻结 macOS arm64 离线候选包的资源层，默认 Main/Core 路由不调用 Rust bootstrap。机器证据不得写为完整包内 Rust UI、生产迁移或 Owner 接受。

固定位置：`Contents/Resources/rust-core/darwin-arm64/manifest.json` 与 `bin/musicbridge-rust-core`；资源根内只有 manifest 和 bin、bin内只有该可执行。无符号链接、路径穿越、写入者可变路径、组/其他用户可写或其他架构回退。

清单精确闭集：`schemaVersion:1`，`kind:"musicbridge-rust-readonly-resource"`，`platform:"darwin"`，`arch:"arm64"`，`protocolVersion:2`，`source:{commit:<40hex>,sha256:<64hex>}`，`binary:{relativePath:"bin/musicbridge-rust-core",sha256:<64hex>,size:<positive safe integer>,cdHash:<40hex>}`。源摘要按实际 Rust 构建输入相对路径排序，串联 `path + NUL + sha256 + LF` 后 SHA256。Rust 先 ad-hoc 签名，再生成/锁定清单；外层最终签名不能改变该 pin。构建时独立持有 expectedManifestSha256，运行时不能信任新邻接清单。

作者 A `apps/desktop/scripts/rust-native-package.mjs` / `.d.mts` 的公开私有 API：常量 RUST_RESOURCE_RELATIVE_ROOT、RUST_BINARY_RELATIVE_PATH；`createRustResourceManifest({binaryPath,sourceCommit,sourceSha256})` 返回上述严格清单（不隐式签名）；`validateRustNativeDirectory({directory,expectedManifestSha256,platform?,arch?})` 检查目录闭集/普通文件/权限/实际薄 Mach-O arm64/最终 SHA/实际 codesign verify 及 ad-hoc CDHash，返回 `{manifest,manifestSha256,binaryPath,binarySha256,cdHash}`；`stageRustNativeResource({sourceDirectory,resourcesDirectory,expectedManifestSha256})` 仅新建不存在的固定资源根、复制后复验；源码和原生产 native beforePack 不变。错误为中文稳定类别，不输出凭据或私密栈。

作者 B 新 `src/main/rust-core-resource.ts`：`resolveRustCoreResource({resourcesDirectory,expectedManifestSha256})` 仅可信调用，资源根 absolute/realpath/无链接，使用 A 的准入并返回 `{binary:{path,sha256},manifestSha256,manifest}`。拒绝额外配置字段/非 darwin-arm64；无 env/Renderer/公共 IPC 开关；不更改默认 Main/Core/Owner。行为测试覆盖可信 pin 漂移及实际路径准入。

作者 C 新协议 helper 暴露 `runRustOfflineCandidateProtocol({resourcesDirectory,expectedManifestSha256,evidenceDirectory})`：全新外置合成 Node 两库 → 原子 export → B 从实际最终 Resources 取得 binary → 既有 Rust sidecar/完整 DTO 对照/写拒绝/ACK/自然关闭；保留实际报告、Node/Rust自然退出分别观察，不修改原合同/预算/生产数据库。协议不是候选 Main→Core→Rust 证据。evidence helper 暴露 `acceptRustOfflineCandidateEvidence(report, expectedIdentity)`，expectedIdentity 由独立实际文件观察生成。严格接受实际包资源/最终签名/ASAR/Fuses/默认Node自然运行/协议证明；缺漏、伪造、漂移不得 skip。作者 C 与主代理在其 helper 起草时同步 report schema，主代理按最终实际字段生成。

候选配置独立外置，appId/productName 与生产分离。ASAR 只包含原 production dist 及原 production dependencies，不含新测试入口；保留原全部 fuses，直接运行候选 MacOS 可执行，不传外置 JS、不用 Playwright inspect。原 STARTUP_TEST/CORE_TEST_MODE/UI_E2E/OFFLINE、显式 mock-keychain及全新外置 startup profile；原 app.quit 自然关闭，Electron/Core真实 exit0。Owner worker逐个退出没有观察时不升级声明。

x64/universal、Developer ID、公证、安装替换、正式启用、真实用户库/服务/播放/录音/push/发布/合并均另列。所有失败日志保留；无输入不构建/下载/安装替代工具、不降旧门禁。

最终机器报告新增 verification 闭集，expectedIdentity 同时持有独立实读 verification：platform/arch固定darwin/arm64；nativeSignature和bundleSignature均含 verified/adHoc/CDHash；asarIntegrity含SHA256与实际header hash。defaultNode只含原默认App证据，日志再次核readiness和原生命周期；协议证据单独实际文件核。

协议校准：现有默认快照进程实际wire为v2；manifest的protocolVersion固定2，资源schema仍1，Node公开IPC仍1。large-wire3的候选启用/适配另列，Rust现有协议实现不变。A/B最初收据的旧资源标记仅为历史，最终Gate复核修正后源码与原48/22行为。
