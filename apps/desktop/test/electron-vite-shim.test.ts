import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'electron-vite'
import { spreadsheetImportMigration } from '../../../packages/bridge-core/src/collection/spreadsheet-import-store.js'

test('真实 ESM 构建只在模块语句后注入 CommonJS 兼容层，不改写迁移 SQL 字符串', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-build-shim-'))
  const root = path.resolve(import.meta.dirname, '..')
  try {
    const entry = path.join(directory, 'entry.mjs'), output = path.join(directory, 'out')
    // 保持实际多行 SQL；转成 JSON 字符串会掩盖构建器把字符串内 import 当作语句的错误。
    await writeFile(entry, 'export const migration = `' + spreadsheetImportMigration + '`;\nexport const separator = require("node:path").sep;\n')
    const configFile = path.join(directory, 'electron.vite.config.mjs')
    await writeFile(configFile, `export default ${JSON.stringify({ main: { root, build: { outDir: output, rollupOptions: { input: entry, output: { format: 'es', entryFileNames: 'entry.mjs' } } } } })}`)
    await build({ configFile, logLevel: 'silent', ignoreConfigWarning: true })
    const built = await import(pathToFileURL(path.join(output, 'entry.mjs')).href)
    assert.equal(built.migration, spreadsheetImportMigration, '产物必须逐字保留实际迁移 SQL')
    assert.equal(built.separator, path.sep, '兼容层必须实际工作，不能仅移除注入')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
