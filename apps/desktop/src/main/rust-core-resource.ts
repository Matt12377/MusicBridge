import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { types } from 'node:util'
import { RUST_RESOURCE_RELATIVE_ROOT, validateRustNativeDirectory, type RustResourceManifest } from '../../scripts/rust-native-package.mjs'

export interface RustCoreResourceOptions {
  resourcesDirectory: string
  expectedManifestSha256: string
}

export interface RustCoreResource {
  readonly binary: Readonly<{ path: string; sha256: string }>
  readonly manifestSha256: string
  readonly manifest: Readonly<Omit<RustResourceManifest, 'source' | 'binary'>> & {
    readonly source: Readonly<RustResourceManifest['source']>
    readonly binary: Readonly<RustResourceManifest['binary']>
  }
}

function reject(message: string): never {
  throw Object.assign(new Error(message), { code: 'RUST_RESOURCE_REJECTED' })
}

function trustedOptions(value: RustCoreResourceOptions): RustCoreResourceOptions {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) reject('Rust 资源配置无效。')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) reject('Rust 资源配置无效。')
  const fields = Reflect.ownKeys(value)
  if (fields.length !== 2 || fields.some(key => key !== 'resourcesDirectory' && key !== 'expectedManifestSha256')) reject('Rust 资源配置无效。')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const resources = descriptors.resourcesDirectory, pin = descriptors.expectedManifestSha256
  if (!resources || !pin || !resources.enumerable || !pin.enumerable
    || !Object.hasOwn(resources, 'value') || !Object.hasOwn(pin, 'value')
    || typeof resources.value !== 'string' || typeof pin.value !== 'string' || !/^[a-f0-9]{64}$/u.test(pin.value)) reject('Rust 资源配置无效。')
  // 首次 await 前复制两个数据字段；调用方后来修改对象不能替换本次准入身份。
  return { resourcesDirectory: resources.value, expectedManifestSha256: pin.value }
}

async function trustedResourcesDirectory(directory: string) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || directory.length > 1024 || directory.includes('\0')) reject('Rust 资源路径未准入。')
  try {
    const identity = await lstat(directory, { bigint: true })
    if (!identity.isDirectory() || identity.isSymbolicLink() || (identity.mode & 0o022n) !== 0n
      || (identity.mode & 0o7000n) !== 0n || await realpath(directory) !== directory) reject('Rust 资源路径未准入。')
    return identity
  } catch { return reject('Rust 资源路径未准入。') }
}

/** 仅由可信宿主显式解析固定资源；正式默认入口不调用。 */
export async function resolveRustCoreResource(supplied: RustCoreResourceOptions): Promise<RustCoreResource> {
  const options = trustedOptions(supplied)
  if (process.platform !== 'darwin' || process.arch !== 'arm64') reject('Rust 资源只支持 macOS arm64。')
  const before = await trustedResourcesDirectory(options.resourcesDirectory)
  const verified = await validateRustNativeDirectory({
    directory: path.join(options.resourcesDirectory, RUST_RESOURCE_RELATIVE_ROOT),
    expectedManifestSha256: options.expectedManifestSha256,
    platform: process.platform,
    arch: process.arch,
  })
  const after = await trustedResourcesDirectory(options.resourcesDirectory)
  if (['dev', 'ino', 'mode', 'mtimeNs', 'ctimeNs', 'nlink'].some(field =>
    before[field as keyof typeof before] !== after[field as keyof typeof after])) reject('Rust 资源路径未准入。')
  const manifest = Object.freeze({ ...verified.manifest,
    source: Object.freeze({ ...verified.manifest.source }), binary: Object.freeze({ ...verified.manifest.binary }) })
  return Object.freeze({ binary: Object.freeze({ path: verified.binaryPath, sha256: verified.binarySha256 }),
    manifestSha256: verified.manifestSha256, manifest })
}
