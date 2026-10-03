import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { isCollectionModel } from '@music-bridge/contracts';
import { exactScalePrepareFrame } from '../helpers/optional-scale-fixture.js';

const binary = { path: process.env.MUSIC_BRIDGE_RUST_BINARY!, sha256: process.env.MUSIC_BRIDGE_RUST_SHA256! };
assert.equal(binary.sha256, '2feb6d5fbe2d875228c5b0de26f016abe6377aee05a7e48977503ece899f21ef');
assert.equal(createHash('sha256').update(readFileSync(binary.path)).digest('hex'), binary.sha256);

async function wire(t: test.TestContext, count: number) {
  const child = spawn(binary.path, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(binary.path), env: { LANG: 'C.UTF-8' } });
  child.stderr.resume(); const exit = once(child, 'close'); let ended = false; child.once('close', () => { ended = true; });
  t.after(async () => { if (!ended) { child.kill('SIGKILL'); await exit; } });
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const identity = { epoch: randomUUID(), datasetId: randomUUID(), snapshotId: randomUUID() }; let sequence = 0;
  const frames: { operation: string; bytesWithoutLF: number; sha256: string; ok: boolean; errorCode?: string }[] = [];
  async function rpc(operation: string, payload: unknown, bytesWithoutLF?: number) {
    const requestId = randomUUID(), encoded = JSON.stringify({ protocolVersion: 3, requestId, ...identity, sequence: ++sequence, operation, payload });
    const base = Buffer.byteLength(encoded); assert.ok(bytesWithoutLF === undefined || bytesWithoutLF >= base);
    // RAW_WIRE_NONCANONICAL_PADDING：标准合法 JSON 尾部空白，payload仍是合法DTO。
    const frame = Buffer.from(encoded + ' '.repeat((bytesWithoutLF ?? base) - base) + '\n');
    await new Promise<void>((resolve, reject) => child.stdin.write(frame, error => error ? reject(error) : resolve()));
    const next = await replies.next(); assert.equal(next.done, false); const reply = JSON.parse(next.value!) as { requestId: string; ok: boolean; error?: { code: string } };
    assert.equal(reply.requestId, requestId);
    frames.push({ operation, bytesWithoutLF: frame.length - 1, sha256: createHash('sha256').update(frame).digest('hex'), ok: reply.ok, ...(reply.error ? { errorCode: reply.error.code } : {}) });
    return reply;
  }
  assert.equal((await rpc('prepare', { modelCount: count })).ok, true);
  return { rpc, frames, async finish(success: boolean) {
    if (success) { assert.equal((await rpc('commitBoot', {})).ok, true); assert.equal((await rpc('close', {})).ok, true); child.stdin.end(); }
    const actualExit = await exit; assert.deepEqual(actualExit, [success ? 0 : 1, null]);
    t.diagnostic(JSON.stringify({ scope: 'RAW_WIRE_NONCANONICAL_PADDING_NOT_CANONICAL_SIDECAR_CAPABILITY', binarySha256: binary.sha256, pid: child.pid, frames, actualExit, closeAcknowledged: success, expectedNativeGuardRejection: !success }));
  } };
}

for (const delta of [-1, 0, 1]) test(`独立raw wire合法JSON空白padding append帧1MiB${delta >= 0 ? '+' : ''}${delta}`, { timeout: 30_000 }, async t => {
  const model = exactScalePrepareFrame(4_194_303).models[0]!; assert.equal(isCollectionModel(model), true);
  const f = await wire(t, 1), reply = await f.rpc('appendSnapshot', { chunkIndex: 0, models: [model] }, 1_048_576 + delta);
  assert.equal(reply.ok, delta <= 0); if (delta > 0) assert.equal(reply.error?.code, 'CAPACITY_EXCEEDED');
  await f.finish(delta <= 0);
});

for (const delta of [-1, 0, 1]) test(`独立raw wire合法DTO累计上传8MiB+64KiB${delta >= 0 ? '+' : ''}${delta}含LF`, { timeout: 30_000 }, async t => {
  const models = exactScalePrepareFrame(4_194_303).models.slice(0, 1_152).map(({ featuredPhoto: _photo, photoCount: _count, ...model }) => ({
    ...model, brand: 'T', name: 'N', edition: 'E', lengths: [90], minimumSealedReserve: 0, revision: 1,
    counts: { total: 1, sealedBlank: 1, openedBlank: 0, legacyUsed: 0, recorded: 0, reserved: 0, unavailable: 0, unknown: 0 },
  })); assert.ok(models.every(isCollectionModel));
  const f = await wire(t, models.length), max = 8_388_608 + 65_536;
  for (let chunkIndex = 0; chunkIndex < 9; chunkIndex++) {
    const length = chunkIndex < 8 ? 1_048_576 : max + delta - 8 * (1_048_576 + 1) - 1;
    const reply = await f.rpc('appendSnapshot', { chunkIndex, models: models.slice(chunkIndex * 128, (chunkIndex + 1) * 128) }, length);
    assert.equal(reply.ok, chunkIndex < 8 || delta <= 0); if (!reply.ok) assert.equal(reply.error?.code, 'CAPACITY_EXCEEDED');
  }
  assert.equal(f.frames.filter(frame => frame.operation === 'appendSnapshot').reduce((total, frame) => total + frame.bytesWithoutLF + 1, 0), max + delta);
  await f.finish(delta <= 0);
});
