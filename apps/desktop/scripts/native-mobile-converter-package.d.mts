export interface NativeMobileConverterBuildMetadata { schemaVersion: 1; manifestSha256: string | null }
export function captureNativeMobileConverter(appDirectory: string): Promise<NativeMobileConverterBuildMetadata>
export function verifyNativeMobileConverterPackage(appDirectory: string): Promise<string | false>
