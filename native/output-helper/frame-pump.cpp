#include "frame-pump.hpp"
#include <algorithm>
#include <cstring>
#include <stdexcept>
namespace output {
static_assert(std::atomic<uint64_t>::is_always_lock_free);
static_assert(std::atomic<Phase>::is_always_lock_free);
static_assert(std::atomic<Reason>::is_always_lock_free);
FramePump::FramePump(uint32_t bytes, uint64_t frames, uint32_t capacity)
    : frame_bytes_(bytes), capacity_(capacity), total_(frames) {
  if (bytes < 2 || bytes > 8 || !frames || !capacity || capacity > 16384) throw std::invalid_argument("帧泵配置无效");
  ring_ = std::make_unique<std::byte[]>(size_t(bytes) * capacity);
}
bool FramePump::start() noexcept {
  if (reason() != Reason::none) return false;
  auto expected = Phase::ready;
  return phase_.compare_exchange_strong(expected, Phase::running, std::memory_order_acq_rel);
}
uint32_t FramePump::publish(std::span<const std::byte> input) noexcept {
  if (reason() != Reason::none || (phase() != Phase::ready && phase() != Phase::running) || input.size() % frame_bytes_) return 0;
  const auto written = written_.load(std::memory_order_relaxed), read = read_.load(std::memory_order_acquire);
  const auto count = static_cast<uint32_t>(std::min({uint64_t(input.size() / frame_bytes_), uint64_t(capacity_) - (written - read), total_ - written}));
  const auto first = std::min(count, capacity_ - static_cast<uint32_t>(written % capacity_));
  std::memcpy(ring_.get() + (written % capacity_) * frame_bytes_, input.data(), size_t(first) * frame_bytes_);
  if (count > first) std::memcpy(ring_.get(), input.data() + size_t(first) * frame_bytes_, size_t(count - first) * frame_bytes_);
  written_.store(written + count, std::memory_order_release);
  return count;
}
Pull FramePump::pull(std::span<std::byte> out, uint32_t frames) noexcept {
  callbacks_.fetch_add(1, std::memory_order_relaxed);
  if (frames < 1 || frames > 4096 || out.size() != size_t(frames) * frame_bytes_) {
    if (out.size() <= 4096 * 8) std::memset(out.data(), 0, out.size());
    stop(Reason::output_shape); phase_.store(Phase::failed, std::memory_order_release);
    return {0, 0, Phase::failed};
  }
  std::memset(out.data(), 0, out.size()); uint32_t copied = 0;
  while (phase() == Phase::running && copied < frames) {
    if (reason() != Reason::none) {
      phase_.store(reason() == Reason::stop_requested ? Phase::stopped : Phase::failed, std::memory_order_release); break;
    }
    const auto read = read_.load(std::memory_order_relaxed);
    if (read == total_) { phase_.store(Phase::drained, std::memory_order_release); break; }
    const auto available = written_.load(std::memory_order_acquire) - read;
    if (!available) { stop(Reason::underrun); phase_.store(Phase::failed, std::memory_order_release); break; }
    const auto count = static_cast<uint32_t>(std::min({available, total_ - read, uint64_t(frames - copied), uint64_t(capacity_ - read % capacity_), uint64_t(256)}));
    std::memcpy(out.data() + size_t(copied) * frame_bytes_, ring_.get() + (read % capacity_) * frame_bytes_, size_t(count) * frame_bytes_);
    read_.store(read + count, std::memory_order_release); copied += count;
    if (read + count == total_) phase_.store(Phase::drained, std::memory_order_release);
  }
  zeros_.fetch_add(frames - copied, std::memory_order_relaxed);
  return {copied, frames - copied, phase()};
}
void FramePump::stop(Reason value) noexcept {
  auto expected = Reason::none; reason_.compare_exchange_strong(expected, value, std::memory_order_acq_rel);
}
}
