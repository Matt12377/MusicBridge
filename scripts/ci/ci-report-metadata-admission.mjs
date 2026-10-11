import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readlinkSync,
  readSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MBM004_TASK, MBM004_BRANCH, MBM004_BASE, MBM004_SCOPE_PATH, MBM004_CORRECTION_PATH,
  MBM004_PREDECESSOR_SOURCE, MBM004_CANONICAL, validateMbm004Scope, validateMbm004Correction,
  assertMbm004CorrectionScope, assertMbm004Metadata, assertMbm004PredecessorMetadata } from './mbm004-admission.mjs';
import { validateMobileContentParentCi } from './report-only-mbm004.mjs';
import { CI_REPORT_MIRROR_TASK, CI_REPORT_MIRROR_BRANCH, CI_REPORT_MIRROR_BASE, CI_REPORT_MIRROR_PRODUCT_SOURCE,
  CI_REPORT_MIRROR_SOURCE_FILES, CI_REPORT_MIRROR_REPORT_PATHS, CI_REPORT_MIRROR_CORRECTION_IDENTITY,
  CI_REPORT_MIRROR_SCOPE_PATH, CI_REPORT_MIRROR_CORRECTION_PATH, assertCiReportMirrorScope,
  assertCiReportMirrorCorrection, ciReportMirrorReportIdentity, validateCiReportMirrorSourceReceipt } from './ci-report-mirror-admission.mjs';

export const CI_REPORT_METADATA_TASK = 'CI-REPORT-METADATA-001';
export const CI_REPORT_METADATA_BRANCH = 'codex/ci-report-metadata-001';
export const CI_REPORT_METADATA_BASE = '1b5345d13d9617c1770a361841d805305d06d038';
export const CI_REPORT_METADATA_SOURCE_PARENT = 'dfad0c8e0e0f906c3a7456b0151b3aaba7e5547c';
export const CI_REPORT_METADATA_HISTORICAL_SOURCE = 'd3d86c6db8d27485d2d763b81cd5e8925ee15af6';
export const CI_REPORT_METADATA_PRODUCT_SOURCE = '16507120ab52d4843012e6888ad521138d8336d6';
export const CI_REPORT_METADATA_SCOPE_PATH = 'docs/postrust/MBM-004/CI_REPORT_METADATA_SCOPE.json';
export const CI_REPORT_METADATA_CORRECTION_PATH = 'docs/postrust/MBM-004/CI_REPORT_METADATA_CORRECTION.json';
export const CI_REPORT_METADATA_EVIDENCE_PATH = 'docs/postrust/MBM-004/CI_EVIDENCE.json';
export const CI_REPORT_METADATA_GUARD_STEP = 'CI报告元数据精确身份与原软件复用准入';
export const CI_REPORT_METADATA_GATE_STEP = 'CI报告元数据修复工具 Gate';
export const CI_REPORT_METADATA_UPLOAD_STEP = '保留本次CI报告元数据工具证据';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryId = 1340424953, repositoryName = 'Matt12377/MusicBridge';
const zero = '0'.repeat(40), admitted = new WeakSet();
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function fail(code) { const error = new Error('CI报告元数据修复准入拒绝。'); error.code = code; throw error; }
function parse(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('CI_REPORT_METADATA_JSON_INVALID'); }
}
const numberToken = Symbol('CI报告原JSON数字token');
function lossless(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), (_key, value, context) => {
      if (typeof value !== 'number') return value;
      if (typeof context?.source !== 'string') fail('CI_REPORT_METADATA_NUMBER_TOKEN_UNAVAILABLE');
      return { [numberToken]: context.source };
    });
  } catch { fail('CI_REPORT_METADATA_LOSSLESS_JSON_INVALID'); }
}
function losslessEqual(left, right) {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return left === right;
  const leftNumber = Object.hasOwn(left, numberToken), rightNumber = Object.hasOwn(right, numberToken);
  if (leftNumber || rightNumber) return leftNumber && rightNumber && left[numberToken] === right[numberToken];
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left).sort();
  return equal(keys, Object.keys(right).sort()) && keys.every(key => losslessEqual(left[key], right[key]));
}
const relative = value => typeof value === 'string' && value.length > 0 && value.length < 4096
  && !path.isAbsolute(value) && !/[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');
export const CI_REPORT_METADATA_REPORT_PATHS = freeze([...CI_REPORT_MIRROR_REPORT_PATHS]);
export const CI_REPORT_METADATA_SOURCE_FILES = freeze([
  ['tasks/CI-REPORT-METADATA-001.md', 'A', 'task'],
  [CI_REPORT_METADATA_CORRECTION_PATH, 'A', 'authority'], [CI_REPORT_METADATA_SCOPE_PATH, 'A', 'authority'],
  ['scripts/ci/ci-report-metadata-admission.mjs', 'A', 'ci-tool'],
  ['scripts/ci/verify-ci-report-metadata.mjs', 'A', 'ci-tool'],
  ['scripts/ci/test/ci-report-metadata.test.mjs', 'A', 'tool-test'],
  ['scripts/ci/task-applicability.mjs', 'M', 'ci-routing'], ['scripts/ci/report-only-admission.mjs', 'M', 'ci-routing'],
  ['.github/workflows/verify.yml', 'M', 'workflow'], ['.github/workflows/security.yml', 'M', 'workflow'],
  ['.github/workflows/rust-core.yml', 'M', 'workflow'], ['.github/workflows/electron-e2e.yml', 'M', 'workflow'],
  ['project/STATUS.json', 'M', 'machine-status-projection'],
].map(([file, status, role]) => ({ path: file, status, role, oldMode: status === 'A' ? '000000' : '100644', newMode: '100644' })));
export const CI_REPORT_METADATA_SOURCE_DELTA_FILES = freeze([
  ['tasks/CI-REPORT-METADATA-001.md', 'c88b573c63c7446f2f8caf1343a697380731e695'],
  [CI_REPORT_METADATA_CORRECTION_PATH, '78a8d0cdea8ae0f1e0f4074d6315bbaff40df107'],
  [CI_REPORT_METADATA_SCOPE_PATH, '35bc0f6ad0dfdeec7b8b49b94f297d0a73a2c4bd'],
  ['scripts/ci/ci-report-metadata-admission.mjs', '6e679597ccd5d0cc1d0b526ae78514a6d5efb14f'],
  ['scripts/ci/verify-ci-report-metadata.mjs', 'e787d4c2b2af30e4921b2db35cd2afc06d8cc891'],
  ['scripts/ci/test/ci-report-metadata.test.mjs', '9b9e89f2ea92cfa23293f664b72e931b306aa380'],
  ['.github/workflows/verify.yml', '7ee3a92cc71d817ffbafe4f43d4829ac01a56aac'],
].map(([file, oldBlob]) => ({ path: file, status: 'M', oldMode: '100644', newMode: '100644', oldBlob })));
export const CI_REPORT_METADATA_SOURCE_DELTA_PATHS = freeze(CI_REPORT_METADATA_SOURCE_DELTA_FILES.map(row => row.path));
export const CI_REPORT_METADATA_SAFETY_CASE_NAMES = freeze([
  '元数据修复复现原失败报告24个URL触发控制面拒绝',
  '元数据修复Source状态投影与完整历史CI证据连续绑定',
  '元数据修复直接Report摘要与当前完整CI证据连续绑定',
  '元数据修复未知字段URL与凭据不能进入状态摘要',
  '元数据修复Source十三路径与冻结角色模式完整准入',
  '元数据修复Source错误父链多父dirty及Git重定向拒绝',
  '元数据修复冻结Scope原001历史和产品字节不可漂移',
  '元数据修复Report唯一八路径父链模式与账本完整准入',
  '元数据修复摘要遗漏必需事实和CI证据digest漂移拒绝',
  '元数据修复真实路由Source需fresh工具Gate且坏报告不访问API',
  '元数据修复实际workflow镜像与两历史对象保持闭合',
  '元数据修复四workflow六job唯一新工具artifact producer闭合',
  '元数据修复失败重复retry与旧产品伪PASS不能取得复用',
  '元数据修复wholeZIP成员与三阶段raw及summary原字节连续绑定',
  '元数据修复旧Source1资格与新Source报告CI不能互相替代',
  '元数据修复复用捕获器有界退出完整raw与物理关闭',
]);
const fixedPins = freeze({
  oldScope: { path: MBM004_SCOPE_PATH, bytes: 26899, sha256: '7158eb8b33ed58de8a7c9f9ad3456fb372c65ebcc0f9fa7e0a491a248cc2a54d' },
  oldCorrection: { path: MBM004_CORRECTION_PATH, bytes: 4010, sha256: '4c7da837a75ded9bcb164ca8c1c33a48bef69577cdae1fe11c5d0512a0521a5c' },
  oldLocal: { path: 'docs/postrust/MBM-004/LOCAL_SOFTWARE_EVIDENCE.json', bytes: 1204380, sha256: '3b0bcfd27f2dff84937f7c776d94c55372eff6faff7c8b191befe7a45fbf6f1c' },
  oldCi: { path: CI_REPORT_METADATA_EVIDENCE_PATH, bytes: 1940776, sha256: 'b1ca308d724488d467369de91cc3fd6c6f10385c1ccda69d7134f26d62f0603c' },
});
export const CI_REPORT_METADATA_SOURCE1_CANONICAL = freeze({ bytes: 259414,
  sha256: 'd0c0e67153992239d2b277751c090178db5fbae7780366f4a81e5d767e70f9c4' });
export const CI_REPORT_METADATA_FROZEN_HISTORY = freeze([
  { path: CI_REPORT_MIRROR_CORRECTION_PATH, bytes: 2751, sha256: '54f433e6a766cd52de98cc3c52780a71e179f669544f16488e31165e6f65d6bf' },
  { path: CI_REPORT_MIRROR_SCOPE_PATH, bytes: 4599, sha256: 'fda50be2ca457dd601335bd56553c6a3ac4dadc12a40007154d26d9704074702' },
  { path: 'scripts/ci/ci-report-mirror-admission.mjs', bytes: 51638, sha256: 'e668fcfa9211073f7562814c9197399d817fddb7a6cfc2b80e95deff393782bb' },
  { path: 'scripts/ci/verify-ci-report-mirror.mjs', bytes: 29505, sha256: '619d477242dd4b6c13045b91819dbebad151e43b829f6184f74cd98d3d87c070' },
  { path: 'scripts/ci/test/ci-report-mirror.test.mjs', bytes: 41456, sha256: '939b3d01deb39acebb4c6a3d20da927193cdb382548c81949e2c3cbced2da9d7' },
  { path: 'scripts/ci/verify-control-plane.mjs', bytes: 7033, sha256: 'c2f4f6c2d3dd077be39fe6157114af7d8957ff271323a7c9d46aecc4092aa784' },
]);
const originalMetadataCorrectionIdentity = freeze({
  schema: 'musicbridge.ci-report-metadata.correction.v1', task: CI_REPORT_METADATA_TASK, branch: CI_REPORT_METADATA_BRANCH,
  baseSha: CI_REPORT_METADATA_BASE, historicalSource: CI_REPORT_METADATA_HISTORICAL_SOURCE,
  historicalBaseReport: CI_REPORT_MIRROR_BASE, productSource: CI_REPORT_METADATA_PRODUCT_SOURCE,
  predecessorSource: MBM004_PREDECESSOR_SOURCE, foundation: MBM004_BASE, scope: CI_REPORT_METADATA_SCOPE_PATH,
  repairKind: 'MACHINE_STATUS_PUBLIC_CI_IDENTITY_PROJECTION_ONLY',
  failure: { reportSha: CI_REPORT_METADATA_BASE, preserved: true, reason: 'status-secret-or-url',
    credentialPatternsMatched: false, publicAvatarQueryMatches: 16, publicNotificationsTemplateMatches: 8,
    security: { runId: 38123254259, jobId: 114422188105, stepName: 'Validate machine control state', stepNumber: 7 },
    verify: { runId: 38123254269, jobId: 114422188221, stepName: 'Validate control plane', stepNumber: 12 },
    audit: { jobId: 114422188379, conclusion: 'success' }, runAttempt: 1, event: 'push', toolGateRan: false, toolArtifacts: 0,
    receipt: { bytes: 59029, sha256: '0709e8be16c710a34ada34bd58148c7785f46e48336478ee22fc7af3146799ee' },
    diagnosis: { bytes: 7685, sha256: '933a6a5ec138867f119fa0044f87addb179a63621251b0992d4b6a43bc0abd27' } },
  historicalSourceCi: { path: CI_REPORT_METADATA_EVIDENCE_PATH, jsonPointer: '/ciRepair/sourceCi',
    raw: { bytes: 334184, sha256: 'fde4519142d448881701ea8c16009b2d3498917e4f322c518209bfe236aa786d' },
    canonical: CI_REPORT_METADATA_SOURCE1_CANONICAL, toolTests: 193, workflows: 4, jobs: 6, artifacts: 1,
    runIds: [38122949220, 38122949289, 38122949203, 38122949223],
    jobIds: [114421266400, 114421266547, 114421266621, 114421266399, 114421266311, 114421266343] },
  frozenHistory: CI_REPORT_METADATA_FROZEN_HISTORY,
  historicalObjects: CI_REPORT_MIRROR_CORRECTION_IDENTITY.historicalObjects,
  softwareReuse: { source: CI_REPORT_METADATA_PRODUCT_SOURCE, mode: 'EXACT_BYTES_AND_ORIGINAL_PRODUCERS',
    productTestsRepeated: false, compiledAppStatus: 'SKIPPED_REUSED_S165' },
  oldScope: fixedPins.oldScope, oldCorrection: fixedPins.oldCorrection, oldLocal: fixedPins.oldLocal,
  ledger: CI_REPORT_MIRROR_CORRECTION_IDENTITY.ledger,
  canonicalEncoding: 'RECURSIVE_SORTED_KEYS_ARRAY_ORDER_COMPACT_JSON_STRINGIFY_UTF8',
  budgets: { toolStageMs: 90000, toolWholeMs: 180000, productStageMs: 180000, productWholeMs: 480000, ownerMs: 2000 },
  sourceCi: { workflows: 4, jobs: 6, artifacts: 1 }, reportCi: { workflows: 2, jobs: 3, artifacts: 1 },
  toolGate: { stages: ['original-173', 'control-plane', 'metadata-safety'], originalTests: 173, safetyTests: 16, totalTapTests: 189 },
  reportPaths: CI_REPORT_METADATA_REPORT_PATHS, realEvidence: 'NOT_RUN',
});

export const CI_REPORT_METADATA_CORRECTION_IDENTITY = freeze({
  ...originalMetadataCorrectionIdentity,
  "sourceParentSha": CI_REPORT_METADATA_SOURCE_PARENT,
  "historicalFailedMetadataSource": {
    "source": "dfad0c8e0e0f906c3a7456b0151b3aaba7e5547c",
    "parent": "1b5345d13d9617c1770a361841d805305d06d038",
    "tree": "63afd77199f9655510e2f87c179999018b159dae",
    "scope": {
      "path": "docs/postrust/MBM-004/CI_REPORT_METADATA_SCOPE.json",
      "bytes": 4986,
      "sha256": "0d94617f5fb4a590849074b2c7a0a77c064bef0d5f2cbadfa7d7898f2a4fc778"
    },
    "correction": {
      "path": "docs/postrust/MBM-004/CI_REPORT_METADATA_CORRECTION.json",
      "bytes": 5475,
      "sha256": "d046e9688714ac14bc5b24d1cee776225963c15a0ad2a41084416ac7227f1eb5"
    },
    "sourceOwnCi": "FAILED",
    "report": null,
    "sourceFiles": [
      {
        "path": "tasks/CI-REPORT-METADATA-001.md",
        "status": "A",
        "oldMode": "000000",
        "newMode": "100644",
        "oldBlob": "0000000000000000000000000000000000000000",
        "bytes": 4783,
        "sha256": "f1566139b1424f8390aa27415af03b1bf622f11677d3cf48cd69b12dc5d36570"
      },
      {
        "path": "docs/postrust/MBM-004/CI_REPORT_METADATA_CORRECTION.json",
        "status": "A",
        "oldMode": "000000",
        "newMode": "100644",
        "oldBlob": "0000000000000000000000000000000000000000",
        "bytes": 5475,
        "sha256": "d046e9688714ac14bc5b24d1cee776225963c15a0ad2a41084416ac7227f1eb5"
      },
      {
        "path": "docs/postrust/MBM-004/CI_REPORT_METADATA_SCOPE.json",
        "status": "A",
        "oldMode": "000000",
        "newMode": "100644",
        "oldBlob": "0000000000000000000000000000000000000000",
        "bytes": 4986,
        "sha256": null
      },
      {
        "path": "scripts/ci/ci-report-metadata-admission.mjs",
        "status": "A",
        "oldMode": "000000",
        "newMode": "100644",
        "oldBlob": "0000000000000000000000000000000000000000",
        "bytes": 77093,
        "sha256": "ac8a251bd1ded6517bca5ff4ca0e92fabf46a71d741967783c7c7964ea9453b3"
      },
      {
        "path": "scripts/ci/verify-ci-report-metadata.mjs",
        "status": "A",
        "oldMode": "000000",
        "newMode": "100644",
        "oldBlob": "0000000000000000000000000000000000000000",
        "bytes": 18870,
        "sha256": "0475f3fac8c0137e27d5b2d80dc369afa4c77a888401527125c19ec3c13fc459"
      },
      {
        "path": "scripts/ci/test/ci-report-metadata.test.mjs",
        "status": "A",
        "oldMode": "000000",
        "newMode": "100644",
        "oldBlob": "0000000000000000000000000000000000000000",
        "bytes": 57841,
        "sha256": "fd9f81569142df60ad08cda649779da7c81e355e5d12d58fe7ea6efd94383612"
      },
      {
        "path": "scripts/ci/task-applicability.mjs",
        "status": "M",
        "oldMode": "100644",
        "newMode": "100644",
        "oldBlob": "8e97557b2b5c2eedec4c062b26a8e90e4bafdbbd",
        "bytes": 7495,
        "sha256": "d4a0835101911c833bf1b4372292b43f54fca2a68e6a6bf4e90aaa8bce0db28e"
      },
      {
        "path": "scripts/ci/report-only-admission.mjs",
        "status": "M",
        "oldMode": "100644",
        "newMode": "100644",
        "oldBlob": "9abd252db4560daaca039a9e5f7ab07a0f5f614e",
        "bytes": 29411,
        "sha256": "b9b6dc7755caabfa69e11d349be33ec589de9edb93bffac275e661e88c7f4c12"
      },
      {
        "path": ".github/workflows/verify.yml",
        "status": "M",
        "oldMode": "100644",
        "newMode": "100644",
        "oldBlob": "56b1c42e1fae7ff5f09edebe1d0a302fdad11f00",
        "bytes": 24686,
        "sha256": "b26ccbaac9c6669a7ccf2c742fc1857bbb8d6e88ef8ed23fb86ba2ca46b7de67"
      },
      {
        "path": ".github/workflows/security.yml",
        "status": "M",
        "oldMode": "100644",
        "newMode": "100644",
        "oldBlob": "ca19ad58e8285395e19b1f57c5327912e183dfe0",
        "bytes": 1895,
        "sha256": "e643e3e7e3af84045e9dbfa9cd0dc364e0f8ce53b0498a7777afc7c1f0aefe41"
      },
      {
        "path": ".github/workflows/rust-core.yml",
        "status": "M",
        "oldMode": "100644",
        "newMode": "100644",
        "oldBlob": "9b76f9588e62d169d6468527a06565df52a4863b",
        "bytes": 4193,
        "sha256": "c54547680db2db7acf33870ff556ca96754089306dcd25645568eb8259e36c65"
      },
      {
        "path": ".github/workflows/electron-e2e.yml",
        "status": "M",
        "oldMode": "100644",
        "newMode": "100644",
        "oldBlob": "666a0664915582bc9492a8af93e9c097a7e89cb4",
        "bytes": 9997,
        "sha256": "7a172406b41b6be8b3f564edb9d2b4dfd178304c2db491bb6729e0c7ef6ce69d"
      },
      {
        "path": "project/STATUS.json",
        "status": "M",
        "oldMode": "100644",
        "newMode": "100644",
        "oldBlob": "d43c0eeb212d23baf270a7775bec544a5a7d3fb2",
        "bytes": 2651788,
        "sha256": "2d0bea39a008809ec3e92321c139bbaa8d73031daa4de65cd0b7ddb513c1e69c"
      }
    ]
  },
  "fixtureFailure": {
    "sourceSha": "dfad0c8e0e0f906c3a7456b0151b3aaba7e5547c",
    "preserved": true,
    "reason": "LINUX_FIXTURE_BUILD_ROOT_EQUALS_CHECKED_MIRROR_PARENT",
    "actualFailedCase": 11,
    "actualFailureLocation": "scripts/ci/test/ci-report-metadata.test.mjs:541",
    "actualCall": "workflowMirror aggregate status",
    "actualStatus": 1,
    "expectedStatus": 0,
    "childStderrPresentInTap": false,
    "causalEvidence": "STATIC_ORIGINAL_STRICT_STORAGE_RULE_WITH_LINUX_POLICY_RED_GREEN_PROBE",
    "runAttempt": 1,
    "event": "push",
    "verify": {
      "runId": 38127156630,
      "jobId": 114433790261,
      "conclusion": "failure"
    },
    "otherJobsPassed": 5,
    "safetyCounts": {
      "tests": 16,
      "pass": 15,
      "fail": 1,
      "cancelled": 0,
      "skipped": 0,
      "todo": 0
    },
    "safetyDurationMs": 72539.47085700001,
    "wholeDurationMs": 86220.451768,
    "timedOut": false,
    "physicalShutdown": {
      "pidAbsent": true,
      "processGroupAbsent": true
    },
    "observedDescendantsAbsent": true,
    "receipt": {
      "bytes": 112838,
      "sha256": "f4a8210f29478e3b69c7273c3b1060470a31e6ae86fe9432e848e65d968442ff"
    },
    "diagnosis": {
      "bytes": 109272,
      "sha256": "50152e054b8403a01aaf3bb2b051155e6122bc86df41edf7bd99d92595f7923f"
    },
    "selectedRootRecords": 12,
    "selectedRangeBytes": 2549577,
    "wholeZipRead": false,
    "wholeZipDigestVerified": false,
    "successQualification": false,
    "platformArtifact": {
      "id": 11697892551,
      "bytes": 75949897,
      "members": 9645,
      "platformDeclaredSha256": "8d667d46a55d063f323b5c363e8cff16daf59e4a04d53fb17b3abf5690f5aac4"
    },
    "uploadCause": "FAILURE_OWNED_TMP_PRESERVED_AND_DIRECTORY_ALWAYS_UPLOADED"
  },
  "sourceDeltaPaths": CI_REPORT_METADATA_SOURCE_DELTA_PATHS,
  "fixtureRepair": {
    "approvedRoot": "PARENT_OF_MIRROR_PARENT",
    "linuxPolicyNegativeAndPositiveRequired": true,
    "realStages": [
      "REAL_METADATA_GUARD",
      "REAL_SOURCE_PINNED_MIRROR",
      "REAL_HISTORICAL_PREPARATION"
    ],
    "stageFailureRawRequired": true,
    "upload": "EXACT_TWELVE_ROOT_FILES_NO_TMP"
  },
  "sourceMachineState": {
    "path": "project/STATUS.json",
    "bytes": 2651788,
    "sha256": "2d0bea39a008809ec3e92321c139bbaa8d73031daa4de65cd0b7ddb513c1e69c"
  }
});

/** 摘要与报告共用既有UTF-8编码；digest只保存在摘要，不写回被摘要对象。 */
export function ciReportMetadataCanonicalPin(value) {
  const bytes = Buffer.from(JSON.stringify(canonical(value)), 'utf8');
  if (bytes.length > 16777216) fail('CI_REPORT_METADATA_CANONICAL_BUDGET');
  return { bytes: bytes.length, sha256: digest(bytes) };
}
export function assertCiReportMetadataCorrection(value) {
  if (!equal(value, CI_REPORT_METADATA_CORRECTION_IDENTITY)) fail('CI_REPORT_METADATA_CORRECTION_CHANGED');
  return value;
}
const metadataScopeHeader = freeze({ schema: 'musicbridge.ci-report-metadata.execution-scope.v1', task: CI_REPORT_METADATA_TASK,
  branch: CI_REPORT_METADATA_BRANCH, baseSha: CI_REPORT_METADATA_BASE, productSource: CI_REPORT_METADATA_PRODUCT_SOURCE,
  correction: CI_REPORT_METADATA_CORRECTION_PATH, frozen: true, reportPaths: CI_REPORT_METADATA_REPORT_PATHS });
function metadataScope(scope, scopeBytes, header, extraKeys = []) {
  if (!object(scope) || !equal(without(scope, ['files', ...extraKeys]), header) || !Array.isArray(scope.files)
    || scope.files.length !== CI_REPORT_METADATA_SOURCE_FILES.length) fail('CI_REPORT_METADATA_SCOPE_HEADER_OR_COUNT');
  const seen = new Set();
  for (const expected of CI_REPORT_METADATA_SOURCE_FILES) {
    const rows = scope.files.filter(row => row?.path === expected.path);
    if (rows.length !== 1) fail('CI_REPORT_METADATA_SCOPE_PATH_SET');
    const row = rows[0];
    if (!equal(without(row, ['oldBlob', 'bytes', 'sha256']), expected) || seen.has(row.path)
      || !positive(row.bytes) || row.bytes > 16777216 || !sha(row.oldBlob)
      || expected.status === 'A' && row.oldBlob !== zero || expected.status === 'M' && row.oldBlob === zero
      || (row.path === CI_REPORT_METADATA_SCOPE_PATH ? row.sha256 !== null : !/^[a-f0-9]{64}$/u.test(row.sha256 ?? '')))
      fail('CI_REPORT_METADATA_SCOPE_ROW_CHANGED');
    seen.add(row.path);
  }
  if (scopeBytes !== undefined && (!Buffer.isBuffer(scopeBytes)
    || scope.files.find(row => row.path === CI_REPORT_METADATA_SCOPE_PATH).bytes !== scopeBytes.length
    || !equal(parse(scopeBytes), scope))) fail('CI_REPORT_METADATA_SCOPE_SELF_LENGTH');
  return scope;
}
export function assertCiReportMetadataScope(scope, scopeBytes) {
  metadataScope(scope, scopeBytes, { ...metadataScopeHeader, sourceParentSha: CI_REPORT_METADATA_SOURCE_PARENT }, ['sourceDeltaFiles']);
  if (!equal(scope.sourceDeltaFiles, CI_REPORT_METADATA_SOURCE_DELTA_FILES)) fail('CI_REPORT_METADATA_SCOPE_DELTA_CHANGED');
  return scope;
}

const workflows = freeze(['.github/workflows/verify.yml', '.github/workflows/security.yml', '.github/workflows/rust-core.yml', '.github/workflows/electron-e2e.yml']);
const reuseName = '复用165已封存产品软件证据';
function publicReceipt(value) {
  return {
    schema: 'musicbridge.ci-report-metadata.public-producer.v1', status: value.status, phase: value.phase,
    task: value.task, revision: value.revision, branch: value.branch, repositoryId: value.repositoryId,
    workflows: workflows.map(file => {
      const run = value.runs.find(row => row.path === file), proof = value.proofs.find(row => row.runId === run.id);
      return { path: file, runId: run.id, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion,
        jobs: [...proof.jobs].sort((a, b) => a.id - b.id).map(job => ({ jobId: job.id, name: job.name, status: job.status, conclusion: job.conclusion })) };
    }),
    logs: [...value.logs].sort((a, b) => a.jobId - b.jobId).map(log => ({ runId: log.runId, jobId: log.jobId,
      bytes: log.raw.bytes, sha256: log.raw.sha256 })),
    artifacts: value.artifacts.map(artifact => ({ artifactId: artifact.id, name: artifact.name,
      bytes: artifact.zip.bytes, sha256: artifact.zip.sha256, allMembersBytesAndCrcRead: artifact.allMembersBytesAndCrcRead,
      memberManifest: { count: artifact.members.length, expandedBytes: artifact.expandedBytes,
        canonical: ciReportMetadataCanonicalPin(artifact.members) },
      summary: { path: artifact.toolContent.entry, ...artifact.members.find(row => row.path === artifact.toolContent.entry) },
      originalTests: artifact.toolContent.result.originalTests, safetyTests: artifact.toolContent.result.safetyTests,
      totalTapTests: artifact.toolContent.result.expectedToolTests })),
    softwareReuse: 'EXACT_BYTES_AND_ORIGINAL_PRODUCERS', productSource: value.oldProductSource,
    compiledAndApp: value.compiledAndApp, currentProductTestsRepeated: false,
    realApplicationServiceDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN',
  };
}
export function ciReportMetadataHistoricalSourceProjection(sourceCi) {
  if (!validateCiReportMirrorSourceReceipt(sourceCi, CI_REPORT_METADATA_HISTORICAL_SOURCE)
    || !equal(ciReportMetadataCanonicalPin(sourceCi), CI_REPORT_METADATA_SOURCE1_CANONICAL))
    fail('CI_REPORT_METADATA_HISTORICAL_SOURCE_CI_CHANGED');
  const result = { ...publicReceipt(sourceCi), fullObject: { path: CI_REPORT_METADATA_EVIDENCE_PATH,
    jsonPointer: '/ciRepair/sourceCi', ...CI_REPORT_METADATA_SOURCE1_CANONICAL } };
  assertPublic(result); return result;
}
export function ciReportMetadataReportIdentity(sourceSha, sourceCi) {
  return { task: CI_REPORT_METADATA_TASK, branch: CI_REPORT_METADATA_BRANCH, baseReport: CI_REPORT_METADATA_BASE,
    sourceSha, sourceParentSha: CI_REPORT_METADATA_SOURCE_PARENT,
    productSource: CI_REPORT_METADATA_PRODUCT_SOURCE, scope: CI_REPORT_METADATA_SCOPE_PATH,
    failedReportPreserved: true, softwareReuse: 'EXACT_BYTES_AND_ORIGINAL_PRODUCERS', currentProductTestsRepeated: false,
    currentToolGateRequired: true, realEvidence: 'NOT_RUN', sourceCi, reportSha: null, reportCi: null,
    reportCommitResolution: 'EXACT_DIRECT_CHILD_OF_SOURCE', ownerAcceptance: 'NOT_RUN' };
}
export function ciReportMetadataReportProjection(identity) {
  if (!object(identity) || !equal(identity, ciReportMetadataReportIdentity(identity.sourceSha, identity.sourceCi))
    || !validateCiReportMetadataSourceReceipt(identity.sourceCi, identity.sourceSha)) fail('CI_REPORT_METADATA_REPORT_IDENTITY_INVALID');
  const result = { ...without(identity, ['sourceCi']), schema: 'musicbridge.ci-report-metadata.public-report.v1',
    sourceCi: publicReceipt(identity.sourceCi), fullObject: { path: CI_REPORT_METADATA_EVIDENCE_PATH,
      jsonPointer: '/ciReportMetadata', ...ciReportMetadataCanonicalPin(identity) } };
  assertPublic(result); return result;
}
function assertPublic(value) {
  const text = JSON.stringify(value);
  if (/https?:\/\//iu.test(text) || /(NETEASE_COOKIE|MUSIC_U|__csrf)\s*[:=]\s*[^,}]+/iu.test(text)
    || /Bearer\s+[A-Za-z0-9]/iu.test(text)) fail('CI_REPORT_METADATA_PUBLIC_SUMMARY_UNSAFE');
}

function gitContext(directory, env, options = {}) {
  if (!object(options) || Object.keys(options).some(key => key !== 'deadline')) fail('CI_REPORT_METADATA_ADMISSION_BUDGET');
  const now = performance.now(), deadline = options.deadline ?? now + 60000;
  if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 180000) fail('CI_REPORT_METADATA_ADMISSION_BUDGET');
  if (process.versions.node.split('.')[0] !== '22' || !['darwin', 'linux'].includes(process.platform)
    || env.NODE_OPTIONS || env.NODE_PATH) fail('CI_REPORT_METADATA_NODE_CONTEXT_REJECTED');
  const check = () => { if (performance.now() >= deadline) fail('CI_REPORT_METADATA_ADMISSION_BUDGET'); };
  check();
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || realpathSync(directory) !== directory)
    fail('CI_REPORT_METADATA_DIRECTORY_NOT_CANONICAL');
  const gitEnvironment = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnvironment, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  const git = (args, input) => {
    check();
    try { const bytes = execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args],
      { cwd: directory, env: gitEnvironment, input,
        timeout: Math.min(10000, Math.max(1, Math.ceil(deadline - performance.now()))),
        killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); check(); return bytes; }
    catch { fail('CI_REPORT_METADATA_GIT_READ_FAILED'); }
  };
  const text = args => new TextDecoder('utf-8', { fatal: true }).decode(git(args)).trim();
  if (text(['rev-parse', '--show-toplevel']) !== directory || text(['rev-parse', '--is-shallow-repository']) !== 'false'
    || text(['for-each-ref', '--format=%(refname)', 'refs/replace'])) fail('CI_REPORT_METADATA_GIT_OVERLAY_OR_SHALLOW');
  const commonDir = text(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonDir !== path.join(directory, '.git') || text(['rev-parse', '--path-format=absolute', '--git-dir']) !== commonDir
    || !lstatSync(commonDir).isDirectory() || lstatSync(commonDir).isSymbolicLink()
    || realpathSync(commonDir) !== commonDir) fail('CI_REPORT_METADATA_INDEPENDENT_GIT_REQUIRED');
  for (const name of ['info/grafts', 'shallow', 'objects/info/alternates', 'objects/info/http-alternates']) {
    const filename = text(['rev-parse', '--path-format=absolute', '--git-path', name]);
    if (existsSync(filename)) fail('CI_REPORT_METADATA_GIT_OVERLAY_OR_SHALLOW');
  }
  const flags = git(['ls-files', '-v', '-z']).toString('utf8').split('\0').filter(Boolean);
  if (flags.some(row => !row.startsWith('H '))) fail('CI_REPORT_METADATA_INDEX_FLAGS');
  const head = text(['rev-parse', 'HEAD']), actualBranch = text(['branch', '--show-current']);
  const branch = actualBranch || env.GITHUB_REF_NAME;
  if (!sha(head) || branch !== CI_REPORT_METADATA_BRANCH || env.GITHUB_SHA && env.GITHUB_SHA !== head
    || env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF_NAME !== CI_REPORT_METADATA_BRANCH
    || text(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) fail('CI_REPORT_METADATA_HEAD_BRANCH_OR_CLEAN');
  // 只在这次真实Git读取内复用完整OID；资格、worktree字节和期限均不跨context复用。
  return { directory, env, git, text, head, branch, deadline, check,
    trees: new Map(), blobs: new Map(), cachedBlobBytes: 0 };
}
function tree(context, revision) {
  context.check();
  if (!sha(revision)) fail('CI_REPORT_METADATA_IMMUTABLE_REVISION_REQUIRED');
  if (context.trees.has(revision)) return context.trees.get(revision);
  const result = new Map();
  for (const row of context.git(['ls-tree', '-r', '-z', revision]).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/u.exec(row);
    if (!match || !relative(match[3]) || result.has(match[3])) fail('CI_REPORT_METADATA_TREE_NOT_CLOSED');
    result.set(match[3], { path: match[3], mode: match[1], blob: match[2] });
  }
  if (!result.size || result.size > 32768) fail('CI_REPORT_METADATA_TREE_BUDGET');
  context.check(); context.trees.set(revision, result);
  return result;
}
function rawDiff(context, before, after) {
  const parts = context.git(['diff', '--raw', '--no-abbrev', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', before, after])
    .toString('utf8').split('\0');
  if (parts.pop() !== '' || parts.length % 2) fail('CI_REPORT_METADATA_RAW_DIFF_INVALID');
  const seen = new Set(), rows = [];
  for (let index = 0; index < parts.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AM])$/u.exec(parts[index]), file = parts[index + 1];
    if (!match || !relative(file) || seen.has(file)) fail('CI_REPORT_METADATA_RAW_DIFF_INVALID');
    seen.add(file); rows.push({ path: file, oldMode: match[1], newMode: match[2], oldBlob: match[3], newBlob: match[4], status: match[5] });
  }
  return rows;
}
function exactDiff(rows, expected, code) {
  if (rows.length !== expected.length || expected.some(want => {
    const matching = rows.filter(row => row.path === want.path);
    return matching.length !== 1 || Object.entries(want).some(([key, value]) => matching[0][key] !== value);
  })) fail(code);
}
function parents(context, revision, parent) {
  if (!equal(context.text(['rev-list', '--parents', '-n', '1', revision]).split(' '), [revision, parent]))
    fail('CI_REPORT_METADATA_UNIQUE_PARENT_CHANGED');
}
function cacheBlob(context, oid, bytes) {
  context.check();
  if (!sha(oid) || bytes.length > 67108864
    || createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== oid)
    fail('CI_REPORT_METADATA_IMMUTABLE_BLOB_OID_CHANGED');
  const previous = context.blobs.get(oid);
  if (previous) {
    if (!previous.equals(bytes)) fail('CI_REPORT_METADATA_IMMUTABLE_BLOB_CHANGED');
    return previous;
  }
  if (context.cachedBlobBytes + bytes.length > 67108864) fail('CI_REPORT_METADATA_BLOB_CACHE_BUDGET');
  context.cachedBlobBytes += bytes.length; context.blobs.set(oid, bytes);
  return bytes;
}
function blob(context, revision, file) {
  context.check();
  if (!relative(file)) fail('CI_REPORT_METADATA_IMMUTABLE_BLOB_PATH_INVALID');
  const entry = tree(context, revision).get(file);
  if (!entry) fail('CI_REPORT_METADATA_IMMUTABLE_BLOB_MISSING');
  return context.blobs.get(entry.blob) ?? cacheBlob(context, entry.blob, context.git(['show', revision + ':' + file]));
}
/** 原114+111与冻结失败Source13分别闭集批读；仅在本context按完整OID去重。 */
function scopeBlobs(context, records, expectedCount = 225) {
  context.check();
  if (![13, 225].includes(expectedCount) || !Array.isArray(records) || records.length !== expectedCount)
    fail('CI_REPORT_METADATA_SCOPE_BATCH_COUNT');
  const pending = new Map();
  for (const { row, entry } of records) {
    if (!entry || entry.mode !== '100644' || !sha(entry.blob) || !positive(row.bytes)
      || row.bytes > 16777216) fail('CI_REPORT_METADATA_PRODUCT_SCOPE_PIN_CHANGED');
    if (context.blobs.has(entry.blob)) continue;
    const previous = pending.get(entry.blob);
    if (previous !== undefined && previous !== row.bytes) fail('CI_REPORT_METADATA_SCOPE_BATCH_LENGTH_CHANGED');
    pending.set(entry.blob, row.bytes);
  }
  const requests = [...pending];
  const maximum = requests.reduce((total, [, bytes]) => total + bytes + 128, 0);
  if (maximum > 67108864 || requests.length > expectedCount) fail('CI_REPORT_METADATA_SCOPE_BATCH_BUDGET');
  if (requests.length) {
    const input = Buffer.from(requests.map(([oid]) => oid + '\n').join(''), 'ascii');
    const output = context.git(['cat-file', '--batch'], input);
    if (output.length > maximum) fail('CI_REPORT_METADATA_SCOPE_BATCH_BUDGET');
    let offset = 0;
    for (const [oid, expectedBytes] of requests) {
      context.check();
      const newline = output.indexOf(10, offset);
      if (newline < offset || newline - offset > 127) fail('CI_REPORT_METADATA_SCOPE_BATCH_HEADER');
      const header = output.subarray(offset, newline).toString('ascii');
      const expectedHeader = oid + ' blob ' + expectedBytes;
      // 原字节逐项相等，拒绝missing/type/乱序/非规范size及非ASCII伪header。
      if (!output.subarray(offset, newline).equals(Buffer.from(expectedHeader, 'ascii')) || header !== expectedHeader)
        fail('CI_REPORT_METADATA_SCOPE_BATCH_HEADER');
      const start = newline + 1, end = start + expectedBytes;
      if (end >= output.length || output[end] !== 10) fail('CI_REPORT_METADATA_SCOPE_BATCH_TRUNCATED');
      cacheBlob(context, oid, output.subarray(start, end)); offset = end + 1;
    }
    if (offset !== output.length) fail('CI_REPORT_METADATA_SCOPE_BATCH_TRAILING_BYTES');
  }
  context.check();
}
function pinObject(context, revision, pin) {
  const bytes = blob(context, revision, pin.path);
  if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256
    || tree(context, revision).get(pin.path)?.mode !== '100644') fail('CI_REPORT_METADATA_FIXED_PRODUCT_PIN_CHANGED');
  return bytes;
}
function readWhole(filename, check) {
  check();
  if (realpathSync(filename) !== filename) fail('CI_REPORT_METADATA_FILE_NOT_CANONICAL');
  const named = lstatSync(filename, { bigint: true }), fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = fstatSync(fd, { bigint: true });
    const stable = row => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'].every(key => row[key] === first[key]);
    if (!first.isFile() || first.size < 0n || first.size > 67108864n || !stable(named)) fail('CI_REPORT_METADATA_FILE_KIND_OR_BUDGET');
    const bytes = Buffer.alloc(Number(first.size)); let offset = 0;
    while (offset < bytes.length) { check(); const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), null);
      if (!count) fail('CI_REPORT_METADATA_FILE_TRUNCATED'); offset += count; }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) || !stable(fstatSync(fd, { bigint: true }))
      || !stable(lstatSync(filename, { bigint: true }))) fail('CI_REPORT_METADATA_FILE_CHANGED_DURING_READ');
    return bytes;
  } finally { closeSync(fd); }
}
/** status之外实读所有tracked字节，拒绝assume-unchanged、稀疏索引或mode隐藏。 */
function snapshot(context) {
  if (context.text(['rev-parse', 'HEAD']) !== context.head
    || context.text(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) fail('CI_REPORT_METADATA_ADMISSION_DRIFT');
  const rows = tree(context, context.head), hasher = createHash('sha256'); let total = 0;
  for (const row of rows.values()) {
    context.check();
    const filename = path.join(context.directory, row.path), stat = lstatSync(filename);
    let bytes;
    if (row.mode === '120000') {
      if (!stat.isSymbolicLink() || realpathSync(path.dirname(filename)) !== path.dirname(filename)) fail('CI_REPORT_METADATA_SYMLINK_CHANGED');
      bytes = Buffer.from(readlinkSync(filename));
    } else {
      if (!stat.isFile() || Boolean(stat.mode & 0o111) !== (row.mode === '100755')) fail('CI_REPORT_METADATA_FILE_MODE_CHANGED');
      bytes = readWhole(filename, context.check);
    }
    total += bytes.length;
    if (total > 536870912 || createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== row.blob)
      fail('CI_REPORT_METADATA_WORKTREE_BYTES_OR_BUDGET');
    hasher.update(row.path + '\0' + row.mode + '\0' + row.blob + '\0' + digest(bytes) + '\0');
  }
  return { head: context.head, tree: context.text(['rev-parse', context.head + '^{tree}']),
    trackedFiles: rows.size, trackedBytes: total, sha256: hasher.digest('hex') };
}
function sameOutside(context, before, after, allowed) {
  const left = tree(context, before), right = tree(context, after), names = new Set([...left.keys(), ...right.keys()]);
  for (const name of names) if (!allowed.has(name) && !equal(left.get(name), right.get(name))) fail('CI_REPORT_METADATA_PROTECTED_TREE_CHANGED');
}
function originalProduct(context) {
  parents(context, CI_REPORT_MIRROR_BASE, CI_REPORT_MIRROR_PRODUCT_SOURCE);
  parents(context, CI_REPORT_MIRROR_PRODUCT_SOURCE, MBM004_PREDECESSOR_SOURCE);
  parents(context, MBM004_PREDECESSOR_SOURCE, MBM004_BASE);
  const source = CI_REPORT_MIRROR_PRODUCT_SOURCE;
  for (const pin of [fixedPins.oldScope, fixedPins.oldCorrection, fixedPins.oldLocal]) pinObject(context, source, pin);
  const scope = validateMbm004Scope(parse(blob(context, source, MBM004_SCOPE_PATH)));
  const correction = validateMbm004Correction(parse(blob(context, source, MBM004_CORRECTION_PATH)));
  const oldBytes = pinObject(context, MBM004_PREDECESSOR_SOURCE, correction.predecessorScope);
  const oldScope = validateMbm004Scope(parse(oldBytes));
  if (scope.files.length !== 114 || oldScope.files.length !== 111 || oldScope.sourceCorrection !== undefined)
    fail('CI_REPORT_METADATA_ORIGINAL_SCOPE_CHANGED');
  assertMbm004CorrectionScope(oldScope, scope);
  const expectedRows = scope.files.map(row => ({ path: row.path, status: row.status, oldMode: row.status === 'A' ? '000000' : '100644', newMode: '100644' }));
  exactDiff(rawDiff(context, MBM004_BASE, source), [...expectedRows,
    { path: MBM004_SCOPE_PATH, status: 'A', oldMode: '000000', newMode: '100644' }], 'CI_REPORT_METADATA_ORIGINAL_SOURCE_CUMULATIVE_DIFF');
  exactDiff(rawDiff(context, MBM004_BASE, MBM004_PREDECESSOR_SOURCE), oldScope.files.map(row =>
    ({ path: row.path, status: row.status, oldMode: row.status === 'A' ? '000000' : '100644', newMode: '100644' }))
    .concat([{ path: MBM004_SCOPE_PATH, status: 'A', oldMode: '000000', newMode: '100644' }]), 'CI_REPORT_METADATA_PREDECESSOR_DIFF');
  exactDiff(rawDiff(context, MBM004_PREDECESSOR_SOURCE, source), correction.repairPaths.map(file =>
    ({ path: file, status: 'M', oldMode: '100644', newMode: '100644' })).concat([
    { path: MBM004_SCOPE_PATH, status: 'M', oldMode: '100644', newMode: '100644' },
    { path: MBM004_CORRECTION_PATH, status: 'A', oldMode: '000000', newMode: '100644' }]), 'CI_REPORT_METADATA_PRODUCT_REPAIR_DIFF');
  const sourceTree = tree(context, source), oldTree = tree(context, MBM004_PREDECESSOR_SOURCE);
  const records = scope.files.map(row => ({ row, entry: sourceTree.get(row.path) }))
    .concat(oldScope.files.map(row => ({ row, entry: oldTree.get(row.path) })));
  scopeBlobs(context, records);
  for (const { row, entry } of records) {
    context.check(); const bytes = context.blobs.get(entry.blob);
    if (!bytes || bytes.length !== row.bytes || digest(bytes) !== row.sha256 || entry.mode !== '100644')
      fail('CI_REPORT_METADATA_PRODUCT_SCOPE_PIN_CHANGED');
  }
  pinObject(context, source, MBM004_CANONICAL);
  if (!blob(context, source, MBM004_CANONICAL.path).equals(blob(context, MBM004_BASE, MBM004_CANONICAL.path))) fail('CI_REPORT_METADATA_CANONICAL_CHANGED');
  const status = parse(blob(context, source, 'project/STATUS.json')), plan = parse(blob(context, source, 'project/POSTRUST_PLAN.json'));
  assertMbm004Metadata(status, plan);
  assertMbm004PredecessorMetadata(parse(blob(context, MBM004_BASE, 'project/STATUS.json')), status,
    parse(blob(context, MBM004_BASE, 'project/POSTRUST_PLAN.json')), plan);
  const reportDiff = rawDiff(context, source, CI_REPORT_MIRROR_BASE);
  if (reportDiff.length !== 8 || reportDiff.some(row => !CI_REPORT_MIRROR_REPORT_PATHS.includes(row.path)
    || row.newMode !== '100644' || row.oldMode !== (row.status === 'A' ? '000000' : '100644')))
    fail('CI_REPORT_METADATA_ORIGINAL_REPORT_DIFF');
  sameOutside(context, source, CI_REPORT_MIRROR_BASE, new Set(CI_REPORT_MIRROR_REPORT_PATHS));
  const originalCi = parse(pinObject(context, CI_REPORT_MIRROR_BASE, fixedPins.oldCi));
  if (originalCi.source !== source || originalCi.repositoryId !== repositoryId || originalCi.branch !== MBM004_BRANCH
    || !validateMobileContentParentCi({ task: MBM004_TASK, repositoryId, parent: source, branch: MBM004_BRANCH,
      runs: originalCi.firstNaturalRuns, proofs: originalCi.producerProofs, now: Date.parse(originalCi.recordedAt) }))
    fail('CI_REPORT_METADATA_ORIGINAL_PRODUCT_PRODUCERS_NOT_PROVEN');
  const exclusions = new Set([...CI_REPORT_MIRROR_SOURCE_FILES.map(row => row.path), ...CI_REPORT_MIRROR_REPORT_PATHS]);
  const productFingerprint = digest(Buffer.from(JSON.stringify([...sourceTree.values()].filter(row => !exclusions.has(row.path)))));
  return { productFingerprint, oldProductCi: fixedPins.oldCi, originalScopeFiles: 114,
    originalAggregateFiles: 115, originalProductWorkflows: 4, originalProductJobs: 6, originalProductArtifacts: 5 };
}

function jsonDomain(value, file) {
  if (!object(value)) fail('CI_REPORT_METADATA_JSON_DOMAIN_INVALID');
  if (file === 'project/STATUS.json') {
    if (!object(value.mobileContentMultidevice)) fail('CI_REPORT_METADATA_STATUS_DOMAIN_MISSING');
    return value.mobileContentMultidevice;
  }
  if (file === 'project/POSTRUST_PLAN.json') {
    const rows = value.mobile_tasks?.filter(row => row?.id === MBM004_TASK);
    if (rows?.length !== 1 || !object(rows[0])) fail('CI_REPORT_METADATA_TASK_ROW_AMBIGUOUS');
    return rows[0];
  }
  return value;
}
/** 001已冻结，只读它的精确原Source/Report对象，不将当前HEAD冒充旧001资格。 */
function historicalIdentity(context) {
  parents(context, CI_REPORT_METADATA_BASE, CI_REPORT_METADATA_HISTORICAL_SOURCE);
  parents(context, CI_REPORT_METADATA_HISTORICAL_SOURCE, CI_REPORT_MIRROR_BASE);
  const scopeBytes = blob(context, CI_REPORT_METADATA_HISTORICAL_SOURCE, CI_REPORT_MIRROR_SCOPE_PATH);
  const scope = assertCiReportMirrorScope(parse(scopeBytes), scopeBytes);
  assertCiReportMirrorCorrection(parse(blob(context, CI_REPORT_METADATA_HISTORICAL_SOURCE, CI_REPORT_MIRROR_CORRECTION_PATH)));
  const changes = rawDiff(context, CI_REPORT_MIRROR_BASE, CI_REPORT_METADATA_HISTORICAL_SOURCE);
  exactDiff(changes, CI_REPORT_MIRROR_SOURCE_FILES.map(row => without(row, ['role'])), 'CI_REPORT_METADATA_HISTORICAL_SOURCE_DIFF');
  for (const row of scope.files) {
    const change = changes.find(entry => entry.path === row.path), bytes = blob(context, CI_REPORT_METADATA_HISTORICAL_SOURCE, row.path);
    if (change.oldBlob !== row.oldBlob || (tree(context, CI_REPORT_MIRROR_BASE).get(row.path)?.blob ?? zero) !== row.oldBlob
      || tree(context, CI_REPORT_METADATA_HISTORICAL_SOURCE).get(row.path)?.mode !== row.newMode
      || bytes.length !== row.bytes || row.path !== CI_REPORT_MIRROR_SCOPE_PATH && digest(bytes) !== row.sha256)
      fail('CI_REPORT_METADATA_HISTORICAL_SCOPE_PIN_CHANGED');
  }
  sameOutside(context, CI_REPORT_MIRROR_BASE, CI_REPORT_METADATA_HISTORICAL_SOURCE, new Set(CI_REPORT_MIRROR_SOURCE_FILES.map(row => row.path)));
  exactDiff(rawDiff(context, CI_REPORT_METADATA_HISTORICAL_SOURCE, CI_REPORT_METADATA_BASE),
    CI_REPORT_METADATA_REPORT_PATHS.map(file => ({ path: file, status: 'M', oldMode: '100644', newMode: '100644' })),
    'CI_REPORT_METADATA_HISTORICAL_REPORT_DIFF');
  for (const file of CI_REPORT_METADATA_REPORT_PATHS) {
    const before = blob(context, CI_REPORT_METADATA_HISTORICAL_SOURCE, file), after = blob(context, CI_REPORT_METADATA_BASE, file);
    if (file.endsWith('.md')) {
      if (after.length <= before.length || after.length - before.length > 131072 || !after.subarray(0, before.length).equals(before)
        || !after.subarray(before.length).toString('utf8').includes('CI_REPORT_MIRROR_001'))
        fail('CI_REPORT_METADATA_HISTORICAL_REPORT_APPEND_CHANGED');
      continue;
    }
    const oldJson = parse(before), newJson = parse(after), oldDomain = jsonDomain(oldJson, file), newDomain = jsonDomain(newJson, file);
    if (Object.hasOwn(oldDomain, 'ciRepair') || !object(newDomain.ciRepair)
      || !equal(newDomain.ciRepair, ciReportMirrorReportIdentity(CI_REPORT_METADATA_HISTORICAL_SOURCE, newDomain.ciRepair.sourceCi)))
      fail('CI_REPORT_METADATA_HISTORICAL_REPORT_DOMAIN_CHANGED');
    ciReportMetadataHistoricalSourceProjection(newDomain.ciRepair.sourceCi);
    delete newDomain.ciRepair;
    if (!equal(oldJson, newJson)) fail('CI_REPORT_METADATA_HISTORICAL_REPORT_OLD_SEMANTICS_CHANGED');
  }
  sameOutside(context, CI_REPORT_METADATA_HISTORICAL_SOURCE, CI_REPORT_METADATA_BASE, new Set(CI_REPORT_METADATA_REPORT_PATHS));
  for (const pin of CI_REPORT_METADATA_FROZEN_HISTORY) {
    pinObject(context, CI_REPORT_METADATA_HISTORICAL_SOURCE, pin);
    pinObject(context, CI_REPORT_METADATA_BASE, pin);
    pinObject(context, context.head, pin);
  }
  return { historicalSource: CI_REPORT_METADATA_HISTORICAL_SOURCE, historicalReport: CI_REPORT_METADATA_BASE,
    historicalToolTests: 193, historicalSourceCiCanonical: CI_REPORT_METADATA_SOURCE1_CANONICAL,
    historicalFailurePreserved: true, historicalSourceCi: CI_REPORT_METADATA_CORRECTION_IDENTITY.historicalSourceCi };
}
/** 原失败Source的tree与十三叶独立冻结，旧Scope自身null摘要由固定原始pin补核。 */
function failedMetadataIdentity(context) {
  const failed = CI_REPORT_METADATA_CORRECTION_IDENTITY.historicalFailedMetadataSource;
  parents(context, CI_REPORT_METADATA_SOURCE_PARENT, CI_REPORT_METADATA_BASE);
  if (context.text(['rev-parse', CI_REPORT_METADATA_SOURCE_PARENT + '^{tree}']) !== failed.tree)
    fail('CI_REPORT_METADATA_FAILED_SOURCE_TREE_CHANGED');
  const failedTree = tree(context, CI_REPORT_METADATA_SOURCE_PARENT), baseTree = tree(context, CI_REPORT_METADATA_BASE);
  scopeBlobs(context, failed.sourceFiles.map(row => ({ row, entry: failedTree.get(row.path) })), 13);
  const scopeBytes = pinObject(context, CI_REPORT_METADATA_SOURCE_PARENT, failed.scope);
  const scope = metadataScope(parse(scopeBytes), scopeBytes, metadataScopeHeader);
  if (!equal(parse(pinObject(context, CI_REPORT_METADATA_SOURCE_PARENT, failed.correction)), originalMetadataCorrectionIdentity))
    fail('CI_REPORT_METADATA_FAILED_SOURCE_CORRECTION_CHANGED');
  const changes = rawDiff(context, CI_REPORT_METADATA_BASE, CI_REPORT_METADATA_SOURCE_PARENT);
  exactDiff(changes, failed.sourceFiles.map(row => without(row, ['bytes', 'sha256'])), 'CI_REPORT_METADATA_FAILED_SOURCE_PATHS_CHANGED');
  for (const row of failed.sourceFiles) {
    const expected = CI_REPORT_METADATA_SOURCE_FILES.find(entry => entry.path === row.path);
    if (!equal(scope.files.find(entry => entry.path === row.path), { ...row, role: expected.role })
      || (baseTree.get(row.path)?.blob ?? zero) !== row.oldBlob || failedTree.get(row.path)?.mode !== row.newMode)
      fail('CI_REPORT_METADATA_FAILED_SOURCE_SCOPE_CHANGED');
    pinObject(context, CI_REPORT_METADATA_SOURCE_PARENT, row.path === CI_REPORT_METADATA_SCOPE_PATH ? failed.scope : row);
  }
  sameOutside(context, CI_REPORT_METADATA_BASE, CI_REPORT_METADATA_SOURCE_PARENT,
    new Set(CI_REPORT_METADATA_SOURCE_FILES.map(row => row.path)));
  return { historicalFailedMetadataSourcePreserved: true };
}
function encodingProof(context, revision, role) {
  const statusBytes = blob(context, revision, 'project/STATUS.json'), evidenceBytes = blob(context, revision, CI_REPORT_METADATA_EVIDENCE_PATH);
  const status = parse(statusBytes), evidence = parse(evidenceBytes), domain = jsonDomain(status, 'project/STATUS.json');
  if (!object(domain.ciRepair) || !object(evidence.ciRepair)) fail('CI_REPORT_METADATA_SOURCE1_REFERENCE_MISSING');
  const oldProjection = ciReportMetadataHistoricalSourceProjection(evidence.ciRepair.sourceCi);
  if (!equal(domain.ciRepair.sourceCi, oldProjection)) fail('CI_REPORT_METADATA_SOURCE1_PROJECTION_CHANGED');
  let full = evidence.ciRepair.sourceCi, projection = oldProjection, pointer = '/ciRepair/sourceCi';
  if (role === 'report') {
    full = evidence.ciReportMetadata;
    projection = ciReportMetadataReportProjection(full); pointer = '/ciReportMetadata';
    if (!equal(domain.ciReportMetadata, projection)) fail('CI_REPORT_METADATA_REPORT_PROJECTION_CHANGED');
  } else if (Object.hasOwn(domain, 'ciReportMetadata') || Object.hasOwn(evidence, 'ciReportMetadata')) {
    fail('CI_REPORT_METADATA_SOURCE_CONTAINS_REPORT_STATE');
  }
  return { status: { path: 'project/STATUS.json', bytes: statusBytes.length, sha256: digest(statusBytes) },
    evidence: { path: CI_REPORT_METADATA_EVIDENCE_PATH, bytes: evidenceBytes.length, sha256: digest(evidenceBytes) },
    jsonPointer: pointer, canonical: ciReportMetadataCanonicalPin(full), publicSummaryCanonical: ciReportMetadataCanonicalPin(projection) };
}
function sourceObject(context, sourceSha) {
  parents(context, sourceSha, CI_REPORT_METADATA_SOURCE_PARENT);
  const scopeBytes = blob(context, sourceSha, CI_REPORT_METADATA_SCOPE_PATH), scope = assertCiReportMetadataScope(parse(scopeBytes), scopeBytes);
  assertCiReportMetadataCorrection(parse(blob(context, sourceSha, CI_REPORT_METADATA_CORRECTION_PATH)));
  exactDiff(rawDiff(context, CI_REPORT_METADATA_SOURCE_PARENT, sourceSha), CI_REPORT_METADATA_SOURCE_DELTA_FILES,
    'CI_REPORT_METADATA_SOURCE_DELTA_NOT_EXACT');
  const changes = rawDiff(context, CI_REPORT_METADATA_BASE, sourceSha);
  exactDiff(changes, CI_REPORT_METADATA_SOURCE_FILES.map(row => without(row, ['role'])), 'CI_REPORT_METADATA_SOURCE_PATHS_NOT_EXACT');
  const sourceTree = tree(context, sourceSha), baseTree = tree(context, CI_REPORT_METADATA_BASE);
  for (const row of scope.files) {
    const change = changes.find(entry => entry.path === row.path), bytes = blob(context, sourceSha, row.path);
    if (change.oldBlob !== row.oldBlob || sourceTree.get(row.path)?.mode !== row.newMode
      || (baseTree.get(row.path)?.blob ?? zero) !== row.oldBlob || bytes.length !== row.bytes
      || row.path !== CI_REPORT_METADATA_SCOPE_PATH && digest(bytes) !== row.sha256) fail('CI_REPORT_METADATA_SOURCE_SCOPE_PIN_CHANGED');
  }
  const oldStatus = parse(blob(context, CI_REPORT_METADATA_BASE, 'project/STATUS.json'));
  const newStatus = parse(blob(context, sourceSha, 'project/STATUS.json'));
  const oldDomain = jsonDomain(oldStatus, 'project/STATUS.json'), newDomain = jsonDomain(newStatus, 'project/STATUS.json');
  if (!object(oldDomain.ciRepair) || !object(newDomain.ciRepair)) fail('CI_REPORT_METADATA_SOURCE_STATUS_DOMAIN_CHANGED');
  const full = parse(blob(context, CI_REPORT_METADATA_BASE, CI_REPORT_METADATA_EVIDENCE_PATH)).ciRepair?.sourceCi;
  if (!equal(oldDomain.ciRepair.sourceCi, full) || !equal(newDomain.ciRepair.sourceCi, ciReportMetadataHistoricalSourceProjection(full)))
    fail('CI_REPORT_METADATA_SOURCE_STATUS_PROJECTION_CHANGED');
  newDomain.ciRepair.sourceCi = oldDomain.ciRepair.sourceCi;
  if (!equal(oldStatus, newStatus)) fail('CI_REPORT_METADATA_SOURCE_STATUS_OLD_SEMANTICS_CHANGED');
  const oldTokens = lossless(blob(context, CI_REPORT_METADATA_BASE, 'project/STATUS.json'));
  const newTokens = lossless(blob(context, sourceSha, 'project/STATUS.json'));
  delete jsonDomain(oldTokens, 'project/STATUS.json').ciRepair.sourceCi;
  delete jsonDomain(newTokens, 'project/STATUS.json').ciRepair.sourceCi;
  if (!losslessEqual(oldTokens, newTokens)) fail('CI_REPORT_METADATA_SOURCE_STATUS_NUMBER_OR_TYPE_CHANGED');
  pinObject(context, sourceSha, CI_REPORT_METADATA_CORRECTION_IDENTITY.sourceMachineState);
  sameOutside(context, CI_REPORT_METADATA_BASE, sourceSha, new Set(CI_REPORT_METADATA_SOURCE_FILES.map(row => row.path)));
  sameOutside(context, CI_REPORT_METADATA_SOURCE_PARENT, sourceSha, new Set(CI_REPORT_METADATA_SOURCE_DELTA_PATHS));
  encodingProof(context, sourceSha, 'source');
  return { sourceSha, sourceParentSha: CI_REPORT_METADATA_SOURCE_PARENT,
    ciScopeSha256: digest(scopeBytes), exactSourceFiles: 13, exactSourceDeltaFiles: 7 };
}
function reportObject(context, sourceSha) {
  exactDiff(rawDiff(context, sourceSha, context.head), CI_REPORT_METADATA_REPORT_PATHS.map(file =>
    ({ path: file, status: 'M', oldMode: '100644', newMode: '100644' })), 'CI_REPORT_METADATA_REPORT_PATHS_NOT_EXACT');
  const evidence = parse(blob(context, context.head, CI_REPORT_METADATA_EVIDENCE_PATH)), identity = evidence.ciReportMetadata;
  if (!object(identity) || identity.sourceSha !== sourceSha
    || !equal(identity, ciReportMetadataReportIdentity(sourceSha, identity.sourceCi))
    || !validateCiReportMetadataSourceReceipt(identity.sourceCi, sourceSha)) fail('CI_REPORT_METADATA_REPORT_SOURCE_CI_CHANGED');
  const producer = identity.sourceCi.artifacts[0].toolContent.result.sourceBefore.admission;
  const recordedEncoding = identity.sourceCi.artifacts[0].toolContent.result.controlPlaneEncodingProof;
  if (producer.ciScopeSha256 !== digest(blob(context, sourceSha, CI_REPORT_METADATA_SCOPE_PATH)))
    fail('CI_REPORT_METADATA_REPORT_SOURCE_SCOPE_PRODUCER_MISMATCH');
  for (const pin of [recordedEncoding.status, recordedEncoding.evidence]) {
    const bytes = blob(context, sourceSha, pin.path);
    if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256) fail('CI_REPORT_METADATA_REPORT_SOURCE_ENCODING_PRODUCER_MISMATCH');
  }
  const projection = ciReportMetadataReportProjection(identity);
  for (const file of CI_REPORT_METADATA_REPORT_PATHS) {
    const before = blob(context, sourceSha, file), after = blob(context, context.head, file);
    if (file.endsWith('.md')) {
      if (!after.subarray(0, before.length).equals(before) || after.length <= before.length || after.length - before.length > 131072
        || !after.subarray(before.length).toString('utf8').includes('CI_REPORT_METADATA_001')) fail('CI_REPORT_METADATA_REPORT_NOT_APPEND_ONLY');
      continue;
    }
    const oldJson = parse(before), newJson = parse(after), oldDomain = jsonDomain(oldJson, file), newDomain = jsonDomain(newJson, file);
    if (Object.hasOwn(oldDomain, 'ciReportMetadata') || !equal(newDomain.ciReportMetadata,
      file === 'project/STATUS.json' ? projection : identity)) fail('CI_REPORT_METADATA_REPORT_DOMAIN_CHANGED');
    delete newDomain.ciReportMetadata;
    if (!equal(oldJson, newJson)) fail('CI_REPORT_METADATA_REPORT_CHANGED_OLD_SEMANTICS');
    const oldTokens = lossless(before), newTokens = lossless(after);
    delete jsonDomain(newTokens, file).ciReportMetadata;
    if (!losslessEqual(oldTokens, newTokens)) fail('CI_REPORT_METADATA_REPORT_OLD_NUMBER_OR_TYPE_CHANGED');
  }
  sameOutside(context, sourceSha, context.head, new Set(CI_REPORT_METADATA_REPORT_PATHS));
  return { exactReportFiles: 8, parentToolCiReceiptSha256: ciReportMetadataCanonicalPin(identity.sourceCi).sha256 };
}
function inspect(directory, env, role, options) {
  const context = gitContext(directory, env, options), lineage = context.text(['rev-list', '--parents', '-n', '1', context.head]).split(' ');
  if (lineage.length !== 2) fail('CI_REPORT_METADATA_UNIQUE_PARENT_CHANGED');
  const sourceSha = role === 'source' ? context.head : lineage[1];
  const source = sourceObject(context, sourceSha), report = role === 'report' ? reportObject(context, sourceSha) : {};
  const before = snapshot(context), original = originalProduct(context), historical = historicalIdentity(context);
  const failedMetadata = failedMetadataIdentity(context);
  const encoding = encodingProof(context, context.head, role), after = snapshot(context);
  if (!equal(before, after)) fail('CI_REPORT_METADATA_ADMISSION_DRIFT');
  context.check();
  const result = freeze({ schema: 'musicbridge.ci-report-metadata.admission.v1', task: CI_REPORT_METADATA_TASK,
    branch: context.branch, baseSha: CI_REPORT_METADATA_BASE, headAtAdmission: context.head,
    sourceSha, productSource: CI_REPORT_METADATA_PRODUCT_SOURCE, ...source, ...original, ...historical, ...failedMetadata, ...report,
    repairRole: role, encodingProof: encoding, productResultsReused: true, currentToolGateRequired: true,
    currentProductTestsRepeated: false, compiledAndApp: 'SKIPPED_REUSED_S165', originalFailurePreserved: true,
    before, after, realApplicationServiceDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' });
  admitted.add(result); return result;
}
export function inspectCiReportMetadataAdmission(directory = repository, env = process.env, options = {}) { return inspect(directory, env, 'source', options); }
export function inspectCiReportMetadataReportAdmission(directory = repository, env = process.env, options = {}) { return inspect(directory, env, 'report', options); }
export const assertCiReportMetadataReportSource = inspectCiReportMetadataReportAdmission;
export function inspectCiReportMetadataEncoding(directory = repository, env = process.env, options = {}) {
  const context = gitContext(directory, env, options), lineage = context.text(['rev-list', '--parents', '-n', '1', context.head]).split(' ');
  if (lineage.length !== 2) fail('CI_REPORT_METADATA_UNIQUE_PARENT_CHANGED');
  const proof = encodingProof(context, context.head, lineage[1] === CI_REPORT_METADATA_SOURCE_PARENT ? 'source' : 'report');
  for (const pin of [proof.status, proof.evidence]) {
    const filename = path.join(directory, pin.path), bytes = readWhole(filename, context.check);
    if (tree(context, context.head).get(pin.path)?.mode !== '100644' || (lstatSync(filename).mode & 0o111)
      || bytes.length !== pin.bytes || digest(bytes) !== pin.sha256) fail('CI_REPORT_METADATA_ENCODING_WORKTREE_CHANGED');
  }
  if (context.text(['rev-parse', 'HEAD']) !== context.head
    || context.text(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) fail('CI_REPORT_METADATA_ENCODING_DRIFT');
  context.check(); return freeze(proof);
}
export function inspectCiReportMetadataHistoricalObjects(directory = repository, env = process.env, options = {}) {
  const context = gitContext(directory, env, options);
  for (const revision of CI_REPORT_METADATA_CORRECTION_IDENTITY.historicalObjects)
    if (context.text(['cat-file', '-t', revision]) !== 'commit') fail('CI_REPORT_METADATA_HISTORICAL_OBJECT_UNAVAILABLE');
  return { historicalObjects: [...CI_REPORT_METADATA_CORRECTION_IDENTITY.historicalObjects], allReadable: true, fetched: false };
}
export function ciReportMetadataWorkflowOutputs(result) {
  if (!admitted.has(result)) fail('CI_REPORT_METADATA_RESULT_NOT_ACTUALLY_ADMITTED');
  return { repairMode: 'reuse-s165', task: CI_REPORT_METADATA_TASK, sourceSha: result.sourceSha,
    sourceParentSha: result.sourceParentSha,
    productSource: result.productSource, productFingerprint: result.productFingerprint,
    ciScopeSha256: result.ciScopeSha256, repairRole: result.repairRole };
}

const skippedSteps = freeze({
  verify: ['Install frozen workspace', 'Verify platform-independent workspace (typecheck, unit tests, build; no Electron)',
    'Verify offline preparation boundaries', 'Verify isolated MBRS-001 offline POC', 'MBRS002 本地合同 Gate',
    'MBRS003 阶段软件 Gate', 'MBRS004 名称与版本规则 Gate', 'MBRS005 本地文件网关与资源租约 Gate',
    'MBRS006 本地Audio Input与会话隔离 Gate', 'MBRS007 队列预取与持久恢复 Gate',
    'MBRS008 原样字节与独立质量证据 Gate', 'MBRS009 正式本地库有界查询与复用UI Gate',
    'MBRS010 封面选择与来源安全 Gate', 'MBRS011 MB_ONLY信息整理预览与撤销 Gate',
    'MBRS014 旧收藏关联与冻结来源保护 Gate', 'MBRS012 受控源写与备份恢复 Gate',
    'MBRS013 同内容位置迁移与具体清理 Gate', 'MBM000 移动合同双端采纳 Gate', 'MBM001 配对与只读曲库 Gate',
    'MBM002 手机资源播放 Gate', 'MBM003 无损与DSD传输软件 Gate', '本地音乐库有符号身份修复 Gate',
    'MBM004 内容与多设备软件 Gate', '磁带共同基线与fresh读取策略 Gate',
    'Verify pinned historical fragments and current discarded rejection', '验证报告CI准入正负例', 'Preserve full verification log'],
  'dependency-audit': ['Install frozen workspace'],
  'static-security': ['Install frozen workspace', 'Run directed platform-independent security tests (no Electron)'],
  'rust-core (ubuntu-latest)': ['安装固定 Rust 工具链', '安装冻结工作区依赖', '验证实际 Rust 与 TypeScript 边界', '保留编译器、测试及源码与二进制清单'],
  'rust-core (macos-latest)': ['安装固定 Rust 工具链', '安装冻结工作区依赖', '验证实际 Rust 与 TypeScript 边界', '保留编译器、测试及源码与二进制清单'],
  'macos-electron-gate': ['Install frozen workspace', 'Prepare fresh Core fixed Worker before existing Electron gates',
    'Prepare Rust toolchain', 'Build and verify both Rust hosts once in this job',
    'Install Electron binary from locked tree (official installer only)', 'Verify official Electron archive and actual execution tree',
    'Electron startup, crash/restart, safeStorage vault and credential recovery gates',
    'Electron end-to-end flow (Playwright, production build)', 'Select declared synthetic Rust Host artifacts',
    'Preserve declared synthetic Rust Host compiled artifacts', 'Preserve Electron logs and synthetic test artifacts'],
});
const jobNames = freeze([['verify', 'dependency-audit'], ['static-security'],
  ['rust-core (ubuntu-latest)', 'rust-core (macos-latest)'], ['macos-electron-gate']]);

const stepIs = (job, name, conclusion) => {
  const rows = job.steps.filter(row => row?.name === name);
  return rows.length === 1 && rows[0].status === 'completed' && rows[0].conclusion === conclusion;
};
/** 当前Source工具producer是新任务；原产品执行和原001当前工具执行必须明确skipped。 */
export function validateCiReportMetadataParentCi(input) {
  try {
    const { task, repositoryId: id, parent, branch, runs, proofs, now = Date.now() } = input ?? {};
    if (task !== CI_REPORT_METADATA_TASK || id !== repositoryId || !sha(parent)
      || [CI_REPORT_METADATA_SOURCE_PARENT, CI_REPORT_METADATA_BASE, CI_REPORT_METADATA_HISTORICAL_SOURCE,
        CI_REPORT_MIRROR_BASE, CI_REPORT_METADATA_PRODUCT_SOURCE].includes(parent)
      || branch !== CI_REPORT_METADATA_BRANCH || !Number.isFinite(now) || !Array.isArray(runs) || runs.length !== 4
      || !Array.isArray(proofs) || proofs.length !== 4) return false;
    const runIds = new Set(), jobIds = new Set(), artifactIds = new Set();
    for (let index = 0; index < workflows.length; index++) {
      const selected = runs.filter(run => run?.path === workflows[index]); if (selected.length !== 1) return false;
      const run = selected[0], matching = proofs.filter(proof => proof?.runId === run.id); if (matching.length !== 1) return false;
      const proof = matching[0];
      if (!positive(run.id) || runIds.has(run.id) || run.repository?.id !== id || run.head_repository?.id !== id
        || run.head_sha !== parent || run.head_branch !== branch || run.event !== 'push' || run.run_attempt !== 1
        || run.status !== 'completed' || run.conclusion !== 'success' || !Array.isArray(proof.jobs)
        || !equal(proof.jobs.map(job => job.name).sort(), [...jobNames[index]].sort())
        || !Array.isArray(proof.artifacts) || proof.artifacts.length !== (index === 0 ? 1 : 0)) return false;
      runIds.add(run.id);
      for (const job of proof.jobs) {
        if (!positive(job.id) || jobIds.has(job.id) || job.run_id !== run.id || job.head_sha !== parent
          || job.status !== 'completed' || job.conclusion !== 'success' || !Array.isArray(job.steps)
          || !stepIs(job, CI_REPORT_METADATA_GUARD_STEP, 'success') || !stepIs(job, reuseName, 'success')
          || !stepIs(job, 'CI修复精确身份与原软件复用准入', 'skipped')
          || skippedSteps[job.name].some(name => !stepIs(job, name, 'skipped'))) return false;
        jobIds.add(job.id);
        if (job.name === 'verify' && ([CI_REPORT_METADATA_GATE_STEP, '准备准入正负例的精确历史Git对象', CI_REPORT_METADATA_UPLOAD_STEP]
          .some(name => !stepIs(job, name, 'success')) || ['CI报告镜像历史对象修复工具 Gate', '保留本次CI修复工具证据']
          .some(name => !stepIs(job, name, 'skipped')))) return false;
        if (job.name === 'dependency-audit' && !stepIs(job, 'Production dependency audit', 'success')) return false;
      }
      for (const artifact of proof.artifacts) {
        if (!positive(artifact.id) || artifactIds.has(artifact.id) || artifact.name !== 'verify-' + parent
          || artifact.expired !== false || !positive(artifact.size_in_bytes) || artifact.size_in_bytes > 67108864
          || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? '') || !Number.isFinite(Date.parse(artifact.expires_at))
          || Date.parse(artifact.expires_at) <= now || artifact.workflow_run?.id !== run.id
          || artifact.workflow_run?.head_sha !== parent || artifact.workflow_run?.repository_id !== id
          || artifact.workflow_run?.head_repository_id !== id) return false;
        artifactIds.add(artifact.id);
      }
    }
    return runIds.size === 4 && jobIds.size === 6 && artifactIds.size === 1;
  } catch { return false; }
}
const pinValid = value => object(value) && typeof value.path === 'string' && value.path.length > 0
  && !/[\u0000-\u001f\u007f]/u.test(value.path) && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && /^[a-f0-9]{64}$/u.test(value.sha256 ?? '');
const digestPinValid = value => object(value) && equal(Object.keys(value).sort(), ['bytes', 'sha256'])
  && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && /^[a-f0-9]{64}$/u.test(value.sha256 ?? '');
const controlPass = Buffer.from('CONTROL_PLANE=PASS\n', 'utf8'), emptyHash = digest(Buffer.alloc(0));
function completeStage(stage) {
  return object(stage) && stage.passed === true && stage.exitCode === 0 && stage.signal === null && stage.timedOut === false
    && stage.overflow === false && stage.cleanupFailed === false && stage.exitObserved === true && stage.closeObserved === true
    && stage.spawnFailed === false && stage.interrupted === false && stage.lingeringOwnedGroup === false
    && stage.physicalShutdown?.pidAbsent === true && stage.physicalShutdown.processGroupAbsent === true
    && stage.observedDescendantsAbsent === true && Array.isArray(stage.observedDescendants)
    && stage.observedDescendants.every(row => row?.physicallyAbsent === true)
    && stage.descendantScanFailed === false && stage.rawForcedClosed === false && stage.boundedSettleObserved === false
    && stage.unexpectedPipeHolder === false && stage.terminationRequested === false
    && stage.rawCaptureComplete === true && stage.rawCaptureScope === 'FULL_SEPARATE_STDOUT_STDERR_BYTES_UNTIL_CLOSE_WITH_FIXED_BOUNDS'
    && Number.isFinite(stage.durationMs) && stage.durationMs >= 0 && Number.isFinite(stage.budgetMs)
    && stage.budgetMs > 0 && stage.budgetMs <= 90000 && stage.durationMs <= stage.budgetMs && object(stage.raw)
    && equal(Object.keys(stage.raw).sort(), ['stderr', 'stdout']);
}
/** 完整Source收据把producer、whole ZIP、summary原字节、三stage raw和状态投影绑定成同一对象。 */
export function validateCiReportMetadataSourceReceipt(value, sourceSha) {
  try {
    if (!object(value) || !sha(sourceSha) || value.schema !== 'musicbridge.root.ci-report-metadata.first-natural-ci.v1'
      || value.status !== 'SEALED_FIRST_NATURAL_TOOL_CI_WITH_ORIGINAL_S165_SOFTWARE_REUSE' || value.phase !== 'source'
      || value.task !== CI_REPORT_METADATA_TASK || value.revision !== sourceSha || value.branch !== CI_REPORT_METADATA_BRANCH
      || value.repository !== repositoryName || value.repositoryId !== repositoryId || value.code !== null
      || !equal(value.before, value.after) || value.before?.head !== sourceSha || value.before.parent !== CI_REPORT_METADATA_SOURCE_PARENT
      || value.before.branch !== CI_REPORT_METADATA_BRANCH || value.before.status !== '' || !sha(value.before.tree)
      || value.oldProductSource !== CI_REPORT_METADATA_PRODUCT_SOURCE || value.oldFailedReport !== CI_REPORT_METADATA_BASE
      || value.oldFailurePreserved !== true || value.oldProductTestsRepeated !== false || value.oldProductZipsDownloadedOrCrcReplayed !== false
      || value.compiledAndApp !== 'SKIPPED_REUSED_S165' || value.reruns !== 0 || value.dispatches !== 0
      || value.credentialsOrSignedRedirectArchived !== false || value.realApplicationServiceDeviceAudio !== 'NOT_RUN'
      || value.ownerAcceptance !== 'NOT_RUN' || !Number.isFinite(Date.parse(value.recordedAt))
      || !validateCiReportMetadataParentCi({ task: value.task, repositoryId, parent: sourceSha, branch: value.branch,
        runs: value.runs, proofs: value.proofs, now: Date.parse(value.recordedAt) })
      || !Array.isArray(value.logs) || value.logs.length !== 6 || !Array.isArray(value.artifacts) || value.artifacts.length !== 1) return false;
    const jobs = value.proofs.flatMap(proof => proof.jobs), seenLogs = new Set();
    for (const log of value.logs) {
      const producer = jobs.find(job => job.id === log?.jobId);
      if (!producer || seenLogs.has(log.jobId) || log.runId !== producer.run_id || log.jobName !== producer.name
        || !pinValid(log.raw) || !positive(log.raw.bytes) || log.raw.bytes > 16777216
        || log.redirectLocationArchived !== false || log.credentialsArchived !== false
        || log.authorizationForwardedAcrossHosts !== false) return false;
      seenLogs.add(log.jobId);
    }
    if (new Set(value.logs.map(row => row.raw.path)).size !== 6) return false;
    const artifact = value.artifacts[0], platform = value.proofs.flatMap(proof => proof.artifacts)[0];
    if (artifact.id !== platform.id || artifact.name !== platform.name || !pinValid(artifact.zip)
      || artifact.zip.bytes !== platform.size_in_bytes || 'sha256:' + artifact.zip.sha256 !== platform.digest
      || artifact.allMembersBytesAndCrcRead !== true || artifact.credentialsArchived !== false
      || artifact.signedRedirectArchived !== false || artifact.authorizationForwardedAcrossHosts !== false
      || !Array.isArray(artifact.members) || !artifact.members.length || artifact.members.length > 256
      || artifact.members.some(row => !pinValid(row) || !relative(row.path.endsWith('/') ? row.path.slice(0, -1) : row.path)
        || !equal(Object.keys(row).sort(), ['bytes', 'crc32', 'path', 'sha256']) || !Number.isSafeInteger(row.crc32)
        || row.crc32 < 0 || row.crc32 > 0xffffffff) || new Set(artifact.members.map(row => row.path)).size !== artifact.members.length
      || !Number.isSafeInteger(artifact.expandedBytes) || artifact.expandedBytes > 67108864
      || artifact.expandedBytes !== artifact.members.reduce((total, row) => total + row.bytes, 0)) return false;
    const summary = artifact.toolContent?.result, entry = artifact.toolContent?.entry;
    if (!object(summary) || artifact.toolContent.phase !== 'source' || !relative(entry) || path.posix.basename(entry) !== 'summary.json'
      || summary.schema !== 'musicbridge.ci-report-metadata.tool-gate.v1' || summary.status !== 'PASSED_CURRENT_TOOL_GATE'
      || summary.success !== true || summary.currentToolGateExitCode !== 0 || !equal(summary.failures, [])
      || summary.task !== CI_REPORT_METADATA_TASK || summary.headAtRun !== sourceSha || summary.sourceSha !== sourceSha
      || summary.repairRole !== 'source' || summary.baseSha !== CI_REPORT_METADATA_BASE
      || summary.sourceParentSha !== CI_REPORT_METADATA_SOURCE_PARENT
      || summary.productSoftwareSource !== CI_REPORT_METADATA_PRODUCT_SOURCE || summary.productTestsOrBuildsRepeated !== false
      || summary.softwareEvidenceMode !== 'SKIPPED_REUSED_S165' || summary.productArtifactsCreated !== 0
      || !equal(summary.limits, { stageMs: 90000, wholeMs: 180000, rawBytesPerStream: 16777216,
        gitBytes: 16777216, gitMs: 10000 }) || !Number.isFinite(summary.durationMs)
      || summary.durationMs < 0 || summary.durationMs >= 180000
      || !Number.isFinite(summary.startedAtMs) || !Number.isFinite(summary.finishedAtMs)
      || summary.finishedAtMs < summary.startedAtMs
      || summary.temporaryCleanup?.createdByThisGate !== true || summary.temporaryCleanup.removed !== true
      || summary.temporaryCleanup.onlyCurrentOwnedTmpRemoved !== true
      || summary.temporaryCleanup.allStageOwnedProcessesPhysicallyClosed !== true
      || summary.sourceInputsUnchanged !== true || !equal(summary.sourceBefore, summary.sourceAfter)
      || summary.sourceBefore?.identity?.head !== sourceSha || summary.sourceBefore.identity.status !== ''
      || summary.sourceBefore.identity.branch !== CI_REPORT_METADATA_BRANCH || summary.sourceBefore.identity.tree !== value.before.tree
      || summary.originalTests !== 173 || summary.safetyTests !== 16 || summary.expectedToolTests !== 189
      || summary.controlPlaneEncodingPassed !== true || !Array.isArray(summary.stages) || summary.stages.length !== 3
      || !equal(summary.stages.map(stage => stage.name), ['original-173', 'control-plane', 'metadata-safety'])) return false;
    const toolDirectory = path.posix.dirname(entry), expectedMembers = ['summary.json', 'source-before.json', 'source-after.json',
      ...summary.stages.flatMap(stage => [stage.name + '.json', stage.name + '.stdout.log', stage.name + '.stderr.log'])]
      .map(name => path.posix.join(toolDirectory, name)).sort();
    if (!equal(artifact.members.map(row => row.path).sort(), expectedMembers)) return false;
    const entries = new Map(artifact.members.map(row => [row.path, row])), encodedSummary = artifact.toolContent.rawBase64;
    if (typeof encodedSummary !== 'string' || encodedSummary.length < 4 || encodedSummary.length > 22369624
      || encodedSummary.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedSummary)) return false;
    const summaryBytes = Buffer.from(encodedSummary, 'base64'), summaryMember = entries.get(entry);
    if (!summaryMember || !summaryBytes.length || summaryBytes.length > 16777216 || summaryBytes.toString('base64') !== encodedSummary
      || summaryMember.bytes !== summaryBytes.length || summaryMember.sha256 !== digest(summaryBytes) || !equal(parse(summaryBytes), summary)) return false;
    const proof = summary.controlPlaneEncodingProof;
    if (!object(proof) || !equal(Object.keys(proof).sort(), ['canonical', 'evidence', 'jsonPointer', 'publicSummaryCanonical', 'status'])
      || !pinValid(proof.status) || proof.status.path !== 'project/STATUS.json' || !pinValid(proof.evidence)
      || proof.evidence.path !== CI_REPORT_METADATA_EVIDENCE_PATH || proof.jsonPointer !== '/ciRepair/sourceCi'
      || !equal(proof.canonical, CI_REPORT_METADATA_SOURCE1_CANONICAL) || !digestPinValid(proof.publicSummaryCanonical)
      || !Array.isArray(summary.sourceBefore.currentFiles) || !equal(summary.sourceBefore.admission?.encodingProof, proof)) return false;
    for (const pin of [proof.status, proof.evidence]) {
      const matching = summary.sourceBefore.currentFiles.filter(row => row.path === pin.path);
      if (matching.length !== 1 || matching[0].mode !== '100644' || matching[0].bytes !== pin.bytes || matching[0].sha256 !== pin.sha256) return false;
    }
    if (!sha(summary.sourceBefore.admission.sourceSha) || summary.sourceBefore.admission.sourceSha !== sourceSha
      || summary.sourceBefore.admission.sourceParentSha !== CI_REPORT_METADATA_SOURCE_PARENT
      || summary.sourceBefore.admission.exactSourceDeltaFiles !== 7
      || summary.sourceBefore.admission.historicalFailedMetadataSourcePreserved !== true
      || summary.sourceBefore.admission.exactSourceFiles !== 13 || summary.sourceBefore.admission.repairRole !== 'source'
      || !/^[a-f0-9]{64}$/u.test(summary.sourceBefore.admission.ciScopeSha256 ?? '')) return false;
    for (const stage of summary.stages) {
      if (!completeStage(stage)) return false;
      if (stage.name === 'control-plane') {
        if (stage.expectedTests !== null || stage.testCounts !== null || stage.expectedCaseNames !== null
          || !equal(stage.actualCaseNames, []) || stage.raw.stdout.bytes !== controlPass.length || stage.raw.stdout.sha256 !== digest(controlPass)
          || stage.raw.stderr.bytes !== 0 || stage.raw.stderr.sha256 !== emptyHash) return false;
      } else {
        const expected = stage.name === 'original-173' ? 173 : 16;
        if (stage.expectedTests !== expected || stage.testCounts?.tests !== expected || stage.testCounts.pass !== expected
          || ['fail', 'cancelled', 'skipped', 'todo'].some(key => stage.testCounts[key] !== 0)
          || stage.tapComplete !== true || stage.caseNamesMatched !== true || !Array.isArray(stage.actualCaseNames)
          || stage.actualCaseNames.length !== expected
          || (stage.name === 'original-173' ? stage.expectedCaseNames !== null
            : !equal(stage.expectedCaseNames, CI_REPORT_METADATA_SAFETY_CASE_NAMES)
              || !equal(stage.actualCaseNames, CI_REPORT_METADATA_SAFETY_CASE_NAMES))) return false;
      }
      for (const [stream, pin] of Object.entries(stage.raw)) {
        if (!pinValid(pin) || pin.path !== stage.name + '.' + stream + '.log' || pin.bytes > 16777216) return false;
        const member = entries.get(path.posix.join(path.posix.dirname(entry), pin.path));
        if (!member || member.bytes !== pin.bytes || member.sha256 !== pin.sha256) return false;
      }
    }
    return true;
  } catch { return false; }
}

export function ciReportMetadataRouteRequested(branch, authorityPresent) { return branch === CI_REPORT_METADATA_BRANCH || authorityPresent === true; }
function hasAuthority(directory) {
  for (const file of [CI_REPORT_METADATA_CORRECTION_PATH, CI_REPORT_METADATA_SCOPE_PATH]) {
    try { if (lstatSync(path.join(directory, file), { throwIfNoEntry: false })) return true; }
    catch { return true; }
  }
  return false;
}
function route(directory, env) {
  const gitEnvironment = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnvironment, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  let branch;
  try { branch = execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', 'branch', '--show-current'],
    { cwd: directory, env: gitEnvironment, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || env.GITHUB_REF_NAME; }
  catch { fail('CI_REPORT_METADATA_GIT_READ_FAILED'); }
  return ciReportMetadataRouteRequested(branch, hasAuthority(directory));
}
export function inspectCiReportMetadataWorkflowGuard(directory = repository, env = process.env, options = {}) {
  if (!route(directory, env)) return freeze({ repairMode: 'not-applicable' });
  const context = gitContext(directory, env, options), lineage = context.text(['rev-list', '--parents', '-n', '1', context.head]).split(' ');
  const budget = { deadline: context.deadline };
  const result = lineage[1] === CI_REPORT_METADATA_SOURCE_PARENT
    ? inspectCiReportMetadataAdmission(directory, env, budget) : inspectCiReportMetadataReportAdmission(directory, env, budget);
  return ciReportMetadataWorkflowOutputs(result);
}
function producerIdentity({ runs, proofs }) {
  return workflows.map(file => {
    const run = runs.find(row => row.path === file), proof = proofs.find(row => row.runId === run.id);
    return { path: file, runId: run.id, head: run.head_sha, branch: run.head_branch, attempt: run.run_attempt,
      jobs: [...proof.jobs].sort((a, b) => a.id - b.id).map(job => ({ id: job.id, name: job.name, head: job.head_sha,
        steps: job.steps.map(step => ({ name: step.name, status: step.status, conclusion: step.conclusion })) })),
      artifacts: proof.artifacts.map(artifact => ({ id: artifact.id, name: artifact.name, bytes: artifact.size_in_bytes, digest: artifact.digest })) };
  });
}

/** 新任务优先真实分类。Source和非法Report均不访问API，失败绝不签发复用资格。 */
export async function inspectCiReportMetadataReportOnly(env = process.env, directory = repository, getJson) {
  const full = reason => ({ mode: 'full', reason, task: CI_REPORT_METADATA_TASK, productResultsReused: false });
  const deadline = performance.now() + 90000, budget = { deadline };
  let candidate = env.GITHUB_REF_NAME === CI_REPORT_METADATA_BRANCH || hasAuthority(directory);
  try {
    if (!route(directory, env)) return null;
    candidate = true;
    const context = gitContext(directory, env, budget), lineage = context.text(['rev-list', '--parents', '-n', '1', context.head]).split(' ');
    if (lineage[1] === CI_REPORT_METADATA_SOURCE_PARENT) {
      inspectCiReportMetadataAdmission(directory, env, budget);
      return full('CI_REPORT_METADATA_SOURCE_REQUIRES_FRESH_TOOL_GATE');
    }
    const report = inspectCiReportMetadataReportAdmission(directory, env, budget);
    if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.GITHUB_EVENT_NAME !== 'push'
      || env.GITHUB_API_URL !== 'https://api.github.com' || env.GITHUB_REPOSITORY !== repositoryName
      || env.GITHUB_SHA !== report.headAtAdmission) return full('CI_REPORT_METADATA_NOT_PUBLIC_HOSTED_PUSH_CONTEXT');
    const readApi = getJson ?? (async endpoint => {
      const remaining = deadline - performance.now(); if (remaining <= 0) fail('CI_REPORT_METADATA_API_BUDGET');
      const response = await fetch('https://api.github.com/repos/' + repositoryName + endpoint, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(Math.min(15000, Math.ceil(remaining))) });
      if (!response.ok) fail('CI_REPORT_METADATA_API_UNAVAILABLE');
      const reader = response.body.getReader(), chunks = []; let total = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length;
        if (total > 2097152) fail('CI_REPORT_METADATA_API_OVERFLOW'); chunks.push(Buffer.from(next.value)); } }
      finally { await reader.cancel(); }
      return parse(Buffer.concat(chunks));
    });
    const api = async endpoint => {
      const remaining = Math.min(15000, deadline - performance.now());
      if (remaining <= 0) fail('CI_REPORT_METADATA_API_BUDGET');
      let timer;
      try {
        const value = await Promise.race([readApi(endpoint), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('CI公开元数据读取超时。'), { code: 'CI_REPORT_METADATA_API_BUDGET' })), Math.ceil(remaining));
        })]);
        if (performance.now() >= deadline || Buffer.byteLength(JSON.stringify(value), 'utf8') > 2097152) fail('CI_REPORT_METADATA_API_BUDGET');
        return value;
      } finally { clearTimeout(timer); }
    };
    const repo = await api('');
    if (repo?.id !== repositoryId || repo.full_name !== repositoryName || repo.private !== false) return full('CI_REPORT_METADATA_REPOSITORY_IDENTITY_UNKNOWN');
    const listing = await api('/actions/runs?head_sha=' + report.sourceSha + '&event=push&per_page=100');
    if (listing?.total_count !== 4 || listing.workflow_runs?.length !== 4) return full('CI_REPORT_METADATA_PARENT_RUN_LIST_NOT_EXACT');
    const runs = listing.workflow_runs, proofs = [];
    for (const file of workflows) {
      const selected = runs.filter(run => run?.path === file);
      if (selected.length !== 1) return full('CI_REPORT_METADATA_PARENT_RUN_LIST_NOT_EXACT');
      const run = selected[0]; if (!positive(run.id)) return full('CI_REPORT_METADATA_PARENT_RUN_ID_INVALID');
      const jobs = await api('/actions/runs/' + run.id + '/attempts/1/jobs?per_page=100');
      const artifacts = await api('/actions/runs/' + run.id + '/artifacts?per_page=100');
      if (!Number.isSafeInteger(jobs?.total_count) || jobs.total_count !== jobs.jobs?.length
        || !Number.isSafeInteger(artifacts?.total_count) || artifacts.total_count !== artifacts.artifacts?.length)
        return full('CI_REPORT_METADATA_PARENT_LIST_INCOMPLETE');
      proofs.push({ runId: run.id, jobs: jobs.jobs, artifacts: artifacts.artifacts });
    }
    if (!validateCiReportMetadataParentCi({ task: CI_REPORT_METADATA_TASK, repositoryId, parent: report.sourceSha,
      branch: CI_REPORT_METADATA_BRANCH, runs, proofs })) return full('CI_REPORT_METADATA_PARENT_TOOL_GATE_NOT_PROVEN');
    const recorded = parse(blob(context, context.head, CI_REPORT_METADATA_EVIDENCE_PATH)).ciReportMetadata.sourceCi;
    if (!equal(producerIdentity({ runs, proofs }), producerIdentity(recorded))) return full('CI_REPORT_METADATA_PARENT_PRODUCERS_CHANGED');
    const repeated = inspectCiReportMetadataReportAdmission(directory, env, budget);
    if (!equal(repeated, report)) return full('CI_REPORT_METADATA_REPORT_CHANGED_DURING_API');
    return { schema: 'musicbridge.report-only-ci.v1', mode: 'report-only', reason: 'EXACT_PARENT_CI_METADATA_GATE_SUCCESS',
      task: CI_REPORT_METADATA_TASK, reportSha: report.headAtAdmission, parentSourceSha: report.sourceSha,
      sourceParentSha: report.sourceParentSha,
      productSource: report.productSource, productFingerprint: report.productFingerprint, ciScopeSha256: report.ciScopeSha256,
      repositoryId, productResultsReused: true, currentProductTestsRepeated: false, artifactContentDownloaded: false,
      evidenceScope: 'PUBLIC_PLATFORM_TOOL_PRODUCER_AND_ARTIFACT_DIGEST_METADATA_NOT_CONTENT_VALIDATION',
      workflows: proofs.map(proof => ({ runId: proof.runId, jobIds: proof.jobs.map(job => job.id),
        artifacts: proof.artifacts.map(({ id, name, digest: hash, expired }) => ({ id, name, digest: hash, expired })) })) };
  } catch { return candidate ? full('CI_REPORT_METADATA_IDENTITY_OR_API_REJECTED') : null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--workflow-guard') fail('CI_REPORT_METADATA_UNKNOWN_ARGUMENT');
    const outputs = inspectCiReportMetadataWorkflowGuard();
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(outputs).map(([key, value]) => key + '=' + value + '\n').join(''), { flag: 'a' });
    process.stdout.write(JSON.stringify({ schema: 'musicbridge.ci-report-metadata.workflow-guard.v1', ...outputs }) + '\n');
  } catch (error) {
    process.stderr.write('CI报告元数据修复准入拒绝：' + (/^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'CI_REPORT_METADATA_ADMISSION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
