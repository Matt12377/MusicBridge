import type beforeConverterPack from './native-converter-package.mjs'
export const NATIVE_RUST_BUILD_ROOT: 'native/rust-core/darwin-arm64'
export interface NativeRustBuildIdentity { schemaVersion: 1; manifestSha256: string | null }
export function captureNativeRust(appDirectory: string): Promise<NativeRustBuildIdentity>
export function verifyNativeRustPackage(appDirectory: string): Promise<string | false>
export default function beforePack(context: Parameters<typeof beforeConverterPack>[0]): Promise<void>
