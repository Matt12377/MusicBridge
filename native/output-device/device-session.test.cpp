#include "device-session.hpp"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <vector>

using namespace output::device;
namespace {
int checks = 0;
void check(bool value, const char* name) {
  ++checks;
  if (!value) { std::fprintf(stderr, "失败：%s\n", name); std::exit(1); }
}
class FakeProbe final : public DeviceProbe {
 public:
  std::optional<DeviceObservation> observeExact(std::string_view uid) noexcept override {
    ++observations; requestedUid.assign(uid);
    if (next < values.size()) return values[next++];
    return values.empty() ? std::nullopt : values.back();
  }
  const std::atomic<uint64_t>* eventEpoch() const noexcept override { return &epoch; }
  std::atomic<uint64_t> epoch{42};
  std::vector<std::optional<DeviceObservation>> values;
  size_t next = 0;
  int observations = 0;
  std::string requestedUid;
};
class FakeShim final : public HalShim {
 public:
  OSStatus create(AudioObjectID device, AudioDeviceIOProc callback, void* opaque, AudioDeviceIOProcID* id) noexcept override {
    ++creates; createdDevice = device; proc = callback; context = opaque;
    if (createFails) return -1;
    *id = reinterpret_cast<AudioDeviceIOProcID>(0x1); return noErr;
  }
  OSStatus start(AudioObjectID device, AudioDeviceIOProcID) noexcept override {
    ++starts; startedDevice = device; return startFails ? -1 : noErr;
  }
  OSStatus stop(AudioObjectID, AudioDeviceIOProcID) noexcept override { ++stops; return noErr; }
  OSStatus destroy(AudioObjectID, AudioDeviceIOProcID) noexcept override { ++destroys; return noErr; }
  OSStatus currentTime(AudioObjectID device, AudioTimeStamp* out) noexcept override {
    ++clockReads; if (device != createdDevice || clockFails) return -1;
    out->mFlags = clockValid ? kAudioTimeStampSampleTimeValid | kAudioTimeStampHostTimeValid : 0;
    out->mSampleTime = clockSample; out->mHostTime = clockHost; return noErr;
  }
  template<size_t N> void render(std::array<std::byte, N>& bytes, double sampleTime = 0, uint64_t hostTime = 0) const {
    AudioBufferList output{}; output.mNumberBuffers = 1; output.mBuffers[0].mNumberChannels = 2;
    output.mBuffers[0].mDataByteSize = static_cast<UInt32>(bytes.size()); output.mBuffers[0].mData = bytes.data();
    AudioTimeStamp time{}; AudioBufferList input{};
    time.mSampleTime = sampleTime; time.mHostTime = hostTime;
    if (hostTime) time.mFlags = kAudioTimeStampSampleTimeValid | kAudioTimeStampHostTimeValid;
    proc(createdDevice, &time, &input, &time, &output, &time, context);
  }
  int creates = 0, starts = 0, stops = 0, destroys = 0, clockReads = 0;
  bool createFails = false, startFails = false, clockFails = false, clockValid = true;
  double clockSample = 0;
  uint64_t clockHost = 0;
  AudioObjectID createdDevice = kAudioObjectUnknown, startedDevice = kAudioObjectUnknown;
  AudioDeviceIOProc proc = nullptr;
  void* context = nullptr;
};
RequestedRoute route() {
  RequestedRoute value{OutputScope::formal_recording, "output-uid-01", 42, 48000, 2, PcmFormat::s16le, PcmFormat::s16le, 4, 3, 8, {}};
  value.admissionSha256[0] = std::byte{0x42}; return value;
}
DeviceObservation observed() { return {"output-uid-01", 71, 42, 48000, 2, PcmFormat::s16le, PcmFormat::s16le, 4, true, true}; }
}
int main() {
  {
    FakeProbe probe; FakeShim shim; auto invalid = route(); invalid.admissionSha256 = {};
    DeviceOutputSession session(probe, shim, invalid);
    check(!session.prepare() && session.facts().failure == QualificationFailure::invalid_request
      && probe.observations == 0 && shim.creates == 0, "缺scope身份摘要在设备观测前即拒绝");
  }
  {
    FakeProbe probe; FakeShim shim; auto invalid = route(); invalid.scope = static_cast<OutputScope>(3);
    DeviceOutputSession session(probe, shim, invalid);
    check(!session.prepare() && probe.observations == 0 && shim.creates == 0, "未知输出scope在HAL观测前拒绝");
  }
  {
    FakeProbe probe; FakeShim shim; probe.values = {std::nullopt};
    DeviceOutputSession session(probe, shim, route());
    check(!session.prepare() && session.facts().failure == QualificationFailure::observation_unavailable
      && probe.requestedUid == "output-uid-01" && shim.creates == 0, "只查询精确UID，无法观测时不选默认设备");
  }
  {
    FakeProbe probe; FakeShim shim; auto changed = observed(); changed.sampleRate = 44100; probe.values = {changed};
    DeviceOutputSession session(probe, shim, route());
    check(!session.prepare() && session.facts().failure == QualificationFailure::identity_mismatch && shim.creates == 0,
      "格式失配在HAL注册前拒绝");
  }
  {
    FakeProbe probe; FakeShim shim; auto changed = observed(); changed.physicalFormat = PcmFormat::f32le; probe.values = {changed};
    DeviceOutputSession session(probe, shim, route());
    check(!session.prepare() && session.facts().failure == QualificationFailure::identity_mismatch && shim.creates == 0,
      "虚拟PCM相同但物理格式不同，不允许HAL隐式转换");
  }
  {
    FakeProbe probe; FakeShim shim; probe.values = {observed(), observed()};
    DeviceOutputSession session(probe, shim, route());
    check(session.prepare(), "取消前只完成HAL注册，不启动设备");
    const auto facts = session.sealAndDetach();
    check(!facts.startAttempted && !facts.stopAcknowledged && facts.destroyAcknowledged && shim.starts == 0 && shim.stops == 0,
      "Prepared后Run前取消只要求Destroy；不得捏造Stop ACK或首帧");
  }
  {
    FakeProbe probe; FakeShim shim; auto changed = observed(); changed.routeGeneration++;
    probe.values = {observed(), changed}; DeviceOutputSession session(probe, shim, route());
    check(!session.prepare() && session.facts().failure == QualificationFailure::route_changed
      && probe.observations == 2 && shim.creates == 0, "构造与HAL注册之间路由漂移不注册设备");
  }
  {
    FakeProbe probe; FakeShim shim; auto changed = observed(); changed.device = 72;
    probe.values = {observed(), observed(), changed}; DeviceOutputSession session(probe, shim, route());
    check(session.prepare() && !session.start() && session.facts().failure == QualificationFailure::route_changed
      && shim.creates == 1 && shim.starts == 0 && shim.createdDevice == 71, "start前设备对象漂移拒绝且不切别的设备");
    session.sealAndDetach(); check(shim.destroys == 1, "拒绝后仍解除原设备注册");
  }
  {
    FakeProbe probe; FakeShim shim; auto changed = observed(); changed.bufferFrames = 8;
    probe.values = {observed(), observed(), observed(), observed(), changed}; DeviceOutputSession session(probe, shim, route());
    const std::array<std::byte, 12> pcm{};
    check(session.prepare() && session.publish(pcm) == 3 && session.start() && shim.startedDevice == 71,
      "仅在精确配置复核和预填充后启动指定设备");
    check(!session.revalidate() && session.facts().failure == QualificationFailure::route_changed && shim.stops == 1,
      "运行中缓冲漂移封闭派发，不续播或默认回退");
    const auto facts = session.sealAndDetach();
    check(facts.startAttempted && facts.stopAcknowledged && facts.destroyAcknowledged && !facts.hardwareDrained && !facts.callbacksQuiescent,
      "Stop和Destroy回执不升级为回调静止或硬件排空");
  }
  {
    FakeProbe probe; FakeShim shim; probe.values = {observed(), observed(), observed(), observed()};
    DeviceOutputSession session(probe, shim, route());
    const std::array<std::byte, 12> pcm{std::byte{1}, std::byte{2}, std::byte{3}, std::byte{4}};
    check(session.prepare() && session.publish(pcm) == 3 && session.start(), "含合法尾静音的源时间线已启动");
    std::array<std::byte, 16> output{}; output.fill(std::byte{0x7f}); shim.render(output);
    check(output[0] == std::byte{1} && output[3] == std::byte{4}
      && std::all_of(output.begin() + 4, output.end(), [](std::byte byte) { return byte == std::byte{0}; })
      && session.facts().consumedFrames == 3 && session.facts().sourceEof && !session.facts().callbackFault,
      "尾部零样本是两个完整源帧，另一个安全零帧不混入源帧计数");
    session.sealAndDetach();
  }
  {
    FakeProbe probe; FakeShim shim; auto certified = route(); certified.drainPolicy = {8, 2};
    probe.values = {observed(), observed(), observed(), observed(), observed(), observed(), observed(), observed(), observed(), observed()};
    DeviceOutputSession session(probe, shim, certified);
    const std::array<std::byte, 12> pcm{std::byte{1}, std::byte{2}, std::byte{3}, std::byte{4}};
    check(session.prepare() && session.publish(pcm) == 3 && session.start(), "受信尾部参数样本已启动");
    std::array<std::byte, 16> output{};
    shim.render(output, 100, 10); shim.render(output, 104, 20); shim.render(output, 108, 50);
    shim.clockSample = 110; shim.clockHost = 35;
    check(session.pollDrain() == DrainReadiness::pending && !session.facts().hardwareDrained,
      "源时间线含静音完整消费后，当前设备时钟仍不足不能给排空回执");
    shim.clockSample = 111; shim.clockHost = 41;
    check(session.pollDrain() == DrainReadiness::ready && session.facts().hardwareDrained && !session.facts().callbacksQuiescent,
      "受信尾部边界、连续数字零与设备时间均满足才报告HAL时间候选");
    session.sealAndDetach();
  }
  {
    FakeProbe probe; FakeShim shim; probe.values = {observed(), observed(), observed()};
    DeviceOutputSession session(probe, shim, route()); const std::array<std::byte, 12> pcm{};
    check(session.prepare() && session.publish(pcm) == 3, "监听代际样本已预填");
    // 属性短暂改变又恢复，读取值与设备对象仍完全相同；事件代际必须独立锁存。
    probe.epoch.store(43, std::memory_order_release);
    check(!session.start() && session.facts().failure == QualificationFailure::route_changed && shim.starts == 0,
      "改变后恢复的精确属性也不得在旧会话上启动");
    session.sealAndDetach();
  }
  {
    FakeProbe probe; FakeShim shim; probe.values = {observed(), observed(), observed(), observed()};
    DeviceOutputSession session(probe, shim, route()); const std::array<std::byte, 12> pcm{};
    check(session.prepare() && session.publish(pcm) == 3 && session.start(), "运行中代际样本已启动");
    probe.epoch.store(43, std::memory_order_release);
    std::array<std::byte, 16> output{}; output.fill(std::byte{0x7f}); shim.render(output);
    check(output == std::array<std::byte, 16>{} && session.facts().callbackFault,
      "HAL通知后的实时回调只读原子代际并静音，不在回调查询属性");
    check(!session.revalidate() && session.facts().failure == QualificationFailure::route_changed,
      "恢复到原值的假观测不能覆盖锁存事件");
    session.sealAndDetach();
  }
  {
    FakeProbe probe; FakeShim shim; auto changed = observed(); changed.routeGeneration++;
    probe.values = {observed(), observed(), observed(), changed}; DeviceOutputSession session(probe, shim, route());
    const std::array<std::byte, 12> pcm{};
    check(session.prepare() && session.publish(pcm) == 3 && !session.start()
      && session.facts().failure == QualificationFailure::route_changed && shim.starts == 1 && shim.stops == 1,
      "HAL启动同步派发后路由漂移立即停止，不返回可继续运行的成功");
    session.sealAndDetach(); check(shim.destroys == 1, "同步启动漂移仍解除注册");
  }
  {
    FakeProbe probe; FakeShim shim; shim.createFails = true; probe.values = {observed(), observed()};
    DeviceOutputSession session(probe, shim, route());
    check(!session.prepare() && session.facts().failure == QualificationFailure::hal_rejected && shim.creates == 1 && shim.starts == 0,
      "HAL拒绝后不启动、不重复注册");
  }
  std::printf("通过：%d 个受控设备会话断言；未枚举、打开设备或发声。\n", checks);
}
