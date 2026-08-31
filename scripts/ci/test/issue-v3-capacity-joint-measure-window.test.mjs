import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import test from 'node:test'

const jointMeasureIssuer = new URL('../issue-v3-capacity-joint-measure-window.py', import.meta.url)
const objectsMeasureIssuer = new URL('../issue-v3-capacity-measure-window.py', import.meta.url)
const supervisorSource = new URL('../capacity-phase-supervisor-v2.py', import.meta.url)
const jointGenerationIssuerSource = new URL('../issue-v3-capacity-joint-generation-window.py', import.meta.url)
const python = '/usr/bin/python3'

const shaBytes = value => createHash('sha256').update(value).digest('hex')
const shaFile = path => shaBytes(readFileSync(path))
function put(path, value) { const bytes = `${JSON.stringify(value)}\n`; writeFileSync(path, bytes); return shaBytes(bytes) }
function git(cwd, ...args) { return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim() }
function argValue(args, name) { return args[args.indexOf(name) + 1] }
function directoryBytes(path) {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = join(path, entry.name)
    return total + (entry.isDirectory() ? directoryBytes(child) : statSync(child).size)
  }, 0)
}

function pythonCall(source, value) {
  return spawnSync(python, ['-c', `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('joint_measure_issuer',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
${source}`, jointMeasureIssuer.pathname, JSON.stringify(value)], { encoding: 'utf8' })
}

test('joint measure必须使用专用issuer，不能放宽objects-limit历史恢复入口', () => {
  assert.equal(existsSync(jointMeasureIssuer), true, '缺少专用joint measure issuer')
  const jointSource = readFileSync(jointMeasureIssuer, 'utf8')
  const objectsSource = readFileSync(objectsMeasureIssuer, 'utf8')
  assert.match(jointSource, /joint:generate:PASS/u)
  assert.match(jointSource, /'profile': 'joint'/u)
  assert.match(objectsSource, /choices=\('objects-limit',\)/u)
  assert.doesNotMatch(objectsSource, /choices=\('objects-limit', 'joint'\)/u)
})

function generationFact() {
  const h = 'a'.repeat(64)
  const generation = { verifiedPassed: true, exitZero: true, sourceBeforeEqualsAfter: true,
    fixtureIdentityValid: true, authorityStable: true, jointSeedValid: true,
    generationPlanValid: true, generationSpaceValid: true, noSqliteSidecars: true }
  return {
    window: { scope: 'musicbridge-capacity-generation-window', id: '22222222-2222-4222-8222-222222222222',
      phase: 'generate', profile: 'joint', state: 'approved', label: 'joint-seed', n: 1 },
    close: { scope: 'musicbridge-capacity-generation-window-close', windowId: '22222222-2222-4222-8222-222222222222',
      profile: 'joint', label: 'joint-seed', state: 'passed', failure: null, groupEmpty: true, zombies: [],
      deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
      replayPolicy: 'terminal-window-id-and-label-never-reuse', generation },
    supervision: { passed: true, failure: null, code: 0, groupEmpty: true, zombies: [], generation },
    files: { windowSha256: h, closeSha256: h, supervisionSha256: h, ownedManifestSha256: h,
      sourceManifestSha256: h, seedMetadataSha256: h, seedSnapshotSha256: h, fixtureOwnerSha256: h },
  }
}

test('纯合同只消费完整joint generation PASS并生成标准measure窗口', () => {
  const predecessor = generationFact(), h = 'a'.repeat(64)
  const payload = { predecessor, window_id: '11111111-1111-4111-8111-111111111111', label: 'joint-measure-01',
    issued_at: '2026-08-31T12:00:00.000+00:00', deadline_at: '2026-08-31T12:15:00.000+00:00',
    owned_sha: h, source_sha: h, supervisor: '/authority/supervisor.py', supervisor_sha: h,
    candidate: { root: '/candidate', branch: 'main', head: 'b'.repeat(40) },
    consumer: '/usr/bin/python3', consumer_sha: h,
    issuer: '/candidate/scripts/ci/issue-v3-capacity-joint-measure-window.py', issuer_sha: h }
  const result = pythonCall('p=json.loads(sys.argv[2]);print(json.dumps(m.build_authority_payload(**p)))', payload)
  assert.equal(result.status, 0, result.stderr)
  const { window, issuerFact } = JSON.parse(result.stdout)
  assert.equal(window.scope, 'musicbridge-capacity-measure-window')
  assert.equal(window.phase, 'measure'); assert.equal(window.profile, 'joint'); assert.equal(window.n, 105)
  assert.equal(window.seedLabel, 'joint-seed')
  assert.deepEqual(window.seed, { metadataSha256: h, snapshotSha256: h, fixtureOwnerSha256: h })
  assert.equal(window.measurePlan.sampleCount, 1575)
  assert.equal(issuerFact.predecessor.requiredResult, 'joint:generate:PASS')
})

test('generation任一降级都不能成为joint measure前驱', () => {
  for (const mutate of [
    value => { value.window.profile = 'objects-limit' },
    value => { value.close.state = 'failed' },
    value => { value.supervision.generation.verifiedPassed = false },
    value => { value.supervision.generation.generationSpaceValid = false },
    value => { value.supervision.groupEmpty = false },
    value => { value.files.seedSnapshotSha256 = '0'.repeat(63) },
  ]) {
    const value = structuredClone(generationFact()); mutate(value)
    const result = pythonCall("m.validate_joint_generation_pass(json.loads(sys.argv[2]));print('accepted')", value)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /JOINT_GENERATION_PASS/u)
  }
})

test('generation supervisor写出独立terminal close并保留同一generation事实', () => {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'musicbridge-generation-close-')))
  try {
    const supervision = join(root, 'supervision'); mkdirSync(supervision)
    put(join(supervision, 'supervisor.json'), { passed: true })
    const payload = { parent: root, window: { id: randomUUID(), profile: 'joint', label: 'joint-seed',
      sourceManifest: { sha256: 'a'.repeat(64) }, ownedManifest: { sha256: 'b'.repeat(64) } },
      result: { passed: true, failure: null, pid: 1, pgid: 1, managedProcessGroup: true, code: 0,
        exitSignal: null, signals: [], groupEmpty: true, zombies: [], elapsedMs: 1,
        generation: { verifiedPassed: true } }, authority: { authorityStable: true, windowSha256Observed: 'c'.repeat(64) } }
    const result = spawnSync(python, ['-c', `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('supervisor',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=json.loads(sys.argv[2]);value=m._write_generation_close(p['parent'],p['window'],p['result'],p['authority'],lambda:p['authority'])
print(json.dumps(value))`, supervisorSource.pathname, JSON.stringify(payload)], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const close = JSON.parse(result.stdout)
    assert.equal(close.scope, 'musicbridge-capacity-generation-window-close')
    assert.equal(close.state, 'passed'); assert.deepEqual(close.generation, { verifiedPassed: true })
    assert.equal(close.replayPolicy, 'terminal-window-id-and-label-never-reuse')
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'close.json'), 'utf8')), close)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function cliFixture() {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'musicbridge-joint-measure-')))
  const repo = join(root, 'repo'), runtime = join(root, 'runtime'), scripts = join(repo, 'scripts/ci')
  mkdirSync(scripts, { recursive: true }); mkdirSync(runtime)
  const issuer = join(scripts, 'issue-v3-capacity-joint-measure-window.py')
  const generationIssuer = join(scripts, 'issue-v3-capacity-joint-generation-window.py')
  const supervisor = join(scripts, 'capacity-phase-supervisor-v2.py')
  writeFileSync(issuer, readFileSync(jointMeasureIssuer)); writeFileSync(generationIssuer, readFileSync(jointGenerationIssuerSource))
  writeFileSync(supervisor, readFileSync(supervisorSource))
  const fixedSources = ['package.json', 'pnpm-lock.yaml', 'packages/bridge-core/package.json',
    'packages/contracts/package.json', 'packages/contracts/capacity-process-failure-lineage-v1.json',
    'packages/bridge-core/test/benchmarks/recording-capacity.ts',
    'packages/bridge-core/test/benchmarks/recording-capacity-process.ts',
    'scripts/ci/capacity_process_failure_lineage.py', 'scripts/ci/issue-v3-capacity-measure-window.py']
  for (const relative of fixedSources) {
    const path = join(repo, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${relative}\n`)
  }
  for (const relative of ['packages/bridge-core/src', 'packages/bridge-core/test/helpers',
    'packages/contracts/src', 'packages/contracts/dist']) mkdirSync(join(repo, relative), { recursive: true })
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Test')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'candidate'); const head = git(repo, 'rev-parse', 'HEAD')

  const fixture = realpathSync(mkdtempSync(join(os.tmpdir(), 'musicbridge-version-')))
  const marker = { id: randomUUID(), scope: 'musicbridge-capacity-synthetic-only' }
  const fixtureOwnerSha = put(join(fixture, 'capacity-owner.json'), marker)
  writeFileSync(join(fixture, 'fixture.bin'), 'fixture payload larger than snapshot')
  const id = randomUUID(), seed = join(runtime, 'joint-seed'); mkdirSync(seed)
  const snapshot = join(seed, 'seed.sqlite'); writeFileSync(snapshot, 'sqlite')
  const snapshotSha = shaFile(snapshot), mib = 1024 ** 2
  const generationPlan = { model: 'serial-single-output-plus-bounded-growth-v1', activeOutputMaximum: 1,
    finalAxisBytes: 1_275_068_416, activeOutputBytes: 1_275_068_416, activeRecordWorkspaceBytes: 16_777_216,
    evidenceAllowanceBytes: 134_217_728, plannedBytes: 2_701_131_776 }
  const targets = { attemptEvents: 50_000, attemptBytes: 64 * mib, recordBytes: 64 * mib,
    printBytes: 64 * mib, photoBytes: 512 * mib, printObjectBytes: 512 * mib }
  const metadata = { schema: 21, profile: 'joint', integrity: 'passed', growth: { state: 'target-reached' },
    nextPlanId: randomUUID(), nextPlanHash: '9'.repeat(64), budget: { records: 1 }, fixtureDirectory: fixture,
    marker, snapshotSha256: snapshotSha, generationPlan,
    axes: { targets, actual: targets, reached: Object.fromEntries(Object.keys(targets).map(key => [key, true])) },
    planPreparation: { strategy: 'serial-create-consume-one-active', prepared: 2, beforeFirstAttempt: true,
      preparedBeforeFirstAttempt: 1, activePlanMaximum: 1, unconsumedAtSeal: 1 } }
  const seedMetadataSha = put(join(seed, 'seed.json'), metadata)
  const sourceSnapshot = { candidate: 'synthetic' }
  put(join(seed, 'source-before.json'), sourceSnapshot); put(join(seed, 'source-after.json'), sourceSnapshot)
  put(join(seed, 'command.json'), { executable: '/Users/yihe/.nvm/versions/node/v22.23.2/bin/node',
    args: [join(repo, 'packages/bridge-core/test/benchmarks/recording-capacity.ts'), '--phase', 'generate',
      '--profile', 'joint', '--label', 'joint-seed', '--window', id], cwd: repo, node: 'v22.23.2',
    phase: 'generate', profile: 'joint', window: id })
  put(join(seed, 'checkpoint-1.json'), { fixtureDirectory: fixture })
  put(join(seed, 'exit.json'), { exit: 0 })
  const fixtureBytes = directoryBytes(fixture)
  const preSnapshotOutputBytes = ['source-before.json', 'command.json', 'checkpoint-1.json']
    .reduce((total, name) => total + statSync(join(seed, name)).size, 0)
  put(join(seed, 'space-before-snapshot.json'), { availableBytes: 64 * 1024 ** 3,
    plannedBytes: fixtureBytes + generationPlan.evidenceAllowanceBytes,
    ownedBytes: fixtureBytes + preSnapshotOutputBytes })

  const parent = join(runtime, 'joint-generation-window-01'), supervisionDirectory = join(parent, 'supervision')
  mkdirSync(supervisionDirectory, { recursive: true })
  const ownerSha = put(join(parent, 'owner.json'), { scope: 'musicbridge-capacity-generation-window', owner: 'root', id })
  writeFileSync(join(parent, 'supervisor.py'), readFileSync(supervisor))
  const issuerIdentity = join(parent, 'issuer-identity'); mkdirSync(issuerIdentity)
  put(join(issuerIdentity, 'owner.json'), { schemaVersion: 1,
    scope: 'musicbridge-capacity-joint-generation-authority-issuer', windowId: id,
    candidateRepository: { root: repo, branch: 'main', head },
    supervisor: { path: join(parent, 'supervisor.py'), sha256: shaFile(supervisor) },
    issuer: { path: generationIssuer, sha256: shaFile(generationIssuer) },
    authorityInherited: false, receiptReuseAllowed: false, oldWindowReplayAllowed: false })
  const info = statSync(parent)
  const ownedPath = join(parent, 'owned-roots.json')
  const ownedSha = put(ownedPath, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId: id,
    roots: [{ path: parent, device: info.dev, inode: info.ino, marker: { relative: 'owner.json', sha256: ownerSha } }] })
  const sourcePath = join(parent, 'source-pins.json')
  const sourceSha = put(sourcePath, { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: { 'old.txt': 'c'.repeat(64) } })
  const windowPath = join(parent, 'window.json')
  const windowSha = put(windowPath, { schemaVersion: 1, scope: 'musicbridge-capacity-generation-window', owner: 'root', id,
    state: 'approved', phase: 'generate', profile: 'joint', label: 'joint-seed', n: 1,
    ownedManifest: { file: 'owned-roots.json', sha256: ownedSha }, sourceManifest: { file: 'source-pins.json', sha256: sourceSha } })
  const artifactProbe = spawnSync(python, ['-c', `import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('supervisor',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=json.loads(sys.argv[2]);expected={'profile':'joint','label':'joint-seed','window':p['id'],
'node':'/Users/yihe/.nvm/versions/node/v22.23.2/bin/node','entry':Path(p['repo'])/'packages/bridge-core/test/benchmarks/recording-capacity.ts',
'root':Path(p['repo']),'windowSha256':p['windowSha'],'ownedManifestSha256':p['ownedSha'],'sourceManifestSha256':p['sourceSha'],
'authorityProbe':lambda:{'authorityStable':True,'sourcePinsValid':True,'ownedRootsValid':True,'spaceValid':True}}
print(json.dumps(m._generation_artifacts(p['runtime'],'joint-seed',expected)))`, supervisor,
  JSON.stringify({ id, repo, runtime, windowSha, ownedSha, sourceSha })], { encoding: 'utf8' })
  assert.equal(artifactProbe.status, 0, artifactProbe.stderr)
  const generation = JSON.parse(artifactProbe.stdout)
  assert.equal(generation.verifiedPassed, true)
  const supervisionPath = join(supervisionDirectory, 'supervisor.json')
  const supervision = { passed: true, failure: null, code: 0, groupEmpty: true, zombies: [], generation }
  const supervisionSha = put(supervisionPath, supervision)
  const closePath = join(parent, 'close.json')
  const closeSha = put(closePath, { schemaVersion: 1, scope: 'musicbridge-capacity-generation-window-close', windowId: id,
    profile: 'joint', label: 'joint-seed', state: 'passed', failure: null, groupEmpty: true, zombies: [],
    windowSha256: windowSha, ownedManifestSha256: ownedSha, sourceManifestSha256: sourceSha,
    supervisorSha256: supervisionSha, generation, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
    replayPolicy: 'terminal-window-id-and-label-never-reuse' })
  const consumer = realpathSync(python)
  const args = ['--repo-root', repo, '--runtime-root', runtime,
    '--joint-generation-window', windowPath, '--expected-joint-generation-window-sha256', windowSha,
    '--joint-generation-close', closePath, '--expected-joint-generation-close-sha256', closeSha,
    '--joint-generation-supervision', supervisionPath, '--expected-joint-generation-supervision-sha256', supervisionSha,
    '--joint-generation-owned-manifest', ownedPath, '--expected-joint-generation-owned-sha256', ownedSha,
    '--joint-generation-source-manifest', sourcePath, '--expected-joint-generation-source-sha256', sourceSha,
    '--window-dir-name', 'joint-measure-window-01', '--label', 'joint-measure-01',
    '--expected-branch', 'main', '--expected-head', head, '--expected-source-count', '10',
    '--supervisor', supervisor, '--expected-supervisor-sha256', shaFile(supervisor),
    '--consumer-python', consumer, '--expected-consumer-sha256', shaFile(consumer),
    '--expected-issuer-sha256', shaFile(issuer)]
  return { root, repo, runtime, fixture, issuer, args }
}

test('完整CLI原子发布joint measure窗口且installed supervisor接受preflight', () => {
  const fixture = cliFixture()
  try {
    const result = spawnSync(python, [fixture.issuer, ...fixture.args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout), parent = join(fixture.runtime, 'joint-measure-window-01')
    const window = JSON.parse(readFileSync(join(parent, 'window.json'), 'utf8'))
    assert.equal(receipt.state, 'ISSUED_NOT_EXECUTED'); assert.equal(window.profile, 'joint')
    assert.equal(window.phase, 'measure'); assert.equal(receipt.predecessor.requiredResult, 'joint:generate:PASS')
    assert.equal(existsSync(join(parent, 'window.pending.json')), false)
    const preflight = spawnSync(python, ['-c', `import importlib.util,sys
spec=importlib.util.spec_from_file_location('installed',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
print(m._validate_measure_authority(sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5])['seedValid'])`,
    join(parent, 'supervisor.py'), parent, fixture.runtime, fixture.repo, receipt.windowSha256], { encoding: 'utf8' })
    assert.equal(preflight.status, 0, preflight.stderr); assert.equal(preflight.stdout.trim(), 'True')
  } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(fixture.fixture, { recursive: true, force: true }) }
})

test('完整CLI对dirty候选、前驱篡改与重放路径fail-closed', () => {
  for (const scenario of [
    { code: /JOINT_MEASURE_ISSUER_REPOSITORY_IDENTITY/u, mutate: f => writeFileSync(join(f.repo, 'dirty.txt'), 'dirty\n') },
    { code: /JOINT_MEASURE_ISSUER_JOINT_GENERATION_PASS/u, mutate: f => writeFileSync(argValue(f.args, '--joint-generation-close'), '{}\n') },
    { code: /JOINT_MEASURE_ISSUER_JOINT_GENERATION_PASS/u, mutate: f => writeFileSync(join(f.runtime, 'joint-seed', 'source-after.json'), '{}\n') },
    { code: /JOINT_MEASURE_ISSUER_JOINT_GENERATION_PASS/u, mutate: f => writeFileSync(join(f.runtime, 'joint-generation-window-01', 'issuer-identity', 'owner.json'), '{}\n') },
    { code: /JOINT_MEASURE_ISSUER_REPLAY_PATH/u, mutate: f => mkdirSync(join(f.runtime, 'joint-measure-window-01')) },
  ]) {
    const fixture = cliFixture()
    try {
      scenario.mutate(fixture)
      const result = spawnSync(python, [fixture.issuer, ...fixture.args], { encoding: 'utf8' })
      assert.notEqual(result.status, 0); assert.match(result.stderr, scenario.code)
      assert.equal(existsSync(join(fixture.runtime, 'joint-measure-window-01', 'window.json')), false)
    } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(fixture.fixture, { recursive: true, force: true }) }
  }
})
