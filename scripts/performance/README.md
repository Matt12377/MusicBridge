# MBP-001 合成性能结构基线

此脚本直接调用当前生产模块，用合成输入和 Fake SDK 观察工作量。它不连接账号、Provider、Roon、设备，不读取用户配置、媒体或资料，也不构建或启动 Electron。结构计数不能作为真实 Roon 耗时或真实听感证据。

脚本覆盖：

- 真实 `usePlaybackSession` 与 `collectRoonPlaybackContext`：250 条上下文、首屏 24 条，闸住第一个剩余页后观察播放是否已派发，释放后记录所有分页与播放的顺序。
- 真实 Roon Library + Fake Browse SDK：专辑、艺人、歌单各 250 条，实际请求首屏 24 条，记录首屏返回前的 SDK load 调用和读取数量。
- 真实 `createPlaybackEventPublisher`：50、500、5000 条合成队列，各发送两个进度 tick，记录事件数量及实际 JSON 序列化后的 UTF-8 字节估计。该值不代表 Electron IPC structured-clone 的真实字节数。
- 重复出现与多碟：观测同引用的既有合并行为、不同引用的重复曲保留，以及多碟曲目的 Disc/Track/sourceIndex/出现路径身份；脚本不改变这些语义。

JSON 保存当前 Git SHA、工作区是否脏、四个被测源码文件的 SHA-256 指纹、脚本和 contracts dist 身份、Node 版本及未测项。脚本只读取 Git 身份和状态，不执行 Git 写入。若运行中源码变化，`sourceStableDuringRun` 为 false，应在源码稳定后使用新目录重跑；旧结果仍保留。

使用已安装的 Node 22.23.2 和 pnpm 10.17.1 工作区依赖。只需要已有的 contracts dist，不运行全量构建。输出必须位于已挂载且可写的外置 LifeWeave；父目录必须已存在，已有结果文件不会被覆盖。

```zsh
(
  [[ -d /Volumes/LifeWeave && -w /Volumes/LifeWeave/Developer/CommandLine/tmp \
    && $(stat -f %d /Volumes/LifeWeave) != $(stat -f %d /Volumes) ]] || exit 1
  cd /Volumes/LifeWeave/VSCode/MusicBridge/apps/desktop || exit 1
  MBP_BASELINE_DIR=$(mktemp -d /Volumes/LifeWeave/Developer/CommandLine/tmp/mbp-001-baseline-XXXXXX) || exit 1
  MBP_NODE=/Users/yihe/.nvm/versions/node/v22.23.2/bin/node
  env TMPDIR=/Volumes/LifeWeave/Developer/CommandLine/tmp \
    DEV_BUILD_ROOT=/Volumes/LifeWeave/Developer/CommandLine \
    DEV_CACHE_ROOT=/Volumes/LifeWeave/Developer/CommandLine/Caches \
    "$MBP_NODE" --import tsx ../../scripts/performance/baseline.ts \
    --output "$MBP_BASELINE_DIR/baseline.json"
)
```

场景按串行顺序执行。退出码 0 表示场景执行完成且 JSON 已保存；不表示已经达成优化目标。当前首次基线用于记录实施前行为，后续任务可以用同一脚本比较实际结构变化。
