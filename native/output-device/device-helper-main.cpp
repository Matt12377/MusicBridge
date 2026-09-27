#include "device-session.hpp"
#include "device-catalog-inspector.hpp"
#include "output-run-lease.hpp"
#include "system-device-probe.hpp"
#include <CommonCrypto/CommonDigest.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <poll.h>
#include <span>
#include <string>
#include <unistd.h>

using namespace output::device;
namespace {
constexpr int pcmFd = 3;
constexpr int leaseFd = 4;
constexpr size_t headerBytes = 320, controlBytes = 32, eventBytes = 64;
constexpr uint64_t maxDurationMs = 6ull * 60 * 60 * 1000;
uint16_t u16(const std::byte* p) { return uint16_t(p[0]) | uint16_t(p[1]) << 8; }
uint32_t u32(const std::byte* p) { return uint32_t(u16(p)) | uint32_t(u16(p + 2)) << 16; }
uint64_t u64(const std::byte* p) { return uint64_t(u32(p)) | uint64_t(u32(p + 4)) << 32; }
void put16(std::byte* p, uint16_t value) { p[0] = std::byte(value & 255); p[1] = std::byte(value >> 8); }
void put32(std::byte* p, uint32_t value) { put16(p, uint16_t(value)); put16(p + 2, uint16_t(value >> 16)); }
void put64(std::byte* p, uint64_t value) { put32(p, uint32_t(value)); put32(p + 4, uint32_t(value >> 32)); }
bool equal(const std::byte* p, const char* text, size_t count) { return std::memcmp(p, text, count) == 0; }
bool allZero(std::span<const std::byte> bytes) {
  return std::all_of(bytes.begin(), bytes.end(), [](std::byte value) { return value == std::byte{0}; });
}
bool readExactly(int fd, std::span<std::byte> bytes) {
  for (size_t offset = 0; offset < bytes.size();) {
    const auto n = ::read(fd, bytes.data() + offset, bytes.size() - offset);
    if (n > 0) offset += size_t(n);
    else if (n < 0 && errno == EINTR) continue;
    else return false;
  }
  return true;
}
bool writeExactly(int fd, std::span<const std::byte> bytes) {
  for (size_t offset = 0; offset < bytes.size();) {
    const auto n = ::write(fd, bytes.data() + offset, bytes.size() - offset);
    if (n > 0) offset += size_t(n);
    else if (n < 0 && errno == EINTR) continue;
    else return false;
  }
  return true;
}
uint32_t frameBytes(PcmFormat format, uint32_t channels) {
  const uint32_t sampleBytes = format == PcmFormat::s16le ? 2 : format == PcmFormat::packed_s24le ? 3 : 4;
  return sampleBytes * channels;
}
struct Request {
  std::array<std::byte, 16> runId;
  RequestedRoute route;
  std::array<std::byte, 32> pcmSha256;
  uint64_t totalBytes;
};
bool decodeHeader(const std::array<std::byte, headerBytes>& b, Request& out) {
  const auto uidLength = u16(b.data() + 24), rawFormat = u16(b.data() + 26);
  if (!equal(b.data(), "MBOD", 4) || u16(b.data() + 4) != 1 || u16(b.data() + 6) != headerBytes
    || uidLength < 1 || uidLength > 128 || (b[256] != std::byte{1} && b[256] != std::byte{2})
    || !allZero({b.data() + 257, 63})
    || !allZero({b.data() + 128 + uidLength, size_t(128 - uidLength)})) return false;
  const auto rate = u32(b.data() + 28), channels = u32(b.data() + 32), buffer = u32(b.data() + 36), capacity = u32(b.data() + 40);
  const auto zeroCallbacks = u32(b.data() + 44);
  const auto frames = u64(b.data() + 48), tail = u64(b.data() + 56);
  if (rawFormat < 1 || rawFormat > 4 || !frames || channels < 1 || channels > 2
    || ![&] { for (auto valid : {44100u, 48000u, 88200u, 96000u, 176400u, 192000u}) if (rate == valid) return true; return false; }()
    || buffer < 16 || buffer > 4096 || (buffer & (buffer - 1)) || capacity < buffer || capacity > 16384
    || tail < buffer || tail > 3840000 || zeroCallbacks < 1 || zeroCallbacks > 128
    || allZero({b.data() + 64, 32}) || allZero({b.data() + 96, 32})) return false;
  const auto format = static_cast<PcmFormat>(rawFormat);
  const uint64_t bytesPerFrame = frameBytes(format, channels);
  if (frames > std::numeric_limits<uint64_t>::max() / bytesPerFrame
    || frames > uint64_t(rate) * maxDurationMs / 1000) return false;
  out.totalBytes = frames * bytesPerFrame;
  std::memcpy(out.runId.data(), b.data() + 8, 16);
  out.route.scope = static_cast<OutputScope>(std::to_integer<uint8_t>(b[256]));
  std::memcpy(out.route.admissionSha256.data(), b.data() + 64, 32);
  std::memcpy(out.pcmSha256.data(), b.data() + 96, 32);
  out.route.uid.assign(reinterpret_cast<const char*>(b.data() + 128), uidLength);
  out.route.routeGeneration = 1; // helper本进程代际，从独立Probe观测；不复制Core选择代际。
  out.route.sampleRate = rate; out.route.channels = channels;
  out.route.format = format; out.route.physicalFormat = format;
  out.route.bufferFrames = buffer; out.route.capacityFrames = capacity; out.route.sourceFrames = frames;
  out.route.drainPolicy = {tail, zeroCallbacks};
  return out.route.uid.find('\0') == std::string::npos;
}
struct EventWriter {
  std::array<std::byte, 16> runId{};
  uint32_t sequence = 0;
  bool send(uint16_t kind, uint32_t code, uint64_t received, const SessionFacts& facts) {
    std::array<std::byte, eventBytes> b{};
    std::memcpy(b.data(), "MBDE", 4); put16(b.data() + 4, 1); put16(b.data() + 6, kind);
    put32(b.data() + 8, ++sequence); put32(b.data() + 12, code); std::memcpy(b.data() + 16, runId.data(), 16);
    put64(b.data() + 32, received); put64(b.data() + 40, facts.consumedFrames); put64(b.data() + 48, facts.zeroFilledFrames);
    b[56] = std::byte(facts.sourceEof); b[57] = std::byte(facts.hardwareDrained);
    b[58] = std::byte(facts.stopAcknowledged); b[59] = std::byte(facts.destroyAcknowledged);
    b[60] = std::byte(facts.callbackFault); b[61] = std::byte(facts.startAttempted);
    return writeExactly(STDOUT_FILENO, b);
  }
};
struct Terminal { uint16_t kind; uint32_t code; int exitCode; };
Terminal classifyTerminal(uint16_t kind, uint32_t code, const SessionFacts& facts) {
  if (kind == 6 && (!facts.startAttempted || !facts.hardwareDrained || !facts.stopAcknowledged
    || !facts.destroyAcknowledged || facts.callbackFault)) { kind = 8; code = 13; }
  if (kind == 7 && (!facts.destroyAcknowledged || (facts.startAttempted && !facts.stopAcknowledged))) {
    kind = 8; code = 13;
  }
  return {kind, code, kind == 6 ? 0 : kind == 7 ? 2 : 1};
}
[[noreturn]] void finish(DeviceOutputSession& session, EventWriter& writer, uint16_t kind, uint32_t code, uint64_t received) {
  const auto facts = session.sealAndDetach();
  const auto terminal = classifyTerminal(kind, code, facts);
  writer.send(terminal.kind, terminal.code, received, facts);
  // callback/listener opaque均为进程寿命内存；不运行析构，父进程必须等child.close。
  std::_Exit(terminal.exitCode);
}
bool control(const std::array<std::byte, controlBytes>& b, const Request& request, uint32_t expectedSequence, uint16_t& operation) {
  if (!equal(b.data(), "MBDC", 4) || u16(b.data() + 4) != 1 || !allZero({b.data() + 28, 4})
    || std::memcmp(b.data() + 8, request.runId.data(), 16) || u32(b.data() + 24) != expectedSequence) return false;
  operation = u16(b.data() + 6); return operation == 1 || operation == 2;
}
}
int main(int argc, char** argv) {
  if (argc == 2 && std::strcmp(argv[1], "--inspect") == 0) return runDeviceCatalogInspector();
  if (argc == 2 && std::strcmp(argv[1], "--lease-revoke") == 0) {
    // 私有恢复命令只读stdin的精确预期身份、使用继承的独立fd；绝不构造HAL对象。
    std::array<std::byte, outputRunLeaseBytes> expected{};
    if (!readExactly(STDIN_FILENO, expected)) return 3;
    const auto identity = decodeOutputRunLeaseIdentity(expected);
    if (!identity) return 3;
    const auto result = revokeOutputRunLease(leaseFd, *identity);
    return result == OutputRunLeaseResult::ready ? 0 : result == OutputRunLeaseResult::occupied ? 2 : 3;
  }
  if (argc != 1) return 1;
  std::array<std::byte, headerBytes> header{};
  if (!readExactly(STDIN_FILENO, header)) std::_Exit(1);
  Request request{};
  if (!decodeHeader(header, request)) std::_Exit(1);
  if (request.route.scope == OutputScope::formal_recording
    && acquireOutputRunLeaseForHeader(leaseFd, request.runId, request.pcmSha256, request.route.admissionSha256)
      != OutputRunLeaseResult::ready) std::_Exit(1);
  EventWriter writer{request.runId};
  SystemDeviceProbe probe; SystemHalShim shim;
  DeviceOutputSession session(probe, shim, request.route);
  if (!writer.send(1, 0, 0, session.facts())) std::_Exit(1);
  if (!session.prepare()) finish(session, writer, 8, 1, 0);
  if (!writer.send(2, 0, 0, session.facts())) finish(session, writer, 8, 12, 0);
  CC_SHA256_CTX digest{};
  if (CC_SHA256_Init(&digest) != 1) finish(session, writer, 8, 12, 0);
  std::array<std::byte, 4096 * 8> pcm{};
  std::array<std::byte, controlBytes> command{};
  size_t pcmCarry = 0, commandCarry = 0;
  uint64_t bytesReceived = 0, suppliedFrames = 0;
  uint32_t controlSequence = 1;
  bool runRequested = false, running = false, pipeEof = false, sourceEofSent = false;
  uint64_t lastProgressFrames = 0;
  auto lastProgressAt = std::chrono::steady_clock::now();
  const auto frameSize = frameBytes(request.route.format, request.route.channels);
  const auto durationMs = (request.route.sourceFrames * 1000 + request.route.sampleRate - 1) / request.route.sampleRate;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(durationMs + 30000);
  for (;;) {
    if (std::chrono::steady_clock::now() > deadline) finish(session, writer, 8, 10, suppliedFrames);
    if (running && !session.revalidate()) finish(session, writer, 8, 5, suppliedFrames);
    const auto state = session.facts();
    if (state.callbackFault) finish(session, writer, 8, 13, suppliedFrames);
    if (runRequested && !running && suppliedFrames >= std::min<uint64_t>(request.route.sourceFrames, request.route.bufferFrames)) {
      if (!session.start()) finish(session, writer, 8, 6, suppliedFrames);
      running = true;
      if (!writer.send(3, 0, suppliedFrames, session.facts())) finish(session, writer, 8, 12, suppliedFrames);
    }
    if (pipeEof && running && !sourceEofSent) {
      if (bytesReceived != request.totalBytes || pcmCarry) finish(session, writer, 8, 9, suppliedFrames);
      std::array<std::byte, CC_SHA256_DIGEST_LENGTH> actual{};
      CC_SHA256_Final(reinterpret_cast<unsigned char*>(actual.data()), &digest);
      if (actual != request.pcmSha256) finish(session, writer, 8, 8, suppliedFrames);
      sourceEofSent = true;
      if (!writer.send(4, 0, suppliedFrames, session.facts())) finish(session, writer, 8, 12, suppliedFrames);
    }
    if (sourceEofSent && running) {
      const auto readiness = session.pollDrain();
      if (readiness == DrainReadiness::invalid) finish(session, writer, 8, 7, suppliedFrames);
      if (readiness == DrainReadiness::ready) {
        if (!writer.send(5, 0, suppliedFrames, session.facts())) finish(session, writer, 8, 12, suppliedFrames);
        finish(session, writer, 6, 0, suppliedFrames);
      }
    }
    if (running) {
      const auto progress = session.facts();
      const auto sampledAt = std::chrono::steady_clock::now();
      if (progress.consumedFrames > suppliedFrames || progress.consumedFrames > request.route.sourceFrames)
        finish(session, writer, 8, 13, suppliedFrames);
      if (progress.consumedFrames > lastProgressFrames && sampledAt - lastProgressAt >= std::chrono::milliseconds(100)) {
        if (!writer.send(9, 0, suppliedFrames, progress)) finish(session, writer, 8, 12, suppliedFrames);
        lastProgressFrames = progress.consumedFrames;
        lastProgressAt = sampledAt;
      }
    }
    pollfd fds[2]{{STDIN_FILENO, POLLIN | POLLHUP, 0}, {pcmFd, 0, 0}};
    const auto freeBytes = uint64_t(session.writableFrames()) * frameSize;
    const auto availableBytes = freeBytes > pcmCarry ? freeBytes - pcmCarry : 0;
    if (!pipeEof && (bytesReceived == request.totalBytes || availableBytes)) fds[1].events = POLLIN | POLLHUP;
    const auto watched = fds[1].events ? 2 : 1;
    const int ready = ::poll(fds, watched, 10);
    if (ready < 0) { if (errno == EINTR) continue; finish(session, writer, 8, 12, suppliedFrames); }
    if (fds[0].revents & (POLLIN | POLLHUP)) {
      const auto n = ::read(STDIN_FILENO, command.data() + commandCarry, controlBytes - commandCarry);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) finish(session, writer, 7, 11, suppliedFrames);
      commandCarry += size_t(n);
      if (commandCarry == controlBytes) {
        uint16_t operation = 0;
        if (!control(command, request, controlSequence++, operation)) finish(session, writer, 8, 12, suppliedFrames);
        commandCarry = 0;
        if (operation == 2) finish(session, writer, 7, 11, suppliedFrames);
        if (runRequested) finish(session, writer, 8, 12, suppliedFrames);
        runRequested = true;
      }
    }
    if (watched == 2 && fds[1].revents & (POLLIN | POLLHUP)) {
      const uint64_t remaining = request.totalBytes - bytesReceived;
      const size_t want = remaining ? size_t(std::min<uint64_t>({remaining, availableBytes, pcm.size() - pcmCarry})) : 1;
      std::byte extra{};
      auto* destination = remaining ? pcm.data() + pcmCarry : &extra;
      const auto n = ::read(pcmFd, destination, want);
      if (n < 0) { if (errno == EINTR) continue; finish(session, writer, 8, 12, suppliedFrames); }
      if (n == 0) pipeEof = true;
      else if (!remaining) finish(session, writer, 8, 12, suppliedFrames);
      else {
        CC_SHA256_Update(&digest, destination, static_cast<CC_LONG>(n));
        bytesReceived += uint64_t(n); pcmCarry += size_t(n);
        const size_t whole = pcmCarry / frameSize * frameSize;
        if (whole) {
          const auto published = session.publish({pcm.data(), whole});
          if (published != whole / frameSize) finish(session, writer, 8, 13, suppliedFrames);
          suppliedFrames += published; pcmCarry -= whole;
          if (pcmCarry) std::memmove(pcm.data(), pcm.data() + whole, pcmCarry);
        }
      }
    }
  }
}
