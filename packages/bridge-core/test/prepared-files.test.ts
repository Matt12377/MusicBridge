import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { createPreparationDirectory, copyPreparationFile, publishPreparation, verifyPublishedPreparation, writePreparationFile } from '../src/recording/preparation-files.js';

test('原始 Render 存入独立保留区，不能落入可编辑的 Logic Sources 或覆盖原件', async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-raw-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = { ...await authorizeSourceDirectory(directory), id: randomUUID() }, id = randomUUID();
  const owned = await createPreparationDirectory(root, id, 'cassette', 'raw-render');
  assert.equal(owned.root.path, path.join(directory, `MusicBridge-OriginalRender-${id}`));
  const bytes = Buffer.from('合成 Render 文件字节'), source = path.join(directory, 'owner.wav'); await writeFile(source, bytes);
  const before = await stat(source, { bigint: true }), expected = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  const signal = new AbortController().signal, output = await copyPreparationFile(owned, 'Originals/A.wav', root, 'owner.wav', expected, signal);
  assert.deepEqual(await readFile(source), bytes); assert.deepEqual(await readFile(path.join(owned.root.path, output.relative)), bytes);
  const after = await stat(source, { bigint: true }); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
  assert.equal(Number((await stat(path.join(owned.root.path, output.relative))).mode) & 0o777, 0o600);
  await assert.rejects(copyPreparationFile(owned, 'Originals/A.wav', root, 'owner.wav', expected, signal));
  await assert.rejects(writePreparationFile(owned, 'Sources/001.wav', bytes));
  await assert.rejects(writePreparationFile(owned, '../owner.wav', bytes));
  const hash = await publishPreparation(owned, [output], Buffer.from('{"kind":"原始 Render"}'), signal);
  assert.equal(await verifyPublishedPreparation(owned, [output], hash), true);
  await writeFile(path.join(owned.root.path, output.relative), Buffer.from('外部修改'));
  assert.equal(await verifyPublishedPreparation(owned, [output], hash), false);
});
