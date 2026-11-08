import assert from 'node:assert/strict';
import test from 'node:test';
import { DiagnosticRingBuffer, assertDiagnosticExportSafe } from '@music-bridge/contracts';
import { createRoonIntegrationDiagnostics } from '../src/roon/integration-diagnostics.js';

test('接入诊断只接收闭集阶段和不透明媒体身份，不导出 URL、session 或异常文本', () => {
  const ring=new DiagnosticRingBuffer(), observer=createRoonIntegrationDiagnostics(ring);
  observer.log('roon_media_request',{diagnosticId:'roon-media-1',url:'https://private.invalid/secret',session_id:'private-session',message:'private-error'});
  observer.log('roon_gateway_first_body_bytes',{diagnosticId:'roon-media-1'});
  observer.log('roon_gateway_transfer_complete',{diagnosticId:'roon-media-1',bytesForwarded:4096,durationMs:12});
  observer.log('untrusted-dynamic-event',{state:'secret'});
  observer.playback('roon-media-1',{stage:'playing',current:false,durationMs:14});
  observer.playback('roon-media-2',{stage:'playing',current:true,durationMs:20});
  observer.playback('https://private.invalid',{stage:'session_timeout',current:true,durationMs:30000});
  const events=ring.snapshot();assert.equal(events.length,6);
  assert.equal(events[3]!.state,'stale_ignored');assert.equal(events[4]!.state,'playing_confirmed');
  assert.equal(events[2]!.state,'media_terminal|bytes=4096');
  assert.equal(events[5]!.diagnosticId,undefined);
  const text=JSON.stringify(events);assertDiagnosticExportSafe(text);
  assert.doesNotMatch(text,/private|session_id|secret/u);
});

test('代理或其他 peer 被拒绝时仅导出固定分类，不复制地址与代理头', () => {
  const ring = new DiagnosticRingBuffer(), observer = createRoonIntegrationDiagnostics(ring);
  observer.log('roon_media_peer_rejected', { url: 'http://private.invalid/token', remoteAddress: 'private-peer', forwarded: 'secret', message: 'private-error' });
  const events = ring.snapshot();
  assert.equal(events.length, 1); assert.equal(events[0]!.state, 'media_peer_rejected');
  assert.equal(events[0]!.level, 'warn');
  const text = JSON.stringify(events); assertDiagnosticExportSafe(text);
  assert.doesNotMatch(text, /private|secret|remoteAddress|forwarded/u);
});

test('撤回的实验性主机事件不进入诊断，监听事件不复制任意主机字段', () => {
  const ring = new DiagnosticRingBuffer(), observer = createRoonIntegrationDiagnostics(ring);
  observer.log('roon_media_host_selected', { selection: 'name-unavailable', hostname: 'private.local', error: 'secret' });
  observer.log('roon_media_host_selected', { selection: 'private.local' });
  observer.log('roon_media_listener_ready', { advertisedHostClass: 'mdns', bindIP: 'private-address' });
  observer.log('roon_media_listener_ready', { advertisedHostClass: 'private.local' });
  assert.deepEqual(ring.snapshot().map(value => value.state), ['media_listener_ready', 'media_listener_ready']);
  const text = JSON.stringify(ring.snapshot()); assertDiagnosticExportSafe(text); assert.doesNotMatch(text, /private|secret|bindIP|hostname/u);
});
