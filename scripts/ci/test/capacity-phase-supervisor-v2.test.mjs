import assert from 'node:assert/strict'
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const sourceSupervisor = new URL('../capacity-phase-supervisor-v2.py', import.meta.url).pathname
const sourceBuildHelper = new URL('../issue-v3-capacity-window.py', import.meta.url).pathname
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

function identity(path) {
  const info = statSync(path)
  return { device: info.dev, inode: info.ino, size: info.size, sha256: sha(path) }
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
  elif method == 'aggregate-budget':
    value=module._validate_measure_aggregate_budget(pathlib.Path(payload['output']))
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
  elif method == 'queued-window':
    value=list(module._validate_queued_stop_window(payload['window'], payload['now']))
  elif method == 'queued-artifacts':
    value=module._validate_queued_stop_artifacts(pathlib.Path(payload['parent']), payload.get('expected'))
  elif method == 'queued-bound-identities':
    value=module._validate_queued_stop_bound_identities(
      payload['window'], pathlib.Path(payload['parent']), pathlib.Path(payload['candidate']))
  elif method == 'queued-command':
    captured={}
    module._require_loaded_window_identity=lambda *args, **kwargs: True
    module._reject_queued_stop_replay=lambda *args, **kwargs: True
    module._validate_queued_stop_authority=lambda *args, **kwargs: {'authorityStable': True}
    module._write_queued_stop_close=lambda *args, **kwargs: captured.update(close=True)
    module._validate_queued_stop_artifacts=lambda *args, **kwargs: {'verifiedComplete': True, 'verifiedPassed': True}
    def supervise(command, deadline, supervision, **kwargs):
      captured['command']=[str(item) for item in command]; captured['cwd']=str(kwargs.get('cwd'))
      captured['environment']=kwargs.get('environment'); kwargs['artifact_probe']()
      return {'passed':True,'failure':None,'code':0,'signals':[],'groupEmpty':True,'zombies':[]}
    module.supervise=supervise
    loaded=(pathlib.Path(payload['runtime']), pathlib.Path(payload['authority']), payload['window'], {'sha256': payload['windowSha256']})
    value={'exit':module._main_queued_stop([], loaded=loaded), **captured}
  elif method == 'owned':
    future=pathlib.Path(payload['future']) if payload.get('future') else None
    value=module._validate_owned_manifest(pathlib.Path(payload['manifest']), pathlib.Path(payload['runtime']),
      payload['windowId'], 'objects-limit', planned_bytes=0,
      future_path=future, future_state='absent' if future is not None else None)
  elif method == 'measure-plan':
    value=module._measure_planned_bytes(payload['snapshotBytes'])
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
  elif method in ('issuer-failure-carryover', 'v2-terminal-carryover'):
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
    if method == 'issuer-failure-carryover':
      value=module._validate_measure_issuer_failure_carryover(
        pathlib.Path(payload['parent']), pathlib.Path(payload['runtime']), payload['ownedSha256'],
        payload['failureSha256'], payload['windowId'], payload['dirName'], payload['label'])
    else:
      value=module._validate_measure_v2_terminal_carryover(
        pathlib.Path(payload['window']), pathlib.Path(payload['close']), pathlib.Path(payload['output']),
        pathlib.Path(payload['runtime']), payload['ownedSha256'], payload['windowSha256'],
        payload['closeSha256'], payload['commandSha256'], payload['windowId'], payload['label'])
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
    'packages/contracts/src/generated.ts',
    'scripts/ci/capacity-phase-supervisor-v2.py', 'scripts/ci/issue-v3-capacity-measure-window.py',
  ]
  for (const relative of candidateFiles) {
    const path = join(candidate, relative); mkdirSync(dirname(path), { recursive: true })
    if (relative === 'scripts/ci/capacity-phase-supervisor-v2.py') copyFileSync(sourceSupervisor, path)
    else writeFileSync(path, `${relative}\n`)
  }
  copyFileSync(sourceBuildHelper, join(candidate, 'scripts/ci/issue-v3-capacity-window.py'))
  writeFileSync(join(candidate, 'packages/contracts/tsconfig.json'), '{}\n')
  writeFileSync(join(candidate, 'scripts/ci/issue-v3-capacity-queued-stop-window.py'), 'queued issuer\n')
  writeFileSync(join(candidate, 'tsx-loader.mjs'), 'export {}\n')
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

const queuedLimits = { executionMs: 50_000, killGraceMs: 1_000, closeMs: 2_000,
  minimumFreeBytes: 10 * 1024 ** 3, maximumOwnedBytes: 16 * 1024 ** 3 }

function queuedWindowValue(f) {
  const now = Date.now(), snapshotBytes = 1_990_471_680
  return {
    schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-window', owner: 'root', id: randomUUID(), state: 'approved',
    phase: 'queued-stop', profile: 'objects-limit', label: 'objects-limit-queued-stop-formal-01',
    seedLabel: 'r023-objects-limit-seed-03',
    seed: { label: 'r023-objects-limit-seed-03', metadataSha256: '632d8e4b0c01ffec07adc72344e7bcc877e5f1d764e7745af856c6ba44492309',
      snapshotSha256: '7ec9b3bed1642503cc9fcee70c6156b54eb43834b0a457050ec51607f2e1ab3a',
      fixtureOwnerSha256: '8e885bdee2c2acd6ba6b189f6de6c88bcb5e3a4b84d838a9b56e30987eb716c1' },
    n: 105, issuedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 900_000).toISOString(), limits: queuedLimits,
    ownedManifest: { file: 'owned-roots.json', sha256: '4'.repeat(64) },
    sourceManifest: { file: 'source-pins.json', sha256: '5'.repeat(64) },
    queuedStopPlan: { warmupCount: 5, formalCount: 100, sampleCount: 105, activeCloneMaximum: 1,
      snapshotBytes, evidenceAllowanceBytes: 256 * 1024 ** 2, plannedBytes: snapshotBytes + 256 * 1024 ** 2,
      model: 'serial-single-clone-plus-bounded-growth-v1', aggregateAudit: 'queued-stop-aggregate-budget.jsonl' },
    supervisor: { path: f.script, sha256: sha(f.script) },
    toolchain: {
      node: { path: process.execPath, sha256: 'd'.repeat(64) },
      tsxLoader: { path: join(f.candidate, 'tsx-loader.mjs'), sha256: 'e'.repeat(64) },
      consumerPython: { path: python, sha256: 'f'.repeat(64) },
    },
    issuer: { path: sourceSupervisor, sha256: 'a'.repeat(64),
      fact: { path: join(f.authority, 'issuer-identity/owner.json'), sha256: 'b'.repeat(64) } },
    candidateRepository: { root: f.candidate, branch: f.candidateBranch, head: f.head },
    measureCarryover: {
      window: { path: join(f.runtime, 'r023-objects-limit-measure-window-06/window.json'), id: 'afc81a99-d15d-4179-8326-5774a5c40b62', sha256: 'cfac8e19336a181de00c68d458d046065cd821a0dca48cc4fc78af0e15c15227' },
      close: { path: join(f.runtime, 'r023-objects-limit-measure-window-06/close.json'), sha256: '1c93f6c6ec1a0b58619f87127d3e2c7d11a1cfcce1c155b3576a84eda2af84b7' },
      ownedManifest: { path: join(f.runtime, 'r023-objects-limit-measure-window-06/owned-roots.json'), sha256: 'cd6faddd3b205f290e379cec95af9c20a6fbbbbfd2c7989ef07ff2712bc3c4ab' },
      sourceManifest: { path: join(f.runtime, 'r023-objects-limit-measure-window-06/source-pins.json'), sha256: '71bfb77f9c706ae9d31f580d4067f7ff427ee1099c341f03915d39ab1edff503' },
      supervision: { path: join(f.runtime, 'r023-objects-limit-measure-window-06/supervision/supervisor.json'), sha256: '18ef840fe99b861ca8881c7c7be09b70c13431df02d88ddf282e29f2169cdc92' },
      supervisor: { path: join(f.runtime, 'r023-objects-limit-measure-window-06/supervisor.py'), sha256: 'aaf871474dfe8129bae76ff8d2f07ed4f9a1200801d9108d005e6bbd1823e743' },
      output: { path: join(f.runtime, 'r023-objects-limit-measure-06'), label: 'r023-objects-limit-measure-06', commandSha256: '4a0417df8056764a5ba6a24ffda42d7be590cb4bfbd480b5d7188d8d609b8231' },
    },
  }
}

function sealQueuedIdentity(f, window) {
  const issuerPath = join(f.candidate, 'scripts/ci/issue-v3-capacity-queued-stop-window.py')
  const supervisorPath = join(f.candidate, 'scripts/ci/capacity-phase-supervisor-v2.py')
  const tsxPath = join(f.candidate, 'tsx-loader.mjs')
  window.toolchain = { node: { path: process.execPath, sha256: sha(process.execPath) },
    tsxLoader: { path: tsxPath, sha256: sha(tsxPath) }, consumerPython: { path: python, sha256: sha(python) } }
  window.issuer.path = issuerPath; window.issuer.sha256 = sha(issuerPath)
  const buildHelperPath = join(f.candidate, 'scripts/ci/issue-v3-capacity-window.py')
  const buildRoot = join(f.temp, 'queued-build-toolchain')
  const buildNodeLibrary = join(buildRoot, 'libnode.141.dylib')
  const typescriptDirectory = join(buildRoot, 'typescript/lib')
  const typescriptCompiler = join(typescriptDirectory, '_tsc.js')
  const typescriptLibrary = join(typescriptDirectory, 'lib.d.ts')
  mkdirSync(typescriptDirectory, { recursive: true })
  writeFileSync(buildNodeLibrary, 'node library\n')
  writeFileSync(typescriptCompiler, 'typescript compiler\n')
  writeFileSync(typescriptLibrary, 'interface Test {}\n')
  const libraryManifestSha256 = createHash('sha256').update(JSON.stringify({ files: { 'lib.d.ts': sha(typescriptLibrary) } })).digest('hex')
  const distRelative = 'packages/contracts/dist/generated.js'
  writeFileSync(join(f.candidate, distRelative), 'export const generated = true\n')
  json(join(f.authority, 'source-pins.json'), { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins',
    files: { [distRelative]: sha(join(f.candidate, distRelative)) } })
  const buildToolchain = {
    node: { path: process.execPath, sha256: sha(process.execPath) },
    nodeLibrary: { path: buildNodeLibrary, sha256: sha(buildNodeLibrary) },
    typescriptCompiler: { path: typescriptCompiler, sha256: sha(typescriptCompiler) },
    typescriptLibraryManifestSha256: libraryManifestSha256,
  }
  const build = {
    candidateHead: f.head,
    inputs: {
      'packages/contracts/package.json': sha(join(f.candidate, 'packages/contracts/package.json')),
      'packages/contracts/tsconfig.json': sha(join(f.candidate, 'packages/contracts/tsconfig.json')),
      'packages/contracts/src/generated.ts': sha(join(f.candidate, 'packages/contracts/src/generated.ts')),
    },
    command: ['/private/toolchain/bin/node', '/private/toolchain/typescript/lib/_tsc.js', '--project',
      '/private/packages/contracts/tsconfig.json', '--pretty', 'false', '--incremental', 'false', '--noCheck', '--noResolve'],
    environment: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' },
    timeoutMs: 120000, compilerExitCode: 0, compilerOutputBytes: 0,
    privateToolchain: { nodeSha256: buildToolchain.node.sha256,
      nodeLibrarySha256: buildToolchain.nodeLibrary.sha256,
      typescriptCompilerSha256: buildToolchain.typescriptCompiler.sha256,
      typescriptLibraryManifestSha256: libraryManifestSha256 },
    outputs: { [distRelative]: sha(join(f.candidate, distRelative)) },
  }
  const factPath = join(f.authority, 'issuer-identity/owner.json')
  json(factPath, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-authority-issuer', windowId: window.id,
    issuerRepository: { root: f.candidate, branch: f.candidateBranch, head: f.head,
      relativePath: 'scripts/ci/issue-v3-capacity-queued-stop-window.py', sha256: window.issuer.sha256 },
    candidateRepository: window.candidateRepository,
    supervisorSource: { path: supervisorPath, relativePath: 'scripts/ci/capacity-phase-supervisor-v2.py', sha256: window.supervisor.sha256 },
    toolchain: window.toolchain,
    buildHelper: { path: buildHelperPath, relativePath: 'scripts/ci/issue-v3-capacity-window.py', sha256: sha(buildHelperPath) },
    buildToolchain, build, measureCarryover: window.measureCarryover })
  window.issuer.fact = { path: factPath, sha256: sha(factPath) }
  return window
}

function completeQueuedArtifacts(f, window, mutate = () => {}) {
  const output = join(f.authority, window.label); mkdirSync(output)
  const planId = randomUUID(), planHash = 'e'.repeat(64)
  json(join(output, 'owner.json'), { scope: 'musicbridge-capacity-phase-output', id: randomUUID(), windowId: window.id, label: window.label })
  json(join(output, 'input.json'), { args: { phase: 'queued-stop', profile: 'objects-limit', label: window.label,
    seedLabel: window.seedLabel, windowPath: join(f.authority, 'window.json'), windowSha256: 'd'.repeat(64),
    ownedRootsPath: join(f.authority, 'owned-roots.json'), ownedRootsSha256: window.ownedManifest.sha256 },
    windowId: window.id, seedSha256: window.seed.snapshotSha256, sourceManifestSha256: window.sourceManifest.sha256,
    initialSpace: { availableBytes: 16 * 1024 ** 3, plannedBytes: window.queuedStopPlan.plannedBytes, ownedBytes: 1 },
    effectiveOperationLimits: { executionMs: 50_000, killGraceMs: 1_000, closeMs: 2_000, admissionReserveMs: 53_000 },
    classification: 'software-only/exclusive-window', cache: 'test', n: 105, warmup: 5, formalSamples: 100,
    clocks: 'parent与child分栏，不跨进程相减', backend: 'private-immediate-fake', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' })
  const rows = [], pids = []
  for (let index = 1; index <= 105; index += 1) {
    const name = `sample-${String(index).padStart(3, '0')}`, childPid = 10_000 + index; pids.push(childPid)
    const receipt = { outcome: 'ok', requestId: randomUUID(), childPid, code: 0, signal: null, closed: true,
      cleanup: { termSent: false, killSent: false }, forkToCloseMs: 10, phase: 'exited',
      timings: { readyMs: 1, clock: 'parent-relative', receiptMs: 2, sendStopToReceiptMs: 1, exitMs: 3, receiptToChildCloseMs: 1 },
      processGroup: { pgid: childPid, managed: true, groupEmpty: true, zombies: [] },
      result: { kind: 'queue', planId, planHash, attemptId: randomUUID(), order: ['progress','stop'],
        progressFrames: 1, fullAuditMs: 1, beginMs: 1, progressMs: 1, abortObserved: true, driverStopInvoked: true,
        driverStopAcknowledged: true, stopReceivedToAbortMs: 1, stopReceivedToDriverStopInvokedMs: 1,
        stopReceivedToDriverStopAckMs: 1, stopReceivedToReceiptMs: 1, childMeasuredMs: 2, clock: 'child-relative',
        deviceOpened: false, formalReady: false, gateB: 'NOT_RUN', driverCloseInvoked: true, driverCloseResolved: true,
        stopReceivedToDriverCloseInvokedMs: 1, stopReceivedToDriverCloseResolvedMs: 1 } }
    const row = { index, phase: 'queued-stop', profile: 'objects-limit', warmup: index <= 5, preparationMs: 1,
      outcome: 'ok', result: receipt, beforeSpace: { availableBytes: 16 * 1024 ** 3, plannedBytes: window.queuedStopPlan.plannedBytes, ownedBytes: 1 } }
    json(join(output, `${name}-intent.json`), { index, phase: 'queued-stop', profile: 'objects-limit', windowId: window.id,
      seedSha256: window.seed.snapshotSha256, state: 'operation-not-yet-returned' })
    json(join(output, `${name}-raw-receipt.json`), receipt)
    json(join(output, `${name}-raw-receipt.sha256.json`), { sha256: sha(join(output, `${name}-raw-receipt.json`)) })
    json(join(output, `${name}.json`), row)
    json(join(output, `${name}-retention.json`), { retained: false, resourcesClosed: true,
      space: { availableBytes: 16 * 1024 ** 3, plannedBytes: 0, ownedBytes: 1 } })
    json(join(output, `${name}.receipt.json`), { outcome: 'ok', resourcesClosed: true, samples: [receipt],
      marker: { id: randomUUID(), scope: 'musicbridge-capacity-clone-only', label: name }, sqliteSha256: 'f'.repeat(64), retained: false,
      workspaceReceipt: null, workspaceTreeSha256: null })
    rows.push(row)
  }
  writeFileSync(join(output, 'samples.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  json(join(output, 'summary.json'), { phase: 'queued-stop', profile: 'objects-limit', state: 'passed', planned: 105,
    attempted: 105, successes: 105, failures: 0, timeouts: 0, unrun: 0, minMs: 10, medianMs: 10, maxMs: 10, p99: null,
    queuedStop: { counts: { warmup: 5, formal: 100 }, childProgressMs: { n: 100, p50: 1, p95: 1, p99: 1, max: 1, limitP95: 50, limitMax: 100, passed: true },
      stopReceivedToAbortMs: { n: 100, p50: 1, p95: 1, p99: 1, max: 1, limitMax: 100, passed: true },
      stopReceivedToDriverStopInvokedMs: { n: 100, p50: 1, p95: 1, p99: 1, max: 1, limitMax: 100, passed: true },
      stopReceivedToDriverStopAckMs: { n: 100, p50: 1, p95: 1, p99: 1, max: 1 },
      stopReceivedToReceiptMs: { n: 100, p50: 1, p95: 1, p99: 1, max: 1, limitP95: 500, limitMax: 2000, passed: true },
      parentSendStopToReceiptMs: { n: 100, p50: 1, p95: 1, p99: 1, max: 1, limitMax: 2000, passed: true },
      parentReceiptToChildCloseMs: { n: 100, p50: 1, p95: 1, p99: 1, max: 1 },
      driverCloseInvokedMs: { n: 100, p50: 1, p95: 1, p99: 1, max: 1 },
      driverCloseResolvedMs: { n: 100, p50: 1, p95: 1, p99: 1, max: 1, limitMax: 250, passed: true }, passed: true },
    deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' })
  json(join(output, 'exit.json'), { exit: 0 })
  const aggregate = [], aggregateRow = (checkpoint, group, activeClone, plannedBytes = 0) => aggregate.push({ schemaVersion: 1,
    scope: 'musicbridge-capacity-queued-stop-aggregate-budget', sequence: aggregate.length + 1, checkpoint, group,
    activeClone, snapshotBytes: window.queuedStopPlan.snapshotBytes, limitBytes: window.queuedStopPlan.plannedBytes,
    outputBytesBefore: 1, plannedBytes, recordedAt: new Date().toISOString() })
  aggregateRow('output-created', null, null); aggregateRow('input-written', null, null)
  for (let index = 1; index <= 105; index += 1) {
    const group = `sample-${String(index).padStart(3, '0')}`
    aggregateRow('clone-before-write', group, null, window.queuedStopPlan.snapshotBytes)
    for (const checkpoint of ['clone-after-write', 'operation-returned', 'sample-evidence-written', 'retention-written',
      'group-receipt-before-write', 'group-receipt-after-write']) aggregateRow(checkpoint, group, group)
    aggregateRow('clone-after-cleanup', group, null)
  }
  aggregateRow('terminal-written', null, null)
  writeFileSync(join(output, 'queued-stop-aggregate-budget.jsonl'), aggregate.map(row => JSON.stringify(row)).join('\n') + '\n')
  mutate({ output, rows, pids })
  return output
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

function aggregateBudgetRows(group = 'progress', activeClone = `group-${group}`) {
  const snapshotBytes = 1024 * 1024, limitBytes = snapshotBytes + 256 * 1024 ** 2
  return [
    { schemaVersion: 1, scope: 'musicbridge-capacity-measure-aggregate-budget', sequence: 1,
      checkpoint: 'clone-before-write', group, activeClone: null, snapshotBytes, limitBytes,
      outputBytesBefore: 1024, plannedBytes: snapshotBytes, recordedAt: new Date(1_788_000_000_000).toISOString() },
    { schemaVersion: 1, scope: 'musicbridge-capacity-measure-aggregate-budget', sequence: 2,
      checkpoint: 'clone-after-write', group, activeClone, snapshotBytes, limitBytes,
      outputBytesBefore: snapshotBytes + 4096, plannedBytes: 0, recordedAt: new Date(1_788_000_000_001).toISOString() },
  ]
}

function writeAggregateBudget(output, rows = aggregateBudgetRows()) {
  writeFileSync(join(output, 'measure-aggregate-budget.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' })
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
  writeAggregateBudget(output)
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
  writeAggregateBudget(output, aggregateBudgetRows('stop', 'group-stop'))
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

function ownedManifest(f, count, windowId, future = null) {
  const roots = []
  for (let index = 0; index < count; index += 1) {
    const path = join(f.runtime, `owned-${String(index).padStart(2, '0')}`); mkdirSync(path)
    json(join(path, 'owner.json'), { scope: 'test', index })
    const info = statSync(path)
    roots.push({ path, device: info.dev, inode: info.ino,
      marker: { relative: 'owner.json', sha256: sha(join(path, 'owner.json')) } })
  }
  const manifest = join(f.authority, `owned-${count}.json`)
  json(manifest, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId, roots,
    ...(future ? { futureRoots: [future] } : {}) })
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
    futureBytes: plannedBytes,
    admissionAvailableBytes: plannedBytes + 10 * 1024 ** 3 + 1,
    terminalAvailableBytes: 10 * 1024 ** 3 + 1,
  }
}

function rootRow(path, markerName = 'owner.json') {
  const info = statSync(path)
  return { path, device: info.dev, inode: info.ino,
    marker: { relative: markerName, sha256: sha(join(path, markerName)) } }
}

function issuerFailureCarryover(f, mutate = () => {}) {
  const windowId = randomUUID(), dirName = 'objects-measure-window-03', label = 'objects-measure-03'
  const parent = join(f.runtime, dirName), issuerIdentity = join(parent, 'issuer-identity')
  const inherited = join(f.runtime, 'inherited-root'); mkdirSync(inherited); mkdirSync(issuerIdentity, { recursive: true })
  json(join(inherited, 'owner.json'), { scope: 'test-inherited' })
  json(join(parent, 'owner.json'), { scope: 'musicbridge-capacity-measure-window', owner: 'root', id: windowId })
  json(join(issuerIdentity, 'owner.json'), { scope: 'musicbridge-capacity-measure-authority-issuer', id: windowId })
  copyFileSync(f.script, join(parent, 'supervisor.py'), constants.COPYFILE_EXCL)
  json(join(parent, 'source-pins.json'), { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: {} })
  const future = join(f.runtime, label)
  json(join(parent, 'owned-roots.json'), {
    schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId,
    roots: [rootRow(inherited), rootRow(parent), rootRow(issuerIdentity)], futureRoots: [future],
  })
  json(join(parent, 'issuer-failure.json'), {
    schemaVersion: 1, scope: 'musicbridge-capacity-measure-authority-issuer-failure',
    state: 'TERMINAL_ISSUER_FAILURE', windowId, windowDirName: dirName, label,
    errorCode: 'AUTHORITY_PREFLIGHT',
    authorityFilesCreated: ['owner.json', 'supervisor.py', 'issuer-identity/owner.json', 'source-pins.json', 'owned-roots.json'],
    windowWritten: false, replayAllowed: false, recordedAt: new Date().toISOString(),
  })
  mutate({ parent, inherited, issuerIdentity, future })
  return { parent, runtime: f.runtime, ownedSha256: sha(join(parent, 'owned-roots.json')),
    failureSha256: sha(join(parent, 'issuer-failure.json')), windowId, dirName, label }
}

function v2TerminalCarryover(f, mutate = () => {}) {
  const windowId = randomUUID(), dirName = 'objects-measure-window-04', label = 'objects-measure-04'
  const parent = join(f.runtime, dirName), issuerIdentity = join(parent, 'issuer-identity')
  const inherited = join(f.runtime, 'terminal-inherited-root'), output = join(f.runtime, label)
  mkdirSync(inherited); mkdirSync(issuerIdentity, { recursive: true }); mkdirSync(output)
  json(join(inherited, 'owner.json'), { scope: 'test-terminal-inherited' })
  json(join(parent, 'owner.json'), { scope: 'musicbridge-capacity-measure-window', owner: 'root', id: windowId })
  json(join(issuerIdentity, 'owner.json'), { scope: 'musicbridge-capacity-measure-authority-issuer', id: windowId })
  copyFileSync(f.script, join(parent, 'supervisor.py'), constants.COPYFILE_EXCL)
  json(join(parent, 'source-pins.json'), { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: {} })
  json(join(parent, 'owned-roots.json'), {
    schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId,
    roots: [rootRow(inherited), rootRow(parent), rootRow(issuerIdentity)], futureRoots: [output],
  })
  const ownedSha256 = sha(join(parent, 'owned-roots.json'))
  const sourceSha256 = sha(join(parent, 'source-pins.json'))
  const window = windowValue(f)
  Object.assign(window, { id: windowId, label, supervisor: { path: join(parent, 'supervisor.py'), sha256: sha(join(parent, 'supervisor.py')) },
    ownedManifest: { file: 'owned-roots.json', sha256: ownedSha256 },
    sourceManifest: { file: 'source-pins.json', sha256: sourceSha256 } })
  json(join(parent, 'window.json'), window)
  const entry = join(f.candidate, 'packages/bridge-core/test/benchmarks/recording-capacity.ts')
  json(join(output, 'command.json'), {
    executable: '/test/node', args: [entry, '--phase', 'measure', '--profile', 'objects-limit', '--label', label,
      '--seed-label', window.seedLabel, '--window', windowId, '--runtime-root', f.runtime],
    cwd: `${f.candidate}/`, node: 'v22.23.2', phase: 'measure', profile: 'objects-limit', window: windowId,
    deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
  })
  json(join(output, 'measurement.json'), { seedLabel: window.seedLabel, seedSha256: window.seed.snapshotSha256,
    profile: 'objects-limit', window: windowId, measurePlan: plan })
  const rows = completeSamples(1), allRows = [...rows.progress, ...rows.stop]
  writeFileSync(join(output, 'samples.jsonl'), allRows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' })
  json(join(output, 'source-before.json'), { files: {} }); json(join(output, 'source-after.json'), { files: {} })
  json(join(output, 'exit.json'), { exit: 1 })
  const progressMarker = marker('progress'), stopMarker = marker('stop')
  json(join(output, 'group-progress.receipt.json'), groupReceipt('progress', progressMarker, rows.progress))
  json(join(output, 'group-stop.round-001.receipt.json'), roundReceipt(1, stopMarker, rows.stop))
  writeFileSync(join(output, 'measure-stages.jsonl'),
    stages(['progress'], 1).concat(stages(['stop'], 1).slice(0, 4)).map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' })
  const retained = join(output, 'group-stop'); mkdirSync(retained)
  json(join(retained, 'owner.json'), stopMarker); writeFileSync(join(retained, 'sample.sqlite'), 'sqlite bytes are never read\n')
  const supervision = join(parent, 'supervision'); mkdirSync(supervision)
  writeFileSync(join(supervision, 'stdout.log'), "TAP version 13\n  code: 'COPY_UNAVAILABLE'\n")
  writeFileSync(join(supervision, 'stderr.log'), 'SQLite experimental warning\n')
  json(join(supervision, 'supervisor.json'), { passed: false, failure: null, code: 1, groupEmpty: true, zombies: [] })
  const present = ['command.json', 'measurement.json', 'samples.jsonl', 'source-before.json', 'source-after.json',
    'exit.json', 'measure-stages.jsonl']
  const files = Object.fromEntries(present.map(name => [name, { exists: true, size: statSync(join(output, name)).size, sha256: sha(join(output, name)) }]))
  for (const name of ['end-budget.json', 'summary.json']) files[name] = { exists: false, size: null, sha256: null }
  const close = {
    schemaVersion: 1, scope: 'musicbridge-capacity-measure-window-close', windowId,
    profile: 'objects-limit', label, seedLabel: window.seedLabel, state: 'failed', failure: 'AUTHORITY_DRIFT',
    managedProcessGroup: true, code: 1, exitSignal: null, signals: [], groupEmpty: true, zombies: [],
    windowSha256: sha(join(parent, 'window.json')), sourceManifestSha256: sourceSha256, ownedManifestSha256: ownedSha256,
    seed: window.seed,
    authorityAdmission: { authorityStable: true, windowStable: true, ownerStable: true,
      sourceManifestStable: true, ownedManifestStable: true, sourcePinsValid: true, ownedRootsValid: true,
      spaceValid: true, seedValid: true, windowSha256Observed: sha(join(parent, 'window.json')),
      sourceManifestSha256Observed: sourceSha256, ownedManifestSha256Observed: ownedSha256,
      ownedRootCount: 4, plannedBytes: 4_249_378_816, seedSnapshotBytes: 1_990_471_680 },
    authorityTerminal: { authorityStable: false, error: 'AUTHORITY_DRIFT' },
    measurement: { profile: 'objects-limit', label, seedLabel: window.seedLabel, window: windowId,
      windowSha256: sha(join(parent, 'window.json')), ownedManifestSha256: ownedSha256,
      sourceManifestSha256: sourceSha256, outputDirectory: output, outputDirectoryExists: true,
      partialExists: true, partialPreserved: true, files, unexpectedEntries: [], sampleCount: 111,
      measurePlan: plan, samplesValid: false, receiptCount: 1, receiptsValid: false,
      roundReceiptCount: 1, roundReceiptsValid: false, roundReceiptInventory: [],
      stageEvidenceValid: false, stageCount: 10, partialEvidenceValid: false,
      receiptInventory: [{ name: 'group-progress.receipt.json', identity: identity(join(output, 'group-progress.receipt.json')),
        outcome: 'ok', retained: false, sampleCount: 105, marker: progressMarker, sqliteSha256: 'a'.repeat(64) }],
      retainedInventory: [{ path: retained, device: statSync(retained).dev, inode: statSync(retained).ino,
        marker: identity(join(retained, 'owner.json')) }],
      exitZero: false, sourceBeforeEqualsAfter: true, childExitMatchesThreshold: true,
      commandMatchesWindow: true, measurementMatchesWindow: true, summaryComplete: false,
      thresholdPassed: false, authorityStable: false, authority: null, authorityError: 'AUTHORITY_DRIFT',
      verifiedComplete: false, verifiedPassed: false },
    stdout: { path: join(supervision, 'stdout.log'), exists: true, size: statSync(join(supervision, 'stdout.log')).size,
      sha256: sha(join(supervision, 'stdout.log')) },
    stderr: { path: join(supervision, 'stderr.log'), exists: true, size: statSync(join(supervision, 'stderr.log')).size,
      sha256: sha(join(supervision, 'stderr.log')) },
    supervisorSha256: sha(join(supervision, 'supervisor.json')),
    deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
    replayPolicy: 'terminal-window-id-and-label-never-reuse',
  }
  mutate({ parent, inherited, issuerIdentity, output, retained, window, close })
  json(join(parent, 'close.json'), close)
  return { runtime: f.runtime, window: join(parent, 'window.json'), close: join(parent, 'close.json'), output,
    ownedSha256, windowSha256: sha(join(parent, 'window.json')), closeSha256: sha(join(parent, 'close.json')),
    commandSha256: sha(join(output, 'command.json')), windowId, label, forbidSqliteRead: true }
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
    assert.equal(bridge(f.script, 'source', { manifest: sourceManifest(f), root: f.candidate }).value, 9)
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

test('无future的generation roots仍以68为上限', () => {
  for (const [count, accepted] of [[68, true], [69, false]]) {
    const f = copiedSupervisor()
    try {
      const windowId = randomUUID(), manifest = ownedManifest(f, count, windowId)
      assert.equal(bridge(f.script, 'owned', { manifest, runtime: f.runtime, windowId }).ok, accepted)
    } finally { f.cleanup() }
  }
})

test('measure允许70个existing roots且只允许一个future形成71个授权根', () => {
  for (const [count, accepted] of [[70, true], [71, false]]) {
    const f = copiedSupervisor()
    try {
      const windowId = randomUUID(), future = join(f.runtime, 'future-output')
      const manifest = ownedManifest(f, count, windowId, future)
      const observed = bridge(f.script, 'owned', { manifest, runtime: f.runtime, windowId, future })
      assert.equal(observed.ok, accepted)
      if (accepted) assert.equal(observed.value.rootCount, 71)
    } finally { f.cleanup() }
  }
})

test('measure最坏写入计划只计一个顺序clone与256MiB增长余量', () => {
  const f = copiedSupervisor()
  try {
    const snapshotBytes = 1_990_471_680
    assert.deepEqual(bridge(f.script, 'measure-plan', { snapshotBytes }), {
      ok: true,
      value: snapshotBytes + 256 * 1024 ** 2,
    })
    for (const invalid of [-1, 0.5, '1990449152']) {
      assert.equal(bridge(f.script, 'measure-plan', { snapshotBytes: invalid }).ok, false)
    }
  } finally { f.cleanup() }
})

test('terminal authority以不超过授权plan的真实future output替代预算且仍验证root marker与空间', () => {
  {
    const f = copiedSupervisor()
    try {
      const payload = ownedTransition(f)
      assert.equal(payload.futureBytes, payload.plannedBytes)
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
    payload => { payload.futureBytes = payload.plannedBytes + 1 },
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

test('measure aggregate预算逐行闭合且拒绝缺失、篡改、乱序与全树超限', () => {
  {
    const f = copiedSupervisor()
    try {
      const output = join(f.runtime, 'aggregate-valid'); mkdirSync(output); writeAggregateBudget(output)
      const observed = bridge(f.script, 'aggregate-budget', { output })
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value.valid, true)
      assert.equal(observed.value.rowCount, 2)
      assert.equal(observed.value.finalOutputBytes <= observed.value.limitBytes, true)
    } finally { f.cleanup() }
  }
  const mutations = [
    ({ rows }) => { rows[0].extra = true },
    ({ rows }) => { rows[1].sequence = 3 },
    ({ rows }) => { rows[0].recordedAt = '2026-08-30T00:00:00' },
    ({ rows }) => { rows[0].snapshotBytes = 0 },
    ({ rows }) => { rows[1].limitBytes += 1 },
    ({ rows }) => { rows[0].outputBytesBefore = Number.MAX_SAFE_INTEGER + 1 },
    ({ rows }) => { rows[0].outputBytesBefore = rows[0].limitBytes; rows[0].plannedBytes = 1 },
    ({ rows }) => { rows[1].activeClone = 'group-stop' },
    ({ output, rows }) => {
      const file = join(output, 'logical-over-limit.bin'); writeFileSync(file, '')
      truncateSync(file, rows[0].limitBytes + 1)
    },
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor()
    try {
      const output = join(f.runtime, 'aggregate-invalid'); mkdirSync(output)
      const rows = aggregateBudgetRows(); mutate({ output, rows }); writeAggregateBudget(output, rows)
      const observed = bridge(f.script, 'aggregate-budget', { output })
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value.valid, false)
    } finally { f.cleanup() }
  }
  {
    const f = copiedSupervisor()
    try {
      const output = join(f.runtime, 'aggregate-missing'); mkdirSync(output)
      assert.equal(bridge(f.script, 'aggregate-budget', { output }).value.valid, false)
    } finally { f.cleanup() }
  }
  for (const fixture of [completeArtifacts, partialArtifacts]) {
    const f = copiedSupervisor()
    try {
      const artifact = fixture(f.runtime); rmSync(join(artifact.output, 'measure-aggregate-budget.jsonl'))
      const observed = bridge(f.script, 'artifacts', { runtime: f.runtime, label: artifact.label })
      assert.equal(observed.value.aggregateBudgetValid, false)
      assert.equal(observed.value.verifiedComplete, false)
      if (fixture === partialArtifacts) assert.equal(observed.value.partialEvidenceValid, false)
    } finally { f.cleanup() }
  }
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
    assert.equal(observed.value.aggregateBudgetValid, true)
    assert.equal(observed.value.aggregateBudgetRowCount, 2)
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
    assert.equal(observed.value.aggregateBudgetValid, true)
    assert.equal(observed.value.sampleCount, 279)
    assert.equal(observed.value.verifiedComplete, false)
    assert.equal(observed.value.verifiedPassed, false)
  } finally { f.cleanup() }
})

test('window03 issuer失败carryover冻结manifest roots且future保持未创建', () => {
  {
    const f = copiedSupervisor()
    try {
      const payload = issuerFailureCarryover(f)
      const observed = bridge(f.script, 'issuer-failure-carryover', payload)
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value.roots.length, 3)
      assert.equal(observed.value.terminal.state, 'TERMINAL_ISSUER_FAILURE')
      assert.equal(observed.value.terminal.replayAllowed, false)
      const wrongHash = structuredClone(payload); wrongHash.failureSha256 = 'f'.repeat(64)
      assert.equal(bridge(f.script, 'issuer-failure-carryover', wrongHash).ok, false)
    } finally { f.cleanup() }
  }
  for (const mutate of [
    ({ inherited }) => { rmSync(join(inherited, 'owner.json')); json(join(inherited, 'owner.json'), { scope: 'drift' }) },
    ({ future }) => mkdirSync(future),
    ({ parent }) => json(join(parent, 'window.json'), { state: 'unexpectedly-published' }),
  ]) {
    const f = copiedSupervisor()
    try { assert.equal(bridge(f.script, 'issuer-failure-carryover', issuerFailureCarryover(f, mutate)).ok, false) }
    finally { f.cleanup() }
  }
})

test('window04 v2终态partial冻结失败语义并只lstat retained SQLite', () => {
  {
    const f = copiedSupervisor()
    try {
      const payload = v2TerminalCarryover(f)
      const observed = bridge(f.script, 'v2-terminal-carryover', payload)
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value.roots.length, 3)
      assert.equal(observed.value.outputRoot.path, payload.output)
      assert.equal(observed.value.terminal.failure, 'AUTHORITY_DRIFT')
      assert.equal(observed.value.partial.benchmarkFailureCode, 'COPY_UNAVAILABLE')
      assert.equal(observed.value.partial.retainedSqlite.contentSha256Verified, false)
      assert.ok(observed.value.partial.retainedSqlite.size > 0)
      const wrongHash = structuredClone(payload); wrongHash.commandSha256 = 'f'.repeat(64)
      assert.equal(bridge(f.script, 'v2-terminal-carryover', wrongHash).ok, false)
    } finally { f.cleanup() }
  }
  for (const mutate of [
    ({ close }) => { close.authorityTerminal = { authorityStable: true } },
    ({ output }) => writeFileSync(join(output, 'unexpected.bin'), 'x'),
    ({ retained, output }) => {
      rmSync(join(retained, 'sample.sqlite'))
      const target = join(dirname(output), 'sqlite-target'); writeFileSync(target, 'sqlite bytes are never read\n')
      symlinkSync(target, join(retained, 'sample.sqlite'))
    },
    ({ parent, close }) => {
      writeFileSync(join(parent, 'supervision/stdout.log'), 'TAP failed without frozen benchmark code\n')
      close.stdout.size = statSync(join(parent, 'supervision/stdout.log')).size
      close.stdout.sha256 = sha(join(parent, 'supervision/stdout.log'))
    },
  ]) {
    const f = copiedSupervisor()
    try { assert.equal(bridge(f.script, 'v2-terminal-carryover', v2TerminalCarryover(f, mutate)).ok, false) }
    finally { f.cleanup() }
  }
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

test('queued-stop successor只接受冻结exact schema、900秒、S加256MiB与self/candidate identity', () => {
  const f = copiedSupervisor()
  try {
    const window = queuedWindowValue(f)
    assert.equal(bridge(f.script, 'queued-window', { window, now: Date.now() / 1000 }).ok, true)
    for (const [mutation, mutate] of [
      value => { value.scope = 'musicbridge-capacity-phase-window' },
      value => { value.n = 104 },
      value => { value.profile = 'history-limit' },
      value => { value.seed.label = 'other-seed' },
      value => { value.seed.snapshotSha256 = '0'.repeat(64) },
      value => { value.queuedStopPlan.warmupCount = 4 },
      value => { value.queuedStopPlan.formalCount = 99 },
      value => { value.queuedStopPlan.activeCloneMaximum = 2 },
      value => { value.queuedStopPlan.snapshotBytes -= 1; value.queuedStopPlan.plannedBytes -= 1 },
      value => { value.queuedStopPlan.evidenceAllowanceBytes -= 1 },
      value => { value.queuedStopPlan.plannedBytes -= 1 },
      value => { value.queuedStopPlan.aggregateAudit = '../escape.jsonl' },
      value => { value.deadlineAt = new Date(Date.parse(value.issuedAt) + 899_999).toISOString() },
      value => { delete value.measureCarryover.supervision },
      value => { value.measureCarryover.window.id = randomUUID() },
      value => { value.measureCarryover.close.sha256 = '0'.repeat(64) },
      value => { value.candidateRepository.head = 'f'.repeat(40) },
      value => { value.supervisor.sha256 = 'f'.repeat(64) },
      value => { value.extra = true },
    ].entries()) {
      const changed = structuredClone(window); mutate(changed)
      assert.equal(bridge(f.script, 'queued-window', { window: changed, now: Date.now() / 1000 }).ok, false, `mutation ${mutation}`)
    }
  } finally { f.cleanup() }
})

test('queued-stop successor固定构造Node命令且旧双横线透传永久拒绝', () => {
  const f = copiedSupervisor()
  try {
    const window = queuedWindowValue(f), windowSha256 = 'd'.repeat(64)
    const observed = bridge(f.script, 'queued-command', { runtime: f.runtime, authority: f.authority, window, windowSha256 })
    assert.equal(observed.ok, true, observed.error)
    assert.deepEqual(observed.value.command, [window.toolchain.node.path, '--import', window.toolchain.tsxLoader.path,
      join(f.candidate, 'packages/bridge-core/test/benchmarks/recording-capacity-process.ts'),
      '--phase', 'queued-stop', '--profile', 'objects-limit', '--label', window.label,
      '--seed-label', window.seedLabel, '--window', join(f.authority, 'window.json'), '--window-sha256', windowSha256,
      '--owned-roots', join(f.authority, 'owned-roots.json'), '--owned-roots-sha256', window.ownedManifest.sha256,
    ])
    assert.equal(observed.value.cwd, f.candidate)
    assert.equal(observed.value.close, true)
    const legacy = spawnSync(python, [f.script, '--window', join(f.authority, 'window.json'), '--window-sha256', windowSha256, '--', '--phase', 'queued-stop'], { encoding: 'utf8' })
    assert.notEqual(legacy.status, 0)
  } finally { f.cleanup() }
})

test('queued-stop admission实际复核toolchain、issuer fact与candidate HEAD blob身份', () => {
  const f = copiedSupervisor()
  try {
    const window = sealQueuedIdentity(f, queuedWindowValue(f))
    const observed = bridge(f.script, 'queued-bound-identities', { window, parent: f.authority, candidate: f.candidate })
    assert.equal(observed.ok, true, observed.error)
    assert.deepEqual(Object.keys(observed.value).sort(), ['buildHelper','buildNode','buildNodeLibrary','consumerPython',
      'issuer','issuerFact','node','tsxLoader','typescriptCompiler','typescriptLibraries'])
    const changed = structuredClone(window); changed.toolchain.node.sha256 = '0'.repeat(64)
    assert.equal(bridge(f.script, 'queued-bound-identities', { window: changed, parent: f.authority, candidate: f.candidate }).ok, false)
  } finally { f.cleanup() }
})

test('queued-stop admission拒绝build helper、TypeScript标准库与派生输出证明漂移', () => {
  const mutations = [
    ({ fact }) => writeFileSync(fact.buildHelper.path, 'drifted helper\n'),
    ({ fact }) => writeFileSync(join(dirname(fact.buildToolchain.typescriptCompiler.path), 'lib.d.ts'), 'drifted library\n'),
    ({ f }) => {
      const path = join(f.authority, 'source-pins.json')
      rmSync(path); json(path, { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins',
        files: { 'packages/contracts/dist/generated.js': '0'.repeat(64) } })
    },
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor()
    try {
      const window = sealQueuedIdentity(f, queuedWindowValue(f))
      const fact = JSON.parse(readFileSync(window.issuer.fact.path))
      mutate({ f, fact })
      assert.equal(bridge(f.script, 'queued-bound-identities', {
        window, parent: f.authority, candidate: f.candidate,
      }).ok, false)
    } finally { f.cleanup() }
  }
})

test('queued-stop successor完整636文件闭包并拒绝PID、raw hash、receipt、summary、aggregate和unexpected漂移', () => {
  {
    const f = copiedSupervisor()
    try {
      const window = queuedWindowValue(f), output = completeQueuedArtifacts(f, window)
      const observed = bridge(f.script, 'queued-artifacts', { parent: f.authority,
        expected: { window, windowSha256: 'd'.repeat(64) } })
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value.verifiedComplete, true)
      assert.equal(observed.value.verifiedPassed, true)
      assert.equal(observed.value.fileCount, 636)
      assert.equal(observed.value.sampleCount, 105)
      assert.equal(observed.value.uniqueChildPids, 105)
      assert.equal(observed.value.aggregateBudgetValid, true)
      assert.equal(output.startsWith(f.authority), true)
    } finally { f.cleanup() }
  }
  const mutations = [
    ({ output }) => rmSync(join(output, 'sample-105.receipt.json')),
    ({ output }) => { const p = join(output, 'sample-002-raw-receipt.json'), v = JSON.parse(readFileSync(p)); v.childPid = 10001; rmSync(p); json(p, v) },
    ({ output }) => { const p = join(output, 'sample-003-raw-receipt.sha256.json'), v = JSON.parse(readFileSync(p)); v.sha256 = '0'.repeat(64); rmSync(p); json(p, v) },
    ({ output }) => { const p = join(output, 'summary.json'), v = JSON.parse(readFileSync(p)); v.queuedStop.passed = false; rmSync(p); json(p, v) },
    ({ output }) => { const p = join(output, 'exit.json'); rmSync(p); json(p, { exit: 1 }) },
    ({ output }) => { const p = join(output, 'queued-stop-aggregate-budget.jsonl'); writeFileSync(p, JSON.stringify({ schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-aggregate-budget', sequence: 1, checkpoint: 'terminal', group: 'queued-stop', activeClone: null, snapshotBytes: 1, limitBytes: 1, outputBytesBefore: 1, plannedBytes: 1, recordedAt: new Date().toISOString() }) + '\n') },
    ({ output }) => writeFileSync(join(output, 'unexpected.bin'), 'x'),
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor()
    try {
      const window = queuedWindowValue(f); completeQueuedArtifacts(f, window, mutate)
      const observed = bridge(f.script, 'queued-artifacts', { parent: f.authority,
        expected: { window, windowSha256: 'd'.repeat(64) } })
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value.verifiedPassed, false)
    } finally { f.cleanup() }
  }
})
