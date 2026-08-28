#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>

namespace output {
enum class Phase : uint32_t { ready, running, drained, stopped, failed };
enum class Reason : uint32_t { none, stop_requested, parent_closed, bad_protocol, bad_input_fd, unsupported_format, range_or_budget, input_changed, hash_mismatch, read_failed, underrun, output_shape, time_limit, internal };
struct Pull { uint32_t source_frames; uint32_t zero_frames; Phase phase; };
class FramePump {
 public:
  FramePump(uint32_t frame_bytes, uint64_t total_frames, uint32_t capacity = 16384);
  bool start() noexcept;
  uint32_t publish(std::span<const std::byte> input) noexcept;
  Pull pull(std::span<std::byte> output, uint32_t frames) noexcept;
  void stop(Reason reason = Reason::stop_requested) noexcept;
  uint64_t consumed() const noexcept { return read_.load(std::memory_order_acquire); }
  uint64_t available() const noexcept { return written_.load(std::memory_order_acquire) - consumed(); }
  uint32_t free_frames() const noexcept { return capacity_ - static_cast<uint32_t>(available()); }
  uint64_t zeros() const noexcept { return zeros_.load(); }
  uint64_t callbacks() const noexcept { return callbacks_.load(); }
  Phase phase() const noexcept { return phase_.load(std::memory_order_acquire); }
  Reason reason() const noexcept { return reason_.load(std::memory_order_acquire); }
 private:
  uint32_t frame_bytes_, capacity_;
  uint64_t total_;
  std::unique_ptr<std::byte[]> ring_;
  std::atomic<uint64_t> read_{0}, written_{0}, zeros_{0}, callbacks_{0};
  std::atomic<Phase> phase_{Phase::ready};
  std::atomic<Reason> reason_{Reason::none};
};
}
