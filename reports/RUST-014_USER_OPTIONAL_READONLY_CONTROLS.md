# RUST-014 普通用户可选 Rust 查询与刷新

普通应用已接入“设置 → 应用 → Rust 收藏查询”开关，以及列表和详情页的“刷新库存”。最终签名包、普通界面操作与完整软件验证通过；两轮独审通过，未解决P1/P2为0；普通界面闭库独立收据已通过。默认仍关闭 Rust，原 Node 控制面和唯一业务库作者保持。

基线 `e35ad579ef276075d09d0b52fc6bb8158c418b26`，实现 `040e9c1c3525b3b26a6335a545f47ba8ad2e0bdd`，分支 `codex/rust-core-014-user-optional-readonly-controls`。实际构建 HEAD 是基线，最终 1,143 程序输入聚合 SHA `bbcf1601805f9e6d1b32e993d8e08321be7d3cad9f865d31cc8a50955e0a8a17` 与实现 Git blobs 一一匹配；未把构建身份改写为事后提交。报告提交由 `git log -1 --format=%H -- reports/RUST-014_USER_OPTIONAL_READONLY_CONTROLS.md` 解析，下一任务从最终报告 HEAD 接续。机器证据见 [RUST-014_EVIDENCE.json](RUST-014_EVIDENCE.json)。

正常固定 Main/core.js/空 args 及原公开 bootstrap 先完成 Node prepare/boot，再附加可选只读 manager。默认 OFF 不解析 Rust 资源、不导出快照、不创建 native。开启失败或错误 pin 保留标准查询；写入仍经原持久 outbox 与唯一 Node 作者，写后立即撤销旧 Rust 读发布权，普通刷新才重新建立快照。未知或异常 native 关闭将本 Core 封禁，不能重新开启来洗掉故障。Main 仅保存 schemaVersion/boolean，可信主窗口闭集 IPC，代际/迟到回复与旧刷新航班均有围栏。

最终验证结果：

- `candidate-04` 四份 arm64 ad-hoc 包与六次实际运行通过，112/112 专项零失败/跳过；固定 Resources pin、实际签名、ASAR/header、九位 Fuse、正常入口和共享 preload/Renderer 均核验。
- Node/Rust fresh 各通过原表单入库 26 型号，再保存一次保护设置；各 27 条 Main 提交/ACK、独立领域账本和 revision。分页、筛选、详情、写后回退、普通刷新及 OFF→ON 通过。相同包/profile 冷启保留库存/策略和 ON/OFF 意图，零业务写入及零普通刷新；四份闭库 SQLite 的218次完整DTO参照独立核对（两fresh各98，两cold各11）。
- Rust fresh 47 个实际请求/validated reply、3 个 native 创建与自然退出，cold 13 个请求/validated reply及1个自然退出；五个诊断run原 Node prepare/boot/close 均一次。原 Rust list dispatch fresh38/cold10；关闭 ACK/pending0 与原 Main outbox-close-end 均核，六run Main均自然退出0，五个诊断run Core/Node自然退出0；default原startup未独立观察Node退出。无 timeout/强制清理。错误 pin 为可选能力失败，原 Node 继续可用。
- 完整软件六步全部退出0：类型、4,023 单元通过、生产构建、control-plane、boundaries、cycles。仅原有两条 OutputNative 条件 skip；未把未执行计为通过。已签 native 实际回归30/30、原包内资源与 bootstrap11/11，零skip；Rust源未改，复用013已验证的unsigned编译输入，不声称新 Rust 编译。

代理通过普通 native CUA 操作最终默认诊断关闭包：一型号原表单入库、保护保留数量改为1，共两次业务保存；两次写后标准查询回退，列表和详情普通刷新恢复 Rust，详情型号保留，保护值刷新后仍为1，关闭再开启正常。保存11组 AX/实际JPEG像素，正常CmdQ退出0，独立C以immutable只读确认1型号/SKU/lot、2唯一账本和succeeded/ACK outbox、revision2/normal/reserve1及偏好true/0600，三库读前后SHA不变；不直调API/store/handler。历史candidate03另有16组AX/JPEG及闭库1型号/2账本对照；其截图内容为JPEG而文件扩展名为.png，原件保留，最终04按实际格式保存.jpg。固定DOM工程驱动与普通CUA分层记录，不能替代Owner或真实服务验收。

实际失败均保留：Gate01设置驱动使用错误入口选择器，未执行第27次写入，不计完整通过；Gate02完成27次写入却暴露详情页无普通刷新入口，追加真实SFC模板有效RED后补齐同一按钮，并等待实际列表/详情读取完成。前三次模板host准备失败与有效RED区分。首轮独审P2跨OFF→ON复用旧刷新航班已取得有效RED/修后27通过。完整软件01循环检查发现设置与客户端互相导入，移动共享错误类到协议层、保留原客户端再导出，循环检查变绿；最终源码04、签名包和全软件重新验证。相对cwd旧夹具与native冻结预检等准备失败单列，不修改原断言或冒称执行。

两轮独审通过，唯一P2已闭合。第二轮收据 `review-014-round2.json` SHA `a300a8dbce42a5085cf1c0f40bd8de05deb16c2cf051ed77a34ba0896bdae58e`；报告提交后由外置 `FINAL_IDENTITY.json` 再核最终HEAD、清洁、remote与14保护树/7WIP。本期未安装替换、迁移真实用户库、接管Rust写库、push或发布。受控包只包含本期Rust资源；原FFmpeg/output/device打包hooks保留在源码，完整媒体资源包未跑。其他架构/Developer ID/公证、真实账号/Roon/播放/录音与Owner结果分别保留，不能由本期通过推定。下一项先验证普通入口的2000/4MiB规模回退和完整链路成本，已存在的5000/8MiB显式可信能力继续单独计证据；完整Rust迁移仍未完成。
