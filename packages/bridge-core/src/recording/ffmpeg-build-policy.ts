/** 经官方发布签名核对的源码；更新版本必须重新走构建和行为 Gate。 */
export const ffmpegBuildPolicy = {
  source: { version: '8.1.2', url: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz', sha256: '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c', signingFingerprint: 'FCF986EA15E6E293A5644F10B4322F04D67658D8' },
  libraries: [
    { id: 'libavcodec.62.dylib', name: 'libavcodec', version: '62.28.102' },
    { id: 'libavfilter.11.dylib', name: 'libavfilter', version: '11.14.102' },
    { id: 'libavformat.62.dylib', name: 'libavformat', version: '62.12.102' },
    { id: 'libavutil.60.dylib', name: 'libavutil', version: '60.26.102' },
    { id: 'libswresample.6.dylib', name: 'libswresample', version: '6.3.102' },
  ],
} as const;

export function ffmpegConfigureArgs(): string[] {
  return [
    '--prefix=/MusicBridgeFFmpeg', '--cc=clang', '--arch=arm64', '--target-os=darwin',
    '--disable-autodetect', '--disable-everything', '--disable-gpl', '--disable-nonfree', '--disable-version3',
    '--disable-network', '--disable-doc', '--disable-debug', '--disable-programs', '--enable-ffmpeg', '--enable-ffprobe',
    '--enable-shared', '--disable-static', '--disable-avdevice', '--disable-swscale',
    '--disable-audiotoolbox', '--disable-videotoolbox', '--disable-coreimage', '--disable-appkit', '--disable-avfoundation',
    '--enable-avcodec', '--enable-avformat', '--enable-avfilter', '--enable-swresample',
    '--enable-protocol=fd', '--enable-demuxer=wav,aiff,flac', '--enable-muxer=wav', '--enable-parser=flac',
    '--enable-decoder=flac,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f64le',
    '--enable-encoder=pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le',
    '--enable-filter=aresample,aformat,anull,pan,abuffer,abuffersink', '--install-name-dir=@rpath',
    '--extra-cflags=-mmacosx-version-min=13.0', '--extra-ldflags=-mmacosx-version-min=13.0 -Wl,-rpath,@executable_path/../lib',
  ];
}
