import assert from 'node:assert/strict'
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const sourceSupervisor = new URL('../capacity-phase-supervisor-v2.py', import.meta.url).pathname
const python = '/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/bin/python3.14'
const plan = { groupCloneCount: 3, fullHashCount: 3, stopRoundReceiptCount: 105, sampleCount: 1575 }
const stopMetrics = ['signalAborted', 'driverStopInvoked', 'driverStopAck', 'driverCloseInvoked', 'driverCloseResolved', 'receiptSettled']
const readMetrics = ['recordList', 'queryLastPage', 'queryChinese', 'queryMissing', 'queryPhysical', 'emptyPoll', 'pdf', 'photo']
const stagePhases = ['copy', 'open-audit', 'operation', 'round-fsync', 'final-hash', 'cleanup']

function json(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function bridge(script, method, payload) {
  const code = `
import importlib.util, json, pathlib, sys, types
spec=importlib.util.spec_from_file_location('capacity_phase_supervisor_v2', sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
method=sys.argv[2]; payload=json.loads(sys.argv[3])
try:
  if method == 'repo-root': value=str(module._runtime_repo_root())
  elif method == 'candidate': value=str(module._validate_candidate_repository(payload['window'], pathlib.Path(payload['runtime'])))
  elif method == 'target':
    root, entry=module._measure_execution_target(payload['window'], pathlib.Path(payload['runtime']))
    value={'root':str(root),'cwd':str(root),'entry':str(entry)}
  elif method == 'source': value=module._validate_source_manifest(pathlib.Path(payload['manifest']), pathlib.Path(payload['root']))['fileCount']
  elif method == 'load':
    value=[str(item) if isinstance(item, pathlib.Path) else item for item in module._load_window(
      ['--window', payload['window'], '--window-sha256', payload['windowSha256']])[:3]]
  elif method == 'window':
    value=list(module._validate_measure_window(payload['window'], payload['now']))
  elif method == 'artifacts':
    value=module._measure_artifacts(pathlib.Path(payload['runtime']), payload['label'])
  elif method == 'js-json': value=module._js_compact_json(payload['value'])
  elif method == 'artifacts-expected':
    expected=dict(payload['expected']); expected['entry']=pathlib.Path(expected['entry']); expected['root']=pathlib.Path(expected['root'])
    value=module._measure_artifacts(pathlib.Path(payload['runtime']), payload['label'], expected)
  elif method == 'measure-command':
    captured={}
    module._require_loaded_window_identity=lambda *args, **kwargs: True
    module._reject_measure_replay=lambda *args, **kwargs: True
    module._validate_measure_authority=lambda *args, **kwargs: {'seedBudget': {'fixed': True}}
    module._write_measure_close=lambda *args, **kwargs: None
    def artifacts(runtime, label, expected=None):
      captured['artifactRuntime']=str(runtime); captured['expectedRuntime']=str(expected.get('runtime'))
      return {'verifiedPassed': True}
    def supervise(command, deadline, supervision, **kwargs):
      captured['command']=[str(item) for item in command]; captured['cwd']=str(kwargs.get('cwd'))
      kwargs['artifact_probe']()
      return {'passed': True}
    module._measure_artifacts=artifacts; module.supervise=supervise
    loaded=(pathlib.Path(payload['runtime']), pathlib.Path(payload['authority']), payload['window'], {'sha256': payload['windowSha256']})
    value={'exit':module._main_measure([], loaded=loaded), **captured}
  elif method == 'owned':
    value=module._validate_owned_manifest(pathlib.Path(payload['manifest']), pathlib.Path(payload['runtime']),
      payload['windowId'], 'objects-limit', planned_bytes=0)
  elif method == 'owned-transition':
    runtime=pathlib.Path(payload['runtime']); future=pathlib.Path(payload['future'])
    available=iter([payload['admissionAvailableBytes'], payload['terminalAvailableBytes']])
    module.os.statvfs=lambda path: types.SimpleNamespace(f_bavail=next(available), f_frsize=1)
    original_directory_bytes=module._directory_bytes
    def controlled_directory_bytes(path):
      if pathlib.Path(path) == future: return payload['futureBytes'], 2
      return original_directory_bytes(path)
    module._directory_bytes=controlled_directory_bytes
    admission=module._validate_owned_manifest(
      pathlib.Path(payload['manifest']), runtime, payload['windowId'], 'objects-limit',
      planned_bytes=payload['plannedBytes'], future_path=future, future_state='absent')
    future.mkdir()
    marker=future/'command.json'
    if payload.get('symlinkMarker'):
      target=runtime/'outside-command.json'; target.write_text('{}\\n'); marker.symlink_to(target)
    else: marker.write_text('{}\\n')
    terminal=module._validate_owned_manifest(
      pathlib.Path(payload['manifest']), runtime, payload['windowId'], 'objects-limit',
      planned_bytes=payload['plannedBytes'], future_path=future, future_state='present')
    value={'admission':admission,'terminal':terminal}
  elif method == 'carryover':
    if 'legacyEvidence' in payload: module._LEGACY_CARRYOVER_EVIDENCE=payload['legacyEvidence']
    if payload.get('forbidSqliteRead'):
      strict_identity=module._strict_identity; sha256=module._sha
      read_bytes=pathlib.Path.read_bytes; read_text=pathlib.Path.read_text
      def guarded_identity(file, maximum=None):
        if pathlib.Path(file).name == 'sample.sqlite': raise AssertionError('sample.sqlite content read')
        return strict_identity(file, maximum)
      def guarded_sha(file):
        if pathlib.Path(file).name == 'sample.sqlite': raise AssertionError('sample.sqlite content hash')
        return sha256(file)
      def guarded_read_bytes(file):
        if file.name == 'sample.sqlite': raise AssertionError('sample.sqlite read_bytes')
        return read_bytes(file)
      def guarded_read_text(file, *args, **kwargs):
        if file.name == 'sample.sqlite': raise AssertionError('sample.sqlite read_text')
        return read_text(file, *args, **kwargs)
      module._strict_identity=guarded_identity; module._sha=guarded_sha
      pathlib.Path.read_bytes=guarded_read_bytes; pathlib.Path.read_text=guarded_read_text
    value=module._validate_measure_carryover(
      pathlib.Path(payload['window']), pathlib.Path(payload['close']), pathlib.Path(payload['output']),
      pathlib.Path(payload['runtime']), payload['windowSha256'], payload['closeSha256'],
      payload['commandSha256'], payload['windowId'], payload['label'])
  else: raise RuntimeError('unknown method')
  print(json.dumps({'ok':True,'value':value}, sort_keys=True))
except (SystemExit, ValueError) as error:
  print(json.dumps({'ok':False,'error':str(error)}, sort_keys=True))
`
  const result = spawnSync(python, ['-c', code, script, method, JSON.stringify(payload)], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function copiedSupervisor() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-supervisor-v2-')))
  const repo = join(temp, 'task-078-v3-acceptance')
  const candidate = join(temp, 'task-079-v3-final-acceptance')
  const runtime = join(repo, 'reports/runtime/task-078-v3-acceptance')
  mkdirSync(runtime, { recursive: true })
  const authority = join(runtime, 'objects-measure-v2-window'); mkdirSync(authority)
  const script = join(authority, 'supervisor.py')
  copyFileSync(sourceSupervisor, script, constants.COPYFILE_EXCL)
  const repoBranch = 'codex/task-078-v3-acceptance'
  for (const args of [
    ['init', '-b', repoBranch], ['config', 'user.name', 'Capacity Test'],
    ['config', 'user.email', 'capacity@example.invalid'], ['add', '.'], ['commit', '-m', 'runtime'],
  ]) {
    const result = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr)
  }
  const repoHead = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD^{commit}'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  const candidateFiles = [
    'package.json', 'pnpm-lock.yaml', 'packages/bridge-core/package.json', 'packages/contracts/package.json',
    'packages/bridge-core/test/benchmarks/recording-capacity.ts',
    'packages/bridge-core/test/benchmarks/recording-capacity-process.ts',
    'scripts/ci/capacity-phase-supervisor-v2.py', 'scripts/ci/issue-v3-capacity-measure-window.py',
  ]
  for (const relative of candidateFiles) {
    const path = join(candidate, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${relative}\n`)
  }
  for (const relative of ['packages/bridge-core/src', 'packages/bridge-core/test/helpers', 'packages/contracts/src', 'packages/contracts/dist']) {
    mkdirSync(join(candidate, relative), { recursive: true })
  }
  for (const args of [
    ['init', '-b', 'codex/task-079-v3-final-acceptance'], ['config', 'user.name', 'Capacity Test'],
    ['config', 'user.email', 'capacity@example.invalid'], ['add', '.'], ['commit', '-m', 'candidate'],
  ]) {
    const result = spawnSync('/usr/bin/git', args, { cwd: candidate, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr)
  }
  const head = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD^{commit}'], { cwd: candidate, encoding: 'utf8' }).stdout.trim()
  return { temp, repo, repoBranch, repoHead, candidate, candidateBranch: 'codex/task-079-v3-final-acceptance', head,
    candidateFiles, runtime, authority, script, cleanup: () => rmSync(temp, { recursive: true, force: true }) }
}

function sample(metric, index) {
  return { metric, durationMs: 1, warmup: index < 5, outcome: 'ok', details: null }
}

function completeSamples(stopRounds = 105) {
  const progress = Array.from({ length: 105 }, (_, index) => sample('progress', index))
  const stop = Array.from({ length: stopRounds }, (_, index) => stopMetrics.map(metric => ({
    ...sample(metric, index), details: { sample: index, observed: true },
  }))).flat()
  const read = readMetrics.flatMap(metric => Array.from({ length: 105 }, (_, index) => sample(metric, index)))
  return { progress, stop, read, all: [...progress, ...stop, ...read] }
}

function marker(group) {
  return { id: randomUUID(), scope: 'musicbridge-capacity-clone-only', label: `group-${group}` }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function legacyCarryover(f, mutate = () => {}) {
  const windowId = randomUUID(), label = 'objects-measure-old', parent = join(f.runtime, 'objects-measure-old-window')
  const output = join(f.runtime, label); mkdirSync(parent); mkdirSync(output)
  const windowPath = join(parent, 'window.json'), closePath = join(parent, 'close.json')
  json(join(parent, 'owner.json'), { scope: 'musicbridge-capacity-measure-window', owner: 'root', id: windowId })
  json(windowPath, { schemaVersion: 1, scope: 'musicbridge-capacity-measure-window', id: windowId, label })
  const command = {
    executable: '/test/node',
    args: ['/candidate/recording-capacity.ts', '--phase', 'measure', '--profile', 'objects-limit', '--label', label,
      '--seed-label', 'objects-seed-old', '--window', windowId],
    cwd: '/candidate/', node: 'v22.23.2', platform: 'darwin', arch: 'arm64', osVersion: 'test', logicalCpus: 12,
    cache: 'test', profileDefinition: { name: 'objects-limit' }, phase: 'measure', profile: 'objects-limit', window: windowId,
    deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
  }
  json(join(output, 'command.json'), command)
  json(join(output, 'measurement.json'), {
    seedLabel: 'objects-seed-old', seedSha256: '7'.repeat(64), profile: 'objects-limit', window: windowId,
    classification: 'software-only/exclusive-window', cache: 'test', warmup: 5,
    readSamples: 100, progressSamples: 100, stopSamples: 100, excluded: ['device'],
  })
  json(join(output, 'source-before.json'), { 'packages/bridge-core/src/recording/attempt-store.ts': 'a'.repeat(40) })
  const progress = Array.from({ length: 105 }, (_, index) => sample('progress', index))
  const stops = Array.from({ length: 28 }, (_, index) => stopMetrics.map(metric => ({
    ...sample(metric, index), details: { sample: index, observed: true },
  }))).flat()
  const samples = [...progress, ...stops]
  writeFileSync(join(output, 'samples.jsonl'), samples.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' })
  const receiptNames = []
  for (let index = 1; index <= 29; index += 1) {
    const name = `sample-${index}.receipt.json`; receiptNames.push(name)
    json(join(output, name), {
      outcome: 'ok', resourcesClosed: true,
      samples: index === 1 ? progress : stops.slice((index - 2) * 6, (index - 1) * 6),
      marker: { id: randomUUID(), scope: 'musicbridge-capacity-clone-only', label: `sample-${index}` },
      sqliteSha256: createHash('sha256').update(`sqlite-${index}`).digest('hex'), retained: false,
    })
  }
  const retained = join(output, 'sample-30'); mkdirSync(retained)
  const retainedOwner = { id: randomUUID(), scope: 'musicbridge-capacity-clone-only', label: 'sample-30' }
  json(join(retained, 'owner.json'), retainedOwner)
  writeFileSync(join(retained, 'sample.sqlite'), 'small sparse substitute')
  writeFileSync(join(retained, 'sample.sqlite-wal'), '')
  writeFileSync(join(retained, 'sample.sqlite-shm'), 'small shm substitute')
  const fixedNames = ['command.json', 'measurement.json', 'source-before.json', 'samples.jsonl']
  const fixedFiles = Object.fromEntries(fixedNames.map(name => [name, {
    exists: true, size: statSync(join(output, name)).size, sha256: sha(join(output, name)),
  }]))
  for (const name of ['source-after.json', 'end-budget.json', 'summary.json', 'exit.json']) {
    fixedFiles[name] = { exists: false, size: null, sha256: null }
  }
  const sqliteBytes = statSync(join(retained, 'sample.sqlite')).size
  const close = {
    schemaVersion: 1, scope: 'musicbridge-capacity-measure-window-close', windowId, label,
    state: 'failed', failure: 'EXECUTION_TIMEOUT', groupEmpty: true, zombies: [],
    windowSha256: sha(windowPath), deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
    authorityAdmission: { authorityStable: true, seedSnapshotBytes: sqliteBytes },
    authorityTerminal: { authorityStable: true, seedSnapshotBytes: sqliteBytes },
    replayPolicy: 'terminal-window-id-and-label-never-reuse',
    measurement: { outputDirectory: output, partialExists: true, partialPreserved: true,
      verifiedComplete: false, verifiedPassed: false, sampleCount: 273, receiptCount: 29,
      authorityStable: true, commandMatchesWindow: true, files: fixedFiles },
  }
  json(closePath, close)
  const receiptInventory = receiptNames.map(name => ({ name, size: statSync(join(output, name)).size, sha256: sha(join(output, name)) }))
  const evidence = {
    format: 'legacy-107-clone-partial-v1', windowId, label,
    windowSha256: sha(windowPath), closeSha256: sha(closePath), commandSha256: sha(join(output, 'command.json')),
    seedLabel: 'objects-seed-old', seedSha256: '7'.repeat(64),
    files: Object.fromEntries(fixedNames.map(name => [name, { size: statSync(join(output, name)).size, sha256: sha(join(output, name)) }])),
    receiptSha256: receiptInventory.map(item => item.sha256),
    receiptManifestSha256: createHash('sha256').update(canonicalJson(receiptInventory)).digest('hex'),
    retainedOwner, retainedOwnerSha256: sha(join(retained, 'owner.json')),
    sqliteBytes,
    wal: { size: statSync(join(retained, 'sample.sqlite-wal')).size, sha256: sha(join(retained, 'sample.sqlite-wal')) },
    shm: { size: statSync(join(retained, 'sample.sqlite-shm')).size, sha256: sha(join(retained, 'sample.sqlite-shm')) },
  }
  const payload = { runtime: f.runtime, window: windowPath, close: closePath, output,
    windowSha256: evidence.windowSha256, closeSha256: evidence.closeSha256,
    commandSha256: evidence.commandSha256, windowId, label, legacyEvidence: evidence, forbidSqliteRead: true }
  mutate({ output, retained, receiptNames, samples, payload, evidence })
  return payload
}

function groupReceipt(group, groupMarker, samples, outcome = 'ok') {
  return { outcome, resourcesClosed: true, samples, marker: groupMarker, sqliteSha256: 'a'.repeat(64), retained: outcome !== 'ok',
    workspaceReceipt: null, workspaceTreeSha256: null }
}

function treeEntry(relative, type, size, contentSha256Verified = type === 'file') {
  return {
    relative, type, device: 1, inode: 100 + relative.length, mode: type === 'directory' ? 0o40700 : 0o100600,
    size, mtimeMs: 1_788_000_000_000, ctimeMs: 1_788_000_000_000,
    contentSha256: contentSha256Verified ? createHash('sha256').update(relative).digest('hex') : null,
    contentSha256Verified,
  }
}

function treeSha256(entries) {
  const hash = createHash('sha256')
  for (const entry of entries) hash.update(JSON.stringify(entry))
  return hash.digest('hex')
}

function fixtureTree() {
  const value = {
    scope: 'musicbridge-capacity-fixture-tree', root: '/synthetic/musicbridge-version-fixture',
    entries: [treeEntry('', 'directory', 160, false), treeEntry('capacity-owner.json', 'file', 120),
      treeEntry('seed.sqlite', 'file', 2_000_000_000, false)],
    treeSha256: '', databaseContentSha256Verified: false, excludedDatabaseFiles: ['seed.sqlite'],
  }
  value.treeSha256 = treeSha256(value.entries)
  return value
}

function workspaceReceipt(groupMarker) {
  const entries = [treeEntry('', 'directory', 160, false), treeEntry('archive', 'directory', 64, false),
    treeEntry('execution', 'directory', 64, false), treeEntry('owner.json', 'file', 120),
    treeEntry('source', 'directory', 96, false), treeEntry('source/fixture.wav', 'file', 176_448)]
  const workspace = {
    marker: { id: randomUUID(), scope: 'musicbridge-capacity-stop-workspace' },
    directories: entries.filter(value => value.type === 'directory').length,
    files: entries.filter(value => value.type === 'file').length,
    bytes: entries.filter(value => value.type === 'file').reduce((sum, value) => sum + value.size, 0),
    treeSha256: treeSha256(entries), entries,
  }
  return { schemaVersion: 1, scope: 'musicbridge-capacity-stop-workspace-tree', groupMarker, workspace,
    recordedAt: new Date(1_788_000_000_000).toISOString() }
}

function roundReceipt(index, groupMarker, samples) {
  return {
    schemaVersion: 1,
    scope: 'musicbridge-capacity-measure-stop-round',
    group: 'stop',
    groupMarker,
    roundIndex: index,
    attemptId: randomUUID(),
    commandId: randomUUID(),
    inProgressBefore: 0,
    inProgressAfter: 0,
    attemptStatus: 'aborted',
    attemptReason: 'user-stop',
    coordinatorClosed: true,
    repositoryOpen: true,
    samples,
    sampleCount: 6,
    recordedAt: new Date(1_788_000_000_000 + index).toISOString(),
  }
}

function stages(groups = ['progress', 'stop', 'read'], completedRounds = 105) {
  return groups.flatMap(group => stagePhases.map((phase, index) => ({
    schemaVersion: 1,
    scope: 'musicbridge-capacity-measure-stage',
    group,
    phase,
    recordedAt: new Date(1_788_000_100_000 + index).toISOString(),
    details: group === 'stop' && phase === 'round-fsync'
      ? { requestedRounds: 105, completedRounds, lastReceipt: `group-stop.round-${String(completedRounds).padStart(3, '0')}.receipt.json` }
      : { complete: completedRounds === 105 || group === 'progress' },
  })))
}

function baseFiles(output, rows) {
  json(join(output, 'command.json'), { phase: 'measure' })
  json(join(output, 'measurement.json'), { measurePlan: plan })
  json(join(output, 'source-before.json'), { files: {} })
  const fixture = fixtureTree()
  json(join(output, 'fixture-before.json'), fixture)
  json(join(output, 'fixture-after.json'), fixture)
  writeFileSync(join(output, 'samples.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' })
}

function completeArtifacts(runtime, mutate = () => {}) {
  const label = 'objects-measure-v2'
  const output = join(runtime, label); mkdirSync(output)
  const rows = completeSamples()
  const markers = { progress: marker('progress'), stop: marker('stop'), read: marker('read') }
  baseFiles(output, rows.all)
  json(join(output, 'source-after.json'), { files: {} })
  json(join(output, 'end-budget.json'), { fixed: true })
  json(join(output, 'summary.json'), { fullR023Passed: false })
  json(join(output, 'exit.json'), { exit: 0 })
  const workspace = workspaceReceipt(markers.stop)
  json(join(output, 'group-stop.workspace.receipt.json'), workspace)
  for (const group of ['progress', 'stop', 'read']) {
    const receipt = groupReceipt(group, markers[group], rows[group])
    if (group === 'stop') {
      receipt.workspaceReceipt = 'group-stop.workspace.receipt.json'
      receipt.workspaceTreeSha256 = workspace.workspace.treeSha256
    }
    json(join(output, `group-${group}.receipt.json`), receipt)
  }
  for (let index = 1; index <= 105; index += 1) {
    json(join(output, `group-stop.round-${String(index).padStart(3, '0')}.receipt.json`),
      roundReceipt(index, markers.stop, rows.stop.slice((index - 1) * 6, index * 6)))
  }
  writeFileSync(join(output, 'measure-stages.jsonl'), stages().map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' })
  mutate({ output, rows, markers, workspace })
  return { label, output }
}

function partialArtifacts(runtime) {
  const label = 'objects-measure-v2-partial'
  const output = join(runtime, label); mkdirSync(output)
  const rows = completeSamples(29); const progressMarker = marker('progress'), stopMarker = marker('stop')
  baseFiles(output, [...rows.progress, ...rows.stop])
  json(join(output, 'group-progress.receipt.json'), groupReceipt('progress', progressMarker, rows.progress))
  const retained = join(output, 'group-stop'); mkdirSync(retained)
  json(join(retained, 'owner.json'), stopMarker); writeFileSync(join(retained, 'sample.sqlite'), 'partial sqlite\n')
  for (let index = 1; index <= 29; index += 1) {
    json(join(output, `group-stop.round-${String(index).padStart(3, '0')}.receipt.json`),
      roundReceipt(index, stopMarker, rows.stop.slice((index - 1) * 6, index * 6)))
  }
  writeFileSync(join(output, 'measure-stages.jsonl'), stages(['progress'], 29).concat(stages(['stop'], 29).slice(0, 4)).map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' })
  return { label, output }
}

function windowValue(f) {
  const issued = new Date(Date.now() - 1_000)
  return {
    schemaVersion: 1, scope: 'musicbridge-capacity-measure-window', owner: 'root', id: randomUUID(),
    state: 'approved', phase: 'measure', profile: 'objects-limit', label: 'objects-measure-v2',
    seedLabel: 'objects-seed', n: 105, issuedAt: issued.toISOString(),
    deadlineAt: new Date(issued.getTime() + 900_000).toISOString(),
    limits: { executionMs: 900000, killGraceMs: 1000, closeMs: 2000, minimumFreeBytes: 10 * 1024 ** 3, maximumOwnedBytes: 16 * 1024 ** 3 },
    seed: { metadataSha256: '1'.repeat(64), snapshotSha256: '2'.repeat(64), fixtureOwnerSha256: '3'.repeat(64) },
    ownedManifest: { file: 'owned-roots.json', sha256: '4'.repeat(64) },
    sourceManifest: { file: 'source-pins.json', sha256: '5'.repeat(64) },
    measurePlan: plan,
    supervisor: { path: f.script, sha256: sha(f.script) },
    candidateRepository: { root: f.candidate, branch: f.candidateBranch, head: f.head },
  }
}

function sourceManifest(f) {
  const files = Object.fromEntries(f.candidateFiles.map(relative => [relative, sha(join(f.candidate, relative))]))
  const manifest = join(f.authority, 'source-pins-candidate.json')
  json(manifest, { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files })
  return manifest
}

function ownedManifest(f, count, windowId) {
  const roots = []
  for (let index = 0; index < count; index += 1) {
    const path = join(f.runtime, `owned-${String(index).padStart(2, '0')}`); mkdirSync(path)
    json(join(path, 'owner.json'), { scope: 'test', index })
    const info = statSync(path)
    roots.push({ path, device: info.dev, inode: info.ino,
      marker: { relative: 'owner.json', sha256: sha(join(path, 'owner.json')) } })
  }
  const manifest = join(f.authority, `owned-${count}.json`)
  json(manifest, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId, roots })
  return manifest
}

function ownedTransition(f) {
  const windowId = randomUUID(), root = join(f.runtime, 'owned-transition-root')
  const future = join(f.runtime, 'objects-measure-v2'); mkdirSync(root)
  json(join(root, 'owner.json'), { scope: 'test', id: windowId })
  const info = statSync(root)
  const manifest = join(f.authority, 'owned-transition.json')
  json(manifest, {
    schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId,
    roots: [{ path: root, device: info.dev, inode: info.ino,
      marker: { relative: 'owner.json', sha256: sha(join(root, 'owner.json')) } }],
    futureRoots: [future],
  })
  const plannedBytes = 4_249_378_816
  return {
    manifest, runtime: f.runtime, windowId, future, plannedBytes,
    futureBytes: 13 * 1024 ** 3,
    admissionAvailableBytes: plannedBytes + 10 * 1024 ** 3 + 1,
    terminalAvailableBytes: 10 * 1024 ** 3 + 1,
  }
}

test('v2从window绑定独立TASK079 candidate，绝不反推TASK078 runtime root', () => {
  assert.equal(existsSync(sourceSupervisor), true, '先写测试时生产v2脚本必须缺失并形成RED')
  const f = copiedSupervisor()
  try {
    assert.notEqual(f.candidate, f.repo)
    const window = windowValue(f)
    assert.deepEqual(bridge(f.script, 'candidate', { window, runtime: f.runtime }), { ok: true, value: f.candidate })
    const runtimeDerived = structuredClone(window)
    runtimeDerived.candidateRepository = { root: f.repo, branch: f.repoBranch, head: f.repoHead }
    assert.equal(bridge(f.script, 'candidate', { window: runtimeDerived, runtime: f.runtime }).ok, false)
    assert.deepEqual(bridge(f.script, 'target', { window, runtime: f.runtime }), { ok: true, value: {
      root: f.candidate, cwd: f.candidate, entry: join(f.candidate, 'packages/bridge-core/test/benchmarks/recording-capacity.ts') } })
    assert.equal(bridge(f.script, 'source', { manifest: sourceManifest(f), root: f.candidate }).value, 8)
    json(join(f.authority, 'owner.json'), { scope: window.scope, owner: 'root', id: window.id })
    json(join(f.authority, 'window.json'), window)
    const loaded = bridge(f.script, 'load', { window: join(f.authority, 'window.json'), windowSha256: sha(join(f.authority, 'window.json')) })
    assert.equal(loaded.ok, true)
    assert.deepEqual(loaded.value.slice(0, 2), [f.runtime, f.authority])
  } finally { f.cleanup() }
})

test('measure命令与artifact验证精确绑定显式TASK078 runtime-root', () => {
  const f = copiedSupervisor()
  try {
    const window = windowValue(f), windowSha256 = 'a'.repeat(64)
    const observed = bridge(f.script, 'measure-command', {
      runtime: f.runtime, authority: f.authority, window, windowSha256,
    })
    assert.equal(observed.ok, true)
    const entry = join(f.candidate, 'packages/bridge-core/test/benchmarks/recording-capacity.ts')
    assert.deepEqual(observed.value.command.slice(3), [entry, '--phase', 'measure', '--profile', 'objects-limit',
      '--label', window.label, '--seed-label', window.seedLabel, '--window', window.id, '--runtime-root', f.runtime])
    assert.equal(observed.value.cwd, f.candidate)
    assert.equal(observed.value.artifactRuntime, f.runtime)
    assert.equal(observed.value.expectedRuntime, f.runtime)

    const artifacts = completeArtifacts(f.runtime, ({ output }) => {
      rmSync(join(output, 'command.json'))
      json(join(output, 'command.json'), {
        executable: '/Users/yihe/.nvm/versions/node/v22.23.2/bin/node',
        args: [entry, '--phase', 'measure', '--profile', 'objects-limit', '--label', window.label,
          '--seed-label', window.seedLabel, '--window', window.id, '--runtime-root', f.runtime],
        cwd: f.candidate, node: 'v22.23.2', phase: 'measure', profile: 'objects-limit', window: window.id,
      })
    })
    const expected = { profile: 'objects-limit', label: window.label, seedLabel: window.seedLabel,
      window: window.id, node: '/Users/yihe/.nvm/versions/node/v22.23.2/bin/node', entry, root: f.candidate,
      runtime: f.runtime, seedSnapshotSha256: '2'.repeat(64),
      seedFixtureDirectory: '/synthetic/musicbridge-version-fixture' }
    const bound = bridge(f.script, 'artifacts-expected', { runtime: f.runtime, label: artifacts.label, expected }).value
    assert.equal(bound.commandMatchesWindow, true)
    assert.equal(bound.fixtureTreeValid, true)
    for (const name of ['fixture-before.json', 'fixture-after.json']) {
      const fixturePath = join(artifacts.output, name), fixture = JSON.parse(readFileSync(fixturePath))
      fixture.root = '/synthetic/musicbridge-version-replacement'; rmSync(fixturePath); json(fixturePath, fixture)
    }
    assert.equal(bridge(f.script, 'artifacts-expected', { runtime: f.runtime, label: artifacts.label, expected }).value.fixtureTreeValid, false,
      '自洽的fixture摘要也必须绑定authority验证过的generation fixture根')
    const commandPath = join(artifacts.output, 'command.json'), command = JSON.parse(readFileSync(commandPath))
    command.args.splice(-2); rmSync(commandPath); json(commandPath, command)
    assert.equal(bridge(f.script, 'artifacts-expected', { runtime: f.runtime, label: artifacts.label, expected }).value.commandMatchesWindow, false)
  } finally { f.cleanup() }
})

test('measure窗口只接受精确measurePlan、900秒限制与self identity', () => {
  const f = copiedSupervisor()
  try {
    const window = windowValue(f)
    assert.equal(bridge(f.script, 'window', { window, now: Date.now() / 1000 }).ok, true)
    for (const mutate of [
      value => { delete value.measurePlan },
      value => { value.measurePlan.groupCloneCount = 4 },
      value => { value.measurePlan.fullHashCount = 2 },
      value => { value.measurePlan.stopRoundReceiptCount = 104 },
      value => { value.measurePlan.sampleCount = 1574 },
      value => { value.limits.executionMs = 900001 },
      value => { delete value.supervisor },
      value => { value.supervisor.path = join(f.runtime, 'supervisor.py') },
      value => { value.supervisor.sha256 = 'f'.repeat(64) },
      value => { delete value.candidateRepository },
      value => { value.candidateRepository.root = join(f.temp, 'missing-candidate') },
      value => { value.candidateRepository.branch = 'codex/wrong' },
      value => { value.candidateRepository.head = 'f'.repeat(40) },
    ]) {
      const changed = structuredClone(window); mutate(changed)
      assert.equal(bridge(f.script, 'window', { window: changed, now: Date.now() / 1000 }).ok, false)
    }
    writeFileSync(f.script, '\n# drift\n', { flag: 'a' })
    assert.equal(bridge(f.script, 'window', { window, now: Date.now() / 1000 }).ok, false)
  } finally { f.cleanup() }
})

test('owned roots上限精确为68', () => {
  for (const [count, accepted] of [[68, true], [69, false]]) {
    const f = copiedSupervisor()
    try {
      const windowId = randomUUID(), manifest = ownedManifest(f, count, windowId)
      assert.equal(bridge(f.script, 'owned', { manifest, runtime: f.runtime, windowId }).ok, accepted)
    } finally { f.cleanup() }
  }
})

test('terminal authority以真实future output替代admission planned预算且仍验证root marker与空间', () => {
  {
    const f = copiedSupervisor()
    try {
      const payload = ownedTransition(f)
      assert.ok(payload.futureBytes < 16 * 1024 ** 3)
      assert.ok(payload.futureBytes + payload.plannedBytes > 16 * 1024 ** 3)
      const observed = bridge(f.script, 'owned-transition', payload)
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value.admission.plannedBytes, payload.plannedBytes)
      assert.equal(observed.value.terminal.plannedBytes, payload.plannedBytes, '终态仍保留窗口固定授权计划的既有证据语义')
      assert.equal(observed.value.terminal.ownedBytes, payload.futureBytes + statSync(join(f.runtime, 'owned-transition-root/owner.json')).size)
      assert.equal(observed.value.terminal.futureRootIdentities[payload.future].marker.sha256, sha(join(payload.future, 'command.json')))
    } finally { f.cleanup() }
  }
  for (const mutate of [
    payload => { payload.admissionAvailableBytes = payload.plannedBytes + 10 * 1024 ** 3 - 1 },
    payload => { payload.futureBytes = 16 * 1024 ** 3 },
    payload => { payload.symlinkMarker = true },
    payload => { payload.terminalAvailableBytes = 10 * 1024 ** 3 - 1 },
  ]) {
    const f = copiedSupervisor()
    try {
      const payload = ownedTransition(f); mutate(payload)
      assert.equal(bridge(f.script, 'owned-transition', payload).ok, false)
    } finally { f.cleanup() }
  }
})

test('tree hash的Python compact JSON与JSON.stringify整数及非整数毫秒一致', () => {
  const f = copiedSupervisor()
  try {
    const values = [
      { mtimeMs: 1_788_000_000_000, ctimeMs: 1_788_000_000_001 },
      { mtimeMs: 1_788_000_000_000.125, ctimeMs: 1_788_000_000_000.75 },
      { lowerFixed: 0.000001, scientific: 0.0000001, safeInteger: 1_000_000_000_000_000 },
      { largeScientific: 1e21, relative: '归档/换行\n文件' },
    ]
    for (const value of values) {
      const observed = bridge(f.script, 'js-json', { value })
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value, JSON.stringify(value))
    }
  } finally { f.cleanup() }
})

test('完整measure精确接受workspace receipt、fixture前后摘要与既有完整闭包', () => {
  const f = copiedSupervisor()
  try {
    const a = completeArtifacts(f.runtime)
    const observed = bridge(f.script, 'artifacts', { runtime: f.runtime, label: a.label })
    assert.equal(observed.ok, true)
    assert.equal(observed.value.samplesValid, true)
    assert.equal(observed.value.receiptsValid, true)
    assert.equal(observed.value.workspaceReceiptValid, true)
    assert.equal(observed.value.fixtureTreeValid, true)
    assert.equal(observed.value.roundReceiptsValid, true)
    assert.equal(observed.value.stageEvidenceValid, true)
    assert.equal(observed.value.receiptCount, 3)
    assert.equal(observed.value.roundReceiptCount, 105)
    assert.deepEqual(observed.value.measurePlan, plan)
    assert.deepEqual(observed.value.unexpectedEntries, [])
    assert.equal('workspaceReceipt' in observed.value, false, '公开结果不得泄漏workspace tree内容')
    assert.equal('fixtureBefore' in observed.value, false, '公开结果不得泄漏fixture tree内容')
  } finally { f.cleanup() }
})

test('缺round、重复Attempt、marker漂移、stop拼接错与多余文件均拒绝', () => {
  const mutations = [
    ({ output }) => rmSync(join(output, 'group-stop.round-105.receipt.json')),
    ({ output }) => {
      const first = JSON.parse(readFileSync(join(output, 'group-stop.round-001.receipt.json')))
      const secondPath = join(output, 'group-stop.round-002.receipt.json'), second = JSON.parse(readFileSync(secondPath))
      second.attemptId = first.attemptId; rmSync(secondPath); json(secondPath, second)
    },
    ({ output }) => {
      const path = join(output, 'group-stop.round-003.receipt.json'), value = JSON.parse(readFileSync(path))
      value.groupMarker.id = randomUUID(); rmSync(path); json(path, value)
    },
    ({ output }) => {
      const path = join(output, 'group-stop.round-004.receipt.json'), value = JSON.parse(readFileSync(path))
      value.samples.reverse(); rmSync(path); json(path, value)
    },
    ({ output }) => writeFileSync(join(output, 'unexpected.bin'), 'x'),
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor()
    try {
      const a = completeArtifacts(f.runtime, mutate)
      const observed = bridge(f.script, 'artifacts', { runtime: f.runtime, label: a.label })
      assert.equal(observed.ok, true)
      assert.equal(observed.value.receiptsValid && observed.value.roundReceiptsValid
        && observed.value.stageEvidenceValid && observed.value.unexpectedEntries.length === 0, false)
    } finally { f.cleanup() }
  }
})

test('workspace receipt缺失、额外、篡改、非普通文件及成功残留workspace均拒绝', () => {
  const mutations = [
    ({ output }) => rmSync(join(output, 'group-stop.workspace.receipt.json')),
    ({ output }) => json(join(output, 'group-stop.workspace.extra.json'), { schemaVersion: 1 }),
    ({ output }) => {
      const path = join(output, 'group-stop.workspace.receipt.json'), value = JSON.parse(readFileSync(path))
      value.scope = 'musicbridge-capacity-stop-workspace-tree-drift'; rmSync(path); json(path, value)
    },
    ({ output }) => {
      const path = join(output, 'group-stop.workspace.receipt.json'), value = JSON.parse(readFileSync(path))
      value.groupMarker.id = randomUUID(); rmSync(path); json(path, value)
    },
    ({ output }) => {
      const path = join(output, 'group-stop.receipt.json'), value = JSON.parse(readFileSync(path))
      value.workspaceTreeSha256 = 'd'.repeat(64); rmSync(path); json(path, value)
    },
    ({ output }) => {
      const path = join(output, 'group-stop.workspace.receipt.json'), value = JSON.parse(readFileSync(path))
      value.workspace.files += 1; rmSync(path); json(path, value)
    },
    ({ output }) => {
      const path = join(output, 'group-stop.workspace.receipt.json'), value = JSON.parse(readFileSync(path))
      value.workspace.entries[1].relative = '../escape'; rmSync(path); json(path, value)
    },
    ({ output }) => {
      const workspacePath = join(output, 'group-stop.workspace.receipt.json')
      const workspace = JSON.parse(readFileSync(workspacePath)); workspace.workspace.entries[3].contentSha256 = 'd'.repeat(64)
      workspace.workspace.treeSha256 = 'e'.repeat(64); rmSync(workspacePath); json(workspacePath, workspace)
      const groupPath = join(output, 'group-stop.receipt.json'), group = JSON.parse(readFileSync(groupPath))
      group.workspaceTreeSha256 = workspace.workspace.treeSha256; rmSync(groupPath); json(groupPath, group)
    },
    ({ output }) => {
      const path = join(output, 'group-stop.workspace.receipt.json'), target = join(output, '..', 'workspace-receipt-target.json')
      rmSync(path); json(target, workspaceReceipt(marker('stop'))); symlinkSync(target, path)
    },
    ({ output }) => linkSync(join(output, 'group-stop.workspace.receipt.json'), join(output, '..', 'workspace-receipt-hardlink.json')),
    ({ output }) => {
      const path = join(output, 'group-stop.receipt.json'), value = JSON.parse(readFileSync(path))
      value.workspaceTreeSha256 = 'not-a-sha256'; rmSync(path); json(path, value)
    },
    ({ output }) => {
      const workspace = join(output, 'group-stop/group-stop-workspace'); mkdirSync(workspace, { recursive: true })
      json(join(workspace, 'owner.json'), { id: randomUUID(), scope: 'musicbridge-capacity-stop-workspace' })
    },
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor()
    try {
      const a = completeArtifacts(f.runtime, mutate)
      const observed = bridge(f.script, 'artifacts', { runtime: f.runtime, label: a.label })
      assert.equal(observed.ok, true)
      assert.equal(observed.value.receiptsValid && observed.value.workspaceReceiptValid
        && observed.value.unexpectedEntries.length === 0, false)
    } finally { f.cleanup() }
  }
})

test('fixture摘要必须精确闭合且SQLite内容明确未hash', () => {
  const mutations = [
    ({ output }) => rmSync(join(output, 'fixture-after.json')),
    ({ output }) => {
      const path = join(output, 'fixture-after.json'), value = JSON.parse(readFileSync(path))
      value.treeSha256 = 'd'.repeat(64); rmSync(path); json(path, value)
    },
    ({ output }) => {
      const path = join(output, 'fixture-before.json'), value = JSON.parse(readFileSync(path))
      value.databaseContentSha256Verified = true; rmSync(path); json(path, value)
    },
    ({ output }) => {
      const path = join(output, 'fixture-before.json'), value = JSON.parse(readFileSync(path))
      const sqlite = value.entries.find(entry => entry.relative === 'seed.sqlite')
      sqlite.contentSha256Verified = true; sqlite.contentSha256 = 'e'.repeat(64); rmSync(path); json(path, value)
    },
    ({ output }) => {
      const path = join(output, 'fixture-before.json'), value = JSON.parse(readFileSync(path))
      value.extra = true; rmSync(path); json(path, value)
    },
    ({ output }) => {
      for (const name of ['fixture-before.json', 'fixture-after.json']) {
        const path = join(output, name), value = JSON.parse(readFileSync(path))
        value.entries[1].contentSha256 = 'd'.repeat(64); value.treeSha256 = 'e'.repeat(64)
        rmSync(path); json(path, value)
      }
    },
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor()
    try {
      const a = completeArtifacts(f.runtime, mutate)
      const observed = bridge(f.script, 'artifacts', { runtime: f.runtime, label: a.label })
      assert.equal(observed.ok, true)
      assert.equal(observed.value.fixtureTreeValid, false)
    } finally { f.cleanup() }
  }
})

test('第30轮partial保留group-stop与前29 rounds且绝不verifiedPassed', () => {
  const f = copiedSupervisor()
  try {
    const a = partialArtifacts(f.runtime)
    const observed = bridge(f.script, 'artifacts', { runtime: f.runtime, label: a.label })
    assert.equal(observed.ok, true)
    assert.equal(observed.value.partialExists, true)
    assert.equal(observed.value.partialPreserved, true)
    assert.equal(observed.value.partialEvidenceValid, true)
    assert.equal(observed.value.receiptCount, 1)
    assert.equal(observed.value.roundReceiptCount, 29)
    assert.equal(observed.value.stageCount, 10)
    assert.equal(observed.value.sampleCount, 279)
    assert.equal(observed.value.verifiedComplete, false)
    assert.equal(observed.value.verifiedPassed, false)
  } finally { f.cleanup() }
})

test('旧timeout carryover按legacy 107-clone格式验证29 receipts、273 samples且不读取sqlite', () => {
  const f = copiedSupervisor()
  try {
    const payload = legacyCarryover(f)
    const observed = bridge(f.script, 'carryover', payload)
    assert.equal(observed.ok, true)
    assert.equal(observed.value.valid, true)
    assert.equal(observed.value.terminal.failure, 'EXECUTION_TIMEOUT')
    assert.equal(observed.value.partial.format, 'legacy-107-clone-partial-v1')
    assert.equal(observed.value.partial.sampleCount, 273)
    assert.equal(observed.value.partial.receiptCount, 29)
    assert.equal(observed.value.partial.samplesMatchReceipts, true)
    assert.equal(observed.value.partial.receiptNames.length, 29)
    assert.deepEqual(observed.value.partial.metricCounts, {
      progress: 105, signalAborted: 28, driverStopInvoked: 28, driverStopAck: 28,
      driverCloseInvoked: 28, driverCloseResolved: 28, receiptSettled: 28,
    })
    assert.deepEqual(observed.value.partial.retainedDirectories, ['sample-30'])
    assert.equal(observed.value.partial.retainedClone.sqlite.contentSha256Verified, false)
    assert.equal(observed.value.partial.retainedClone.sqlite.verification, 'stable-lstat-size-only-no-content-read')
    assert.deepEqual(observed.value.partial.unexpectedEntries, [])
    assert.equal(observed.value.roots.length, 2)
    assert.equal(observed.value.roots.every(root => root.path && root.marker), true)
    const changed = structuredClone(payload); changed.commandSha256 = 'f'.repeat(64)
    assert.equal(bridge(f.script, 'carryover', changed).ok, false)
  } finally { f.cleanup() }
})

test('legacy carryover拒绝receipt缺失、内容漂移与samples拼接漂移', () => {
  const mutations = [
    ({ output }) => rmSync(join(output, 'sample-17.receipt.json')),
    ({ output }) => {
      const path = join(output, 'sample-9.receipt.json'), value = JSON.parse(readFileSync(path))
      value.sqliteSha256 = 'f'.repeat(64); rmSync(path); json(path, value)
    },
    ({ output }) => {
      const path = join(output, 'samples.jsonl'), rows = readFileSync(path, 'utf8').trimEnd().split('\n')
      ;[rows[110], rows[111]] = [rows[111], rows[110]]
      writeFileSync(path, rows.join('\n') + '\n')
    },
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor()
    try { assert.equal(bridge(f.script, 'carryover', legacyCarryover(f, mutate)).ok, false) }
    finally { f.cleanup() }
  }
})

test('prebuild或stop partial可保留受控workspace但绝不误判成功', () => {
  const f = copiedSupervisor()
  try {
    const a = partialArtifacts(f.runtime)
    const workspace = join(a.output, 'group-stop/group-stop-workspace'); mkdirSync(workspace)
    json(join(workspace, 'owner.json'), { id: randomUUID(), scope: 'musicbridge-capacity-stop-workspace' })
    for (const name of ['source', 'execution', 'archive']) mkdirSync(join(workspace, name))
    writeFileSync(join(workspace, 'source/fixture.wav'), 'partial fixture')
    const observed = bridge(f.script, 'artifacts', { runtime: f.runtime, label: a.label })
    assert.equal(observed.ok, true)
    assert.equal(observed.value.partialEvidenceValid, true)
    assert.equal(observed.value.verifiedComplete, false)
    assert.equal(observed.value.verifiedPassed, false)
    assert.deepEqual(observed.value.unexpectedEntries, [])
  } finally { f.cleanup() }
})

test('legacy carryover拒绝v2 artifact及任意多余顶层entry', () => {
  const mutations = [
    ({ output }) => json(join(output, 'group-stop.round-001.receipt.json'), { schemaVersion: 1 }),
    ({ output }) => writeFileSync(join(output, 'unexpected.bin'), 'x'),
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor()
    try { assert.equal(bridge(f.script, 'carryover', legacyCarryover(f, mutate)).ok, false) }
    finally { f.cleanup() }
  }
})

test('legacy carryover拒绝retained clone子项、owner、sidecar、sqlite size与symlink漂移', () => {
  const mutations = [
    ({ retained }) => rmSync(join(retained, 'sample.sqlite-shm')),
    ({ retained }) => {
      const path = join(retained, 'owner.json'), value = JSON.parse(readFileSync(path)); value.label = 'group-stop'
      rmSync(path); json(path, value)
    },
    ({ retained }) => writeFileSync(join(retained, 'sample.sqlite-wal'), 'drift'),
    ({ retained }) => writeFileSync(join(retained, 'sample.sqlite'), 'size drift', { flag: 'a' }),
    ({ retained }) => writeFileSync(join(retained, 'unexpected.sidecar'), 'x'),
    ({ retained, output }) => linkSync(join(retained, 'sample.sqlite'), join(output, '..', 'sqlite-hardlink')),
    ({ retained, output }) => {
      const path = join(retained, 'sample.sqlite'); rmSync(path)
      const target = join(output, '..', 'outside.sqlite'); writeFileSync(target, 'small sparse substitute'); symlinkSync(target, path)
    },
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor()
    try { assert.equal(bridge(f.script, 'carryover', legacyCarryover(f, mutate)).ok, false) }
    finally { f.cleanup() }
  }
})
