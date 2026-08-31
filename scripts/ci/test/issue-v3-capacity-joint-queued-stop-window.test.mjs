import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const jointIssuer = new URL('../issue-v3-capacity-joint-queued-stop-window.py', import.meta.url)
const objectsIssuer = new URL('../issue-v3-capacity-queued-stop-window.py', import.meta.url)
const supervisor = new URL('../capacity-phase-supervisor-v2.py', import.meta.url)

test('joint queued-stop必须有专用issuer和独立消费合同', () => {
  assert.equal(existsSync(jointIssuer), true, '缺少专用joint queued-stop issuer')
  const jointSource = readFileSync(jointIssuer, 'utf8')
  const objectsSource = readFileSync(objectsIssuer, 'utf8')
  const supervisorSource = readFileSync(supervisor, 'utf8')
  assert.match(jointSource, /joint:measure:PASS/u)
  assert.match(jointSource, /'profile': 'joint'/u)
  assert.match(objectsSource, /choices=\('objects-limit',\)/u)
  assert.doesNotMatch(objectsSource, /choices=\('objects-limit', 'joint'\)/u)
  assert.match(supervisorSource, /'profile': 'objects-limit'/u)
  assert.match(supervisorSource, /--profile', 'objects-limit'/u)
})

function python(source) {
  const result = spawnSync('/usr/bin/python3', ['-c', source], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('joint measure PASS逐字段校验且只构造joint queued-stop窗口', () => {
  const modulePath = JSON.stringify(jointIssuer.pathname)
  const supervisorPath = JSON.stringify(supervisor.pathname)
  const value = python(`
import copy, datetime, hashlib, json, pathlib, runpy, subprocess, uuid
m = runpy.run_path(${modulePath}, run_name='joint_queued_stop_test')
s = runpy.run_path(${supervisorPath}, run_name='joint_queued_stop_supervisor_test')
supervisor_path = pathlib.Path(${supervisorPath}).resolve()
repo = supervisor_path.parents[2]
supervisor_sha = hashlib.sha256(supervisor_path.read_bytes()).hexdigest()
branch = subprocess.check_output(['/usr/bin/git','branch','--show-current'], cwd=repo, text=True).strip()
head = subprocess.check_output(['/usr/bin/git','rev-parse','HEAD^{commit}'], cwd=repo, text=True).strip()
h = 'a' * 64
measurement = {'verifiedComplete': True, 'verifiedPassed': True, 'summaryComplete': True,
 'thresholdPassed': True, 'sourceBeforeEqualsAfter': True, 'fixtureBeforeEqualsAfter': True,
 'authorityStable': True, 'sampleCount': 1575, 'roundReceiptCount': 105,
 'aggregateBudgetValid': True}
window = {'scope': 'musicbridge-capacity-measure-window', 'phase': 'measure',
 'profile': 'joint', 'state': 'approved', 'id': str(uuid.uuid4()), 'label': 'joint-measure', 'n': 105}
close = {'scope': 'musicbridge-capacity-measure-window-close', 'windowId': window['id'],
 'profile': 'joint', 'state': 'passed', 'failure': None, 'code': 0, 'signals': [],
 'groupEmpty': True, 'zombies': [], 'deviceOpened': False, 'formalReady': False,
 'gateB': 'NOT_RUN', 'replayPolicy': 'terminal-window-id-and-label-never-reuse',
 'measurement': measurement}
supervision = {'passed': True, 'failure': None, 'code': 0, 'groupEmpty': True,
 'zombies': [], 'measurement': measurement}
files = {key: h for key in ('windowSha256','closeSha256','supervisionSha256',
 'ownedManifestSha256','sourceManifestSha256','seedMetadataSha256',
 'seedSnapshotSha256','fixtureOwnerSha256','commandSha256')}
fact = m['validate_joint_measure_pass']({'window': window, 'close': close,
 'supervision': supervision, 'files': files})
bad = copy.deepcopy(measurement); bad['roundReceiptCount'] = 104
rejected = False
try:
 close_bad = {**close, 'measurement': bad}
 m['validate_joint_measure_pass']({'window': window, 'close': close_bad,
  'supervision': {**supervision, 'measurement': bad}, 'files': files})
except m['IssueError']:
 rejected = True
carry = {'window': {'path': '/runtime/measure/window.json', 'id': window['id'], 'sha256': h},
 'close': {'path': '/runtime/measure/close.json', 'sha256': h},
 'ownedManifest': {'path': '/runtime/measure/owned-roots.json', 'sha256': h},
 'sourceManifest': {'path': '/runtime/measure/source-pins.json', 'sha256': h},
 'supervision': {'path': '/runtime/measure/supervision/supervisor.json', 'sha256': h},
 'supervisor': {'path': '/runtime/measure/supervisor.py', 'sha256': h},
 'output': {'path': '/runtime/joint-measure', 'label': 'joint-measure', 'commandSha256': h}}
now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=123000)
payload = m['build_authority_payload'](predecessor={'fact': fact, 'carryover': carry},
 window_id=str(uuid.uuid4()), label='joint-queued-stop', issued_at=now.isoformat(),
 deadline_at=(now + datetime.timedelta(seconds=900)).isoformat(), owned_sha=h,
 source_sha=h, supervisor=str(supervisor_path), supervisor_sha=supervisor_sha,
 candidate={'root':str(repo),'branch':branch,'head':head}, node='/node', node_sha=h,
 tsx_loader='/tsx', tsx_sha=h, consumer='/python', consumer_sha=h,
 issuer='/repo/issuer.py', issuer_sha=h, issuer_fact_path='/runtime/window/issuer-identity/owner.json',
 issuer_fact_sha=h, shared_helper='/repo/scripts/ci/issue-v3-capacity-joint-measure-window.py',
 shared_helper_sha=h, snapshot_bytes=123456)
s['_validate_joint_queued_stop_window'](payload['window'], now.timestamp() + 0.001)
wrong = copy.deepcopy(payload['window']); wrong['issuerFailureCarryoverCount'] = 1
supervisor_rejected = False
try:
 s['_validate_joint_queued_stop_window'](wrong, now.timestamp() + 0.001)
except SystemExit:
 supervisor_rejected = True
print(json.dumps({'rejected': rejected, 'profile': payload['window']['profile'],
 'phase': payload['window']['phase'], 'counts': payload['window']['queuedStopPlan'],
 'failureCountsPresent': any(key.endswith('FailureCarryoverCount') for key in payload['window']),
 'inherited': payload['issuerFact']['authorityInherited'], 'supervisorRejected': supervisor_rejected}))
`)
  assert.equal(value.rejected, true)
  assert.equal(value.profile, 'joint')
  assert.equal(value.phase, 'queued-stop')
  assert.equal(value.counts.warmupCount, 5)
  assert.equal(value.counts.formalCount, 100)
  assert.equal(value.counts.sampleCount, 105)
  assert.equal(value.failureCountsPresent, false)
  assert.equal(value.inherited, false)
  assert.equal(value.supervisorRejected, true)
})
