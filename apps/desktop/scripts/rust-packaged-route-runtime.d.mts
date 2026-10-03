export type RustPackagedRouteKind = 'default-node' | 'node-diagnostic' | 'rust-diagnostic' | 'pin-rejected'
export interface RustPackagedRouteRunOptions { executable: string; expectedExecutableSha256: string; evidenceDirectory: string; kind: RustPackagedRouteKind }
export interface RustPackagedRouteRuntimeReceipt extends RustPackagedRouteRunOptions {
  schemaVersion: 1; executableSha256: string; executableSha256After: string; profileDirectory: string; tmpDirectory: string; startedAt: string; mainPid: number | null;
  events: import('../src/main/packaged-route-main-probe.js').PackagedRouteEvidenceEvent[]; mainExit: { code: number | null; signal: string | null };
  timedOut: boolean; forceKilled: boolean; parseErrors: number; stdoutSha256: string; stderrSha256: string; stdoutBytes: number; stderrBytes: number;
  startupReady: boolean; startupFailed: boolean; completion: 'spawn-error' | 'timeout' | 'forced-close' | 'closed'
}
export function validateRustPackagedRouteRunOptions(options: RustPackagedRouteRunOptions): Promise<Readonly<RustPackagedRouteRunOptions>>
export function runRustPackagedRouteCandidate(options: RustPackagedRouteRunOptions): Promise<RustPackagedRouteRuntimeReceipt>
