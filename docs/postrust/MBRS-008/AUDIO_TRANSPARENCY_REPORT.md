# MBRS-008 四层音质证据

源码阶段已执行370项定向软件检查（36新、334回归），全部通过且无skip/cancel/todo；Core263、Contracts58、Desktop49。实际旧23回归路径未改。新鲜Reader/CUE准备、严格Core/Vue/E2E类型与两场景原NowPlaying组件SSR通过。完整最终Gate、源提交CI及独立报告身份以[结果报告](../../../reports/MBRS-008_AUDIO_TRANSPARENCY.md)和外置收据为准。

| 层级 | 已执行软件方法 | 真实证据边界 |
|---|---|---|
| Q1 | 自有非静音WAVE经真实Reader/Scanner/SQLite accepted观察、production票据/固定FD/Registry/Gateway，14完整/HEAD/Range/If-Range/错误请求逐字节对独立oracle；中间低位改变、replace/truncate、短读与取消quiet负例 | 仅受测8236字节、16bit/44100/2声道及其版本；Endpoint/SDK为受控接点，不是实际Roon出声或DSP |
| Q2 | 分别绑定native/direct同build/Core/Zone/output/source/revision/settings，语义比较输入/处理/输出、对象键序、DSP顺序、增益/响度/ReplayGain与DSD三段；工厂身份和深冻结拒clone/裸结果/跨scope包装 | 实际Signal Path未测，无伪造SDK输出接口 |
| Q3 | 私有离线16/24/32位非静音双声道、有效低位、明确整数偏移逐样本比较；少帧/交换/复制/增益/格式与预算拒绝 | 设备捕获条件未提供，真实数字输出未测；算法MATCH不能声明设备位精确 |
| Q4 | 同clock唯一锚点、3～16次重复与native基线；丢帧/插静音/重复/尖峰、对齐误差、跨率relock单列；混合测次保留所有issues和已证失败优先 | 实际gapless、设备重锁未测；007顺序预备不能抵扣 |

默认能力矩阵14行×12轴逐项显式；FMT14精确片段unsupported。受测软件证据按scope列出，不跨scope合并为普遍能力；其余实际格式/AudioInput/输出继续未测。文件参数由当前accepted解析报告经Owner票据进入原Controller与三个现有UI消费者，旧A/缺参数B/native清参均通过。UI明确本地来源、文件解析参数与Roon实际输入/处理/输出未知，四轴不自报绿灯。SSR是组件软件证据，普通App和Owner最终反馈未执行。

实际实验音量/DSP变化仍需明确授权、初始记录和结束回读恢复。本次没有发送真实设置命令；仅检验安全私有记录。素材、原件与测量JSON在外置私有根；CI排除run/tmp子树，公共资料只含安全摘要和引用。Q1工厂结果、Q2/Q3/Q4分析结果与质量assessment均防复制自报，endToEndBitExact固定false；不声明CORE_READY、DSD直通或完整无损。
