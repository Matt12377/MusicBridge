import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import electron from 'electron'

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mode = process.argv[2]
const crashGate = process.env.MUSIC_BRIDGE_CORE_CRASH_GATE === '1'

if (mode !== 'development' && mode !== 'production') {
  console.error('usage: node scripts/startup-gate.mjs <development|production>')
  process.exit(2)
}

function commandPath(name) {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  return path.join(desktopRoot, 'node_modules', '.bin', `${name}${suffix}`)
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: desktopRoot,
      env: process.env,
      stdio: 'inherit',
      ...options,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

const buildResult = await run(commandPath('electron-vite'), ['build', '--mode', mode])
if (buildResult.code !== 0) {
  console.error(`DESKTOP_BUILD_FAIL=${mode}`)
  process.exit(buildResult.code ?? 1)
}

const child = spawn(electron, ['dist/main/index.js'], {
  cwd: desktopRoot,
  env: {
    ...process.env,
    MUSIC_BRIDGE_STARTUP_TEST: '1',
    MUSIC_BRIDGE_CORE_TEST_MODE: '1',
    ...(crashGate ? { MUSIC_BRIDGE_CORE_CRASH_GATE: '1' } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
let finished = false

const result = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    if (!finished) {
      finished = true
      child.kill('SIGTERM')
      resolve({ code: null, timedOut: true })
    }
  }, 30_000)

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
    if (!finished && stdout.includes('DESKTOP_STARTUP_READY')) {
      finished = true
      clearTimeout(timer)
      child.once('exit', (code) => resolve({ code, timedOut: false }))
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  child.once('error', (error) => {
    if (!finished) {
      finished = true
      clearTimeout(timer)
      resolve({ code: null, error, timedOut: false })
    }
  })
  child.once('exit', (code) => {
    if (!finished) {
      finished = true
      clearTimeout(timer)
      resolve({ code, timedOut: false })
    }
  })
})

const expectedMarker = crashGate ? 'CORE_CRASH_GATE_PASS' : 'DESKTOP_STARTUP_READY'
if (!stdout.includes(expectedMarker) || result.code !== 0) {
  console.error(`DESKTOP_STARTUP_FAIL=${mode}`)
  if (result.timedOut) console.error('DESKTOP_STARTUP_TIMEOUT=true')
  if (stderr.trim()) console.error(stderr.trim().slice(-2000))
  process.exit(1)
}

console.log(`${crashGate ? 'CORE_CRASH_GATE' : 'DESKTOP_STARTUP_PASS'}=${mode}`)
