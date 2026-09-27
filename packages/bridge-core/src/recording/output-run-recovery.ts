import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isCollectionId } from '@music-bridge/contracts';
import type { PinnedDeviceOutputHelper } from './bundled-device-output-helper.js';
import type { OutputRunRecoveryRow } from './output-run-barrier.js';
import { revokeOutputRunLease, type OutputRunLeaseBinding } from './output-run-lease.js';

export type OutputRunRecoveryState =
  | { safe: true; pendingRuns: number }
  | { safe: false; pendingRuns: number; reason: 'OUTPUT_RUN_UNVERIFIED' };
type Presence = 'present' | 'absent' | 'unknown';
type Binding = Omit<OutputRunLeaseBinding, 'gateRecordSha256'>;

async function leasePresence(databaseFile: string, runId: string): Promise<Presence> {
  try { await lstat(`${databaseFile}.output-run-${runId}.lease`); return 'present'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown'; }
}

/** 冷启仅凭当前dataset与持久pending身份撤销；缺文件不是静止证明。 */
export async function reconcileOutputRunRecovery(options: {
  databaseFile: string; datasetId: string; rows: readonly OutputRunRecoveryRow[];
  pin?: PinnedDeviceOutputHelper; assertCurrent(): void;
  /** 仅隔离测试注入，不经Runtime/IPC/环境变量。 */
  probe?: typeof leasePresence;
  revoke?: (binding: Binding) => Promise<boolean>;
  /** 原生墓碑已落盘后，仅补写此run的两项软件静止事实；失败仍封锁输出。 */
  persistQuiet?: (row: OutputRunRecoveryRow) => void | Promise<void>;
}): Promise<OutputRunRecoveryState> {
  const blocked = (): OutputRunRecoveryState => ({ safe: false, pendingRuns: options.rows.length, reason: 'OUTPUT_RUN_UNVERIFIED' });
  if (!path.isAbsolute(options.databaseFile) || options.databaseFile.includes('\0')
    || !isCollectionId(options.datasetId) || !Array.isArray(options.rows)) return blocked();
  const probe = options.probe ?? leasePresence;
  try {
    options.assertCurrent();
    for (const row of options.rows) {
      if (!isCollectionId(row.attemptId) || !isCollectionId(row.runId)
        || !['A', 'B', 'Program'].includes(row.side)
        || ![row.planContentSha256, row.audioSha256, row.pcmSha256].every(hash => /^[a-f0-9]{64}$/u.test(hash))
        || typeof row.quietPersisted !== 'boolean') return blocked();
      const presence = await probe(options.databaseFile, row.runId);
      options.assertCurrent();
      if (presence === 'unknown') return blocked();
      if (presence === 'absent') {
        if (!row.quietPersisted) return blocked();
        continue;
      }
      // 有sidecar时，哪怕barrier已verified也必须由原生helper持排他锁落盘墓碑。
      if (!options.pin) return blocked();
      const binding: Binding = { databaseFile: options.databaseFile, datasetId: options.datasetId,
        attemptId: row.attemptId, side: row.side, runId: row.runId,
        planContentSha256: row.planContentSha256, audioSha256: row.audioSha256,
        pcmSha256: row.pcmSha256, pin: options.pin };
      if (!await (options.revoke ?? revokeOutputRunLease)(binding)) return blocked();
      options.assertCurrent();
      if (!row.quietPersisted) {
        if (!options.persistQuiet) return blocked();
        await options.persistQuiet(row);
        options.assertCurrent();
      }
    }
    options.assertCurrent();
    return { safe: true, pendingRuns: options.rows.length };
  } catch { return blocked(); }
}
