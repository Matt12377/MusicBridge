#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

namespace output::device {
constexpr size_t outputRunLeaseBytes = 288;
constexpr uint8_t outputRunLeaseActive = 1;
constexpr uint8_t outputRunLeaseRevoked = 2;

struct OutputRunLeaseIdentity {
  std::array<std::byte, 16> runId;
  std::array<std::byte, 16> generation;
  std::array<std::byte, 16> datasetId;
  std::array<std::byte, 16> attemptId;
  uint8_t side;
  uint64_t databaseDevice;
  uint64_t databaseInode;
  uint64_t databaseBirthtimeNs;
  std::array<std::byte, 32> planContentSha256;
  std::array<std::byte, 32> audioSha256;
  std::array<std::byte, 32> pcmSha256;
  std::array<std::byte, 32> helperSha256;
  std::array<std::byte, 32> gateRecordSha256;
};

enum class OutputRunLeaseResult { ready, occupied, invalid, io_error };

/** 调用方先以 O_EXCL 创建精确 sidecar；完成并 fsync 后才可把 fd 传给可能触碰 HAL 的 helper。 */
bool initializeOutputRunLease(int fd, const OutputRunLeaseIdentity& identity) noexcept;
std::optional<OutputRunLeaseIdentity> decodeOutputRunLeaseIdentity(
  std::span<const std::byte, outputRunLeaseBytes> bytes) noexcept;

/** helper 在构造任何 HAL 对象前调用；继承 fd 仅由最后一次 close 释放，绝不显式 LOCK_UN。 */
OutputRunLeaseResult acquireOutputRunLease(int fd, const OutputRunLeaseIdentity& identity) noexcept;
/** 正式 helper 用 header 的 run/PCM/Gate B 身份再钉住磁盘租约；未通过不得构造 HAL 对象。 */
OutputRunLeaseResult acquireOutputRunLeaseForHeader(int fd, const std::array<std::byte, 16>& runId,
  const std::array<std::byte, 32>& pcmSha256, const std::array<std::byte, 32>& gateRecordSha256) noexcept;

/** 冷启端用独立 open 的 fd 非阻塞排他；持锁写不可逆墓碑并 fsync。 */
OutputRunLeaseResult revokeOutputRunLease(int fd, const OutputRunLeaseIdentity& identity) noexcept;
}
