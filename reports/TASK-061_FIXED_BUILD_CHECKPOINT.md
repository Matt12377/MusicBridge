# TASK-061：固定 FFmpeg/SWR 本地构建与打包检查点

> 历史检查点：以下提交状态描述当时取证时点；最终本地收口身份见 `TASK-061_RESULT.md` 和 `project/STATUS.json`。

2026-08-28。Owner 本轮明确授权制作并核验可打包的固定构建；仍不发布、不推送。此检查点已取得本地构建、桌面与打包应用实际转换证据，不代表完整 V3、TASK-061 三提交或正式录音验收完成。

## 身份与边界

- 工作树：`worktree/task-061-execution-conversion`。
- 分支：`codex/task-061-execution-conversion`。
- Base / HEAD：`87e52bf08b2cd0666333bc5112983fddca3a6237`；本轮没有创建提交。
- 远端对应分支：本次 `ls-remote` 退出 0、无匹配；没有 push、main 合并或下一任务分支。
- 0 子代理；全部源文件、账号、库存、Render 和任务数据均为隔离合成数据。未使用真实 Provider、Roon、硬件或音频输出。
- 证据目录：`reports/runtime/task-061-product-build-ukhdz8q6`。失败尝试和产物保留；本轮未清理用户文件。

## 固定构建

使用 [FFmpeg 官方下载与签名材料](https://ffmpeg.org/download.html) 中的 8.1.2 源码，不打包 Homebrew 二进制。官方发布签名指纹核验成功：`FCF986EA15E6E293A5644F10B4322F04D67658D8`；验证使用独立临时 keyring。

| 身份 | 值 |
|---|---|
| 源码压缩包 SHA-256 | `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c` |
| 清单 SHA-256 | `d552121ea60fdc4d86e7e697503e6208152679f1fad58d1ed48a59a79af597cc` |
| FFmpeg / SWR | 8.1.2 / 6.3.102 |
| 目标 | macOS arm64；编译部署目标 13.0，未做 macOS 13 实机验证 |
| 原生文件 | ffmpeg、ffprobe、5 个 FFmpeg dylib；无符号链接 |
| 本地签名 | ad-hoc；无 Developer ID、无公证、无公开分发 |

构建关闭 GPL、nonfree、version3、network 和第三方自动发现；只启用当前音频容器/编解码子集及 FD 输入输出。实际协议列表只有 FD；依赖闭包仅包含 5 个打包 dylib 和明确的 Apple 系统库，没有 Homebrew 动态依赖。构建配置中个别辅助 filter 被 FFmpeg 自动选中，不声称只存在显式列出的 6 个 filter。

共享库经相对 `@rpath` 加载；构建脚本使用固定安装前缀和 DESTDIR，产物清单不包含开发者目录。包内附带完整对应源码、LGPL 许可证、构建选项和署名，设置页面有组件说明。此处记录材料与技术检查，**未完成分发法律审查**；[FFmpeg 官方许可要求](https://ffmpeg.org/legal.html) 仍是发布前独立检查项。

## 应用接入

1. Vite 把原生清单 Hash 同时编入 Core 常量和打包身份快照，后续文件漂移不能由读取新清单自动接受。
2. 普通 Core 从固定开发或 ASAR Resources 目录加载；不使用 cwd/PATH 搜索，不接受 Renderer 或环境变量指定可执行路径。清单、平台、组件版本和 7 个文件 Hash 全部核对后才能注入转换器。
3. 缺包或校验失败时只禁用转换，不使既有 V2 播放启动失败。常规合成测试保持无后端；显式原生 Gate 才在合成运行时使用固定包。
4. 打包前验证编译身份、完整文件集合及许可/源码材料。当前钩子只准入 macOS arm64 本地 ad-hoc 包；Developer ID 会改变原生文件 Hash，发布需另建先签名后锁定流程。
5. 打包后再次核对原生 Hash、ASAR 内 Main/Core 与已验证 dist 身份、整个应用签名及实际启动。安全 Fuses、ASAR 和 Renderer 隔离保持原值。
6. 旧音频边界扫描仅对 Core 中 `./ffmpeg-build-policy.js` 的一条精确导入放行；其他位置、外部库、动态导入与 Renderer 导入均有拒绝测试。

## 新鲜验证

Node 22.23.2 / pnpm 10.17.1。最终代码验证后仅整理任务文档、状态和报告。

| 检查 | 结果 | 证据 |
|---|---|---|
| 最终完整 verify | 退出 0；Contracts 66、Core 654、Desktop 175 | `final-verify.log` |
| 安全 Gate | 退出 0；22/22 | `security.log` |
| Electron startup/crash/safeStorage | 退出 0；4/4 | `electron.log` |
| 完整桌面 E2E，含原生转换 | 退出 0；49/49 | `full-ui.log` |
| 控制面、边界、循环依赖 | 各退出 0；cycles 148 文件 | `final-static-exits.json`；control 仍只覆盖 WAVE-3 |
| 固定源码构建及签名 | 退出 0 | `product-build.log`、`source-signature.log` |
| 原生适配器实际合成转换 | 12 份输出独立核验通过；截断 FLAC 拒绝且输出为空 | `native-validation-2/` |
| 使用包内后端的持久化/恢复/PREP | 4 次转换、5 份文件独立核验通过 | `native-persistence/` |
| 本地应用打包 | 退出 0；整包 codesign verify 退出 0 | `package-3.log`、`packaged-codesign.log` |
| 包后原生及 Main/Core 身份 | 7 个原生文件 Hash 不变；3 个 Main 产物与 dist 一致 | `packaged-native-hashes.json`、`packaged-main-identity.json` |
| 打包应用启动 | 退出 0；DESKTOP_STARTUP_READY | `packaged-startup-result.json` |
| 打包应用 Core 实际转换 | 驱动退出 0；432,004 帧，重新验证通过，原源不变 | `packaged-conversion-result.json`、`packaged-converter-gate-2.log` |
| 打包输出独立 Python 回读 | 退出 0；整文件/PCM Hash、实际帧数、3 段数字零和2段转换 PCM | `packaged-independent.json` |

### 音频事实与限制

- 整数参考输出 10 份与之前的参考文件逐字节一致。
- 浮点参考对比有 20 个近零差异，最大绝对差 `3.469446951953614e-18`；容器头一致，同一固定构建重复结果逐字节一致。尚未定位具体编译器指令原因；不把该样本最大差当通用误差上界。
- 原生持久任务的 Direct 为 720,006 帧，PREP Derivative 为 720,003 帧；提交恢复不重复转换，原件保持不变。
- 打包应用通过真实 Main/utility Core/固定后端生成 48 kHz、24-bit、stereo 输出，432,004 帧；仅驱动和数据为合成。使用 Renderer CDP，不启用 Node 调试 Fuse。
- 测试夹具仍用于故障编排，不作为真实解码证据。所有结果均不是听感、设备、正式录音或 Owner 接受证据。

## 失败记录及修正

- 官方 keyring 首次导入异常后，在独立 keyring 中验证成功；不据此改动用户 keyring。
- 第一轮浮点跨构建逐字节断言失败；保留差异并补同构建重复和独立样本检查，没有修改音频代码迁就参考文件。
- 桌面驱动先修正 select 的可访问名称和折叠字段定位；随后获得缺少后端的实际行为 RED，接入后通过。
- 打包钩子原先误读 `context.appDir`，补失败测试后改用安装版本定义的 `context.packager.info.appDir`。
- 无签名候选因旧签名失效被系统终止。启用工具提供的 ad-hoc 重签后，签名与启动通过，原生 Hash 未变。
- 保留合成状态时曾误用非临时目录，触发既有测试目录护栏；恢复合法临时目录，不放松生产护栏。一个启动驱动未继承 TMPDIR 也导致目录校验不匹配；修正环境后通过。
- 打包转换驱动首版过早以 `running` 作完成断言；失败日志保留。显式轮询观察到 `running → running → completed` 后，再核对文件与公开回执。
- 独立回读初版误以为实际段回执包含 `kind`，修正为配方和实际段逐一配对，未改生产回执。

## 本地重建入口

从上述官方来源取得并核验源码签名和 Hash，再使用全新输出/工作目录。生成物不提交 Git，已存在目录不能覆盖。

```sh
export PATH=/Users/yihe/.nvm/versions/node/v22.23.2/bin:$PATH
mkdir -p apps/desktop/native/ffmpeg
node --import tsx scripts/native/build-ffmpeg.mjs /absolute/verified/ffmpeg-8.1.2.tar.xz apps/desktop/native/ffmpeg/darwin-arm64 /absolute/new-build-directory
corepack pnpm@10.17.1 --filter @music-bridge/desktop run build
```

在 `apps/desktop` 下执行本地包命令，并指定新的输出目录：

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false corepack pnpm@10.17.1 exec electron-builder --dir --mac --arm64 --config.mac.identity=null --config.electronFuses.resetAdHocDarwinSignature=true --config.directories.output=/absolute/new-package-directory
MUSIC_BRIDGE_NATIVE_GATE=1 corepack pnpm@10.17.1 exec playwright test --grep '固定原生构建' --output /absolute/new-gate-directory
```

标准 E2E 在没有显式原生 Gate 时保留该用例为 skipped；原生 Gate 开启却缺失原生包时必须失败，不能悄悄改用系统 FFmpeg。显式原生 Gate 的合成临时目录保留，供打包应用后续核验；不用于用户音乐。

## 自查与未关闭项

SPEC：本轮授权的固定本地构建、加载、打包及实际合成转换验证已满足。QUALITY：限定输入/目录、编译时身份与失败关闭、依赖闭包、无新增可执行 IPC；属主代理自查，不是独立审查。

完整 TASK-061 尚未作实现/报告/状态三提交，没有下一分支基线。发布法律审查、Developer ID/公证、其他架构与 macOS 13 实机、DSD/特殊格式、正式预检与输出认证仍分别待处理。F-01 保留政策未决，禁止自动清理、不承诺永久归档，不创建正式 RecordingPlan/Attempt。完整 V3 的归档、Replica、J-Card、备份、目录导入及 Owner 验收范围不变。
