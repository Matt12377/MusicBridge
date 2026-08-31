import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

test('Excel Main仅提供有界读取和预览，拒绝不可信Renderer与私有字段', async () => {
  const module = await import('../src/main/spreadsheet-import-ipc.js').catch(() => ({}))
  assert.ok('installSpreadsheetImportReads' in module, '缺少Excel受限读取入口')
  const install = (module as typeof import('../src/main/spreadsheet-import-ipc.js')).installSpreadsheetImportReads
  const handlers = new Map<string, (event: boolean, value?: unknown) => unknown>(), calls: Array<[string, unknown]> = []
  install({ handle: (channel, handler) => handlers.set(channel, handler), requireTrusted: (trusted: boolean) => { if (!trusted) throw new Error('不可信Renderer') }, supervisor: { request: (async (command: string, payload: unknown) => { calls.push([command, payload]); return { synthetic: true } }) as never } })
  const invoke = (channel: string, value?: unknown, trusted = true) => Promise.resolve().then(() => handlers.get(channel)!(trusted, value))
  assert.deepEqual([...handlers.keys()].sort(), ['sources', 'source', 'sourceRows', 'preview', 'revision', 'history', 'adjustmentPreview', 'adjustments'].map(name => `spreadsheetImports:${name}`).sort())
  await assert.rejects(invoke('spreadsheetImports:sources', { offset: 0, limit: 25 }, false))
  await assert.rejects(invoke('spreadsheetImports:sources', { offset: 0, limit: 25, absolutePath: '/synthetic/workbook.xlsx' }))
  await assert.rejects(invoke('spreadsheetImports:source', { id: '/synthetic/workbook.xlsx' }))
  assert.equal(calls.length, 0)
  const id = randomUUID(); await invoke('spreadsheetImports:source', { id })
  assert.deepEqual(calls, [['spreadsheetImports.source', { id }]])
})
