import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

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
