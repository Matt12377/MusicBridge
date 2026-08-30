import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as files from '../src/recording/preparation-files.js';
import { authorizeSourceDirectory } from '../src/recording/source-files.js';
import { preparationFixture } from './helpers/preparation-fixture.js';
import { recordingProfileContent } from './helpers/recording-profile-fixture.js';
import { planDirectExecution, planConvertedDirectExecution } from '../src/recording/execution-plan.js';
import { conversionFixture } from './helpers/conversion-fixture.js';

test('执行任务拥有独立排他目录，空引用清单可以发布，其他用途不能借用此例外', async t => {
  const f = await preparationFixture(t), target = path.join(f.directory, '执行资产'); await mkdir(target);
  const destination = { ...await authorizeSourceDirectory(target), id: randomUUID() }, id = randomUUID();
  const owned = await files.createPreparationDirectory(destination, id, 'cassette', 'execution');
  assert.equal(owned.root.path, path.join(target, `MusicBridge-Execution-${id}`));
  assert.deepEqual((await readdir(owned.root.path)).sort(), ['.musicbridge-owner.json', 'Audio']);
  assert.equal(owned.purpose, 'execution'); await files.checkPreparationOwnership(owned);
  await assert.rejects(files.createPreparationDirectory(destination, id, 'cassette', 'execution'));
  await assert.rejects(files.writePreparationFile(owned, 'Sources/001.wav', Buffer.from('不可写')));
  const manifest = Buffer.from('{"mode":"prepared-reference"}'), hash = await files.publishPreparation(owned, [], manifest, new AbortController().signal);
  assert.equal(hash, createHash('sha256').update(manifest).digest('hex')); assert.equal(await files.verifyPublishedPreparation(owned, [], hash), true);
  await assert.rejects(files.publishPreparation(owned, [], manifest, new AbortController().signal));
  const original = await files.createPreparationDirectory(destination, randomUUID(), 'cassette', 'raw-render');
  await assert.rejects(files.publishPreparation(original, [], manifest, new AbortController().signal));
});

test('执行文件在排他句柄编译后回读，重复写不覆盖，损坏不再通过发布校验', async t => {
  const f = await preparationFixture(t), frozen = await f.freeze(); await f.versions.idle();
  const { master, layout } = f.repository.preparations.frozen(f.versions.job(frozen.id).job!.layoutVersionId!);
  const recipe = planDirectExecution(master, layout, { ...recordingProfileContent().executionFormat, outputProfileVersion: randomUUID() })[0]!;
  const target = path.join(f.directory, '编译目标'); await mkdir(target);
  const destination = { ...await authorizeSourceDirectory(target), id: randomUUID() }, owned = await files.createPreparationDirectory(destination, randomUUID(), 'cassette', 'execution');
  const compile = files.compileExecutionFile;
  const sources = recipe.segments.filter(s => s.kind === 'source').map(s => ({ trackId: s.trackId, root: f.repository.sources.root(f.root.id), relative: 'fixture.wav' })), signal = new AbortController().signal;
  const result = await compile(owned, recipe, sources, signal);
  assert.equal(result.file.relative, 'Audio/A.execution.wav'); assert.equal(result.receipt.audio.sha256, result.file.sha256);
  const absolute = path.join(owned.root.path, result.file.relative), before = await readFile(absolute);
  await assert.rejects(compile(owned, recipe, sources, signal)); assert.deepEqual(await readFile(absolute), before);
  const hash = await files.publishPreparation(owned, [result.file], Buffer.from('{}'), signal); assert.equal(await files.verifyPublishedPreparation(owned, [result.file], hash), true);
  const changed = Buffer.from(before); changed[44] = changed[44]! ^ 1; await writeFile(absolute, changed);
  assert.equal(await files.verifyPublishedPreparation(owned, [result.file], hash), false);
});

test('转换中间文件与最终音频只能写入任务目录并一并发布，重复请求不能覆盖', async t => {
  const f=await preparationFixture(t), frozen=await f.freeze(); await f.versions.idle();
  const {master,layout}=f.repository.preparations.frozen(f.versions.job(frozen.id).job!.layoutVersionId!);
  const converter=conversionFixture(), recipe=planConvertedDirectExecution(master,layout,{...recordingProfileContent().executionFormat,outputProfileVersion:randomUUID()},converter.plan)[0]!;
  const target=path.join(f.directory,'转换执行'); await mkdir(target);
  const destination={...await authorizeSourceDirectory(target),id:randomUUID()},owned=await files.createPreparationDirectory(destination,randomUUID(),'cassette','execution'),signal=new AbortController().signal;
  const outputs=[],sources=[];
  for(const segment of recipe.segments) if(segment.kind==='source') {
    const location={root:f.repository.sources.root(f.root.id),relative:'fixture.wav'};
    const result=await files.convertExecutionSourceFile(owned,segment.trackId,segment.conversion,location,converter,signal);
    outputs.push(result.file); sources.push({trackId:segment.trackId,root:owned.root,relative:result.file.relative,receipt:result.receipt});
    await assert.rejects(files.convertExecutionSourceFile(owned,segment.trackId,segment.conversion,location,converter,signal));
  }
  const result=await files.compileConvertedExecutionFile(owned,recipe,sources,signal);outputs.push(result.file);
  const hash=await files.publishPreparation(owned,outputs,Buffer.from('{}'),signal);
  assert.equal(await files.verifyPublishedPreparation(owned,outputs,hash),true);
  const intermediate=path.join(owned.root.path,outputs[0]!.relative),bytes=await readFile(intermediate);bytes[44]=1;await writeFile(intermediate,bytes);
  assert.equal(await files.verifyPublishedPreparation(owned,outputs,hash),false);
  await assert.rejects(files.writePreparationFile(owned,'Audio/not-a-track.converted.wav',Buffer.from('拒绝')));
});
