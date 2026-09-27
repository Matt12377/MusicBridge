import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadonlyAudioConsumer, readonlyAudioReader } from '../src/recording/readonly-audio-consumer.js';

test('Core只读帧视图不带FD/release/revoke，EOF不冒充后端排空', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-readonly-audio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'frozen.wav'), content = Buffer.alloc(52);
  content.set([1, 2, 3, 4, 5, 6, 7, 8], 44);
  await writeFile(file, content);
  const handle = await open(file, 'r');
  t.after(() => handle.close());
  const owner = createReadonlyAudioConsumer(handle, { dataOffset: 44, frameCount: 2, channelCount: 2, sampleFormat: 'pcm-s16le' }, new AbortController().signal, () => undefined);
  const reader = readonlyAudioReader(owner);
  assert.deepEqual(Reflect.ownKeys(reader).sort(), ['descriptor', 'readFrames']);
  assert.equal(Object.isFrozen(reader), true);
  assert.equal('handle' in reader || 'release' in reader || 'revoke' in reader, false);
  const first = await reader.readFrames(0, 1), last = await reader.readFrames(1, 1);
  assert.deepEqual(first, { bytes: Buffer.from([1, 2, 3, 4]), frames: 1, sourceEof: false });
  assert.deepEqual(last, { bytes: Buffer.from([5, 6, 7, 8]), frames: 1, sourceEof: true });
  assert.equal('backendDrained' in last, false);
  owner.revoke();
  await assert.rejects(reader.readFrames(0, 1), { code: 'LEASE_CLOSED' });
  assert.equal((await handle.stat()).size, 52, '撤销reader不会由provider关闭Core持有的FD');
});
