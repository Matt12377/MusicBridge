# MBRS-014 关联合同实施决定

状态：Root 已审阅并冻结为实施输入；尚未实现或验证。

使用六项 localLegacyLinks 闭集命令及两类独立边。旧实体发行可用 physical-release 主体直接关联本地发行，不要求先建立 Roon 或 DigitalAlbum。既有数字记录用 digital-album 主体独立关联。当前草稿源关联必须由 Owner 对两个实际文件完成 SHA-256、长度、范围和权限核验；同名、标签或时长不产生等价关系。

完整类型和事件语义由 API_FREEZE.json 所绑定的只读草稿提供，Backend/contracts 唯一作者据此实施；具体预算和接口候选读取以本冻结文件为准。候选从已有有界本地读接口选择，预览由服务端验证，客户端不得自报文件证据、私有位置、能力或绑定事实。

新事件保存在原 schema34 local_catalog_ledger 的独立 operation。外部 commandId 保持同一 local_catalog_ledger 各 operation 的唯一主键，并继承既有 Outbox 身份；旧 music、physical、source 等独立账本不因此获得永久统一命令键。server 签发的 link、preview、transition ID 独立。新增关系与旧 Roon 边互不替代。预览、执行、解除、历史和明确 CAS 撤销分别记录；只能追加事件，不能改旧端点、照片、库存、Reference Catalog、冻结快照、录音或 J-Card。

新域冷核和增量投影须有界，游标固定已核高水位。原账本 12M 行、目录 16GiB、200 曲和 SAB 2048 slots 合同保留。异常、预算或来源历史无法核验时明确拒绝，不能显示成功空态或关闭旧浏览。COMMIT 不确定继续沿唯一 Node 作者 fatal fence 保留工作库和 claims，不自动重发。

原 schema30 合成旧库及103表比较保持原字节；新增非空 Prepared、旧录音、照片、商业发行与参考目录另建自有合成证据链。真实用户库迁移、账号、Roon/NAS、声音、设备、印刷及 Owner 最终试用保持未验。

Preload 原完整方法集合断言因新增接口作精确增量更新：仅在预期列表尾部追加六个已冻结方法名，保留所有原断言和旧调用顺序。具体原件与唯一允许后继字节见 PRELOAD_API_EXTENSION.json；其余48个输入仍按原件字节核验。
