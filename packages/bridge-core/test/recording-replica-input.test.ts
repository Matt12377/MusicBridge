import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { link, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { recordingRecordFixture } from './helpers/recording-record-fixture.js';

async function setup(t: test.TestContext, format: 'cassette' | 'dat' = 'cassette') {
  const f = await recordingRecordFixture(t, format), pending = await f.readyForFinal();
  await f.attempts.confirm(pending.request);
  const recordingId = f.repository.recordingRecords.read(db => String(db.prepare('SELECT id FROM recording_records').get()!.id));
  const module = await import('../src/recording/replica-input.js').catch(() => ({}));
  assert.ok('createRecordingReplicaInput' in module, '缺少历史Record只读输入边界');
  const api = (module as typeof import('../src/recording/replica-input.js')).createRecordingReplicaInput({ repository: f.repository });
  const inspect = () => api.inspect({ readId: randomUUID(), recordingId }, new AbortController().signal, () => undefined);
  return { ...f, recordingId, apiBackup: f.api, api, inspect };
}

test('历史Direct完成后不依赖预留和原工作目录，读取归档完整PCM且不写事实', async t => {
  const f = await setup(t), facts = () => f.repository.recordingRecords.read(db => ['recording_records','recording_record_current','recording_attempts','physical_copies','media_reservations'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  const before = facts();
  await rename(f.target, `${f.target}-离线`);
  for (const root of f.repository.sources.roots()) f.repository.sources.revoke({ commandId: randomUUID(), id: root.id });
  const inspection = await f.inspect(), target = inspection.targets.find(v => v.target === 'actual-execution' && v.side === 'A');
  assert.equal(target?.state, 'verified', JSON.stringify(target)); assert.equal(inspection.targets.some(v => v.target === 'original-render'), false);
  const result = await f.api.withInput({ recordingId: f.recordingId, target: 'actual-execution', side: 'A', expectedFingerprint: inspection.fingerprint }, new AbortController().signal, () => undefined, async input => {
    const bytes = Buffer.alloc(input.audio.size); await input.handle.read(bytes, 0, bytes.length, 0); input.checkOperation();
    assert.equal(createHash('sha256').update(bytes).digest('hex'), input.audio.fileSha256);
    return createHash('sha256').update(bytes.subarray(input.dataOffset, input.dataOffset + input.audio.frameCount * input.audio.format.channelCount * Number(input.audio.format.sampleFormat.slice(5, 7)) / 8)).digest('hex');
  });
  assert.equal(result, f.frozenPlan.execution.audio.find(a => a.recipe.side === 'A')!.audio.pcmSha256);
  assert.deepEqual(facts(), before);
});

test('FINALIZED真实对象保持单链接，额外硬链或改写字节不能消费', async t => {
  const f = await setup(t, 'dat'), receipt = f.frozenPlan.execution.audio[0]!, file = path.join(f.root.objects.path, receipt.audio.sha256);
  const before = await f.inspect(); assert.equal(before.targets[0]?.state, 'verified', JSON.stringify(before.targets));
  await link(file, path.join(f.directory, '外部硬链.wav'));
  const result = await f.inspect(); assert.equal(result.targets[0]?.state, 'unavailable');
  let called = false;
  await assert.rejects(f.api.withInput({ recordingId: f.recordingId, target: 'actual-execution', side: 'Program', expectedFingerprint: before.fingerprint }, new AbortController().signal, () => undefined, async () => { called = true; }));
  assert.equal(called, false); assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), receipt.audio.sha256);
});

for (const mode of ['prepared-reference','prepared-derivative'] as const) test(`${mode} 明确原件与执行音频，空B不播放，不套当前Profile或重复加gap`, async t => {
  const { preparedReplicaFixture } = await import('./helpers/recording-replica-fixture.js');
  const { createRecordingReplicaInput } = await import('../src/recording/replica-input.js');
  const f = await preparedReplicaFixture(t, mode), api = createRecordingReplicaInput({ repository: f.repository });
  await rename(f.target, `${f.target}-离线`); await rename(f.rawTarget, `${f.rawTarget}-离线`);
  const result = await api.inspect({ readId: randomUUID(), recordingId: f.recordingId }, new AbortController().signal, () => undefined);
  assert.equal(result.targets.length, 4);
  const actual = result.targets[0]!, raw = result.targets[2]!;
  assert.equal(actual.state, 'verified', JSON.stringify(actual)); assert.equal(raw.state, 'verified', JSON.stringify(raw));
  if (actual.state !== 'verified' || raw.state !== 'verified') return;
  assert.equal(raw.audio.pcmHashEvidence, 'verified-render-bytes'); assert.equal(raw.audio.format.sampleRate, 96000); assert.equal(raw.audio.format.sampleFormat, 'pcm-s16le');
  assert.equal(actual.audio.pcmHashEvidence, 'frozen-execution');
  if (mode === 'prepared-derivative') { assert.notEqual(actual.audio.fileSha256, raw.audio.fileSha256); assert.equal(actual.audio.format.sampleRate, 48000); assert.equal(actual.audio.format.sampleFormat, 'pcm-s24le'); }
  else assert.equal(actual.audio.fileSha256, raw.audio.fileSha256);
  for (const target of [actual, raw]) {
    const frames = await api.withInput({ recordingId: f.recordingId, target: target.target, side: 'A', expectedFingerprint: result.fingerprint }, new AbortController().signal, () => undefined, async input => { assert.deepEqual(input.audio, target.audio); return input.audio.frameCount; });
    assert.equal(frames, target.audio.frameCount);
  }
  assert.equal(result.targets[1]!.state, 'empty'); assert.equal(result.targets[3]!.state, 'empty');
  await assert.rejects(api.withInput({ recordingId: f.recordingId, target: 'original-render', side: 'B', expectedFingerprint: result.fingerprint }, new AbortController().signal, () => undefined, async () => assert.fail('空面不能消费')));
});

test('真实完整备份恢复绑定消费历史FD，metadata不回退旧路径且撤权使租期失效', async t => {
  const { mkdir } = await import('node:fs/promises');
  const { authorizeSourceDirectory } = await import('../src/recording/source-files.js');
  const { restoreArchiveBackup } = await import('../src/recording/restore-package.js');
  const { prepareRestoredDataset } = await import('../src/recording/restore-activation-files.js');
  const { createRestoredContentBinding } = await import('../src/recording/restore-content-binding.js');
  const { createCollectionRepository } = await import('../src/collection/repository.js');
  const { createRecordingReplicaInput } = await import('../src/recording/replica-input.js');
  const f = await setup(t, 'dat'), signal = new AbortController().signal;
  const capability = async (name:string) => { const target=path.join(f.directory,name);await mkdir(target);return {...await authorizeSourceDirectory(target),id:randomUUID()}; };
  for (const mode of ['archive-content','metadata'] as const) {
    const backup=await f.apiBackup.createArchiveBackup({ ...f.backupRequest, id:randomUUID(), mode });
    const restored=await restoreArchiveBackup({backup:backup.directory,destination:await capability(`${mode}-恢复`),protectedRoots:[],id:randomUUID(),userConfirmed:true,signal});
    const prepared=await prepareRestoredDataset({id:randomUUID(),source:restored.directory,destination:await capability(`${mode}-工作库`),userConfirmed:true,signal});
    const repository=createCollectionRepository({filePath:path.join(prepared.database.path,'collection.sqlite')});t.after(()=>repository.close());
    let authorized=true;
    const binding=createRestoredContentBinding(prepared,{isAuthorized:()=>authorized}),api=createRecordingReplicaInput({repository,contentBinding:binding,watchIntervalMs:5});
    if(mode==='archive-content') await rename(f.root.root.path,`${f.root.root.path}-离线`);
    const result=await api.inspect({readId:randomUUID(),recordingId:f.recordingId},signal,()=>undefined);
    if(mode==='metadata'){assert.equal(result.targets[0]!.state,'unavailable');continue;}
    assert.equal(result.targets[0]!.state,'verified',JSON.stringify(result));
    await api.withInput({recordingId:f.recordingId,target:'actual-execution',side:'Program',expectedFingerprint:result.fingerprint},signal,()=>undefined,async input=>{assert.equal((await input.handle.stat()).nlink,1);assert.equal(input.audio.fileSha256,f.frozenPlan.execution.audio[0]!.audio.sha256);});
    let held:import('node:fs/promises').FileHandle|undefined;
    await assert.rejects(api.withInput({recordingId:f.recordingId,target:'actual-execution',side:'Program',expectedFingerprint:result.fingerprint},signal,()=>undefined,async input=>{
      held=input.handle;authorized=false;
      await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}));
      assert.equal((await held.stat()).nlink,1);
    }));
    await assert.rejects(held!.stat());
    const unavailable=await api.inspect({readId:randomUUID(),recordingId:f.recordingId},signal,()=>undefined);assert.equal(unavailable.targets[0]!.state,'unavailable');
  }
});

test('消费期间归档清单变化，即使音频字节未变也不能发布成功', async t => {
  const { writeFile } = await import('node:fs/promises');
  const f = await setup(t, 'dat'), inspection = await f.inspect(), op = f.repository.archive.operation(f.archiveRequest.commandId)!.owned!;
  await assert.rejects(f.api.withInput({ recordingId:f.recordingId,target:'actual-execution',side:'Program',expectedFingerprint:inspection.fingerprint },new AbortController().signal,()=>undefined,async()=>{
    await writeFile(path.join(op.directory.path,'Manifest.json'), `${op.manifest} `);
    return '不能发布';
  }));
});

test('纯inspect首验后归档清单变化不能返回verified，正常root末验重读真实文件', async t => {
  const { writeFileSync } = await import('node:fs');
  const f = await setup(t, 'dat'), op = f.repository.archive.operation(f.archiveRequest.commandId)!.owned!;
  const original = f.repository.archive.root.bind(f.repository.archive);
  let calls = 0;
  t.mock.method(f.repository.archive, 'root', (id: string) => {
    const root = original(id);
    // 首次磁盘清单验证已结束；只改合成真实文件，不改变返回的目录或数据库事实。
    if (++calls === 2) writeFileSync(path.join(op.directory.path, 'Manifest.json'), `${op.manifest} `);
    return root;
  });
  await assert.rejects(f.inspect());
  assert.ok(calls >= 2);
});
