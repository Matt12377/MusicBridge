import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isScanJobRecord,
  isLocalMBQueueEntryRecord,
  type ScanJobRecord,
  type LocalMBQueueEntryRecord,
} from '../../src/local-domain-references.js';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scan = (): ScanJobRecord => ({
  schemaVersion: '1.2', jobId: id(1), datasetId: id(2), libraryRootId: id(3), sourceRootId: id(4),
  rootRevision: '1', jobRevision: '2', checkpointRef: id(5),
  progress: { visited: '10', accepted: '8', rejected: '2' }, phase: 'paused', failureCode: null,
});
const entry = (): LocalMBQueueEntryRecord => ({
  schemaVersion: '1.2', datasetId: id(2), entryId: id(6), queueId: id(7),
  queueRevision: '3', entryRevision: '4', orderIndex: '0',
  localSourceSnapshot: {
    sourceKind: 'local_file', trackId: id(8), assetId: id(9), libraryRootId: id(3), sourceRootId: id(4),
    rootRevision: '1', fileRevision: '2', locationRevision: '3', selectionRevision: '4',
    segment: { id: id(10), startFrame: '9007199254740992', endFrameExclusive: '9007199254740993', timebaseHz: 48000 },
  },
  target: { coreId: 'core-合成', zoneId: 'zone-合成' }, restartPolicy: { reResolve: true, autoplay: false },
});
const roundtrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// 每项拒绝只输出布尔结果，避免断言日志展开持久对象或 locator。
const scanRejects = (v: unknown): void => assert.equal(isScanJobRecord(v), false);
const entryRejects = (v: unknown): void => assert.equal(isLocalMBQueueEntryRecord(v), false);

test('MBRS002 持久引用合同：JSON往返保留扫描checkpoint和精确本地片段', () => {
  const job = scan(); const item = entry();
  assert.equal(isScanJobRecord(job), true);
  assert.equal(isLocalMBQueueEntryRecord(item), true);
  const coldJob = roundtrip(job); const coldEntry = roundtrip(item);
  assert.equal(isScanJobRecord(coldJob), true);
  assert.equal(isLocalMBQueueEntryRecord(coldEntry), true);
  assert.equal(JSON.stringify(coldJob), JSON.stringify(job));
  assert.equal(JSON.stringify(coldEntry), JSON.stringify(item));
  assert.equal(isLocalMBQueueEntryRecord({ ...item, target: null, localSourceSnapshot: { ...item.localSourceSnapshot, segment: null } }), true);
  entryRejects({ ...item, localSourceSnapshot: { ...item.localSourceSnapshot,
    segment: { ...item.localSourceSnapshot.segment!, startFrame: '9007199254740993' } } });
});

test('MBRS002 持久引用合同：同track可拥有独立entry和排序修订', () => {
  const first = entry(); const second = { ...entry(), entryId: id(11), entryRevision: '5', orderIndex: '1' };
  assert.equal(isLocalMBQueueEntryRecord(first), true);
  assert.equal(isLocalMBQueueEntryRecord(second), true);
  assert.equal(first.localSourceSnapshot.trackId, second.localSourceSnapshot.trackId);
  assert.notEqual(first.entryId, second.entryId);
  assert.equal(first.queueId, second.queueId);
  entryRejects({ ...first, entryId: 'roon-native-queue-item' });
  entryRejects({ ...first, queueId: 'roon-native-queue' });
});

test('MBRS002 持久引用合同：相邻超JS安全整数修订和计数无损保留', () => {
  const job = { ...scan(), rootRevision: '9007199254740992', jobRevision: '9007199254740993',
    progress: { visited: '9007199254740993', accepted: '9007199254740992', rejected: '1' } };
  const item = entry(); item.queueRevision = '9007199254740992'; item.entryRevision = '9007199254740993';
  item.localSourceSnapshot.fileRevision = '9007199254740992';
  item.localSourceSnapshot.locationRevision = '9007199254740993';
  assert.equal(isScanJobRecord(job), true); assert.equal(isLocalMBQueueEntryRecord(item), true);
  const coldJob = roundtrip(job); const cold = roundtrip(item);
  assert.equal(coldJob.jobRevision, '9007199254740993');
  assert.equal(cold.queueRevision, '9007199254740992');
  assert.equal(cold.entryRevision, '9007199254740993');
  assert.notEqual(cold.localSourceSnapshot.fileRevision, cold.localSourceSnapshot.locationRevision);
  scanRejects({ ...job, jobRevision: 9007199254740992 });
  entryRejects({ ...item, entryRevision: '18446744073709551616' });
  entryRejects({ ...item, queueRevision: '01' });
  entryRejects({ ...item, orderIndex: '-1' });
});

test('MBRS002 持久引用合同：所有记录层拒绝undefined和URL路径session原生queue扩展', () => {
  const job = scan(); const item = entry();
  scanRejects({ ...job, checkpointRef: undefined });
  entryRejects({ ...item, target: undefined });
  entryRejects({ ...item, localSourceSnapshot: { ...item.localSourceSnapshot, segment: undefined } });
  for (const key of ['rawURL', 'path', 'session', 'nativeQueueId', 'generation', 'attempt', 'providerToken', 'controllerGeneration']) {
    scanRejects({ ...job, [key]: 'synthetic-forbidden' });
    entryRejects({ ...item, [key]: 'synthetic-forbidden' });
    entryRejects({ ...item, localSourceSnapshot: { ...item.localSourceSnapshot, [key]: 'synthetic-forbidden' } });
    entryRejects({ ...item, target: { ...item.target!, [key]: 'synthetic-forbidden' } });
    entryRejects({ ...item, restartPolicy: { ...item.restartPolicy, [key]: 'synthetic-forbidden' } });
    scanRejects({ ...job, progress: { ...job.progress, [key]: 'synthetic-forbidden' } });
  }
  scanRejects({ ...job, checkpointRef: '/synthetic/private-checkpoint' });
  entryRejects({ ...item, target: { coreId: 'https://invalid.example/secret', zoneId: 'zone' } });
  entryRejects({ ...item, target: { coreId: 'core', zoneId: 'session_handle=synthetic' } });
  entryRejects({ ...item, target: { coreId: 'a'.repeat(513), zoneId: 'zone' } });
  entryRejects({ ...item, target: { coreId: '\ud800', zoneId: 'zone' } });
  assert.equal(isLocalMBQueueEntryRecord({ ...item, target: { coreId: '🎵'.repeat(256), zoneId: 'zone' } }), true);
  entryRejects({ ...item, target: { coreId: '🎵'.repeat(257), zoneId: 'zone' } });
  const validSegment = item.localSourceSnapshot.segment!;
  const snapshotWith = (segment: unknown) => ({ ...item, localSourceSnapshot: { ...item.localSourceSnapshot, segment } });
  assert.equal(isLocalMBQueueEntryRecord(snapshotWith({ ...validSegment })), true);
  const hiddenLocator = { ...validSegment };
  Object.defineProperty(hiddenLocator, 'path', { value: 'synthetic-forbidden', enumerable: false });
  entryRejects(snapshotWith(hiddenLocator));
  entryRejects(snapshotWith({ ...validSegment, [Symbol('session')]: 'synthetic-forbidden' }));
  const inherited = { ...validSegment };
  Object.setPrototypeOf(inherited, { providerToken: 'synthetic-forbidden' });
  entryRejects(snapshotWith(inherited));
  const nonenumerableRequired = { ...validSegment };
  Object.defineProperty(nonenumerableRequired, 'startFrame', { enumerable: false });
  entryRejects(snapshotWith(nonenumerableRequired));

});

test('MBRS002 持久引用合同：dataset与root/file/location/selection的ABA快照分别保留', () => {
  const saved = entry();
  const changed = roundtrip(saved);
  changed.datasetId = id(12);
  changed.localSourceSnapshot.rootRevision = '2';
  changed.localSourceSnapshot.fileRevision = '3';
  changed.localSourceSnapshot.locationRevision = '4';
  changed.localSourceSnapshot.selectionRevision = '5';
  assert.equal(isLocalMBQueueEntryRecord(saved), true);
  assert.equal(isLocalMBQueueEntryRecord(changed), true);
  const cold = roundtrip(changed);
  assert.notEqual(saved.datasetId, cold.datasetId);
  for (const key of ['rootRevision', 'fileRevision', 'locationRevision', 'selectionRevision'] as const) {
    assert.notEqual(saved.localSourceSnapshot[key], cold.localSourceSnapshot[key]);
    entryRejects({ ...saved, localSourceSnapshot: { ...saved.localSourceSnapshot, [key]: undefined } });
    entryRejects({ ...saved, localSourceSnapshot: { ...saved.localSourceSnapshot, [key]: '0' } });
  }
  entryRejects({ ...saved, datasetId: 'path-as-dataset' });
  // 结构 guard 接受两个历史快照；当前 scope/权限/ABA拒绝由 resolver 和 owner 实测。
});

test('MBRS002 持久引用合同：restart禁止自动播放且扫描phase/progress闭集一致', () => {
  const item = entry();
  entryRejects({ ...item, restartPolicy: { reResolve: false, autoplay: false } });
  entryRejects({ ...item, restartPolicy: { reResolve: true, autoplay: true } });
  entryRejects({ ...item, restartPolicy: { reResolve: true, autoplay: false, resumeSession: 'synthetic' } });
  const job = scan();
  assert.equal(isScanJobRecord({ ...job, phase: 'pending', checkpointRef: null,
    progress: { visited: '0', accepted: '0', rejected: '0' } }), true);
  assert.equal(isScanJobRecord({ ...job, phase: 'running' }), true);
  assert.equal(isScanJobRecord({ ...job, phase: 'cancelled' }), true);
  assert.equal(isScanJobRecord({ ...job, phase: 'completed' }), true);
  assert.equal(isScanJobRecord({ ...job, phase: 'failed', failureCode: 'SCAN_READ_FAILED' }), true);
  scanRejects({ ...job, phase: 'Playing' });
  scanRejects({ ...job, phase: 'pending' });
  scanRejects({ ...job, phase: 'failed' });
  scanRejects({ ...job, failureCode: 'SCAN_READ_FAILED' });
  scanRejects({ ...job, phase: 'failed', failureCode: '/synthetic/internal-error' });
  scanRejects({ ...job, progress: { visited: '9', accepted: '8', rejected: '2' } });
  scanRejects({ ...job, phase: 'completed', progress: { visited: '11', accepted: '8', rejected: '2' } });
});
