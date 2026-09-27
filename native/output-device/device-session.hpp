#pragma once

#include "core-audio-driver.hpp"
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace output::device {
enum class PcmFormat : uint16_t { s16le = 1, packed_s24le = 2, s32le = 3, f32le = 4 };
enum class OutputScope : uint8_t { formal_recording = 1, replica_playback = 2 };
enum class QualificationFailure { none, invalid_request, observation_unavailable, identity_mismatch, route_changed, hal_rejected, drain_unavailable };

// Formal Gate B或普通Playback身份由Core分别核实；本结构只冻结本run的精确路由，不签发任何资格。
struct RequestedRoute {
  OutputScope scope;
  std::string uid;
  uint64_t routeGeneration;
  uint32_t sampleRate;
  uint32_t channels;
  PcmFormat format;
  PcmFormat physicalFormat;
  uint32_t bufferFrames;
  uint64_t sourceFrames;
  uint32_t capacityFrames;
  std::array<std::byte, 32> admissionSha256;
  CertifiedDrainPolicy drainPolicy{0, 0};
};

// 必须由独立Probe读取；绝不把RequestedRoute字段复制过来充作observed。
struct DeviceObservation {
  std::string uid;
  AudioObjectID device;
  uint64_t routeGeneration;
  uint32_t sampleRate;
  uint32_t channels;
  PcmFormat format;
  PcmFormat physicalFormat;
  uint32_t bufferFrames;
  bool alive;
  bool hasOutput;
};
class DeviceProbe {
 public:
  virtual ~DeviceProbe() = default;
  virtual std::optional<DeviceObservation> observeExact(std::string_view uid) noexcept = 0;
  /** 进程寿命的事件计数器；RT只读此原子值，不在回调中访问HAL。 */
  virtual const std::atomic<uint64_t>* eventEpoch() const noexcept { return nullptr; }
};

struct SessionFacts {
  QualificationFailure failure;
  bool prepared;
  bool running;
  bool sourceEof;
  bool startAttempted;
  bool stopAcknowledged;
  bool destroyAcknowledged;
  bool callbackFault;
  uint64_t consumedFrames;
  uint64_t zeroFilledFrames;
  bool callbacksQuiescent;
  bool hardwareDrained;
};

/** 每Side只创建一次；调用方按scope完成各自准入，再交给隔离子进程。 */
class DeviceOutputSession final {
 public:
  DeviceOutputSession(DeviceProbe& probe, HalShim& shim, RequestedRoute route);
  DeviceOutputSession(const DeviceOutputSession&) = delete;
  DeviceOutputSession& operator=(const DeviceOutputSession&) = delete;
  bool prepare();
  uint32_t publish(std::span<const std::byte> bytes);
  uint32_t writableFrames() const;
  bool start();
  bool revalidate();
  DrainReadiness pollDrain();
  void stop();
  SessionFacts sealAndDetach();
  SessionFacts facts() const;
 private:
  bool validRoute() const;
  bool matches(const DeviceObservation& observed) const;
  bool sameDevice(const DeviceObservation& observed) const;
  bool observeBeforeStart();
  DeviceProbe& probe_;
  HalShim& shim_;
  const RequestedRoute route_;
  std::optional<DeviceObservation> selected_;
  std::unique_ptr<CoreAudioDriver> driver_;
  QualificationFailure failure_ = QualificationFailure::none;
  bool running_ = false;
};
}
