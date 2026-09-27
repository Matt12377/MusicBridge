#pragma once

#include "device-session.hpp"
#include <array>
#include <cstddef>
#include <optional>
#include <string>

namespace output::device {
/**
 * 只按显式UID读取HAL属性；不枚举、不读取默认输出，也不更改设备配置。
 * generation是本helper进程内观测代际，不是Gate B证书字段；进程重建后须重新观测。
 */
class SystemDeviceProbe final : public DeviceProbe {
 public:
  SystemDeviceProbe();
  ~SystemDeviceProbe() override;
  std::optional<DeviceObservation> observeExact(std::string_view uid) noexcept override;
  const std::atomic<uint64_t>* eventEpoch() const noexcept override;
 private:
  struct EventCell;
  struct Subscription { AudioObjectID object; AudioObjectPropertyAddress address; };
  struct Snapshot {
    std::string uid;
    AudioObjectID device;
    AudioStreamID stream;
    uint32_t sampleRate, channels;
    PcmFormat format, physicalFormat;
    uint32_t bufferFrames;
    bool alive, hasOutput;
    bool operator==(const Snapshot&) const = default;
  };
  static OSStatus changed(AudioObjectID, UInt32, const AudioObjectPropertyAddress*, void*) noexcept;
  bool subscribe(AudioObjectID object, AudioObjectPropertySelector selector, AudioObjectPropertyScope scope) noexcept;
  bool initialize(AudioObjectID device, AudioStreamID stream, std::string_view uid);
  void invalidate() noexcept;
  EventCell* const events_; // HAL移除监听后仍可能迟到；只在隔离helper进程退出时回收。
  std::array<Subscription, 10> subscriptions_{};
  size_t subscriptionCount_ = 0;
  AudioObjectID selectedDevice_ = kAudioObjectUnknown;
  AudioStreamID selectedStream_ = kAudioObjectUnknown;
  std::string selectedUid_;
  bool failed_ = false;
  std::optional<Snapshot> previous_;
};
}
