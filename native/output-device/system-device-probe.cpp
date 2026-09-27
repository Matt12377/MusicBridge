#include "system-device-probe.hpp"
#include <CoreFoundation/CoreFoundation.h>
#include <array>
#include <cmath>
#include <limits>

namespace output::device {
struct SystemDeviceProbe::EventCell {
  std::atomic<uint64_t> value{1};
  void bump() noexcept {
    auto current = value.load(std::memory_order_relaxed);
    while (current < std::numeric_limits<uint64_t>::max()
      && !value.compare_exchange_weak(current, current + 1, std::memory_order_release, std::memory_order_relaxed)) {}
  }
};
namespace {
struct CFStringOwner {
  CFStringRef value = nullptr;
  ~CFStringOwner() { if (value) CFRelease(value); }
};
AudioObjectPropertyAddress address(AudioObjectPropertySelector selector, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  return {selector, scope, kAudioObjectPropertyElementMain};
}
template<typename T> bool readProperty(AudioObjectID object, AudioObjectPropertySelector selector, AudioObjectPropertyScope scope, T& out) noexcept {
  const auto property = address(selector, scope);
  UInt32 size = sizeof(T);
  return AudioObjectGetPropertyData(object, &property, 0, nullptr, &size, &out) == noErr && size == sizeof(T);
}
std::optional<PcmFormat> pcmFormat(const AudioStreamBasicDescription& stream, uint32_t channels, uint32_t sampleRate) noexcept {
  if (stream.mFormatID != kAudioFormatLinearPCM || stream.mSampleRate != sampleRate || stream.mChannelsPerFrame != channels
    || stream.mFramesPerPacket != 1) return std::nullopt;
  uint32_t sampleBytes = 0;
  std::optional<PcmFormat> format;
  if (stream.mFormatFlags == (kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked)
    && stream.mBitsPerChannel == 32) { format = PcmFormat::f32le; sampleBytes = 4; }
  else if (stream.mFormatFlags == (kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked)) {
    if (stream.mBitsPerChannel == 16) { format = PcmFormat::s16le; sampleBytes = 2; }
    else if (stream.mBitsPerChannel == 24) { format = PcmFormat::packed_s24le; sampleBytes = 3; }
    else if (stream.mBitsPerChannel == 32) { format = PcmFormat::s32le; sampleBytes = 4; }
  }
  if (!format || stream.mBytesPerFrame != channels * sampleBytes || stream.mBytesPerPacket != stream.mBytesPerFrame) return std::nullopt;
  return format;
}
}

SystemDeviceProbe::SystemDeviceProbe() : events_(new EventCell) {}
SystemDeviceProbe::~SystemDeviceProbe() {
  // Remove并不证明已投递的回调静止；EventCell保持进程寿命，由隔离helper的close封闭。
  while (subscriptionCount_) {
    const auto& sub = subscriptions_[--subscriptionCount_];
    AudioObjectRemovePropertyListener(sub.object, &sub.address, changed, events_);
  }
}
const std::atomic<uint64_t>* SystemDeviceProbe::eventEpoch() const noexcept { return &events_->value; }
OSStatus SystemDeviceProbe::changed(AudioObjectID, UInt32, const AudioObjectPropertyAddress*, void* opaque) noexcept {
  static_cast<EventCell*>(opaque)->bump(); return noErr;
}
bool SystemDeviceProbe::subscribe(AudioObjectID object, AudioObjectPropertySelector selector, AudioObjectPropertyScope scope) noexcept {
  if (subscriptionCount_ >= subscriptions_.size()) return false;
  const auto property = address(selector, scope);
  if (!AudioObjectHasProperty(object, &property)
    || AudioObjectAddPropertyListener(object, &property, changed, events_) != noErr) return false;
  subscriptions_[subscriptionCount_++] = {object, property}; return true;
}
bool SystemDeviceProbe::initialize(AudioObjectID device, AudioStreamID stream, std::string_view uid) {
  // 监听系统设备集合，但不读取其列表；只要所选设备短暂移除又恢复，代际仍锁存变化。
  if (subscriptionCount_ == 0 && !subscribe(kAudioObjectSystemObject, kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal)) return false;
  if (!subscribe(device, kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal)
    || !subscribe(device, kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal)
    || !subscribe(device, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal)
    || !subscribe(device, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal)
    || !subscribe(device, kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeOutput)
    || !subscribe(device, kAudioDevicePropertyStreams, kAudioDevicePropertyScopeOutput)
    || !subscribe(stream, kAudioStreamPropertyVirtualFormat, kAudioObjectPropertyScopeGlobal)
    || !subscribe(stream, kAudioStreamPropertyPhysicalFormat, kAudioObjectPropertyScopeGlobal)) return false;
  const auto variable = address(kAudioDevicePropertyUsesVariableBufferFrameSizes, kAudioDevicePropertyScopeOutput);
  if (AudioObjectHasProperty(device, &variable)
    && !subscribe(device, kAudioDevicePropertyUsesVariableBufferFrameSizes, kAudioDevicePropertyScopeOutput)) return false;
  selectedDevice_ = device; selectedStream_ = stream; selectedUid_.assign(uid); return true;
}
void SystemDeviceProbe::invalidate() noexcept {
  failed_ = true; previous_.reset(); events_->bump();
}
std::optional<DeviceObservation> SystemDeviceProbe::observeExact(std::string_view wantedUid) noexcept {
  const auto unavailable = [&]() -> std::optional<DeviceObservation> {
    invalidate(); return std::nullopt;
  };
  try {
    if (failed_ || wantedUid.empty() || wantedUid.size() > 128 || wantedUid.find('\0') != std::string_view::npos
      || (selectedDevice_ != kAudioObjectUnknown && wantedUid != selectedUid_)) return unavailable();
    if (subscriptionCount_ == 0 && !subscribe(kAudioObjectSystemObject, kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal)) return unavailable();
    CFStringOwner wanted{CFStringCreateWithBytes(kCFAllocatorDefault, reinterpret_cast<const UInt8*>(wantedUid.data()),
      static_cast<CFIndex>(wantedUid.size()), kCFStringEncodingUTF8, false)};
    if (!wanted.value) return unavailable();
    // HAL按精确UID翻译；不调用Devices列表或DefaultOutputDevice，也不设置任何属性。
    const auto translation = address(kAudioHardwarePropertyTranslateUIDToDevice);
    AudioObjectID device = kAudioObjectUnknown;
    UInt32 size = sizeof(device); CFStringRef qualifier = wanted.value;
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &translation, sizeof(qualifier), &qualifier, &size, &device) != noErr
      || size != sizeof(device) || device == kAudioObjectUnknown) return unavailable();
    const auto streams = address(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeOutput);
    UInt32 streamSize = 0;
    if (AudioObjectGetPropertyDataSize(device, &streams, 0, nullptr, &streamSize) != noErr || streamSize != sizeof(AudioStreamID)) return unavailable();
    AudioStreamID stream = kAudioObjectUnknown;
    if (AudioObjectGetPropertyData(device, &streams, 0, nullptr, &streamSize, &stream) != noErr
      || streamSize != sizeof(stream) || stream == kAudioObjectUnknown) return unavailable();
    if (selectedDevice_ == kAudioObjectUnknown) {
      if (!initialize(device, stream, wantedUid)) return unavailable();
    } else if (device != selectedDevice_ || stream != selectedStream_) return unavailable();
    const uint64_t observedEpoch = events_->value.load(std::memory_order_acquire);
    if (observedEpoch != 1) return unavailable();
    // 注册监听后重读精确翻译和核心属性；配置漂移即使后来恢复也不能消除事件锁存。
    AudioObjectID currentDevice = kAudioObjectUnknown;
    size = sizeof(currentDevice);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &translation, sizeof(qualifier), &qualifier, &size, &currentDevice) != noErr
      || size != sizeof(currentDevice) || currentDevice != device) return unavailable();
    AudioStreamID currentStream = kAudioObjectUnknown;
    streamSize = sizeof(currentStream);
    if (AudioObjectGetPropertyData(device, &streams, 0, nullptr, &streamSize, &currentStream) != noErr
      || streamSize != sizeof(currentStream) || currentStream != stream) return unavailable();
    CFStringOwner actual;
    if (!readProperty(device, kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, actual.value)
      || !actual.value || !CFEqual(actual.value, wanted.value)) return unavailable();
    const std::string uid(wantedUid);
    UInt32 alive = 0, bufferFrames = 0;
    Float64 nominalRate = 0;
    if (!readProperty(device, kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal, alive)
      || !readProperty(device, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, nominalRate)
      || !readProperty(device, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal, bufferFrames)
      || !std::isfinite(nominalRate) || nominalRate < 8000 || nominalRate > 384000 || std::floor(nominalRate) != nominalRate
      || bufferFrames < 1 || bufferFrames > 4096) return unavailable();
    const auto variableFrames = address(kAudioDevicePropertyUsesVariableBufferFrameSizes, kAudioDevicePropertyScopeOutput);
    if (AudioObjectHasProperty(device, &variableFrames)) {
      UInt32 variable = 0;
      if (!readProperty(device, kAudioDevicePropertyUsesVariableBufferFrameSizes, kAudioDevicePropertyScopeOutput, variable) || variable != 0) return unavailable();
    }
    const auto layoutProperty = address(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeOutput);
    UInt32 layoutSize = 0;
    if (AudioObjectGetPropertyDataSize(device, &layoutProperty, 0, nullptr, &layoutSize) != noErr
      || layoutSize < sizeof(AudioBufferList) || layoutSize > 1024) return unavailable();
    alignas(AudioBufferList) std::array<std::byte, 1024> layoutBytes{};
    UInt32 actualLayoutSize = layoutSize;
    if (AudioObjectGetPropertyData(device, &layoutProperty, 0, nullptr, &actualLayoutSize, layoutBytes.data()) != noErr
      || actualLayoutSize != layoutSize) return unavailable();
    const auto* layout = reinterpret_cast<const AudioBufferList*>(layoutBytes.data());
    if (layout->mNumberBuffers != 1 || layout->mBuffers[0].mNumberChannels < 1 || layout->mBuffers[0].mNumberChannels > 2) return unavailable();
    const uint32_t channels = layout->mBuffers[0].mNumberChannels, sampleRate = static_cast<uint32_t>(nominalRate);
    AudioStreamBasicDescription description{}, physical{};
    if (!readProperty(stream, kAudioStreamPropertyVirtualFormat, kAudioObjectPropertyScopeGlobal, description)
      || !readProperty(stream, kAudioStreamPropertyPhysicalFormat, kAudioObjectPropertyScopeGlobal, physical)) return unavailable();
    const auto pcm = pcmFormat(description, channels, sampleRate);
    const auto physicalPcm = pcmFormat(physical, channels, sampleRate);
    // 不允许HAL在IOProc与硬件之间隐式转换；两种ASBD所有实质字段必须一致。
    if (!pcm || !physicalPcm || *pcm != *physicalPcm || description.mFormatFlags != physical.mFormatFlags
      || description.mBytesPerFrame != physical.mBytesPerFrame || description.mBytesPerPacket != physical.mBytesPerPacket
      || description.mBitsPerChannel != physical.mBitsPerChannel) return unavailable();
    if (events_->value.load(std::memory_order_acquire) != observedEpoch) return unavailable();
    Snapshot current{uid, device, stream, sampleRate, channels, *pcm, *physicalPcm, bufferFrames, alive != 0, true};
    if (previous_ && *previous_ != current) return unavailable();
    previous_ = current;
    return DeviceObservation{uid, device, observedEpoch, sampleRate, channels, *pcm, *physicalPcm, bufferFrames, alive != 0, true};
  } catch (...) { return unavailable(); }
}
}
