import { constants } from 'node:fs'
import { lstat, open, realpath, readdir, mkdir, rename, unlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import rustBeforePack from './native-rust-package.mjs'

export const CUE_NATIVE_BUILD_ROOT = 'native/cue-ffmpeg/darwin-arm64'
export const CUE_NATIVE_RESOURCE_ROOT = 'cue-ffmpeg/darwin-arm64'
export const CUE_NATIVE_BUILD_FILE = 'cue-build.json'
export const CUE_NATIVE_PURPOSE = 'cue-independent-eight-format-output'
export const CUE_OUTPUT_PROFILES = Object.freeze([
  'flac:s24', 'alac:s24', 'mp3:fixed', 'vorbis:fixed', 'opus:fixed', 'wavpack:s24',
  'pcm-wav:s24', 'pcm-wav:s16', 'pcm-wav:s32', 'pcm-wav:f32',
  'pcm-aiff:s24', 'pcm-aiff:s16', 'pcm-aiff:s32', 'pcm-aiff:f32',
])
const SOURCES = [
  {
    "id": "ffmpeg",
    "version": "8.1.2",
    "archive": "ffmpeg-8.1.2.tar.xz",
    "directory": "ffmpeg-8.1.2",
    "bytes": 11710924,
    "sha256": "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
    "url": "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
    "license": "LGPL-2.1-or-later",
    "authenticity": "fixed-sha256-and-official-pgp-fingerprint",
    "legal": [
      "COPYING.LGPLv2.1",
      "LICENSE.md"
    ]
  },
  {
    "id": "ogg",
    "version": "1.3.6",
    "archive": "libogg-1.3.6.tar.xz",
    "directory": "libogg-1.3.6",
    "bytes": 439952,
    "sha256": "5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061",
    "url": "https://downloads.xiph.org/releases/ogg/libogg-1.3.6.tar.xz",
    "license": "BSD-3-Clause",
    "authenticity": "official-published-sha256",
    "legal": [
      "COPYING",
      "AUTHORS"
    ]
  },
  {
    "id": "vorbis",
    "version": "1.3.7",
    "archive": "libvorbis-1.3.7.tar.xz",
    "directory": "libvorbis-1.3.7",
    "bytes": 1203792,
    "sha256": "b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b",
    "url": "https://downloads.xiph.org/releases/vorbis/libvorbis-1.3.7.tar.xz",
    "license": "BSD-3-Clause",
    "authenticity": "official-published-sha256",
    "legal": [
      "COPYING",
      "AUTHORS"
    ]
  },
  {
    "id": "opus",
    "version": "1.6.1",
    "archive": "opus-1.6.1.tar.gz",
    "directory": "opus-1.6.1",
    "bytes": 10472813,
    "sha256": "6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1",
    "url": "https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz",
    "license": "BSD-3-Clause",
    "authenticity": "official-published-sha256",
    "legal": [
      "COPYING",
      "AUTHORS"
    ]
  },
  {
    "id": "lame",
    "version": "4.0",
    "archive": "lame-4.0.tar.gz",
    "directory": "lame-4.0",
    "bytes": 1496810,
    "sha256": "3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb",
    "url": "https://downloads.sourceforge.net/project/lame/lame/4.0/lame-4.0.tar.gz",
    "license": "LGPL-2.0-or-later",
    "authenticity": "official-https-first-observed-sha256",
    "legal": [
      "LICENSE",
      "COPYING"
    ]
  }
]
const CONFIGURE = [
  "--prefix=/MusicBridgeCue",
  "--cc=clang",
  "--arch=arm64",
  "--target-os=darwin",
  "--pkg-config=/opt/homebrew/bin/pkg-config",
  "--disable-autodetect",
  "--disable-everything",
  "--disable-gpl",
  "--disable-nonfree",
  "--disable-version3",
  "--disable-network",
  "--disable-doc",
  "--disable-debug",
  "--disable-programs",
  "--enable-ffmpeg",
  "--enable-ffprobe",
  "--enable-shared",
  "--disable-static",
  "--disable-avdevice",
  "--disable-swscale",
  "--disable-audiotoolbox",
  "--disable-videotoolbox",
  "--disable-coreimage",
  "--disable-appkit",
  "--disable-avfoundation",
  "--enable-avcodec",
  "--enable-avformat",
  "--enable-avfilter",
  "--enable-swresample",
  "--enable-libmp3lame",
  "--enable-libvorbis",
  "--enable-libopus",
  "--enable-protocol=fd",
  "--enable-demuxer=flac,mp3,ogg,wv,wav,aiff,mov,ape,tta,mpc,mpc8,tak",
  "--enable-muxer=flac,mp3,ogg,wv,wav,aiff,ipod,null,pcm_s16le,pcm_s24le,pcm_s32le",
  "--enable-parser=flac,mpegaudio,opus,vorbis,tak",
  "--enable-decoder=flac,alac,mp3float,vorbis,opus,wavpack,ape,tta,mpc7,mpc8,tak,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be",
  "--enable-encoder=flac,alac,libmp3lame,libvorbis,libopus,wavpack,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be",
  "--enable-filter=aresample,aformat,anull,atrim,asetpts,pan,abuffer,abuffersink",
  "--install-name-dir=@rpath",
  "--extra-cflags=-mmacosx-version-min=13.0",
  "--extra-ldflags=-mmacosx-version-min=13.0 -Wl,-rpath,@executable_path/../lib"
]
const COMPONENTS = [
  {
    "id": "libavcodec.62.dylib",
    "name": "libavcodec",
    "version": "62.28.102"
  },
  {
    "id": "libavfilter.11.dylib",
    "name": "libavfilter",
    "version": "11.14.102"
  },
  {
    "id": "libavformat.62.dylib",
    "name": "libavformat",
    "version": "62.12.102"
  },
  {
    "id": "libavutil.60.dylib",
    "name": "libavutil",
    "version": "60.26.102"
  },
  {
    "id": "libswresample.6.dylib",
    "name": "libswresample",
    "version": "6.3.102"
  },
  {
    "id": "libogg.0.dylib",
    "name": "libogg",
    "version": "1.3.6"
  },
  {
    "id": "libvorbis.0.dylib",
    "name": "libvorbis",
    "version": "1.3.7"
  },
  {
    "id": "libvorbisenc.2.dylib",
    "name": "libvorbisenc",
    "version": "1.3.7"
  },
  {
    "id": "libopus.0.dylib",
    "name": "libopus",
    "version": "1.6.1"
  },
  {
    "id": "libmp3lame.0.dylib",
    "name": "libmp3lame",
    "version": "4.0"
  }
]
const LEGAL = [
  {
    "relative": "legal/NOTICE.txt",
    "bytes": 318,
    "sha256": "1c536c3c857460c351c2957fe1e3a3a9b30d869840e0d581086826f5c8d95151"
  },
  {
    "relative": "legal/ffmpeg/COPYING.LGPLv2.1",
    "bytes": 26517,
    "sha256": "246041b6ecf9bc32d718a62c57877c78b5eb397b6467e74ed7ae2626ab189c30"
  },
  {
    "relative": "legal/ffmpeg/LICENSE.md",
    "bytes": 4346,
    "sha256": "2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af"
  },
  {
    "relative": "legal/ffmpeg/ffmpeg-8.1.2.tar.xz",
    "bytes": 11710924,
    "sha256": "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
  },
  {
    "relative": "legal/lame/COPYING",
    "bytes": 25281,
    "sha256": "e64f9c5a18f56828c10a575df13ade641aa3af4512a7afe6c411256943b57aaf"
  },
  {
    "relative": "legal/lame/LICENSE",
    "bytes": 503,
    "sha256": "5c1f8d44f1eacbea3e1c31ff6ee11a4e1690ccbed4ee4af16de3b6eb61dc69a8"
  },
  {
    "relative": "legal/lame/lame-4.0.tar.gz",
    "bytes": 1496810,
    "sha256": "3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb"
  },
  {
    "relative": "legal/ogg/AUTHORS",
    "bytes": 198,
    "sha256": "6fcb33d0cdd60b5054e7df820916388b590427514288c2bab01c626bb8ae9506"
  },
  {
    "relative": "legal/ogg/COPYING",
    "bytes": 1466,
    "sha256": "d2ab5758336489da61c12cc5bb757da5339c4ae9001f9bb0562b4370249af814"
  },
  {
    "relative": "legal/ogg/libogg-1.3.6.tar.xz",
    "bytes": 439952,
    "sha256": "5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061"
  },
  {
    "relative": "legal/opus/AUTHORS",
    "bytes": 239,
    "sha256": "f9fd849e652219ce98e008303370b352d37663d0ffb27b8dc514ad93c9c7438b"
  },
  {
    "relative": "legal/opus/COPYING",
    "bytes": 1945,
    "sha256": "01e1167d54a096d123cf6dfbbeb19587278845c6481d2d66d545669846079551"
  },
  {
    "relative": "legal/opus/opus-1.6.1.tar.gz",
    "bytes": 10472813,
    "sha256": "6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1"
  },
  {
    "relative": "legal/vorbis/AUTHORS",
    "bytes": 65,
    "sha256": "f5cab9f16035f770f50299f85cf2938c06dc3a9a30425961067788102ec896d3"
  },
  {
    "relative": "legal/vorbis/COPYING",
    "bytes": 1470,
    "sha256": "ec1815db59fcd302846df949d7424876cb2e2dc5ed1606c5fb0b36787b1cf43a"
  },
  {
    "relative": "legal/vorbis/libvorbis-1.3.7.tar.xz",
    "bytes": 1203792,
    "sha256": "b33cc4934322bcbf6efcbacf49e3ca01aadbea4114ec9589d1b1e9d20f72954b"
  }
]
const RECIPES = {
  "ogg": [
    "--enable-shared",
    "--disable-static",
    "--disable-docs"
  ],
  "vorbis": [
    "--enable-shared",
    "--disable-static",
    "--disable-examples",
    "--disable-docs",
    "--with-ogg=<fixed-build-dependencies>"
  ],
  "opus": [
    "--enable-shared",
    "--disable-static",
    "--disable-doc",
    "--disable-extra-programs",
    "--disable-deep-plc",
    "--disable-dred",
    "--disable-osce"
  ],
  "lame": [
    "--enable-shared",
    "--disable-static",
    "--disable-decoder",
    "--disable-frontend",
    "--disable-nasm"
  ],
  "vorbisMake": [
    "CFLAGS:仅移除-force_cpusubtype_ALL"
  ]
}
const SHA64 = /^[a-f0-9]{64}$/u
const STAT_FIELDS = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink']
const MAX_FILE = 16 * 1024 * 1024
const MAX_WHOLE = 64 * 1024 * 1024
const MINIMUM_MACOS = 13 << 16
export const nativeDigest = bytes => createHash('sha256').update(bytes).digest('hex')
export function nativeFail(code = 'NATIVE_PACKAGE_IDENTITY_MISMATCH') {
  const error = new Error('原生包、构建固定身份或完整资源读回不符合要求。')
  error.code = code
  throw error
}
export function nativeAssert(condition, code) { if (!condition) nativeFail(code) }
export function nativeContext() { return { deadline: performance.now() + 90_000, bytes: 0 } }
function checkTime(context) { nativeAssert(performance.now() < context.deadline, 'NATIVE_PACKAGE_READ_TIMEOUT') }
export function nativeSame(left, right) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}
export function nativeKeys(value, fields) {
  nativeAssert(value !== null && typeof value === 'object' && !Array.isArray(value)
    && nativeSame(Object.keys(value).sort(), [...fields].sort()), 'NATIVE_PACKAGE_CLOSED_FIELDS')
}

/** JSON完整解析同时拒绝重复键；不能让JSON.parse的末值覆盖赋予资格。 */
export function nativeParseJson(bytes, limit = MAX_FILE) {
  nativeAssert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limit, 'NATIVE_PACKAGE_JSON_BUDGET')
  const text = bytes.toString('utf8')
  nativeAssert(Buffer.from(text, 'utf8').equals(bytes), 'NATIVE_PACKAGE_JSON_UTF8')
  let cursor = 0, values = 0
  const whitespace = () => { while (cursor < text.length && /[\x20\t\r\n]/u.test(text[cursor])) cursor++ }
  function string() {
    const begin = cursor++
    nativeAssert(text[begin] === '"')
    while (cursor < text.length) {
      const char = text[cursor++]
      if (char === '"') { try { return JSON.parse(text.slice(begin, cursor)) } catch { nativeFail('NATIVE_PACKAGE_JSON_INVALID') } }
      if (char === '\\') cursor++
    }
    nativeFail('NATIVE_PACKAGE_JSON_INVALID')
  }
  function value(depth) {
    nativeAssert(depth <= 64 && ++values <= 200_000, 'NATIVE_PACKAGE_JSON_BUDGET')
    whitespace()
    const char = text[cursor]
    if (char === '"') return string()
    if (char === '{') {
      cursor++; whitespace()
      const result = Object.create(null), keys = new Set()
      if (text[cursor] === '}') { cursor++; return result }
      while (cursor < text.length) {
        whitespace(); nativeAssert(text[cursor] === '"')
        const key = string(); nativeAssert(!keys.has(key), 'NATIVE_PACKAGE_JSON_DUPLICATE_KEY'); keys.add(key)
        whitespace(); nativeAssert(text[cursor++] === ':'); result[key] = value(depth + 1); whitespace()
        const next = text[cursor++]; if (next === '}') return result; nativeAssert(next === ',')
      }
    } else if (char === '[') {
      cursor++; whitespace(); const result = []
      if (text[cursor] === ']') { cursor++; return result }
      while (cursor < text.length) {
        result.push(value(depth + 1)); whitespace()
        const next = text[cursor++]; if (next === ']') return result; nativeAssert(next === ',')
      }
    } else {
      for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
        if (text.startsWith(token, cursor)) { cursor += token.length; return result }
      }
      const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(cursor))
      nativeAssert(number !== null); cursor += number[0].length
      const result = Number(number[0]); nativeAssert(Number.isFinite(result) && (!Number.isInteger(result) || Number.isSafeInteger(result)))
      return result
    }
    nativeFail('NATIVE_PACKAGE_JSON_INVALID')
  }
  const result = value(0); whitespace(); nativeAssert(cursor === text.length, 'NATIVE_PACKAGE_JSON_INVALID'); return result
}
export async function nativeDirectory(directory, context = nativeContext()) {
  checkTime(context)
  nativeAssert(typeof directory === 'string' && path.isAbsolute(directory) && path.resolve(directory) === directory)
  const info = await lstat(directory, { bigint: true })
  nativeAssert(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o7022n) === 0n
    && await realpath(directory) === directory, 'NATIVE_PACKAGE_DIRECTORY')
  checkTime(context); return directory
}
export async function nativeMissingRoot(directory, context = nativeContext()) {
  // 只有整件根目录缺失可成为null；存在的链接、空包和缺叶都必须拒绝。
  await nativeDirectory(path.dirname(directory), context)
  try { await lstat(directory); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
export async function nativeRead(file, limit = MAX_FILE, context = nativeContext()) {
  checkTime(context)
  nativeAssert(path.isAbsolute(file) && path.resolve(file) === file && Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_FILE)
  const named = await lstat(file, { bigint: true })
  nativeAssert(named.isFile() && !named.isSymbolicLink() && named.nlink === 1n && named.size > 0n
    && named.size <= BigInt(limit) && (named.mode & 0o7022n) === 0n && await realpath(file) === file,
  'NATIVE_PACKAGE_REGULAR_FILE')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    nativeAssert(STAT_FIELDS.every(key => named[key] === before[key]))
    context.bytes += Number(before.size); nativeAssert(context.bytes <= MAX_WHOLE, 'NATIVE_PACKAGE_WHOLE_BUDGET')
    const bytes = Buffer.alloc(Number(before.size)), deadline = Math.min(context.deadline, performance.now() + 10_000)
    for (let offset = 0; offset < bytes.length;) {
      nativeAssert(performance.now() < deadline, 'NATIVE_PACKAGE_READ_TIMEOUT')
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
      nativeAssert(bytesRead > 0); offset += bytesRead
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true })
    nativeAssert(STAT_FIELDS.every(key => before[key] === after[key] && before[key] === current[key])
      && await realpath(file) === file, 'NATIVE_PACKAGE_FILE_CHANGED')
    checkTime(context); return bytes
  } finally { await handle.close() }
}
async function tree(directory, expected, context) {
  const allowed = new Set(expected), allowedDirectories = new Set([''])
  for (const relative of expected) {
    nativeAssert(typeof relative === 'string' && relative.length < 180 && !relative.includes('\\')
      && relative.split('/').every(part => /^[a-zA-Z0-9_.-]+$/u.test(part) && part !== '.' && part !== '..'))
    let parent = path.posix.dirname(relative)
    while (parent !== '.') { allowedDirectories.add(parent); parent = path.posix.dirname(parent) }
  }
  const rows = [], found = []
  async function visit(relative) {
    const absolute = relative === '' ? directory : path.join(directory, relative)
    await nativeDirectory(absolute, context)
    const names = await readdir(absolute)
    nativeAssert(names.length <= 64, 'NATIVE_PACKAGE_EXTRA_ENTRY')
    for (const name of names.sort()) {
      checkTime(context)
      const rel = relative === '' ? name : `${relative}/${name}`, file = path.join(directory, rel)
      const info = await lstat(file, { bigint: true })
      nativeAssert(!info.isSymbolicLink() && await realpath(file) === file, 'NATIVE_PACKAGE_LINK')
      if (info.isDirectory()) { nativeAssert(allowedDirectories.has(rel), 'NATIVE_PACKAGE_EXTRA_ENTRY'); await visit(rel) }
      else {
        nativeAssert(allowed.has(rel) && info.isFile() && info.nlink === 1n && (info.mode & 0o7022n) === 0n,
          'NATIVE_PACKAGE_EXTRA_ENTRY')
        found.push(rel)
      }
      rows.push({ path: rel, identity: STAT_FIELDS.map(key => String(info[key])) })
    }
  }
  await visit('')
  nativeAssert(nativeSame(found.sort(), [...expected].sort()), 'NATIVE_PACKAGE_MISSING_ENTRY')
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}
export async function nativeTreeBefore(directory, expected, context) { return tree(directory, expected, context) }
export async function nativeTreeAfter(directory, expected, before, context) {
  nativeAssert(nativeSame(before, await tree(directory, expected, context)), 'NATIVE_PACKAGE_TREE_CHANGED')
}
export function nativeCheckPin(bytes, pin) {
  nativeAssert(bytes.length === pin.bytes && nativeDigest(bytes) === pin.sha256, 'NATIVE_PACKAGE_BYTES_MISMATCH')
}
function cstring(bytes, offset, end) {
  nativeAssert(offset >= 0 && offset < end && end <= bytes.length)
  const zero = bytes.indexOf(0, offset); nativeAssert(zero >= offset && zero < end)
  const value = bytes.subarray(offset, zero).toString('utf8')
  nativeAssert(Buffer.from(value).equals(bytes.subarray(offset, zero)) && !/[\x00-\x20\x7f]/u.test(value))
  return value
}
/** 真实thin arm64命令和ad-hoc CodeDirectory逐页散列，完全离线，不执行工具二进制。 */
export function nativeCheckMachO(bytes, relative, declaredDependencies, libraryNames) {
  nativeAssert(bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c
    && bytes.readUInt32LE(8) === 0 && bytes.readUInt32LE(12) === (relative.startsWith('bin/') ? 2 : 6), 'NATIVE_PACKAGE_MACHO')
  const count = bytes.readUInt32LE(16), size = bytes.readUInt32LE(20)
  nativeAssert(count > 0 && count <= 256 && size > 0 && size <= 64 * 1024 && 32 + size <= bytes.length)
  let cursor = 32, platform = 0, signature = null
  const dependencies = [], rpaths = []
  for (let index = 0; index < count; index++) {
    nativeAssert(cursor + 8 <= 32 + size)
    const cmd = bytes.readUInt32LE(cursor), length = bytes.readUInt32LE(cursor + 4)
    nativeAssert(length >= 8 && length % 8 === 0 && cursor + length <= 32 + size)
    if ([0xc, 0xd, 0x80000018, 0x8000001f, 0x80000023].includes(cmd)) {
      nativeAssert(cmd === 0xc || cmd === 0xd, 'NATIVE_PACKAGE_DYLIB_KIND')
      nativeAssert(length >= 24)
      const offset = bytes.readUInt32LE(cursor + 8); nativeAssert(offset >= 24)
      const name = cstring(bytes, cursor + offset, cursor + length)
      const system = ['/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib',
        '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
        '/System/Library/Frameworks/CoreVideo.framework/Versions/A/CoreVideo',
        '/System/Library/Frameworks/CoreMedia.framework/Versions/A/CoreMedia']
      nativeAssert(system.includes(name) || libraryNames.map(item => `@rpath/${item}`).includes(name), 'NATIVE_PACKAGE_DYLIB_PATH')
      if (cmd === 0xd) nativeAssert(relative.startsWith('lib/') && name === `@rpath/${path.posix.basename(relative)}`)
      dependencies.push(name)
    } else if (cmd === 0x8000001c) {
      nativeAssert(length >= 16)
      rpaths.push(cstring(bytes, cursor + bytes.readUInt32LE(cursor + 8), cursor + length))
    } else if (cmd === 0x32) {
      nativeAssert(length >= 24 && bytes.readUInt32LE(cursor + 8) === 1 && bytes.readUInt32LE(cursor + 12) === MINIMUM_MACOS)
      platform++
    } else if (cmd === 0x24 || cmd === 0x25 || cmd === 0x2f || cmd === 0x30) nativeFail('NATIVE_PACKAGE_PLATFORM_COMMAND')
    else if (cmd === 0x1d) {
      nativeAssert(length === 16 && signature === null)
      signature = { offset: bytes.readUInt32LE(cursor + 8), bytes: bytes.readUInt32LE(cursor + 12) }
    }
    cursor += length
  }
  nativeAssert(cursor === 32 + size && platform === 1 && nativeSame(dependencies, declaredDependencies)
    && new Set(dependencies).size === dependencies.length && new Set(rpaths).size === rpaths.length
    && rpaths.every(item => item === '@executable_path/../lib')
    && (relative.startsWith('bin/') ? rpaths.length === 1 : rpaths.length <= 1), 'NATIVE_PACKAGE_LOAD_COMMANDS')
  nativeAssert(signature !== null && signature.offset >= 32 + size && signature.bytes >= 20
    && signature.offset + signature.bytes === bytes.length, 'NATIVE_PACKAGE_CODE_SIGNATURE')
  const sig = bytes.subarray(signature.offset), magic = sig.readUInt32BE(0), length = sig.readUInt32BE(4), entries = sig.readUInt32BE(8)
  nativeAssert(magic === 0xfade0cc0 && length <= sig.length && length >= 12 + entries * 8 && entries > 0 && entries <= 16)
  let codeDirectories = 0
  for (let index = 0; index < entries; index++) {
    const type = sig.readUInt32BE(12 + index * 8), offset = sig.readUInt32BE(16 + index * 8)
    nativeAssert(offset >= 12 + entries * 8 && offset + 8 <= length)
    const slotLength = sig.readUInt32BE(offset + 4); nativeAssert(slotLength >= 8 && offset + slotLength <= length)
    if (type !== 0 && !(type >= 0x1000 && type <= 0x1005)) continue
    const cd = sig.subarray(offset, offset + slotLength)
    nativeAssert(cd.length >= 64 && cd.readUInt32BE(0) === 0xfade0c02 && (cd.readUInt32BE(12) & 2) === 2
      && cd[36] === 32 && cd[37] === 2 && cd[39] >= 12 && cd[39] <= 16, 'NATIVE_PACKAGE_ADHOC_SIGNATURE')
    const hashOffset = cd.readUInt32BE(16), slots = cd.readUInt32BE(28), codeLimit = cd.readUInt32BE(32), page = 2 ** cd[39]
    nativeAssert(codeLimit === signature.offset && slots === Math.ceil(codeLimit / page) && hashOffset >= 44
      && hashOffset + slots * 32 <= cd.length, 'NATIVE_PACKAGE_CODE_DIRECTORY')
    for (let slot = 0; slot < slots; slot++) {
      const actual = createHash('sha256').update(bytes.subarray(slot * page, Math.min((slot + 1) * page, codeLimit))).digest()
      nativeAssert(actual.equals(cd.subarray(hashOffset + slot * 32, hashOffset + (slot + 1) * 32)), 'NATIVE_PACKAGE_CODE_PAGE')
    }
    codeDirectories++
  }
  nativeAssert(codeDirectories > 0, 'NATIVE_PACKAGE_UNSIGNED')
}

export async function validateNativeCueDirectory({ directory, expectedManifestSha256 }, context = nativeContext()) {
  nativeAssert(typeof expectedManifestSha256 === 'string' && SHA64.test(expectedManifestSha256), 'NATIVE_PACKAGE_FIXED_PIN_REQUIRED')
  await nativeDirectory(directory, context)
  const raw = await nativeRead(path.join(directory, 'manifest.json'), 64 * 1024, context)
  nativeAssert(nativeDigest(raw) === expectedManifestSha256, 'NATIVE_PACKAGE_MANIFEST_PIN')
  const manifest = nativeParseJson(raw, 64 * 1024)
  nativeKeys(manifest, ['schemaVersion', 'purpose', 'platform', 'arch', 'minimumMacOS', 'sources', 'configure', 'configureSha256',
    'externalRecipes', 'components', 'files', 'protocols', 'actualEncodeDecodeEofQualification', 'releaseReady'])
  nativeAssert(manifest.schemaVersion === 1 && manifest.purpose === CUE_NATIVE_PURPOSE && manifest.platform === 'darwin'
    && manifest.arch === 'arm64' && manifest.minimumMacOS === '13.0' && manifest.releaseReady === false
    && manifest.actualEncodeDecodeEofQualification === null && nativeSame(manifest.sources, SOURCES)
    && nativeSame(manifest.configure, CONFIGURE) && nativeSame(manifest.components, COMPONENTS)
    && manifest.configureSha256 === nativeDigest(Buffer.from(JSON.stringify(CONFIGURE)))
    && nativeSame(manifest.protocols, ['fd']), 'NATIVE_PACKAGE_CUE_RECIPE')
  nativeKeys(manifest.externalRecipes, Object.keys(RECIPES))
  const recipes = { ...manifest.externalRecipes }
  nativeAssert(Array.isArray(recipes.vorbis) && recipes.vorbis.length === 5 && typeof recipes.vorbis[4] === 'string'
    && recipes.vorbis[4].startsWith('--with-ogg=') && path.isAbsolute(recipes.vorbis[4].slice(11))
    && path.resolve(recipes.vorbis[4].slice(11)) === recipes.vorbis[4].slice(11)
    && recipes.vorbis[4].endsWith('/dependencies') && !/[\x00-\x1f]/u.test(recipes.vorbis[4]))
  recipes.vorbis = [...recipes.vorbis.slice(0, 4), '--with-ogg=<fixed-build-dependencies>']
  nativeAssert(nativeSame(recipes, RECIPES), 'NATIVE_PACKAGE_EXTERNAL_RECIPE')
  const nativeNames = ['bin/ffmpeg', 'bin/ffprobe', ...COMPONENTS.map(item => `lib/${item.id}`)]
  nativeAssert(Array.isArray(manifest.files) && manifest.files.length === nativeNames.length
    && nativeSame(manifest.files.map(item => item.relative), nativeNames), 'NATIVE_PACKAGE_FILE_SET')
  const expected = ['manifest.json', ...nativeNames, ...LEGAL.map(item => item.relative)]
  const before = await nativeTreeBefore(directory, expected, context), filePins = []
  for (const pin of manifest.files) {
    nativeKeys(pin, ['relative', 'bytes', 'sha256', 'dependencies'])
    nativeAssert(Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes <= MAX_FILE && SHA64.test(pin.sha256)
      && Array.isArray(pin.dependencies))
    const file = path.join(directory, pin.relative), info = await lstat(file)
    nativeAssert((info.mode & 0o111) !== 0, 'NATIVE_PACKAGE_NOT_EXECUTABLE')
    const bytes = await nativeRead(file, MAX_FILE, context); nativeCheckPin(bytes, pin)
    nativeCheckMachO(bytes, pin.relative, pin.dependencies, COMPONENTS.map(item => item.id))
    filePins.push({ relative: pin.relative, bytes: bytes.length, sha256: nativeDigest(bytes) })
  }
  for (const pin of LEGAL) { nativeCheckPin(await nativeRead(path.join(directory, pin.relative), MAX_FILE, context), pin); filePins.push({ ...pin }) }
  nativeAssert((await nativeRead(path.join(directory, 'manifest.json'), 64 * 1024, context)).equals(raw), 'NATIVE_PACKAGE_MANIFEST_CHANGED')
  await nativeTreeAfter(directory, expected, before, context)
  return { directory, manifestSha256: expectedManifestSha256, files: filePins, outputProfiles: [...CUE_OUTPUT_PROFILES],
    packagingBytesVerified: true, actualEncodeDecodeEofQualifiedByThisCheck: false }
}

export function nativeBuildMetadata(purpose, manifestSha256) {
  nativeAssert(manifestSha256 === null || (typeof manifestSha256 === 'string' && SHA64.test(manifestSha256)))
  return { schemaVersion: 1, purpose, platform: 'darwin', arch: 'arm64', manifestSha256 }
}
export function nativeReadBuildMetadata(raw, purpose, required = false) {
  const metadata = nativeParseJson(raw, 1024)
  nativeKeys(metadata, ['schemaVersion', 'purpose', 'platform', 'arch', 'manifestSha256'])
  nativeAssert(metadata.schemaVersion === 1 && metadata.purpose === purpose && metadata.platform === 'darwin' && metadata.arch === 'arm64'
    && (metadata.manifestSha256 === null || (typeof metadata.manifestSha256 === 'string' && SHA64.test(metadata.manifestSha256)))
    && raw.equals(Buffer.from(JSON.stringify(nativeBuildMetadata(purpose, metadata.manifestSha256)) + '\n')), 'NATIVE_PACKAGE_BUILD_METADATA')
  nativeAssert(!required || metadata.manifestSha256 !== null, 'NATIVE_PACKAGE_BUILD_UNAVAILABLE')
  return metadata
}
async function ensureDirectories(root, relative, context) {
  await nativeDirectory(root, context)
  for (const part of relative.split('/')) {
    root = path.join(root, part)
    try { await mkdir(root, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    await nativeDirectory(root, context)
  }
  return root
}
async function atomicArtifact(file, bytes, context) {
  await nativeDirectory(path.dirname(file), context)
  let previous = null
  try { previous = await lstat(file, { bigint: true }); await nativeRead(file, 1024, context) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${file}.${randomBytes(12).toString('hex')}.new`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let renamed = false
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close()
    if (previous !== null) { const current = await lstat(file, { bigint: true }); nativeAssert(STAT_FIELDS.every(key => previous[key] === current[key])) }
    else { try { await lstat(file); nativeFail('NATIVE_PACKAGE_ARTIFACT_RACE') } catch (error) { if (error.code !== 'ENOENT') throw error } }
    checkTime(context); await rename(temporary, file); renamed = true
    nativeAssert((await nativeRead(file, 1024, context)).equals(bytes), 'NATIVE_PACKAGE_ARTIFACT_CHANGED')
  } finally { try { await handle.close() } catch {} if (!renamed) await unlink(temporary).catch(() => {}) }
}
/** 捕获发生在vite之前；seal只核已捕获pin，禁止由新的旁边manifest重新赋权。 */
export async function nativeCaptureBuild(appDirectory, { root, purpose, fileName, validate }) {
  const context = nativeContext(); await nativeDirectory(appDirectory, context)
  const directory = path.join(appDirectory, root)
  let metadata
  // 上层native目录也不存在时只允许完全缺失，不吞掉其它I/O错误。
  let absent = false
  try { await lstat(directory) } catch (error) { if (error.code === 'ENOENT') absent = true; else throw error }
  if (absent) {
    let ancestor = path.dirname(directory)
    for (;;) { try { await nativeDirectory(ancestor, context); break } catch (error) { if (error.code !== 'ENOENT' || ancestor === appDirectory) throw error; ancestor = path.dirname(ancestor) } }
    metadata = nativeBuildMetadata(purpose, null)
  } else {
    const pin = nativeDigest(await nativeRead(path.join(directory, 'manifest.json'), 64 * 1024, context))
    await validate({ directory, expectedManifestSha256: pin }, context); metadata = nativeBuildMetadata(purpose, pin)
  }
  const cache = await ensureDirectories(appDirectory, 'node_modules/.cache/musicbridge-native-build', context)
  await atomicArtifact(path.join(cache, fileName), Buffer.from(JSON.stringify(metadata) + '\n'), context)
  return metadata
}
export async function nativeSealBuild(appDirectory, options) {
  const context = nativeContext(); await nativeDirectory(appDirectory, context)
  const capturedFile = path.join(appDirectory, 'node_modules/.cache/musicbridge-native-build', options.fileName)
  const raw = await nativeRead(capturedFile, 1024, context), metadata = nativeReadBuildMetadata(raw, options.purpose)
  const index = path.join(appDirectory, 'dist/main/index.js')
  const indexInfo = await lstat(index, { bigint: true }), captureInfo = await lstat(capturedFile, { bigint: true })
  nativeAssert(indexInfo.isFile() && !indexInfo.isSymbolicLink() && indexInfo.nlink === 1n && indexInfo.size > 0n
    && (indexInfo.mode & 0o7022n) === 0n && await realpath(index) === index
    && indexInfo.mtimeNs >= captureInfo.mtimeNs, 'NATIVE_PACKAGE_BUILD_NOT_FRESH')
  const directory = path.join(appDirectory, options.root)
  if (metadata.manifestSha256 !== null) await options.validate({ directory, expectedManifestSha256: metadata.manifestSha256 }, context)
  else {
    try { await lstat(directory); nativeFail('NATIVE_PACKAGE_NULL_BUILD_CHANGED') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  nativeAssert((await nativeRead(capturedFile, 1024, context)).equals(raw), 'NATIVE_PACKAGE_CAPTURE_CHANGED')
  await nativeDirectory(path.dirname(index), context)
  await atomicArtifact(path.join(appDirectory, 'dist/main', options.fileName), raw, context)
  return metadata
}
export async function captureNativeCue(appDirectory) {
  return nativeCaptureBuild(appDirectory, { root: CUE_NATIVE_BUILD_ROOT, purpose: CUE_NATIVE_PURPOSE, fileName: CUE_NATIVE_BUILD_FILE, validate: validateNativeCueDirectory })
}
export async function sealNativeCueBuild(appDirectory) {
  return nativeSealBuild(appDirectory, { root: CUE_NATIVE_BUILD_ROOT, purpose: CUE_NATIVE_PURPOSE, fileName: CUE_NATIVE_BUILD_FILE, validate: validateNativeCueDirectory })
}
export async function verifyNativeCuePackage(appDirectory) {
  const context = nativeContext(); await nativeDirectory(appDirectory, context)
  const metadata = nativeReadBuildMetadata(await nativeRead(path.join(appDirectory, 'dist/main', CUE_NATIVE_BUILD_FILE), 1024, context), CUE_NATIVE_PURPOSE, true)
  return validateNativeCueDirectory({ directory: path.join(appDirectory, CUE_NATIVE_BUILD_ROOT), expectedManifestSha256: metadata.manifestSha256 }, context)
}

/** asar只读取有界header和两条固定metadata，整件FD前后不变；不借.asar.unpacked或链接。 */
export async function readNativeAsarBuilds(archive, context = nativeContext()) {
  checkTime(context)
  const named = await lstat(archive, { bigint: true })
  nativeAssert(named.isFile() && !named.isSymbolicLink() && named.nlink === 1n && named.size >= 16n
    && named.size <= 2n * 1024n * 1024n * 1024n && (named.mode & 0o7022n) === 0n && await realpath(archive) === archive)
  const handle = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true }); nativeAssert(STAT_FIELDS.every(key => before[key] === named[key]))
    async function read(offset, length) {
      nativeAssert(length > 0 && length <= MAX_FILE && offset >= 0 && offset + length <= Number(before.size))
      context.bytes += length; nativeAssert(context.bytes <= MAX_WHOLE)
      const bytes = Buffer.alloc(length)
      for (let readOffset = 0; readOffset < length;) {
        checkTime(context); const result = await handle.read(bytes, readOffset, Math.min(64 * 1024, length - readOffset), offset + readOffset)
        nativeAssert(result.bytesRead > 0); readOffset += result.bytesRead
      }
      return bytes
    }
    const prefix = await read(0, 8); nativeAssert(prefix.readUInt32LE(0) === 4)
    const length = prefix.readUInt32LE(4); nativeAssert(length >= 12 && length <= MAX_FILE && length % 4 === 0)
    const header = await read(8, length), textLength = header.readUInt32LE(4)
    nativeAssert(header.readUInt32LE(0) === length - 4 && textLength > 0 && textLength <= length - 8
      && length - 8 - textLength < 4 && header.subarray(8 + textLength).every(byte => byte === 0))
    const parsed = nativeParseJson(header.subarray(8, 8 + textLength)), offsets = [], result = Object.create(null)
    for (const fileName of [CUE_NATIVE_BUILD_FILE, 'local-audio-tags-build.json']) {
      let node = parsed
      for (const part of ['dist', 'main', fileName]) {
        nativeAssert(node !== null && typeof node === 'object' && node.files !== null && typeof node.files === 'object'
          && !node.link && !node.unpacked && Object.hasOwn(node.files, part), 'NATIVE_PACKAGE_ASAR_PATH')
        node = node.files[part]
      }
      nativeKeys(node, node.integrity === undefined ? ['size', 'offset'] : ['size', 'offset', 'integrity'])
      nativeAssert(Number.isSafeInteger(node.size) && node.size > 0 && node.size <= 1024
        && typeof node.offset === 'string' && /^(0|[1-9][0-9]{0,10})$/u.test(node.offset), 'NATIVE_PACKAGE_ASAR_ENTRY')
      const offset = 8 + length + Number(node.offset)
      nativeAssert(offsets.every(item => offset + node.size <= item.begin || offset >= item.end), 'NATIVE_PACKAGE_ASAR_OVERLAP')
      offsets.push({ begin: offset, end: offset + node.size })
      const raw = await read(offset, node.size)
      if (node.integrity !== undefined) {
        nativeKeys(node.integrity, ['algorithm', 'hash', 'blockSize', 'blocks'])
        nativeAssert(node.integrity.algorithm === 'SHA256' && node.integrity.hash === nativeDigest(raw)
          && node.integrity.blockSize === 4 * 1024 * 1024 && nativeSame(node.integrity.blocks, [nativeDigest(raw)]), 'NATIVE_PACKAGE_ASAR_INTEGRITY')
      }
      result[fileName] = { raw, metadata: nativeReadBuildMetadata(raw, fileName === CUE_NATIVE_BUILD_FILE ? CUE_NATIVE_PURPOSE : 'owner-protected-audio-copy-tags', true) }
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(archive, { bigint: true })
    nativeAssert(STAT_FIELDS.every(key => before[key] === after[key] && before[key] === current[key]) && await realpath(archive) === archive,
      'NATIVE_PACKAGE_ASAR_CHANGED')
    checkTime(context); return result
  } finally { await handle.close() }
}
export default async function beforePack(context) {
  nativeAssert(process.platform === 'darwin' && process.arch === 'arm64' && context.electronPlatformName === 'darwin' && context.arch === 3, 'NATIVE_PACKAGE_TARGET')
  // 原Rust→converter→mobile/output链先完整执行，新两包均不得以null取得正式打包资格。
  await rustBeforePack(context)
  const directory = await realpath(context.packager.info.appDir)
  await verifyNativeCuePackage(directory)
  const { verifyNativeLocalAudioTagsPackage } = await import('./native-local-audio-tags-package.mjs')
  await verifyNativeLocalAudioTagsPackage(directory)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  try {
    nativeAssert(process.argv.length === 3 && ['--capture-build', '--seal-build'].includes(process.argv[2]), 'NATIVE_PACKAGE_ARGUMENTS')
    const metadata = await (process.argv[2] === '--capture-build' ? captureNativeCue(directory) : sealNativeCueBuild(directory))
    console.log(JSON.stringify({ status: metadata.manifestSha256 === null ? 'NATIVE_UNAVAILABLE' : 'FIXED_BUILD_IDENTITY_CAPTURED', metadata }))
  } catch (error) { console.error(error.code?.startsWith('NATIVE_PACKAGE_') ? error.code : 'NATIVE_PACKAGE_FAILED'); process.exitCode = 1 }
}
