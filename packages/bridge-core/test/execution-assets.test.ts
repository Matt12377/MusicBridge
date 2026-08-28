import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isExecutionHistory, isExecutionProposal } from '@music-bridge/contracts';
import { recordingProfileContent } from './helpers/recording-profile-fixture.js';
import { createCollectionRepository } from '../src/collection/repository.js';
import { compileExecutionFile } from '../src/recording/preparation-files.js';
import { conversionFixture } from './helpers/conversion-fixture.js';
import type { FfmpegConverter } from '../src/recording/audio-converter.js';
import { executionPublicationComplete } from '../src/recording/execution-store.js';

import { executionFixture as setup } from './helpers/execution-fixture.js';
import { preparedExecutionFixture as preparedSetup } from './helpers/prepared-execution-fixture.js';

test('Direct 明确预览不写盘，确认持久化逐面 PCM/清单/参数，原命令不重复编译', async t => {
  const f = await setup(t), p = await f.preview(); assert.equal(isExecutionProposal(p), true); assert.deepEqual(await readdir(f.target), []);
  assert.equal(p.settings.effective.recordLevel, '本次人工电平'); assert.equal(p.settings.effective.preRollMs, 1000);
  const request = await f.request(), job = await f.execution.start(request); assert.equal(job.state, 'running'); await f.execution.idle();
  const history = f.execution.list(f.draft.draftId); assert.equal(isExecutionHistory(history), true); assert.equal(history.assets.length, 1); assert.equal(history.jobs[0]!.state, 'completed');
  assert.deepEqual(await f.execution.start(request), history.jobs[0]); assert.equal((await readdir(f.target)).length, 1);
  const asset = history.assets[0]!, owned = f.repository.execution.job(job.id)!.owned!;
  assert.equal(asset.formalReady, false); assert.equal(asset.state, 'verified-at-publication'); assert.equal(asset.retentionPolicy, 'unresolved-no-automatic-deletion');
  assert.equal(asset.settings.profile.id, f.profile.id); assert.equal(asset.settings.effective.recordLevel, '本次人工电平');
  for (const receipt of asset.audio) { const bytes = await readFile(path.join(owned.root.path, `Audio/${receipt.recipe.side}.execution.wav`)); assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.audio.sha256); assert.equal(bytes.readUInt32LE(24), 44100); }
  assert.equal((await f.execution.verify({ assetId: asset.id, readId: randomUUID() })).state, 'verified');
  assert.ok(!JSON.stringify(history).includes(f.sourcePath)); assert.ok(!JSON.stringify(history).includes(f.target));
  const db = new DatabaseSync(f.filePath); try { for (const table of ['execution_assets','execution_jobs']) assert.throws(() => db.exec(`UPDATE ${table} SET data=data`)); assert.throws(() => db.exec('UPDATE execution_ledger SET result=result')); } finally { db.close(); }
});

test('空 B 无占位音频；DAT 只有 Program；旧 Profile 默认变更不改写已确认参数', async t => {
  for (const options of [{ emptyB: true }, { format: 'dat' as const }]) {
    const f = await setup(t, options), request = await f.request();
    f.repository.recordingProfiles.save({ commandId: randomUUID(), profileId: f.profile.profileId, expectedVersionId: f.profile.id, content: { ...f.profile.content, defaults: { ...f.profile.content.defaults, noiseReduction: '新默认' } }, userConfirmed: true });
    const job = await f.execution.start(request); await f.execution.idle(); const asset = f.execution.list(f.draft.draftId).assets[0]!;
    assert.equal(asset.settings.profile.id, f.profile.id); assert.equal(asset.settings.effective.noiseReduction, 'Off'); assert.equal(asset.audio.length, 1); assert.equal(f.execution.job(job.id).job!.totalSides, 1);
    assert.deepEqual(await readdir(path.join(f.repository.execution.job(job.id)!.owned!.root.path, 'Audio')), [options.emptyB ? 'A.execution.wav' : 'Program.execution.wav']);
  }
});

test('参数修订、容量/兼容性或转换需求变化必须重新确认，预览/失效启动不写文件', async t => {
  const f = await setup(t), request = await f.request();
  f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, profileVersionId: f.profile.id, overrides: { noiseReduction: null }, userConfirmed: true });
  await assert.rejects(f.execution.start(request)); assert.equal(f.execution.list(f.draft.draftId).jobs.length, 0); assert.deepEqual(await readdir(f.target), []);
  for (const content of [{ ...f.profile.content, executionFormat: { ...f.profile.content.executionFormat, sampleRate: 48000 } }, { ...f.profile.content, compatibility: { confirmed: true, cassetteTypes: [] as const, dat: false } }]) {
    const profile = f.repository.recordingProfiles.save({ commandId: randomUUID(), content, userConfirmed: true }), previous = f.repository.recordingProfiles.session(f.draft.draftId).session!;
    const session = f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: previous.revision, profileVersionId: profile.id, overrides: {}, userConfirmed: true });
    await assert.rejects(f.execution.preview({ ...f.selection, sessionRevision: session.revision, readId: randomUUID() })); assert.deepEqual(await readdir(f.target), []);
  }
});

test('写任务事务失败不写盘；发布后 DB 故障保留已校验文件，冷启动只补交不重编译', async t => {
  let actionToFail = '', compiles = 0;
  const f = await setup(t, { beforeCommit: action => { if (action === actionToFail) throw new Error('合成 DB 故障'); }, compile: async (...args) => { compiles++; return compileExecutionFile(...args); } });
  const request = await f.request(); actionToFail = 'start-execution'; await assert.rejects(f.execution.start(request)); assert.deepEqual(await readdir(f.target), []); assert.equal(f.execution.list(f.draft.draftId).jobs.length, 0);
  actionToFail = 'finish-execution'; const job = await f.execution.start(request); await f.execution.idle(); assert.equal(f.execution.job(job.id).job!.state, 'interrupted'); assert.equal(f.execution.list(f.draft.draftId).assets.length, 0);
  const count = compiles; await f.execution.close(); await rm(f.sourcePath, { recursive: true });
  actionToFail = ''; const reopened = createCollectionRepository({ filePath: f.filePath }), resumed = f.make(reopened, { compile: async (...args) => { compiles++; return compileExecutionFile(...args); } });
  try { await resumed.idle(); assert.equal(compiles, count); assert.equal(resumed.job(job.id).job!.state, 'completed'); assert.equal(resumed.list(f.draft.draftId).assets.length, 1); assert.deepEqual(await resumed.start(request), resumed.job(job.id).job); } finally { await resumed.close(); reopened.close(); }
});

test('发布后字节损坏不会恢复成功；历史发布事实不冒充当前可用', async t => {
  const f = await setup(t), job = await f.execution.start(await f.request()); await f.execution.idle(); const stored = f.repository.execution.job(job.id)!, asset = f.execution.list(f.draft.draftId).assets[0]!;
  const file = path.join(stored.owned!.root.path, stored.files[0]!.relative), bytes = await readFile(file); bytes[44] = bytes[44]! ^ 1; await writeFile(file, bytes);
  const check = await f.execution.verify({ assetId: asset.id, readId: randomUUID() }); assert.equal(check.state, 'unavailable'); assert.equal(check.reason, 'ASSET_INVALID'); assert.equal(f.execution.list(f.draft.draftId).assets[0]!.state, 'verified-at-publication');
});

test('编译中取消或撤权不发布资产，不删除已拥有的目录，冷启动不重放', async t => {
  for (const revoke of [false,true]) {
    let entered!: () => void, release!: () => void; const seen = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    const f = await setup(t, { compile: async (...args) => { entered(); await wait; return compileExecutionFile(...args); } }), job = await f.execution.start(await f.request()); await seen;
    if (revoke) f.preparation.revoke({ commandId: randomUUID(), id: f.destination.id }); else f.execution.cancel({ commandId: randomUUID(), id: job.id });
    release(); await f.execution.idle(); assert.equal(f.execution.job(job.id).job!.state, revoke ? 'failed' : 'cancelled'); assert.equal(f.execution.list(f.draft.draftId).assets.length, 0); assert.equal((await readdir(f.target)).length, 1);
    await f.execution.close(); const resumed = f.make(f.repository, { compile: async () => { assert.fail('不得重放'); } }); try { await resumed.idle(); assert.equal(resumed.list(f.draft.draftId).assets.length, 0); } finally { await resumed.close(); }
  }
});


test('PREP 实际原件引用逐面核对，不复制、不加 Gap；原件授权撤销立即使当前检查不可用', async t => {
  for (const options of [{ emptyB: true }, { format: 'dat' as const }, {}]) {
    const f = await preparedSetup(t, options), request = await f.request(), p = await f.execution.preview({ ...f.selection, readId: randomUUID() });
    assert.equal(p.audioBytesToWrite, 0); assert.equal(p.referencedAudioBytes, f.prep.assets.reduce((sum,a) => sum + a.size, 0));
    const job = await f.execution.start(request); await f.execution.idle(); const asset = f.execution.list(f.draft.draftId).assets[0]!; assert.ok(asset); assert.equal(asset.preparedVersionId, f.prep.id);
    assert.deepEqual(await readdir(path.join(f.repository.execution.job(job.id)!.owned!.root.path, 'Audio')), []);
    for (const receipt of asset.audio) { const original = f.prep.assets.find(a => a.side === receipt.recipe.side)!; assert.equal(receipt.origin, 'retained-render'); assert.equal(receipt.audio.sha256, original.sha256); assert.equal(receipt.audio.frameCount, original.totalFrames); assert.equal(receipt.recipe.segments.length, 1); }
    assert.equal((await f.execution.verify({ assetId: asset.id, readId: randomUUID() })).state, 'verified');
    f.preparation.revoke({ commandId: randomUUID(), id: f.rawDestination.id }); const check = await f.execution.verify({ assetId: asset.id, readId: randomUUID() }); assert.equal(check.state, 'unavailable'); assert.equal(check.reason, 'DESTINATION_INVALID');
    assert.equal((await readdir(f.rawTarget)).length, 1);
  }
});

test('PREP 发布后提交故障，原件损坏时冷启动保持中断，不错误补交也不重建', async t => {
  let fail = false; const f = await preparedSetup(t, { beforeCommit: action => { if (fail && action === 'finish-execution') throw new Error('合成故障'); } });
  fail = true; const job = await f.execution.start(await f.request()); await f.execution.idle(); assert.equal(f.execution.job(job.id).job!.state, 'interrupted'); await f.execution.close();
  const original = path.join(f.imported.owned!.root.path, f.imported.files[0]!.relative), bytes = await readFile(original); bytes[44] = bytes[44]! ^ 1; await writeFile(original, bytes);
  fail = false; const resumed = f.make(f.repository, { compile: async () => { assert.fail('恢复不能重编译'); } }); try { await resumed.idle(); assert.equal(resumed.job(job.id).job!.state, 'interrupted'); assert.equal(resumed.list(f.draft.draftId).assets.length, 0); } finally { await resumed.close(); }
});

test('执行有总体期限；超时的慢编译不返回资产，读取消先于预览也有效', async t => {
  const f = await setup(t, { operationTimeoutMs: 100, compile: async (...args) => { await new Promise(resolve => setTimeout(resolve, 150)); return compileExecutionFile(...args); } });
  const readId = randomUUID(); f.execution.cancelRead(readId); await assert.rejects(f.execution.preview({ ...f.selection, readId })); assert.deepEqual(await readdir(f.target), []);
  const job = await f.execution.start(await f.request()); await f.execution.idle(); assert.equal(f.execution.job(job.id).job!.state, 'failed'); assert.equal(f.execution.job(job.id).job!.failure, 'IO_ERROR'); assert.equal(f.execution.list(f.draft.draftId).assets.length, 0);
});

test('预览转换需求以公开 BAD_REQUEST 拒绝；后续编译故障保留明确磁盘已满状态', async t => {
  const f = await setup(t, { compile: async () => { throw Object.assign(new Error('/private/fake-destination'), { code: 'ENOSPC' }); } }), job = await f.execution.start(await f.request());
  await f.execution.idle(); assert.equal(f.execution.job(job.id).job!.failure, 'DISK_FULL');
  const profile = f.repository.recordingProfiles.save({ commandId: randomUUID(), content: recordingProfileContent(48000), userConfirmed: true }), session = f.repository.recordingProfiles.saveSession({ commandId: randomUUID(), draftId: f.draft.draftId, expectedRevision: 1, profileVersionId: profile.id, overrides: {}, userConfirmed: true });
  await assert.rejects(f.execution.preview({ ...f.selection, sessionRevision: session.revision, readId: randomUUID() }), error => error instanceof Error && 'code' in error && error.code === 'BAD_REQUEST' && error.message.includes('转换'));
});

test('V2 转换任务明确预览后发布所有中间文件和最终音频，命令幂等且无路径泄漏', async t => {
  const f=await setup(t,{converter:conversionFixture()}),selection={...f.selection,mode:'direct-converted' as const};
  const proposal=await f.execution.preview({...selection,readId:randomUUID()});
  assert.equal(isExecutionProposal(proposal),true);assert.deepEqual(await readdir(f.target),[]);
  const request={...selection,commandId:randomUUID(),proposalFingerprint:proposal.proposalFingerprint,userConfirmed:true as const};
  const job=await f.execution.start(request);await f.execution.idle();
  const stored=f.repository.execution.job(job.id)!,history=f.execution.list(f.draft.draftId);
  assert.equal(history.jobs[0]!.state,'completed',JSON.stringify({job:stored.public,files:stored.files,audio:stored.audio.length}));assert.equal(isExecutionHistory(history),true);
  assert.equal(stored.files.length,5);assert.equal(executionPublicationComplete(stored),true);
  assert.equal(executionPublicationComplete({...stored,files:stored.files.slice(1)}),false);
  assert.equal(history.assets[0]!.recipes.every(r=>r.schemaVersion===2),true);
  assert.deepEqual(await f.execution.start(request),history.jobs[0]);assert.equal((await readdir(f.target)).length,1);
  assert.equal((await f.execution.verify({assetId:job.id,readId:randomUUID()})).state,'verified');
  assert.ok(!JSON.stringify(history).includes(f.directory));
});

test('V2 发布后提交中断只补交，不重读原源或重新转换；中间文件也属于完整性边界', async t => {
  let fail=true,calls=0;const converter=conversionFixture(),convert=converter.convert;
  converter.convert=async(...args)=>{calls++;return convert(...args);};
  const f=await setup(t,{converter,beforeCommit:action=>{if(fail&&action==='finish-execution')throw new Error('合成提交中断');}}),selection={...f.selection,mode:'direct-converted' as const};
  const proposal=await f.execution.preview({...selection,readId:randomUUID()}),request={...selection,commandId:randomUUID(),proposalFingerprint:proposal.proposalFingerprint,userConfirmed:true as const};
  const job=await f.execution.start(request);await f.execution.idle();assert.equal(f.execution.job(job.id).job!.state,'interrupted');
  const count=calls;await f.execution.close();await rm(f.sourcePath,{recursive:true});fail=false;
  const resumed=f.make(f.repository,{converter});
  try {
    await resumed.idle();assert.equal(resumed.job(job.id).job!.state,'completed');assert.equal(calls,count);
    const stored=f.repository.execution.job(job.id)!,intermediate=stored.files.find(file=>file.relative.endsWith('.converted.wav'))!;
    const filename=path.join(stored.owned!.root.path,intermediate.relative),bytes=await readFile(filename);bytes[44]=1;await writeFile(filename,bytes);
    assert.equal((await resumed.verify({assetId:job.id,readId:randomUUID()})).state,'unavailable');
  }finally{await resumed.close();}
});

test('V2 PREP Derivative 使用实际 Render 位深生成独立文件，保留原件且不加 Gap', async t => {
  const f=await preparedSetup(t,{converter:conversionFixture(),emptyB:true});
  const original=await readFile(path.join(f.imported.owned!.root.path,f.imported.files[0]!.relative));
  const content=recordingProfileContent(48000);content.executionFormat={...content.executionFormat,internalProcessingPrecision:'float64',outputSampleFormat:'pcm-s24le',resamplerImplementation:'ffmpeg-swr',resamplerVersion:'6.3.102'};
  const profile=f.repository.recordingProfiles.save({commandId:randomUUID(),content,userConfirmed:true}),session=f.repository.recordingProfiles.saveSession({commandId:randomUUID(),draftId:f.draft.draftId,expectedRevision:f.selection.sessionRevision,profileVersionId:profile.id,overrides:{},userConfirmed:true});
  const selection={...f.selection,mode:'prepared-derivative' as const,sessionRevision:session.revision},proposal=await f.execution.preview({...selection,readId:randomUUID()});
  assert.ok(proposal.audioBytesToWrite>0);assert.equal(proposal.referencedAudioBytes,original.length);
  const job=await f.execution.start({...selection,commandId:randomUUID(),proposalFingerprint:proposal.proposalFingerprint,userConfirmed:true});await f.execution.idle();
  assert.equal(f.execution.job(job.id).job!.state,'completed');const asset=f.execution.list(f.draft.draftId).assets[0]!;
  assert.equal(asset.audio[0]!.origin,'derived-render');assert.equal(asset.audio[0]!.audio.frameCount,Math.ceil(f.prep.assets[0]!.totalFrames/2));
  assert.equal(asset.recipes[0]!.segments.length,1);assert.equal(f.repository.execution.job(job.id)!.files[0]!.relative,'Audio/A.derivative.wav');
  assert.deepEqual(await readFile(path.join(f.imported.owned!.root.path,f.imported.files[0]!.relative)),original);
});

test('V2 未配置固定转换器时明确拒绝，不自动搜索或启用系统 FFmpeg', async t => {
  const f=await setup(t);
  await assert.rejects(f.execution.preview({...f.selection,mode:'direct-converted',readId:randomUUID()}),error=>error instanceof Error&&error.message.includes('转换器'));
  assert.deepEqual(await readdir(f.target),[]);assert.equal(f.execution.list(f.draft.draftId).jobs.length,0);
});

test('V2 转换中取消、源撤权或目标撤权均不发布，冷启动不重放部分文件', async t => {
  for (const action of ['cancel', 'source', 'destination'] as const) {
    let entered!: () => void, release!: () => void;
    const seen = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const fixture = conversionFixture();
    const converter: FfmpegConverter = { ...fixture, convert: async (...args) => { entered(); await wait; return fixture.convert(...args); } };
    const f = await setup(t, { converter }), selection = { ...f.selection, mode: 'direct-converted' as const };
    const proposal = await f.execution.preview({ ...selection, readId: randomUUID() });
    const job = await f.execution.start({ ...selection, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true });
    await seen;
    if (action === 'source') await f.sources.revoke({ commandId: randomUUID(), id: f.root.id });
    else if (action === 'destination') f.preparation.revoke({ commandId: randomUUID(), id: f.destination.id });
    else f.execution.cancel({ commandId: randomUUID(), id: job.id });
    release(); await f.execution.idle();
    assert.equal(f.execution.job(job.id).job!.failure, action === 'cancel' ? 'CANCELLED' : action === 'source' ? 'SOURCE_INVALID' : 'DESTINATION_INVALID');
    assert.equal(f.execution.list(f.draft.draftId).assets.length, 0);
    const owned = f.repository.execution.job(job.id)!.owned!;
    assert.ok((await readdir(path.join(owned.root.path, 'Audio'))).length > 0, '保留已拥有的部分文件');
    assert.ok(!(await readdir(owned.root.path)).includes('Manifest.json'));
    await f.execution.close();
    const resumed = f.make(f.repository, { converter: { ...fixture, convert: async () => { assert.fail('不得重放转换'); } } });
    try { await resumed.idle(); assert.equal(resumed.list(f.draft.draftId).assets.length, 0); } finally { await resumed.close(); }
  }
});

test('V2 预览读取实际源字节，源变化时不返回可确认配方', async t => {
  const f = await setup(t, { converter: conversionFixture() });
  const bytes = await readFile(f.file); bytes[44] = bytes[44]! ^ 1; await writeFile(f.file, bytes);
  await assert.rejects(f.execution.preview({ ...f.selection, mode: 'direct-converted', readId: randomUUID() }));
  assert.deepEqual(await readdir(f.target), []);
  assert.equal(f.execution.list(f.draft.draftId).jobs.length, 0);
});

test('私有运行时注入转换器后，公开预览与启动仍只接收固定选择合同', async t => {
  const f = await setup(t), { createTestBridgeRuntime } = await import('../src/runtime.js');
  await f.execution.close();
  const runtime = createTestBridgeRuntime({ collectionRepository: f.repository, recordingConverter: conversionFixture() });
  try {
    const selection = { ...f.selection, mode: 'direct-converted' as const };
    const proposal = await runtime.execution!.preview({ ...selection, readId: randomUUID() });
    assert.equal(proposal.mode, 'direct-converted');
    assert.equal(proposal.recipes[0]!.schemaVersion, 2);
    assert.deepEqual(await readdir(f.target), []);
    const job = await runtime.execution!.start({ ...selection, commandId: randomUUID(), proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true });
    await runtime.execution!.idle();
    assert.equal(runtime.execution!.job(job.id).job!.state, 'completed');
    assert.equal(isExecutionHistory(runtime.execution!.list(f.draft.draftId)), true);
  } finally { await runtime.shutdown(); }
});
