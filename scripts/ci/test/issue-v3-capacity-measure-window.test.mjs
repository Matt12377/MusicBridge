import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const sourceIssuer = new URL('../issue-v3-capacity-measure-window.py', import.meta.url).pathname
const sourceHelper = new URL('../issue-v3-capacity-window.py', import.meta.url).pathname
const python = realpathSync('/opt/homebrew/bin/python3')
const buildNode = realpathSync('/opt/homebrew/bin/node')
const buildNodeLibrary = realpathSync(join(
  dirname(dirname(buildNode)), 'lib',
  readdirSync(join(dirname(dirname(buildNode)), 'lib')).find((name) => /^libnode\.[0-9]+\.dylib$/.test(name)),
))
const typescriptCompiler = realpathSync(new URL('../../../packages/contracts/node_modules/typescript/lib/_tsc.js', import.meta.url).pathname)

function json(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }
function sha(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function git(cwd, ...args) { return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim() }
function identity(path, marker) {
  const stat = execFileSync(python, ['-c', `import json,os; s=os.stat(${JSON.stringify(path)}); print(json.dumps([s.st_dev,s.st_ino]))`], { encoding: 'utf8' })
  const [device, inode] = JSON.parse(stat)
  return { path, device, inode, marker: { relative: marker, sha256: sha(join(path, marker)) } }
}
function toolchainLibraryManifestSha() {
  const files = {}
  for (const name of readdirSync(dirname(typescriptCompiler)).filter((name) => /^lib(?:\.[A-Za-z0-9.-]+)?\.d\.ts$/.test(name)).sort()) {
    files[name] = sha(join(dirname(typescriptCompiler), name))
  }
  return createHash('sha256').update(JSON.stringify({ files })).digest('hex')
}
const typescriptLibraryManifestSha256 = toolchainLibraryManifestSha()

function supervisorSource(sourcePaths) {
  return `
from pathlib import Path
import hashlib, json, os
_MEASURE_LIMITS={'executionMs':900000,'killGraceMs':1000,'closeMs':2000,'minimumFreeBytes':10737418240,'maximumOwnedBytes':17179869184}
def _sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def _strict_json(path):
  path=Path(path); data=json.loads(path.read_text())
  return data, {'sha256':_sha(path)}
def _strict_identity(path):
  path=Path(path); return {'sha256':_sha(path), 'size':path.stat().st_size}
def _expected_source_paths(root): return Path(root).resolve(), ${JSON.stringify(sourcePaths)}
def _validate_source_manifest(path, root):
  value,ident=_strict_json(path); expected=_expected_source_paths(root)[1]
  if set(value.get('files',{})) != set(expected) or any(value['files'][p] != _sha(Path(root)/p) for p in expected): raise ValueError('SOURCE_MANIFEST')
  return {'fileCount':len(expected),'manifestSha256':ident['sha256'],'manifestIdentity':ident,
          'fileIdentities':{p:_strict_identity(Path(root)/p) for p in expected}}
def _validate_owned_manifest(path, runtime, window_id, profile, planned_bytes=None, future_path=None, future_state=None):
  value,ident=_strict_json(path)
  if value.get('windowId') != window_id or profile != 'objects-limit' or len(value.get('roots',[])) != 63: raise ValueError('OWNED_MANIFEST')
  if value.get('futureRoots') != [str(future_path)] or future_state != 'absent' or Path(future_path).exists(): raise ValueError('OWNED_MANIFEST')
  roots={}
  for row in value['roots']:
    p=Path(row['path']); marker=p/row['marker']['relative']; info=p.stat()
    if info.st_dev != row['device'] or info.st_ino != row['inode'] or _sha(marker) != row['marker']['sha256']: raise ValueError('OWNED_MANIFEST')
    roots[str(p)]={}
  return {'rootCount':64,'ownedBytes':4096,'plannedBytes':planned_bytes,'availableBytes':64*1024**3,
          'manifestSha256':ident['sha256'],'manifestIdentity':ident,'rootIdentities':roots,
          'futureRoots':[str(future_path)],'futureRootIdentities':{}}
def _validate_measure_authority(parent, runtime, repo_root, window_sha256, initial=None):
  parent=Path(parent); window,window_identity=_strict_json(parent/'window.json')
  if window_identity['sha256'] != window_sha256: raise ValueError('AUTHORITY_INVALID')
  source=_validate_source_manifest(parent/'source-pins.json', repo_root)
  seed=Path(runtime)/window['seedLabel']; metadata,metadata_identity=_strict_json(seed/'seed.json')
  fixture=Path(metadata['fixtureDirectory'])
  planned=2*(seed/'seed.sqlite').stat().st_size+256*1024**2
  owned=_validate_owned_manifest(parent/'owned-roots.json', runtime, window['id'], window['profile'],
                                 planned_bytes=planned, future_path=Path(runtime)/window['label'], future_state='absent')
  required={str(parent),str(seed),str(fixture)}
  if not required.issubset(owned['rootIdentities']): raise ValueError('OWNED_MANIFEST')
  return {'authorityStable':True,'sourcePinsValid':True,'ownedRootsValid':True,'spaceValid':True,
          'seedValid':True,'sourceFileCount':source['fileCount'],'ownedRootCount':owned['rootCount'],
          'ownedBytes':owned['ownedBytes'],'plannedBytes':owned['plannedBytes'],'availableBytes':owned['availableBytes'],
          'seedSnapshotBytes':(seed/'seed.sqlite').stat().st_size,'_snapshot':{'fixed':True}}
`
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-measure-issuer-')))
  const runtime = join(root, 'reports/runtime/task-078-v3-acceptance')
  mkdirSync(runtime, { recursive: true })
  const supervisor = join(runtime, 'capacity-phase-supervisor.py')
  const sourcePaths = [
    'reports/runtime/task-078-v3-acceptance/capacity-phase-supervisor.py',
    ...Array.from({ length: 242 }, (_, index) => `candidate/source-${String(index + 1).padStart(3, '0')}.txt`),
  ]
  for (const relative of sourcePaths.slice(1)) {
    const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `candidate ${relative}\n`)
  }
  writeFileSync(supervisor, supervisorSource(sourcePaths))

  const generation = join(runtime, 'objects-generation-window')
  mkdirSync(join(generation, 'issuer-identity'), { recursive: true })
  const generationId = randomUUID()
  json(join(generation, 'owner.json'), { scope: 'musicbridge-capacity-generation-window', owner: 'root', id: generationId })
  json(join(generation, 'issuer-identity/owner.json'), { scope: 'musicbridge-capacity-authority-issuer', id: generationId })
  const generationRoots = [identity(generation, 'owner.json'), identity(join(generation, 'issuer-identity'), 'owner.json')]
  for (let index = 0; index < 57; index += 1) {
    const path = join(runtime, `controlled-${String(index + 1).padStart(2, '0')}`); mkdirSync(path)
    json(join(path, 'owner.json'), { scope: 'controlled-root', index })
    generationRoots.push(identity(path, 'owner.json'))
  }
  assert.equal(generationRoots.length, 59)
  const generationOwned = join(generation, 'owned-roots.json')
  json(generationOwned, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId: generationId, roots: generationRoots })
  const sourcePins = {}
  for (const relative of sourcePaths) sourcePins[relative] = sha(join(root, relative))
  const generationSource = join(generation, 'source-pins.json')
  json(generationSource, { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: sourcePins })

  const seedLabel = 'objects-seed'
  const seed = join(runtime, seedLabel); mkdirSync(seed)
  const externalFixture = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-version-')))
  const fixtureMarker = { id: randomUUID(), scope: 'musicbridge-capacity-synthetic-only' }
  json(join(externalFixture, 'capacity-owner.json'), fixtureMarker)
  writeFileSync(join(seed, 'seed.sqlite'), 'synthetic sqlite snapshot\n')
  const snapshotSha = sha(join(seed, 'seed.sqlite'))
  json(join(seed, 'seed.json'), {
    schema: 21, classification: 'capacity-seed/non-performance', profile: 'objects-limit',
    integrity: 'passed', retained: true, growth: { state: 'target-reached' },
    nextPlanId: randomUUID(), nextPlanHash: '6'.repeat(64), budget: { bytes: 19 },
    fixtureDirectory: externalFixture, marker: fixtureMarker, snapshotSha256: snapshotSha,
  })
  json(join(seed, 'source-before.json'), { files: sourcePins })
  cpSync(join(seed, 'source-before.json'), join(seed, 'source-after.json'))
  json(join(seed, 'command.json'), { phase: 'generate', profile: 'objects-limit', window: generationId })
  json(join(seed, 'space-before-snapshot.json'), { available: true })
  json(join(seed, 'exit.json'), { exit: 0 })
  for (let index = 1; index <= 557; index += 1) json(join(seed, `checkpoint-${index}.json`), { fixtureDirectory: externalFixture })

  const generationWindow = join(generation, 'window.json')
  json(generationWindow, {
    schemaVersion: 1, scope: 'musicbridge-capacity-generation-window', owner: 'root', id: generationId,
    state: 'approved', phase: 'generate', profile: 'objects-limit', label: seedLabel, n: 1,
    issuedAt: '2026-08-29T19:44:34.634+00:00', deadlineAt: '2026-08-29T20:04:34.634+00:00',
    limits: { executionMs: 1200000, killGraceMs: 1000, closeMs: 2000, minimumFreeBytes: 10 * 1024 ** 3, maximumOwnedBytes: 16 * 1024 ** 3 },
    ownedManifest: { file: 'owned-roots.json', sha256: sha(generationOwned) },
    sourceManifest: { file: 'source-pins.json', sha256: sha(generationSource) },
  })
  const required = ['source-before.json', 'command.json', 'space-before-snapshot.json', 'seed.sqlite', 'seed.json', 'source-after.json', 'exit.json']
  const checkpointNames = Array.from({ length: 557 }, (_, index) => `checkpoint-${index + 1}.json`)
  const files = {}
  for (const name of [...required, ...checkpointNames]) files[name] = { exists: true, size: readFileSync(join(seed, name)).length, sha256: sha(join(seed, name)) }
  const generationSupervisor = join(generation, 'supervision/supervisor.json'); mkdirSync(dirname(generationSupervisor))
  json(generationSupervisor, {
    passed: true, failure: null, pid: 999999, pgid: 999999, code: 0, exitSignal: null, signals: [],
    groupEmpty: true, zombies: [], managedProcessGroup: true,
    generation: {
      profile: 'objects-limit', label: seedLabel, window: generationId, windowSha256: sha(generationWindow),
      ownedManifestSha256: sha(generationOwned), sourceManifestSha256: sha(generationSource),
      outputDirectory: seed, outputDirectoryExists: true, partialExists: false, unexpectedEntries: [],
      files, checkpointFiles: checkpointNames, checkpointCount: 557, seedExists: true,
      seedMetadataSha256Observed: sha(join(seed, 'seed.json')), snapshotSha256Observed: snapshotSha,
      exitZero: true, seedProfileMatches: true, seedShaMatches: true, noSqliteSidecars: true,
      sourceBeforeEqualsAfter: true, commandMatchesWindow: true, fixtureIdentityValid: true,
      fixtureIdentity: {
        valid: true, identityStable: true,
        markerSha256: sha(join(externalFixture, 'capacity-owner.json')),
      },
      authority: {
        authorityStable: true, sourcePinsValid: true, ownedRootsValid: true, spaceValid: true,
        sourceFileCount: 243, ownedRootCount: 59,
      },
      authorityStable: true, targetReached: true, verifiedPassed: true,
    },
  })

  execFileSync('/usr/bin/git', ['init', '-b', 'main'], { cwd: root })
  git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test')
  const fixtureIssuer = join(root, 'scripts/ci/issue-v3-capacity-measure-window.py')
  const fixtureHelper = join(root, 'scripts/ci/issue-v3-capacity-window.py')
  mkdirSync(dirname(fixtureIssuer), { recursive: true })
  cpSync(sourceIssuer, fixtureIssuer); cpSync(sourceHelper, fixtureHelper)
  git(root, 'add', 'candidate', 'scripts/ci/issue-v3-capacity-measure-window.py', 'scripts/ci/issue-v3-capacity-window.py')
  git(root, 'commit', '-m', 'fixture candidate and issuers')
  const f = {
    root, runtime, supervisor, sourcePaths, generation, generationWindow, generationSupervisor,
    generationSource, generationOwned, seed, seedLabel, externalFixture,
    issuer: fixtureIssuer, helper: fixtureHelper, head: git(root, 'rev-parse', 'HEAD'),
  }
  return f
}

function args(f, extra = []) {
  return [
    f.issuer, '--repo-root', f.root, '--runtime-root', f.runtime,
    '--supervisor', f.supervisor, '--expected-supervisor-sha256', sha(f.supervisor),
    '--expected-source-count', '243', '--generation-window', f.generationWindow,
    '--expected-generation-window-sha256', sha(f.generationWindow),
    '--generation-supervisor', f.generationSupervisor,
    '--expected-generation-supervisor-sha256', sha(f.generationSupervisor),
    '--window-dir-name', 'objects-measure-window', '--label', 'objects-measure',
    '--seed-label', f.seedLabel, '--profile', 'objects-limit', '--expected-branch', 'main',
    '--expected-head', f.head, '--consumer-python', python, '--expected-consumer-sha256', sha(python),
    '--issuer-repo-root', f.root, '--expected-issuer-branch', 'main', '--expected-issuer-head', f.head,
    '--expected-issuer-sha256', sha(f.issuer), '--generation-issuer-helper', f.helper,
    '--expected-generation-issuer-helper-sha256', sha(f.helper),
    '--build-node', buildNode, '--expected-build-node-sha256', sha(buildNode),
    '--build-node-library', buildNodeLibrary, '--expected-build-node-library-sha256', sha(buildNodeLibrary),
    '--typescript-compiler', typescriptCompiler, '--expected-typescript-compiler-sha256', sha(typescriptCompiler),
    '--expected-typescript-library-manifest-sha256', typescriptLibraryManifestSha256,
    ...extra,
  ]
}

function run(f, extra = []) { return spawnSync(python, args(f, extra), { encoding: 'utf8' }) }
function cleanup(f) { rmSync(f.root, { recursive: true, force: true }); rmSync(f.externalFixture, { recursive: true, force: true }) }

test('签发 objects-limit measure authority：63 个既存 roots 加唯一 future output，且不运行 benchmark', () => {
  const f = fixture()
  try {
    const result = run(f)
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    const parent = join(f.runtime, 'objects-measure-window')
    const window = JSON.parse(readFileSync(join(parent, 'window.json'), 'utf8'))
    const owned = JSON.parse(readFileSync(join(parent, 'owned-roots.json'), 'utf8'))
    assert.equal(owned.roots.length, 63)
    assert.equal(new Set(owned.roots.map((row) => row.path)).size, 63)
    assert.deepEqual(
      new Set(owned.roots.map((row) => row.path)),
      new Set([
        ...JSON.parse(readFileSync(f.generationOwned)).roots.map((row) => row.path),
        f.seed, f.externalFixture, parent, join(parent, 'issuer-identity'),
      ]),
    )
    assert.deepEqual(owned.futureRoots, [join(f.runtime, 'objects-measure')])
    assert.equal(receipt.ownedRootCount, 64)
    assert.equal(window.scope, 'musicbridge-capacity-measure-window')
    assert.equal(window.profile, 'objects-limit'); assert.equal(window.label, 'objects-measure')
    assert.equal(window.seedLabel, f.seedLabel); assert.equal(window.n, 105)
    assert.equal(Date.parse(window.deadlineAt) - Date.parse(window.issuedAt), 900_000)
    assert.equal(existsSync(join(f.runtime, 'objects-measure')), false)
    assert.equal(existsSync(join(parent, 'supervision')), false)
    assert.equal(existsSync(join(parent, 'window.pending.json')), false)
    assert.deepEqual(receipt.consumeCommand, [python, f.supervisor, '--window', join(parent, 'window.json'), '--window-sha256', sha(join(parent, 'window.json'))])
  } finally { cleanup(f) }
})

test('generation supervisor proof 或 source pins 漂移时 terminal fail-closed', () => {
  for (const mutate of [
    (f) => { const proof = JSON.parse(readFileSync(f.generationSupervisor)); proof.generation.checkpointCount = 556; json(f.generationSupervisor, proof) },
    (f) => { const proof = JSON.parse(readFileSync(f.generationSupervisor)); delete proof.generation.authority; json(f.generationSupervisor, proof) },
    (f) => { writeFileSync(join(f.root, f.sourcePaths[1]), 'drift\n') },
  ]) {
    const f = fixture()
    try {
      mutate(f)
      const extra = ['--expected-generation-supervisor-sha256', sha(f.generationSupervisor)]
      const result = run(f, extra)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /GENERATION_PROOF|SOURCE_CANDIDATE/)
      const failurePath = join(f.runtime, 'objects-measure-window/issuer-failure.json')
      if (existsSync(failurePath)) {
        const failure = JSON.parse(readFileSync(failurePath))
        assert.equal(failure.state, 'TERMINAL_ISSUER_FAILURE'); assert.equal(failure.replayAllowed, false)
      }
      assert.equal(existsSync(join(f.runtime, 'objects-measure-window/window.json')), false)
    } finally { cleanup(f) }
  }
})

test('seed、fixture marker 或 SQLite sidecar 漂移时拒绝签发', () => {
  for (const mutate of [
    (f) => writeFileSync(join(f.seed, 'seed.sqlite'), 'drifted snapshot\n'),
    (f) => json(join(f.externalFixture, 'capacity-owner.json'), { id: randomUUID(), scope: 'musicbridge-capacity-synthetic-only' }),
    (f) => writeFileSync(join(f.seed, 'seed.sqlite-wal'), 'forbidden\n'),
  ]) {
    const f = fixture()
    try {
      mutate(f); const result = run(f)
      assert.notEqual(result.status, 0); assert.match(result.stderr, /GENERATION_PROOF|SEED_INVALID/)
      assert.equal(existsSync(join(f.runtime, 'objects-measure-window/window.json')), false)
    } finally { cleanup(f) }
  }
})

test('future output 已存在时在 authority 目录创建前拒绝', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.runtime, 'objects-measure'))
    const result = run(f)
    assert.notEqual(result.status, 0); assert.match(result.stderr, /REPLAY_PATH/)
    assert.equal(existsSync(join(f.runtime, 'objects-measure-window')), false)
  } finally { cleanup(f) }
})

test('损坏或 symlink 的旧 measure authority 由 replay scanner 稳定拒绝', () => {
  for (const prepare of [
    (f) => { const old = join(f.runtime, 'old-measure'); mkdirSync(old); writeFileSync(join(old, 'window.json'), '{') },
    (f) => { const old = join(f.runtime, 'old-measure'); mkdirSync(old); symlinkSync(f.generationWindow, join(old, 'window.json')) },
  ]) {
    const f = fixture()
    try {
      prepare(f); const result = run(f)
      assert.notEqual(result.status, 0); assert.match(result.stderr, /REPLAY_AUDIT/)
      assert.equal(existsSync(join(f.runtime, 'objects-measure-window')), false)
    } finally { cleanup(f) }
  }
})

test('有效旧 measure window、close 或 issuer failure 使用同 label 时永久拒绝重放', () => {
  for (const prepare of [
    (f) => { const old = join(f.runtime, 'old-measure'); mkdirSync(old); json(join(old, 'window.json'), { scope: 'musicbridge-capacity-measure-window', id: randomUUID(), label: 'objects-measure' }) },
    (f) => { json(join(f.runtime, 'old-measure-close.json'), { scope: 'musicbridge-capacity-measure-window-close', windowId: randomUUID(), label: 'objects-measure' }) },
    (f) => { const old = join(f.runtime, 'old-failure'); mkdirSync(old); json(join(old, 'issuer-failure.json'), { scope: 'musicbridge-capacity-measure-authority-issuer-failure', windowId: randomUUID(), label: 'objects-measure' }) },
  ]) {
    const f = fixture()
    try {
      prepare(f); const result = run(f)
      assert.notEqual(result.status, 0); assert.match(result.stderr, /REPLAY/)
      assert.equal(existsSync(join(f.runtime, 'objects-measure-window')), false)
    } finally { cleanup(f) }
  }
})

test('generation process group 仍存活时拒绝签发', () => {
  const f = fixture()
  try {
    const proof = JSON.parse(readFileSync(f.generationSupervisor))
    proof.pgid = Number(execFileSync(python, ['-c', 'import os; print(os.getpgrp())'], { encoding: 'utf8' }).trim())
    json(f.generationSupervisor, proof)
    const result = run(f, ['--expected-generation-supervisor-sha256', sha(f.generationSupervisor)])
    assert.notEqual(result.status, 0); assert.match(result.stderr, /GENERATION_PROCESS_LIVE/)
    assert.equal(existsSync(join(f.runtime, 'objects-measure-window/window.json')), false)
  } finally { cleanup(f) }
})

test('runtime 条目超过 4096 时稳定拒绝无界 replay 扫描', () => {
  const f = fixture()
  try {
    for (let index = 0; index < 4097; index += 1) mkdirSync(join(f.runtime, `padding-${String(index).padStart(4, '0')}`))
    const result = run(f)
    assert.notEqual(result.status, 0); assert.match(result.stderr, /RUNTIME_COUNT/)
    assert.equal(existsSync(join(f.runtime, 'objects-measure-window')), false)
  } finally { cleanup(f) }
})

test('pending 发布 rename 失败时只保留不可消费 pending 与 terminal failure', () => {
  const f = fixture()
  try {
    const injection = [
      'import importlib.util, sys',
      "spec=importlib.util.spec_from_file_location('issuer_under_test', sys.argv[1])",
      'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
      'original=module.os.rename',
      "def reject(source,target):\n if str(source).endswith('window.pending.json'): raise OSError('injected rename failure')\n return original(source,target)",
      'module.os.rename=reject',
      'raise SystemExit(module.main(sys.argv[2:]))',
    ].join('\n')
    const result = spawnSync(python, ['-c', injection, f.issuer, ...args(f).slice(1)], { encoding: 'utf8' })
    const parent = join(f.runtime, 'objects-measure-window')
    assert.notEqual(result.status, 0); assert.equal(existsSync(join(parent, 'window.json')), false)
    assert.equal(existsSync(join(parent, 'window.pending.json')), true)
    const failure = JSON.parse(readFileSync(join(parent, 'issuer-failure.json')))
    assert.equal(failure.windowWritten, false); assert.equal(failure.replayAllowed, false)
  } finally { cleanup(f) }
})

test('rename 后 fsync 失败必须回退为 pending 并留下 terminal failure', () => {
  const f = fixture()
  try {
    const injection = [
      'import importlib.util, sys',
      "spec=importlib.util.spec_from_file_location('issuer_under_test', sys.argv[1])",
      'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
      'original_rename=module.os.rename; original_fsync=module.fsync_directory; published=[False]',
      "def rename(source,target):\n original_rename(source,target)\n published[0]=True",
      "def fsync(path):\n if published[0]: raise OSError('injected post-publish fsync failure')\n return original_fsync(path)",
      'module.os.rename=rename; module.fsync_directory=fsync',
      'raise SystemExit(module.main(sys.argv[2:]))',
    ].join('\n')
    const result = spawnSync(python, ['-c', injection, f.issuer, ...args(f).slice(1)], { encoding: 'utf8' })
    const parent = join(f.runtime, 'objects-measure-window')
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(join(parent, 'window.json')), false)
    assert.equal(existsSync(join(parent, 'window.pending.json')), true)
    const failure = JSON.parse(readFileSync(join(parent, 'issuer-failure.json')))
    assert.equal(failure.errorCode, 'PUBLISH_DURABILITY')
    assert.equal(failure.windowWritten, false)
    assert.equal(failure.replayAllowed, false)
  } finally { cleanup(f) }
})

test('发布后 fsync 与回退 rename 同时失败时不得伪造 terminal 双态或下发消费命令', () => {
  const f = fixture()
  try {
    const injection = [
      'import importlib.util, sys',
      "spec=importlib.util.spec_from_file_location('issuer_under_test', sys.argv[1])",
      'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
      'original_rename=module.os.rename; original_fsync=module.fsync_directory; published=[False]; renames=[0]',
      "def rename(source,target):\n renames[0]+=1\n if renames[0]>1: raise OSError('injected rollback rename failure')\n original_rename(source,target)\n published[0]=True",
      "def fsync(path):\n if published[0]: raise OSError('injected post-publish fsync failure')\n return original_fsync(path)",
      'module.os.rename=rename; module.fsync_directory=fsync',
      'raise SystemExit(module.main(sys.argv[2:]))',
    ].join('\n')
    const result = spawnSync(python, ['-c', injection, f.issuer, ...args(f).slice(1)], { encoding: 'utf8' })
    const parent = join(f.runtime, 'objects-measure-window')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(parent, 'window.json')), true)
    assert.equal(existsSync(join(parent, 'issuer-failure.json')), false)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.state, 'PUBLISHED_NOT_EXECUTED_DURABILITY_UNCONFIRMED')
    assert.equal(receipt.consumeCommand, null)
  } finally { cleanup(f) }
})
