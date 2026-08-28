import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BackupWorkflowError, createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js';

const unavailable = (error: unknown): boolean => error instanceof BackupWorkflowError && error.code === 'BACKUP_UNAVAILABLE';
const moduleUrl = new URL('../src/recording/backup-workflow-store.ts', import.meta.url).href;

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ledger-safety-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'maintenance.sqlite');
  const store = createBackupWorkflowStore({ filePath });
  t.after(() => store.close());
  return { directory, filePath, store };
}

function runningJob(store: ReturnType<typeof createBackupWorkflowStore>, directory: string) {
  const root = store.authorize({ commandId: randomUUID(), kind: 'backup-destination' }, {
    id: randomUUID(), path: directory, dev: '1', ino: '1', label: '合成目录', authorized: true,
  });
  const job = store.startJob({ commandId: randomUUID(), kind: 'backup', rootId: root.id, mode: 'metadata', userConfirmed: true });
  store.markRunning(job.id);
  return job.id;
}

for (const kind of ['text', 'zero-byte', 'empty-sqlite', 'foreign-sqlite', 'forged-identity'] as const) {
  test(`未知已有文件 ${kind} 被拒绝，内容与权限均不改变`, async t => {
    const f = await fixture(t);
    if (kind === 'text' || kind === 'zero-byte') await writeFile(f.filePath, kind === 'text' ? '保留用户原始内容' : '');
    else {
      const db = new DatabaseSync(f.filePath);
      try {
        db.exec(kind === 'empty-sqlite' ? 'VACUUM' : 'CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES (\'原始数据\');');
        if (kind === 'forged-identity') db.exec('PRAGMA user_version=1; PRAGMA application_id=1296192087;');
      } finally { db.close(); }
    }
    await chmod(f.filePath, 0o640);
    const before = await readFile(f.filePath), mode = (await stat(f.filePath)).mode;
    assert.throws(() => f.store.overview(), unavailable);
    assert.ok((await readFile(f.filePath)).equals(before), '拒绝不得改写已有文件');
    assert.equal((await stat(f.filePath)).mode, mode, '识别前不得修改已有文件权限');
  });
}

test('同进程第二个仓库不能恢复或读取第一仓库的运行任务，拒绝后的 close 也不能释放第一把锁', async t => {
  const f = await fixture(t), id = runningJob(f.store, f.directory);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const second = createBackupWorkflowStore({ filePath: f.filePath });
    try {
      assert.throws(() => second.recoverInterrupted(), unavailable);
      assert.throws(() => second.overview(), unavailable);
    } finally { second.close(); }
    assert.equal(f.store.job(id).view.state, 'running');
  }
  f.store.close();
  const next = createBackupWorkflowStore({ filePath: f.filePath });
  try { next.recoverInterrupted(); assert.equal(next.job(id).view.state, 'interrupted'); }
  finally { next.close(); }
});

test('父目录别名不能绕过同进程账本所有权', async t => {
  const f = await fixture(t), id = runningJob(f.store, f.directory);
  const alias = `${f.directory}-alias`;
  await symlink(path.dirname(f.directory), alias);
  t.after(() => rm(alias, { force: true }));
  const second = createBackupWorkflowStore({ filePath: path.join(alias, path.basename(f.directory), 'maintenance.sqlite') });
  try { assert.throws(() => second.recoverInterrupted(), unavailable); }
  finally { second.close(); }
  assert.equal(f.store.job(id).view.state, 'running');
});

function childAttempt(filePath: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { createBackupWorkflowStore } from ${JSON.stringify(moduleUrl)};
    const store = createBackupWorkflowStore({ filePath: process.argv[1] });
    try { store.recoverInterrupted(); process.stdout.write('opened'); }
    catch (error) { process.stdout.write(error.code ?? 'unexpected'); }
    finally { store.close(); }
  `, filePath], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 10_000 });
}

test('跨进程排他贯穿空闲事务间隙，第二 Core 不得将存活 Core 的任务标为 interrupted', async t => {
  const f = await fixture(t), id = runningJob(f.store, f.directory);
  const result = childAttempt(f.filePath);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'BACKUP_UNAVAILABLE');
  assert.equal(f.store.job(id).view.state, 'running');
  f.store.close();
  const afterClose = childAttempt(f.filePath);
  assert.equal(afterClose.status, 0, afterClose.stderr);
  assert.equal(afterClose.stdout, 'opened');
});

test('持有者被 SIGKILL 后由系统释放锁，新 Core 恢复已提交任务而不依赖超时或 PID 抢锁', { timeout: 15_000 }, async t => {
  const f = await fixture(t), id = runningJob(f.store, f.directory);
  f.store.close();
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { createBackupWorkflowStore } from ${JSON.stringify(moduleUrl)};
    const store = createBackupWorkflowStore({ filePath: process.argv[1] });
    store.cancel({ id: process.argv[2], commandId: crypto.randomUUID() });
    process.send({ ready: true });
    setInterval(() => {}, 1000);
  `, f.filePath, id], { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  });
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(() => { throw new Error(`子进程未就绪：${stderr}`); }),
  ]);
  assert.deepEqual(ready, { ready: true });
  assert.ok((await stat(`${f.filePath}-wal`)).size > 0, '崩溃前必须实际提交 WAL 数据');
  const contender = createBackupWorkflowStore({ filePath: f.filePath });
  try { assert.throws(() => contender.recoverInterrupted(), unavailable); }
  finally { contender.close(); }
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const recovered = createBackupWorkflowStore({ filePath: f.filePath });
  try {
    recovered.recoverInterrupted();
    assert.equal(recovered.job(id).view.state, 'interrupted');
    assert.equal(recovered.job(id).view.issue, 'INTERRUPTED');
  } finally { recovered.close(); }
});

test('独立内存仓库互不争锁，未打开仓库的 close 不影响已打开的持有者', async t => {
  const f = await fixture(t), unopened = createBackupWorkflowStore({ filePath: f.filePath });
  f.store.overview(); unopened.close();
  assert.deepEqual(f.store.overview().jobs, []);
  const first = createBackupWorkflowStore({ filePath: ':memory:' }), second = createBackupWorkflowStore({ filePath: ':memory:' });
  try { first.overview(); second.overview(); assert.notEqual(first, second); }
  finally { first.close(); second.close(); }
});
