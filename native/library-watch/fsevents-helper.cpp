// 只监听Owner传入FD3对应的目录；回显仅含失效通知，不含路径或用户文件名。
#include <CoreServices/CoreServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <sys/stat.h>
#include <poll.h>
#include <fcntl.h>
#include <unistd.h>
#include <limits.h>
#include <atomic>
#include <thread>
#include <string>
#include <cstring>
#include <cerrno>
#include <dirent.h>
#include <signal.h>
#include <cstdint>
#include <algorithm>
#include <vector>

namespace {
std::atomic<bool> stopping{false};
std::atomic<bool> invalidControl{false};
bool line(const char *text) {
  std::size_t done = 0, size = std::strlen(text);
  while(done < size) {
    const auto n = ::write(1, text + done, size - done);
    if(n < 0 && errno == EINTR) continue;
    if(n <= 0) return false;
    done += static_cast<std::size_t>(n);
  }
  return true;
}
void changed(ConstFSEventStreamRef, void *, std::size_t count, void *,
             const FSEventStreamEventFlags flags[], const FSEventStreamEventId[]) {
  for(std::size_t i = 0; i < count; ++i) {
    if(flags[i] & kFSEventStreamEventFlagHistoryDone) continue;
    if(!line("INVALIDATE\n")) stopping.store(true);
    break;
  }
}
}
namespace structure_probe {
constexpr std::size_t maxEntries = 256, maxChildFds = 12, maxRawBytes = 65536;
constexpr unsigned maxDepth = 2;
volatile sig_atomic_t signalled = 0;
void cancelSignal(int) { signalled = 1; }
struct Failure { const char *code; bool cancelled; };
[[noreturn]] void reject(const char *code) { throw Failure{code, false}; }
[[noreturn]] void cancel() { throw Failure{"CANCELLED", true}; }

struct Control {
  std::string partial;
  void cancelPoint() {
    if(signalled) cancel();
    for(;;) {
      pollfd input{0, POLLIN | POLLHUP, 0};
      const int result = ::poll(&input, 1, 0);
      if(result < 0) { if(errno == EINTR) { if(signalled) cancel(); continue; } reject("CONTROL_FAILED"); }
      if(!result) return;
      if(input.revents & (POLLERR | POLLNVAL)) reject("CONTROL_FAILED");
      char block[6]; const ssize_t count = ::read(0, block, sizeof(block));
      if(count < 0) { if(errno == EINTR) { if(signalled) cancel(); continue; } reject("CONTROL_FAILED"); }
      if(!count) cancel();
      partial.append(block, static_cast<std::size_t>(count));
      if(partial == "STOP\n") cancel();
      if(partial.size() >= 5 || std::string("STOP\n").compare(0, partial.size(), partial)) reject("INVALID_CONTROL");
    }
  }
  void beforePublication() { cancelPoint(); if(!partial.empty()) reject("INCOMPLETE_CONTROL"); }
};

bool closedFd(int fd) {
  const int result = ::close(fd);
  const int closeError = result == 0 ? 0 : errno;
  errno = 0; const int after = ::fcntl(fd, F_GETFD);
  return closeError == 0 && after == -1 && errno == EBADF;
}
struct Closure {
  bool failed = false, duplicateCreated = false, duplicateClosed = false;
  std::size_t childOpened = 0, childClosed = 0, streamsOpened = 0, streamsClosed = 0;
};
// 每个DIR拥有同一个真实FD；close后立即核EBADF，再允许后续open复用该号码。
struct Directory {
  DIR *stream = nullptr;
  int fd = -1;
  Closure &closure;
  bool child;
  Directory(int actual, Closure &ledger, bool isChild) : fd(actual), closure(ledger), child(isChild) {
    if(::fcntl(fd, F_SETFD, FD_CLOEXEC)) {
      const bool closed = closedFd(fd); closure.failed |= !closed;
      if(closed) { if(child) ++closure.childClosed; else closure.duplicateClosed = true; }
      fd = -1; reject("FD_FLAGS_FAILED");
    }
    stream = ::fdopendir(fd);
    if(!stream) {
      const bool closed = closedFd(fd); closure.failed |= !closed;
      if(closed) { if(child) ++closure.childClosed; else closure.duplicateClosed = true; }
      fd = -1; reject("DIRECTORY_STREAM_FAILED");
    }
    ++closure.streamsOpened;
  }
  Directory(Directory &&other) noexcept : stream(other.stream), fd(other.fd), closure(other.closure), child(other.child) { other.stream = nullptr; other.fd = -1; }
  Directory(const Directory &) = delete;
  Directory &operator=(const Directory &) = delete;
  ~Directory() {
    if(!stream) return;
    const int actual = ::dirfd(stream), status = ::closedir(stream);
    errno = 0; const int remaining = ::fcntl(fd, F_GETFD);
    const bool closed = actual == fd && status == 0 && remaining == -1 && errno == EBADF;
    if(remaining >= 0) { if(!closedFd(fd)) closure.failed = true; }
    closure.failed |= !closed;
    if(closed) { ++closure.streamsClosed; if(child) ++closure.childClosed; else closure.duplicateClosed = true; }
  }
};

bool sameTime(const timespec &a, const timespec &b) { return a.tv_sec == b.tv_sec && a.tv_nsec == b.tv_nsec; }
bool sameStat(const struct stat &a, const struct stat &b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode
    && a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_nlink == b.st_nlink && a.st_size == b.st_size
    && sameTime(a.st_birthtimespec, b.st_birthtimespec) && sameTime(a.st_mtimespec, b.st_mtimespec)
    && sameTime(a.st_ctimespec, b.st_ctimespec);
}
void stableFd(int fd, const struct stat &before, Control &control) {
  control.cancelPoint(); struct stat after{};
  if(::fstat(fd, &after) || !sameStat(before, after)) reject("DIRECTORY_CHANGED");
  control.cancelPoint();
}
// 名称保持原UTF8字节，不归一化/改名；拒绝无效编码、控制字节和超长分量。
bool validName(const std::string &name) {
  if(name.empty() || name.size() > NAME_MAX) return false;
  const auto *bytes = reinterpret_cast<const unsigned char *>(name.data());
  for(std::size_t at = 0; at < name.size();) {
    const unsigned char a = bytes[at];
    if(a < 0x80) { if(a < 0x20 || a == 0x7f || a == '/') return false; ++at; continue; }
    std::size_t count; std::uint32_t value;
    if(a >= 0xc2 && a <= 0xdf) { count = 2; value = a & 0x1f; }
    else if(a >= 0xe0 && a <= 0xef) { count = 3; value = a & 0x0f; }
    else if(a >= 0xf0 && a <= 0xf4) { count = 4; value = a & 0x07; }
    else return false;
    if(at + count > name.size()) return false;
    for(std::size_t n = 1; n < count; ++n) { const unsigned char c = bytes[at+n]; if(c < 0x80 || c > 0xbf) return false; value = (value << 6) | (c & 0x3f); }
    if((count == 3 && value < 0x800) || (count == 4 && value < 0x10000)
      || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
    at += count;
  }
  return true;
}
const char *kind(mode_t mode) {
  return S_ISREG(mode) ? "file" : S_ISDIR(mode) ? "directory" : S_ISLNK(mode) ? "symlink" : "other";
}
struct Entry { std::string name; struct stat identity{}; };
struct Row { std::string relative; struct stat identity{}; std::vector<Entry> entries; int fd; };
struct Facts { struct stat root{}; std::vector<Row> directories; std::size_t entriesRead = 0; };
void stableNames(int parent, const std::vector<Entry> &entries, Control &control) {
  for(const auto &entry : entries) {
    control.cancelPoint(); struct stat named{};
    if(::fstatat(parent, entry.name.c_str(), &named, AT_SYMLINK_NOFOLLOW) || !sameStat(entry.identity, named)) reject("ENTRY_CHANGED");
  }
}
void enumerate(Directory &directory, const std::string &relative, unsigned depth,
               const struct stat &expected, Facts &facts, Closure &closure, Control &control, std::vector<Directory> &children) {
  control.cancelPoint(); struct stat before{};
  if(::fstat(directory.fd, &before) || !S_ISDIR(before.st_mode) || !sameStat(expected, before)) reject("DIRECTORY_CHANGED");
  // FD3必须是Owner此次专用fresh描述符；dup共享offset，先从目录起点完整读取。
  ::rewinddir(directory.stream);
  std::vector<Entry> entries;
  for(;;) {
    control.cancelPoint(); errno = 0; dirent *actual = ::readdir(directory.stream);
    if(!actual) { if(errno) reject("DIRECTORY_READ_FAILED"); break; }
    const std::string name(actual->d_name);
    if(name == "." || name == "..") continue;
    if(!validName(name)) reject("INVALID_ENTRY_NAME");
    if(facts.entriesRead == maxEntries) reject("ENTRY_BUDGET");
    control.cancelPoint(); struct stat identity{};
    if(::fstatat(directory.fd, name.c_str(), &identity, AT_SYMLINK_NOFOLLOW)) reject("ENTRY_CHANGED");
    ++facts.entriesRead; entries.push_back({name, identity});
  }
  std::sort(entries.begin(), entries.end(), [](const Entry &a, const Entry &b) { return a.name < b.name; });
  for(std::size_t n = 1; n < entries.size(); ++n) if(entries[n-1].name == entries[n].name) reject("DUPLICATE_ENTRY");
  stableFd(directory.fd, before, control); stableNames(directory.fd, entries, control);
  facts.directories.push_back({relative, before, entries, directory.fd});
  if(depth < maxDepth) for(const auto &entry : entries) if(S_ISDIR(entry.identity.st_mode)) {
    stableFd(directory.fd, before, control);
    struct stat named{};
    if(::fstatat(directory.fd, entry.name.c_str(), &named, AT_SYMLINK_NOFOLLOW) || !sameStat(entry.identity, named)) reject("ENTRY_CHANGED");
    control.cancelPoint(); if(closure.childOpened == maxChildFds) reject("CHILD_FD_BUDGET");
    const int child = ::openat(directory.fd, entry.name.c_str(), O_RDONLY | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC);
    if(child < 0) { control.cancelPoint(); reject("CHILD_OPEN_FAILED"); }
    ++closure.childOpened;
    // reserve过的同一池保留至全树最终核对；不为了复核再open而越过12总FD预算。
    children.emplace_back(child, closure, true);
    enumerate(children.back(), relative.empty() ? entry.name : relative + "/" + entry.name,
              depth + 1, entry.identity, facts, closure, control, children);
    if(closure.failed) reject("PHYSICAL_CLOSE_FAILED");
    stableFd(directory.fd, before, control);
  }
  stableFd(directory.fd, before, control); stableNames(directory.fd, entries, control);
}

struct Json {
  std::string text;
  void add(const std::string &value) { if(value.size() > maxRawBytes - 1 - text.size()) reject("OUTPUT_BUDGET"); text += value; }
  void quoted(const std::string &value) {
    add("\"");
    for(unsigned char c : value) { if(c == '"' || c == '\\') add(std::string("\\") + static_cast<char>(c)); else add(std::string(1, static_cast<char>(c))); }
    add("\"");
  }
};
std::string ns(const timespec &value) {
  if(value.tv_sec < 0 || value.tv_nsec < 0 || value.tv_nsec > 999999999
    || static_cast<std::uint64_t>(value.tv_sec) > (static_cast<std::uint64_t>(INT64_MAX) - static_cast<std::uint64_t>(value.tv_nsec)) / 1000000000ULL) reject("INVALID_STAT");
  return std::to_string(static_cast<std::uint64_t>(value.tv_sec) * 1000000000ULL + static_cast<std::uint64_t>(value.tv_nsec));
}
void physical(Json &json, const struct stat &value) {
  json.add("\"dev\":"); json.quoted(std::to_string(static_cast<std::uint64_t>(value.st_dev)));
  json.add(",\"ino\":"); json.quoted(std::to_string(static_cast<std::uint64_t>(value.st_ino)));
  json.add(",\"birthtimeNs\":"); json.quoted(ns(value.st_birthtimespec));
  json.add(",\"mode\":"); json.quoted(std::to_string(static_cast<std::uint64_t>(value.st_mode)));
  json.add(",\"uid\":"); json.quoted(std::to_string(static_cast<std::uint64_t>(value.st_uid)));
  json.add(",\"gid\":"); json.quoted(std::to_string(static_cast<std::uint64_t>(value.st_gid)));
}
std::string body(const Facts &facts, const Closure &closure) {
  Json json; json.add("{\"schema\":\"musicbridge.directory-structure.fd.v1\",\"bounds\":{\"depth\":2,\"entries\":256,\"childFds\":12},\"root\":{");
  physical(json, facts.root); json.add("},\"directories\":[");
  for(std::size_t n = 0; n < facts.directories.size(); ++n) {
    if(n) json.add(","); const auto &row = facts.directories[n];
    json.add("{\"relative\":"); json.quoted(row.relative); json.add(","); physical(json, row.identity); json.add(",\"entries\":[");
    for(std::size_t item = 0; item < row.entries.size(); ++item) {
      if(item) json.add(","); json.add("{\"name\":"); json.quoted(row.entries[item].name); json.add(",\"kind\":"); json.quoted(kind(row.entries[item].identity.st_mode)); json.add("}");
    }
    json.add("]}");
  }
  json.add("],\"entriesRead\":" + std::to_string(facts.entriesRead));
  json.add(",\"childDirectoriesOpened\":" + std::to_string(closure.childOpened));
  json.add(",\"bounded\":false,\"physicalClosed\":{\"inputFd\":true,\"duplicateRootFd\":true,\"childDirectoryFds\":true,\"directoryStreams\":true}}\n");
  return json.text;
}
bool publish(const std::string &text, Control &control) {
  const int original = ::fcntl(1, F_GETFL);
  if(original < 0 || ::fcntl(1, F_SETFL, original | O_NONBLOCK)) return false;
  std::size_t written = 0; bool result = true;
  try {
    while(written < text.size()) {
      control.beforePublication(); const ssize_t count = ::write(1, text.data() + written, text.size() - written);
      if(count > 0) { written += static_cast<std::size_t>(count); continue; }
      if(count < 0 && errno == EINTR) continue;
      if(count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        pollfd output{1, POLLOUT, 0}; const int ready = ::poll(&output, 1, 25);
        if(ready < 0 && errno != EINTR) { result = false; break; }
        continue;
      }
      result = false; break;
    }
  } catch(...) { if(::fcntl(1, F_SETFL, original)) reject("OUTPUT_FLAGS_RESTORE_FAILED"); throw; }
  if(::fcntl(1, F_SETFL, original)) result = false;
  return result;
}
int run() {
  struct sigaction handler{}, ignored{};
  handler.sa_handler = cancelSignal; sigemptyset(&handler.sa_mask);
  ignored.sa_handler = SIG_IGN; sigemptyset(&ignored.sa_mask);
  const bool signals = ::sigaction(SIGTERM, &handler, nullptr) == 0 && ::sigaction(SIGINT, &handler, nullptr) == 0
    && ::sigaction(SIGPIPE, &ignored, nullptr) == 0;
  Closure closure; Facts facts; Control control; const char *error = nullptr; bool cancelled = false;
  try {
    if(!signals) reject("SIGNAL_CONTROL_FAILED"); control.cancelPoint();
    const int flags = ::fcntl(3, F_GETFL);
    if(flags < 0 || (flags & O_ACCMODE) != O_RDONLY || ::fstat(3, &facts.root) || !S_ISDIR(facts.root.st_mode)) reject("INVALID_ROOT_FD");
    const int duplicated = ::dup(3); if(duplicated < 0) reject("ROOT_DUP_FAILED"); closure.duplicateCreated = true;
    {
      Directory root(duplicated, closure, false);
      std::vector<Directory> children; children.reserve(maxChildFds);
      enumerate(root, "", 0, facts.root, facts, closure, control, children);
      // 保留全部原FD核两次完整快照；变更不能靠新的path/FD或仅根inode混进facts。
      for(unsigned pass = 0; pass < 2; ++pass) {
        for(const auto &row : facts.directories) { stableFd(row.fd, row.identity, control); stableNames(row.fd, row.entries, control); }
        stableFd(3, facts.root, control);
      }
      children.clear();
      if(closure.failed) reject("PHYSICAL_CLOSE_FAILED");
      stableFd(3, facts.root, control);
    }
    if(closure.failed) reject("PHYSICAL_CLOSE_FAILED");
    control.beforePublication();
  } catch(const Failure &failure) { error = failure.code; cancelled = failure.cancelled; }
  catch(...) { error = "INTERNAL_PROBE_FAILED"; }
  // 所有成功、拒绝和取消路径都关闭继承FD3；它不是父Owner仍持有的原FileHandle。
  const bool inputClosed = closedFd(3);
  if(!inputClosed || closure.failed) { error = "PHYSICAL_CLOSE_FAILED"; cancelled = false; }
  if(error) {
    // 取消/拒绝不输出可被Domain消费的facts；不输出路径或用户名称。
    const std::string message = std::string("STRUCTURE_PROBE_") + error + "\n";
    ::write(2, message.data(), message.size()); return cancelled ? 3 : 2;
  }
  if(!closure.duplicateCreated || !closure.duplicateClosed || closure.childOpened != closure.childClosed
    || closure.streamsOpened != closure.streamsClosed || facts.directories.size() != closure.childOpened + 1) {
    const char *message = "STRUCTURE_PROBE_PHYSICAL_CLOSE_FAILED\n"; ::write(2, message, std::strlen(message)); return 2;
  }
  try {
    control.beforePublication(); const std::string output = body(facts, closure);
    if(output.size() > maxRawBytes || !publish(output, control)) reject("OUTPUT_FAILED");
    return 0;
  } catch(const Failure &failure) {
    const std::string message = std::string("STRUCTURE_PROBE_") + failure.code + "\n";
    ::write(2, message.data(), message.size()); return failure.cancelled ? 3 : 2;
  } catch(...) { const char *message = "STRUCTURE_PROBE_INTERNAL_PROBE_FAILED\n"; ::write(2, message, std::strlen(message)); return 2; }
}
} // namespace structure_probe
int main(int argc, char **argv) {
  if(argc == 2 && !std::strcmp(argv[1], "--probe-structure-fd")) return structure_probe::run();
  if(argc != 2 || std::strcmp(argv[1], "--watch-fd")) return 2;
  struct stat before{}, named{}; char rootPath[PATH_MAX]{};
  if(::fstat(3, &before) || !S_ISDIR(before.st_mode) || ::fcntl(3, F_GETPATH, rootPath)
     || ::lstat(rootPath, &named) || !S_ISDIR(named.st_mode)
     || named.st_dev != before.st_dev || named.st_ino != before.st_ino) return 2;
  CFStringRef name = CFStringCreateWithFileSystemRepresentation(nullptr, rootPath);
  if(!name) return 2;
  const void *values[] = {name};
  CFArrayRef paths = CFArrayCreate(nullptr, values, 1, &kCFTypeArrayCallBacks);
  CFRelease(name);
  if(!paths) return 2;
  FSEventStreamContext context{};
  FSEventStreamRef stream = FSEventStreamCreate(nullptr, changed, &context, paths,
    kFSEventStreamEventIdSinceNow, 0.05,
    kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot | kFSEventStreamCreateFlagNoDefer);
  CFRelease(paths);
  if(!stream) return 2;
  FSEventStreamScheduleWithRunLoop(stream, CFRunLoopGetCurrent(), kCFRunLoopDefaultMode);
  if(!FSEventStreamStart(stream)) { FSEventStreamInvalidate(stream); FSEventStreamRelease(stream); return 2; }
  std::thread control([] {
    std::string input;
    while(!stopping.load()) {
      struct pollfd ready{0, POLLIN | POLLHUP, 0};
      const int observed = ::poll(&ready, 1, 100);
      if(observed < 0) { if(errno == EINTR) continue; invalidControl.store(true); break; }
      if(!observed) continue;
      char block[16]; const auto n = ::read(0, block, sizeof(block));
      if(n <= 0) { invalidControl.store(true); break; }
      input.append(block, static_cast<std::size_t>(n));
      if(input == "STOP\n") break;
      if(input.size() >= 5 || std::string("STOP\n").compare(0, input.size(), input) != 0) { invalidControl.store(true); break; }
    }
    stopping.store(true);
  });
  if(!line("READY\n")) stopping.store(true);
  while(!stopping.load()) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, false);
  FSEventStreamStop(stream);
  FSEventStreamInvalidate(stream);
  FSEventStreamRelease(stream);
  control.join();
  if(::close(3) || ::fcntl(3, F_GETFD) >= 0 || errno != EBADF) return 2;
  if(invalidControl.load()) return 2;
  return line("STOPPED\n") ? 0 : 2;
}
