#pragma once

#include "../output-helper/frame-pump.hpp"
#include "drain-observer.hpp"
#include <CoreAudio/AudioHardware.h>
#include <atomic>
#include <cstdint>
#include <span>
#include <thread>

// 单次隔离helper进程的HAL边界；不属于旧synthetic helper/pin。
namespace output::device {
class HalShim {
 public:
  virtual ~HalShim() = default;
  virtual OSStatus create(AudioObjectID device, AudioDeviceIOProc callback, void* opaque, AudioDeviceIOProcID* id) noexcept = 0;
  virtual OSStatus start(AudioObjectID device, AudioDeviceIOProcID id) noexcept = 0;
  virtual OSStatus stop(AudioObjectID device, AudioDeviceIOProcID id) noexcept = 0;
  virtual OSStatus destroy(AudioObjectID device, AudioDeviceIOProcID id) noexcept = 0;
  /** 只可在控制线程调用；不在实时IOProc读取HAL。 */
  virtual OSStatus currentTime(AudioObjectID, AudioTimeStamp*) noexcept { return -1; }
};

class SystemHalShim final : public HalShim {
 public:
  OSStatus create(AudioObjectID, AudioDeviceIOProc, void*, AudioDeviceIOProcID*) noexcept override;
  OSStatus start(AudioObjectID, AudioDeviceIOProcID) noexcept override;
  OSStatus stop(AudioObjectID, AudioDeviceIOProcID) noexcept override;
  OSStatus destroy(AudioObjectID, AudioDeviceIOProcID) noexcept override;
  OSStatus currentTime(AudioObjectID, AudioTimeStamp*) noexcept override;
};

enum class Stage { idle, prepared, running, stopping, closed };
struct Config {
  AudioObjectID device;
  uint32_t frameBytes;
  uint32_t channels;
  uint32_t callbackFrames;
  uint64_t sourceFrames;
  uint32_t capacityFrames;
  const std::atomic<uint64_t>* routeEpoch = nullptr;
  uint64_t expectedRouteEpoch = 0;
  CertifiedDrainPolicy drainPolicy{0, 0};
};
struct Facts {
  Stage stage;
  bool sourceEof;
  bool startAttempted;
  bool stopAcknowledged;
  bool destroyAcknowledged;
  bool callbackFault;
  uint64_t consumedFrames;
  uint64_t zeroFilledFrames;
  // 官方API未声明Stop/Destroy返回时已取opaque的回调全部退出；永远不冒充证明。
  bool callbacksQuiescent;
  bool hardwareDrained;
};

/**
 * 每进程只创建一次。opaque指向进程寿命Cell，stop/destroy乃至析构后仍不释放它；
 * 唯一内存寿命屏障是外层等待隔离helper进程close。helper须用_exit/_Exit结束，
 * 不运行静态析构；不得把此Driver放入长期Electron/Core进程。
 */
class CoreAudioDriver final {
 public:
  CoreAudioDriver(HalShim& shim, Config config);
  ~CoreAudioDriver();
  CoreAudioDriver(const CoreAudioDriver&) = delete;
  CoreAudioDriver& operator=(const CoreAudioDriver&) = delete;
  bool prepare();
  uint32_t publish(std::span<const std::byte> bytes);
  uint32_t writableFrames() const;
  bool start();
  void stop();
  DrainReadiness pollDrain();
  Facts sealAndDetach();
  Facts facts() const;
 private:
  struct Cell;
  static OSStatus callback(AudioObjectID, const AudioTimeStamp*, const AudioBufferList*, const AudioTimeStamp*, AudioBufferList*, const AudioTimeStamp*, void*) noexcept;
  void controlThread() const;
  HalShim& shim_;
  const Config config_;
  const std::thread::id owner_;
  Cell* const cell_; // 进程寿命，不由Driver析构；后到回调仅访问Cell。
  AudioDeviceIOProcID ioProc_ = nullptr;
  Stage stage_ = Stage::idle;
  bool startAttempted_ = false, stopAcknowledged_ = false, destroyAcknowledged_ = false;
  bool drainObserved_ = false;
};
}
