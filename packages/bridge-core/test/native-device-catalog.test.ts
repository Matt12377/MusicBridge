import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { createNativeReadonlyDeviceCatalog } from '../src/recording/native-device-catalog.js';
import type { PinnedDeviceOutputHelper } from '../src/recording/bundled-device-output-helper.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function pin(): Promise<PinnedDeviceOutputHelper> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-native-catalog-'));
  const helper = path.join(directory, 'helper'), manifest = path.join(directory, 'manifest.json');
  const helperBytes = Buffer.from('只读目录受控Fake，不运行HAL'), manifestBytes = Buffer.from('{}');
  await writeFile(helper, helperBytes); await chmod(helper, 0o755); await writeFile(manifest, manifestBytes);
  return { path: helper, sha256: sha(helperBytes), manifestPath: manifest,
    manifestSha256: sha(manifestBytes), sourceSha256: 'a'.repeat(64), drainAlgorithmId: 'hal-sample-zero-cover-v1' };
}
function response(operation: 1 | 2, status: 0 | 1, uid = 'exact-uid'): Buffer {
  const count = status === 0 ? 1 : 0, size = operation === 1 ? 392 : status === 0 ? 152 : 0;
  const bytes = Buffer.alloc(16 + size);
  bytes.write('MBIR'); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(operation, 6);
  bytes.writeUInt16LE(status, 8); bytes.writeUInt16LE(count, 10);
  if (operation === 1) {
    const name = Buffer.from('受控输出设备');
    bytes.writeUInt16LE(Buffer.byteLength(uid), 16); bytes.writeUInt16LE(name.length, 18);
    bytes[20] = 1; bytes.write(uid, 24); name.copy(bytes, 152);
  } else if (status === 0) {
    bytes.writeUInt16LE(Buffer.byteLength(uid), 16);
    bytes.writeUInt16LE(1, 18); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
    bytes.writeUInt32LE(48_000, 24); bytes.writeUInt32LE(256, 28);
    bytes[32] = 1; bytes[33] = 1; bytes.write(uid, 40);
  }
  return bytes;
}
class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  constructor(private readonly answer: (input: Buffer) => Buffer) {
    super();
    this.stdin.on('data', (input: Buffer) => {
      assert.equal(input.length, 144); assert.equal(input.toString('ascii', 0, 4), 'MBIQ');
      this.stdout.write(this.answer(input)); queueMicrotask(() => this.emit('close', 0));
    });
  }
  kill() { queueMicrotask(() => this.emit('close', null)); return true; }
}

test('只读Native目录按调用才启动，列表与精确UID观测分开，绝不读默认设备', async () => {
  const helper = await pin(), calls: number[] = [];
  const catalog = createNativeReadonlyDeviceCatalog(helper, { launch(_file, args) {
    assert.deepEqual(args, ['--inspect']);
    return new FakeProcess(input => {
      const operation = input.readUInt16LE(6) as 1 | 2; calls.push(operation);
      if (operation === 1) assert.equal(input.readUInt16LE(8), 0);
      else assert.equal(input.toString('utf8', 16, 25), 'exact-uid');
      return response(operation, 0);
    }) as unknown as ChildProcess;
  } });
  assert.deepEqual(calls, [], '构造目录不触发HAL');
  const signal = new AbortController().signal, listed = await catalog.list(signal);
  assert.equal(listed.length, 1); assert.equal(listed[0]?.uid, 'exact-uid');
  assert.match(listed[0]!.endpointId, /^dev_[a-f0-9]{24}$/u);
  const observed = await catalog.observeExact('exact-uid', signal);
  assert.equal(observed?.endpointId, listed[0]?.endpointId);
  assert.equal(observed?.sampleRate, 48_000); assert.equal(observed?.bufferFrames, 256);
  assert.match(observed!.configurationFingerprintSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(calls, [1, 2]);
});

test('只读目录拒绝身份漂移、错误UID、协议尾字节与事前撤销', async () => {
  const helper = await pin(), signal = new AbortController().signal;
  const wrongUid = createNativeReadonlyDeviceCatalog(helper, { launch: () =>
    new FakeProcess(() => response(2, 0, 'other-uid')) as unknown as ChildProcess });
  await assert.rejects(wrongUid.observeExact('exact-uid', signal));
  const trailing = createNativeReadonlyDeviceCatalog(helper, { launch: () =>
    new FakeProcess(() => Buffer.concat([response(1, 0), Buffer.from([1])])) as unknown as ChildProcess });
  await assert.rejects(trailing.list(signal));
  const controller = new AbortController(); controller.abort();
  let starts = 0;
  const aborted = createNativeReadonlyDeviceCatalog(helper, { launch: () => {
    ++starts; assert.fail('事前撤销不得启动只读helper');
  } });
  await assert.rejects(aborted.list(controller.signal)); assert.equal(starts, 0);
  await writeFile(helper.path, '固定helper已漂移');
  await assert.rejects(trailing.list(signal));
});
