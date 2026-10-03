import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { captureNativeOutputDevice, verifyNativeOutputDevicePackage } from '../scripts/native-output-device-package.mjs'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function fixture(t: test.TestContext) {
  const app = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-output-device-package-')))
  t.after(() => rm(app, { recursive: true, force: true }))
  const root = path.join(app, 'native/output-device/darwin-arm64')
  await mkdir(path.join(root, 'bin'), { recursive: true })
  await mkdir(path.join(app, 'dist/main'), { recursive: true })
  const helper = path.join(root, 'bin/output-device-helper')
  await writeFile(helper, '受控假helper，不执行HAL', { mode: 0o755 })
  const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', protocolVersion: 1,
    backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0', mode: 'device',
    drainAlgorithmId: 'hal-sample-zero-cover-v1', sourceSha256: 'a'.repeat(64),
    files: { helper: { path: 'bin/output-device-helper', sha256: sha(await readFile(helper)) } } }
  const writeManifest = async (value: unknown) => {
    const bytes = `${JSON.stringify(value)}\n`
    await writeFile(path.join(root, 'manifest.json'), bytes)
    return sha(bytes)
  }
  return { app, root, helper, manifest, writeManifest }
}

test('v0.2设备包非null构建pin绑定精确文件；旧包、缺包与篡改均拒绝', async t => {
  const x = await fixture(t)
  const manifestSha256 = await x.writeManifest(x.manifest)
  const captured = await captureNativeOutputDevice(x.app)
  assert.deepEqual(captured, { schemaVersion: 1, manifestSha256, candidate: null })
  await writeFile(path.join(x.app, 'dist/main/output-device-build.json'), JSON.stringify(captured))
  assert.equal(await verifyNativeOutputDevicePackage(x.app), x.root)

  await writeFile(x.helper, '篡改helper')
  await assert.rejects(verifyNativeOutputDevicePackage(x.app))
  await writeFile(x.helper, '受控假helper，不执行HAL')
  await chmod(x.helper, 0o777)
  await assert.rejects(verifyNativeOutputDevicePackage(x.app))
  await chmod(x.helper, 0o755)
  await rm(x.helper)
  await symlink(path.join(x.root, 'manifest.json'), x.helper)
  await assert.rejects(verifyNativeOutputDevicePackage(x.app))
  await rm(x.helper)
  await writeFile(x.helper, '受控假helper，不执行HAL', { mode: 0o755 })

  await x.writeManifest({ ...x.manifest, backendVersion: '0.1.0', mode: 'synthetic-only' })
  await assert.rejects(verifyNativeOutputDevicePackage(x.app))
  await x.writeManifest(x.manifest)
  await writeFile(path.join(x.app, 'dist/main/output-device-build.json'), JSON.stringify({ ...captured, manifestSha256: null }))
  await assert.rejects(verifyNativeOutputDevicePackage(x.app), '已存在的设备包不能由null pin晚绑定')
  await writeFile(path.join(x.app, 'dist/main/output-device-build.json'), JSON.stringify({ ...captured,
    candidate: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), sourceSha256: x.manifest.sourceSha256,
      manifestSha256, helperSha256: 'c'.repeat(64) } }))
  await assert.rejects(verifyNativeOutputDevicePackage(x.app), 'candidate不得与helper真实Hash漂移')
})

test('缺包编译为null，后来加入的包不能获得准入', async t => {
  const app = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-output-device-null-')))
  t.after(() => rm(app, { recursive: true, force: true }))
  assert.deepEqual(await captureNativeOutputDevice(app), { schemaVersion: 1, manifestSha256: null, candidate: null })
  await mkdir(path.join(app, 'dist/main'), { recursive: true })
  await writeFile(path.join(app, 'dist/main/output-device-build.json'), JSON.stringify({ schemaVersion: 1, manifestSha256: null, candidate: null }))
  assert.equal(await verifyNativeOutputDevicePackage(app), undefined)
  await mkdir(path.join(app, 'native/output-device/darwin-arm64'), { recursive: true })
  await assert.rejects(verifyNativeOutputDevicePackage(app))
})

test('仅干净且源码与manifest一致的Git树产生真实候选；dirty不妨碍普通Replica包pin', async t => {
  const project = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-device-candidate-')))
  t.after(() => rm(project, { recursive: true, force: true }))
  const app = path.join(project, 'apps/desktop'), root = path.join(app, 'native/output-device/darwin-arm64')
  const sourceNames = ['native/output-helper/frame-pump.cpp', 'native/output-helper/frame-pump.hpp',
    'native/output-device/device-helper-main.cpp', 'scripts/build-output-device-helper.mjs'].sort()
  const contents = sourceNames.map((name, index) => `${name}:${index}\n`)
  for (let index = 0; index < sourceNames.length; index++) {
    const file = path.join(project, sourceNames[index]!)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents[index]!)
  }
  const sourceSha256 = sha(sourceNames.map((name, index) => `${name}\0${sha(contents[index]!)}\n`).join(''))
  await mkdir(path.join(root, 'bin'), { recursive: true })
  const helper = path.join(root, 'bin/output-device-helper')
  await writeFile(helper, '受控候选字节', { mode: 0o755 })
  const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', protocolVersion: 1,
    backendId: 'musicbridge-coreaudio-hal', backendVersion: '0.2.0', mode: 'device',
    drainAlgorithmId: 'hal-sample-zero-cover-v1', sourceSha256,
    files: { helper: { path: 'bin/output-device-helper', sha256: sha(await readFile(helper)) } } }
  await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
  await writeFile(path.join(project, '.gitignore'), 'apps/desktop/native/output-device/\n')
  execFileSync('git', ['init', '-q'], { cwd: project })
  execFileSync('git', ['add', '-A'], { cwd: project })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: project })
  const captured = await captureNativeOutputDevice(app)
  assert.ok(captured.candidate)
  assert.equal(captured.candidate.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project }).toString().trim())
  assert.equal(captured.candidate.tree, execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: project }).toString().trim())
  assert.equal(captured.candidate.sourceSha256, sourceSha256)
  assert.equal(captured.candidate.manifestSha256, captured.manifestSha256)
  assert.equal(captured.candidate.helperSha256, manifest.files.helper.sha256)
  await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify({ ...manifest, sourceSha256: 'b'.repeat(64) })}\n`)
  const mismatched = await captureNativeOutputDevice(app)
  assert.notEqual(mismatched.manifestSha256, captured.manifestSha256)
  assert.equal(mismatched.candidate, null, '即使Git干净，helper清单不对应当前源码也不能签发候选身份')
  await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`)
  await writeFile(path.join(project, sourceNames[0]!), 'dirty源码')
  const dirty = await captureNativeOutputDevice(app)
  assert.equal(dirty.manifestSha256, captured.manifestSha256)
  assert.equal(dirty.candidate, null)
})

test('构建和打包入口携带独立设备pin与资源，不借旧synthetic包', async () => {
  const config = await readFile(new URL('../electron.vite.config.ts', import.meta.url), 'utf8')
  const entry = await readFile(new URL('../src/main/recording-bootstrap.ts', import.meta.url), 'utf8')
  const coreEntry = await readFile(new URL('../src/main/core-entry.ts', import.meta.url), 'utf8')
  const coreHost = await readFile(new URL('../src/main/core-host.ts', import.meta.url), 'utf8')
  const ownerEntry = await readFile(new URL('../src/main/dataset-owner-entry.ts', import.meta.url), 'utf8')
  const beforePack = await readFile(new URL('../scripts/native-converter-package.mjs', import.meta.url), 'utf8')
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(config, /captureNativeOutputDevice\(currentDirectory\)/u)
  assert.match(config, /output-device-build\.json/u)
  assert.match(config, /__MUSIC_BRIDGE_OUTPUT_DEVICE_CANDIDATE__/u)
  assert.match(config, /'dataset-owner': path\.join\(currentDirectory, 'src\/main\/dataset-owner-entry\.ts'\)/u)
  assert.match(coreEntry, /void runDesktopCoreHost\(\{ optionalReadonlyManager: manager/u)
  assert.match(coreHost, /createWorker\(new URL\('\.\/dataset-owner\.js'/u)
  assert.match(ownerEntry, /await loadRecordingDependenciesForOwner/u)
  assert.match(entry, /loadBundledDeviceOutputHelper/u)
  assert.match(entry, /output-device.*darwin-arm64/u)
  assert.match(beforePack, /verifyNativeOutputDevicePackage/u)
  assert.ok(packageJson.build.extraResources.some((resource: { from: string; to: string }) =>
    resource.from === 'native/output-device/darwin-arm64' && resource.to === 'output-device/darwin-arm64'))
})
