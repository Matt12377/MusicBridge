# V39-INTEGRATION-002：完整Feedback与CoverDrop正式集成

本任务从已完成Source及唯一直接Report自身首次自然CI封口的 `4c1c6c78d965260a56c3f5bf51f1d6c83ddb9870` 创建，实际独立分支 `codex/v39-integration-002`；前序Source为 `744c29af17e7f587a635810c4f45e327c7132705`。已有Owner完整授权持续有效，按精确分工连续实现与验证。

完整采用Feedback、Report、Async、Async Report及SQL四增量共8个准确输入，99叶（92新增、7修改，1944704字节）。3175两异步IPC叶按固定版本保留；548从e2d分叉，只叠准确SQL增量至72e5，不能用整棵72e5树覆盖。历史提案只保留原件，不自动应用。

CoverDrop原35组+9组新增共44组逐项验证；37行历史映射另外保留。CD-36既有SourceWrites/Relocation、标签封面与改名移动保护入口完整保留；CD-37固定93fa无歌词只是历史事实，不能排除当前七组歌词。正式本地音乐album wall/detail/play与独立CoverDrop侧栏共享Controller、根、专辑身份与Owner，并保留离开Save门禁、选中项和返回位置。

七组歌词含五来源单专辑查询、真实正文预览选择、samestem LRC独占拒覆盖、WAV/FLAC受保护副本嵌入、完整指定库批次/停止/恢复/失败重试、本地三态inventory与第九筛选、封面歌词共同Save/离开门禁。候选不等于本地歌词；写入前原身份/计划/journal/CAS/SourceFiles许可与锁不可绕过。LRC成功、嵌入失败、快照失败分别登记，UNKNOWN仅查原回执，不改UUID重发。库移除join所有相关任务，仅删除许可本地记录/缓存，源音乐/封面/LRC及其他库引用保留。快照独立retry不能重扫或重新查询Provider。

Root负责唯一Owner、SQL/CAS/journal、完整专辑捕获、Scanner/Parser/Reader、真实FSEvents、Main/Preload、Native与最终整合；CoreLyrics只写Scope的13个独立歌词叶，Renderer只写自己的精确叶，Wave只写16个新准入/Gate/测试/路由/工作流。`EXECUTION_SCOPE.json` 开发态frozen:false只登记完整写权，不能自报CI资格；停写后固定全部实际Source累计/直接闭集与整件pins、测试名称和原件根。

10000项/32MiB是完整逻辑捕获界；2048项/128KiB小组与2048 physical claims另域保留。不可截当前页、按同专辑分批业务commit或提高预算。大组MB-only完整CAS一次事务；超过物理保护能力的源写整组阻断并说明。CUE99×100上限不抬高。Owner2000ms、Reader1或2、原32MiB读取/64MiB分配/3000ms、小frame等均保留；专辑扫描1–24/default12独立于Reader并发，配置持久回读、当前启动参数freeze、冷恢复及最近成功快照齐全。

独立darwin-arm64 CUE配方复用本地FFmpeg8.1.2固定整包SHA及实际GPG签名，另固定官方LAME4.0、Ogg1.3.6、Vorbis1.3.7、Opus1.6.1和TagLib2.3.2整包/许可证。ffmpeg旧录音/mobile DSD策略原字节保留。FLAC、ALAC、MP3、Vorbis、Opus、WavPack、PCM WAV、PCM AIFF八族必须实际encode并用固定decoder完整读至EOF，记真实字节/摘要/无损PCM等值及有损延迟/质量、标签图片、采样率/位深/声道、Unicode、CD75/pregap/多FILE、取消/原子失败/原SHA与无覆盖输出。下载/--version/菜单/模拟编码都不授Native完成资格。

2026-10-12 CD-35范围裁定：上述八族是必须保留的输出资格，输入另包含原功能需要的APE、TTA、MPC7/MPC8及TAK；非可保持输出编码只回退已实际资格的FLAC，不增加通用转换器。新增demux/decoder均来自同一固定FFmpeg源码包，五包版本/SHA/GPG、TagLib身份和禁止GPL/nonfree/version3/network继续固定。新配方与包使用新manifest及实际解码至EOF、独立FLAC输出、PCM/精度、标签回读、源SHA和物理收口证据；有损MPC源不宣称原源无损。旧347及其资格原件保持原字节，不签新包。该必要实现已由既有完整44组授权覆盖，该输入配方沿原Source270，全部预算不扩大，未运行的新能力仍不授完成资格。

本轮标准检查、002工具Gate、Native180000/480000ms域及必要容量600000/30000/Owner2000ms域分别自然执行。普通工具90000/480000ms、16MiB I/O与64MiB展开frame不改变。原173用例及001所有历史原件保持，旧001当代闭集不拿来签002。当前新增nested测试由新Gate显式执行，不能声称pnpm默认glob覆盖。已合格未变的100k/300k不机械重复；变动SQL/完整组需要当前证据，548的300k超时保持失败。进程/FD/watcher/helper/claims必须实际关闭。

新准入优先识别002；缺标记、branch mismatch、开发态、dirty、未知路径/模式/身份或历史对象漂移要拒绝，不能fallback旧001/通用full绕过。Source从4c唯一直接父普通提交；Source自己的标准/Gate/首次自然产品CI后，创建精确8叶3A5M唯一直接Report，Source叶保持原字节，Report本地工具及自身首次自然CI独立封口。TODO只在完成Report更新一次。CI归档精确排除runner缓存，保留编译物、Native、raw I/O、日志和测试证据；不重跑旧SHA，不amend/reset/强推。

顺序固定002→003→004→MBRS-016→MBRS-017。003对接既有MBM-003合同与现有iOS工作归属，完整包含移动FLAC至少24bit192kHz和仅DSD由Mac转48k24 PCM生成独立FLAC缓存；首曲整件完成才播放，可复用、Range seek、续租释放和配额齐全，原文件/传输角色区分。真实iPhone播放、拖动及断线恢复均属于003的完整验收，不能只验FLAC就关闭MBM-003或把DSD延期给004。004保留既有MBM-004内容、多设备工作归属及原完整验收；新标签不替换旧任务。2.55GB Tape停写备份DB/WAL/outbox生产导入另立真实窗口。本轮初始均NOT_RUN，不以合成测试、构建或CI代替Owner接受。

2026-10-13正常扫描与位置计划一致性修复：实际混合TTA/FLAC/MPC批次在原引用闭包后缀分类处被误拒UNKNOWN_REFERENCE。仅增加原继承 `source-relocation-companions.ts` 这一必要M叶，对齐OGA/TTA/TAK/MPC及MPP/MP+已批准输入别名；开发Scope270→271（99M/172A）据实际登记，不增加功能、Public39或预算。未知同stem伴随文件、未登记音频、共享引用、完整目录与符号链规则保持，原失败raw保留；必须以无诊断变换的fresh产物验证原混合批次和拒绝回归。

2026-10-13关闭身份回归夹具一致性修复：576完整标准已实际自然失败，原`command-outbox-core.test.ts`在数据库文件被替换后正确拒绝dispatch，但旧after-hook把原关闭的身份拒绝误当清理成功。仅追加这一必要继承M测试叶；开发Scope271→272（100M/172A）登记其4c原blob/整件SHA，不增加功能、Public39、预算或门禁例外。生产关闭仍核同真实identity/连接，失效时拒绝并保留材料；测试只能在取得原失败证据后清理自有两库，不能把强制清理计为Owner自然退出或SourceQuiet。所有原失败日志与已封566/571原件保留；新源码须经当前针对检查和新完整标准窗口，旧576没有after或生产尾构建，不准Main。

2026-10-13桌面继承测试一致性收口：585完整标准实际自然结束（verify1/tee0），合同298/298、Core3093通过及2个既有Native条件跳过、额外集成8/8，桌面2079中80失败集中15叶。Root590移除自有子进程无关NODE_USE_ENV_PROXY后，两原raw文件67/67，未改测试或过滤stderr；这两叶不登记新修改。本次仅为已授权002所必需的七个继承测试追加M：core-supervisor-compact、library-cache-transport、library-read-terminal、mbrs011-organizer-ui、mobile-content-rpc-main、recording-print-worker、sidebar-controls；分别登记其4c原mode/blob/整件SHA。开发Scope272→279（107M/172A），不是增加功能或实际修改数。生产core-supervisor在原授权M内修正恢复期间的同原child/port/generation关闭请求；ACK失败及原物理exit/UNKNOWN屏障保持，Fake回声不替代Main或Owner证据。Public39、九名、所有预算、真实身份及原负例保留；原585/580/584/590封件不改。后续候选实际检查与新完整标准须绑定Scope279，旧hard272窗口不准签新域或Main。
