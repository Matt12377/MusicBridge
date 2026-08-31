import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const jointIssuer = new URL('../issue-v3-capacity-joint-generation-window.py', import.meta.url)
const objectsRecoveryIssuer = new URL('../issue-v3-capacity-window.py', import.meta.url)
const installedSupervisorSource = new URL('../capacity-phase-supervisor-v2.py', import.meta.url)
const python = '/usr/bin/python3'

function pythonCall(source, value) {
  return spawnSync(python, ['-c', `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('joint_issuer',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
${source}`, jointIssuer.pathname, JSON.stringify(value)], { encoding: 'utf8' })
}

const hashBytes = value => createHash('sha256').update(value).digest('hex')
function put(path, value) { const bytes = `${JSON.stringify(value)}\n`; writeFileSync(path, bytes); return hashBytes(bytes) }
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex')
function git(cwd, ...args) { return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim() }
function argValue(args, name) { return args[args.indexOf(name) + 1] }

function cliFixture() {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'musicbridge-joint-cli-')))
  const repo = join(root, 'repo'), runtime = join(root, 'runtime'), scripts = join(repo, 'scripts/ci')
  mkdirSync(scripts, { recursive: true }); mkdirSync(runtime)
  const fixtureIssuer = join(scripts, 'issue-v3-capacity-joint-generation-window.py')
  const supervisor = join(scripts, 'capacity-phase-supervisor-v2.py')
  writeFileSync(fixtureIssuer, readFileSync(jointIssuer)); writeFileSync(supervisor, readFileSync(installedSupervisorSource))
  const fixedSources = ['package.json', 'pnpm-lock.yaml', 'packages/bridge-core/package.json',
    'packages/contracts/package.json', 'packages/contracts/capacity-process-failure-lineage-v1.json',
    'packages/bridge-core/test/benchmarks/recording-capacity.ts',
    'packages/bridge-core/test/benchmarks/recording-capacity-process.ts',
    'scripts/ci/capacity_process_failure_lineage.py', 'scripts/ci/issue-v3-capacity-measure-window.py']
  for (const relative of fixedSources) {
    const file = join(repo, relative); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${relative}\n`)
  }
  for (const relative of ['packages/bridge-core/src', 'packages/bridge-core/test/helpers',
    'packages/contracts/src', 'packages/contracts/dist']) mkdirSync(join(repo, relative), { recursive: true })
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Test')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'candidate')
  const head = git(repo, 'rev-parse', 'HEAD')

  const authority = join(runtime, 'objects-queued-pass'), supervisionDirectory = join(authority, 'supervision')
  mkdirSync(supervisionDirectory, { recursive: true })
  const id = '22222222-2222-4222-8222-222222222222', label = 'objects-queued-pass'
  const ownerPath = join(authority, 'owner.json'), ownerSha = put(ownerPath, { scope: 'musicbridge-capacity-queued-stop-window', owner: 'root', id })
  const ownerStat = statSync(authority)
  const ownedPath = join(authority, 'owned-roots.json'), sourcePath = join(authority, 'source-pins.json')
  const ownedSha = put(ownedPath, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId: id,
    roots: [{ path: authority, device: ownerStat.dev, inode: ownerStat.ino, marker: { relative: 'owner.json', sha256: ownerSha } }] })
  const sourceSha = put(sourcePath, { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: { 'old.txt': 'c'.repeat(64) } })
  const windowPath = join(authority, 'window.json')
  const windowSha = put(windowPath, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-window', owner: 'root',
    id, phase: 'queued-stop', profile: 'objects-limit', state: 'approved', label, n: 105,
    ownedManifest: { file: 'owned-roots.json', sha256: ownedSha }, sourceManifest: { file: 'source-pins.json', sha256: sourceSha } })
  const queuedStop = { verifiedComplete: true, verifiedPassed: true, sampleCount: 105,
    uniqueChildPids: 105, aggregateBudgetValid: true }
  const supervisionPath = join(supervisionDirectory, 'supervisor.json')
  const supervisionSha = put(supervisionPath, { passed: true, failure: null, code: 0, groupEmpty: true, zombies: [], queuedStop })
  const closePath = join(authority, 'close.json')
  const closeSha = put(closePath, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-window-close',
    windowId: id, windowSha256: windowSha, profile: 'objects-limit', label, state: 'passed', failure: null,
    groupEmpty: true, zombies: [], deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
    replayPolicy: 'terminal-window-id-and-label-never-reuse', ownedManifestSha256: ownedSha,
    sourceManifestSha256: sourceSha, supervisorSha256: supervisionSha, queuedStop })
  const consumer = realpathSync(python)
  const args = ['--repo-root', repo, '--runtime-root', runtime,
    '--objects-queued-window', windowPath, '--expected-objects-queued-window-sha256', windowSha,
    '--objects-queued-close', closePath, '--expected-objects-queued-close-sha256', closeSha,
    '--objects-queued-supervision', supervisionPath, '--expected-objects-queued-supervision-sha256', supervisionSha,
    '--objects-queued-owned-manifest', ownedPath, '--expected-objects-queued-owned-sha256', ownedSha,
    '--objects-queued-source-manifest', sourcePath, '--expected-objects-queued-source-sha256', sourceSha,
    '--window-dir-name', 'joint-generation-window-01', '--label', 'joint-generation-01',
    '--expected-branch', 'main', '--expected-head', head, '--expected-source-count', '10',
    '--supervisor', supervisor, '--expected-supervisor-sha256', hashFile(supervisor),
    '--consumer-python', consumer, '--expected-consumer-sha256', hashFile(consumer),
    '--expected-issuer-sha256', hashFile(fixtureIssuer)]
  return { root, repo, runtime, fixtureIssuer, args }
}

test('joint generation必须使用专用issuer，不能放宽objects-limit失败恢复入口', () => {
  assert.equal(existsSync(jointIssuer), true, '缺少专用joint generation issuer')
  const jointSource = readFileSync(jointIssuer, 'utf8')
  const recoverySource = readFileSync(objectsRecoveryIssuer, 'utf8')
  assert.match(jointSource, /objects-limit:queued-stop:PASS/u)
  assert.match(jointSource, /2_701_131_776/u)
  assert.match(jointSource, /'profile': 'joint'/u)
  assert.match(recoverySource, /choices=\('objects-limit',\)/u)
  assert.doesNotMatch(recoverySource, /choices=\('objects-limit', 'joint'\)/u)
  const parity = pythonCall(`import pathlib,runpy
p=json.loads(sys.argv[2]);root=pathlib.Path(p['root']).resolve()
s=runpy.run_path(p['supervisor'],run_name='source_contract')
assert m._expected_source_paths(root) == s['_expected_source_paths'](root)[1]
print(len(m._expected_source_paths(root)))`, { root: process.cwd(), supervisor: installedSupervisorSource.pathname })
  assert.equal(parity.status, 0, parity.stderr)
  assert.ok(Number(parity.stdout.trim()) > 10)
})

test('joint窗口纯合同固定前驱PASS、独立计划与一次性消费命令', () => {
  const h = 'a'.repeat(64), windowId = '11111111-1111-4111-8111-111111111111'
  const predecessor = {
    window: { id: '22222222-2222-4222-8222-222222222222', phase: 'queued-stop', profile: 'objects-limit',
      state: 'approved', label: 'objects-queued-pass', n: 105 },
    close: { windowId: '22222222-2222-4222-8222-222222222222', profile: 'objects-limit',
      label: 'objects-queued-pass', state: 'passed', failure: null, groupEmpty: true, zombies: [],
      deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
      replayPolicy: 'terminal-window-id-and-label-never-reuse',
      queuedStop: { verifiedComplete: true, verifiedPassed: true, sampleCount: 105,
        uniqueChildPids: 105, aggregateBudgetValid: true } },
    supervision: { passed: true, failure: null, code: 0, groupEmpty: true, zombies: [],
      queuedStop: { verifiedComplete: true, verifiedPassed: true, sampleCount: 105,
        uniqueChildPids: 105, aggregateBudgetValid: true } },
    files: { windowSha256: h, closeSha256: h, supervisionSha256: h,
      ownedManifestSha256: h, sourceManifestSha256: h },
  }
  const payload = { predecessor, window_id: windowId, label: 'joint-generation-01',
    issued_at: '2026-08-31T12:00:00.000+00:00', deadline_at: '2026-08-31T12:20:00.000+00:00',
    owned_sha: h, source_sha: h, supervisor: '/authority/supervisor.py', supervisor_sha: h,
    candidate: { root: '/candidate', branch: 'main', head: 'b'.repeat(40) },
    consumer: '/usr/bin/python3', consumer_sha: h, issuer: '/candidate/scripts/ci/issue-v3-capacity-joint-generation-window.py',
    issuer_sha: h }
  const result = pythonCall("p=json.loads(sys.argv[2]);print(json.dumps(m.build_authority_payload(**p)))", payload)
  assert.equal(result.status, 0, result.stderr)
  const { window, issuerFact } = JSON.parse(result.stdout)
  assert.equal(window.profile, 'joint')
  assert.equal(window.phase, 'generate')
  assert.equal(window.n, 1)
  assert.deepEqual(Object.keys(window).sort(), ['deadlineAt', 'id', 'issuedAt', 'label', 'limits', 'n', 'ownedManifest', 'owner', 'phase', 'profile', 'schemaVersion', 'scope', 'sourceManifest', 'state'].sort())
  assert.equal(issuerFact.generationPlan.plannedBytes, 2_701_131_776)
  assert.equal(issuerFact.predecessor.requiredResult, 'objects-limit:queued-stop:PASS')
  assert.equal(issuerFact.predecessor.windowSha256, h)
  assert.deepEqual(issuerFact.toolchain.consumerPython, { path: payload.consumer, sha256: h })
})

test('joint前驱必须是完整objects-limit queued-stop PASS，任一降级均拒绝', () => {
  const h = 'a'.repeat(64), base = {
    window: { id: '22222222-2222-4222-8222-222222222222', phase: 'queued-stop', profile: 'objects-limit',
      state: 'approved', label: 'objects-queued-pass', n: 105 },
    close: { windowId: '22222222-2222-4222-8222-222222222222', profile: 'objects-limit',
      label: 'objects-queued-pass', state: 'passed', failure: null, groupEmpty: true, zombies: [],
      deviceOpened: false, formalReady: false, gateB: 'NOT_RUN', replayPolicy: 'terminal-window-id-and-label-never-reuse',
      queuedStop: { verifiedComplete: true, verifiedPassed: true, sampleCount: 105,
        uniqueChildPids: 105, aggregateBudgetValid: true } },
    supervision: { passed: true, failure: null, code: 0, groupEmpty: true, zombies: [],
      queuedStop: { verifiedComplete: true, verifiedPassed: true, sampleCount: 105,
        uniqueChildPids: 105, aggregateBudgetValid: true } },
    files: { windowSha256: h, closeSha256: h, supervisionSha256: h,
      ownedManifestSha256: h, sourceManifestSha256: h },
  }
  for (const mutate of [
    v => { v.window.profile = 'joint' },
    v => { v.close.state = 'failed' },
    v => { v.close.queuedStop.sampleCount = 104 },
    v => { v.supervision.queuedStop.uniqueChildPids = 104 },
    v => { v.close.groupEmpty = false },
    v => { v.files.windowSha256 = '0'.repeat(63) },
  ]) {
    const value = structuredClone(base); mutate(value)
    const result = pythonCall("p=json.loads(sys.argv[2]);m.validate_objects_queued_pass(p);print('accepted')", value)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /OBJECTS_QUEUED_PASS/u)
  }
})

test('前驱原始五文件逐SHA、同authority路径与交叉字段闭合', () => {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'musicbridge-joint-issuer-')))
  try {
    const authority = join(root, 'objects-queued-pass'), supervisionDirectory = join(authority, 'supervision')
    mkdirSync(supervisionDirectory, { recursive: true })
    const id = '22222222-2222-4222-8222-222222222222', label = 'objects-queued-pass'
    const ownedPath = join(authority, 'owned-roots.json'), sourcePath = join(authority, 'source-pins.json')
    const ownedSha = put(ownedPath, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId: id, roots: [] })
    const sourceSha = put(sourcePath, { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: {} })
    const windowPath = join(authority, 'window.json')
    const windowSha = put(windowPath, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-window', owner: 'root',
      id, phase: 'queued-stop', profile: 'objects-limit', state: 'approved', label, n: 105,
      ownedManifest: { file: 'owned-roots.json', sha256: ownedSha }, sourceManifest: { file: 'source-pins.json', sha256: sourceSha } })
    const queuedStop = { verifiedComplete: true, verifiedPassed: true, sampleCount: 105,
      uniqueChildPids: 105, aggregateBudgetValid: true }
    const supervisionPath = join(supervisionDirectory, 'supervisor.json')
    const supervisionSha = put(supervisionPath, { passed: true, failure: null, code: 0, groupEmpty: true, zombies: [], queuedStop })
    const closePath = join(authority, 'close.json')
    const closeSha = put(closePath, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-window-close',
      windowId: id, windowSha256: windowSha, profile: 'objects-limit', label, state: 'passed', failure: null,
      groupEmpty: true, zombies: [], deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
      replayPolicy: 'terminal-window-id-and-label-never-reuse', ownedManifestSha256: ownedSha,
      sourceManifestSha256: sourceSha, supervisorSha256: supervisionSha, queuedStop })
    const paths = { window_path: windowPath, window_sha: windowSha, close_path: closePath, close_sha: closeSha,
      supervision_path: supervisionPath, supervision_sha: supervisionSha, owned_path: ownedPath, owned_sha: ownedSha,
      source_path: sourcePath, source_sha: sourceSha }
    const accepted = pythonCall("p=json.loads(sys.argv[2]);print(json.dumps(m.load_objects_queued_pass(**p)))", paths)
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.equal(JSON.parse(accepted.stdout).windowSha256, windowSha)

    writeFileSync(sourcePath, '{}\n')
    const rejected = pythonCall("p=json.loads(sys.argv[2]);m.load_objects_queued_pass(**p)", paths)
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /OBJECTS_QUEUED_PASS/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('完整CLI只在所有验证后原子发布joint window并返回唯一消费命令', () => {
  const f = cliFixture()
  try {
    const result = spawnSync(python, [f.fixtureIssuer, ...f.args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    const parent = join(f.runtime, 'joint-generation-window-01')
    const window = JSON.parse(readFileSync(join(parent, 'window.json'), 'utf8'))
    assert.equal(receipt.state, 'ISSUED_NOT_EXECUTED')
    assert.equal(receipt.profile, 'joint')
    assert.equal(receipt.predecessor.requiredResult, 'objects-limit:queued-stop:PASS')
    assert.equal(window.profile, 'joint')
    assert.equal(existsSync(join(parent, 'window.pending.json')), false)
    assert.deepEqual(receipt.consumeCommand, [realpathSync(python), join(parent, 'supervisor.py'),
      '--window', join(parent, 'window.json'), '--window-sha256', receipt.windowSha256])
    const preflight = spawnSync(python, ['-c', `import importlib.util,sys
spec=importlib.util.spec_from_file_location('installed',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
print(m._validate_generation_authority(sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5],'joint')['plannedBytes'])`,
    join(parent, 'supervisor.py'), parent, f.runtime, f.repo, receipt.windowSha256], { encoding: 'utf8' })
    assert.equal(preflight.status, 0, preflight.stderr)
    assert.equal(Number(preflight.stdout.trim()), 2_701_131_776)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('完整CLI对dirty候选、前驱篡改与重放路径fail-closed', () => {
  for (const scenario of [
    {
      name: 'dirty', code: /JOINT_ISSUER_REPOSITORY_IDENTITY/u,
      mutate: f => writeFileSync(join(f.repo, 'untracked.txt'), 'dirty\n'),
    },
    {
      name: 'predecessor-tamper', code: /JOINT_ISSUER_OBJECTS_QUEUED_PASS/u,
      mutate: f => writeFileSync(argValue(f.args, '--objects-queued-close'), '{}\n'),
    },
    {
      name: 'replay-path', code: /JOINT_ISSUER_REPLAY_PATH/u,
      mutate: f => mkdirSync(join(f.runtime, 'joint-generation-window-01')),
    },
  ]) {
    const f = cliFixture()
    try {
      scenario.mutate(f)
      const result = spawnSync(python, [f.fixtureIssuer, ...f.args], { encoding: 'utf8' })
      assert.notEqual(result.status, 0, scenario.name)
      assert.match(result.stderr, scenario.code, scenario.name)
      assert.equal(existsSync(join(f.runtime, 'joint-generation-window-01', 'window.json')), false, scenario.name)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  }
})
