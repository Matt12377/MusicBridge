import assert from 'node:assert/strict'
import { chmodSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const sourceSupervisor = new URL('../capacity-phase-supervisor-v2.py', import.meta.url).pathname
const sourceBuildHelper = new URL('../issue-v3-capacity-window.py', import.meta.url).pathname
const sourceRecoveryTool = new URL('../create-v3-capacity-measure-root-recovery.py', import.meta.url).pathname
const sourceLineageHelper = new URL('../capacity_process_failure_lineage.py', import.meta.url).pathname
const sourceLineageContract = new URL('../../../packages/contracts/capacity-process-failure-lineage-v1.json', import.meta.url).pathname
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

function replaceJson(path, mutate) {
  const value = JSON.parse(readFileSync(path, 'utf8')); mutate(value)
  rmSync(path); json(path, value)
}

function identity(path) {
  const info = statSync(path)
  return { device: info.dev, inode: info.ino, size: info.size, sha256: sha(path) }
}

function bridge(script, method, payload, environment = {}) {
  const code = `
import importlib.util, json, pathlib, sys, types
spec=importlib.util.spec_from_file_location('capacity_phase_supervisor_v2', sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
method=sys.argv[2]; payload=json.loads(sys.argv[3])
try:
  if method == 'repo-root': value=str(module._runtime_repo_root())
  elif method == 'git-env': value={key:value for key,value in module._git_environment().items() if key.startswith('GIT_')}
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
  elif method == 'queued-replay':
    value=module._reject_queued_stop_replay(
      pathlib.Path(payload['runtime']), pathlib.Path(payload['parent']), payload['window'])
  elif method == 'queued-bound-identities':
    value=module._validate_queued_stop_bound_identities(
      payload['window'], pathlib.Path(payload['parent']), pathlib.Path(payload['candidate']))
  elif method == 'queued-prechild-failures':
    value=module._validate_queued_stop_prechild_failures(
      payload['carryover'], pathlib.Path(payload['runtime']),
      runtime_relocation=payload.get('runtimeRelocation'))
  elif method == 'queued-source':
    value=module._validate_phase_source_manifest(
      pathlib.Path(payload['manifest']), pathlib.Path(payload['root']))
  elif method == 'queued-process-failures':
    if payload.get('acceptRetainedFixture'):
      module._validate_retained_process_failure_output=lambda *args: True
    value=module._validate_queued_stop_process_failures(
      payload['carryover'], pathlib.Path(payload['runtime']))
  elif method == 'queued-process-lineage':
    value=module._validate_queued_stop_process_recovery_lineage(
      pathlib.Path(payload['runtime']),payload['historicalMeasure'],payload['oldInherited'],
      payload['currentRoots'],payload['currentMappings'],payload.get('runtimeRelocation'))
  elif method == 'queued-owned':
    value=module._validate_queued_stop_owned_manifest(
      pathlib.Path(payload['manifest']), pathlib.Path(payload['runtime']), payload['windowId'],
      pathlib.Path(payload['parent']), payload['carryRoots'], payload['plannedBytes'],
      payload.get('expectedDevice'))
  elif method == 'queued-transitive-billing':
    value=module._apply_queued_stop_transitive_billing(
      payload['value'], payload['directRoots'], payload['processRoots'],
      pathlib.Path(payload['parent']), payload.get('terminal',False))
  elif method == 'frozen-owned':
    try:
      value=module._validate_frozen_owned_roots(
        pathlib.Path(payload['manifest']), pathlib.Path(payload['runtime']), payload['manifestSha256'],
        payload['windowId'], pathlib.Path(payload['future']), 'present', 'FROZEN_OWNED',
        root_recovery=payload['measureRootRecovery'])
      value['future']=str(value['future'])
    except TypeError as error:
      raise ValueError(str(error)) from error
  elif method == 'queued-authority-snapshot':
    parent=pathlib.Path(payload['parent']); runtime=pathlib.Path(payload['runtime']); repo=pathlib.Path(payload['repo'])
    fixed={'device':1,'inode':1,'size':1,'mtimeNs':1,'ctimeNs':1,'sha256':'1'*64}
    module._validate_queued_stop_window=lambda *args, **kwargs: (0, 1)
    module._validate_candidate_repository=lambda *args, **kwargs: repo
    module._validate_queued_stop_bound_identities=lambda *args, **kwargs: {
      **{key:fixed for key in ('node','tsxLoader','consumerPython','issuer','issuerFact','buildHelper','buildNode','buildNodeLibrary','typescriptCompiler')},
      'typescriptLibraries':{'sha256':'2'*64,'files':{}},
      'issuerFailureRoots':payload.get('issuerFailureRoots',[]),'issuerFailures':payload['failures'],
      'prechildFailureRoots':payload.get('prechildFailureRoots',[]),'prechildFailures':payload.get('prechildFailures', []),
      'processFailureRoots':payload.get('processFailureRoots',[]),
      'processFailureBillingRoots':payload.get('processFailureBillingRoots',[]),
      'processFailures':payload.get('processFailures', [])}
    module._validate_queued_stop_measure_carryover=lambda *args, **kwargs: {
      'roots':payload.get('measureRoots',[]),
      'rootRecovery': {'liveDeviceRemap': {'currentDevice': runtime.lstat().st_dev},'mappings':[]}}
    module._validate_queued_stop_process_recovery_lineage=lambda *args, **kwargs: {
      'translated':True,'stableRootCount':66,'replacementCount':7}
    module._validate_phase_source_manifest=lambda *args, **kwargs: {'fileCount':241,'manifestIdentity':{'sha256':'3'*64}}
    module._validate_queued_stop_owned_manifest=lambda *args, **kwargs: {
      'rootCount':76,'ownedBytes':1,'plannedBytes':2,'remainingPlannedBytes':0,'availableBytes':3,
      'manifestIdentity':{'sha256':'4'*64}}
    module._apply_queued_stop_transitive_billing=lambda value, *args, **kwargs: value
    value=module._validate_queued_stop_authority(
      parent,runtime,repo,payload['windowSha256'],terminal=payload.get('terminal',False),initial=payload.get('initial'))
  elif method == 'queued-command':
    captured={}
    module._require_loaded_window_identity=lambda *args, **kwargs: True
    if not payload.get('injectReplayAfterAdmission'):
      module._reject_queued_stop_replay=lambda *args, **kwargs: True
      module._validate_queued_stop_authority=lambda *args, **kwargs: {'authorityStable': True}
    else:
      admission_count={'value':0}
      def admission(*args, **kwargs):
        admission_count['value']+=1
        if admission_count['value'] == 1:
          collision=pathlib.Path(payload['runtime'])/'injected-replay-close.json'
          collision.write_text(json.dumps({'scope':'test-close','label':payload['window']['label']}))
        return {'authorityStable': True}
      module._validate_queued_stop_authority=admission
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
  elif method == 'generation-plan':
    value=module._planned_generation_plan(payload['profile'])
  elif method == 'generation-plan-valid':
    value=module._joint_generation_plan_valid(payload['value'])
  elif method == 'generation-plan-valid-float':
    candidate=module._planned_generation_plan('joint'); candidate['finalAxisBytes']=float(candidate['finalAxisBytes'])
    value=module._joint_generation_plan_valid(candidate)
  elif method == 'measure-seed':
    value=module._validate_measure_seed(pathlib.Path(payload['runtime']), payload['window'])
  elif method == 'generation-artifacts':
    expected=dict(payload['expected']); expected['entry']=pathlib.Path(expected['entry']); expected['root']=pathlib.Path(expected['root'])
    expected['authorityProbe']=lambda: {'authorityStable':True,'sourcePinsValid':True,'ownedRootsValid':True,'spaceValid':True}
    value=module._generation_artifacts(pathlib.Path(payload['runtime']), payload['label'], expected)
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
  const result = spawnSync(python, ['-c', code, script, method, JSON.stringify(payload)], {
    encoding: 'utf8', env: { ...process.env, ...environment },
  })
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
  copyFileSync(sourceLineageHelper, join(authority, 'capacity_process_failure_lineage.py'))
  const directContract = join(script, '../../../packages/contracts/capacity-process-failure-lineage-v1.json')
  mkdirSync(dirname(directContract), { recursive: true }); copyFileSync(sourceLineageContract, directContract)
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
    'packages/contracts/src/generated.ts', 'packages/contracts/dist/generated.js',
    'packages/contracts/capacity-process-failure-lineage-v1.json', 'scripts/ci/capacity_process_failure_lineage.py',
    'scripts/ci/capacity-phase-supervisor-v2.py', 'scripts/ci/issue-v3-capacity-measure-window.py',
  ]
  for (const relative of candidateFiles) {
    const path = join(candidate, relative); mkdirSync(dirname(path), { recursive: true })
    if (relative === 'scripts/ci/capacity-phase-supervisor-v2.py') copyFileSync(sourceSupervisor, path)
    else if (relative === 'scripts/ci/capacity_process_failure_lineage.py') copyFileSync(sourceLineageHelper, path)
    else if (relative === 'packages/contracts/capacity-process-failure-lineage-v1.json') copyFileSync(sourceLineageContract, path)
    else writeFileSync(path, `${relative}\n`)
  }
  copyFileSync(sourceBuildHelper, join(candidate, 'scripts/ci/issue-v3-capacity-window.py'))
  copyFileSync(sourceRecoveryTool, join(candidate, 'scripts/ci/create-v3-capacity-measure-root-recovery.py'))
  writeFileSync(join(candidate, 'scripts/ci/terminalize-v3-capacity-queued-stop-prechild.py'),
    'queued prechild terminalizer\n')
  writeFileSync(join(candidate, 'packages/contracts/tsconfig.json'), '{}\n')
  writeFileSync(join(candidate, 'scripts/ci/issue-v3-capacity-queued-stop-window.py'), 'queued issuer\n')
  writeFileSync(join(candidate, 'tsx-loader.mjs'), 'export {}\n')
  writeFileSync(join(candidate, 'packages/contracts/dist/generated.js'), 'export const generated = true\n')
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
  const candidateRemote = join(temp, 'candidate-remote.git')
  for (const [cwd, args] of [[temp, ['init', '--bare', candidateRemote]],
    [candidate, ['remote', 'add', 'origin', candidateRemote]],
    [candidate, ['push', '-u', 'origin', 'codex/task-079-v3-final-acceptance']]]) {
    const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr)
  }
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
    issuerFailureCarryoverCount: 1,
    prechildFailureCarryoverCount: 1,
    processFailureCarryoverCount: 1,
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
      measureRootRecovery: { path: join(f.runtime, 'measure-root-recovery-v1/recovery.json'), sha256: '6'.repeat(64) },
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
  const lineageHelperRelative = 'scripts/ci/capacity_process_failure_lineage.py'
  const lineageContractRelative = 'packages/contracts/capacity-process-failure-lineage-v1.json'
  json(join(f.authority, 'source-pins.json'), { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins',
    files: { [distRelative]: sha(join(f.candidate, distRelative)),
      [lineageHelperRelative]: sha(join(f.candidate, lineageHelperRelative)),
      [lineageContractRelative]: sha(join(f.candidate, lineageContractRelative)) } })
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
  const priorRoot = join(f.runtime, 'objects-queued-prior-window')
  const priorWindowId = randomUUID()
  mkdirSync(join(priorRoot, 'issuer-identity'), { recursive: true })
  json(join(priorRoot, 'owner.json'), { scope: 'musicbridge-capacity-queued-stop-window', owner: 'root', id: priorWindowId })
  writeFileSync(join(priorRoot, 'supervisor.py'), 'prior supervisor\n')
  json(join(priorRoot, 'issuer-identity/owner.json'), {
    schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-authority-issuer', windowId: priorWindowId })
  json(join(priorRoot, 'source-pins.json'), {
    schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: {} })
  json(join(priorRoot, 'owned-roots.json'), {
    schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only',
    windowId: priorWindowId, roots: [] })
  json(join(priorRoot, 'issuer-failure.json'), {
    schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-authority-issuer-failure',
    state: 'TERMINAL_ISSUER_FAILURE', windowId: priorWindowId,
    windowDirName: 'objects-queued-prior-window', label: 'objects-queued-prior-run', errorCode: 'SOURCE_CANDIDATE',
    authorityFilesCreated: ['owner.json', 'supervisor.py', 'issuer-identity/owner.json',
      'source-pins.json', 'owned-roots.json'],
    windowWritten: false, replayAllowed: false, recordedAt: '2026-08-30T03:58:58.329+00:00',
  })
  const issuerFailureCarryover = [{
    root: priorRoot, windowId: priorWindowId, windowDirName: 'objects-queued-prior-window',
    label: 'objects-queued-prior-run', errorCode: 'SOURCE_CANDIDATE',
    files: {
      owner: { path: join(priorRoot, 'owner.json'), sha256: sha(join(priorRoot, 'owner.json')) },
      supervisor: { path: join(priorRoot, 'supervisor.py'), sha256: sha(join(priorRoot, 'supervisor.py')) },
      issuerFact: { path: join(priorRoot, 'issuer-identity/owner.json'), sha256: sha(join(priorRoot, 'issuer-identity/owner.json')) },
      failure: { path: join(priorRoot, 'issuer-failure.json'), sha256: sha(join(priorRoot, 'issuer-failure.json')) },
      sourceManifest: { path: join(priorRoot, 'source-pins.json'), sha256: sha(join(priorRoot, 'source-pins.json')) },
      ownedManifest: { path: join(priorRoot, 'owned-roots.json'), sha256: sha(join(priorRoot, 'owned-roots.json')) },
    },
  }]
  const prechildRoot = join(f.runtime, 'objects-queued-prechild-window')
  const prechildWindowId = randomUUID(), prechildLabel = 'objects-queued-prechild-run'
  mkdirSync(join(prechildRoot, 'issuer-identity'), { recursive: true })
  const prechildOwner = join(prechildRoot, 'owner.json')
  const prechildSupervisor = join(prechildRoot, 'supervisor.py')
  const prechildFact = join(prechildRoot, 'issuer-identity/owner.json')
  const prechildSource = join(prechildRoot, 'source-pins.json')
  const prechildOwned = join(prechildRoot, 'owned-roots.json')
  const prechildWindow = join(prechildRoot, 'window.json')
  json(prechildOwner, { scope: 'musicbridge-capacity-queued-stop-window', owner: 'root', id: prechildWindowId })
  writeFileSync(prechildSupervisor, 'prechild installed supervisor\n')
  json(prechildFact, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-authority-issuer',
    windowId: prechildWindowId, candidateRepository: window.candidateRepository })
  json(prechildSource, { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: {} })
  json(prechildOwned, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only',
    windowId: prechildWindowId, roots: [] })
  json(prechildWindow, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-window', owner: 'root',
    id: prechildWindowId, state: 'approved', phase: 'queued-stop', profile: 'objects-limit', label: prechildLabel,
    candidateRepository: window.candidateRepository,
    supervisor: { path: prechildSupervisor, sha256: sha(prechildSupervisor) },
    sourceManifest: { file: 'source-pins.json', sha256: sha(prechildSource) },
    ownedManifest: { file: 'owned-roots.json', sha256: sha(prechildOwned) } })
  const prechildTrigger = join(f.runtime, 'objects-generation-prechild-close.json')
  json(prechildTrigger, { schemaVersion: 1, scope: 'musicbridge-capacity-generation-close',
    window: { id: randomUUID(), label: 'objects-generation-prechild' } })
  const terminalizerPath = join(f.candidate, 'scripts/ci/terminalize-v3-capacity-queued-stop-prechild.py')
  const prechildFailure = join(prechildRoot, 'prechild-failure.json')
  const triggerValue = JSON.parse(readFileSync(prechildTrigger))
  json(prechildFailure, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-prechild-failure',
    state: 'TERMINAL_PRECHILD_CONTROL_FAILURE', windowId: prechildWindowId,
    windowDirName: 'objects-queued-prechild-window', label: prechildLabel,
    failure: 'QUEUED_STOP_REPLAY_AUDIT_TYPE_ERROR', observedExitCode: 1,
    windowSha256: sha(prechildWindow),
    authorityFiles: { ownerSha256: sha(prechildOwner), supervisorSha256: sha(prechildSupervisor),
      issuerFactSha256: sha(prechildFact), sourceManifestSha256: sha(prechildSource),
      ownedManifestSha256: sha(prechildOwned) },
    trigger: { path: prechildTrigger, sha256: sha(prechildTrigger), scope: triggerValue.scope,
      windowId: triggerValue.window.id, label: triggerValue.window.label, fieldType: 'dict',
      role: 'isolated-reproduction-witness-not-historical-order' },
    reproduction: { type: 'TypeError', messageCode: 'UNHASHABLE_DICT',
      fullRuntimeReproduced: true, isolatedWitnessReproduced: true }, authorityAdmission: 'NOT_RUN',
    supervisionStarted: false, benchmarkStarted: false, childSpawned: false, outputCreated: false,
    sampleCount: 0, windowConsumed: true, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
    replayAllowed: false, replayPolicy: 'terminal-window-id-and-label-never-reuse',
    recovery: { repositoryRoot: f.candidate, branch: f.candidateBranch, head: f.head,
      scriptPath: terminalizerPath, scriptRelativePath: 'scripts/ci/terminalize-v3-capacity-queued-stop-prechild.py',
      scriptSha256: sha(terminalizerPath) }, recordedAt: '2026-08-30T08:00:00.000+00:00' })
  const prechildFailureCarryover = [{ root: prechildRoot, windowId: prechildWindowId,
    windowDirName: 'objects-queued-prechild-window', label: prechildLabel,
    errorCode: 'QUEUED_STOP_REPLAY_AUDIT_TYPE_ERROR', files: {
      owner: { path: prechildOwner, sha256: sha(prechildOwner) },
      supervisor: { path: prechildSupervisor, sha256: sha(prechildSupervisor) },
      issuerFact: { path: prechildFact, sha256: sha(prechildFact) },
      sourceManifest: { path: prechildSource, sha256: sha(prechildSource) },
      ownedManifest: { path: prechildOwned, sha256: sha(prechildOwned) },
      window: { path: prechildWindow, sha256: sha(prechildWindow) },
      failure: { path: prechildFailure, sha256: sha(prechildFailure) },
    } }]
  const { fixture: ignoredProcessFixture, ...processFailure } = queuedProcessFailure(f)
  void ignoredProcessFixture
  const processFailureCarryover = [processFailure]
  const factPath = join(f.authority, 'issuer-identity/owner.json')
  json(factPath, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-authority-issuer', windowId: window.id,
    issuerRepository: { root: f.candidate, branch: f.candidateBranch, head: f.head,
      relativePath: 'scripts/ci/issue-v3-capacity-queued-stop-window.py', sha256: window.issuer.sha256 },
    candidateRepository: window.candidateRepository,
    supervisorSource: { path: supervisorPath, relativePath: 'scripts/ci/capacity-phase-supervisor-v2.py', sha256: window.supervisor.sha256 },
    toolchain: window.toolchain,
    buildHelper: { path: buildHelperPath, relativePath: 'scripts/ci/issue-v3-capacity-window.py', sha256: sha(buildHelperPath) },
    buildToolchain, build, issuerFailureCarryover, prechildFailureCarryover, processFailureCarryover,
    measureCarryover: window.measureCarryover })
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

function jointMeasureSeed(f, mutate = () => {}) {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-version-')))
  const marker = { id: randomUUID(), scope: 'musicbridge-capacity-synthetic-only' }
  json(join(fixture, 'capacity-owner.json'), marker)
  const seedLabel = 'joint-seed', seedDirectory = join(f.runtime, seedLabel)
  mkdirSync(seedDirectory); writeFileSync(join(seedDirectory, 'seed.sqlite'), 'joint seed\n')
  const snapshotSha256 = sha(join(seedDirectory, 'seed.sqlite'))
  const generationPlan = {
    model: 'serial-single-output-plus-bounded-growth-v1', activeOutputMaximum: 1,
    finalAxisBytes: 1_275_068_416, activeOutputBytes: 1_275_068_416,
    activeRecordWorkspaceBytes: 16 * 1024 ** 2, evidenceAllowanceBytes: 128 * 1024 ** 2,
    plannedBytes: 2_701_131_776,
  }
  const axisTargets = { attemptEvents: 50_000, attemptBytes: 64 * 1024 ** 2,
    recordBytes: 64 * 1024 ** 2, printBytes: 64 * 1024 ** 2,
    photoBytes: 512 * 1024 ** 2, printObjectBytes: 512 * 1024 ** 2 }
  const axes = { targets: axisTargets, actual: { ...axisTargets },
    reached: Object.fromEntries(Object.keys(axisTargets).map(key => [key, true])) }
  const planPreparation = { strategy: 'serial-create-consume-one-active', prepared: 2,
    beforeFirstAttempt: true, preparedBeforeFirstAttempt: 1, activePlanMaximum: 1, unconsumedAtSeal: 1 }
  const metadata = { schema: 21, profile: 'joint', integrity: 'passed', growth: { state: 'target-reached' },
    nextPlanId: randomUUID(), nextPlanHash: 'a'.repeat(64), snapshotSha256, budget: { records: 1 },
    fixtureDirectory: fixture, marker, generationPlan, axes, planPreparation }
  mutate(metadata)
  json(join(seedDirectory, 'seed.json'), metadata)
  const window = { profile: 'joint', seedLabel,
    seed: { metadataSha256: sha(join(seedDirectory, 'seed.json')), snapshotSha256,
      fixtureOwnerSha256: sha(join(fixture, 'capacity-owner.json')) } }
  return { window, fixture }
}

function jointGenerationArtifacts(f, mutateSeed = () => {}, mutateSpace = () => {}) {
  const label = 'joint-generation', output = join(f.runtime, label); mkdirSync(output)
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-version-')))
  const marker = { id: randomUUID(), scope: 'musicbridge-capacity-synthetic-only' }
  json(join(fixture, 'capacity-owner.json'), marker)
  const entry = join(f.candidate, 'packages/bridge-core/test/benchmarks/recording-capacity.ts')
  const window = randomUUID(), generationPlan = {
    model: 'serial-single-output-plus-bounded-growth-v1', activeOutputMaximum: 1,
    finalAxisBytes: 1_275_068_416, activeOutputBytes: 1_275_068_416,
    activeRecordWorkspaceBytes: 16 * 1024 ** 2, evidenceAllowanceBytes: 128 * 1024 ** 2,
    plannedBytes: 2_701_131_776,
  }
  const axisTargets = { attemptEvents: 50_000, attemptBytes: 64 * 1024 ** 2,
    recordBytes: 64 * 1024 ** 2, printBytes: 64 * 1024 ** 2,
    photoBytes: 512 * 1024 ** 2, printObjectBytes: 512 * 1024 ** 2 }
  const axes = { targets: axisTargets, actual: { ...axisTargets },
    reached: Object.fromEntries(Object.keys(axisTargets).map(key => [key, true])) }
  const planPreparation = { strategy: 'serial-create-consume-one-active', prepared: 2,
    beforeFirstAttempt: true, preparedBeforeFirstAttempt: 1, activePlanMaximum: 1, unconsumedAtSeal: 1 }
  writeFileSync(join(output, 'seed.sqlite'), 'joint seed\n')
  const seed = { schema: 21, profile: 'joint', integrity: 'passed', growth: { state: 'target-reached' },
    nextPlanId: randomUUID(), nextPlanHash: 'a'.repeat(64), budget: { records: 1 }, fixtureDirectory: fixture, marker,
    snapshotSha256: sha(join(output, 'seed.sqlite')), generationPlan, axes, planPreparation }
  mutateSeed(seed)
  json(join(output, 'seed.json'), seed)
  const source = { frozen: true }
  json(join(output, 'source-before.json'), source); json(join(output, 'source-after.json'), source)
  json(join(output, 'command.json'), { executable: process.execPath,
    args: [entry, '--phase', 'generate', '--profile', 'joint', '--label', label, '--window', window],
    cwd: f.candidate, node: 'v22.23.2', phase: 'generate', profile: 'joint', window })
  json(join(output, 'checkpoint-1.json'), { fixtureDirectory: fixture })
  const fixtureBytes = statSync(join(fixture, 'capacity-owner.json')).size
  const preSnapshotOutputBytes = ['source-before.json', 'command.json', 'checkpoint-1.json']
    .reduce((total, name) => total + statSync(join(output, name)).size, 0)
  const plannedBytes = fixtureBytes + generationPlan.evidenceAllowanceBytes
  const space = { availableBytes: plannedBytes + 10 * 1024 ** 3 + 1, plannedBytes,
    ownedBytes: fixtureBytes + preSnapshotOutputBytes }
  mutateSpace(space); json(join(output, 'space-before-snapshot.json'), space)
  json(join(output, 'exit.json'), { exit: 0 })
  return { label, fixture, expected: { profile: 'joint', label, entry, root: f.candidate, node: process.execPath, window } }
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

function queuedProcessFailure(f, mutate = () => {}, suffix = '') {
  const windowId = randomUUID(), windowDirName = `objects-queued-process-window${suffix}`,
    label = `objects-queued-process-run${suffix}`, parent = join(f.runtime, windowDirName)
  const issuerIdentity = join(parent, 'issuer-identity'), supervisionDirectory = join(parent, 'supervision')
  mkdirSync(issuerIdentity, { recursive: true }); mkdirSync(supervisionDirectory)
  const owner = join(parent, 'owner.json'), supervisor = join(parent, 'supervisor.py')
  const issuerFact = join(issuerIdentity, 'owner.json'), source = join(parent, 'source-pins.json')
  const owned = join(parent, 'owned-roots.json'), windowPath = join(parent, 'window.json')
  const closePath = join(parent, 'close.json'), supervision = join(supervisionDirectory, 'supervisor.json')
  const supervisorStart = join(supervisionDirectory, 'supervisor-start.json')
  const stdout = join(supervisionDirectory, 'stdout.log'), stderr = join(supervisionDirectory, 'stderr.log')
  json(owner, { scope: 'musicbridge-capacity-queued-stop-window', owner: 'root', id: windowId })
  copyFileSync(sourceSupervisor, supervisor, constants.COPYFILE_EXCL)
  const sourceFiles = Object.fromEntries(Array.from({ length: 241 }, (_, index) =>
    [`synthetic/source-${String(index).padStart(3, '0')}.ts`, String((index % 9) + 1).repeat(64)]))
  json(source, { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: sourceFiles })
  const template = queuedWindowValue(f), candidateRepository = template.candidateRepository
  json(issuerFact, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-authority-issuer', windowId,
    issuerRepository: { root: f.candidate, branch: f.candidateBranch, head: f.head,
      relativePath: 'scripts/ci/issue-v3-capacity-queued-stop-window.py',
      sha256: sha(join(f.candidate, 'scripts/ci/issue-v3-capacity-queued-stop-window.py')) },
    candidateRepository,
    supervisorSource: { path: join(f.candidate, 'scripts/ci/capacity-phase-supervisor-v2.py'),
      relativePath: 'scripts/ci/capacity-phase-supervisor-v2.py', sha256: sha(supervisor) },
    toolchain: template.toolchain,
    buildHelper: { path: join(f.candidate, 'scripts/ci/issue-v3-capacity-window.py'),
      relativePath: 'scripts/ci/issue-v3-capacity-window.py',
      sha256: sha(join(f.candidate, 'scripts/ci/issue-v3-capacity-window.py')) },
    buildToolchain: { node: { path: process.execPath, sha256: sha(process.execPath) },
      nodeLibrary: { path: join(f.candidate, 'tsx-loader.mjs'), sha256: sha(join(f.candidate, 'tsx-loader.mjs')) },
      typescriptCompiler: { path: join(f.candidate, 'tsx-loader.mjs'), sha256: sha(join(f.candidate, 'tsx-loader.mjs')) },
      typescriptLibraryManifestSha256: 'a'.repeat(64) },
    build: { candidateHead: f.head, inputs: {}, command: [], environment: {}, timeoutMs: 1,
      compilerExitCode: 0, compilerOutputBytes: 0, privateToolchain: {}, outputs: {} },
    issuerFailureCarryover: [{}], prechildFailureCarryover: [{}], measureCarryover: template.measureCarryover })
  const historicalRoots = []
  for (let index = 0; index < 73; index += 1) {
    const root = join(f.runtime, `process-history${suffix}-${String(index).padStart(2, '0')}`)
    mkdirSync(root); json(join(root, 'owner.json'), { scope: 'process-history', index })
    historicalRoots.push(rootRow(root))
  }
  const roots = [...historicalRoots, rootRow(parent), rootRow(issuerIdentity)]
  json(owned, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only',
    windowId, roots })
  const window = { ...template, id: windowId, label,
    issuedAt: '2026-08-30T10:51:28.210+00:00', deadlineAt: '2026-08-30T11:06:28.210+00:00',
    issuerFailureCarryoverCount: 1, prechildFailureCarryoverCount: 1,
    supervisor: { path: supervisor, sha256: sha(supervisor) },
    ownedManifest: { file: 'owned-roots.json', sha256: sha(owned) },
    sourceManifest: { file: 'source-pins.json', sha256: sha(source) },
    issuer: { path: join(f.candidate, 'scripts/ci/issue-v3-capacity-queued-stop-window.py'),
      sha256: sha(join(f.candidate, 'scripts/ci/issue-v3-capacity-queued-stop-window.py')),
      fact: { path: issuerFact, sha256: sha(issuerFact) } } }
  delete window.processFailureCarryoverCount
  json(windowPath, window)
  writeFileSync(stdout, '')
  writeFileSync(stderr, 'CAPACITY_PHASE_OPERATION_FAILED\n' +
    '(node:313) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n' +
    '(Use `node --trace-warnings ...` to show where the warning was created)\n')
  const stdoutFact = { path: stdout, exists: true, size: 0, sha256: sha(stdout) }
  const stderrFact = { path: stderr, exists: true, size: statSync(stderr).size, sha256: sha(stderr) }
  const queuedStop = { outputDirectory: join(parent, label), verifiedComplete: false, verifiedPassed: false,
    fileCount: 0, sampleCount: 0, uniqueChildPids: 0, aggregateBudgetValid: false, unexpectedEntries: [] }
  const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C',
    TZ: 'UTC', CI: '1', TMPDIR: realpathSync(tmpdir()) }
  json(supervisorStart, { pid: 313, pgid: 313,
    command: [window.toolchain.node.path, '--import', window.toolchain.tsxLoader.path,
      join(f.candidate, 'packages/bridge-core/test/benchmarks/recording-capacity-process.ts'),
      '--phase', 'queued-stop', '--profile', 'objects-limit', '--label', label,
      '--seed-label', window.seedLabel, '--window', windowPath, '--window-sha256', sha(windowPath),
      '--owned-roots', owned, '--owned-roots-sha256', sha(owned)],
    managedProcessGroup: true, startedMonotonic: 1, deadlineMonotonic: 2, cwd: f.candidate,
    environmentKeys: ['CI', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'], environment,
    stdin: 'DEVNULL', stdout, stderr })
  json(supervision, { passed: false, failure: 'PROCESS_EXIT', pid: 313, pgid: 313, code: 1,
    exitSignal: null, signals: [], groupEmpty: true, zombies: [], elapsedMs: 650.4,
    managedProcessGroup: true, stdout: stdoutFact, stderr: stderrFact, queuedStop })
  const authority = { authorityStable: true, windowStable: true, ownerStable: true,
    sourceManifestStable: true, ownedManifestStable: true, sourcePinsValid: true, ownedRootsValid: true,
    measureCarryoverValid: true, issuerFailureCarryoverValid: true, prechildFailureCarryoverValid: true,
    spaceValid: true, windowSha256Observed: sha(windowPath), ownerSha256Observed: sha(owner),
    sourceFileCount: 241, ownedRootCount: 75, issuerFailureCount: 1, prechildFailureCount: 1,
    ownedBytes: 1, plannedBytes: window.queuedStopPlan.plannedBytes, remainingPlannedBytes: 0,
    availableBytes: 20_000_000_000, candidateRepository, toolchainStable: true, issuerStable: true }
  json(closePath, { schemaVersion: 1, scope: 'musicbridge-capacity-queued-stop-window-close', windowId,
    profile: 'objects-limit', label, seedLabel: window.seedLabel,
    closedAt: '2026-08-30T10:51:58.666686+00:00', state: 'failed', failure: 'PROCESS_EXIT',
    pid: 313, pgid: 313, managedProcessGroup: true, code: 1, exitSignal: null, signals: [],
    groupEmpty: true, zombies: [], elapsedMs: 650.4, windowSha256: sha(windowPath),
    sourceManifestSha256: sha(source), ownedManifestSha256: sha(owned), seed: window.seed,
    measureCarryover: window.measureCarryover,
    authorityAdmission: { ...authority, remainingPlannedBytes: window.queuedStopPlan.plannedBytes },
    authorityTerminal: authority, queuedStop, supervisorSha256: sha(supervision), stdout: stdoutFact,
    stderr: stderrFact, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
    replayPolicy: 'terminal-window-id-and-label-never-reuse' })
  mutate({ parent, issuerIdentity, supervisionDirectory, owner, supervisor, issuerFact, source, owned,
    windowPath, closePath, supervision, supervisorStart, stdout, stderr, window, historicalRoots })
  const files = Object.fromEntries(Object.entries({ owner, supervisor, issuerFact, sourceManifest: source,
    ownedManifest: owned, window: windowPath, close: closePath, supervision, supervisorStart, stdout, stderr })
    .map(([role, path]) => [role, { path, sha256: sha(path) }]))
  return { root: parent, windowId, windowDirName, label, failure: 'PROCESS_EXIT', code: 1,
    sampleCount: 0, deviceOpened: false, formalReady: false, gateB: 'NOT_RUN', files,
    fixture: { parent, issuerIdentity, supervisionDirectory, owner, supervisor, issuerFact, source, owned,
      windowPath, closePath, supervision, supervisorStart, stdout, stderr, historicalRoots } }
}

function refreshQueuedProcessRow(row) {
  const x=row.fixture
  replaceJson(x.owned,value=>{value.roots[value.roots.length-1]=rootRow(x.issuerIdentity)})
  replaceJson(x.windowPath,value=>{value.issuer.fact.sha256=sha(x.issuerFact);value.ownedManifest.sha256=sha(x.owned)})
  replaceJson(x.supervisorStart,value=>{value.command[value.command.indexOf('--window-sha256')+1]=sha(x.windowPath);value.command[value.command.indexOf('--owned-roots-sha256')+1]=sha(x.owned)})
  replaceJson(x.supervision,value=>{value.stdout={path:x.stdout,exists:true,size:statSync(x.stdout).size,sha256:sha(x.stdout)};value.stderr={path:x.stderr,exists:true,size:statSync(x.stderr).size,sha256:sha(x.stderr)}})
  replaceJson(x.closePath,value=>{value.windowSha256=sha(x.windowPath);value.ownedManifestSha256=sha(x.owned);value.supervisorSha256=sha(x.supervision);value.stdout=JSON.parse(readFileSync(x.supervision)).stdout;value.stderr=JSON.parse(readFileSync(x.supervision)).stderr;value.authorityAdmission.windowSha256Observed=sha(x.windowPath);value.authorityTerminal.windowSha256Observed=sha(x.windowPath)})
  row.files=Object.fromEntries(Object.entries({owner:x.owner,supervisor:x.supervisor,issuerFact:x.issuerFact,
    sourceManifest:x.source,ownedManifest:x.owned,window:x.windowPath,close:x.closePath,supervision:x.supervision,
    supervisorStart:x.supervisorStart,stdout:x.stdout,stderr:x.stderr}).map(([role,path])=>[role,{path,sha256:sha(path)}]))
  return row
}

function linkedQueuedProcessFailure(f) {
  const leaf=queuedProcessFailure(f,()=>{},'-03'),head=queuedProcessFailure(f,()=>{},'-05')
  const predecessor=structuredClone(leaf);delete predecessor.fixture
  replaceJson(head.fixture.issuerFact,value=>{value.processFailureCarryover=[predecessor]})
  replaceJson(head.fixture.owned,value=>{value.roots.splice(0,73,...structuredClone(leaf.fixture.historicalRoots));value.roots.splice(73,0,rootRow(leaf.root));value.roots[value.roots.length-1]=rootRow(head.fixture.issuerIdentity)})
  replaceJson(head.fixture.windowPath,value=>{value.processFailureCarryoverCount=1;value.issuedAt='2026-08-30T10:52:28.210+00:00';value.deadlineAt='2026-08-30T11:07:28.210+00:00'})
  replaceJson(head.fixture.closePath,value=>{value.closedAt='2026-08-30T10:52:58.666686+00:00';for(const authority of [value.authorityAdmission,value.authorityTerminal]){authority.processFailureCarryoverValid=true;authority.processFailureCount=1;authority.ownedRootCount=76}})
  head.fixture.historicalRoots=leaf.fixture.historicalRoots
  refreshQueuedProcessRow(head)
  return {leaf,head}
}

function successorQueuedProcessFailure(f, predecessor, suffix = '-06') {
  const successor = queuedProcessFailure(f, () => {}, suffix)
  const predecessorRow = structuredClone(predecessor); delete predecessorRow.fixture
  replaceJson(successor.fixture.issuerFact, value => { value.processFailureCarryover = [predecessorRow] })
  replaceJson(successor.fixture.owned, value => {
    value.roots.splice(0, 73, ...structuredClone(predecessor.fixture.historicalRoots))
    value.roots.splice(73, 0, rootRow(predecessor.root))
    value.roots[value.roots.length - 1] = rootRow(successor.fixture.issuerIdentity)
  })
  replaceJson(successor.fixture.windowPath, value => {
    value.processFailureCarryoverCount = 1
    value.issuedAt = '2026-08-30T10:53:28.210+00:00'
    value.deadlineAt = '2026-08-30T11:08:28.210+00:00'
  })
  replaceJson(successor.fixture.closePath, value => {
    value.closedAt = '2026-08-30T10:53:58.666686+00:00'
    for (const authority of [value.authorityAdmission, value.authorityTerminal]) {
      authority.processFailureCarryoverValid = true
      authority.processFailureCount = 2
      authority.ownedRootCount = 76
    }
  })
  successor.fixture.historicalRoots = predecessor.fixture.historicalRoots
  refreshQueuedProcessRow(successor)
  return successor
}

function disappearedFrozenOwnedFixture(remapped = true) {
  const f = copiedSupervisor()
  const windowId = randomUUID(), historical = join(f.runtime, 'historical-measure-window')
  const future = join(f.runtime, 'historical-measure-output'), seed = join(f.runtime, 'historical-durable-seed')
  mkdirSync(historical); mkdirSync(future)
  json(join(future, 'command.json'), { phase: 'measure', windowId })
  mkdirSync(seed); writeFileSync(join(seed, 'seed.sqlite'), 'durable benchmark seed\n')
  const present = []
  for (let index = 0; index < 62; index += 1) {
    const root = join(f.runtime, `historical-present-${String(index).padStart(2, '0')}`); mkdirSync(root)
    json(join(root, 'owner.json'), { scope: 'historical-present', index }); present.push(rootRow(root))
  }
  const disappeared = []
  for (let index = 0; index < 7; index += 1) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-version-')))
    json(join(root, 'capacity-owner.json'), { scope: 'musicbridge-capacity-synthetic-only', index })
    disappeared.push(rootRow(root, 'capacity-owner.json'))
  }
  json(join(seed, 'seed.json'), { schema: 21, profile: 'objects-limit', fixtureDirectory: disappeared[0].path,
    snapshotSha256: sha(join(seed, 'seed.sqlite')) })
  present.unshift(rootRow(seed, 'seed.json'))
  const currentDevice = statSync(f.runtime).dev, historicalDevice = currentDevice + (remapped ? 1 : 0)
  for (const row of [...present, ...disappeared]) row.device = historicalDevice
  const manifest = join(historical, 'owned-roots.json')
  json(manifest, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only',
    windowId, roots: [...present, ...disappeared], futureRoots: [future] })
  const window = join(historical, 'window.json'), close = join(historical, 'close.json')
  json(window, { scope: 'musicbridge-capacity-measure-window', id: windowId, state: 'approved' })
  json(close, { scope: 'musicbridge-capacity-measure-window-close', windowId, state: 'passed',
    windowSha256: sha(window), ownedManifestSha256: sha(manifest) })
  const frozenHashes = { window: sha(window), close: sha(close), manifest: sha(manifest) }
  const recoveryRoot = join(f.runtime, 'measure-root-recovery-v1'); mkdirSync(recoveryRoot); chmodSync(recoveryRoot, 0o700)
  const replacements = disappeared.map((historicalRoot, index) => {
    const root = join(recoveryRoot, `replacement-${String(index + 1).padStart(3, '0')}`); mkdirSync(root)
    json(join(root, 'owner.json'), { schemaVersion: 1, scope: 'musicbridge-capacity-historical-control-only',
      id: randomUUID(), role: 'historical-control-only', recovered: false, historicalRoot })
    chmodSync(root, 0o700); chmodSync(join(root, 'owner.json'), 0o400)
    return { ...rootRow(root), role: 'historical-control-only' }
  })
  const recovery = join(recoveryRoot, 'recovery.json'), recoveryTool = join(f.candidate,
    'scripts/ci/create-v3-capacity-measure-root-recovery.py')
  json(recovery, { schemaVersion: 1, scope: 'musicbridge-capacity-measure-root-recovery', access: 'read-only',
    state: 'PUBLISHED', model: 'exact75-v2-replacement-closure',
    windowId, historicalManifest: { path: manifest, sha256: frozenHashes.manifest },
    liveDeviceRemap: { mode: remapped ? 'REMAPPED' : 'UNCHANGED', historicalDevice, currentDevice, liveRootCount: 63 },
    repository: { root: f.candidate, branch: f.candidateBranch, head: f.head, clean: true, pushedHead: true },
    recoveryTool: { path: recoveryTool, relativePath: 'scripts/ci/create-v3-capacity-measure-root-recovery.py',
      workingSha256: sha(recoveryTool), gitBlobSha256: sha(recoveryTool) },
    mappings: disappeared.map((historicalRoot, index) => ({ historicalRoot, state: 'LOST',
      recovered: false, replacementRoot: replacements[index] })),
    contentRecovered: false, historicalManifestRewritten: false,
    activeBenchmarkInput: { model: 'durable-seed-snapshot', path: join(seed, 'seed.sqlite'), sha256: sha(join(seed, 'seed.sqlite')) },
    deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' })
  chmodSync(recovery, 0o400)
  for (const row of disappeared) rmSync(row.path, { recursive: true })
  return { ...f, windowId, historical, future, seed, present, disappeared, replacements, manifest, window,
    close, recovery, measureRootRecovery: { path: recovery, sha256: sha(recovery) }, frozenHashes }
}

function rewriteRootRecovery(f, mutate) {
  const receipt = JSON.parse(readFileSync(f.recovery, 'utf8')); mutate(receipt, f)
  rmSync(f.recovery); json(f.recovery, receipt)
  return { path: f.recovery, sha256: sha(f.recovery) }
}

function relocatedFrozenOwnedFixture() {
  const f = disappearedFrozenOwnedFixture()
  const historicalRuntime = f.runtime, currentRuntime = `${f.runtime}-relocated`
  renameSync(historicalRuntime, currentRuntime)
  const mapped = value => join(currentRuntime, value.slice(historicalRuntime.length + 1))
  f.runtime = currentRuntime; f.script = mapped(f.script); f.authority = mapped(f.authority)
  f.historical = mapped(f.historical); f.future = mapped(f.future); f.seed = mapped(f.seed)
  f.manifest = mapped(f.manifest); f.window = mapped(f.window); f.close = mapped(f.close)
  f.recovery = mapped(f.recovery)
  f.present = f.present.map((row, index) => ({ ...row, inode: row.inode + 100000 + index }))
  const historicalRows = [...f.present, ...f.disappeared]
  rmSync(f.manifest); json(f.manifest, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only',
    windowId: f.windowId, roots: historicalRows, futureRoots: [join(historicalRuntime, 'historical-measure-output')] })
  f.frozenHashes.manifest = sha(f.manifest)
  f.replacements = f.replacements.map((row, index) => ({ ...rootRow(mapped(row.path)), role: 'historical-control-only' }))
  const currentLive = f.present.map(row => rootRow(mapped(row.path), row.marker.relative))
  replaceJson(f.recovery, receipt => {
    receipt.model = 'exact75-v3-runtime-relocation-closure'
    receipt.historicalManifest = { path: f.manifest, sha256: f.frozenHashes.manifest }
    receipt.liveRootRemap = { mode: 'PREFIX_RELOCATION', historicalRuntime, currentRuntime, liveRootCount: 63,
      mappings: f.present.map((historicalRoot, index) => ({ historicalRoot, currentRoot: currentLive[index] })) }
    receipt.liveDeviceRemap.currentDevice = statSync(currentRuntime).dev
    receipt.mappings = f.disappeared.map((historicalRoot, index) => ({ historicalRoot, state: 'LOST', recovered: false,
      replacementRoot: f.replacements[index] }))
    receipt.activeBenchmarkInput.path = join(f.seed, 'seed.sqlite')
  })
  chmodSync(f.recovery, 0o400)
  f.measureRootRecovery = { path: f.recovery, sha256: sha(f.recovery) }
  return f
}

function queuedProcessLineageFixture() {
  const f=disappearedFrozenOwnedFixture(),currentRoot=join(f.runtime,'measure-root-recovery-v2')
  mkdirSync(currentRoot);chmodSync(currentRoot,0o700)
  const currentReplacements=f.disappeared.map((historicalRoot,index)=>{const path=join(currentRoot,`replacement-${String(index+1).padStart(3,'0')}`);mkdirSync(path);json(join(path,'owner.json'),{schemaVersion:1,scope:'musicbridge-capacity-historical-control-only',id:randomUUID(),role:'historical-control-only',historicalRoot,recovered:false});return {...rootRow(path),role:'historical-control-only'}})
  const stable=f.present.map(row=>rootRow(row.path,row.marker.relative))
  const suffix=[rootRow(f.future,'command.json')]
  for(const name of ['issuer-failure','prechild-failure']){const path=join(f.runtime,`lineage-${name}`);mkdirSync(path);json(join(path,'owner.json'),{scope:name});suffix.push(rootRow(path))}
  const receipt=JSON.parse(readFileSync(f.recovery,'utf8'))
  const currentMappings=f.disappeared.map((historicalRoot,index)=>({historicalRoot,state:'LOST',recovered:false,replacementRoot:currentReplacements[index]}))
  const historicalMeasure={measureRootRecovery:{path:f.recovery,sha256:sha(f.recovery)},window:{id:f.windowId},ownedManifest:{path:f.manifest,sha256:f.frozenHashes.manifest},candidateRepository:{root:f.candidate,branch:f.candidateBranch,head:f.head}}
  return {...f,historicalMeasure,currentMappings,oldInherited:[...stable,...f.replacements.map(({role,...row})=>row),...suffix],currentRoots:[...stable,...currentReplacements.map(({role,...row})=>row),...suffix],receipt}
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
    assert.equal(bridge(f.script, 'source', { manifest: sourceManifest(f), root: f.candidate }).value,
      f.candidateFiles.length)
    json(join(f.authority, 'owner.json'), { scope: window.scope, owner: 'root', id: window.id })
    json(join(f.authority, 'window.json'), window)
    const loaded = bridge(f.script, 'load', { window: join(f.authority, 'window.json'), windowSha256: sha(join(f.authority, 'window.json')) })
    assert.equal(loaded.ok, true)
    assert.deepEqual(loaded.value.slice(0, 2), [f.runtime, f.authority])
  } finally { f.cleanup() }
})

test('所有Git读取净化外部GIT注入、固定只读环境并拒绝candidate子目录冒充仓库根', () => {
  const f = copiedSupervisor()
  try {
    const window = windowValue(f)
    const injected = { GIT_DIR: join(f.temp, 'attacker.git'), GIT_WORK_TREE: f.runtime,
      GIT_INDEX_FILE: join(f.temp, 'attacker.index'), GIT_CONFIG_COUNT: '99' }
    const observed = bridge(f.script, 'candidate', { window, runtime: f.runtime }, injected)
    assert.equal(observed.ok, true, observed.error)
    const gitEnvironment = bridge(f.script, 'git-env', {}, injected)
    assert.deepEqual(gitEnvironment.value, { GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' })

    const nested = structuredClone(window)
    nested.candidateRepository.root = join(f.candidate, 'packages')
    assert.equal(bridge(f.script, 'candidate', { window: nested, runtime: f.runtime }).ok, false)
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

test('joint generation预算只保留一个活动输出和一个活动Record工作区', () => {
  const f = copiedSupervisor()
  try {
    assert.deepEqual(bridge(f.script, 'generation-plan', { profile: 'joint' }), {
      ok: true,
      value: {
        model: 'serial-single-output-plus-bounded-growth-v1', activeOutputMaximum: 1,
        finalAxisBytes: 1_275_068_416, activeOutputBytes: 1_275_068_416,
        activeRecordWorkspaceBytes: 16 * 1024 ** 2, evidenceAllowanceBytes: 128 * 1024 ** 2,
        plannedBytes: 2_701_131_776,
      },
    })
  } finally { f.cleanup() }
})

test('joint generation预算拒绝旧130 Record预建值和额外字段', () => {
  const f = copiedSupervisor()
  try {
    const exactPlan = bridge(f.script, 'generation-plan', { profile: 'joint' }).value
    assert.deepEqual(bridge(f.script, 'generation-plan-valid', { value: exactPlan }), { ok: true, value: true })
    assert.deepEqual(bridge(f.script, 'generation-plan-valid', {
      value: { ...exactPlan, plannedBytes: 6_140_461_056 },
    }), { ok: true, value: false })
    assert.deepEqual(bridge(f.script, 'generation-plan-valid', {
      value: { ...exactPlan, unboundedRecordCount: 130 },
    }), { ok: true, value: false })
    assert.deepEqual(bridge(f.script, 'generation-plan-valid', {
      value: { ...exactPlan, activeOutputMaximum: true },
    }), { ok: true, value: false })
    assert.deepEqual(bridge(f.script, 'generation-plan-valid-float', {}), { ok: true, value: false })
    assert.equal(bridge(f.script, 'generation-plan', { profile: 'objects-limit' }).ok, false)
  } finally { f.cleanup() }
})

test('joint measure seed消费端拒绝缺失或错误generation预算合同', () => {
  const mutations = [
    null,
    value => { delete value.generationPlan },
    value => { value.generationPlan.plannedBytes = 6_140_461_056 },
    value => { delete value.axes },
    value => { value.axes.reached.photoBytes = false },
    value => { delete value.planPreparation },
    value => { value.planPreparation.strategy = 'prebuilt-before-object-growth' },
    value => { value.planPreparation.activePlanMaximum = 2 },
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor(); let fixture
    try {
      const prepared = jointMeasureSeed(f, mutate ?? (() => {})); fixture = prepared.fixture
      const observed = bridge(f.script, 'measure-seed', { runtime: f.runtime, window: prepared.window })
      assert.equal(observed.ok, mutate === null, observed.error)
      if (mutate !== null) assert.equal(observed.error, 'SEED_INVALID')
    } finally {
      if (fixture) rmSync(fixture, { recursive: true, force: true })
      f.cleanup()
    }
  }
  const rawMutations = [
    value => value.replace('"schema": 21', '"schema": 21.0'),
    value => value.replace('"nextPlanHash": "' + 'a'.repeat(64) + '"', '"nextPlanHash": ' + '1'.repeat(64)),
    value => value.replace('"attemptEvents": 50000', '"attemptEvents": 50000.0'),
  ]
  for (const mutateRaw of rawMutations) {
    const f = copiedSupervisor(); let fixture
    try {
      const prepared = jointMeasureSeed(f); fixture = prepared.fixture
      const metadataPath = join(f.runtime, prepared.window.seedLabel, 'seed.json')
      const before = readFileSync(metadataPath, 'utf8'), after = mutateRaw(before)
      assert.notEqual(after, before); writeFileSync(metadataPath, after)
      prepared.window.seed.metadataSha256 = sha(metadataPath)
      const observed = bridge(f.script, 'measure-seed', { runtime: f.runtime, window: prepared.window })
      assert.deepEqual(observed, { ok: false, error: 'SEED_INVALID' })
    } finally {
      if (fixture) rmSync(fixture, { recursive: true, force: true })
      f.cleanup()
    }
  }
})

test('joint generation artifacts仅在精确预算合同存在时verifiedPassed', () => {
  const cases = [
    { expected: true },
    { expected: false, seed: value => { delete value.generationPlan } },
    { expected: false, seed: value => { value.generationPlan.plannedBytes = 6_140_461_056 } },
    { expected: false, seed: value => { delete value.schema } },
    { expected: false, seed: value => { delete value.axes } },
    { expected: false, seed: value => { value.axes.actual.attemptBytes = false } },
    { expected: false, seed: value => { delete value.planPreparation } },
    { expected: false, seed: value => { value.planPreparation.beforeFirstAttempt = false } },
    { expected: false, seed: value => { value.planPreparation.activePlanMaximum = 2 } },
    { expected: false, space: value => { value.ownedBytes = 0 } },
  ]
  for (const item of cases) {
    const f = copiedSupervisor(); let prepared
    try {
      prepared = jointGenerationArtifacts(f, item.seed, item.space)
      const observed = bridge(f.script, 'generation-artifacts', {
        runtime: f.runtime, label: prepared.label, expected: prepared.expected,
      })
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value.verifiedPassed, item.expected, JSON.stringify(observed.value))
    } finally {
      if (prepared?.fixture) rmSync(prepared.fixture, { recursive: true, force: true })
      f.cleanup()
    }
  }
  for (const mutateRaw of [
    value => value.replace('"schema": 21', '"schema": 21.0'),
    value => value.replace('"nextPlanHash": "' + 'a'.repeat(64) + '"', '"nextPlanHash": ' + '1'.repeat(64)),
    value => value.replace('"attemptEvents": 50000', '"attemptEvents": 50000.0'),
  ]) {
    const f = copiedSupervisor(); let prepared
    try {
      prepared = jointGenerationArtifacts(f)
      const metadataPath = join(f.runtime, prepared.label, 'seed.json')
      const before = readFileSync(metadataPath, 'utf8'), after = mutateRaw(before)
      assert.notEqual(after, before); writeFileSync(metadataPath, after)
      const observed = bridge(f.script, 'generation-artifacts', {
        runtime: f.runtime, label: prepared.label, expected: prepared.expected,
      })
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value.verifiedPassed, false, JSON.stringify(observed.value))
    } finally {
      if (prepared?.fixture) rmSync(prepared.fixture, { recursive: true, force: true })
      f.cleanup()
    }
  }
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

test('queued-stop PROCESS_EXIT carryover严格冻结exact75 authority、日志与双稳定快照', () => {
  {
    const f = copiedSupervisor()
    try {
      const { fixture: ignored, ...row } = queuedProcessFailure(f)
      void ignored
      const observed = bridge(f.script, 'queued-process-failures', { runtime: f.runtime, carryover: [row] })
      assert.equal(observed.ok, true, observed.error)
      assert.equal(observed.value.roots.length, 1)
      assert.equal(observed.value.snapshots[0].windowId, row.windowId)
      assert.equal(observed.value.snapshots[0].failure, 'PROCESS_EXIT')
      assert.deepEqual(observed.value.snapshots[0].inheritedRoots, ignored.historicalRoots)
      assert.deepEqual(observed.value.snapshots[0].supervisionIdentity.entries,
        ['stderr.log', 'stdout.log', 'supervisor-start.json', 'supervisor.json'])
      assert.equal(observed.value.snapshots[0].stdout.size, 0)
      assert.equal(row.files.stdout.sha256,
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
      assert.equal(row.files.stderr.sha256,
        '0dfbd76c742fe7754a435fcb368a34dabe21adbdd23338ee9145ad5afb157298')
    } finally { f.cleanup() }
  }

  {
    const f = copiedSupervisor()
    try {
      const { fixture: ignored, ...row } = queuedProcessFailure(f, ({ stderr, supervision, closePath }) => {
        writeFileSync(stderr, 'CAPACITY_PHASE_OPERATION_FAILED\n' +
          '(node:314) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n' +
          '(Use `node --trace-warnings ...` to show where the warning was created)\n')
        const stderrFact = { path: stderr, exists: true, size: statSync(stderr).size, sha256: sha(stderr) }
        replaceJson(supervision, value => { value.stderr = stderrFact })
        replaceJson(closePath, value => { value.stderr = stderrFact; value.supervisorSha256 = sha(supervision) })
      })
      void ignored
      assert.equal(bridge(f.script, 'queued-process-failures', {
        runtime: f.runtime, carryover: [row],
      }).ok, false)
    } finally { f.cleanup() }
  }
  const mutations = [
    ({ parent }) => writeFileSync(join(parent, 'unexpected.txt'), 'unexpected\n'),
    ({ stdout }) => writeFileSync(stdout, 'unexpected stdout\n'),
    ({ stderr }) => writeFileSync(stderr, 'CAPACITY_PHASE_OPERATION_FAILED\nsecret path\n'),
    ({ closePath }) => replaceJson(closePath, value => { value.authorityTerminal.authorityStable = false }),
    ({ closePath }) => replaceJson(closePath, value => { value.failure = 'AUTHORITY_DRIFT' }),
    ({ supervision }) => replaceJson(supervision, value => { value.failure = null }),
    ({ owned }) => replaceJson(owned, value => { value.roots.pop() }),
    ({ issuerFact }) => replaceJson(issuerFact, value => { value.extra = true }),
    ({ supervisionDirectory }) => writeFileSync(join(supervisionDirectory, 'extra.log'), 'x\n'),
  ]
  for (const mutate of mutations) {
    const f = copiedSupervisor()
    try {
      const { fixture: ignored, ...row } = queuedProcessFailure(f, mutate)
      void ignored
      assert.equal(bridge(f.script, 'queued-process-failures', {
        runtime: f.runtime, carryover: [row],
      }).ok, false)
    } finally { f.cleanup() }
  }
})

test('queued-stop PROCESS_EXIT carryover接受消费者输出的有界WINDOW_INVALID失败码',()=>{
  const f=copiedSupervisor()
  try {
    const row=queuedProcessFailure(f)
    writeFileSync(row.fixture.stderr,'CAPACITY_PHASE_WINDOW_INVALID\n(node:313) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n')
    refreshQueuedProcessRow(row)
    const direct=structuredClone(row);delete direct.fixture
    const observed=bridge(f.script,'queued-process-failures',{runtime:f.runtime,carryover:[direct]})
    assert.equal(observed.ok,true,observed.error)
    assert.equal(observed.value.snapshots[0].windowId,row.windowId)
  } finally { f.cleanup() }
})

test('queued-stop PROCESS_EXIT carryover接受严格校验后的首样本preflight保留现场',()=>{
  const f=copiedSupervisor()
  try {
    const row=queuedProcessFailure(f),output=join(row.fixture.parent,row.label);mkdirSync(output)
    writeFileSync(row.fixture.stdout,'CAPACITY_PHASE_INCOMPLETE\n')
    writeFileSync(row.fixture.stderr,'(node:313) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n')
    const partial={outputDirectory:output,verifiedComplete:false,verifiedPassed:false,fileCount:12,
      sampleCount:0,uniqueChildPids:0,aggregateBudgetValid:false,unexpectedEntries:['sample-001']}
    replaceJson(row.fixture.supervision,value=>{value.queuedStop=partial})
    replaceJson(row.fixture.closePath,value=>{value.queuedStop=partial})
    refreshQueuedProcessRow(row)
    const direct=structuredClone(row);delete direct.fixture
    const observed=bridge(f.script,'queued-process-failures',{
      runtime:f.runtime,carryover:[direct],acceptRetainedFixture:true,
    })
    assert.equal(observed.ok,true,observed.error)
    assert.equal(observed.value.snapshots[0].windowId,row.windowId)
    assert.equal(observed.value.snapshots[0].stdout.size,26)
  } finally { f.cleanup() }
})

test('queued-stop PROCESS_EXIT head压缩递归验证window05到window03并返回全链billing roots',()=>{
  const f=copiedSupervisor()
  try {
    const {leaf,head}=linkedQueuedProcessFailure(f)
    writeFileSync(head.fixture.stderr,'CAPACITY_PHASE_OPERATION_FAILED\n(node:97229) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n')
    replaceJson(head.fixture.supervisorStart,v=>{v.pid=97229;v.pgid=97229})
    replaceJson(head.fixture.supervision,v=>{v.pid=97229;v.pgid=97229})
    replaceJson(head.fixture.closePath,v=>{v.pid=97229;v.pgid=97229})
    refreshQueuedProcessRow(head)
    const direct=structuredClone(head);delete direct.fixture
    const observed=bridge(f.script,'queued-process-failures',{runtime:f.runtime,carryover:[direct]})
    assert.equal(observed.ok,true,observed.error)
    assert.deepEqual(observed.value.roots.map(v=>v.path),[head.root])
    assert.deepEqual(observed.value.billingRoots.map(v=>v.path).sort(),[leaf.root,head.root].sort())
    assert.deepEqual(observed.value.snapshots.map(v=>v.windowId),[head.windowId,leaf.windowId])
  } finally { f.cleanup() }
})

test('queued-stop PROCESS_EXIT第二层后继区分direct head与递归reachable depth',()=>{
  const f=copiedSupervisor()
  try {
    const {leaf,head}=linkedQueuedProcessFailure(f),successor=successorQueuedProcessFailure(f,head)
    const direct=structuredClone(successor);delete direct.fixture
    const observed=bridge(f.script,'queued-process-failures',{runtime:f.runtime,carryover:[direct]})
    assert.equal(observed.ok,true,observed.error)
    assert.deepEqual(observed.value.billingRoots.map(value=>value.path),[successor.root,head.root,leaf.root])
    assert.equal(observed.value.contractLineage.directHeadCount,1)
    assert.equal(observed.value.contractLineage.reachableDepth,3)
  } finally { f.cleanup() }
})

test('queued-stop PROCESS_EXIT head压缩拒绝owned[73]错配、fork/cycle与orphan',async t=>{
  for(const [name,mutate] of [
    ['owned[73]',({head})=>{replaceJson(head.fixture.owned,v=>{v.roots[73]=structuredClone(v.roots[0])});refreshQueuedProcessRow(head)}],
    ['fork',({head})=>{replaceJson(head.fixture.issuerFact,v=>{v.processFailureCarryover.push(structuredClone(v.processFailureCarryover[0]))});refreshQueuedProcessRow(head)}],
    ['cycle',({head})=>{const self=structuredClone(head);delete self.fixture;replaceJson(head.fixture.issuerFact,v=>{v.processFailureCarryover=[self]});refreshQueuedProcessRow(head)}],
    ['orphan',({f})=>{queuedProcessFailure(f,()=>{},'-orphan')}],
  ]) await t.test(name,()=>{const f=copiedSupervisor();try{const chain=linkedQueuedProcessFailure(f);mutate({...chain,f});const direct=structuredClone(chain.head);delete direct.fixture;const observed=bridge(f.script,'queued-process-failures',{runtime:f.runtime,carryover:[direct]});assert.equal(observed.ok,false)}finally{f.cleanup()}})
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

test('queued-stop successor window逐项绑定单个只读measure root recovery收据', () => {
  const f = copiedSupervisor()
  try {
    const window = queuedWindowValue(f)
    window.measureCarryover.measureRootRecovery = {
      path: join(f.authority, 'measure-root-recovery.json'), sha256: '6'.repeat(64) }
    const observed = bridge(f.script, 'queued-window', { window, now: Date.now() / 1000 })
    assert.equal(observed.ok, true, observed.error)
    for (const mutate of [
      value => { delete value.measureCarryover.measureRootRecovery },
      value => { value.measureCarryover.measureRootRecovery.path = 'relative.json' },
      value => { value.measureCarryover.measureRootRecovery.sha256 = '0'.repeat(63) },
      value => { value.measureCarryover.measureRootRecovery.extra = true },
    ]) {
      const changed = structuredClone(window); mutate(changed)
      assert.equal(bridge(f.script, 'queued-window', { window: changed, now: Date.now() / 1000 }).ok, false)
    }
  } finally { f.cleanup() }
})

test('冻结measure以exact75-v2只读收据把7个LOST根替换为durable control roots且不改写历史PASS证据', () => {
  const f = disappearedFrozenOwnedFixture()
  try {
    const observed = bridge(f.script, 'frozen-owned', {
      manifest: f.manifest, runtime: f.runtime, manifestSha256: f.frozenHashes.manifest,
      windowId: f.windowId, future: f.future, measureRootRecovery: f.measureRootRecovery })
    assert.equal(observed.ok, true, observed.error)
    assert.equal(observed.value.roots.length, 70)
    assert.deepEqual(new Set(observed.value.roots.map(row => row.path)),
      new Set([...f.present, ...f.replacements].map(row => row.path)))
    assert.equal(new Set([...observed.value.roots.map(row => row.path), f.future]).size, 71)
    assert.equal(observed.value.roots.some(row => row.path === f.replacements[0].path), true)
    assert.deepEqual({ window: sha(f.window), close: sha(f.close), manifest: sha(f.manifest) }, f.frozenHashes)
    const receipt = JSON.parse(readFileSync(f.recovery, 'utf8'))
    assert.deepEqual(receipt.liveDeviceRemap, { mode: 'REMAPPED', historicalDevice: f.present[0].device,
      currentDevice: statSync(f.runtime).dev, liveRootCount: 63 })
    assert.equal(receipt.mappings.length, 7)
    assert.equal(JSON.parse(readFileSync(join(f.seed, 'seed.json'))).fixtureDirectory, f.disappeared[0].path)
    assert.equal(receipt.mappings[0].historicalRoot.path, f.disappeared[0].path)
    assert.equal(receipt.mappings.every(row => row.state === 'LOST' && row.recovered === false), true)
    assert.equal(receipt.mappings.every(row => row.replacementRoot.marker.relative === 'owner.json'), true)
    const replacementOwners = receipt.mappings.map(row =>
      JSON.parse(readFileSync(join(row.replacementRoot.path, 'owner.json'))))
    assert.equal(replacementOwners.every(owner => owner.scope ===
      'musicbridge-capacity-historical-control-only'), true)
    assert.equal(replacementOwners.every(owner => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(owner.id)), true)
    assert.equal(new Set(replacementOwners.map(owner => owner.id)).size, 7)
    assert.equal(receipt.mappings.every(row =>
      row.replacementRoot.marker.sha256 !== row.historicalRoot.marker.sha256), true)
    assert.equal('activeFixtureDirectory' in receipt, false)
    assert.equal(receipt.contentRecovered, false)
    assert.equal(receipt.historicalManifestRewritten, false)
    assert.deepEqual(receipt.activeBenchmarkInput,
      { model: 'durable-seed-snapshot', path: join(f.seed, 'seed.sqlite'), sha256: sha(join(f.seed, 'seed.sqlite')) })
  } finally { f.cleanup() }
})

test('冻结measure接受显式runtime relocation并返回63个当前root身份', () => {
  const f = relocatedFrozenOwnedFixture()
  try {
    const observed = bridge(f.script, 'frozen-owned', {
      manifest: f.manifest, runtime: f.runtime, manifestSha256: f.frozenHashes.manifest,
      windowId: f.windowId, future: f.future, measureRootRecovery: f.measureRootRecovery })
    assert.equal(observed.ok, true, observed.error)
    assert.equal(observed.value.roots.length, 70)
    assert.equal(observed.value.roots.slice(0, 63).every(root => root.path.startsWith(`${f.runtime}/`)), true)
  } finally { f.cleanup() }
})

test('冻结measure由相同历史与当前device派生UNCHANGED', () => {
  const f = disappearedFrozenOwnedFixture(false)
  try {
    const observed = bridge(f.script, 'frozen-owned', {
      manifest: f.manifest, runtime: f.runtime, manifestSha256: f.frozenHashes.manifest,
      windowId: f.windowId, future: f.future, measureRootRecovery: f.measureRootRecovery })
    assert.equal(observed.ok, true, observed.error)
    assert.equal(observed.value.rootRecovery.liveDeviceRemap.mode, 'UNCHANGED')
  } finally { f.cleanup() }
})

test('measure root recovery拒绝非exact或不自洽liveDeviceRemap及设备集合', () => {
  const cases = [
    f => rewriteRootRecovery(f, receipt => { delete receipt.liveDeviceRemap }),
    f => rewriteRootRecovery(f, receipt => { receipt.liveDeviceRemap.extra = true }),
    f => rewriteRootRecovery(f, receipt => { receipt.liveDeviceRemap.mode = 'UNCHANGED' }),
    f => rewriteRootRecovery(f, receipt => { receipt.liveDeviceRemap.liveRootCount = 62 }),
    f => { const manifest = JSON.parse(readFileSync(f.manifest)); manifest.roots[0].device += 1
      rmSync(f.manifest); json(f.manifest, manifest); f.frozenHashes.manifest = sha(f.manifest)
      return rewriteRootRecovery(f, receipt => { receipt.historicalManifest.sha256 = f.frozenHashes.manifest }) },
    f => { const manifest = JSON.parse(readFileSync(f.manifest)); manifest.roots[0].inode += 1
      rmSync(f.manifest); json(f.manifest, manifest); f.frozenHashes.manifest = sha(f.manifest)
      return rewriteRootRecovery(f, receipt => { receipt.historicalManifest.sha256 = f.frozenHashes.manifest }) },
    f => { writeFileSync(join(f.seed, 'seed.json'), 'marker drift\n'); return f.measureRootRecovery },
    f => rewriteRootRecovery(f, receipt => { receipt.liveDeviceRemap.currentDevice += 1 }),
    f => rewriteRootRecovery(f, receipt => { receipt.mappings[0].replacementRoot.device += 1 }),
  ]
  for (const mutate of cases) {
    const f = disappearedFrozenOwnedFixture()
    try {
      const observed = bridge(f.script, 'frozen-owned', {
        manifest: f.manifest, runtime: f.runtime, manifestSha256: f.frozenHashes.manifest,
        windowId: f.windowId, future: f.future, measureRootRecovery: mutate(f) })
      assert.equal(observed.ok, false)
    } finally {
      for (const row of f.disappeared) rmSync(row.path, { recursive: true, force: true })
      f.cleanup()
    }
  }
})

test('measure root recovery拒绝缺项、夹带、旧路径重现、身份漂移、marker-only复制与replacement冒充fixture', () => {
  const cases = [
    f => rewriteRootRecovery(f, receipt => { receipt.mappings.pop() }),
    f => rewriteRootRecovery(f, receipt => { receipt.mappings.push(structuredClone(receipt.mappings[0])) }),
    f => rewriteRootRecovery(f, receipt => { receipt.mappings[0].historicalRoot.path += '-drift' }),
    f => rewriteRootRecovery(f, receipt => { receipt.mappings[0].historicalRoot.inode += 1 }),
    f => rewriteRootRecovery(f, receipt => { receipt.mappings[0].historicalRoot.marker.sha256 = '0'.repeat(64) }),
    f => { mkdirSync(f.disappeared[0].path); json(join(f.disappeared[0].path, 'capacity-owner.json'),
      { scope: 'musicbridge-capacity-synthetic-only', index: 0 }); return f.measureRootRecovery },
    f => { chmodSync(join(f.replacements[0].path, 'owner.json'), 0o600)
      writeFileSync(join(f.replacements[0].path, 'owner.json'), 'marker drift\n'); return f.measureRootRecovery },
    f => { const path = f.replacements[0].path; renameSync(path, `${path}-old`); mkdirSync(path)
      json(join(path, 'owner.json'), { id: randomUUID(), scope: 'musicbridge-capacity-historical-control-only' })
      return f.measureRootRecovery },
    f => rewriteRootRecovery(f, receipt => { receipt.mappings[0].state = 'PRESENT' }),
    f => rewriteRootRecovery(f, receipt => { receipt.mappings[0].recovered = true }),
    f => rewriteRootRecovery(f, receipt => { receipt.contentRecovered = true }),
    f => rewriteRootRecovery(f, receipt => { receipt.historicalManifestRewritten = true }),
    f => rewriteRootRecovery(f, receipt => { receipt.activeFixtureDirectory = receipt.mappings[0].replacementRoot.path }),
    f => rewriteRootRecovery(f, receipt => { receipt.activeBenchmarkInput = {
      path: receipt.mappings[0].replacementRoot.path, sha256: receipt.mappings[0].replacementRoot.marker.sha256 } }),
    f => rewriteRootRecovery(f, receipt => {
      const mapping = receipt.mappings[0], replacement = mapping.replacementRoot.path
      rmSync(replacement, { recursive: true }); mkdirSync(replacement)
      json(join(replacement, 'capacity-owner.json'), { scope: 'musicbridge-capacity-synthetic-only', index: 0 })
      mapping.replacementRoot = rootRow(replacement, 'capacity-owner.json')
      assert.equal(mapping.replacementRoot.marker.sha256, mapping.historicalRoot.marker.sha256)
    }),
    f => ({ path: f.recovery, sha256: '0'.repeat(64) }),
  ]
  for (const mutate of cases) {
    const f = disappearedFrozenOwnedFixture()
    try {
      const observed = bridge(f.script, 'frozen-owned', {
        manifest: f.manifest, runtime: f.runtime, manifestSha256: f.frozenHashes.manifest,
        windowId: f.windowId, future: f.future, measureRootRecovery: mutate(f) })
      assert.equal(observed.ok, false)
    } finally {
      for (const row of f.disappeared) rmSync(row.path, { recursive: true, force: true })
      f.cleanup()
    }
  }
})

test('63个live历史根加7个historical-control-only根、output与三类carryover保持successor exact76', () => {
  const f = disappearedFrozenOwnedFixture()
  try {
    const issuerIdentity = join(f.authority, 'issuer-identity'); mkdirSync(issuerIdentity)
    json(join(f.authority, 'owner.json'), { scope: 'musicbridge-capacity-queued-stop-window', owner: 'root', id: f.windowId })
    json(join(issuerIdentity, 'owner.json'), { scope: 'musicbridge-capacity-queued-stop-authority-issuer', windowId: f.windowId })
    const outputRoot = rootRow(f.future, 'command.json')
    const measureRoots = [
      ...f.present.map(root => ({ ...root, device: statSync(root.path).dev })),
      ...f.replacements.map(({ role: _role, ...root }) => root),
    ]
    assert.equal(measureRoots.length, 70)
    const priorRoots = []
    for (const name of ['prior-issuer-failure', 'prior-prechild-failure', 'prior-process-failure']) {
      const root = join(f.runtime, name); mkdirSync(root); json(join(root, 'owner.json'), { scope: name })
      priorRoots.push(rootRow(root))
    }
    const carryRoots = [...measureRoots, outputRoot, ...priorRoots]
    assert.equal(carryRoots.length, 74)
    const manifest = join(f.authority, 'owned-roots.json')
    json(manifest, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only',
      windowId: f.windowId, roots: [...carryRoots, rootRow(f.authority), rootRow(issuerIdentity)] })
    const expectedDevice = statSync(f.runtime).dev
    const payload = { manifest, runtime: f.runtime, windowId: f.windowId,
      parent: f.authority, carryRoots, plannedBytes: 0, expectedDevice }
    const observed = bridge(f.script, 'queued-owned', payload)
    assert.equal(observed.ok, true, observed.error)
    assert.equal(observed.value.rootCount, 76)
    assert.equal(bridge(f.script, 'queued-owned', { ...payload, expectedDevice: expectedDevice + 1 }).ok, false)
  } finally { f.cleanup() }
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
      value => { value.issuerFailureCarryoverCount = 0 },
      value => { value.prechildFailureCarryoverCount = 0 },
      value => { delete value.prechildFailureCarryoverCount },
      value => { value.processFailureCarryoverCount = 0 },
      value => { delete value.processFailureCarryoverCount },
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

test('queued-stop admission后新增replay身份必须在spawn前停止', () => {
  const f = copiedSupervisor()
  try {
    const window = queuedWindowValue(f), windowSha256 = 'd'.repeat(64)
    const observed = bridge(f.script, 'queued-command', {
      runtime: f.runtime, authority: f.authority, window, windowSha256,
      injectReplayAfterAdmission: true,
    })
    assert.equal(observed.ok, false)
    assert.equal(observed.error, 'CAPACITY_SUPERVISOR_INPUT')
  } finally { f.cleanup() }
})

test('queued-stop replay审计兼容历史close内嵌window对象且仍拒绝内嵌身份碰撞', () => {
  const f = copiedSupervisor()
  try {
    const window = queuedWindowValue(f)
    const historicalClose = join(f.runtime, 'objects-generation-window-01-close.json')
    json(historicalClose, {
      schemaVersion: 1,
      scope: 'musicbridge-capacity-generation-close',
      window: {
        id: randomUUID(),
        label: 'objects-generation-01',
        phase: 'generation',
        profile: 'objects-limit',
        executionLimitMs: 120_000,
        sha256: 'a'.repeat(64),
      },
    })
    assert.equal(bridge(f.script, 'queued-replay', {
      runtime: f.runtime, parent: f.authority, window,
    }).ok, true)

    const collided = JSON.parse(readFileSync(historicalClose))
    rmSync(historicalClose)
    collided.window.id = window.id
    json(historicalClose, collided)
    const nestedIdCollision = bridge(f.script, 'queued-replay', {
      runtime: f.runtime, parent: f.authority, window,
    })
    assert.equal(nestedIdCollision.ok, false)
    assert.equal(nestedIdCollision.error, 'QUEUED_STOP_REPLAY')

    rmSync(historicalClose)
    collided.window.id = randomUUID()
    collided.window.label = window.label
    json(historicalClose, collided)
    const nestedLabelCollision = bridge(f.script, 'queued-replay', {
      runtime: f.runtime, parent: f.authority, window,
    })
    assert.equal(nestedLabelCollision.ok, false)
    assert.equal(nestedLabelCollision.error, 'QUEUED_STOP_REPLAY')

    for (const mutate of [
      value => { value.label = {} },
      value => { value.window = [] },
      value => { value.window.id = [] },
      value => { value.window.label = false },
    ]) {
      rmSync(historicalClose)
      const malformed = {
        schemaVersion: 1,
        scope: 'musicbridge-capacity-generation-close',
        window: { id: randomUUID(), label: 'objects-generation-01' },
      }
      mutate(malformed)
      json(historicalClose, malformed)
      const observed = bridge(f.script, 'queued-replay', {
        runtime: f.runtime, parent: f.authority, window,
      })
      assert.equal(observed.ok, false)
      assert.equal(observed.error, 'QUEUED_STOP_REPLAY_AUDIT')
    }
    rmSync(historicalClose)
    const outsideClose = join(f.temp, 'outside-generation-close.json')
    json(outsideClose, { schemaVersion: 1, scope: 'musicbridge-capacity-generation-close',
      window: { id: randomUUID(), label: 'objects-generation-outside' } })
    symlinkSync(outsideClose, historicalClose)
    const closeSymlink = bridge(f.script, 'queued-replay', {
      runtime: f.runtime, parent: f.authority, window,
    })
    assert.equal(closeSymlink.ok, false)
    assert.equal(closeSymlink.error, 'QUEUED_STOP_REPLAY_AUDIT')
    rmSync(historicalClose)
    const outsideAuthority = join(f.temp, 'outside-authority')
    mkdirSync(outsideAuthority)
    json(join(outsideAuthority, 'window.json'), { id: randomUUID(), label: 'outside-window' })
    symlinkSync(outsideAuthority, join(f.runtime, 'objects-symlink-window'))
    const authoritySymlink = bridge(f.script, 'queued-replay', {
      runtime: f.runtime, parent: f.authority, window,
    })
    assert.equal(authoritySymlink.ok, false)
    assert.equal(authoritySymlink.error, 'QUEUED_STOP_REPLAY_AUDIT')
    rmSync(join(f.runtime, 'objects-symlink-window'))
    const currentPrechild = join(f.authority, 'prechild-failure.json')
    json(currentPrechild, { scope: 'musicbridge-capacity-queued-stop-prechild-failure',
      windowId: window.id, label: window.label })
    const currentTerminal = bridge(f.script, 'queued-replay', {
      runtime: f.runtime, parent: f.authority, window,
    })
    assert.equal(currentTerminal.ok, false)
    assert.equal(currentTerminal.error, 'QUEUED_STOP_REPLAY')
    rmSync(currentPrechild)
    const priorPrechild = join(f.runtime, 'objects-prior-prechild-window')
    mkdirSync(priorPrechild)
    const priorReceipt = join(priorPrechild, 'prechild-failure.json')
    json(priorReceipt, { scope: 'musicbridge-capacity-queued-stop-prechild-failure',
      windowId: randomUUID(), label: window.label })
    const priorCollision = bridge(f.script, 'queued-replay', {
      runtime: f.runtime, parent: f.authority, window,
    })
    assert.equal(priorCollision.ok, false)
    assert.equal(priorCollision.error, 'QUEUED_STOP_REPLAY')
    rmSync(priorReceipt)
    json(priorReceipt, { scope: 'musicbridge-capacity-queued-stop-prechild-failure',
      windowId: {}, label: 'prior-prechild' })
    const malformedPrechild = bridge(f.script, 'queued-replay', {
      runtime: f.runtime, parent: f.authority, window,
    })
    assert.equal(malformedPrechild.ok, false)
    assert.equal(malformedPrechild.error, 'QUEUED_STOP_REPLAY_AUDIT')
  } finally { f.cleanup() }
})

test('queued-stop admission实际复核toolchain、issuer fact与candidate HEAD blob身份', () => {
  const f = copiedSupervisor()
  try {
    const window = sealQueuedIdentity(f, queuedWindowValue(f))
    const observed = bridge(f.script, 'queued-bound-identities', { window, parent: f.authority, candidate: f.candidate })
    assert.equal(observed.ok, true, observed.error)
    assert.deepEqual(Object.keys(observed.value).sort(), ['buildHelper','buildNode','buildNodeLibrary','consumerPython',
      'issuer','issuerFact','issuerFailureRoots','issuerFailures','node','prechildFailureRoots','prechildFailures',
      'processFailureBillingRoots','processFailureLineage','processFailureRoots','processFailures','tsxLoader','typescriptCompiler','typescriptLibraries'])
    assert.equal(observed.value.issuerFailures[0].issuerIdentity.path,
      join(observed.value.issuerFailureRoots[0].path, 'issuer-identity'))
    const changed = structuredClone(window); changed.toolchain.node.sha256 = '0'.repeat(64)
    assert.equal(bridge(f.script, 'queued-bound-identities', { window: changed, parent: f.authority, candidate: f.candidate }).ok, false)
    const wrongCount = structuredClone(window); wrongCount.issuerFailureCarryoverCount = 2
    assert.equal(bridge(f.script, 'queued-bound-identities', { window: wrongCount, parent: f.authority, candidate: f.candidate }).ok, false)
    const wrongPrechildCount = structuredClone(window); wrongPrechildCount.prechildFailureCarryoverCount = 2
    assert.equal(bridge(f.script, 'queued-bound-identities', {
      window: wrongPrechildCount, parent: f.authority, candidate: f.candidate,
    }).ok, false)
    const wrongProcessCount = structuredClone(window); wrongProcessCount.processFailureCarryoverCount = 2
    assert.equal(bridge(f.script, 'queued-bound-identities', {
      window: wrongProcessCount, parent: f.authority, candidate: f.candidate,
    }).ok, false)
    const factPath = window.issuer.fact.path, factBytes = readFileSync(factPath)
    const malformedFact = JSON.parse(factBytes)
    malformedFact.prechildFailureCarryover[0].root = {}
    rmSync(factPath); json(factPath, malformedFact)
    const malformedWindow = structuredClone(window); malformedWindow.issuer.fact.sha256 = sha(factPath)
    const malformedRoot = bridge(f.script, 'queued-bound-identities', {
      window: malformedWindow, parent: f.authority, candidate: f.candidate,
    })
    assert.equal(malformedRoot.ok, false)
    assert.equal(malformedRoot.error, 'QUEUED_STOP_PRECHILD_FAILURE')
    rmSync(factPath); writeFileSync(factPath, factBytes)
    const prechildRoot = observed.value.prechildFailureRoots[0].path
    writeFileSync(join(prechildRoot, 'unexpected.txt'), 'unexpected\n')
    assert.equal(bridge(f.script, 'queued-bound-identities', {
      window, parent: f.authority, candidate: f.candidate,
    }).ok, false)
    rmSync(join(prechildRoot, 'unexpected.txt'))
    const priorRoot = observed.value.issuerFailureRoots[0].path, extra = join(priorRoot, 'unexpected.txt')
    const priorIssuerIdentity = join(priorRoot, 'issuer-identity'), replacementIdentity = join(priorRoot, 'issuer-identity-new')
    mkdirSync(replacementIdentity); renameSync(join(priorIssuerIdentity, 'owner.json'), join(replacementIdentity, 'owner.json'))
    rmSync(priorIssuerIdentity, { recursive: true }); renameSync(replacementIdentity, priorIssuerIdentity)
    const directoryReplaced = bridge(f.script, 'queued-bound-identities', { window, parent: f.authority, candidate: f.candidate })
    assert.equal(directoryReplaced.ok, true, directoryReplaced.error)
    assert.notDeepEqual(directoryReplaced.value.issuerFailures, observed.value.issuerFailures)
    const priorOwner = join(priorRoot, 'owner.json'), priorOwnerBytes = readFileSync(priorOwner)
    rmSync(priorOwner); writeFileSync(priorOwner, priorOwnerBytes)
    const replaced = bridge(f.script, 'queued-bound-identities', { window, parent: f.authority, candidate: f.candidate })
    assert.equal(replaced.ok, true, replaced.error)
    assert.notDeepEqual(replaced.value.issuerFailures, observed.value.issuerFailures)
    writeFileSync(extra, 'unexpected\n')
    assert.equal(bridge(f.script, 'queued-bound-identities', { window, parent: f.authority, candidate: f.candidate }).ok, false)
    rmSync(extra)
    const unlisted = join(f.runtime, 'objects-queued-unlisted-window'); mkdirSync(unlisted)
    json(join(unlisted, 'issuer-failure.json'), {
      scope: 'musicbridge-capacity-queued-stop-authority-issuer-failure', windowId: randomUUID() })
    assert.equal(bridge(f.script, 'queued-bound-identities', { window, parent: f.authority, candidate: f.candidate }).ok, false)
  } finally { f.cleanup() }
})

test('queued-stop prechild历史收据在runtime迁移后只做内存路径投影', () => {
  const f = copiedSupervisor()
  try {
    const window = sealQueuedIdentity(f, queuedWindowValue(f))
    const fact = JSON.parse(readFileSync(window.issuer.fact.path, 'utf8'))
    const aliasParent = join(f.temp, 'historical-repository-alias')
    symlinkSync(f.temp, aliasParent)
    const aliasedCandidate = join(aliasParent, 'task-079-v3-final-acceptance')
    const failureBinding = fact.prechildFailureCarryover[0].files.failure
    replaceJson(failureBinding.path, receipt => {
      receipt.recovery.repositoryRoot = aliasedCandidate
      receipt.recovery.scriptPath = join(
        aliasedCandidate, 'scripts/ci/terminalize-v3-capacity-queued-stop-prechild.py')
    })
    failureBinding.sha256 = sha(failureBinding.path)
    const historicalRuntime = f.runtime
    const currentRuntime = `${historicalRuntime}-relocated`
    renameSync(historicalRuntime, currentRuntime)
    const relocate = value => {
      if (typeof value === 'string') {
        return value === historicalRuntime || value.startsWith(`${historicalRuntime}/`)
          ? `${currentRuntime}${value.slice(historicalRuntime.length)}` : value
      }
      if (Array.isArray(value)) return value.map(relocate)
      if (value && typeof value === 'object') return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, relocate(item)]))
      return value
    }
    f.runtime = currentRuntime
    f.script = relocate(f.script)
    const runtimeRelocation = {
      mode: 'PREFIX_RELOCATION', historicalRuntime, currentRuntime, liveRootCount: 63, mappings: [],
    }
    const observed = bridge(f.script, 'queued-prechild-failures', {
      carryover: relocate(fact.prechildFailureCarryover), runtime: currentRuntime, runtimeRelocation,
    })
    assert.equal(observed.ok, true, observed.error)
    assert.equal(observed.value.roots[0].path.startsWith(`${currentRuntime}/`), true)
  } finally {
    f.cleanup()
  }
})

test('queued-stop admission复用已钉死candidate谱系模块而不依赖安装目录副本', () => {
  const f = copiedSupervisor()
  try {
    const window = sealQueuedIdentity(f, queuedWindowValue(f))
    rmSync(join(f.authority, 'capacity_process_failure_lineage.py'))
    const observed = bridge(f.script, 'queued-bound-identities', {
      window, parent: f.authority, candidate: f.candidate,
    })
    assert.equal(observed.ok, true, observed.error)
  } finally {
    f.cleanup()
  }
})

test('queued-stop source闭包动态跟随expected paths并拒绝缺失或额外文件', () => {
  const f = copiedSupervisor()
  try {
    const excluded = new Set(['scripts/ci/capacity-phase-supervisor-v2.py',
      'scripts/ci/issue-v3-capacity-measure-window.py'])
    const files = Object.fromEntries(f.candidateFiles.filter(relative => !excluded.has(relative))
      .map(relative => [relative, sha(join(f.candidate, relative))]))
    const manifest = join(f.authority, 'queued-source-pins.json')
    json(manifest, { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files })
    const observed = bridge(f.script, 'queued-source', { manifest, root: f.candidate })
    assert.equal(observed.ok, true, observed.error)
    assert.equal(observed.value.fileCount, Object.keys(files).length)
    replaceJson(manifest, value => { value.files['scripts/ci/capacity-phase-supervisor-v2.py'] = sha(f.script) })
    assert.equal(bridge(f.script, 'queued-source', { manifest, root: f.candidate }).ok, false)
  } finally {
    f.cleanup()
  }
})

test('queued-stop owned闭包动态接受74个carryover加当前authority形成exact76根', () => {
  const f = copiedSupervisor()
  try {
    const windowId = randomUUID(), issuerIdentity = join(f.authority, 'issuer-identity')
    mkdirSync(issuerIdentity)
    json(join(f.authority, 'owner.json'), { scope: 'musicbridge-capacity-queued-stop-window', owner: 'root', id: windowId })
    json(join(issuerIdentity, 'owner.json'), { scope: 'musicbridge-capacity-queued-stop-authority-issuer', windowId })
    const carryRoots = []
    for (let index = 0; index < 74; index += 1) {
      const root = join(f.runtime, `queued-carry-${String(index).padStart(2, '0')}`)
      mkdirSync(root); json(join(root, 'owner.json'), { scope: 'queued-carry', index })
      carryRoots.push(rootRow(root))
    }
    const manifest = join(f.authority, 'owned-roots.json')
    json(manifest, { schemaVersion: 1, scope: 'musicbridge-capacity-owned-roots', access: 'count-only', windowId,
      roots: [...carryRoots, rootRow(f.authority), rootRow(issuerIdentity)] })
    const payload = { manifest, runtime: f.runtime, windowId, parent: f.authority, carryRoots, plannedBytes: 0 }
    const observed = bridge(f.script, 'queued-owned', payload)
    assert.equal(observed.ok, true, observed.error)
    assert.equal(observed.value.rootCount, 76)
    const incomplete = JSON.parse(readFileSync(manifest)); incomplete.roots.splice(0, 1)
    rmSync(manifest); json(manifest, incomplete)
    assert.equal(bridge(f.script, 'queued-owned', payload).ok, false)
  } finally { f.cleanup() }
})

test('queued-stop传递计费计算direct roots与递归process roots的去重union', () => {
  const f = copiedSupervisor()
  try {
    const direct = join(f.runtime, 'billing-direct'), process = join(f.runtime, 'billing-process')
    const nested = join(process, 'nested')
    mkdirSync(direct); mkdirSync(nested, { recursive: true })
    writeFileSync(join(direct, 'direct.bin'), Buffer.alloc(17))
    writeFileSync(join(process, 'process.bin'), Buffer.alloc(23))
    writeFileSync(join(nested, 'nested.bin'), Buffer.alloc(31))
    const value = { rootCount: 76, ownedBytes: 0, plannedBytes: 0,
      remainingPlannedBytes: 0, availableBytes: 0, manifestIdentity: { sha256: '4'.repeat(64) } }
    const observed = bridge(f.script, 'queued-transitive-billing', {
      value, directRoots: [{ path: direct }, { path: nested }], processRoots: [{ path: process }],
      parent: f.authority, terminal: true,
    })
    assert.equal(observed.ok, true, observed.error)
    assert.equal(observed.value.ownedBytes, 71)
    assert.equal(observed.value.remainingPlannedBytes, 0)
    assert.ok(observed.value.availableBytes >= 10 * 1024 ** 3)
  } finally { f.cleanup() }
})

test('queued-stop authority admission到terminal逐项比较issuer failure身份快照', () => {
  const f = copiedSupervisor()
  try {
    const windowId = randomUUID(), windowPath = join(f.authority, 'window.json')
    const issuerIdentity = join(f.authority, 'issuer-identity'); mkdirSync(issuerIdentity)
    json(join(f.authority, 'owner.json'), { scope: 'musicbridge-capacity-queued-stop-window', owner: 'root', id: windowId })
    json(join(issuerIdentity, 'owner.json'), { scope: 'musicbridge-capacity-queued-stop-authority-issuer', windowId })
    json(windowPath, { scope: 'musicbridge-capacity-queued-stop-window', id: windowId,
      issuedAt: '2026-08-30T00:00:00.000Z',
      sourceManifest: { sha256: '3'.repeat(64) }, ownedManifest: { sha256: '4'.repeat(64) },
      queuedStopPlan: { plannedBytes: 2 }, candidateRepository: { root: f.candidate }, measureCarryover: {} })
    const failures = [{ rootIdentity: { path: join(f.runtime, 'prior'), inode: 1 },
      issuerIdentity: { path: join(f.runtime, 'prior/issuer-identity'), inode: 2 }, files: {} }]
    const prechildFailures = [{ rootIdentity: { path: join(f.runtime, 'prechild'), inode: 4 },
      issuerIdentity: { path: join(f.runtime, 'prechild/issuer-identity'), inode: 5 }, files: {} }]
    const root = (name, inode) => ({ path: join(f.runtime, name), device: 1, inode,
      marker: { relative: 'owner.json', sha256: String(inode).repeat(64).slice(0, 64) } })
    const measureRoots = Array.from({ length: 71 }, (_, index) => root(`measure-${index}`, index + 10))
    const issuerFailureRoots = [root('prior', 81)], prechildFailureRoots = [root('prechild', 82)]
    const inheritedRoots = structuredClone([...measureRoots, ...issuerFailureRoots, ...prechildFailureRoots])
    const processFailures = [{ rootIdentity: { path: join(f.runtime, 'process'), inode: 7 },
      supervisionIdentity: { path: join(f.runtime, 'process/supervision'), inode: 8 },
      inheritedRoots, files: {} }]
    const payload = { parent: f.authority, runtime: f.runtime, repo: f.candidate,
      windowSha256: sha(windowPath), failures, prechildFailures, processFailures,
      measureRoots, issuerFailureRoots, prechildFailureRoots }
    const admission = bridge(f.script, 'queued-authority-snapshot', payload)
    assert.equal(admission.ok, true, admission.error)
    const terminal = structuredClone(payload)
    terminal.initial = admission.value; terminal.terminal = true
    terminal.failures[0].issuerIdentity.inode = 3
    const observed = bridge(f.script, 'queued-authority-snapshot', terminal)
    assert.equal(observed.ok, false)
    assert.match(observed.error, /QUEUED_STOP_AUTHORITY_DRIFT/u)
    const prechildTerminal = structuredClone(payload)
    prechildTerminal.initial = admission.value; prechildTerminal.terminal = true
    prechildTerminal.prechildFailures[0].rootIdentity.inode = 6
    const prechildObserved = bridge(f.script, 'queued-authority-snapshot', prechildTerminal)
    assert.equal(prechildObserved.ok, false)
    assert.match(prechildObserved.error, /QUEUED_STOP_AUTHORITY_DRIFT/u)
    const processTerminal = structuredClone(payload)
    processTerminal.initial = admission.value; processTerminal.terminal = true
    processTerminal.processFailures[0].supervisionIdentity.inode = 9
    const processObserved = bridge(f.script, 'queued-authority-snapshot', processTerminal)
    assert.equal(processObserved.ok, false)
    assert.match(processObserved.error, /QUEUED_STOP_AUTHORITY_DRIFT/u)

  } finally { f.cleanup() }
})

test('queued-stop admission与terminal使用recovery谱系翻译PROCESS_EXIT inherited roots', async t => {
  const source=readFileSync(sourceSupervisor,'utf8'),authority=source.slice(source.indexOf('def _validate_queued_stop_authority('),source.indexOf('def _queued_stop_budget('))
  assert.match(authority,/process_lineage = \[_validate_queued_stop_process_recovery_lineage\(/u)
  assert.match(authority,/_apply_queued_stop_transitive_billing\([\s\S]*processFailureBillingRoots/u)
  assert.match(authority,/'processFailureLineage': process_lineage/u)
  assert.match(authority,/'prechildFailures', 'processFailures', 'processFailureBillingRoots',[\s\S]*'processFailureLineage'/u)
  await t.test('跨代正例',()=>{const f=queuedProcessLineageFixture();try{const observed=bridge(f.script,'queued-process-lineage',{runtime:f.runtime,historicalMeasure:f.historicalMeasure,oldInherited:f.oldInherited,currentRoots:f.currentRoots,currentMappings:f.currentMappings});assert.equal(observed.ok,true,observed.error);assert.equal(observed.value.translated,true)}finally{f.cleanup()}})
  await t.test('V3历史恢复收据与当前runtime relocation逐项一致',()=>{const f=queuedProcessLineageFixture();try{const historicalRuntime=join(f.temp,'historical-runtime'),live=f.oldInherited.slice(0,63),runtimeRelocation={mode:'PREFIX_RELOCATION',historicalRuntime,currentRuntime:f.runtime,liveRootCount:63,mappings:live.map(row=>({historicalRoot:structuredClone(row),currentRoot:structuredClone(row)}))};const binding=rewriteRootRecovery(f,receipt=>{receipt.model='exact75-v3-runtime-relocation-closure';receipt.liveRootRemap=runtimeRelocation});chmodSync(f.recovery,0o400);const historicalMeasure=structuredClone(f.historicalMeasure);historicalMeasure.measureRootRecovery=binding;const payload={runtime:f.runtime,historicalMeasure,oldInherited:f.oldInherited,currentRoots:f.currentRoots,currentMappings:f.currentMappings,runtimeRelocation};const observed=bridge(f.script,'queued-process-lineage',payload);assert.equal(observed.ok,true,observed.error);assert.equal(observed.value.translated,true);const drifted=structuredClone(payload);drifted.runtimeRelocation.mappings[0].currentRoot.marker.sha256='f'.repeat(64);const rejected=bridge(f.script,'queued-process-lineage',drifted);assert.equal(rejected.ok,false);assert.match(rejected.error,/QUEUED_STOP_PROCESS_FAILURE_LINEAGE/u)}finally{f.cleanup()}})
  await t.test('历史repository祖先别名仍按同一Git工作树与冻结blob验证',()=>{const f=queuedProcessLineageFixture();try{const aliasParent=join(f.temp,'historical-repository-alias');symlinkSync(f.temp,aliasParent,'dir');const alias=join(aliasParent,'task-079-v3-final-acceptance');const binding=rewriteRootRecovery(f,receipt=>{receipt.repository.root=alias;receipt.recoveryTool.path=join(alias,receipt.recoveryTool.relativePath)});chmodSync(f.recovery,0o400);const historicalMeasure=structuredClone(f.historicalMeasure);historicalMeasure.measureRootRecovery=binding;historicalMeasure.candidateRepository.root=alias;const observed=bridge(f.script,'queued-process-lineage',{runtime:f.runtime,historicalMeasure,oldInherited:f.oldInherited,currentRoots:f.currentRoots,currentMappings:f.currentMappings});assert.equal(observed.ok,true,observed.error);assert.equal(observed.value.translated,true)}finally{f.cleanup()}})
  for(const [name,mutate] of [['historicalRoot漂移',(f,p)=>{p.currentMappings[0].historicalRoot.inode+=1}],['映射重排',(f,p)=>{[p.currentMappings[0],p.currentMappings[1]]=[p.currentMappings[1],p.currentMappings[0]]}],['旧receipt漂移',(f,p)=>{const binding=rewriteRootRecovery(f,r=>{r.repository.clean=false});p.historicalMeasure.measureRootRecovery=binding}],['新增任意根',(f,p)=>{p.currentRoots.push(structuredClone(p.currentRoots[0]))}],['marker替换',(f,p)=>{p.currentRoots[0].marker.sha256='f'.repeat(64)}],['issuer-prechild互换',(f,p)=>{[p.currentRoots[71],p.currentRoots[72]]=[p.currentRoots[72],p.currentRoots[71]]}]])await t.test(name,()=>{const f=queuedProcessLineageFixture();try{const payload={runtime:f.runtime,historicalMeasure:structuredClone(f.historicalMeasure),oldInherited:structuredClone(f.oldInherited),currentRoots:structuredClone(f.currentRoots),currentMappings:structuredClone(f.currentMappings)};mutate(f,payload);const observed=bridge(f.script,'queued-process-lineage',payload);assert.equal(observed.ok,false);assert.match(observed.error,/QUEUED_STOP_PROCESS_FAILURE_LINEAGE/u)}finally{f.cleanup()}})
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
