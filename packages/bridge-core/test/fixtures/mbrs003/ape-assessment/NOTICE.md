# APE 合成夹具来源与证据边界

本目录仅保存 OxideAV/oxideav-ape 作者测试工程的完整 `silence_mono8k.ape` 合成静音样本，174 字节；没有用户音乐、第三方歌曲或参考编码器程序。

- 作者仓库：https://github.com/OxideAV/oxideav-ape
- 作者相对路径：`tests/fixtures/silence_mono8k.ape`
- 固定 tree SHA：`ea6e8ca2848b18716a49ca6de0fe4d8d26d4893a`
- 固定 Git blob SHA1：`1591dafc45d63e2136029e8d760d97dd1f7d4989`
- 固定 blob 来源：https://api.github.com/repos/OxideAV/oxideav-ape/git/blobs/1591dafc45d63e2136029e8d760d97dd1f7d4989
- 字节 SHA256：`e49c9f3a28587d9f10644d64a72e047432249a8b3a8ff34f2c8f61fe4c07ba1c`

作者 `tests/vendor_fixtures.rs` 说明：Monkey’s Audio 参考控制台编码器 v13.18（file version 3990）对为该测试工程生成的 PCM 输入作黑盒完整编码，本样本为 level 1000、0.2 秒、单声道 8kHz 静音；作者的完整解码测试固定 PCM 3200 字节及 CRC32 CB7B98A6。作者源码与完整 MIT 原文已由 Root 保留，身份见 manifest；本候选未下载或运行作者工程、参考编码器或解码器。

## 版权与许可

Copyright (c) 2026 Karpelès Lab Inc.

本目录 `LICENSE-MIT.txt` 是 Root 获取的仓库完整 MIT 原文，逐字节保留。对作者工程自行生成测试夹具的 MIT 适用属于仓库许可与来源的推断：同一 tree 未观察到夹具单独许可条目；不宣称额外法律确认，也不宣称任何第三方音乐许可。完整版权、授权和免责条款随夹具一并保留。

## 独立完整性证据与产品评估

Root 已在一次有限本机评估中用已有 ffprobe 与 ffmpeg 校验该固定样本：两命令均退出 0，PCM 为 3200 字节，SHA256 `5a312281df4bd8dfbb4d4a94ad0bf44d01bb8cfced1206b90e21b4ca0568cdb1`，CRC32 CB7B98A6。原始收据与 Gate 身份在 manifest 引用；这个既有 Root 结果和作者源码证据各自记录，不由本测试重新执行。

新评估仅调用未改预算的默认 MetadataReader、真实已编译 Worker 和原 SourceStore 只读 FD/lease，期待明确 UNSUPPORTED，并核实际 worker-exit、FD EBADF、私有读取许可归还及夹具原 SHA 保持。真实 ScanReadAdmission 用固定 quiet 测试输入提供票据，未接真实 Controller/Gateway 的媒体繁忙信号，不视为 Scanner、Owner 通路或优先级负载验证。测试中的短夹具 SHA/Git blob 核验仅用于来源身份，不宣称产品执行全音频哈希、解码、标签或封面支持。
