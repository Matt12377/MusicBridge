import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const sourceIssuer = new URL('../issue-v3-capacity-measure-window.py', import.meta.url).pathname
const sourceHelper = new URL('../issue-v3-capacity-window.py', import.meta.url).pathname
const sourceTrackedSupervisor = new URL('../capacity-phase-supervisor-v2.py', import.meta.url).pathname
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
const legacyStopMetrics = ['signalAborted', 'driverStopInvoked', 'driverStopAck', 'driverCloseInvoked', 'driverCloseResolved', 'receiptSettled']

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function legacySample(metric, index, details = null) {
  return { details, durationMs: index + 1, metric, outcome: 'ok', warmup: index < 5 }
}

function productionLegacyCarryoverFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-issuer-real-carryover-')))
  const runtime = join(root, 'reports/runtime/task-078-v3-acceptance'); mkdirSync(runtime, { recursive: true })
  const windowId = randomUUID(), label = 'objects-measure-old'
  const parent = join(runtime, 'objects-measure-old-window'), output = join(runtime, label)
  mkdirSync(parent); mkdirSync(output)
  const windowPath = join(parent, 'window.json'), closePath = join(parent, 'close.json')
  json(join(parent, 'owner.json'), { scope: 'musicbridge-capacity-measure-window', owner: 'root', id: windowId })
  json(windowPath, { schemaVersion: 1, scope: 'musicbridge-capacity-measure-window', id: windowId, label })
  json(join(output, 'command.json'), {
    executable: '/test/node',
    args: ['/candidate/recording-capacity.ts', '--phase', 'measure', '--profile', 'objects-limit', '--label', label,
      '--seed-label', 'objects-seed-old', '--window', windowId],
    cwd: '/candidate/', node: 'v22.23.2', platform: 'darwin', arch: 'arm64', osVersion: 'test', logicalCpus: 12,
    cache: 'test', profileDefinition: { name: 'objects-limit' }, phase: 'measure', profile: 'objects-limit', window: windowId,
    deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
  })
  json(join(output, 'measurement.json'), {
    seedLabel: 'objects-seed-old', seedSha256: '7'.repeat(64), profile: 'objects-limit', window: windowId,
    classification: 'software-only/exclusive-window', cache: 'test', warmup: 5,
    readSamples: 100, progressSamples: 100, stopSamples: 100, excluded: ['device'],
  })
  json(join(output, 'source-before.json'), { 'packages/bridge-core/src/recording/attempt-store.ts': 'a'.repeat(40) })
  const progress = Array.from({ length: 105 }, (_, index) => legacySample('progress', index))
  const stops = Array.from({ length: 28 }, (_, index) => legacyStopMetrics.map((metric) =>
    legacySample(metric, index, { sample: index, observed: true }))).flat()
  const samples = [...progress, ...stops]
  writeFileSync(join(output, 'samples.jsonl'), `${samples.map((row) => JSON.stringify(row)).join('\n')}\n`)
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
  const fixedFiles = Object.fromEntries(fixedNames.map((name) => [name, {
    exists: true, size: statSync(join(output, name)).size, sha256: sha(join(output, name)),
  }]))
  for (const name of ['source-after.json', 'end-budget.json', 'summary.json', 'exit.json']) fixedFiles[name] = { exists: false, size: null, sha256: null }
  const sqliteBytes = statSync(join(retained, 'sample.sqlite')).size
  json(closePath, {
    schemaVersion: 1, scope: 'musicbridge-capacity-measure-window-close', windowId, label,
    state: 'failed', failure: 'EXECUTION_TIMEOUT', groupEmpty: true, zombies: [],
    windowSha256: sha(windowPath), deviceOpened: false, formalReady: false, gateB: 'NOT_RUN',
    authorityAdmission: { authorityStable: true, seedSnapshotBytes: sqliteBytes },
    authorityTerminal: { authorityStable: true, seedSnapshotBytes: sqliteBytes },
    replayPolicy: 'terminal-window-id-and-label-never-reuse',
    measurement: { outputDirectory: output, partialExists: true, partialPreserved: true,
      verifiedComplete: false, verifiedPassed: false, sampleCount: 273, receiptCount: 29,
      authorityStable: true, commandMatchesWindow: true, files: fixedFiles },
  })
  const receiptInventory = receiptNames.map((name) => ({ name, size: statSync(join(output, name)).size, sha256: sha(join(output, name)) }))
  const evidence = {
    format: 'legacy-107-clone-partial-v1', windowId, label,
    windowSha256: sha(windowPath), closeSha256: sha(closePath), commandSha256: sha(join(output, 'command.json')),
    seedLabel: 'objects-seed-old', seedSha256: '7'.repeat(64),
    files: Object.fromEntries(fixedNames.map((name) => [name, { size: statSync(join(output, name)).size, sha256: sha(join(output, name)) }])),
    receiptSha256: receiptInventory.map((item) => item.sha256),
    receiptManifestSha256: createHash('sha256').update(canonicalJson(receiptInventory)).digest('hex'),
    retainedOwner, retainedOwnerSha256: sha(join(retained, 'owner.json')), sqliteBytes,
    wal: { size: statSync(join(retained, 'sample.sqlite-wal')).size, sha256: sha(join(retained, 'sample.sqlite-wal')) },
    shm: { size: statSync(join(retained, 'sample.sqlite-shm')).size, sha256: sha(join(retained, 'sample.sqlite-shm')) },
  }
  return { root, runtime, parent, output, windowPath, closePath, windowId, label, evidence }
}

function supervisorSource(sourcePaths) {
  return `
from pathlib import Path
import hashlib, json, os, subprocess
_MEASURE_LIMITS={'executionMs':900000,'killGraceMs':1000,'closeMs':2000,'minimumFreeBytes':10737418240,'maximumOwnedBytes':17179869184}
_MEASURE_PLAN={'groupCloneCount':3,'fullHashCount':3,'stopRoundReceiptCount':105,'sampleCount':1575}
_MEASURE_KEYS={'schemaVersion','scope','owner','id','state','phase','profile','label','seedLabel','n','issuedAt','deadlineAt','limits','seed','ownedManifest','sourceManifest','measurePlan','supervisor','candidateRepository'}
_LEGACY_CARRYOVER_EVIDENCE=None
def _sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def _strict_json(path):
  path=Path(path); data=json.loads(path.read_text())
  return data, {'sha256':_sha(path),'size':path.stat().st_size}
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
  if value.get('windowId') != window_id or profile != 'objects-limit' or len(value.get('roots',[])) != 65: raise ValueError('OWNED_MANIFEST')
  if value.get('futureRoots') != [str(future_path)] or future_state != 'absent' or Path(future_path).exists(): raise ValueError('OWNED_MANIFEST')
  roots={}
  for row in value['roots']:
    p=Path(row['path']); marker=p/row['marker']['relative']; info=p.stat()
    if info.st_dev != row['device'] or info.st_ino != row['inode'] or _sha(marker) != row['marker']['sha256']: raise ValueError('OWNED_MANIFEST')
    roots[str(p)]={}
  return {'rootCount':66,'ownedBytes':4096,'plannedBytes':planned_bytes,'availableBytes':64*1024**3,
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
def _validate_candidate_repository(window, runtime=None):
  candidate=window.get('candidateRepository') if isinstance(window,dict) else None
  if not isinstance(candidate,dict) or set(candidate) != {'root','branch','head'}: raise ValueError('CANDIDATE_REPOSITORY')
  root=Path(candidate['root']).resolve(strict=True)
  if Path(candidate['root']) != root or (runtime is not None and root == Path(runtime).resolve(strict=True).parents[2]): raise ValueError('CANDIDATE_REPOSITORY')
  def git(*args): return subprocess.check_output(['/usr/bin/git',*args],cwd=root,text=True).strip()
  if git('branch','--show-current') != candidate['branch'] or git('rev-parse','HEAD^{commit}') != candidate['head']: raise ValueError('CANDIDATE_REPOSITORY')
  return root
def _validate_measure_window(window, now):
  if not isinstance(window,dict) or set(window) != _MEASURE_KEYS or window.get('measurePlan') != _MEASURE_PLAN or window.get('limits') != _MEASURE_LIMITS: raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
  _validate_candidate_repository(window)
  return True
def _validate_measure_carryover(window_path, close_path, output_path, runtime, expected_window_sha256, expected_close_sha256, expected_command_sha256, expected_window_id, expected_label):
  global _LEGACY_CARRYOVER_EVIDENCE
  expected={'windowSha256':expected_window_sha256,'closeSha256':expected_close_sha256,'outputCommandSha256':expected_command_sha256,'windowId':expected_window_id,'label':expected_label}
  window_path=Path(window_path); close_path=Path(close_path); output_path=Path(output_path); runtime=Path(runtime)
  window,window_identity=_strict_json(window_path); close,close_identity=_strict_json(close_path)
  command,command_identity=_strict_json(output_path/'command.json')
  if window_path != runtime/'previous-measure-window'/'window.json' or close_path != runtime/'previous-measure-window'/'close.json' or output_path != runtime/expected['label']: raise ValueError('CARRYOVER_PATH')
  if window_identity['sha256'] != expected['windowSha256'] or close_identity['sha256'] != expected['closeSha256'] or command_identity['sha256'] != expected['outputCommandSha256']: raise ValueError('CARRYOVER_SHA')
  if window != {'schemaVersion':1,'scope':'musicbridge-capacity-measure-window','owner':'root','id':expected['windowId'],'state':'approved','phase':'measure','profile':'objects-limit','label':expected['label'],'n':105}: raise ValueError('CARRYOVER_WINDOW')
  if command != {'schemaVersion':1,'phase':'measure','profile':'objects-limit','window':expected['windowId'],'label':expected['label']}: raise ValueError('CARRYOVER_COMMAND')
  required={'schemaVersion':1,'scope':'musicbridge-capacity-measure-window-close','windowId':expected['windowId'],'windowSha256':expected['windowSha256'],'label':expected['label'],'state':'FAILED_EXECUTION_TIMEOUT','failure':'EXECUTION_TIMEOUT','partialPreserved':True,'receiptCount':29,'sampleCount':273,'retainedClone':'sample-30','groupEmpty':True,'zombies':[],'authorityStable':True,'verifiedPassed':False,'replayAllowed':False}
  if close != required: raise ValueError('CARRYOVER_CLOSE')
  receipts=list(output_path.glob('receipt-*.json'))
  samples=(output_path/'samples.jsonl').read_text().splitlines()
  if len(receipts) != 29 or len(samples) != 273 or not (output_path/'sample-30').is_dir(): raise ValueError('CARRYOVER_PARTIAL')
  def root(path, marker):
    info=path.stat()
    return {'path':str(path),'device':info.st_dev,'inode':info.st_ino,'marker':{'relative':marker,'sha256':_sha(path/marker)}}
  receipt_names=[f'sample-{index}.receipt.json' for index in range(1,30)]
  inventory=[{'name':name,'size':len((output_path/f'receipt-{index:03d}.json').read_bytes()),'sha256':_sha(output_path/f'receipt-{index:03d}.json')} for index,name in enumerate(receipt_names,1)]
  owner_path=output_path/'sample-30'/'owner.json'; sqlite_bytes=21
  files={'command.json':{'size':command_identity['size'],'sha256':command_identity['sha256']},'measurement.json':{'size':1,'sha256':'1'*64},'source-before.json':{'size':1,'sha256':'2'*64},'samples.jsonl':{'size':(output_path/'samples.jsonl').stat().st_size,'sha256':_sha(output_path/'samples.jsonl')}}
  _LEGACY_CARRYOVER_EVIDENCE={'format':'legacy-107-clone-partial-v1','windowId':window['id'],'label':window['label'],'windowSha256':window_identity['sha256'],'closeSha256':close_identity['sha256'],'commandSha256':command_identity['sha256'],'seedLabel':'objects-seed-old','seedSha256':'7'*64,'files':files,'receiptSha256':[row['sha256'] for row in inventory],'receiptManifestSha256':hashlib.sha256(json.dumps(inventory,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'retainedOwner':json.loads(owner_path.read_text()),'retainedOwnerSha256':_sha(owner_path),'sqliteBytes':sqlite_bytes,'wal':{'size':0,'sha256':hashlib.sha256(b'').hexdigest()},'shm':{'size':1,'sha256':'3'*64}}
  metric_counts={'progress':105,'signalAborted':28,'driverStopInvoked':28,'driverStopAck':28,'driverCloseInvoked':28,'driverCloseResolved':28,'receiptSettled':28}
  return {'valid':True,'terminal':{'windowId':window['id'],'label':window['label'],'state':'failed','failure':close['failure'],'windowSha256':window_identity['sha256'],'closeSha256':close_identity['sha256'],'groupEmpty':close['groupEmpty'],'zombies':close['zombies'],'authorityStable':close['authorityStable'],'replayAllowed':close['replayAllowed']},'partial':{'format':'legacy-107-clone-partial-v1','outputDirectory':str(output_path),'commandSha256':command_identity['sha256'],'partialExists':True,'partialPreserved':close['partialPreserved'],'verifiedPassed':close['verifiedPassed'],'sampleCount':close['sampleCount'],'receiptCount':close['receiptCount'],'samplesSha256':files['samples.jsonl']['sha256'],'samplesMatchReceipts':True,'receiptManifestSha256':_LEGACY_CARRYOVER_EVIDENCE['receiptManifestSha256'],'receiptNames':receipt_names,'metricCounts':metric_counts,'retainedDirectories':['sample-30'],'retainedClone':{'directoryName':'sample-30','ownerSha256':_LEGACY_CARRYOVER_EVIDENCE['retainedOwnerSha256'],'sqlite':{'size':sqlite_bytes,'nlink':1,'contentSha256Verified':False,'verification':'stable-lstat-size-only-no-content-read'},'wal':dict(_LEGACY_CARRYOVER_EVIDENCE['wal']),'shm':dict(_LEGACY_CARRYOVER_EVIDENCE['shm'])},'unexpectedEntries':[]},'roots':[root(window_path.parent,'owner.json'),root(output_path,'command.json')]}
`
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-measure-issuer-')))
  const generationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'musicbridge-generation-proof-')))
  const runtime = join(generationRoot, 'reports/runtime/task-078-v3-acceptance')
  mkdirSync(runtime, { recursive: true })
  const supervisor = join(root, 'scripts/ci/capacity-phase-supervisor-v2.py')
  mkdirSync(dirname(supervisor), { recursive: true })
  const sourcePaths = [
    'scripts/ci/capacity-phase-supervisor-v2.py',
    'scripts/ci/issue-v3-capacity-measure-window.py',
    ...Array.from({ length: 241 }, (_, index) => `candidate/source-${String(index + 1).padStart(3, '0')}.txt`),
  ]
  for (const relative of sourcePaths.slice(2)) {
    const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `candidate ${relative}\n`)
  }
  writeFileSync(supervisor, supervisorSource(sourcePaths))
  const generationSourcePaths = [
    'reports/runtime/task-078-v3-acceptance/capacity-phase-supervisor.py',
    'reports/runtime/task-078-v3-acceptance/test_capacity_phase_supervisor.py',
    ...sourcePaths.slice(2),
  ]
  for (const relative of generationSourcePaths) {
    const path = join(generationRoot, relative); mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `frozen generation ${relative}\n`)
  }
  execFileSync('/usr/bin/git', ['init', '-b', 'generation'], { cwd: generationRoot })
  git(generationRoot, 'config', 'user.email', 'test@example.invalid'); git(generationRoot, 'config', 'user.name', 'Test')
  git(generationRoot, 'add', 'candidate')
  git(generationRoot, 'commit', '-m', 'frozen generation candidate')
  const generationHead = git(generationRoot, 'rev-parse', 'HEAD')

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
  for (const relative of generationSourcePaths) sourcePins[relative] = sha(join(generationRoot, relative))
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

  const previousMeasure = join(runtime, 'previous-measure-window'); mkdirSync(previousMeasure)
  const previousMeasureId = randomUUID(), previousMeasureLabel = 'r023-objects-limit-measure-01'
  json(join(previousMeasure, 'owner.json'), { scope: 'musicbridge-capacity-measure-window', owner: 'root', id: previousMeasureId })
  const previousMeasureWindow = join(previousMeasure, 'window.json')
  json(previousMeasureWindow, {
    schemaVersion: 1, scope: 'musicbridge-capacity-measure-window', owner: 'root', id: previousMeasureId,
    state: 'approved', phase: 'measure', profile: 'objects-limit', label: previousMeasureLabel, n: 105,
  })
  const previousMeasureOutput = join(runtime, previousMeasureLabel); mkdirSync(previousMeasureOutput)
  const previousMeasureCommand = join(previousMeasureOutput, 'command.json')
  json(previousMeasureCommand, {
    schemaVersion: 1, phase: 'measure', profile: 'objects-limit', window: previousMeasureId, label: previousMeasureLabel,
  })
  for (let index = 1; index <= 29; index += 1) json(join(previousMeasureOutput, `receipt-${String(index).padStart(3, '0')}.json`), { index, outcome: 'ok' })
  writeFileSync(join(previousMeasureOutput, 'samples.jsonl'), Array.from({ length: 273 }, (_, index) => JSON.stringify({ index: index + 1, outcome: 'ok' })).join('\n') + '\n')
  mkdirSync(join(previousMeasureOutput, 'sample-30'))
  json(join(previousMeasureOutput, 'sample-30/owner.json'), { id: randomUUID(), scope: 'musicbridge-capacity-clone-only', label: 'sample-30' })
  const previousMeasureClose = join(previousMeasure, 'close.json')
  json(previousMeasureClose, {
    schemaVersion: 1, scope: 'musicbridge-capacity-measure-window-close', windowId: previousMeasureId,
    windowSha256: sha(previousMeasureWindow), label: previousMeasureLabel,
    state: 'FAILED_EXECUTION_TIMEOUT', failure: 'EXECUTION_TIMEOUT', partialPreserved: true,
    receiptCount: 29, sampleCount: 273, retainedClone: 'sample-30', groupEmpty: true, zombies: [],
    authorityStable: true, verifiedPassed: false, replayAllowed: false,
  })

  execFileSync('/usr/bin/git', ['init', '-b', 'main'], { cwd: root })
  git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test')
  const fixtureIssuer = join(root, 'scripts/ci/issue-v3-capacity-measure-window.py')
  const fixtureHelper = join(root, 'scripts/ci/issue-v3-capacity-window.py')
  mkdirSync(dirname(fixtureIssuer), { recursive: true })
  cpSync(sourceIssuer, fixtureIssuer); cpSync(sourceHelper, fixtureHelper)
  git(root, 'add', 'candidate', 'scripts/ci/issue-v3-capacity-measure-window.py', 'scripts/ci/issue-v3-capacity-window.py', 'scripts/ci/capacity-phase-supervisor-v2.py')
  git(root, 'commit', '-m', 'fixture candidate and issuers')
  const f = {
    root, generationRoot, generationHead, runtime, supervisor, sourcePaths, generationSourcePaths,
    generation, generationWindow, generationSupervisor,
    generationSource, generationOwned, seed, seedLabel, externalFixture,
    previousMeasure, previousMeasureId, previousMeasureLabel, previousMeasureWindow,
    previousMeasureClose, previousMeasureOutput, previousMeasureCommand,
    issuer: fixtureIssuer, helper: fixtureHelper, head: git(root, 'rev-parse', 'HEAD'),
  }
  return f
}

function recursiveFiles(directory, suffix) {
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...recursiveFiles(path, suffix))
    else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(path)
  }
  return result.sort()
}

function refreshGenerationSourceProof(f, sourcePins) {
  json(f.generationSource, { schemaVersion: 1, scope: 'musicbridge-capacity-source-pins', files: sourcePins })
  json(join(f.seed, 'source-before.json'), { files: sourcePins })
  cpSync(join(f.seed, 'source-before.json'), join(f.seed, 'source-after.json'))
  const window = JSON.parse(readFileSync(f.generationWindow))
  window.sourceManifest = { file: 'source-pins.json', sha256: sha(f.generationSource) }
  json(f.generationWindow, window)
  const proof = JSON.parse(readFileSync(f.generationSupervisor))
  proof.generation.windowSha256 = sha(f.generationWindow)
  proof.generation.sourceManifestSha256 = sha(f.generationSource)
  for (const name of ['source-before.json', 'source-after.json']) {
    proof.generation.files[name] = { exists: true, size: statSync(join(f.seed, name)).size, sha256: sha(join(f.seed, name)) }
  }
  json(f.generationSupervisor, proof)
}

function installDerivedGenerationProof(f) {
  const workspaceRoot = dirname(dirname(dirname(sourceIssuer)))
  const contractRoot = join(workspaceRoot, 'packages/contracts')
  for (const relative of ['packages/contracts/package.json', 'packages/contracts/tsconfig.json']) {
    const destination = join(f.generationRoot, relative); mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(workspaceRoot, relative), destination)
  }
  const sourceFiles = recursiveFiles(join(contractRoot, 'src'), '.ts')
  const distFiles = recursiveFiles(join(contractRoot, 'dist'), '.js')
  assert.equal(sourceFiles.length, 42); assert.equal(distFiles.length, 42)
  const sourcePaths = sourceFiles.map((path) => `packages/contracts/src/${path.slice(join(contractRoot, 'src').length + 1)}`)
  const distPaths = distFiles.map((path) => `packages/contracts/dist/${path.slice(join(contractRoot, 'dist').length + 1)}`)
  for (const [paths, base] of [[sourcePaths, workspaceRoot], [distPaths, workspaceRoot]]) {
    for (const relative of paths) {
      const destination = join(f.generationRoot, relative); mkdirSync(dirname(destination), { recursive: true })
      cpSync(join(base, relative), destination)
    }
  }
  git(f.generationRoot, 'add', 'packages/contracts/package.json', 'packages/contracts/tsconfig.json', 'packages/contracts/src')
  git(f.generationRoot, 'commit', '-m', 'frozen tracked contract inputs')
  f.generationHead = git(f.generationRoot, 'rev-parse', 'HEAD')
  const runtimeSources = f.generationSourcePaths.slice(0, 2)
  const fillers = f.generationSourcePaths.slice(2, 157)
  const frozenPaths = [...runtimeSources, 'packages/contracts/package.json', 'packages/contracts/tsconfig.json',
    ...sourcePaths, ...distPaths, ...fillers]
  assert.equal(frozenPaths.length, 243)
  const sourcePins = Object.fromEntries(frozenPaths.map((relative) => [relative, sha(join(f.generationRoot, relative))]))
  refreshGenerationSourceProof(f, sourcePins)
  return { distPaths, sourcePins }
}

function args(f, extra = []) {
  return [
    f.issuer, '--repo-root', f.root, '--runtime-root', f.runtime,
    '--generation-repo-root', f.generationRoot, '--expected-generation-branch', 'generation',
    '--expected-generation-head', f.generationHead,
    '--supervisor', f.supervisor, '--expected-supervisor-sha256', sha(f.supervisor),
    '--expected-source-count', '243', '--generation-window', f.generationWindow,
    '--expected-generation-window-sha256', sha(f.generationWindow),
    '--generation-supervisor', f.generationSupervisor,
    '--expected-generation-supervisor-sha256', sha(f.generationSupervisor),
    '--previous-measure-window', f.previousMeasureWindow,
    '--expected-previous-measure-window-id', f.previousMeasureId,
    '--expected-previous-measure-window-sha256', sha(f.previousMeasureWindow),
    '--previous-measure-close', f.previousMeasureClose,
    '--expected-previous-measure-close-sha256', sha(f.previousMeasureClose),
    '--previous-measure-output', f.previousMeasureOutput,
    '--expected-previous-measure-output-label', f.previousMeasureLabel,
    '--expected-previous-measure-output-command-sha256', sha(f.previousMeasureCommand),
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
function cleanup(f) { rmSync(f.root, { recursive: true, force: true }); rmSync(f.generationRoot, { recursive: true, force: true }); rmSync(f.externalFixture, { recursive: true, force: true }) }

test('签发 measure authority v2：65 个既存 roots 加唯一 future output，固定plan且不运行 benchmark', () => {
  const f = fixture()
  try {
    const result = run(f)
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    const parent = join(f.runtime, 'objects-measure-window')
    const window = JSON.parse(readFileSync(join(parent, 'window.json'), 'utf8'))
    const owned = JSON.parse(readFileSync(join(parent, 'owned-roots.json'), 'utf8'))
    assert.equal(owned.roots.length, 65)
    assert.equal(new Set(owned.roots.map((row) => row.path)).size, 65)
    assert.deepEqual(
      new Set(owned.roots.map((row) => row.path)),
      new Set([
        ...JSON.parse(readFileSync(f.generationOwned)).roots.map((row) => row.path),
        f.seed, f.externalFixture, f.previousMeasure, f.previousMeasureOutput,
        parent, join(parent, 'issuer-identity'),
      ]),
    )
    assert.deepEqual(owned.futureRoots, [join(f.runtime, 'objects-measure')])
    assert.equal(receipt.ownedRootCount, 66)
    assert.equal(window.scope, 'musicbridge-capacity-measure-window')
    assert.equal(window.profile, 'objects-limit'); assert.equal(window.label, 'objects-measure')
    assert.equal(window.seedLabel, f.seedLabel); assert.equal(window.n, 105)
    assert.deepEqual(window.measurePlan, { groupCloneCount: 3, fullHashCount: 3, stopRoundReceiptCount: 105, sampleCount: 1575 })
    assert.equal(Date.parse(window.deadlineAt) - Date.parse(window.issuedAt), 900_000)
    assert.equal(existsSync(join(f.runtime, 'objects-measure')), false)
    assert.equal(existsSync(join(parent, 'supervision')), false)
    assert.equal(existsSync(join(parent, 'window.pending.json')), false)
    const issuer = JSON.parse(readFileSync(join(parent, 'issuer-identity/owner.json'), 'utf8'))
    const installedSupervisor = join(parent, 'supervisor.py')
    assert.deepEqual(window.supervisor, { path: installedSupervisor, sha256: sha(f.supervisor) })
    assert.deepEqual(issuer.supervisor, window.supervisor)
    assert.equal(sha(installedSupervisor), sha(f.supervisor))
    assert.equal((execFileSync('/usr/bin/stat', ['-f', '%Lp', installedSupervisor], { encoding: 'utf8' }).trim()), '700')
    assert.equal(issuer.previousMeasure.window.id, f.previousMeasureId)
    assert.equal(issuer.previousMeasure.output.label, f.previousMeasureLabel)
    assert.equal(issuer.previousMeasure.partial.format, 'legacy-107-clone-partial-v1')
    assert.equal(issuer.previousMeasure.partial.receiptCount, 29)
    assert.equal(issuer.previousMeasure.partial.sampleCount, 273)
    assert.equal(issuer.previousMeasure.partial.receiptNames.length, 29)
    assert.match(issuer.previousMeasure.partial.receiptManifestSha256, /^[0-9a-f]{64}$/u)
    assert.equal(issuer.previousMeasure.partial.retainedClone.sqlite.contentSha256Verified, false)
    assert.deepEqual(issuer.measureRepository, { root: f.root, branch: 'main', head: f.head })
    assert.deepEqual(issuer.generationRepository, { root: f.generationRoot, branch: 'generation', head: f.generationHead })
    assert.notEqual(issuer.measureRepository.root, issuer.generationRepository.root)
    const currentSource = JSON.parse(readFileSync(join(parent, 'source-pins.json'), 'utf8'))
    assert.deepEqual(new Set(Object.keys(currentSource.files)), new Set(f.sourcePaths))
    assert.equal(Object.keys(currentSource.files).length, 243)
    assert.equal(currentSource.files['scripts/ci/capacity-phase-supervisor-v2.py'], sha(f.supervisor))
    assert.equal(currentSource.files['scripts/ci/issue-v3-capacity-measure-window.py'], sha(f.issuer))
    assert.deepEqual(window.candidateRepository, { root: f.root, branch: 'main', head: f.head })
    assert.deepEqual(receipt.consumeCommand, [python, installedSupervisor, '--window', join(parent, 'window.json'), '--window-sha256', sha(join(parent, 'window.json'))])
  } finally { cleanup(f) }
})

test('issuer窗口通过supervisor v2 exact-key与candidate repository消费前校验', () => {
  const f = fixture()
  try {
    const result = run(f)
    assert.equal(result.status, 0, result.stderr)
    const parent = join(f.runtime, 'objects-measure-window')
    const installedSupervisor = join(parent, 'supervisor.py')
    const validation = spawnSync(python, ['-c', [
      'import importlib.util,json,sys,time',
      "spec=importlib.util.spec_from_file_location('installed_supervisor',sys.argv[1])",
      'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
      'window=json.load(open(sys.argv[2]))',
      'module._validate_measure_window(window,time.time())',
      'module._validate_candidate_repository(window,sys.argv[3])',
    ].join(';'), installedSupervisor, join(parent, 'window.json'), f.runtime], { encoding: 'utf8' })
    assert.equal(validation.status, 0, validation.stderr)
  } finally { cleanup(f) }
})

test('production issuer与真实tracked supervisor v2精确互操作完整legacy partial合同', () => {
  const f = productionLegacyCarryoverFixture()
  try {
    const payload = {
      runtime: f.runtime, window: f.windowPath, close: f.closePath, output: f.output,
      windowId: f.windowId, label: f.label, evidence: f.evidence,
    }
    const bridge = [
      'import importlib.util,json,pathlib,sys,types',
      "def load(name,path):\n spec=importlib.util.spec_from_file_location(name,path); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module",
      "issuer=load('measure_issuer',sys.argv[1]); supervisor=load('tracked_supervisor',sys.argv[2]); helper=load('issuer_helper',sys.argv[3])",
      'payload=json.loads(sys.argv[4]); supervisor._LEGACY_CARRYOVER_EVIDENCE=payload["evidence"]',
      'strict_identity=supervisor._strict_identity; sha256=supervisor._sha',
      "def guarded_identity(file,maximum=None):\n if pathlib.Path(file).name=='sample.sqlite': raise AssertionError('sample.sqlite content read')\n return strict_identity(file,maximum)",
      "def guarded_sha(file):\n if pathlib.Path(file).name=='sample.sqlite': raise AssertionError('sample.sqlite content hash')\n return sha256(file)",
      'supervisor._strict_identity=guarded_identity; supervisor._sha=guarded_sha',
      'options=types.SimpleNamespace(previous_measure_window=payload["window"],expected_previous_measure_window_sha256=payload["evidence"]["windowSha256"],previous_measure_close=payload["close"],expected_previous_measure_close_sha256=payload["evidence"]["closeSha256"],previous_measure_output=payload["output"],expected_previous_measure_output_label=payload["label"],expected_previous_measure_output_command_sha256=payload["evidence"]["commandSha256"],expected_previous_measure_window_id=payload["windowId"])',
      'value=issuer.validate_measure_carryover(helper,supervisor,options,pathlib.Path(payload["runtime"]))',
      'print(json.dumps({"partial":value["partial"],"roots":value["roots"]}))',
    ].join('\n')
    const result = spawnSync(python, ['-c', bridge, sourceIssuer, sourceTrackedSupervisor, sourceHelper, JSON.stringify(payload)], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const observed = JSON.parse(result.stdout)
    assert.equal(observed.partial.format, 'legacy-107-clone-partial-v1')
    assert.equal(observed.partial.receiptCount, 29); assert.equal(observed.partial.sampleCount, 273)
    assert.equal(observed.partial.receiptManifestSha256, f.evidence.receiptManifestSha256)
    assert.equal(observed.partial.retainedClone.sqlite.contentSha256Verified, false)
    assert.equal(observed.roots.length, 2)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('measure与generation仓库身份不可合并，generation HEAD漂移也拒绝签发', () => {
  for (const extra of [
    (f) => ['--expected-generation-head', '0'.repeat(40)],
    (f) => ['--generation-repo-root', f.root, '--expected-generation-branch', 'main', '--expected-generation-head', f.head],
  ]) {
    const f = fixture()
    try {
      const result = run(f, extra(f))
      assert.notEqual(result.status, 0); assert.match(result.stderr, /REPOSITORY_IDENTITY/)
      assert.equal(existsSync(join(f.runtime, 'objects-measure-window')), false)
    } finally { cleanup(f) }
  }
})

test('旧 generation source proof保持冻结时，当前候选source可由新HEAD独立重签', () => {
  const f = fixture()
  try {
    const changed = join(f.root, f.sourcePaths[2])
    writeFileSync(changed, 'candidate v2 source\n')
    git(f.root, 'add', f.sourcePaths[2]); git(f.root, 'commit', '-m', 'candidate v2 source')
    f.head = git(f.root, 'rev-parse', 'HEAD')
    const result = run(f)
    assert.equal(result.status, 0, result.stderr)
    const parent = join(f.runtime, 'objects-measure-window')
    const source = JSON.parse(readFileSync(join(parent, 'source-pins.json'), 'utf8'))
    const frozen = JSON.parse(readFileSync(f.generationSource, 'utf8'))
    assert.notEqual(source.files[f.sourcePaths[2]], frozen.files[f.generationSourcePaths[2]])
    assert.equal(source.files[f.sourcePaths[2]], sha(changed))
  } finally { cleanup(f) }
})

test('generation冻结manifest允许42个untracked dist且必须由受控构建逐字重算', () => {
  {
    const f = fixture()
    try {
      installDerivedGenerationProof(f)
      const result = run(f)
      assert.equal(result.status, 0, result.stderr)
    } finally { cleanup(f) }
  }
  for (const freezeTamper of [false, true]) {
    const f = fixture()
    try {
      const derived = installDerivedGenerationProof(f)
      const target = join(f.generationRoot, derived.distPaths[0])
      writeFileSync(target, 'tampered derived output\n')
      if (freezeTamper) {
        derived.sourcePins[derived.distPaths[0]] = sha(target)
        refreshGenerationSourceProof(f, derived.sourcePins)
      }
      const result = run(f)
      assert.notEqual(result.status, 0); assert.match(result.stderr, /GENERATION_PROOF/)
      assert.equal(existsSync(join(f.runtime, 'objects-measure-window/window.json')), false)
    } finally { cleanup(f) }
  }
})

test('旧 terminal/partial 任一事实、文件数量或marker漂移都拒绝签发', () => {
  for (const mutate of [
    (f) => { const close = JSON.parse(readFileSync(f.previousMeasureClose)); close.receiptCount = 30; json(f.previousMeasureClose, close); return ['--expected-previous-measure-close-sha256', sha(f.previousMeasureClose)] },
    (f) => { rmSync(join(f.previousMeasureOutput, 'receipt-029.json')); return [] },
    (f) => { const command = JSON.parse(readFileSync(f.previousMeasureCommand)); command.label = 'drift'; json(f.previousMeasureCommand, command); return ['--expected-previous-measure-output-command-sha256', sha(f.previousMeasureCommand)] },
    (f) => { rmSync(join(f.previousMeasureOutput, 'sample-30'), { recursive: true }); return [] },
  ]) {
    const f = fixture()
    try {
      const result = run(f, mutate(f))
      assert.notEqual(result.status, 0); assert.match(result.stderr, /MEASURE_CARRYOVER/)
      assert.equal(existsSync(join(f.runtime, 'objects-measure-window/window.json')), false)
    } finally { cleanup(f) }
  }
})

test('旧 window root 或 partial root 缺失、漂移、symlink 均拒绝继承闭包', () => {
  for (const mutate of [
    (f) => rmSync(join(f.previousMeasure, 'owner.json')),
    (f) => json(join(f.previousMeasure, 'owner.json'), { scope: 'drift', owner: 'root', id: f.previousMeasureId }),
    (f) => { const marker = join(f.previousMeasureOutput, 'command.json'); const target = `${marker}.target`; cpSync(marker, target); rmSync(marker); symlinkSync(target, marker) },
  ]) {
    const f = fixture()
    try {
      mutate(f); const result = run(f)
      assert.notEqual(result.status, 0); assert.match(result.stderr, /MEASURE_CARRYOVER|OWNED/)
      assert.equal(existsSync(join(f.runtime, 'objects-measure-window/window.json')), false)
    } finally { cleanup(f) }
  }
})

test('supervisor 若仍声明107次full-hash旧结构，签发前fail-closed', () => {
  const f = fixture()
  try {
    writeFileSync(f.supervisor, readFileSync(f.supervisor, 'utf8').replace("'groupCloneCount':3,'fullHashCount':3", "'groupCloneCount':107,'fullHashCount':107"))
    const result = run(f, ['--expected-supervisor-sha256', sha(f.supervisor)])
    assert.notEqual(result.status, 0); assert.match(result.stderr, /SUPERVISOR_CONTRACT/)
    assert.equal(existsSync(join(f.runtime, 'objects-measure-window')), false)
  } finally { cleanup(f) }
})

test('supervisor source 与expected issuer HEAD的tracked blob不一致时拒绝，且不安装副本', () => {
  const f = fixture()
  try {
    writeFileSync(f.supervisor, `${readFileSync(f.supervisor, 'utf8')}\n# drift\n`)
    const result = run(f, ['--expected-supervisor-sha256', sha(f.supervisor)])
    assert.notEqual(result.status, 0); assert.match(result.stderr, /REPOSITORY_IDENTITY|SUPERVISOR_IDENTITY/)
    assert.equal(existsSync(join(f.runtime, 'objects-measure-window/supervisor.py')), false)
  } finally { cleanup(f) }
})

test('supervisor O_EXCL安装失败时terminal fail-closed，不发布window', () => {
  const f = fixture()
  try {
    const injection = [
      'import importlib.util, sys',
      "spec=importlib.util.spec_from_file_location('issuer_under_test', sys.argv[1])",
      'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
      'original=module.os.open',
      "def reject(path,flags,*rest):\n if str(path).endswith('/supervisor.py') and flags & module.os.O_EXCL: raise OSError('injected copy failure')\n return original(path,flags,*rest)",
      'module.os.open=reject',
      'raise SystemExit(module.main(sys.argv[2:]))',
    ].join('\n')
    const result = spawnSync(python, ['-c', injection, f.issuer, ...args(f).slice(1)], { encoding: 'utf8' })
    assert.notEqual(result.status, 0); assert.match(result.stderr, /SUPERVISOR_INSTALL/)
    assert.equal(existsSync(join(f.runtime, 'objects-measure-window/window.json')), false)
  } finally { cleanup(f) }
})

test('pending window的per-window supervisor绑定漂移时发布前拒绝', () => {
  const f = fixture()
  try {
    const injection = [
      'import importlib.util, json, sys',
      "spec=importlib.util.spec_from_file_location('issuer_under_test', sys.argv[1])",
      'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
      'original=module.os.rename',
      "def drift(source,target):\n if str(source).endswith('window.pending.json'):\n  value=json.loads(open(source).read()); value['supervisor']['sha256']='0'*64; open(source,'w').write(json.dumps(value)+'\\n')\n return original(source,target)",
      'module.os.rename=drift',
      'raise SystemExit(module.main(sys.argv[2:]))',
    ].join('\n')
    const result = spawnSync(python, ['-c', injection, f.issuer, ...args(f).slice(1)], { encoding: 'utf8' })
    assert.notEqual(result.status, 0); assert.match(result.stderr, /SUPERVISOR_IDENTITY/)
    assert.equal(existsSync(join(f.runtime, 'objects-measure-window/window.json')), false)
  } finally { cleanup(f) }
})

test('generation supervisor proof 或 source pins 漂移时 terminal fail-closed', () => {
  for (const mutate of [
    (f) => { const proof = JSON.parse(readFileSync(f.generationSupervisor)); proof.generation.checkpointCount = 556; json(f.generationSupervisor, proof) },
    (f) => { const proof = JSON.parse(readFileSync(f.generationSupervisor)); delete proof.generation.authority; json(f.generationSupervisor, proof) },
    (f) => { writeFileSync(join(f.root, f.sourcePaths[2]), 'drift\n') },
    (f) => { writeFileSync(join(f.generationRoot, f.generationSourcePaths[2]), 'frozen drift\n') },
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
