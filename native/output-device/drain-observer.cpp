#include "drain-observer.hpp"
#include <cmath>
#include <limits>

namespace output::device {
static_assert(std::atomic<uint64_t>::is_always_lock_free);
static_assert(std::atomic<bool>::is_always_lock_free);
namespace {
constexpr uint64_t exactDoubleIntegerLimit = uint64_t{1} << 53;
bool exactFrame(double value, uint64_t& out) noexcept {
  if (!std::isfinite(value) || value < 0 || value > static_cast<double>(exactDoubleIntegerLimit)
    || std::floor(value) != value) return false;
  out = static_cast<uint64_t>(value); return true;
}
}
bool DrainObserver::onCallback(DeviceTimePoint outputTime, uint32_t callbackFrames, uint32_t sourceFrames, uint32_t zeroFrames) noexcept {
  if (fault() || !sourceFrames_ || !outputTime.sampleValid || !outputTime.hostValid || !outputTime.hostTime
    || callbackFrames < 1 || callbackFrames > 4096 || sourceFrames > callbackFrames
    || zeroFrames != callbackFrames - sourceFrames) return fail();
  uint64_t start = 0;
  if (!exactFrame(outputTime.sampleTime, start) || start > exactDoubleIntegerLimit - callbackFrames) return fail();
  const auto priorEnd = priorOutputEnd_.load(std::memory_order_acquire);
  const auto priorHost = priorHostTime_.load(std::memory_order_acquire);
  if ((priorEnd && start != priorEnd) || (priorHost && outputTime.hostTime <= priorHost)) return fail();
  const auto seen = sourceSeen_.load(std::memory_order_acquire);
  if (seen > sourceFrames_ || sourceFrames > sourceFrames_ - seen) return fail();
  const auto total = seen + sourceFrames;
  if (seen == sourceFrames_ && sourceFrames != 0) return fail();
  if (total == sourceFrames_ && sourceFrames > 0) sourceEnd_.store(start + sourceFrames, std::memory_order_release);
  if (total == sourceFrames_ && zeroFrames) {
    zeroThrough_.store(start + callbackFrames, std::memory_order_release);
    zeroCallbacks_.fetch_add(1, std::memory_order_release);
  }
  sourceSeen_.store(total, std::memory_order_release);
  priorOutputEnd_.store(start + callbackFrames, std::memory_order_release);
  priorHostTime_.store(outputTime.hostTime, std::memory_order_release);
  return true;
}
DrainReadiness DrainObserver::evaluate(DeviceTimePoint now, CertifiedDrainPolicy policy, bool routeStable, bool callbackFault) const noexcept {
  if (!routeStable || callbackFault || fault() || currentClockFault_.load(std::memory_order_acquire) || !sourceFrames_ || !policy.tailFrames
    || policy.tailFrames > 3840000 || policy.minimumZeroCallbacks < 1 || policy.minimumZeroCallbacks > 128) return DrainReadiness::invalid;
  if (!now.sampleValid || !now.hostValid || !now.hostTime) return DrainReadiness::invalid;
  uint64_t current = 0;
  if (!exactFrame(now.sampleTime, current)) return DrainReadiness::invalid;
  // 当前设备时钟只与本身此前读数比较；最新输出回调可能仍排在未来。
  const auto priorCurrentSample = lastCurrentSample_.load(std::memory_order_acquire);
  const auto priorCurrentHost = lastCurrentHost_.load(std::memory_order_acquire);
  if ((priorCurrentSample && current < priorCurrentSample) || (priorCurrentHost && now.hostTime < priorCurrentHost)) {
    currentClockFault_.store(true, std::memory_order_release); return DrainReadiness::invalid;
  }
  lastCurrentSample_.store(current, std::memory_order_release);
  lastCurrentHost_.store(now.hostTime, std::memory_order_release);
  const auto seen = sourceSeen_.load(std::memory_order_acquire);
  const auto end = sourceEnd_.load(std::memory_order_acquire);
  if (seen != sourceFrames_ || !end) return DrainReadiness::pending;
  if (end > exactDoubleIntegerLimit - policy.tailFrames) return DrainReadiness::invalid;
  const auto threshold = end + policy.tailFrames;
  const auto zeroThrough = zeroThrough_.load(std::memory_order_acquire);
  const auto zeroCallbacks = zeroCallbacks_.load(std::memory_order_acquire);
  if (current < threshold || zeroThrough < threshold
    || zeroCallbacks < policy.minimumZeroCallbacks || current > zeroThrough) return DrainReadiness::pending;
  return DrainReadiness::ready;
}
}
