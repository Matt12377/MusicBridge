import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import beforePack, { captureNativeConverter, verifyNativeConverterPackage } from '../scripts/native-converter-package.mjs'

// 只验证打包身份链，不运行合成程序，也不充当真实转换证据。
test('打包准入绑定应用编译时清单，拒绝缺包、内容漂移、符号链接与缺失许可材料', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-native-package-')))
  const bundle = path.join(root, 'native/ffmpeg/darwin-arm64'), dist = path.join(root, 'dist/main')
  const hash = (b: string) => createHash('sha256').update(b).digest('hex')
  try {
    assert.deepEqual(await captureNativeConverter(root), { schemaVersion: 1, manifestSha256: null })
    await mkdir(dist, { recursive: true })
    await writeFile(path.join(dist, 'output-build.json'), JSON.stringify({ schemaVersion: 1, manifestSha256: null }))
    await writeFile(path.join(dist, 'converter-build.json'), JSON.stringify({ schemaVersion: 1, manifestSha256: null }))
    await assert.rejects(verifyNativeConverterPackage(root))
    for (const dir of ['bin', 'lib', 'legal']) await mkdir(path.join(bundle, dir), { recursive: true })
    const binary = (name: string) => ({ path: name, sha256: hash(name), versionSha256: hash('version') })
    const programs = { ffmpeg: binary('bin/ffmpeg'), ffprobe: binary('bin/ffprobe') }
    const dependencies = ['avcodec.62','avfilter.11','avformat.62','avutil.60','swresample.6'].map(name => ({ id: `lib${name}.dylib`, path: `lib/lib${name}.dylib`, sha256: hash(`lib/lib${name}.dylib`) }))
    for (const pin of [...Object.values(programs), ...dependencies]) await writeFile(path.join(bundle, pin.path), pin.path)
    const source = '固定的合成源码，仅用于打包测试'
    const manifest = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', sourceSha256: hash(source), build: { ...programs, dependencies } }
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest))
    for (const name of ['COPYING.LGPLv2.1','LICENSE.md','NOTICE.txt','BUILD.json']) await writeFile(path.join(bundle, 'legal', name), name)
    await writeFile(path.join(bundle, 'legal/ffmpeg-8.1.2.tar.xz'), source)
    const captured = await captureNativeConverter(root)
    await writeFile(path.join(dist, 'converter-build.json'), JSON.stringify(captured))
    assert.equal(await verifyNativeConverterPackage(root), bundle)
    const priorDiscovery = process.env.CSC_IDENTITY_AUTO_DISCOVERY
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    try {
      const context = { electronPlatformName: 'darwin', arch: 3, packager: { platformSpecificBuildOptions: { identity: null }, info: { appDir: root }, config: { electronFuses: { resetAdHocDarwinSignature: true } } } }
      await beforePack(context)
      await assert.rejects(beforePack({ ...context, packager: { ...context.packager, config: { electronFuses: { resetAdHocDarwinSignature: false } } } }))
    } finally {
      if (priorDiscovery === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY
      else process.env.CSC_IDENTITY_AUTO_DISCOVERY = priorDiscovery
    }
    await writeFile(path.join(bundle, 'bin/ffmpeg'), '被修改')
    await assert.rejects(verifyNativeConverterPackage(root))
    await writeFile(path.join(bundle, 'bin/ffmpeg'), 'bin/ffmpeg')
    await rm(path.join(bundle, 'lib', dependencies[0]!.id))
    await symlink(path.join(bundle, 'bin/ffmpeg'), path.join(bundle, 'lib', dependencies[0]!.id))
    await assert.rejects(verifyNativeConverterPackage(root))
    await rm(path.join(bundle, 'lib', dependencies[0]!.id))
    await writeFile(path.join(bundle, dependencies[0]!.path), dependencies[0]!.path)
    await rm(path.join(bundle, 'legal/NOTICE.txt'))
    await assert.rejects(verifyNativeConverterPackage(root))
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ ...manifest, arch: 'x64' }))
    await assert.rejects(verifyNativeConverterPackage(root))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('边界 Gate 只放行 Core 内固定策略模块，不放行外部转换库或 Renderer 导入', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFile } = await import('node:fs/promises')
  const project = path.resolve(import.meta.dirname, '../../..')
  const root = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-boundary-'))
  const file = 'packages/bridge-core/src/recording/bundled-converter.ts'
  try {
    for (const relative of ['apps/desktop/src/main/security.ts', 'packages/bridge-core/src/config/config.ts', '.github/workflows/verify.yml', '.github/workflows/security.yml', '.github/workflows/electron-e2e.yml']) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
      await writeFile(path.join(root, relative), await readFile(path.join(project, relative)))
    }
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    const allowed = "import { ffmpegBuildPolicy } from './ffmpeg-build-policy.js'"
    const run = () => execFileSync(process.execPath, [path.join(project, 'scripts/ci/verify-boundaries.mjs')], { cwd: root, stdio: 'pipe' }).toString()
    await writeFile(path.join(root, file), allowed)
    assert.match(run(), /BOUNDARIES=PASS/)
    for (const rejected of ["import codec from 'ffmpeg'", "import 'ffmpeg'", "const codec = import('ffmpeg')", "import codec from 'fluent-ffmpeg'", "import codec from 'transcoder'", "const codec = require('unblockmusic')"]) {
      await writeFile(path.join(root, file), allowed + '\n' + rejected)
      assert.throws(run, /audio-boundary/)
    }
    await writeFile(path.join(root, file), allowed)
    const renderer = path.join(root, 'apps/desktop/src/renderer/component.ts')
    await mkdir(path.dirname(renderer), { recursive: true }); await writeFile(renderer, allowed)
    assert.throws(run, /audio-boundary/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
