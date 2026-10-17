// 只处理Owner已经取得独占声明的保护副本FD；不解析路径、URL或任意命令。
#include <tfilestream.h>
#include <tpropertymap.h>
#include <tvariant.h>
#include <attachedpictureframe.h>
#include <CommonCrypto/CommonDigest.h>
#include <wavfile.h>
#include <aifffile.h>
#include <flacfile.h>
#include <mpegfile.h>
#include <mp4file.h>
#include <vorbisfile.h>
#include <opusfile.h>
#include <wavpackfile.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr std::size_t maxInput = 8 * 1024 * 1024;
const std::vector<std::string> keys = {"TITLE", "ARTIST", "ALBUM", "DATE", "DISCNUMBER", "TRACKNUMBER", "LYRICS", "PICTURE"};
using Bytes = std::vector<unsigned char>;
std::uint32_t number(const Bytes &b, std::size_t &p) {
  if(p + 4 > b.size()) throw std::runtime_error("协议不完整");
  std::uint32_t n = 0;
  for(int i = 0; i < 4; ++i) n = (n << 8) | b[p++];
  return n;
}
std::string field(const Bytes &b, std::size_t &p, std::size_t limit) {
  const auto n = number(b, p);
  if(n > limit || p + n > b.size()) throw std::runtime_error("协议预算无效");
  std::string s(reinterpret_cast<const char *>(b.data() + p), n); p += n;
  if(s.find('\0') != std::string::npos) throw std::runtime_error("协议含空字符");
  return s;
}
void appendNumber(Bytes &b, std::size_t n) {
  for(int shift = 24; shift >= 0; shift -= 8) b.push_back(static_cast<unsigned char>((n >> shift) & 255));
}
void appendField(Bytes &b, const std::string &s) { appendNumber(b, s.size()); b.insert(b.end(), s.begin(), s.end()); }
std::string pictureHash(const TagLib::ByteVector &bytes) {
  if(bytes.isEmpty()) return {};
  unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(bytes.data(), static_cast<CC_LONG>(bytes.size()), digest);
  constexpr char hex[] = "0123456789abcdef"; std::string result;
  for(auto c : digest) { result += hex[c >> 4]; result += hex[c & 15]; } return result;
}
std::unique_ptr<TagLib::File> fileFor(const std::string &format, TagLib::IOStream *stream) {
  if(format == "pcm-wav") return std::make_unique<TagLib::RIFF::WAV::File>(stream, false);
  if(format == "pcm-aiff") return std::make_unique<TagLib::RIFF::AIFF::File>(stream, false);
  if(format == "flac") return std::make_unique<TagLib::FLAC::File>(stream, false);
  if(format == "mp3") return std::make_unique<TagLib::MPEG::File>(stream, false);
  if(format == "alac") return std::make_unique<TagLib::MP4::File>(stream, false);
  if(format == "vorbis") return std::make_unique<TagLib::Ogg::Vorbis::File>(stream, false);
  if(format == "opus") return std::make_unique<TagLib::Ogg::Opus::File>(stream, false);
  if(format == "wavpack") return std::make_unique<TagLib::WavPack::File>(stream, false);
  throw std::runtime_error("格式不受支持");
}
Bytes readInput() {
  Bytes result; unsigned char block[4096];
  for(;;) {
    const auto n = ::read(4, block, sizeof(block));
    if(n < 0) { if(errno == EINTR) continue; throw std::runtime_error("输入读取失败"); }
    if(!n) break;
    if(result.size() + static_cast<std::size_t>(n) > maxInput) throw std::runtime_error("输入超过预算");
    result.insert(result.end(), block, block + n);
  }
  return result;
}
void writeOutput(const Bytes &b) {
  std::size_t done = 0;
  while(done < b.size()) {
    const auto n = ::write(1, b.data() + done, b.size() - done);
    if(n < 0) { if(errno == EINTR) continue; throw std::runtime_error("回显写出失败"); }
    if(!n) throw std::runtime_error("回显提前结束");
    done += static_cast<std::size_t>(n);
  }
}
std::unique_ptr<TagLib::FileStream> openClaimedStream(bool readOnly) {
  // FileStream会关闭传入FD。单独转交dup，保留Owner的FD3用于身份复核与fsync。
  if(::lseek(3, 0, SEEK_SET) < 0) throw std::runtime_error("保护副本无法定位");
  const int owned = ::fcntl(3, F_DUPFD_CLOEXEC, 5);
  if(owned < 0) throw std::runtime_error("保护副本FD无法复制");
  auto stream = std::make_unique<TagLib::FileStream>(owned, readOnly);
  if(!stream->isOpen()) { ::close(owned); throw std::runtime_error("保护副本流无法打开"); }
  stream->seek(0); return stream;
}
}
int main(int argc, char **argv) {
  unsigned int stage = 0;
  try {
    if(argc != 2 || (std::strcmp(argv[1], "--write-copy") != 0 && std::strcmp(argv[1], "--read-copy") != 0))
      throw std::runtime_error("命令无效");
    const bool write = std::strcmp(argv[1], "--write-copy") == 0;
    struct stat before{};
    const int flags = ::fcntl(3, F_GETFL);
    if(::fstat(3, &before) || !S_ISREG(before.st_mode) || before.st_nlink != 1 || flags < 0
       || (write && (flags & O_ACCMODE) != O_RDWR)) throw std::runtime_error("未取得保护副本FD");
    const auto input = readInput(); std::size_t pos = 7;
    if(input.size() < pos || std::memcmp(input.data(), "MBTAG1\n", pos)) throw std::runtime_error("协议版本无效");
    const auto format = field(input, pos, 16);
    const auto count = number(input, pos);
    if(count > keys.size() || (!write && count != 0)) throw std::runtime_error("字段数无效");
    TagLib::PropertyMap changes; std::set<std::string> seen; TagLib::ByteVector picture;
    for(std::uint32_t i = 0; i < count; ++i) {
      const auto key = field(input, pos, 16), value = field(input, pos, key == "PICTURE" ? 6 * 1024 * 1024 : key == "LYRICS" ? 64 * 1024 : 4096);
      if(std::find(keys.begin(), keys.end(), key) == keys.end() || !seen.insert(key).second) throw std::runtime_error("字段无效");
      const TagLib::String text(value, TagLib::String::UTF8);
      if(text.to8Bit(true) != value) throw std::runtime_error("字段不是完整UTF8");
      if(key == "PICTURE") {
        const TagLib::ByteVector encoded(value.data(), value.size()); picture = TagLib::ByteVector::fromBase64(encoded);
        if(picture.size() < 3 || picture.size() > 4 * 1024 * 1024 || picture.toBase64() != encoded
          || (picture.mid(0, 3) != TagLib::ByteVector("\377\330\377", 3) && picture.mid(0, 8) != TagLib::ByteVector("\211PNG\r\n\032\n", 8)))
          throw std::runtime_error("图片副本无效");
      } else changes.replace(TagLib::String(key), TagLib::StringList(text));
    }
    if(pos != input.size()) throw std::runtime_error("协议含多余字段");
    stage = 1;
    {
      auto stream = openClaimedStream(!write);
      auto file = fileFor(format, stream.get());
      if(!file->isValid() || !file->isOpen()) throw std::runtime_error("保护副本不是有效音频");
      if(write) {
        stage = 2;
        auto props = file->properties();
        for(const auto &item : changes) props.replace(item.first, item.second);
        const auto unsupported = file->setProperties(props);
        for(const auto &key : seen) if(unsupported.contains(TagLib::String(key))) throw std::runtime_error("标签写入不受支持");
        if(!picture.isEmpty()) {
          TagLib::VariantMap image; image.insert("data", picture);
          image.insert("mimeType", TagLib::String(static_cast<unsigned char>(picture[0]) == 0xff ? "image/jpeg" : "image/png"));
          image.insert("description", TagLib::String("MusicBridge"));
          image.insert("pictureType", TagLib::ID3v2::AttachedPictureFrame::typeToString(TagLib::ID3v2::AttachedPictureFrame::FrontCover));
          image.insert("width", 0); image.insert("height", 0); image.insert("colorDepth", 0); image.insert("numColors", 0);
          if(!file->setComplexProperties("PICTURE", TagLib::List<TagLib::VariantMap>{image})) throw std::runtime_error("图片写入不受支持");
        }
        if(!file->save()) throw std::runtime_error("标签写入未完成");
      }
    }
    // fclose完成stdio缓冲区写出后，再同步保留的同一inode。
    stage = 3;
    if(write && ::fsync(3)) throw std::runtime_error("标签同步未完成");
    auto checkStream = openClaimedStream(true);
    auto checkFile = fileFor(format, checkStream.get());
    if(!checkFile->isValid() || !checkFile->isOpen()) throw std::runtime_error("写后音频无法读取");
    stage = 4;
    const auto actual = checkFile->properties();
    for(const auto &item : changes) if(!actual.contains(item.first) || actual[item.first] != item.second) throw std::runtime_error("写后标签不匹配");
    const auto pictures = checkFile->complexProperties("PICTURE");
    const auto actualPicture = pictures.isEmpty() ? TagLib::ByteVector{} : pictures.front().value("data").toByteVector();
    if(!picture.isEmpty() && picture != actualPicture) throw std::runtime_error("写后图片不匹配");
    stage = 5;
    struct stat after{};
    if(::fstat(3, &after) || before.st_dev != after.st_dev || before.st_ino != after.st_ino || after.st_nlink != 1)
      throw std::runtime_error("保护副本身份发生变化");
    Bytes output{'M','B','T','A','G','1','\n'}; appendField(output, format); appendNumber(output, keys.size());
    for(const auto &key : keys) {
      const auto values = actual[TagLib::String(key)]; const auto value = key == "PICTURE" ? pictureHash(actualPicture) : values.isEmpty() ? std::string() : values.front().to8Bit(true);
      if(value.size() > (key == "LYRICS" ? 64 * 1024 : 4096)) throw std::runtime_error("标签回显超过预算");
      appendField(output, key); appendField(output, value);
    }
    stage = 6;
    writeOutput(output); return 0;
  } catch(...) { std::cerr << "音频标签保护副本处理失败，阶段=" << stage << "。\n"; return 1; }
}
