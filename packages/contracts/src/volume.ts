export interface VolumeOutput {
  outputId: string;
  name: string;
  type: 'db' | 'number' | 'incremental';
  min?: number;
  max?: number;
  value?: number;
  step?: number;
  muted?: boolean;
}
export interface VolumeSnapshot { zoneId: string; outputs: readonly VolumeOutput[] }
export interface VolumeRequest { zoneId: string; outputId: string; how: 'absolute' | 'relative'; value: number }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const label = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/.test(v);
const onlyKeys = (v: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(v).every(k => allowed.includes(k));

export function isVolumeRequest(v: unknown): v is VolumeRequest {
  return record(v) && onlyKeys(v, ['zoneId', 'outputId', 'how', 'value'])
    && label(v.zoneId) && label(v.outputId)
    && (v.how === 'absolute' || v.how === 'relative')
    && typeof v.value === 'number' && Number.isFinite(v.value) && Math.abs(v.value) <= 10000;
}
function isVolumeOutput(v: unknown): v is VolumeOutput {
  if (!record(v) || !onlyKeys(v, ['outputId', 'name', 'type', 'min', 'max', 'value', 'step', 'muted'])
    || !label(v.outputId) || !label(v.name)
    || (v.muted !== undefined && typeof v.muted !== 'boolean')) return false;
  if (v.type === 'incremental') return ['min', 'max', 'value', 'step'].every(k => v[k] === undefined);
  return (v.type === 'db' || v.type === 'number')
    && ['min', 'max', 'value', 'step'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k]))
    && Number(v.min) < Number(v.max) && Number(v.step) > 0;
}
export function isVolumeSnapshot(v: unknown): v is VolumeSnapshot {
  return record(v) && onlyKeys(v, ['zoneId', 'outputs']) && (v.zoneId === '' || label(v.zoneId))
    && Array.isArray(v.outputs) && v.outputs.length <= 100 && v.outputs.every(isVolumeOutput);
}
