import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('主题 IPC 拒绝不可信来源和非法值，仅改变窗口外观', async () => {
  const source = await readFile('src/main/index.ts', 'utf8')
  const start = source.indexOf("  ipcMain.handle('app:set-appearance-theme'")
  const end = source.indexOf("  ipcMain.handle('app:get-info'", start)
  assert.ok(start > 0 && end > start)
  let handler!: (event: { trusted: boolean }, theme: unknown) => void
  const nativeTheme = { themeSource: 'light' }
  let background = '#f2edf1'
  runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    ipcMain: { handle: (channel: string, callback: typeof handler) => { assert.equal(channel, 'app:set-appearance-theme'); handler = callback } },
    requireTrustedRenderer: (event: { trusted: boolean }) => { if (!event.trusted) throw Error('拒绝来源'); return { setBackgroundColor: (value: string) => { background = value } } },
    publicIpcFailure: (code: string) => { throw Error(code) },
    nativeTheme,
  })
  assert.throws(() => handler({ trusted: false }, 'dark'), /拒绝来源/)
  for (const value of [undefined, null, {}, 'system', 'DARK', 'dark;anything']) assert.throws(() => handler({ trusted: true }, value), /INVALID_IPC_REQUEST/)
  assert.equal(nativeTheme.themeSource, 'light')
  assert.equal(background, '#f2edf1')
  handler({ trusted: true }, 'dark')
  assert.equal(nativeTheme.themeSource, 'dark')
  assert.equal(background, '#3c4253')
  handler({ trusted: true }, 'light')
  assert.equal(nativeTheme.themeSource, 'light')
  assert.equal(background, '#f2edf1')
})
