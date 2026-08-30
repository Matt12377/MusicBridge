import { readFileSync, lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// 此入口校验证据索引，不执行应用、不连接设备、不授予产品或整门验收。
const SOURCE_PATHS = ['docs/prd/MUSICBRIDGE_V3_PRD_v0.3.md', 'project/V3_DEVELOPMENT_PACK.md']
const COUNTS = { MVP: 30, A: 11, B: 15, C: 11, D: 11, E: 15, U: 10 }
const IDS = Object.entries(COUNTS).flatMap(([prefix, count]) => Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`))
const KINDS = ['software', 'synthetic', 'native-no-device']
const EXTERNAL = ['owner', 'hardware', 'real-input', 'real-logic', 'real-roon']
const RUNTIME = 'reports/runtime/task-078-v3-acceptance/'
const CANDIDATE_ROOTS = [
  'packages/contracts/src', 'packages/contracts/test', 'packages/bridge-core/src', 'packages/bridge-core/test',
  'apps/desktop/src', 'apps/desktop/test', 'apps/desktop/e2e', 'apps/desktop/electron-gate', 'apps/desktop/scripts',
  'scripts', 'native/output-helper', 'native/output-lifecycle',
]
const PACKAGE_ROOTS = ['packages/contracts', 'packages/bridge-core', 'apps/desktop']
const CANDIDATE_CONFIGS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...PACKAGE_ROOTS.map(base => `${base}/package.json`)]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const fail = code => { throw new Error(code) }
const check = (condition, code) => { if (!condition) fail(code) }
const text = (value, max = 4000) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const gitSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value)
function keys(value, required, optional = []) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'SHAPE')
  check(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k)), 'SHAPE')
}
function list(value, max, code = 'SHAPE') { check(Array.isArray(value) && value.length <= max, code) }
function relative(file) {
  check(text(file, 500) && !/[\\:\x00-\x1f]/u.test(file) && !path.isAbsolute(file) && file.split('/').every(p => p && p !== '.' && p !== '..'), 'PATH')
}

/** 与候选生成器共用固定受验集合；不调用Git，不读取生成物、控制面或运行报告。 */
export function enumerateAcceptanceCandidateFiles(root) {
  check(typeof root === 'string', 'ROOT_REQUIRED')
  const base = path.resolve(root), files = new Set()
  let visited = 0, bytes = 0
  function stat(file) {
    relative(file)
    let current = base
    for (const part of file.split('/')) {
      current = path.join(current, part)
      let value
      try { value = lstatSync(current) } catch (error) { if (error.code === 'ENOENT') return undefined; fail('PATH_UNAVAILABLE') }
      check(!value.isSymbolicLink(), 'PATH')
      if (current !== path.join(base, file)) check(value.isDirectory(), 'PATH')
      else return value
    }
  }
  function add(file, value) {
    check(value.isFile(), 'PATH')
    check(value.size <= 2 * 1024 * 1024, 'FILE_BUDGET')
    if (!files.has(file)) { files.add(file); bytes += value.size }
    check(files.size <= 5000 && bytes <= 128 * 1024 * 1024, 'CANDIDATE_BUDGET')
  }
  function children(directory) {
    let entries
    try { entries = readdirSync(path.join(base, directory)) } catch { fail('PATH_UNAVAILABLE') }
    visited += entries.length
    check(visited <= 10_000, 'CANDIDATE_BUDGET')
    return entries.sort()
  }
  function visit(directory, depth = 0, select = () => true) {
    check(depth <= 32, 'CANDIDATE_BUDGET')
    const value = stat(directory)
    if (!value) return
    check(value.isDirectory(), 'PATH')
    for (const name of children(directory)) {
      const file = `${directory}/${name}`, child = stat(file)
      check(child, 'PATH_UNAVAILABLE')
      if (child.isDirectory()) visit(file, depth + 1, select)
      else if (select(name)) add(file, child)
    }
  }
  for (const directory of CANDIDATE_ROOTS) visit(directory)
  for (const file of CANDIDATE_CONFIGS) { const value = stat(file); if (value) add(file, value) }
  for (const directory of PACKAGE_ROOTS) {
    const value = stat(directory); if (!value) continue
    check(value.isDirectory(), 'PATH')
    for (const name of children(directory)) {
      if (/^tsconfig.*\.json$/u.test(name) || directory === 'apps/desktop' && /^(?:electron\.vite|playwright)\.config\.(?:[cm]?[jt]s)$/u.test(name)) {
        const file = `${directory}/${name}`, child = stat(file); check(child, 'PATH_UNAVAILABLE'); add(file, child)
      }
    }
  }
  visit('apps/desktop/build', 0, name => /^entitlements.*\.plist$/u.test(name))
  return [...files].sort()
}
function reader(root) {
  const cache = new Map()
  return (file, limit = 2 * 1024 * 1024) => {
    relative(file)
    if (cache.has(file)) { const bytes = cache.get(file); check(bytes.length <= limit, 'FILE_BUDGET'); return bytes }
    try {
      let current = root
      const parts = file.split('/')
      for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]); const stat = lstatSync(current)
        check(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()), 'PATH')
        if (i === parts.length - 1) check(stat.size <= limit, 'FILE_BUDGET')
      }
      const bytes = readFileSync(current); check(bytes.length <= limit, 'FILE_BUDGET'); cache.set(file, bytes); return bytes
    } catch (error) { if (['PATH', 'FILE_BUDGET'].includes(error.message)) throw error; fail('PATH_UNAVAILABLE') }
  }
}
function requirements(read) {
  const found = new Map()
  for (const source of SOURCE_PATHS) {
    let inMvp = false
    read(source).toString('utf8').split('\n').forEach((line, i) => {
      if (line.startsWith('# 75.')) inMvp = true
      if (line.startsWith('# 76.')) inMvp = false
      const mvp = inMvp && /^(\d+)\. (.+)$/u.exec(line)
      const gate = /^\| ([A-EU]-\d{2}) \|/u.exec(line)
      if (!mvp && !gate) return
      const id = mvp ? `MVP-${mvp[1].padStart(2, '0')}` : gate[1]
      check(!found.has(id), 'SOURCE_DUPLICATE'); found.set(id, { path: source, line: i + 1, text: line })
    })
  }
  check(found.size === 103 && IDS.every(id => found.has(id)), 'SOURCE_IDS')
  return found
}
function requiredExternal(id) {
  const kinds = ['owner']
  if (['MVP-16', 'MVP-18', 'B-09', 'B-10', 'B-11', 'B-12', 'B-13', 'B-14', 'B-15', 'U-05', 'U-10'].includes(id)) kinds.push('hardware')
  if (['MVP-05', 'MVP-11', 'MVP-23', 'A-02', 'A-04'].includes(id)) kinds.push('real-input')
  if (['MVP-08', 'MVP-09', 'MVP-10', 'D-05', 'D-06', 'D-07', 'D-08'].includes(id)) kinds.push('real-logic')
  if (['MVP-02', 'MVP-14', 'MVP-22', 'A-02', 'B-09', 'U-01', 'U-06', 'U-07', 'U-10'].includes(id)) kinds.push('real-roon')
  return kinds
}
function declaration(mapping, read) {
  check(Number.isSafeInteger(mapping.line) && mapping.line > 0 && text(mapping.testName, 1000) && !mapping.testName.includes('${'), 'TEST_DECLARATION')
  const line = read(mapping.path).toString('utf8').split('\n')[mapping.line - 1]
  check(typeof line === 'string', 'TEST_DECLARATION')
  const start = /\b(?:test|it)(?:\.only)?\s*\(\s*(['"`])/u.exec(line)
  check(start, 'TEST_DECLARATION')
  const quote = start[1]; let raw = '', ended = false
  for (let i = start.index + start[0].length; i < line.length; i++) {
    const char = line[i]
    if (char === quote) { ended = true; break }
    if (char === '\\') { i++; check(i < line.length, 'TEST_DECLARATION'); raw += line[i] } else raw += char
  }
  check(ended, 'TEST_DECLARATION')
  if (raw.includes('${')) {
    check(mapping.template === raw, 'TEST_DECLARATION')
    const expression = raw.split(/\$\{[^}]+\}/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.+')
    check(new RegExp(`^${expression}$`, 'u').test(mapping.testName), 'TEST_DECLARATION')
  } else check(mapping.template === undefined && raw === mapping.testName, 'TEST_DECLARATION')
}
function observed(log, item) {
  const escaped = item.testName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const tap = new RegExp(`^\\s*${item.outcome === 'passed' ? 'ok' : 'not ok'}\\s+\\d+\\s*-?\\s*${escaped}\\s*(?:#.*)?$`, 'u')
  // 精确展开名称；同名跨文件拒绝复用一个泛化 TAP 成功行。
  return log.split('\n').some(line => !/#\s*(?:SKIP|TODO)\b/iu.test(line) && (tap.test(line) || (line.includes(item.testName) && new RegExp(`^\\s*${item.outcome === 'passed' ? '[✓✔]' : '[✘✖]'}\\s+\\d+\\s+`, 'u').test(line) && line.includes(' › ' + item.testName + ' ('))))
}

export function validateAcceptance(matrix, { root, requireFresh = false } = {}) {
  check(typeof root === 'string', 'ROOT_REQUIRED')
  const read = reader(path.resolve(root)); const required = requirements(read)
  keys(matrix, ['schemaVersion', 'task', 'baseCommit', 'formalReady', 'externalGate', 'sources', 'entries', 'evidence'])
  check(matrix.schemaVersion === 1 && matrix.task === 'TASK-078' && gitSha(matrix.baseCommit), 'MATRIX_IDENTITY')
  check(matrix.formalReady === false && matrix.externalGate === 'NOT_RUN', 'EXTERNAL_GATE_NOT_RUN')
  list(matrix.sources, 2); check(matrix.sources.length === 2, 'SOURCES')
  const sourceSet = new Set()
  for (const source of matrix.sources) {
    keys(source, ['path', 'sha256']); check(SOURCE_PATHS.includes(source.path) && !sourceSet.has(source.path), 'SOURCES')
    sourceSet.add(source.path); check(sha(source.sha256) && hash(read(source.path)) === source.sha256, 'SOURCE_HASH')
  }
  list(matrix.entries, 103); check(matrix.entries.length === 103, 'ENTRY_IDS')
  const entrySet = new Set(), mappings = new Map()
  for (const entry of matrix.entries) {
    keys(entry, ['id', 'source', 'status', 'mappings', 'gaps', 'externalRequirements', 'freshGate'])
    check(required.has(entry.id) && !entrySet.has(entry.id), 'ENTRY_IDS'); entrySet.add(entry.id)
    keys(entry.source, ['path', 'line', 'text']); const source = required.get(entry.id)
    check(Object.keys(source).every(k => source[k] === entry.source[k]), 'SOURCE_CLAUSE')
    list(entry.mappings, 12); list(entry.gaps, 20); check(entry.gaps.every(g => text(g)), 'GAPS')
    check(['mapped', 'unmapped'].includes(entry.status) && (entry.status === 'mapped' ? entry.mappings.length > 0 : entry.mappings.length === 0 && entry.gaps.length > 0), 'MAPPING_STATE')
    const local = new Set()
    for (const mapping of entry.mappings) {
      keys(mapping, ['path', 'line', 'testName', 'evidenceKind', 'covers'], ['template'])
      check(KINDS.includes(mapping.evidenceKind) && text(mapping.covers), 'MAPPING_KIND')
      declaration(mapping, read); const key = `${mapping.path}\0${mapping.testName}`
      check(!local.has(key), 'MAPPING_DUPLICATE'); local.add(key)
      if (mappings.has(key)) check(mappings.get(key).evidenceKind === mapping.evidenceKind, 'MAPPING_KIND')
      mappings.set(key, mapping)
    }
    list(entry.externalRequirements, 5); const external = new Set()
    for (const requirement of entry.externalRequirements) {
      keys(requirement, ['kind', 'state', 'gap'])
      check(EXTERNAL.includes(requirement.kind) && !external.has(requirement.kind) && requirement.state === 'not-run' && text(requirement.gap), 'EXTERNAL_REQUIREMENT')
      external.add(requirement.kind)
    }
    check(requiredExternal(entry.id).every(kind => external.has(kind)), 'EXTERNAL_REQUIREMENT')
    keys(entry.freshGate, ['state', 'evidenceIds']); check(['pending', 'passed', 'failed'].includes(entry.freshGate.state), 'FRESH_STATE')
    list(entry.freshGate.evidenceIds, 20); check(new Set(entry.freshGate.evidenceIds).size === entry.freshGate.evidenceIds.length, 'FRESH_STATE')
    if (entry.freshGate.state === 'pending') check(entry.freshGate.evidenceIds.length === 0, 'FRESH_STATE')
    else check(entry.status === 'mapped' && entry.freshGate.evidenceIds.length > 0, 'FRESH_STATE')
  }
  list(matrix.evidence, 100)
  const expectedCandidateFiles = matrix.evidence.length ? enumerateAcceptanceCandidateFiles(root) : []
  const evidenceById = new Map()
  for (const evidence of matrix.evidence) {
    keys(evidence, ['id', 'kind', 'executedAt', 'command', 'exitCode', 'candidate', 'log', 'cases'])
    check(typeof evidence.id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/u.test(evidence.id) && !evidenceById.has(evidence.id), 'EVIDENCE_ID')
    check(KINDS.includes(evidence.kind) && Number.isSafeInteger(evidence.exitCode) && evidence.exitCode >= 0 && evidence.exitCode <= 255, 'EVIDENCE_RESULT')
    check(typeof evidence.executedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(evidence.executedAt) && Number.isFinite(Date.parse(evidence.executedAt)) && Date.parse(evidence.executedAt) <= Date.now() + 60_000, 'EVIDENCE_TIME')
    list(evidence.command, 100); check(evidence.command.length > 0 && evidence.command.every(part => text(part, 500) && !/[\r\n\0]/u.test(part)), 'EVIDENCE_COMMAND')
    for (const ref of [evidence.log, evidence.candidate]) {
      keys(ref, ['path', 'sha256']); relative(ref.path); check(ref.path.startsWith(RUNTIME), 'EVIDENCE_PATH')
      check(sha(ref.sha256) && hash(read(ref.path, 16 * 1024 * 1024)) === ref.sha256, 'EVIDENCE_HASH')
    }
    let candidate
    try { candidate = JSON.parse(read(evidence.candidate.path).toString('utf8')) } catch { fail('CANDIDATE_JSON') }
    keys(candidate, ['baseCommit', 'files']); check(candidate.baseCommit === matrix.baseCommit, 'CANDIDATE_BASE')
    check(candidate.files && typeof candidate.files === 'object' && !Array.isArray(candidate.files), 'CANDIDATE_FILES')
    check(Object.keys(candidate.files).length > 0 && Object.keys(candidate.files).length <= 5000, 'CANDIDATE_FILES')
    for (const file of Object.keys(candidate.files)) {
      relative(file)
      // 控制数据、结果报告与输出不进入代码候选，避免录入证据时产生循环 hash。
      check(!file.startsWith('reports/') && !file.startsWith('project/') && !SOURCE_PATHS.includes(file), 'CANDIDATE_CONTROL_DATA')
    }
    const actualCandidateFiles = Object.keys(candidate.files).sort()
    check(actualCandidateFiles.length === expectedCandidateFiles.length && actualCandidateFiles.every((file, i) => file === expectedCandidateFiles[i]), 'CANDIDATE_COVERAGE')
    for (const [file, expected] of Object.entries(candidate.files)) {
      check(gitSha(expected) && blob(read(file)) === expected, 'CANDIDATE_HASH')
    }
    list(evidence.cases, 5000); check(evidence.cases.length > 0, 'CASE_EVIDENCE')
    const names = new Set(), caseKeys = new Set(), log = read(evidence.log.path, 16 * 1024 * 1024).toString('utf8')
    for (const item of evidence.cases) {
      keys(item, ['path', 'testName', 'outcome']); relative(item.path)
      check(text(item.testName, 1000) && ['passed', 'failed'].includes(item.outcome), 'CASE_EVIDENCE')
      check(Object.hasOwn(candidate.files, item.path), 'CANDIDATE_CASE')
      const key = `${item.path}\0${item.testName}`
      check(!names.has(item.testName) && !caseKeys.has(key), 'CASE_AMBIGUOUS'); names.add(item.testName); caseKeys.add(key)
      check(observed(log, item), 'CASE_EVIDENCE')
    }
    evidenceById.set(evidence.id, evidence)
  }
  for (const entry of matrix.entries) {
    if (entry.freshGate.state === 'pending') { if (requireFresh && entry.status === 'mapped') fail('FRESH_REQUIRED'); continue }
    if (requireFresh && entry.freshGate.state === 'failed') fail('FRESH_FAILED')
    const evidence = entry.freshGate.evidenceIds.map(id => { check(evidenceById.has(id), 'EVIDENCE_MISSING'); return evidenceById.get(id) })
    for (const mapping of entry.mappings) {
      const matching = evidence.filter(e => e.cases.some(c => c.path === mapping.path && c.testName === mapping.testName))
      check(matching.length > 0, 'CASE_UNCOVERED'); check(matching.every(e => e.kind === mapping.evidenceKind), 'EVIDENCE_KIND')
      if (entry.freshGate.state === 'passed') check(matching.some(e => e.exitCode === 0 && e.cases.some(c => c.path === mapping.path && c.testName === mapping.testName && c.outcome === 'passed')), 'CASE_NOT_PASSED')
    }
    if (entry.freshGate.state === 'failed') check(evidence.some(e => e.exitCode !== 0 || e.cases.some(c => c.outcome === 'failed')), 'CASE_NOT_FAILED')
  }
  return { entryCount: 103, mapped: matrix.entries.filter(e => e.status === 'mapped').length, unmapped: matrix.entries.filter(e => e.status === 'unmapped').length, pending: matrix.entries.filter(e => e.freshGate.state === 'pending').length, passed: matrix.entries.filter(e => e.freshGate.state === 'passed').length, failed: matrix.entries.filter(e => e.freshGate.state === 'failed').length, externalGate: 'NOT_RUN', formalReady: false }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.slice(2).every(arg => arg === '--require-fresh') && process.argv.slice(2).length <= 1, 'ARGUMENTS')
    const root = process.cwd(), bytes = reader(root)('project/V3_ACCEPTANCE.json')
    const result = validateAcceptance(JSON.parse(bytes.toString('utf8')), { root, requireFresh: process.argv.includes('--require-fresh') })
    console.log(`V3_ACCEPTANCE_INDEX=PASS ${JSON.stringify(result)}；仅索引与软件证据校验，外部门未通过。`)
  } catch (error) {
    const code = typeof error.message === 'string' && /^[A-Z_]+$/u.test(error.message) ? error.message : 'INVALID_INDEX'
    console.error(`V3_ACCEPTANCE_INDEX=FAIL code=${code}`); process.exitCode = 1
  }
}
