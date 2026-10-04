# RUST-015 历史局部片段冻结

这些是原失败候选的局部事件证据，共4片段、74完整事件。它们不是本轮 App / 新签包 / 真实服务 / 完整 RUST-015 PASS。

`provenance.json` 固定 raw SHA、完整raw字节/事件数、原数组indices与选择算法。`extract-historical-fragments.py` 先核两个完整raw SHA，再只复制原事件对象，不改字段、序号、PID、时钟或顺序。新clone与CI只消费本目录相对文件；重新提取只能读原外置存档并输出到新外置目录，不能覆写冻结片段。

| 源 | 原raw SHA256 | 片段 |
| --- | --- | --- |
| 05 | `03ed7e49782d32c422da6d6d8ec653442862b48f830610f743fd3119391026ef` | 原action全部47事件；两次reset各6事件 |
| 08 | `4cf19b78de49a243b425bcf56a67d6ceea3bdaf287568e4b91e0555001f2b4c5` | 原首次settings-open的15事件 |

`historical-raw-build-provenance.json` 保留原preparation、可执行文件前/后SHA与相关源文件摘要；`rust016-historical-manifest-proof.json` 记录全部05/1169与08/1170原排序源entries的摘要重算。算法来自原producer：逐entry UTF8 `path + NUL + sha256 + LF` 拼接后SHA256。05源摘要为 `9fa9588818a0aa9a806cf32f3fd479530017b1feb83c56a2d13e3fd7438a214d`；08为 `12661b7e0723c1d137b8ada2a0b292bca45c7f9ac62f4b7ea84b84c502d8470c`。原 `sourceCommit=906a3841...` 只是dirty构建所处HEAD定位；真实构建身份由字节manifest绑定，不能宣称该Git commit与构建源码精确相同。

Source05保持三次24-limit目录读、两次paint、两次背景limit1、空query/brand、零warm及原reset消费者/三filter负例。Historical loader核固定字节SHA及封套；不能强行用当前事件parser给旧schema补字段。

Source08原indices111～124、149按原数组顺序；settled无 `settingsStatusSelection` 且paint为零，后面原renderer事件为discarded。main/renderer各有自己的sequence，不能跨actor用main62与renderer22比较先后。历史对象继续被原settings消费者拒绝；当前合法 `settingsFixture()` 单独先通过，再只加同代际discarded，精确拒绝消息证明该新负例原因。
