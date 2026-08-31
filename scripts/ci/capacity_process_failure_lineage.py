#!/usr/bin/env python3
"""PROCESS_EXIT 谱系的版本化纯逻辑；文件身份验证仍由各入口负责。"""

import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat


CONTRACT_RELATIVE = 'packages/contracts/capacity-process-failure-lineage-v1.json'
_UUID4 = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.ASCII)
_SHA256 = re.compile(r'^[0-9a-f]{64}$', re.ASCII)


def load_contract(repository_root):
    path = Path(repository_root) / CONTRACT_RELATIVE
    with path.open(encoding='utf-8') as stream:
        value = json.load(stream)
    if value != {
            'schemaVersion': 1,
            'scope': 'musicbridge-capacity-process-failure-lineage-contract',
            'failure': 'PROCESS_EXIT',
            'maximumReachableDepth': 64,
            'exactDirectHeadCount': 1,
            'ordering': 'head-to-leaf',
            'fieldSemantics': {
                'processFailureCarryoverCount': 'directHeadCount',
                'processFailureCount': 'predecessorReachableDepth'},
            'verdicts': [
                'PASS', 'DIRECT_HEAD_COUNT', 'ORPHAN', 'CYCLE', 'FORK', 'DEPTH_LIMIT',
                'TIME_ORDER', 'PID_MISMATCH', 'IDENTITY_MISMATCH',
                'AUTHORITY_DEPTH_MISMATCH']}:
        raise ValueError('LINEAGE_CONTRACT')
    return value


def _result(direct, billing, failure):
    return {
        'verdict': failure or 'PASS',
        'directHeadCount': len(direct),
        'reachableDepth': len(billing),
        'orderedDirectRoots': direct,
        'billingRoots': billing,
        'failure': failure,
    }


def _instant(value):
    if not isinstance(value, str) or not value.endswith('Z'):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError:
        return None
    return parsed if parsed.utcoffset() == datetime.timedelta(0) else None


def evaluate_process_failure_lineage(case, contract):
    """对已规范化的单 head 链给出稳定、可跨语言比较的判定。"""
    if not isinstance(case, dict) or not isinstance(contract, dict):
        raise ValueError('LINEAGE_INPUT')
    direct = case.get('directRootIds')
    nodes = case.get('nodes')
    if not isinstance(direct, list) or not all(isinstance(value, str) for value in direct) \
            or not isinstance(nodes, list):
        raise ValueError('LINEAGE_INPUT')
    if len(direct) != contract.get('exactDirectHeadCount'):
        return _result(direct, [], 'DIRECT_HEAD_COUNT')
    by_id = {}
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get('id'), str) \
                or node['id'] in by_id:
            raise ValueError('LINEAGE_INPUT')
        by_id[node['id']] = node
    billing = []
    seen = set()
    current_id = direct[0]
    while True:
        if current_id in seen:
            return _result(direct, billing, 'CYCLE')
        node = by_id.get(current_id)
        if node is None:
            return _result(direct, billing, 'ORPHAN')
        seen.add(current_id); billing.append(current_id)
        if len(billing) > contract.get('maximumReachableDepth', 0):
            return _result(direct, billing, 'DEPTH_LIMIT')
        predecessors = node.get('predecessorIds')
        if not isinstance(predecessors, list) or not all(isinstance(value, str)
                                                          for value in predecessors):
            raise ValueError('LINEAGE_INPUT')
        if len(predecessors) > 1:
            return _result(direct, billing, 'FORK')
        if not predecessors:
            break
        current_id = predecessors[0]
    for index, node_id in enumerate(billing):
        node = by_id[node_id]
        issued = _instant(node.get('issuedAt')); deadline = _instant(node.get('deadlineAt'))
        closed = _instant(node.get('closedAt'))
        if issued is None or deadline is None or closed is None \
                or not issued <= closed <= deadline:
            return _result(direct, billing, 'TIME_ORDER')
        pid = node.get('pid')
        if type(pid) is not int or pid <= 0 \
                or any(node.get(key) != pid for key in ('pgid', 'supervisionPid', 'closePid')):
            return _result(direct, billing, 'PID_MISMATCH')
        predecessors = node['predecessorIds']
        identities = node.get('predecessorRootIdentities')
        if not isinstance(identities, list) or len(identities) != len(predecessors):
            return _result(direct, billing, 'IDENTITY_MISMATCH')
        if predecessors:
            predecessor = by_id.get(predecessors[0])
            if predecessor is None:
                return _result(direct, billing, 'ORPHAN')
            if identities[0] != predecessor.get('rootIdentity'):
                return _result(direct, billing, 'IDENTITY_MISMATCH')
            predecessor_closed = _instant(predecessor.get('closedAt'))
            if predecessor_closed is None or predecessor_closed > issued:
                return _result(direct, billing, 'TIME_ORDER')
            expected_depth = len(billing) - index - 1
            if node.get('authorityReachableDepth') != expected_depth:
                return _result(direct, billing, 'AUTHORITY_DEPTH_MISMATCH')
        elif node.get('authorityReachableDepth') is not None:
            return _result(direct, billing, 'AUTHORITY_DEPTH_MISMATCH')
    return _result(direct, billing, None)


def _exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def _regular(path):
    try: info = Path(path).lstat()
    except OSError: return False
    return stat.S_ISREG(info.st_mode) and not Path(path).is_symlink() and info.st_nlink == 1


def _json(path, maximum=16 * 1024 * 1024):
    path = Path(path)
    if not _regular(path) or path.stat().st_size > maximum: raise ValueError('RETAINED_OUTPUT')
    return json.loads(path.read_text(encoding='utf-8'))


def _sha256(path):
    path = Path(path); descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    digest = hashlib.sha256()
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1: raise ValueError('RETAINED_OUTPUT')
        for chunk in iter(lambda: os.read(descriptor, 1024 * 1024), b''): digest.update(chunk)
        after = os.fstat(descriptor)
    finally: os.close(descriptor)
    named = path.lstat()
    if any(getattr(before, key) != getattr(after, key) or getattr(after, key) != getattr(named, key)
           for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')):
        raise ValueError('RETAINED_OUTPUT')
    return digest.hexdigest(), after.st_size


def _space(value, maximum):
    return _exact(value, {'availableBytes', 'plannedBytes', 'ownedBytes'}) \
        and all(type(value.get(key)) is int and value[key] >= 0
                for key in ('availableBytes', 'plannedBytes', 'ownedBytes')) \
        and value['plannedBytes'] <= maximum


def validate_retained_preflight_failure(output, window, window_sha256, owned_sha256, source_sha256):
    """严格冻结首样本尚未spawn时的保留现场；它仍是0样本失败，不是性能证据。"""
    output = Path(output)
    expected = {'owner.json', 'input.json', 'samples.jsonl', 'summary.json', 'exit.json',
                'queued-stop-aggregate-budget.jsonl', 'sample-001', 'sample-001-intent.json',
                'sample-001-raw-receipt.json', 'sample-001-raw-receipt.sha256.json',
                'sample-001.json', 'sample-001-retention.json'}
    try:
        if not output.is_absolute() or output.is_symlink() or output.resolve(strict=True) != output \
                or {entry.name for entry in output.iterdir()} != expected:
            return False
        sample = output / 'sample-001'
        if sample.is_symlink() or sample.resolve(strict=True) != sample \
                or {entry.name for entry in sample.iterdir()} != {'owner.json', 'sample.sqlite'}:
            return False
        if any(not _regular(output / name) for name in expected - {'sample-001'}) \
                or not _regular(sample / 'owner.json') or not _regular(sample / 'sample.sqlite'):
            return False
        if any((output / name).stat().st_size > 16 * 1024 * 1024
               for name in expected - {'sample-001'}):
            return False
        owner = _json(output / 'owner.json'); input_value = _json(output / 'input.json')
        intent = _json(output / 'sample-001-intent.json'); raw = _json(output / 'sample-001-raw-receipt.json')
        raw_hash = _json(output / 'sample-001-raw-receipt.sha256.json')
        row = _json(output / 'sample-001.json'); retention = _json(output / 'sample-001-retention.json')
        clone_owner = _json(sample / 'owner.json'); summary = _json(output / 'summary.json')
        exit_value = _json(output / 'exit.json')
        samples = [json.loads(line) for line in (output / 'samples.jsonl').read_text(encoding='utf-8').splitlines()]
        aggregate = [json.loads(line) for line in (output / 'queued-stop-aggregate-budget.jsonl').read_text(encoding='utf-8').splitlines()]
        raw_digest, _ = _sha256(output / 'sample-001-raw-receipt.json')
        snapshot_digest, snapshot_size = _sha256(sample / 'sample.sqlite')
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError):
        return False
    plan = window.get('queuedStopPlan') if isinstance(window, dict) else None
    args = input_value.get('args') if isinstance(input_value, dict) else None
    request_id = raw.get('requestId') if isinstance(raw, dict) else None
    if not isinstance(plan, dict) \
            or any(type(plan.get(key)) is not int or plan[key] < 0
                   for key in ('snapshotBytes', 'plannedBytes')) \
            or _SHA256.fullmatch(str(window_sha256 or '')) is None \
            or _SHA256.fullmatch(str(owned_sha256 or '')) is None \
            or _SHA256.fullmatch(str(source_sha256 or '')) is None:
        return False
    if owner != {'scope': 'musicbridge-capacity-phase-output', 'id': owner.get('id'),
                 'windowId': window.get('id'), 'label': window.get('label')} \
            or _UUID4.fullmatch(str(owner.get('id', ''))) is None \
            or not _exact(input_value, {'args', 'windowId', 'seedSha256', 'sourceManifestSha256',
                                        'initialSpace', 'effectiveOperationLimits', 'classification',
                                        'cache', 'n', 'warmup', 'formalSamples', 'clocks', 'backend',
                                        'deviceOpened', 'formalReady', 'gateB'}) \
            or not _exact(args, {'phase', 'profile', 'label', 'seedLabel', 'windowPath', 'windowSha256',
                                 'ownedRootsPath', 'ownedRootsSha256'}) \
            or args.get('phase') != 'queued-stop' or args.get('profile') != 'objects-limit' \
            or args.get('label') != window.get('label') or args.get('seedLabel') != window.get('seedLabel') \
            or args.get('windowPath') != str(output.parent / 'window.json') \
            or args.get('ownedRootsPath') != str(output.parent / 'owned-roots.json') \
            or args.get('windowSha256') != window_sha256 or args.get('ownedRootsSha256') != owned_sha256 \
            or input_value.get('windowId') != window.get('id') \
            or input_value.get('seedSha256') != window.get('seed', {}).get('snapshotSha256') \
            or input_value.get('sourceManifestSha256') != source_sha256 \
            or not _space(input_value.get('initialSpace'), plan.get('plannedBytes')) \
            or input_value['initialSpace']['plannedBytes'] != plan.get('plannedBytes') \
            or input_value.get('effectiveOperationLimits') != {
                'executionMs': 50000, 'killGraceMs': 1000, 'closeMs': 2000,
                'admissionReserveMs': 53000} \
            or input_value.get('classification') != 'software-only/exclusive-window' \
            or not isinstance(input_value.get('cache'), str) or not input_value['cache'] \
            or input_value.get('n') != 105 or input_value.get('warmup') != 5 \
            or input_value.get('formalSamples') != 100 \
            or input_value.get('clocks') != 'parent与child分栏，不跨进程相减' \
            or input_value.get('backend') != 'private-immediate-fake' \
            or input_value.get('deviceOpened') is not False \
            or input_value.get('formalReady') is not False or input_value.get('gateB') != 'NOT_RUN':
        return False
    expected_raw = {'outcome': 'failed', 'requestId': request_id, 'childPid': None, 'code': None,
                    'signal': None, 'closed': False, 'cleanup': {'termSent': False, 'killSent': False},
                    'forkToCloseMs': 0, 'phase': 'preflight', 'timings': {}, 'failure': 'INPUT_INVALID'}
    if raw != expected_raw or _UUID4.fullmatch(str(request_id or '')) is None \
            or raw_hash != {'sha256': raw_digest} \
            or intent != {'index': 1, 'phase': 'queued-stop', 'profile': 'objects-limit',
                          'windowId': window.get('id'), 'seedSha256': window.get('seed', {}).get('snapshotSha256'),
                          'state': 'operation-not-yet-returned'} \
            or not _exact(row, {'index', 'phase', 'profile', 'warmup', 'preparationMs',
                                'outcome', 'result', 'beforeSpace'}) \
            or type(row.get('preparationMs')) not in (int, float) \
            or not math.isfinite(row['preparationMs']) or row['preparationMs'] < 0 \
            or row.get('index') != 1 or row.get('phase') != 'queued-stop' or row.get('profile') != 'objects-limit' \
            or row.get('warmup') is not True or row.get('outcome') != 'failed' or row.get('result') != raw \
            or not _space(row.get('beforeSpace'), plan.get('plannedBytes')) \
            or samples != [row] or not _exact(retention, {'retained', 'resourcesClosed', 'space'}) \
            or retention.get('retained') is not True \
            or retention.get('resourcesClosed') is not False \
            or not _space(retention.get('space'), plan.get('plannedBytes')) \
            or retention['space']['plannedBytes'] != 0 \
            or clone_owner != {'id': clone_owner.get('id'), 'scope': 'musicbridge-capacity-clone-only', 'label': 'sample-001'} \
            or _UUID4.fullmatch(str(clone_owner.get('id', ''))) is None \
            or snapshot_size != plan.get('snapshotBytes') \
            or snapshot_digest != window.get('seed', {}).get('snapshotSha256'):
        return False
    checkpoints = [('output-created', None, None), ('input-written', None, None),
                   ('clone-before-write', 'sample-001', None), ('clone-after-write', 'sample-001', 'sample-001'),
                   ('operation-returned', 'sample-001', 'sample-001'), ('sample-evidence-written', 'sample-001', 'sample-001'),
                   ('retention-written', 'sample-001', 'sample-001'), ('terminal-written', None, 'sample-001')]
    if len(aggregate) != len(checkpoints):
        return False
    for sequence, (record, expected_row) in enumerate(zip(aggregate, checkpoints), 1):
        checkpoint, group, active = expected_row
        if not _exact(record, {'schemaVersion', 'scope', 'sequence', 'checkpoint', 'group', 'activeClone',
                               'snapshotBytes', 'limitBytes', 'outputBytesBefore', 'plannedBytes', 'recordedAt'}) \
                or record.get('schemaVersion') != 1 \
                or record.get('scope') != 'musicbridge-capacity-queued-stop-aggregate-budget' \
                or record.get('sequence') != sequence or record.get('checkpoint') != checkpoint \
                or record.get('group') != group or record.get('activeClone') != active \
                or record.get('snapshotBytes') != plan.get('snapshotBytes') \
                or record.get('limitBytes') != plan.get('plannedBytes') \
                or type(record.get('outputBytesBefore')) is not int \
                or type(record.get('plannedBytes')) is not int \
                or not 0 <= record['outputBytesBefore'] <= plan.get('plannedBytes') \
                or not 0 <= record['plannedBytes'] <= plan.get('plannedBytes') - record['outputBytesBefore'] \
                or _instant(record.get('recordedAt')) is None:
            return False
    if aggregate[-1]['plannedBytes'] != 0:
        return False
    empty_metric = lambda limits={}: {'n': 0, 'p50': None, 'p95': None, 'p99': None, 'max': None, **limits}
    expected_queue = {'counts': {'warmup': 5, 'formal': 100},
        'childProgressMs': empty_metric({'limitP95': 50, 'limitMax': 100, 'passed': False}),
        'stopReceivedToAbortMs': empty_metric({'limitMax': 100, 'passed': False}),
        'stopReceivedToDriverStopInvokedMs': empty_metric({'limitMax': 100, 'passed': False}),
        'stopReceivedToDriverStopAckMs': empty_metric(),
        'stopReceivedToReceiptMs': empty_metric({'limitP95': 500, 'limitMax': 2000, 'passed': False}),
        'parentSendStopToReceiptMs': empty_metric({'limitMax': 2000, 'passed': False}),
        'parentReceiptToChildCloseMs': empty_metric(), 'driverCloseInvokedMs': empty_metric(),
        'driverCloseResolvedMs': empty_metric({'limitMax': 250, 'passed': False}), 'passed': False}
    return summary == {'phase': 'queued-stop', 'profile': 'objects-limit', 'state': 'incomplete',
        'planned': 105, 'attempted': 1, 'successes': 0, 'failures': 1, 'timeouts': 0, 'unrun': 104,
        'minMs': None, 'medianMs': None, 'maxMs': None, 'p99': None, 'queuedStop': expected_queue,
        'failure': 'CAPACITY_PHASE_OPERATION_FAILED', 'deviceOpened': False, 'formalReady': False,
        'gateB': 'NOT_RUN'} and exit_value == {'exit': 1}
