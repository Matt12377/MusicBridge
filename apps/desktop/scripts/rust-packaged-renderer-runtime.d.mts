export type RustPackagedRendererKind = 'default-node' | 'node-renderer' | 'rust-renderer' | 'pin-rejected'
export type RustPackagedRendererLaunch = { type: 'fresh' } | { type: 'cold'; priorReceiptPath: string; priorReceiptSha256: string }
export interface RustPackagedRendererRunOptions { executable: string; expectedExecutableSha256: string; evidenceDirectory: string; kind: RustPackagedRendererKind; launch: RustPackagedRendererLaunch }
export interface RustPackagedRendererRuntimeReceipt extends RustPackagedRendererRunOptions {
  schemaVersion: 1; launchId: string; executableSha256: string; executableSha256After: string; profileDirectory: string; tmpDirectory: string; profileDev: string; profileIno: string; markerPath: string; markerSha256: string; nonce: string; completedMarkerSha256: string | null; priorReceiptSha256: string | null; startedAt: string; mainPid: number | null;
  actualLaunch: { executable: string; argv: string[]; cwd: string; env: Record<string, string> };
  events: import('../src/main/packaged-renderer-main-probe.js').PackagedRendererEvidenceEvent[]; lifecycle: { phase: string; elapsedMs: number; exitCode?: number }[]; rawEvidence: { path: string; sha256: string; bytes: number };
  mainExit: { code: number | null; signal: string | null }; timedOut: boolean; forceKilled: boolean; parseErrors: number; stdoutSha256: string; stderrSha256: string; stdoutBytes: number; stderrBytes: number; startupReady: boolean; startupFailed: boolean; completion: 'spawn-error' | 'timeout' | 'forced-close' | 'closed'
}
export function validateRustPackagedRendererRunOptions(options: RustPackagedRendererRunOptions): Promise<Readonly<RustPackagedRendererRunOptions>>
export function runRustPackagedRendererCandidate(options: RustPackagedRendererRunOptions): Promise<RustPackagedRendererRuntimeReceipt>
