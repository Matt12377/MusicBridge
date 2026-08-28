# TASK073 第二阶段：无设备检查面板与预检分类

## 身份与范围

基线`0a9ec3520b01066260df6f593e26c7b21167b83f`，分支`codex/task-073-output-backend`。实现提交`d5bf0725e5457e2146b0e049b0d6eed6f48d3621`；报告提交由本阶段最终STATUS锁定。上一阶段的`TASK-073_RESULT.md`保持原样。

Owner持续开发授权下，三个GPT-5.6 Sol / High代理按独立路径实施/审查，root统一构建、实际Electron验证和本地提交。不push、不合并main、不安装或发布。没有访问真实账号、音乐源库或设备。

**本阶段交付无设备检查交互，不完成TASK073或Gate B。** Gate B仍NOT_RUN，formalReady=false；TASK074尚未开始。

## 已实现

1. 在原计划面板常驻接入无设备检查区。打开只读status；用户先明确查看/冻结Plan，再选择非空A/B/Program，才可手动检查。不自动选历史、不自动运行、不走outbox。
2. 回执的run、Plan、Plan hash、Side、帧数、PCM hash、helper身份及无设备边界全部匹配才能显示通过。缺包禁用，状态或检查错误仅显示有界中文，不暴露内部路径；刷新能力时清除上次通过提示。
3. 单活动检查；切换计划/侧面或卸载会取消并使迟到结果失效。取消ACK不解锁，须等原检查结束；失败可重试取消，不将迟到真实成功恢复成通过。
4. 复用现有设计tokens和滚动对话框，提供原生label/select/button、44px控件、aria-live、可见焦点和折叠hash。实际Chromium发现启动按钮禁用时失焦，已按发起前焦点及完成后的当前位置恢复；用户已移焦和卸载时不抢回。
5. 修复TASK072保留P3：同内容媒体规划仅revision变化，预检归`versions / VERSION_MISMATCH`。真实capture先执行，副本实际失效仍为`COPY_UNAVAILABLE`；没有放宽准入或重写旧Plan/库存/命令回执。

## 验证

| 检查 | 当前结果 | 退出码 |
| --- | --- | --- |
| 最终canonical verify：类型、单元、生产build | Contracts134 / Core957 / Desktop447，双native开关开启，0skip | 0 |
| 安全 | 28/28 | 0 |
| Electron启动、crash/restart、合成保险库恢复 | 4/4 | 0 |
| Electron后恢复生产build | PASS | 0 |
| TASK073实际Electron focused | 5/5，含3个新增UI场景，0skip | 0 |
| 完整E2E | 80/80，双native开关开启，0skip，3.0分钟 | 0 |
| control / boundaries / cycles | PASS / PASS / 216文件PASS | 0 |
| 固定原生产物 | 16文件与阶段入口逐字节hash一致，无重建 | 0 |

本阶段自动验证使用合成源、真实冻结Plan和固定helper。成功场景实际消费132300帧并核对PCM；比较库存、outbox、Plan和源文件不变。取消UI场景是正式Core结果完成后，在Main延迟其回执，再验证取消失败/重试及迟到结果失效；**不是正在运行的真实设备停止试验**。

720×480和1440×900截图已逐张查看，panel级axe serious/critical为0、无横向溢出；键盘Enter发起、成功后焦点及关闭后焦点返回均实际验证。沿用长对话框纵向滚动，截图只代表其当前视口，不宣称整应用视觉或Owner接受。

本阶段未重新打包含新UI的应用。生产dist的Electron E2E与下述上一阶段实际.app退出复核分开记录。

## RED与两阶段审查

- UI初始实际RED：3PASS/11FAIL；刷新能力残留通过提示RED：15PASS/1FAIL。取消按钮卸载焦点RED：12PASS/1FAIL；正确宿主节点身份重新证明后才修复。
- root首个UI E2E因草稿选择器前提错误失败，不作产品RED；修正后旧dist因缺少新面板得到有效RED。首轮实际新面板4PASS/1FAIL，失败精确为成功后启动按钮焦点；追加宿主禁用失焦RED15PASS/3FAIL，修复后focused33/33及真实Electron5/5。
- P3通过真实freeze→同内容preview/save→preflight得到0PASS/1FAIL，修复后原文件21/21；同时核验真实副本失效优先级与事实不变。
- UI SPEC1 PASS，QUALITY1发现上述焦点P2，QUALITY2按修复delta及真实GREEN关闭。P3 SPEC1→QUALITY1 PASS。E2E SPEC1发现未明确选Plan的断言假阳性，SPEC2修正后QUALITY1 PASS；root随后追加的焦点断言取得真实RED/GREEN。没有第三轮审查。

最终候选8个代码文件、16个原生文件；`candidate-sealed.json` SHA256：`75a8dc91c8fe8aa09bcf0b9322235f73565484095eafd7e72276cda6c0fd10f7`。全部RED/GREEN、实际E2E、截图、审查及逐文件身份保留于`reports/runtime/task-073-output-ui/`，不提交运行资料。

## 包退出：本次明确FAIL，未伪报修复

只复用上一阶段已核对的实际.app，未改变包、Main、Fuses或sender。旧探针存在等待无响应CDP命令、页面按键不等原生Quit及超时过短的问题；本次只执行一次有根因的纠正验证：向browser根WebSocket直接发送不带sessionId的`Browser.close`，不等待命令reply，独立等待child close 15秒。

**实际结果FAIL，探针exit1。** 四个包子进程已退出，仅Main残留；随后仅清理自建PID，观察SIGKILL后的close且残留进程为空。静态追踪未证明普通Core/remote/outbox未结Promise能解释阻塞，缺少清理阶段标记和Main线程栈，不能指定具体生产阻塞行。没有继续盲跑或修改生产。

此结果更新原“正常退出未验证”的风险，不影响已经分别取得的无设备check证据，也不能被其它自动Gate覆盖。它仍需独立定位和正常退出GREEN；当前不适合宣称包可发布或全部生命周期通过。

## 保留与下一步

TASK073继续：下一最小离线模块为独立`native/output-lifecycle/`会话内核和FakeDriver测试，不加入现有helper源码pin或链接集合，不提供设备入口。该模块只能证明合成控制顺序、故障终止及资源处理，不能提供设备排空/无声或B01～B15测量证据。实际接入前仍须独立构建、审查和更新pin。

实际声卡/录音机、格式/缓冲/路由、电平、独立时基和故障操作仍待明确授权。保留完整TASK064～079队列、TASK047真实歌词、TASK061发布准入、R020大库/Gate E、既有视觉项与最终Owner验收。P3版本误分类在本阶段关闭；包退出FAIL继续保留。下一阶段须从本阶段最终HEAD接续，不提前启动TASK074。
