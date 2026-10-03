export interface RustResourceManifest {
  schemaVersion: 1
  kind: 'musicbridge-rust-readonly-resource'
  platform: 'darwin'
  arch: 'arm64'
  protocolVersion: 2
  source: { commit: string; sha256: string }
  binary: { relativePath: 'bin/musicbridge-rust-core'; sha256: string; size: number; cdHash: string }
}
export interface ValidatedRustNativeDirectory {
  manifest: RustResourceManifest
  manifestSha256: string
  binaryPath: string
  binarySha256: string
  cdHash: string
}
export const RUST_RESOURCE_RELATIVE_ROOT: 'rust-core/darwin-arm64'
export const RUST_BINARY_RELATIVE_PATH: 'bin/musicbridge-rust-core'
export function createRustResourceManifest(input: { binaryPath: string; sourceCommit: string; sourceSha256: string }): Promise<RustResourceManifest>
export function validateRustNativeDirectory(input: { directory: string; expectedManifestSha256: string; platform?: string; arch?: string }): Promise<ValidatedRustNativeDirectory>
export function stageRustNativeResource(input: { sourceDirectory: string; resourcesDirectory: string; expectedManifestSha256: string }): Promise<ValidatedRustNativeDirectory>
