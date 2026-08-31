# TASK-050：实物照片、代表图与收藏墙

## 身份与授权

- Owner 持续目标“全部开始”；延续已认可的收藏/录音双入口方向。
- 基线：`71eca199f2678c9dfe6ba765193e09ef4207d89a`，TASK-049 最终状态锁定提交。
- 分支：`codex/task-050-v3-collection-photos`。
- 上一任务已通过自动 Gate；真实照片与 Owner 视觉验收未执行。

## 范围

1. 使用原生文件选择器，由用户主动选择实物照片。Main 只读取选择的文件，校验类型、尺寸与大小，生成应用拥有的安全图片副本；不扫描照片目录，不改写原文件，不加载外部参考图。
2. 照片可归属型号或已有单盘；支持代表图指定与回退，缺图明确标识。给型号添加照片不批量生成 Physical ID，不改变库存数量。
3. 正式收藏墙以照片为主体；支持按品牌、年代及关键词浏览，有界查询和分页。长名称、各时长数量、未知状态和单盘来源保持可读。
4. 图片持久化与已有 schema 迁移；移除、重复命令和中途失败不破坏库存或原照片。记录来源、应用副本和实体归属，Renderer 只拿到有界业务引用，不暴露本机路径。
5. 单盘详情保留状态与编号；旧录音在内容尚未补录时明确显示“已录音，内容待补录”。原版实体库、音乐内容与 Roon 关系由下一任务完成。

## 允许修改

- `packages/contracts/src/{collection.ts,ipc.ts,validator.ts,index.ts,errors.ts}`；`test/validator.test.ts`。
- `packages/bridge-core/src/collection/`、`src/{runtime.ts,utility-main.ts}`；`test/{collection-repository.test.ts,utility-ipc.test.ts,runtime.test.ts}`。
- `apps/desktop/src/main/{index.ts,collection-photos.ts}`；`src/preload/{api.ts,index.ts}`。
- `apps/desktop/src/renderer/src/components/collection/`、`composables/useCollection.ts`。
- `apps/desktop/e2e/v1-ui.spec.ts`；`test/{collection-photos.test.ts,preload.test.ts,renderer.test.ts,protocol.test.ts}`。
- 本任务、索引、`project/{WAVE-5.yaml,STATUS.json,V3_EXECUTION_PLAN.md}`、`docs/adr/ADR-010-v3-collection-photos.md`、`reports/TASK-050_RESULT.md`；忽略提交的本地验证证据。

若实施需要新文件或不同架构范围，先更新本任务并说明原因；不顺带修改播放、歌词、安全策略或音频执行。

## 验收

- 先通过正式 Renderer/Main/Core 边界得到照片相关行为 RED，再实现 GREEN。
- 合成图片覆盖正常读取、取消、畸形/伪装类型、超量、缺失与链接路径边界；不输出真实路径和元数据。
- 已有库存数据库迁移后数量、Physical ID、保护与账本不变；重复照片命令不重复关联。
- 代表图设置与回退可验证；照片加载失败只影响图片，不丢失实物记录或导致空库。
- 过滤/分页不改变全量库存与型号身份；照片不被拉伸或误裁，键盘、720/1440px、长名称与 axe 检查。
- `verify`、security、Electron 生命周期、完整 E2E、控制面/边界/循环与差异检查在 Node 22.23.2 / pnpm 10.17.1 下执行。共享构建目录的 Gate 顺序运行。
- 独立实现/报告/状态提交；不 push、不合并 main、不访问真实 Roon/账号/音乐或录音设备。

## 保留事项

F-01、TASK-047、V2 闲置播放器对比度与 TASK-049 未确认操作跨重启 outbox 保留。照片任务不将完整 Gate C/U-02/U-04 或 Owner 美观验收标为完成；最后仍需使用 Owner 指定的真实照片体验。
