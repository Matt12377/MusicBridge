export interface CollectionScaleSourceIdentity {
  entries: Array<{ path: string; sha256: string }>
  sha256: string
}
export declare function sourceIdentity(): Promise<CollectionScaleSourceIdentity>
export declare function prepare(output: string, binaryPath: string): Promise<Record<string, unknown>>
export declare function gate(preparation: unknown, output: string): Promise<Record<string, unknown>>
export declare function captureClosedSqlite(runKey: string, evidenceDirectory: string, evidence: { path: string }): Promise<{ check: Record<string, unknown>; value: unknown }>
/** 逐轮失败屏障；完整协议、源码、包与持久事实由最终严格准入另核。 */
export declare function assertCollectionScaleRunClosed(runKey: string, kind: string, receipt: unknown): void
/** 只供本任务完整证据测试进程使用；短期限仅供受控生命周期检查。 */
export declare function runCollectionScaleBehaviorCheck(output: string, executable: string, argv: string[], extraEnv?: Record<string, string>, cwd?: string, deadlineMs?: number): Promise<{ code: number; signal: null; failure: null; childPid: number; scope: string; deadlineMs: number; timedOut: boolean; forcedCleanup: boolean; log: string; logSha256: string }>
