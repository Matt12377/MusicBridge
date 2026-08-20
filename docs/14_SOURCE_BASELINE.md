# 外部来源基线

**核对日期：2026-08-20。** 本文件用于说明架构决策的公开技术基线，不代表第三方服务对本项目的授权或背书。

| 主题 | 来源 | 本项目使用结论 |
|---|---|---|
| Electron 进程模型 | https://www.electronjs.org/docs/latest/tutorial/process-model | Main、Renderer、Preload；Bridge Core 使用 utilityProcess |
| Electron utilityProcess | https://www.electronjs.org/docs/latest/api/utility-process | Node 子进程与 MessagePort 通信 |
| Electron 安全 | https://www.electronjs.org/docs/latest/tutorial/security | sandbox、contextIsolation、限制远程内容与 IPC |
| Electron safeStorage | https://www.electronjs.org/docs/latest/api/safe-storage | macOS Keychain；优先异步 API |
| Electron 版本 | https://releases.electronjs.org/ | 2026-08-20 使用受支持稳定线，不使用 beta/nightly |
| Vue + TypeScript | https://vuejs.org/guide/typescript/overview | Vue 3、Vite、vue-tsc、VS Code Vue - Official |
| Node.js 支持线 | https://nodejs.org/en/about/previous-releases | POC 22 LTS；正式基线评估 24 LTS |
| Roon Stream Example | https://github.com/RoonLabs/roon-connect-stream-example | Extension + Zone Settings + HTTP media URL |
| Roon Audio Input | https://github.com/RoonLabs/node-roon-api-audioinput | begin_session、play、end_session 等 |
| 网易云适配器 | https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced | 非官方适配器；固定版本；禁用解灰 |

实际固定 commit 继续以 `docs/08_UPSTREAM_BASELINE.md` 为准。任何升级必须更新本文件、风险登记和兼容测试结果。
