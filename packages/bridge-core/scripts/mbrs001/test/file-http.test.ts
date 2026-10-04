import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { get, type IncomingMessage } from 'node:http';
import test, { type TestContext } from 'node:test';
import { buildStoragePolicy } from '../../../../../apps/desktop/scripts/build-storage-root.mjs';
import { startSyntheticFileHttp, type SyntheticFileHttp, type SyntheticInputDescriptor } from '../file-http.js';

async function fixture(t: TestContext, content?: Buffer): Promise<{
  bytes: Buffer; service: SyntheticFileHttp; mediaUrl: string; directory: string; input: SyntheticInputDescriptor;
}> {
  const policy = buildStoragePolicy();
  const temporaryRoot = policy.check(process.env.TMPDIR!, { mustExist: true });
  // 准入完成后才写合成fixture；不借用户文件或仓库临时目录。
  const directory = await mkdtemp(path.join(temporaryRoot, 'musicbridge-mbrs001-'));
  await chmod(directory, 0o700);
  let service: SyntheticFileHttp | undefined;
  t.after(async () => {
    try { await service?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const bytes = content ?? Buffer.from('MBRS001-synthetic-byte-control-0123456789', 'utf8');
  const input: SyntheticInputDescriptor = {
    kind: 'synthetic', sampleAlias: 'sample-one', relativePath: 'same-name.wav',
    sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  await writeFile(path.join(directory, input.relativePath), bytes, { flag: 'wx', mode: 0o600 });
  service = await startSyntheticFileHttp({ fixtureDirectory: directory, inputs: [input] });
  const mediaUrl = service.registrations[0]!.mediaUrl;
  return { bytes, service, mediaUrl, directory, input };
}

test('MBRS001 FD控制：真实loopback完整GET与预核合成原字节一致', async t => {
  const { bytes, service, mediaUrl } = await fixture(t);
  const response = await fetch(mediaUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await service.waitForRequestsDrained();
  assert.deepEqual(service.resourceSnapshot(), { openFds: 1, closedFds: 0, activeRequestRefs: 0, activeTokens: 1 });
});

test('MBRS001 HEAD控制：忽略Range，完整长度与validator且零body', async t => {
  const { bytes, service, mediaUrl } = await fixture(t);
  const response = await fetch(mediaUrl, { method: 'HEAD', headers: { Range: 'bytes=4-11' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('etag'), `"${createHash('sha256').update(bytes).digest('hex')}"`);
  assert.equal(response.headers.get('content-range'), null);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(service.resourceSnapshot().openFds, 1);
});

test('MBRS001 lease控制：HTTP结束保留FD，revoke拒新请求并实际关闭FD，重复关闭幂等', async t => {
  const { bytes, service, mediaUrl } = await fixture(t);
  const response = await fetch(mediaUrl);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await service.waitForRequestsDrained();
  assert.equal(service.resourceSnapshot().openFds, 1);
  assert.equal(await service.releasedHandlesRejectStat(), false);
  await service.revoke('sample-one');
  assert.equal((await fetch(mediaUrl)).status, 404);
  assert.deepEqual(service.resourceSnapshot(), { openFds: 0, closedFds: 1, activeRequestRefs: 0, activeTokens: 0 });
  assert.equal(await service.releasedHandlesRejectStat(), true);
  await service.revoke('sample-one');
  await service.close();
  await service.close();
  assert.equal(service.resourceSnapshot().closedFds, 1);
});

test('MBRS001 Range RED：代表闭区间应206并只返回固定FD对应原字节', async t => {
  const { bytes, mediaUrl } = await fixture(t);
  const response = await fetch(mediaUrl, { headers: { Range: 'bytes=4-11' } });
  const body = Buffer.from(await response.arrayBuffer());
  // 原200 !== 206有效RED已经封存；保留同一目标行为断言验证GREEN。
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 4-11/${bytes.length}`);
  assert.equal(response.headers.get('content-length'), '8');
  assert.deepEqual(body, bytes.subarray(4, 12));
});

test('MBRS001 Range：开放尾、suffix与过大末尾截取均对照实际FD', async t => {
  const { bytes, mediaUrl } = await fixture(t);
  for (const [range, start, end] of [
    ['bytes=4-', 4, bytes.length - 1], ['bytes=-7', bytes.length - 7, bytes.length - 1],
    ['bytes=4-9999', 4, bytes.length - 1], ['bytes=-9999', 0, bytes.length - 1],
  ] as const) {
    const response = await fetch(mediaUrl, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
});

test('MBRS001 Range：畸形与多Range固定400，不可满足固定416及总长度', async t => {
  const { bytes, mediaUrl } = await fixture(t);
  for (const range of ['bytes=', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1', 'bytes=9-4', 'bytes=9007199254740992-']) {
    const response = await fetch(mediaUrl, { headers: { Range: range } });
    assert.equal(response.status, 400); assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  for (const range of [`bytes=${bytes.length}-`, 'bytes=-0']) {
    const response = await fetch(mediaUrl, { headers: { Range: range } });
    assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});

test('MBRS001 If-Range：精确强ETag匹配206，不匹配完整200；HEAD始终忽略', async t => {
  const { bytes, mediaUrl } = await fixture(t);
  const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
  for (const [validator, status] of [[etag, 206], ['"different"', 200], [`W/${etag}`, 200]] as const) {
    const response = await fetch(mediaUrl, { headers: { Range: 'bytes=4-11', 'If-Range': validator } });
    assert.equal(response.status, status);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), status === 206 ? bytes.subarray(4, 12) : bytes);
  }
  const head = await fetch(mediaUrl, { method: 'HEAD', headers: { Range: 'bytes=0-1,3-4', 'If-Range': etag } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(head.headers.get('content-range'), null); assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('MBRS001 并发：同一FD使用固定position，三个不同Range不串cursor', async t => {
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
  const { mediaUrl, service } = await fixture(t, bytes);
  await Promise.all([[0, 63], [1024, 2047], [4000, 4095]].map(async ([start, end]) => {
    const response = await fetch(mediaUrl, { headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end! + 1));
  }));
  await service.waitForRequestsDrained(); assert.equal(service.resourceSnapshot().activeRequestRefs, 0);
  assert.equal(service.resourceSnapshot().openFds, 1);
});

test('MBRS001 revoke：中止实际在途响应，等refs归零后FD真实关闭', { timeout: 5000 }, async t => {
  const { mediaUrl, service } = await fixture(t, Buffer.alloc(8 * 1024 * 1024, 7));
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(mediaUrl, incoming => { incoming.on('error', () => undefined); incoming.pause(); resolve(incoming); }).on('error', reject);
  });
  assert.ok(service.resourceSnapshot().activeRequestRefs > 0);
  const closed = new Promise<void>(resolve => response.once('close', resolve));
  await service.revoke('sample-one'); response.resume(); await closed;
  assert.equal(service.resourceSnapshot().activeRequestRefs, 0);
  assert.equal(await service.releasedHandlesRejectStat(), true);
  assert.equal((await fetch(mediaUrl)).status, 404);
});

test('MBRS001 身份：预核摘要错拒绝启动，已持FD截断拒绝后续正文', async t => {
  const { service, directory, input, mediaUrl } = await fixture(t);
  await assert.rejects(startSyntheticFileHttp({ fixtureDirectory: directory, inputs: [{ ...input, sha256: '0'.repeat(64) }] }), /字节摘要/u);
  await writeFile(path.join(directory, input.relativePath), Buffer.from('changed'), { mode: 0o600 });
  const response = await fetch(mediaUrl);
  assert.equal(response.status, 409); assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(service.resourceSnapshot().openFds, 1);
});

test('MBRS001 URL：路径和query不能选择filesystem输入', async t => {
  const { mediaUrl } = await fixture(t);
  const response = await fetch(`${mediaUrl}?file=same-name.wav`);
  assert.equal(response.status, 404); assert.equal((await response.arrayBuffer()).byteLength, 0);
});
