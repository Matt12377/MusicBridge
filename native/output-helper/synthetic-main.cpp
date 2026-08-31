#include "frame-pump.hpp"
#include <CommonCrypto/CommonDigest.h>
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace {
using output::Reason;
using Bytes = std::array<unsigned char, 32>;
struct Failure { Reason reason; };
[[noreturn]] void fail(Reason reason) { throw Failure{reason}; }
uint64_t now() { return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()); }
uint64_t get(const unsigned char* bytes, size_t count) { uint64_t value = 0; for (size_t i = 0; i < count; ++i) value |= uint64_t(bytes[i]) << (i * 8); return value; }
void put(unsigned char* bytes, uint64_t value, size_t count) { for (size_t i = 0; i < count; ++i) bytes[i] = static_cast<unsigned char>(value >> (i * 8)); }
struct Hash {
  CC_SHA256_CTX context{};
  Hash() { if (CC_SHA256_Init(&context) != 1) fail(Reason::internal); }
  void add(const void* bytes, size_t size) { if (size > 1024 * 1024 || CC_SHA256_Update(&context, bytes, static_cast<CC_LONG>(size)) != 1) fail(Reason::internal); }
  Bytes digest() const { auto copy = context; Bytes result{}; if (CC_SHA256_Final(result.data(), &copy) != 1) fail(Reason::internal); return result; }
};
struct Header {
  std::array<unsigned char, 256> raw{};
  uint64_t size = 0, offset = 0, bytes = 0, frames = 0;
  uint32_t rate = 0, channels = 0, format = 0, callback = 0, frame_bytes = 0;
};
struct Runner {
  Header header;
  uint64_t started = now(), deadline = started + 15ULL * 60 * 1000000000;
  uint32_t event_seq = 0, control_seq = 1;
  std::array<unsigned char, 32> control{};
  size_t control_size = 0;
  bool identified = false;
  Bytes input_hash{};
  Hash sink_hash;
  std::unique_ptr<output::FramePump> pump;
  void time_check() const { if (now() >= deadline) fail(Reason::time_limit); }
  void read_header() {
    size_t count = 0;
    while (count < header.raw.size()) {
      if (now() - started > 5ULL * 1000000000) fail(Reason::time_limit);
      pollfd fd{0, POLLIN, 0}; const int result = poll(&fd, 1, 100);
      if (result < 0) { if (errno == EINTR) continue; fail(Reason::bad_protocol); }
      if (!result) continue;
      const auto received = read(0, header.raw.data() + count, header.raw.size() - count);
      if (received < 0 && (errno == EINTR || errno == EAGAIN)) continue;
      if (received <= 0) fail(Reason::bad_protocol);
      count += static_cast<size_t>(received);
    }
    identified = true;
    const auto& h = header.raw;
    if (std::memcmp(h.data(), "MBFP", 4) || get(h.data() + 4, 2) != 1 || get(h.data() + 6, 2) != 256 || std::any_of(h.begin() + 228, h.end(), [](auto c) { return c != 0; })) fail(Reason::bad_protocol);
    for (const size_t offset : {8, 24, 40}) if (std::all_of(h.begin() + offset, h.begin() + offset + 16, [](auto c) { return c == 0; })) fail(Reason::bad_protocol);
    header.size = get(h.data() + 184, 8); header.offset = get(h.data() + 192, 8); header.bytes = get(h.data() + 200, 8); header.frames = get(h.data() + 208, 8);
    header.rate = static_cast<uint32_t>(get(h.data() + 216, 4)); header.channels = static_cast<uint32_t>(get(h.data() + 220, 2)); header.format = static_cast<uint32_t>(get(h.data() + 222, 2)); header.callback = static_cast<uint32_t>(get(h.data() + 224, 4));
    if (header.rate < 8000 || header.rate > 384000 || header.channels < 1 || header.channels > 2 || header.format < 1 || header.format > 4) fail(Reason::unsupported_format);
    header.frame_bytes = header.channels * (header.format == 1 ? 2 : header.format == 2 ? 3 : 4);
    if (header.size < 44 || header.size > 0xffffffffULL + 8 || header.offset < 20 || header.offset > header.size || !header.frames || header.frames > (header.size - header.offset) / header.frame_bytes || header.frames * header.frame_bytes != header.bytes || header.callback < 1 || header.callback > 4096) fail(Reason::range_or_budget);
  }
  bool commands(bool wait, bool allow_run) {
    do {
      time_check(); pollfd fd{0, POLLIN, 0}; const int result = poll(&fd, 1, wait ? 100 : 0);
      if (result < 0) { if (errno == EINTR) continue; fail(Reason::bad_protocol); }
      if (!result) { if (wait) continue; return false; }
      const auto count = read(0, control.data() + control_size, control.size() - control_size);
      if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
      if (count <= 0) fail(Reason::parent_closed);
      control_size += static_cast<size_t>(count);
      if (control_size != control.size()) { if (wait) continue; return false; }
      control_size = 0;
      if (std::memcmp(control.data(), "MBFC", 4) || get(control.data() + 4, 2) != 1 || std::memcmp(control.data() + 8, header.raw.data() + 8, 16) || get(control.data() + 24, 4) != control_seq++ || get(control.data() + 28, 4) != 0) fail(Reason::bad_protocol);
      const auto opcode = get(control.data() + 6, 2);
      if (opcode == 2) fail(Reason::stop_requested);
      if (opcode == 1 && allow_run) return true;
      fail(Reason::bad_protocol);
    } while (wait);
    return false;
  }
  void event(uint16_t kind, Reason reason = Reason::none) {
    std::array<unsigned char, 128> data{}; std::memcpy(data.data(), "MBFE", 4);
    put(data.data() + 4, 1, 2); put(data.data() + 6, kind, 2); put(data.data() + 8, ++event_seq, 4); put(data.data() + 12, static_cast<uint32_t>(reason), 4);
    std::memcpy(data.data() + 16, header.raw.data() + 8, 16); put(data.data() + 32, now() - started, 8);
    if (pump) { put(data.data() + 40, pump->consumed(), 8); put(data.data() + 48, pump->zeros(), 8); put(data.data() + 56, pump->callbacks(), 8); }
    std::memcpy(data.data() + 64, input_hash.data(), 32);
    if (kind >= 5) { const auto hash = sink_hash.digest(); std::memcpy(data.data() + 96, hash.data(), 32); }
    size_t sent = 0; const auto write_deadline = now() + 1000000000ULL;
    while (sent < data.size()) {
      if (now() > write_deadline) fail(Reason::time_limit);
      const auto count = write(1, data.data() + sent, data.size() - sent);
      if (count > 0) { sent += static_cast<size_t>(count); continue; }
      if (count < 0 && errno == EINTR) continue;
      if (count < 0 && errno == EAGAIN) { pollfd fd{1, POLLOUT, 0}; poll(&fd, 1, 10); continue; }
      fail(Reason::parent_closed);
    }
  }
  struct stat input_stat() const {
    struct stat value{};
    if (fstat(3, &value) || !S_ISREG(value.st_mode) || value.st_nlink != 1 || value.st_size < 0 || static_cast<uint64_t>(value.st_size) != header.size) fail(Reason::bad_input_fd);
    return value;
  }
  void unchanged(const struct stat& before) const {
    const auto after = input_stat();
    if (before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_size != after.st_size || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec || before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec || before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec) fail(Reason::input_changed);
  }
  void read_exact(unsigned char* bytes, size_t size, uint64_t offset) {
    size_t read_bytes = 0;
    while (read_bytes < size) {
      commands(false, false);
      const auto count = pread(3, bytes + read_bytes, size - read_bytes, static_cast<off_t>(offset + read_bytes));
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) fail(Reason::read_failed);
      read_bytes += static_cast<size_t>(count);
    }
  }
  void finite(const unsigned char* bytes, size_t size) const {
    if (header.format != 4) return;
    for (size_t i = 0; i < size; i += 4) { float value; std::memcpy(&value, bytes + i, 4); if (!std::isfinite(value)) fail(Reason::unsupported_format); }
  }
  int run() {
    read_header();
    const int access = fcntl(3, F_GETFL);
    if (access < 0 || (access & O_ACCMODE) != O_RDONLY) fail(Reason::bad_input_fd);
    const auto before = input_stat(); event(1);
    std::vector<unsigned char> block(1024 * 1024); Hash whole, pcm;
    for (uint64_t position = 0; position < header.size;) { const auto count = static_cast<size_t>(std::min(uint64_t(block.size()), header.size - position)); read_exact(block.data(), count, position); whole.add(block.data(), count); position += count; }
    const size_t aligned = block.size() - block.size() % header.frame_bytes;
    for (uint64_t position = 0; position < header.bytes;) { const auto count = static_cast<size_t>(std::min(uint64_t(aligned), header.bytes - position)); read_exact(block.data(), count, header.offset + position); finite(block.data(), count); pcm.add(block.data(), count); position += count; }
    unchanged(before);
    if (whole.digest() != hash_at(120) || pcm.digest() != hash_at(152)) fail(Reason::hash_mismatch);
    input_hash = pcm.digest(); event(2); commands(true, true);
    pump = std::make_unique<output::FramePump>(header.frame_bytes, header.frames); if (!pump->start()) fail(Reason::internal); event(3);
    std::vector<std::byte> output(size_t(header.callback) * header.frame_bytes);
    Hash supplied; uint64_t produced = 0;
    while (pump->phase() == output::Phase::running) {
      commands(false, false);
      if (pump->available() < header.callback && produced < header.frames) {
        const auto frames = static_cast<uint32_t>(std::min(uint64_t(pump->free_frames()), header.frames - produced));
        const size_t bytes = size_t(frames) * header.frame_bytes;
        read_exact(block.data(), bytes, header.offset + produced * header.frame_bytes); finite(block.data(), bytes); supplied.add(block.data(), bytes);
        produced += frames;
        if (produced == header.frames) { unchanged(before); if (supplied.digest() != input_hash) fail(Reason::hash_mismatch); event(4); }
        if (pump->publish({reinterpret_cast<const std::byte*>(block.data()), bytes}) != frames) fail(Reason::internal);
      }
      const auto pulled = pump->pull(output, header.callback);
      sink_hash.add(output.data(), size_t(pulled.source_frames) * header.frame_bytes);
    }
    if (pump->phase() != output::Phase::drained) fail(pump->reason());
    commands(false, false);
    if (control_size != 0) fail(Reason::bad_protocol);
    unchanged(before);
    if (pump->consumed() != header.frames || sink_hash.digest() != input_hash) fail(Reason::hash_mismatch);
    event(5); return 0;
  }
  Bytes hash_at(size_t offset) const { Bytes hash{}; std::memcpy(hash.data(), header.raw.data() + offset, hash.size()); return hash; }
  int terminal(Reason reason) noexcept {
    try {
      if (pump && pump->phase() == output::Phase::running) {
        pump->stop(reason); std::array<std::byte, 4096 * 8> zero{};
        pump->pull(std::span(zero).first(size_t(header.callback) * header.frame_bytes), header.callback);
      }
      if (identified) event(reason == Reason::stop_requested ? 6 : 7, reason);
    } catch (...) { return 1; }
    return reason == Reason::stop_requested ? 2 : 1;
  }
};
}
int main(int argc, char**) {
  if (argc != 1) return 1;
  std::signal(SIGPIPE, SIG_IGN);
  for (int fd : {0, 1}) { const int flags = fcntl(fd, F_GETFL); if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) return 1; }
  try {
    Runner runner;
    try { return runner.run(); } catch (const Failure& failure) { return runner.terminal(failure.reason); } catch (...) { return runner.terminal(Reason::internal); }
  } catch (...) { return 1; }
}
