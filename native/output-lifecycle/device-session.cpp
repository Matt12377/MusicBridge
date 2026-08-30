#include "device-session.hpp"
#include <cstring>
#include <stdexcept>

namespace output::lifecycle {
static_assert(std::atomic<bool>::is_always_lock_free);
static_assert(std::atomic<uint32_t>::is_always_lock_free);
static_assert(std::atomic<EndReason>::is_always_lock_free);
namespace {
Pull silence(std::span<std::byte> output, uint32_t frames, uint32_t frameBytes, Phase phase) noexcept {
  // 早退同样核对完整shape；预算内清零不等于已提供请求的完整有效帧。
  const bool valid = frames >= 1 && frames <= 4096 && output.size() == size_t(frames) * frameBytes;
  if (!output.empty() && output.size() <= 4096 * 8) std::memset(output.data(), 0, output.size());
  return {0, valid ? frames : 0, valid ? phase : Phase::failed};
}
EndReason faultReason(Fault fault) noexcept {
  switch (fault) {
    case Fault::device_lost: return EndReason::device_lost;
    case Fault::route_changed: return EndReason::route_changed;
    case Fault::format_changed: return EndReason::format_changed;
    case Fault::driver_failure: return EndReason::driver_failure;
    case Fault::none: return EndReason::none;
  }
  return EndReason::driver_failure;
}
}
CallbackContext::CallbackContext(const SessionConfig& config)
    : pump_(config.frameBytes, config.sourceFrames, config.capacityFrames), generation_(config.generation), frameBytes_(config.frameBytes) {}
void CallbackContext::latch(EndReason reason) noexcept {
  auto empty = EndReason::none;
  reason_.compare_exchange_strong(empty, reason, std::memory_order_acq_rel);
}
void CallbackContext::cutOff() noexcept {
  accepting_.store(false, std::memory_order_release);
  // stop只锁存原子原因；并发在途块可能已消费，不等于回调静止或硬件无声。
  pump_.stop();
}
Pull CallbackContext::render(uint64_t generation, std::span<std::byte> output, uint32_t frames) noexcept {
  inFlight_.fetch_add(1, std::memory_order_acq_rel);
  struct Exit { std::atomic<uint32_t>& count; ~Exit() { count.fetch_sub(1, std::memory_order_release); } } exit{inFlight_};
  if (generation != generation_ || !accepting_.load(std::memory_order_acquire)) return silence(output, frames, frameBytes_, Phase::stopped);
  if (pulling_.test_and_set(std::memory_order_acquire)) {
    latch(EndReason::callback_overlap); cutOff();
    return silence(output, frames, frameBytes_, Phase::failed);
  }
  struct Unlock { std::atomic_flag& flag; ~Unlock() { flag.clear(std::memory_order_release); } } unlock{pulling_};
  if (!accepting_.load(std::memory_order_acquire)) return silence(output, frames, frameBytes_, Phase::stopped);
  const auto result = pump_.pull(output, frames);
  if (result.phase == Phase::drained) { latch(EndReason::source_exhausted); accepting_.store(false, std::memory_order_release); }
  else if (result.phase == Phase::failed) {
    latch(pump_.reason() == Reason::underrun ? EndReason::underrun : EndReason::output_shape);
    cutOff();
  }
  return result;
}
DeviceSession::DeviceSession(std::unique_ptr<Driver> driver, SessionConfig config)
    : config_(config), owner_(std::this_thread::get_id()), context_(config), driver_(std::move(driver)) {
  if (!driver_ || !config.generation || !config.cleanupTimeoutMs || config.cleanupTimeoutMs > 60000) throw std::invalid_argument("生命周期配置无效");
}
DeviceSession::~DeviceSession() {
  context_.cutOff();
  driver_->shutdownAndJoin();
  // 屏障覆盖尚未进入render的已派发回调；此时才可销毁Driver和context。
  if (registered_) driver_->detach(config_.generation);
  driver_.reset();
}
void DeviceSession::controlThread() const {
  if (std::this_thread::get_id() != owner_) throw std::logic_error("生命周期控制API必须在所属单线程调用");
}
void DeviceSession::clock(uint64_t now) {
  controlThread();
  if (now < lastNow_) throw std::invalid_argument("生命周期时钟不能倒退");
  lastNow_ = now;
}
bool DeviceSession::prepare() {
  controlThread();
  if (stage_ != Stage::idle) return false;
  if (!driver_->registerCallback(context_, config_.generation)) {
    context_.latch(EndReason::driver_failure); context_.cutOff(); stage_ = Stage::retired; return false;
  }
  registered_ = true; stage_ = Stage::prepared; return true;
}
bool DeviceSession::start(uint64_t now) {
  clock(now);
  if (stage_ != Stage::prepared) return false;
  poll(now);
  if (stage_ != Stage::prepared) return false;
  if (!context_.pump_.start()) { context_.latch(EndReason::driver_failure); beginStop(now); return false; }
  stage_ = Stage::running; context_.accepting_.store(true, std::memory_order_release);
  if (!driver_->start(config_.generation)) { context_.latch(EndReason::driver_failure); beginStop(now); return false; }
  return true;
}
uint32_t DeviceSession::publish(std::span<const std::byte> input) {
  controlThread();
  if (stage_ == Stage::stopping || stage_ == Stage::retired) return 0;
  return context_.pump_.publish(input);
}
void DeviceSession::beginStop(uint64_t now) {
  if (stage_ == Stage::retired || stage_ == Stage::stopping) return;
  context_.cutOff();
  if (!registered_) { stage_ = Stage::retired; return; }
  stage_ = Stage::stopping; stoppedAt_ = now;
  stopAcknowledged_ = driver_->requestStop(config_.generation);
  if (!stopAcknowledged_) cleanupIssue_ = CleanupIssue::stop_failed;
}
void DeviceSession::stop(uint64_t now) {
  clock(now);
  if (stage_ == Stage::retired) return;
  context_.latch(EndReason::cancelled); beginStop(now);
}
void DeviceSession::poll(uint64_t now) {
  clock(now);
  if (!registered_ || stage_ == Stage::retired) return;
  const auto observation = driver_->observe(config_.generation);
  if (observation.generation == config_.generation && observation.fault != Fault::none) context_.latch(faultReason(observation.fault));
  if (context_.reason_.load(std::memory_order_acquire) != EndReason::none) beginStop(now);
  if (stage_ != Stage::stopping) return;
  if (now - stoppedAt_ >= config_.cleanupTimeoutMs) cleanupTimedOut_ = true;
  // inFlight只能作为附加防线；必须同时取得Driver对所有派发的静止证明。
  if (observation.generation != config_.generation || !observation.callbacksQuiescent || context_.inFlight_.load(std::memory_order_acquire) != 0) return;
  if (!driver_->detach(config_.generation)) { if (cleanupIssue_ == CleanupIssue::none) cleanupIssue_ = CleanupIssue::detach_failed; return; }
  registered_ = false; stage_ = Stage::retired;
}
SessionSnapshot DeviceSession::snapshot() const {
  controlThread();
  return {stage_, context_.reason_.load(std::memory_order_acquire), cleanupIssue_, stopAcknowledged_, stage_ == Stage::stopping, cleanupTimedOut_, context_.pump_.consumed(), context_.pump_.zeros()};
}
}
