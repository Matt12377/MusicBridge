import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import type { LocalRelocationPlanGetResult, LocalRelocationPlanReceipt } from '@music-bridge/contracts';
import { createDatasetOwnerClient } from '../src/collection/dataset-owner-client.js';
import { DatasetOwnerDispatchError, DatasetOwnerTransportError, isDatasetCollectionSnapshot } from '../src/collection/dataset-owner-protocol.js';

const executeFile = promisify(execFile);
async function material(t: test.TestContext): Promise<string> {
  const temporary = path.resolve(os.tmpdir()), external = '/Volumes/LifeWeave/Developer/CommandLine/tmp';
  const hosted = process.env.GITHUB_ACTIONS === 'true' && Boolean(process.env.RUNNER_TEMP);
  if (process.platform === 'darwin' && !hosted && temporary !== external && !temporary.startsWith(external + '/')) throw new Error('本机搬迁启动测试必须使用外置临时根。');
  const directory = await mkdtemp(path.join(temporary, 'musicbridge-relocation-bootstrap-'));
  const privateDirectory = path.join(directory, 'local-relocation');
  await mkdir(privateDirectory, { mode: 0o700 }); await chmod(privateDirectory, 0o755);
  t.diagnostic(`仅自有空库；有限搬迁资格明确不可用：${directory}`);
  return directory;
}
function endpointFor(directory: string) {
  const worker = new Worker(new URL('./helpers/dataset-owner-domain-fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'], workerData: { dataDirectory: directory },
  });
  const endpoint = createDatasetOwnerClient({ worker });
  return { endpoint, worker };
}
async function close(endpoint: ReturnType<typeof createDatasetOwnerClient>, worker: Worker): Promise<void> {
  const exited = once(worker, 'exit'); await endpoint.close(); assert.deepEqual(await exited, [0]);
}
async function unqualifiedContext(endpoint: ReturnType<typeof createDatasetOwnerClient>, datasetId: string) {
  const context = await endpoint.dispatch({ version: 1, id: randomUUID(), expectedDatasetId: datasetId,
    command: 'localRelocationPlan.get', payload: { datasetId, selector: { kind: 'context' } } }) as LocalRelocationPlanGetResult;
  assert.equal(context.kind, 'context'); if (context.kind !== 'context') throw new Error('搬迁上下文种类错误。');
  assert.equal(context.qualification.state, 'unqualified'); assert.equal(context.qualification.proofFingerprint, null);
  assert.equal(context.qualification.issue?.code, 'UNQUALIFIED'); assert.equal(context.policy.enabled, false);
  const commandId = randomUUID();
  const rejected = await endpoint.dispatch({ version: 1, id: randomUUID(), expectedDatasetId: datasetId,
    command: 'localRelocationPlan.setPolicy', payload: { datasetId, commandId, enabled: true, expectedPolicyRevision: context.policy.revision } }) as LocalRelocationPlanReceipt;
  assert.equal(rejected.outcome, 'rejected'); assert.equal(rejected.issue?.code, 'UNQUALIFIED'); assert.equal(rejected.policy, null);
  const after = await endpoint.dispatch({ version: 1, id: randomUUID(), expectedDatasetId: datasetId,
    command: 'localRelocationPlan.get', payload: { datasetId, selector: { kind: 'context' } } }) as LocalRelocationPlanGetResult;
  assert.equal(after.kind, 'context'); if (after.kind === 'context') assert.deepEqual(after.policy, context.policy);
  return commandId;
}

test('无搬迁资格的新库仍经原真实两库Worker启动和导出，启用请求保持拒绝', async t => {
  const directory = await material(t), { endpoint, worker } = endpointFor(directory);
  t.after(() => endpoint.close());
  const identity = await endpoint.prepare(); await endpoint.commitBoot();
  await unqualifiedContext(endpoint, identity.datasetId);
  await endpoint.dispatch({ version: 1, id: randomUUID(), expectedDatasetId: identity.datasetId, command: 'collection.receive', payload: {
    commandId: randomUUID(), model: { brand: '合成品牌', name: '资格不可用的旧收藏', edition: '自有测试', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
    lengthMinutes: 90, quantities: { sealedBlank: 1, openedBlank: 0, legacyUsed: 0, unclassified: 0 },
  } });
  const first = await endpoint.exportCollectionSnapshot(), second = await endpoint.exportCollectionSnapshot();
  assert.equal(isDatasetCollectionSnapshot(first), true); assert.equal(first.datasetId, identity.datasetId); assert.equal(first.epoch, identity.epoch);
  assert.equal(first.models.length, 1); assert.deepEqual(second.models, first.models); assert.notEqual(first.snapshotId, second.snapshotId);
  await close(endpoint, worker);
});

test('资格不可用不会吞掉原搬迁journal损坏，下一真实Owner仍拒绝prepare', async t => {
  const directory = await material(t), first = endpointFor(directory); t.after(() => first.endpoint.close());
  const identity = await first.endpoint.prepare(); await first.endpoint.commitBoot();
  const commandId = await unqualifiedContext(first.endpoint, identity.datasetId); await close(first.endpoint, first.worker);
  const file = path.join(directory, 'collection.v1.sqlite'), database = new DatabaseSync(file, { readOnly: true });
  let payload: string;
  try {
    const rows = database.prepare('SELECT request FROM local_catalog_ledger WHERE command_id=? AND operation=?').all(commandId, 'LOCAL_RELOCATION_V1');
    assert.equal(rows.length, 1); assert.equal(typeof rows[0]!.request, 'string'); payload = rows[0]!.request as string;
  } finally { database.close(); }
  // 只破坏已经关闭的自有数据库文件；不移除正式journal的SQL不可改写守卫。
  const original = await readFile(file), serialized = Buffer.from(payload), offset = original.indexOf(serialized);
  assert.ok(offset >= 0); assert.equal(original.lastIndexOf(serialized), offset);
  const marker = '"eventHash":"', hashOffset = payload.indexOf(marker) + marker.length;
  assert.ok(hashOffset >= marker.length); assert.match(payload[hashOffset]!, /^[0-9a-f]$/u);
  const changed = Buffer.from(original); changed[offset + hashOffset] = payload[hashOffset] === '0' ? 0x31 : 0x30;
  assert.notDeepEqual(changed, original); await writeFile(file, changed);
  const second = endpointFor(directory); t.after(() => second.endpoint.close());
  await assert.rejects(second.endpoint.prepare(), error => error instanceof DatasetOwnerDispatchError);
  await assert.rejects(second.endpoint.exportCollectionSnapshot(), error => error instanceof DatasetOwnerTransportError && error.outcome === 'not-sent');
  await close(second.endpoint, second.worker);
});

test('实际JS模板生成的Linux mountinfo正则在Python执行并保持空格与反斜线原字节', async () => {
  const source = await readFile(new URL('../src/collection/source-relocation-root-identity.ts', import.meta.url), 'utf8');
  const literal = /const nativeIdentityScript = (`[\s\S]*?`);/u.exec(source)?.[1];
  assert.ok(literal); assert.equal(literal.includes('${'), false);
  const cooked: unknown = runInNewContext(literal, Object.create(null)); assert.equal(typeof cooked, 'string');
  const expression = /return re\.sub\(rb'([^']+)'/u.exec(cooked as string)?.[1]; assert.ok(expression);
  const python = 'import re,sys,json\np=re.compile(sys.argv[1].encode())\nraw=b"/owned"+bytes([92])+b"040path"+bytes([92])+b"134tail"\nprint(json.dumps(list(p.sub(lambda m:bytes([int(m.group(1),8)]),raw))))';
  const result = await executeFile('/usr/bin/python3', ['-I', '-S', '-B', '-c', python, expression], { timeout: 5000, maxBuffer: 16384, env: { LANG: 'C', LC_ALL: 'C' } });
  assert.equal(result.stderr, ''); assert.deepEqual(JSON.parse(result.stdout), [...Buffer.from('/owned path\\tail')]);
});
