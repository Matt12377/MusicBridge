import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundledOutputHelper } from '../src/recording/bundled-output-helper.js';
import { OutputCheckError } from '../src/recording/output-error.js';
import { FakeOutputChild, outputHelperFixture, complete, nativeEvent, sha, tick, until } from './helpers/output-helper-fixture.js';

async function load() {
  const module = await import('../src/recording/output-helper.js').catch(() => ({}));
  assert.ok('createOutputHelperRunner' in module, '缺少固定无设备helper runner');
  return (module as typeof import('../src/recording/output-helper.js')).createOutputHelperRunner;
}
test('固定绝对binary无args/继承环境，header→VERIFIED→RUN，只有close后返回完整结果', async t => {
  const create = await load(), f = await outputHelperFixture(t), child = new FakeOutputChild(); let checks = 0;
  const runner = create(f.pin, { launch: (file, args, options) => {
    assert.equal(file, f.pin.path); assert.deepEqual(args, []); assert.equal(options.shell, false);
    assert.deepEqual(options.env, { LANG: 'C', LC_ALL: 'C' }); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe', f.input.handle.fd]);
    return child.process();
  }, checkIntervalMs: 2 });
  const promise = runner.run({ ...f.input, checkOperation: () => { checks++; } }); let settled = false; void promise.then(() => { settled = true; });
  await until(() => child.writes.length === 1); assert.equal(child.writes[0]!.length, 256); assert.equal(child.stdin.writableEnded, false);
  child.stdout.write(nativeEvent(f.input, 1)); assert.equal(child.writes.length, 1);
  child.stdout.write(nativeEvent(f.input, 2)); assert.equal(child.writes.length, 2); assert.equal(child.writes[1]!.readUInt16LE(6), 1); assert.equal(child.writes[1]!.readUInt32LE(24), 1);
  for (let k = 3; k <= 5; k++) child.stdout.write(nativeEvent(f.input, k));
  await tick(); assert.equal(settled, false); assert.ok((await f.input.handle.stat()).isFile()); child.emit('exit', 0); await tick(); assert.equal(settled, false);
  child.close(); assert.deepEqual(await promise, { consumedFrames: f.input.audio.frameCount, pcmSha256: sha(f.pcm), helperSha256: f.pin.sha256 });
  const finalChecks = checks; await new Promise(resolve => setTimeout(resolve, 8)); assert.equal(checks, finalChecks);
  assert.equal(getEventListeners(f.abort.signal, 'abort').length, 0); assert.equal(child.stdout.listenerCount('data'), 0); assert.equal(child.stderr.listenerCount('data'), 0);
});
test('取消先到不spawn；STOP合并且序号按是否RUN分配，kill后仍等close并拒绝迟到成功', async t => {
  const create = await load(), before = await outputHelperFixture(t); let launches = 0; before.abort.abort();
  await assert.rejects(create(before.pin, { launch: () => { launches++; return new FakeOutputChild().process(); } }).run(before.input), /CANCELLED/); assert.equal(launches, 0);
  for (const afterRun of [false, true]) {
    const f = await outputHelperFixture(t), child = new FakeOutputChild();
    const promise = create(f.pin, { launch: () => child.process(), stopTimeoutMs: 5 }).run(f.input); let settled = false;
    const rejected = assert.rejects(promise, /CANCELLED/).then(() => { settled = true; });
    await until(() => child.writes.length > 0);
    if (afterRun) { child.stdout.write(nativeEvent(f.input, 1)); child.stdout.write(nativeEvent(f.input, 2)); }
    f.abort.abort(); f.abort.abort();
    const controls = child.writes.slice(1); assert.equal(controls.length, afterRun ? 2 : 1); assert.equal(controls.at(-1)!.readUInt16LE(6), 2); assert.equal(controls.at(-1)!.readUInt32LE(24), afterRun ? 2 : 1);
    await until(() => child.kills.length > 0); assert.deepEqual(child.kills, ['SIGKILL']); assert.equal(settled, false);
    if (!afterRun) complete(child, f.input); else for (let k = 3; k <= 5; k++) child.stdout.write(nativeEvent(f.input, k));
    child.close(); await rejected; assert.equal(child.writes.filter(b => b.length === 32 && b.readUInt16LE(6) === 1).length, afterRun ? 1 : 0);
    assert.equal(getEventListeners(f.abort.signal, 'abort').length, 0);
  }
});
test('跨run、重复终态、stdout/stderr洪泛立即kill；任何错误均等close且不泄露原文', async t => {
  const create = await load();
  for (const variant of ['cross-run', 'late', 'stdout', 'stderr', 'os', 'stdin'] as const) {
    const f = await outputHelperFixture(t), child = new FakeOutputChild();
    const promise = create(f.pin, { launch: () => child.process() }).run(f.input); let settled = false;
    const rejected = assert.rejects(promise, error => { assert.ok(error instanceof OutputCheckError); assert.ok(!error.message.includes('私密路径')); return true; }).then(() => { settled = true; });
    await until(() => child.writes.length > 0);
    if (variant === 'cross-run') { const wrong = nativeEvent(f.input, 1); wrong[16] = wrong[16]! ^ 1; child.stdout.write(wrong); }
    if (variant === 'late') { complete(child, f.input); child.stdout.write(nativeEvent(f.input, 5, 6)); }
    if (variant === 'stdout') child.stdout.write(Buffer.alloc(1025));
    if (variant === 'stderr') child.stderr.write(Buffer.from('私密路径'.repeat(3000)));
    if (variant === 'os') child.emit('error', new Error('私密路径 spawn失败'));
    if (variant === 'stdin') child.stdin.emit('error', new Error('私密路径 pipe失败'));
    assert.deepEqual(child.kills, ['SIGKILL']); await tick(); assert.equal(settled, false); child.close(null); await rejected;
  }
});
test('非零退出、缺终态或结束后pin变化不能成功；下次run先复核pin不spawn', async t => {
  const create = await load();
  for (const variant of ['exit', 'truncated', 'changed'] as const) {
    const f = await outputHelperFixture(t), child = new FakeOutputChild(); let launches = 0;
    const runner = create(f.pin, { launch: () => { launches++; return child.process(); } });
    const promise = runner.run(f.input), rejected = assert.rejects(promise, variant === 'changed' ? /HELPER_CHANGED/ : /HELPER_PROTOCOL/);
    await until(() => child.writes.length > 0); if (variant !== 'truncated') complete(child, f.input);
    if (variant === 'changed') await writeFile(f.hal, '合成object已改变');
    child.close(variant === 'exit' ? 1 : 0); await rejected;
    if (variant === 'changed') { await assert.rejects(runner.run(f.input), /HELPER_CHANGED/); assert.equal(launches, 1); }
  }
});
for (const variant of ['cancel-flood', 'premature-running'] as const) test(`协议边界${variant}：取消后的洪泛立即kill且RUN前事件不可伪装`, async t => {
  const create = await load();
    const f = await outputHelperFixture(t), child = new FakeOutputChild();
    const promise = create(f.pin, { launch: () => child.process() }).run(f.input);
    const rejected = assert.rejects(promise, variant === 'cancel-flood' ? /CANCELLED/ : /HELPER_PROTOCOL/);
    await until(() => child.writes.length > 0);
    if (variant === 'cancel-flood') { f.abort.abort(); child.stdout.write(Buffer.alloc(1025)); }
    else child.stdout.write(Buffer.concat([nativeEvent(f.input, 1), nativeEvent(f.input, 2), nativeEvent(f.input, 3)]));
    try { assert.deepEqual(child.kills, ['SIGKILL']); }
    finally { child.close(null); await rejected; }
});
test('ACCEPTED期限、总期限和运行中上下文改变均停止且等待close，预算只能收紧', async t => {
  const create = await load();
  for (const variant of ['accepted', 'total', 'changed'] as const) {
    const f = await outputHelperFixture(t), child = new FakeOutputChild(); let changed = false;
    const runner = create(f.pin, { launch: () => child.process(), acceptedTimeoutMs: 30, operationTimeoutMs: 60, stopTimeoutMs: 5, checkIntervalMs: 2 });
    const promise = runner.run({ ...f.input, checkOperation: () => { if (changed) throw new OutputCheckError('PLAN_CHANGED'); } });
    const rejected = assert.rejects(promise, variant === 'changed' ? /PLAN_CHANGED/ : /TIMEOUT/);
    await until(() => child.writes.length > 0); if (variant !== 'accepted') child.stdout.write(nativeEvent(f.input, 1)); if (variant === 'changed') changed = true;
    await until(() => child.kills.length > 0); assert.equal(child.writes.at(-1)!.readUInt16LE(6), 2); child.close(null); await rejected;
  }
  const f = await outputHelperFixture(t);
  for (const options of [{ acceptedTimeoutMs: 5001 }, { operationTimeoutMs: 900001 }, { stopTimeoutMs: 1001 }, { checkIntervalMs: 101 }, { checkIntervalMs: 0 }]) assert.throws(() => create(f.pin, options), /INVALID_REQUEST/);
});
test('实际固定native binary读取真实只读WAV，消费hash/2051帧与Core receipt完全一致', { skip: process.env.MUSIC_BRIDGE_OUTPUT_NATIVE_GATE !== '1' ? '需显式MUSIC_BRIDGE_OUTPUT_NATIVE_GATE=1及本地固定native构建；普通unit不冒充原生证据' : false }, async t => {
  const create = await load(), f = await outputHelperFixture(t);
  const root = fileURLToPath(new URL('../../../apps/desktop/native/output/darwin-arm64/', import.meta.url));
  const pin = await loadBundledOutputHelper(root.replace(/\/$/u, ''), sha(await readFile(path.join(root, 'manifest.json')))); assert.ok(pin);
  const result = await create(pin).run(f.input);
  assert.deepEqual(result, { consumedFrames: 2051, pcmSha256: sha(f.pcm), helperSha256: pin.sha256 });
  assert.ok((await f.input.handle.stat()).isFile());
});
