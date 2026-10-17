/** CUE独立输出配方。原录音及移动DSD配方保持各自资格。 */
export const CUE_FFMPEG_VERSION = '8.1.2' as const
export const CUE_FFMPEG_SOURCE_SHA256 = '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c'
export const CUE_FFMPEG_SIGNING_FINGERPRINT = 'FCF986EA15E6E293A5644F10B4322F04D67658D8'
export const CUE_NATIVE_SOURCE_INPUTS = Object.freeze([
  { id: 'ffmpeg', version: '8.1.2', archive: 'ffmpeg-8.1.2.tar.xz', directory: 'ffmpeg-8.1.2', bytes: 11710924, sha256: CUE_FFMPEG_SOURCE_SHA256,
    url: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz', license: 'LGPL-2.1-or-later', authenticity: 'fixed-sha256-and-official-pgp-fingerprint', legal: ['COPYING.LGPLv2.1', 'LICENSE.md'] },
  { id: 'ogg', version: '1.3.6', archive: 'libogg-1.3.6.tar.xz', directory: 'libogg-1.3.6', bytes: 439952, sha256: '5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061',
    url: 'https://downloads.xiph.org/releases/ogg/libogg-1.3.6.tar.xz', license: 'BSD-3-Clause', authenticity: 'official-published-sha256', legal: ['COPYING', 'AUTHORS'] },
  { id: 'vorbis', version: '1.3.7', archive: 'libvorbis-1.3.7.tar.xz', directory: 'libvorbis-1.3.7', bytes: 1203792, sha256: 'b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b',
    url: 'https://downloads.xiph.org/releases/vorbis/libvorbis-1.3.7.tar.xz', license: 'BSD-3-Clause', authenticity: 'official-published-sha256', legal: ['COPYING', 'AUTHORS'] },
  { id: 'opus', version: '1.6.1', archive: 'opus-1.6.1.tar.gz', directory: 'opus-1.6.1', bytes: 10472813, sha256: '6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1',
    url: 'https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz', license: 'BSD-3-Clause', authenticity: 'official-published-sha256', legal: ['COPYING', 'AUTHORS'] },
  { id: 'lame', version: '4.0', archive: 'lame-4.0.tar.gz', directory: 'lame-4.0', bytes: 1496810, sha256: '3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb',
    url: 'https://downloads.sourceforge.net/project/lame/lame/4.0/lame-4.0.tar.gz', license: 'LGPL-2.0-or-later', authenticity: 'official-https-first-observed-sha256', legal: ['LICENSE', 'COPYING'] },
] as const)
export const CUE_FFMPEG_LIBRARIES = Object.freeze([
  { id: 'libavcodec.62.dylib', name: 'libavcodec', version: '62.28.102' },
  { id: 'libavfilter.11.dylib', name: 'libavfilter', version: '11.14.102' },
  { id: 'libavformat.62.dylib', name: 'libavformat', version: '62.12.102' },
  { id: 'libavutil.60.dylib', name: 'libavutil', version: '60.26.102' },
  { id: 'libswresample.6.dylib', name: 'libswresample', version: '6.3.102' },
  { id: 'libogg.0.dylib', name: 'libogg', version: '1.3.6' },
  { id: 'libvorbis.0.dylib', name: 'libvorbis', version: '1.3.7' },
  { id: 'libvorbisenc.2.dylib', name: 'libvorbisenc', version: '1.3.7' },
  { id: 'libopus.0.dylib', name: 'libopus', version: '1.6.1' },
  { id: 'libmp3lame.0.dylib', name: 'libmp3lame', version: '4.0' },
] as const)
export const CUE_FFMPEG_CONFIGURE = Object.freeze([
  '--prefix=/MusicBridgeCue', '--cc=clang', '--arch=arm64', '--target-os=darwin', '--pkg-config=/opt/homebrew/bin/pkg-config',
  '--disable-autodetect', '--disable-everything', '--disable-gpl', '--disable-nonfree', '--disable-version3',
  '--disable-network', '--disable-doc', '--disable-debug', '--disable-programs',
  '--enable-ffmpeg', '--enable-ffprobe', '--enable-shared', '--disable-static',
  '--disable-avdevice', '--disable-swscale', '--disable-audiotoolbox', '--disable-videotoolbox',
  '--disable-coreimage', '--disable-appkit', '--disable-avfoundation',
  '--enable-avcodec', '--enable-avformat', '--enable-avfilter', '--enable-swresample',
  '--enable-libmp3lame', '--enable-libvorbis', '--enable-libopus',
  '--enable-protocol=fd', '--enable-demuxer=flac,mp3,ogg,wv,wav,aiff,mov,ape,tta,mpc,mpc8,tak',
  '--enable-muxer=flac,mp3,ogg,wv,wav,aiff,ipod,null,pcm_s16le,pcm_s24le,pcm_s32le',
  '--enable-parser=flac,mpegaudio,opus,vorbis,tak',
  '--enable-decoder=flac,alac,mp3float,vorbis,opus,wavpack,ape,tta,mpc7,mpc8,tak,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be',
  '--enable-encoder=flac,alac,libmp3lame,libvorbis,libopus,wavpack,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be',
  '--enable-filter=aresample,aformat,anull,atrim,asetpts,pan,abuffer,abuffersink',
  '--install-name-dir=@rpath', '--extra-cflags=-mmacosx-version-min=13.0',
  '--extra-ldflags=-mmacosx-version-min=13.0 -Wl,-rpath,@executable_path/../lib',
] as const)
/** 独立CUE输入闭集；新增解码不增加公开输出编码或网络协议。 */
export const CUE_INPUT_DEMUXERS = Object.freeze(['wav', 'aiff', 'flac', 'mp3', 'ogg', 'wv', 'mov', 'ape', 'tta', 'mpc', 'mpc8', 'tak'] as const)
export const CUE_NATIVE_STAGE_MS = 180000
export const CUE_NATIVE_WHOLE_MS = 480000
export const CUE_NATIVE_RAW_BYTES = 16 * 1024 * 1024
export const CUE_NATIVE_FORMATS = Object.freeze([
  { id: 'flac', codec: 'flac', encoder: 'flac', decoder: 'flac', extension: 'flac', muxer: 'flac', lossless: true },
  { id: 'alac', codec: 'alac', encoder: 'alac', decoder: 'alac', extension: 'm4a', muxer: 'ipod', lossless: true },
  { id: 'mp3', codec: 'mp3', encoder: 'libmp3lame', decoder: 'mp3float', extension: 'mp3', muxer: 'mp3', lossless: false },
  { id: 'vorbis', codec: 'vorbis', encoder: 'libvorbis', decoder: 'vorbis', extension: 'ogg', muxer: 'ogg', lossless: false },
  { id: 'opus', codec: 'opus', encoder: 'libopus', decoder: 'opus', extension: 'opus', muxer: 'ogg', lossless: false },
  { id: 'wavpack', codec: 'wavpack', encoder: 'wavpack', decoder: 'wavpack', extension: 'wv', muxer: 'wv', lossless: true },
  { id: 'pcm-wav', codec: 'pcm-wav', encoder: 'pcm_s24le', decoder: 'pcm_s24le', extension: 'wav', muxer: 'wav', lossless: true },
  { id: 'pcm-aiff', codec: 'pcm-aiff', encoder: 'pcm_s24be', decoder: 'pcm_s24be', extension: 'aiff', muxer: 'aiff', lossless: true },
] as const)
