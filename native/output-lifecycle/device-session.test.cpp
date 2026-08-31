#include "device-session.hpp"
#include <algorithm>
#include <array>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>
using namespace output::lifecycle;
namespace {
int checks = 0;
void check(bool value, const char* message) { ++checks; if (!value) { std::fprintf(stderr, "失败：%s\n", message); std::exit(1); } }
struct Evidence {
  int attach = 0, start = 0, stop = 0, detach = 0, join = 0, destroyed = 0, released = 0;
  std::mutex mutex;
  std::condition_variable changed;
  bool dispatched = false, release = false, joining = false, exited = false;
  uint32_t delayed_frames = 99;
};
struct Resource { Evidence& evidence; ~Resource() { ++evidence.released; } };
class FakeDriver final : public Driver {
 public:
  explicit FakeDriver(Evidence& evidence) : evidence(evidence) {}
  ~FakeDriver() override { ++evidence.destroyed; }
  bool registerCallback(CallbackContext& value, uint64_t token) noexcept override { ++evidence.attach; if (!attach_ok) return false; resource = std::make_unique<Resource>(evidence); callback = &value; generation = token; return true; }
  bool start(uint64_t) noexcept override { ++evidence.start; return start_ok; }
  bool requestStop(uint64_t) noexcept override { ++evidence.stop; return stop_ok; }
  DriverObservation observe(uint64_t) noexcept override { return { observation_generation ? observation_generation : generation, fault, quiescent }; }
  bool detach(uint64_t) noexcept override { ++evidence.detach; if (!detach_ok) return false; callback = nullptr; resource.reset(); return true; }
  void shutdownAndJoin() noexcept override {
    ++evidence.join;
    { std::lock_guard lock(evidence.mutex); evidence.joining = true; evidence.changed.notify_all(); }
    if (worker.joinable()) worker.join();
    quiescent = true;
  }
  void dispatchBeforeEntry() {
    auto* retained = callback; const auto token = generation;
    worker = std::thread([&, retained, token] {
      { std::unique_lock lock(evidence.mutex); evidence.dispatched = true; evidence.changed.notify_all(); evidence.changed.wait(lock, [&] { return evidence.release; }); }
      std::array<std::byte, 4> out{}; out.fill(std::byte{0xff});
      evidence.delayed_frames = retained->render(token, out, 2).source_frames;
      { std::lock_guard lock(evidence.mutex); evidence.exited = true; evidence.changed.notify_all(); }
    });
  }
  output::Pull render(std::span<std::byte> out, uint32_t frames, uint64_t token = 0) { return callback->render(token ? token : generation, out, frames); }
  Evidence& evidence;
  CallbackContext* callback = nullptr;
  uint64_t generation = 0, observation_generation = 0;
  bool attach_ok = true, start_ok = true, stop_ok = true, detach_ok = true, quiescent = false;
  Fault fault = Fault::none;
  std::thread worker;
  std::unique_ptr<Resource> resource;
};
struct Fixture {
  Evidence evidence;
  FakeDriver* driver;
  DeviceSession session;
  Fixture(uint64_t frames = 4) : driver(new FakeDriver(evidence)), session(std::unique_ptr<Driver>(driver), {7, 2, frames, 4, 100}) {}
};
void finish(Fixture& f, uint64_t now = 2) { f.driver->quiescent = true; f.session.poll(now); }
}
int main() {
  {
    Fixture f; f.session.stop(0); check(!f.session.prepare() && !f.session.start(1), "取消先到不能注册或启动");
    check(f.evidence.attach == 0 && f.evidence.start == 0 && f.session.snapshot().reason == EndReason::cancelled, "取消先到保留原因且没有driver副作用");
  }
  {
    Fixture f; check(f.session.prepare() && !f.session.prepare(), "单会话只能注册一次");
    check(f.session.start(0) && !f.session.start(0), "单会话只能启动一次");
    f.session.stop(1); f.session.stop(1);
    check(f.evidence.start == 1 && f.evidence.stop == 1 && f.evidence.detach == 0, "重复取消幂等且ACK不释放");
    check(f.session.snapshot().stopAcknowledged && f.session.snapshot().cleanupPending, "ACK只确认请求且清理未完成");
    finish(f); check(f.evidence.detach == 1 && f.session.snapshot().stage == Stage::retired, "静止证明后才释放一次");
    f.session.poll(3); f.session.stop(3); check(!f.session.start(3) && f.evidence.detach == 1 && f.evidence.start == 1, "已释放不重启或重复释放");
  }
  {
    Evidence e;
    { auto driver = std::make_unique<FakeDriver>(e); driver->attach_ok = false; DeviceSession s(std::move(driver), {1, 2, 1, 4, 100}); check(!s.prepare(), "注册失败返回失败"); check(s.snapshot().reason == EndReason::driver_failure, "注册失败锁存原因"); }
    check(e.detach == 0 && e.join == 1 && e.destroyed == 1, "注册未取得资源不销毁伪句柄，析构仍经过屏障");
  }
  {
    Fixture f; f.driver->start_ok = false; check(f.session.prepare() && !f.session.start(0), "启动失败不伪运行");
    check(f.session.snapshot().reason == EndReason::driver_failure && f.evidence.stop == 1 && f.evidence.detach == 0, "启动失败保留已注册资源等静止");
    finish(f); check(f.evidence.detach == 1, "启动失败只释放实际已注册资源");
  }
  {
    Fixture f; f.session.prepare(); f.session.start(0); f.driver->stop_ok = false; f.session.stop(1); f.session.poll(101);
    const auto s = f.session.snapshot();
    check(!s.stopAcknowledged && s.cleanupTimedOut && s.cleanupPending && s.cleanupIssue == CleanupIssue::stop_failed, "停止失败与清理超时保留事实");
    check(s.reason == EndReason::cancelled && f.evidence.detach == 0, "超时不覆盖终止原因也不释放资源");
    finish(f, 102); check(f.session.snapshot().cleanupTimedOut && f.session.snapshot().stage == Stage::retired, "迟到静止可清理但不能擦掉超时事实");
  }
  {
    Fixture f; f.session.prepare(); f.session.start(0); f.session.stop(1); f.driver->quiescent = true; f.driver->observation_generation = 6; f.session.poll(2);
    check(f.evidence.detach == 0 && f.session.snapshot().cleanupPending, "旧代际静止证明不能释放当前资源");
    f.driver->observation_generation = 0; finish(f, 3); check(f.evidence.detach == 1, "当前代际静止证明有效");
  }
  {
    Fixture f; std::array<std::byte, 8> input{}; input.fill(std::byte{0x12}); f.session.publish(input); f.session.prepare(); f.session.start(0);
    std::array<std::byte, 4> out{}; out.fill(std::byte{0xff}); auto result = f.driver->render(out, 2, 6);
    check(result.source_frames == 0 && out == std::array<std::byte, 4>{} && f.session.snapshot().consumedFrames == 0, "旧代际回调静音且不消耗新会话");
    result = f.driver->render(out, 2); check(result.source_frames == 2 && out[0] == std::byte{0x12}, "当前代际仍使用真实FramePump");
    f.session.stop(1); f.driver->render(out, 2); check(f.session.snapshot().consumedFrames == 2 && out == std::array<std::byte, 4>{}, "停止后只填零不继续供帧"); finish(f);
  }
  for (const bool stale : {false, true}) {
    Fixture f; std::array<std::byte, 8> input{}; input.fill(std::byte{0x12});
    f.session.publish(input); f.session.prepare(); f.session.start(0);
    if (!stale) f.session.stop(1);
    const auto before = f.session.snapshot();
    struct InvalidShape { size_t bytes; uint32_t frames; };
    for (const auto shape : {InvalidShape{32770, 1}, InvalidShape{3, 2}, InvalidShape{2, 0}, InvalidShape{0, 0}, InvalidShape{8194, 4097}}) {
      std::vector<std::byte> output(shape.bytes, std::byte{0x7f});
      const auto result = f.driver->render(output, shape.frames, stale ? 6 : 7);
      check(result.source_frames == 0 && result.zero_frames == 0 && result.phase == output::Phase::failed,
        "停止或旧代际早退遇无效shape必须失败，不能虚报完整填零帧");
      check(std::all_of(output.begin(), output.end(), [&](auto byte) { return byte == (shape.bytes <= 32768 ? std::byte{0} : std::byte{0x7f}); }),
        "无效输出仅预算内安全清零，超预算不做无界写入");
      const auto after = f.session.snapshot();
      check(after.stage == before.stage && after.reason == before.reason && after.consumedFrames == before.consumedFrames,
        "无效早退不污染当前会话生命周期、终止原因或源帧计数");
    }
    std::array<std::byte, 4> output{}; output.fill(std::byte{0x7f});
    const auto result = f.driver->render(output, 2, stale ? 6 : 7);
    check(result.source_frames == 0 && result.zero_frames == 2 && result.phase == output::Phase::stopped && output == std::array<std::byte, 4>{},
      "早退只有完整有效shape真正清零后才报告零帧");
    if (stale) {
      const auto live = f.driver->render(output, 2);
      check(live.source_frames == 2 && output[0] == std::byte{0x12}, "旧代际无效shape后当前回调仍能消费原源帧");
      f.session.stop(1);
    }
    finish(f);
  }
  for (auto fault : {Fault::device_lost, Fault::route_changed, Fault::format_changed}) {
    Fixture f; f.session.prepare(); f.driver->fault = fault;
    check(!f.session.start(0) && f.evidence.start == 0, "注册后已报告变化，启动前必须重新核对并拒绝start");
    finish(f);
  }
  for (auto fault : {Fault::device_lost, Fault::route_changed, Fault::format_changed}) {
    Fixture f; f.session.prepare(); f.session.start(0); f.driver->fault = fault; f.session.poll(1);
    const auto reason = f.session.snapshot().reason; check(reason != EndReason::none && reason != EndReason::source_exhausted, "变化转为故障而不是完成");
    f.driver->fault = Fault::none; f.session.stop(2); finish(f, 3);
    check(f.session.snapshot().reason == reason && !f.session.start(4) && f.evidence.start == 1, "变化后不恢复、不换设备且原因不被取消覆盖");
  }
  {
    Fixture f; f.session.prepare(); f.session.start(0); f.session.stop(1); f.driver->quiescent = true; f.driver->detach_ok = false; f.session.poll(2);
    check(f.session.snapshot().cleanupPending && f.session.snapshot().cleanupIssue == CleanupIssue::detach_failed, "解除注册失败仍持有资源");
    f.driver->detach_ok = true; f.session.poll(3); check(f.session.snapshot().stage == Stage::retired && f.session.snapshot().cleanupIssue == CleanupIssue::detach_failed, "显式后续poll可清理但保留失败事实");
  }
  {
    Fixture f(3); std::array<std::byte, 6> input{std::byte{1}, std::byte{2}, std::byte{3}, std::byte{4}, std::byte{5}, std::byte{6}};
    check(f.session.publish(input) == 3, "预填真实源帧"); f.session.prepare(); f.session.start(0);
    std::array<std::byte, 8> out{}; out.fill(std::byte{0xff}); const auto result = f.driver->render(out, 4);
    check(result.source_frames == 3 && result.zero_frames == 1 && std::equal(input.begin(), input.end(), out.begin()) && out[6] == std::byte{0} && out[7] == std::byte{0}, "共享帧泵尾块保字节且只补数字零");
    f.session.poll(1); check(f.session.snapshot().reason == EndReason::source_exhausted && f.session.snapshot().cleanupPending && f.evidence.detach == 0, "源帧结束仅为源事实，不是设备排空或资源释放"); finish(f);
  }
  {
    Fixture f; f.session.prepare(); f.session.start(0); std::array<std::byte, 4> out{}; out.fill(std::byte{0xff}); f.driver->render(out, 2); f.session.poll(1);
    check(f.session.snapshot().reason == EndReason::underrun && f.session.snapshot().consumedFrames == 0 && out == std::array<std::byte, 4>{}, "真实空ring欠载锁存失败且不供替代内容"); finish(f);
  }
  {
    Fixture f; f.session.prepare(); f.session.start(0); std::array<std::byte, 3> out{}; out.fill(std::byte{0xff}); f.driver->render(out, 2); f.session.poll(1);
    check(f.session.snapshot().reason == EndReason::output_shape && out == std::array<std::byte, 3>{}, "不完整输出帧保留原帧泵错误且有界清零"); finish(f);
  }
  {
    Evidence e;
    std::thread control([&] {
      auto driver = std::make_unique<FakeDriver>(e); auto* fake = driver.get();
      DeviceSession s(std::move(driver), {8, 2, 2, 4, 100}); std::array<std::byte, 4> input{}; input.fill(std::byte{0x12});
      s.publish(input); s.prepare(); s.start(0); fake->dispatchBeforeEntry();
      { std::unique_lock lock(e.mutex); e.changed.wait(lock, [&] { return e.dispatched; }); }
      s.stop(1); s.poll(101);
      check(s.snapshot().cleanupPending && s.snapshot().cleanupTimedOut && e.detach == 0, "已取opaque但尚未进回调的窗口不能释放");
    });
    { std::unique_lock lock(e.mutex); e.changed.wait(lock, [&] { return e.joining; });
      check(!e.exited && e.detach == 0 && e.destroyed == 0 && e.released == 0, "析构屏障真实等待回调，context与Driver仍存活");
      e.release = true; e.changed.notify_all(); }
    control.join();
    check(e.exited && e.delayed_frames == 0 && e.detach == 1 && e.join == 1 && e.destroyed == 1 && e.released == 1, "回调退出后才释放一次，无悬空访问或泄漏");
  }
  {
    Evidence e;
    {
      auto driver = std::make_unique<FakeDriver>(e); driver->detach_ok = false;
      DeviceSession s(std::move(driver), {9, 2, 2, 4, 100}); s.prepare(); s.start(0); s.stop(1);
    }
    check(e.join == 1 && e.detach == 1 && e.released == 1 && e.destroyed == 1, "常规解除注册失败时，析构屏障后Driver的RAII仍释放自有资源");
  }
  {
    Fixture f; bool rejected = false;
    std::thread wrong([&] { try { f.session.prepare(); } catch (const std::logic_error&) { rejected = true; } }); wrong.join();
    check(rejected && f.evidence.attach == 0, "控制API拒绝非所属线程且不调用driver");
  }
  std::printf("通过：%d 个合成生命周期断言；无设备操作、无排空认证。\n", checks);
}
