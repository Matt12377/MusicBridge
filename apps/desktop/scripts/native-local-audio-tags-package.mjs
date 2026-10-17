import { lstat, realpath, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 原build先完成bridge-core编译；打包与Owner共用同一纯watch字节规则，不能放宽CUE的Mach-O闭集。
import { validateLibraryWatchArtifactBytes, LIBRARY_WATCH_FILES } from '../../../packages/bridge-core/dist/library/fsevents-library-monitor.js'
import {
  nativeAssert, nativeContext, nativeDigest, nativeDirectory, nativeKeys, nativeRead, nativeParseJson, nativeSame,
  nativeCheckPin, nativeCheckMachO, nativeTreeBefore, nativeTreeAfter, nativeReadBuildMetadata,
  nativeCaptureBuild, nativeSealBuild, readNativeAsarBuilds, validateNativeCueDirectory, CUE_NATIVE_BUILD_FILE,
  CUE_NATIVE_RESOURCE_ROOT,
} from './native-cue-package.mjs'

export const LOCAL_AUDIO_TAGS_BUILD_ROOT = 'native/local-audio-tags/darwin-arm64'
export const LOCAL_AUDIO_TAGS_RESOURCE_ROOT = 'local-audio-tags/darwin-arm64'
export const LOCAL_AUDIO_TAGS_BUILD_FILE = 'local-audio-tags-build.json'
export const LOCAL_AUDIO_TAGS_PURPOSE = 'owner-protected-audio-copy-tags'
const SOURCE = {
  "id": "taglib",
  "version": "2.3.2",
  "archive": "taglib-2.3.2.tar.gz",
  "directory": "taglib-2.3.2",
  "url": "https://taglib.org/releases/taglib-2.3.2.tar.gz",
  "bytes": 1799985,
  "sha256": "3ca2d8afaa7f1cf7f6ed10e511ebc368bfacd6dcaa3dbfa690b89e502e8963dc",
  "authenticity": "official-https-and-fixed-first-observed-sha256",
  "independentSignature": null
}
const HELPER_SOURCE = {
  "bytes": 9625,
  "sha256": "6d29979f9f12109d70abe244f403ded7b9e596e02813f84f3c277812b3a5195e"
}
const CONFIGURE = [
  "-G",
  "Unix Makefiles",
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0",
  "-DCMAKE_OSX_ARCHITECTURES=arm64",
  "-DCMAKE_C_COMPILER=/usr/bin/clang",
  "-DCMAKE_CXX_COMPILER=/usr/bin/clang++",
  "-DCMAKE_MAKE_PROGRAM=/usr/bin/make",
  "-DCMAKE_CXX_FLAGS=-fmodules-cache-path=<fixed-build-modules>",
  "-DBUILD_SHARED_LIBS=ON",
  "-DBUILD_BINDINGS=OFF",
  "-DBUILD_EXAMPLES=OFF",
  "-DBUILD_TESTING=OFF",
  "-DWITH_APE=ON",
  "-DWITH_MP4=ON",
  "-DWITH_RIFF=ON",
  "-DWITH_VORBIS=ON",
  "-DWITH_ZLIB=OFF",
  "-DWITH_ASF=OFF",
  "-DWITH_DSF=OFF",
  "-DWITH_MATROSKA=OFF",
  "-DWITH_MOD=OFF",
  "-DWITH_SHORTEN=OFF",
  "-DWITH_TRUEAUDIO=OFF",
  "-DCMAKE_FIND_USE_SYSTEM_ENVIRONMENT_PATH=OFF",
  "-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF",
  "-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF",
  "-DCMAKE_FIND_FRAMEWORK=NEVER",
  "-DCMAKE_FIND_APPBUNDLE=NEVER"
]
const LEGAL = [
  {
    "relative": "legal/COPYING.LGPL",
    "bytes": 26530,
    "sha256": "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551"
  },
  {
    "relative": "legal/COPYING.MPL",
    "bytes": 25755,
    "sha256": "53692a2ed6c6a2c6ec9b32dd0b820dfae91e0a1fcdf625ca9ed0bdf8705fcc4f"
  },
  {
    "relative": "legal/AUTHORS",
    "bytes": 889,
    "sha256": "047780f6bded3712fc24edc77b9187bfa49ea3826ed090933cb6342458eace85"
  },
  {
    "relative": "legal/3rdparty-utfcpp-LICENSE",
    "bytes": 1338,
    "sha256": "c9bff75738922193e67fa726fa225535870d2aa1059f91452c411736284ad566"
  },
  {
    "relative": "legal/taglib-2.3.2.tar.gz",
    "bytes": 1799985,
    "sha256": "3ca2d8afaa7f1cf7f6ed10e511ebc368bfacd6dcaa3dbfa690b89e502e8963dc"
  }
]
const FORMATS = ['flac', 'alac', 'mp3', 'vorbis', 'opus', 'wavpack', 'pcm-wav', 'pcm-aiff']
const HELPER_RESOURCE = 'legal/mb-audio-tags-helper.cpp'
const LIMIT = 16 * 1024 * 1024
export const LIBRARY_WATCH_BUILD_ROOT = 'native/library-watch/darwin-arm64'
export const LIBRARY_WATCH_RESOURCE_ROOT = 'library-watch/darwin-arm64'
export const LIBRARY_WATCH_BUILD_FILE = 'library-watch-build.json'
export const LIBRARY_WATCH_PURPOSE = 'owner-fsevents-library-invalidation'

export async function validateNativeLibraryWatchDirectory({ directory, expectedManifestSha256 }, context = nativeContext()) {
  nativeAssert(typeof expectedManifestSha256 === 'string' && /^[a-f0-9]{64}$/u.test(expectedManifestSha256), 'NATIVE_PACKAGE_FIXED_PIN_REQUIRED')
  await nativeDirectory(directory, context)
  const before = await nativeTreeBefore(directory, LIBRARY_WATCH_FILES, context)
  const manifest = await nativeRead(path.join(directory, 'manifest.json'), 65536, context)
  nativeAssert(nativeDigest(manifest) === expectedManifestSha256, 'NATIVE_PACKAGE_MANIFEST_PIN')
  const program = await nativeRead(path.join(directory, 'mb-library-watch'), 1024 * 1024, context)
  const source = await nativeRead(path.join(directory, 'legal/fsevents-helper.cpp'), 65536, context)
  nativeAssert(((await lstat(path.join(directory, 'mb-library-watch'))).mode & 0o111) !== 0, 'NATIVE_PACKAGE_NOT_EXECUTABLE')
  const result = validateLibraryWatchArtifactBytes(manifest, program, source)
  nativeAssert((await nativeRead(path.join(directory, 'manifest.json'), 65536, context)).equals(manifest), 'NATIVE_PACKAGE_MANIFEST_CHANGED')
  await nativeTreeAfter(directory, LIBRARY_WATCH_FILES, before, context)
  return { directory, ...result, files: LIBRARY_WATCH_FILES.map((relative, index) => {
    const raw = [manifest, program, source][index]; return { relative, bytes: raw.length, sha256: nativeDigest(raw) }
  }), actualMonitorQualifiedByThisCheck: false }
}
function watchOptions() {
  return { root: LIBRARY_WATCH_BUILD_ROOT, purpose: LIBRARY_WATCH_PURPOSE, fileName: LIBRARY_WATCH_BUILD_FILE,
    validate: validateNativeLibraryWatchDirectory }
}
export async function captureNativeLibraryWatch(appDirectory) { return nativeCaptureBuild(appDirectory, watchOptions()) }
export async function sealNativeLibraryWatchBuild(appDirectory) { return nativeSealBuild(appDirectory, watchOptions()) }
export async function verifyNativeLibraryWatchPackage(appDirectory, context = nativeContext()) {
  await nativeDirectory(appDirectory, context)
  const metadata = nativeReadBuildMetadata(await nativeRead(path.join(appDirectory, 'dist/main', LIBRARY_WATCH_BUILD_FILE), 1024, context), LIBRARY_WATCH_PURPOSE, true)
  return validateNativeLibraryWatchDirectory({ directory: path.join(appDirectory, LIBRARY_WATCH_BUILD_ROOT),
    expectedManifestSha256: metadata.manifestSha256 }, context)
}
/** 只追加第三个有界metadata；原cue/tags读取与原包验证保持独立。 */
export async function readNativeLibraryWatchAsarBuild(archive, context = nativeContext()) {
  const fields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink'], named = await lstat(archive, { bigint: true })
  nativeAssert(named.isFile() && !named.isSymbolicLink() && named.nlink === 1n && (named.mode & 0o7022n) === 0n
    && named.size >= 16n && named.size <= 2n * 1024n * 1024n * 1024n && await realpath(archive) === archive, 'NATIVE_PACKAGE_ASAR_PATH')
  const fd = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await fd.stat({ bigint: true }); nativeAssert(fields.every(key => before[key] === named[key]))
    async function read(position, length) {
      nativeAssert(performance.now() < context.deadline && Number.isSafeInteger(position) && Number.isSafeInteger(length)
        && position >= 0 && length > 0 && length <= LIMIT && position + length <= Number(before.size), 'NATIVE_PACKAGE_ASAR_ENTRY')
      context.bytes += length; nativeAssert(context.bytes <= 64 * 1024 * 1024, 'NATIVE_PACKAGE_WHOLE_BUDGET')
      const bytes = Buffer.alloc(length), deadline = Math.min(context.deadline, performance.now() + 10000)
      for (let at = 0; at < length;) {
        nativeAssert(performance.now() < deadline, 'NATIVE_PACKAGE_READ_TIMEOUT')
        const part = await fd.read(bytes, at, Math.min(65536, length - at), position + at); nativeAssert(part.bytesRead > 0); at += part.bytesRead
      }
      return bytes
    }
    const prefix = await read(0, 8); nativeAssert(prefix.readUInt32LE(0) === 4)
    const length = prefix.readUInt32LE(4); nativeAssert(length >= 12 && length <= LIMIT && length % 4 === 0)
    const header = await read(8, length), textLength = header.readUInt32LE(4)
    nativeAssert(header.readUInt32LE(0) === length - 4 && textLength > 0 && textLength <= length - 8
      && length - 8 - textLength < 4 && header.subarray(8 + textLength).every(byte => byte === 0))
    const parsed = nativeParseJson(header.subarray(8, 8 + textLength)), spans = []; let result
    for (const [file, purpose] of [[CUE_NATIVE_BUILD_FILE, 'cue-independent-eight-format-output'],
      [LOCAL_AUDIO_TAGS_BUILD_FILE, LOCAL_AUDIO_TAGS_PURPOSE], [LIBRARY_WATCH_BUILD_FILE, LIBRARY_WATCH_PURPOSE]]) {
      let node = parsed
      for (const part of ['dist', 'main', file]) {
        nativeAssert(node && typeof node === 'object' && node.files && typeof node.files === 'object'
          && !node.link && !node.unpacked && Object.hasOwn(node.files, part), 'NATIVE_PACKAGE_ASAR_PATH'); node = node.files[part]
      }
      nativeKeys(node, node.integrity === undefined ? ['size', 'offset'] : ['size', 'offset', 'integrity'])
      nativeAssert(Number.isSafeInteger(node.size) && node.size > 0 && node.size <= 1024 && typeof node.offset === 'string'
        && /^(0|[1-9][0-9]{0,10})$/u.test(node.offset), 'NATIVE_PACKAGE_ASAR_ENTRY')
      const begin = 8 + length + Number(node.offset), end = begin + node.size
      nativeAssert(spans.every(span => end <= span.begin || begin >= span.end), 'NATIVE_PACKAGE_ASAR_OVERLAP'); spans.push({ begin, end })
      const raw = await read(begin, node.size), metadata = nativeReadBuildMetadata(raw, purpose, true)
      if (node.integrity !== undefined) {
        nativeKeys(node.integrity, ['algorithm', 'hash', 'blockSize', 'blocks'])
        nativeAssert(node.integrity.algorithm === 'SHA256' && node.integrity.hash === nativeDigest(raw)
          && node.integrity.blockSize === 4 * 1024 * 1024 && nativeSame(node.integrity.blocks, [nativeDigest(raw)]), 'NATIVE_PACKAGE_ASAR_INTEGRITY')
      }
      if (file === LIBRARY_WATCH_BUILD_FILE) result = { raw, metadata }
    }
    const after = await fd.stat({ bigint: true }), current = await lstat(archive, { bigint: true })
    nativeAssert(fields.every(key => before[key] === after[key] && before[key] === current[key]) && await realpath(archive) === archive
      && performance.now() < context.deadline && result, 'NATIVE_PACKAGE_ASAR_CHANGED'); return result
  } finally { await fd.close() }
}

export async function validateNativeLocalAudioTagsDirectory({ directory, expectedManifestSha256, helperSourceFile, packaged = false }, context = nativeContext()) {
  nativeAssert(typeof expectedManifestSha256 === 'string' && /^[a-f0-9]{64}$/u.test(expectedManifestSha256), 'NATIVE_PACKAGE_FIXED_PIN_REQUIRED')
  await nativeDirectory(directory, context)
  const raw = await nativeRead(path.join(directory, 'manifest.json'), 64 * 1024, context)
  nativeAssert(nativeDigest(raw) === expectedManifestSha256, 'NATIVE_PACKAGE_MANIFEST_PIN')
  const manifest = nativeParseJson(raw, 64 * 1024)
  nativeKeys(manifest, ['schemaVersion', 'purpose', 'platform', 'arch', 'minimumMacOS', 'source', 'helperSource', 'configure',
    'configureSha256', 'formats', 'files', 'legal', 'actualProtectedCopyQualification', 'releaseReady'])
  nativeAssert(manifest.schemaVersion === 1 && manifest.purpose === LOCAL_AUDIO_TAGS_PURPOSE && manifest.platform === 'darwin'
    && manifest.arch === 'arm64' && manifest.minimumMacOS === '13.0' && manifest.actualProtectedCopyQualification === null
    && manifest.releaseReady === false && nativeSame(manifest.source, SOURCE) && nativeSame(manifest.helperSource, HELPER_SOURCE)
    && nativeSame(manifest.formats, FORMATS) && nativeSame(manifest.legal, LEGAL.filter(item => item.relative !== `legal/${SOURCE.archive}`)),
  'NATIVE_PACKAGE_TAGS_RECIPE')
  nativeAssert(Array.isArray(manifest.configure) && manifest.configure.length === CONFIGURE.length && typeof manifest.configure[8] === 'string'
    && manifest.configure[8].startsWith('-DCMAKE_CXX_FLAGS=-fmodules-cache-path='))
  const modules = manifest.configure[8].slice('-DCMAKE_CXX_FLAGS=-fmodules-cache-path='.length)
  nativeAssert(path.isAbsolute(modules) && path.resolve(modules) === modules && modules.endsWith('/modules') && !/[\x00-\x1f]/u.test(modules))
  const configure = [...manifest.configure]; configure[8] = '-DCMAKE_CXX_FLAGS=-fmodules-cache-path=<fixed-build-modules>'
  nativeAssert(nativeSame(configure, CONFIGURE) && manifest.configureSha256 === nativeDigest(Buffer.from(JSON.stringify(manifest.configure))),
    'NATIVE_PACKAGE_TAGS_CONFIGURE')
  const names = ['bin/mb-audio-tags', 'lib/libtag.2.dylib']
  nativeAssert(Array.isArray(manifest.files) && manifest.files.length === 2 && nativeSame(manifest.files.map(item => item.relative), names),
    'NATIVE_PACKAGE_FILE_SET')
  const expected = ['manifest.json', ...names, ...LEGAL.map(item => item.relative), ...(packaged ? [HELPER_RESOURCE] : [])]
  const before = await nativeTreeBefore(directory, expected, context), filePins = []
  for (const pin of manifest.files) {
    nativeKeys(pin, ['relative', 'bytes', 'sha256', 'dependencies'])
    nativeAssert(Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes <= LIMIT && /^[a-f0-9]{64}$/u.test(pin.sha256)
      && nativeSame(pin.dependencies, ['@rpath/libtag.2.dylib', '/usr/lib/libc++.1.dylib', '/usr/lib/libSystem.B.dylib']))
    const file = path.join(directory, pin.relative)
    nativeAssert(((await lstat(file)).mode & 0o111) !== 0, 'NATIVE_PACKAGE_NOT_EXECUTABLE')
    const bytes = await nativeRead(file, LIMIT, context); nativeCheckPin(bytes, pin)
    nativeCheckMachO(bytes, pin.relative, pin.dependencies, ['libtag.2.dylib'])
    filePins.push({ relative: pin.relative, bytes: bytes.length, sha256: nativeDigest(bytes) })
  }
  for (const pin of LEGAL) { nativeCheckPin(await nativeRead(path.join(directory, pin.relative), LIMIT, context), pin); filePins.push({ ...pin }) }
  const helper = packaged ? path.join(directory, HELPER_RESOURCE) : helperSourceFile
  nativeAssert(typeof helper === 'string' && path.isAbsolute(helper), 'NATIVE_PACKAGE_HELPER_SOURCE_REQUIRED')
  nativeCheckPin(await nativeRead(helper, 64 * 1024, context), HELPER_SOURCE)
  nativeAssert((await nativeRead(path.join(directory, 'manifest.json'), 64 * 1024, context)).equals(raw), 'NATIVE_PACKAGE_MANIFEST_CHANGED')
  await nativeTreeAfter(directory, expected, before, context)
  return { directory, manifestSha256: expectedManifestSha256, files: filePins,
    helperSource: { ...HELPER_SOURCE, relative: packaged ? HELPER_RESOURCE : 'native/local-audio-tags/taglib-helper.cpp' },
    packagingBytesVerified: true, actualProtectedCopyQualifiedByThisCheck: false }
}
function options(appDirectory) {
  return { root: LOCAL_AUDIO_TAGS_BUILD_ROOT, purpose: LOCAL_AUDIO_TAGS_PURPOSE, fileName: LOCAL_AUDIO_TAGS_BUILD_FILE,
    validate: (input, context) => validateNativeLocalAudioTagsDirectory({ ...input,
      helperSourceFile: path.resolve(appDirectory, '../../native/local-audio-tags/taglib-helper.cpp') }, context) }
}
export async function captureNativeLocalAudioTags(appDirectory) { return nativeCaptureBuild(appDirectory, options(appDirectory)) }
export async function sealNativeLocalAudioTagsBuild(appDirectory) { return nativeSealBuild(appDirectory, options(appDirectory)) }
export async function verifyNativeLocalAudioTagsPackage(appDirectory) {
  const context = nativeContext(); await nativeDirectory(appDirectory, context)
  const metadata = nativeReadBuildMetadata(await nativeRead(path.join(appDirectory, 'dist/main', LOCAL_AUDIO_TAGS_BUILD_FILE), 1024, context), LOCAL_AUDIO_TAGS_PURPOSE, true)
  const tags = await validateNativeLocalAudioTagsDirectory({ directory: path.join(appDirectory, LOCAL_AUDIO_TAGS_BUILD_ROOT),
    expectedManifestSha256: metadata.manifestSha256,
    helperSourceFile: path.resolve(appDirectory, '../../native/local-audio-tags/taglib-helper.cpp') }, context)
  // 原beforePack链通过此有限入口追加第三包；缺监听包不能取得正式pack资格。
  const watch = await verifyNativeLibraryWatchPackage(appDirectory, context); return { ...tags, watch }
}
export async function verifyPackagedNativeResources({ resourcesDirectory, appDirectory }) {
  const context = nativeContext(); await nativeDirectory(resourcesDirectory, context); await nativeDirectory(appDirectory, context)
  const builds = await readNativeAsarBuilds(path.join(resourcesDirectory, 'app.asar'), context)
  for (const file of [CUE_NATIVE_BUILD_FILE, LOCAL_AUDIO_TAGS_BUILD_FILE]) {
    const expected = await nativeRead(path.join(appDirectory, 'dist/main', file), 1024, context)
    nativeAssert(expected.equals(builds[file].raw), 'NATIVE_PACKAGE_ASAR_BUILD_MISMATCH')
  }
  const cue = await validateNativeCueDirectory({ directory: path.join(resourcesDirectory, CUE_NATIVE_RESOURCE_ROOT),
    expectedManifestSha256: builds[CUE_NATIVE_BUILD_FILE].metadata.manifestSha256 }, context)
  const tags = await validateNativeLocalAudioTagsDirectory({ directory: path.join(resourcesDirectory, LOCAL_AUDIO_TAGS_RESOURCE_ROOT),
    expectedManifestSha256: builds[LOCAL_AUDIO_TAGS_BUILD_FILE].metadata.manifestSha256, packaged: true }, context)
  const watchBuild = await readNativeLibraryWatchAsarBuild(path.join(resourcesDirectory, 'app.asar'), context)
  nativeAssert(watchBuild.raw.equals(await nativeRead(path.join(appDirectory, 'dist/main', LIBRARY_WATCH_BUILD_FILE), 1024, context)), 'NATIVE_PACKAGE_ASAR_BUILD_MISMATCH')
  const watch = await validateNativeLibraryWatchDirectory({ directory: path.join(resourcesDirectory, LIBRARY_WATCH_RESOURCE_ROOT),
    expectedManifestSha256: watchBuild.metadata.manifestSha256 }, context)
  return { cue, tags, watch, compiledMetadataMatchedActualAsar: true, packagingReadbackOnly: true,
    nativeSoftwareQualificationGranted: false, signingOrOwnerAcceptanceGranted: false }
}
export default async function afterPack(context) {
  nativeAssert(process.platform === 'darwin' && process.arch === 'arm64' && context.electronPlatformName === 'darwin' && context.arch === 3
    && process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' && context.packager.platformSpecificBuildOptions.identity === null
    && context.packager.config.electronFuses?.resetAdHocDarwinSignature === true, 'NATIVE_PACKAGE_TARGET')
  const product = context.packager.appInfo.productFilename
  nativeAssert(typeof product === 'string' && product.length > 0 && product.length <= 120 && !/[\/\\\x00-\x1f]/u.test(product) && product !== '.' && product !== '..')
  const appDirectory = await realpath(context.packager.info.appDir)
  const resourcesDirectory = path.join(await nativeDirectory(context.appOutDir), `${product}.app/Contents/Resources`)
  return verifyPackagedNativeResources({ resourcesDirectory, appDirectory })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  try {
    nativeAssert(process.argv.length === 3 && ['--capture-build', '--seal-build', '--capture-watch-build', '--seal-watch-build'].includes(process.argv[2]), 'NATIVE_PACKAGE_ARGUMENTS')
    const operation = { '--capture-build': captureNativeLocalAudioTags, '--seal-build': sealNativeLocalAudioTagsBuild,
      '--capture-watch-build': captureNativeLibraryWatch, '--seal-watch-build': sealNativeLibraryWatchBuild }[process.argv[2]]
    const metadata = await operation(directory)
    console.log(JSON.stringify({ status: metadata.manifestSha256 === null ? 'NATIVE_UNAVAILABLE' : 'FIXED_BUILD_IDENTITY_CAPTURED', metadata }))
  } catch (error) { console.error(error.code?.startsWith('NATIVE_PACKAGE_') ? error.code : 'NATIVE_PACKAGE_FAILED'); process.exitCode = 1 }
}
