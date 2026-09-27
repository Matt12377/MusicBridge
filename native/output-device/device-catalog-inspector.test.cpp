#include "device-catalog-inspector.hpp"
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>

using namespace output::device;
namespace {
void check(bool value, const char* message) { if (!value) { std::fprintf(stderr, "%s\n", message); std::exit(1); } }
uint16_t u16(const std::byte* p) { return uint16_t(std::to_integer<uint8_t>(p[0])) | uint16_t(std::to_integer<uint8_t>(p[1])) << 8; }
std::array<std::byte, inspectorRequestBytes> request(InspectorOperation operation, const char* uid = "") {
  std::array<std::byte, inspectorRequestBytes> bytes{};
  std::memcpy(bytes.data(), "MBIQ", 4); bytes[4] = std::byte{1}; bytes[6] = std::byte(static_cast<uint16_t>(operation));
  const auto length = std::strlen(uid); bytes[8] = std::byte(length);
  std::memcpy(bytes.data() + 16, uid, length); return bytes;
}
class FakeSource final : public InspectorSource {
 public:
  std::optional<std::vector<InspectorCandidate>> list() noexcept override {
    return std::vector<InspectorCandidate>{{"exact-uid", "受控输出设备", true}};
  }
  std::optional<DeviceObservation> observeExact(std::string_view uid) noexcept override {
    if (uid != "exact-uid") return std::nullopt;
    return DeviceObservation{"exact-uid", 1, 1, 48000, 2, PcmFormat::s16le, PcmFormat::s16le, 256, true, true};
  }
};
}
int main() {
  FakeSource source;
  const auto list = respondInspector(source, request(InspectorOperation::list));
  check(list && list->size() == inspectorResponseHeaderBytes + inspectorCandidateBytes
    && std::memcmp(list->data(), "MBIR", 4) == 0 && u16(list->data() + 6) == 1
    && u16(list->data() + 8) == 0 && u16(list->data() + 10) == 1,
    "只读目录响应头无效");
  check(u16(list->data() + 16) == 9 && (*list)[20] == std::byte{1}
    && std::memcmp(list->data() + 24, "exact-uid", 9) == 0, "只读候选字段无效");
  const auto exact = respondInspector(source, request(InspectorOperation::observe_exact, "exact-uid"));
  check(exact && exact->size() == inspectorResponseHeaderBytes + inspectorObservationBytes
    && u16(exact->data() + 6) == 2 && u16(exact->data() + 10) == 1
    && u16(exact->data() + 16) == 9 && u16(exact->data() + 18) == 1
    && u16(exact->data() + 22) == 2 && (*exact)[32] == std::byte{1}
    && (*exact)[33] == std::byte{1}, "精确观测字段无效");
  const auto missing = respondInspector(source, request(InspectorOperation::observe_exact, "absent"));
  check(missing && missing->size() == inspectorResponseHeaderBytes && u16(missing->data() + 8) == 1,
    "不存在UID必须明确不可用");
  auto invalid = request(InspectorOperation::list, "exact-uid");
  check(!decodeInspectorRequest(invalid), "list不得夹带UID");
  invalid = request(InspectorOperation::observe_exact, "exact-uid"); invalid[10] = std::byte{1};
  check(!decodeInspectorRequest(invalid), "保留字段非零必须拒绝");
  invalid = request(InspectorOperation::observe_exact, "exact-uid"); invalid[16] = std::byte{0};
  check(!decodeInspectorRequest(invalid), "UID包含NUL必须拒绝");
  std::printf("通过：只读目录/精确观测协议 Fake；未枚举或打开 HAL。\n");
}
