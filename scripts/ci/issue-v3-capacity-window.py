#!/usr/bin/env python3
"""一次性签发 TASK-078 capacity generation authority；只写控制文件，不执行 benchmark。"""

import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

SAFE = re.compile(r'^[a-z0-9-]{1,64}$', re.ASCII)
ROOT_NAME = re.compile(r'^[A-Za-z0-9-]{1,64}$', re.ASCII)
SHA256 = re.compile(r'^[0-9a-f]{64}$', re.ASCII)
GIT_SHA = re.compile(r'^[0-9a-f]{40}$', re.ASCII)
MARKERS = {'owner.json', 'capacity-owner.json', 'seed.json', 'command.json', 'r020-owner.json'}
GENERATION_LIMITS = {'executionMs': 1200000, 'killGraceMs': 1000, 'closeMs': 2000,
                     'minimumFreeBytes': 10 * 1024 ** 3, 'maximumOwnedBytes': 16 * 1024 ** 3}
OBJECTS_LIMIT_PLANNED_BYTES = 9_623_411_100
_FAILURE_CONTEXT = None


class IssueError(Exception):
    pass


def fail(code):
    raise IssueError(code)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def ordinary(path):
    path = Path(path)
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink == 1


def strict_json(path):
    path = Path(path)
    if not ordinary(path):
        fail('ORDINARY_FILE')
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    if any(getattr(before, key) != getattr(after, key) for key in fields):
        fail('FILE_CHANGED')
    try:
        return json.loads(data.decode('utf-8')), hashlib.sha256(data).hexdigest()
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail('JSON_INVALID')


def exclusive_json(path, value):
    path = Path(path)
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise IssueError('EXCLUSIVE_CREATE') from error
    try:
        written = 0
        while written < len(data):
            written += os.write(descriptor, data[written:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return hashlib.sha256(data).hexdigest()


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def record_terminal_failure(code):
    """目录创建后的任何失败都留下不可重放回执；记录失败本身不得覆盖原错误。"""
    global _FAILURE_CONTEXT
    context = _FAILURE_CONTEXT
    if context is None:
        return
    parent = context['parent']
    receipt = parent / 'issuer-failure.json'
    if receipt.exists() or receipt.is_symlink():
        return
    created = [name for name in ('owner.json', 'source-pins.json', 'owned-roots.json', 'window.pending.json', 'window.json')
               if ordinary(parent / name)]
    try:
        exclusive_json(receipt, {
            'schemaVersion': 1,
            'scope': 'musicbridge-capacity-authority-issuer-failure',
            'state': 'TERMINAL_ISSUER_FAILURE',
            'windowId': context['windowId'],
            'errorCode': code,
            'authorityFilesCreated': created,
            'windowWritten': 'window.json' in created,
            'replayAllowed': False,
            'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
        })
        fsync_directory(parent)
        fsync_directory(context['runtime'])
    except Exception:
        pass


def canonical_directory(path, parent=None):
    supplied = Path(path)
    try:
        resolved = supplied.resolve(strict=True)
        info = supplied.lstat()
    except OSError:
        fail('DIRECTORY_IDENTITY')
    if supplied.is_symlink() or not stat.S_ISDIR(info.st_mode) or supplied != resolved:
        fail('DIRECTORY_IDENTITY')
    if parent is not None and os.path.commonpath((str(parent), str(resolved))) != str(parent):
        fail('DIRECTORY_BOUNDARY')
    return resolved


def root_identity(row):
    if not isinstance(row, dict) or set(row) != {'path', 'device', 'inode', 'marker'}:
        fail('OWNED_IDENTITY')
    path = canonical_directory(row.get('path'))
    marker = row.get('marker')
    if not isinstance(marker, dict) or set(marker) != {'relative', 'sha256'} or marker.get('relative') not in MARKERS or SHA256.fullmatch(str(marker.get('sha256', ''))) is None:
        fail('OWNED_IDENTITY')
    info = path.stat(); marker_path = path / marker['relative']
    if info.st_dev != row.get('device') or info.st_ino != row.get('inode') or not ordinary(marker_path) or sha256(marker_path) != marker['sha256']:
        fail('CARRYOVER_IDENTITY')
    return {'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
            'marker': {'relative': marker['relative'], 'sha256': marker['sha256']}}


def current_root(path, marker_relative):
    path = canonical_directory(path)
    marker = path / marker_relative
    if marker_relative not in MARKERS or not ordinary(marker):
        fail('OWNED_IDENTITY')
    info = path.stat()
    return {'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
            'marker': {'relative': marker_relative, 'sha256': sha256(marker)}}


def git_value(root, *arguments):
    try:
        return subprocess.check_output(
            ['/usr/bin/git', *arguments], cwd=root, text=True, stderr=subprocess.DEVNULL,
            env={key: value for key, value in os.environ.items() if not key.startswith('GIT_')}).strip()
    except (OSError, subprocess.CalledProcessError):
        fail('REPOSITORY_IDENTITY')


def git_blob(root, head, relative):
    try:
        return subprocess.check_output(
            ['/usr/bin/git', 'show', f'{head}:{relative}'], cwd=root, stderr=subprocess.DEVNULL,
            env={key: value for key, value in os.environ.items() if not key.startswith('GIT_')})
    except (OSError, subprocess.CalledProcessError):
        fail('SOURCE_CANDIDATE')


def load_supervisor(path):
    spec = importlib.util.spec_from_file_location('musicbridge_capacity_supervisor', path)
    if spec is None or spec.loader is None:
        fail('SUPERVISOR_IDENTITY')
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        raise IssueError('SUPERVISOR_IDENTITY') from error
    required = ('_expected_source_paths', '_strict_identity', '_validate_source_manifest', '_validate_owned_manifest', '_GENERATION_LIMITS')
    if any(not hasattr(module, name) for name in required):
        fail('SUPERVISOR_CONTRACT')
    return module


def parse_args(argv):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--repo-root', required=True)
    parser.add_argument('--runtime-root', required=True)
    parser.add_argument('--supervisor', required=True)
    parser.add_argument('--expected-supervisor-sha256', required=True)
    parser.add_argument('--expected-source-count', required=True, type=int)
    parser.add_argument('--base-owned-manifest', required=True)
    parser.add_argument('--expected-base-owned-sha256', required=True)
    parser.add_argument('--carryover-inventory', required=True)
    parser.add_argument('--expected-carryover-inventory-sha256', required=True)
    parser.add_argument('--window-dir-name', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--profile', required=True, choices=('objects-limit',))
    parser.add_argument('--expected-branch', required=True)
    parser.add_argument('--expected-head', required=True)
    parser.add_argument('--consumer-python', default=sys.executable)
    parser.add_argument('--expected-consumer-sha256', required=True)
    return parser.parse_args(argv)


def reject_replay_label(runtime, label):
    entries = list(runtime.iterdir())
    if len(entries) > 4096:
        fail('RUNTIME_COUNT')
    for entry in entries:
        candidates = []
        if entry.is_dir() and not entry.is_symlink():
            window = entry / 'window.json'
            if window.exists() or window.is_symlink():
                candidates.append(window)
        elif entry.name.endswith('-close.json') and (entry.is_file() or entry.is_symlink()):
            candidates.append(entry)
        for candidate in candidates:
            if not ordinary(candidate):
                fail('REPLAY_AUDIT')
            try:
                value, _ = strict_json(candidate)
            except IssueError:
                fail('REPLAY_AUDIT')
            observed = value.get('label') if value.get('scope') == 'musicbridge-capacity-generation-window' else value.get('window', {}).get('label')
            if observed == label:
                fail('REPLAY_LABEL')


def failed_authority_roots(runtime):
    """把先前 issuer 的完整终态失败目录纳入下一次 owned 闭包。"""
    rows = []
    entries = list(runtime.iterdir())
    if len(entries) > 4096:
        fail('RUNTIME_COUNT')
    for entry in entries:
        if not entry.is_dir() or entry.is_symlink():
            continue
        owner_path = entry / 'owner.json'
        failure_path = entry / 'issuer-failure.json'
        has_owner = owner_path.exists() or owner_path.is_symlink()
        has_failure = failure_path.exists() or failure_path.is_symlink()
        owner = None
        if has_owner:
            if not ordinary(owner_path):
                fail('FAILED_AUTHORITY_TERMINAL')
            owner, _ = strict_json(owner_path)
        generation_owner = isinstance(owner, dict) and owner.get('scope') == 'musicbridge-capacity-generation-window'
        if not has_failure:
            if generation_owner and not (entry / 'window.json').exists():
                fail('FAILED_AUTHORITY_TERMINAL')
            continue
        if not ordinary(failure_path) or not generation_owner:
            fail('FAILED_AUTHORITY_TERMINAL')
        failure, _ = strict_json(failure_path)
        required = {'schemaVersion', 'scope', 'state', 'windowId', 'errorCode', 'authorityFilesCreated',
                    'windowWritten', 'replayAllowed', 'recordedAt'}
        if (not isinstance(failure, dict) or set(failure) != required or failure.get('schemaVersion') != 1
                or failure.get('scope') != 'musicbridge-capacity-authority-issuer-failure'
                or failure.get('state') != 'TERMINAL_ISSUER_FAILURE' or failure.get('windowId') != owner.get('id')
                or failure.get('windowWritten') is not False or failure.get('replayAllowed') is not False
                or not isinstance(failure.get('errorCode'), str) or not failure['errorCode']
                or not isinstance(failure.get('authorityFilesCreated'), list)
                or (entry / 'window.json').exists() or (entry / 'window.json').is_symlink()):
            fail('FAILED_AUTHORITY_TERMINAL')
        rows.append(current_root(entry, 'owner.json'))
    return rows


def issue(options):
    global _FAILURE_CONTEXT
    _FAILURE_CONTEXT = None
    root = canonical_directory(Path(options.repo_root).resolve(strict=True))
    runtime = canonical_directory(Path(options.runtime_root).resolve(strict=True), root)
    supervisor_path = Path(options.supervisor).resolve(strict=True)
    if supervisor_path.parent != runtime or not ordinary(supervisor_path):
        fail('SUPERVISOR_IDENTITY')
    if SHA256.fullmatch(options.expected_supervisor_sha256) is None or sha256(supervisor_path) != options.expected_supervisor_sha256:
        fail('SUPERVISOR_IDENTITY')
    if SAFE.fullmatch(options.window_dir_name) is None or SAFE.fullmatch(options.label) is None:
        fail('LABEL_INVALID')
    if GIT_SHA.fullmatch(options.expected_head) is None or git_value(root, 'rev-parse', '--show-toplevel') != str(root) or git_value(root, 'rev-parse', 'HEAD^{commit}') != options.expected_head or git_value(root, 'branch', '--show-current') != options.expected_branch:
        fail('REPOSITORY_IDENTITY')
    parent = runtime / options.window_dir_name; output = runtime / options.label
    if parent.exists() or parent.is_symlink() or output.exists() or output.is_symlink():
        fail('REPLAY_PATH')
    reject_replay_label(runtime, options.label)
    consumer_path = Path(options.consumer_python)
    if not consumer_path.is_absolute():
        fail('CONSUMER_IDENTITY')
    try:
        consumer = str(consumer_path.resolve(strict=True))
    except OSError:
        fail('CONSUMER_IDENTITY')
    consumer_info = Path(consumer).lstat()
    if not stat.S_ISREG(consumer_info.st_mode) or Path(consumer).is_symlink() or not os.access(consumer, os.X_OK) or SHA256.fullmatch(options.expected_consumer_sha256) is None or sha256(consumer) != options.expected_consumer_sha256:
        fail('CONSUMER_IDENTITY')

    module = load_supervisor(supervisor_path)
    if module._GENERATION_LIMITS != GENERATION_LIMITS:
        fail('SUPERVISOR_CONTRACT')
    base_path = Path(options.base_owned_manifest)
    if not base_path.is_absolute() or base_path.is_symlink() or base_path.resolve(strict=True) != base_path or base_path.parent.parent != runtime:
        fail('BASE_OWNED_MANIFEST')
    base, base_sha = strict_json(base_path)
    if SHA256.fullmatch(options.expected_base_owned_sha256) is None or base_sha != options.expected_base_owned_sha256:
        fail('BASE_OWNED_MANIFEST')
    if not isinstance(base, dict) or set(base) != {'schemaVersion', 'scope', 'access', 'windowId', 'roots'} or base.get('schemaVersion') != 1 or base.get('scope') != 'musicbridge-capacity-owned-roots' or base.get('access') != 'count-only' or not isinstance(base.get('windowId'), str) or not isinstance(base.get('roots'), list) or not base['roots']:
        fail('BASE_OWNED_MANIFEST')
    roots = [root_identity(row) for row in base['roots']]

    carryover_path = Path(options.carryover_inventory)
    if not carryover_path.is_absolute() or carryover_path.is_symlink() or carryover_path.resolve(strict=True) != carryover_path or carryover_path.parent != runtime:
        fail('CARRYOVER_INVENTORY')
    carryover, carryover_sha = strict_json(carryover_path)
    if SHA256.fullmatch(options.expected_carryover_inventory_sha256) is None or carryover_sha != options.expected_carryover_inventory_sha256:
        fail('CARRYOVER_INVENTORY')
    if not isinstance(carryover, dict) or set(carryover) != {'schemaVersion', 'scope', 'terminalClose', 'roots'} or carryover.get('schemaVersion') != 1 or carryover.get('scope') != 'musicbridge-capacity-carryover-inventory' or not isinstance(carryover.get('roots'), list) or not carryover['roots']:
        fail('CARRYOVER_INVENTORY')
    terminal = carryover.get('terminalClose')
    if not isinstance(terminal, dict) or set(terminal) != {'path', 'sha256'} or SHA256.fullmatch(str(terminal.get('sha256', ''))) is None:
        fail('CARRYOVER_INVENTORY')
    close_path = Path(terminal['path']).resolve(strict=True)
    if close_path.parent != runtime:
        fail('CARRYOVER_TERMINAL')
    close_value, close_sha = strict_json(close_path)
    if close_sha != terminal['sha256'] or not isinstance(close_value, dict) or close_value.get('scope') != 'musicbridge-capacity-generation-close' or close_value.get('safety', {}).get('replayAllowed') is not False:
        fail('CARRYOVER_TERMINAL')
    terminal_parent_name = close_path.name.removesuffix('-close.json')
    terminal_parent = runtime / terminal_parent_name
    terminal_window_path = terminal_parent / 'window.json'
    terminal_window, terminal_window_sha = strict_json(terminal_window_path)
    close_window = close_value.get('window')
    if not isinstance(close_window, dict) or terminal_window_sha != close_window.get('sha256') or close_window.get('id') != terminal_window.get('id') or close_window.get('profile') != options.profile or terminal_window.get('profile') != options.profile or terminal_window.get('ownedManifest', {}).get('sha256') != base_sha or base_path != terminal_parent / 'owned-roots.json':
        fail('CARRYOVER_TERMINAL')
    safety = close_value.get('safety', {}); supervisor = close_value.get('supervisor', {})
    if close_value.get('state') != 'SEALED_CONTROL_COVERAGE_FAILURE' or close_value.get('stopReason', {}).get('code') != 'OWNED_MANIFEST_INCOMPLETE_PREEXISTING_CONTROLLED_ROOTS' or close_value.get('verdict') != 'CONTROL_FAILURE_NOT_A_SEED_NOT_A_CAPACITY_PASS' or safety.get('remainingProcesses') != 0 or safety.get('processGroupEmpty') is not True or safety.get('retryAuthorized') is not False or safety.get('jointAuthorized') is not False or supervisor.get('groupEmpty') is not True or supervisor.get('zombies') != []:
        fail('CARRYOVER_TERMINAL')
    declared = {}
    omitted = close_value.get('omittedPreexistingRoots')
    if not isinstance(omitted, list):
        fail('CARRYOVER_COVERAGE')
    for entry in omitted:
        kind = entry.get('kind') if isinstance(entry, dict) else None
        label = entry.get('label') if isinstance(entry, dict) else None
        label_valid = SAFE.fullmatch(str(label or '')) is not None if kind == 'partial-output' else re.fullmatch(r'musicbridge-version-[A-Za-z0-9]+', str(label or '')) is not None
        if kind not in {'partial-output', 'partial-fixture'} or not label_valid or type(entry.get('device')) is not int or type(entry.get('inode')) is not int or not isinstance(entry.get('marker'), dict):
            fail('CARRYOVER_COVERAGE')
        marker = 'command.json' if kind == 'partial-output' else 'capacity-owner.json'
        if entry['marker'].get('relative') != marker or SHA256.fullmatch(str(entry['marker'].get('sha256', ''))) is None:
            fail('CARRYOVER_COVERAGE')
        declared[label] = {'relative': marker, 'sha256': entry['marker']['sha256'], 'device': entry['device'], 'inode': entry['inode']}
    current_output = close_value.get('partialEvidence', {}).get('outputLabel')
    current_fixture_value = close_value.get('fixture', {})
    current_fixture = current_fixture_value.get('label')
    if SAFE.fullmatch(str(current_output or '')) is None or re.fullmatch(r'musicbridge-version-[A-Za-z0-9]+', str(current_fixture or '')) is None:
        fail('CARRYOVER_COVERAGE')
    terminal_supervisor_path = terminal_parent / 'supervision' / 'supervisor.json'
    terminal_supervisor, terminal_supervisor_sha = strict_json(terminal_supervisor_path)
    command_fact = terminal_supervisor.get('generation', {}).get('files', {}).get('command.json', {})
    if terminal_supervisor_sha != supervisor.get('sha256') or terminal_supervisor.get('generation', {}).get('outputDirectory') != str(runtime / current_output) or command_fact.get('exists') is not True or SHA256.fullmatch(str(command_fact.get('sha256', ''))) is None:
        fail('CARRYOVER_COVERAGE')
    fixture_marker = current_fixture_value.get('marker')
    if type(current_fixture_value.get('device')) is not int or type(current_fixture_value.get('inode')) is not int or not isinstance(fixture_marker, dict) or fixture_marker.get('relative') != 'capacity-owner.json' or SHA256.fullmatch(str(fixture_marker.get('sha256', ''))) is None:
        fail('CARRYOVER_COVERAGE')
    declared[current_output] = {'relative': 'command.json', 'sha256': command_fact['sha256']}
    declared[current_fixture] = {'relative': 'capacity-owner.json', 'sha256': fixture_marker['sha256'],
                                 'device': current_fixture_value['device'], 'inode': current_fixture_value['inode']}
    carryover_rows = [root_identity(row) for row in carryover['roots']]
    observed = {Path(row['path']).name: row for row in carryover_rows}
    if len(observed) != len(carryover_rows) or set(observed) != set(declared):
        fail('CARRYOVER_COVERAGE')
    for label, expected in declared.items():
        row = observed[label]
        if row['marker']['relative'] != expected['relative'] or row['marker']['sha256'] != expected['sha256'] or 'device' in expected and (row['device'] != expected['device'] or row['inode'] != expected['inode']):
            fail('CARRYOVER_COVERAGE')
    roots.extend(carryover_rows)
    roots.extend(failed_authority_roots(runtime))

    unique = {}
    for row in roots:
        existing = unique.get(row['path'])
        if existing is not None and existing != row:
            fail('OWNED_DUPLICATE')
        unique[row['path']] = row
    if len(unique) + 1 > 64:
        fail('OWNED_COUNT')

    window_id = str(uuid.uuid4())
    try:
        parent.mkdir(mode=0o700)
    except OSError as error:
        raise IssueError('EXCLUSIVE_CREATE') from error
    _FAILURE_CONTEXT = {'parent': parent, 'runtime': runtime, 'windowId': window_id}
    owner = {'scope': 'musicbridge-capacity-generation-window', 'owner': 'root', 'id': window_id}
    owner_sha = exclusive_json(parent / 'owner.json', owner)
    parent_info = parent.stat()
    unique[str(parent)] = {'path': str(parent), 'device': parent_info.st_dev, 'inode': parent_info.st_ino,
                           'marker': {'relative': 'owner.json', 'sha256': owner_sha}}

    source_root, source_paths = module._expected_source_paths(root)
    if Path(source_root) != root or options.expected_source_count != len(source_paths):
        fail('SOURCE_MANIFEST')
    files = {}
    for relative in source_paths:
        identity = module._strict_identity(root / relative)
        if relative not in {
            'reports/runtime/task-078-v3-acceptance/capacity-phase-supervisor.py',
            'reports/runtime/task-078-v3-acceptance/test_capacity_phase_supervisor.py'
        } and hashlib.sha256(git_blob(root, options.expected_head, relative)).hexdigest() != identity['sha256']:
            fail('SOURCE_CANDIDATE')
        files[relative] = identity['sha256']
    source = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-source-pins', 'files': files}
    source_sha = exclusive_json(parent / 'source-pins.json', source)
    owned = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-owned-roots', 'access': 'count-only',
             'windowId': window_id, 'roots': list(unique.values())}
    owned_sha = exclusive_json(parent / 'owned-roots.json', owned)
    try:
        source_result = module._validate_source_manifest(parent / 'source-pins.json', root)
        owned_result = module._validate_owned_manifest(parent / 'owned-roots.json', runtime, window_id, options.profile)
    except Exception as error:
        raise IssueError('AUTHORITY_PREFLIGHT') from error
    if source_result.get('fileCount') != options.expected_source_count or owned_result.get('rootCount') != len(unique) or owned_result.get('plannedBytes') != OBJECTS_LIMIT_PLANNED_BYTES or type(owned_result.get('ownedBytes')) is not int or type(owned_result.get('availableBytes')) is not int or owned_result['ownedBytes'] + OBJECTS_LIMIT_PLANNED_BYTES > GENERATION_LIMITS['maximumOwnedBytes'] or owned_result['availableBytes'] - OBJECTS_LIMIT_PLANNED_BYTES < GENERATION_LIMITS['minimumFreeBytes']:
        fail('AUTHORITY_PREFLIGHT')

    issued = datetime.datetime.now(datetime.timezone.utc)
    deadline = issued + datetime.timedelta(seconds=1200)
    window = {
        'schemaVersion': 1, 'scope': 'musicbridge-capacity-generation-window', 'owner': 'root',
        'id': window_id, 'state': 'approved', 'phase': 'generate', 'profile': options.profile,
        'label': options.label, 'n': 1, 'issuedAt': issued.isoformat(timespec='milliseconds'),
        'deadlineAt': deadline.isoformat(timespec='milliseconds'), 'limits': dict(GENERATION_LIMITS),
        'ownedManifest': {'file': 'owned-roots.json', 'sha256': owned_sha},
        'sourceManifest': {'file': 'source-pins.json', 'sha256': source_sha}
    }
    result = {
        'state': 'ISSUED_NOT_EXECUTED', 'windowId': window_id, 'windowPath': str(parent / 'window.json'),
        'windowSha256': None, 'profile': options.profile, 'label': options.label,
        'sourceFileCount': source_result.get('fileCount'), 'ownedRootCount': owned_result.get('rootCount'),
        'ownedBytes': owned_result.get('ownedBytes'), 'plannedBytes': owned_result.get('plannedBytes'),
        'availableBytes': owned_result.get('availableBytes'), 'deadlineAt': window['deadlineAt'],
        'consumeCommand': None
    }
    # approved authority 是最后一步发布；此前先持久化目录与 pending 文件。
    pending_path = parent / 'window.pending.json'
    window_sha = exclusive_json(pending_path, window)
    fsync_directory(parent)
    fsync_directory(runtime)
    os.rename(pending_path, parent / 'window.json')
    result['windowSha256'] = window_sha
    result['consumeCommand'] = [consumer, str(supervisor_path), '--window', str(parent / 'window.json'), '--window-sha256', window_sha]
    _FAILURE_CONTEXT = None
    return result


def main(argv):
    try:
        value = issue(parse_args(argv))
    except IssueError as error:
        record_terminal_failure(str(error))
        print(f'CAPACITY_WINDOW_ISSUER={error}', file=sys.stderr)
        return 1
    except Exception:
        record_terminal_failure('ISSUER_INTERNAL')
        print('CAPACITY_WINDOW_ISSUER=ISSUER_INTERNAL', file=sys.stderr)
        return 1
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
