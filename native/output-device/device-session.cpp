#include "device-session.hpp"
#include <algorithm>
#include <stdexcept>

namespace output::device {
namespace {
uint32_t bytesPerSample(PcmFormat format) {
  switch (format) {
    case PcmFormat::s16le: return 2;
    case PcmFormat::packed_s24le: return 3;
    case PcmFormat::s32le: case PcmFormat::f32le: return 4;
  }
  return 0;
}
bool hasAdmissionIdentity(const std::array<std::byte, 32>& hash) {
  return std::any_of(hash.begin(), hash.end(), [](std::byte value) { return value != std::byte{0}; });
}
}
DeviceOutputSession::DeviceOutputSession(DeviceProbe& probe, HalShim& shim, RequestedRoute route)
    : probe_(probe), shim_(shim), route_(std::move(route)) {}
bool DeviceOutputSession::validRoute() const {
  const auto sampleBytes = bytesPerSample(route_.format);
  return !route_.uid.empty() && route_.uid.size() <= 128 && route_.uid.find('\0') == std::string::npos
    && route_.routeGeneration && route_.sampleRate >= 8000 && route_.sampleRate <= 384000
    && route_.channels >= 1 && route_.channels <= 2 && sampleBytes && route_.physicalFormat == route_.format
    && route_.bufferFrames >= 1 && route_.bufferFrames <= 4096
    && route_.sourceFrames && route_.capacityFrames >= route_.bufferFrames && route_.capacityFrames <= 16384
    && (!route_.drainPolicy.tailFrames || (route_.drainPolicy.tailFrames <= 3840000
      && route_.drainPolicy.minimumZeroCallbacks >= 1 && route_.drainPolicy.minimumZeroCallbacks <= 128))
    && (route_.scope == OutputScope::formal_recording || route_.scope == OutputScope::replica_playback)
    && hasAdmissionIdentity(route_.admissionSha256);
}
bool DeviceOutputSession::matches(const DeviceObservation& value) const {
  const auto* epoch = probe_.eventEpoch();
  return value.device != kAudioObjectUnknown && value.alive && value.hasOutput && value.uid == route_.uid
    && value.routeGeneration == route_.routeGeneration && value.sampleRate == route_.sampleRate
    && value.channels == route_.channels && value.format == route_.format && value.physicalFormat == route_.physicalFormat
    && value.bufferFrames == route_.bufferFrames
    && (!epoch || epoch->load(std::memory_order_acquire) == value.routeGeneration);
}
bool DeviceOutputSession::sameDevice(const DeviceObservation& value) const {
  return selected_ && matches(value) && value.device == selected_->device;
}
bool DeviceOutputSession::prepare() {
  if (driver_ || failure_ != QualificationFailure::none) return false;
  if (!validRoute()) { failure_ = QualificationFailure::invalid_request; return false; }
  selected_ = probe_.observeExact(route_.uid);
  if (!selected_) { failure_ = QualificationFailure::observation_unavailable; return false; }
  if (!matches(*selected_)) { failure_ = QualificationFailure::identity_mismatch; return false; }
  const auto frameBytes = bytesPerSample(route_.format) * route_.channels;
  try { driver_ = std::make_unique<CoreAudioDriver>(shim_, Config{selected_->device, frameBytes, route_.channels, route_.bufferFrames, route_.sourceFrames, route_.capacityFrames, probe_.eventEpoch(), selected_->routeGeneration, route_.drainPolicy}); }
  catch (const std::exception&) { failure_ = QualificationFailure::invalid_request; return false; }
  // 第二次独立观测夹在构造和HAL注册之间；代际或对象变化不得进入create。
  const auto beforeCreate = probe_.observeExact(route_.uid);
  if (!beforeCreate || !sameDevice(*beforeCreate)) { failure_ = QualificationFailure::route_changed; driver_.reset(); return false; }
  if (!driver_->prepare()) { failure_ = QualificationFailure::hal_rejected; return false; }
  return true;
}
uint32_t DeviceOutputSession::publish(std::span<const std::byte> bytes) {
  return driver_ && failure_ == QualificationFailure::none ? driver_->publish(bytes) : 0;
}
uint32_t DeviceOutputSession::writableFrames() const {
  return driver_ && failure_ == QualificationFailure::none ? driver_->writableFrames() : 0;
}
bool DeviceOutputSession::observeBeforeStart() {
  const auto current = probe_.observeExact(route_.uid);
  if (current && sameDevice(*current)) return true;
  failure_ = QualificationFailure::route_changed; stop(); return false;
}
bool DeviceOutputSession::start() {
  if (!driver_ || running_ || failure_ != QualificationFailure::none || !observeBeforeStart()) return false;
  if (!driver_->start()) { failure_ = QualificationFailure::hal_rejected; return false; }
  running_ = true;
  // start内部可能同步派发；再次独立核对路由代际，漂移即封闭派发。
  return revalidate();
}
bool DeviceOutputSession::revalidate() {
  if (!driver_ || !running_ || failure_ != QualificationFailure::none) return false;
  const auto current = probe_.observeExact(route_.uid);
  if (current && sameDevice(*current)) return true;
  failure_ = QualificationFailure::route_changed; stop(); return false;
}
DrainReadiness DeviceOutputSession::pollDrain() {
  if (!driver_ || !running_ || failure_ != QualificationFailure::none) return DrainReadiness::invalid;
  if (!revalidate()) return DrainReadiness::invalid;
  const auto result = driver_->pollDrain();
  if (!revalidate()) return DrainReadiness::invalid;
  if (result == DrainReadiness::invalid) { failure_ = QualificationFailure::drain_unavailable; stop(); }
  return result;
}
void DeviceOutputSession::stop() { if (driver_) driver_->stop(); running_ = false; }
SessionFacts DeviceOutputSession::sealAndDetach() {
  if (!driver_) return facts();
  driver_->sealAndDetach(); running_ = false; return facts();
}
SessionFacts DeviceOutputSession::facts() const {
  const auto state = driver_ ? driver_->facts() : Facts{Stage::idle, false, false, false, false, false, 0, 0, false, false};
  return {failure_, driver_ && state.stage != Stage::idle && state.stage != Stage::closed, running_, state.sourceEof, state.startAttempted,
    state.stopAcknowledged, state.destroyAcknowledged, state.callbackFault, state.consumedFrames,
    state.zeroFilledFrames, state.callbacksQuiescent, failure_ == QualificationFailure::none && state.hardwareDrained};
}
}
