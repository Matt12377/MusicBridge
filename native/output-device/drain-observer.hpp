#pragma once
#include <atomic>
#include <cstdint>

namespace output::device {
/** 同一已选设备的sample/host时间表示；valid位须来自各自AudioTimeStamp.mFlags。 */
struct DeviceTimePoint {
  double sampleTime;
  uint64_t hostTime;
  bool sampleValid;
  bool hostValid;
};
/** 只能从同配置受信完整Gate B记录实例化；数值本身不构成认证。 */
struct CertifiedDrainPolicy {
  uint64_t tailFrames;
  uint32_t minimumZeroCallbacks;
};
enum class DrainReadiness { pending, ready, invalid };

/**
 * RT侧只记录最后一个源时间线帧（包含合法静音/gap/tail）及后续安全零覆盖；
 * 控制线程用同设备当前sampleTime和受信尾部上限评估。时间越界仍只是已认证
 * 算法中的HAL呈现证据，绝不单靠此类证明物理端已无声。
 */
class DrainObserver final {
 public:
  explicit DrainObserver(uint64_t sourceFrames) noexcept : sourceFrames_(sourceFrames) {}
  bool onCallback(DeviceTimePoint outputTime, uint32_t callbackFrames, uint32_t sourceFrames, uint32_t zeroFrames) noexcept;
  DrainReadiness evaluate(DeviceTimePoint currentTime, CertifiedDrainPolicy policy, bool routeStable, bool callbackFault) const noexcept;
  bool fault() const noexcept { return fault_.load(std::memory_order_acquire); }
  uint64_t sourceFramesSeen() const noexcept { return sourceSeen_.load(std::memory_order_acquire); }
  uint64_t lastSourceFrameEnd() const noexcept { return sourceEnd_.load(std::memory_order_acquire); }
  uint64_t safeZeroThrough() const noexcept { return zeroThrough_.load(std::memory_order_acquire); }
 private:
  const uint64_t sourceFrames_;
  std::atomic<uint64_t> sourceSeen_{0}, priorOutputEnd_{0}, priorHostTime_{0}, sourceEnd_{0}, zeroThrough_{0}, zeroCallbacks_{0};
  mutable std::atomic<uint64_t> lastCurrentSample_{0}, lastCurrentHost_{0};
  mutable std::atomic<bool> currentClockFault_{false};
  std::atomic<bool> fault_{false};
  bool fail() noexcept { fault_.store(true, std::memory_order_release); return false; }
};
}
