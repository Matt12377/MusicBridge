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
