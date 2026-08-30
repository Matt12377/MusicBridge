#!/usr/bin/env python3
"""PROCESS_EXIT 谱系的版本化纯逻辑；文件身份验证仍由各入口负责。"""

import datetime
import json
from pathlib import Path


CONTRACT_RELATIVE = 'packages/contracts/capacity-process-failure-lineage-v1.json'


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
