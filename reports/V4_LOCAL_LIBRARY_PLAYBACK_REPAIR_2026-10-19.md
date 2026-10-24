# 本地音乐、歌词、子碟封面与进度修复

当前修复版已完成开发构建并在现有华语音乐库运行。指定 WAV 的内嵌歌词和封面、四张子 Disc 的专辑根封面、连续点播及连续进度跳转已观察通过。大库冷启动仍然慢，物理鼠标连续拖动的完整手感和真实出声延迟没有验收结论；不能据此宣布全部性能目标完成。

## 源码与构建身份

- 源码：`/Volumes/LifeWeave/VSCode/MusicBridge/worktree/v4`，分支 `codex/v4`。
- 基线 HEAD：`f459c46525855e87e1d8ee68388e8ea21ab04653`。实现及本报告均保留为未提交 WIP，未提交、推送或清理既有改动。当前分支没有 upstream；只读 `ls-remote` 未找到同名远端分支，退出码 0。
- 当前构建来自外置镜像 `musicbridge-dev-25b6ed0447bc/workspace`；开发构建退出码 0，内部构建 21.62 秒，含身份采集共 23.556 秒。
- Reader 编译绑定 SHA256：`828434cfd2ec8b95c390ef5346ee8d83869bb29ad7cc4afb81910cd1be840cab`。
- 已装配 Rust Worker SHA256：`61448720f84ed8a75f974091a65eac7953978922379f508d3fc67bdff3317886`。
- 147 个当前生产 WIP 文件与运行镜像逐字匹配。此清单包含既有 WIP，不表示全部改动均由本轮编写。构建后仅追加历史回放测试与交付记录，没有改变运行中的生产源码。
- 下一次继续以当前 WIP 及 `final-production-source-manifest.json` 为基线，不从 HEAD 覆盖工作区。

证据根目录：`/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-library-latency-20261018`。主要身份文件为 `final-build-result.json`、`final-reader-binding.json`、`final-production-source-manifest.json`；运行日志为 `capture-replay-runtime.log`。

## 本轮改动及真实结果

### WAV 内嵌歌词

指定文件 `孙燕姿/2003.08.22 - 孙燕姿 - 《The Moment》[2CD]/CD1/01. The Moment.wav` 的 RIFF 尾部包含 ID3 USLT 歌词。原链路只有旁置 LRC，新增私有 Rust 读取操作跳过 PCM 和 APIC 正文，从同一已授权音频 FD 读取内嵌歌词；有效旁置歌词仍优先。

保留绝对期限、读取与文本预算、取消后 FD 收口、Source/当前会话身份核对。USLT/ULT 中的 LRC 与 SYLT/SLT 均有相关覆盖，失权不回退。日志只记录阶段、计数和耗时，不打印歌词、来源路径或凭据。

正式应用核对目标 track `4ed0c46c-a22b-40fe-9468-b6c5504a522a`、asset `4cc700aa-8d7f-45fa-8bda-40f7bae32f03`；播放页显示正确封面和 50 行同步歌词。最终运行日志记录内嵌读取 27.77ms、完整本地歌词读取 44.47ms、2931 字节。播放进度实际推进后已暂停，留给 Owner 直接试用。

### 子 Disc 专辑根封面

`林忆莲/2008 林忆莲《盛放莲华 4CD》[引进版] [WAV]` 的 CD1–CD4 内没有各自图片，专辑根存在 `cover.jpg`。新增严格同一音乐库、直接父级且目录名称符合 CD/Disc 规则的候选：子目录自己的图片优先，再读父级固定封面名，最后读取内嵌图片。不会继续向艺人目录或其他库递归查图。

旧的子 Disc 缺图结果允许有界重新探测，图片读取仍保留完整来源证明。真实应用中四个 Disc 均显示正确的同一专辑根封面。

### 两条状态误报、打开专辑与点播卡顿

页面先等实际 Core 和当前视图身份就绪，再发当前页面请求；优先展示专辑，随后读取管理上下文。一次读取只有在双端实际接受当前 dataset、owner、视图及修订时才算成功，晚回包和离页结果不能覆盖当前状态。真实未知写请求仍保留原参数与核对入口，不用隐藏真实失败来消除红字。

普通打开单张专辑不再自动捕获整库 9755 张专辑。管理记录新增有界 CAS 和提交后精确回读；历史重放在同一次完整核验内建立观察 ID/序号索引，保留原 SQLite 行序、预算、完整 codec/hash/成员核对及超界回退。没有省略完整核库、Source 或事务核对。

最终应用连续三次保存单专辑读取记录为 56.04 / 60.20 / 39.70ms，修复前同阶段为 77.7 秒。指定 WAV 的提交完成约 545ms；先前连续三次点播的提交约 233 / 476 / 588ms。这里的提交完成不是人耳出声时间。首入最终应用未观察到用户截图中的两条红字。

真实库的一致性外置只读副本执行原完整 Catalog 核验为 23.31 秒，原逐曲相关 ledger 查询为 0。该检查没有访问 NAS 或写入正式库；最终应用也已正常启动并读取既有历史记录。

### 进度、封面和播放页

健康 compact 观测不再无条件重建完整播放会话，当前播放封面按真实 dataset、track/asset 和修订保持关联。暂停 seek 仅在同一实际设备的新观测与目标相符时确认；未知、超时和换代仍走原恢复，不能由 ACK 伪造成功或永久禁用后续操作。

真实应用在暂停时连续跳转到约 2:24、1:03，保持超过五秒，封面和歌词保留、滑块仍启用；此前恢复播放后进度继续推进并进入下一曲。自动化原生 `drag` 在本窗口只改变按下位置，不能可靠完成终点移动，因此不把它记作完整物理拖动验证。相关 Core/Renderer 行为测试通过，但顺滑连续拖动的手感仍需单独试用确认。

### 封面墙与专辑详情

封面墙使用有界可见预取和 LRU，持久缓存由 Core 保存并后台补齐；不把全库图片灌入 Renderer。查询按批读取全部专辑，不再依赖每 20 张到页底才能继续。前台读取优先，后台读写留出安静窗口；队列变化不再无谓重建整库结构。

详情页按用户参考调整为满宽内容、大封面及右侧信息、下方连续歌曲列表，保留现有主题与真实元数据，不为参考图补造介绍或无效操作。54px 实际行高与虚拟列表一致。普通 960×640 与最大化 2485×1409 窗口已观察；未做同视口逐像素差异，最窄原生窗口没有实机通过记录。详见 `design-qa.md`。

## 验证

以下均检查了实际退出状态；测试组存在重叠，不累加为唯一用例总数。

| 检查 | 结果 | 外置日志 |
|---|---|---|
| 最终开发构建与 Reader/Rust 装配 | 退出 0 | `capture-replay-dev-build.log` |
| Core 类型检查 | 退出 0 | `final-history-core-types.log` |
| Desktop 类型检查 | 退出 0 | `workspace-final-desktop-types.log` |
| WAV/子碟封面相关 | 27/27 | `new-lyrics-disc-tests.log` |
| 内嵌歌词相关 | 20/20 | `embedded-lyrics-tests.log` |
| Renderer seek/会话 | 44/44 | `seek-renderer-tests.log` |
| Core 暂停 seek | 10/10 | `seek-core-final-tests.log` |
| 连续点播修订与队列 | 14/14、26/26 | `repeat-revision-final-tests.log`、`repeat-queue-regression.log` |
| 封面回归 | 92/92 | `final-artwork-regression.log` |
| 工作区实际读取确认 | 18/18 | `workspace-read-confirmation-tests.log` |
| CAS 范围、提交证书 | 9/9、19/19 | `capture-cas-scope-recheck-tests.log`、`capture-delta-final-tests.log` |
| 原管理读取/日记/Source 标记回归 | 115/115 | `capture-history-regression-tests.log` |
| 新历史重放边界 | 8/8 | `capture-history-final-restored-tests.log` |
| `git diff --check` | 退出 0 | 最终工作区检查 |

新历史测试覆盖多次捕获、未来观察/override 隔离、原 observation 行序与 64 位行号、空 raw、200/202 候选回退、正文篡改、规范 chunk 漏组、跨 Root，以及原 SourceWrites 真实发布产生的非空/空 fullRaw 锚。初稿中的无效测试字段、绑定时机及 mock 恢复问题已分别修正；没有为使测试通过而降低生产校验或删除原断言。失败日志仍保留。

## 尚未完成的目标与限制

- **大库冷启动仍有明显等待。** 最终日志两轮 Owner 就绪约 65.91 / 64.65 秒，合计约 133.28 秒，首次墙查询另约 13.44 秒。源码链是先完整启动本地 Core，Renderer 才读取自动 SSH 偏好，隧道绑定后正常切换模式并重启、再次完整核库；首轮为正常退出而非 crash 重试。需要在首次 Core 启动前确定最终模式并处理失败回退、关闭竞态，不能直接删掉 restart 或跳过核验。本轮未实施该启动生命周期改动，不能宣称冷启动无感。
- **五分钟全库扫描目标没有新通过证据。** 保留的华语扫描记录为 27 分 40.567 秒；为保留现有数据，未清库或重扫来制造新结果。
- 没有测人耳出声延迟、HTTP 音频字节、Roon Signal Path 或物理数字输出。进度推进与提交完成不能代替这些证据。
- 未完成同视口逐像素、最窄原生窗口、完整物理拖动手感或 Owner 最终接受。
- CoverDrop 工作区未选择播放设备时的错误反馈仍不够明确；本次正式播放验证选择已有 `System Output` 后完成。没有调整家庭网络、配对或 Provider 凭据。
- iOS 发现、503、手机播放与锁屏/热状态属于独立联合验证，不能由本次 Mac 结果代替。

现有音乐库、扫描记录、封面缓存及源文件均保留；当前修复版保持打开。Owner 可直接试指定 WAV 的歌词、四个 Disc 封面和连续进度跳转，无需先清库或重扫。
