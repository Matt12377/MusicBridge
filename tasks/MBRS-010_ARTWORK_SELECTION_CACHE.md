# MBRS-010 · CoverDrop封面选择与缓存

版本：1.2｜状态：NOT_STARTED｜范围：CORE。这是任务规格，不是完成报告。

## 目标

将封面查找、比较和应用放进MB，不要求CoverDrop单独常驻。

## 依赖与执行边界

硬依赖：MBRS-009、MBRS-004

任务依赖表示验收条件，不阻止提前编写隔离合同/mock；产品接入必须有G0记录。编号不是提交顺序。

先核对 [代码复用表](../REUSE_MAP.md)、[Rust待办映射](../RUST_TO_MBRS_MAP.md)、[模型/状态映射](../13_MODEL_AND_STATE_MAPPING.md)。文件名是当前定位线索；迁移后使用等价后继实现，不恢复旧架构。

## 实施步骤

1. 继承本地独立图/内嵌图优先级、候选staging和按需查找规则，固定provider/版本/许可证。

2. 支持拖图/选图/候选比较，保存来源、尺寸和Hash。默认只改MB ArtworkSelection及缓存，不写cover.jpg/音频。

3. 复用SafeArtwork和有界缓存，检查类型/解码像素/压缩大小/重定向/SSRF/取消；禁止默认全库联网。

4. 数字专辑图、磁带参考图、个人照片、冻结MasterArtwork分别建关系，不能混成一个覆盖对象。

5. 本地UI立即更新；Roon封面传递只用实证字段，不能凭UI有图声称Core收到。文件写回只生成Organizer计划。

## 验收

- [ ] **MBRS-AT-010-01 / integration / 1.1**：本地独立图/内嵌图/缺封面都可处理，候选优先级和来源可追溯。

- [ ] **MBRS-AT-010-02 / ui / 1.1**：在MB中搜索/拖入/比较/应用真实可用，不需另开CoverDrop。

- [ ] **MBRS-AT-010-03 / security / 1.1**：伪图片、大图、重定向、恶意URL和取消有界，无任意内网抓取。

- [ ] **MBRS-AT-010-04 / integration / 1.1**：仅MB选图不改原文件，写回需独立计划确认。

- [ ] **MBRS-AT-010-05 / unit / 1.1**：封面不参与自动版本合并或质量真实性判断。

- [ ] **MBRS-AT-010-06 / integration / 1.1**：封面服务关闭/失败不阻塞当前和新直送；Roon封面传递实测状态单列。

- [ ] **MBRS-AT-010-07 / integration / 1.2**：数字音乐封面、磁带参考图、个人实物照片和冻结MasterArtwork保持独立身份与用途。

## 交付物

- `ArtworkService增量`

- `provider与候选工作流`

- `图像安全/来源/缓存测试`

## 禁止

禁止把图片相同当发行相同；禁止底层replace操作冒充撤销。

## 阻断处理

provider失败保留本地选图可用，但失败provider不得标接入完成。

## 证据与回退

按 [任务结果模板](../templates/TASK_RESULT_TEMPLATE.md)交代码范围、确切提交、命令/退出码、失败保留、证据层级及未完成项。产品测试不是包结构校验；纯设计/旧报告/上游支持不能替代新实机证据。

使用 [统一验证政策](../15_VERIFICATION_AND_EVIDENCE.md)控制验证成本；按 [发布回退说明](../08_RELEASE_AND_RECOVERY.md)区分代码、数据库、文件及运行服务的恢复。共享交付只维护一个主实施任务，不复制实现或完成状态。
