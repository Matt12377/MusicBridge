import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
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
    state: 'no-device-control-main-green-hardware-independent-r2-final-red-objects-successor-v3-full-green-awaiting-fresh-audit-external-not-run',
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
    hardwareEvidenceControl: {
      state: 'CONTRACT_V2_MAIN_GREEN_AFTER_INDEPENDENT_R2_FINAL_RED',
      previousImplementationCommit: 'a6d3c798452dc01b3cd49657c94397fefeb5bbcd',
      previousReportCommit: 'cf6d570fc87861010493d4e8d3c2237e9931d54f',
      contractV2ImplementationCommit: '7f373784de01b4be72f93c6c1ed117cac417deb2',
      contractV2ReportCommit: 'fde4f6cb42facc975f2ff9c457f0e7dcde516d9d',
      focusedVerification: { tests: 33, passed: 33, failed: 0 },
      independentReviewRound1: 'RED_STANDALONE_B15_CERTIFICATE',
      independentReviewRound2Final: 'RED_DEPENDENCY_ORDER_AND_SUBJECT_BINDING',
      mainAdjudication: [
        'dependency-receipts-must-precede-hardware-authorization',
        'hardware-subject-binding-aligns-window-attempt-physical-copy-side-and-event',
        'replica-manifest-frame-and-endpoint-correlation',
        'configuration-observation-recomputes-before-and-after-fingerprint',
        'observer-execution-binds-authority-plan-preflight-source-and-operations',
        'typed-scope-evidence-binds-mvp16-mvp18-u05-u10',
        'b15-identity-has-expiry-and-never-claims-full-gate-b-certification',
        'u10-roon-offline-rejects-track-change-dependency',
      ],
      independentPass: false,
      thirdReviewPerformed: false,
      hardwareRun: 'NOT_RUN',
      gateB: 'NOT_RUN',
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
      externalEvidenceProfiles: 'REAL_INPUT_REAL_LOGIC_REAL_ROON_PREPARED__HARDWARE_MAIN_GREEN_INDEPENDENT_R2_FINAL_RED',
      capacityAuthority: 'OBJECTS_SUCCESSOR_V3_FULL_GREEN_AWAITING_FRESH_AUDIT_NOT_ISSUED',
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
    task078SoftwareCheckpoints: {
      capacityWindowIssuer: {
        state: 'PREAUTH_REPLAY_AUDIT_ROOT_CAUSE_FIXED_FRESH_AUTHORITY_REQUIRED',
        previousImplementationCommit: 'a167eba95ae9bbb4205808153a5694216161ba76',
        previousReportCommit: 'cf6de5ad1b6e1be0a6836474424e39727b61337b',
        implementationCommits: [
          'ecf253ed7e2c5afc0d96e190f8aabf3fb65f0001',
          '089994d166788326fac104e371593f905b9b17b6',
          '6009b3cb8f830cfd69fbbb7640be0bf6b70b3272',
          '751146c5a36aa5ec15a45355d8f726b990a05575',
          '5879c92142b6089f11daac0b3eb4460a66ffbe1d',
        ],
        initialRed: 'generated-contract-dist-source-candidate-1of2-fail',
        focusedVerification: { tests: 19, passed: 19, failed: 0 },
        pythonCompile: 'PASS',
        independentReviewRound1: 'SPEC_RED_P1_3__QUALITY_RED_P1_1_P2_3',
        independentReviewRound2Final: 'SPEC_PASS__QUALITY_RED_P2_2',
        mainAdjudication: [
          'candidate-tracked-src-tsconfig-package-rebuilds-untracked-dist-exact-set-and-bytes',
          'issuer-candidate-build-and-toolchain-facts-enter-owned-manifest-window-hash-closure',
          'fixed-tsconfig-no-resolve-prevents-candidate-output-boundary-expansion',
          'verified-node-libnode-typescript-and-libs-run-from-private-toolchain-copy',
          'git-candidate-reads-have-fifteen-second-fail-closed-timeouts',
          'replay-audit-type-guards-unrelated-phase-and-generation-close-shapes',
          'carryover-terminal-and-coverage-nested-shapes-fail-with-stable-codes',
        ],
        candidatePreflight: { sourcePins: 243, derivedJs: 42, buildInputs: 44, exactBytes: true },
        preAuthorityIssueAttempt: {
          state: 'ISSUER_INTERNAL_BEFORE_EXCLUSIVE_CREATE',
          authorityDirectoryCreated: false,
          authorityFilesCreated: 0,
          windowCreated: false,
          seedCreated: false,
          generationStarted: false,
          replayed: false,
          rootCause: 'unrelated-phase-close-string-window-not-type-guarded',
        },
        writesAuthorityOnly: true,
        executesBenchmark: false,
        freshWindowAuthorized: false,
        deviceOpened: false,
        gateB: 'NOT_RUN',
      },
      capacityMeasureWindowIssuer: {
        state: 'ISSUED_ONCE_MEASURE_TIMEOUT_PARTIAL_PRESERVED_NONREPLAY',
        implementationCommit: 'fc23f559790b02aefe3292271364f3564c8e8fc8',
        initialRed: 'missing-production-script-7-of-7-fail',
        focusedVerification: { tests: 11, passed: 11, failed: 0 },
        pythonCompile: 'PASS',
        independentReviewRound1: 'SPEC_RED_P1_2__QUALITY_RED_P2_3',
        independentReviewRound2Final: 'SPEC_PASS__QUALITY_BOUNDED_PASS_P2_3',
        thirdReviewPerformed: false,
        rootClosure: { inherited: 59, addedExisting: 4, existing: 63, future: 1, authorized: 64 },
        plannedBytes: 4249378816,
        mainAdjudication: [
          'runtime-is-bounded-before-json-replay-audit-but-directory-enumeration-p2-remains',
          'derived-contract-build-reuses-generation-issuer-helper-with-existing-focused-coverage',
          'consumer-command-shape-statically-matches-frozen-supervisor-load-window-contract',
        ],
        writesAuthorityOnly: true,
        executesBenchmark: false,
        freshMeasureAuthorityIssued: true,
        measureRun: 'EXECUTION_TIMEOUT_PARTIAL_PRESERVED_NONREPLAY',
        measureWindow: {
          windowId: '1bcbe626-0ad2-401b-9140-7dbcf67cdce3',
          windowSha256: '5c646834b03e775b27959aaec4b0db25c4ffd84c064a835058f4171cbcfa45ea',
          closeSha256: 'c88e14612044ca2e2e5784d655da6e8c0db861d45c6b893a0c4a27bb8c28b8e5',
          supervisorSha256: '350833cad62544542f155df46e156d0f88a5dd80f3d25451923edb1132d1cdc5',
          state: 'FAILED_EXECUTION_TIMEOUT',
          elapsedMs: 879259.2549999972,
          receiptCount: 29,
          sampleCount: 273,
          retainedClone: 'sample-30',
          partialPreserved: true,
          groupEmpty: true,
          zombies: [],
          authorityStable: true,
          replay: 'PROHIBITED',
        },
        measureRecoveryV2: {
          state: 'SUCCESSOR_V3_FULL_GREEN_AWAITING_FRESH_AUDIT_NOT_ISSUED',
          baseCommit: '74367bc3f6d1a96a3fabef0ebcbaa3b22ba82ba6',
          implementationCommit: '1086dedb78d9ee4ed43238d82c3dc52823f4e4c1',
          derivedProofCommit: '3836db3f83b3d209b025f3a32445b57c3fc454fe',
          preflightFixCommit: 'bf2ae1449cb826dae21cecb8b0c466e3f505aa75',
          stopReentryFixCommit: '54b6353e9b12a2bdfdecf3c9bb452a53d34a00f5',
          measurePlan: { groupCloneCount: 3, fullHashCount: 3, stopRoundReceiptCount: 105, sampleCount: 1575 },
          focusedVerification: {
            capacity: { tests: 88, passed: 88, failed: 0 },
            supervisor: { tests: 16, passed: 16, failed: 0 },
            issuer: { tests: 23, passed: 23, failed: 0 },
          },
          fullVerify: 'PASS',
          staticGates: { controlPlane: 'PASS', boundaries: 'PASS', cycles: 'PASS_259_FILES' },
          independentReviewRound1: 'SPEC_FAIL_P0_2_P1_2',
          independentReviewRound2Final: 'SPEC_FAIL_P0_1',
          thirdReviewPerformed: false,
          mainAdjudication: 'R2_P0_FIXED_BY_REAL_ISSUER_SUPERVISOR_INTEROP_21_PASS',
          legacyCarryover: {
            format: 'legacy-107-clone-partial-v1', roots: 2, receiptCount: 29, sampleCount: 273,
            retainedClone: 'sample-30', contentSha256Verified: false, replay: 'PROHIBITED',
          },
          rootClosure: { existing: 65, future: 1, authorized: 66 },
          failedAttempts: {
            derivedProof: {
              windowDirName: 'r023-objects-limit-measure-window-02', label: 'r023-objects-limit-measure-02',
              state: 'GENERATION_PROOF_PRECREATE_FAILURE', authorityDirectoryCreated: false,
              windowWritten: false, replay: 'PROHIBITED',
            },
            identityPreflight: {
              windowId: '57f2d338-357f-43db-9cb4-e21dbfe619d5',
              windowDirName: 'r023-objects-limit-measure-window-03', label: 'r023-objects-limit-measure-03',
              state: 'TERMINAL_ISSUER_FAILURE', errorCode: 'AUTHORITY_PREFLIGHT',
              authorityFileCount: 5, windowWritten: false, replay: 'PROHIBITED',
            },
          },
          window04Terminal: {
            windowId: '02f6042a-b797-437d-a8da-45eafa2dd1f4',
            windowDirName: 'r023-objects-limit-measure-window-04',
            label: 'r023-objects-limit-measure-04',
            candidateCommit: 'cfca7be9b7adc42045c371fe3648f3db6e9c4c8d',
            windowSha256: 'afdd51b40e412265eac85a000132168df83bf4a5b42f65150651a5b6dca3006b',
            closeSha256: '1baf8d8ba6d02d524a2368f4d5ce4e4854dba5d866d4dfcfbaac46e0666704f1',
            ownedManifestSha256: 'b6cad8f1701a4b3815810046e11088544027932c00d9ca002c1d4f875add1d9e',
            sourceManifestSha256: 'de474098354a741fc7a4210c9586ad3904453f98c191c5ccb449d3a9bfc32a29',
            progressReceiptSha256: 'b7c3d6e7d25461ff5b3d1bf77c7b1be9ebb74a3060a90498f2307ed0804cc323',
            stopRoundReceiptSha256: '5e497472bb5ab6b69eb1e2a2e050442760ee7218b64c0192fb1b352222d7df92',
            samplesSha256: 'cbeec9cc8e9d087bf0c596259d6eead06ff2f673f105890be407090d20670664',
            stagesSha256: '0a6fb64a9c663237cbe7257856f56f4151709637307b066defcd0de94ee62a9e',
            state: 'FAILED_AUTHORITY_DRIFT', benchmarkFailureCode: 'COPY_UNAVAILABLE',
            elapsedMs: 62295.937791, exitCode: 1, sampleCount: 111, receiptCount: 1,
            stopRoundReceiptCount: 1, retainedClone: 'group-stop', partialPreserved: true,
            groupEmpty: true, zombies: [], admissionAuthorityStable: true,
            terminalAuthorityStable: false, replay: 'PROHIBITED', deviceOpened: false, gateB: 'NOT_RUN',
          },
          postWindow04Fix: {
            implementationCommit: '54b6353e9b12a2bdfdecf3c9bb452a53d34a00f5',
            productionCopyUnavailableProtection: 'UNCHANGED', stopPlans: 105, physicalCopies: 'DISTINCT',
            workspaceReceipt: 'DURABLE_TREE_BOUND', fixtureDatabaseContentSha256Verified: false,
            terminalSpace: 'PRESENT_FUTURE_REPLACES_REMAINING_PLANNED_BYTES',
            treeDigest: 'RECOMPUTED_AND_FIXTURE_ROOT_AUTHORITY_BOUND',
          },
          successorAuthorityV3: {
            state: 'FULL_GATES_GREEN_AWAITING_FRESH_AUDIT_NOT_ISSUED',
            historicalRootUnion: { window03: 65, window04: 65, intersection: 63, union: 67, terminalOutput: 1, historicalExisting: 68 },
            rootClosure: { historicalExisting: 68, currentAuthority: 2, existing: 70, future: 1, authorized: 71 },
            snapshotBytes: 1990471680,
            plannedBytes: 2258907136,
            planModel: 'serial-single-clone-plus-bounded-growth-v1',
            aggregateBudget: {
              scope: 'OUTPUT_TREE_LOGICAL_BYTES_HARD_CAP', auditFile: 'measure-aggregate-budget.jsonl',
              activeCloneMaximum: 1, terminalStop: 'STABLE_NO_FURTHER_EVIDENCE_WRITES',
            },
            terminalCarryovers: {
              window03: 'TERMINAL_ISSUER_FAILURE_PROHIBITED',
              window04: 'FAILED_AUTHORITY_DRIFT_PARTIAL_PROHIBITED',
            },
            publishPreflight: 'TERMINAL_AND_OWNED_REVALIDATED_AFTER_PENDING_WRITE',
            focusedVerification: {
              capacity: { tests: 89, passed: 89, failed: 0 },
              supervisor: { tests: 21, passed: 21, failed: 0 },
              issuer: { tests: 25, passed: 25, failed: 0 },
            },
            fullVerify: 'PASS', freshAuthorityIssued: false, deviceOpened: false, gateB: 'NOT_RUN',
          },
          preflightRootCause: {
            state: 'FIXED_VERIFIED',
            cause: 'TRACKED_SOURCE_MODULE_VALIDATED_INSTALLED_SUPERVISOR_PATH',
            resolution: 'INSTALLED_SUPERVISOR_MODULE_SELF_VALIDATES_WINDOW',
            stages: ['source-manifest', 'owned-manifest', 'facts', 'candidate-repository', 'window'],
            safeDiagnostics: true,
          },
          freshAudit: 'REQUIRED_ON_NEXT_COMMIT',
          freshAuthorityIssued: false,
          measureRun: 'WINDOW04_FAILED_NONREPLAY_NEXT_NOT_RUN',
          deviceOpened: false,
          gateB: 'NOT_RUN',
        },
        deviceOpened: false,
        gateB: 'NOT_RUN',
      },
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
    value => { value.v3Development.state = 'no-device-evidence-control-complete-external-not-run' },
    value => { delete value.v3Development.hardwareEvidenceControl },
    value => { value.v3Development.hardwareEvidenceControl.state = 'PASS_INDEPENDENT_REVIEW_COMPLETE' },
    value => { value.v3Development.hardwareEvidenceControl.contractV2ImplementationCommit = '0'.repeat(40) },
    value => { value.v3Development.hardwareEvidenceControl.contractV2ReportCommit = '0'.repeat(40) },
    value => { value.v3Development.hardwareEvidenceControl.focusedVerification.passed = 32 },
    value => { value.v3Development.hardwareEvidenceControl.independentReviewRound2Final = 'PASS' },
    value => { value.v3Development.hardwareEvidenceControl.independentPass = true },
    value => { value.v3Development.hardwareEvidenceControl.thirdReviewPerformed = true },
    value => { value.v3Development.hardwareEvidenceControl.hardwareRun = 'PASS' },
    value => { value.v3Development.hardwareEvidenceControl.gateB = 'PASS' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityWindowIssuer.focusedVerification.passed = 16 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityWindowIssuer.freshWindowAuthorized = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityWindowIssuer.gateB = 'PASS' },
    value => { delete value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.focusedVerification.passed = 10 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.freshMeasureAuthorityIssued = false },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRun = 'PASS' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureWindow.receiptCount = 30 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.focusedVerification.issuer.passed = 20 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.freshAuthorityIssued = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.legacyCarryover.contentSha256Verified = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.window04Terminal.windowId = randomUUID() },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.window04Terminal.closeSha256 = '0'.repeat(64) },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.window04Terminal.benchmarkFailureCode = 'PASS' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.window04Terminal.replay = 'ALLOWED' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.window04Terminal.deviceOpened = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.postWindow04Fix.implementationCommit = '0'.repeat(40) },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.successorAuthorityV3.rootClosure.authorized = 70 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.successorAuthorityV3.freshAuthorityIssued = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.gateB = 'PASS' },
    value => { value.v3Development.gates.readinessControl = 'PASS_14_FOCUSED_FULL_VERIFY_CONTROL_BOUNDARIES_CYCLES_REVIEW_P0_P1_ZERO' },
    value => { value.v3Development.gates.externalEvidenceProfiles = 'ALL_PREPARED' },
    value => { value.v3Development.gates.capacityAuthority = 'AUTHORIZED' },
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
