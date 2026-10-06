import type { RoonSdk, RoonApiOptions, RoonZoneChangeCallback, RoonAudioInputPlayOptions } from '../../src/roon/sdk.js';
import { RoonAudioInputAdapter } from '../../src/roon/adapter.js';
import type { Logger } from '../../src/shared/logger.js';
export const silentLogger: Logger = {debug(){},info(){},warn(){},error(){}};
/** 锁定SDK签名的受控回报；不连接真实Roon，不发声。 */
export async function adapterFixture(timeout = 30,iconPort=38502) {
  let apiOptions!: RoonApiOptions, zoneCallback!: RoonZoneChangeCallback;
  const sessions: ((message: unknown, body: unknown) => void)[] = [], plays: ((message: unknown, body: unknown) => void)[] = [];
  const sends: RoonAudioInputPlayOptions[] = []; let ends = 0, controls = 0;
  const core = { core_id:'synthetic-core', display_name:'受控Core', services: {
    RoonApiAudioInput: { begin_session(_options:unknown, callback:(message:unknown,body:unknown)=>void) { sessions.push(callback); return {end_session(callback:(message:unknown,body:unknown)=>void){ends++;callback('SessionEnded',{});}}; },
      update_transport_controls(_options:unknown,callback:(message:unknown,body:unknown)=>void){callback('Success',{});},
      play(options:RoonAudioInputPlayOptions,callback:(message:unknown,body:unknown)=>void){sends.push(options);plays.push(callback);callback('Playing',{});} },
    RoonApiTransport: {subscribe_zones(callback:RoonZoneChangeCallback){zoneCallback=callback;},control(_zone:unknown,_control:unknown,callback:(error:false)=>void){controls++;callback(false);},seek(_zone:unknown,_how:unknown,_seconds:unknown,callback:(error:false)=>void){callback(false);} }
  }};
  const sdk = {audioInputService:class {},transportService:class {},createApi(options:RoonApiOptions){apiOptions=options;return {load_config(){},save_config(){},init_services(){},start_discovery(){},stop_discovery(){},disconnect_all(){}};},createSettings(){return {};},createStatus(){return {set_status(){}};}} as unknown as RoonSdk;
  const adapter = new RoonAudioInputAdapter(silentLogger,sdk,{sessionBeginTimeoutMs:timeout,playingTimeoutMs:timeout,iconPort});
  await adapter.start(); apiOptions.core_paired(core);
  zoneCallback('Subscribed',{zones:[{zone_id:'synthetic-zone',display_name:'受控Zone',outputs:[{output_id:'synthetic-output'}],is_pause_allowed:true,is_play_allowed:true,is_seek_allowed:true}]});
  adapter.selectZone('synthetic-zone');
  return {adapter,sessions,plays,sends,core,pair(){apiOptions.core_paired(core);},unpair(){apiOptions.core_unpaired(core);},zoneCallback,ends:()=>ends,controls:()=>controls};
}
export const syntheticPlayRequest = {mediaUrl:'http://127.0.0.1:38502/local_stream/synthetic-secret',iconUrl:'http://127.0.0.1:38502/assets/icon.png',metadata:{id:'local-test',title:'合成曲目',artists:['合成作者'],album:'合成专辑'}};
export const tick = () => new Promise<void>(resolve=>setImmediate(resolve));
