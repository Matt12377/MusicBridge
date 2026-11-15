import assert from 'node:assert/strict';
import test from 'node:test';
import { request, type ClientRequest } from 'node:http';
import { StreamGateway } from '../src/stream/gateway.js';
import { StreamRegistry } from '../src/stream/registry.js';
import type { ResolvedAudioStream } from '../src/netease/types.js';
import type { Logger } from '../src/shared/logger.js';

/** 仅自有loopback网关、受控上游字节；不连接真实Provider/Roon或播放设备。 */
async function fixture(t: test.TestContext) {
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [], clients: ClientRequest[] = [], listeners = new Set<() => void>();
  const events: unknown[] = [], registry = new StreamRegistry(); let closed = false, releaseResolver!: () => void;
  const resolver = new Promise<void>(resolve => { releaseResolver = resolve; });
  const notify = (): void => { for (const listener of [...listeners]) listener(); };
  const record = (event: string, fields?: Record<string, unknown>): void => { events.push({ event, fields }); };
  const logger: Logger = { debug: record, info: record, warn: record, error: record };
  const stream = (trackId: string): ResolvedAudioStream => ({ trackId, upstreamUrl: `https://controlled.invalid/${trackId}.flac`,
    requestedQuality: 'lossless', actualQuality: 'lossless', format: 'flac', transportSecurity: 'https-native' });
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry, logger,
    onMediaReadActivityChanged: notify, fetcher: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { bodies.push(controller); if (closed) controller.close(); notify(); },
    }), { headers: { 'Content-Type': 'audio/flac' } }) });
  await gateway.start();
  const register = (trackId: string, delayed = false) => registry.register({ metadata: { id: trackId, title: 'Controlled', artists: ['Synthetic'], album: 'Synthetic Album' },
    requestedQuality: 'lossless', resolve: async () => { if (delayed) await resolver; return stream(trackId); } });
  const get = (token: string): ClientRequest => {
    const client = request(`${gateway.localBaseUrl()}/stream/${token}.flac`, response => { response.on('error', () => {}); response.resume(); });
    client.on('error', () => {}); clients.push(client); client.end(); return client;
  };
  const wait = (condition: () => boolean): Promise<void> => {
    if (condition()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = (): void => { if (condition()) { clearTimeout(timer); listeners.delete(check); resolve(); } };
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error('合成网关活动未到达预期边界。')); }, 3000);
      listeners.add(check); check();
    });
  };
  t.after(async () => {
    closed = true; releaseResolver();
    for (const client of clients) client.destroy();
    for (const body of bodies) try { body.close(); } catch { /* 原流可能已经取消。 */ }
    const errors: unknown[] = [];
    try { await wait(() => gateway.getActiveMediaReadCount() === 0); } catch (error) { errors.push(error); }
    try { await gateway.stop(); } catch (error) { errors.push(error); }
    assert.equal(gateway.getActiveMediaReadCount(), 0);
    if (errors.length) throw new AggregateError(errors, '合成网关未全部确认关闭。', { cause: errors[0] });
  });
  return { bodies, events, gateway, registry, stream, get, register, wait, releaseResolver };
}

test('扫描媒体资格：解析/首字节前不放行，唯一当前token进入pipeline后才可考虑预算', async t => {
  const f = await fixture(t), current = f.register('61001', true);
  assert.equal(f.gateway.hasOnlyMediaReadsForToken(undefined), true);
  f.get(current.token); await f.wait(() => f.gateway.getActiveMediaReadCount() === 1);
  assert.equal(f.gateway.hasOnlyMediaReadsForToken(current.token), false, 'resolve尚未落定不能借旧playing状态');
  f.releaseResolver(); await f.wait(() => f.bodies.length === 1);
  assert.equal(f.gateway.hasOnlyMediaReadsForToken(current.token), false, '只有headers而没有实际候选字节仍阻断');
  f.bodies[0]!.enqueue(Uint8Array.of(1, 2, 3)); await f.wait(() => f.gateway.hasOnlyMediaReadsForToken(current.token));
  assert.equal(f.gateway.hasOnlyMediaReadsForToken('unrelated-controlled-token'), false);
  assert.equal(f.gateway.hasOnlyMediaReadsForToken(undefined), false);
  f.get(current.token); await f.wait(() => f.bodies.length === 2);
  f.bodies[1]!.enqueue(Uint8Array.of(4));
  assert.equal(f.gateway.getActiveMediaReadCount(), 2); assert.equal(f.gateway.hasOnlyMediaReadsForToken(current.token), false);
  f.bodies[1]!.close(); await f.wait(() => f.gateway.getActiveMediaReadCount() === 1);
  assert.equal(f.gateway.hasOnlyMediaReadsForToken(current.token), true);
  f.bodies[0]!.close(); await f.wait(() => f.gateway.getActiveMediaReadCount() === 0);
  assert.equal(JSON.stringify(f.events).includes(current.token), false, '新资格绑定不得写入网关日志');
});

test('扫描媒体资格：无归属preflight与其他注册流不能冒当前所有权', async t => {
  const f = await fixture(t), current = f.register('61002'), other = f.register('61003');
  f.get(other.token); await f.wait(() => f.bodies.length === 1);
  f.bodies[0]!.enqueue(Uint8Array.of(1)); await f.wait(() => f.gateway.hasOnlyMediaReadsForToken(other.token));
  assert.equal(f.gateway.hasOnlyMediaReadsForToken(current.token), false);
  f.bodies[0]!.close(); await f.wait(() => f.gateway.getActiveMediaReadCount() === 0);
  const preflight = f.gateway.preflight(f.stream('61004'));
  await f.wait(() => f.gateway.getActiveMediaReadCount() === 1);
  assert.equal(f.gateway.hasOnlyMediaReadsForToken(current.token), false);
  await preflight; await f.wait(() => f.gateway.getActiveMediaReadCount() === 0);
});

test('扫描媒体资格：真实并发超过有限绑定预算，未跟踪的最后一条也不误判单流', async t => {
  const f = await fixture(t), current = f.register('61005');
  for (let index = 0; index < 9; ++index) f.get(current.token);
  await f.wait(() => f.bodies.length === 9);
  for (const body of f.bodies) body.enqueue(Uint8Array.of(1));
  assert.equal(f.gateway.getActiveMediaReadCount(), 9); assert.equal(f.gateway.hasOnlyMediaReadsForToken(current.token), false);
  for (const body of f.bodies.slice(0, 8)) body.close();
  await f.wait(() => f.gateway.getActiveMediaReadCount() === 1);
  assert.equal(f.gateway.hasOnlyMediaReadsForToken(current.token), false, '最后未跟踪请求必须等真实完成，不能补造归属');
  f.bodies[8]!.close(); await f.wait(() => f.gateway.getActiveMediaReadCount() === 0);
  assert.equal(f.gateway.hasOnlyMediaReadsForToken(undefined), true);
});
