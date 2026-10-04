import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, chmod, writeFile, symlink, link } from 'node:fs/promises'
import path from 'node:path'
import { readPackagedRendererProfile, readPackagedRendererProfileWithinRoot } from '../src/main/packaged-renderer-main-probe.js'
import { validateSyntheticProfileDirectory } from '../src/main/synthetic-profile-root.js'
import { syntheticFixtureRoot } from './helpers/synthetic-profile-root.js'

test('受控根与正式profile wrapper分离，nonce/权限/链接/闭集保护保持', async () => {
  const root = syntheticFixtureRoot(), directory = await mkdtemp(path.join(root.directory, 'musicbridge-ui-diagnostics-rust016-'))
  await chmod(directory, 0o700)
  const marker = path.join(directory, 'rust013-profile.json'), nonce = randomUUID()
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, kind: 'rust013-synthetic-profile', nonce }), { mode: 0o600 })
  const env = { MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_UI_E2E_OFFLINE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory }
  assert.equal(readPackagedRendererProfileWithinRoot(env, root).nonce, nonce)
  assert.throws(() => validateSyntheticProfileDirectory(directory, { ...root, device: 'wrong' }))
  assert.throws(() => validateSyntheticProfileDirectory(directory + '/../' + path.basename(directory), root))
  const alias = path.join(root.directory, 'musicbridge-ui-diagnostics-rust016-alias-' + randomUUID())
  await symlink(directory, alias); assert.throws(() => validateSyntheticProfileDirectory(alias, root))
  await chmod(directory, 0o755); assert.throws(() => readPackagedRendererProfileWithinRoot(env, root)); await chmod(directory, 0o700)
  for (const value of [{ schemaVersion: 1, kind: 'rust013-synthetic-profile', nonce: 'bad' }, { schemaVersion: 1, kind: 'rust013-synthetic-profile', nonce, root: '/any' }]) {
    await writeFile(marker, JSON.stringify(value)); assert.throws(() => readPackagedRendererProfileWithinRoot(env, root))
  }
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, kind: 'rust013-synthetic-profile', nonce }))
  await link(marker, path.join(directory, 'marker-hardlink')); assert.throws(() => readPackagedRendererProfileWithinRoot(env, root))
  assert.throws(() => readPackagedRendererProfile({ ...env, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: '/Users/yihe/Library/Application Support/MusicBridge' }))
})
