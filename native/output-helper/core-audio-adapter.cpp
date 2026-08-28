#include "frame-pump.hpp"
#include <CoreAudio/AudioHardware.h>
#include <type_traits>

// 只编译类型适配；此object永不链接进synthetic，不注册或打开设备。
namespace output {
struct HalContext { FramePump* pump; uint32_t frame_bytes; uint32_t channels; };
OSStatus halCallback(AudioObjectID, const AudioTimeStamp*, const AudioBufferList*, const AudioTimeStamp*, AudioBufferList* buffers, const AudioTimeStamp*, void* opaque) {
  auto* context = static_cast<HalContext*>(opaque);
  if (!context || !context->pump) return 0;
  if (!buffers || buffers->mNumberBuffers != 1 || !buffers->mBuffers[0].mData || buffers->mBuffers[0].mNumberChannels != context->channels || !context->frame_bytes || buffers->mBuffers[0].mDataByteSize % context->frame_bytes) { context->pump->stop(Reason::output_shape); return 0; }
  auto& buffer = buffers->mBuffers[0];
  context->pump->pull({static_cast<std::byte*>(buffer.mData), buffer.mDataByteSize}, buffer.mDataByteSize / context->frame_bytes);
  return 0;
}
static_assert(std::is_convertible_v<decltype(&halCallback), AudioDeviceIOProc>);
bool exactHalFormat(const AudioStreamBasicDescription& value, uint32_t rate, uint32_t channels, uint32_t bits, bool floating) noexcept {
  const auto flags = kAudioFormatFlagIsPacked | (floating ? kAudioFormatFlagIsFloat : kAudioFormatFlagIsSignedInteger);
  return value.mFormatID == kAudioFormatLinearPCM && value.mSampleRate == rate && value.mFormatFlags == flags && value.mChannelsPerFrame == channels && value.mBitsPerChannel == bits && value.mFramesPerPacket == 1 && value.mBytesPerFrame == channels * (bits / 8) && value.mBytesPerPacket == value.mBytesPerFrame;
}
}
