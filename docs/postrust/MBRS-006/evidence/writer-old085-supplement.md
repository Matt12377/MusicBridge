# MBRS-006 旧 TASK-085 E2E 严格定位补修

007 尚未开始。检查 HEAD `522ef22f66957f89e7155bf744be445ccb40cf72`，仅修改 `apps/desktop/e2e/task-085-collection.spec.ts` 的一个原断言；用例数量、其余期待、阈值与产品均不变。不涉及旧录音计时根因。

确认的旧失败证据：a940c34081ca36b0fdda669ffb675baf59e2567d 自然 Electron run37428265660/job112152823515，103 passed / 4 skipped / 1 failed。原日志及 receipt 保留在 `ci/ELECTRON_THIRD_SOURCE_FAILURE.log` 与对应 `_LOG_RECEIPT.json`；日志 SHA256 `36193bb9c2e81c4821fbcd2a67c6d3dd02b0b66180ae66253050ff933b14a983`。Playwright 原 getByText 同时匹配 status成功notice 与无status的静态hint，触发strict mode violation。

数据流：`reference-catalog-controller.ts` registerZip 的 write 成功回调才设置“原 JSON 已登记，ZIP 的 SHA、大小和入口名已留不可变回执；原 ZIP 不长期归档。…”；`ReferenceCatalogPanel.vue` 将 state.notice 输出为 role=status，静态说明为 p.hint。本次仅把定位限定为 getByRole('status').filter(hasText=上述成功回执前缀)，仍要求可见，避免静态说明替代成功登记回执，不使用 first/nth 放宽唯一性。后续 ZIP 容器回执标题、ZIP SHA、目录/库存/冷启原断言保留。

现有原单case入口已尝试（未安装/构建/复制运行树）：`checks/writer-old085-e2e-preparation-01`，Node22.23.2，`node node_modules/@playwright/test/cli.js test e2e/task-085-collection.spec.ts --grep 'TASK-085 J03/J04/C11' --workers=1`。退出1，尚未执行case。Playwright config 的 verifiedElectronExecution 首先拒绝缺少本轮官方Electron身份收据；只读核查本树electron@43.4.0 package还缺path.txt与dist/Electron.app/Contents/MacOS/Electron。已有Desktop main/core/preload/renderer bundle不能替代native身份。此为 PREPARATION_NOT_REACHED_TEST，绝非本机行为RED/GREEN；修正后实际GREEN待自然CI。未为验证安装或扩大权限。

FREEZE05 原57文件逐项字节hash相同；FREEZE06总58，新增此旧E2E测试SHA256 `85230f0b631bcd3cdbc054117187b42589bb7640fc96df45156f90f95242e2ae`。git diff --check退出0。Root-owned package/CI/workflow/task/docs/project均未修改。无新代理、commit/push、真实账号/Roon/音频操作，全部命令已终态，无inflight，停止写入交Root。
