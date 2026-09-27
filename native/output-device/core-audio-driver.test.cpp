#include "core-audio-driver.hpp"
#include <array>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <thread>

using namespace output::device;
namespace {
int checks = 0;
void check(bool value, const char* name) { ++checks; if (!value) { std::fprintf(stderr, "失败：%s\n", name); std::exit(1); } }
class FakeShim final : public HalShim {
 public:
  OSStatus create(AudioObjectID device, AudioDeviceIOProc callback, void* opaque, AudioDeviceIOProcID* id) noexcept override {
    ++creates; deviceSeen = device; proc = callback; context = opaque;
    if (createFails) return -1;
    *id = reinterpret_cast<AudioDeviceIOProcID>(0x1); return noErr;
  }
  OSStatus start(AudioObjectID, AudioDeviceIOProcID) noexcept override { ++starts; return startFails ? -1 : noErr; }
  OSStatus stop(AudioObjectID, AudioDeviceIOProcID) noexcept override { ++stops; return stopFails ? -1 : noErr; }
  OSStatus destroy(AudioObjectID, AudioDeviceIOProcID) noexcept override { ++destroys; return destroyFails ? -1 : noErr; }
  template<size_t N> void render(std::array<std::byte, N>& bytes, uint32_t channels = 1) const {
    AudioBufferList list{}; list.mNumberBuffers = 1; list.mBuffers[0].mNumberChannels = channels;
    list.mBuffers[0].mDataByteSize = static_cast<UInt32>(bytes.size()); list.mBuffers[0].mData = bytes.data();
    AudioTimeStamp time{}; AudioBufferList input{};
    proc(deviceSeen, &time, &input, &time, &list, &time, context);
  }
  int creates = 0, starts = 0, stops = 0, destroys = 0;
  bool createFails = false, startFails = false, stopFails = false, destroyFails = false;
  AudioObjectID deviceSeen = kAudioObjectUnknown;
  AudioDeviceIOProc proc = nullptr;
  void* context = nullptr;
};
Config config() { return {42, 2, 1, 4, 3, 8}; }
}
int main() {
  {
    FakeShim shim; bool invalid = false;
    try { CoreAudioDriver driver(shim, {kAudioObjectUnknown, 2, 1, 4, 3, 8}); }
    catch (const std::invalid_argument&) { invalid = true; }
    check(invalid && shim.creates == 0, "没有已准入设备ID时不枚举、不注册也不选默认设备");
  }
  {
    FakeShim shim; CoreAudioDriver driver(shim, config());
    check(!driver.start() && shim.starts == 0, "未注册不能start");
    check(driver.prepare() && !driver.prepare() && shim.creates == 1 && shim.deviceSeen == 42, "只注册指定设备一次");
    const std::array<std::byte, 6> pcm{std::byte{1}, std::byte{2}, std::byte{3}, std::byte{4}, std::byte{5}, std::byte{6}};
    check(driver.publish(pcm) == 3 && driver.start() && !driver.start() && shim.starts == 1, "预填后仅启动一次");
    std::array<std::byte, 8> out{}; out.fill(std::byte{0x7f}); shim.render(out);
    check(out[0] == std::byte{1} && out[5] == std::byte{6} && out[6] == std::byte{0} && out[7] == std::byte{0}, "尾块精确保留源帧并只用数字零补齐");
    const auto source = driver.facts();
    check(source.sourceEof && source.consumedFrames == 3 && source.zeroFilledFrames == 1 && !source.stopAcknowledged && !source.hardwareDrained && !source.callbacksQuiescent,
      "EOF不推导Stop、静止、硬件排空或实体完成");
    driver.stop(); driver.stop(); const auto closed = driver.sealAndDetach();
    check(closed.stopAcknowledged && closed.destroyAcknowledged && !closed.callbacksQuiescent && !closed.hardwareDrained && shim.stops == 1 && shim.destroys == 1,
      "Stop/Destroy回执分离且不冒充回调静止或排空");
    check(!driver.start() && driver.publish(pcm) == 0, "关闭后不重启、不复用源");
  }
  {
    FakeShim shim;
    {
      auto driver = std::make_unique<CoreAudioDriver>(shim, config());
      const std::array<std::byte, 6> pcm{std::byte{1}, std::byte{2}, std::byte{3}, std::byte{4}, std::byte{5}, std::byte{6}};
      check(driver->prepare() && driver->publish(pcm) == 3 && driver->start(), "延迟回调样本已注册启动");
      // shim先取opaque；driver随后析构，模拟已派发但尚未进入回调的窗口。
    }
    std::array<std::byte, 8> delayed{}; delayed.fill(std::byte{0x7f});
    std::thread late([&] { shim.render(delayed); }); late.join();
    check(delayed == std::array<std::byte, 8>{} && shim.stops == 1 && shim.destroys == 1,
      "Driver析构后迟到opaque仅访问进程寿命Cell，完整填零且不UAF");
  }
  {
    FakeShim shim; shim.startFails = true; CoreAudioDriver driver(shim, config());
    const std::array<std::byte, 6> pcm{};
    check(driver.prepare() && driver.publish(pcm) == 3 && !driver.start(), "失败start不能发布运行");
    const auto facts = driver.sealAndDetach();
    check(shim.starts == 1 && shim.stops == 1 && shim.destroys == 1 && !driver.start() && facts.stopAcknowledged,
      "部分start失败仍请求Stop并解除注册，且不迟到重启");
  }
  {
    FakeShim shim; shim.createFails = true; CoreAudioDriver driver(shim, config());
    check(!driver.prepare() && !driver.start() && shim.destroys == 0 && shim.stops == 0, "注册失败没有伪清理设备句柄");
  }
  {
    FakeShim shim; CoreAudioDriver driver(shim, config());
    const std::array<std::byte, 6> pcm{};
    driver.prepare(); driver.publish(pcm); driver.start();
    std::array<std::byte, 3> malformed{}; malformed.fill(std::byte{0x7f}); shim.render(malformed);
    check(malformed == std::array<std::byte, 3>{} && driver.facts().callbackFault, "输出shape故障有界清零并锁存，不换设备");
    driver.sealAndDetach();
  }
  std::printf("通过：%d 个受控HAL shim断言；没有枚举/open设备或发声。\n", checks);
}
