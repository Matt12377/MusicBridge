import assert from 'node:assert/strict';
import test from 'node:test';
import {createBridgeRuntime} from '../../src/runtime.js';
import {RoonAudioInputAdapter} from '../../src/roon/adapter.js';
import {NeteaseClient} from '../../src/netease/client.js';
import {ControlServer} from '../../src/control/server.js';
import {StreamGateway} from '../../src/stream/gateway.js';
import {catalogFixture} from './catalog-fixture.js';
import {silentLogger} from './adapter-fixture.js';

test('006实际runtime legacy入口明确unsupported且零Owner捕获/SDK发送，旧网易云入口继续可用',async t=>{
 const f=await catalogFixture(t);let captures=0,plays=0,cloud=0;
 t.mock.method(RoonAudioInputAdapter.prototype,'start',async()=>{});t.mock.method(RoonAudioInputAdapter.prototype,'shutdown',async()=>{});
 t.mock.method(RoonAudioInputAdapter.prototype,'getState',()=>({status:'ready',selectedZoneId:'synthetic-zone',transportState:'playing'}));
 t.mock.method(RoonAudioInputAdapter.prototype,'play',async()=>{plays++;});t.mock.method(RoonAudioInputAdapter.prototype,'stop',async()=>{});
 t.mock.method(StreamGateway.prototype,'start',async()=>{});t.mock.method(StreamGateway.prototype,'preflight',async()=>{});t.mock.method(StreamGateway.prototype,'stop',async()=>{});t.mock.method(ControlServer.prototype,'start',async()=>{});t.mock.method(ControlServer.prototype,'stop',async()=>{});
 t.mock.method(NeteaseClient.prototype,'getPublicAccountProfile',async()=>({displayName:'受控合成'}));
 t.mock.method(NeteaseClient.prototype,'getTrack',async()=>({id:'123',title:'合成旧入口',artists:['合成'],album:'合成'}));t.mock.method(NeteaseClient.prototype,'resolveStream',async()=>{cloud++;return {trackId:'123',upstreamUrl:'https://synthetic.invalid/audio',requestedQuality:'standard',actualQuality:'standard',expiresInSeconds:60};});
 const runtime=createBridgeRuntime({logger:silentLogger,env:{NETEASE_COOKIE:'synthetic-offline-fixture-cookie'},datasetOwnerEndpoint:{prepare:async()=>({epoch:f.epoch,datasetId:f.datasetId}),dispatch:async()=>{},commitBoot:async()=>{},close:async()=>{},captureLocalSource:async()=>{captures++;throw new Error('legacy不得捕获');}}});t.after(()=>runtime.shutdown());
 assert.deepEqual(await runtime.playbackPlayLocal!(f.requests[0]!),{status:'unsupported',reason:'LOCAL_PLAYBACK_PROTOCOL_UNSUPPORTED'});assert.equal(captures,0);assert.equal(plays,0);
 await runtime.playbackPlay('123','standard');assert.equal(cloud,1);assert.equal(plays,1);
});
