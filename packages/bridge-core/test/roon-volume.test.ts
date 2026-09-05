import assert from 'node:assert/strict';
import test from 'node:test';
import { readVolume, planVolume } from '../src/roon/volume.js';
const zone = { zone_id: 'z', outputs: [{ output_id: 'speaker', display_name: '音箱', volume: { type: 'db', min: -80, max: 0, value: -24, step: 0.5, limits: { min: -60, max: -10 } } }] };
test('读取设备原生单位与限制，缺数据不能假装 100% 音量', () => {
 const volume = readVolume(zone);
 assert.deepEqual(volume.outputs[0], { outputId:'speaker', name:'音箱', type:'db', min:-60, max:-10, value:-24, step:0.5 });
 assert.deepEqual(readVolume(undefined), { zoneId: '', outputs: [] });
 assert.equal(readVolume({ zone_id:'z', outputs:[{output_id:'fixed'}] }).outputs.length, 0);
});
test('切换设备后拒绝旧请求，限制越界，保留步长', () => {
 assert.throws(() => planVolume(zone, {zoneId:'old',outputId:'speaker',value:-25,how:'absolute'}));
 assert.throws(() => planVolume(zone, {zoneId:'z',outputId:'wrong',value:-25,how:'absolute'}));
 assert.throws(() => planVolume(zone, {zoneId:'z',outputId:'speaker',value:0,how:'absolute'}));
 assert.throws(() => planVolume(zone, {zoneId:'z',outputId:'speaker',value:NaN,how:'absolute'}));
 assert.equal(planVolume(zone, {zoneId:'z',outputId:'speaker',value:-25.2,how:'absolute'}).value,-25);
});
test('只有增量型设备允许相对 +1/-1', () => {
 const z = {zone_id:'z',outputs:[{output_id:'i',volume:{type:'incremental'}}]};
 assert.equal(planVolume(z,{zoneId:'z',outputId:'i',how:'relative',value:1}).value,1);
 assert.throws(() => planVolume(z,{zoneId:'z',outputId:'i',how:'relative',value:10}));
});
