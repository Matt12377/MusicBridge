#include "drain-observer.hpp"
#include <cstdio>
#include <cstdlib>

using namespace output::device;
namespace {
int checks = 0;
void check(bool value, const char* name) {
  ++checks; if (!value) { std::fprintf(stderr, "失败：%s\n", name); std::exit(1); }
}
DeviceTimePoint moment(double sample, uint64_t host) { return {sample, host, true, true}; }
}
int main() {
  const CertifiedDrainPolicy policy{8, 2};
  DrainObserver observer(5);
  check(observer.evaluate(moment(100, 10), policy, true, false) == DrainReadiness::pending, "未提交源帧不能排空");
  check(observer.onCallback(moment(100, 10), 4, 4, 0), "第一批源时间线帧");
  check(observer.onCallback(moment(104, 20), 4, 1, 3), "末源帧即使值为零也按时间线计数");
  check(observer.lastSourceFrameEnd() == 105 && observer.sourceFramesSeen() == 5 && observer.safeZeroThrough() == 108,
    "安全零填充与末源帧分开计数");
  check(observer.evaluate(moment(106, 25), policy, true, false) == DrainReadiness::pending,
    "源完成不自动推出设备排空");
  check(observer.onCallback(moment(108, 30), 4, 0, 4), "末帧后的连续安全零");
  check(observer.onCallback(moment(112, 40), 4, 0, 4), "第二次连续安全零");
  check(observer.evaluate(moment(112, 35), policy, true, false) == DrainReadiness::pending,
    "设备当前sampleTime未越过受信尾部上限不通过");
  check(observer.evaluate(moment(113, 37), policy, true, false) == DrainReadiness::ready,
    "最新零回调未来hostTime为40，当前hostTime仅37仍可凭同一设备sample时间线越界");
  check(observer.evaluate(moment(113, 37), policy, false, false) == DrainReadiness::invalid,
    "设备路由撤权不能沿用已有时间证据");
  check(observer.evaluate(moment(113, 37), policy, true, true) == DrainReadiness::invalid,
    "回调故障不能沿用已有时间证据");
  check(observer.evaluate({113, 37, false, true}, policy, true, false) == DrainReadiness::invalid,
    "缺设备当前sampleTime有效位不能推断排空");
  check(observer.evaluate(moment(113, 37), {0, 2}, true, false) == DrainReadiness::invalid,
    "缺受信尾部上限不能把EOF/close升级为排空");
  DrainObserver zeroShort(1);
  check(zeroShort.onCallback(moment(200, 10), 4, 1, 3)
    && zeroShort.evaluate(moment(210, 15), policy, true, false) == DrainReadiness::pending,
    "当前设备时钟足够但后续安全零覆盖不足仍不通过");
  DrainObserver broken(2);
  check(broken.onCallback(moment(200, 50), 2, 2, 0) && !broken.onCallback(moment(203, 60), 2, 0, 2)
    && broken.evaluate(moment(220, 100), policy, true, false) == DrainReadiness::invalid,
    "回调sampleTime不连续后即使时钟足够也锁存失败");
  DrainObserver invalidClock(1);
  check(!invalidClock.onCallback({300, 50, true, false}, 1, 1, 0) && invalidClock.fault(),
    "输出时间戳缺host有效位时不继续证明");
  std::printf("通过：%d 个受控排空时间线断言；未调用HAL或发声。\n", checks);
}
