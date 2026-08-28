import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCollectionRepository } from '../src/collection/repository.js';
import { createBackupWorkflowStore } from '../src/recording/backup-workflow-store.js';
import { createBackupCoordinator } from '../src/recording/backup-coordinator.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-activation-process-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privatePath = path.join(directory, 'private'), backupPath = path.join(directory, 'backup'), restorePath = path.join(directory, 'restore');
  for (const folder of [privatePath, backupPath, restorePath]) await mkdir(folder);
  const repository = createCollectionRepository({ filePath: path.join(privatePath, 'collection.v1.sqlite') });
  const append = (title: string) => repository.drafts.append({ commandId: randomUUID(), fingerprint: randomUUID().replaceAll('-', '').repeat(2), title, programType: 'compilation', metadata: [{ title: '合成曲目' }] });
  append('备份内草稿');
  const store = createBackupWorkflowStore({ filePath: path.join(privatePath, 'backup-maintenance.v1.sqlite') });
  const coordinator = createBackupCoordinator({ store, repository, privateRoot: { ...await authorizeSourceDirectory(privatePath), id: randomUUID() } });
  try {
    const target = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-destination', absolutePath: backupPath });
    const backup = coordinator.start({ commandId: randomUUID(), kind: 'backup', rootId: target.id, mode: 'metadata', userConfirmed: true }); await coordinator.idle();
    const sourceId = store.job(backup.id).view.resultRootId!;
    append('备份后草稿');
    const verified = coordinator.start({ commandId: randomUUID(), kind: 'verify', rootId: sourceId, userConfirmed: true }); await coordinator.idle();
    const destination = await coordinator.authorize({ commandId: randomUUID(), kind: 'restore-destination', absolutePath: restorePath });
    const restored = coordinator.start({ commandId: randomUUID(), kind: 'restore', rootId: sourceId, destinationId: destination.id, verificationId: verified.id, userConfirmed: true }); await coordinator.idle();
    const activation = coordinator.activate({ commandId: randomUUID(), restoreJobId: restored.id, expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true }); await coordinator.idle();
    assert.equal(store.activations.get(activation.id).view.state, 'prepared');
    return { privatePath, activationId: activation.id };
  } finally { await coordinator.close(); repository.close(); }
}

for (const checkpoint of ['before-ready', 'after-ready'] as const) {
  test(`合成Core子进程在${checkpoint}遭SIGKILL，冷启动按已提交指针恢复且不自动播放`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const child = fork(new URL('./helpers/restore-activation-process-child.ts', import.meta.url), [f.privatePath, checkpoint], { execArgv: ['--import', 'tsx'], stdio: ['ignore','ignore','pipe','ipc'] });
    let stderr = ''; child.stderr?.on('data', bytes => { stderr += String(bytes); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
    const message = await new Promise<{ checkpoint: string; drafts: string[]; playback: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('合成Core检查点超时')), 10_000);
      child.once('message', value => { clearTimeout(timeout); resolve(value as { checkpoint: string; drafts: string[]; playback: string }); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`合成Core提前退出：${code}；${stderr}`)); });
    });
    assert.equal(message.checkpoint, checkpoint); assert.deepEqual(message.drafts, ['备份内草稿']); assert.notEqual(message.playback, 'playing');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const { openCollectionDataset } = await import('../src/recording/restore-dataset-runtime.js');
    const cold = await openCollectionDataset(f.privatePath);
    try {
      const titles = cold.repository.drafts.list({ offset: 0, limit: 20 }).items.map(item => item.title).sort();
      assert.deepEqual(titles, checkpoint === 'before-ready' ? ['备份内草稿','备份后草稿'].sort() : ['备份内草稿']);
      assert.equal(cold.store.activations.get(f.activationId).view.state, checkpoint === 'before-ready' ? 'rolled-back' : 'active');
      assert.equal(cold.pendingActivationId, undefined);
    } finally { cold.close(); }
  });
}
