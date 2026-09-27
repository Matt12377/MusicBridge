#pragma once

#include "device-session.hpp"
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace output::device {
constexpr size_t inspectorRequestBytes = 144;
constexpr size_t inspectorResponseHeaderBytes = 16;
constexpr size_t inspectorCandidateBytes = 392;
constexpr size_t inspectorObservationBytes = 152;
enum class InspectorOperation : uint16_t { list = 1, observe_exact = 2 };
struct InspectorRequest { InspectorOperation operation; std::string uid; };
struct InspectorCandidate { std::string uid; std::string label; bool available; };
class InspectorSource {
 public:
  virtual ~InspectorSource() = default;
  virtual std::optional<std::vector<InspectorCandidate>> list() noexcept = 0;
  virtual std::optional<DeviceObservation> observeExact(std::string_view uid) noexcept = 0;
};
std::optional<InspectorRequest> decodeInspectorRequest(std::span<const std::byte, inspectorRequestBytes> bytes) noexcept;
std::optional<std::vector<std::byte>> respondInspector(InspectorSource& source,
  std::span<const std::byte, inspectorRequestBytes> bytes) noexcept;
int runDeviceCatalogInspector();
}
