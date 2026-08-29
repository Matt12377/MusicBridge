import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { normalizeReadinessError, validateOwnerReadiness } from '../verify-v3-owner-readiness.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const matrixBytes = readFileSync(new URL('../../../project/V3_ACCEPTANCE.json', import.meta.url))
const matrix = JSON.parse(matrixBytes)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const controlStatus = {
  v3Development: {
    task: 'TASK-079',
    branch: 'codex/task-079-v3-final-acceptance',
    baseCommit: 'fac7363b4a6481591e207dda7cca77f0ae8d3cd4',
    evidenceInfrastructure: {
      state: 'PASS_26_FOCUSED_FULL_VERIFY_CONTROL_BOUNDARIES_CYCLES',
      receiptFoundation: {
        baseCommit: '7c5db990dd79cf9aaf7e95d1a74306e73c81ec62',
        implementationCommit: 'e43f39f1f0994cc66a2be275ee4c7f715e9783d0',
        reportCommit: '23da9a122988929a0f79c02df744834613031205',
        finalCommit: '9e20a02679425fb97f081dd26529def4dbb5006e',
        focusedTests: 25,
      },
      candidateClosure: {
        baseCommit: '9e20a02679425fb97f081dd26529def4dbb5006e',
        implementationCommit: '04b77e45d48713f7437011e6e9bf51f87858c600',
        reportCommit: '98bce05e0453a8f6095b72129f3a6b3ee553a211',
        finalCommit: 'c66da1c741db87414976686ede6e02387f93ea7d',
        focusedTests: 26,
      },
    },
    deviceTestPlanning: {
      connectionState: 'no-devices-connected',
      audioInterfaceBrandCandidates: ['RME', 'Apogee'],
      audioInterfaceModel: null,
      plannedRecorder: { brand: 'Sony', type: 'cassette-deck', model: null },
      measurementConfiguration: 'PENDING',
      deviceOperationsAuthorization: 'NOT_GRANTED',
      outputBackendCertification: 'NOT_RUN',
    },
    gates: {
      readinessControl: 'PASS_15_FOCUSED_FULL_VERIFY_CONTROL_BOUNDARIES_CYCLES_REVIEW_P0_P1_ZERO',
      externalEvidenceProfiles: 'REAL_INPUT_REAL_LOGIC_PREPARED_REAL_ROON_HARDWARE_PENDING',
      externalGate: 'NOT_RUN',
      realInput: 'NOT_RUN',
      realLogic: 'NOT_RUN',
      realRoon: 'NOT_RUN',
      hardware: 'NOT_RUN',
      ownerDecisions: 'PENDING_103',
      audibleReplica: 'NOT_RUN',
      outputBackendCertification: 'NOT_RUN',
      realRecording: 'NOT_RUN',
      paperPrint: 'NOT_RUN',
      ownerProductAcceptance: 'NOT_RUN',
    },
  },
}
const controlWave = `activeTask: TASK-079\nactiveBranch: codex/task-079-v3-final-acceptance\nactiveBaseCommit: fac7363b4a6481591e207dda7cca77f0ae8d3cd4\n`

function readiness() {
  return {
    schemaVersion: 1,
    task: 'TASK-079',
    baseCommit: 'fac7363b4a6481591e207dda7cca77f0ae8d3cd4',
    phase: 'no-device-readiness',
    ready: false,
    softwareBaseline: {
      task: 'TASK-078',
      finalCommit: 'fac7363b4a6481591e207dda7cca77f0ae8d3cd4',
      matrixPath: 'project/V3_ACCEPTANCE.json',
      matrixSha256: sha256(matrixBytes),
      entries: 103,
      mappedPassed: 101,
      unmappedPending: ['B-13', 'B-15'],
      externalGate: 'NOT_RUN',
      formalReady: false,
    },
    devicePlan: {
      connectionState: 'not-connected',
      operationsAuthorized: false,
      audioInterfaceBrands: ['RME', 'Apogee'],
      audioInterfaceModel: null,
      recorderBrand: 'Sony',
      recorderKind: 'cassette-deck',
      recorderModel: null,
      configurationState: 'pending',
      measurementPlanState: 'pending',
    },
    externalRequirements: ['real-input', 'real-logic', 'real-roon', 'hardware', 'owner'].map(kind => ({ kind, state: 'not-run', evidenceIds: [] })),
    ownerDecisions: matrix.entries.map(({ id }) => ({ id, state: 'pending', evidenceIds: [] })),
    evidence: [],
  }
}

test('无设备基线精确校验并保持fail-closed', () => {
  const result = validateOwnerReadiness(readiness(), { root })
  assert.deepEqual(result, {
    ready: false,
    ownerPending: 103,
    externalNotRun: 5,
    deviceConnected: false,
    deviceOperationsAuthorized: false,
  })
})

test('任务、基线与冻结软件矩阵身份不可漂移', () => {
  for (const edit of [
    value => { value.task = 'TASK-078' },
    value => { value.baseCommit = '0'.repeat(40) },
    value => { value.softwareBaseline.finalCommit = '0'.repeat(40) },
    value => { value.softwareBaseline.matrixPath = '../secret' },
    value => { value.softwareBaseline.matrixSha256 = '0'.repeat(64) },
    value => { value.softwareBaseline.mappedPassed = 103 },
    value => { value.softwareBaseline.unmappedPending = [] },
    value => { value.softwareBaseline.formalReady = true },
  ]) {
    const value = readiness(); edit(value)
    assert.throws(() => validateOwnerReadiness(value, { root }))
  }
})

test('外部条件必须五类齐全且全部not-run', () => {
  for (const edit of [
    value => { value.externalRequirements.pop() },
    value => { value.externalRequirements.push(value.externalRequirements[0]) },
    value => { value.externalRequirements[0].kind = 'credentials' },
    value => { value.externalRequirements[0].state = 'passed' },
    value => { value.externalRequirements[0].evidenceIds = ['synthetic-pass'] },
  ]) {
    const value = readiness(); edit(value)
    assert.throws(() => validateOwnerReadiness(value, { root }), /EXTERNAL/u)
  }
})

test('Owner决策必须覆盖103条且无设备阶段全部pending', () => {
  for (const edit of [
    value => { value.ownerDecisions.pop() },
    value => { value.ownerDecisions.push(value.ownerDecisions[0]) },
    value => { value.ownerDecisions[0].id = 'MVP-99' },
    value => { value.ownerDecisions[0].state = 'accepted' },
    value => { value.ownerDecisions[0].evidenceIds = ['message-1'] },
  ]) {
    const value = readiness(); edit(value)
    assert.throws(() => validateOwnerReadiness(value, { root }), /OWNER/u)
  }
})

test('设备计划不能把品牌意向冒充连接、型号或操作授权', () => {
  for (const edit of [
    value => { value.devicePlan.connectionState = 'connected' },
    value => { value.devicePlan.operationsAuthorized = true },
    value => { value.devicePlan.audioInterfaceBrands = ['RME'] },
    value => { value.devicePlan.audioInterfaceModel = 'Fireface' },
    value => { value.devicePlan.recorderModel = 'unknown' },
    value => { value.devicePlan.configurationState = 'ready' },
    value => { value.devicePlan.measurementPlanState = 'ready' },
  ]) {
    const value = readiness(); edit(value)
    assert.throws(() => validateOwnerReadiness(value, { root }), /DEVICE/u)
  }
})

test('未知字段、证据与ready升级一律拒绝', () => {
  for (const edit of [
    value => { value.ready = true },
    value => { value.phase = 'owner-accepted' },
    value => { value.evidence = [{ token: 'secret' }] },
    value => { value.localPath = '/Users/example/Music' },
    value => { value.devicePlan.token = 'secret' },
    value => { value.ownerDecisions[0].note = 'accepted by guess' },
  ]) {
    const value = readiness(); edit(value)
    assert.throws(() => validateOwnerReadiness(value, { root }))
  }
})

test('TASK078矩阵若被升级外部门或formalReady则readiness拒绝', () => {
  const changed = structuredClone(matrix)
  changed.formalReady = true
  assert.throws(() => validateOwnerReadiness(readiness(), { root, matrix: changed }), /SOFTWARE_BASELINE/u)
  changed.formalReady = false
  changed.externalGate = 'PASS'
  assert.throws(() => validateOwnerReadiness(readiness(), { root, matrix: changed }), /SOFTWARE_BASELINE/u)
  changed.externalGate = 'NOT_RUN'
  changed.baseCommit = '0'.repeat(40)
  assert.throws(() => validateOwnerReadiness(readiness(), { root, matrix: changed }), /SOFTWARE_BASELINE/u)
})

test('实际矩阵fresh状态或B-13/B-15边界漂移不能信任自报摘要', () => {
  for (const edit of [
    value => { value.entries.find(entry => entry.status === 'mapped').freshGate = { state: 'pending', evidenceIds: [] } },
    value => { value.entries.find(entry => entry.id === 'B-13').status = 'mapped'; value.entries.find(entry => entry.id === 'B-13').freshGate = { state: 'passed', evidenceIds: ['fake'] } },
    value => { value.entries.find(entry => entry.id === 'B-15').freshGate = { state: 'failed', evidenceIds: ['fake'] } },
  ]) {
    const changed = structuredClone(matrix); edit(changed)
    assert.throws(() => validateOwnerReadiness(readiness(), { root, matrix: changed }), /SOFTWARE_BASELINE/u)
  }
})

test('即使篡改矩阵仍自报相同计数并同步新hash，也必须拒绝冻结身份漂移', t => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'task079-readiness-'))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))
  mkdirSync(path.join(temporaryRoot, 'project'), { recursive: true })
  const changed = structuredClone(matrix)
  changed.untrustedExtra = 'same-counts'
  const changedBytes = Buffer.from(JSON.stringify(changed))
  writeFileSync(path.join(temporaryRoot, 'project/V3_ACCEPTANCE.json'), changedBytes)
  const value = readiness()
  value.softwareBaseline.matrixSha256 = sha256(changedBytes)
  assert.throws(() => validateOwnerReadiness(value, { root: temporaryRoot, status: controlStatus, wave: controlWave }), /SOFTWARE_BASELINE/u)
})

test('STATUS v3Development与WAVE-5必须精确指向TASK079基线', () => {
  assert.equal(validateOwnerReadiness(readiness(), { root, status: controlStatus, wave: controlWave }).ready, false)
  for (const [status, wave] of [
    [{ v3Development: { ...controlStatus.v3Development, task: 'TASK-078' } }, controlWave],
    [{ v3Development: { ...controlStatus.v3Development, branch: 'codex/task-078-v3-acceptance' } }, controlWave],
    [{ v3Development: { ...controlStatus.v3Development, baseCommit: '0'.repeat(40) } }, controlWave],
    [controlStatus, controlWave.replace('activeTask: TASK-079', 'activeTask: TASK-078')],
    [controlStatus, controlWave.replace('activeBranch: codex/task-079-v3-final-acceptance', 'activeBranch: codex/task-078-v3-acceptance')],
    [controlStatus, controlWave.replace('activeBaseCommit: fac7363b4a6481591e207dda7cca77f0ae8d3cd4', `activeBaseCommit: ${'0'.repeat(40)}`)],
  ]) {
    assert.throws(() => validateOwnerReadiness(readiness(), { root, status, wave }), /CONTROL_IDENTITY/u)
  }
})

test('STATUS必须锁定两段证据基础设施检查点而非停留在初始readiness', () => {
  assert.equal(validateOwnerReadiness(readiness(), { root, status: controlStatus, wave: controlWave }).ready, false)
  for (const edit of [
    value => { delete value.v3Development.evidenceInfrastructure },
    value => { value.v3Development.evidenceInfrastructure.state = 'PASS_25_FOCUSED' },
    value => { value.v3Development.evidenceInfrastructure.receiptFoundation.finalCommit = '0'.repeat(40) },
    value => { value.v3Development.evidenceInfrastructure.receiptFoundation.focusedTests = 24 },
    value => { value.v3Development.evidenceInfrastructure.candidateClosure.baseCommit = '0'.repeat(40) },
    value => { value.v3Development.evidenceInfrastructure.candidateClosure.implementationCommit = '0'.repeat(40) },
    value => { value.v3Development.evidenceInfrastructure.candidateClosure.reportCommit = '0'.repeat(40) },
    value => { value.v3Development.evidenceInfrastructure.candidateClosure.finalCommit = '0'.repeat(40) },
    value => { value.v3Development.evidenceInfrastructure.candidateClosure.focusedTests = 25 },
  ]) {
    const status = structuredClone(controlStatus); edit(status)
    assert.throws(() => validateOwnerReadiness(readiness(), { root, status, wave: controlWave }), /CONTROL_STATE/u)
  }
})

test('证据检查点必须是当前TASK079仓库中线性可达的真实Git提交', async t => {
  const module = await import('../verify-v3-owner-readiness.mjs')
  assert.equal(typeof module.validateEvidenceCheckpointRepository, 'function')
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'task079-checkpoints-'))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))
  const git = (...arguments_) => {
    const result = spawnSync('git', arguments_, { cwd: temporaryRoot, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-b', 'codex/task-079-v3-final-acceptance')
  git('config', 'user.email', 'task079@example.invalid')
  git('config', 'user.name', 'TASK079 Test')
  const commits = []
  for (let index = 0; index < 7; index += 1) {
    writeFileSync(path.join(temporaryRoot, 'checkpoint.txt'), `${index}\n`)
    git('add', 'checkpoint.txt')
    git('commit', '-m', `checkpoint-${index}`)
    commits.push(git('rev-parse', 'HEAD'))
  }
  const infrastructure = {
    state: 'PASS_26_FOCUSED_FULL_VERIFY_CONTROL_BOUNDARIES_CYCLES',
    receiptFoundation: {
      baseCommit: commits[0], implementationCommit: commits[1], reportCommit: commits[2], finalCommit: commits[3], focusedTests: 25,
    },
    candidateClosure: {
      baseCommit: commits[3], implementationCommit: commits[4], reportCommit: commits[5], finalCommit: commits[6], focusedTests: 26,
    },
  }
  assert.doesNotThrow(() => module.validateEvidenceCheckpointRepository(temporaryRoot, infrastructure))
  const reversed = structuredClone(infrastructure)
  ;[reversed.candidateClosure.implementationCommit, reversed.candidateClosure.reportCommit] = [reversed.candidateClosure.reportCommit, reversed.candidateClosure.implementationCommit]
  assert.throws(() => module.validateEvidenceCheckpointRepository(temporaryRoot, reversed), /CONTROL_REPOSITORY/u)
})

test('STATUS设备与外部门状态不能和readiness清单互相矛盾', () => {
  for (const edit of [
    value => { value.v3Development.gates.readinessControl = 'PASS_14_FOCUSED_FULL_VERIFY_CONTROL_BOUNDARIES_CYCLES_REVIEW_P0_P1_ZERO' },
    value => { value.v3Development.gates.externalEvidenceProfiles = 'ALL_PREPARED' },
    value => { value.v3Development.deviceTestPlanning.connectionState = 'connected' },
    value => { value.v3Development.deviceTestPlanning.deviceOperationsAuthorization = 'GRANTED' },
    value => { value.v3Development.deviceTestPlanning.measurementConfiguration = 'READY' },
    value => { value.v3Development.deviceTestPlanning.audioInterfaceModel = 'Fireface' },
    value => { value.v3Development.gates.externalGate = 'PASS' },
    value => { value.v3Development.gates.hardware = 'PASS' },
    value => { value.v3Development.gates.ownerDecisions = 'ACCEPTED_103' },
    value => { value.v3Development.gates.realRecording = 'PASS' },
    value => { value.v3Development.gates.paperPrint = 'PASS' },
    value => { value.v3Development.gates.ownerProductAcceptance = 'PASS' },
  ]) {
    const status = structuredClone(controlStatus); edit(status)
    assert.throws(() => validateOwnerReadiness(readiness(), { root, status, wave: controlWave }), /CONTROL_STATE/u)
  }
})

test('矩阵路径任一符号链接组件都拒绝', t => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'task079-symlink-'))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))
  mkdirSync(path.join(temporaryRoot, 'project'), { recursive: true })
  symlinkSync(path.join(root, 'project/V3_ACCEPTANCE.json'), path.join(temporaryRoot, 'project/V3_ACCEPTANCE.json'))
  assert.throws(() => validateOwnerReadiness(readiness(), { root: temporaryRoot, status: controlStatus, wave: controlWave }), /BASELINE_PATH/u)
  rmSync(path.join(temporaryRoot, 'project'), { recursive: true, force: true })
  symlinkSync(path.join(root, 'project'), path.join(temporaryRoot, 'project'), 'dir')
  assert.throws(() => validateOwnerReadiness(readiness(), { root: temporaryRoot, status: controlStatus, wave: controlWave }), /BASELINE_PATH/u)
})

test('CLI错误只公开稳定错误码', () => {
  assert.equal(normalizeReadinessError(new Error('OWNER_STATE')), 'OWNER_STATE')
  assert.equal(normalizeReadinessError(new SyntaxError('/Users/name/private.json: unexpected token')), 'INVALID_READINESS')
  assert.equal(normalizeReadinessError({ message: 'arbitrary detail' }), 'INVALID_READINESS')
})
