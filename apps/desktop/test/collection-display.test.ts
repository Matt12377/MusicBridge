import assert from 'node:assert/strict'
import test from 'node:test'

test('未知品牌型号只补展示文案，不修改原空数据或生成品牌身份', async () => {
  const { collectionModelLabel } = await import('../src/renderer/src/components/collection/collection-display.js')
  const unknown = Object.freeze({ brand: '', name: '' })
  assert.equal(collectionModelLabel(unknown), '品牌待确认 · 型号待确认')
  assert.deepEqual(unknown, { brand: '', name: '' })
  assert.equal(collectionModelLabel({ brand: '合成品牌', name: '' }), '合成品牌 · 型号待确认')
  assert.equal(collectionModelLabel({ brand: '', name: '合成型号' }), '品牌待确认 · 合成型号')
})

test('完整品牌型号保持既有显示，空白按未知展示而不回写数据', async () => {
  const { collectionModelLabel } = await import('../src/renderer/src/components/collection/collection-display.js')
  assert.equal(collectionModelLabel({ brand: '合成品牌', name: '合成型号' }), '合成品牌 合成型号')
  const whitespace = Object.freeze({ brand: '  ', name: '\t' })
  assert.equal(collectionModelLabel(whitespace), '品牌待确认 · 型号待确认')
  assert.deepEqual(whitespace, { brand: '  ', name: '\t' })
})


test('实际型号详情渲染Unknown标题，不把空品牌型号呈现为空标题', async () => {
  const { readFile } = await import('node:fs/promises')
  const { createRequire } = await import('node:module')
  const { parse, compileScript } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default
  const require = createRequire(import.meta.url), vue = require('vue') as typeof import('vue')
  const source = await readFile(new URL('../src/renderer/src/components/collection/CollectionModelDetail.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source); assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'unknown-model-detail', inlineTemplate: true })
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  let display: unknown
  try { display = await import('../src/renderer/src/components/collection/collection-display.js') } catch { display = {} }
  const module = { exports: {} as { default: import('vue').Component } }
  new Function('require', 'module', 'exports', compiled)((name: string) => name === 'vue' ? vue : name.includes('collection-display') ? display : name.endsWith('.vue') ? { default: { render: () => null } } : require(name), module, module.exports)
  const model = { id: '11111111-1111-4111-8111-111111111111', brand: '', name: '', edition: '', format: 'cassette', tapeType: 'unknown', year: null, identification: 'partial', collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 0, lengths: [null], counts: { total: 10, sealedBlank: 0, openedBlank: 0, legacyUsed: 3, recorded: 0, reserved: 0, unknown: 7, unavailable: 0 } }
  const page = { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
  const { renderToString } = require('vue/server-renderer') as typeof import('vue/server-renderer')
  const app = vue.createSSRApp(module.exports.default, { detail: { model, lots: page, copies: page }, busy: false })
  const html = await renderToString(app)
  assert.match(html, /<h2>品牌待确认 · 型号待确认<\/h2>/u)
  assert.match(html, /<button type="button" disabled>补充库存<\/button>/u)
  assert.match(html, /Excel 导入历史.*数量更正/u)
  assert.equal(model.brand, ''); assert.equal(model.name, '')
})


test('只对已有Unknown或partial型号阻止普通补充，已知手工型号保持可用', async () => {
  const { canManuallyReceiveModel } = await import('../src/renderer/src/components/collection/collection-display.js')
  assert.equal(canManuallyReceiveModel({ brand: '', name: '', identification: 'partial' }), false)
  assert.equal(canManuallyReceiveModel({ brand: '合成', name: 'A', identification: 'partial' }), false)
  assert.equal(canManuallyReceiveModel({ brand: '', name: 'A', identification: 'unidentified' }), false)
  assert.equal(canManuallyReceiveModel({ brand: '合成', name: 'A', identification: 'unidentified' }), true)
})
