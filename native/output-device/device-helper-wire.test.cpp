// 编入正式helper的同一私有字节编解码函数，但绝不调用会构造SystemDeviceProbe的入口。
#define main device_helper_entry
#include "device-helper-main.cpp"
#undef main
#include <cstdio>

namespace {
int checks = 0;
void check(bool result, const char* name) {
  ++checks; if (!result) { std::fprintf(stderr, "失败：%s\n", name); std::exit(1); }
}
}
int main() {
  std::array<std::byte, headerBytes> header{};
  std::memcpy(header.data(), "MBOD", 4); put16(header.data() + 4, 1); put16(header.data() + 6, headerBytes);
  for (size_t index = 0; index < 16; ++index) header[8 + index] = std::byte(index);
  put16(header.data() + 24, 6); put16(header.data() + 26, 1); put32(header.data() + 28, 48000);
  put32(header.data() + 32, 2); put32(header.data() + 36, 16); put32(header.data() + 40, 32);
  put32(header.data() + 44, 2); put64(header.data() + 48, 8); put64(header.data() + 56, 16);
  header[64] = std::byte{0xaa}; header[96] = std::byte{0xbb}; std::memcpy(header.data() + 128, "device", 6);
  header[256] = std::byte{1};
  Request request{};
  check(decodeHeader(header, request) && request.route.uid == "device" && request.route.sourceFrames == 8
    && request.route.drainPolicy.tailFrames == 16 && request.totalBytes == 32
    && request.route.scope == OutputScope::formal_recording, "320字节MBOD头与TS固定偏移一致");
  auto changed = header; changed[256] = std::byte{2};
  check(decodeHeader(changed, request) && request.route.scope == OutputScope::replica_playback,
    "普通Replica具有独立scope而不冒用正式Gate B身份");
  changed = header; changed[256] = std::byte{0};
  check(!decodeHeader(changed, request), "缺失scope拒绝");
  changed = header; changed[256] = std::byte{3};
  check(!decodeHeader(changed, request), "未知scope拒绝");
  changed = header; changed[257] = std::byte{1};
  check(!decodeHeader(changed, request), "scope后保留字节非零拒绝");
  changed = header; put16(changed.data() + 24, 129);
  check(!decodeHeader(changed, request), "UID长度超界在任何UID尾指针运算前拒绝");
  changed = header; changed[64] = std::byte{0};
  check(!decodeHeader(changed, request), "全零Gate B记录Hash拒绝");
  changed = header; changed[96] = std::byte{0};
  check(!decodeHeader(changed, request), "全零PCM Hash拒绝");
  std::array<std::byte, controlBytes> command{};
  std::memcpy(command.data(), "MBDC", 4); put16(command.data() + 4, 1); put16(command.data() + 6, 1);
  std::memcpy(command.data() + 8, header.data() + 8, 16); put32(command.data() + 24, 1);
  uint16_t operation = 0;
  check(control(command, request, 1, operation) && operation == 1 && !control(command, request, 2, operation),
    "RUN控制序号绑定，重复序号不能复用");
  put16(command.data() + 6, 2); put32(command.data() + 24, 2);
  check(control(command, request, 2, operation) && operation == 2, "CANCEL控制opcode与序号一致");
  int fds[2]{}; check(::pipe(fds) == 0, "仅建内存管道收集事件字节");
  const int original = ::dup(STDOUT_FILENO); check(original >= 0 && ::dup2(fds[1], STDOUT_FILENO) >= 0, "重定向Fake事件输出");
  ::close(fds[1]);
  EventWriter writer{request.runId};
  const SessionFacts facts{QualificationFailure::none, true, true, false, true, false, false, false, 4, 1, false, false};
  const bool sent = writer.send(9, 0, 8, facts);
  check(::dup2(original, STDOUT_FILENO) >= 0, "恢复测试输出"); ::close(original);
  std::array<std::byte, eventBytes> event{};
  check(sent && readExactly(fds[0], event), "收到完整64字节MBDE事件"); ::close(fds[0]);
  check(equal(event.data(), "MBDE", 4) && u16(event.data() + 4) == 1 && u16(event.data() + 6) == 9
    && u32(event.data() + 8) == 1 && u32(event.data() + 12) == 0
    && u64(event.data() + 32) == 8 && u64(event.data() + 40) == 4 && u64(event.data() + 48) == 1
    && event[56] == std::byte{0} && event[60] == std::byte{0} && event[61] == std::byte{1}
    && allZero({event.data() + 62, 2}),
    "进度字段、runId、flags与TS事件解码位置一致");
  const SessionFacts prepared{QualificationFailure::none, true, false, false, false, false, true, false, 0, 0, false, false};
  const auto neverStarted = classifyTerminal(7, 11, prepared);
  check(neverStarted.kind == 7 && neverStarted.exitCode == 2 && !prepared.stopAcknowledged,
    "Prepared后Run前取消凭never-started+Destroy证明，不伪造Stop ACK");
  const SessionFacts started{QualificationFailure::none, true, false, false, true, true, true, false, 2, 0, false, false};
  const auto stopped = classifyTerminal(7, 11, started);
  check(stopped.kind == 7 && stopped.exitCode == 2 && started.stopAcknowledged,
    "已尝试启动的取消必须有Stop和Destroy ACK");
  auto badStop = started; badStop.stopAcknowledged = false;
  check(classifyTerminal(7, 11, badStop).kind == 8, "已尝试启动但Stop失败不能报正常取消");
  std::printf("通过：%d 个原生协议字节断言；未调用helper入口、HAL或发声。\n", checks);
}
