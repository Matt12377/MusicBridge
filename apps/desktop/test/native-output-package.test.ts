import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, chmod, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
const load = () => import('../scripts/native-output-package.mjs')
test('输出包在编译时锁定清单，缺包保持禁用；旁边的新清单无法替换旧应用pin', async () => {
  const { captureNativeOutput, verifyNativeOutputPackage } = await load()
  const app = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-output-package-')))
  assert.deepEqual(await captureNativeOutput(app), { schemaVersion: 1, manifestSha256: null })
  const root = path.join(app, 'native/output/darwin-arm64'), dist = path.join(app, 'dist/main'); await mkdir(path.join(root, 'bin'), { recursive: true }); await mkdir(path.join(root, 'build')); await mkdir(dist, { recursive: true })
  const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
  const helper = { path: 'bin/output-helper', sha256: sha('合成helper') }, halAdapter = { path: 'build/core-audio-adapter.o', sha256: sha('合成object') }
  await writeFile(path.join(root, helper.path), '合成helper', { mode: 0o755 }); await writeFile(path.join(root, halAdapter.path), '合成object')
  const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', protocolVersion: 1, backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.1.0', mode: 'synthetic-only', files: { helper, halAdapter }, sourceSha256: 'a'.repeat(64) }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest))
  const captured = await captureNativeOutput(app); await writeFile(path.join(dist, 'output-build.json'), JSON.stringify(captured)); assert.equal(await verifyNativeOutputPackage(app), root)
  await writeFile(path.join(root, helper.path), '更换后helper'); manifest.files.helper.sha256 = sha(await readFile(path.join(root, helper.path))); await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest)); await assert.rejects(verifyNativeOutputPackage(app))
})
test('构建入口实际发出输出pin并把固定输出包纳入已有打包准入', async () => {
  const config = await readFile(new URL('../electron.vite.config.ts', import.meta.url), 'utf8')
  assert.match(config, /captureNativeOutput\(currentDirectory\)/u); assert.match(config, /__MUSIC_BRIDGE_OUTPUT_MANIFEST_SHA256__/u); assert.match(config, /output-build\.json/u)
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(packageJson.build.extraResources.some((r: { from: string; to: string }) => r.from === 'native/output/darwin-arm64' && r.to === 'output/darwin-arm64'))
  assert.match(await readFile(new URL('../scripts/native-converter-package.mjs', import.meta.url), 'utf8'), /verifyNativeOutputPackage/u)
})

test('缺输出构建metadata不能信任旁边包，null pin只允许确实无包', async t => {
  const { verifyNativeOutputPackage } = await load()
  const app = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-output-disabled-')))
  t.after(() => rm(app, { recursive: true, force: true }))
  await assert.rejects(verifyNativeOutputPackage(app))
  const dist = path.join(app, 'dist/main'); await mkdir(dist, { recursive: true })
  await writeFile(path.join(dist, 'output-build.json'), JSON.stringify({ schemaVersion: 1, manifestSha256: null }))
  assert.equal(await verifyNativeOutputPackage(app), undefined)
  await mkdir(path.join(app, 'native/output/darwin-arm64'), { recursive: true })
  await assert.rejects(verifyNativeOutputPackage(app), '残缺包不能以null pin自动准入')
})

test('输出包核验固定manifest语义、文件Hash、权限和符号链接', async t => {
  const { verifyNativeOutputPackage } = await load()
  const app = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-output-shape-')))
  t.after(() => rm(app, { recursive: true, force: true }))
  const root = path.join(app, 'native/output/darwin-arm64'), dist = path.join(app, 'dist/main')
  await mkdir(path.join(root, 'bin'), { recursive: true }); await mkdir(path.join(root, 'build')); await mkdir(dist, { recursive: true })
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', protocolVersion: 1, backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.1.0', mode: 'synthetic-only', files: { helper: { path: 'bin/output-helper', sha256: sha('helper') }, halAdapter: { path: 'build/core-audio-adapter.o', sha256: sha('object') } }, sourceSha256: 'a'.repeat(64) }
  const helper = path.join(root, manifest.files.helper.path), object = path.join(root, manifest.files.halAdapter.path)
  await writeFile(helper, 'helper', { mode: 0o755 }); await writeFile(object, 'object')
  const writeManifest = async (value: unknown) => { const bytes = JSON.stringify(value); await writeFile(path.join(root, 'manifest.json'), bytes); await writeFile(path.join(dist, 'output-build.json'), JSON.stringify({ schemaVersion: 1, manifestSha256: sha(bytes) })) }
  await writeManifest(manifest); assert.equal(await verifyNativeOutputPackage(app), root)
  for (const patch of [{ mode: 'device' }, { arch: 'x64' }, { protocolVersion: 2 }, { backendVersion: '2' }, { sourceSha256: 'A'.repeat(64) }, { files: { ...manifest.files, device: {} } }, { files: { ...manifest.files, helper: { ...manifest.files.helper, path: '../output-helper' } } }]) { await writeManifest({ ...manifest, ...patch }); await assert.rejects(verifyNativeOutputPackage(app)) }
  await writeManifest(manifest)
  await writeFile(helper, 'changed'); await assert.rejects(verifyNativeOutputPackage(app)); await writeFile(helper, 'helper')
  await chmod(helper, 0o777); await assert.rejects(verifyNativeOutputPackage(app)); await chmod(helper, 0o755)
  await rm(object); await symlink(helper, object); await assert.rejects(verifyNativeOutputPackage(app))
})
