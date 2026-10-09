# MBM-001 复用与双端接线

唯一合同继续使用 `packages/contracts/mobile/openapi.json`（1.6.0，wire 0.1.0，40操作），整字节不改。001只接前10操作；q在listAlbums/listTracks内，不增加search或command HTTP操作。Mac基线c6c4745、iOS基线8ba6b97，完整身份见PREDECESSOR_DELIVERY.json。

复用CollectionRepository.localCatalog及既有Dataset Owner权限/恢复/关闭围栏，009只读查询和010当前发行选图；公共HTTP字段不能证明路径、根或设备权限。认证状态与稳定ID注册走私有Owner端口，SQLite仍只有原Dataset Owner写入。Main持有本地安全加密上下文，设备配对不复用Provider QR/Cookie。

两端按冻结raw合同接线：GET server唯一未认证最小身份；pairing201、refresh200与logout204；认证后的capabilities和只读catalog/artwork。两端继续现有server pin、installation、Idempotency-Key与401原意图恢复语义；后端必须提供真实持久回执，客户端生产失败不切Mock。

Root独占公共合同、共享Owner/DB、Main/preload/设置、工程/CI、编译测试App及Git。三个既存代理先分别审计auth、catalog、HTTPS接点，公共私有API固定后按独占新文件实施；不得派生或重写彼此文件。原iOS主代理独占客户端代码、测试、Git及推送。

内部快照与opaque cursor绑定server/device/dataset/account/source/revision/sort/filter/album和撤销epoch；原始路径及Provider locator不公开。发行/音频/segment缺事实必须明确有限拒绝或真实缺失，不能构造unknown专辑、0时长或假规格。当前选图只读输出实际96/256/512编码；GET不调用stage/apply。

真实LAN部署/手机操作/音频留独立验收，本阶段先完成软件与受控HTTPS/App；002首条可运行Mac→iPhone文件链就绪再接真机。000最终R内pending为冻结历史，由实际最终收据解析；本001资料更新其软件完成，不产生第三次000封存提交。

当前原Mac复用锁完整字节仍保留。三个新增Owner接点文件经001有限片段适配：先核当前整文件exact bytes/SHA，再只在内存逆回原片段并由原000整文件断言核对；此证明仅覆盖旧片段，当前Owner行为由001实际HTTP／扫描／分页Gate证明。原Preload测试夹具仅新增真实移动模块依赖，九个原测试及全部原断言不变。

未指定source明确local；all/netease在001返回503/BUSY、retryable=false。实际登记技术事实不能证明当前介质权限或002播放，availability保守unavailable。Main调用原Owner原有collection与maintenance连接；不新增移动SQLite连接或DDL，移动密封状态走独立受控JSON。
