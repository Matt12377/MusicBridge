import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateAcceptance, enumerateAcceptanceCandidateFiles } from '../verify-v3-acceptance.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const sourcePaths = ['docs/prd/MUSICBRIDGE_V3_PRD_v0.3.md', 'project/V3_DEVELOPMENT_PACK.md']
const digest = data => createHash('sha256').update(data).digest('hex')
const blob = data => createHash('sha1').update(`blob ${Buffer.byteLength(data)}\0`).update(data).digest('hex')
const baseCommit = 'c54cf8b71b493482d8ad061d38123c444d718ad0'
const runtime = 'reports/runtime/task-078-v3-acceptance/'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'v3-acceptance-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (file, data) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), data) }
  const sources = sourcePaths.map(file => { const data = readFileSync(path.join(repository, file)); write(file, data); return { path: file, sha256: digest(data) } })
  const entries = []
  for (const file of sourcePaths) {
    const lines = readFileSync(path.join(root, file), 'utf8').split('\n')
    let inMvp = false
    lines.forEach((line, i) => {
      if (line.startsWith('# 75.')) inMvp = true
      if (line.startsWith('# 76.')) inMvp = false
      const mvp = inMvp && /^(\d+)\. (.+)$/u.exec(line)
      const gate = /^\| ([A-EU]-\d{2}) \|/u.exec(line)
      if (!mvp && !gate) return
      const id = mvp ? `MVP-${mvp[1].padStart(2, '0')}` : gate[1]
      entries.push({ id, source: { path: file, line: i + 1, text: line }, status: 'mapped', mappings: [{ path: 'packages/bridge-core/test/sample.test.mjs', line: 1, testName: '合成库存守恒', evidenceKind: 'synthetic', covers: '合成库存事务，不代表整条验收' }], gaps: ['本轮尚未验证该条完整产品范围。'], externalRequirements: [{ kind: 'owner', state: 'not-run', gap: 'Owner产品验收尚未执行。' }, { kind: 'hardware', state: 'not-run', gap: '真实设备不在本次合成验证范围。' }, { kind: 'real-input', state: 'not-run', gap: '未读取实际用户资料。' }, { kind: 'real-logic', state: 'not-run', gap: '未操作真实Logic。' }, { kind: 'real-roon', state: 'not-run', gap: '未连接真实Roon。' }], freshGate: { state: 'pending', evidenceIds: [] } })
    })
  }
  write('packages/bridge-core/test/sample.test.mjs', "test('合成库存守恒', () => {});\n")
  const matrix = { schemaVersion: 1, task: 'TASK-078', baseCommit, formalReady: false, externalGate: 'NOT_RUN', sources, entries, evidence: [] }
  return { root, write, matrix }
}

function addEvidence(f, options = {}) {
  const testPath = 'packages/bridge-core/test/sample.test.mjs', logPath = runtime + 'fresh.log', candidatePath = runtime + 'candidate.json'
  const candidate = JSON.stringify({ baseCommit, files: { [testPath]: blob(readFileSync(path.join(f.root, testPath))) } })
  const log = options.log ?? 'TAP version 13\nok 1 - 合成库存守恒\n1..1\n# tests 1\n# pass 1\n# fail 0\n'
  f.write(candidatePath, candidate); f.write(logPath, log)
  const evidence = { id: 'fresh-unit', kind: 'synthetic', executedAt: new Date().toISOString(), command: ['node', '--test', testPath], exitCode: 0, candidate: { path: candidatePath, sha256: digest(candidate) }, log: { path: logPath, sha256: digest(log) }, cases: [{ path: testPath, testName: '合成库存守恒', outcome: 'passed' }] }
  f.matrix.evidence.push(evidence)
  f.matrix.entries[0].freshGate = { state: 'passed', evidenceIds: [evidence.id] }
  return evidence
}

test('103条仅映射且fresh pending可校验，但不是自动验收通过', t => {
  const f = fixture(t); const result = validateAcceptance(f.matrix, { root: f.root })
  assert.equal(result.entryCount, 103); assert.equal(result.passed, 0); assert.equal(result.pending, 103)
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root, requireFresh: true }), /FRESH_REQUIRED/u)
})
test('遗漏、重复、未知ID以及修改权威条款均拒绝', t => {
  const f = fixture(t)
  for (const edit of [m => m.entries.pop(), m => m.entries.push(m.entries[0]), m => { m.entries[0].id = 'MVP-31' }, m => { m.entries[0].source.text = '缩减范围' }, m => { m.sources[0].sha256 = '0'.repeat(64) }]) {
    const m = structuredClone(f.matrix); edit(m); assert.throws(() => validateAcceptance(m, { root: f.root }))
  }
})
test('来源、测试和证据只允许仓库内常规文件，拒绝绝对路径、穿越和符号链接', t => {
  const f = fixture(t)
  for (const bad of ['/tmp/secret', '../secret', 'test/../secret', 'test\\secret', 'file:///tmp/secret']) {
    const m = structuredClone(f.matrix); m.entries[0].mappings[0].path = bad; assert.throws(() => validateAcceptance(m, { root: f.root }), /PATH/u)
  }
  symlinkSync(path.join(f.root, 'packages/bridge-core/test/sample.test.mjs'), path.join(f.root, 'packages/bridge-core/test/link.test.mjs'))
  f.matrix.entries[0].mappings[0].path = 'packages/bridge-core/test/link.test.mjs'
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /PATH/u)
})
test('测试名和声明位置必须吻合，不接受只存在测试文件', t => {
  const f = fixture(t); f.matrix.entries[0].mappings[0].testName = '不存在的通过'
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /TEST_DECLARATION/u)
})
test('动态测试需要实际展开名与对应模板，不能用泛名代表所有case', t => {
  const f = fixture(t); f.write('packages/bridge-core/test/sample.test.mjs', 'test(`${cut} 崩溃后恢复`, () => {});\n')
  for (const e of f.matrix.entries) e.mappings[0] = { ...e.mappings[0], testName: 'VERIFIED 崩溃后恢复', template: '${cut} 崩溃后恢复' }
  assert.equal(validateAcceptance(f.matrix, { root: f.root }).entryCount, 103)
  f.matrix.entries[0].mappings[0].testName = '${cut} 崩溃后恢复'
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /TEST_DECLARATION/u)
})
test('有精确case成功日志、SHA与当前候选才可标软件子范围passed', t => {
  const f = fixture(t); addEvidence(f)
  assert.equal(validateAcceptance(f.matrix, { root: f.root }).passed, 1)
  f.write('packages/bridge-core/test/sample.test.mjs', "test('合成库存守恒', () => { throw new Error() });\n")
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /CANDIDATE/u)
})
test('文件存在、总PASS、失败行和SKIP不能作为该case成功证据', t => {
  for (const log of ['全部通过', '# tests 99\n# pass 99', 'not ok 1 - 合成库存守恒\n', 'ok 1 - 合成库存守恒 # SKIP\n']) {
    const f = fixture(t); addEvidence(f, { log }); assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /CASE_EVIDENCE/u)
  }
})
test('同名case若没有文件区分不能给两个测试文件重复授予通过', t => {
  const f = fixture(t); const e = addEvidence(f); f.write('packages/bridge-core/test/other.test.mjs', "test('合成库存守恒', () => {});\n")
  e.cases.push({ path: 'packages/bridge-core/test/other.test.mjs', testName: '合成库存守恒', outcome: 'passed' })
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }))
})
test('旧报告或本轮日志内容hash漂移不能冒新证据', t => {
  const f = fixture(t); const e = addEvidence(f)
  f.write(e.log.path, 'changed'); assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /EVIDENCE/u)
  e.log.path = 'reports/TASK-077_RESULT.md'; assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /PATH/u)
})
test('非零退出或failed case不能升级为passed，失败仍可如实记录', t => {
  const f = fixture(t); const e = addEvidence(f, { log: 'not ok 1 - 合成库存守恒\n' }); e.exitCode = 1; e.cases[0].outcome = 'failed'
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }))
  f.matrix.entries[0].freshGate.state = 'failed'
  assert.equal(validateAcceptance(f.matrix, { root: f.root }).failed, 1)
})
test('合成、原生无设备证据不能升级hardware/Owner、formalReady或整门', t => {
  const f = fixture(t)
  for (const edit of [m => { m.formalReady = true }, m => { m.externalGate = 'PASS' }, m => { m.entries[0].externalRequirements[0].state = 'passed' }, m => { m.entries.find(e => e.id === 'B-09').externalRequirements = [] }]) {
    const m = structuredClone(f.matrix); edit(m); assert.throws(() => validateAcceptance(m, { root: f.root }))
  }
  const e = addEvidence(f); e.kind = 'native-no-device'
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /EVIDENCE_KIND/u)
})
test('unmapped必须显式缺口且不允许软件passed；requireFresh不偷偷清缺口', t => {
  const f = fixture(t); const row = f.matrix.entries[0]; row.status = 'unmapped'; row.mappings = []; row.gaps = []
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }))
  row.gaps = ['没有覆盖']; assert.equal(validateAcceptance(f.matrix, { root: f.root }).unmapped, 1)
  row.freshGate.state = 'passed'; assert.throws(() => validateAcceptance(f.matrix, { root: f.root }))
})
test('一条映射含多个实际case时必须全部取证，不能用同文件一个成功冒充其它case', t => {
  const f = fixture(t); const e = addEvidence(f)
  f.write('packages/bridge-core/test/second.test.mjs', "test('另一个故障窗口', () => {});\n")
  const candidate = JSON.parse(readFileSync(path.join(f.root, e.candidate.path), 'utf8'))
  candidate.files['packages/bridge-core/test/second.test.mjs'] = blob(readFileSync(path.join(f.root, 'packages/bridge-core/test/second.test.mjs')))
  const bytes = JSON.stringify(candidate); f.write(e.candidate.path, bytes); e.candidate.sha256 = digest(bytes)
  f.matrix.entries[0].mappings.push({ path: 'packages/bridge-core/test/second.test.mjs', line: 1, testName: '另一个故障窗口', evidenceKind: 'synthetic', covers: '另一个具体故障窗口' })
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /CASE_UNCOVERED/u)
})
test('控制文件不能进入候选造成循环指纹，候选不允许遗漏实际case文件', t => {
  const f = fixture(t); const e = addEvidence(f)
  const candidate = JSON.parse(readFileSync(path.join(f.root, e.candidate.path), 'utf8'))
  f.write('project/STATUS.json', '{}'); candidate.files['project/STATUS.json'] = blob('{}')
  let bytes = JSON.stringify(candidate); f.write(e.candidate.path, bytes); e.candidate.sha256 = digest(bytes)
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /CANDIDATE_CONTROL_DATA/u)
  delete candidate.files['project/STATUS.json']; delete candidate.files['packages/bridge-core/test/sample.test.mjs']; candidate.files['packages/bridge-core/test/unused.mjs'] = blob('')
  f.write('packages/bridge-core/test/unused.mjs', ''); bytes = JSON.stringify(candidate); f.write(e.candidate.path, bytes); e.candidate.sha256 = digest(bytes)
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /CANDIDATE_COVERAGE/u)
})
test('本轮Playwright明确成功行可以取证，但pending不接受偷偷挂上的证据', t => {
  const f = fixture(t); const e = addEvidence(f, { log: '  ✓  1 packages/bridge-core/test/sample.test.mjs:1:1 › 合成库存守恒 (12ms)\n' })
  e.kind = 'native-no-device'; for (const entry of f.matrix.entries) entry.mappings[0].evidenceKind = 'native-no-device'
  assert.equal(validateAcceptance(f.matrix, { root: f.root }).passed, 1)
  f.matrix.entries[0].freshGate.state = 'pending'
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /FRESH_STATE/u)
})
test('严格新鲜模式拒绝已记录failed；普通索引模式仍允许如实保存失败', t => {
  const f = fixture(t); const e = addEvidence(f, { log: 'not ok 1 - 合成库存守恒\n' })
  e.exitCode = 1; e.cases[0].outcome = 'failed'
  for (const entry of f.matrix.entries) entry.freshGate = { state: 'failed', evidenceIds: [e.id] }
  assert.equal(validateAcceptance(f.matrix, { root: f.root }).failed, 103)
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root, requireFresh: true }), /FRESH_FAILED/u)
})

// SPEC R1：有测试通过不代表候选已包含实际受验生产代码。
test('候选必须完整包含固定范围生产与配置，漏项拒绝且源码变更使旧证据失效', t => {
  const f = fixture(t), source = 'packages/bridge-core/src/recording-fixture.ts', config = 'packages/bridge-core/tsconfig.test.json'
  f.write(source, 'export const enabled = true;\n'); f.write(config, '{}\n')
  const e = addEvidence(f)
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /CANDIDATE_COVERAGE/u)
  const candidate = JSON.parse(readFileSync(path.join(f.root, e.candidate.path), 'utf8'))
  for (const file of [source, config]) candidate.files[file] = blob(readFileSync(path.join(f.root, file)))
  const bytes = JSON.stringify(candidate); f.write(e.candidate.path, bytes); e.candidate.sha256 = digest(bytes)
  assert.equal(validateAcceptance(f.matrix, { root: f.root }).passed, 1)
  f.write(source, 'export const enabled = false;\n')
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /CANDIDATE_HASH/u)
})

test('候选枚举涵盖全部固定源码根与关键配置且排除生成物和控制数据', t => {
  const f = fixture(t)
  const included = [
    'packages/contracts/src/index.ts', 'packages/contracts/test/contract.test.ts',
    'packages/bridge-core/src/core.ts', 'packages/bridge-core/test/fixture.sql',
    'apps/desktop/src/main.ts', 'apps/desktop/test/ui.test.ts', 'apps/desktop/e2e/app.spec.ts',
    'apps/desktop/electron-gate/startup.test.ts', 'apps/desktop/scripts/gate.mjs',
    'scripts/ci/nested/check.mjs', 'scripts/deploy/app.sh', 'scripts/native/build.mjs',
    'native/output-helper/frame-pump.cpp', 'native/output-lifecycle/device-session.hpp',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    ...['packages/contracts', 'packages/bridge-core', 'apps/desktop'].flatMap(base => [`${base}/package.json`, `${base}/tsconfig.json`, `${base}/tsconfig.test.json`]),
    'apps/desktop/electron.vite.config.ts', 'apps/desktop/playwright.config.ts', 'apps/desktop/build/entitlements.mac.plist',
  ]
  const excluded = ['project/STATUS.json', 'project/V3_ACCEPTANCE.json', 'reports/runtime/generated.log',
    'apps/desktop/dist/main.js', 'apps/desktop/native/output/manifest.json', 'apps/desktop/build/icon.png',
    'packages/contracts/dist/index.js', 'node_modules/fake/index.js']
  for (const file of [...included, ...excluded]) f.write(file, '{}\n')
  assert.deepEqual(enumerateAcceptanceCandidateFiles(f.root), [...included, 'packages/bridge-core/test/sample.test.mjs'].sort())
  const e = addEvidence(f), candidate = JSON.parse(readFileSync(path.join(f.root, e.candidate.path), 'utf8'))
  candidate.files = Object.fromEntries(enumerateAcceptanceCandidateFiles(f.root).map(file => [file, blob(readFileSync(path.join(f.root, file)))]))
  const update = () => { const bytes = JSON.stringify(candidate); f.write(e.candidate.path, bytes); e.candidate.sha256 = digest(bytes) }
  update(); assert.equal(validateAcceptance(f.matrix, { root: f.root }).passed, 1)
  candidate.files['apps/desktop/dist/main.js'] = blob('{}\n'); update()
  assert.throws(() => validateAcceptance(f.matrix, { root: f.root }), /CANDIDATE_COVERAGE/u)
})

test('候选固定源码根拒绝链接、非常规路径和超限文件，不静默跳过', t => {
  const f = fixture(t)
  f.write('packages/bridge-core/src/core.ts', 'export {}')
  symlinkSync(path.join(f.root, 'packages/bridge-core/src/core.ts'), path.join(f.root, 'packages/bridge-core/src/linked.ts'))
  assert.throws(() => enumerateAcceptanceCandidateFiles(f.root), /PATH/u)
  rmSync(path.join(f.root, 'packages/bridge-core/src/linked.ts'))
  f.write('packages/bridge-core/src/huge.ts', Buffer.alloc(2 * 1024 * 1024 + 1))
  assert.throws(() => enumerateAcceptanceCandidateFiles(f.root), /FILE_BUDGET/u)
  rmSync(path.join(f.root, 'packages/bridge-core/src/huge.ts'))
  f.write('native/output-helper', '')
  assert.throws(() => enumerateAcceptanceCandidateFiles(f.root), /PATH/u)
})
