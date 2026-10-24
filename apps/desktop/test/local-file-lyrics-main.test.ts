import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { isCollectionId, validateIpcRequest } from '@music-bridge/contracts';

/** 执行实际Main参数guard和实际lyrics:get handler；不启动Electron、不构造Source权限。 */
async function fixture() {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions: string[] = [], handlers: string[] = [];
  function walk(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && ['requirePlaybackTrackId', 'requireLyricsTrackId'].includes(node.name.text)) functions.push(node.getText(ast));
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerPerformanceHandler'
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'lyrics:get') handlers.push(node.getText(ast));
    ts.forEachChild(node, walk);
  }
  walk(ast); assert.equal(functions.length, 2); assert.equal(handlers.length, 1);
  let handler!: (event: { trusted: boolean }, trackId: unknown) => Promise<unknown>;
  const calls: { command: string; payload: unknown }[] = [];
  const context = { isCollectionId, publicIpcFailure: (code: string) => { throw Object.assign(new Error('合成参数拒绝'), { code }); },
    registerPerformanceHandler: (name: string, operation: typeof handler) => { assert.equal(name, 'lyrics:get'); handler = operation; },
    invokeCore: async (event: { trusted: boolean }, work: () => Promise<unknown>) => { if (!event.trusted) throw new Error('不可信来源'); return work(); },
    supervisor: { request: async (command: string, payload: unknown) => {
      assert.equal(validateIpcRequest({ version: 1, id: 'actual-main-lyrics', command, payload }).ok, true);
      calls.push({ command, payload: structuredClone(payload) }); return { status: 'unavailable', lines: [], activeLineIndex: -1, timingSource: 'static' };
    } }, requirePlaybackTrackId: undefined as unknown, requireLyricsTrackId: undefined as unknown };
  runInNewContext(ts.transpileModule(functions.join('\n') + '\n' + handlers[0] + ';', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { handler, calls, playbackGuard: context.requirePlaybackTrackId as (value: unknown) => string };
}

test('实际Main歌词handler：规范UUID与数字透传同一lyrics.get，原数字播放guard继续拒UUID', async () => {
  const f = await fixture(), id = randomUUID();
  await f.handler({ trusted: true }, id); await f.handler({ trusted: true }, '123');
  assert.deepEqual(f.calls, [{ command: 'lyrics.get', payload: { trackId: id } }, { command: 'lyrics.get', payload: { trackId: '123' } }]);
  assert.throws(() => f.playbackGuard(id)); assert.equal(f.playbackGuard('123'), '123');
});

test('实际Main歌词handler：不可信、路径、畸形/非规范ID在Supervisor与Source派发前拒绝', async () => {
  const f = await fixture(); await assert.rejects(f.handler({ trusted: false }, randomUUID()));
  for (const id of ['0', '', '../一.lrc', 'file:///私有/一.lrc', 'not-a-numeric-id', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 123, null]) await assert.rejects(f.handler({ trusted: true }, id));
  assert.equal(f.calls.length, 0);
});
