#!/usr/bin/env python3
"""签发 joint queued-stop 一次性 authority；只消费 joint:measure:PASS，不执行 benchmark。"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import uuid


SHA256 = re.compile(r'^[0-9a-f]{64}$', re.ASCII)
GIT_SHA = re.compile(r'^[0-9a-f]{40}$', re.ASCII)
SAFE = re.compile(r'^[a-z0-9-]{1,64}$', re.ASCII)
QUEUED_LIMITS = {'executionMs': 50_000, 'killGraceMs': 1_000, 'closeMs': 2_000,
                 'minimumFreeBytes': 10 * 1024 ** 3, 'maximumOwnedBytes': 16 * 1024 ** 3}
ALLOWANCE = 256 * 1024 ** 2
AUDIT = 'queued-stop-aggregate-budget.jsonl'
MODEL = 'serial-single-clone-plus-bounded-growth-v1'
_FAILURE_CONTEXT = None

_SHARED_PATH = Path(__file__).with_name('issue-v3-capacity-joint-measure-window.py')
_SHARED = runpy.run_path(str(_SHARED_PATH), run_name='musicbridge_joint_queued_stop_shared')
IssueError = _SHARED['IssueError']
_strict_json = _SHARED['_strict_json']
_stable_sha256 = _SHARED['_stable_sha256']
_canonical_directory = _SHARED['_canonical_directory']
_verified_file = _SHARED['_verified_file']
_git = _SHARED['_git']
_source_manifest = _SHARED['_source_manifest']
_owned_root = _SHARED['_owned_root']
_current_root = _SHARED['_current_root']
_exclusive_json = _SHARED['_exclusive_json']
_copy_verified = _SHARED['_copy_verified']
_reject_replay = _SHARED['_reject_replay']
_fsync_directory = _SHARED['_fsync_directory']


def fail(code):
    raise IssueError(code)


def _candidate(root, branch, head, issuer, issuer_sha, supervisor, supervisor_sha):
    if GIT_SHA.fullmatch(str(head or '')) is None or not branch \
            or _git(root, 'rev-parse', '--show-toplevel') != str(root) \
            or _git(root, 'rev-parse', 'HEAD^{commit}') != head \
            or _git(root, 'branch', '--show-current') != branch \
            or _git(root, 'status', '--porcelain=v1', '--untracked-files=all'):
        fail('REPOSITORY_IDENTITY')
    expected_issuer = root / 'scripts/ci/issue-v3-capacity-joint-queued-stop-window.py'
    expected_supervisor = root / 'scripts/ci/capacity-phase-supervisor-v2.py'
    if issuer != expected_issuer or supervisor != expected_supervisor:
        fail('CANDIDATE_FILE_IDENTITY')
    for path, digest, code in ((issuer, issuer_sha, 'ISSUER_IDENTITY'),
                               (supervisor, supervisor_sha, 'SUPERVISOR_IDENTITY')):
        blob = _git(root, 'show', f'{head}:{path.relative_to(root)}', binary=True)
        if hashlib.sha256(blob).hexdigest() != digest:
            fail(code)
    return {'root': str(root), 'branch': branch, 'head': head}


def validate_joint_measure_pass(value):
    """独立判定完整 joint measure 终态；单独 exit 0 或 supervisor code 0 均不构成PASS。"""
    try:
        window = value['window']; close = value['close']; supervision = value['supervision']
        measurement = close['measurement']; files = value['files']
        required_files = {'windowSha256', 'closeSha256', 'supervisionSha256',
                          'ownedManifestSha256', 'sourceManifestSha256',
                          'seedMetadataSha256', 'seedSnapshotSha256',
                          'fixtureOwnerSha256', 'commandSha256'}
        if window.get('scope') != 'musicbridge-capacity-measure-window' \
                or window.get('phase') != 'measure' or window.get('profile') != 'joint' \
                or window.get('state') != 'approved' or window.get('n') != 105 \
                or SAFE.fullmatch(str(window.get('label', ''))) is None \
                or close.get('scope') != 'musicbridge-capacity-measure-window-close' \
                or close.get('windowId') != window.get('id') or close.get('profile') != 'joint' \
                or close.get('state') != 'passed' or close.get('failure') is not None \
                or close.get('code') != 0 or close.get('signals') != [] \
                or close.get('groupEmpty') is not True or close.get('zombies') != [] \
                or close.get('deviceOpened') is not False or close.get('formalReady') is not False \
                or close.get('gateB') != 'NOT_RUN' \
                or close.get('replayPolicy') != 'terminal-window-id-and-label-never-reuse' \
                or supervision.get('passed') is not True or supervision.get('failure') is not None \
                or supervision.get('code') != 0 or supervision.get('groupEmpty') is not True \
                or supervision.get('zombies') != [] or supervision.get('measurement') != measurement \
                or measurement.get('verifiedComplete') is not True \
                or measurement.get('verifiedPassed') is not True \
                or measurement.get('summaryComplete') is not True \
                or measurement.get('thresholdPassed') is not True \
                or measurement.get('sourceBeforeEqualsAfter') is not True \
                or measurement.get('fixtureBeforeEqualsAfter') is not True \
                or measurement.get('authorityStable') is not True \
                or measurement.get('sampleCount') != 1575 \
                or measurement.get('roundReceiptCount') != 105 \
                or measurement.get('aggregateBudgetValid') is not True \
                or set(files) != required_files \
                or any(SHA256.fullmatch(str(files.get(key, ''))) is None for key in files):
            fail('JOINT_MEASURE_PASS')
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise IssueError('JOINT_MEASURE_PASS') from error
    return {'requiredResult': 'joint:measure:PASS', 'windowId': window['id'],
            'label': window['label'], **files}


def load_joint_measure_pass(*, window_path, window_sha, close_path, close_sha,
                            supervision_path, supervision_sha, owned_path, owned_sha,
                            source_path, source_sha, runtime):
    parent = Path(window_path).parent
    if parent.parent != runtime or Path(close_path).parent != parent \
            or Path(owned_path).parent != parent or Path(source_path).parent != parent \
            or Path(supervision_path) != parent / 'supervision' / 'supervisor.json':
        fail('JOINT_MEASURE_PASS')
    window = _strict_json(window_path, window_sha); close = _strict_json(close_path, close_sha)
    supervision = _strict_json(supervision_path, supervision_sha)
    owned = _strict_json(owned_path, owned_sha); source = _strict_json(source_path, source_sha)
    installed = parent / 'supervisor.py'; _, installed_sha = _stable_sha256(installed, 'JOINT_MEASURE_PASS')
    output = Path(str(supervision.get('measurement', {}).get('outputDirectory', '')))
    if output != runtime / window.get('label', '') or not output.is_dir() \
            or close.get('windowSha256') != window_sha \
            or close.get('ownedManifestSha256') != owned_sha \
            or close.get('sourceManifestSha256') != source_sha \
            or close.get('supervisorSha256') != supervision_sha \
            or window.get('supervisor') != {'path': str(installed), 'sha256': installed_sha} \
            or owned.get('scope') != 'musicbridge-capacity-owned-roots' \
            or owned.get('windowId') != window.get('id') or not isinstance(owned.get('roots'), list) \
            or owned.get('futureRoots') != [str(output)] \
            or source.get('scope') != 'musicbridge-capacity-source-pins' \
            or not isinstance(source.get('files'), dict):
        fail('JOINT_MEASURE_PASS')
    seed = window.get('seed', {}); command_sha = _stable_sha256(output / 'command.json', 'JOINT_MEASURE_PASS')[1]
    predecessor = validate_joint_measure_pass({'window': window, 'close': close,
        'supervision': supervision, 'files': {'windowSha256': window_sha, 'closeSha256': close_sha,
        'supervisionSha256': supervision_sha, 'ownedManifestSha256': owned_sha,
        'sourceManifestSha256': source_sha, 'seedMetadataSha256': seed.get('metadataSha256'),
        'seedSnapshotSha256': seed.get('snapshotSha256'),
        'fixtureOwnerSha256': seed.get('fixtureOwnerSha256'), 'commandSha256': command_sha}})
    return predecessor, window, close, supervision, owned, source, output, installed_sha


def build_authority_payload(*, predecessor, window_id, label, issued_at, deadline_at,
                            owned_sha, source_sha, supervisor, supervisor_sha, candidate,
                            node, node_sha, tsx_loader, tsx_sha, consumer, consumer_sha,
                            issuer, issuer_sha, issuer_fact_path, issuer_fact_sha,
                            snapshot_bytes):
    issued = datetime.datetime.fromisoformat(issued_at); deadline = datetime.datetime.fromisoformat(deadline_at)
    if deadline - issued != datetime.timedelta(seconds=900) or snapshot_bytes <= 0:
        fail('AUTHORITY_PAYLOAD')
    carry = predecessor['carryover']; predecessor_fact = predecessor['fact']
    plan = {'warmupCount': 5, 'formalCount': 100, 'sampleCount': 105,
            'activeCloneMaximum': 1, 'snapshotBytes': snapshot_bytes,
            'evidenceAllowanceBytes': ALLOWANCE, 'plannedBytes': snapshot_bytes + ALLOWANCE,
            'model': MODEL, 'aggregateAudit': AUDIT}
    window = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-queued-stop-window',
              'owner': 'root', 'id': window_id, 'state': 'approved', 'phase': 'queued-stop',
              'profile': 'joint', 'label': label, 'seedLabel': predecessor_fact['label'],
              'seed': {'label': predecessor_fact['label'],
                       'metadataSha256': predecessor_fact['seedMetadataSha256'],
                       'snapshotSha256': predecessor_fact['seedSnapshotSha256'],
                       'fixtureOwnerSha256': predecessor_fact['fixtureOwnerSha256']},
              'n': 105, 'issuedAt': issued_at, 'deadlineAt': deadline_at,
              'limits': dict(QUEUED_LIMITS),
              'ownedManifest': {'file': 'owned-roots.json', 'sha256': owned_sha},
              'sourceManifest': {'file': 'source-pins.json', 'sha256': source_sha},
              'queuedStopPlan': plan,
              'supervisor': {'path': supervisor, 'sha256': supervisor_sha},
              'candidateRepository': dict(candidate),
              'toolchain': {'node': {'path': node, 'sha256': node_sha},
                            'tsxLoader': {'path': tsx_loader, 'sha256': tsx_sha},
                            'consumerPython': {'path': consumer, 'sha256': consumer_sha}},
              'issuer': {'path': issuer, 'sha256': issuer_sha,
                         'fact': {'path': issuer_fact_path, 'sha256': issuer_fact_sha}},
              'measureCarryover': carry}
    fact = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-joint-queued-stop-authority-issuer',
            'windowId': window_id, 'candidateRepository': dict(candidate),
            'predecessor': predecessor_fact,
            'supervisorSource': {'path': str(Path(candidate['root']) / 'scripts/ci/capacity-phase-supervisor-v2.py'),
                                 'relativePath': 'scripts/ci/capacity-phase-supervisor-v2.py',
                                 'sha256': supervisor_sha},
            'toolchain': window['toolchain'], 'issuer': {'path': issuer, 'sha256': issuer_sha},
            'authorityInherited': False, 'receiptReuseAllowed': False,
            'oldWindowReplayAllowed': False, 'deviceOpened': False,
            'formalReady': False, 'gateB': 'NOT_RUN'}
    return {'window': window, 'issuerFact': fact}


def _parse_args(argv):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    for name in ('repo-root', 'runtime-root', 'joint-measure-window',
                 'expected-joint-measure-window-sha256', 'joint-measure-close',
                 'expected-joint-measure-close-sha256', 'joint-measure-supervision',
                 'expected-joint-measure-supervision-sha256', 'joint-measure-owned-manifest',
                 'expected-joint-measure-owned-sha256', 'joint-measure-source-manifest',
                 'expected-joint-measure-source-sha256', 'window-dir-name', 'label',
                 'expected-branch', 'expected-head', 'supervisor',
                 'expected-supervisor-sha256', 'node', 'expected-node-sha256',
                 'tsx-loader', 'expected-tsx-loader-sha256', 'consumer-python',
                 'expected-consumer-sha256', 'expected-issuer-sha256'):
        parser.add_argument(f'--{name}', required=True)
    parser.add_argument('--expected-source-count', required=True, type=int)
    return parser.parse_args(argv)


def _record_failure(code):
    if _FAILURE_CONTEXT is None: return
    try:
        _exclusive_json(_FAILURE_CONTEXT['parent'] / 'issuer-failure.json', {
            'schemaVersion': 1, 'scope': 'musicbridge-capacity-joint-queued-stop-authority-issuer-failure',
            'state': 'TERMINAL_ISSUER_FAILURE', 'windowId': _FAILURE_CONTEXT['windowId'],
            'label': _FAILURE_CONTEXT['label'], 'errorCode': code,
            'windowWritten': (_FAILURE_CONTEXT['parent'] / 'window.json').is_file(),
            'replayAllowed': False,
            'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')})
        _fsync_directory(_FAILURE_CONTEXT['parent']); _fsync_directory(_FAILURE_CONTEXT['runtime'])
    except Exception:
        pass


def issue(options):
    global _FAILURE_CONTEXT
    root = _canonical_directory(options.repo_root, 'REPOSITORY_IDENTITY')
    runtime = _canonical_directory(options.runtime_root, 'RUNTIME_IDENTITY')
    if SAFE.fullmatch(options.window_dir_name or '') is None or SAFE.fullmatch(options.label or '') is None:
        fail('LABEL_INVALID')
    issuer = _verified_file(Path(__file__).resolve(strict=True), options.expected_issuer_sha256, 'ISSUER_IDENTITY')
    supervisor = _verified_file(options.supervisor, options.expected_supervisor_sha256, 'SUPERVISOR_IDENTITY')
    node = _verified_file(options.node, options.expected_node_sha256, 'NODE_IDENTITY', executable=True, allow_hardlinks=True)
    tsx_loader = _verified_file(options.tsx_loader, options.expected_tsx_loader_sha256, 'TSX_IDENTITY', allow_hardlinks=True)
    consumer = _verified_file(options.consumer_python, options.expected_consumer_sha256,
                              'CONSUMER_IDENTITY', executable=True, allow_hardlinks=True)
    candidate = _candidate(root, options.expected_branch, options.expected_head, issuer,
                           options.expected_issuer_sha256, supervisor, options.expected_supervisor_sha256)
    result = load_joint_measure_pass(
        window_path=options.joint_measure_window,
        window_sha=options.expected_joint_measure_window_sha256,
        close_path=options.joint_measure_close, close_sha=options.expected_joint_measure_close_sha256,
        supervision_path=options.joint_measure_supervision,
        supervision_sha=options.expected_joint_measure_supervision_sha256,
        owned_path=options.joint_measure_owned_manifest,
        owned_sha=options.expected_joint_measure_owned_sha256,
        source_path=options.joint_measure_source_manifest,
        source_sha=options.expected_joint_measure_source_sha256, runtime=runtime)
    predecessor_fact, measure_window, _, _, measure_owned, _, measure_output, _ = result
    seed_directory = runtime / measure_window['seedLabel']; fixture_directory = Path(
        _strict_json(seed_directory / 'seed.json', predecessor_fact['seedMetadataSha256'])['fixtureDirectory'])
    snapshot_bytes = (seed_directory / 'seed.sqlite').stat().st_size
    carry = {'window': {'path': options.joint_measure_window, 'id': predecessor_fact['windowId'],
                        'sha256': predecessor_fact['windowSha256']},
             'close': {'path': options.joint_measure_close, 'sha256': predecessor_fact['closeSha256']},
             'ownedManifest': {'path': options.joint_measure_owned_manifest,
                               'sha256': predecessor_fact['ownedManifestSha256']},
             'sourceManifest': {'path': options.joint_measure_source_manifest,
                                'sha256': predecessor_fact['sourceManifestSha256']},
             'supervision': {'path': options.joint_measure_supervision,
                             'sha256': predecessor_fact['supervisionSha256']},
             'supervisor': {'path': str(Path(options.joint_measure_window).parent / 'supervisor.py'),
                            'sha256': measure_window['supervisor']['sha256']},
             'output': {'path': str(measure_output), 'label': measure_window['label'],
                        'commandSha256': predecessor_fact['commandSha256']}}
    predecessor = {'fact': predecessor_fact, 'carryover': carry}
    parent = runtime / options.window_dir_name; _reject_replay(runtime, parent, options.label)
    source = _source_manifest(root, options.expected_head, options.expected_source_count)
    window_id = str(uuid.uuid4()); parent.mkdir(mode=0o700)
    _FAILURE_CONTEXT = {'parent': parent, 'runtime': runtime, 'windowId': window_id, 'label': options.label}
    owner_sha = _exclusive_json(parent / 'owner.json', {
        'scope': 'musicbridge-capacity-queued-stop-window', 'owner': 'root', 'id': window_id})
    issuer_identity = parent / 'issuer-identity'; issuer_identity.mkdir(mode=0o700)
    installed = parent / 'supervisor.py'; _copy_verified(supervisor, installed, options.expected_supervisor_sha256)
    issued = datetime.datetime.now(datetime.timezone.utc)
    issued_at = issued.isoformat(timespec='milliseconds'); deadline_at = (
        issued + datetime.timedelta(seconds=900)).isoformat(timespec='milliseconds')
    placeholder = '0' * 64; fact_path = issuer_identity / 'owner.json'
    first = build_authority_payload(
        predecessor=predecessor, window_id=window_id, label=options.label,
        issued_at=issued_at, deadline_at=deadline_at, owned_sha=placeholder, source_sha=placeholder,
        supervisor=str(installed), supervisor_sha=options.expected_supervisor_sha256,
        candidate=candidate, node=str(node), node_sha=options.expected_node_sha256,
        tsx_loader=str(tsx_loader), tsx_sha=options.expected_tsx_loader_sha256,
        consumer=str(consumer), consumer_sha=options.expected_consumer_sha256,
        issuer=str(issuer), issuer_sha=options.expected_issuer_sha256,
        issuer_fact_path=str(fact_path), issuer_fact_sha=placeholder, snapshot_bytes=snapshot_bytes)
    fact_sha = _exclusive_json(fact_path, first['issuerFact'])
    source_sha = _exclusive_json(parent / 'source-pins.json', source)
    roots = [_owned_root(row) for row in measure_owned['roots']]
    roots.extend((_current_root(measure_output, 'command.json', predecessor_fact['commandSha256']),
                  _current_root(parent, 'owner.json', owner_sha),
                  _current_root(issuer_identity, 'owner.json', fact_sha)))
    unique = {row['path']: row for row in roots}
    if len(unique) != len(roots) or len(roots) > 64:
        fail('OWNED_IDENTITY')
    owned = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-owned-roots',
             'access': 'count-only', 'windowId': window_id, 'roots': roots}
    owned_sha = _exclusive_json(parent / 'owned-roots.json', owned)
    final = build_authority_payload(
        predecessor=predecessor, window_id=window_id, label=options.label,
        issued_at=issued_at, deadline_at=deadline_at, owned_sha=owned_sha, source_sha=source_sha,
        supervisor=str(installed), supervisor_sha=options.expected_supervisor_sha256,
        candidate=candidate, node=str(node), node_sha=options.expected_node_sha256,
        tsx_loader=str(tsx_loader), tsx_sha=options.expected_tsx_loader_sha256,
        consumer=str(consumer), consumer_sha=options.expected_consumer_sha256,
        issuer=str(issuer), issuer_sha=options.expected_issuer_sha256,
        issuer_fact_path=str(fact_path), issuer_fact_sha=fact_sha, snapshot_bytes=snapshot_bytes)
    if final['issuerFact'] != first['issuerFact']:
        fail('AUTHORITY_PAYLOAD')
    contract = runpy.run_path(str(installed), run_name='musicbridge_joint_queued_stop_preflight')
    contract['_validate_joint_queued_stop_window'](final['window'], issued.timestamp() + .001)
    pending = parent / 'window.pending.json'; window_sha = _exclusive_json(pending, final['window'])
    _fsync_directory(issuer_identity); _fsync_directory(parent); _fsync_directory(runtime)
    os.rename(pending, parent / 'window.json'); _fsync_directory(parent); _fsync_directory(runtime)
    _FAILURE_CONTEXT = None
    return {'state': 'ISSUED_NOT_EXECUTED', 'windowId': window_id,
            'windowPath': str(parent / 'window.json'), 'windowSha256': window_sha,
            'profile': 'joint', 'label': options.label, 'predecessor': predecessor_fact,
            'sourceFileCount': len(source['files']), 'ownedRootCount': len(roots),
            'plannedBytes': snapshot_bytes + ALLOWANCE, 'deadlineAt': deadline_at,
            'issuerFact': {'file': 'issuer-identity/owner.json', 'sha256': fact_sha},
            'consumeCommand': [str(consumer), str(installed), '--window',
                               str(parent / 'window.json'), '--window-sha256', window_sha]}


def main(argv):
    try:
        value = issue(_parse_args(argv))
    except IssueError as error:
        _record_failure(str(error)); print(f'JOINT_QUEUED_STOP_ISSUER_{error}', file=sys.stderr); return 1
    except Exception:
        _record_failure('INTERNAL'); print('JOINT_QUEUED_STOP_ISSUER_INTERNAL', file=sys.stderr); return 1
    print(json.dumps(value, sort_keys=True, separators=(',', ':'))); return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
