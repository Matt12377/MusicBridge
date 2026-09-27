#include "output-run-lease.hpp"
#include <array>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <string>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

using namespace output::device;
namespace {
void check(bool condition, const char* message) {
  if (!condition) { std::fprintf(stderr, "%s\n", message); std::exit(1); }
}
std::string temporaryFile() {
  const char* root = std::getenv("TMPDIR");
  check(root && std::strncmp(root, "/Volumes/LifeWeave/Developer/CommandLine/tmp", 46) == 0,
    "必须使用外置测试临时根");
  std::string path = std::string(root) + "/musicbridge-run-lease-XXXXXX";
  const int fd = ::mkstemp(path.data()); check(fd >= 0, "无法创建租约测试文件");
  check(::fchmod(fd, 0600) == 0, "无法设置租约测试权限"); ::close(fd);
  return path;
}
OutputRunLeaseIdentity identity() {
  OutputRunLeaseIdentity value{};
  for (size_t index = 0; index < 16; ++index) {
    value.runId[index] = std::byte(index + 1); value.generation[index] = std::byte(index + 17);
    value.datasetId[index] = std::byte(index + 33); value.attemptId[index] = std::byte(index + 49);
  }
  for (size_t index = 0; index < 32; ++index) {
    value.planContentSha256[index] = std::byte(index + 1); value.audioSha256[index] = std::byte(index + 2);
    value.pcmSha256[index] = std::byte(index + 3); value.helperSha256[index] = std::byte(index + 4);
    value.gateRecordSha256[index] = std::byte(index + 5);
  }
  value.side = 1; value.databaseDevice = 123; value.databaseInode = 456; value.databaseBirthtimeNs = 789;
  return value;
}
void initialize(const std::string& path, const OutputRunLeaseIdentity& value) {
  const int fd = ::open(path.c_str(), O_RDWR | O_NOFOLLOW);
  check(fd >= 0 && initializeOutputRunLease(fd, value), "租约初始化失败"); ::close(fd);
}
int opened(const std::string& path) {
  const int fd = ::open(path.c_str(), O_RDWR | O_NOFOLLOW);
  check(fd >= 0, "无法重新打开租约"); return fd;
}
void signalByte(int fd, char byte) { check(::write(fd, &byte, 1) == 1, "同步信号写入失败"); }
void awaitByte(int fd, char expected) {
  pollfd watch{fd, POLLIN, 0};
  check(::poll(&watch, 1, 5000) == 1 && (watch.revents & POLLIN), "子进程同步超时");
  char byte = 0; check(::read(fd, &byte, 1) == 1 && byte == expected, "子进程同步值错误");
}
}

int main() {
  const auto value = identity(); const auto path = temporaryFile(); initialize(path, value);
  const int holder = opened(path), recovery = opened(path);
  check(acquireOutputRunLease(holder, value) == OutputRunLeaseResult::ready, "helper 未能取得共享锁");
  check(revokeOutputRunLease(recovery, value) == OutputRunLeaseResult::occupied, "helper 持锁时恢复不得推断静止");
  ::close(holder);
  check(revokeOutputRunLease(recovery, value) == OutputRunLeaseResult::ready, "helper close 后撤销失败");
  ::close(recovery);
  const int late = opened(path);
  check(acquireOutputRunLease(late, value) == OutputRunLeaseResult::invalid, "迟到 helper 不得穿过墓碑"); ::close(late);
  const auto wrongDatabase = [&] { auto copy = value; copy.databaseInode += 1; return copy; }();
  const int copied = opened(path);
  check(revokeOutputRunLease(copied, wrongDatabase) == OutputRunLeaseResult::invalid, "新数据库 inode 不得继承旧租约"); ::close(copied);
  const auto wrongPlan = [&] { auto copy = value; copy.planContentSha256[0] = std::byte{0}; return copy; }();
  const int drifted = opened(path);
  check(revokeOutputRunLease(drifted, wrongPlan) == OutputRunLeaseResult::invalid, "Plan绑定漂移不得继承旧租约"); ::close(drifted);
  const auto wrongGeneration = [&] { auto copy = value; copy.generation[0] = std::byte{0}; return copy; }();
  const int stale = opened(path);
  check(revokeOutputRunLease(stale, wrongGeneration) == OutputRunLeaseResult::invalid, "旧代际不得撤销新租约"); ::close(stale);
  std::array<std::byte, outputRunLeaseBytes> oldBytes{};
  const int original = opened(path);
  check(::pread(original, oldBytes.data(), oldBytes.size(), 0) == static_cast<ssize_t>(oldBytes.size()), "读取原租约失败"); ::close(original);
  const auto moved = path + ".previous";
  check(::rename(path.c_str(), moved.c_str()) == 0, "无法模拟sidecar替换");
  const int replacement = ::open(path.c_str(), O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW, 0600);
  check(replacement >= 0 && ::pwrite(replacement, oldBytes.data(), oldBytes.size(), 0) == static_cast<ssize_t>(oldBytes.size()), "无法模拟sidecar内容复制");
  check(revokeOutputRunLease(replacement, value) == OutputRunLeaseResult::invalid, "复制内容的新sidecar inode不得产生静止证明");
  ::close(replacement); ::unlink(path.c_str()); ::unlink(moved.c_str());
  const auto tamperedPath = temporaryFile(); initialize(tamperedPath, value);
  const int tampered = opened(tamperedPath);
  const std::byte altered{0};
  check(::pwrite(tampered, &altered, 1, 144) == 1, "无法模拟音频身份篡改");
  check(revokeOutputRunLease(tampered, value) == OutputRunLeaseResult::invalid, "内容篡改不得产生静止证明");
  ::close(tampered); ::unlink(tamperedPath.c_str());

  // launcher 退出而 grandchild helper 继续持有共享锁：恢复不能只看父进程寿命。
  const auto inheritedPath = temporaryFile(); initialize(inheritedPath, value);
  int ready[2]{}, release[2]{}, done[2]{};
  check(::pipe(ready) == 0 && ::pipe(release) == 0 && ::pipe(done) == 0, "无法创建受控子进程同步管道");
  const pid_t launcher = ::fork(); check(launcher >= 0, "无法 fork launcher");
  if (launcher == 0) {
    const int inheritedFd = opened(inheritedPath);
    const pid_t helper = ::fork();
    if (helper < 0) std::_Exit(2);
    if (helper == 0) {
      ::close(ready[0]); ::close(release[1]); ::close(done[0]);
      if (acquireOutputRunLease(inheritedFd, value) != OutputRunLeaseResult::ready) std::_Exit(3);
      signalByte(ready[1], 'R'); awaitByte(release[0], 'X'); ::close(inheritedFd);
      signalByte(done[1], 'D'); std::_Exit(0);
    }
    std::_Exit(0);
  }
  ::close(ready[1]); ::close(release[0]); ::close(done[1]);
  int status = 0; check(::waitpid(launcher, &status, 0) == launcher && WIFEXITED(status) && WEXITSTATUS(status) == 0,
    "launcher 未按预期退出");
  awaitByte(ready[0], 'R');
  const int freshRecovery = opened(inheritedPath);
  check(revokeOutputRunLease(freshRecovery, value) == OutputRunLeaseResult::occupied,
    "父进程退出后，存活 helper 的共享锁必须继续阻断恢复");
  signalByte(release[1], 'X'); awaitByte(done[0], 'D');
  check(revokeOutputRunLease(freshRecovery, value) == OutputRunLeaseResult::ready, "helper 退出后恢复应能写墓碑");
  ::close(freshRecovery); ::close(ready[0]); ::close(release[1]); ::close(done[0]);
  ::unlink(inheritedPath.c_str());
  return 0;
}
