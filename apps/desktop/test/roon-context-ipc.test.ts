import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const handle = '11111111-1111-4111-8111-111111111111'
const reference = `musicbridge-v2-entity-${handle}`
async function mainHandler() {
  const source = await readFile(path.resolve('src/main/index.ts'), 'utf8')
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = ast.statements.filter(ts.isFunctionDeclaration).filter(node => ['requireZoneId', 'requireRoonReference', 'requireRoonEntityReference', 'requireRoonQueueReferences', 'requireRoonPlaybackContextHandle'].includes(node.name?.text ?? ''))
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'registerPerformanceHandler' && node.arguments[0]?.getText(ast) === "'roon:library:play'") expression = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(ast); assert.ok(expression, '须执行实际Main注册处理函数')
  const calls: unknown[][] = []
  const code = `${functions.map(node => node.getText(ast)).join('\n')}\nexports.handler = ${expression!.getText(ast)};`
  const exports: { handler?: (...args: unknown[]) => Promise<unknown> } = {}
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, MAX_PLAYBACK_QUEUE_ITEMS: 5000,
    publicIpcFailure: (code: string, message: string) => { throw Object.assign(new Error(message), { code }) },
    invokeCore: async (_event: unknown, operation: () => unknown) => operation(),
    supervisor: { request: async (...args: unknown[]) => { calls.push(JSON.parse(JSON.stringify(args))); return { started: true } } },
  })
  return { handler: exports.handler!, calls }
}

test('003B：实际Main传递handle、保留旧队列和单曲入口', async () => {
  const f = await mainHandler()
  await f.handler({}, reference, 'zone', undefined, handle)
  assert.deepEqual(f.calls[0], ['roon.library.play', { reference, zoneId: 'zone', contextHandle: handle }])
  await f.handler({}, reference, 'zone', [reference])
  await f.handler({}, reference, 'zone')
  assert.deepEqual(f.calls.slice(1), [['roon.library.play', { reference, zoneId: 'zone', queueReferences: [reference] }], ['roon.library.play', { reference, zoneId: 'zone' }]])
})

test('003B：实际Main拒绝混用、坏handle与私有值，零Core派发', async () => {
  const f = await mainHandler()
  await assert.rejects(f.handler({}, reference, 'zone', [reference], handle))
  for (const value of [null, 1, '', '/private/session']) await assert.rejects(f.handler({}, reference, 'zone', undefined, value))
  assert.equal(f.calls.length, 0)
})
