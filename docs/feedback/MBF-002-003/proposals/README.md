# 共享 journal 提案原字节

V2 已获调度 Root 的有限边界认可并替代 V1；它们仍未应用，不代表原 Owner 注册或 writer 验证通过。

两个 `.patch.gz` 为原 patch 的无损 gzip 保存。解压后逐字节等于外置 `checks/` 和 `checks/immutable-proposal-copies/` 的普通副本；对应 `.json` 中 `patchSha256` 针对解压字节，metadata 原样保留。存储压缩副本是因为原 unified diff 的合法上下文空白行会触发“新增文件”的 Git 空白检查；没有删除上下文、改变获批补丁或降低源码检查规则。

应用前将 gzip 解压到自己的外置任务目录，对照 metadata 的原 SHA、目标 `sourceSha256`、完整边界及 `git apply --check`。本文件不授权应用；共享实施仍由 V3.9 在调度安排的窗口中完成。
