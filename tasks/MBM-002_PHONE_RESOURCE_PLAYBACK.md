# MBM-002 手机资源播放

基线是 001 最终报告 `8044d935e242d8647adc21445116fb49c9100e4a`。Mac 使用独立分支 `codex/mbm-002-phone-resource-playback`；双端配对交付事实在 `docs/postrust/MBM-002/PREDECESSOR_DELIVERY.json`，当前范围和测试闭集分别在 `EXECUTION_SCOPE.json`、`TEST_SCOPE.json`。

本任务只接入 createSession、getSession、closeSession、reportObservation、createResource、getResource、releaseResource、renewResource、getMediaAsset 和 headMediaAsset。沿用 001 的十个操作，后续 UI 内容操作仍拒绝。完整 canonical 合同维持 145918 字节、40 个操作及原 SHA-256；原 18/156、有效 17/150 和 001 的 9 个独立 AT、报告、冻结证据保持。

Main 管理逻辑会话、资源、原幂等回执和票据。加密状态通过现有唯一 DatasetOwner 写入单独的播放命名空间；真实源资格、统一物理读锁、FD 和租约在 Owner 中管理。禁止 Main 建第二套文件池，禁止伪造 Roon Core 或 Zone 确认。普通 access 刷新只更新访问代际；撤销、退出和重新配对立即封住旧设备 epoch。其他设备得到 404，同设备旧 epoch 得到准确的撤销错误。原 201/202 回执保持，UNKNOWN 只读取原提交结果，不重做来源准备或改换键。

file 媒体通过独立流式发送器逐块读取，块上限 64KiB；实际写回调和 drain 控制背压。元数据的 256KiB 请求、2MiB 响应、15 秒期限保持。控制与媒体各有 16 个请求槽，连接最多 32 个；媒体建立期限 10 秒、idle 5 秒、票据绝对期限 60 秒，持续写入不能延长旧票。renew 持久完成后签发新票，旧票只活到原期限。每个 HTTP 读有独立取消身份，取消 seek 不删除整个资源。关闭或 release 等待原真实读及 FD 围栏回收，不能以超时包装代替 quiet。

GET 支持单一闭区间、开放尾及 suffix；多 Range 和非法范围得到空 400，不可满足范围得到空 416 及真实总长度。D2 HEAD 忽略 Range，成功仅完整 200、完整 Content-Length、无 Content-Range、零正文和零读；错误 HEAD 也只有零正文。开始发送后出现撤销或失败只断流，不能追加 JSON。

独立软件 Gate 实际重建 contracts、Core 和固定 Metadata Worker，再检查测试、desktop、e2e 类型，执行合同 15、Core 30、桌面 36 个行为用例。总计 81 个用例独立于操作和验收项数量，不能借测试数声称手机或 Owner 接受。Gate 预算固定为单阶段 180 秒、总计 480 秒，完整输入、日志和新鲜产物在结束时再次核对；未知漂移、缺案、SKIP/TODO 或不自然关闭均拒绝。

```bash
node --test scripts/ci/test/mbm002-admission.test.mjs scripts/ci/test/mbm002-legacy-input-normalization.test.mjs
node scripts/ci/verify-mbm002-resource-playback.mjs --output-root="$DEV_BUILD_ROOT/tmp/musicbridge-mbm002-gate"
```

自有 WAV／ALAC 的 Scanner、SQLite、真实 FD 与生产 Main HTTPS 同进程用例属于软件集成。正式 Electron、CoreSupervisor、Owner Worker、系统 safeStorage 和局域网候选另取实际证据；它们不能替代原生 iPhone 引擎、设备输出或听感。首条可运行局域网文件链路就交 iOS 接物理设备，保留短期自有素材和受保护的配对通道，不修改已安装的桌面应用或用户数据。

003 仍未开始，已确认的 24-bit/192kHz FLAC 和 DSD 转独立 PCM 范围见 `docs/postrust/MBM-003/OWNER_SCOPE_AMENDMENT_2026-10-09.json`。本任务不以不支持格式关闭这些要求，不宣称转码为原生 DSD 或 PCM 无损转换。

提交按实现 Source、独立报告 R 执行。Source 必须有新鲜本地 Gate 和首次自然 push CI；R 必须只更新本任务报告记账，并消费精确父 Source 的 013/000/001/002 Gate 与完整 producer 元数据。普通推送后核实远端 HEAD、工作区清洁、完整日志及制品，最终双端封存置于外置私有证据目录。真实 Provider、Roon、NAS、设备音频、录音和 Owner 验收保留各自未完成项。
