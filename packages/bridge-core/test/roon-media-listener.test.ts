import assert from 'node:assert/strict';
import test from 'node:test';
import { networkInterfaces } from 'node:os';
import { request } from 'node:http';
import { StreamGateway } from '../src/stream/gateway.js';
import { StreamRegistry } from '../src/stream/registry.js';
import { createLogger } from '../src/shared/logger.js';
import { createTrustedRoonMediaPeer, isPrivateMediaAddress } from '../src/stream/roon-media-listener.js';
import { gatewayFixture } from './mbrs005/fixture.js';
import type { ResolvedAudioStream } from '../src/netease/types.js';

// 仅自有合成媒体，在当前网卡上验证真实 HTTP；不连接任何 Provider 或 Roon。
const lan = Object.values(networkInterfaces()).flat().find(value => value && !value.internal && isPrivateMediaAddress(value.address))?.address;
const peer = () => createTrustedRoonMediaPeer({ localAddress: lan!, remoteAddress: lan! });
const logger = createLogger('error');
const resolved = async (): Promise<ResolvedAudioStream> => ({ trackId: 'synthetic',
  upstreamUrl: 'https://m8.music.126.net/synthetic.flac', format: 'flac', requestedQuality: 'lossless', actualQuality: 'lossless' });
const raw = (url: string, target: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
  const req = request(url, { path: target, headers, agent: false }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)); });
  req.once('error', reject); req.end();
});

test('可信配对网络仅接受规范私有 IPv4，拒绝广域监听、公网、子网及伪造能力', async () => {
  for (const address of ['0.0.0.0', '8.8.8.8', '127.0.0.1', '192.168.1.0/24', '192.168.001.2', 'localhost']) {
    assert.throws(() => createTrustedRoonMediaPeer({ localAddress: address, remoteAddress: '192.168.1.2' }));
    assert.throws(() => createTrustedRoonMediaPeer({ localAddress: '192.168.1.2', remoteAddress: address }));
  }
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry: new StreamRegistry(), logger });
  await gateway.start();
  try { await assert.rejects(gateway.configureRoonMedia({ localAddress: '192.168.1.2', remoteAddress: '192.168.1.3' })); }
  finally { await gateway.stop(); }
});

test('LAN 实际随机端口统一发布网易云与 PNG，保留 Range/HEAD，只开放指定路由', async t => {
  if (!lan) { t.skip('当前环境没有可绑定的私有 IPv4 网卡'); return; }
  const registry = new StreamRegistry(), seen: string[] = [], events: string[] = [];
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry,
    logger: { ...logger, info: (event, fields) => events.push(JSON.stringify({event,fields})) },
    fetcher: async (url, init) => { assert.equal(url, 'https://m8.music.126.net/synthetic.flac'); seen.push(new Headers(init.headers).get('range') ?? 'none');
      return new Response(init.method === 'HEAD' ? null : Uint8Array.from([1, 2, 3, 4]), { status: 206,
        headers: { 'Content-Type': 'audio/flac', 'Content-Length': '4', 'Content-Range': 'bytes 0-3/10', 'Accept-Ranges': 'bytes' } }); } });
  await gateway.start(); t.after(() => gateway.stop());
  const registration = registry.register({ metadata: { id: 'synthetic', title: '合成歌曲', artists: ['测试艺人'], album: '合成专辑' },
    requestedQuality: 'lossless', resolve: resolved });
  await gateway.configureRoonMedia(peer());
  const url = gateway.streamUrl(registration.token, 'flac'), origin = new URL(url).origin;
  assert.equal(new URL(url).hostname, lan); assert.notEqual(new URL(url).port, '0');
  assert.equal(new URL(gateway.iconUrl()).origin, origin); assert.equal(gateway.isTrustedRoonMediaOrigin(origin), true);
  const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=0-3' } });
  assert.equal(head.status, 206); assert.equal(await head.text(), '');
  assert.equal(events.some(event => event.includes('roon_gateway_first_body_bytes')), false);
  const response = await fetch(url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(response.status, 206); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([1,2,3,4]));
  assert.deepEqual(seen, ['bytes=0-3','bytes=0-3']);
  assert.equal(events.some(event => event.includes('roon_gateway_first_body_bytes')), true);
  assert.equal(events.some(event => event.includes(registration.token)), false);
  assert.equal((await fetch(gateway.iconUrl())).headers.get('content-type'), 'image/png');
  for (const target of ['/health', '/__musicbridge_remote_dev_health', '/assets/icon.svg', '/assets/icon.png?x=1', '/stream/'+registration.token+'.flac?x=1', 'http://example.com/assets/icon.png']) {
    assert.equal(await raw(origin, target), 404, target);
  }
  assert.equal((await fetch(origin+'/stream/'+'a'.repeat(43)+'.flac')).status, 404);
  assert.equal((await fetch(gateway.iconUrl(), { method: 'POST' })).status, 404);
  const changed = await gateway.configureRoonMedia(peer()); assert.equal(changed, undefined);
  assert.equal(new URL(gateway.iconUrl()).origin, origin, '同一配对重复配置不换端口');
});

test('LAN 本地流复用原文件租约、Range 和撤销；换网不永久关闭本地注册', async t => {
  if (!lan) { t.skip('当前环境没有可绑定的私有 IPv4 网卡'); return; }
  const f = await gatewayFixture(t);
  await f.gateway.configureRoonMedia(peer());
  const url = f.gateway.localStreamUrl(f.token), origin = new URL(url).origin;
  assert.equal(new URL(url).hostname, lan);
  const response = await fetch(url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(100,200));
  await f.gateway.configureRoonMedia();
  assert.equal(f.gateway.isTrustedRoonMediaOrigin(origin), false);
  assert.equal(f.lease.state, 'PREPARED');
  const local = await fetch(f.url); assert.equal(local.status, 200); await local.arrayBuffer();
  await f.gateway.configureRoonMedia(peer());
  const replay = await fetch(f.gateway.localStreamUrl(f.token)); assert.equal(replay.status, 200); await replay.arrayBuffer();
});

test('LAN 来源只认 socket 的精确 peer，伪造转发头不能取得访问', async t => {
  if (!lan) { t.skip('当前环境没有可绑定的私有 IPv4 网卡'); return; }
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry: new StreamRegistry(), logger });
  await gateway.start(); t.after(() => gateway.stop());
  const other = lan === '192.168.254.254' ? '192.168.254.253' : '192.168.254.254';
  await gateway.configureRoonMedia(createTrustedRoonMediaPeer({localAddress:lan,remoteAddress:other}));
  assert.equal(await raw(gateway.iconUrl(), '/assets/icon.png', { 'X-Forwarded-For': other }), 404);
  assert.equal((await fetch(gateway.localBaseUrl()+'/assets/icon.png')).status, 200, 'loopback 服务没有受影响');
});

test('LAN configure 与 stop 交错撤销迟到监听，未就绪时拒绝发布远端 URL', async t => {
  if (!lan) { t.skip('当前环境没有可绑定的私有 IPv4 网卡'); return; }
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry: new StreamRegistry(), logger });
  await gateway.start();
  const activating = gateway.configureRoonMedia(peer());
  assert.throws(() => gateway.iconUrl(), /尚未就绪/u);
  const stopping = gateway.stop();
  await Promise.all([activating, stopping]);
  assert.throws(() => gateway.localBaseUrl(), /not listening/u);
  assert.equal(gateway.isTrustedRoonMediaOrigin(`http://${lan}:0`), false);
  await gateway.start();
  await gateway.configureRoonMedia(peer()); assert.equal(new URL(gateway.iconUrl()).hostname,lan);
  await gateway.stop();
});

test('LAN 上游异常不泄漏地址或错误原文', async t => {
  if (!lan) { t.skip('当前环境没有可绑定的私有 IPv4 网卡'); return; }
  const registry = new StreamRegistry();
  const gateway = new StreamGateway({ host:'127.0.0.1',port:0,publicBaseUrl:'http://127.0.0.1:0',registry,logger,
    fetcher:async()=>{throw new Error('https://private.invalid/audio?credential=synthetic-secret');} });
  await gateway.start(); t.after(()=>gateway.stop()); await gateway.configureRoonMedia(peer());
  const registration=registry.register({metadata:{id:'synthetic',title:'合成歌曲',artists:['测试'],album:'合成'},requestedQuality:'lossless',
    resolve:resolved});
  const response=await fetch(gateway.streamUrl(registration.token,'flac'));
  assert.equal(response.status,502); assert.equal(await response.text(),'');
});

test('LAN 撤销会结束本监听的活动传输，不等待整首媒体且保留 loopback', async t => {
  if (!lan) { t.skip('当前环境没有可绑定的私有 IPv4 网卡'); return; }
  const registry = new StreamRegistry(); let cancelled = false;
  const gateway = new StreamGateway({host:'127.0.0.1',port:0,publicBaseUrl:'http://127.0.0.1:0',registry,logger,
    fetcher:async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(4096));},cancel(){cancelled=true;}}),
      {status:200,headers:{'Content-Type':'audio/flac'}})});
  await gateway.start();t.after(()=>gateway.stop());await gateway.configureRoonMedia(peer());
  const registration=registry.register({metadata:{id:'synthetic',title:'合成歌曲',artists:['测试'],album:'合成'},requestedQuality:'lossless',
    resolve:resolved});
  const response=await fetch(gateway.streamUrl(registration.token,'flac')), reader=response.body!.getReader();
  const first=await reader.read();assert.ok(first.value!.length>0);
  const started=performance.now();await gateway.configureRoonMedia();assert.ok(performance.now()-started<1000);
  await reader.read().catch(()=>undefined);
  for(let i=0;i<20 && !cancelled;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,true);
  assert.equal((await fetch(gateway.localBaseUrl()+'/assets/icon.png')).status,200);
});
