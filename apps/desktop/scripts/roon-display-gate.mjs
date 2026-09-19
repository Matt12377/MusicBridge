import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { runStartupProcess } from './startup-gate-process.mjs'
import { testElectronArguments } from './test-keychain.mjs'

// 所有数据合成，仅 loopback；独立 Electron，不读取用户设置或真实 Roon。
const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-display-gate-'))
const entry = path.join(directory, 'gate.cjs')
await build({
  entryPoints: [path.join(desktopRoot, 'scripts/roon-display-gate-fixture.mjs')],
  outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  nodePaths: [path.resolve(desktopRoot, '../../node_modules/.pnpm/node_modules')],
})
const result = await runStartupProcess(electron, testElectronArguments([entry], 'mock'), {
  cwd: desktopRoot,
  env: { ...process.env, MUSIC_BRIDGE_DISPLAY_GATE_DIR: directory },
  expectedMarker: 'ROON_DISPLAY_GATE_PASS', readyMarker: 'ROON_DISPLAY_GATE_READY',
  exitTimeoutMs: 60000,
})
if (result.failure || !result.markerSeen || !result.closed || result.code !== 0 || result.signal !== null) {
  console.error('ROON_DISPLAY_GATE_FAIL', result.failure ?? 'process-exit')
  process.exitCode = 1
} else console.log('ROON_DISPLAY_GATE_PASS：隔离、持久化、断连清词、自动重连、重启与停用')
