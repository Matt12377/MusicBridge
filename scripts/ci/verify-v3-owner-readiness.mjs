import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 本入口只校验 TASK-079 无设备就绪清单。成功表示控制文件可信，不表示真实 Gate 或 Owner 验收通过。
const TASK = 'TASK-079'
const BASE_COMMIT = 'fac7363b4a6481591e207dda7cca77f0ae8d3cd4'
const MATRIX_BASE_COMMIT = 'c54cf8b71b493482d8ad061d38123c444d718ad0'
const MATRIX_PATH = 'project/V3_ACCEPTANCE.json'
const MATRIX_SHA256 = '12f15170b25f578ba06d4def53060b58096fd57bf378d0e28f8ca2a7fe4ba944'
const EXTERNAL_KINDS = ['real-input', 'real-logic', 'real-roon', 'hardware', 'owner']
const UNMAPPED_PENDING = ['B-13', 'B-15']
const READINESS_CONTROL = 'PASS_15_FOCUSED_FULL_VERIFY_CONTROL_BOUNDARIES_CYCLES_REVIEW_P0_P1_ZERO'
const DEVELOPMENT_STATE = 'no-device-control-main-green-hardware-independent-r2-final-red-objects-measure-window06-software-pass-queued-stop-window06-process-exit-terminal-window07-nonreplay-no-samples-canonical-lineage-architecture-green-new-window-not-authorized-joint-formal-not-run-external-pending'
const EXTERNAL_EVIDENCE_PROFILES = 'REAL_INPUT_REAL_LOGIC_REAL_ROON_PREPARED__HARDWARE_MAIN_GREEN_INDEPENDENT_R2_FINAL_RED'
const CAPACITY_AUTHORITY = 'OBJECTS_MEASURE_WINDOW06_SOFTWARE_PASS_QUEUED_STOP_WINDOW06_PROCESS_EXIT_TERMINAL_WINDOW07_NONREPLAY_NO_CHILD_NO_SAMPLES_CANONICAL_LINEAGE_ARCHITECTURE_GREEN_NEW_WINDOW_NOT_AUTHORIZED_JOINT_FORMAL_NOT_RUN'
const EVIDENCE_INFRASTRUCTURE = {
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
}
const HARDWARE_EVIDENCE_CONTROL = {
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
}
const CAPACITY_WINDOW_ISSUER = {
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
}
const CAPACITY_MEASURE_WINDOW_ISSUER = {
  state: 'WINDOW01_TIMEOUT_WINDOW04_FAILED_WINDOW06_SOFTWARE_PASS_NONREPLAY',
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
    state: 'WINDOW06_MEASURE_SOFTWARE_PASS_QUEUED_STOP_JOINT_PENDING',
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
      state: 'FRESH_AUDIT_PASS_WINDOW06_ISSUED_ONCE_CONSUMED_ONCE_MEASURE_PASS',
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
      fullVerify: 'PASS',
      freshAudit: { state: 'PASS', candidateCommit: 'a457414fffd141390ec2ff4536452a0f654b1370' },
      window05PrecreateRejection: {
        sequence: '05', state: 'CONSUMER_IDENTITY_PRECONDITION_REJECTED', pathCreated: false,
        windowIdAllocated: false, authorityCreated: false, replay: 'PROHIBITED',
      },
      window06Measure: {
        windowId: 'afc81a99-d15d-4179-8326-5774a5c40b62',
        candidateCommit: 'a457414fffd141390ec2ff4536452a0f654b1370',
        windowSha256: 'cfac8e19336a181de00c68d458d046065cd821a0dca48cc4fc78af0e15c15227',
        closeSha256: '1c93f6c6ec1a0b58619f87127d3e2c7d11a1cfcce1c155b3576a84eda2af84b7',
        supervisorSha256: '18ef840fe99b861ca8881c7c7be09b70c13431df02d88ddf282e29f2169cdc92',
        state: 'PASSED', exitCode: 0, elapsedMs: 320039.741875, sampleCount: 1575,
        groupReceiptCount: 3, stopRoundReceiptCount: 105, stageCount: 18,
        aggregateBudget: {
          rows: 2383, snapshotBytes: 1990471680, limitBytes: 2258907136,
          plannedBytes: 2258907136, outputLogicalBytes: 5544090,
        },
        thresholdPassed: true, groupEmpty: true, zombies: [], issuedOnce: true,
        consumedOnce: true, replay: 'PROHIBITED', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
      },
      freshAuthorityIssued: true, deviceOpened: false, gateB: 'NOT_RUN',
    },
    preflightRootCause: {
      state: 'FIXED_VERIFIED',
      cause: 'TRACKED_SOURCE_MODULE_VALIDATED_INSTALLED_SUPERVISOR_PATH',
      resolution: 'INSTALLED_SUPERVISOR_MODULE_SELF_VALIDATES_WINDOW',
      stages: ['source-manifest', 'owned-manifest', 'facts', 'candidate-repository', 'window'],
      safeDiagnostics: true,
    },
    freshAudit: 'PASS_BOUND_TO_A457414_WINDOW06',
    freshAuthorityIssued: true,
    measureRun: 'WINDOW06_SOFTWARE_PASS_QUEUED_STOP_JOINT_NOT_RUN',
    deviceOpened: false,
    gateB: 'NOT_RUN',
  },
  deviceOpened: false,
  gateB: 'NOT_RUN',
}
const CAPACITY_QUEUED_STOP_CONTROL_PLANE = {
  state: 'WINDOW06_PROCESS_EXIT_TERMINAL_WINDOW07_NONREPLAY_NO_CHILD_NO_SAMPLES_CANONICAL_LINEAGE_ARCHITECTURE_GREEN_NEW_WINDOW_NOT_AUTHORIZED',
  implementationCommit: '7d67f5069233fbbc5b00a9170c2639b9e237edf2',
  derivedBuildFix: {
    implementationCommit: '33d8856c7f4a1e93edce90ba2c9f31d406d9272a',
    rootCause: 'UNTRACKED_CONTRACTS_DIST_TREATED_AS_GIT_BLOBS',
    resolution: 'PINNED_REBUILD_PROVENANCE_BOUND_AT_ISSUE_ADMISSION_TERMINAL',
    buildHelper: 'scripts/ci/issue-v3-capacity-window.py', derivedOutputCount: 42,
  },
  failureCarryoverFix: {
    implementationCommit: 'f285bf3de7ef9b23be5370759a4e591dd3280414',
    rootCause: 'TERMINAL_ISSUER_FAILURE_OMITTED_FROM_NEXT_AUTHORITY',
    resolution: 'EXACT_DIRECT_CHILD_QUEUED_FAILURE_INVENTORY_BOUND_AT_ISSUE_ADMISSION_TERMINAL',
    priorFailureCount: 1,
    issuerFactSha256: '5cd3828a073be9318c333741d96fb1f7dc555b10eb3e8d63fe6732847a866267',
    ownerSha256: '0ed4a2e3aa757efdb2d61cd9037ba487f15cd63360b69272510a6a11be3ea64a',
    supervisorSha256: 'd7f953cc9954723cd9d26aa8c6b77b79af094b4372626bfb4618337febf8d79e',
  },
  prechildFailureCarryoverFix: {
    implementationCommit: 'ab5f33912e29ec8206358b3c7521d0752710b13b',
    rootCause: 'HISTORICAL_REPLAY_AUDIT_DICT_UNHASHABLE_BEFORE_CHILD',
    resolution: 'TERMINAL_PRECHILD_RECEIPT_AND_EXACT_DIRECT_CHILD_PRECHILD_INVENTORY_BOUND_AT_ISSUE_ADMISSION_TERMINAL',
    priorPrechildFailureCount: 1,
    recoveryScriptSha256: '3fc51473d6739281c3ccce1fe71d44d2b21db3895b9ae94964fa505ff67353bf',
  },
  terminalIssuerWindow01: {
    state: 'TERMINAL_ISSUER_FAILURE', windowId: 'c9e11b19-6e83-4d8c-959c-1b57b61aa71d',
    windowDirName: 'r023-objects-limit-queued-stop-window-01', label: 'r023-objects-limit-queued-stop-01',
    errorCode: 'SOURCE_CANDIDATE', failureSha256: 'e18619e0c24306b0aaf7d84fe3f970faecbbe844780b5f1abb0f6ae47f108329',
    windowWritten: false, benchmarkRun: 'NOT_RUN', replay: 'PROHIBITED',
  },
  terminalPrechildWindow02: {
    state: 'TERMINAL_PRECHILD_CONTROL_FAILURE',
    failure: 'QUEUED_STOP_REPLAY_AUDIT_TYPE_ERROR',
    windowId: 'c7528bf4-d5a4-4a7e-8d73-f738370d1774',
    windowDirName: 'r023-objects-limit-queued-stop-window-02',
    label: 'r023-objects-limit-queued-stop-02',
    receiptSha256: '0b372f0ca99be6226b614a5898ccaf002e3129ad1cbdbd36903dc784339465ae',
    windowSha256: 'bf4cb4c7b38478e48023c8e974f016e2809881515eda4ed4f46938e3a57012d1',
    authorityFiles: {
      ownerSha256: 'f01145de94e93a82deff37a80e401b3d8ac80558021648df59c4bbe9a2165db8',
      supervisorSha256: '751bcebc601ef5b40ba9f6f35101703a63c6735052204f49838ce2e3d1c7113c',
      issuerFactSha256: '9ff0e704f67ea2754390afb8fd8d28f730c5f28bd1feddbcbdca1be8f1fff1cc',
      sourceManifestSha256: '63044cd174bbe3220b52b6dc4905a8f64add6e6178ee070c248ee05ae6653827',
      ownedManifestSha256: '519bdcccb2191712a95c0d333fdde94c6ea0faebaa3a2f7bd55ffa10d538bd8a',
    },
    ownedRootCount: 74,
    observedExitCode: 1,
    authorityAdmission: 'NOT_RUN',
    supervisionStarted: false,
    benchmarkStarted: false,
    childSpawned: false,
    outputCreated: false,
    sampleCount: 0,
    windowConsumed: true,
    trigger: {
      sha256: 'b82414541ba26fe21871c472ccd03321a27f7896bf4f70376f0abbeb264591a3',
      role: 'isolated-reproduction-witness-not-historical-order',
    },
    receiptMode: '0400',
    receiptLinkCount: 1,
    replay: 'PROHIBITED',
    deviceOpened: false,
    formalReady: false,
    gateB: 'NOT_RUN',
  },
  frozenMeasureWindow06: {
    windowId: 'afc81a99-d15d-4179-8326-5774a5c40b62',
    candidateCommit: 'a457414fffd141390ec2ff4536452a0f654b1370',
    windowSha256: 'cfac8e19336a181de00c68d458d046065cd821a0dca48cc4fc78af0e15c15227',
    closeSha256: '1c93f6c6ec1a0b58619f87127d3e2c7d11a1cfcce1c155b3576a84eda2af84b7',
    supervisorSha256: '18ef840fe99b861ca8881c7c7be09b70c13431df02d88ddf282e29f2169cdc92',
    snapshotBytes: 1990471680,
  },
  rootClosure: {
    frozenMeasure: 71, priorIssuerFailures: 1, priorPrechildFailures: 1,
    priorProcessFailureHead: 1, authorityParent: 1, issuerIdentity: 1,
    exactDirect: 76, transitiveBillingRootCount: 78,
  },
  formalPlan: {
    warmupCount: 5, formalCount: 100, sampleCount: 105,
    activeCloneMaximum: 1, executionTimeoutMs: 50000, windowTimeoutSeconds: 900,
    evidenceAllowanceBytes: 268435456, plannedBytes: 2258907136,
    aggregateAuditRows: 843, successfulOutputFiles: 636,
  },
  focusedVerification: {
    capacity: { tests: 92, passed: 92, failed: 0 },
    supervisor: { tests: 28, passed: 28, failed: 0 },
    issuer: { tests: 9, passed: 9, failed: 0 },
    fourCapacityControlSuites: { tests: 81, passed: 81, failed: 0 },
  },
  prechildCarryoverVerification: {
    implementationCommit: 'ab5f33912e29ec8206358b3c7521d0752710b13b',
    queuedStopIssuerAndTerminalizer: { tests: 18, passed: 18, failed: 0 },
    supervisorQueuedStopFocused: { tests: 9, passed: 9, failed: 0 },
    bridgeCoreExact75Focused: { tests: 1, passed: 1, failed: 0 },
    combinedQueuedStopSuites: { tests: 52, passed: 52, failed: 0 },
    fourCapacityControlSuites: { tests: 96, passed: 96, failed: 0 },
    fullVerify: 'PASS',
    independentReview: { p0: 0, p1: 0 },
  },
  fullVerify: 'PASS',
  staticGates: { controlPlane: 'PASS', boundaries: 'PASS', cycles: 'PASS_259_FILES' },
  authority: {
    state: 'ISSUED_AND_CONSUMED_ONCE_INPUT_REJECTED_NO_TERMINAL_RECEIPT_REPLAY_PROHIBITED',
    candidateCommit: '3abc4c2f77475ede4159d7c1922396481cada48c',
    windowId: '5f5df917-cb23-453b-906c-4e4395cec1ad',
    windowDirName: 'r023-objects-limit-queued-stop-window-07',
    label: 'r023-objects-limit-queued-stop-07',
    windowSha256: '0bac4fcc26057f94dc17eab902b2affbf34438ae0d3fae7fa43bd779e6182331',
    recoverySha256: 'f500b9b3f85962f88e40b0596ff2cf78a3e37458643b7eb687827b18a40e0ffb',
    observedExitCode: 1, observedError: 'CAPACITY_SUPERVISOR_INPUT',
    authorityAdmission: 'REJECTED_BEFORE_SUPERVISION', supervisionStarted: false,
    childSpawned: false, benchmarkStarted: false, outputCreated: false, sampleCount: 0,
    deviceOpened: false, gateB: 'NOT_RUN',
  },
  blockingAudit: {
    state: 'RESOLVED_CANONICAL_LINEAGE_CONTRACT_GREEN_NEW_WINDOW_NOT_AUTHORIZED',
    implementationCheckpoints: [
      '168cbcbd7a15130b6bd90e115024aefdb789da67',
      '36d92a85c28e4d8a7faa6d95ebf8014263c10b26',
      '3abc4c2f77475ede4159d7c1922396481cada48c',
    ],
    locations: [
      'bridge-core-cli-runtime-root', 'queued-stop-issuer-recursive-process-count',
      'installed-supervisor-recursive-process-count',
    ],
    fourthPatchAttempted: false, newWindowAuthorized: false,
    requiredDecision: 'FRESH_REMOTE_HEAD_AUDIT_THEN_EXPLICIT_NEW_WINDOW_AUTHORIZATION',
  },
  architectureResolution: {
    implementationCommit: 'ed73b59fca177cc1804d4010fe863f8fb57001a0',
    contract: {
      path: 'packages/contracts/capacity-process-failure-lineage-v1.json',
      sha256: 'd9d1c792971e27b666a9c2fcf7ea7942f3af75b6e500c3f9502f1bcf33157927',
      schemaVersion: 1, maximumReachableDepth: 64, directHeadCount: 1,
      processFailureCountMeaning: 'PREDECESSOR_REACHABLE_DEPTH', billingOrder: 'HEAD_TO_LEAF',
    },
    sharedPythonEvaluator: {
      path: 'scripts/ci/capacity_process_failure_lineage.py',
      sha256: '458c3e5233bba9f4834d8986ccdceb568bd42e06805ef5a872a363d2b707e9e7',
    },
    consumers: ['queued-stop-issuer', 'installed-supervisor', 'typescript-capacity-consumer'],
    sourcePinCount: 243,
    historicalSourcePinCountsAcceptedReadOnly: [241, 243],
    goldenCorpus: {
      tests: 1, passed: 1, validDepths: [0, 1, 2, 3],
      rejections: [
        'DIRECT_HEAD_COUNT', 'ORPHAN', 'CYCLE', 'FORK', 'TIME_ORDER',
        'PID_MISMATCH', 'IDENTITY_MISMATCH', 'AUTHORITY_DEPTH_MISMATCH',
      ],
    },
    focusedVerification: {
      issuer: 'PASS_71_OF_71', supervisor: 'PASS_58_OF_58',
      bridgeCapacityAndConformance: 'PASS', bridgeTypecheck: 'PASS',
    },
    fullVerification: {
      pnpmVerify: 'PASS', contracts: 'PASS_186_OF_186',
      bridgeCore: 'PASS_1296_WITH_1_CONDITIONAL_SKIP', desktop: 'PASS_643_OF_643',
      build: 'PASS', controlPlane: 'PASS', boundaries: 'PASS', cycles: 'PASS_259_FILES',
      readinessFocused: 'PASS_15_OF_15',
      readiness: 'PASS_READY_FALSE_OWNER_PENDING_103_EXTERNAL_NOT_RUN_5', diffCheck: 'PASS',
    },
    review: { specification: 'PASS', quality: 'PASS', additionalReviewLoop: false },
    newWindowIssued: false, newWindowAuthorized: false, runtimeMutated: false,
  },
  formalRun: 'NOT_RUN_ARCHITECTURE_GREEN_NEW_WINDOW_NOT_AUTHORIZED_ZERO_SAMPLES',
  joint: 'SOFTWARE_GREEN_FORMAL_GENERATION_NOT_RUN_MEASURE_NOT_RUN',
  deviceOpened: false,
  gateB: 'NOT_RUN',
  ownerAcceptance: 'NOT_RUN',
}
const CAPACITY_JOINT_GENERATION_CONTROL_PLANE = {
  state: 'SOFTWARE_GREEN_FORMAL_GENERATION_NOT_RUN_MEASURE_NOT_RUN',
  implementationCommit: '5464ae06355832a76dc394c4cde5eed28acb4846',
  previousPlannedBytes: 6140461056,
  generationPlan: {
    model: 'serial-single-output-plus-bounded-growth-v1',
    activeOutputMaximum: 1, finalAxisBytes: 1275068416, activeOutputBytes: 1275068416,
    activeRecordWorkspaceBytes: 16777216, evidenceAllowanceBytes: 134217728,
    plannedBytes: 2701131776,
  },
  planPreparation: {
    strategy: 'serial-create-consume-one-active', preparedBeforeFirstAttempt: 1,
    activePlanMaximum: 1, unconsumedAtSeal: 1,
  },
  consumerContract: {
    supervisorGenerationArtifacts: 'EXACT', supervisorMeasureSeed: 'EXACT',
    phaseGenerationPlanAndAxes: 'EXACT', strictJsonTypes: true,
    snapshotPrewriteProjection: true, terminalOutputBound: true,
  },
  focusedVerification: {
    capacity: { tests: 92, passed: 92, failed: 0 },
    supervisor: { tests: 32, passed: 32, failed: 0 },
    generationIssuer: { tests: 19, passed: 19, failed: 0 },
    measureIssuer: { tests: 25, passed: 25, failed: 0 },
    queuedStopIssuer: { tests: 9, passed: 9, failed: 0 },
    fourCapacityControlSuites: { tests: 85, passed: 85, failed: 0 },
    bridgeCoreTypecheck: 'PASS', pythonCompile: 'PASS', fullVerify: 'PASS',
    staticGates: { controlPlane: 'PASS', boundaries: 'PASS', cycles: 'PASS_259_FILES' },
  },
  independentReview: { p0: 0, p1: 0, p2: 0 },
  formalGeneration: 'NOT_RUN', formalMeasure: 'NOT_RUN', deviceOpened: false,
  formalReady: false, gateB: 'NOT_RUN', ownerAcceptance: 'NOT_RUN',
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw new Error(code) }
const check = (condition, code) => { if (!condition) fail(code) }
const gitSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value)
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const ERROR_CODES = new Set([
  'ARGUMENTS', 'SHAPE', 'ROOT_REQUIRED', 'IDENTITY', 'CONTROL_IDENTITY', 'CONTROL_STATE',
  'CONTROL_REPOSITORY',
  'BASELINE_PATH', 'SOFTWARE_BASELINE', 'READY_CONTRADICTION', 'DEVICE_STATE',
  'EXTERNAL_STATE', 'OWNER_STATE', 'EVIDENCE_NOT_ALLOWED', 'READY_REQUIRED', 'INVALID_READINESS',
])

export function normalizeReadinessError(error) {
  return error instanceof Error && ERROR_CODES.has(error.message) ? error.message : 'INVALID_READINESS'
}

function keys(value, required) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'SHAPE')
  check(required.every(key => Object.hasOwn(value, key)), 'SHAPE')
  check(Object.keys(value).every(key => required.includes(key)), 'SHAPE')
}

function safeFile(root, relativePath, allowedPaths, limit = 16 * 1024 * 1024) {
  check(allowedPaths.includes(relativePath), 'BASELINE_PATH')
  let current = path.resolve(root)
  for (const part of relativePath.split('/')) {
    check(part && part !== '.' && part !== '..', 'BASELINE_PATH')
    current = path.join(current, part)
    let stat
    try { stat = lstatSync(current) } catch { fail('BASELINE_PATH') }
    check(!stat.isSymbolicLink(), 'BASELINE_PATH')
  }
  const stat = lstatSync(current)
  check(stat.isFile() && stat.size <= limit, 'BASELINE_PATH')
  return readFileSync(current)
}

function gitResult(root, arguments_) {
  return spawnSync('git', arguments_, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

export function validateEvidenceCheckpointRepository(root, infrastructure = EVIDENCE_INFRASTRUCTURE,
                                                     jointCommit = CAPACITY_JOINT_GENERATION_CONTROL_PLANE.implementationCommit) {
  check(typeof root === 'string', 'ROOT_REQUIRED')
  check(infrastructure?.state === EVIDENCE_INFRASTRUCTURE.state, 'CONTROL_REPOSITORY')
  const receipt = infrastructure.receiptFoundation
  const closure = infrastructure.candidateClosure
  check(receipt?.focusedTests === 25 && closure?.focusedTests === 26 && closure.baseCommit === receipt.finalCommit, 'CONTROL_REPOSITORY')
  const commits = [
    receipt.baseCommit, receipt.implementationCommit, receipt.reportCommit, receipt.finalCommit,
    closure.implementationCommit, closure.reportCommit, closure.finalCommit,
  ]
  check(commits.every(gitSha) && gitSha(jointCommit) && new Set([...commits, jointCommit]).size === commits.length + 1, 'CONTROL_REPOSITORY')
  const top = gitResult(root, ['rev-parse', '--show-toplevel'])
  check(top.error === undefined && top.signal === null && top.status === 0 && realpathSync(top.stdout.trim()) === realpathSync(root), 'CONTROL_REPOSITORY')
  const branch = gitResult(root, ['branch', '--show-current'])
  check(branch.error === undefined && branch.signal === null && branch.status === 0 && branch.stdout.trim() === 'codex/task-079-v3-final-acceptance', 'CONTROL_REPOSITORY')
  for (const commit of commits) {
    const object = gitResult(root, ['cat-file', '-e', `${commit}^{commit}`])
    check(object.error === undefined && object.signal === null && object.status === 0, 'CONTROL_REPOSITORY')
  }
  const jointObject = gitResult(root, ['cat-file', '-e', `${jointCommit}^{commit}`])
  check(jointObject.error === undefined && jointObject.signal === null && jointObject.status === 0, 'CONTROL_REPOSITORY')
  for (let index = 1; index < commits.length; index += 1) {
    const ancestry = gitResult(root, ['merge-base', '--is-ancestor', commits[index - 1], commits[index]])
    check(ancestry.error === undefined && ancestry.signal === null && ancestry.status === 0, 'CONTROL_REPOSITORY')
  }
  const jointAncestry = gitResult(root, ['merge-base', '--is-ancestor', commits.at(-1), jointCommit])
  const headAncestry = gitResult(root, ['merge-base', '--is-ancestor', jointCommit, 'HEAD'])
  check(jointAncestry.error === undefined && jointAncestry.signal === null && jointAncestry.status === 0
    && headAncestry.error === undefined && headAncestry.signal === null && headAncestry.status === 0, 'CONTROL_REPOSITORY')
}

export function validateArchitectureCheckpointRepository(
  root,
  architectureCommit = CAPACITY_QUEUED_STOP_CONTROL_PLANE.architectureResolution.implementationCommit,
  parentCommit = CAPACITY_JOINT_GENERATION_CONTROL_PLANE.implementationCommit,
) {
  check(typeof root === 'string' && gitSha(architectureCommit) && gitSha(parentCommit)
    && architectureCommit !== parentCommit, 'CONTROL_REPOSITORY')
  for (const commit of [parentCommit, architectureCommit]) {
    const object = gitResult(root, ['cat-file', '-e', `${commit}^{commit}`])
    check(object.error === undefined && object.signal === null && object.status === 0, 'CONTROL_REPOSITORY')
  }
  const parentAncestry = gitResult(root, ['merge-base', '--is-ancestor', parentCommit, architectureCommit])
  const headAncestry = gitResult(root, ['merge-base', '--is-ancestor', architectureCommit, 'HEAD'])
  check(parentAncestry.error === undefined && parentAncestry.signal === null && parentAncestry.status === 0
    && headAncestry.error === undefined && headAncestry.signal === null && headAncestry.status === 0, 'CONTROL_REPOSITORY')
}

function validateControlIdentity(status, wave) {
  const current = status?.v3Development
  check(current && current.task === TASK && current.branch === 'codex/task-079-v3-final-acceptance' && current.baseCommit === BASE_COMMIT, 'CONTROL_IDENTITY')
  check(current.state === DEVELOPMENT_STATE, 'CONTROL_STATE')
  check(JSON.stringify(current.evidenceInfrastructure) === JSON.stringify(EVIDENCE_INFRASTRUCTURE), 'CONTROL_STATE')
  check(JSON.stringify(current.hardwareEvidenceControl) === JSON.stringify(HARDWARE_EVIDENCE_CONTROL), 'CONTROL_STATE')
  check(JSON.stringify(current.task078SoftwareCheckpoints?.capacityWindowIssuer) === JSON.stringify(CAPACITY_WINDOW_ISSUER), 'CONTROL_STATE')
  check(JSON.stringify(current.task078SoftwareCheckpoints?.capacityMeasureWindowIssuer) === JSON.stringify(CAPACITY_MEASURE_WINDOW_ISSUER), 'CONTROL_STATE')
  check(JSON.stringify(current.task078SoftwareCheckpoints?.capacityQueuedStopControlPlane) === JSON.stringify(CAPACITY_QUEUED_STOP_CONTROL_PLANE), 'CONTROL_STATE')
  check(JSON.stringify(current.task078SoftwareCheckpoints?.capacityJointGenerationControlPlane) === JSON.stringify(CAPACITY_JOINT_GENERATION_CONTROL_PLANE), 'CONTROL_STATE')
  const device = current.deviceTestPlanning
  check(device && device.connectionState === 'no-devices-connected' && device.deviceOperationsAuthorization === 'NOT_GRANTED' && device.measurementConfiguration === 'PENDING' && device.outputBackendCertification === 'NOT_RUN', 'CONTROL_STATE')
  check(Array.isArray(device.audioInterfaceBrandCandidates) && JSON.stringify(device.audioInterfaceBrandCandidates) === JSON.stringify(['RME', 'Apogee']) && device.audioInterfaceModel === null, 'CONTROL_STATE')
  check(device.plannedRecorder?.brand === 'Sony' && device.plannedRecorder?.type === 'cassette-deck' && device.plannedRecorder?.model === null, 'CONTROL_STATE')
  const gates = current.gates
  const notRun = ['externalGate', 'realInput', 'realLogic', 'realRoon', 'hardware', 'audibleReplica', 'outputBackendCertification', 'realRecording', 'paperPrint', 'ownerProductAcceptance']
  check(gates && gates.readinessControl === READINESS_CONTROL && gates.externalEvidenceProfiles === EXTERNAL_EVIDENCE_PROFILES && gates.capacityAuthority === CAPACITY_AUTHORITY, 'CONTROL_STATE')
  check(notRun.every(key => gates[key] === 'NOT_RUN') && gates.ownerDecisions === 'PENDING_103', 'CONTROL_STATE')
  check(typeof wave === 'string', 'CONTROL_IDENTITY')
  const values = new Map()
  for (const line of wave.split('\n')) {
    const match = /^(activeTask|activeBranch|activeBaseCommit): (.+)$/u.exec(line)
    if (!match) continue
    check(!values.has(match[1]), 'CONTROL_IDENTITY')
    values.set(match[1], match[2])
  }
  check(values.size === 3, 'CONTROL_IDENTITY')
  check(values.get('activeTask') === TASK && values.get('activeBranch') === 'codex/task-079-v3-final-acceptance' && values.get('activeBaseCommit') === BASE_COMMIT, 'CONTROL_IDENTITY')
}

function validateSoftwareBaseline(baseline, matrix, matrixBytes) {
  keys(baseline, ['task', 'finalCommit', 'matrixPath', 'matrixSha256', 'entries', 'mappedPassed', 'unmappedPending', 'externalGate', 'formalReady'])
  check(baseline.task === 'TASK-078' && baseline.finalCommit === BASE_COMMIT && gitSha(baseline.finalCommit), 'SOFTWARE_BASELINE')
  check(baseline.matrixPath === MATRIX_PATH && sha256(baseline.matrixSha256) && baseline.matrixSha256 === MATRIX_SHA256 && baseline.matrixSha256 === hash(matrixBytes), 'SOFTWARE_BASELINE')
  check(matrix && typeof matrix === 'object' && matrix.task === 'TASK-078' && matrix.baseCommit === MATRIX_BASE_COMMIT, 'SOFTWARE_BASELINE')
  check(matrix.externalGate === 'NOT_RUN' && matrix.formalReady === false, 'SOFTWARE_BASELINE')
  check(Array.isArray(matrix.entries) && matrix.entries.length === 103, 'SOFTWARE_BASELINE')
  const mappedPassed = matrix.entries.filter(entry => entry.status === 'mapped' && entry.freshGate?.state === 'passed')
  const unmappedPending = matrix.entries.filter(entry => entry.status === 'unmapped' && entry.freshGate?.state === 'pending').map(entry => entry.id).sort()
  check(mappedPassed.length === 101 && JSON.stringify(unmappedPending) === JSON.stringify(UNMAPPED_PENDING), 'SOFTWARE_BASELINE')
  check(baseline.entries === 103 && baseline.mappedPassed === 101, 'SOFTWARE_BASELINE')
  check(Array.isArray(baseline.unmappedPending) && JSON.stringify([...baseline.unmappedPending].sort()) === JSON.stringify(UNMAPPED_PENDING), 'SOFTWARE_BASELINE')
  check(baseline.externalGate === 'NOT_RUN' && baseline.formalReady === false, 'SOFTWARE_BASELINE')
}

export function validateOwnerReadiness(readiness, { root, matrix, status, wave } = {}) {
  check(typeof root === 'string', 'ROOT_REQUIRED')
  keys(readiness, ['schemaVersion', 'task', 'baseCommit', 'phase', 'ready', 'softwareBaseline', 'devicePlan', 'externalRequirements', 'ownerDecisions', 'evidence'])
  check(readiness.schemaVersion === 1 && readiness.task === TASK && readiness.baseCommit === BASE_COMMIT && gitSha(readiness.baseCommit), 'IDENTITY')
  check(readiness.phase === 'no-device-readiness' && readiness.ready === false, 'READY_CONTRADICTION')

  const matrixBytes = safeFile(root, readiness.softwareBaseline?.matrixPath, [MATRIX_PATH])
  let actualMatrix = matrix
  if (!actualMatrix) {
    try { actualMatrix = JSON.parse(matrixBytes.toString('utf8')) } catch { fail('SOFTWARE_BASELINE') }
  }
  validateSoftwareBaseline(readiness.softwareBaseline, actualMatrix, matrixBytes)
  let actualStatus = status
  if (!actualStatus) {
    try { actualStatus = JSON.parse(safeFile(root, 'project/STATUS.json', ['project/STATUS.json']).toString('utf8')) } catch (error) { if (error instanceof Error && error.message === 'BASELINE_PATH') throw error; fail('CONTROL_IDENTITY') }
  }
  const actualWave = wave ?? safeFile(root, 'project/WAVE-5.yaml', ['project/WAVE-5.yaml']).toString('utf8')
  validateControlIdentity(actualStatus, actualWave)

  keys(readiness.devicePlan, ['connectionState', 'operationsAuthorized', 'audioInterfaceBrands', 'audioInterfaceModel', 'recorderBrand', 'recorderKind', 'recorderModel', 'configurationState', 'measurementPlanState'])
  check(readiness.devicePlan.connectionState === 'not-connected' && readiness.devicePlan.operationsAuthorized === false, 'DEVICE_STATE')
  check(Array.isArray(readiness.devicePlan.audioInterfaceBrands) && JSON.stringify(readiness.devicePlan.audioInterfaceBrands) === JSON.stringify(['RME', 'Apogee']), 'DEVICE_STATE')
  check(readiness.devicePlan.audioInterfaceModel === null && readiness.devicePlan.recorderBrand === 'Sony' && readiness.devicePlan.recorderKind === 'cassette-deck' && readiness.devicePlan.recorderModel === null, 'DEVICE_STATE')
  check(readiness.devicePlan.configurationState === 'pending' && readiness.devicePlan.measurementPlanState === 'pending', 'DEVICE_STATE')

  check(Array.isArray(readiness.externalRequirements) && readiness.externalRequirements.length === EXTERNAL_KINDS.length, 'EXTERNAL_STATE')
  const external = new Set()
  for (const requirement of readiness.externalRequirements) {
    keys(requirement, ['kind', 'state', 'evidenceIds'])
    check(EXTERNAL_KINDS.includes(requirement.kind) && !external.has(requirement.kind), 'EXTERNAL_STATE')
    check(requirement.state === 'not-run' && Array.isArray(requirement.evidenceIds) && requirement.evidenceIds.length === 0, 'EXTERNAL_STATE')
    external.add(requirement.kind)
  }
  check(EXTERNAL_KINDS.every(kind => external.has(kind)), 'EXTERNAL_STATE')

  const requiredIds = new Set(actualMatrix.entries.map(entry => entry.id))
  check(requiredIds.size === 103 && Array.isArray(readiness.ownerDecisions) && readiness.ownerDecisions.length === 103, 'OWNER_STATE')
  const decisions = new Set()
  for (const decision of readiness.ownerDecisions) {
    keys(decision, ['id', 'state', 'evidenceIds'])
    check(requiredIds.has(decision.id) && !decisions.has(decision.id), 'OWNER_STATE')
    check(decision.state === 'pending' && Array.isArray(decision.evidenceIds) && decision.evidenceIds.length === 0, 'OWNER_STATE')
    decisions.add(decision.id)
  }
  check([...requiredIds].every(id => decisions.has(id)), 'OWNER_STATE')
  check(Array.isArray(readiness.evidence) && readiness.evidence.length === 0, 'EVIDENCE_NOT_ALLOWED')

  return {
    ready: false,
    ownerPending: 103,
    externalNotRun: 5,
    deviceConnected: false,
    deviceOperationsAuthorized: false,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.slice(2).every(argument => argument === '--require-ready') && process.argv.slice(2).length <= 1, 'ARGUMENTS')
    const root = process.cwd()
    const readiness = JSON.parse(safeFile(root, 'project/V3_OWNER_ACCEPTANCE.json', ['project/V3_OWNER_ACCEPTANCE.json']).toString('utf8'))
    const result = validateOwnerReadiness(readiness, { root })
    validateEvidenceCheckpointRepository(root)
    validateArchitectureCheckpointRepository(root)
    if (process.argv.includes('--require-ready') && !result.ready) fail('READY_REQUIRED')
    console.log(`V3_OWNER_READINESS=PASS ${JSON.stringify(result)}；控制文件有效，真实设备与Owner验收仍未运行。`)
  } catch (error) {
    console.error(`V3_OWNER_READINESS=FAIL ${normalizeReadinessError(error)}`)
    process.exitCode = 1
  }
}
