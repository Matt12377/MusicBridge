#!/usr/bin/env python3
"""签发 joint generation 一次性 authority；只消费 objects-limit:queued-stop:PASS，不执行 benchmark。"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import subprocess
import sys
import uuid

SHA256 = re.compile(r'^[0-9a-f]{64}$', re.ASCII)
GIT_SHA = re.compile(r'^[0-9a-f]{40}$', re.ASCII)
UUID4 = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.ASCII)
SAFE = re.compile(r'^[a-z0-9-]{1,64}$', re.ASCII)
JOINT_GENERATION_PLANNED_BYTES = 2_701_131_776
GENERATION_LIMITS = {
    'executionMs': 1_200_000,
    'killGraceMs': 1_000,
    'closeMs': 2_000,
    'minimumFreeBytes': 10 * 1024 ** 3,
    'maximumOwnedBytes': 16 * 1024 ** 3,
}
JOINT_GENERATION_PLAN = {
    'model': 'serial-single-output-plus-bounded-growth-v1',
    'activeOutputMaximum': 1,
    'finalAxisBytes': 1_275_068_416,
    'activeOutputBytes': 1_275_068_416,
    'activeRecordWorkspaceBytes': 16_777_216,
    'evidenceAllowanceBytes': 134_217_728,
    'plannedBytes': JOINT_GENERATION_PLANNED_BYTES,
}
GIT_TIMEOUT_SECONDS = 15
MAX_RUNTIME_ENTRIES = 4096
MAX_SOURCE_FILES = 4096
MAX_OWNED_ROOTS = 64
OWNED_MARKERS = {'owner.json', 'capacity-owner.json', 'seed.json', 'command.json', 'r020-owner.json'}
_FAILURE_CONTEXT = None


class IssueError(Exception):
    """只暴露有界错误码，不回显路径、参数或内部异常。"""


def fail(code):
    raise IssueError(code)


def _mapping(value):
    return isinstance(value, dict)


def _strict_json(path, expected_sha, maximum=32 * 1024 * 1024):
    try:
        supplied = Path(path)
        canonical = supplied.resolve(strict=True)
        info = supplied.lstat()
        if not supplied.is_absolute() or supplied != canonical or supplied.is_symlink() \
                or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 \
                or info.st_size < 2 or info.st_size > maximum \
                or SHA256.fullmatch(str(expected_sha)) is None:
            fail('OBJECTS_QUEUED_PASS')
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        descriptor = os.open(canonical, flags)
        try:
            before = os.fstat(descriptor)
            digest = hashlib.sha256()
            chunks = []
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                chunks.append(chunk)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
        named = canonical.lstat()
        if any(getattr(before, key) != getattr(after, key)
               or getattr(after, key) != getattr(named, key) for key in fields) \
                or digest.hexdigest() != expected_sha:
            fail('OBJECTS_QUEUED_PASS')
        value = json.loads(b''.join(chunks).decode('utf-8'))
        if not isinstance(value, dict):
            fail('OBJECTS_QUEUED_PASS')
        return value
    except IssueError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError) as error:
        raise IssueError('OBJECTS_QUEUED_PASS') from error


def _queued_result(value):
    return _mapping(value) \
        and value.get('verifiedComplete') is True \
        and value.get('verifiedPassed') is True \
        and type(value.get('sampleCount')) is int and value['sampleCount'] == 105 \
        and type(value.get('uniqueChildPids')) is int and value['uniqueChildPids'] == 105 \
        and value.get('aggregateBudgetValid') is True


def validate_objects_queued_pass(value):
    """验证从真实原始文件归一化出的最小前驱事实；不把exit 0单独当PASS。"""
    try:
        window = value['window']
        close = value['close']
        supervision = value['supervision']
        files = value['files']
        window_valid = _mapping(window) \
            and UUID4.fullmatch(str(window.get('id', ''))) is not None \
            and window.get('phase') == 'queued-stop' \
            and window.get('profile') == 'objects-limit' \
            and window.get('state') == 'approved' \
            and SAFE.fullmatch(str(window.get('label', ''))) is not None \
            and type(window.get('n')) is int and window['n'] == 105
        close_valid = _mapping(close) \
            and close.get('windowId') == window.get('id') \
            and close.get('profile') == 'objects-limit' \
            and close.get('label') == window.get('label') \
            and close.get('state') == 'passed' and close.get('failure') is None \
            and close.get('groupEmpty') is True and close.get('zombies') == [] \
            and close.get('deviceOpened') is False and close.get('formalReady') is False \
            and close.get('gateB') == 'NOT_RUN' \
            and close.get('replayPolicy') == 'terminal-window-id-and-label-never-reuse' \
            and _queued_result(close.get('queuedStop'))
        supervision_valid = _mapping(supervision) \
            and supervision.get('passed') is True and supervision.get('failure') is None \
            and type(supervision.get('code')) is int and supervision['code'] == 0 \
            and supervision.get('groupEmpty') is True and supervision.get('zombies') == [] \
            and _queued_result(supervision.get('queuedStop')) \
            and supervision.get('queuedStop') == close.get('queuedStop')
        files_valid = _mapping(files) and set(files) == {
            'windowSha256', 'closeSha256', 'supervisionSha256',
            'ownedManifestSha256', 'sourceManifestSha256',
        } and all(SHA256.fullmatch(str(files.get(key, ''))) is not None for key in files)
        if not window_valid or not close_valid or not supervision_valid or not files_valid:
            fail('OBJECTS_QUEUED_PASS')
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise IssueError('OBJECTS_QUEUED_PASS') from error
    return {
        'requiredResult': 'objects-limit:queued-stop:PASS',
        'windowId': window['id'],
        'label': window['label'],
        **files,
    }


def load_objects_queued_pass(*, window_path, window_sha, close_path, close_sha,
                             supervision_path, supervision_sha, owned_path, owned_sha,
                             source_path, source_sha):
    """从五份原始证据重建前驱事实；路径、SHA和交叉字段必须同时闭合。"""
    try:
        window_file = Path(window_path)
        parent = window_file.parent
        if Path(close_path).parent != parent or Path(owned_path).parent != parent \
                or Path(source_path).parent != parent \
                or Path(supervision_path) != parent / 'supervision' / 'supervisor.json' \
                or window_file.name != 'window.json' or Path(close_path).name != 'close.json' \
                or Path(owned_path).name != 'owned-roots.json' \
                or Path(source_path).name != 'source-pins.json':
            fail('OBJECTS_QUEUED_PASS')
        window = _strict_json(window_path, window_sha)
        close = _strict_json(close_path, close_sha)
        supervision = _strict_json(supervision_path, supervision_sha)
        owned = _strict_json(owned_path, owned_sha)
        source = _strict_json(source_path, source_sha)
        if window.get('schemaVersion') != 1 \
                or window.get('scope') != 'musicbridge-capacity-queued-stop-window' \
                or window.get('owner') != 'root' \
                or window.get('ownedManifest') != {'file': 'owned-roots.json', 'sha256': owned_sha} \
                or window.get('sourceManifest') != {'file': 'source-pins.json', 'sha256': source_sha} \
                or close.get('schemaVersion') != 1 \
                or close.get('scope') != 'musicbridge-capacity-queued-stop-window-close' \
                or close.get('windowSha256') != window_sha \
                or close.get('ownedManifestSha256') != owned_sha \
                or close.get('sourceManifestSha256') != source_sha \
                or close.get('supervisorSha256') != supervision_sha \
                or owned.get('schemaVersion') != 1 \
                or owned.get('scope') != 'musicbridge-capacity-owned-roots' \
                or owned.get('access') != 'count-only' \
                or owned.get('windowId') != window.get('id') \
                or not isinstance(owned.get('roots'), list) \
                or source.get('schemaVersion') != 1 \
                or source.get('scope') != 'musicbridge-capacity-source-pins' \
                or not isinstance(source.get('files'), dict):
            fail('OBJECTS_QUEUED_PASS')
        return validate_objects_queued_pass({
            'window': window,
            'close': close,
            'supervision': supervision,
            'files': {
                'windowSha256': window_sha,
                'closeSha256': close_sha,
                'supervisionSha256': supervision_sha,
                'ownedManifestSha256': owned_sha,
                'sourceManifestSha256': source_sha,
            },
        })
    except IssueError:
        raise
    except (KeyError, TypeError, ValueError, OSError) as error:
        raise IssueError('OBJECTS_QUEUED_PASS') from error


def _canonical_time(value):
    try:
        parsed = datetime.datetime.fromisoformat(value)
    except (TypeError, ValueError) as error:
        raise IssueError('AUTHORITY_PAYLOAD') from error
    if parsed.utcoffset() != datetime.timedelta(0) or parsed.microsecond % 1000 != 0:
        fail('AUTHORITY_PAYLOAD')
    return parsed


def build_authority_payload(*, predecessor, window_id, label, issued_at, deadline_at,
                            owned_sha, source_sha, supervisor, supervisor_sha,
                            candidate, consumer, consumer_sha, issuer, issuer_sha,
                            ):
    """构造installed supervisor可消费的精确window及不公开给worker的issuer事实。"""
    predecessor_fact = validate_objects_queued_pass(predecessor)
    issued = _canonical_time(issued_at)
    deadline = _canonical_time(deadline_at)
    if deadline - issued != datetime.timedelta(seconds=1_200) \
            or UUID4.fullmatch(str(window_id)) is None \
            or SAFE.fullmatch(str(label)) is None \
            or any(SHA256.fullmatch(str(value)) is None for value in (
                owned_sha, source_sha, supervisor_sha, consumer_sha, issuer_sha)) \
            or not all(isinstance(value, str) and Path(value).is_absolute() for value in (
                supervisor, consumer, issuer)) \
            or not _mapping(candidate) or set(candidate) != {'root', 'branch', 'head'} \
            or not isinstance(candidate.get('root'), str) or not Path(candidate['root']).is_absolute() \
            or not isinstance(candidate.get('branch'), str) or not candidate['branch'] \
            or GIT_SHA.fullmatch(str(candidate.get('head', ''))) is None:
        fail('AUTHORITY_PAYLOAD')
    window = {
        'schemaVersion': 1,
        'scope': 'musicbridge-capacity-generation-window',
        'owner': 'root',
        'id': window_id,
        'state': 'approved',
        'phase': 'generate',
        'profile': 'joint',
        'label': label,
        'n': 1,
        'issuedAt': issued_at,
        'deadlineAt': deadline_at,
        'limits': dict(GENERATION_LIMITS),
        'ownedManifest': {'file': 'owned-roots.json', 'sha256': owned_sha},
        'sourceManifest': {'file': 'source-pins.json', 'sha256': source_sha},
    }
    fact = {
        'schemaVersion': 1,
        'scope': 'musicbridge-capacity-joint-generation-authority-issuer',
        'windowId': window_id,
        'candidateRepository': dict(candidate),
        'predecessor': predecessor_fact,
        'generationPlan': dict(JOINT_GENERATION_PLAN),
        'supervisor': {'path': supervisor, 'sha256': supervisor_sha},
        'toolchain': {'consumerPython': {'path': consumer, 'sha256': consumer_sha}},
        'issuer': {
            'path': issuer,
            'sha256': issuer_sha,
        },
        'authorityInherited': False,
        'receiptReuseAllowed': False,
        'oldWindowReplayAllowed': False,
        'deviceOpened': False,
        'formalReady': False,
        'gateB': 'NOT_RUN',
    }
    return {'window': window, 'issuerFact': fact}


def _stable_sha256(path, error_code='FILE_IDENTITY', allow_hardlinks=False):
    supplied = Path(path)
    try:
        canonical = supplied.resolve(strict=True)
        info = supplied.lstat()
        if not supplied.is_absolute() or supplied != canonical or supplied.is_symlink() \
                or not stat.S_ISREG(info.st_mode) or not allow_hardlinks and info.st_nlink != 1:
            fail(error_code)
        descriptor = os.open(canonical, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        try:
            before = os.fstat(descriptor)
            digest = hashlib.sha256()
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        named = canonical.lstat()
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
        if any(getattr(before, key) != getattr(after, key)
               or getattr(after, key) != getattr(named, key) for key in fields):
            fail(error_code)
        return canonical, digest.hexdigest()
    except IssueError:
        raise
    except OSError as error:
        raise IssueError(error_code) from error


def _verified_file(path, expected_sha, error_code, executable=False, allow_hardlinks=False):
    if SHA256.fullmatch(str(expected_sha or '')) is None:
        fail(error_code)
    canonical, observed = _stable_sha256(path, error_code, allow_hardlinks=allow_hardlinks)
    if observed != expected_sha or executable and not os.access(canonical, os.X_OK):
        fail(error_code)
    return canonical


def _canonical_directory(path, error_code, parent=None):
    supplied = Path(path)
    try:
        canonical = supplied.resolve(strict=True)
        info = supplied.lstat()
    except OSError as error:
        raise IssueError(error_code) from error
    if not supplied.is_absolute() or supplied != canonical or supplied.is_symlink() \
            or not stat.S_ISDIR(info.st_mode):
        fail(error_code)
    if parent is not None:
        try:
            if os.path.commonpath((str(parent), str(canonical))) != str(parent):
                fail(error_code)
        except ValueError as error:
            raise IssueError(error_code) from error
    return canonical


def _git(root, *arguments, binary=False):
    environment = {
        **{key: value for key, value in os.environ.items() if not key.startswith('GIT_')},
        'GIT_OPTIONAL_LOCKS': '0',
        'GIT_NO_LAZY_FETCH': '1',
    }
    try:
        value = subprocess.check_output(
            ['/usr/bin/git', *arguments], cwd=root, stderr=subprocess.DEVNULL,
            timeout=GIT_TIMEOUT_SECONDS, env=environment)
    except subprocess.TimeoutExpired as error:
        raise IssueError('REPOSITORY_TIMEOUT') from error
    except (OSError, subprocess.CalledProcessError) as error:
        raise IssueError('REPOSITORY_IDENTITY') from error
    return value if binary else value.decode('utf-8').strip()


def _candidate(root, expected_branch, expected_head, issuer, expected_issuer_sha,
               supervisor, expected_supervisor_sha):
    if GIT_SHA.fullmatch(str(expected_head or '')) is None or not expected_branch:
        fail('REPOSITORY_IDENTITY')
    if _git(root, 'rev-parse', '--show-toplevel') != str(root) \
            or _git(root, 'rev-parse', 'HEAD^{commit}') != expected_head \
            or _git(root, 'branch', '--show-current') != expected_branch \
            or _git(root, 'status', '--porcelain=v1', '--untracked-files=all'):
        fail('REPOSITORY_IDENTITY')
    expected_issuer = root / 'scripts/ci/issue-v3-capacity-joint-generation-window.py'
    expected_supervisor = root / 'scripts/ci/capacity-phase-supervisor-v2.py'
    if issuer != expected_issuer or supervisor != expected_supervisor:
        fail('CANDIDATE_FILE_IDENTITY')
    for path, expected_sha, code in (
            (issuer, expected_issuer_sha, 'ISSUER_IDENTITY'),
            (supervisor, expected_supervisor_sha, 'SUPERVISOR_IDENTITY')):
        relative = str(path.relative_to(root))
        if hashlib.sha256(_git(root, 'show', f'{expected_head}:{relative}', binary=True)).hexdigest() \
                != expected_sha:
            fail(code)
    return {'root': str(root), 'branch': expected_branch, 'head': expected_head}


def _expected_source_paths(root):
    paths = [
        'package.json', 'pnpm-lock.yaml', 'packages/bridge-core/package.json',
        'packages/contracts/package.json',
        'packages/contracts/capacity-process-failure-lineage-v1.json',
        'packages/bridge-core/test/benchmarks/recording-capacity.ts',
        'packages/bridge-core/test/benchmarks/recording-capacity-process.ts',
        'scripts/ci/capacity_process_failure_lineage.py',
        'scripts/ci/capacity-phase-supervisor-v2.py',
        'scripts/ci/issue-v3-capacity-measure-window.py',
    ]
    for relative, suffix in (
            ('packages/bridge-core/src', '.ts'),
            ('packages/bridge-core/test/helpers', '.ts'),
            ('packages/contracts/src', '.ts'),
            ('packages/contracts/dist', '.js')):
        directory = root / relative
        if not directory.is_dir() or directory.is_symlink():
            fail('SOURCE_MANIFEST')
        for current, directories, files in os.walk(directory, topdown=True, followlinks=False):
            directories.sort()
            files.sort()
            for name in directories:
                if (Path(current) / name).is_symlink():
                    fail('SOURCE_CANDIDATE')
            for name in files:
                path = Path(current) / name
                if path.is_symlink():
                    fail('SOURCE_CANDIDATE')
                if name.endswith(suffix):
                    paths.append(str(path.relative_to(root)))
                if len(paths) > MAX_SOURCE_FILES:
                    fail('SOURCE_MANIFEST')
    return sorted(paths)


def _source_manifest(root, head, expected_count):
    paths = _expected_source_paths(root)
    if type(expected_count) is not int or expected_count < 1 or expected_count > MAX_SOURCE_FILES \
            or len(paths) != expected_count or len(set(paths)) != len(paths):
        fail('SOURCE_MANIFEST')
    files = {}
    for relative in paths:
        item = Path(relative)
        if item.is_absolute() or '..' in item.parts or relative.startswith('.git/'):
            fail('SOURCE_MANIFEST')
        path = root / item
        try:
            canonical, live_sha = _stable_sha256(path, 'SOURCE_CANDIDATE')
            if os.path.commonpath((str(root), str(canonical))) != str(root):
                fail('SOURCE_CANDIDATE')
        except ValueError as error:
            raise IssueError('SOURCE_CANDIDATE') from error
        blob_sha = hashlib.sha256(_git(root, 'show', f'{head}:{relative}', binary=True)).hexdigest()
        if live_sha != blob_sha:
            fail('SOURCE_CANDIDATE')
        files[relative] = live_sha
    return {'schemaVersion': 1, 'scope': 'musicbridge-capacity-source-pins', 'files': files}


def _owned_root(row):
    if not isinstance(row, dict) or set(row) != {'path', 'device', 'inode', 'marker'}:
        fail('OBJECTS_OWNED_IDENTITY')
    path = _canonical_directory(row.get('path'), 'OBJECTS_OWNED_IDENTITY')
    marker = row.get('marker')
    if not isinstance(marker, dict) or set(marker) != {'relative', 'sha256'} \
            or marker.get('relative') not in OWNED_MARKERS \
            or SHA256.fullmatch(str(marker.get('sha256', ''))) is None:
        fail('OBJECTS_OWNED_IDENTITY')
    info = path.stat()
    _, marker_sha = _stable_sha256(path / marker['relative'], 'OBJECTS_OWNED_IDENTITY')
    if type(row.get('device')) is not int or type(row.get('inode')) is not int \
            or info.st_dev != row['device'] or info.st_ino != row['inode'] \
            or marker_sha != marker['sha256']:
        fail('OBJECTS_OWNED_IDENTITY')
    return {'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
            'marker': {'relative': marker['relative'], 'sha256': marker_sha}}


def _current_root(path, marker, marker_sha):
    info = path.stat()
    return {'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
            'marker': {'relative': marker, 'sha256': marker_sha}}


def _exclusive_json(path, value):
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                             | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    except OSError as error:
        raise IssueError('EXCLUSIVE_CREATE') from error
    try:
        offset = 0
        while offset < len(data):
            offset += os.write(descriptor, data[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return hashlib.sha256(data).hexdigest()


def _fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _copy_verified(source, destination, expected_sha):
    source_descriptor = destination_descriptor = None
    try:
        source_descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        destination_descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                         | getattr(os, 'O_NOFOLLOW', 0), 0o500)
        before = os.fstat(source_descriptor)
        digest = hashlib.sha256()
        while True:
            chunk = os.read(source_descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            offset = 0
            while offset < len(chunk):
                offset += os.write(destination_descriptor, chunk[offset:])
        os.fsync(destination_descriptor)
        after = os.fstat(source_descriptor)
    except OSError as error:
        raise IssueError('SUPERVISOR_IDENTITY') from error
    finally:
        if source_descriptor is not None:
            os.close(source_descriptor)
        if destination_descriptor is not None:
            os.close(destination_descriptor)
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    if digest.hexdigest() != expected_sha \
            or any(getattr(before, key) != getattr(after, key) for key in fields):
        fail('SUPERVISOR_IDENTITY')
    os.chmod(destination, 0o500)
    _verified_file(destination, expected_sha, 'SUPERVISOR_IDENTITY', executable=True)


def _reject_replay(runtime, parent, label):
    if parent.exists() or parent.is_symlink() or (runtime / label).exists() \
            or (runtime / label).is_symlink():
        fail('REPLAY_PATH')
    entries = list(runtime.iterdir())
    if len(entries) > MAX_RUNTIME_ENTRIES:
        fail('RUNTIME_COUNT')
    for entry in entries:
        candidates = []
        if entry.is_dir() and not entry.is_symlink():
            candidates.extend(entry / name for name in ('window.json', 'issuer-failure.json'))
        elif entry.name.endswith('-close.json'):
            candidates.append(entry)
        for candidate in candidates:
            if not candidate.exists() and not candidate.is_symlink():
                continue
            try:
                canonical, digest = _stable_sha256(candidate, 'REPLAY_AUDIT')
                value = _strict_json(canonical, digest)
            except IssueError as error:
                raise IssueError('REPLAY_AUDIT') from error
            observed = value.get('label')
            if observed is None and isinstance(value.get('window'), dict):
                observed = value['window'].get('label')
            if observed == label:
                fail('REPLAY_LABEL')


def _parse_args(argv):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--repo-root', required=True)
    parser.add_argument('--runtime-root', required=True)
    parser.add_argument('--objects-queued-window', required=True)
    parser.add_argument('--expected-objects-queued-window-sha256', required=True)
    parser.add_argument('--objects-queued-close', required=True)
    parser.add_argument('--expected-objects-queued-close-sha256', required=True)
    parser.add_argument('--objects-queued-supervision', required=True)
    parser.add_argument('--expected-objects-queued-supervision-sha256', required=True)
    parser.add_argument('--objects-queued-owned-manifest', required=True)
    parser.add_argument('--expected-objects-queued-owned-sha256', required=True)
    parser.add_argument('--objects-queued-source-manifest', required=True)
    parser.add_argument('--expected-objects-queued-source-sha256', required=True)
    parser.add_argument('--window-dir-name', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--expected-branch', required=True)
    parser.add_argument('--expected-head', required=True)
    parser.add_argument('--expected-source-count', required=True, type=int)
    parser.add_argument('--supervisor', required=True)
    parser.add_argument('--expected-supervisor-sha256', required=True)
    parser.add_argument('--consumer-python', required=True)
    parser.add_argument('--expected-consumer-sha256', required=True)
    parser.add_argument('--expected-issuer-sha256', required=True)
    return parser.parse_args(argv)


def _record_failure(code):
    context = _FAILURE_CONTEXT
    if context is None:
        return
    try:
        _exclusive_json(context['parent'] / 'issuer-failure.json', {
            'schemaVersion': 1,
            'scope': 'musicbridge-capacity-joint-generation-authority-issuer-failure',
            'state': 'TERMINAL_ISSUER_FAILURE',
            'windowId': context['windowId'],
            'label': context['label'],
            'errorCode': code,
            'windowWritten': (context['parent'] / 'window.json').is_file(),
            'replayAllowed': False,
            'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds'),
        })
        _fsync_directory(context['parent'])
        _fsync_directory(context['runtime'])
    except Exception:
        pass


def issue(options):
    global _FAILURE_CONTEXT
    _FAILURE_CONTEXT = None
    root = _canonical_directory(options.repo_root, 'REPOSITORY_IDENTITY')
    runtime = _canonical_directory(options.runtime_root, 'RUNTIME_IDENTITY')
    if SAFE.fullmatch(str(options.window_dir_name or '')) is None \
            or SAFE.fullmatch(str(options.label or '')) is None:
        fail('LABEL_INVALID')
    issuer = _verified_file(Path(__file__).resolve(strict=True), options.expected_issuer_sha256,
                            'ISSUER_IDENTITY')
    supervisor = _verified_file(options.supervisor, options.expected_supervisor_sha256,
                                'SUPERVISOR_IDENTITY')
    consumer = _verified_file(options.consumer_python, options.expected_consumer_sha256,
                              'CONSUMER_IDENTITY', executable=True, allow_hardlinks=True)
    candidate = _candidate(root, options.expected_branch, options.expected_head, issuer,
                           options.expected_issuer_sha256, supervisor,
                           options.expected_supervisor_sha256)
    predecessor = load_objects_queued_pass(
        window_path=options.objects_queued_window,
        window_sha=options.expected_objects_queued_window_sha256,
        close_path=options.objects_queued_close,
        close_sha=options.expected_objects_queued_close_sha256,
        supervision_path=options.objects_queued_supervision,
        supervision_sha=options.expected_objects_queued_supervision_sha256,
        owned_path=options.objects_queued_owned_manifest,
        owned_sha=options.expected_objects_queued_owned_sha256,
        source_path=options.objects_queued_source_manifest,
        source_sha=options.expected_objects_queued_source_sha256)
    predecessor_parent = Path(options.objects_queued_window).parent
    if predecessor_parent.parent != runtime:
        fail('OBJECTS_QUEUED_PASS')
    predecessor_owned = _strict_json(
        options.objects_queued_owned_manifest, options.expected_objects_queued_owned_sha256)
    roots = [_owned_root(row) for row in predecessor_owned['roots']]
    if not roots or len(roots) + 2 > MAX_OWNED_ROOTS:
        fail('OBJECTS_OWNED_IDENTITY')
    unique = {}
    for row in roots:
        if row['path'] in unique and unique[row['path']] != row:
            fail('OBJECTS_OWNED_IDENTITY')
        unique[row['path']] = row

    parent = runtime / options.window_dir_name
    _reject_replay(runtime, parent, options.label)
    source = _source_manifest(root, options.expected_head, options.expected_source_count)

    # 所有外部身份先验证完，之后才独占创建本次不可重放目录。
    window_id = str(uuid.uuid4())
    try:
        parent.mkdir(mode=0o700)
    except OSError as error:
        raise IssueError('EXCLUSIVE_CREATE') from error
    _FAILURE_CONTEXT = {'parent': parent, 'runtime': runtime, 'windowId': window_id,
                        'label': options.label}
    owner_sha = _exclusive_json(parent / 'owner.json', {
        'scope': 'musicbridge-capacity-generation-window', 'owner': 'root', 'id': window_id})
    issuer_identity = parent / 'issuer-identity'
    try:
        issuer_identity.mkdir(mode=0o700)
    except OSError as error:
        raise IssueError('EXCLUSIVE_CREATE') from error
    installed_supervisor = parent / 'supervisor.py'
    _copy_verified(supervisor, installed_supervisor, options.expected_supervisor_sha256)

    issued = datetime.datetime.now(datetime.timezone.utc)
    issued_at = issued.isoformat(timespec='milliseconds')
    deadline_at = (issued + datetime.timedelta(seconds=1_200)).isoformat(timespec='milliseconds')
    placeholder = '0' * 64
    first = build_authority_payload(
        predecessor={
            'window': _strict_json(options.objects_queued_window,
                                   options.expected_objects_queued_window_sha256),
            'close': _strict_json(options.objects_queued_close,
                                  options.expected_objects_queued_close_sha256),
            'supervision': _strict_json(options.objects_queued_supervision,
                                        options.expected_objects_queued_supervision_sha256),
            'files': {
                'windowSha256': options.expected_objects_queued_window_sha256,
                'closeSha256': options.expected_objects_queued_close_sha256,
                'supervisionSha256': options.expected_objects_queued_supervision_sha256,
                'ownedManifestSha256': options.expected_objects_queued_owned_sha256,
                'sourceManifestSha256': options.expected_objects_queued_source_sha256,
            },
        }, window_id=window_id, label=options.label, issued_at=issued_at,
        deadline_at=deadline_at, owned_sha=placeholder, source_sha=placeholder,
        supervisor=str(installed_supervisor), supervisor_sha=options.expected_supervisor_sha256,
        candidate=candidate, consumer=str(consumer), consumer_sha=options.expected_consumer_sha256,
        issuer=str(issuer), issuer_sha=options.expected_issuer_sha256)
    issuer_fact_sha = _exclusive_json(issuer_identity / 'owner.json', first['issuerFact'])
    source_sha = _exclusive_json(parent / 'source-pins.json', source)
    unique[str(parent)] = _current_root(parent, 'owner.json', owner_sha)
    unique[str(issuer_identity)] = _current_root(issuer_identity, 'owner.json', issuer_fact_sha)
    owned = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-owned-roots',
             'access': 'count-only', 'windowId': window_id, 'roots': list(unique.values())}
    owned_sha = _exclusive_json(parent / 'owned-roots.json', owned)

    # 使用将被实际消费的 installed supervisor 做最后的静态 preflight，避免 issuer 与消费者合同漂移。
    try:
        supervisor_contract = runpy.run_path(
            str(installed_supervisor), run_name='musicbridge_capacity_supervisor_preflight')
        if supervisor_contract.get('_GENERATION_LIMITS') != GENERATION_LIMITS:
            fail('SUPERVISOR_CONTRACT')
        source_result = supervisor_contract['_validate_source_manifest'](
            parent / 'source-pins.json', root)
        owned_result = supervisor_contract['_validate_owned_manifest'](
            parent / 'owned-roots.json', runtime, window_id, 'joint')
    except IssueError:
        raise
    except Exception as error:
        raise IssueError('AUTHORITY_PREFLIGHT') from error
    if source_result.get('fileCount') != options.expected_source_count \
            or owned_result.get('rootCount') != len(owned['roots']) \
            or owned_result.get('plannedBytes') != JOINT_GENERATION_PLANNED_BYTES:
        fail('AUTHORITY_PREFLIGHT')
    owned_bytes = owned_result.get('ownedBytes')
    available_bytes = owned_result.get('availableBytes')
    if type(owned_bytes) is not int or type(available_bytes) is not int:
        fail('AUTHORITY_PREFLIGHT')
    final = build_authority_payload(
        predecessor={
            'window': _strict_json(options.objects_queued_window,
                                   options.expected_objects_queued_window_sha256),
            'close': _strict_json(options.objects_queued_close,
                                  options.expected_objects_queued_close_sha256),
            'supervision': _strict_json(options.objects_queued_supervision,
                                        options.expected_objects_queued_supervision_sha256),
            'files': {
                'windowSha256': options.expected_objects_queued_window_sha256,
                'closeSha256': options.expected_objects_queued_close_sha256,
                'supervisionSha256': options.expected_objects_queued_supervision_sha256,
                'ownedManifestSha256': options.expected_objects_queued_owned_sha256,
                'sourceManifestSha256': options.expected_objects_queued_source_sha256,
            },
        }, window_id=window_id, label=options.label, issued_at=issued_at,
        deadline_at=deadline_at, owned_sha=owned_sha, source_sha=source_sha,
        supervisor=str(installed_supervisor), supervisor_sha=options.expected_supervisor_sha256,
        candidate=candidate, consumer=str(consumer), consumer_sha=options.expected_consumer_sha256,
        issuer=str(issuer), issuer_sha=options.expected_issuer_sha256)
    if final['issuerFact'] != first['issuerFact']:
        fail('AUTHORITY_PAYLOAD')

    # 发布前再次确认候选、issuer、supervisor和consumer均未漂移。
    _candidate(root, options.expected_branch, options.expected_head, issuer,
               options.expected_issuer_sha256, supervisor, options.expected_supervisor_sha256)
    _verified_file(consumer, options.expected_consumer_sha256, 'CONSUMER_IDENTITY',
                   executable=True, allow_hardlinks=True)
    pending = parent / 'window.pending.json'
    window_sha = _exclusive_json(pending, final['window'])
    _fsync_directory(issuer_identity)
    _fsync_directory(parent)
    _fsync_directory(runtime)
    try:
        os.rename(pending, parent / 'window.json')
    except OSError as error:
        raise IssueError('ATOMIC_PUBLISH') from error
    try:
        _fsync_directory(parent)
        _fsync_directory(runtime)
    except OSError as error:
        # durable publish未确认时撤回可消费文件；终态失败目录仍永久保留且不可重放。
        try:
            os.rename(parent / 'window.json', parent / 'window.unpublished.json')
            _fsync_directory(parent)
            _fsync_directory(runtime)
        except OSError:
            pass
        raise IssueError('ATOMIC_PUBLISH') from error
    _FAILURE_CONTEXT = None
    return {
        'state': 'ISSUED_NOT_EXECUTED',
        'windowId': window_id,
        'windowPath': str(parent / 'window.json'),
        'windowSha256': window_sha,
        'profile': 'joint',
        'label': options.label,
        'predecessor': predecessor,
        'sourceFileCount': source_result['fileCount'],
        'ownedRootCount': owned_result['rootCount'],
        'ownedBytes': owned_bytes,
        'plannedBytes': JOINT_GENERATION_PLANNED_BYTES,
        'availableBytes': available_bytes,
        'deadlineAt': deadline_at,
        'issuerFact': {'file': 'issuer-identity/owner.json', 'sha256': issuer_fact_sha},
        'consumeCommand': [str(consumer), str(installed_supervisor), '--window',
                           str(parent / 'window.json'), '--window-sha256', window_sha],
    }


def main(argv):
    try:
        value = issue(_parse_args(argv))
    except IssueError as error:
        _record_failure(str(error))
        print(f'JOINT_ISSUER_{error}', file=sys.stderr)
        return 1
    except Exception:
        _record_failure('INTERNAL')
        print('JOINT_ISSUER_INTERNAL', file=sys.stderr)
        return 1
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
