# MBM-000 移动合同双端采纳结果

本任务完成40个既有移动操作的唯一权威合同、五份纯DTO/codec、完整HTTP样例及独立行为Gate。Mac精确修复Source为`579d0c3097a0cd78290467cf9b073819989826fd`，唯一父为首个Source `d980de9037b5d7cc1df402b3638072cd3514a1f0`，完整任务基线为013最终报告`d3174bce575aa817b27ba05d39a40d3050b77be4`；iOS已交付Source `bc72069f73e342479190beda7f230b79ea91d9f0`和独立报告`8ba6b9777b67d23dc89cc1edca7412e128398256`。两端实际整份合同均为145918字节、SHA256 `ee79461bf672e78c4ac29945d794e46286c92b0f909ced85bc4534a8a6de57bb`。

首个Source `d980de9037b5d7cc1df402b3638072cd3514a1f0` 的首次自然CI两处失败原样保留于 `docs/postrust/MBM-000/evidence/first-source-ci-failure.json`。本轮只修同一首页独立探针时序、原013 Core组文件并发及新helper输入图，未改变原清单、断言、限时、canonical或下一任务范围。下面的成功CI仅指新Source `579d0c3097a0cd78290467cf9b073819989826fd` 的首次自然push，不覆盖旧失败、不使用CI重跑。

## 实际验证

- Mac提交后fresh build、types、四个显式行为文件三阶段自然退出0，33/33、零fail/skip/cancel/todo。431个声明输入已与Source完整Git blob核对；222个编译输出、其中五移动模块的15个编译件和四份实际消费回执完整复核。
- 60个schema、128个schema样例（其中24个负例）、196份完整HTTP材料分别记录，不充当行为测试数。声明工具依赖按实际直接使用范围记录，不宣称完整传递依赖闭包。
- Source首次自然push触发四个workflow、六个job全部成功；完整job日志、五份真实artifact ZIP整份digest与声明内容已消费，细项见`source-ci-readback.json`和`source-artifact-readback.json`。
- 远端目录扫描共434个输入行：431份Git源码与本地整对象相同，另3份为此前Python执行生成的缓存，未上传缓存正文，未宣称独立缓存字节复核。远端阶段raw与contracts编译文件按既有上传规则排除，实际制品消费只证明已上传内容；本地精确Source三段raw和222份fresh输出另有完整证据。
- iOS作者执行137个不同Swift用例、零fail/skip；49个schema正例和70个负例另计。347个Source输入、Mock和Production两次未签名generic Simulator构建已核，原报告与实际证据逐份匹配，普通远端exact报告且当时工作树clean。iOS GitHub CI未执行。

## 提交与封存

本文件属于独立报告R，其唯一父必须为上述Source。报告自身SHA由提交后的真实Git解析，不制造自引用SHA或第三个封存提交。报告首次自然CI、普通push后的remote exact和clean尚待执行；最终成对交付与MBMAT-000-07只在外置最终收据实际通过后成立。MBMAT-000-01至06软件层已通过；Source内此前pending快照原样保留，R只追加记账与结果证据。

R不得改合同、样例、源码、冻结任务、预算或既有验收状态。下一MBM-001从本R最终HEAD创建，常规开发、必要验证、提交和普通推送继续沿用已有授权。

## 保留的验收缺口

当前证明合同软件与客户端采纳；移动服务、Mac正式App运行、iOS真实UI、真实Provider/Roon/NAS、音频、物理设备和Owner验收未运行。原18任务/156 AT、有效17/150整对象不变；013八项继续PARTIAL，015六项继续Owner取消N_A。真实媒体读取、播放与无损交付依序在001至004实施，随后016综合回归与017最终交付；历史真实层缺口不以本次合同测试抵扣。

本地准备阶段021空body准入、029时间戳表示和033独立预期对象原型的失败记录保留；最终Source Gate均已自然通过。全工作区024候选结果不能冒充本Source结果，Source结论只使用本次真实CI。
