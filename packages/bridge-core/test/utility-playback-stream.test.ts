import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlaybackStreamSnapshot } from '@music-bridge/contracts';
import { attachCoreRuntimePort, type CoreRuntimeForIpc, type UtilityPort } from '../src/utility-main.js';

const coreInstanceId = '11111111-1111-4111-8111-111111111111';
const health = { runtime: 'ready', roon: 'ready', provider: 'configured', activeStreamCount: 0, activePlaybackPresent: false };
function seed(sequence = 1): PlaybackStreamSnapshot {
  return { stamp: { coreInstanceId, generation: 0, sequence, queueRevision: 1, selectedZoneId: null, trackId: null, source: null },
    snapshot: { state: 'idle', queue: { items: [], index: -1, hasNext: false, hasPrevious: false }, positionMs: 0,
      canNext: false, canPrevious: false, canStop: false, canPause: false, canResume: false } };
}
class Port implements UtilityPort {
  messages: unknown[] = [];
  receive?: (event: { data: unknown }) => void;
  on(_event: 'message', listener: (event: { data: unknown }) => void) { this.receive = listener; }
  start() {}
  postMessage(message: unknown) { this.messages.push(structuredClone(message)); }
  send() { this.receive?.({ data: { version: 1, id: 'seed', command: 'playback.getStreamSnapshot', payload: {} } }); }
}
const runtime = (getPlaybackStreamSnapshot: () => unknown, compact = true) => ({ start: async () => {}, getState: () => health,
  getPlaybackStreamSnapshot, getPlaybackEventProtocol: () => compact ? { protocol: 'compact-v1', coreInstanceId } : null }) as unknown as CoreRuntimeForIpc;
const turn = () => new Promise(resolve => setImmediate(resolve));

test('006 Utility：ready ACK来自唯一runtime，旧模式保持原ready形状', async () => {
  const compact = new Port(); await attachCoreRuntimePort(compact, runtime(() => seed()));
  assert.deepEqual(compact.messages, [{ version: 1, event: 'core.ready', payload: { state: health, playbackEvents: { protocol: 'compact-v1', coreInstanceId } } }]);
  const legacy = new Port(); await attachCoreRuntimePort(legacy, runtime(() => null, false));
  assert.deepEqual(legacy.messages, [{ version: 1, event: 'core.ready', payload: { state: health } }]);
});

test('006 Utility：seed发送前最后同步采样，await期间的新事实不能被旧seed遮盖', async () => {
  let current = seed(), calls = 0;
  const port = new Port(); await attachCoreRuntimePort(port, runtime(() => {
    calls += 1;
    if (calls === 1) queueMicrotask(() => { current = seed(2); });
    return current;
  }));
  port.send(); await turn();
  assert.deepEqual(port.messages.at(-1), { version: 1, id: 'seed', ok: true, result: seed(2) });
  assert.equal(calls, 2);
});

test('006 Utility：无效runtime seed不会作为成功回执发给Main', async () => {
  const port = new Port(); await attachCoreRuntimePort(port, runtime(() => ({ ...seed(), privateSession: 'private' })));
  port.send(); await turn();
  const reply = port.messages.at(-1) as { ok: boolean; error?: { code: string; message: string } };
  assert.equal(reply.ok, false); assert.equal(reply.error?.code, 'INTERNAL_ERROR');
  assert.ok(!reply.error?.message.includes('privateSession'));
});

test('006 Utility：旧模式seed为null，不引发播放或SDK读取', async () => {
  const port = new Port(); await attachCoreRuntimePort(port, runtime(() => null, false));
  port.send(); await turn(); assert.deepEqual(port.messages.at(-1), { version: 1, id: 'seed', ok: true, result: null });
});
