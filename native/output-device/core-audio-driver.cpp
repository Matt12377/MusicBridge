#include "core-audio-driver.hpp"
#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace output::device {
static_assert(std::atomic<bool>::is_always_lock_free);
static_assert(std::atomic<uint32_t>::is_always_lock_free);
static_assert(std::atomic<uint64_t>::is_always_lock_free);
namespace {
void boundedSilence(AudioBufferList* buffers) noexcept {
  if (!buffers || buffers->mNumberBuffers != 1) return;
  auto& value = buffers->mBuffers[0];
  if (value.mData && value.mDataByteSize <= 4096 * 8) std::memset(value.mData, 0, value.mDataByteSize);
}
}

struct CoreAudioDriver::Cell {
  explicit Cell(const Config& c) : pump(c.frameBytes, c.sourceFrames, c.capacityFrames), drain(c.sourceFrames), frameBytes(c.frameBytes), channels(c.channels), routeEpoch(c.routeEpoch), expectedRouteEpoch(c.expectedRouteEpoch), drainPolicy(c.drainPolicy) {}
  FramePump pump;
  DrainObserver drain;
  const uint32_t frameBytes, channels;
  const std::atomic<uint64_t>* const routeEpoch;
  const uint64_t expectedRouteEpoch;
  const CertifiedDrainPolicy drainPolicy;
  std::atomic<bool> accepting{false}, callbackFault{false};
  std::atomic<uint32_t> inFlight{0};
  std::atomic_flag pulling = ATOMIC_FLAG_INIT;
};

OSStatus SystemHalShim::create(AudioObjectID device, AudioDeviceIOProc callback, void* opaque, AudioDeviceIOProcID* id) noexcept {
  return AudioDeviceCreateIOProcID(device, callback, opaque, id);
}
OSStatus SystemHalShim::start(AudioObjectID device, AudioDeviceIOProcID id) noexcept { return AudioDeviceStart(device, id); }
OSStatus SystemHalShim::stop(AudioObjectID device, AudioDeviceIOProcID id) noexcept { return AudioDeviceStop(device, id); }
OSStatus SystemHalShim::destroy(AudioObjectID device, AudioDeviceIOProcID id) noexcept { return AudioDeviceDestroyIOProcID(device, id); }
OSStatus SystemHalShim::currentTime(AudioObjectID device, AudioTimeStamp* out) noexcept { return AudioDeviceGetCurrentTime(device, out); }

CoreAudioDriver::CoreAudioDriver(HalShim& shim, Config config)
    : shim_(shim), config_(config), owner_(std::this_thread::get_id()), cell_([&] {
        if (config.device == kAudioObjectUnknown || config.frameBytes < 2 || config.frameBytes > 8
          || config.channels < 1 || config.channels > 2 || config.callbackFrames < 1 || config.callbackFrames > 4096
          || !config.sourceFrames || !config.capacityFrames || config.capacityFrames > 16384
          || (config.routeEpoch && !config.expectedRouteEpoch)
          || (config.drainPolicy.tailFrames && (!config.drainPolicy.minimumZeroCallbacks || config.drainPolicy.minimumZeroCallbacks > 128))) throw std::invalid_argument("HAL配置无效");
        return new Cell(config);
      }()) {}
CoreAudioDriver::~CoreAudioDriver() { sealAndDetach(); }
void CoreAudioDriver::controlThread() const {
  if (std::this_thread::get_id() != owner_) throw std::logic_error("HAL控制API必须在所属单线程调用");
}
bool CoreAudioDriver::prepare() {
  controlThread(); if (stage_ != Stage::idle) return false;
  AudioDeviceIOProcID id = nullptr;
  if (shim_.create(config_.device, callback, cell_, &id) != noErr || !id) { cell_->accepting.store(false, std::memory_order_release); stage_ = Stage::closed; return false; }
  ioProc_ = id; stage_ = Stage::prepared; return true;
}
uint32_t CoreAudioDriver::publish(std::span<const std::byte> bytes) {
  controlThread(); if (stage_ != Stage::prepared && stage_ != Stage::running) return 0;
  return cell_->pump.publish(bytes);
}
uint32_t CoreAudioDriver::writableFrames() const {
  controlThread(); return stage_ == Stage::prepared || stage_ == Stage::running ? cell_->pump.free_frames() : 0;
}
bool CoreAudioDriver::start() {
  controlThread(); if (stage_ != Stage::prepared || !ioProc_) return false;
  if (cell_->pump.available() < std::min(config_.sourceFrames, uint64_t(config_.callbackFrames)) || !cell_->pump.start()) return false;
  // 同步start可能立即派发回调；在它之前开放RT，但失败必须先封闭再stop。
  cell_->accepting.store(true, std::memory_order_release);
  startAttempted_ = true;
  if (shim_.start(config_.device, ioProc_) != noErr) { cell_->accepting.store(false, std::memory_order_release); cell_->pump.stop(Reason::internal); stop(); return false; }
  stage_ = Stage::running; return true;
}
void CoreAudioDriver::stop() {
  controlThread(); if (stage_ == Stage::closed || stage_ == Stage::stopping) return;
  cell_->accepting.store(false, std::memory_order_release);
  cell_->pump.stop();
  if (startAttempted_ && ioProc_) stopAcknowledged_ = shim_.stop(config_.device, ioProc_) == noErr;
  stage_ = Stage::stopping;
}
DrainReadiness CoreAudioDriver::pollDrain() {
  controlThread();
  if (stage_ != Stage::running || !config_.drainPolicy.tailFrames || cell_->callbackFault.load(std::memory_order_acquire)
    || cell_->drain.fault()) return DrainReadiness::invalid;
  if (cell_->pump.phase() != Phase::drained || cell_->pump.consumed() != config_.sourceFrames) return DrainReadiness::pending;
  AudioTimeStamp time{};
  time.mFlags = kAudioTimeStampSampleTimeValid | kAudioTimeStampHostTimeValid;
  if (shim_.currentTime(config_.device, &time) != noErr) return DrainReadiness::invalid;
  const DeviceTimePoint now{time.mSampleTime, time.mHostTime,
    (time.mFlags & kAudioTimeStampSampleTimeValid) != 0, (time.mFlags & kAudioTimeStampHostTimeValid) != 0};
  const auto result = cell_->drain.evaluate(now, config_.drainPolicy, true, cell_->callbackFault.load(std::memory_order_acquire));
  if (result == DrainReadiness::ready) drainObserved_ = true;
  return result;
}
Facts CoreAudioDriver::sealAndDetach() {
  controlThread(); if (stage_ == Stage::closed) return facts();
  stop();
  if (ioProc_) { destroyAcknowledged_ = shim_.destroy(config_.device, ioProc_) == noErr; ioProc_ = nullptr; }
  stage_ = Stage::closed;
  // 即使Destroy成功也不delete cell_；已取opaque而尚未进入callback的窗口由进程退出封闭。
  return facts();
}
Facts CoreAudioDriver::facts() const {
  controlThread();
  return { stage_, cell_->pump.phase() == Phase::drained, startAttempted_, stopAcknowledged_, destroyAcknowledged_, cell_->callbackFault.load(std::memory_order_acquire),
    cell_->pump.consumed(), cell_->pump.zeros(), false, drainObserved_ && !cell_->drain.fault() && !cell_->callbackFault.load(std::memory_order_acquire) };
}
OSStatus CoreAudioDriver::callback(AudioObjectID, const AudioTimeStamp*, const AudioBufferList*, const AudioTimeStamp*, AudioBufferList* buffers, const AudioTimeStamp* outputTime, void* opaque) noexcept {
  auto* cell = static_cast<Cell*>(opaque);
  if (!cell) { boundedSilence(buffers); return noErr; }
  cell->inFlight.fetch_add(1, std::memory_order_acq_rel);
  struct Exit { Cell* cell; ~Exit() { cell->inFlight.fetch_sub(1, std::memory_order_release); } } exit{cell};
  if (!buffers || buffers->mNumberBuffers != 1 || !buffers->mBuffers[0].mData || buffers->mBuffers[0].mNumberChannels != cell->channels
    || !cell->frameBytes || buffers->mBuffers[0].mDataByteSize % cell->frameBytes
    || buffers->mBuffers[0].mDataByteSize == 0 || buffers->mBuffers[0].mDataByteSize / cell->frameBytes > 4096) {
    cell->callbackFault.store(true, std::memory_order_release); cell->accepting.store(false, std::memory_order_release);
    cell->pump.stop(Reason::output_shape); boundedSilence(buffers); return noErr;
  }
  auto& value = buffers->mBuffers[0];
  auto out = std::span(static_cast<std::byte*>(value.mData), value.mDataByteSize);
  if (cell->routeEpoch && cell->routeEpoch->load(std::memory_order_acquire) != cell->expectedRouteEpoch) {
    cell->callbackFault.store(true, std::memory_order_release); cell->accepting.store(false, std::memory_order_release);
    cell->pump.stop(Reason::internal); std::memset(out.data(), 0, out.size()); return noErr;
  }
  if (!cell->accepting.load(std::memory_order_acquire)) { std::memset(out.data(), 0, out.size()); return noErr; }
  if (cell->pulling.test_and_set(std::memory_order_acquire)) {
    cell->callbackFault.store(true, std::memory_order_release); cell->accepting.store(false, std::memory_order_release);
    cell->pump.stop(Reason::internal); std::memset(out.data(), 0, out.size()); return noErr;
  }
  struct Unlock { Cell* cell; ~Unlock() { cell->pulling.clear(std::memory_order_release); } } unlock{cell};
  if (!cell->accepting.load(std::memory_order_acquire)) { std::memset(out.data(), 0, out.size()); return noErr; }
  const auto result = cell->pump.pull(out, value.mDataByteSize / cell->frameBytes);
  if (cell->drainPolicy.tailFrames) {
    const DeviceTimePoint time{outputTime ? outputTime->mSampleTime : 0, outputTime ? outputTime->mHostTime : 0,
      outputTime && (outputTime->mFlags & kAudioTimeStampSampleTimeValid) != 0,
      outputTime && (outputTime->mFlags & kAudioTimeStampHostTimeValid) != 0};
    if (!cell->drain.onCallback(time, value.mDataByteSize / cell->frameBytes, result.source_frames, result.zero_frames)) {
      cell->callbackFault.store(true, std::memory_order_release); cell->accepting.store(false, std::memory_order_release);
      cell->pump.stop(Reason::internal); std::memset(out.data(), 0, out.size()); return noErr;
    }
  }
  // pull期间撤权或HAL属性事件可能并发到达；本回调必须整块清零，不能外送部分旧路由PCM。
  if (!cell->accepting.load(std::memory_order_acquire)
    || (cell->routeEpoch && cell->routeEpoch->load(std::memory_order_acquire) != cell->expectedRouteEpoch)) {
    cell->callbackFault.store(true, std::memory_order_release); cell->accepting.store(false, std::memory_order_release);
    cell->pump.stop(Reason::internal); std::memset(out.data(), 0, out.size()); return noErr;
  }
  if (result.phase == Phase::failed) { cell->callbackFault.store(true, std::memory_order_release); cell->accepting.store(false, std::memory_order_release); }
  if (result.phase == Phase::drained && !cell->drainPolicy.tailFrames) cell->accepting.store(false, std::memory_order_release);
  return noErr;
}
}
