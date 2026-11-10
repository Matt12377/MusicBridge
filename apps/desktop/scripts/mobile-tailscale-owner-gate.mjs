import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { prepareCoreTestEnvironment } from '../../../scripts/ci/run-core-tests.mjs'

// Fresh real SQLite Owner + metadata Reader + production Main/worker factories.
// All media, identities, accounts and HTTPS listeners belong to synthetic private fixtures; never VPN/audio acceptance.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
assert.match(process.versions.node, /^22\./u)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const script = fileURLToPath(import.meta.url), scriptHash = hash(readFileSync(script))
const coreRequire = createRequire(path.join(repository, 'packages/bridge-core/package.json'))
const { build } = coreRequire('esbuild')
const prepared = await prepareCoreTestEnvironment()
const output = path.join(prepared.privateRoot, 'qualified-tailscale-main')
mkdirSync(output, { mode: 0o700 })
writeFileSync(path.join(output, 'package.json'), JSON.stringify({ type: 'module' }), { mode: 0o600 })
const externalPackages = { name: 'qualified-existing-package-graph', setup(builder) {
  builder.onResolve({ filter: /^[^./]/ }, async args => {
    if (args.kind === 'entry-point' || args.pluginData?.qualifiedExternalResolution) return undefined
    if (isBuiltin(args.path)) return { path: args.path, external: true }
    const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir || repository, kind: args.kind,
      pluginData: { qualifiedExternalResolution: true } })
    if (resolved.errors.length) return { errors: resolved.errors }
    return { path: resolved.path, external: true }
  })
} }
const common = { absWorkingDir: repository, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  sourcemap: 'external', metafile: true, plugins: [externalPackages], logLevel: 'silent' }
const mainFile = path.join(output, 'qualified-mobile-main.mjs')
const main = await build({ ...common, outfile: mainFile, stdin: {
  contents: [
    "export { createMobileBackend } from './apps/desktop/src/main/mobile-backend.ts';",
    "export * as qualifiedHttps from './apps/desktop/src/main/mobile-https-server.ts';",
    "export * as qualifiedTls from './apps/desktop/src/main/mobile-tls-identity.ts';",
  ].join('\n'), resolveDir: repository, sourcefile: 'qualified-tailscale-main-entry.ts', loader: 'ts',
} })
const workerFile = path.join(output, 'mobile-playback-state-worker-entry.js')
const worker = await build({ ...common, outfile: workerFile, entryPoints: ['apps/desktop/src/main/mobile-playback-state-worker-entry.ts'] })
prepared.assertCurrent()
const artifacts = [mainFile, workerFile, mainFile + '.map', workerFile + '.map'].map(file => ({ file, sha256: hash(readFileSync(file)) }))
const assertCurrent = () => {
  prepared.assertCurrent()
  assert.equal(hash(readFileSync(script)), scriptHash)
  for (const artifact of artifacts) assert.equal(hash(readFileSync(artifact.file)), artifact.sha256)
}
assertCurrent()
writeFileSync(path.join(output, 'fresh-main-build.json'), JSON.stringify({ schema: 'mobile-tailscale-owner-main.v1',
  scriptSha256: scriptHash, artifacts, mainInputs: main.metafile.inputs, workerInputs: worker.metafile.inputs }), { mode: 0o600 })
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
  'test/mbm002/mobile-playback-real-owner.test.ts'], { cwd: path.join(repository, 'apps/desktop'),
  env: { ...prepared.env, MUSIC_BRIDGE_REAL_OWNER_MAIN_TEST_MODULE: mainFile }, stdio: 'inherit', timeout: 240_000, killSignal: 'SIGTERM' })
assertCurrent()
assert.equal(result.error, undefined, 'Owned synthetic test process must settle within its bound.')
assert.equal(result.signal, null)
assert.equal(result.status, 0)
console.log('TAILSCALE_SHARED_REAL_OWNER_SOFTWARE_GATE_PASSED; physical VPN, audible playback and Owner acceptance remain unclaimed.')
