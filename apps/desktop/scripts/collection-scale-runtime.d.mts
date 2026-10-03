export type CollectionScaleKind = 'default-node' | 'scale-0' | 'scale-100' | 'scale-2000' | 'scale-2001' | 'scale-5000' | 'scale-5001'
export type CollectionScaleLaunch = { type: 'fresh' } | { type: 'cold'; priorReceiptPath: string; priorReceiptSha256: string }
export interface CollectionScaleRunOptions { executable: string; expectedExecutableSha256: string; evidenceDirectory: string; kind: CollectionScaleKind; launch: CollectionScaleLaunch }
export interface CollectionScaleEvent { schemaVersion: 1; actor: 'main' | 'core' | 'renderer'; sequence: number; elapsedMs: number; pid: number; event: string; data: Record<string, any> }
export interface CollectionScaleRuntimeReceipt extends CollectionScaleRunOptions {
  schemaVersion: 1; seedTool: any | null; modelCount: number; seedReceipt: { path: string; sha256: string }; rss: { intervalMs: 100; scope: 'bounded-runtime-ps-sampling'; clock: 'runtime-performance'; samples: { pid: number; elapsedMs: number; rssKiB: number }[]; zeroReadings: { pid: number; elapsedMs: number; rssKiB: 0; psStatus: 0 }[]; errors: { pid: number; code: string }[] };
  launchId: string; executableSha256: string; executableSha256After: string; profileDirectory: string; tmpDirectory: string; profileDev: string; profileIno: string;
  markerPath: string; markerSha256: string; nonce: string; completedMarkerSha256: string | null; priorReceiptSha256: string | null; startedAt: string; mainPid: number | null;
  actualLaunch: { executable: string; argv: string[]; cwd: string; env: Record<string, string> }; events: CollectionScaleEvent[]; lifecycle: { phase: string; elapsedMs: number; exitCode?: number }[];
  rawEvidence: { path: string; sha256: string; bytes: number }; streams: Record<'stdout' | 'stderr', { path: string; sha256: string; bytes: number }>;
  mainExit: { code: number | null; signal: string | null }; timedOut: boolean; forceKilled: boolean; parseErrors: number; stdoutSha256: string; stderrSha256: string; stdoutBytes: number; stderrBytes: number;
  startupReady: boolean; startupFailed: boolean; completion: 'spawn-error' | 'timeout' | 'forced-close' | 'closed'
}
export const COLLECTION_SCALE_KINDS: readonly CollectionScaleKind[]
export function validateCollectionScaleRunOptions(options: CollectionScaleRunOptions): Promise<Readonly<CollectionScaleRunOptions>>
export function parseCollectionScaleEvent(value: unknown): CollectionScaleEvent
export function collectionScalePriorClosed(value: any, kind: CollectionScaleKind): boolean
export function runCollectionScaleCandidate(options: CollectionScaleRunOptions): Promise<CollectionScaleRuntimeReceipt>

export const COLLECTION_SCALE_PROFILE_PREFIXES: Readonly<Record<CollectionScaleKind,string>>

export function recordCollectionScaleRssReading(rss:CollectionScaleRuntimeReceipt["rss"],reading:{pid:number;elapsedMs:number;rssKiB:number;psStatus:number}):void
