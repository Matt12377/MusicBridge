# MBM-003 FLAC无损与DSD兼容传输

从002成对软件封存后的最终Mac审计HEAD `b1a8de728086e7994bb69d7dee10782f646886dd` 建立独立分支 `codex/mbm-003-lossless-dsd-transport`。前序固定Source7ec8和直接软件报告d518不被运行审计替代；原真实carryover继续。

本任务消费2026-10-10 Owner精确4578字节决定：仅DSD在Mac整曲转换为24-bit/48kHz PCM后编码FLAC，置于独立限额缓存。首次整曲有效后播放，后续复用；原文件和标签不变。其它格式保持既定策略，FLAC至少24-bit/192kHz，保留16/24-bit和24/44.1矩阵。保留seek、Range、renew、release和缓存限额，首版无多档或动态切换。

先冻结真实可审阅合同与processing语义，再双端实现。Root是公开合同唯一作者，现有三作者按Scope独占文件，Root独占Git、编译、测试、App和冻结跨任务接点。范围、前序交付和当前候选合同分别见 `EXECUTION_SCOPE.json`、`PREDECESSOR_DELIVERY.json` 与 `CONTRACT_SEMANTICS_DRAFT.md`。

新产品Source必须取得适用新鲜Gate和首次自然CI；独立结果报告R及普通远端身份分别核实。纯任务记录复用002已通过精确Source/R，不重跑其build/装机/听感。实际手机播放、拖动和断线恢复单列，物理输出不得用来源或传输规格代替。004尚不启动。
