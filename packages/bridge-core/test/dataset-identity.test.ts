import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openCollectionDataset } from '../src/recording/restore-dataset-runtime.js';

test('默认实际数据库身份跨冷启动保持，重建数据库必须换身份', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-dataset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await openCollectionDataset(directory);
  const id = (first as typeof first & { datasetId?: string }).datasetId;
  assert.match(id ?? '', /^[0-9a-f-]{36}$/u, '打开的数据库必须提供非空持久身份');
  first.close();
  const cold = await openCollectionDataset(directory);
  assert.equal((cold as typeof cold & { datasetId?: string }).datasetId, id); cold.close();
  await rename(path.join(directory, 'collection.v1.sqlite'), path.join(directory, '原库.sqlite'));
  const rebuilt = await openCollectionDataset(directory);
  try { assert.notEqual((rebuilt as typeof rebuilt & { datasetId?: string }).datasetId, id); }
  finally { rebuilt.close(); }
});

test('运行中的数据库被替换，执行边界不得继续接受旧scope', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-dataset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const opened = await openCollectionDataset(directory);
  try {
    const identity = opened as typeof opened & { assertIdentity?: () => void };
    assert.equal(typeof identity.assertIdentity, 'function', '需要实际打开文件的末端身份核验');
    identity.assertIdentity!();
    await rename(path.join(directory, 'collection.v1.sqlite'), path.join(directory, randomUUID() + '.sqlite'));
    assert.throws(() => identity.assertIdentity!());
  } finally { opened.close(); }
});
