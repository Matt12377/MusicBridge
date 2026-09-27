#include "device-catalog-inspector.hpp"
#include "system-device-probe.hpp"
#include <CoreFoundation/CoreFoundation.h>
#include <algorithm>
#include <array>
#include <cerrno>
#include <cstring>
#include <limits>
#include <string_view>
#include <unordered_set>
#include <unistd.h>

namespace output::device {
namespace {
uint16_t u16(const std::byte* p) { return uint16_t(std::to_integer<uint8_t>(p[0])) | uint16_t(std::to_integer<uint8_t>(p[1])) << 8; }
void put16(std::byte* p, uint16_t value) { p[0] = std::byte(value & 255); p[1] = std::byte(value >> 8); }
void put32(std::byte* p, uint32_t value) { put16(p, uint16_t(value)); put16(p + 2, uint16_t(value >> 16)); }
bool zero(std::span<const std::byte> bytes) {
  return std::all_of(bytes.begin(), bytes.end(), [](std::byte value) { return value == std::byte{0}; });
}
bool uidSafe(std::string_view uid) { return !uid.empty() && uid.size() <= 128 && uid.find('\0') == std::string_view::npos; }
void header(std::vector<std::byte>& bytes, InspectorOperation operation, uint16_t status, uint16_t count) {
  bytes.resize(inspectorResponseHeaderBytes);
  std::memcpy(bytes.data(), "MBIR", 4); put16(bytes.data() + 4, 1);
  put16(bytes.data() + 6, static_cast<uint16_t>(operation)); put16(bytes.data() + 8, status); put16(bytes.data() + 10, count);
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
AudioObjectPropertyAddress address(AudioObjectPropertySelector selector, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal) {
  return {selector, scope, kAudioObjectPropertyElementMain};
}
template<typename T> bool property(AudioObjectID object, AudioObjectPropertySelector selector, AudioObjectPropertyScope scope, T& out) {
  const auto at = address(selector, scope); UInt32 size = sizeof(T);
  return AudioObjectGetPropertyData(object, &at, 0, nullptr, &size, &out) == noErr && size == sizeof(T);
}
std::optional<std::string> utf8(CFStringRef text, size_t maximum) {
  if (!text) return std::nullopt;
  const auto length = CFStringGetLength(text);
  if (length <= 0 || length > 256) return std::nullopt;
  std::array<UInt8, 256> buffer{}; CFIndex used = 0;
  if (CFStringGetBytes(text, CFRangeMake(0, length), kCFStringEncodingUTF8, 0, false,
      buffer.data(), static_cast<CFIndex>(buffer.size()), &used) != length
    || used < 1 || used > static_cast<CFIndex>(maximum)) return std::nullopt;
  const std::string value(reinterpret_cast<const char*>(buffer.data()), static_cast<size_t>(used));
  if (value.find('\0') != std::string::npos) return std::nullopt;
  return value;
}
std::optional<std::string> stringProperty(AudioObjectID device, AudioObjectPropertySelector selector, size_t maximum) {
  CFStringRef value = nullptr;
  if (!property(device, selector, kAudioObjectPropertyScopeGlobal, value) || !value) return std::nullopt;
  const auto result = utf8(value, maximum); CFRelease(value); return result;
}
class SystemInspectorSource final : public InspectorSource {
 public:
  std::optional<std::vector<InspectorCandidate>> list() noexcept override {
    try {
      // 只读取设备集合/UID/名称/是否存活/输出流，不读取默认设备、不设置属性、不创建IOProc。
      const auto devicesProperty = address(kAudioHardwarePropertyDevices);
      UInt32 size = 0;
      if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &devicesProperty, 0, nullptr, &size) != noErr
        || size % sizeof(AudioObjectID) || size > 64 * sizeof(AudioObjectID)) return std::nullopt;
      std::array<AudioObjectID, 64> ids{};
      if (size && AudioObjectGetPropertyData(kAudioObjectSystemObject, &devicesProperty, 0, nullptr, &size, ids.data()) != noErr) return std::nullopt;
      std::vector<InspectorCandidate> result; std::unordered_set<std::string> seen;
      for (size_t index = 0; index < size / sizeof(AudioObjectID); ++index) {
        const auto device = ids[index];
        if (device == kAudioObjectUnknown) continue;
        const auto uid = stringProperty(device, kAudioDevicePropertyDeviceUID, 128);
        if (!uid || !uidSafe(*uid) || !seen.insert(*uid).second) continue;
        const auto name = stringProperty(device, kAudioObjectPropertyName, 256);
        UInt32 alive = 0; const bool live = property(device, kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal, alive) && alive != 0;
        const auto streams = address(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeOutput);
        UInt32 streamSize = 0;
        const bool output = AudioObjectGetPropertyDataSize(device, &streams, 0, nullptr, &streamSize) == noErr
          && streamSize == sizeof(AudioStreamID);
        result.push_back({*uid, name.value_or("输出设备"), live && output});
      }
      return result;
    } catch (...) { return std::nullopt; }
  }
  std::optional<DeviceObservation> observeExact(std::string_view uid) noexcept override {
    SystemDeviceProbe probe;
    return probe.observeExact(uid);
  }
};
}

std::optional<InspectorRequest> decodeInspectorRequest(std::span<const std::byte, inspectorRequestBytes> bytes) noexcept {
  if (std::memcmp(bytes.data(), "MBIQ", 4) != 0 || u16(bytes.data() + 4) != 1
    || !zero(bytes.subspan(10, 6))) return std::nullopt;
  const auto operation = u16(bytes.data() + 6), length = u16(bytes.data() + 8);
  if ((operation != 1 && operation != 2) || length > 128 || !zero(bytes.subspan(16 + length, 128 - length))
    || (operation == 1 && length != 0) || (operation == 2 && length == 0)) return std::nullopt;
  const std::string uid(reinterpret_cast<const char*>(bytes.data() + 16), length);
  if (operation == 2 && !uidSafe(uid)) return std::nullopt;
  return InspectorRequest{static_cast<InspectorOperation>(operation), uid};
}

std::optional<std::vector<std::byte>> respondInspector(InspectorSource& source,
  std::span<const std::byte, inspectorRequestBytes> bytes) noexcept {
  try {
    const auto request = decodeInspectorRequest(bytes);
    if (!request) return std::nullopt;
    std::vector<std::byte> response;
    if (request->operation == InspectorOperation::list) {
      const auto candidates = source.list();
      if (!candidates || candidates->size() > 64) return std::nullopt;
      header(response, request->operation, 0, static_cast<uint16_t>(candidates->size()));
      std::unordered_set<std::string> seen;
      for (const auto& candidate : *candidates) {
        if (!uidSafe(candidate.uid) || candidate.label.empty() || candidate.label.size() > 256
          || candidate.label.find('\0') != std::string::npos || !seen.insert(candidate.uid).second) return std::nullopt;
        const size_t offset = response.size(); response.resize(offset + inspectorCandidateBytes);
        auto* record = response.data() + offset;
        put16(record, static_cast<uint16_t>(candidate.uid.size())); put16(record + 2, static_cast<uint16_t>(candidate.label.size()));
        record[4] = std::byte(candidate.available);
        std::memcpy(record + 8, candidate.uid.data(), candidate.uid.size());
        std::memcpy(record + 136, candidate.label.data(), candidate.label.size());
      }
    } else {
      const auto observed = source.observeExact(request->uid);
      if (!observed) { header(response, request->operation, 1, 0); return response; }
      if (observed->uid != request->uid || observed->sampleRate < 1 || observed->channels < 1 || observed->channels > 2
        || observed->bufferFrames < 1) return std::nullopt;
      header(response, request->operation, 0, 1);
      response.resize(inspectorResponseHeaderBytes + inspectorObservationBytes);
      auto* record = response.data() + inspectorResponseHeaderBytes;
      put16(record, static_cast<uint16_t>(observed->uid.size()));
      put16(record + 2, static_cast<uint16_t>(observed->format));
      put16(record + 4, static_cast<uint16_t>(observed->physicalFormat));
      put16(record + 6, static_cast<uint16_t>(observed->channels));
      put32(record + 8, observed->sampleRate); put32(record + 12, observed->bufferFrames);
      record[16] = std::byte(observed->alive); record[17] = std::byte(observed->hasOutput);
      std::memcpy(record + 24, observed->uid.data(), observed->uid.size());
    }
    return response;
  } catch (...) { return std::nullopt; }
}

int runDeviceCatalogInspector() {
  std::array<std::byte, inspectorRequestBytes> request{};
  if (!readExactly(STDIN_FILENO, request)) return 1;
  SystemInspectorSource source;
  const auto response = respondInspector(source, request);
  return response && writeExactly(STDOUT_FILENO, *response) ? 0 : 1;
}
}
