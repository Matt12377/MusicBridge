import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()

function walk(directory) {
  if (!fs.existsSync(directory)) return []
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(absolute)
    return [absolute]
  })
}

function text(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function fail(message) {
  console.error(`BOUNDARIES=FAIL reason=${message}`)
  process.exit(1)
}

function assertNo(relativePath, pattern, reason) {
  if (pattern.test(text(relativePath))) fail(reason)
}

const contractFiles = walk(path.join(root, 'packages/contracts/src')).filter((file) => /\.(ts|js)$/.test(file))
for (const file of contractFiles) {
  const relative = path.relative(root, file)
  const content = fs.readFileSync(file, 'utf8')
  if (/(?:from|require\()\s*['"][^'"]*(?:electron|node:|node-roon|neteasecloudmusic|roon-api)/i.test(content)) {
    fail(`contracts-boundary:${relative}`)
  }
}

const rendererFiles = walk(path.join(root, 'apps/desktop/src/renderer')).filter((file) => /\.(ts|vue|js)$/.test(file))
for (const file of rendererFiles) {
  const relative = path.relative(root, file)
  const content = fs.readFileSync(file, 'utf8')
  if (/(?:from|require\()\s*['"]node:/i.test(content) || /\brequire\s*\(/.test(content)) {
    fail(`renderer-node-access:${relative}`)
  }
  if (/\b(?:process|Buffer|__dirname|__filename)\b/.test(content)) {
    fail(`renderer-node-global:${relative}`)
  }
}

const security = text('apps/desktop/src/main/security.ts')
for (const [name, expected] of [
  ['nodeIntegration', 'false'],
  ['contextIsolation', 'true'],
  ['sandbox', 'true'],
  ['webSecurity', 'true'],
  ['webviewTag', 'false'],
  ['allowRunningInsecureContent', 'false'],
]) {
  if (!new RegExp(`${name}:\\s*${expected}`).test(security)) fail(`electron-security:${name}`)
}
if (/unsafe-eval|connect-src[^\n]*\*/.test(security)) fail('electron-csp')

const config = text('packages/bridge-core/src/config/config.ts')
if (!config.includes("env.BRIDGE_CONTROL_HOST?.trim() || '127.0.0.1'")) fail('control-loopback-default')
if (!config.includes("env.BRIDGE_STREAM_HOST?.trim() || '127.0.0.1'")) fail('stream-loopback-default')
if (!config.includes("controlHost !== '127.0.0.1' && controlHost !== '::1'")) fail('control-loopback-guard')
if (!config.includes("streamHost !== '127.0.0.1' && streamHost !== '::1'")) fail('stream-loopback-guard')

const productFiles = [
  ...walk(path.join(root, 'packages/bridge-core/src')),
  ...walk(path.join(root, 'apps/desktop/src')),
  ...walk(path.join(root, 'scripts/deploy')),
].filter((file) => /\.(ts|vue|js|mjs|sh)$/.test(file))
for (const file of productFiles) {
  const relative = path.relative(root, file)
  const content = fs.readFileSync(file, 'utf8')
  for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]*(?:ffmpeg|fluent-ffmpeg|unblockmusic|transcod)[^'"]*)['"]/gi)) {
    // TASK-061 仅允许 Core 加载自己的固定构建策略；外部转换库、Provider 流与 Renderer 边界不放开。
    if (relative !== 'packages/bridge-core/src/recording/bundled-converter.ts' || match[1] !== './ffmpeg-build-policy.js') {
      fail(`audio-boundary:${relative}`)
    }
  }
  if (/(?:NETEASE_COOKIE|MUSIC_U|__csrf)\s*[:=]\s*['"][A-Za-z0-9%_+-]{16,}['"]/i.test(content)) {
    fail(`credential-value:${relative}`)
  }
  if (/Bearer\s+[A-Za-z0-9._-]{16,}/i.test(content)) fail(`bearer-value:${relative}`)
  if (/https?:\/\/[^\s'"<>]+[?&](?:token|auth|signature|sign|key|expires)=/i.test(content)) {
    fail(`query-url:${relative}`)
  }
}

const workflows = [
  '.github/workflows/verify.yml',
  '.github/workflows/security.yml',
  '.github/workflows/electron-e2e.yml',
]
for (const relative of workflows) {
  const content = text(relative)
  if (!content.includes('corepack pnpm@10.17.1')) fail(`workflow-pnpm:${relative}`)
  if (!content.includes('--frozen-lockfile')) fail(`workflow-lockfile:${relative}`)
  if (/npm install|pnpm install(?![^\n]*--frozen-lockfile)/i.test(content)) fail(`workflow-install:${relative}`)
  if (/NETEASE_COOKIE\s*[:=]|roonstation|ssh\s/i.test(content)) fail(`workflow-real-service:${relative}`)
}
if (!text('.github/workflows/verify.yml').includes('audit --prod')) fail('workflow-audit')

// Platform-independent verify must never launch Electron on Linux runners.
const platformVerify = text('.github/workflows/verify.yml')
if (/xvfb-run|test:startup|test:electron|test:e2e/.test(platformVerify)) fail('verify-workflow-electron-leak')

// The macOS Electron gate must run both the Electron unit gate (startup, crash,
// safeStorage vault, credential recovery) and the Playwright end-to-end flow.
const electronGate = text('.github/workflows/electron-e2e.yml')
for (const required of ['runs-on: macos-latest', 'test:electron', 'test:e2e']) {
  if (!electronGate.includes(required)) fail(`electron-gate-missing:${required}`)
}

// Security workflow must stay platform-independent; no Electron launch steps.
const securityWorkflow = text('.github/workflows/security.yml')
if (/xvfb-run|test:startup|test:electron|test:e2e/.test(securityWorkflow)) fail('security-workflow-electron-leak')

console.log('BOUNDARIES=PASS')
