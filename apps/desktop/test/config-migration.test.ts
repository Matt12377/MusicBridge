import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

import { migrateRoonConfig } from '../src/main/config-migration.js'

async function makeTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'musicbridge-task012-'))
}

test('Roon config migration atomically copies valid JSON and keeps the legacy file', async () => {
  const root = await makeTempRoot()
  const legacyPath = path.join(root, 'legacy', 'config.json')
  const targetPath = path.join(root, 'app', 'data', 'config.json')
  await mkdir(path.dirname(legacyPath), { recursive: true })
  await writeFile(legacyPath, JSON.stringify({ settings: { output: { output_id: 'zone-1' } } }))

  const result = await migrateRoonConfig({ legacyPath, targetPath })

  assert.equal(result.status, 'copied')
  assert.deepEqual(JSON.parse(await readFile(targetPath, 'utf8')), {
    settings: { output: { output_id: 'zone-1' } },
  })
  assert.equal((await lstat(targetPath)).isFile(), true)
  assert.equal((await lstat(legacyPath)).isFile(), true)
  assert.equal((await lstat(targetPath)).mode & 0o777, 0o600)
})

test('invalid or symlink legacy config is rejected without creating a target', async () => {
  const root = await makeTempRoot()
  const invalidLegacy = path.join(root, 'invalid.json')
  const invalidTarget = path.join(root, 'invalid-target.json')
  await writeFile(invalidLegacy, '{not-json')

  assert.deepEqual(
    await migrateRoonConfig({ legacyPath: invalidLegacy, targetPath: invalidTarget }),
    { status: 'invalid' },
  )

  const realLegacy = path.join(root, 'real.json')
  const linkLegacy = path.join(root, 'link.json')
  const linkTarget = path.join(root, 'link-target.json')
  await writeFile(realLegacy, JSON.stringify({ settings: {} }))
  await symlink(realLegacy, linkLegacy)

  assert.deepEqual(
    await migrateRoonConfig({ legacyPath: linkLegacy, targetPath: linkTarget }),
    { status: 'invalid' },
  )
})

test('existing formal config is preserved and legacy config remains available', async () => {
  const root = await makeTempRoot()
  const legacyPath = path.join(root, 'legacy.json')
  const targetPath = path.join(root, 'target.json')
  await writeFile(legacyPath, JSON.stringify({ settings: { output: { output_id: 'old' } } }))
  await writeFile(targetPath, JSON.stringify({ settings: { output: { output_id: 'new' } } }))
  await chmod(targetPath, 0o600)

  const result = await migrateRoonConfig({ legacyPath, targetPath })

  assert.equal(result.status, 'already_present')
  assert.match(await readFile(targetPath, 'utf8'), /new/)
  assert.match(await readFile(legacyPath, 'utf8'), /old/)
})


test('合成迁移模式在取得任何配置路径之前跳过，不读取或复制旧配置', async () => {
  let pathReads = 0
  const request = {
    mode: 'synthetic-test' as const,
    get legacyPath(): string { ++pathReads; throw new Error('合成模式禁止取得旧配置路径') },
    get targetPath(): string { ++pathReads; throw new Error('跳过迁移不应取得目标路径') },
  }
  assert.deepEqual(await migrateRoonConfig(request), { status: 'skipped_test' })
  assert.equal(pathReads, 0)
})

for (const mode of ['startup', 'ui'] as const) {
  test(`${mode}合成启动实际prepare函数不解析home、不迁移旧配置`, async t => {
    const root = await makeTempRoot()
    t.after(() => rm(root, { recursive: true, force: true }))
    const userData = path.join(root, 'isolated-user-data')
    const sourceText = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    const source = ts.createSourceFile('index.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'prepareCoreDataDirectory')
    assert.ok(declaration, '必须执行现有Main中的精确命名函数')
    const compiled = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    let homeReads = 0
    const currentUserData = userData
    const migrationCalls: Parameters<typeof migrateRoonConfig>[0][] = []
    const result = await runInNewContext(compiled + '\nprepareCoreDataDirectory()', {
      isStartupTest: mode === 'startup', isUiE2e: mode === 'ui',
      syntheticUserDataDirectory: userData,
      startupTestConfiguration: { userDataDirectory: userData, uiE2eUserDataDirectory: userData },
      app: {
        setPath() { assert.fail('prepare 不得在 ready 后切换用户路径') },
        getPath(name: string) {
          if (name === 'home') { ++homeReads; throw new Error('合成启动禁止解析用户home') }
          assert.equal(name, 'userData'); assert.equal(currentUserData, userData); return currentUserData
        },
      },
      path, mkdir, mkdtemp, safeStorage: {},
      migrateRoonConfig: async (request: Parameters<typeof migrateRoonConfig>[0]) => { migrationCalls.push(request); return migrateRoonConfig(request) },
      CredentialVault: class { constructor(readonly options: { filePath: string }) {} },
    }) as { dataDirectory: string; credentialVault: { options: { filePath: string } } }
    assert.equal(homeReads, 0)
    assert.equal(migrationCalls.length, 1)
    assert.deepEqual(Object.keys(migrationCalls[0]!), ['mode'])
    assert.equal((migrationCalls[0] as { mode?: string }).mode, 'synthetic-test')
    assert.equal(result.dataDirectory, path.join(userData, 'data'))
    assert.equal(result.credentialVault.options.filePath, path.join(userData, 'data', 'netease.credential'))
    await assert.rejects(lstat(path.join(userData, 'data', 'config.json')), { code: 'ENOENT' })
  })
}
