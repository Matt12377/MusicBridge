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
          correlationSha256: 'e'.repeat(64),
          eventCorrelationSha256: 'f'.repeat(64),
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
    ...(scopeId === 'B-09' ? { correlationSha256: receipt.caseEvidence.correlationSha256 } : {}),
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
    ...(scopeId === 'B-09' ? { correlationSha256: receipt.caseEvidence.correlationSha256 } : {}),
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
    ...(scopeId === 'B-09' ? { correlationSha256: receipt.caseEvidence.correlationSha256 } : {}),
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

function externalFixture(t, { receiptId, kind, scopeId, externalKind, environmentAliasKey, environmentAlias, allowedOperations, allowedDataClasses, caseEvidence, observation, controlledFilesExtra = [] }) {
  const fixture = actualFixture(t)
  const receipt = fixture.envelope.receipt
  receipt.receiptId = receiptId
  mkdirSync(path.join(fixture.root, `reports/runtime/task-079-v3-final-acceptance/receipts/${receiptId}`), { recursive: true })
  receipt.kind = kind
  receipt.scopeIds = [scopeId]
  receipt.configuration = null
  receipt.configurationFingerprintSha256 = null
  receipt.measurements = null
  receipt.artifacts = []
  const matrix = JSON.parse(readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json'), 'utf8'))
  const entry = matrix.entries.find(value => value.id === scopeId)
  const criterionSha256 = sha256(Buffer.from(JSON.stringify(entry.source)))
  upsertJsonArtifact(fixture, 'external-observation', 'external-observation', observation)
  receipt.caseEvidence = {
    ...caseEvidence,
    externalKind,
    correlationSha256: 'e'.repeat(64),
    criterionSha256,
    observationArtifactIds: ['external-observation'],
  }
  syncCaseArtifact(fixture)
  receipt.environmentFingerprint = upsertJsonArtifact(fixture, 'environment-seal', 'environment-seal', {
    runId: receipt.receiptId,
    osFamily: 'macos',
    architecture: 'arm64',
    externalKind,
    [environmentAliasKey]: environmentAlias,
  })
  const controlledFiles = [
    { relativePath: 'project/V3_ACCEPTANCE.json', sha256: receipt.matrixSha256 },
    { relativePath: 'scripts/ci/verify-v3-owner-evidence.mjs', sha256: '8'.repeat(64) },
    ...controlledFilesExtra,
  ]
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
    externalKind,
    correlationSha256: receipt.caseEvidence.correlationSha256,
    criterionSha256,
    allowedOperations,
    allowedDataClasses,
    grantedAt: '2026-08-29T05:50:00.000Z',
    expiresAt: '2026-08-29T06:10:00.000Z',
  })
  receipt.planSha256 = upsertJsonArtifact(fixture, 'plan-seal', 'plan-seal', {
    scopeId,
    runId: receipt.receiptId,
    candidateCommit: receipt.candidateCommit,
    candidateTree: receipt.candidateTree,
    candidateManifestSha256: receipt.candidateManifestSha256,
    externalKind,
    correlationSha256: receipt.caseEvidence.correlationSha256,
    criterionSha256,
    grantSha256: receipt.authorizationSha256,
    frozenAt: '2026-08-29T05:55:00.000Z',
  })
  receipt.preflightSha256 = upsertJsonArtifact(fixture, 'preflight-seal', 'preflight-seal', {
    scopeId,
    runId: receipt.receiptId,
    candidateCommit: receipt.candidateCommit,
    candidateTree: receipt.candidateTree,
    candidateManifestSha256: receipt.candidateManifestSha256,
    externalKind,
    correlationSha256: receipt.caseEvidence.correlationSha256,
    criterionSha256,
    grantSha256: receipt.authorizationSha256,
    planSha256: receipt.planSha256,
    observedAt: '2026-08-29T05:58:00.000Z',
    passed: true,
  })
  return fixture
}

function realInputFixture(t, scopeId = 'MVP-05') {
  return externalFixture(t, {
    receiptId: 'real-input-window-01',
    kind: 'real-input-observation',
    scopeId,
    externalKind: 'real-input',
    environmentAliasKey: 'dataSourceAlias',
    environmentAlias: 'source-root-01',
    allowedOperations: ['read-source', 'hash-source'],
    allowedDataClasses: ['anonymous-real-input'],
    observation: { sourceAliases: ['source-01'], sourceSha256s: ['d'.repeat(64)] },
    caseEvidence: {
      type: 'real-input',
      sourceCount: 1,
      authorizedRead: true,
      contentHashesVerified: true,
      originalBytesUnchanged: true,
      criterionSatisfied: true,
    },
  })
}

const REAL_LOGIC_OUTCOMES = {
  'MVP-08': 'workspace-generated',
  'MVP-09': 'exports-reimported',
  'MVP-10': 'prepared-master-frozen',
  'D-05': 'timeline-rebuilt',
  'D-06': 'accepted-variance',
  'D-07': 'requires-new-layout',
  'D-08': 'freeze-blocked',
}

function realLogicFixture(t, scopeId = 'D-05') {
  return externalFixture(t, {
    receiptId: 'real-logic-window-01',
    kind: 'real-logic-observation',
    scopeId,
    externalKind: 'real-logic',
    environmentAliasKey: 'logicWorkspaceAlias',
    environmentAlias: 'logic-workspace-01',
    allowedOperations: ['open-workspace', 'read-export', 'hash-export', 'inspect-marker', 'inspect-timeline'],
    allowedDataClasses: ['anonymous-real-logic'],
    observation: {
      workspaceAlias: 'logic-workspace-01',
      projectSha256: 'b'.repeat(64),
      exports: [{ exportAlias: 'export-a-01', sha256: 'c'.repeat(64), markerCount: 3, timelineSha256: 'd'.repeat(64) }],
    },
    caseEvidence: {
      type: 'real-logic',
      workspaceOpened: true,
      exportCount: 1,
      exportHashesVerified: true,
      markerEvidenceVerified: true,
      timelineEvidenceVerified: true,
      observedOutcome: REAL_LOGIC_OUTCOMES[scopeId],
      criterionSatisfied: true,
    },
  })
}

const REAL_ROON_CASES = {
  'MVP-02': { outcome: 'v2-regression-observed', connectionState: 'connected', operations: ['browse-library', 'observe-playback'], facts: { requiredPageCount: 8, openedPageCount: 8, playbackStarted: true, playbackContinued: true, playbackStateBeforeSha256: '1'.repeat(64), playbackStateAfterSha256: '1'.repeat(64) } },
  'MVP-14': { outcome: 'inventory-recommendation-observed', connectionState: 'connected', operations: ['browse-library', 'select-track', 'read-inventory-recommendation'], facts: { selectionSha256: '1'.repeat(64), recommendationSelectionSha256: '1'.repeat(64), reasonShown: true, availableCountShown: true, sideFitShown: true, revalidatedBeforeFormalRecording: true } },
  'MVP-22': { outcome: 'relationship-lineage-separated', connectionState: 'connected', operations: ['browse-library', 'inspect-relationship', 'inspect-recording-lineage'], facts: { physicalReleaseAlias: 'physical-release-01', digitalReleaseAlias: 'digital-release-01', releaseRelationType: 'release-link', recordedLineageType: 'recorded-track-lineage', recordedTrackCount: 3, tracedTrackCount: 3 } },
  'A-02': { outcome: 'roon-file-mapping-confirmed', connectionState: 'connected', operations: ['browse-library', 'inspect-reference', 'confirm-file-mapping'], facts: { roonEntryAlias: 'roon-entry-01', sourceAlias: 'source-01', sourceSha256: 'd'.repeat(64), mappingSha256: '2'.repeat(64), mappingConfirmedAt: '2026-08-29T05:59:50.000Z', mappingConfirmed: true } },
  'B-09': { outcome: 'external-takeover-interrupted', connectionState: 'connected', operations: ['observe-zone', 'observe-queue', 'observe-attempt-state', 'inject-external-roon-change'], facts: { actionKind: 'roon-track-change', beforeStateSha256: '1'.repeat(64), afterStateSha256: '2'.repeat(64), eventCorrelationSha256: 'f'.repeat(64), changeObserved: true, attemptState: 'interrupted', exclusiveControlClaimed: false } },
  'U-01': { outcome: 'physical-roon-relationship-observed', connectionState: 'connected', operations: ['browse-library', 'inspect-relationship'], facts: { physicalItemTypes: ['cd', 'original-cassette'], singleLibraryVisible: true, relationClassesObserved: ['exact', 'probable', 'related', 'unmatched'], unmatchedVisible: true } },
  'U-06': { outcome: 'multi-release-lineage-preserved', connectionState: 'connected', operations: ['browse-library', 'select-track', 'inspect-recording-lineage'], facts: { albumCount: 2, trackCount: 4, tracedTrackCount: 4, recordingType: 'self-recorded', commercialExactCreated: false, originalInventoryIncrement: 0 } },
  'U-07': { outcome: 'preliminary-flow-bounded', connectionState: 'connected', operations: ['browse-library', 'select-track', 'read-inventory-recommendation', 'inspect-recording-gate'], facts: { selectionObserved: true, sourceVerified: false, logicCompleted: false, recommendationLabel: 'preliminary-estimate', reasonShown: true, playbackTakeoverCount: 0, reservationCount: 0, formalStartCount: 0 } },
  'U-10': { outcome: 'offline-history-preserved', connectionState: 'offline-observed', operations: ['observe-roon-offline', 'inspect-physical-history', 'inspect-attempt-state'], facts: { roonAvailableBefore: true, roonAvailableAfter: false, attemptState: 'interrupted', completedClaimed: false, blankInventoryIncrement: 0, physicalRecordPreserved: true, historyPreserved: true, manualBackfillMarkerPreserved: true } },
}

function realRoonFixture(t, scopeId = 'U-01') {
  const contract = REAL_ROON_CASES[scopeId]
  return externalFixture(t, {
    receiptId: 'real-roon-window-01',
    kind: 'real-roon-observation',
    scopeId,
    externalKind: 'real-roon',
    environmentAliasKey: 'roonEnvironmentAlias',
    environmentAlias: 'roon-environment-01',
    allowedOperations: contract.operations,
    allowedDataClasses: ['anonymous-real-roon'],
    controlledFilesExtra: [{ relativePath: 'packages/bridge-core/src/roon/adapter.ts', sha256: '9'.repeat(64) }],
    observation: {
      roonEnvironmentAlias: 'roon-environment-01',
      connectionState: contract.connectionState,
      observerRelativePath: 'packages/bridge-core/src/roon/adapter.ts',
      observerSha256: '9'.repeat(64),
      correlationSha256: 'e'.repeat(64),
      observedAt: '2026-08-29T05:59:55.000Z',
      facts: contract.facts,
      factsSha256: sha256(Buffer.from(JSON.stringify(contract.facts))),
    },
    caseEvidence: {
      type: 'real-roon',
      connectionState: contract.connectionState,
      observedOutcome: contract.outcome,
      criterionSatisfied: true,
    },
  })
}

function installTechnicalReceipt(sourceFixture, targetRoot) {
  const receipt = sourceFixture.envelope.receipt
  for (const artifact of receipt.artifacts) {
    const targetPath = path.join(targetRoot, artifact.relativePath)
    mkdirSync(path.dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, readFileSync(path.join(sourceFixture.root, artifact.relativePath)))
  }
  const bytes = Buffer.from(JSON.stringify(sourceFixture.envelope))
  const relativePath = `reports/runtime/task-079-v3-final-acceptance/receipts/${receipt.receiptId}.json`
  writeFileSync(path.join(targetRoot, relativePath), bytes)
  writeReceiptSeal(targetRoot, receipt.receiptId, bytes)
  return { receiptId: receipt.receiptId, receiptSha256: sha256(bytes) }
}

function ownerEnvelopeFrom(fixture, receiptId, references) {
  const envelope = structuredClone(fixture.envelope)
  envelope.receipt.receiptId = receiptId
  envelope.receipt.kind = 'owner-observed'
  envelope.receipt.configuration = null
  envelope.receipt.configurationFingerprintSha256 = null
  envelope.receipt.measurements = null
  envelope.receipt.artifacts = []
  envelope.receipt.caseEvidence = null
  envelope.receipt.verdict = null
  envelope.receipt.ownerDecision = 'accepted'
  envelope.receipt.referencedTechnicalReceipts = references
  return envelope
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
  mkdirSync(path.join(owner.root, 'project'), { recursive: true })
  writeFileSync(path.join(owner.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
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

  mkdirSync(path.join(owner.root, 'project'), { recursive: true })
  writeFileSync(path.join(owner.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  const ownerOnly = structuredClone(ownerEnvelope)
  ownerOnly.receipt.scopeIds = ['MVP-01']
  ownerOnly.receipt.ownerDecision = 'accepted'
  ownerOnly.receipt.referencedTechnicalReceipts = []
  assert.equal(validateV3EvidenceEnvelope(ownerOnly, { root: owner.root }).verdict, 'accepted')

  const realRoonRequired = structuredClone(ownerOnly)
  realRoonRequired.receipt.scopeIds = ['U-01']
  assert.throws(() => validateV3EvidenceEnvelope(realRoonRequired, { root: owner.root }), /OWNER_BOUNDARY/u)

  const input = realInputFixture(t)
  mkdirSync(path.join(input.root, 'project'), { recursive: true })
  writeFileSync(path.join(input.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  assert.equal(validateV3EvidenceEnvelope(input.envelope, { root: input.root }).verdict, 'passed')
  const detachedCase = structuredClone(input.envelope)
  detachedCase.receipt.caseEvidence.sourceCount = 2
  assert.throws(() => validateV3EvidenceEnvelope(detachedCase, { root: input.root }), /CASE_EVIDENCE/u)
  const extraInput = realInputFixture(t)
  mkdirSync(path.join(extraInput.root, 'project'), { recursive: true })
  writeFileSync(path.join(extraInput.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  upsertJsonArtifact(extraInput, 'extra-event', 'event-log', { event: 'unscoped-extra' })
  assert.throws(() => validateV3EvidenceEnvelope(extraInput.envelope, { root: extraInput.root }), /ARTIFACT/u)
  const inputBytes = Buffer.from(JSON.stringify(input.envelope))
  const inputPath = `reports/runtime/task-079-v3-final-acceptance/receipts/${input.envelope.receipt.receiptId}.json`
  writeFileSync(path.join(input.root, inputPath), inputBytes)
  writeReceiptSeal(input.root, input.envelope.receipt.receiptId, inputBytes)
  const inputOwner = structuredClone(input.envelope)
  inputOwner.receipt.receiptId = 'owner-input-window-01'
  inputOwner.receipt.kind = 'owner-observed'
  inputOwner.receipt.artifacts = []
  inputOwner.receipt.caseEvidence = null
  inputOwner.receipt.verdict = null
  inputOwner.receipt.ownerDecision = 'accepted'
  inputOwner.receipt.referencedTechnicalReceipts = [{ receiptId: input.envelope.receipt.receiptId, receiptSha256: sha256(inputBytes) }]
  assert.equal(validateV3EvidenceEnvelope(inputOwner, { root: input.root }).verdict, 'accepted')

  const multiExternal = realInputFixture(t, 'A-02')
  mkdirSync(path.join(multiExternal.root, 'project'), { recursive: true })
  writeFileSync(path.join(multiExternal.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  assert.equal(validateV3EvidenceEnvelope(multiExternal.envelope, { root: multiExternal.root }).verdict, 'passed')
  const multiBytes = Buffer.from(JSON.stringify(multiExternal.envelope))
  const multiPath = `reports/runtime/task-079-v3-final-acceptance/receipts/${multiExternal.envelope.receipt.receiptId}.json`
  writeFileSync(path.join(multiExternal.root, multiPath), multiBytes)
  writeReceiptSeal(multiExternal.root, multiExternal.envelope.receipt.receiptId, multiBytes)
  const incompleteOwner = structuredClone(multiExternal.envelope)
  incompleteOwner.receipt.receiptId = 'owner-a02-window-01'
  incompleteOwner.receipt.kind = 'owner-observed'
  incompleteOwner.receipt.artifacts = []
  incompleteOwner.receipt.caseEvidence = null
  incompleteOwner.receipt.verdict = null
  incompleteOwner.receipt.ownerDecision = 'accepted'
  incompleteOwner.receipt.referencedTechnicalReceipts = [{ receiptId: multiExternal.envelope.receipt.receiptId, receiptSha256: sha256(multiBytes) }]
  assert.throws(() => validateV3EvidenceEnvelope(incompleteOwner, { root: multiExternal.root }), /OWNER_BOUNDARY/u)

  let logic
  for (const scopeId of Object.keys(REAL_LOGIC_OUTCOMES)) {
    const candidate = realLogicFixture(t, scopeId)
    mkdirSync(path.join(candidate.root, 'project'), { recursive: true })
    writeFileSync(path.join(candidate.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
    assert.equal(validateV3EvidenceEnvelope(candidate.envelope, { root: candidate.root }).verdict, 'passed', scopeId)
    if (scopeId === 'D-05') logic = candidate
  }
  const logicBytes = Buffer.from(JSON.stringify(logic.envelope))
  const logicPath = `reports/runtime/task-079-v3-final-acceptance/receipts/${logic.envelope.receipt.receiptId}.json`
  writeFileSync(path.join(logic.root, logicPath), logicBytes)
  writeReceiptSeal(logic.root, logic.envelope.receipt.receiptId, logicBytes)
  const logicOwner = structuredClone(logic.envelope)
  logicOwner.receipt.receiptId = 'owner-logic-window-01'
  logicOwner.receipt.kind = 'owner-observed'
  logicOwner.receipt.artifacts = []
  logicOwner.receipt.caseEvidence = null
  logicOwner.receipt.verdict = null
  logicOwner.receipt.ownerDecision = 'accepted'
  logicOwner.receipt.referencedTechnicalReceipts = [{ receiptId: logic.envelope.receipt.receiptId, receiptSha256: sha256(logicBytes) }]
  assert.equal(validateV3EvidenceEnvelope(logicOwner, { root: logic.root }).verdict, 'accepted')

  const wrongLogicOutcome = realLogicFixture(t, 'D-07')
  mkdirSync(path.join(wrongLogicOutcome.root, 'project'), { recursive: true })
  writeFileSync(path.join(wrongLogicOutcome.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  wrongLogicOutcome.envelope.receipt.caseEvidence.observedOutcome = 'accepted-variance'
  syncCaseArtifact(wrongLogicOutcome)
  assert.throws(() => validateV3EvidenceEnvelope(wrongLogicOutcome.envelope, { root: wrongLogicOutcome.root }), /CASE_EVIDENCE/u)

  const mismatchedWorkspace = realLogicFixture(t)
  mkdirSync(path.join(mismatchedWorkspace.root, 'project'), { recursive: true })
  writeFileSync(path.join(mismatchedWorkspace.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  upsertJsonArtifact(mismatchedWorkspace, 'external-observation', 'external-observation', {
    workspaceAlias: 'logic-workspace-02',
    projectSha256: 'b'.repeat(64),
    exports: [{ exportAlias: 'export-a-01', sha256: 'c'.repeat(64), markerCount: 3, timelineSha256: 'd'.repeat(64) }],
  })
  assert.throws(() => validateV3EvidenceEnvelope(mismatchedWorkspace.envelope, { root: mismatchedWorkspace.root }), /CASE_EVIDENCE/u)

  const roonFixtures = new Map()
  for (const scopeId of Object.keys(REAL_ROON_CASES)) {
    const candidate = realRoonFixture(t, scopeId)
    mkdirSync(path.join(candidate.root, 'project'), { recursive: true })
    writeFileSync(path.join(candidate.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
    assert.equal(validateV3EvidenceEnvelope(candidate.envelope, { root: candidate.root }).verdict, 'passed', scopeId)
    roonFixtures.set(scopeId, candidate)
  }
  const wrongRoonEvent = realRoonFixture(t, 'U-07')
  mkdirSync(path.join(wrongRoonEvent.root, 'project'), { recursive: true })
  writeFileSync(path.join(wrongRoonEvent.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  const wrongObservation = {
    roonEnvironmentAlias: 'roon-environment-01',
    connectionState: 'connected',
    observerRelativePath: 'packages/bridge-core/src/roon/adapter.ts',
    observerSha256: '9'.repeat(64),
    correlationSha256: 'e'.repeat(64),
    observedAt: '2026-08-29T05:59:55.000Z',
    facts: REAL_ROON_CASES['MVP-02'].facts,
    factsSha256: sha256(Buffer.from(JSON.stringify(REAL_ROON_CASES['MVP-02'].facts))),
  }
  upsertJsonArtifact(wrongRoonEvent, 'external-observation', 'external-observation', wrongObservation)
  assert.throws(() => validateV3EvidenceEnvelope(wrongRoonEvent.envelope, { root: wrongRoonEvent.root }), /CASE_EVIDENCE/u)

  const privateRoonField = realRoonFixture(t, 'U-01')
  mkdirSync(path.join(privateRoonField.root, 'project'), { recursive: true })
  writeFileSync(path.join(privateRoonField.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  const privateArtifact = privateRoonField.envelope.receipt.artifacts.find(artifact => artifact.role === 'external-observation')
  const privateObservation = JSON.parse(readFileSync(path.join(privateRoonField.root, privateArtifact.relativePath), 'utf8'))
  privateObservation.zoneName = 'living-room'
  upsertJsonArtifact(privateRoonField, 'external-observation', 'external-observation', privateObservation)
  assert.throws(() => validateV3EvidenceEnvelope(privateRoonField.envelope, { root: privateRoonField.root }), /CASE_EVIDENCE/u)

  const failedRoon = realRoonFixture(t, 'U-07')
  mkdirSync(path.join(failedRoon.root, 'project'), { recursive: true })
  writeFileSync(path.join(failedRoon.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  const failedArtifact = failedRoon.envelope.receipt.artifacts.find(artifact => artifact.role === 'external-observation')
  const failedObservation = JSON.parse(readFileSync(path.join(failedRoon.root, failedArtifact.relativePath), 'utf8'))
  failedObservation.facts.formalStartCount = 1
  failedObservation.factsSha256 = sha256(Buffer.from(JSON.stringify(failedObservation.facts)))
  upsertJsonArtifact(failedRoon, 'external-observation', 'external-observation', failedObservation)
  failedRoon.envelope.receipt.caseEvidence.observedOutcome = null
  failedRoon.envelope.receipt.caseEvidence.criterionSatisfied = false
  failedRoon.envelope.receipt.verdict = 'failed'
  failedRoon.envelope.receipt.reasonCodes = ['event-mismatch']
  syncCaseArtifact(failedRoon)
  assert.equal(validateV3EvidenceEnvelope(failedRoon.envelope, { root: failedRoon.root }).verdict, 'failed')
  failedRoon.envelope.receipt.verdict = 'passed'
  failedRoon.envelope.receipt.reasonCodes = []
  assert.throws(() => validateV3EvidenceEnvelope(failedRoon.envelope, { root: failedRoon.root }), /CASE_EVIDENCE/u)

  const roonOnlyA02 = roonFixtures.get('A-02')
  const roonOnlyReference = installTechnicalReceipt(roonOnlyA02, roonOnlyA02.root)
  const roonOnlyOwner = structuredClone(roonOnlyA02.envelope)
  roonOnlyOwner.receipt.receiptId = 'owner-roon-a02-window-01'
  roonOnlyOwner.receipt.kind = 'owner-observed'
  roonOnlyOwner.receipt.artifacts = []
  roonOnlyOwner.receipt.caseEvidence = null
  roonOnlyOwner.receipt.verdict = null
  roonOnlyOwner.receipt.ownerDecision = 'accepted'
  roonOnlyOwner.receipt.referencedTechnicalReceipts = [roonOnlyReference]
  assert.throws(() => validateV3EvidenceEnvelope(roonOnlyOwner, { root: roonOnlyA02.root }), /OWNER_BOUNDARY/u)

  const roonOnlyU10 = roonFixtures.get('U-10')
  const roonOnlyU10Reference = installTechnicalReceipt(roonOnlyU10, roonOnlyU10.root)
  const roonOnlyU10Owner = ownerEnvelopeFrom(roonOnlyU10, 'owner-roon-u10-window-01', [roonOnlyU10Reference])
  assert.throws(() => validateV3EvidenceEnvelope(roonOnlyU10Owner, { root: roonOnlyU10.root }), /OWNER_BOUNDARY/u)

  const outputB09 = actualFixture(t)
  mkdirSync(path.join(outputB09.root, 'project'), { recursive: true })
  writeFileSync(path.join(outputB09.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  const outputReference = installTechnicalReceipt(outputB09, outputB09.root)
  const ownerB09 = structuredClone(outputB09.envelope)
  ownerB09.receipt.receiptId = 'owner-b09-window-01'
  ownerB09.receipt.kind = 'owner-observed'
  ownerB09.receipt.configuration = null
  ownerB09.receipt.configurationFingerprintSha256 = null
  ownerB09.receipt.measurements = null
  ownerB09.receipt.artifacts = []
  ownerB09.receipt.caseEvidence = null
  ownerB09.receipt.verdict = null
  ownerB09.receipt.ownerDecision = 'accepted'
  ownerB09.receipt.referencedTechnicalReceipts = [outputReference]
  assert.throws(() => validateV3EvidenceEnvelope(ownerB09, { root: outputB09.root }), /OWNER_BOUNDARY/u)
  const roonB09Reference = installTechnicalReceipt(roonFixtures.get('B-09'), outputB09.root)
  ownerB09.receipt.referencedTechnicalReceipts.push(roonB09Reference)
  assert.equal(validateV3EvidenceEnvelope(ownerB09, { root: outputB09.root }).verdict, 'accepted')

  const roonA02Reference = installTechnicalReceipt(roonFixtures.get('A-02'), multiExternal.root)
  incompleteOwner.receipt.referencedTechnicalReceipts.push(roonA02Reference)
  assert.equal(validateV3EvidenceEnvelope(incompleteOwner, { root: multiExternal.root }).verdict, 'accepted')

  const mismatchedB09Output = actualFixture(t)
  mkdirSync(path.join(mismatchedB09Output.root, 'project'), { recursive: true })
  writeFileSync(path.join(mismatchedB09Output.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  const mismatchedB09Roon = realRoonFixture(t, 'B-09')
  mkdirSync(path.join(mismatchedB09Roon.root, 'project'), { recursive: true })
  writeFileSync(path.join(mismatchedB09Roon.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  const b09ObservationArtifact = mismatchedB09Roon.envelope.receipt.artifacts.find(artifact => artifact.role === 'external-observation')
  const b09Observation = JSON.parse(readFileSync(path.join(mismatchedB09Roon.root, b09ObservationArtifact.relativePath), 'utf8'))
  b09Observation.facts.eventCorrelationSha256 = 'a'.repeat(64)
  b09Observation.factsSha256 = sha256(Buffer.from(JSON.stringify(b09Observation.facts)))
  upsertJsonArtifact(mismatchedB09Roon, 'external-observation', 'external-observation', b09Observation)
  assert.equal(validateV3EvidenceEnvelope(mismatchedB09Roon.envelope, { root: mismatchedB09Roon.root }).verdict, 'passed')
  const mismatchedB09References = [
    installTechnicalReceipt(mismatchedB09Output, mismatchedB09Output.root),
    installTechnicalReceipt(mismatchedB09Roon, mismatchedB09Output.root),
  ]
  const mismatchedB09Owner = ownerEnvelopeFrom(mismatchedB09Output, 'owner-b09-mismatch-window-01', mismatchedB09References)
  assert.throws(() => validateV3EvidenceEnvelope(mismatchedB09Owner, { root: mismatchedB09Output.root }), /OWNER_BOUNDARY/u)

  const mismatchedA02Input = realInputFixture(t, 'A-02')
  mkdirSync(path.join(mismatchedA02Input.root, 'project'), { recursive: true })
  writeFileSync(path.join(mismatchedA02Input.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  const mismatchedA02Roon = realRoonFixture(t, 'A-02')
  mkdirSync(path.join(mismatchedA02Roon.root, 'project'), { recursive: true })
  writeFileSync(path.join(mismatchedA02Roon.root, 'project/V3_ACCEPTANCE.json'), readFileSync(path.join(projectRoot, 'project/V3_ACCEPTANCE.json')))
  const a02ObservationArtifact = mismatchedA02Roon.envelope.receipt.artifacts.find(artifact => artifact.role === 'external-observation')
  const a02Observation = JSON.parse(readFileSync(path.join(mismatchedA02Roon.root, a02ObservationArtifact.relativePath), 'utf8'))
  a02Observation.facts.sourceSha256 = 'c'.repeat(64)
  a02Observation.factsSha256 = sha256(Buffer.from(JSON.stringify(a02Observation.facts)))
  upsertJsonArtifact(mismatchedA02Roon, 'external-observation', 'external-observation', a02Observation)
  assert.equal(validateV3EvidenceEnvelope(mismatchedA02Roon.envelope, { root: mismatchedA02Roon.root }).verdict, 'passed')
  const mismatchedA02References = [
    installTechnicalReceipt(mismatchedA02Input, mismatchedA02Input.root),
    installTechnicalReceipt(mismatchedA02Roon, mismatchedA02Input.root),
  ]
  const mismatchedA02Owner = ownerEnvelopeFrom(mismatchedA02Input, 'owner-a02-mismatch-window-01', mismatchedA02References)
  assert.throws(() => validateV3EvidenceEnvelope(mismatchedA02Owner, { root: mismatchedA02Input.root }), /OWNER_BOUNDARY/u)
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
    if (gateId !== 'B-09') {
      delete fixture.envelope.receipt.caseEvidence.correlationSha256
      delete fixture.envelope.receipt.caseEvidence.eventCorrelationSha256
    }
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
