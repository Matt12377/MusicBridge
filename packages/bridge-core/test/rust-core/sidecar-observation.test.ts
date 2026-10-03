import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRustReadonlyDatasetEndpoint } from '../../src/rust-core/readonly-sidecar.js';

function fixture(t: test.TestContext) {
  const child = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
  const frames: Record<string, any>[] = [];
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const frame = JSON.parse(String(chunk)); frames.push(frame);
    const { payload: _payload, ...identity } = frame;
    const result = frame.operation === 'prepare' ? { epoch: frame.epoch, datasetId: frame.datasetId, snapshotId: frame.snapshotId, readOnly: true, capabilities: ['collection.list'], modelCount: 0 } : null;
    setImmediate(() => { stdout.write(JSON.stringify({ ...identity, ok: true, result }) + '\n'); if (frame.operation === 'close') setImmediate(() => child.emit('close', 0, null)); });
    callback();
  } });
  t.mock.method(childProcess, 'spawn', () => Object.assign(child, { pid: 12345, stdin, stdout, stderr, kill() { throw new Error('正常收口不能kill'); } }) as unknown as ChildProcessWithoutNullStreams);
  return { frames };
}

test('可信观察绑定实际发送帧、已验证ACK与自然退出，深冻结且观察拒绝不改变语义', async t => {
  const fake = fixture(t), events: any[] = [];
  const endpoint = createRustReadonlyDatasetEndpoint({
    binary: { path: process.execPath, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') },
    snapshot: { epoch: randomUUID(), datasetId: randomUUID(), snapshotId: randomUUID(), models: [] },
    onObservation(value: unknown) { events.push(value); return Promise.reject(new Error('受控观察拒绝')); },
  } as Parameters<typeof createRustReadonlyDatasetEndpoint>[0]);
  await endpoint.prepare(); await endpoint.commitBoot(); await endpoint.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.map(event => event.event), ['spawn', 'request', 'validated-reply', 'request', 'validated-reply', 'request', 'validated-reply', 'exit']);
  assert.deepEqual(events.find(event => event.event === 'request').frame, fake.frames[0]);
  assert.equal(Object.isFrozen(events[1].frame.payload.models), true);
  assert.equal(events.at(-1).code, 0); assert.equal(events.at(-1).signal, null);
  assert.equal(events.at(-1).closeAcknowledged, true);
});
