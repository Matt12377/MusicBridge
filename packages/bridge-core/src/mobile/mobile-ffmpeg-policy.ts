/** 独立 mobile 后端，不继承录音 converter 的容器或进程策略。 */
export const MOBILE_FFMPEG_SOURCE_SHA256 = '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c';
export const MOBILE_FFMPEG_VERSION = '8.1.2';
export const MOBILE_DSD_RECIPE = 'MBM003_DSD_PCM_S24_48000_FLAC_V1';
export const MOBILE_FFMPEG_CONFIGURE_SHA256 = '0fa7b89df2a10af5d8379a051372a4bd76260718a88176c043f47b0a479c7cec';
export const MOBILE_FFMPEG_DECODERS = Object.freeze(['dsd_lsbf', 'dsd_lsbf_planar', 'dsd_msbf', 'dsd_msbf_planar', 'flac']);
export const MOBILE_FFMPEG_DEMUXERS = Object.freeze(['dsf', 'iff', 'flac']);
export const MOBILE_FFMPEG_ENCODERS = Object.freeze(['flac', 'pcm_s24le']);
export const MOBILE_FFMPEG_MUXERS = Object.freeze(['flac', 'null', 's24le']);
export const MOBILE_FFMPEG_DEPENDENCIES = Object.freeze(['libavcodec.62.dylib', 'libavfilter.11.dylib', 'libavformat.62.dylib', 'libavutil.60.dylib', 'libswresample.6.dylib']);

/** fd: 配合 -fd 3/4 指定只读源和新 owned 输出；不接收路径、URL、滤镜或声道参数。 */
export function mobileDsdConversionArguments(container: 'dsf' | 'dff'): readonly string[] {
  return Object.freeze(['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
    '-threads', '1', '-protocol_whitelist', 'fd', '-f', container === 'dsf' ? 'dsf' : 'iff', '-fd', '3', '-i', 'fd:',
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-ar', '48000', '-sample_fmt', 's32',
    '-c:a', 'flac', '-bits_per_raw_sample', '24', '-threads', '1', '-f', 'flac', '-fd', '4', 'fd:']);
}
/** 完整解码流只计数/丢弃，不在内存留整首 PCM；实际退出与样本数都是准入条件。 */
export const MOBILE_DSD_VERIFY_ARGUMENTS = Object.freeze(['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror',
  '-err_detect', 'explode', '-threads', '1', '-protocol_whitelist', 'fd', '-f', 'flac', '-fd', '3', '-i', 'fd:',
  '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'pcm_s24le', '-threads', '1', '-f', 's24le', '-fd', '1', 'fd:']);
