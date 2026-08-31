#pragma once
#include "../output-helper/frame-pump.hpp"
#include <atomic>
#include <cstdint>
#include <memory>
#include <span>
#include <thread>

// 隔离控制内核：不属于当前helper的源码pin或打包集合，不提供设备或正式输出入口。
namespace output::lifecycle {
enum class Stage { idle, prepared, running, stopping, retired };
enum class EndReason : uint32_t { none, source_exhausted, cancelled, driver_failure, device_lost, route_changed, format_changed, underrun, output_shape, callback_overlap };
enum class Fault { none, device_lost, route_changed, format_changed, driver_failure };
enum class CleanupIssue { none, stop_failed, detach_failed };
struct SessionConfig {
  uint64_t generation;
  uint32_t frameBytes;
  uint64_t sourceFrames;
  uint32_t capacityFrames;
  uint64_t cleanupTimeoutMs;
};
struct DriverObservation {
  uint64_t generation;
  Fault fault;
  // 必须先封闭派发入口并等待全部已派发回调退出；瞬时inFlight=0不是此证明。
  bool callbacksQuiescent;
};
struct SessionSnapshot {
  Stage stage;
  EndReason reason;
  CleanupIssue cleanupIssue;
  bool stopAcknowledged;
  bool cleanupPending;
  bool cleanupTimedOut;
  uint64_t consumedFrames;
  uint64_t zeroFilledFrames;
};

class DeviceSession;
class CallbackContext final {
 public:
  // 唯一RT入口：Driver保证单消费者、不并发且不重入；token必须属于当前会话。
  // 不分配、不加锁/等待、不做I/O、不调用Driver；仅原子和共享FramePump。
  Pull render(uint64_t generation, std::span<std::byte> output, uint32_t frames) noexcept;
 private:
  friend class DeviceSession;
  explicit CallbackContext(const SessionConfig& config);
  void latch(EndReason reason) noexcept;
  void cutOff() noexcept;
  FramePump pump_;
  const uint64_t generation_;
  const uint32_t frameBytes_;
  std::atomic<bool> accepting_{false};
  std::atomic<uint32_t> inFlight_{0};
  std::atomic_flag pulling_ = ATOMIC_FLAG_INIT;
  std::atomic<EndReason> reason_{EndReason::none};
};

class Driver {
 public:
  // Session在析构此对象前已调用shutdownAndJoin；Driver析构须释放剩余自有资源。
  virtual ~Driver() = default;
  // 以下接口仅控制线程调用。false注册不得留下资源或可用回调引用。
  virtual bool registerCallback(CallbackContext&, uint64_t generation) noexcept = 0;
  virtual bool start(uint64_t generation) noexcept = 0;
  // true只表示请求已接收，绝不是回调静止、设备排空或输出端无声。
  virtual bool requestStop(uint64_t generation) noexcept = 0;
  virtual DriverObservation observe(uint64_t generation) noexcept = 0;
  // 仅在有效静止证明之后调用。false必须保留资源，允许控制线程随后重试清理。
  virtual bool detach(uint64_t generation) noexcept = 0;
  // 析构终止屏障：封闭新派发入口，join全部已派发回调，包含已取opaque尚未进入者。
  // 返回后不得再接触context。可等待，不能在RT调用；不提供硬件停止时间上界。
  // 现阶段只有测试FakeDriver兑现此合同；不得假设HAL Stop/Destroy有同等保证。
  virtual void shutdownAndJoin() noexcept = 0;
};

class DeviceSession final {
 public:
  DeviceSession(std::unique_ptr<Driver> driver, SessionConfig config);
  // 与其他控制API同属一个控制线程；即使清理超时，也必须join后才销毁context。
  ~DeviceSession();
  DeviceSession(const DeviceSession&) = delete;
  DeviceSession& operator=(const DeviceSession&) = delete;
  DeviceSession(DeviceSession&&) = delete;
  DeviceSession& operator=(DeviceSession&&) = delete;
  bool prepare();
  bool start(uint64_t monotonicMs);
  // 单producer；只能从所属控制线程预填/补帧，不接受另一生产线程。
  uint32_t publish(std::span<const std::byte> input);
  void stop(uint64_t monotonicMs);
  void poll(uint64_t monotonicMs);
  SessionSnapshot snapshot() const;
 private:
  void controlThread() const;
  void clock(uint64_t now);
  void beginStop(uint64_t now);
  const SessionConfig config_;
  const std::thread::id owner_;
  CallbackContext context_;
  std::unique_ptr<Driver> driver_;
  Stage stage_ = Stage::idle;
  CleanupIssue cleanupIssue_ = CleanupIssue::none;
  bool registered_ = false, stopAcknowledged_ = false, cleanupTimedOut_ = false;
  uint64_t lastNow_ = 0, stoppedAt_ = 0;
};
}
