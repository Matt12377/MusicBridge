# TASK-029 结果报告：V1 完成控制面、CI 与契约冻结

## 最终结论

**PASS**。

TASK-029 已建立 WAVE-3 机器控制面、任务文档、ADR、CI workflow、边界/循环/安全扫描和固定 Provider wrapper contract tests。没有修改产品运行行为、Provider 依赖版本、端口、Roon extension_id、Stream Gateway 或 loopback-only 边界。

## Git 身份

- 基线分支：`codex/wave-2-desktop-core`
- 基线 SHA：`8c5a471dfd3662609822d2ff79739365f8bc7405`
- 工作分支：`codex/task-029-control-plane-ci`
- 实现提交：`aed0ee8e3c60eca6cc39bfd48b12fa9499b81d36`
- 实现提交信息：`chore: establish V1 completion control plane and CI`
- 报告提交信息：`docs: record TASK-029 verification`
- 报告提交 SHA：本文件所在的报告提交；已在提交后用本地与远端 HEAD 复核。
- 实现提交已先推送；报告提交完成后将再次推送并核对。
- 未创建 PR、未合并、未 force-push、未发布。

## 修改文件

- `AGENTS.md`
- `project/STATUS.json`
- `project/WAVE-3.yaml`
- `project/RISK_REGISTER.md`
- `docs/11_V1_PRODUCT_REQUIREMENTS.md`
- `docs/adr/ADR-004-WAVE3-UI-ARCHITECTURE.md`
- `docs/adr/ADR-005-ELECTRON-PROTOCOL-AND-FUSES.md`
- `docs/adr/ADR-006-MACOS-DISTRIBUTION.md`
- `tasks/00_TASK_INDEX.md`
- `tasks/TASK-024_LYRICS.md`
- `tasks/TASK-029_CONTROL_PLANE_CI.md`
- `.github/workflows/verify.yml`
- `.github/workflows/security.yml`
- `.github/workflows/electron-e2e.yml`
- `scripts/ci/verify-control-plane.mjs`
- `scripts/ci/verify-boundaries.mjs`
- `scripts/ci/verify-cycles.mjs`
- `packages/bridge-core/test/provider-wrapper-contract.test.ts`

## 控制面与产品范围

- Lyrics 已从 V1.1 Could 提升为 V1 Must/Should 的同步 Now Playing 能力。
- TASK-024 与 TASK-029 已加入任务索引；WAVE-3 顺序、停止边界和 beta-candidate review boundary 写入 `project/WAVE-3.yaml`。
- `project/STATUS.json` 使用 schemaVersion 1，当前 task 为 TASK-029，状态为 complete，不含用户内容、凭据或私密环境变量。
- ADR-004 固定 V1 路由 Shell 与 Renderer/Preload 边界；ADR-005 固定 `musicbridge://app/`、CSP、Electron security 与 Fuses 方向；ADR-006 固定 arm64 Beta、签名条件和未签名内部候选包策略。

## Fixed Provider wrapper contract

测试直接加载已安装的 `@neteasecloudmusicapienhanced/api` module wrapper，并向 wrapper 注入 Fake `request()`；没有只测试 Music Bridge 自己的理想化 adapter fixture。覆盖：

- login status 的真实嵌套包装；
- QR key/create/check；
- search；
- account、liked list；
- user playlist、playlist detail、playlist track all；
- song detail、song URL v1；
- lyric_new。

测试只使用合成字段和合成响应，不读取真实账号、Cookie、Provider 原始响应或 Roon。

## CI 覆盖

- Node.js 22.x 与固定 Corepack `pnpm@10.17.1`。
- `install --frozen-lockfile --ignore-scripts`、workspace typecheck/test/build/verify。
- contracts boundary、Renderer Node/Electron access、Electron security/CSP、loopback 默认值与 guard。
- import cycle scan、秘密/授权/Bearer/token 值扫描、完整查询 URL 扫描、音频下载/转码/解灰导入扫描。
- synthetic Electron startup、safeStorage gate、utilityProcess crash/restart。
- production dependency audit。
- CI workflow 不包含真实 Provider 凭据、真实 Roon、SSH 目标或账号数据。

## 验证结果与退出码

| 命令/检查 | 结果 |
|---|---:|
| `node scripts/ci/verify-control-plane.mjs` | 0 / PASS |
| `node scripts/ci/verify-boundaries.mjs` | 0 / PASS |
| `node scripts/ci/verify-cycles.mjs` | 0 / PASS；38 个源文件 |
| wrapper contract test | 0 / 8 tests PASS |
| `corepack pnpm@10.17.1 verify` | 0 |
| Contracts | 12/12 PASS |
| Bridge Core | 135/135 PASS |
| Desktop | 26/26 PASS |
| Desktop development/production startup | 0 / PASS |
| synthetic Core crash/restart Gate | 0 / PASS |
| `git diff --check` | 0 |
| `package.json` / `pnpm-lock.yaml` | 无差异 |
| YAML 解析（3 workflow + WAVE-3 plan） | PASS |
| production audit（官方 registry 临时覆盖） | 0；No known vulnerabilities |

第一次 audit 使用的本机镜像没有 audit endpoint，退出码 1；未修改配置或依赖。用一次性 `npm_config_registry` 指向官方 registry 重试退出码 0，报告不保存 registry 凭据或响应内容。

## 安全与范围

- CI 全部使用合成数据，不访问真实 Provider、真实账号、真实 Roon 或 Core Mac。
- 未执行播放、扫码、登录、Provider API 真实调用或 Roon 配对。
- 未新增或升级依赖；未修改 `package.json`、`pnpm-lock.yaml`、产品源码、Roon extension_id、端口、loopback-only 规则或 Stream Gateway 行为。
- 未创建 `.env`，未写入 Cookie、Token、密码、完整 Provider URL、账号资料或内部设备地址。
- workspace build 生成的 `dist` 仍由既有 `.gitignore` 忽略，不进入提交。

## 分支交接

- 实现 HEAD 已推送到 `origin/codex/task-029-control-plane-ci`。
- 本报告提交完成并推送后，下一分支从本任务最终 HEAD 创建：`codex/task-024-lyrics-v1`。
- TASK-029：**PASS**。
- TASK-024：尚未开始；TASK-030 及其他后续任务未开始。
