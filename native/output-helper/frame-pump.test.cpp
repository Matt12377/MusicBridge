#include "frame-pump.hpp"
#include <array>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>
using namespace output;
static int checks = 0;
static void check(bool yes, const char* message) { ++checks; if (!yes) { std::fprintf(stderr, "FAIL %s\n", message); std::exit(1); } }
int main() {
  {
    FramePump pump(2, 7, 4); std::array<std::byte, 14> input{};
    for (size_t i = 0; i < input.size(); ++i) input[i] = std::byte(i + 1);
    check(pump.start(), "必须进入运行状态");
    check(pump.publish(std::span(input).first(8)) == 4, "写入四个真实帧");
    std::array<std::byte, 6> a{}; auto r = pump.pull(a, 3);
    check(r.source_frames == 3 && std::equal(a.begin(), a.end(), input.begin()), "首块字节保持");
    check(pump.publish(std::span(input).subspan(8)) == 3, "环绕后补齐");
    std::array<std::byte, 12> b{}; b.fill(std::byte{0xff}); r = pump.pull(b, 6);
    check(r.source_frames == 4 && r.zero_frames == 2 && r.phase == Phase::drained, "末块只补零不欠载");
    check(std::equal(b.begin(), b.begin() + 8, input.begin() + 6), "环绕保持原帧顺序");
    check(b[8] == std::byte{0} && b[11] == std::byte{0} && pump.consumed() == 7, "尾块没有漏帧或复制旧数据");
  }
  {
    FramePump pump(6, 3, 4); std::array<std::byte, 18> input{}; input.fill(std::byte{0x7f});
    check(pump.start() && pump.publish(input) == 3, "packed24整帧入队");
    std::array<std::byte, 6> out{}; pump.pull(out, 1); pump.stop(); out.fill(std::byte{0xff});
    auto r = pump.pull(out, 1);
    check(r.phase == Phase::stopped && r.source_frames == 0 && pump.consumed() == 1, "停止不继续泵完整源");
    check(out[0] == std::byte{0} && out[5] == std::byte{0}, "停止输出数字零");
    pump.pull(out, 1); check(pump.consumed() == 1 && !pump.start(), "终态不隐式恢复");
  }
  {
    FramePump pump(4, 8); check(pump.start(), "欠载场景启动");
    std::array<std::byte, 16> out{}; out.fill(std::byte{0xff});
    auto r = pump.pull(out, 4);
    check(r.phase == Phase::failed && pump.reason() == Reason::underrun && r.source_frames == 0, "真实ring不足必须欠载失败");
    check(out.front() == std::byte{0} && out.back() == std::byte{0}, "欠载不输出旧buffer内容");
  }
  {
    FramePump pump(2, 1); pump.stop(); check(!pump.start(), "取消先到不得启动");
  }
  {
    FramePump pump(4, 2); pump.start(); std::array<std::byte, 7> out{}; out.fill(std::byte{0xff});
    const auto result = pump.pull(out, 2);
    check(result.phase == Phase::failed && pump.reason() == Reason::output_shape, "不完整输出帧失败而非越界写");
    check(out.front() == std::byte{0} && out.back() == std::byte{0}, "不完整输出区域安全清零");
  }
  {
    constexpr uint32_t frames = 100003;
    FramePump pump(2, frames, 4096); pump.start(); std::vector<std::byte> input(size_t(frames) * 2), actual(input.size());
    for (size_t i = 0; i < input.size(); ++i) input[i] = std::byte(i % 251);
    std::thread producer([&] {
      uint32_t cursor = 0;
      while (cursor < frames) {
        const auto published = pump.publish(std::span(input).subspan(size_t(cursor) * 2, size_t(std::min(uint32_t(997), frames - cursor)) * 2));
        cursor += published; if (!published) std::this_thread::yield();
      }
    });
    uint32_t cursor = 0;
    while (cursor < frames) {
      const auto count = std::min(uint32_t(257), frames - cursor);
      if (pump.available() < count) { std::this_thread::yield(); continue; }
      const auto result = pump.pull(std::span(actual).subspan(size_t(cursor) * 2, size_t(count) * 2), count);
      cursor += result.source_frames;
    }
    producer.join();
    check(actual == input && pump.phase() == Phase::drained, "真实双线程SPSC消费无丢帧重帧或数据竞争式旧块");
    check(pump.consumed() == frames && pump.zeros() == 0, "双线程帧数守恒");
  }
  std::printf("PASS %d 个共享帧泵断言\n", checks);
}
