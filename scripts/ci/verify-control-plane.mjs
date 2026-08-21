import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const requiredFiles = [
  'AGENTS.md',
  'project/STATUS.json',
  'project/WAVE-3.yaml',
  'project/RISK_REGISTER.md',
  'docs/adr/ADR-004-WAVE3-UI-ARCHITECTURE.md',
  'docs/adr/ADR-005-ELECTRON-PROTOCOL-AND-FUSES.md',
  'docs/adr/ADR-006-MACOS-DISTRIBUTION.md',
  'tasks/TASK-024_LYRICS.md',
  'tasks/TASK-029_CONTROL_PLANE_CI.md',
  'reports/WAVE-2_RESULT.md',
  'packages/bridge-core/test/provider-wrapper-contract.test.ts',
  'scripts/ci/verify-cycles.mjs',
  'scripts/ci/verify-boundaries.mjs',
  '.github/workflows/verify.yml',
  '.github/workflows/security.yml',
  '.github/workflows/electron-e2e.yml',
]

function fail(message) {
  console.error(`CONTROL_PLANE=FAIL reason=${message}`)
  process.exit(1)
}

for (const relativePath of requiredFiles) {
  const absolutePath = path.join(root, relativePath)
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    fail(`missing:${relativePath}`)
  }
}

let status
try {
  status = JSON.parse(fs.readFileSync(path.join(root, 'project/STATUS.json'), 'utf8'))
} catch {
  fail('status-json-invalid')
}

if (
  status.schemaVersion !== 1 ||
  status.project !== 'Music Bridge for Roon' ||
  !/^WAVE-[0-9]+$/.test(status.wave) ||
  !/^TASK-[0-9A-Z]+$/.test(status.task) ||
  !/^codex\/[a-z0-9-]+$/.test(status.branch) ||
  !['in_progress', 'complete', 'carryover'].includes(status.state) ||
  !/^[0-9a-f]{40}$/.test(status.baseCommit)
) {
  fail('status-shape-invalid')
}

if (!status.gates || typeof status.gates !== 'object' || Array.isArray(status.gates)) {
  fail('status-gates-invalid')
}

if (
  !status.policy ||
  status.policy.realCredentialsInCi !== false ||
  status.policy.realRoonInCi !== false ||
  status.policy.loopbackOnly !== true ||
  status.policy.providerVersion !== '4.40.1'
) {
  fail('status-policy-invalid')
}

if (status.state === 'complete') {
  const reportPath = path.join(root, 'reports', `${status.task}_RESULT.md`)
  if (!fs.existsSync(reportPath) || !fs.statSync(reportPath).isFile()) {
    fail(`missing-report:${status.task}`)
  }
}

const statusText = JSON.stringify(status)
if (
  /(NETEASE_COOKIE|MUSIC_U|__csrf)\s*[:=]\s*[^,}]+/i.test(statusText) ||
  /Bearer\s+[A-Za-z0-9]/i.test(statusText) ||
  /https?:\/\/[^\s]+[?&][^\s]+/i.test(statusText)
) {
  fail('status-secret-or-url')
}

const wavePlan = fs.readFileSync(path.join(root, 'project/WAVE-3.yaml'), 'utf8')
const requiredOrder = ['TASK-029', 'TASK-024', 'TASK-030', 'TASK-031', 'TASK-032', 'TASK-040', 'TASK-041']
let previousIndex = -1
for (const task of requiredOrder) {
  const index = wavePlan.indexOf(`- ${task}`)
  if (index <= previousIndex) fail('wave-order-invalid')
  previousIndex = index
}
if (!wavePlan.includes('stopAfter: TASK-041') || !wavePlan.includes('reviewBoundary: beta-candidate')) {
  fail('wave-boundary-invalid')
}

console.log('CONTROL_PLANE=PASS')
