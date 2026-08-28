export interface NativeOutputBuildMetadata { schemaVersion: 1; manifestSha256: string | null }
export function captureNativeOutput(appDirectory: string): Promise<NativeOutputBuildMetadata>
export function verifyNativeOutputPackage(appDirectory: string): Promise<string | undefined>
