import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const issuer = new URL('../issue-v3-capacity-window.py', import.meta.url).pathname
const typescript = new URL('../../../packages/contracts/node_modules/typescript/bin/tsc', import.meta.url).pathname
const typescriptCompiler = realpathSync(new URL('../../../packages/contracts/node_modules/typescript/lib/_tsc.js', import.meta.url).pathname)
const python = '/usr/bin/python3'
const buildNode = realpathSync(process.execPath)
const buildNodeLibrary = realpathSync(join(dirname(dirname(buildNode)), 'lib', readdirSync(join(dirname(dirname(buildNode)), 'lib')).find(name => /^libnode\.[0-9]+\.dylib$/.test(name))))

function json(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }
function git(cwd, ...args) { return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim() }

function fixture(sourcePaths = ['tracked.txt', 'reports/runtime/task-078-v3-acceptance/capacity-phase-supervisor.py']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-capacity-issuer-')))
  const runtime = join(root, 'reports/runtime/task-078-v3-acceptance')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(root, 'tracked.txt'), 'frozen\n')
  const supervisor = join(runtime, 'capacity-phase-supervisor.py')
  writeFileSync(supervisor, `
from pathlib import Path
import hashlib, json, os
_GENERATION_LIMITS={'executionMs':1200000,'killGraceMs':1000,'closeMs':2000,'minimumFreeBytes':10737418240,'maximumOwnedBytes':17179869184}
def _expected_source_paths(root): return Path(root).resolve(), ${JSON.stringify(sourcePaths)}
def _sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def _strict_identity(path): return {'sha256':_sha(path)}
def _validate_source_manifest(path, root):
  value=json.loads(Path(path).read_text()); expected=_expected_source_paths(root)[1]
  if set(value['files']) != set(expected) or any(value['files'][p] != _sha(Path(root)/p) for p in expected): raise ValueError('SOURCE')
  return {'fileCount':len(expected)}
def _validate_owned_manifest(path, runtime, window_id, profile):
  value=json.loads(Path(path).read_text())
  if value['windowId'] != window_id or len(value['roots']) not in (7, 8): raise ValueError('OWNED')
  for row in value['roots']:
    p=Path(row['path']); marker=p/row['marker']['relative']
    if p.stat().st_dev != row['device'] or p.stat().st_ino != row['inode'] or _sha(marker) != row['marker']['sha256']: raise ValueError('OWNED')
  return {'ownedBytes':sum(sum(f.stat().st_size for f in Path(r['path']).rglob('*') if f.is_file()) for r in value['roots']), 'plannedBytes':9623411100, 'availableBytes':50*1024**3, 'rootCount':len(value['roots'])}
`)
  const base = join(runtime, 'old-window'); mkdirSync(base)
  json(join(base, 'owner.json'), { scope: 'old', owner: 'root', id: 'old' })
  const baseStat = BunlessStat(base)
  const baseOwned = join(base, 'owned-roots.json')
  json(baseOwned, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId: 'old', roots: [{ path: base, device: baseStat.dev, inode: baseStat.ino, marker: { relative: 'owner.json', sha256: sha(join(base, 'owner.json')) } }] })
  const partial = join(runtime, 'partial-output'); mkdirSync(partial); json(join(partial, 'command.json'), { partial: true })
  const retained = join(root, 'musicbridge-version-U5ilMT'); mkdirSync(retained); json(join(retained, 'capacity-owner.json'), { id: 'retained', scope: 'synthetic' })
  const olderPartial = join(runtime, 'older-output'); mkdirSync(olderPartial); json(join(olderPartial, 'command.json'), { partial: true })
  const olderRetained = join(root, 'musicbridge-version-0PnnN9'); mkdirSync(olderRetained); json(join(olderRetained, 'capacity-owner.json'), { id: 'older', scope: 'synthetic' })
  const terminalWindow = join(base, 'window.json')
  json(terminalWindow, { schemaVersion: 1, scope: 'musicbridge-capacity-generation-window', id: 'old', profile: 'objects-limit', label: 'partial-output', ownedManifest: { file: 'owned-roots.json', sha256: sha(baseOwned) } })
  const supervision = join(base, 'supervision'); mkdirSync(supervision)
  const terminalSupervisor = join(supervision, 'supervisor.json')
  json(terminalSupervisor, { generation: { outputDirectory: partial, files: { 'command.json': { exists: true, sha256: sha(join(partial, 'command.json')) } } } })
  const close = join(runtime, 'old-window-close.json')
  const partialStat = BunlessStat(partial); const retainedStat = BunlessStat(retained); const olderPartialStat = BunlessStat(olderPartial); const olderRetainedStat = BunlessStat(olderRetained)
  json(close, { schemaVersion: 1, scope: 'musicbridge-capacity-generation-close', state: 'SEALED_CONTROL_COVERAGE_FAILURE', window: { id: 'old', profile: 'objects-limit', label: 'partial-output', sha256: sha(terminalWindow) }, stopReason: { code: 'OWNED_MANIFEST_INCOMPLETE_PREEXISTING_CONTROLLED_ROOTS' }, omittedPreexistingRoots: [
    { kind: 'partial-output', label: 'older-output', device: olderPartialStat.dev, inode: olderPartialStat.ino, marker: { relative: 'command.json', sha256: sha(join(olderPartial, 'command.json')) } },
    { kind: 'partial-fixture', label: 'musicbridge-version-0PnnN9', device: olderRetainedStat.dev, inode: olderRetainedStat.ino, marker: { relative: 'capacity-owner.json', sha256: sha(join(olderRetained, 'capacity-owner.json')) } }
  ], supervisor: { sha256: sha(terminalSupervisor), groupEmpty: true, zombies: [] }, partialEvidence: { outputLabel: 'partial-output' }, fixture: { label: 'musicbridge-version-U5ilMT', device: retainedStat.dev, inode: retainedStat.ino, marker: { relative: 'capacity-owner.json', sha256: sha(join(retained, 'capacity-owner.json')) } }, safety: { remainingProcesses: 0, processGroupEmpty: true, replayAllowed: false, retryAuthorized: false, jointAuthorized: false }, verdict: 'CONTROL_FAILURE_NOT_A_SEED_NOT_A_CAPACITY_PASS' })
  const inventory = join(runtime, 'carryover-inventory.json')
  json(inventory, { schemaVersion: 1, scope: 'musicbridge-capacity-carryover-inventory', terminalClose: { path: close, sha256: sha(close) }, roots: [
    { path: olderPartial, device: olderPartialStat.dev, inode: olderPartialStat.ino, marker: { relative: 'command.json', sha256: sha(join(olderPartial, 'command.json')) } },
    { path: olderRetained, device: olderRetainedStat.dev, inode: olderRetainedStat.ino, marker: { relative: 'capacity-owner.json', sha256: sha(join(olderRetained, 'capacity-owner.json')) } },
    { path: partial, device: partialStat.dev, inode: partialStat.ino, marker: { relative: 'command.json', sha256: sha(join(partial, 'command.json')) } },
    { path: retained, device: retainedStat.dev, inode: retainedStat.ino, marker: { relative: 'capacity-owner.json', sha256: sha(join(retained, 'capacity-owner.json')) } }
  ] })
  execFileSync('/usr/bin/git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: root })
  const fixtureIssuer = join(root, 'scripts/ci/issue-v3-capacity-window.py')
  mkdirSync(join(root, 'scripts/ci'), { recursive: true })
  writeFileSync(fixtureIssuer, readFileSync(issuer))
  execFileSync('/usr/bin/git', ['add', 'tracked.txt', 'scripts/ci/issue-v3-capacity-window.py'], { cwd: root })
  execFileSync('/usr/bin/git', ['commit', '-m', 'fixture'], { cwd: root })
  return { root, runtime, supervisor, baseOwned, close, inventory, sourcePaths, issuer: fixtureIssuer, head: git(root, 'rev-parse', 'HEAD') }
}

function BunlessStat(path) { return JSON.parse(execFileSync(python, ['-c', `import json,os; s=os.stat(${JSON.stringify(path)}); print(json.dumps({'dev':s.st_dev,'ino':s.st_ino}))`], { encoding: 'utf8' })) }
function sha(path) { return execFileSync('/usr/bin/shasum', ['-a', '256', path], { encoding: 'utf8' }).split(' ')[0] }
function typescriptLibraryManifestSha() {
  const files = {}
  for (const name of readdirSync(dirname(typescriptCompiler)).filter(name => /^lib(?:\.[A-Za-z0-9.-]+)?\.d\.ts$/.test(name)).sort()) files[name] = createHash('sha256').update(readFileSync(join(dirname(typescriptCompiler), name))).digest('hex')
  return createHash('sha256').update(JSON.stringify({ files })).digest('hex')
}
const typescriptLibraryManifestSha256 = typescriptLibraryManifestSha()
function args(f, extra = []) { return [f.issuer, '--repo-root', f.root, '--runtime-root', f.runtime, '--supervisor', f.supervisor, '--expected-supervisor-sha256', sha(f.supervisor), '--expected-source-count', String(f.sourcePaths.length), '--base-owned-manifest', f.baseOwned, '--expected-base-owned-sha256', sha(f.baseOwned), '--carryover-inventory', f.inventory, '--expected-carryover-inventory-sha256', sha(f.inventory), '--window-dir-name', 'new-window', '--label', 'new-seed', '--profile', 'objects-limit', '--expected-branch', 'main', '--expected-head', f.head, '--consumer-python', realpathSync(python), '--expected-consumer-sha256', sha(realpathSync(python)), '--issuer-repo-root', f.root, '--expected-issuer-branch', 'main', '--expected-issuer-head', f.head, '--expected-issuer-sha256', sha(f.issuer), '--build-node', buildNode, '--expected-build-node-sha256', sha(buildNode), '--build-node-library', buildNodeLibrary, '--expected-build-node-library-sha256', sha(buildNodeLibrary), '--typescript-compiler', typescriptCompiler, '--expected-typescript-compiler-sha256', sha(typescriptCompiler), '--expected-typescript-library-manifest-sha256', typescriptLibraryManifestSha256, ...extra] }

function generatedContractFixture() {
  const generated = 'packages/contracts/dist/example.js'
  const f = fixture(['tracked.txt', 'reports/runtime/task-078-v3-acceptance/capacity-phase-supervisor.py', generated])
  mkdirSync(join(f.root, 'packages/contracts/src'), { recursive: true })
  writeFileSync(join(f.root, 'packages/contracts/src/example.ts'), 'export const candidateValue: number = 42\n')
  json(join(f.root, 'packages/contracts/tsconfig.json'), {
    compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023'],
      rootDir: 'src', outDir: 'dist', strict: true, noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true, noImplicitOverride: true, useUnknownInCatchVariables: true,
      esModuleInterop: true, forceConsistentCasingInFileNames: true, skipLibCheck: true,
      declaration: true, sourceMap: true
    },
    include: ['src/**/*.ts']
  })
  json(join(f.root, 'packages/contracts/package.json'), { name: '@fixture/contracts', private: true, type: 'module' })
  git(f.root, 'add', 'packages/contracts/src/example.ts', 'packages/contracts/tsconfig.json', 'packages/contracts/package.json')
  git(f.root, 'commit', '-m', 'candidate contracts source')
  f.head = git(f.root, 'rev-parse', 'HEAD')
  execFileSync(process.execPath, [typescript, '--project', join(f.root, 'packages/contracts/tsconfig.json')], { cwd: f.root })
  assert.equal(git(f.root, 'status', '--short', '--', generated), `?? ${generated}`)
  return { ...f, generated }
}

test('签发器把旧 partial output、fixture 与新窗口纳入 fresh owned authority', () => {
  const f = fixture()
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(result.stdout)
  const window = JSON.parse(readFileSync(join(f.runtime, 'new-window/window.json'), 'utf8'))
  const owned = JSON.parse(readFileSync(join(f.runtime, 'new-window/owned-roots.json'), 'utf8'))
  const issuerFact = JSON.parse(readFileSync(join(f.runtime, 'new-window/issuer-identity/owner.json'), 'utf8'))
  assert.equal(owned.roots.length, 7)
  assert.deepEqual(new Set(owned.roots.map(row => row.path)), new Set([join(f.runtime, 'old-window'), join(f.runtime, 'older-output'), join(f.root, 'musicbridge-version-0PnnN9'), join(f.runtime, 'partial-output'), join(f.root, 'musicbridge-version-U5ilMT'), join(f.runtime, 'new-window'), join(f.runtime, 'new-window/issuer-identity')]))
  assert.equal(window.profile, 'objects-limit')
  assert.equal(window.label, 'new-seed')
  assert.equal(Date.parse(window.deadlineAt) - Date.parse(window.issuedAt), 1_200_000)
  assert.equal(receipt.state, 'ISSUED_NOT_EXECUTED')
  assert.equal(receipt.issuerFact.sha256, sha(join(f.runtime, 'new-window/issuer-identity/owner.json')))
  assert.equal(issuerFact.issuer.sha256, sha(f.issuer))
  const issuerRoot = owned.roots.find(row => row.path === join(f.runtime, 'new-window/issuer-identity'))
  assert.equal(issuerRoot.marker.sha256, receipt.issuerFact.sha256)
  assert.equal(window.ownedManifest.sha256, sha(join(f.runtime, 'new-window/owned-roots.json')))
  assert.deepEqual(issuerFact.candidateRepository, { root: f.root, branch: 'main', head: f.head })
  assert.equal(issuerFact.buildToolchain.node.sha256, sha(realpathSync(process.execPath)))
  assert.equal(issuerFact.buildToolchain.typescriptCompiler.sha256, sha(typescriptCompiler))
  assert.equal(receipt.consumeCommand.at(-1), receipt.windowSha256)
})

test('carryover marker 漂移时在写 window.json 前失败并保留失败目录', () => {
  const f = fixture()
  writeFileSync(join(f.runtime, 'partial-output/command.json'), 'changed\n')
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CARRYOVER_IDENTITY/)
})

test('目标目录或 label 已存在时拒绝重放', () => {
  const f = fixture(); mkdirSync(join(f.runtime, 'new-seed'))
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /REPLAY_PATH/)
})

test('tracked source 与候选提交不同时拒绝签发', () => {
  const f = fixture(); writeFileSync(join(f.root, 'tracked.txt'), 'dirty\n')
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SOURCE_CANDIDATE/)
  const failure = JSON.parse(readFileSync(join(f.runtime, 'new-window/issuer-failure.json'), 'utf8'))
  assert.equal(failure.state, 'TERMINAL_ISSUER_FAILURE')
  assert.equal(failure.errorCode, 'SOURCE_CANDIDATE')
  assert.equal(failure.replayAllowed, false)
  assert.equal(failure.windowWritten, false)
})

test('由候选源码生成的 untracked contracts dist 可绑定并签发', () => {
  const f = generatedContractFixture()
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const pins = JSON.parse(readFileSync(join(f.runtime, 'new-window/source-pins.json'), 'utf8'))
  const issuerFact = JSON.parse(readFileSync(join(f.runtime, 'new-window/issuer-identity/owner.json'), 'utf8'))
  assert.equal(pins.files[f.generated], sha(join(f.root, f.generated)))
  assert.deepEqual(new Set(Object.keys(issuerFact.build.inputs)), new Set(['packages/contracts/src/example.ts', 'packages/contracts/tsconfig.json', 'packages/contracts/package.json']))
  assert.equal(issuerFact.build.command.includes('--noCheck'), true)
  assert.equal(issuerFact.build.command.includes('--noResolve'), true)
  assert.deepEqual(issuerFact.build.environment, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' })
  assert.equal(issuerFact.build.privateToolchain.nodeSha256, sha(buildNode))
  assert.equal(issuerFact.build.privateToolchain.nodeLibrarySha256, sha(buildNodeLibrary))
  assert.equal(issuerFact.build.privateToolchain.typescriptLibraryManifestSha256, typescriptLibraryManifestSha256)
})

test('由候选源码生成后被篡改的 contracts dist 拒绝签发', () => {
  const f = generatedContractFixture()
  writeFileSync(join(f.root, f.generated), 'export const candidateValue = 99;\n')
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /EMIT_BYTES/)
  const failure = JSON.parse(readFileSync(join(f.runtime, 'new-window/issuer-failure.json'), 'utf8'))
  assert.equal(failure.errorCode, 'EMIT_BYTES')
  assert.equal(failure.windowWritten, false)
})

test('contracts package 缺失或 tsconfig 越界时拒绝候选构建', () => {
  const missingPackage = generatedContractFixture()
  git(missingPackage.root, 'rm', 'packages/contracts/package.json')
  git(missingPackage.root, 'commit', '-m', 'remove package identity')
  missingPackage.head = git(missingPackage.root, 'rev-parse', 'HEAD')
  const missingResult = spawnSync(python, args(missingPackage), { encoding: 'utf8' })
  assert.notEqual(missingResult.status, 0)
  assert.match(missingResult.stderr, /SOURCE_CANDIDATE/)

  const unsafeConfig = generatedContractFixture()
  const configPath = join(unsafeConfig.root, 'packages/contracts/tsconfig.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.compilerOptions.outDir = '../outside-dist'
  json(configPath, config)
  git(unsafeConfig.root, 'add', 'packages/contracts/tsconfig.json')
  git(unsafeConfig.root, 'commit', '-m', 'unsafe output path')
  unsafeConfig.head = git(unsafeConfig.root, 'rev-parse', 'HEAD')
  const unsafeResult = spawnSync(python, args(unsafeConfig), { encoding: 'utf8' })
  assert.notEqual(unsafeResult.status, 0)
  assert.match(unsafeResult.stderr, /SOURCE_CONFIGURATION/)
  assert.equal(existsSync(join(unsafeConfig.root, 'packages/outside-dist')), false)
})

test('carryover inventory 少列任一 close 声明根时拒绝签发', () => {
  const f = fixture(); const value = JSON.parse(readFileSync(f.inventory, 'utf8')); value.roots.pop(); json(f.inventory, value)
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CARRYOVER_COVERAGE/)
})

test('旧 generation window 已使用目标 label 且尚无 output 时仍拒绝重放', () => {
  const f = fixture(); const replay = join(f.runtime, 'replay-window'); mkdirSync(replay); json(join(replay, 'window.json'), { scope: 'musicbridge-capacity-generation-window', label: 'new-seed' })
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /REPLAY_LABEL/)
})

test('source manifest 计数失败会留下不可重放终止回执', () => {
  const f = fixture()
  const result = spawnSync(python, args(f, ['--expected-source-count', '999']), { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SOURCE_MANIFEST/)
  const failure = JSON.parse(readFileSync(join(f.runtime, 'new-window/issuer-failure.json'), 'utf8'))
  assert.equal(failure.errorCode, 'SOURCE_MANIFEST')
  assert.equal(failure.replayAllowed, false)
})

test('terminal close 仍报告存活进程时拒绝签发', () => {
  const f = fixture(); const close = JSON.parse(readFileSync(f.close, 'utf8')); close.safety.remainingProcesses = 1; json(f.close, close)
  const inventory = JSON.parse(readFileSync(f.inventory, 'utf8')); inventory.terminalClose.sha256 = sha(f.close); json(f.inventory, inventory)
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CARRYOVER_TERMINAL/)
})

test('inventory 自洽但与 terminal close 标记不一致时拒绝签发', () => {
  const f = fixture(); const marker = join(f.root, 'musicbridge-version-0PnnN9/capacity-owner.json'); json(marker, { id: 'drifted', scope: 'synthetic' })
  const inventory = JSON.parse(readFileSync(f.inventory, 'utf8')); const row = inventory.roots.find(item => item.path.endsWith('musicbridge-version-0PnnN9')); row.marker.sha256 = sha(marker); json(f.inventory, inventory)
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CARRYOVER_COVERAGE/)
})

test('consumer 身份错误时在创建 authority 目录前失败', () => {
  const f = fixture()
  const result = spawnSync(python, args(f, ['--consumer-python', f.supervisor, '--expected-consumer-sha256', sha(f.supervisor)]), { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CONSUMER_IDENTITY/)
  assert.equal(existsSync(join(f.runtime, 'new-window')), false)
})

test('issuer 或候选构建工具链身份错误时在创建 authority 目录前失败', () => {
  const issuerMismatch = fixture()
  const issuerResult = spawnSync(python, args(issuerMismatch, ['--expected-issuer-sha256', '0'.repeat(64)]), { encoding: 'utf8' })
  assert.notEqual(issuerResult.status, 0)
  assert.match(issuerResult.stderr, /ISSUER_IDENTITY/)
  assert.equal(existsSync(join(issuerMismatch.runtime, 'new-window')), false)

  const compilerMismatch = fixture()
  const compilerResult = spawnSync(python, args(compilerMismatch, ['--expected-typescript-compiler-sha256', '0'.repeat(64)]), { encoding: 'utf8' })
  assert.notEqual(compilerResult.status, 0)
  assert.match(compilerResult.stderr, /BUILD_TOOLCHAIN_IDENTITY/)
  assert.equal(existsSync(join(compilerMismatch.runtime, 'new-window')), false)
})

test('旧 authority window 损坏或为符号链接时 replay 审计 fail-closed', () => {
  const malformed = fixture(); const malformedDir = join(malformed.runtime, 'malformed-window'); mkdirSync(malformedDir); writeFileSync(join(malformedDir, 'window.json'), '{')
  const malformedResult = spawnSync(python, args(malformed), { encoding: 'utf8' })
  assert.notEqual(malformedResult.status, 0)
  assert.match(malformedResult.stderr, /REPLAY_AUDIT/)

  const linked = fixture(); const linkedDir = join(linked.runtime, 'linked-window'); mkdirSync(linkedDir); symlinkSync(join(linked.runtime, 'old-window/window.json'), join(linkedDir, 'window.json'))
  const linkedResult = spawnSync(python, args(linked), { encoding: 'utf8' })
  assert.notEqual(linkedResult.status, 0)
  assert.match(linkedResult.stderr, /REPLAY_AUDIT/)

  const linkedClose = fixture(); symlinkSync(join(linkedClose.runtime, 'old-window-close.json'), join(linkedClose.runtime, 'linked-generation-close.json'))
  const linkedCloseResult = spawnSync(python, args(linkedClose), { encoding: 'utf8' })
  assert.notEqual(linkedCloseResult.status, 0)
  assert.match(linkedCloseResult.stderr, /REPLAY_AUDIT/)
})

test('replay 审计忽略其他阶段的字符串 window，但拒绝 generation 与顶层 primitive 形状', () => {
  const unrelated = fixture()
  json(join(unrelated.runtime, 'phase-window-close.json'), {
    schemaVersion: 1,
    scope: 'musicbridge-capacity-phase-window-close',
    window: 'phase-window'
  })
  const unrelatedResult = spawnSync(python, args(unrelated), { encoding: 'utf8' })
  assert.equal(unrelatedResult.status, 0, unrelatedResult.stderr)

  const malformedGeneration = fixture()
  json(join(malformedGeneration.runtime, 'generation-window-close.json'), {
    schemaVersion: 1,
    scope: 'musicbridge-capacity-generation-close',
    window: 'generation-window'
  })
  const malformedGenerationResult = spawnSync(python, args(malformedGeneration), { encoding: 'utf8' })
  assert.notEqual(malformedGenerationResult.status, 0)
  assert.match(malformedGenerationResult.stderr, /REPLAY_AUDIT/)
  assert.doesNotMatch(malformedGenerationResult.stderr, /ISSUER_INTERNAL/)

  const primitive = fixture()
  json(join(primitive.runtime, 'primitive-window-close.json'), 'primitive-window')
  const primitiveResult = spawnSync(python, args(primitive), { encoding: 'utf8' })
  assert.notEqual(primitiveResult.status, 0)
  assert.match(primitiveResult.stderr, /REPLAY_AUDIT/)
  assert.doesNotMatch(primitiveResult.stderr, /ISSUER_INTERNAL/)
})

test('签发中途失败目录由下一 fresh authority 纳入 owned 闭包', () => {
  const f = fixture(); writeFileSync(join(f.root, 'tracked.txt'), 'dirty\n')
  const failed = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.notEqual(failed.status, 0)
  writeFileSync(join(f.root, 'tracked.txt'), 'frozen\n')
  const recovered = spawnSync(python, args(f, ['--window-dir-name', 'new-window-02', '--label', 'new-seed-02']), { encoding: 'utf8' })
  assert.equal(recovered.status, 0, recovered.stderr)
  const owned = JSON.parse(readFileSync(join(f.runtime, 'new-window-02/owned-roots.json'), 'utf8'))
  assert.equal(owned.roots.some(row => row.path === join(f.runtime, 'new-window')), true)
  assert.equal(owned.roots.length, 8)
})

test('approved window 发布前失败只留下不可执行 pending 与终止回执', () => {
  const f = fixture()
  const injection = [
    'import importlib.util, sys',
    "spec=importlib.util.spec_from_file_location('issuer_under_test', sys.argv[1])",
    'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'original=module.os.rename',
    "def reject(source, target):\n    if str(source).endswith('window.pending.json'): raise OSError('injected-before-publish')\n    return original(source, target)",
    'module.os.rename=reject',
    'raise SystemExit(module.main(sys.argv[2:]))'
  ].join('\n')
  const result = spawnSync(python, ['-c', injection, f.issuer, ...args(f).slice(1)], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  const parent = join(f.runtime, 'new-window')
  assert.equal(existsSync(join(parent, 'window.json')), false)
  assert.equal(existsSync(join(parent, 'window.pending.json')), true)
  const failure = JSON.parse(readFileSync(join(parent, 'issuer-failure.json'), 'utf8'))
  assert.equal(failure.windowWritten, false)
  assert.equal(failure.replayAllowed, false)
})
