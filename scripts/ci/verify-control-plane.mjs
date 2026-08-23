import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

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

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

for (const relativePath of requiredFiles) {
  const absolutePath = path.join(root, relativePath)
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    fail(`missing:${relativePath}`)
  }
}

function commitExists(sha) {
  const result = spawnSync('git', ['-C', root, 'cat-file', '-e', `${sha}^{commit}`], {
    encoding: 'utf8',
  })
  return result.status === 0
}

let status
try {
  status = JSON.parse(readText('project/STATUS.json'))
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

// STATUS commits must be well-formed and resolvable in the local Git history.
const commitFields = ['baseCommit', 'implementationCommit', 'reportCommit']
for (const field of commitFields) {
  const sha = status[field]
  if (sha === null || sha === undefined) continue
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`status-commit-format:${field}`)
  if (!commitExists(sha)) fail(`status-commit-not-in-history:${field}`)
}

// STATUS must agree with the wave plan.
const wavePlan = readText('project/WAVE-3.yaml')
const activeTaskMatch = wavePlan.match(/^activeTask:\s*(\S+)$/m)
const activeBranchMatch = wavePlan.match(/^activeBranch:\s*(\S+)$/m)
const activeBaseMatch = wavePlan.match(/^activeBaseCommit:\s*(\S+)$/m)
if (!activeTaskMatch || activeTaskMatch[1] !== status.task) fail('wave-active-task-mismatch')
if (!activeBranchMatch || activeBranchMatch[1] !== status.branch) fail('wave-active-branch-mismatch')
if (activeBaseMatch) {
  if (!/^[0-9a-f]{40}$/.test(activeBaseMatch[1])) fail('wave-base-format-invalid')
  if (activeBaseMatch[1] !== status.baseCommit) fail('wave-base-status-mismatch')
}

// The current task must exist in the task index and in tasks/ definitions or reports.
const taskIndex = readText('tasks/00_TASK_INDEX.md')
const indexedTasks = new Set([...taskIndex.matchAll(/^\|\s*(TASK-[0-9A-Z]+)\s*\|/gm)].map((match) => match[1]))
if (!indexedTasks.has(status.task)) fail('task-missing-from-index')
const hasTaskDefinition = fs
  .readdirSync(path.join(root, 'tasks'))
  .some((name) => name.startsWith(`${status.task}_`))
const hasTaskReport = fs
  .readdirSync(path.join(root, 'reports'))
  .some((name) => name.startsWith(`${status.task}_`))
if (!hasTaskDefinition && !hasTaskReport) fail('task-definition-missing')

// A finished task must have its final report; an in-progress task needs a definition file.
if (status.state === 'in_progress') {
  if (!hasTaskDefinition) fail(`missing-task-file:${status.task}`)
} else {
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

// Wave order must include the full executed sequence through TASK-041.
const requiredOrder = [
  'TASK-029',
  'TASK-024',
  'TASK-030',
  'TASK-031',
  'TASK-032',
  'TASK-033',
  'TASK-034',
  'TASK-035',
  'TASK-036',
  'TASK-040',
  'TASK-041',
]
let previousIndex = -1
for (const task of requiredOrder) {
  const index = wavePlan.indexOf(`- ${task}`)
  if (index <= previousIndex) fail('wave-order-invalid')
  previousIndex = index
}
if (!wavePlan.includes('stopAfter: TASK-041') || !wavePlan.includes('reviewBoundary: beta-candidate')) {
  fail('wave-boundary-invalid')
}

// Tasks already merged into main must keep integration addenda so their historical
// "not pushed / not merged" claims cannot be misread as current state.
const integratedTasks = ['TASK-033', 'TASK-034', 'TASK-035']
for (const task of integratedTasks) {
  const addendumPath = path.join(root, 'reports', `${task}_INTEGRATION_ADDENDUM.md`)
  if (!fs.existsSync(addendumPath) || !fs.statSync(addendumPath).isFile()) {
    fail(`missing-integration-addendum:${task}`)
  }
  const resultPath = path.join(root, 'reports', `${task}_RESULT.md`)
  if (fs.existsSync(resultPath)) {
    const resultText = readText(path.join('reports', `${task}_RESULT.md`))
    const claimsUnmerged = /(未创建 PR|未推送|未合并|未 push|未 force-push)/.test(resultText)
    if (!claimsUnmerged) fail(`addendum-without-unmerged-claim:${task}`)
  }
}

// Beta version and candidate reports must not contradict each other:
// RELEASE_NOTES must mention the workspace version; the frozen beta acceptance
// report must not silently adopt a newer version without a rebaseline marker.
let packageVersion
try {
  packageVersion = JSON.parse(readText('package.json')).version
} catch {
  fail('package-json-invalid')
}
if (typeof packageVersion !== 'string' || !/^0\.1\.0-beta\.[0-9]+$/.test(packageVersion)) {
  fail('package-version-shape-invalid')
}
const releaseNotes = readText('RELEASE_NOTES.md')
if (!releaseNotes.includes(packageVersion)) fail('release-notes-version-missing')
const betaAcceptance = readText('reports/V1_BETA_ACCEPTANCE.md')
if (betaAcceptance.includes(packageVersion)) {
  const offendingLine = betaAcceptance
    .split('\n')
    .find((line) => line.includes(packageVersion) && !/(重新建基线|重建|PENDING|待|未发布)/.test(line))
  if (offendingLine) fail('beta-version-contradiction')
}

console.log('CONTROL_PLANE=PASS')
