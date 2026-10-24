import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openCollectionDataset } from '../src/recording/restore-dataset-runtime.js';
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js';

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

test('macOS稳定卷身份：同卷同inode与birth跨boot仅dev变化时保留原dataset UUID', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-dataset-volume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await openCollectionDataset(directory), original = first.datasetId; first.close();
  const maintenance = path.join(directory, 'backup-maintenance.v1.sqlite');
  const edit = new DatabaseSync(maintenance);
  let currentDevice = '';
  try {
    const row = edit.prepare("SELECT dev FROM dataset_identities WHERE slot='default'").get();
    assert.ok(row && typeof row.dev === 'string'); currentDevice = row.dev;
    edit.prepare("UPDATE dataset_identities SET dev=? WHERE slot='default'").run(String(BigInt(currentDevice) + 1n));
  } finally { edit.close(); }
  const cold = await openCollectionDataset(directory);
  try { assert.equal(cold.datasetId, original, '已持久证明的同一卷和原文件不能因临时设备号变化换UUID。'); cold.assertIdentity(); }
  finally { cold.close(); }
  const inspect = new DatabaseSync(maintenance, { readOnly: true });
  try { assert.equal(inspect.prepare("SELECT dev FROM dataset_identities WHERE slot='default'").get()?.dev, currentDevice); }
  finally { inspect.close(); }
});

test('v3身份升级v4仅在完整原物理身份匹配后锚定，保留原UUID和v3原表SQL', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-dataset-v3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await openCollectionDataset(directory), original = first.datasetId; first.close();
  const maintenance = path.join(directory, 'backup-maintenance.v1.sqlite'), edit = new DatabaseSync(maintenance);
  let originalSQL: unknown, originalRow: unknown;
  try {
    originalSQL = edit.prepare("SELECT sql FROM sqlite_schema WHERE name='dataset_identities'").get()?.sql;
    originalRow = edit.prepare("SELECT * FROM dataset_identities WHERE slot='default'").get();
    edit.exec('DROP TABLE dataset_volume_identities; PRAGMA user_version=3');
  } finally { edit.close(); }
  const cold = await openCollectionDataset(directory);
  try { assert.equal(cold.datasetId, original); cold.assertIdentity(); } finally { cold.close(); }
  const inspect = new DatabaseSync(maintenance, { readOnly: true });
  try {
    assert.equal(inspect.prepare('PRAGMA user_version').get()?.user_version, 4);
    assert.equal(inspect.prepare("SELECT sql FROM sqlite_schema WHERE name='dataset_identities'").get()?.sql, originalSQL);
    assert.deepEqual(inspect.prepare("SELECT * FROM dataset_identities WHERE slot='default'").get(), originalRow);
    const anchor = inspect.prepare("SELECT * FROM dataset_volume_identities WHERE slot='default'").get();
    if (process.platform === 'darwin') {
      assert.ok(anchor); assert.equal(anchor.dataset_id, original);
      assert.match(String(anchor.volume_uuid), /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
      const row = originalRow as { ino: string; birthtime_ns: string };
      assert.equal(anchor.ino, row.ino); assert.equal(anchor.birthtime_ns, row.birthtime_ns);
    } else assert.equal(anchor, undefined, '非Darwin不得合成卷UUID。');
  } finally { inspect.close(); }
});

test('v3缺卷锚点且仅dev漂移必须拒绝，保留旧UUID和物理登记证据', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-dataset-unanchored-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await openCollectionDataset(directory); first.close();
  const maintenance = path.join(directory, 'backup-maintenance.v1.sqlite'), edit = new DatabaseSync(maintenance);
  let expected: unknown;
  try {
    edit.exec('DROP TABLE dataset_volume_identities; PRAGMA user_version=3');
    const row = edit.prepare("SELECT dev FROM dataset_identities WHERE slot='default'").get(); assert.ok(row);
    edit.prepare("UPDATE dataset_identities SET dev=? WHERE slot='default'").run(String(BigInt(String(row.dev)) + 1n));
    expected = edit.prepare("SELECT * FROM dataset_identities WHERE slot='default'").get();
  } finally { edit.close(); }
  await assert.rejects(openCollectionDataset(directory));
  const inspect = new DatabaseSync(maintenance, { readOnly: true });
  try {
    assert.deepEqual(inspect.prepare("SELECT * FROM dataset_identities WHERE slot='default'").get(), expected);
    assert.equal(inspect.prepare('SELECT count(*) n FROM dataset_volume_identities').get()?.n, 0);
  } finally { inspect.close(); }
});

test('稳定卷不同即使inode与birth相同也不得继承UUID，激活库保持拒绝替换', { skip: process.platform !== 'darwin' }, async t => {
  for (const allowReplacement of [false, true]) await t.test(allowReplacement ? '默认替换使用新UUID' : '激活替换拒绝', async child => {
    const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-dataset-other-volume-'));
    child.after(() => rm(directory, { recursive: true, force: true }));
    const first = await openCollectionDataset(directory), file = first.databaseFile; first.close();
    const maintenance = path.join(directory, 'backup-maintenance.v1.sqlite'), slot = allowReplacement ? 'default' : `activation:${randomUUID()}`;
    const seed = createBackupWorkflowStore({ filePath: maintenance });
    let original: string;
    try { original = seed.datasetIdentities.bind(slot, file, allowReplacement).datasetId; } finally { seed.close(); }
    const edit = new DatabaseSync(maintenance);
    try {
      const actual = edit.prepare('SELECT volume_uuid FROM dataset_volume_identities WHERE slot=?').get(slot); assert.ok(actual);
      let other = randomUUID(); while (other === actual.volume_uuid) other = randomUUID();
      // 仅改变测试维护表中已登记的卷；本轮实际卷仍由原生FD读出，不注入执行器或OS事实。
      edit.prepare('UPDATE dataset_volume_identities SET volume_uuid=? WHERE slot=?').run(other, slot);
    } finally { edit.close(); }
    const reopened = createBackupWorkflowStore({ filePath: maintenance });
    try {
      if (allowReplacement) assert.notEqual(reopened.datasetIdentities.bind(slot, file, true).datasetId, original);
      else {
        assert.throws(() => reopened.datasetIdentities.assertKnown(slot, file));
        assert.throws(() => reopened.datasetIdentities.bind(slot, file, false));
      }
    } finally { reopened.close(); }
  });
});

test('运行期原文件即使逐字复制回原路径也不取得旧身份', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-dataset-copy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const opened = await openCollectionDataset(directory), original = opened.databaseFile, moved = path.join(directory, '原库.sqlite');
  try {
    opened.assertIdentity(); await rename(original, moved); await copyFile(moved, original);
    assert.throws(() => opened.assertIdentity());
  } finally { opened.close(); }
});

test('schema4未知辅助表结构在写入前拒绝，原字节和旧身份不改写', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'musicbridge-dataset-schema4-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await openCollectionDataset(directory); first.close();
  const maintenance = path.join(directory, 'backup-maintenance.v1.sqlite'), edit = new DatabaseSync(maintenance);
  try { edit.exec('ALTER TABLE dataset_volume_identities ADD COLUMN untrusted TEXT'); } finally { edit.close(); }
  const before = await readFile(maintenance);
  const rejected = createBackupWorkflowStore({ filePath: maintenance });
  try { assert.throws(() => rejected.overview()); } finally { rejected.close(); }
  assert.deepEqual(await readFile(maintenance), before);
});
