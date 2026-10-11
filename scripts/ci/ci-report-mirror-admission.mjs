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

export const CI_REPORT_MIRROR_TASK = 'CI-REPORT-MIRROR-001';
export const CI_REPORT_MIRROR_BRANCH = 'codex/ci-report-mirror-001';
export const CI_REPORT_MIRROR_BASE = 'aebf9464dc080d1242c379db183f4424e62f0b40';
export const CI_REPORT_MIRROR_PRODUCT_SOURCE = '16507120ab52d4843012e6888ad521138d8336d6';
export const CI_REPORT_MIRROR_SCOPE_PATH = 'docs/postrust/MBM-004/CI_CORRECTION_SCOPE.json';
export const CI_REPORT_MIRROR_CORRECTION_PATH = 'docs/postrust/MBM-004/CI_CORRECTION.json';
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
function fail(code) { const error = new Error('CI报告镜像修复准入拒绝。'); error.code = code; throw error; }
function parse(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('CI_REPORT_MIRROR_JSON_INVALID'); }
}
const relative = value => typeof value === 'string' && value.length > 0 && value.length < 4096
  && !path.isAbsolute(value) && !/[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git');

export const CI_REPORT_MIRROR_REPORT_PATHS = freeze(['reports/MBM-004_RESULT.md', 'reports/MBM-004_RESULT.json',
  'docs/postrust/MBM-004/CI_EVIDENCE.json', 'docs/postrust/MBM-004/STATUS.json', 'project/STATUS.json',
  'project/POSTRUST_PLAN.json', 'project/POSTRUST_TODO.md', 'project/POSTRUST_PROGRESS.md']);
export const CI_REPORT_MIRROR_SOURCE_FILES = freeze([
  ['tasks/CI-REPORT-MIRROR-001.md', 'A', 'task'],
  [CI_REPORT_MIRROR_CORRECTION_PATH, 'A', 'authority'], [CI_REPORT_MIRROR_SCOPE_PATH, 'A', 'authority'],
  ['scripts/ci/ci-report-mirror-admission.mjs', 'A', 'ci-tool'],
  ['scripts/ci/verify-ci-report-mirror.mjs', 'A', 'ci-tool'],
  ['scripts/ci/test/ci-report-mirror.test.mjs', 'A', 'tool-test'],
  ['scripts/ci/task-applicability.mjs', 'M', 'ci-routing'],
  ['scripts/ci/report-only-admission.mjs', 'M', 'ci-routing'],
  ['.github/workflows/verify.yml', 'M', 'workflow'], ['.github/workflows/security.yml', 'M', 'workflow'],
  ['.github/workflows/rust-core.yml', 'M', 'workflow'], ['.github/workflows/electron-e2e.yml', 'M', 'workflow'],
].map(([file, status, role]) => ({ path: file, status, role, oldMode: status === 'A' ? '000000' : '100644', newMode: '100644' })));
const fixedPins = freeze({
  oldScope: { path: MBM004_SCOPE_PATH, bytes: 26899, sha256: '7158eb8b33ed58de8a7c9f9ad3456fb372c65ebcc0f9fa7e0a491a248cc2a54d' },
  oldCorrection: { path: MBM004_CORRECTION_PATH, bytes: 4010, sha256: '4c7da837a75ded9bcb164ca8c1c33a48bef69577cdae1fe11c5d0512a0521a5c' },
  oldLocal: { path: 'docs/postrust/MBM-004/LOCAL_SOFTWARE_EVIDENCE.json', bytes: 1204380, sha256: '3b0bcfd27f2dff84937f7c776d94c55372eff6faff7c8b191befe7a45fbf6f1c' },
  oldCi: { path: 'docs/postrust/MBM-004/CI_EVIDENCE.json', bytes: 1940776, sha256: 'b1ca308d724488d467369de91cc3fd6c6f10385c1ccda69d7134f26d62f0603c' },
});
export const CI_REPORT_MIRROR_CORRECTION_IDENTITY = freeze({
  schema: 'musicbridge.ci-report-mirror.correction.v1', task: CI_REPORT_MIRROR_TASK, branch: CI_REPORT_MIRROR_BRANCH,
  baseSha: CI_REPORT_MIRROR_BASE, productSource: CI_REPORT_MIRROR_PRODUCT_SOURCE,
  predecessorSource: MBM004_PREDECESSOR_SOURCE, foundation: MBM004_BASE, scope: CI_REPORT_MIRROR_SCOPE_PATH,
  repairKind: 'HISTORICAL_GIT_OBJECT_PREPARATION_ONLY',
  failure: { repositoryId, reportSha: CI_REPORT_MIRROR_BASE, runId: 38118303279, jobId: 114407604814,
    runAttempt: 1, event: 'push', stepName: '验证报告CI准入正负例', stepNumber: 35,
    counts: { tests: 132, pass: 131, fail: 1, skip: 0 },
    log: { bytes: 98779, sha256: '00143d192589a6aa2606289ba6ef30c4dcf5940aa713de521853a65dc2d2f87c' },
    audit: 'success', security: 'success', preserved: true },
  historicalObjects: ['cfa0456de984c6cf37a1cbb69300ae9a9ee97d7f', '99c89519f3357f4018b32930e8179b66719f99e7'],
  softwareReuse: { source: CI_REPORT_MIRROR_PRODUCT_SOURCE, mode: 'EXACT_BYTES_AND_ORIGINAL_PRODUCERS',
    productTestsRepeated: false, compiledAppStatus: 'SKIPPED_REUSED_S165' },
  oldScope: fixedPins.oldScope, oldCorrection: fixedPins.oldCorrection, oldLocal: fixedPins.oldLocal,
  ledger: { originalTasks: 18, originalAcceptanceCases: 156, effectiveTasks: 17, effectiveAcceptanceCases: 150,
    cancelledTask: 'MBRS-015', cancelledCases: 6, cancellation: 'N_A' },
  budgets: { stageMs: 180000, wholeMs: 480000, ownerMs: 2000 }, sourceCi: { workflows: 4, jobs: 6, artifacts: 1 },
  reportCi: { workflows: 2, jobs: 3 }, reportPaths: CI_REPORT_MIRROR_REPORT_PATHS, realEvidence: 'NOT_RUN',
});

/** 纯校验不会签发工作流资格；资格仅来自下方完整真实Git读取。 */
export function assertCiReportMirrorCorrection(value) {
  if (!equal(value, CI_REPORT_MIRROR_CORRECTION_IDENTITY)) fail('CI_REPORT_MIRROR_CORRECTION_CHANGED');
  return value;
}
export function assertCiReportMirrorScope(scope, scopeBytes) {
  const header = { schema: 'musicbridge.ci-report-mirror.execution-scope.v1', task: CI_REPORT_MIRROR_TASK,
    branch: CI_REPORT_MIRROR_BRANCH, baseSha: CI_REPORT_MIRROR_BASE, productSource: CI_REPORT_MIRROR_PRODUCT_SOURCE,
    correction: CI_REPORT_MIRROR_CORRECTION_PATH, frozen: true, reportPaths: CI_REPORT_MIRROR_REPORT_PATHS };
  if (!object(scope) || !equal(without(scope, ['files']), header) || !Array.isArray(scope.files)
    || scope.files.length !== CI_REPORT_MIRROR_SOURCE_FILES.length) fail('CI_REPORT_MIRROR_SCOPE_HEADER_OR_COUNT');
  const seen = new Set();
  for (const expected of CI_REPORT_MIRROR_SOURCE_FILES) {
    const rows = scope.files.filter(row => row?.path === expected.path);
    if (rows.length !== 1) fail('CI_REPORT_MIRROR_SCOPE_PATH_SET');
    const row = rows[0];
    if (!equal(without(row, ['oldBlob', 'bytes', 'sha256']), expected) || seen.has(row.path)
      || !positive(row.bytes) || row.bytes > 16777216 || !sha(row.oldBlob)
      || expected.status === 'A' && row.oldBlob !== zero
      || expected.status === 'M' && row.oldBlob === zero
      || (row.path === CI_REPORT_MIRROR_SCOPE_PATH ? row.sha256 !== null : !/^[a-f0-9]{64}$/u.test(row.sha256 ?? '')))
      fail('CI_REPORT_MIRROR_SCOPE_ROW_CHANGED');
    seen.add(row.path);
  }
  if (scopeBytes !== undefined && (!Buffer.isBuffer(scopeBytes)
    || scope.files.find(row => row.path === CI_REPORT_MIRROR_SCOPE_PATH).bytes !== scopeBytes.length
    || !equal(parse(scopeBytes), scope))) fail('CI_REPORT_MIRROR_SCOPE_SELF_LENGTH');
  return scope;
}

function gitContext(directory, env, options = {}) {
  if (!object(options) || Object.keys(options).some(key => key !== 'deadline')) fail('CI_REPORT_MIRROR_ADMISSION_BUDGET');
  const now = performance.now(), deadline = options.deadline ?? now + 60000;
  if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 180000) fail('CI_REPORT_MIRROR_ADMISSION_BUDGET');
  if (process.versions.node.split('.')[0] !== '22' || !['darwin', 'linux'].includes(process.platform)
    || env.NODE_OPTIONS || env.NODE_PATH) fail('CI_REPORT_MIRROR_NODE_CONTEXT_REJECTED');
  const check = () => { if (performance.now() >= deadline) fail('CI_REPORT_MIRROR_ADMISSION_BUDGET'); };
  check();
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || realpathSync(directory) !== directory)
    fail('CI_REPORT_MIRROR_DIRECTORY_NOT_CANONICAL');
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
    catch { fail('CI_REPORT_MIRROR_GIT_READ_FAILED'); }
  };
  const text = args => new TextDecoder('utf-8', { fatal: true }).decode(git(args)).trim();
  if (text(['rev-parse', '--show-toplevel']) !== directory || text(['rev-parse', '--is-shallow-repository']) !== 'false'
    || text(['for-each-ref', '--format=%(refname)', 'refs/replace'])) fail('CI_REPORT_MIRROR_GIT_OVERLAY_OR_SHALLOW');
  for (const name of ['info/grafts', 'shallow', 'objects/info/alternates', 'objects/info/http-alternates']) {
    const filename = text(['rev-parse', '--path-format=absolute', '--git-path', name]);
    if (existsSync(filename)) fail('CI_REPORT_MIRROR_GIT_OVERLAY_OR_SHALLOW');
  }
  const flags = git(['ls-files', '-v', '-z']).toString('utf8').split('\0').filter(Boolean);
  if (flags.some(row => !row.startsWith('H '))) fail('CI_REPORT_MIRROR_INDEX_FLAGS');
  const head = text(['rev-parse', 'HEAD']), actualBranch = text(['branch', '--show-current']);
  const branch = actualBranch || env.GITHUB_REF_NAME;
  if (!sha(head) || branch !== CI_REPORT_MIRROR_BRANCH || env.GITHUB_SHA && env.GITHUB_SHA !== head
    || env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF_NAME !== CI_REPORT_MIRROR_BRANCH
    || text(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) fail('CI_REPORT_MIRROR_HEAD_BRANCH_OR_CLEAN');
  // 只在这次真实Git读取内复用完整OID；资格、worktree字节和期限均不跨context复用。
  return { directory, env, git, text, head, branch, deadline, check,
    trees: new Map(), blobs: new Map(), cachedBlobBytes: 0 };
}
function tree(context, revision) {
  context.check();
  if (!sha(revision)) fail('CI_REPORT_MIRROR_IMMUTABLE_REVISION_REQUIRED');
  if (context.trees.has(revision)) return context.trees.get(revision);
  const result = new Map();
  for (const row of context.git(['ls-tree', '-r', '-z', revision]).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/u.exec(row);
    if (!match || !relative(match[3]) || result.has(match[3])) fail('CI_REPORT_MIRROR_TREE_NOT_CLOSED');
    result.set(match[3], { path: match[3], mode: match[1], blob: match[2] });
  }
  if (!result.size || result.size > 32768) fail('CI_REPORT_MIRROR_TREE_BUDGET');
  context.check(); context.trees.set(revision, result);
  return result;
}
function rawDiff(context, before, after) {
  const parts = context.git(['diff', '--raw', '--no-abbrev', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', before, after])
    .toString('utf8').split('\0');
  if (parts.pop() !== '' || parts.length % 2) fail('CI_REPORT_MIRROR_RAW_DIFF_INVALID');
  const seen = new Set(), rows = [];
  for (let index = 0; index < parts.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AM])$/u.exec(parts[index]), file = parts[index + 1];
    if (!match || !relative(file) || seen.has(file)) fail('CI_REPORT_MIRROR_RAW_DIFF_INVALID');
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
    fail('CI_REPORT_MIRROR_UNIQUE_PARENT_CHANGED');
}
function cacheBlob(context, oid, bytes) {
  context.check();
  if (!sha(oid) || bytes.length > 67108864
    || createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== oid)
    fail('CI_REPORT_MIRROR_IMMUTABLE_BLOB_OID_CHANGED');
  const previous = context.blobs.get(oid);
  if (previous) {
    if (!previous.equals(bytes)) fail('CI_REPORT_MIRROR_IMMUTABLE_BLOB_CHANGED');
    return previous;
  }
  if (context.cachedBlobBytes + bytes.length > 67108864) fail('CI_REPORT_MIRROR_BLOB_CACHE_BUDGET');
  context.cachedBlobBytes += bytes.length; context.blobs.set(oid, bytes);
  return bytes;
}
function blob(context, revision, file) {
  context.check();
  if (!relative(file)) fail('CI_REPORT_MIRROR_IMMUTABLE_BLOB_PATH_INVALID');
  const entry = tree(context, revision).get(file);
  if (!entry) fail('CI_REPORT_MIRROR_IMMUTABLE_BLOB_MISSING');
  return context.blobs.get(entry.blob) ?? cacheBlob(context, entry.blob, context.git(['show', revision + ':' + file]));
}
/** 精确114+111行的完整blob；OID在本context内去重，逐行原pin校验仍由调用方执行。 */
function scopeBlobs(context, records) {
  context.check();
  if (!Array.isArray(records) || records.length !== 225) fail('CI_REPORT_MIRROR_SCOPE_BATCH_COUNT');
  const pending = new Map();
  for (const { row, entry } of records) {
    if (!entry || entry.mode !== '100644' || !sha(entry.blob) || !positive(row.bytes)
      || row.bytes > 16777216) fail('CI_REPORT_MIRROR_PRODUCT_SCOPE_PIN_CHANGED');
    if (context.blobs.has(entry.blob)) continue;
    const previous = pending.get(entry.blob);
    if (previous !== undefined && previous !== row.bytes) fail('CI_REPORT_MIRROR_SCOPE_BATCH_LENGTH_CHANGED');
    pending.set(entry.blob, row.bytes);
  }
  const requests = [...pending];
  const maximum = requests.reduce((total, [, bytes]) => total + bytes + 128, 0);
  if (maximum > 67108864 || requests.length > 225) fail('CI_REPORT_MIRROR_SCOPE_BATCH_BUDGET');
  if (requests.length) {
    const input = Buffer.from(requests.map(([oid]) => oid + '\n').join(''), 'ascii');
    const output = context.git(['cat-file', '--batch'], input);
    if (output.length > maximum) fail('CI_REPORT_MIRROR_SCOPE_BATCH_BUDGET');
    let offset = 0;
    for (const [oid, expectedBytes] of requests) {
      context.check();
      const newline = output.indexOf(10, offset);
      if (newline < offset || newline - offset > 127) fail('CI_REPORT_MIRROR_SCOPE_BATCH_HEADER');
      const header = output.subarray(offset, newline).toString('ascii');
      const expectedHeader = oid + ' blob ' + expectedBytes;
      // 原字节逐项相等，拒绝missing/type/乱序/非规范size及非ASCII伪header。
      if (!output.subarray(offset, newline).equals(Buffer.from(expectedHeader, 'ascii')) || header !== expectedHeader)
        fail('CI_REPORT_MIRROR_SCOPE_BATCH_HEADER');
      const start = newline + 1, end = start + expectedBytes;
      if (end >= output.length || output[end] !== 10) fail('CI_REPORT_MIRROR_SCOPE_BATCH_TRUNCATED');
      cacheBlob(context, oid, output.subarray(start, end)); offset = end + 1;
    }
    if (offset !== output.length) fail('CI_REPORT_MIRROR_SCOPE_BATCH_TRAILING_BYTES');
  }
  context.check();
}
function pinObject(context, revision, pin) {
  const bytes = blob(context, revision, pin.path);
  if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256
    || tree(context, revision).get(pin.path)?.mode !== '100644') fail('CI_REPORT_MIRROR_FIXED_PRODUCT_PIN_CHANGED');
  return bytes;
}
function readWhole(filename, check) {
  check();
  if (realpathSync(filename) !== filename) fail('CI_REPORT_MIRROR_FILE_NOT_CANONICAL');
  const named = lstatSync(filename, { bigint: true }), fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = fstatSync(fd, { bigint: true });
    const stable = row => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'].every(key => row[key] === first[key]);
    if (!first.isFile() || first.size < 0n || first.size > 67108864n || !stable(named)) fail('CI_REPORT_MIRROR_FILE_KIND_OR_BUDGET');
    const bytes = Buffer.alloc(Number(first.size)); let offset = 0;
    while (offset < bytes.length) { check(); const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), null);
      if (!count) fail('CI_REPORT_MIRROR_FILE_TRUNCATED'); offset += count; }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) || !stable(fstatSync(fd, { bigint: true }))
      || !stable(lstatSync(filename, { bigint: true }))) fail('CI_REPORT_MIRROR_FILE_CHANGED_DURING_READ');
    return bytes;
  } finally { closeSync(fd); }
}
/** status之外实读所有tracked字节，拒绝assume-unchanged、稀疏索引或mode隐藏。 */
function snapshot(context) {
  if (context.text(['rev-parse', 'HEAD']) !== context.head
    || context.text(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) fail('CI_REPORT_MIRROR_ADMISSION_DRIFT');
  const rows = tree(context, context.head), hasher = createHash('sha256'); let total = 0;
  for (const row of rows.values()) {
    context.check();
    const filename = path.join(context.directory, row.path), stat = lstatSync(filename);
    let bytes;
    if (row.mode === '120000') {
      if (!stat.isSymbolicLink() || realpathSync(path.dirname(filename)) !== path.dirname(filename)) fail('CI_REPORT_MIRROR_SYMLINK_CHANGED');
      bytes = Buffer.from(readlinkSync(filename));
    } else {
      if (!stat.isFile() || Boolean(stat.mode & 0o111) !== (row.mode === '100755')) fail('CI_REPORT_MIRROR_FILE_MODE_CHANGED');
      bytes = readWhole(filename, context.check);
    }
    total += bytes.length;
    if (total > 536870912 || createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex') !== row.blob)
      fail('CI_REPORT_MIRROR_WORKTREE_BYTES_OR_BUDGET');
    hasher.update(row.path + '\0' + row.mode + '\0' + row.blob + '\0' + digest(bytes) + '\0');
  }
  return { head: context.head, tree: context.text(['rev-parse', context.head + '^{tree}']),
    trackedFiles: rows.size, trackedBytes: total, sha256: hasher.digest('hex') };
}
function sameOutside(context, before, after, allowed) {
  const left = tree(context, before), right = tree(context, after), names = new Set([...left.keys(), ...right.keys()]);
  for (const name of names) if (!allowed.has(name) && !equal(left.get(name), right.get(name))) fail('CI_REPORT_MIRROR_PROTECTED_TREE_CHANGED');
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
    fail('CI_REPORT_MIRROR_ORIGINAL_SCOPE_CHANGED');
  assertMbm004CorrectionScope(oldScope, scope);
  const expectedRows = scope.files.map(row => ({ path: row.path, status: row.status, oldMode: row.status === 'A' ? '000000' : '100644', newMode: '100644' }));
  exactDiff(rawDiff(context, MBM004_BASE, source), [...expectedRows,
    { path: MBM004_SCOPE_PATH, status: 'A', oldMode: '000000', newMode: '100644' }], 'CI_REPORT_MIRROR_ORIGINAL_SOURCE_CUMULATIVE_DIFF');
  exactDiff(rawDiff(context, MBM004_BASE, MBM004_PREDECESSOR_SOURCE), oldScope.files.map(row =>
    ({ path: row.path, status: row.status, oldMode: row.status === 'A' ? '000000' : '100644', newMode: '100644' }))
    .concat([{ path: MBM004_SCOPE_PATH, status: 'A', oldMode: '000000', newMode: '100644' }]), 'CI_REPORT_MIRROR_PREDECESSOR_DIFF');
  exactDiff(rawDiff(context, MBM004_PREDECESSOR_SOURCE, source), correction.repairPaths.map(file =>
    ({ path: file, status: 'M', oldMode: '100644', newMode: '100644' })).concat([
    { path: MBM004_SCOPE_PATH, status: 'M', oldMode: '100644', newMode: '100644' },
    { path: MBM004_CORRECTION_PATH, status: 'A', oldMode: '000000', newMode: '100644' }]), 'CI_REPORT_MIRROR_PRODUCT_REPAIR_DIFF');
  const sourceTree = tree(context, source), oldTree = tree(context, MBM004_PREDECESSOR_SOURCE);
  const records = scope.files.map(row => ({ row, entry: sourceTree.get(row.path) }))
    .concat(oldScope.files.map(row => ({ row, entry: oldTree.get(row.path) })));
  scopeBlobs(context, records);
  for (const { row, entry } of records) {
    context.check(); const bytes = context.blobs.get(entry.blob);
    if (!bytes || bytes.length !== row.bytes || digest(bytes) !== row.sha256 || entry.mode !== '100644')
      fail('CI_REPORT_MIRROR_PRODUCT_SCOPE_PIN_CHANGED');
  }
  pinObject(context, source, MBM004_CANONICAL);
  if (!blob(context, source, MBM004_CANONICAL.path).equals(blob(context, MBM004_BASE, MBM004_CANONICAL.path))) fail('CI_REPORT_MIRROR_CANONICAL_CHANGED');
  const status = parse(blob(context, source, 'project/STATUS.json')), plan = parse(blob(context, source, 'project/POSTRUST_PLAN.json'));
  assertMbm004Metadata(status, plan);
  assertMbm004PredecessorMetadata(parse(blob(context, MBM004_BASE, 'project/STATUS.json')), status,
    parse(blob(context, MBM004_BASE, 'project/POSTRUST_PLAN.json')), plan);
  const reportDiff = rawDiff(context, source, CI_REPORT_MIRROR_BASE);
  if (reportDiff.length !== 8 || reportDiff.some(row => !CI_REPORT_MIRROR_REPORT_PATHS.includes(row.path)
    || row.newMode !== '100644' || row.oldMode !== (row.status === 'A' ? '000000' : '100644')))
    fail('CI_REPORT_MIRROR_ORIGINAL_REPORT_DIFF');
  sameOutside(context, source, CI_REPORT_MIRROR_BASE, new Set(CI_REPORT_MIRROR_REPORT_PATHS));
  const originalCi = parse(pinObject(context, CI_REPORT_MIRROR_BASE, fixedPins.oldCi));
  if (originalCi.source !== source || originalCi.repositoryId !== repositoryId || originalCi.branch !== MBM004_BRANCH
    || !validateMobileContentParentCi({ task: MBM004_TASK, repositoryId, parent: source, branch: MBM004_BRANCH,
      runs: originalCi.firstNaturalRuns, proofs: originalCi.producerProofs, now: Date.parse(originalCi.recordedAt) }))
    fail('CI_REPORT_MIRROR_ORIGINAL_PRODUCT_PRODUCERS_NOT_PROVEN');
  const exclusions = new Set([...CI_REPORT_MIRROR_SOURCE_FILES.map(row => row.path), ...CI_REPORT_MIRROR_REPORT_PATHS]);
  const productFingerprint = digest(Buffer.from(JSON.stringify([...sourceTree.values()].filter(row => !exclusions.has(row.path)))));
  return { productFingerprint, oldProductCi: fixedPins.oldCi, originalScopeFiles: 114,
    originalAggregateFiles: 115, originalProductWorkflows: 4, originalProductJobs: 6, originalProductArtifacts: 5 };
}
function sourceObject(context, sourceSha) {
  parents(context, sourceSha, CI_REPORT_MIRROR_BASE);
  const rawScope = blob(context, sourceSha, CI_REPORT_MIRROR_SCOPE_PATH), scope = assertCiReportMirrorScope(parse(rawScope), rawScope);
  assertCiReportMirrorCorrection(parse(blob(context, sourceSha, CI_REPORT_MIRROR_CORRECTION_PATH)));
  const changes = rawDiff(context, CI_REPORT_MIRROR_BASE, sourceSha);
  exactDiff(changes, CI_REPORT_MIRROR_SOURCE_FILES.map(row => without(row, ['role'])), 'CI_REPORT_MIRROR_SOURCE_PATHS_NOT_EXACT');
  const sourceTree = tree(context, sourceSha), baseTree = tree(context, CI_REPORT_MIRROR_BASE);
  for (const row of scope.files) {
    const change = changes.find(entry => entry.path === row.path), bytes = blob(context, sourceSha, row.path);
    if (change.oldBlob !== row.oldBlob || sourceTree.get(row.path)?.mode !== row.newMode
      || (baseTree.get(row.path)?.blob ?? zero) !== row.oldBlob || bytes.length !== row.bytes
      || row.path !== CI_REPORT_MIRROR_SCOPE_PATH && digest(bytes) !== row.sha256) fail('CI_REPORT_MIRROR_SOURCE_SCOPE_PIN_CHANGED');
  }
  sameOutside(context, CI_REPORT_MIRROR_BASE, sourceSha, new Set(CI_REPORT_MIRROR_SOURCE_FILES.map(row => row.path)));
  return { sourceSha, ciScopeSha256: digest(rawScope), exactSourceFiles: 12 };
}

const workflows = freeze(['.github/workflows/verify.yml', '.github/workflows/security.yml', '.github/workflows/rust-core.yml', '.github/workflows/electron-e2e.yml']);
const guardName = 'CI修复精确身份与原软件复用准入', reuseName = '复用165已封存产品软件证据';
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
/** 新Source只证明工具修复；全部旧产品执行明确skipped，不接纳假产品PASS。 */
export function validateCiReportMirrorParentCi(input) {
  try {
    const { task, repositoryId: id, parent, branch, runs, proofs, now = Date.now() } = input ?? {};
    if (task !== CI_REPORT_MIRROR_TASK || id !== repositoryId || !sha(parent) || parent === CI_REPORT_MIRROR_BASE
      || parent === CI_REPORT_MIRROR_PRODUCT_SOURCE || branch !== CI_REPORT_MIRROR_BRANCH || !Number.isFinite(now)
      || !Array.isArray(runs) || runs.length !== 4 || !Array.isArray(proofs) || proofs.length !== 4) return false;
    const runIds = new Set(), jobIds = new Set(), artifactIds = new Set();
    const step = (job, name, conclusion) => { const rows = job.steps.filter(row => row?.name === name);
      return rows.length === 1 && rows[0].status === 'completed' && rows[0].conclusion === conclusion; };
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
          || !step(job, guardName, 'success') || !step(job, reuseName, 'success')
          || skippedSteps[job.name].some(name => !step(job, name, 'skipped'))) return false;
        jobIds.add(job.id);
        if (job.name === 'verify' && ['CI报告镜像历史对象修复工具 Gate', '准备准入正负例的精确历史Git对象',
          '保留本次CI修复工具证据'].some(name => !step(job, name, 'success'))) return false;
        if (job.name === 'dependency-audit' && !step(job, 'Production dependency audit', 'success')) return false;
      }
      for (const artifact of proof.artifacts) {
        if (!positive(artifact.id) || artifactIds.has(artifact.id) || artifact.name !== 'verify-' + parent
          || artifact.expired !== false || !positive(artifact.size_in_bytes) || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? '')
          || !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= now
          || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== parent
          || artifact.workflow_run?.repository_id !== id || artifact.workflow_run?.head_repository_id !== id) return false;
        artifactIds.add(artifact.id);
      }
    }
    return runIds.size === 4 && jobIds.size === 6 && artifactIds.size === 1;
  } catch { return false; }
}
const pinValid = value => object(value) && typeof value.path === 'string' && value.path.length > 0
  && !/[\u0000-\u001f\u007f]/u.test(value.path) && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && /^[a-f0-9]{64}$/u.test(value.sha256 ?? '');
/** 报告带入完整工具CI收据，旧产品资格仍由固定165原件和原producer提供。 */
export function validateCiReportMirrorSourceReceipt(value, sourceSha) {
  try {
    if (!object(value) || !sha(sourceSha) || value.schema !== 'musicbridge.root.ci-report-mirror.first-natural-ci191.v1'
      || value.status !== 'SEALED_FIRST_NATURAL_TOOL_CI_WITH_ORIGINAL_S165_SOFTWARE_REUSE' || value.phase !== 'source'
      || value.task !== CI_REPORT_MIRROR_TASK || value.revision !== sourceSha || value.branch !== CI_REPORT_MIRROR_BRANCH
      || value.repository !== repositoryName || value.repositoryId !== repositoryId || value.code !== null
      || !equal(value.before, value.after) || value.before?.head !== sourceSha
      || value.oldProductSource !== CI_REPORT_MIRROR_PRODUCT_SOURCE || value.oldFailedReport !== CI_REPORT_MIRROR_BASE
      || value.oldFailurePreserved !== true || value.oldProductTestsRepeated !== false || value.oldProductZipsDownloadedOrCrcReplayed !== false
      || value.compiledAndApp !== 'SKIPPED_REUSED_S165' || value.reruns !== 0 || value.dispatches !== 0
      || value.credentialsOrSignedRedirectArchived !== false || value.realApplicationServiceDeviceAudio !== 'NOT_RUN'
      || value.ownerAcceptance !== 'NOT_RUN' || !Number.isFinite(Date.parse(value.recordedAt))
      || !validateCiReportMirrorParentCi({ task: value.task, repositoryId, parent: sourceSha, branch: value.branch,
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
      || !Array.isArray(artifact.members) || !artifact.members.length
      || artifact.members.some(row => !pinValid(row) || !relative(row.path.endsWith('/') ? row.path.slice(0, -1) : row.path) || !Number.isSafeInteger(row.crc32)
        || row.crc32 < 0 || row.crc32 > 0xffffffff) || new Set(artifact.members.map(row => row.path)).size !== artifact.members.length) return false;
    const summary = artifact.toolContent?.result, entry = artifact.toolContent?.entry;
    if (!object(summary) || artifact.toolContent.phase !== 'source' || !relative(entry)
      || summary.schema !== 'musicbridge.ci-report-mirror.tool-gate.v1' || summary.status !== 'PASSED_CURRENT_TOOL_GATE'
      || summary.success !== true || summary.currentToolGateExitCode !== 0 || !equal(summary.failures, [])
      || summary.headAtRun !== sourceSha || summary.repairRole !== 'source' || summary.baseSha !== CI_REPORT_MIRROR_BASE
      || summary.productSoftwareSource !== CI_REPORT_MIRROR_PRODUCT_SOURCE || summary.productTestsOrBuildsRepeated !== false
      || summary.softwareEvidenceMode !== 'SKIPPED_REUSED_S165' || summary.productArtifactsCreated !== 0
      || summary.sourceInputsUnchanged !== true || !equal(summary.sourceBefore, summary.sourceAfter)
      || summary.sourceBefore?.identity?.head !== sourceSha || summary.sourceBefore.identity.status !== ''
      || !Array.isArray(summary.stages) || summary.stages.length !== 2
      || !equal(summary.stages.map(stage => stage.expectedTests).sort((a, b) => a - b), [20, 173])) return false;
    const entries = new Map(artifact.members.map(row => [row.path, row]));
    const encodedSummary = artifact.toolContent.rawBase64;
    if (typeof encodedSummary !== 'string' || encodedSummary.length < 4 || encodedSummary.length > 22369624
      || encodedSummary.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedSummary)) return false;
    const summaryBytes = Buffer.from(encodedSummary, 'base64'), summaryMember = entries.get(entry);
    if (!summaryMember || !summaryBytes.length || summaryBytes.length > 16777216
      || summaryBytes.toString('base64') !== encodedSummary || summaryMember.bytes !== summaryBytes.length
      || summaryMember.sha256 !== digest(summaryBytes) || !equal(parse(summaryBytes), summary)) return false;
    for (const stage of summary.stages) {
      if ((stage.expectedTests === 173 ? stage.name !== 'original-173' : stage.name !== 'mirror-safety')
        || stage.passed !== true || stage.exitCode !== 0 || stage.signal !== null || stage.timedOut !== false
        || stage.overflow !== false || stage.cleanupFailed !== false || stage.testCounts?.tests !== stage.expectedTests
        || stage.testCounts.pass !== stage.expectedTests || ['fail', 'cancelled', 'skipped', 'todo'].some(key => stage.testCounts[key] !== 0)
        || stage.exitObserved !== true || stage.closeObserved !== true || stage.spawnFailed !== false
        || stage.interrupted !== false || stage.lingeringOwnedGroup !== false || stage.physicalShutdown?.pidAbsent !== true
        || stage.physicalShutdown.processGroupAbsent !== true || stage.rawCaptureComplete !== true
        || stage.tapComplete !== true || stage.caseNamesMatched !== true
        || !Array.isArray(stage.actualCaseNames) || stage.actualCaseNames.length !== stage.expectedTests
        || !object(stage.raw) || !equal(Object.keys(stage.raw).sort(), ['stderr', 'stdout'])) return false;
      for (const pin of Object.values(stage.raw)) {
        if (!pinValid(pin) || !relative(pin.path)) return false;
        const member = entries.get(path.posix.join(path.posix.dirname(entry), pin.path));
        if (!member || member.bytes !== pin.bytes || member.sha256 !== pin.sha256) return false;
      }
    }
    return true;
  } catch { return false; }
}
export function ciReportMirrorReportIdentity(sourceSha, sourceCi) {
  return { task: CI_REPORT_MIRROR_TASK, branch: CI_REPORT_MIRROR_BRANCH, baseReport: CI_REPORT_MIRROR_BASE,
    sourceSha, productSource: CI_REPORT_MIRROR_PRODUCT_SOURCE, scope: CI_REPORT_MIRROR_SCOPE_PATH,
    failedReportPreserved: true, softwareReuse: 'EXACT_BYTES_AND_ORIGINAL_PRODUCERS', currentProductTestsRepeated: false,
    currentToolGateRequired: true, realEvidence: 'NOT_RUN', sourceCi, reportSha: null, reportCi: null,
    reportCommitResolution: 'EXACT_DIRECT_CHILD_OF_SOURCE', ownerAcceptance: 'NOT_RUN' };
}
function reportObject(context, sourceSha) {
  const changes = rawDiff(context, sourceSha, context.head);
  exactDiff(changes, CI_REPORT_MIRROR_REPORT_PATHS.map(file => ({ path: file, status: 'M', oldMode: '100644', newMode: '100644' })), 'CI_REPORT_MIRROR_REPORT_PATHS_NOT_EXACT');
  let receipt = null;
  for (const file of CI_REPORT_MIRROR_REPORT_PATHS) {
    const before = blob(context, sourceSha, file), after = blob(context, context.head, file);
    if (file.endsWith('.md')) {
      if (!after.subarray(0, before.length).equals(before) || after.length <= before.length || after.length - before.length > 131072
        || !after.subarray(before.length).toString('utf8').includes('CI_REPORT_MIRROR_001')) fail('CI_REPORT_MIRROR_REPORT_MARKDOWN_NOT_APPEND_ONLY');
      continue;
    }
    const oldJson = parse(before), newJson = parse(after); let oldDomain = oldJson, newDomain = newJson;
    if (file === 'project/STATUS.json') { oldDomain = oldJson.mobileContentMultidevice; newDomain = newJson.mobileContentMultidevice; }
    if (file === 'project/POSTRUST_PLAN.json') {
      const oldRows = oldJson.mobile_tasks?.filter(row => row?.id === MBM004_TASK), newRows = newJson.mobile_tasks?.filter(row => row?.id === MBM004_TASK);
      if (oldRows?.length !== 1 || newRows?.length !== 1) fail('CI_REPORT_MIRROR_REPORT_TASK_ROW_AMBIGUOUS');
      oldDomain = oldRows[0]; newDomain = newRows[0];
    }
    if (!object(oldDomain) || !object(newDomain) || Object.hasOwn(oldDomain, 'ciRepair') || !object(newDomain.ciRepair)) fail('CI_REPORT_MIRROR_REPORT_CI_REPAIR_MISSING');
    const identity = newDomain.ciRepair;
    if (!equal(identity, ciReportMirrorReportIdentity(sourceSha, identity.sourceCi))
      || !validateCiReportMirrorSourceReceipt(identity.sourceCi, sourceSha)
      || receipt !== null && !equal(receipt, identity.sourceCi)) fail('CI_REPORT_MIRROR_REPORT_CI_REPAIR_CHANGED');
    receipt = identity.sourceCi;
    delete newDomain.ciRepair;
    if (!equal(oldJson, newJson)) fail('CI_REPORT_MIRROR_REPORT_CHANGED_OLD_AUTHORITY_OR_RESULTS');
  }
  sameOutside(context, sourceSha, context.head, new Set(CI_REPORT_MIRROR_REPORT_PATHS));
  return { exactReportFiles: 8, parentToolCiReceiptSha256: digest(Buffer.from(JSON.stringify(canonical(receipt)))) };
}
function inspect(directory, env, role, options) {
  const context = gitContext(directory, env, options);
  const lineage = context.text(['rev-list', '--parents', '-n', '1', context.head]).split(' ');
  if (lineage.length !== 2) fail('CI_REPORT_MIRROR_UNIQUE_PARENT_CHANGED');
  const sourceSha = role === 'source' ? context.head : lineage[1];
  const source = sourceObject(context, sourceSha), report = role === 'report' ? reportObject(context, sourceSha) : {};
  // 本轮闭集先拒绝越界；每个合格结果仍完整实读225个旧Scope pins及全部当前tracked字节。
  const before = snapshot(context), original = originalProduct(context);
  const after = snapshot(context); if (!equal(before, after)) fail('CI_REPORT_MIRROR_ADMISSION_DRIFT');
  context.check();
  const result = freeze({ schema: 'musicbridge.ci-report-mirror.admission.v1', task: CI_REPORT_MIRROR_TASK,
    branch: context.branch, baseSha: CI_REPORT_MIRROR_BASE, headAtAdmission: context.head,
    sourceSha, productSource: CI_REPORT_MIRROR_PRODUCT_SOURCE, ...source, ...original, ...report,
    repairRole: role, productResultsReused: true, currentToolGateRequired: true, currentProductTestsRepeated: false,
    compiledAndApp: 'SKIPPED_REUSED_S165', originalFailurePreserved: true, before, after,
    realApplicationServiceDeviceAudio: 'NOT_RUN', ownerAcceptance: 'NOT_RUN' });
  admitted.add(result); return result;
}
export function inspectCiReportMirrorAdmission(directory = repository, env = process.env, options = {}) { return inspect(directory, env, 'source', options); }
export function inspectCiReportMirrorReportAdmission(directory = repository, env = process.env, options = {}) { return inspect(directory, env, 'report', options); }
export const assertCiReportMirrorReportSource = inspectCiReportMirrorReportAdmission;
export function ciReportMirrorWorkflowOutputs(result) {
  if (!admitted.has(result)) fail('CI_REPORT_MIRROR_RESULT_NOT_ACTUALLY_ADMITTED');
  return { repairMode: 'reuse-s165', task: CI_REPORT_MIRROR_TASK, sourceSha: result.sourceSha,
    productSource: result.productSource, productFingerprint: result.productFingerprint,
    ciScopeSha256: result.ciScopeSha256, repairRole: result.repairRole };
}
export function ciReportMirrorRouteRequested(branch, authorityPresent) { return branch === CI_REPORT_MIRROR_BRANCH || authorityPresent === true; }
function route(directory, env) {
  const gitEnvironment = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(gitEnvironment, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  let branch;
  try { branch = execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', 'branch', '--show-current'],
    { cwd: directory, env: gitEnvironment, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || env.GITHUB_REF_NAME; }
  catch { fail('CI_REPORT_MIRROR_GIT_READ_FAILED'); }
  return ciReportMirrorRouteRequested(branch, existsSync(path.join(directory, CI_REPORT_MIRROR_CORRECTION_PATH))
    || existsSync(path.join(directory, CI_REPORT_MIRROR_SCOPE_PATH)));
}
export function inspectCiReportMirrorWorkflowGuard(directory = repository, env = process.env) {
  if (!route(directory, env)) return freeze({ repairMode: 'not-applicable' });
  const context = gitContext(directory, env), lineage = context.text(['rev-list', '--parents', '-n', '1', context.head]).split(' ');
  const result = lineage[1] === CI_REPORT_MIRROR_BASE ? inspectCiReportMirrorAdmission(directory, env) : inspectCiReportMirrorReportAdmission(directory, env);
  return ciReportMirrorWorkflowOutputs(result);
}
export function inspectCiReportMirrorHistoricalObjects(directory = repository, env = process.env, options = {}) {
  const context = gitContext(directory, env, options);
  for (const revision of CI_REPORT_MIRROR_CORRECTION_IDENTITY.historicalObjects)
    if (context.text(['cat-file', '-t', revision]) !== 'commit') fail('CI_REPORT_MIRROR_HISTORICAL_OBJECT_UNAVAILABLE');
  return { historicalObjects: [...CI_REPORT_MIRROR_CORRECTION_IDENTITY.historicalObjects], allReadable: true, fetched: false };
}

/** 新任务优先真实分类。Source和非法Report均不访问API，失败绝不签发复用资格。 */
export async function inspectCiReportMirrorReportOnly(env = process.env, directory = repository, getJson) {
  const full = reason => ({ mode: 'full', reason, task: CI_REPORT_MIRROR_TASK, productResultsReused: false });
  let candidate = env.GITHUB_REF_NAME === CI_REPORT_MIRROR_BRANCH
    || existsSync(path.join(directory, CI_REPORT_MIRROR_CORRECTION_PATH)) || existsSync(path.join(directory, CI_REPORT_MIRROR_SCOPE_PATH));
  try {
    if (!route(directory, env)) return null;
    candidate = true;
    const context = gitContext(directory, env), lineage = context.text(['rev-list', '--parents', '-n', '1', context.head]).split(' ');
    if (lineage[1] === CI_REPORT_MIRROR_BASE) {
      inspectCiReportMirrorAdmission(directory, env);
      return full('CI_REPORT_MIRROR_SOURCE_REQUIRES_FRESH_TOOL_GATE');
    }
    const report = inspectCiReportMirrorReportAdmission(directory, env);
    if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.GITHUB_EVENT_NAME !== 'push'
      || env.GITHUB_API_URL !== 'https://api.github.com' || env.GITHUB_REPOSITORY !== repositoryName
      || env.GITHUB_SHA !== report.headAtAdmission) return full('CI_REPORT_MIRROR_NOT_PUBLIC_HOSTED_PUSH_CONTEXT');
    const started = performance.now();
    const api = getJson ?? (async endpoint => {
      const remaining = 90000 - (performance.now() - started); if (remaining <= 0) fail('CI_REPORT_MIRROR_API_BUDGET');
      const response = await fetch('https://api.github.com/repos/' + repositoryName + endpoint, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(Math.min(15000, Math.ceil(remaining))) });
      if (!response.ok) fail('CI_REPORT_MIRROR_API_UNAVAILABLE');
      const reader = response.body.getReader(), chunks = []; let total = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; total += next.value.length;
        if (total > 2097152) fail('CI_REPORT_MIRROR_API_OVERFLOW'); chunks.push(Buffer.from(next.value)); } }
      finally { await reader.cancel(); }
      return parse(Buffer.concat(chunks));
    });
    const repo = await api('');
    if (repo?.id !== repositoryId || repo.full_name !== repositoryName || repo.private !== false) return full('CI_REPORT_MIRROR_REPOSITORY_IDENTITY_UNKNOWN');
    const listing = await api('/actions/runs?head_sha=' + report.sourceSha + '&event=push&per_page=100');
    if (listing?.total_count !== 4 || listing.workflow_runs?.length !== 4) return full('CI_REPORT_MIRROR_PARENT_RUN_LIST_NOT_EXACT');
    const runs = listing.workflow_runs, proofs = [];
    for (const file of workflows) {
      const selected = runs.filter(run => run?.path === file);
      if (selected.length !== 1) return full('CI_REPORT_MIRROR_PARENT_RUN_LIST_NOT_EXACT');
      const run = selected[0]; if (!positive(run.id)) return full('CI_REPORT_MIRROR_PARENT_RUN_ID_INVALID');
      const jobs = await api('/actions/runs/' + run.id + '/attempts/1/jobs?per_page=100');
      const artifacts = await api('/actions/runs/' + run.id + '/artifacts?per_page=100');
      if (!Number.isSafeInteger(jobs?.total_count) || jobs.total_count !== jobs.jobs?.length
        || !Number.isSafeInteger(artifacts?.total_count) || artifacts.total_count !== artifacts.artifacts?.length)
        return full('CI_REPORT_MIRROR_PARENT_LIST_INCOMPLETE');
      proofs.push({ runId: run.id, jobs: jobs.jobs, artifacts: artifacts.artifacts });
    }
    if (!validateCiReportMirrorParentCi({ task: CI_REPORT_MIRROR_TASK, repositoryId, parent: report.sourceSha,
      branch: CI_REPORT_MIRROR_BRANCH, runs, proofs })) return full('CI_REPORT_MIRROR_PARENT_TOOL_GATE_NOT_PROVEN');
    const repeated = inspectCiReportMirrorReportAdmission(directory, env);
    if (!equal(repeated, report)) return full('CI_REPORT_MIRROR_REPORT_CHANGED_DURING_API');
    return { schema: 'musicbridge.report-only-ci.v1', mode: 'report-only', reason: 'EXACT_PARENT_CI_REPAIR_GATE_SUCCESS',
      task: CI_REPORT_MIRROR_TASK, reportSha: report.headAtAdmission, parentSourceSha: report.sourceSha,
      productSource: report.productSource, productFingerprint: report.productFingerprint, ciScopeSha256: report.ciScopeSha256,
      repositoryId, productResultsReused: true, currentProductTestsRepeated: false, artifactContentDownloaded: false,
      evidenceScope: 'PUBLIC_PLATFORM_TOOL_PRODUCER_AND_ARTIFACT_DIGEST_METADATA_NOT_CONTENT_VALIDATION',
      workflows: proofs.map(proof => ({ runId: proof.runId, jobIds: proof.jobs.map(job => job.id),
        artifacts: proof.artifacts.map(({ id, name, digest: hash, expired }) => ({ id, name, digest: hash, expired })) })) };
  } catch { return candidate ? full('CI_REPORT_MIRROR_IDENTITY_OR_API_REJECTED') : null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--workflow-guard') fail('CI_REPORT_MIRROR_UNKNOWN_ARGUMENT');
    const outputs = inspectCiReportMirrorWorkflowGuard();
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT,
      Object.entries(outputs).map(([key, value]) => key + '=' + value + '\n').join(''), { flag: 'a' });
    process.stdout.write(JSON.stringify({ schema: 'musicbridge.ci-report-mirror.workflow-guard.v1', ...outputs }) + '\n');
  } catch (error) {
    process.stderr.write('CI报告镜像修复准入拒绝：' + (/^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'CI_REPORT_MIRROR_ADMISSION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
