import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { buildStoragePolicy } from '../../../apps/desktop/scripts/build-storage-root.mjs';
import { createDesktopDevRuntimeLog, teeDesktopRuntimeOutput } from '../../desktop-dev-runtime-log.mjs';

// 只测试外置合成日志和流；使用本次实际compiled validator，不启动Electron、不读正式DB/NAS。
async function fixture(t) {
  const policy = buildStoragePolicy();
  const parent = policy.hosted ? policy.root : policy.check(process.env.TMPDIR, { mustExist: true });
  const root = fs.mkdtempSync(path.join(parent, 'musicbridge-dev-runtime-log-test-'));
  const paths = { root, workspace: path.join(root, 'workspace'), policy };
  const compiledRoot = process.env.MB_DESKTOP_RUNTIME_LOG_TEST_WORKSPACE ?? fileURLToPath(new URL('../../../', import.meta.url));
  const source = policy.check(path.join(compiledRoot, 'packages/bridge-core/dist/shared/library-operation-log.js'), { mustExist: true, kind: 'file' });
  const compiled = path.join(paths.workspace, 'packages/bridge-core/dist/shared/library-operation-log.js');
  fs.mkdirSync(path.dirname(compiled), { recursive: true });
  fs.writeFileSync(path.join(paths.workspace, 'package.json'), '{"type":"module"}\n');
  fs.copyFileSync(source, compiled);
  const validator = await import(pathToFileURL(compiled).href);
  assert.equal(typeof validator.readLibraryOperationLine, 'function');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = () => fs.existsSync(path.join(root, 'logs')) ? fs.readdirSync(path.join(root, 'logs')).filter(name => /^library-operation-.*\.log$/u.test(name)).sort() : [];
  const text = () => names().map(name => fs.readFileSync(path.join(root, 'logs', name), 'utf8')).join('');
  const events = () => text().split('\n').filter(Boolean).map(line => { const event = validator.readLibraryOperationLine(line); assert.ok(event, '落盘的完整行必须逐条通过原校验器'); return event; });
  return { paths, compiled, names, text, events };
}
const event = (count = 0, action = 'artwork.read') => '[MB_LIBRARY_OPERATION] ' + JSON.stringify({ version: 1, part: 'ui', action,
  state: 'complete', atMs: 1_800_000_000_000, slow: false, message: '资料库页面：完成', count });
function terminal() {
  const stream = new PassThrough(), chunks = [];
  stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}
async function handlePrototype(root) {
  const probe = await promises.open(path.join(root, 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe); await probe.close(); return prototype;
}
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }

test('运行日志仅保存原validator闭集事件，stdout/stderr逐字节保持且原终端不被关闭', async t => {
  const f = await fixture(t), warnings = [], log = await createDesktopDevRuntimeLog(f.paths, { warn: text => warnings.push(text) });
  assert.equal(log.enabled, true);
  const stdout = new PassThrough(), stderr = new PassThrough(), out = terminal(), err = terminal();
  const detach = teeDesktopRuntimeOutput({ stdout, stderr }, log, { stdout: out.stream, stderr: err.stream, warn: text => warnings.push(text) });
  t.after(detach);
  const originalOut = 'SYNTHETIC_TOKEN=不应落盘\n' + event(1) + '\n';
  const invalid = event(2).replace('"count":2', '"count":2,"absolutePath":"/synthetic/private"');
  const originalErr = '合成通用stderr，不应落盘\n' + invalid + '\n' + event(3, 'artwork.queue') + '\n';
  stdout.end(Buffer.from(originalOut)); stderr.end(Buffer.from(originalErr));
  await Promise.all([finished(stdout), finished(stderr)]); await log.close(); detach();
  assert.equal(out.text(), originalOut); assert.equal(err.text(), originalErr);
  assert.equal(out.stream.writableEnded, false); assert.equal(err.stream.writableEnded, false);
  assert.deepEqual(f.events().map(value => value.count).sort(), [1, 3]);
  assert.doesNotMatch(f.text(), /SYNTHETIC_TOKEN|不应落盘|absolutePath|synthetic\/private/u); assert.deepEqual(warnings, []);
});

test('stdout/stderr的UTF8与半行独立组装，退出时仅补完整合法的无换行末事件', async t => {
  const f = await fixture(t), log = await createDesktopDevRuntimeLog(f.paths, { warn() {} });
  const first = Buffer.from(event(4)), second = Buffer.from(event(5, 'albums.page') + '\n');
  const cut = first.indexOf(Buffer.from('资料库页面')) + 1;
  log.stdout(first.subarray(0, cut)); log.stderr(second); log.stdout(first.subarray(cut));
  await log.close();
  assert.deepEqual(f.events().map(value => value.count).sort(), [4, 5]);
});

test('超长行整条丢弃，行尾伪造前缀、任意JSON字段与非闭集诊断不落盘', async t => {
  const f = await fixture(t), log = await createDesktopDevRuntimeLog(f.paths, { warn() {} });
  log.stdout(Buffer.from('合成私密长行' + 'x'.repeat(3000)));
  log.stdout(Buffer.from(event(6) + '\n'));
  log.stderr(Buffer.from('[MB_LOCAL_ALBUM_READ_TRACE] {"private":"SYNTHETIC_SECRET"}\n'));
  log.stderr(Buffer.from(event(7).replace('"count":7', '"count":7,"cookie":"SYNTHETIC_SECRET"') + '\n'));
  log.stdout(Buffer.from(event(8) + '\n')); await log.close();
  assert.deepEqual(f.events().map(value => value.count), [8]); assert.doesNotMatch(f.text(), /SYNTHETIC_SECRET|私密/u);
});

test('日志完整事件分段，每个文件不超过4KiB测试预算且全局最多三份', async t => {
  const f = await fixture(t), warnings = [], log = await createDesktopDevRuntimeLog(f.paths, { maxFileBytes: 4096, warn: text => warnings.push(text) });
  for (let index = 0; index < 150; index++) log.stdout(Buffer.from(event(index) + '\n'));
  await log.close(); assert.equal(f.names().length, 3);
  const sizes = f.names().map(name => fs.statSync(path.join(f.paths.root, 'logs', name)).size);
  assert.ok(sizes.every(size => size <= 4096)); assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= 3 * 4096);
  assert.ok(f.events().some(value => value.count === 149)); assert.ok(!f.events().some(value => value.count === 0));
  for (const name of f.names()) { const info = fs.statSync(path.join(f.paths.root, 'logs', name)); assert.equal(info.mode & 0o777, 0o600); assert.equal(info.nlink, 1); }
  assert.deepEqual(warnings, []);
});

test('每次runtime创建独立文件，跨四次运行仍只保留三份且不碰其他日志', async t => {
  const f = await fixture(t), files = [];
  fs.mkdirSync(path.join(f.paths.root, 'logs')); fs.writeFileSync(path.join(f.paths.root, 'logs', 'unrelated.log'), '合成其他日志');
  for (let run = 0; run < 4; run++) {
    const log = await createDesktopDevRuntimeLog(f.paths, { warn() {} }); assert.equal(log.enabled, true); files.push(log.firstFile);
    log.stdout(Buffer.from(event(run) + '\n')); await log.close();
    assert.ok(f.names().length <= 3); assert.ok(fs.existsSync(log.firstFile));
  }
  assert.equal(new Set(files).size, 4); assert.equal(f.names().length, 3);
  assert.equal(fs.readFileSync(path.join(f.paths.root, 'logs', 'unrelated.log'), 'utf8'), '合成其他日志');
});

test('编译validator缺失只禁用日志，不回落路径或输出异常正文', async t => {
  const f = await fixture(t), warnings = []; fs.unlinkSync(f.compiled);
  const log = await createDesktopDevRuntimeLog(f.paths, { warn: text => warnings.push(text) });
  assert.equal(log.enabled, false); log.stdout(Buffer.from(event())); log.stderr(Buffer.from('SYNTHETIC_SECRET')); await log.close();
  assert.equal(f.names().length, 0); assert.equal(warnings.length, 1); assert.match(warnings[0], /初始化失败/u);
  assert.doesNotMatch(warnings[0], /SYNTHETIC_SECRET|ENOENT|workspace/u);
});

test('日志目录符号链接被原路径policy拒绝，外部目录和终端旁路保持', async t => {
  const f = await fixture(t), warnings = [], outside = path.join(f.paths.root, 'synthetic-private'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.paths.root, 'logs'));
  const log = await createDesktopDevRuntimeLog(f.paths, { warn: text => warnings.push(text) });
  assert.equal(log.enabled, false); await log.close(); assert.deepEqual(fs.readdirSync(outside), []); assert.equal(warnings.length, 1);
});

test('真实FileHandle写入失败只安全提示一次，原始异常与后续通用输出不落盘', async t => {
  const f = await fixture(t), prototype = await handlePrototype(f.paths.root), warnings = [];
  t.mock.method(prototype, 'write', async function () { throw new Error('SYNTHETIC_CREDENTIAL=/private/never-log'); });
  const log = await createDesktopDevRuntimeLog(f.paths, { warn: text => warnings.push(text) });
  log.stdout(Buffer.from(event(10) + '\n')); await log.close();
  log.stdout(Buffer.from('SYNTHETIC_CREDENTIAL\n' + event(11) + '\n'));
  assert.equal(warnings.length, 1); assert.match(warnings[0], /写入失败/u); assert.doesNotMatch(warnings[0], /SYNTHETIC_CREDENTIAL|private/u);
  assert.equal(f.text(), '');
});

test('慢写达到4KiB待写上限时停止持久化，终端原字节仍全部转发', async t => {
  const f = await fixture(t), prototype = await handlePrototype(f.paths.root), originalWrite = prototype.write, gate = deferred(), warnings = [];
  t.mock.method(prototype, 'write', async function (...args) { await gate.promise; return originalWrite.apply(this, args); });
  const log = await createDesktopDevRuntimeLog(f.paths, { maxPendingBytes: 4096, warn: text => warnings.push(text) });
  assert.equal(log.enabled, true); t.after(async () => { gate.resolve(); await log.close(); });
  const stdout = new PassThrough(), stderr = new PassThrough(), out = terminal(), err = terminal();
  const detach = teeDesktopRuntimeOutput({ stdout, stderr }, log, { stdout: out.stream, stderr: err.stream }); t.after(detach);
  const original = Array.from({ length: 64 }, (_, index) => event(index) + '\n').join('');
  stdout.end(Buffer.from(original)); stderr.end('合成通用stderr\n'); await Promise.all([finished(stdout), finished(stderr)]);
  assert.equal(out.text(), original); assert.equal(err.text(), '合成通用stderr\n'); assert.equal(warnings.length, 1); assert.match(warnings[0], /队列达到上限/u);
  gate.resolve(); await log.close(); detach(); assert.ok(f.events().length <= 1);
});

test('日志收尾等待有界，超时不等待迟到写入；真实handle最终仍关闭且不再接受事件', async t => {
  const f = await fixture(t), prototype = await handlePrototype(f.paths.root), originalWrite = prototype.write;
  const gate = deferred(), closed = deferred(), warnings = [], originalOpen = promises.open;
  let activeHandle;
  // Node 22 的 close 属于实例；捕捉真实日志句柄，不能把不存在的原型方法当成关闭证据。
  t.mock.method(promises, 'open', async function (...args) {
    const handle = await originalOpen.apply(this, args);
    if (String(args[0]).endsWith('.log')) activeHandle = handle;
    return handle;
  });
  const log = await createDesktopDevRuntimeLog(f.paths, { warn: text => warnings.push(text) });
  assert.equal(log.enabled, true); assert.ok(activeHandle); t.after(async () => { gate.resolve(); await log.close(); });
  const originalClose = activeHandle.close;
  t.mock.method(prototype, 'write', async function (...args) { await gate.promise; return originalWrite.apply(this, args); });
  t.mock.method(activeHandle, 'close', async function (...args) { try { return await originalClose.apply(this, args); } finally { closed.resolve(); } });
  let timeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { assert.equal(delay, 1000); timeout = callback; return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  log.stdout(Buffer.from(event(12) + '\n')); const closing = log.close(); assert.equal(typeof timeout, 'function');
  timeout(); await closing; assert.equal(warnings.length, 1); assert.match(warnings[0], /收尾超过1秒/u);
  log.stdout(Buffer.from(event(13) + '\n')); gate.resolve(); await closed.promise;
  assert.ok(!f.events().some(value => value.count === 13)); assert.equal(await log.close(), undefined);
});
