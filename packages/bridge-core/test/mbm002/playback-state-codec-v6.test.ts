import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePlaybackStorage, decodePlaybackStorage } from '../../src/mobile/playback-state-codec.js';
import { MOBILE_PLAYBACK_DEFAULT_LIMITS as limits } from '../../src/mobile/playback-types.js';
import { capacityHistory, capacityNodes, CAPACITY_SERVER as SERVER, CAPACITY_DATASET as DATASET, CAPACITY_ORIGIN as ORIGIN, CAPACITY_NOW as NOW, capacityPrincipal } from './playback-state-capacity-fixture.js';

export function blockHistory(receipts = 1445, unknowns = 1) {
  const state = capacityHistory({ sessions: 52, resources: 588, receipts });
  for (const row of state.resources) row.source!.processing.reason = '合成原字节'.repeat(10);
  for (const row of state.receipts) if (row.reply && row.reply.status < 400 && row.operation !== 'createSession')
    (row.reply.body as { processing: { reason: string } }).processing.reason = '合成原字节'.repeat(10);
  if (unknowns) for (const row of state.receipts.filter(v => v.operation === 'createResource').slice(-unknowns)) {
    row.state = 'UNKNOWN'; row.reply = null; row.resourceContext = null;
  }
  return state;
}
test('v6：原terminal-v4-reserve拒绝的1445条历史保留UNKNOWN并在原物理与逻辑预算内冷读', { timeout: 60_000 }, () => {
  const state = blockHistory(), value = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits);
  assert.equal(value.format, 'v6'); assert.ok(value.bytes.length <= limits.stateBytes);
  assert.ok(capacityNodes(JSON.parse(value.canonical)) <= 200_000);
  assert.deepEqual(value.state, state);
  assert.deepEqual(decodePlaybackStorage(value.bytes, SERVER, DATASET, ORIGIN, limits).state, state);
});

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { createMobileAuthCrypto } from '../../src/mobile/auth-crypto.js';
import { createMobilePlaybackService } from '../../src/mobile/playback-service.js';
import { MobilePlaybackError, type MobilePlaybackSourcePort } from '../../src/mobile/playback-types.js';
import type { MobileAuthPersistence, MobileSealedState } from '../../src/mobile/types.js';
import { mobileCanonicalJson, type MobileJsonValue } from '@music-bridge/contracts';
import { createPlaybackStorageActor } from '../../src/mobile/playback-state-codec.js';
import { deltaContext, deltaSession, deltaCandidate, deltaCreate, deltaPublish } from './playback-state-delta-fixture.js';
import { capturePlaybackState } from '../../src/mobile/playback-state.js';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const wire = (value: unknown) => new Uint8Array(Buffer.from(mobileCanonicalJson(value as MobileJsonValue)));
function replacement(text: string, count = 1, encoding = 'raw') {
  const bytes = Buffer.from(text);
  return { encoding, count, rawBytes: bytes.length, digest: digest(bytes), data: (encoding === 'raw' ? bytes : deflateRawSync(bytes)).toString('base64') };
}
function rejected(value: unknown) { assert.throws(() => decodePlaybackStorage(wire(value), SERVER, DATASET, ORIGIN, limits)); }

test('v6：压缩尾/串接流/截断/长度SHA损坏不被当作合法块，raw canonical与闭集严格拒绝', { timeout: 60_000 }, () => {
  const encoded = encodePlaybackStorage(blockHistory(1600, 0), SERVER, DATASET, ORIGIN, limits);
  const source = JSON.parse(encoded.canonical); assert.equal(encoded.format, 'v6');
  assert.equal(source.receipts[0].encoding, 'deflate-raw');
  for (const kind of ['trailer', 'concatenated', 'truncated', 'short', 'long', 'hash', 'base64', 'extra', 'count', 'encoding']) {
    const bad = structuredClone(source), block = bad.receipts[0], bytes = Buffer.from(block.data, 'base64');
    if (kind === 'trailer') block.data = Buffer.concat([bytes, Buffer.from([0])]).toString('base64');
    if (kind === 'concatenated') block.data = Buffer.concat([bytes, deflateRawSync(Buffer.from('null'))]).toString('base64');
    if (kind === 'truncated') block.data = bytes.subarray(0, bytes.length - 1).toString('base64');
    if (kind === 'short') block.rawBytes--;
    if (kind === 'long') block.rawBytes++;
    if (kind === 'hash') block.digest = '0'.repeat(64);
    if (kind === 'base64') block.data += '\n';
    if (kind === 'extra') block.url = '不得接受的合成字段';
    if (kind === 'count') block.count--;
    if (kind === 'encoding') block.encoding = 'gzip';
    rejected(bad);
  }
  for (const kind of ['keyHash', 'duplicateId', 'extra', 'invalidUtf8']) {
    const bad=structuredClone(source),block=bad.receipts[0],bytes=Buffer.from(block.data,'base64');
    const text=(block.encoding==='raw'?bytes:inflateRawSync(bytes)).toString();
    const rows=JSON.parse('['+text+']');
    if(kind==='keyHash')rows[0].keyHash='0'.repeat(64);
    if(kind==='duplicateId')rows[1].id=rows[0].id;
    if(kind==='extra')rows[0].credential='不允许的新字段';
    if(kind==='invalidUtf8') { const raw=Buffer.from([0xff]); bad.root={encoding:'raw',count:1,rawBytes:1,digest:digest(raw),data:raw.toString('base64')}; }
    else bad.receipts[0]=replacement(rows.map((row:MobileJsonValue)=>mobileCanonicalJson(row)).join(','),rows.length);
    rejected(bad);
  }
  const rootBytes = Buffer.from(source.root.data, 'base64');
  const root = JSON.parse((source.root.encoding === 'raw' ? rootBytes : inflateRawSync(rootBytes)).toString());
  for (const text of [' '+mobileCanonicalJson(root), '{"schema":"x","schema":"y"}', 'null', '1e0', '"\\ud800"']) {
    const bad = structuredClone(source); bad.root = replacement(text); rejected(bad);
  }
});

test('v6：先约束声明总量与硬解压输出，再在JSON分配前拒绝超逻辑节点/深度', { timeout: 60_000 }, () => {
  const encoded = encodePlaybackStorage(blockHistory(1600, 0), SERVER, DATASET, ORIGIN, limits), source = JSON.parse(encoded.canonical);
  const tooDeclared = structuredClone(source); tooDeclared.root.rawBytes = limits.stateBytes + limits.maxReceipts * 8192 + 1; rejected(tooDeclared);
  const bomb = structuredClone(source); bomb.root = replacement('0'.repeat(8 * 1024 * 1024), 1, 'deflate-raw'); bomb.root.rawBytes = 1; rejected(bomb);
  const tooMany = structuredClone(source); tooMany.root = replacement('[' + '0,'.repeat(1_000_000) + '0]', 1, 'deflate-raw'); rejected(tooMany);
  const tooDeep = structuredClone(source); tooDeep.root = replacement('['.repeat(25) + '0' + ']'.repeat(25), 1, 'deflate-raw'); rejected(tooDeep);
  const count = structuredClone(source); count.receipts.push(count.receipts[0]); rejected(count);
  assert.throws(() => decodePlaybackStorage(encoded.bytes, 'wrong.server', DATASET, ORIGIN, limits));
  // 终态回执按保存的resourceContext回放；当前origin不改写历史上下文。
  assert.deepEqual(decodePlaybackStorage(encoded.bytes, SERVER, DATASET, 'https://127.0.0.1:9444', limits).state, encoded.state);
  const actor = createPlaybackStorageActor(), owned = actor.encode(encoded.state, deltaContext(encoded.state));
  assert.throws(() => actor.derive(owned.base, deltaSession(encoded.state, 950), { ...deltaContext(encoded.state), responseOrigin: 'https://127.0.0.1:9444' }));
  actor.close();
  assert.throws(() => decodePlaybackStorage(encoded.bytes, SERVER, DATASET, ORIGIN, { ...limits, maxReceipts: 1599 }));
});

test('v6：分散四个UNKNOWN的16种终态子集完整冷读，旧回执原键与全部事实保持', { timeout: 120_000 }, () => {
  const original = blockHistory(1600, 0), pending = original.receipts.filter(row => row.operation === 'createResource').filter((_, i) => [3, 19, 35, 51].includes(i));
  assert.equal(pending.length, 4);
  for (const row of pending) { row.state = 'UNKNOWN'; row.reply = null; row.resourceContext = null; }
  const admitted = encodePlaybackStorage(original, SERVER, DATASET, ORIGIN, limits); assert.equal(admitted.format, 'v6');
  const key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  for (let mask = 0; mask < 16; mask++) {
    const state = structuredClone(original); state.revision = Number.MAX_SAFE_INTEGER; state.clockFloor = 8_640_000_000_000_000;
    state.commitId = '50000000-0000-4000-8000-000000000001';
    for (let i = 0; i < pending.length; i++) if (mask & 1 << i) {
      const row = state.receipts.find(row => row.id === pending[i]!.id)!;
      row.state = 'RECORDED'; row.reply = { status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT', message: '服务暂时无法完成请求，请查询原记录。',
        requestId: `40000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`, retryable: false, retryAfterMs: Number.MAX_SAFE_INTEGER } } };
      const resource = state.resources.find(value => value.id === row.resourceId)!; resource.state = 'failed'; resource.failure = 'IDEMPOTENCY_CONFLICT'; resource.media = null;
    }
    capturePlaybackState(state, SERVER, DATASET, ORIGIN, limits);
    const encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits); assert.equal(encoded.format, 'v6');
    assert.ok(encoded.bytes.length <= limits.stateBytes); assert.ok(capacityNodes(JSON.parse(encoded.canonical)) <= 200_000);
    const aad = Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, state.revision]));
    const sealed = crypto.seal(encoded.bytes, aad), plain = crypto.open(sealed, aad);
    try { assert.deepEqual(decodePlaybackStorage(plain, SERVER, DATASET, ORIGIN, limits).state, state); }
    finally { plain.fill(0); sealed.fill(0); }
    assert.deepEqual(state.receipts.filter(row => !pending.some(value => value.id === row.id)), original.receipts.filter(row => !pending.some(value => value.id === row.id)));
  }
});

test('v6：自有base块仅复用已验证不可变记录，新增session/UNKNOWN/ready与冷编码逐字节一致', { timeout: 60_000 }, () => {
  const initial = blockHistory(1600, 0), actor = createPlaybackStorageActor();
  let state = initial, encoded = actor.encode(state, deltaContext(state)); assert.equal(encoded.format, 'v6');
  const steps = [() => deltaSession(state, 901), () => deltaCreate(state, 902), () => deltaPublish(state, 902)];
  for (let i = 0; i < steps.length; i++) {
    const patch = steps[i]!(), candidate = deltaCandidate(state, patch, i + 1);
    const expected = encodePlaybackStorage(candidate, SERVER, DATASET, ORIGIN, limits);
    const result = actor.derive(encoded.base, patch, deltaContext(candidate));
    assert.equal(result.format, 'v6'); assert.equal(result.canonical, expected.canonical); assert.deepEqual(result.bytes, expected.bytes); assert.deepEqual(result.state, candidate);
    state = structuredClone(result.state); encoded = result;
  }
  // 合法UNKNOWN已带ready/media时，冷恢复terminal及错误结算仍被同一raw上界覆盖。
  const pending=structuredClone(state),receipt=pending.receipts.find(row=>row.id==='delta.receipt.902')!;
  receipt.state='UNKNOWN';receipt.reply=null;receipt.resourceContext=null;
  const before=encodePlaybackStorage(pending,SERVER,DATASET,ORIGIN,limits);
  assert.deepEqual(decodePlaybackStorage(before.bytes,SERVER,DATASET,ORIGIN,limits).state,pending);
  const resource=pending.resources.find(row=>row.id===receipt.resourceId)!;
  resource.state='terminal';resource.failure='SERVICE_RESTARTED';resource.media=null;
  receipt.state='RECORDED';receipt.reply={status:503,body:{error:{code:'SERVICE_RESTARTED',message:'服务已重启，原媒体资源已失效。',
    requestId:'40000000-0000-4000-8000-000000000002',retryable:true,retryAfterMs:1000}}};
  const terminal=encodePlaybackStorage(pending,SERVER,DATASET,ORIGIN,limits);
  assert.deepEqual(decodePlaybackStorage(terminal.bytes,SERVER,DATASET,ORIGIN,limits).state,pending);
  actor.close();
});

test('v6：完整历史经真实服务新增及冷重开原键重放，撤销仍拒且不重prepare', { timeout: 60_000 }, async t => {
  const state = blockHistory(1600, 0), encoded = encodePlaybackStorage(state, SERVER, DATASET, ORIGIN, limits), key = randomBytes(32), crypto = createMobileAuthCrypto(key); key.fill(0);
  const aad = (revision: number) => Buffer.from(JSON.stringify(['MBM002_PLAYBACK_STATE_V1', SERVER, DATASET, revision]));
  let stored: MobileSealedState = { kind: 'sealed', datasetId: DATASET, revision: state.revision, commitId: state.commitId!, sealed: crypto.seal(encoded.bytes, aad(state.revision)) };
  let writes = 0, prepares = 0, revoked = false;
  const source: MobilePlaybackSourcePort = { async prepare() { prepares++; throw new Error('不应再次准备旧来源'); }, async verify() {}, async renew() {},
    async read() { throw new Error('不读取媒体'); }, async closeRead() {}, async release() {} };
  const persistence: MobileAuthPersistence = { async load() { return structuredClone(stored); }, async save(request) {
    assert.equal(request.expectedRevision, stored.revision); writes++;
    stored = { kind: 'sealed', datasetId: DATASET, revision: stored.revision + 1, commitId: request.commitId, sealed: new Uint8Array(request.sealed) };
    return { kind: 'saved', datasetId: DATASET, revision: stored.revision, commitId: stored.commitId };
  } };
  const create = () => createMobilePlaybackService({ serverId: SERVER, datasetId: DATASET, responseOrigin: ORIGIN, crypto, persistence, sourcePort: source,
    nowMs: () => NOW, auth: { async assertDeviceCurrent() { if (revoked) throw new MobilePlaybackError(401, 'DEVICE_REVOKED'); } } });
  const actor = create(); t.after(() => actor.close());
  const request = { path: '/mobile/v1/sessions', pathParameters: {}, query: {}, body: { clientInstanceId: 'selective.new.client' }, idempotencyKey: 'selective.new.original-key' };
  const principal = capacityPrincipal('selective.synthetic.new');
  const first = await actor.control('createSession', request, principal, new AbortController().signal); assert.equal(first.status, 201); await first.beforeSend();
  await actor.close(); const cold = create(); t.after(() => cold.close());
  const replay = await cold.control('createSession', request, principal, new AbortController().signal);
  assert.equal(replay.status, first.status); assert.deepEqual(replay.body, first.body);
  for (const row of [state.receipts[0]!, state.receipts[52]!, state.receipts[639]!, state.receipts.at(-1)!]) {
    const reply = await cold.control(row.operation, row.request, capacityPrincipal(), new AbortController().signal);
    assert.equal(reply.status, row.reply!.status); assert.deepEqual(reply.body, row.reply!.body);
  }
  const opened = crypto.open(stored.sealed, aad(stored.revision));
  try { const decoded = decodePlaybackStorage(opened, SERVER, DATASET, ORIGIN, limits); assert.equal(decoded.format, 'v6');
    assert.equal(decoded.state.receipts.length, state.receipts.length + 1);
    for (const receipt of state.receipts) assert.deepEqual(decoded.state.receipts.find(value => value.id === receipt.id), receipt);
  } finally { opened.fill(0); }
  assert.equal(writes, 1); assert.equal(prepares, 0); revoked = true;
  await assert.rejects(replay.beforeSend(), error => error instanceof MobilePlaybackError && error.code === 'DEVICE_REVOKED');
});


test('v6：真实物理与终态预留最紧边界均拒绝少1B，原完整UNKNOWN随后可持久失败', {timeout:120_000}, () => {
  const state=blockHistory(1445,1),initial=encodePlaybackStorage(state,SERVER,DATASET,ORIGIN,limits);
  let low=initial.bytes.length,high=limits.stateBytes;
  while(low<high){const middle=Math.floor((low+high)/2);
    try{encodePlaybackStorage(state,SERVER,DATASET,ORIGIN,{...limits,stateBytes:middle});high=middle;}
    catch(error){assert.ok(error instanceof MobilePlaybackError&&error.code==='RESOURCE_BUSY');low=middle+1;}}
  assert.ok(low>initial.bytes.length,'最紧准入必须包含实际终态预留而非仅当前压缩字节');
  const tight={...limits,stateBytes:low},admitted=encodePlaybackStorage(state,SERVER,DATASET,ORIGIN,tight);
  assert.equal(admitted.format,'v6');assert.deepEqual(decodePlaybackStorage(admitted.bytes,SERVER,DATASET,ORIGIN,tight).state,state);
  assert.throws(()=>encodePlaybackStorage(state,SERVER,DATASET,ORIGIN,{...tight,stateBytes:low-1}),
    error=>error instanceof MobilePlaybackError&&error.code==='RESOURCE_BUSY');
  const settled=structuredClone(state),row=settled.receipts.find(row=>row.state==='UNKNOWN')!;
  row.state='RECORDED';row.reply={status:409,body:{error:{code:'IDEMPOTENCY_CONFLICT',message:'服务暂时无法完成请求，请查询原记录。',
    requestId:'40000000-0000-4000-8000-000000000001',retryable:false,retryAfterMs:Number.MAX_SAFE_INTEGER}}};
  const resource=settled.resources.find(value=>value.id===row.resourceId)!;resource.state='failed';resource.failure='IDEMPOTENCY_CONFLICT';resource.media=null;
  settled.revision=Number.MAX_SAFE_INTEGER;settled.clockFloor=8_640_000_000_000_000;settled.commitId='50000000-0000-4000-8000-000000000001';
  const final=encodePlaybackStorage(settled,SERVER,DATASET,ORIGIN,tight);
  assert.deepEqual(decodePlaybackStorage(final.bytes,SERVER,DATASET,ORIGIN,tight).state,settled);
});

test('v6：更高4000历史无删减冷往返，原计数限制仍拒4096以上', {timeout:60_000}, () => {
  const state=blockHistory(4000,1),encoded=encodePlaybackStorage(state,SERVER,DATASET,ORIGIN,limits);
  assert.equal(encoded.format,'v6');assert.ok(encoded.bytes.length<=limits.stateBytes);
  assert.ok(capacityNodes(JSON.parse(encoded.canonical))<=200_000);
  assert.deepEqual(decodePlaybackStorage(encoded.bytes,SERVER,DATASET,ORIGIN,limits).state,state);
  assert.throws(()=>encodePlaybackStorage(blockHistory(4097,0),SERVER,DATASET,ORIGIN,limits));
});
