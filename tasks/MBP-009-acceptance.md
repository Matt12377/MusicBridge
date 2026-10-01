# MBP-009：全量验收与依赖安全收口

正式基线 `6ac36f63ca044d74c838768a2f68490541d22647`；从MBP-008最终报告HEAD建立独立开发分支codex/mbp-009-acceptance；仅在008报告与开发分支push/远端身份核对之后开始。Owner已授权连续实施，最多三名gpt-6.1-sol xhigh子代理，禁用gpt-6-sol。保留Electron/Vue/Node TS及既有收藏UI。

## 实现范围

Root独占pnpm-workspace.yaml、pnpm-lock.yaml、apps/desktop/e2e/v1-ui.spec.ts、apps/desktop/tsconfig.e2e.json、任务/报告/进度/Git与共享全量Gate。将API4.40.1和utils0.4.4两条精确父依赖边的Axios固定到1.20.0；新鲜779远端审计另有basic-ftp5.3.1高危（GHSA-c475-qrg2-pj4r），仅将get-uri@6.0.5>basic-ftp固定6.2.1并验证CJS/组件/原get-uri流合同，保留原electron-vite补丁与所有其他直接依赖；禁止auditignore、修改high门槛、auditfix或无关批量升级。锁文件完整解析和实际安装依赖边/integrity分别核验。

完整v1加入原strict E2E include；原17include保留，env注解/defined-string launch、AxeResults类型与recipe schemaVersion1门禁按冻结最小补丁实施。严格校验全部原expect调用、test注册签名、跳过/环境字段/删除、两条100次进度循环、空B与真实音频帧断言未减弱。该补丁包含运行时env/schema门禁，不称pure type-only，须原完整108 Electron验证。

外置HTTP工具先独立只读准备审查，再绑定正式009 branch/HEAD/source/lock运行真实Axios HTTP adapter和生产API weapi/xeapi到合成loopback HTTP；无真实账号/Provider/Roon/Cookie/密码/外网请求。utils unblock保持禁用，其第三方固定目标仅合成loopback重写用于依赖HTTP覆盖，不能声称启用生产解灰。记录请求/adapter/socket/agent/server生命周期、timeout/abort/error/gzip/redirect/crypto、实际退出与失败，不自动重试。任何边界缺陷先修工具，再冻结并执行。

## 门禁与证据

构建、缓存、TMPDIR、日志、测试产物全部在已核验挂载可写的LifeWeave外置卷，Node22.23.2和pnpm10.17.1。Root串行共享安装/预构建/类型/完整verify/安全/mockElectron4/原108E2E；control-plane/boundaries/cycles/diff及产物完整解析、源码前后指纹。原Core2skip与E2E4条件skip原样，范围/timeout/expect不缩减。pnpm audit --prod --audit-level high保持，原审计新鲜19=11moderate+8high；moderate若仍存在准确另列，high必须0；原始审计JSON与实际exit保存，确认远端相同SHA作业。

完整实现提交、独立结果报告提交与非force开发分支push；复核tracked clean、保留原未跟踪test-results/worktree、远端HEAD与报告身份。最终11/11仅表示已授权软件实施/本地门禁，不冒充真实Roon音频/设备/系统钥匙串/GateB/Owner验收。没有main合并、正式App替换或发布权限。

## Carryover与回滚

继承008录音同owner同步热点的受控Stop/PCM延迟与未真实设备验证、历史未知/中断产物边界；不在009扩大第二次资源架构。source/type/兼容/CI出现新缺陷按明确根因修复并重新绑定完整Gate，不用旧绿色数覆盖新源码。回滚仅Owner明确授权后通过独立revert提交，保留数据库/用户数据；本任务不自动回滚或删除任何用户内容。
