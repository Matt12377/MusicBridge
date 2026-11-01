export interface NativeMediaWorkerBuild { schemaVersion: number; protocolVersion: number; binarySha256: string; platform: string; arch: string }
export function captureNativeMediaWorker(appDirectory: string, options?: { requireRelease?: boolean }): Promise<NativeMediaWorkerBuild>;
export default function beforePack(context: unknown): Promise<void>;
