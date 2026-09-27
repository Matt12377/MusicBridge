#include "output-run-lease.hpp"
#include <algorithm>
#include <array>
#include <cerrno>
#include <cstring>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

namespace output::device {
namespace {
void put64(std::byte* p, uint64_t value) {
  for (size_t index = 0; index < 8; ++index) p[index] = std::byte((value >> (index * 8)) & 255);
}
uint64_t get64(const std::byte* p) {
  uint64_t value = 0;
  for (size_t index = 0; index < 8; ++index) value |= uint64_t(std::to_integer<uint8_t>(p[index])) << (index * 8);
  return value;
}
bool plainFile(int fd, struct stat& info) {
  return ::fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_nlink == 1
    && info.st_size == static_cast<off_t>(outputRunLeaseBytes) && (info.st_mode & 0022) == 0;
}
bool readRecord(int fd, std::array<std::byte, outputRunLeaseBytes>& bytes) {
  for (size_t offset = 0; offset < bytes.size();) {
    const auto n = ::pread(fd, bytes.data() + offset, bytes.size() - offset, static_cast<off_t>(offset));
    if (n > 0) offset += static_cast<size_t>(n);
    else if (n < 0 && errno == EINTR) continue;
    else return false;
  }
  return true;
}
bool writeRecord(int fd, const std::array<std::byte, outputRunLeaseBytes>& bytes) {
  for (size_t offset = 0; offset < bytes.size();) {
    const auto n = ::pwrite(fd, bytes.data() + offset, bytes.size() - offset, static_cast<off_t>(offset));
    if (n > 0) offset += static_cast<size_t>(n);
    else if (n < 0 && errno == EINTR) continue;
    else return false;
  }
  return true;
}
bool identityMatches(const std::array<std::byte, outputRunLeaseBytes>& bytes,
  const OutputRunLeaseIdentity& identity, const struct stat& info) {
  return std::memcmp(bytes.data(), "MBRL", 4) == 0
    && bytes[4] == std::byte{1} && bytes[5] == std::byte{0} && bytes[7] == std::byte{identity.side}
    && (bytes[6] == std::byte{outputRunLeaseActive} || bytes[6] == std::byte{outputRunLeaseRevoked})
    && identity.side >= 1 && identity.side <= 3
    && std::equal(identity.runId.begin(), identity.runId.end(), bytes.begin() + 8)
    && std::equal(identity.generation.begin(), identity.generation.end(), bytes.begin() + 24)
    && get64(bytes.data() + 40) == identity.databaseDevice
    && get64(bytes.data() + 48) == identity.databaseInode
    && get64(bytes.data() + 56) == identity.databaseBirthtimeNs
    && get64(bytes.data() + 64) == static_cast<uint64_t>(info.st_dev)
    && get64(bytes.data() + 72) == static_cast<uint64_t>(info.st_ino)
    && std::equal(identity.datasetId.begin(), identity.datasetId.end(), bytes.begin() + 80)
    && std::equal(identity.attemptId.begin(), identity.attemptId.end(), bytes.begin() + 96)
    && std::equal(identity.planContentSha256.begin(), identity.planContentSha256.end(), bytes.begin() + 112)
    && std::equal(identity.audioSha256.begin(), identity.audioSha256.end(), bytes.begin() + 144)
    && std::equal(identity.pcmSha256.begin(), identity.pcmSha256.end(), bytes.begin() + 176)
    && std::equal(identity.helperSha256.begin(), identity.helperSha256.end(), bytes.begin() + 208)
    && std::equal(identity.gateRecordSha256.begin(), identity.gateRecordSha256.end(), bytes.begin() + 240)
    && std::all_of(bytes.begin() + 272, bytes.end(), [](std::byte value) { return value == std::byte{0}; });
}
OutputRunLeaseResult lockFile(int fd, int operation) {
  if (::flock(fd, operation | LOCK_NB) == 0) return OutputRunLeaseResult::ready;
  return errno == EWOULDBLOCK ? OutputRunLeaseResult::occupied : OutputRunLeaseResult::io_error;
}
}

std::optional<OutputRunLeaseIdentity> decodeOutputRunLeaseIdentity(
  std::span<const std::byte, outputRunLeaseBytes> bytes) noexcept {
  if (std::memcmp(bytes.data(), "MBRL", 4) != 0 || bytes[4] != std::byte{1} || bytes[5] != std::byte{0}
    || (bytes[6] != std::byte{outputRunLeaseActive} && bytes[6] != std::byte{outputRunLeaseRevoked})
    || !std::all_of(bytes.begin() + 272, bytes.end(), [](std::byte value) { return value == std::byte{0}; })) return std::nullopt;
  OutputRunLeaseIdentity identity{};
  std::copy_n(bytes.begin() + 8, 16, identity.runId.begin());
  std::copy_n(bytes.begin() + 24, 16, identity.generation.begin());
  identity.databaseDevice = get64(bytes.data() + 40); identity.databaseInode = get64(bytes.data() + 48);
  identity.databaseBirthtimeNs = get64(bytes.data() + 56);
  std::copy_n(bytes.begin() + 80, 16, identity.datasetId.begin());
  std::copy_n(bytes.begin() + 96, 16, identity.attemptId.begin());
  identity.side = std::to_integer<uint8_t>(bytes[7]);
  std::copy_n(bytes.begin() + 112, 32, identity.planContentSha256.begin());
  std::copy_n(bytes.begin() + 144, 32, identity.audioSha256.begin());
  std::copy_n(bytes.begin() + 176, 32, identity.pcmSha256.begin());
  std::copy_n(bytes.begin() + 208, 32, identity.helperSha256.begin());
  std::copy_n(bytes.begin() + 240, 32, identity.gateRecordSha256.begin());
  if (identity.side < 1 || identity.side > 3 || !identity.databaseDevice || !identity.databaseInode
    || std::all_of(identity.runId.begin(), identity.runId.end(), [](std::byte value) { return value == std::byte{0}; })
    || std::all_of(identity.generation.begin(), identity.generation.end(), [](std::byte value) { return value == std::byte{0}; })
    || std::all_of(identity.helperSha256.begin(), identity.helperSha256.end(), [](std::byte value) { return value == std::byte{0}; })
    || std::all_of(identity.gateRecordSha256.begin(), identity.gateRecordSha256.end(), [](std::byte value) { return value == std::byte{0}; })) return std::nullopt;
  return identity;
}

bool initializeOutputRunLease(int fd, const OutputRunLeaseIdentity& identity) noexcept {
  struct stat info{};
  if (::fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1 || info.st_size != 0
    || (info.st_mode & 0022) != 0) return false;
  std::array<std::byte, outputRunLeaseBytes> bytes{};
  if (identity.side < 1 || identity.side > 3) return false;
  std::memcpy(bytes.data(), "MBRL", 4); bytes[4] = std::byte{1}; bytes[6] = std::byte{outputRunLeaseActive}; bytes[7] = std::byte{identity.side};
  std::copy(identity.runId.begin(), identity.runId.end(), bytes.begin() + 8);
  std::copy(identity.generation.begin(), identity.generation.end(), bytes.begin() + 24);
  put64(bytes.data() + 40, identity.databaseDevice); put64(bytes.data() + 48, identity.databaseInode);
  put64(bytes.data() + 56, identity.databaseBirthtimeNs);
  put64(bytes.data() + 64, static_cast<uint64_t>(info.st_dev)); put64(bytes.data() + 72, static_cast<uint64_t>(info.st_ino));
  std::copy(identity.datasetId.begin(), identity.datasetId.end(), bytes.begin() + 80);
  std::copy(identity.attemptId.begin(), identity.attemptId.end(), bytes.begin() + 96);
  std::copy(identity.planContentSha256.begin(), identity.planContentSha256.end(), bytes.begin() + 112);
  std::copy(identity.audioSha256.begin(), identity.audioSha256.end(), bytes.begin() + 144);
  std::copy(identity.pcmSha256.begin(), identity.pcmSha256.end(), bytes.begin() + 176);
  std::copy(identity.helperSha256.begin(), identity.helperSha256.end(), bytes.begin() + 208);
  std::copy(identity.gateRecordSha256.begin(), identity.gateRecordSha256.end(), bytes.begin() + 240);
  return writeRecord(fd, bytes) && ::fsync(fd) == 0;
}

OutputRunLeaseResult acquireOutputRunLease(int fd, const OutputRunLeaseIdentity& identity) noexcept {
  const auto locked = lockFile(fd, LOCK_SH);
  if (locked != OutputRunLeaseResult::ready) return locked;
  struct stat info{}; std::array<std::byte, outputRunLeaseBytes> bytes{};
  if (!plainFile(fd, info) || !readRecord(fd, bytes) || !identityMatches(bytes, identity, info)
    || bytes[6] != std::byte{outputRunLeaseActive}) return OutputRunLeaseResult::invalid;
  return OutputRunLeaseResult::ready;
}

OutputRunLeaseResult acquireOutputRunLeaseForHeader(int fd, const std::array<std::byte, 16>& runId,
  const std::array<std::byte, 32>& pcmSha256, const std::array<std::byte, 32>& gateRecordSha256) noexcept {
  const auto locked = lockFile(fd, LOCK_SH);
  if (locked != OutputRunLeaseResult::ready) return locked;
  struct stat info{}; std::array<std::byte, outputRunLeaseBytes> bytes{};
  if (!plainFile(fd, info) || !readRecord(fd, bytes)) return OutputRunLeaseResult::invalid;
  const auto identity = decodeOutputRunLeaseIdentity(bytes);
  if (!identity || !identityMatches(bytes, *identity, info) || bytes[6] != std::byte{outputRunLeaseActive}
    || identity->runId != runId || identity->pcmSha256 != pcmSha256
    || identity->gateRecordSha256 != gateRecordSha256) return OutputRunLeaseResult::invalid;
  return OutputRunLeaseResult::ready;
}

OutputRunLeaseResult revokeOutputRunLease(int fd, const OutputRunLeaseIdentity& identity) noexcept {
  const auto locked = lockFile(fd, LOCK_EX);
  if (locked != OutputRunLeaseResult::ready) return locked;
  struct stat info{}; std::array<std::byte, outputRunLeaseBytes> bytes{};
  if (!plainFile(fd, info) || !readRecord(fd, bytes) || !identityMatches(bytes, identity, info)) return OutputRunLeaseResult::invalid;
  if (bytes[6] == std::byte{outputRunLeaseRevoked}) return OutputRunLeaseResult::ready;
  const std::byte revoked{outputRunLeaseRevoked};
  if (::pwrite(fd, &revoked, 1, 6) != 1 || ::fsync(fd) != 0) return OutputRunLeaseResult::io_error;
  std::array<std::byte, outputRunLeaseBytes> after{};
  if (!readRecord(fd, after) || !identityMatches(after, identity, info)
    || after[6] != std::byte{outputRunLeaseRevoked}) return OutputRunLeaseResult::io_error;
  return OutputRunLeaseResult::ready;
}
}
