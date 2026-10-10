/** 实际资料档案的同 profile 备份恢复门禁；不接受生产 profile。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openCollectionDataset } from '../packages/bridge-core/src/recording/restore-dataset-runtime.js';
import { createArchiveBackup } from '../packages/bridge-core/src/recording/backup-package.js';
import { createBackupCoordinator } from '../packages/bridge-core/src/recording/backup-coordinator.js';
import { authorizeSourceDirectory } from '../packages/bridge-core/src/recording/source-files.js';
import { dispatchDatasetCommand, type DatasetDispatchTarget } from '../packages/bridge-core/src/collection/dataset-dispatch.js';
import { createCassetteCatalogService } from '../apps/desktop/src/main/cassette-catalog-service.js';

const [profile, importEvidence, evidence] = process.argv.slice(2);
if (!profile || !importEvidence || !evidence || !profile.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-tape-r3-')
  || !/^musicbridge-ui-e2e-tape-r3[A-Za-z0-9._-]*$/u.test(path.basename(profile))
  || !evidence.startsWith('/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-tape-r3-')) throw new Error('恢复门禁只接受外置任务隔离目录。');
assert.equal(process.versions.node.split('.')[0], '22');
const imported = JSON.parse(await readFile(importEvidence, 'utf8')) as { archive: { sha256: string }; revisionId: string; datasetId: string };
const directory = path.join(profile, 'data');
await mkdir(evidence, { recursive: true, mode: 0o700 });
const backupPath = path.join(evidence, 'backup'), restorePath = path.join(evidence, 'restore');
await mkdir(backupPath, { mode: 0o700 }); await mkdir(restorePath, { mode: 0o700 });
let dataset = await openCollectionDataset(directory);
const before = dataset.repository.catalog.revision({ id: imported.revisionId });
assert.equal(dataset.datasetId, imported.datasetId);
const reference = before.revision.items.find(item => item.archive?.primaryAssetId)!;
const preview = { archiveSha256: imported.archive.sha256, expectedDatasetId: dataset.datasetId, expectedCurrentRevisionId: before.revision.id };
const destination = { ...await authorizeSourceDirectory(backupPath), id: randomUUID() };
const backup = await createArchiveBackup({ repository: dataset.repository, destination, id: randomUUID(), mode: 'metadata', userConfirmed: true, signal: new AbortController().signal });
assert.equal(backup.manifest.contentIncluded, false);
const coordinator = createBackupCoordinator({ store: dataset.store, repository: dataset.repository, privateRoot: dataset.privateRoot });
const source = await coordinator.authorize({ commandId: randomUUID(), kind: 'backup-source', absolutePath: backup.directory.path });
const restoreDestination = await coordinator.authorize({ commandId: randomUUID(), kind: 'restore-destination', absolutePath: restorePath });
const verification = coordinator.start({ commandId: randomUUID(), kind: 'verify', rootId: source.id, userConfirmed: true });
await coordinator.idle(); assert.equal(dataset.store.job(verification.id).view.state, 'succeeded');
const restore = coordinator.start({ commandId: randomUUID(), kind: 'restore', rootId: source.id, destinationId: restoreDestination.id, verificationId: verification.id, userConfirmed: true });
await coordinator.idle(); assert.equal(dataset.store.job(restore.id).view.state, 'succeeded');
const activation = coordinator.activate({ commandId: randomUUID(), restoreJobId: restore.id, expectedActiveId: null, userConfirmed: true, stopPlaybackConfirmed: true });
await coordinator.idle(); assert.equal(dataset.store.activations.get(activation.id).view.state, 'prepared');
await coordinator.close(); dataset.close();
dataset = await openCollectionDataset(directory);
assert.equal(dataset.pendingActivationId, activation.id);
assert.notEqual(dataset.datasetId, imported.datasetId);
assert.ok(dataset.databaseFile.includes('/restored-datasets/'));
assert.equal(dataset.repository.privateReferenceArchiveDirectory?.(), path.join(directory, 'reference-archives'));
dataset.commit();
const restored = dataset.repository.catalog.revision({ id: imported.revisionId });
assert.deepEqual(restored, before);
assert.equal(dataset.repository.list({ offset: 0, limit: 1 }).total, 1);
const runtime = { collection: dataset.repository, commandOutbox: { context: () => ({ datasetId: dataset.datasetId }) } } as DatasetDispatchTarget;
await assert.rejects(dispatchDatasetCommand(runtime, { version: 1, id: randomUUID(), command: 'referenceCatalog.previewArchive', payload: preview }), /资料库已切换/u);
let scopeReads = 0;
const switching = { collection: dataset.repository, commandOutbox: { context: () => ({ datasetId: scopeReads++ === 0 ? dataset.datasetId : randomUUID() }) } } as DatasetDispatchTarget;
await assert.rejects(dispatchDatasetCommand(switching, { version: 1, id: randomUUID(), command: 'referenceCatalog.previewArchive',
  payload: { ...preview, expectedDatasetId: dataset.datasetId } }), /校验期间资料库已切换/u);
const service = createCassetteCatalogService({ dataDirectory: () => directory, chooseArchive: async () => null,
  request: async () => { throw new Error('资料恢复读取不需要业务写入'); } });
const detail = await service.detail({ sha256: imported.archive.sha256, referenceId: reference.referenceId });
assert.ok(detail.sections.some(section => section.title.startsWith('原书正文')));
const originalImage = detail.assets.find(asset => asset.origin === 'book' && asset.id.endsWith(':original'))!;
assert.ok(originalImage);
assert.equal((await service.image(originalImage.url, 'GET')).status, 200);
const restoredDatasetId = dataset.datasetId; dataset.close();
dataset = await openCollectionDataset(directory);
assert.equal(dataset.datasetId, restoredDatasetId);
assert.equal(dataset.pendingActivationId, undefined);
assert.deepEqual(dataset.repository.catalog.revision({ id: imported.revisionId }), before);
assert.equal((await service.image(originalImage.url, 'GET')).status, 200);
dataset.close();
const result = { taskId: 'TAPE-CATALOG-R3', node: process.versions.node, evidenceKind: '实际档案与同 profile 隔离元数据备份恢复；不是跨机器完整内容备份',
  profile, originalDatasetId: imported.datasetId, restoredDatasetId, backupId: backup.manifest.id, restoreJobId: restore.id, activationId: activation.id,
  restoredReferenceCount: restored.revision.items.length, restoredMatchesPreserved: true, nestedDatasetUsesProfileArchiveRoot: true,
  archiveTextReadable: true, originalImageReadable: true, coldRestartReadable: true, oldDatasetPreviewRejected: true,
  datasetSwitchDuringValidationRejected: true, archiveBytesIncludedInBackup: false,
  carryover: ['备份包目前不包含独立磁带档案，跨机器恢复需另保留原 ZIP 并重建档案。'] };
await writeFile(path.join(evidence, 'same-profile-restore.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
