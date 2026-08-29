import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeEvidenceError,
  sealReceipt,
  validateRepositoryReceiptIdentity,
  validateV3EvidenceEnvelope,
} from '../verify-v3-owner-evidence.mjs'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const trackedTemplate = JSON.parse(readFileSync(new URL('../../../project/V3_OWNER_EVIDENCE_TEMPLATE.json', import.meta.url)))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function actualFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'task079-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, '.gitignore'), 'reports/runtime/\n')
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0)
  const receiptId = 'gate-b-output-window-01'
  const relativePath = `reports/runtime/task-079-v3-final-acceptance/receipts/${receiptId}/output-samples.json`
  const absolutePath = path.join(root, relativePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  const samples = [
    { state: 'passed', detectMs: 10, engineCutoffMs: 20, backendTailMs: 40, totalMs: 70 },
    { state: 'passed', detectMs: 12, engineCutoffMs: 30, backendTailMs: 50, totalMs: 92 },
    { state: 'passed', detectMs: 11, engineCutoffMs: 25, backendTailMs: 45, totalMs: 81 },
  ]
  const bytes = Buffer.from(`${JSON.stringify({ samples })}\n`)
  writeFileSync(absolutePath, bytes)
  const contract = {
    requiredSampleCount: 3,
    maxMeasurementErrorMs: 1,
    engineCutoffMaxMs: 100,
    totalMaxMs: 2000,
    clockRelation: 'shared-monotonic-calibrated',
    silenceCriterion: 'rms-below-fixed-plan-threshold',
  }
  const contractRelativePath = `reports/runtime/task-079-v3-final-acceptance/receipts/${receiptId}/measurement-contract.json`
  const contractBytes = Buffer.from(`${JSON.stringify(contract)}\n`)
  writeFileSync(path.join(root, contractRelativePath), contractBytes)
  const configuration = {
    audioInterfaceAlias: 'interface-01',
    recorderAlias: 'recorder-01',
    backendId: 'core-audio-hal',
    backendVersion: '1.0.0',
    driverId: 'driver-01',
    driverVersion: '1.0.0',
    firmwareVersion: '1.0.0',
    interfaceUnitAlias: 'interface-unit-01',
    recorderUnitAlias: 'recorder-unit-01',
    cableRouteId: 'route-01',
    channelMap: ['channel-left', 'channel-right'],
    sampleRateHz: 96000,
    channels: 2,
    sampleFormat: 'pcm-s24',
    bufferFrames: 128,
    clockMode: 'interface-internal',
    outputLevelProfile: 'level-profile-01',
    converterId: 'converter-01',
    ditherMode: 'dither-none',
    physicalTargetAlias: 'target-01',
    measurementDeviceAlias: 'measurement-device-01',
    calibrationSha256: 'c'.repeat(64),
    measurementPlanSha256: sha256(contractBytes),
  }
  const configurationBytes = Buffer.from(JSON.stringify(configuration))
  const artifacts = [{
    artifactId: 'output-samples',
    role: 'independent-output-capture',
    relativePath,
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
    mediaType: 'application/json',
  }, {
    artifactId: 'measurement-contract',
    role: 'measurement-contract',
    relativePath: contractRelativePath,
    sha256: sha256(contractBytes),
    sizeBytes: contractBytes.length,
    mediaType: 'application/json',
  }, {
    artifactId: 'configuration-seal',
    role: 'configuration-seal',
    relativePath: `reports/runtime/task-079-v3-final-acceptance/receipts/${receiptId}/configuration-seal.json`,
    sha256: sha256(configurationBytes),
    sizeBytes: configurationBytes.length,
    mediaType: 'application/json',
  }]
  writeFileSync(path.join(root, artifacts[2].relativePath), configurationBytes)
  const fixture = {
    root,
    envelope: {
      schemaVersion: 1,
      task: 'TASK-079',
      baseCommit: 'fac7363b4a6481591e207dda7cca77f0ae8d3cd4',
      template: false,
      ready: false,
      evidenceRoot: 'reports/runtime/task-079-v3-final-acceptance',
      receipt: {
        receiptId,
        kind: 'real-output-measurement',
        scopeIds: ['B-09'],
        observedAt: '2026-08-29T06:00:00.000Z',
        candidateCommit: '3e4d5c6b7a891011121314151617181920212223',
        candidateTree: '4e5d6c7b8a901112131415161718192021222324',
        candidateManifestSha256: '7'.repeat(64),
        matrixSha256: '12f15170b25f578ba06d4def53060b58096fd57bf378d0e28f8ca2a7fe4ba944',
        authorizationSha256: '4'.repeat(64),
        planSha256: '5'.repeat(64),
        preflightSha256: '6'.repeat(64),
        environmentFingerprint: '1'.repeat(64),
        configuration,
        configurationFingerprintSha256: sha256(Buffer.from(JSON.stringify(configuration))),
        artifacts,
        verdict: 'passed',
        reasonCodes: [],
        measurements: {
          sampleCount: 3,
          failedCount: 0,
          timeoutCount: 0,
          clockRelation: 'shared-monotonic-calibrated',
          silenceCriterion: 'rms-below-fixed-plan-threshold',
          measurementErrorMs: 0.5,
          samples,
          detectMs: { p50: 11, p95: 12, p99: 12, max: 12 },
          engineCutoffMs: { p50: 25, p95: 30, p99: 30, max: 30 },
          backendTailMs: { p50: 45, p95: 50, p99: 50, max: 50 },
          totalMs: { p50: 81, p95: 92, p99: 92, max: 92 },
        },
        caseEvidence: {
          type: 'output-stop',
          injectionKind: 'roon-track-change',
          interrupted: true,
          outputEndpointMeasured: true,
          fallbackCount: 0,
          replacementContentCount: 0,
          automaticResumeCount: 0,
          recoveredState: null,
        },
        ownerDecision: null,
        referencedTechnicalReceipts: [],
      },
    },
  }
  syncControlSeals(fixture)
  syncCaseArtifact(fixture)
  return fixture
}

function upsertJsonArtifact(fixture, artifactId, role, value) {
  const relativePath = `reports/runtime/task-079-v3-final-acceptance/receipts/${fixture.envelope.receipt.receiptId}/${artifactId}.json`
  const bytes = Buffer.from(JSON.stringify(value))
  writeFileSync(path.join(fixture.root, relativePath), bytes)
  let artifact = fixture.envelope.receipt.artifacts.find(item => item.artifactId === artifactId)
  if (!artifact) {
    artifact = { artifactId, role, relativePath, sha256: '', sizeBytes: 0, mediaType: 'application/json' }
    fixture.envelope.receipt.artifacts.push(artifact)
  }
  artifact.sha256 = sha256(bytes)
  artifact.sizeBytes = bytes.length
  return artifact.sha256
}

function syncControlSeals(fixture, { grantedAt = '2026-08-29T05:50:00.000Z' } = {}) {
  const receipt = fixture.envelope.receipt
  const scopeId = receipt.scopeIds[0]
  const measurementContractSha256 = receipt.artifacts.find(artifact => artifact.role === 'measurement-contract').sha256
  const controlledFiles = [
    { relativePath: 'project/V3_ACCEPTANCE.json', sha256: receipt.matrixSha256 },
    { relativePath: 'scripts/ci/verify-v3-owner-evidence.mjs', sha256: '8'.repeat(64) },
  ]
  receipt.environmentFingerprint = upsertJsonArtifact(fixture, 'environment-seal', 'environment-seal', {
    runId: receipt.receiptId,
    osFamily: 'macos',
    architecture: 'arm64',
    backendId: receipt.configuration.backendId,
    measurementDeviceAlias: receipt.configuration.measurementDeviceAlias,
    clockRelation: 'shared-monotonic-calibrated',
  })
  receipt.candidateManifestSha256 = upsertJsonArtifact(fixture, 'candidate-manifest', 'candidate-manifest', {
    candidateCommit: receipt.candidateCommit,
    candidateTree: receipt.candidateTree,
    controlledFiles,
    controlledFilesSha256: sha256(Buffer.from(JSON.stringify(controlledFiles))),
  })
  receipt.authorizationSha256 = upsertJsonArtifact(fixture, 'authorization-seal', 'authorization-seal', {
    scopeId,
    runId: receipt.receiptId,
    candidateCommit: receipt.candidateCommit,
    candidateTree: receipt.candidateTree,
    candidateManifestSha256: receipt.candidateManifestSha256,
    configurationFingerprintSha256: receipt.configurationFingerprintSha256,
    measurementContractSha256,
    allowedOperations: ['read-evidence', ...(['B-09', 'B-10', 'B-11', 'B-12'].includes(scopeId) ? ['measure-output', 'inject-fault'] : [])],
    allowedInjectionKinds: ['B-09', 'B-10', 'B-11', 'B-12'].includes(scopeId) ? [receipt.caseEvidence.injectionKind] : [],
    allowedDataClasses: ['anonymous-technical-evidence'],
    grantedAt,
    expiresAt: '2026-08-29T06:10:00.000Z',
  })
  receipt.planSha256 = upsertJsonArtifact(fixture, 'plan-seal', 'plan-seal', {
    scopeId,
    runId: receipt.receiptId,
    candidateCommit: receipt.candidateCommit,
    candidateTree: receipt.candidateTree,
    candidateManifestSha256: receipt.candidateManifestSha256,
    configurationFingerprintSha256: receipt.configurationFingerprintSha256,
    measurementContractSha256,
    grantSha256: receipt.authorizationSha256,
    frozenAt: '2026-08-29T05:55:00.000Z',
  })
  receipt.preflightSha256 = upsertJsonArtifact(fixture, 'preflight-seal', 'preflight-seal', {
    scopeId,
    runId: receipt.receiptId,
    candidateCommit: receipt.candidateCommit,
    candidateTree: receipt.candidateTree,
    candidateManifestSha256: receipt.candidateManifestSha256,
    configurationFingerprintSha256: receipt.configurationFingerprintSha256,
    measurementContractSha256,
    grantSha256: receipt.authorizationSha256,
    planSha256: receipt.planSha256,
    observedAt: '2026-08-29T05:58:00.000Z',
    passed: true,
  })
}

function syncCaseArtifact(fixture) {
  upsertJsonArtifact(fixture, 'case-evidence', 'case-evidence', fixture.envelope.receipt.caseEvidence)
}

function syncSampleArtifact(fixture) {
  const artifact = fixture.envelope.receipt.artifacts.find(value => value.artifactId === 'output-samples')
  const bytes = Buffer.from(`${JSON.stringify({ samples: fixture.envelope.receipt.measurements.samples })}\n`)
  writeFileSync(path.join(fixture.root, artifact.relativePath), bytes)
  artifact.sha256 = sha256(bytes)
  artifact.sizeBytes = bytes.length
}

function writeReceiptSeal(root, receiptId, receiptBytes) {
  const relativePath = `reports/runtime/task-079-v3-final-acceptance/receipts/${receiptId}.sealed.sha256`
  writeFileSync(path.join(root, relativePath), `${sha256(receiptBytes)}\n`)
}

function writeConfigurationCertificate(fixture, certificateId, configurationFingerprintSha256) {
  const value = {
    schemaVersion: 1,
    kind: 'configuration-certificate',
    certificateId,
    scopeId: 'B-15',
    candidateCommit: '2e4d5c6b7a891011121314151617181920212223',
    candidateTree: '2e5d6c7b8a901112131415161718192021222324',
    matrixSha256: fixture.envelope.receipt.matrixSha256,
    configurationFingerprintSha256,
    verdict: 'passed',
  }
  const bytes = Buffer.from(JSON.stringify(value))
  const relativePath = `reports/runtime/task-079-v3-final-acceptance/receipts/${certificateId}.certificate.json`
  writeFileSync(path.join(fixture.root, relativePath), bytes)
  writeFileSync(path.join(fixture.root, `reports/runtime/task-079-v3-final-acceptance/receipts/${certificateId}.certificate.sealed.sha256`), `${sha256(bytes)}\n`)
  return sha256(bytes)
}

test('受控模板精确校验且不能表示实际证据或全局ready', () => {
  assert.deepEqual(validateV3EvidenceEnvelope(trackedTemplate, { root: projectRoot }), {
    template: true,
    ready: false,
    receiptId: null,
    verdict: null,
  })
  for (const edit of [
    value => { value.template = false },
    value => { value.ready = true },
    value => { value.receipt = {} },
    value => { value.extra = 'guess' },
    value => { value.baseCommit = '0'.repeat(40) },
  ]) {
    const value = structuredClone(trackedTemplate); edit(value)
    assert.throws(() => validateV3EvidenceEnvelope(value, { root: projectRoot }))
  }
})

test('真实输出收据验证固定身份、匿名配置、实际文件hash与延迟合同', t => {
  const { root, envelope } = actualFixture(t)
  assert.deepEqual(validateV3EvidenceEnvelope(envelope, { root }), {
    template: false,
    ready: false,
    receiptId: 'gate-b-output-window-01',
    verdict: 'passed',
  })
})

test('未知字段、敏感字段、绝对路径、URL和非匿名设备值拒绝', t => {
  for (const edit of [
    value => { value.receipt.token = 'secret' },
    value => { value.receipt.configuration.serialNumber = '123' },
    value => { value.receipt.configuration.audioInterfaceAlias = 'RME Fireface UCX II' },
    value => { value.receipt.configuration.backendVersion = '/Users/name/private' },
    value => { value.receipt.artifacts[0].relativePath = 'https://example.test/log' },
    value => { value.receipt.artifacts[0].relativePath = '../private.json' },
  ]) {
    const { root, envelope } = actualFixture(t); edit(envelope)
    assert.throws(() => validateV3EvidenceEnvelope(envelope, { root }))
  }
})

test('证据路径必须在固定忽略目录且文件大小与hash精确一致', t => {
  for (const edit of [
    value => { value.receipt.artifacts[0].relativePath = 'project/V3_ACCEPTANCE.json' },
    value => { value.receipt.artifacts[0].sha256 = '0'.repeat(64) },
    value => { value.receipt.artifacts[0].sizeBytes += 1 },
  ]) {
    const { root, envelope } = actualFixture(t); edit(envelope)
    assert.throws(() => validateV3EvidenceEnvelope(envelope, { root }), /ARTIFACT/u)
  }
})

test('证据文件或路径任一组件为符号链接时拒绝', t => {
  const { root, envelope } = actualFixture(t)
  const artifact = envelope.receipt.artifacts[0]
  const absolutePath = path.join(root, artifact.relativePath)
  const targetPath = path.join(root, 'private.json')
  writeFileSync(targetPath, '{"private":true}\n')
  rmSync(absolutePath)
  symlinkSync(targetPath, absolutePath)
  assert.throws(() => validateV3EvidenceEnvelope(envelope, { root }), /ARTIFACT/u)
})

test('硬链接及文本附件中的凭据或私密路径形态拒绝', t => {
  const linked = actualFixture(t)
  const artifact = linked.envelope.receipt.artifacts[0]
  const absolutePath = path.join(linked.root, artifact.relativePath)
  const hardlinkPath = path.join(linked.root, 'hardlink.json')
  linkSync(absolutePath, hardlinkPath)
  assert.throws(() => validateV3EvidenceEnvelope(linked.envelope, { root: linked.root }), /ARTIFACT/u)

  for (const unsafe of ['{"token":"secret"}\n', '{"path":"/Users/name/private"}\n', '{"authorization":"Bearer abc"}\n', '{"to\\u006ben":"opaque"}\n', '{"path":"\\u002fUsers\\u002fname\\u002fprivate"}\n']) {
    const fixture = actualFixture(t)
    const value = fixture.envelope.receipt.artifacts[0]
    const bytes = Buffer.from(unsafe)
    writeFileSync(path.join(fixture.root, value.relativePath), bytes)
    value.sha256 = sha256(bytes)
    value.sizeBytes = bytes.length
    assert.throws(() => validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }), /ARTIFACT/u)
  }

  const invalidUtf8 = actualFixture(t)
  const bytes = Buffer.from([0xff, 0xfe, 0xfd])
  const relativePath = `reports/runtime/task-079-v3-final-acceptance/receipts/${invalidUtf8.envelope.receipt.receiptId}/invalid.txt`
  writeFileSync(path.join(invalidUtf8.root, relativePath), bytes)
  invalidUtf8.envelope.receipt.artifacts.push({ artifactId: 'invalid-text', role: 'event-log', relativePath, sha256: sha256(bytes), sizeBytes: bytes.length, mediaType: 'text/plain' })
  assert.throws(() => validateV3EvidenceEnvelope(invalidUtf8.envelope, { root: invalidUtf8.root }), /ARTIFACT/u)
})

test('附件必须明确被Git忽略且未被强制跟踪，Git错误不得fail-open', t => {
  const tracked = actualFixture(t)
  assert.equal(spawnSync('git', ['add', '-f', '--', tracked.envelope.receipt.artifacts[0].relativePath], { cwd: tracked.root }).status, 0)
  assert.throws(() => validateV3EvidenceEnvelope(tracked.envelope, { root: tracked.root }), /ARTIFACT/u)

  const notIgnored = actualFixture(t)
  writeFileSync(path.join(notIgnored.root, '.gitignore'), '')
  assert.throws(() => validateV3EvidenceEnvelope(notIgnored.envelope, { root: notIgnored.root }), /ARTIFACT/u)

  const notRepository = actualFixture(t)
  rmSync(path.join(notRepository.root, '.git'), { recursive: true, force: true })
  assert.throws(() => validateV3EvidenceEnvelope(notRepository.envelope, { root: notRepository.root }), /ARTIFACT/u)
})

test('passed输出测量必须保留样本、超时和四段统计并满足100/2000ms阈值', t => {
  for (const edit of [
    value => { value.receipt.measurements = null },
    value => { value.receipt.measurements.sampleCount = 0 },
    value => { value.receipt.measurements.failedCount = 1 },
    value => { value.receipt.measurements.timeoutCount = 1 },
    value => { value.receipt.measurements.engineCutoffMs.max = 100.001 },
    value => { value.receipt.measurements.totalMs.max = 2000.001 },
    value => { delete value.receipt.measurements.totalMs.p99 },
    value => { value.receipt.measurements.detectMs.p95 = 13; value.receipt.measurements.detectMs.p99 = 11 },
    value => { value.receipt.measurements.samples[0].totalMs = 69 },
    value => { value.receipt.measurements.totalMs.p50 = 80 },
    value => { value.receipt.measurements.samples[0].detectMs = 9; value.receipt.measurements.samples[0].totalMs = 69 },
    value => { value.receipt.measurements.measurementErrorMs = 100 },
  ]) {
    const { root, envelope } = actualFixture(t); edit(envelope)
    assert.throws(() => validateV3EvidenceEnvelope(envelope, { root }), /MEASUREMENT/u)
  }
})

test('ACK、EOF、进程退出或UI状态不能代替输出端测量', t => {
  for (const forbidden of ['ackMs', 'eofMs', 'processExitMs', 'uiInterruptedAt']) {
    const { root, envelope } = actualFixture(t)
    envelope.receipt.measurements[forbidden] = 1
    assert.throws(() => validateV3EvidenceEnvelope(envelope, { root }), /MEASUREMENT/u)
  }
})

test('技术证据与Owner观察必须分离且单份收据不能声明全局ready', t => {
  const { root, envelope } = actualFixture(t)
  envelope.receipt.ownerDecision = 'accepted'
  assert.throws(() => validateV3EvidenceEnvelope(envelope, { root }), /OWNER_BOUNDARY/u)

  const owner = actualFixture(t)
  owner.envelope.receipt.scopeIds = ['B-13']
  syncControlSeals(owner)
  owner.envelope.receipt.measurements = null
  upsertJsonArtifact(owner, 'notification-capture', 'independent-output-capture', { notificationDetected: false, promptRoute: 'silent-ui' })
  owner.envelope.receipt.caseEvidence = {
    type: 'notification-audio',
    formalOutputNotificationDetected: false,
    promptRoute: 'silent-ui',
    captureArtifactId: 'notification-capture',
  }
  syncCaseArtifact(owner)
  const technicalBytes = Buffer.from(JSON.stringify(owner.envelope))
  const technicalPath = 'reports/runtime/task-079-v3-final-acceptance/receipts/gate-b-output-window-01.json'
  writeFileSync(path.join(owner.root, technicalPath), technicalBytes)
  const technicalSha256 = sha256(technicalBytes)

  const ownerEnvelope = structuredClone(owner.envelope)
  ownerEnvelope.receipt.receiptId = 'owner-b13-window-01'
  ownerEnvelope.receipt.kind = 'owner-observed'
  ownerEnvelope.receipt.configuration = null
  ownerEnvelope.receipt.configurationFingerprintSha256 = null
  ownerEnvelope.receipt.measurements = null
  ownerEnvelope.receipt.caseEvidence = null
  ownerEnvelope.receipt.artifacts = []
  ownerEnvelope.receipt.verdict = null
  ownerEnvelope.receipt.ownerDecision = 'accepted'
  ownerEnvelope.receipt.referencedTechnicalReceipts = [{ receiptId: 'gate-b-output-window-01', receiptSha256: technicalSha256 }]
  assert.throws(() => validateV3EvidenceEnvelope(ownerEnvelope, { root: owner.root }), /OWNER_BOUNDARY/u)
  writeReceiptSeal(owner.root, 'gate-b-output-window-01', technicalBytes)
  assert.equal(validateV3EvidenceEnvelope(ownerEnvelope, { root: owner.root }).verdict, 'accepted')

  const staleCandidate = structuredClone(ownerEnvelope)
  staleCandidate.receipt.candidateCommit = '5e4d5c6b7a891011121314151617181920212223'
  assert.throws(() => validateV3EvidenceEnvelope(staleCandidate, { root: owner.root }), /OWNER_BOUNDARY/u)

  ownerEnvelope.receipt.referencedTechnicalReceipts = []
  assert.throws(() => validateV3EvidenceEnvelope(ownerEnvelope, { root: owner.root }), /OWNER_BOUNDARY/u)

  ownerEnvelope.receipt.ownerDecision = 'rejected'
  assert.equal(validateV3EvidenceEnvelope(ownerEnvelope, { root: owner.root }).verdict, 'rejected')
  ownerEnvelope.receipt.ownerDecision = 'deferred'
  assert.equal(validateV3EvidenceEnvelope(ownerEnvelope, { root: owner.root }).verdict, 'deferred')
})

test('scope必须来自冻结103项且每份技术收据只覆盖一个B-01至B-15用例', t => {
  for (const scopes of [['B-99'], ['A-01'], ['B-09', 'B-10'], ['B-09', 'B-09']]) {
    const { root, envelope } = actualFixture(t)
    envelope.receipt.scopeIds = scopes
    assert.throws(() => validateV3EvidenceEnvelope(envelope, { root }), /SCOPE/u)
  }
})

test('候选、矩阵、授权、Plan、Preflight与配置指纹必须全部冻结', t => {
  for (const edit of [
    value => { value.receipt.candidateCommit = '0'.repeat(40) },
    value => { value.receipt.candidateTree = '0'.repeat(40) },
    value => { value.receipt.candidateManifestSha256 = '0'.repeat(64) },
    value => { value.receipt.matrixSha256 = '0'.repeat(64) },
    value => { value.receipt.authorizationSha256 = 'x' },
    value => { value.receipt.planSha256 = null },
    value => { value.receipt.preflightSha256 = '0'.repeat(63) },
    value => { value.receipt.configurationFingerprintSha256 = '0'.repeat(64) },
  ]) {
    const { root, envelope } = actualFixture(t); edit(envelope)
    assert.throws(() => validateV3EvidenceEnvelope(envelope, { root }))
  }
})

test('B13通知音、B14三层完成与B15配置失配使用各自判别证据', t => {
  const b13 = actualFixture(t)
  b13.envelope.receipt.scopeIds = ['B-13']
  syncControlSeals(b13)
  b13.envelope.receipt.measurements = null
  upsertJsonArtifact(b13, 'notification-capture', 'independent-output-capture', { notificationDetected: false, promptRoute: 'silent-ui' })
  b13.envelope.receipt.caseEvidence = {
    type: 'notification-audio',
    formalOutputNotificationDetected: false,
    promptRoute: 'silent-ui',
    captureArtifactId: 'notification-capture',
  }
  syncCaseArtifact(b13)
  assert.equal(validateV3EvidenceEnvelope(b13.envelope, { root: b13.root }).verdict, 'passed')
  upsertJsonArtifact(b13, 'notification-capture', 'independent-output-capture', { notificationDetected: true, promptRoute: 'silent-ui' })
  assert.throws(() => validateV3EvidenceEnvelope(b13.envelope, { root: b13.root }), /CASE_EVIDENCE/u)

  const b14 = actualFixture(t)
  b14.envelope.receipt.scopeIds = ['B-14']
  syncControlSeals(b14)
  b14.envelope.receipt.measurements = null
  upsertJsonArtifact(b14, 'source-eof', 'event-log', { event: 'source-eof', observedAt: '2026-08-29T05:59:55.000Z' })
  upsertJsonArtifact(b14, 'backend-drained', 'independent-output-capture', { event: 'backend-drained', observedAt: '2026-08-29T05:59:56.000Z' })
  upsertJsonArtifact(b14, 'physical-complete', 'completion-attestation', { event: 'physical-completed', observedAt: '2026-08-29T05:59:58.000Z', physicalStopMs: 1250 })
  b14.envelope.receipt.caseEvidence = {
    type: 'completion-layers',
    sourceEofEvidenceId: 'source-eof',
    backendDrainedEvidenceId: 'backend-drained',
    physicalCompletionEvidenceId: 'physical-complete',
    physicalStopMs: 1250,
    sourceEofAt: '2026-08-29T05:59:55.000Z',
    backendDrainedAt: '2026-08-29T05:59:56.000Z',
    physicalCompletedAt: '2026-08-29T05:59:58.000Z',
    completedAt: '2026-08-29T05:59:59.000Z',
    completedAfterAllLayers: true,
  }
  syncCaseArtifact(b14)
  assert.equal(validateV3EvidenceEnvelope(b14.envelope, { root: b14.root }).verdict, 'passed')
  upsertJsonArtifact(b14, 'backend-drained', 'independent-output-capture', { event: 'backend-drained', observedAt: '2026-08-29T06:00:01.000Z' })
  assert.throws(() => validateV3EvidenceEnvelope(b14.envelope, { root: b14.root }), /CASE_EVIDENCE/u)

  const b15 = actualFixture(t)
  b15.envelope.receipt.scopeIds = ['B-15']
  syncControlSeals(b15)
  b15.envelope.receipt.measurements = null
  b15.envelope.receipt.caseEvidence = {
    type: 'configuration-certification',
    priorCertificateId: 'gate-b-config-old-cert-01',
    priorCertificateSha256: '8'.repeat(64),
    previousConfigurationFingerprintSha256: '7'.repeat(64),
    currentConfigurationFingerprintSha256: b15.envelope.receipt.configurationFingerprintSha256,
    oldCertificateApplied: false,
    changedKeys: ['bufferFrames'],
    certificateState: 'recertified',
    recertificationReceiptId: b15.envelope.receipt.receiptId,
  }
  syncCaseArtifact(b15)
  assert.throws(() => validateV3EvidenceEnvelope(b15.envelope, { root: b15.root }), /CASE_EVIDENCE/u)
  b15.envelope.receipt.caseEvidence.priorCertificateSha256 = writeConfigurationCertificate(b15, 'gate-b-config-old-cert-01', '7'.repeat(64))
  syncCaseArtifact(b15)
  assert.equal(validateV3EvidenceEnvelope(b15.envelope, { root: b15.root }).verdict, 'passed')
  b15.envelope.receipt.caseEvidence.oldCertificateApplied = true
  assert.throws(() => validateV3EvidenceEnvelope(b15.envelope, { root: b15.root }), /CASE_EVIDENCE/u)
})

test('B01至B08每项使用独立case payload且关键语义不能互相代替', t => {
  const cases = new Map([
    ['B-01', { type: 'asset-manifest', sourceCount: 3, compiledBeforeFormalPlayback: true, runtimeTrackConversionCount: 0, assetSha256: '8'.repeat(64), manifestSha256: '9'.repeat(64), frameManifestVerified: true }],
    ['B-02', { type: 'gap-frames', sampleRateHz: 96000, expectedGapFrames: 480000, observedGapFrames: [480000, 480000], finalAssetVerified: true }],
    ['B-03', { type: 'source-silence', leadingFramesBefore: 9600, leadingFramesAfter: 9600, trailingFramesBefore: 19200, trailingFramesAfter: 19200, preserved: true }],
    ['B-04', { type: 'prepared-render-gap', renderConformant: true, additionalGapFrames: 0, derivativeCreated: false, derivativeLineageSha256: null }],
    ['B-05', { type: 'format-unification', inputFormatCount: 2, finalSampleRateHz: 96000, finalChannels: 2, runtimeFormatSwitchCount: 0, lineageSha256: 'a'.repeat(64) }],
    ['B-06', { type: 'fallback-prohibition', rejectedModes: ['smart', 'online-fallback', 'shuffle', 'radio', 'ordinary-queue'], sourceSwitchCount: 0, backendSwitchCount: 0 }],
    ['B-07', { type: 'side-a-end', state: 'awaiting-side-flip', sideBStarted: false, sideBSubmittedFrames: 0 }],
    ['B-08', { type: 'dat-continuous', sideFlipFlowEntered: false, capacityMatched: true, automaticTrackIdClaimed: false }],
  ])
  for (const [gateId, caseEvidence] of cases) {
    const fixture = actualFixture(t)
    fixture.envelope.receipt.scopeIds = [gateId]
    syncControlSeals(fixture)
    fixture.envelope.receipt.measurements = null
    fixture.envelope.receipt.caseEvidence = caseEvidence
    syncCaseArtifact(fixture)
    assert.equal(validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }).verdict, 'passed', gateId)
    const wrong = structuredClone(fixture.envelope)
    wrong.receipt.caseEvidence = cases.get(gateId === 'B-01' ? 'B-02' : 'B-01')
    assert.throws(() => validateV3EvidenceEnvelope(wrong, { root: fixture.root }), /CASE_EVIDENCE/u, gateId)
  }
})

test('B09至B12故障类型、恢复状态和输出端测量不可跨用', t => {
  const allowed = new Map([
    ['B-09', 'roon-zone-change'],
    ['B-10', 'device-removed'],
    ['B-11', 'underrun'],
    ['B-12', 'app-terminated'],
  ])
  for (const [gateId, injectionKind] of allowed) {
    const fixture = actualFixture(t)
    fixture.envelope.receipt.scopeIds = [gateId]
    fixture.envelope.receipt.caseEvidence.injectionKind = injectionKind
    fixture.envelope.receipt.caseEvidence.recoveredState = gateId === 'B-12' ? 'interrupted' : null
    syncControlSeals(fixture)
    syncCaseArtifact(fixture)
    assert.equal(validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }).verdict, 'passed', gateId)
    fixture.envelope.receipt.caseEvidence.injectionKind = gateId === 'B-10' ? 'roon-track-change' : 'device-removed'
    assert.throws(() => validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }), /(?:CASE_EVIDENCE|RECEIPT_STATE)/u, gateId)
  }
})

test('failed、timed-out和stopped收据保留失败事实且不能伪装passed', t => {
  const notification = actualFixture(t)
  notification.envelope.receipt.scopeIds = ['B-13']
  syncControlSeals(notification)
  notification.envelope.receipt.measurements = null
  notification.envelope.receipt.verdict = 'failed'
  notification.envelope.receipt.reasonCodes = ['notification-detected']
  upsertJsonArtifact(notification, 'notification-capture', 'independent-output-capture', { notificationDetected: true, promptRoute: 'silent-ui' })
  notification.envelope.receipt.caseEvidence = {
    type: 'notification-audio',
    formalOutputNotificationDetected: true,
    promptRoute: 'silent-ui',
    captureArtifactId: 'notification-capture',
  }
  syncCaseArtifact(notification)
  assert.equal(validateV3EvidenceEnvelope(notification.envelope, { root: notification.root }).verdict, 'failed')
  notification.envelope.receipt.verdict = 'passed'
  notification.envelope.receipt.reasonCodes = []
  assert.throws(() => validateV3EvidenceEnvelope(notification.envelope, { root: notification.root }), /CASE_EVIDENCE/u)

  const timeout = actualFixture(t)
  timeout.envelope.receipt.verdict = 'timed-out'
  timeout.envelope.receipt.reasonCodes = ['output-timeout']
  timeout.envelope.receipt.measurements.samples[2].state = 'timed-out'
  timeout.envelope.receipt.measurements.timeoutCount = 1
  syncSampleArtifact(timeout)
  assert.equal(validateV3EvidenceEnvelope(timeout.envelope, { root: timeout.root }).verdict, 'timed-out')

  const compileFailure = actualFixture(t)
  compileFailure.envelope.receipt.scopeIds = ['B-01']
  compileFailure.envelope.receipt.verdict = 'failed'
  compileFailure.envelope.receipt.reasonCodes = ['asset-compilation-failed']
  compileFailure.envelope.receipt.measurements = null
  compileFailure.envelope.receipt.caseEvidence = { type: 'asset-manifest', sourceCount: 2, compiledBeforeFormalPlayback: false, runtimeTrackConversionCount: 0, assetSha256: null, manifestSha256: null, frameManifestVerified: false }
  syncControlSeals(compileFailure)
  syncCaseArtifact(compileFailure)
  assert.equal(validateV3EvidenceEnvelope(compileFailure.envelope, { root: compileFailure.root }).verdict, 'failed')

  const stopped = actualFixture(t)
  stopped.envelope.receipt.verdict = 'stopped'
  stopped.envelope.receipt.reasonCodes = ['operation-stopped']
  stopped.envelope.receipt.caseEvidence.interrupted = false
  syncCaseArtifact(stopped)
  assert.equal(validateV3EvidenceEnvelope(stopped.envelope, { root: stopped.root }).verdict, 'stopped')

  const inconclusive = actualFixture(t)
  inconclusive.envelope.receipt.scopeIds = ['B-08']
  inconclusive.envelope.receipt.verdict = 'inconclusive'
  inconclusive.envelope.receipt.reasonCodes = ['evidence-inconclusive']
  inconclusive.envelope.receipt.measurements = null
  inconclusive.envelope.receipt.caseEvidence = { type: 'dat-continuous', sideFlipFlowEntered: false, capacityMatched: false, automaticTrackIdClaimed: false }
  syncControlSeals(inconclusive)
  syncCaseArtifact(inconclusive)
  assert.equal(validateV3EvidenceEnvelope(inconclusive.envelope, { root: inconclusive.root }).verdict, 'inconclusive')
})

test('B14非PASS允许如实缺少后续完成层且不得声明Completed', t => {
  const fixture = actualFixture(t)
  fixture.envelope.receipt.scopeIds = ['B-14']
  fixture.envelope.receipt.verdict = 'failed'
  fixture.envelope.receipt.reasonCodes = ['completion-layers-incomplete']
  fixture.envelope.receipt.measurements = null
  upsertJsonArtifact(fixture, 'source-eof', 'event-log', { event: 'source-eof', observedAt: '2026-08-29T05:59:55.000Z' })
  fixture.envelope.receipt.caseEvidence = {
    type: 'completion-layers',
    sourceEofEvidenceId: 'source-eof',
    backendDrainedEvidenceId: null,
    physicalCompletionEvidenceId: null,
    physicalStopMs: null,
    sourceEofAt: '2026-08-29T05:59:55.000Z',
    backendDrainedAt: null,
    physicalCompletedAt: null,
    completedAt: null,
    completedAfterAllLayers: false,
  }
  syncControlSeals(fixture)
  syncCaseArtifact(fixture)
  assert.equal(validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }).verdict, 'failed')
})

test('逐项结论必须来自当前收据窗口的case附件，不能只信任收据自报字段', t => {
  const fixture = actualFixture(t)
  const artifact = fixture.envelope.receipt.artifacts.find(value => value.role === 'case-evidence')
  fixture.envelope.receipt.artifacts = fixture.envelope.receipt.artifacts.filter(value => value !== artifact)
  assert.throws(() => validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }), /CASE_EVIDENCE/u)
})

test('非PASS标签必须由对应失败事实支撑，完整PASS事实不能只改verdict伪装失败', t => {
  const fixture = actualFixture(t)
  fixture.envelope.receipt.verdict = 'failed'
  fixture.envelope.receipt.reasonCodes = ['output-stop-failed']
  assert.throws(() => validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }), /(?:CASE_EVIDENCE|MEASUREMENT)/u)
})

test('技术附件必须位于当前receiptId独占窗口，禁止后续窗口复用共享文件名覆盖历史', t => {
  const fixture = actualFixture(t)
  const expectedPrefix = `reports/runtime/task-079-v3-final-acceptance/receipts/${fixture.envelope.receipt.receiptId}/`
  const artifact = fixture.envelope.receipt.artifacts[0]
  const oldPath = path.join(fixture.root, artifact.relativePath)
  artifact.relativePath = 'reports/runtime/task-079-v3-final-acceptance/receipts/shared-output-samples.json'
  writeFileSync(path.join(fixture.root, artifact.relativePath), readFileSync(oldPath))
  assert.equal(artifact.relativePath.startsWith(expectedPrefix), false)
  assert.throws(() => validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }), /ARTIFACT/u)
})

test('配置身份与授权PlanPreflight必须覆盖完整匿名环境并形成显式Hash链', t => {
  const fixture = actualFixture(t)
  assert.equal(Object.hasOwn(fixture.envelope.receipt.configuration, 'driverVersion'), true)
  delete fixture.envelope.receipt.configuration.driverVersion
  assert.throws(() => validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }), /CONFIGURATION/u)

  const brokenChain = actualFixture(t)
  const planArtifact = brokenChain.envelope.receipt.artifacts.find(artifact => artifact.role === 'plan-seal')
  const plan = JSON.parse(readFileSync(path.join(brokenChain.root, planArtifact.relativePath), 'utf8'))
  delete plan.grantSha256
  brokenChain.envelope.receipt.planSha256 = upsertJsonArtifact(brokenChain, 'plan-seal', 'plan-seal', plan)
  assert.throws(() => validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }), /(?:CONFIGURATION|RECEIPT_STATE)/u)
  assert.throws(() => validateV3EvidenceEnvelope(brokenChain.envelope, { root: brokenChain.root }), /RECEIPT_STATE/u)
})

test('environmentFingerprint必须来自当前窗口匿名环境seal而非任意自报Hash', t => {
  const fixture = actualFixture(t)
  assert.equal(fixture.envelope.receipt.artifacts.some(artifact => artifact.role === 'environment-seal'), true)
  fixture.envelope.receipt.environmentFingerprint = '1'.repeat(64)
  assert.throws(() => validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }), /RECEIPT_STATE/u)
})

test('授权PlanPreflight与完成层时间必须使用规范UTC ISO而非仅Date.parse可读', t => {
  const fixture = actualFixture(t)
  syncControlSeals(fixture, { grantedAt: '2026-08-29T05:50:00Z' })
  assert.throws(() => validateV3EvidenceEnvelope(fixture.envelope, { root: fixture.root }), /RECEIPT_STATE/u)
})

test('真实CLI候选身份必须拒绝tracked、index与非忽略untracked工作区漂移', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'task079-candidate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'project'), { recursive: true })
  writeFileSync(path.join(root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  writeFileSync(path.join(root, 'tracked.txt'), 'frozen\n')
  assert.equal(spawnSync('git', ['init', '--quiet', '--initial-branch=codex/task-079-v3-final-acceptance'], { cwd: root }).status, 0)
  assert.equal(spawnSync('git', ['add', '--', 'project/V3_ACCEPTANCE.json', 'tracked.txt'], { cwd: root }).status, 0)
  assert.equal(spawnSync('git', ['-c', 'user.name=Task079 Test', '-c', 'user.email=task079@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: root }).status, 0)
  const candidateCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const candidateTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const receipt = { candidateCommit, candidateTree, matrixSha256: '12f15170b25f578ba06d4def53060b58096fd57bf378d0e28f8ca2a7fe4ba944' }
  const controlledFiles = [
    { relativePath: 'project/V3_ACCEPTANCE.json', sha256: receipt.matrixSha256 },
    { relativePath: 'tracked.txt', sha256: sha256(Buffer.from('frozen\n')) },
  ]
  assert.doesNotThrow(() => validateRepositoryReceiptIdentity(root, receipt, controlledFiles))
  const falseManifest = structuredClone(controlledFiles)
  falseManifest[1].sha256 = '9'.repeat(64)
  assert.throws(() => validateRepositoryReceiptIdentity(root, receipt, falseManifest), /RECEIPT_STATE/u)
  writeFileSync(path.join(root, 'tracked.txt'), 'drifted\n')
  assert.throws(() => validateRepositoryReceiptIdentity(root, receipt, controlledFiles), /RECEIPT_STATE/u)
  assert.equal(spawnSync('git', ['checkout', '--', 'tracked.txt'], { cwd: root }).status, 0)
  writeFileSync(path.join(root, 'untracked.txt'), 'drifted\n')
  assert.throws(() => validateRepositoryReceiptIdentity(root, receipt, controlledFiles), /RECEIPT_STATE/u)
})

test('receipt seal首次独占创建、同内容幂等回读且拒绝同ID异内容', t => {
  const fixture = actualFixture(t)
  const receiptId = 'seal-window-01'
  const bytes = Buffer.from('{"receipt":"first"}\n')
  assert.doesNotThrow(() => sealReceipt(fixture.root, receiptId, bytes))
  assert.equal(readFileSync(path.join(fixture.root, `reports/runtime/task-079-v3-final-acceptance/receipts/${receiptId}.sealed.sha256`), 'utf8'), `${sha256(bytes)}\n`)
  assert.doesNotThrow(() => sealReceipt(fixture.root, receiptId, bytes))
  assert.throws(() => sealReceipt(fixture.root, receiptId, Buffer.from('{"receipt":"changed"}\n')), /RECEIPT_STATE/u)
})

test('CLI错误只公开稳定错误码', () => {
  assert.equal(normalizeEvidenceError(new Error('MEASUREMENT')), 'MEASUREMENT')
  assert.equal(normalizeEvidenceError(new SyntaxError('/Users/name/private.json')), 'INVALID_EVIDENCE')
  assert.equal(normalizeEvidenceError({ message: 'Bearer secret' }), 'INVALID_EVIDENCE')
})
