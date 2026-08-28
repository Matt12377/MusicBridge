# TASK-071 执行进度

基线72db8616ddbb461b93e9ffa960576af052c2bdf6，独立codex/task-071-source-picker。TASK070最终本地Gate通过且clean。新树身份与native13核对通过，remote main未变/071远端不存在。三模块TDD开发中；未测试通过、未验收、无push。证据目录reports/runtime/task-071-source-picker/。

## 根集成RED

真实Vue setup测试3/3 RED：缺五类工作事实、源面板迟到覆盖另一草稿、读取失败继续使用旧源snapshot。实际基线Electron两场景先因草稿卡片包含副标题而精确accessible-name定位失败（不算功能RED）；仅修测试定位后2/2真实RED：240无空格长名撑出内容、缺下一步区域。生产开始接共享facts代际与必要h3换行。旧失败与截图目录保留，非最终Gate。

## 初始验证与规格第1轮

初始统一verify exit0：Contracts118/Core897/Desktop382，类型与生产build通过；并非最终候选。完整新场景初跑5/7：两库照片helper未先建立首图可视前提，修后独立真实场景通过；合成源路径使用macOS临时目录别名，改为realpath后正式源绑定和双布局冻结通过，Core授权边界不改。原失败产物保留。

独立交叉SPEC1：Picker范围无确认缺口；非Picker两项需修正：主CTA没有传显式历史上下文给旧面板，媒体候选照片无安全重试入口。扩展任务允许路径，下一步作者先9/9行为RED后实现三工具可选initial上下文，root接传参、旧手动入口清除上次参数。root上下文行为RED4pass/1fail→GREEN5/5。

真实多规划E2E继续发现父页triggerRef维持同一个mutable state引用，子组件computed没有失效，导致选择上下文CTA存在但fieldset未渲染。新增root引用传播RED5pass/1fail；onChange发布浅快照新引用后6/6GREEN。真实Electron仍待新build验证。第二轮SPEC、QUALITY与最终完整Gate均未完成，不把初始绿色计为最终验收。

## 修正候选验证

根集成6/6、三面板9/9、桌面类型、生产build均exit0。新真实Electron focused7/7通过（14.7秒），实际两条冻结布局选择旧布局并进入正确执行面板；媒体/母版工具均承接指定规划。两个尺寸的长名、照片、上下文与关系场景通过溢出/键盘/限定区域axe断言，截图在focused产物中，待root最终逐张目视。

候选SPEC2：22代码/测试/config文件，fingerprint `3f7abf0d845f8782743200675899952c3d22f846ecd46e282e019ac15b1fe929`。第二轮独立交叉规格审查中；完整verify运行中。control/boundaries/cycles已exit0（cycles199文件），e2e-types exit0。未进行QUALITY或最终报告封版。

## 完整回归首跑与审查

SPEC2两交叉范围PASS、22hash一致，进入QUALITY1。canonical verify生产候选exit0：118/897/393；安全27/27。首次完整E2E开启native，71/73通过（新TASK071七项全通过）。两个旧照片场景在冷启详情/添加单盘照片之后未把照片区域滚入近视范围，就等待图片或一次失败状态；原错误和产物保留于e2e-full-first。等待QUALITY1结束后补旧测试可视前提，不改延迟加载产品行为、不删业务断言。

root已逐张查看该次完整运行TASK071的12张截图，记录visual-full-first-observation；720视口采用垂直滚动，不声称单张截图包含全部内容。最终完整重跑、Electron、安全与候选身份仍分别记录。

## QUALITY1修正

独立交叉QUALITY1确认一项P2：旧的固定工具入口focus在新CTA路线关闭后抢焦点。根复现：实际Electron焦点断言失败；集成测试6pass/2fail。五个工具统一记录实际触发者，刷新完成检查同代、连接状态、用户键盘/指针交互及当前焦点，卸载清理临时监听；改后8/8GREEN。两旧照片仅补实际photo滚入视口，原产品未改，原生导入/冷启和单盘失败恢复均在旧生产候选上PASS。最终焦点界面及完整回归待新构建。

修复后focused9/9通过：新7场景、旧原生照片导入/重启、旧单盘照片失败/恢复。显式检查执行、母版和媒体工具关闭后焦点回到主CTA；实际Root集成覆盖全部五工具和迟到交互/切草稿隔离。长标题截图额外把标题滚入视口，原布局与无障碍断言不减。

QUALITY2冻结22file，fingerprint `6c6e37dae6c85e35882fffe084c962b1e34ec949b65f1ecb76c4564f2ca4bf08`，最后有界复核中，无第三轮。统一verify重跑中；远端main仍90d0aa8aa7f156c6ecfc6f366eea698f8e4d6098，TASK071远端不存在。

## 安全Gate阻断：暂不封版

最终QUALITY2两范围PASS且22hash一致；但最终canonical verify exit1：118/897/394of395，唯一失败为既有command-outbox-store跨进程排他测试，第二进程返回unexpected而非OUTBOX_UNAVAILABLE。源实现和旧测试的Git blob与TASK070最终基线相同；不据此免除风险，也不把旧验证绿色替代本次失败。停止封版，根因调查仅限合成测试，区分Main连接生命周期/测试持有和实际锁行为；不改安全实现、不静默重跑PASS。

## Gate夹具根因已证实，恢复验证

独立WeakRef/FinalizationRegistry与6轮显式GC对照：仅保活进程的weak owner被回收，竞争进程可打开；global强引用owner保持可达时竞争者拒绝，SIGKILL后才恢复。原全量失败当时未采集GC事件，因此不谎称直接观察了当时GC；同一正式store可单变量复现相同症状。

root进一步在原既有测试加入6轮GC即稳定复现0/1 RED（unexpected）；只添加到SIGKILL前的全局强引用后整文件22/22GREEN。正式Main通过模块级service和IPC闭包持有store；本轮不改任何锁实现，仅修正fixture持有语义，并保留原第二进程拒绝、实际SIGKILL与uncertain恢复断言。root将该额外测试文件纳入最终允许路径和23file候选；作为最终Gate根因裁决，不开第三轮SPEC/QUALITY。完整verify重新执行，旧失败独立保留。

最终统一verify已重新exit0：118/897/395，类型及生产build通过；安全27/27、Electron4/4重新通过。Electron Gate之后再次恢复生产构建exit0，完整73E2E开启固定native执行中。最后control/boundaries/cycles199全部exit0。不得将运行中E2E提前记为通过。

## 最终自动Gate

最终verify118/897/395、安全27、Electron4、完整E2E73/73（native开启零skip）、类型/build/control/boundaries/cycles199全部exit0。23code+13native一致，最终12截图逐张查看，产物移动保留final-e2e-artifacts。实施/报告/封版提交与清洁身份将在STATUS及final-closeout锁定；F01与Owner保持未完成。
