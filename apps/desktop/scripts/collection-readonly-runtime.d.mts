export type CollectionReadonlyKind = 'default-node' | 'node-controls' | 'rust-controls' | 'pin-rejected'
export type CollectionReadonlyLaunch = { type: 'fresh' } | { type: 'cold'; priorReceiptPath: string; priorReceiptSha256: string }
export interface CollectionReadonlyRunOptions { executable: string; expectedExecutableSha256: string; evidenceDirectory: string; kind: CollectionReadonlyKind; launch: CollectionReadonlyLaunch }
export interface CollectionReadonlyRuntimeReceipt extends CollectionReadonlyRunOptions {
  schemaVersion: 1; launchId: string; executableSha256: string; executableSha256After: string; profileDirectory: string; tmpDirectory: string; profileDev: string; profileIno: string; markerPath: string; markerSha256: string; nonce: string; completedMarkerSha256: string | null; priorReceiptSha256: string | null; startedAt: string; mainPid: number | null;
  actualLaunch: { executable: string; argv: string[]; cwd: string; env: Record<string, string> };
  events: import('../src/main/collection-readonly-main-probe.js').CollectionReadonlyEvidenceEvent[]; lifecycle: { phase: string; elapsedMs: number; exitCode?: number }[]; rawEvidence: { path: string; sha256: string; bytes: number };
  mainExit: { code: number | null; signal: string | null }; timedOut: boolean; forceKilled: boolean; parseErrors: number; stdoutSha256: string; stderrSha256: string; stdoutBytes: number; stderrBytes: number; startupReady: boolean; startupFailed: boolean; completion: 'spawn-error' | 'timeout' | 'forced-close' | 'closed'
}
export function validateCollectionReadonlyRunOptions(options: CollectionReadonlyRunOptions): Promise<Readonly<CollectionReadonlyRunOptions>>
export function runCollectionReadonlyCandidate(options: CollectionReadonlyRunOptions): Promise<CollectionReadonlyRuntimeReceipt>
