export interface NativeConverterBuildMetadata { schemaVersion: 1; manifestSha256: string | null }
export function captureNativeConverter(appDirectory: string): Promise<NativeConverterBuildMetadata>
export function verifyNativeConverterPackage(appDirectory: string): Promise<string>
export default function beforePack(context: { electronPlatformName: string; arch: number; packager: { platformSpecificBuildOptions: { identity: string | null }; info: { appDir: string }; config: { electronFuses?: { resetAdHocDarwinSignature?: boolean } } } }): Promise<void>
