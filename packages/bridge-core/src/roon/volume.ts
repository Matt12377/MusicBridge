import type { VolumeRequest, VolumeSnapshot, VolumeOutput } from '@music-bridge/contracts';
import type { RoonZone } from './sdk.js';
export function readVolume(zone: RoonZone | undefined): VolumeSnapshot {
 const outputs: VolumeOutput[] = [];
 for (const output of zone?.outputs ?? []) {
  const v = output.volume;
  if (!output.output_id || !v) continue;
  const base = { outputId: output.output_id, name: output.display_name || '播放设备' };
  if (v.type === 'incremental') { outputs.push({...base, type:'incremental'}); continue; }
  if (![v.min,v.max,v.value,v.step].every(n => typeof n === 'number' && Number.isFinite(n))) continue;
  const min = Math.max(v.min!, Number.isFinite(v.limits?.min) ? v.limits!.min! : v.min!);
  const max = Math.min(v.max!, Number.isFinite(v.limits?.max) ? v.limits!.max! : v.max!);
  if (min >= max || v.step! <= 0) continue;
  outputs.push({...base, type: v.type === 'db' ? 'db' : 'number', min, max, value:v.value!, step:v.step!, ...(typeof v.is_muted === 'boolean' ? {muted:v.is_muted} : {})});
 }
 return {zoneId:zone?.zone_id ?? '',outputs};
}
export function planVolume(zone: RoonZone | undefined, request: VolumeRequest): VolumeRequest {
 if (!zone || zone.zone_id !== request.zoneId || !Number.isFinite(request.value)) throw Error('播放设备已变化');
 const output = readVolume(zone).outputs.find(o => o.outputId === request.outputId);
 if (!output) throw Error('设备不支持音量调节');
 if (output.type === 'incremental') {
  if (request.how !== 'relative' || ![-1,1].includes(request.value)) throw Error('无效的音量增量');
  return request;
 }
 if (request.how !== 'absolute' || request.value < output.min! || request.value > output.max!) throw Error('音量超出设备范围');
 const rounded = output.min! + Math.round((request.value - output.min!) / output.step!) * output.step!;
 return {...request, value:Math.min(output.max!, Math.max(output.min!, Number(rounded.toFixed(6))))};
}
