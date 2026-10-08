# MBRS-013 实施交接

从已封存的012最终报告 `c5c36c2c3e327b5068b5ad15ca6c251c5aeb4478` 接续独立分支 `codex/mbrs-013-relocation`。012源码 `7166e12d7474957041f5d747db5dc9300f7e9ee7` 的首次自然四workflow/六job、报告首次自然两workflow/三job及实际report-only模式均成功，最终私有交付收据已实际完成。012九AT仍PARTIAL，真实层和全部原失败保留；没有第三个012自封口提交。

本轮常规开发、验证、提交和推送沿Owner已有持续授权执行，不再次索取逐步审批。范围与预算见 EXECUTION_SCOPE.json，规则见 RULE_MATRIX.json；原八AT正文保留在 tasks/MBRS-013_LOCAL_RELOCATION.md。此进场记录不是测试结果。

## 首个实现闭环

由原catalog作者进行跨逻辑根的同内容位置CAS，保留Asset/TrackID、file/selection revision、片段和历史引用。通过原Scanner真实Reader与Parser取得新位置观察，在原Owner同DB短同步事务产生新job/batch、receipts、checkpoint和current file state；本域journal与位置事实一起提交后发布缓存。叶服务不取得raw DB、不自行插Scanner私有表，不复制旧job事实。

保留实际物理和命名写claims期间，只有原Publisher发出的不可伪造、绑定目标FD和映射的读能力能够进入原Reader。原公开MetadataReader与普通播放继续执行busy保护；不允许通用ignoreBusy、提早解锁或伪造quiet。Root单写Scanner、catalog、Owner与Reader共享接点，三位既存作者只写 EXECUTION_SCOPE.json 所列互斥路径；接口需要共同调整时先交Root串行。所有构建、测试、App、媒体工具和Git由Root执行。

## 文件、复制与恢复

013整文件移动以全部原字节与目标独立FD全流Hash一致为条件，普通可读FLAC无需满足012标签writer白名单。资源闭集包括音频及实际引用的CUE、歌词、图片和清单，完整集合参与Hash、授权、claims、I/O和journal；未知或共享引用没有证明时明确阻断，不截断计划。

同卷捕获与无覆盖安装明确非原子，保留必要材料及实际阶段。跨卷先COPY、sync、完整校验、登记新位置；源默认保留，之后只有新鲜具体Main cleanup授权及真实身份、Hash、修订、保护复核允许处理精确原源。冷恢复只读对账，不自动重放原command、自动去重或删除。底层卷/共享身份须有OS实际证明，不能用挂载名或仅dev/inode代替。

## 验证顺序与边界

先运行新013的合同、真实文件和同Owner持久闭环，再验证新Gateway FD取完整原bytes、旧lease拒同名替代、活动lease延期、冷重开与两根实际增量不双登记。随后覆盖大小写/Unicode/根/符号链接/卷替换、伴随闭集、复制和故障恢复、原历史/Frozen与实际生产Electron交互。新夹具独立，原012预算、014四十九冻结输入、旧断言与Loader/worker生命周期保持。

原八AT的软件、生产App、真实多卷/NAS、live Roon、设备/听感与Owner接受单独记录。没有真实Roon结果时02不能升为通过；真实多卷缺环境按原规格carryover。后续按 Owner 已确认的新顺序执行：013→MBM-000～004→016→017。MBM-000 先核正式 Mac 合同、鉴权和 iOS 适配；MBM-002 使用真实 iPhone，MBM-003 保留无损 FLAC 门槛。移动端前置计划见 ../MOBILE_FRONTLOADING_PLAN_2026-10-08.md；015取消及原18/156、有效17/150保持。
