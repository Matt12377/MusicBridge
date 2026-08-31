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
    task: 'TASK-081',
    branch: 'codex/task-081-joint-capacity-issuers',
    baseCommit: 'b90c831f62afa2dedcb07630cbb89add2ad3f393',
    state: 'joint-generation-exclusive-issuer-software-sealed-draft-review-pending-no-window-no-samples-external-pending',
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
      capacityAuthority: 'OBJECTS_MEASURE_WINDOW06_SOFTWARE_PASS_QUEUED_STOP_WINDOW06_PROCESS_EXIT_TERMINAL_WINDOW07_NONREPLAY_NO_CHILD_NO_SAMPLES_CANONICAL_LINEAGE_ARCHITECTURE_GREEN_NEW_WINDOW_NOT_AUTHORIZED_JOINT_GENERATE_MEASURE_QUEUED_STOP_NOT_RUN_GENERATION_ISSUER_GREEN_NOT_ISSUED_REMAINING_ISSUERS_NOT_IMPLEMENTED',
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
      },
      capacityQueuedStopControlPlane: {
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
          coverageEnhancementCommit: 'fefbea78e65ce8deb37bc727ad93b3b7d955ab30',
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
            tests: 2, passed: 2, validDepths: [0, 1, 2, 3],
            rejections: [
              'DIRECT_HEAD_COUNT', 'ORPHAN', 'CYCLE', 'FORK', 'TIME_ORDER',
              'PID_MISMATCH', 'IDENTITY_MISMATCH', 'AUTHORITY_DEPTH_MISMATCH', 'DEPTH_LIMIT',
            ],
          },
          focusedVerification: {
            issuer: 'PASS_71_OF_71', supervisor: 'PASS_58_OF_58',
            bridgeCapacityAndConformance: 'PASS_139_OF_139', bridgeTypecheck: 'PASS',
          },
          fullVerification: {
            pnpmVerify: 'PASS', contracts: 'PASS_186_OF_186',
            bridgeCore: 'PASS_1297_WITH_1_CONDITIONAL_SKIP', desktop: 'PASS_643_OF_643',
            build: 'PASS', controlPlane: 'PASS', boundaries: 'PASS', cycles: 'PASS_259_FILES',
            readinessFocused: 'PASS_17_OF_17',
            readiness: 'PASS_READY_FALSE_OWNER_PENDING_103_EXTERNAL_NOT_RUN_5', diffCheck: 'PASS',
          },
          review: { specification: 'PASS', quality: 'PASS', additionalReviewLoop: false },
          coverageEnhancementReview: { specification: 'PASS', quality: 'PASS', additionalReviewLoop: false },
          newWindowIssued: false, newWindowAuthorized: false, runtimeMutated: false,
        },
        formalRun: 'NOT_RUN_ARCHITECTURE_GREEN_NEW_WINDOW_NOT_AUTHORIZED_ZERO_SAMPLES',
        joint: 'SOFTWARE_GREEN_FORMAL_GENERATION_MEASURE_QUEUED_STOP_NOT_RUN',
        deviceOpened: false,
        gateB: 'NOT_RUN',
        ownerAcceptance: 'NOT_RUN',
      },
      capacityJointGenerationControlPlane: {
        state: 'SOFTWARE_GREEN_FORMAL_GENERATION_MEASURE_QUEUED_STOP_NOT_RUN',
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
        formalGeneration: 'NOT_RUN', formalMeasure: 'NOT_RUN', formalQueuedStop: 'NOT_RUN', deviceOpened: false,
        formalReady: false, gateB: 'NOT_RUN', ownerAcceptance: 'NOT_RUN',
      },
      capacityFormalRouteControl: {
        schemaVersion: 1,
        state: 'WAITING_OBJECTS_LIMIT_QUEUED_STOP_PASS_AND_REMAINING_JOINT_ISSUER_SUPPORT',
        prerequisite: {
          order: 0, profile: 'objects-limit', phase: 'queued-stop', state: 'NOT_RUN',
          requiredResult: 'PASS', currentWindow: 'NOT_ISSUED',
        },
        stages: [
          {
            order: 1, profile: 'joint', phase: 'generate', state: 'NOT_RUN',
            consumes: 'objects-limit:queued-stop:PASS', produces: 'joint-generation-seed',
            runtimeSchemaSupport: 'PASS', exclusiveIssuerSupport: 'IMPLEMENTED_NOT_ISSUED',
            processScope: 'joint-generation-process', clockScope: 'joint-generation-stage-clock',
            receiptScope: 'joint-generation-window-close', requiresFreshProcess: true,
            requiresFreshClock: true, receiptReuseAllowed: false,
            freshAuditRequired: true, uniqueAuthorityRequired: true, oneTimeWindowRequired: true,
            ownerAuthorizationRequired: true,
          },
          {
            order: 2, profile: 'joint', phase: 'measure', state: 'NOT_RUN',
            consumes: 'joint:generate:PASS', produces: 'joint-measure-close',
            runtimeSchemaSupport: 'PASS', exclusiveIssuerSupport: 'NOT_IMPLEMENTED_OBJECTS_LIMIT_ONLY',
            processScope: 'joint-measure-process', clockScope: 'joint-measure-stage-clock',
            receiptScope: 'joint-measure-window-close', requiresFreshProcess: true,
            requiresFreshClock: true, receiptReuseAllowed: false,
            freshAuditRequired: true, uniqueAuthorityRequired: true, oneTimeWindowRequired: true,
            ownerAuthorizationRequired: true,
          },
          {
            order: 3, profile: 'joint', phase: 'queued-stop', state: 'NOT_RUN',
            consumes: 'joint:measure:PASS', produces: 'joint-queued-stop-close',
            runtimeSchemaSupport: 'PASS', exclusiveIssuerSupport: 'NOT_IMPLEMENTED_OBJECTS_LIMIT_ONLY',
            processScope: 'joint-queued-stop-process', clockScope: 'joint-queued-stop-stage-clock',
            receiptScope: 'joint-queued-stop-window-close', requiresFreshProcess: true,
            requiresFreshClock: true, receiptReuseAllowed: false,
            freshAuditRequired: true, uniqueAuthorityRequired: true, oneTimeWindowRequired: true,
            ownerAuthorizationRequired: true,
          },
        ],
        linearNoSkip: true, authorityCannotBeInherited: true, stopOnNonPass: true,
        oldWindowReplayAllowed: false, readyToAuthorize: false,
        nextAction: 'TDD_IMPLEMENT_JOINT_MEASURE_AND_QUEUED_STOP_ISSUERS_BEFORE_ANY_JOINT_AUTHORIZATION',
        deviceOpened: false, gateB: 'NOT_RUN', ownerAcceptance: 'NOT_RUN',
      },
    },
  },
}
const controlWave = `activeTask: TASK-081\nactiveBranch: codex/task-081-joint-capacity-issuers\nactiveBaseCommit: b90c831f62afa2dedcb07630cbb89add2ad3f393\n`

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

test('STATUS v3Development与WAVE-5必须精确指向TASK081当前控制面', () => {
  assert.equal(validateOwnerReadiness(readiness(), { root, status: controlStatus, wave: controlWave }).ready, false)
  for (const [status, wave] of [
    [{ v3Development: { ...controlStatus.v3Development, task: 'TASK-078' } }, controlWave],
    [{ v3Development: { ...controlStatus.v3Development, branch: 'codex/task-078-v3-acceptance' } }, controlWave],
    [{ v3Development: { ...controlStatus.v3Development, baseCommit: '0'.repeat(40) } }, controlWave],
    [controlStatus, controlWave.replace('activeTask: TASK-081', 'activeTask: TASK-078')],
    [controlStatus, controlWave.replace('activeBranch: codex/task-081-joint-capacity-issuers', 'activeBranch: codex/task-078-v3-acceptance')],
    [controlStatus, controlWave.replace('activeBaseCommit: b90c831f62afa2dedcb07630cbb89add2ad3f393', `activeBaseCommit: ${'0'.repeat(40)}`)],
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

test('证据检查点必须是当前TASK081仓库中线性可达的真实Git提交', async t => {
  const module = await import('../verify-v3-owner-readiness.mjs')
  assert.equal(typeof module.validateEvidenceCheckpointRepository, 'function')
  assert.equal(typeof module.validateArchitectureCheckpointRepository, 'function')
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'task081-checkpoints-'))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))
  const git = (...arguments_) => {
    const result = spawnSync('git', arguments_, { cwd: temporaryRoot, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-b', 'codex/task-081-joint-capacity-issuers')
  git('config', 'user.email', 'task081@example.invalid')
  git('config', 'user.name', 'TASK081 Test')
  const commits = []
  for (let index = 0; index < 8; index += 1) {
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
  assert.doesNotThrow(() => module.validateEvidenceCheckpointRepository(temporaryRoot, infrastructure, commits[7]))
  assert.throws(() => module.validateEvidenceCheckpointRepository(temporaryRoot, infrastructure, '0'.repeat(40)), /CONTROL_REPOSITORY/u)
  assert.doesNotThrow(() => module.validateArchitectureCheckpointRepository(temporaryRoot, commits[6], commits[5], commits[7]))
  assert.throws(() => module.validateArchitectureCheckpointRepository(temporaryRoot, '0'.repeat(40), commits[5], commits[7]), /CONTROL_REPOSITORY/u)
  assert.throws(() => module.validateArchitectureCheckpointRepository(temporaryRoot, commits[5], commits[6], commits[7]), /CONTROL_REPOSITORY/u)
  assert.throws(() => module.validateArchitectureCheckpointRepository(temporaryRoot, commits[6], commits[5], '0'.repeat(40)), /CONTROL_REPOSITORY/u)
  assert.throws(() => module.validateArchitectureCheckpointRepository(temporaryRoot, commits[6], commits[5], commits[4]), /CONTROL_REPOSITORY/u)
  const reversed = structuredClone(infrastructure)
  ;[reversed.candidateClosure.implementationCommit, reversed.candidateClosure.reportCommit] = [reversed.candidateClosure.reportCommit, reversed.candidateClosure.implementationCommit]
  assert.throws(() => module.validateEvidenceCheckpointRepository(temporaryRoot, reversed, commits[7]), /CONTROL_REPOSITORY/u)
})

test('STATUS必须锁定谱系覆盖增强检查点与最新验证计数', () => {
  assert.equal(validateOwnerReadiness(readiness(), { root, status: controlStatus, wave: controlWave }).ready, false)
  for (const edit of [
    value => { delete value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.architectureResolution.coverageEnhancementCommit },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.architectureResolution.coverageEnhancementCommit = '0'.repeat(40) },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.architectureResolution.goldenCorpus.tests = 1 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.architectureResolution.goldenCorpus.rejections.pop() },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.architectureResolution.focusedVerification.bridgeCapacityAndConformance = 'PASS' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.architectureResolution.fullVerification.bridgeCore = 'PASS_1296_WITH_1_CONDITIONAL_SKIP' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.architectureResolution.fullVerification.readinessFocused = 'PASS_15_OF_15' },
    value => { delete value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.architectureResolution.coverageEnhancementReview },
  ]) {
    const status = structuredClone(controlStatus); edit(status)
    assert.throws(() => validateOwnerReadiness(readiness(), { root, status, wave: controlWave }), /CONTROL_STATE/u)
  }
})

test('STATUS必须锁定objects-limit后继joint三阶段线性路线与逐阶段授权边界', () => {
  assert.equal(validateOwnerReadiness(readiness(), { root, status: controlStatus, wave: controlWave }).ready, false)
  for (const edit of [
    value => { delete value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.prerequisite.state = 'PASS' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.stages.pop() },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.stages.reverse() },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.stages[0].exclusiveIssuerSupport = 'PASS' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.stages[1].freshAuditRequired = false },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.stages[2].ownerAuthorizationRequired = false },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.stages[2].processScope = 'joint-measure-process' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.stages[2].clockScope = 'joint-measure-stage-clock' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.stages[2].receiptScope = 'joint-measure-window-close' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.stages[2].receiptReuseAllowed = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.authorityCannotBeInherited = false },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.oldWindowReplayAllowed = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.readyToAuthorize = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityFormalRouteControl.gateB = 'PASS' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityJointGenerationControlPlane.formalQueuedStop = 'PASS' },
  ]) {
    const status = structuredClone(controlStatus); edit(status)
    assert.throws(() => validateOwnerReadiness(readiness(), { root, status, wave: controlWave }), /CONTROL_STATE/u)
  }
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
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.freshAuthorityIssued = false },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.legacyCarryover.contentSha256Verified = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.window04Terminal.windowId = randomUUID() },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.window04Terminal.closeSha256 = '0'.repeat(64) },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.window04Terminal.benchmarkFailureCode = 'PASS' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.window04Terminal.replay = 'ALLOWED' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.window04Terminal.deviceOpened = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.postWindow04Fix.implementationCommit = '0'.repeat(40) },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.successorAuthorityV3.rootClosure.authorized = 70 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.successorAuthorityV3.freshAuthorityIssued = false },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.successorAuthorityV3.window05PrecreateRejection.authorityCreated = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.successorAuthorityV3.window06Measure.candidateCommit = '0'.repeat(40) },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.successorAuthorityV3.window06Measure.thresholdPassed = false },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.successorAuthorityV3.window06Measure.formalReady = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.measureRecoveryV2.measureRun = 'WINDOW06_SOFTWARE_PASS_QUEUED_STOP_JOINT_PASS' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityMeasureWindowIssuer.gateB = 'PASS' },
    value => { delete value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.terminalPrechildWindow02.receiptSha256 = '0'.repeat(64) },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.terminalPrechildWindow02.ownedRootCount = 75 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.terminalPrechildWindow02.sampleCount = 1 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.terminalPrechildWindow02.benchmarkStarted = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.terminalPrechildWindow02.childSpawned = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.rootClosure.exactDirect = 75 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.rootClosure.transitiveBillingRootCount = 77 },
    value => { delete value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.rootClosure.priorPrechildFailures },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.authority.state = 'ISSUED' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.authority.windowId = randomUUID() },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.authority.windowDirName = 'future-window' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.authority.label = 'future-label' },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.blockingAudit.fourthPatchAttempted = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.blockingAudit.newWindowAuthorized = true },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityQueuedStopControlPlane.formalRun = 'PASS' },
    value => { delete value.v3Development.task078SoftwareCheckpoints.capacityJointGenerationControlPlane },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityJointGenerationControlPlane.generationPlan.plannedBytes = 6_140_461_056 },
    value => { value.v3Development.task078SoftwareCheckpoints.capacityJointGenerationControlPlane.formalGeneration = 'PASS' },
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
