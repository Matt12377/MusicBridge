import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const issuer = new URL('../issue-v3-capacity-window.py', import.meta.url).pathname
const python = '/usr/bin/python3'

function json(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }
function git(cwd, ...args) { return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim() }

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-capacity-issuer-')))
  const runtime = join(root, 'reports/runtime/task-078-v3-acceptance')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(root, 'tracked.txt'), 'frozen\n')
  const supervisor = join(runtime, 'capacity-phase-supervisor.py')
  writeFileSync(supervisor, `
from pathlib import Path
import hashlib, json, os
_GENERATION_LIMITS={'executionMs':1200000,'killGraceMs':1000,'closeMs':2000,'minimumFreeBytes':10737418240,'maximumOwnedBytes':17179869184}
def _expected_source_paths(root): return Path(root).resolve(), ['tracked.txt', 'reports/runtime/task-078-v3-acceptance/capacity-phase-supervisor.py']
def _sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def _strict_identity(path): return {'sha256':_sha(path)}
def _validate_source_manifest(path, root):
  value=json.loads(Path(path).read_text()); expected=_expected_source_paths(root)[1]
  if set(value['files']) != set(expected) or any(value['files'][p] != _sha(Path(root)/p) for p in expected): raise ValueError('SOURCE')
  return {'fileCount':len(expected)}
def _validate_owned_manifest(path, runtime, window_id, profile):
  value=json.loads(Path(path).read_text())
  if value['windowId'] != window_id or len(value['roots']) not in (6, 7): raise ValueError('OWNED')
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
  execFileSync('/usr/bin/git', ['add', 'tracked.txt'], { cwd: root })
  execFileSync('/usr/bin/git', ['commit', '-m', 'fixture'], { cwd: root })
  return { root, runtime, supervisor, baseOwned, close, inventory, head: git(root, 'rev-parse', 'HEAD') }
}

function BunlessStat(path) { return JSON.parse(execFileSync(python, ['-c', `import json,os; s=os.stat(${JSON.stringify(path)}); print(json.dumps({'dev':s.st_dev,'ino':s.st_ino}))`], { encoding: 'utf8' })) }
function sha(path) { return execFileSync('/usr/bin/shasum', ['-a', '256', path], { encoding: 'utf8' }).split(' ')[0] }
function args(f, extra = []) { return [issuer, '--repo-root', f.root, '--runtime-root', f.runtime, '--supervisor', f.supervisor, '--expected-supervisor-sha256', sha(f.supervisor), '--expected-source-count', '2', '--base-owned-manifest', f.baseOwned, '--expected-base-owned-sha256', sha(f.baseOwned), '--carryover-inventory', f.inventory, '--expected-carryover-inventory-sha256', sha(f.inventory), '--window-dir-name', 'new-window', '--label', 'new-seed', '--profile', 'objects-limit', '--expected-branch', 'main', '--expected-head', f.head, '--consumer-python', realpathSync(python), '--expected-consumer-sha256', sha(realpathSync(python)), ...extra] }

test('签发器把旧 partial output、fixture 与新窗口纳入 fresh owned authority', () => {
  const f = fixture()
  const result = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(result.stdout)
  const window = JSON.parse(readFileSync(join(f.runtime, 'new-window/window.json'), 'utf8'))
  const owned = JSON.parse(readFileSync(join(f.runtime, 'new-window/owned-roots.json'), 'utf8'))
  assert.equal(owned.roots.length, 6)
  assert.deepEqual(new Set(owned.roots.map(row => row.path)), new Set([join(f.runtime, 'old-window'), join(f.runtime, 'older-output'), join(f.root, 'musicbridge-version-0PnnN9'), join(f.runtime, 'partial-output'), join(f.root, 'musicbridge-version-U5ilMT'), join(f.runtime, 'new-window')]))
  assert.equal(window.profile, 'objects-limit')
  assert.equal(window.label, 'new-seed')
  assert.equal(Date.parse(window.deadlineAt) - Date.parse(window.issuedAt), 1_200_000)
  assert.equal(receipt.state, 'ISSUED_NOT_EXECUTED')
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

test('签发中途失败目录由下一 fresh authority 纳入 owned 闭包', () => {
  const f = fixture(); writeFileSync(join(f.root, 'tracked.txt'), 'dirty\n')
  const failed = spawnSync(python, args(f), { encoding: 'utf8' })
  assert.notEqual(failed.status, 0)
  writeFileSync(join(f.root, 'tracked.txt'), 'frozen\n')
  const recovered = spawnSync(python, args(f, ['--window-dir-name', 'new-window-02', '--label', 'new-seed-02']), { encoding: 'utf8' })
  assert.equal(recovered.status, 0, recovered.stderr)
  const owned = JSON.parse(readFileSync(join(f.runtime, 'new-window-02/owned-roots.json'), 'utf8'))
  assert.equal(owned.roots.some(row => row.path === join(f.runtime, 'new-window')), true)
  assert.equal(owned.roots.length, 7)
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
  const result = spawnSync(python, ['-c', injection, issuer, ...args(f).slice(1)], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  const parent = join(f.runtime, 'new-window')
  assert.equal(existsSync(join(parent, 'window.json')), false)
  assert.equal(existsSync(join(parent, 'window.pending.json')), true)
  const failure = JSON.parse(readFileSync(join(parent, 'issuer-failure.json'), 'utf8'))
  assert.equal(failure.windowWritten, false)
  assert.equal(failure.replayAllowed, false)
})
