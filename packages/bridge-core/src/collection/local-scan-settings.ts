import { createHash } from 'node:crypto';
import path from 'node:path';
import * as dto from '@music-bridge/contracts';
import type { DatasetIdentity } from '../recording/dataset-identity.js';

export const LOCAL_SCAN_SETTINGS_OPERATION = 'local-scan-settings-v1';
export interface LocalScanSettings { revision: string; albumConcurrency: number }
export interface LocalScanFrozenSettings { jobId: string; settingsRevision: string; albumConcurrency: number; readerConcurrency: 1 }
export const LOCAL_SCAN_DEFAULT_SETTINGS: Readonly<LocalScanSettings> = Object.freeze({ revision: '1', albumConcurrency: 12 });
const closed = (value: unknown, names: readonly string[]): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === names.length
  && names.every(name => { const field = Object.getOwnPropertyDescriptor(value, name); return field?.enumerable === true && Object.hasOwn(field, 'value'); });
export function isLocalScanSettings(value: unknown): value is LocalScanSettings {
  return closed(value, ['revision','albumConcurrency']) && dto.isLocalCatalogRevision(value.revision)
    && Number.isSafeInteger(value.albumConcurrency) && Number(value.albumConcurrency) >= 1 && Number(value.albumConcurrency) <= 24;
}
export type LocalScanSettingsEvent = { schema: 1; datasetId: string; eventId: string; commandId: string; expectedRevision: string;
  kind: 'settings'; settings: LocalScanSettings } | { schema: 1; datasetId: string; eventId: string; commandId: string;
  kind: 'launch'; frozen: LocalScanFrozenSettings };
export function isLocalScanSettingsEvent(value: unknown): value is LocalScanSettingsEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const names = v.kind === 'settings' ? ['schema','datasetId','eventId','commandId','expectedRevision','kind','settings']
    : ['schema','datasetId','eventId','commandId','kind','frozen'];
  if (!closed(v, names) || v.schema !== 1 || ![v.datasetId,v.eventId,v.commandId].every(dto.isCollectionId)) return false;
  if (v.kind === 'settings') return dto.isLocalCatalogRevision(v.expectedRevision) && isLocalScanSettings(v.settings)
    && BigInt(v.settings.revision) === BigInt(v.expectedRevision as string) + 1n;
  return v.kind === 'launch' && closed(v.frozen, ['jobId','settingsRevision','albumConcurrency','readerConcurrency'])
    && dto.isCollectionId(v.frozen.jobId) && dto.isLocalCatalogRevision(v.frozen.settingsRevision) && v.frozen.readerConcurrency === 1
    && Number.isSafeInteger(v.frozen.albumConcurrency) && Number(v.frozen.albumConcurrency) >= 1 && Number(v.frozen.albumConcurrency) <= 24;
}
export const localScanSettingsFingerprint = (value: LocalScanSettingsEvent): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface LocalScanSettingsStore {
  read(identity: DatasetIdentity): LocalScanSettings;
  save(identity: DatasetIdentity, event: Extract<LocalScanSettingsEvent, { kind: 'settings' }>): LocalScanSettings;
  frozen(identity: DatasetIdentity, jobId: string): LocalScanFrozenSettings | null;
  freeze(identity: DatasetIdentity, event: Extract<LocalScanSettingsEvent, { kind: 'launch' }>): LocalScanFrozenSettings;
}
/** Reader仍只受理一个真实读取；专辑调度等待不打开文件或增加Reader内部队列。 */
export function createScanReaderTurn() {
  let occupied = false, closing = false;
  const waiters: { signal: AbortSignal; resolve(): void; reject(error: unknown): void; abort(): void }[] = [];
  const cancelled = (): Error => { const error = new Error('扫描读取已停止。'); error.name = 'AbortError'; return error; };
  function advance(): void {
    occupied = false;
    while (waiters.length) {
      const next = waiters.shift()!; next.signal.removeEventListener('abort', next.abort);
      if (closing || next.signal.aborted) next.reject(cancelled());
      else { occupied = true; next.resolve(); return; }
    }
  }
  return {
    async consume<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
      if (closing || signal.aborted) throw cancelled();
      if (occupied) {
        if (waiters.length >= 2400) throw new Error('专辑调度超过100个源根的有限等待预算。');
        await new Promise<void>((resolve, reject) => {
          const next = { signal, resolve, reject, abort: () => {
            const at = waiters.indexOf(next); if (at >= 0) waiters.splice(at, 1); reject(cancelled());
          } };
          waiters.push(next); signal.addEventListener('abort', next.abort, { once: true });
          if (signal.aborted) next.abort();
        });
      } else occupied = true;
      try { if (closing || signal.aborted) throw cancelled(); return await operation(); }
      finally { advance(); }
    },
    close() { closing = true; for (const next of waiters.splice(0)) { next.signal.removeEventListener('abort', next.abort); next.reject(cancelled()); } },
    inspect: () => ({ occupied, waiting: waiters.length, closing, readerConcurrency: 1 as const }),
  };
}
/** 一次发现的全部文件按真实目录分组；只有全部专辑任务join后才返回原顺序的完整批次。 */
export async function scheduleScanAlbums<T>(relatives: readonly string[], concurrency: number, parent: AbortSignal,
  consume: (relative: string, signal: AbortSignal) => Promise<T>): Promise<T[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 24 || relatives.length > 200) throw new Error('专辑扫描调度范围或并发设置无效。');
  const grouped = new Map<string, { relative: string; index: number }[]>();
  relatives.forEach((relative, index) => { const directory = path.posix.dirname(relative), group = grouped.get(directory) ?? []; group.push({ relative, index }); grouped.set(directory, group); });
  const groups = [...grouped.values()], values = new Array<T>(relatives.length), control = new AbortController(), signal = AbortSignal.any([parent, control.signal]);
  let cursor = 0, failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const group = groups[cursor++]; if (!group) return;
      try { for (const entry of group) { signal.throwIfAborted(); values[entry.index] = await consume(entry.relative, signal); } }
      catch (error) { failure ??= error; control.abort(error); }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
  if (failure) throw failure; parent.throwIfAborted();
  if (values.length !== relatives.length || relatives.some((_relative, index) => !Object.hasOwn(values, index))) throw new Error('专辑扫描完整批次没有闭合。');
  return values;
}
