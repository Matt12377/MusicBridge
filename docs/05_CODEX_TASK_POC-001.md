# Codex 任务：POC-001 网易云音频进入 Roon

## 任务目标

在现有 starter code 上完成并实机验证：

```text
合法网易云账号 Cookie + 歌曲 ID
→ 实际可播放 URL
→ 本机无转码 Stream Gateway
→ Roon Audio Input
→ 用户选定的 Roon Zone
```

最终不是“代码看起来合理”，而是必须在 Roon 中真实出声并留下可复核证据。

## 开始前

按顺序阅读：

1. `docs/00_PRODUCT_SCOPE.md`
2. `docs/01_ARCHITECTURE.md`
3. `docs/02_DECISIONS.md`
4. `docs/03_POC-001_ACCEPTANCE.md`
5. `docs/04_SECURITY_AND_COPYRIGHT.md`
6. `docs/06_RUNBOOK_MACOS.md`
7. `docs/07_RISK_REGISTER.md`

先运行：

```bash
npm install
npm run doctor
npm run verify
```

记录 starter code 的当前通过/失败基线，再修改。

## 硬约束

- 只做 POC-001，不做扫码、歌单、UI、Apple Music。
- 运行位置是 Roon Server/Core 同一台 Mac。
- 不启用或调用任何解灰、替代音源、会员/地区绕过功能。
- 不使用 FFmpeg，不转码，不落盘保存音频。
- 不记录 Cookie、完整上游 URL、签名参数或临时流令牌。
- 不把控制 API 或流网关暴露到局域网。
- 不升级依赖，除非当前固定版本无法安装；若必须升级，先记录原因、差异和风险。
- 不 push、不创建 PR，除非 Owner 另行明确授权。

## 实施顺序

### 1. 固化安全启动

验证配置层在任何下列变量为 true 时拒绝启动：

- `ENABLE_GENERAL_UNBLOCK`
- `ENABLE_PROXY`
- `ENABLE_RANDOM_CN_IP`

添加自动测试。不得仅靠 README 约定。

### 2. 完成网易云适配器

- `song_detail`：解析 ID、歌名、歌手、专辑、封面、时长。
- `song_url_v1`：传入 ID、请求音质、用户 Cookie。
- 拒绝空 URL、非 200、试听片段、非 HTTPS。
- 保存并展示实际 `level/type/br/size/expi`。
- URL 临近过期时刷新，不提前下载。

### 3. 完成 Stream Gateway

- 高熵临时 token。
- GET/HEAD。
- 转发 Range、If-Range、Accept-Encoding identity。
- 保留 200/206 和关键媒体头。
- 流式 pipe；禁止 `arrayBuffer()`/完整 Buffer。
- 验证每次重定向，拒绝私网和 localhost 上游。
- stop/error/shutdown 撤销 token。

### 4. 完成 Roon Adapter

以 RoonLabs 官方 `roon-connect-stream-example` 为基线：

- Extension discovery / pairing。
- Extension Settings 中选择 Zone。
- Audio Input `begin_session`、`play`、`end_session`。
- 显示歌曲名、歌手、专辑。
- 对 `Playing`、`MediaError`、`EndedNaturally`、`ZoneLost`、超时做确定状态转换。
- 重复 play 前结束旧 Session。

### 5. 完成控制与诊断

- `GET /health`
- `GET /v1/state`
- `POST /v1/play`
- `POST /v1/stop`
- `npm run doctor/play/state/stop`
- 错误码需区分：未配置 Cookie、Roon 未配对、未选 Zone、歌曲不可用、上游失败、媒体错误。

### 6. 自动验证

至少覆盖：

- 安全变量拒绝启动
- 网易云响应解析与降级识别
- 试听片段拒绝
- token 生命周期
- Range/206/关键响应头
- Controller 成功与失败清理
- Roon Adapter 用 Fake 验证 Session 顺序

### 7. 实机验证

按 `docs/03_POC-001_ACCEPTANCE.md` 完整执行。真实 Cookie 只能存在本机 `.env`，不要进入任何报告。

## 交付物

必须产出：

- 可运行代码
- `package-lock.json`
- 全部自动测试
- `reports/POC-001_RESULT.md`
- 必要的脱敏截图/日志路径说明
- 未通过项与精确复现步骤

最终汇报使用表格：Gate、结果、证据、残余风险。不得把“请求成功”当作“Roon 实际无损播放成功”。
