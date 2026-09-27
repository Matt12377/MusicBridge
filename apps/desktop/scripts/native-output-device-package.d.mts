import type { GateBCandidateIdentity } from '../../../packages/bridge-core/src/recording/gate-b-admission.js'

export interface NativeOutputDeviceBuildMetadata {
  schemaVersion: 1
  manifestSha256: string | null
  candidate: GateBCandidateIdentity | null
}

export function captureNativeOutputDevice(appDirectory: string): Promise<NativeOutputDeviceBuildMetadata>
export function verifyNativeOutputDevicePackage(appDirectory: string): Promise<string | undefined>
