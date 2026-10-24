import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureMobilePairingBeginReply, captureMobilePairingBeginRequest, captureMobilePairingExchangeRequest,
  captureMobilePairingFinishReply, isMobilePairingBootstrapPath, mobilePairingCanonicalBinding,
  parseMobilePairingBootstrapRoute, type MobilePairingBootstrapBinding,
} from '../src/mobile-pairing-bootstrap.js';

const requestId = 'pair:' + 'ab'.repeat(24);
const begin = { protocolVersion: 1 as const, serverId: 'server:synthetic', certificateSha256: 'ab'.repeat(32),
  installationId: 'installation:one', deviceName: '合成手机', clientNonce: 'cd'.repeat(32), claimIdempotencyKey: 'claim:one' };
const challenge = { protocolVersion: 1 as const, requestId, serverId: begin.serverId, origin: 'https://192.168.1.2:45391',
  certificateSha256: begin.certificateSha256, serverNonce: 'ef'.repeat(32), salt: '01'.repeat(32),
  serverPublicKey: '02'.repeat(384), expiresAt: '2026-10-24T10:02:00.000Z' };

test('独立四路由只接受唯一方法、空query、封闭body及192位请求身份', () => {
  const captured = parseMobilePairingBootstrapRoute({ method: 'POST', path: '/mobile/v1/pairing-requests', query: [], body: begin });
  assert.equal(captured.operation, 'begin'); assert.equal(captured.requestId, null);
  assert.deepEqual({ ...captured.body }, begin);
  const exchange = { clientPublicKey: '03'.repeat(384), clientProof: '04'.repeat(64) };
  assert.equal(parseMobilePairingBootstrapRoute({ method: 'POST', path: `/mobile/v1/pairing-requests/${encodeURIComponent(requestId)}/exchange`, query: [], body: exchange }).operation, 'exchange');
  assert.equal(parseMobilePairingBootstrapRoute({ method: 'POST', path: `/mobile/v1/pairing-requests/${requestId}/finish`, query: [], body: { clientConfirmation: '05'.repeat(32) } }).operation, 'finish');
  assert.deepEqual(parseMobilePairingBootstrapRoute({ method: 'DELETE', path: `/mobile/v1/pairing-requests/${requestId}`, query: [], body: null }), { operation: 'cancel', requestId, body: null });
  for (const candidate of [
    { method: 'GET', path: '/mobile/v1/pairing-requests', query: [], body: begin },
    { method: 'POST', path: '/mobile/v1/pairing-requests', query: [['code', '123456']], body: begin },
    { method: 'POST', path: '/mobile/v1/pairing-requests', query: [], body: { ...begin, code: '123456' } },
    { method: 'DELETE', path: `/mobile/v1/pairing-requests/${requestId}`, query: [], body: {} },
    { method: 'POST', path: `/mobile/v1/pairing-requests/${requestId}`, query: [], body: null },
    { method: 'POST', path: '/mobile/v1/pairing-requests/short/exchange', query: [], body: exchange },
  ]) assert.throws(() => parseMobilePairingBootstrapRoute(candidate as Parameters<typeof parseMobilePairingBootstrapRoute>[0]));
  assert.equal(isMobilePairingBootstrapPath('/mobile/v1/pairings/claim'), false);
  assert.equal(isMobilePairingBootstrapPath(`/mobile/v1/pairing-requests/${requestId}/status`), false);
});

test('二进制字段拒绝大写、短值、换行、奇数字节及非法响应元数据', () => {
  assert.equal(captureMobilePairingBeginRequest(begin).ok, true);
  assert.equal(captureMobilePairingBeginReply(challenge).ok, true);
  for (const value of ['AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(32) + '\n']) {
    assert.equal(captureMobilePairingBeginRequest({ ...begin, certificateSha256: value }).ok, false);
  }
  for (const patch of [{ deviceName: '   ' }, { deviceName: '手机\u0000' }, { claimIdempotencyKey: 'key\n' }, { protocolVersion: 2 }]) {
    assert.equal(captureMobilePairingBeginRequest({ ...begin, ...patch }).ok, false);
  }
  assert.equal(captureMobilePairingExchangeRequest({ clientPublicKey: 'ab'.repeat(384), clientProof: 'cd'.repeat(64) }).ok, true);
  assert.equal(captureMobilePairingExchangeRequest({ clientPublicKey: 'ab'.repeat(383), clientProof: 'cd'.repeat(64) }).ok, false);
  assert.equal(captureMobilePairingFinishReply({ nonce: 'ab'.repeat(12), ciphertext: 'abc', tag: 'cd'.repeat(16) }).ok, false);
  assert.equal(captureMobilePairingFinishReply({ nonce: 'ab'.repeat(12), ciphertext: 'abcd', tag: 'cd'.repeat(16) }).ok, true);
  assert.equal(captureMobilePairingBeginReply({ ...challenge, requestId: 'pair:short' }).ok, false);
  assert.equal(captureMobilePairingBeginReply({ ...challenge, origin: 'https://public.example:443' }).ok, false);
});

test('封闭快照不执行输入getter、不容许符号字段或查询身份混入', () => {
  let reads = 0;
  const unsafe = Object.defineProperty({ ...begin }, 'deviceName', { enumerable: true, get() { reads++; return '不应执行'; } });
  assert.equal(captureMobilePairingBeginRequest(unsafe).ok, false); assert.equal(reads, 0);
  assert.equal(captureMobilePairingBeginRequest({ ...begin, [Symbol('隐藏')]: '值' }).ok, false);
});

test('canonical绑定使用固定顺序UInt32大端UTF8长度，中文和字段边界不歧义', () => {
  const binding: MobilePairingBootstrapBinding = { ...begin, ...challenge };
  const encoded = mobilePairingCanonicalBinding(binding), view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  let offset = 0; const fields: string[] = [];
  while (offset < encoded.length) {
    const length = view.getUint32(offset, false); offset += 4;
    fields.push(new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(offset, offset + length))); offset += length;
  }
  assert.deepEqual(fields, ['MOUSA_PAIRING_BOOTSTRAP_V1', 'srp6a-3072-sha512', requestId, begin.serverId,
    challenge.origin, begin.certificateSha256, begin.installationId, begin.deviceName,
    begin.clientNonce, challenge.serverNonce, begin.claimIdempotencyKey, challenge.expiresAt]);
  assert.notDeepEqual(mobilePairingCanonicalBinding({ ...binding, installationId: 'ab', deviceName: 'c' }),
    mobilePairingCanonicalBinding({ ...binding, installationId: 'a', deviceName: 'bc' }));
  assert.notDeepEqual(mobilePairingCanonicalBinding({ ...binding, origin: 'https://192.168.1.3:45391' }), encoded);
});
