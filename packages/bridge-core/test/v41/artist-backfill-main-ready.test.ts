import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createDatasetDomain, type DatasetDomain } from '../../src/collection/dataset-domain.js';
import { createCollectionRepository } from '../../src/collection/repository.js';
import { createBackupWorkflowStore } from '../../src/recording/backup-workflow-store.js';
import type { DatasetProjectionPort, DatasetWorkbenchExecutionContext } from '../../src/collection/dataset-owner-protocol.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/** 使用生产领域组合与真实双SQLite；空合成库存不取得任何源读取或Provider资格。 */
async function fixture(t: TestContext, deferredBoot = true) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const temporary = path.join(process.env.DEV_BUILD_ROOT ?? '/Volumes/LifeWeave/Developer/CommandLine', 'tmp');
  assert.ok(path.isAbsolute(temporary));
  if (process.platform === 'darwin') assert.ok(temporary.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp'));
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, 'mousa41-backfill-main-ready-'));
  const datasetId = randomUUID();
  let domain: DatasetDomain | undefined, epoch = randomUUID(), enumerations = 0, commits = 0;
  const projection: DatasetProjectionPort = { async call() { throw new Error('本门禁不允许源读取、真实Provider或Roon调用。'); } };
  t.after(async () => { try { await domain?.close(); } finally { await rm(directory, { recursive: true, force: true }); } });

  async function assemble() {
    const collection = createCollectionRepository({ filePath: path.join(directory, 'collection.sqlite') });
    const maintenance = createBackupWorkflowStore({ filePath: path.join(directory, 'workflow.sqlite') });
    const catalog = collection.localCatalog, enumerate = catalog.privateArtistMetadataBackfillCandidates;
    t.mock.method(catalog, 'privateArtistMetadataBackfillCandidates', (...args: Parameters<typeof enumerate>) => {
      enumerations++; return enumerate.apply(catalog, args);
    });
    domain = createDatasetDomain({ collectionRepository: collection, backupWorkflowStore: maintenance,
      collectionDatasetIdentity: { datasetId, assertCurrent() { collection.list({ offset: 0, limit: 1 }); } },
      localSourceEpoch: epoch, projection,
      ...(deferredBoot ? { commitBoot() { commits++; } } : {}),
    });
    await domain.prepareWorkbench();
  }
  await assemble();
  const context = (): DatasetWorkbenchExecutionContext => ({ identity: { datasetId, epoch },
    signal: new AbortController().signal, deadlineAtMs: performance.now() + 5000 });
  return {
    get domain() { return domain!; }, get enumerations() { return enumerations; }, get commits() { return commits; },
    context, async ack(value = context()) { return domain!.dispatchWorkbenchOwner!({ command: 'lifecycle.mainReady', payload: {} }, value); },
    async tick() { t.mock.timers.tick(0); await turn(); },
    async reopen() { await domain!.close(); epoch = randomUUID(); await assemble(); },
  };
}

test('艺人回填在commit与前台刷新后仍等待Main-ready，同代重复ACK不重新枚举', async t => {
  const f = await fixture(t);
  await assert.rejects(f.ack(), { code: 'INVENTORY_UNAVAILABLE' });
  await f.domain.commitBoot(); await f.tick();
  assert.equal(f.commits, 1); assert.equal(f.enumerations, 0);
  await f.domain.workbenchContext!(); await f.domain.workbenchReadIdentity!();
  await f.domain.dispatchWorkbenchOwner!({ command: 'capabilities.read', payload: {} }, f.context());
  await f.domain.localArtists!.refresh(); await f.tick();
  assert.equal(f.enumerations, 0, '前台刷新完成不能提前恢复后台补读');

  assert.deepEqual(await Promise.all([f.ack(), f.ack(), f.ack()]), [true, true, true]);
  await f.tick(); assert.equal(f.enumerations, 1);
  await f.ack(); await f.tick(); assert.equal(f.enumerations, 1);
  await f.domain.localArtists!.refresh(); await f.tick();
  assert.equal(f.enumerations, 2, '本代Main仍有效时，交互刷新后恢复原补读调度');
});

test('预先boot的生产领域工厂也不抢跑，关闭后同Dataset新epoch重新等待ACK', async t => {
  const f = await fixture(t, false);
  await f.tick(); assert.equal(f.enumerations, 0);
  await f.domain.localArtists!.refresh(); await f.tick(); assert.equal(f.enumerations, 0);
  await f.ack(); await f.tick(); assert.equal(f.enumerations, 1);
  const old = f.context();
  await f.reopen(); await f.tick(); assert.equal(f.enumerations, 1);
  await f.domain.localArtists!.refresh(); await f.tick(); assert.equal(f.enumerations, 1);
  await assert.rejects(f.ack(old), { code: 'INVENTORY_UNAVAILABLE' });
  await f.ack(); await f.tick(); assert.equal(f.enumerations, 2);
});

test('失效Main身份与已关闭工作台不能借刷新恢复补读，Owner关闭清除待启动任务', async t => {
  const f = await fixture(t);
  await f.domain.commitBoot();
  const aborted = new AbortController(); aborted.abort();
  for (const context of [
    { ...f.context(), identity: { ...f.context().identity, datasetId: randomUUID() } },
    { ...f.context(), identity: { ...f.context().identity, epoch: randomUUID() } },
    { ...f.context(), signal: aborted.signal }, { ...f.context(), deadlineAtMs: performance.now() - 1 },
  ]) await assert.rejects(f.ack(context), { code: 'INVENTORY_UNAVAILABLE' });
  await f.tick(); assert.equal(f.enumerations, 0);
  await f.ack();
  await f.domain.closeWorkbench!();
  await f.domain.localArtists!.refresh(); await f.tick();
  assert.equal(f.enumerations, 0, '关闭工作台后刷新只能暂停原补读，不能重新启动');
  await assert.rejects(f.ack(), { code: 'NOT_READY' });
  await f.reopen(); await f.domain.commitBoot(); await f.ack();
  await f.domain.close(); await f.tick();
  assert.equal(f.enumerations, 0, 'Owner关闭必须清除ACK刚登记而尚未执行的补读任务');
});
