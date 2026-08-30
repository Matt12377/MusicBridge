#!/usr/bin/env python3
"""为冻结 measure manifest 中永久丢失的 fixture 根建立只读控制替代根。

本工具不恢复 fixture 内容、不复制 seed、不运行 benchmark，也不改写历史 manifest。
"""

import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid


SHA256 = re.compile(r'^[0-9a-f]{64}$', re.ASCII)
GIT_SHA = re.compile(r'^[0-9a-f]{40}$', re.ASCII)
SAFE_NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$', re.ASCII)
UUID4 = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    re.ASCII)
SCRIPT_RELATIVE = 'scripts/ci/create-v3-capacity-measure-root-recovery.py'
MISSING_ROOT_COUNT = 7
MEASURE_ROOT_COUNT = 70
LIVE_ROOT_COUNT = 63
TEST_STOP_ENV = 'MUSICBRIDGE_TEST_STOP_AFTER_REPLACEMENTS'


class RecoveryError(Exception):
    pass


def fail(code):
    raise RecoveryError(code)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def regular_file(path):
    path = Path(path)
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink == 1


def canonical_directory(path):
    supplied = Path(path)
    try:
        resolved = supplied.resolve(strict=True)
        info = supplied.lstat()
    except OSError as error:
        raise RecoveryError('DIRECTORY_IDENTITY') from error
    if supplied != resolved or supplied.is_symlink() or not stat.S_ISDIR(info.st_mode):
        fail('DIRECTORY_IDENTITY')
    return resolved


def stable_sha256(path, expected=None, maximum=None):
    path = Path(path)
    if not regular_file(path):
        fail('FILE_IDENTITY')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise RecoveryError('FILE_IDENTITY') from error
    digest = hashlib.sha256()
    try:
        before = os.fstat(descriptor)
        if maximum is not None and before.st_size > maximum:
            fail('FILE_SIZE')
        for chunk in iter(lambda: os.read(descriptor, 1024 * 1024), b''):
            digest.update(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    try:
        named = path.lstat()
    except OSError as error:
        raise RecoveryError('FILE_IDENTITY') from error
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    if any(getattr(before, key) != getattr(after, key)
           or getattr(after, key) != getattr(named, key) for key in fields):
        fail('FILE_CHANGED')
    observed = digest.hexdigest()
    if expected is not None and observed != expected:
        fail('HASH_MISMATCH')
    return {
        'path': str(path), 'sha256': observed, 'device': after.st_dev, 'inode': after.st_ino,
        'size': after.st_size, 'mtimeNs': after.st_mtime_ns, 'ctimeNs': after.st_ctime_ns,
        'nlink': after.st_nlink,
    }


def strict_json(path, expected=None, maximum=16 * 1024 * 1024):
    identity = stable_sha256(path, expected=expected, maximum=maximum)
    try:
        data = Path(path).read_bytes()
        after = Path(path).lstat()
        fields = {
            'st_dev': 'device', 'st_ino': 'inode', 'st_size': 'size',
            'st_mtime_ns': 'mtimeNs', 'st_ctime_ns': 'ctimeNs', 'st_nlink': 'nlink',
        }
        if hashlib.sha256(data).hexdigest() != identity['sha256'] \
                or any(getattr(after, source) != identity[target]
                       for source, target in fields.items()):
            fail('FILE_CHANGED')
        value = json.loads(data.decode('utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RecoveryError('JSON_INVALID') from error
    return value, identity


def compact_json(value):
    try:
        return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    except (TypeError, ValueError) as error:
        raise RecoveryError('JSON_INVALID') from error


def receipt_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def exclusive_bytes(path, data, mode=0o400):
    path = Path(path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags, mode)
    except OSError as error:
        raise RecoveryError('EXCLUSIVE_CREATE') from error
    try:
        os.fchmod(descriptor, mode)
        view = memoryview(data)
        while view:
            count = os.write(descriptor, view)
            if count <= 0:
                fail('PERSISTENCE')
            view = view[count:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(path.parent)


def mkdir_exclusive(path):
    try:
        Path(path).mkdir(mode=0o700)
        os.chmod(path, 0o700)
        fsync_directory(Path(path).parent)
    except OSError as error:
        raise RecoveryError('EXCLUSIVE_CREATE') from error


def _rename_noreplace(runtime_fd, pending_name, final_name):
    """在同一已打开runtime目录内做平台原生的不可覆盖rename。"""
    if '/' in pending_name or '/' in final_name or pending_name in {'', '.', '..'} \
            or final_name in {'', '.', '..'}:
        fail('PUBLISH_IDENTITY')
    source = os.fsencode(pending_name)
    destination = os.fsencode(final_name)
    library = ctypes.CDLL(None, use_errno=True)
    function = None
    flags = None
    if sys.platform == 'darwin':
        function = getattr(library, 'renameatx_np', None)
        flags = 0x00000004  # RENAME_EXCL
    elif sys.platform.startswith('linux'):
        function = getattr(library, 'renameat2', None)
        flags = 0x00000001  # RENAME_NOREPLACE
    if function is None:
        fail('PUBLISH_UNSUPPORTED')
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
                         ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(runtime_fd, source, runtime_fd, destination, flags) != 0:
        observed_errno = ctypes.get_errno()
        if observed_errno in {errno.EEXIST, errno.ENOTEMPTY}:
            fail('PUBLISH_FAILED')
        raise RecoveryError('PUBLISH_FAILED') from OSError(
            observed_errno, os.strerror(observed_errno))


def _same_directory_object(left, right):
    return stat.S_ISDIR(left.st_mode) and stat.S_ISDIR(right.st_mode) \
        and left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _publish_completed_pending(runtime, pending, final, expected, missing):
    runtime_fd = None
    pending_fd = None
    lock_identity = None
    lock_name = f'.{final.name}.publish-lock'
    expected_entries = sorted(
        ['recovery.json'] + [f'replacement-{index:03d}' for index in range(1, 8)])
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_CLOEXEC', 0)
    try:
        runtime_fd = os.open(runtime, flags)
        try:
            os.mkdir(lock_name, mode=0o700, dir_fd=runtime_fd)
        except OSError as error:
            raise RecoveryError('PUBLISH_LOCKED') from error
        lock_identity = os.stat(lock_name, dir_fd=runtime_fd, follow_symlinks=False)
        os.fsync(runtime_fd)

        pending_fd = os.open(
            pending.name, flags | getattr(os, 'O_NOFOLLOW', 0), dir_fd=runtime_fd)
        pending_identity = os.fstat(pending_fd)
        named_pending = os.stat(pending.name, dir_fd=runtime_fd, follow_symlinks=False)
        pending_entries = sorted(os.listdir(pending_fd))
        if not _same_directory_object(pending_identity, named_pending) \
                or stat.S_IMODE(pending_identity.st_mode) != 0o700 \
                or pending_entries != expected_entries:
            fail('PUBLISH_IDENTITY')
        validate_completed_pending(pending, final, expected)
        require_originals_absent(missing)
        try:
            os.stat(final.name, dir_fd=runtime_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        except OSError as error:
            raise RecoveryError('PUBLISH_FAILED') from error
        else:
            fail('PUBLISH_FAILED')

        named_pending = os.stat(pending.name, dir_fd=runtime_fd, follow_symlinks=False)
        if not _same_directory_object(pending_identity, named_pending) \
                or sorted(os.listdir(pending_fd)) != pending_entries:
            fail('PUBLISH_IDENTITY')
        _rename_noreplace(runtime_fd, pending.name, final.name)

        published = os.stat(final.name, dir_fd=runtime_fd, follow_symlinks=False)
        still_open = os.fstat(pending_fd)
        if not _same_directory_object(pending_identity, published) \
                or not _same_directory_object(pending_identity, still_open) \
                or sorted(os.listdir(pending_fd)) != pending_entries:
            fail('PUBLISH_IDENTITY')
        validate_completed_pending(final, final, expected)
        require_originals_absent(missing)
        os.fsync(runtime_fd)
    except FileNotFoundError as error:
        raise RecoveryError('PUBLISH_IDENTITY') from error
    finally:
        if pending_fd is not None:
            os.close(pending_fd)
        if runtime_fd is not None:
            if lock_identity is not None:
                try:
                    current_lock = os.stat(lock_name, dir_fd=runtime_fd, follow_symlinks=False)
                    lock_fd = os.open(
                        lock_name, flags | getattr(os, 'O_NOFOLLOW', 0), dir_fd=runtime_fd)
                    try:
                        lock_empty = not os.listdir(lock_fd)
                    finally:
                        os.close(lock_fd)
                    if _same_directory_object(lock_identity, current_lock) and lock_empty:
                        os.rmdir(lock_name, dir_fd=runtime_fd)
                        os.fsync(runtime_fd)
                except OSError:
                    pass
            os.close(runtime_fd)


def git_value(root, *arguments):
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update({'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_LAZY_FETCH': '1'})
    try:
        return subprocess.check_output(
            ['/usr/bin/git', *arguments], cwd=root, text=True, stderr=subprocess.DEVNULL,
            timeout=15, env=environment).strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise RecoveryError('REPOSITORY_IDENTITY') from error


def git_blob(root, head, relative):
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update({'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_LAZY_FETCH': '1'})
    try:
        return subprocess.check_output(
            ['/usr/bin/git', 'show', f'{head}:{relative}'], cwd=root,
            stderr=subprocess.DEVNULL, timeout=15, env=environment)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise RecoveryError('RECOVERY_TOOL_IDENTITY') from error


def validate_repository(options):
    root = canonical_directory(Path(options.repo_root))
    if GIT_SHA.fullmatch(options.expected_head or '') is None \
            or SHA256.fullmatch(options.expected_script_sha256 or '') is None:
        fail('REPOSITORY_IDENTITY')
    script = Path(__file__)
    try:
        script = script.resolve(strict=True)
    except OSError as error:
        raise RecoveryError('RECOVERY_TOOL_IDENTITY') from error
    expected_script = root / SCRIPT_RELATIVE
    if script != expected_script or not regular_file(script):
        fail('RECOVERY_TOOL_IDENTITY')
    working = stable_sha256(script, expected=options.expected_script_sha256, maximum=2 * 1024 * 1024)
    blob_sha = hashlib.sha256(git_blob(root, options.expected_head, SCRIPT_RELATIVE)).hexdigest()
    if blob_sha != options.expected_script_sha256:
        fail('RECOVERY_TOOL_IDENTITY')
    head = git_value(root, 'rev-parse', 'HEAD^{commit}')
    branch = git_value(root, 'branch', '--show-current')
    top = git_value(root, 'rev-parse', '--show-toplevel')
    upstream = git_value(root, 'rev-parse', '@{u}^{commit}')
    dirty = git_value(root, 'status', '--porcelain=v1', '--untracked-files=all')
    if top != str(root) or head != options.expected_head or branch != options.expected_branch \
            or upstream != head or dirty:
        fail('REPOSITORY_IDENTITY')
    return root, {
        'root': str(root), 'branch': branch, 'head': head, 'clean': True, 'pushedHead': True,
    }, {
        'path': str(script), 'relativePath': SCRIPT_RELATIVE,
        'workingSha256': working['sha256'], 'gitBlobSha256': blob_sha,
    }


def validate_root_row(row):
    if not isinstance(row, dict) or set(row) != {'path', 'device', 'inode', 'marker'} \
            or not isinstance(row.get('path'), str) or not Path(row['path']).is_absolute() \
            or type(row.get('device')) is not int or type(row.get('inode')) is not int:
        fail('MEASURE_OWNED_MANIFEST')
    marker = row.get('marker')
    if not isinstance(marker, dict) or set(marker) != {'relative', 'sha256'} \
            or not isinstance(marker.get('relative'), str) \
            or '/' in marker['relative'] or marker['relative'] in {'', '.', '..'} \
            or SHA256.fullmatch(str(marker.get('sha256', ''))) is None:
        fail('MEASURE_OWNED_MANIFEST')
    path = Path(row['path'])
    if Path(os.path.normpath(str(path))) != path or path.resolve(strict=False) != path:
        fail('MEASURE_OWNED_MANIFEST')
    return {
        'path': str(path), 'device': row['device'], 'inode': row['inode'],
        'marker': {'relative': marker['relative'], 'sha256': marker['sha256']},
    }


def validate_present_root(row):
    path = canonical_directory(row['path'])
    info = path.stat()
    if info.st_dev != row['device'] or info.st_ino != row['inode']:
        fail('MEASURE_OWNED_MANIFEST')
    marker = path / row['marker']['relative']
    if stable_sha256(marker, expected=row['marker']['sha256'], maximum=1024 * 1024)['sha256'] \
            != row['marker']['sha256']:
        fail('MEASURE_OWNED_MANIFEST')


def validate_manifest(options, runtime, declared_missing=None):
    path = Path(options.measure_owned_manifest)
    try:
        canonical = path.resolve(strict=True)
    except OSError as error:
        raise RecoveryError('MEASURE_OWNED_MANIFEST') from error
    if not path.is_absolute() or canonical != path or path.is_symlink() \
            or os.path.commonpath((str(runtime), str(path))) != str(runtime) \
            or SHA256.fullmatch(options.expected_measure_owned_sha256 or '') is None:
        fail('MEASURE_OWNED_MANIFEST')
    value, identity = strict_json(path, expected=options.expected_measure_owned_sha256)
    required = {'schemaVersion', 'scope', 'access', 'windowId', 'roots', 'futureRoots'}
    if not isinstance(value, dict) or set(value) != required \
            or value.get('schemaVersion') != 1 \
            or value.get('scope') != 'musicbridge-capacity-owned-roots' \
            or value.get('access') != 'count-only' \
            or value.get('windowId') != options.expected_window_id \
            or not isinstance(value.get('roots'), list) or len(value['roots']) != MEASURE_ROOT_COUNT:
        fail('MEASURE_OWNED_MANIFEST')
    if not isinstance(value['futureRoots'], list) or len(value['futureRoots']) != 1 \
            or not isinstance(value['futureRoots'][0], str):
        fail('MEASURE_OWNED_MANIFEST')
    future = Path(value['futureRoots'][0])
    if not future.is_absolute() or Path(os.path.normpath(str(future))) != future \
            or future.resolve(strict=False) != future \
            or os.path.commonpath((str(runtime), str(future))) != str(runtime):
        fail('MEASURE_OWNED_MANIFEST')
    rows = [validate_root_row(row) for row in value['roots']]
    if len({row['path'] for row in rows}) != len(rows):
        fail('MEASURE_OWNED_MANIFEST')
    missing = []
    for row in rows:
        try:
            Path(row['path']).lstat()
        except FileNotFoundError:
            if row['marker']['relative'] != 'capacity-owner.json':
                fail('MEASURE_OWNED_MANIFEST')
            missing.append(row)
        except OSError as error:
            raise RecoveryError('MEASURE_OWNED_MANIFEST') from error
        else:
            if declared_missing is not None and row['path'] in declared_missing:
                fail('ORIGINAL_ROOT_PRESENT')
            validate_present_root(row)
    if len(missing) != MISSING_ROOT_COUNT:
        fail('MISSING_ROOT_EVIDENCE')
    if len(rows) - len(missing) != LIVE_ROOT_COUNT \
            or value['futureRoots'][0] in {row['path'] for row in rows}:
        fail('MEASURE_OWNED_MANIFEST')
    return path, identity, missing


def validate_evidence(paths, missing):
    if len(paths) != MISSING_ROOT_COUNT:
        fail('MISSING_ROOT_EVIDENCE')
    expected = {row['path']: row for row in missing}
    observed = {}
    for supplied in paths:
        path = Path(supplied)
        try:
            canonical = path.resolve(strict=True)
        except OSError as error:
            raise RecoveryError('MISSING_ROOT_EVIDENCE') from error
        if not path.is_absolute() or path != canonical or path.is_symlink():
            fail('MISSING_ROOT_EVIDENCE')
        value, _ = strict_json(path, maximum=1024 * 1024)
        if not isinstance(value, dict) or set(value) != {'fixtureDirectory', 'marker'} \
                or not isinstance(value.get('fixtureDirectory'), str) \
                or not isinstance(value.get('marker'), dict):
            fail('MISSING_ROOT_EVIDENCE')
        original = value['fixtureDirectory']
        if original not in expected or original in observed:
            fail('MISSING_ROOT_EVIDENCE')
        marker_bytes = compact_json(value['marker'])
        if hashlib.sha256(marker_bytes).hexdigest() != expected[original]['marker']['sha256']:
            fail('MARKER_EVIDENCE_MISMATCH')
        observed[original] = {'marker': value['marker'], 'markerBytes': marker_bytes}
    if set(observed) != set(expected):
        fail('MISSING_ROOT_EVIDENCE')
    return observed


def evidence_directories(paths):
    directories = []
    for supplied in paths:
        path = Path(supplied)
        try:
            canonical = path.resolve(strict=True)
        except OSError as error:
            raise RecoveryError('MISSING_ROOT_EVIDENCE') from error
        if not path.is_absolute() or path != canonical or path.is_symlink():
            fail('MISSING_ROOT_EVIDENCE')
        value, _ = strict_json(path, maximum=1024 * 1024)
        if not isinstance(value, dict) or set(value) != {'fixtureDirectory', 'marker'} \
                or not isinstance(value.get('fixtureDirectory'), str) \
                or not isinstance(value.get('marker'), dict):
            fail('MISSING_ROOT_EVIDENCE')
        directories.append(value['fixtureDirectory'])
    return set(directories)


def require_originals_absent(missing):
    for row in missing:
        path = Path(row['path'])
        try:
            path.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise RecoveryError('ORIGINAL_ROOT_PRESENT') from error
        fail('ORIGINAL_ROOT_PRESENT')


def pending_owner_marker(historical_root):
    return {
        'schemaVersion': 1,
        'scope': 'musicbridge-capacity-historical-control-only',
        'id': str(uuid.uuid4()),
        'role': 'historical-control-only',
        'historicalRoot': historical_root,
        'recovered': False,
    }


def pending_value(name, manifest_fact, repository, recovery_tool, benchmark, missing):
    return {
        'schemaVersion': 1,
        'scope': 'musicbridge-capacity-measure-root-recovery-pending',
        'state': 'PENDING',
        'recoveryDirectoryName': name,
        'historicalManifest': manifest_fact,
        'repository': repository,
        'recoveryTool': recovery_tool,
        'activeBenchmarkInput': benchmark,
        'plans': [
            {
                'directoryName': f'replacement-{index:03d}',
                'historicalRoot': row,
                'ownerMarker': pending_owner_marker(row),
            }
            for index, row in enumerate(missing, 1)
        ],
    }


def validate_pending_value(value, name, manifest_fact, repository, recovery_tool, benchmark, missing):
    keys = {'schemaVersion', 'scope', 'state', 'recoveryDirectoryName', 'historicalManifest',
            'repository', 'recoveryTool', 'activeBenchmarkInput', 'plans'}
    if not isinstance(value, dict) or set(value) != keys or value.get('schemaVersion') != 1 \
            or value.get('scope') != 'musicbridge-capacity-measure-root-recovery-pending' \
            or value.get('state') != 'PENDING' or value.get('recoveryDirectoryName') != name \
            or value.get('historicalManifest') != manifest_fact \
            or value.get('repository') != repository or value.get('recoveryTool') != recovery_tool \
            or value.get('activeBenchmarkInput') != benchmark \
            or not isinstance(value.get('plans'), list) or len(value['plans']) != MISSING_ROOT_COUNT:
        fail('PENDING_INVALID')
    for index, (plan, row) in enumerate(zip(value['plans'], missing), 1):
        marker = plan.get('ownerMarker') if isinstance(plan, dict) else None
        if not isinstance(plan, dict) or set(plan) != {'directoryName', 'historicalRoot', 'ownerMarker'} \
                or plan.get('directoryName') != f'replacement-{index:03d}' \
                or plan.get('historicalRoot') != row or not isinstance(marker, dict) \
                or set(marker) != {'schemaVersion', 'scope', 'id', 'role', 'historicalRoot', 'recovered'} \
                or marker.get('schemaVersion') != 1 \
                or marker.get('scope') != 'musicbridge-capacity-historical-control-only' \
                or UUID4.fullmatch(str(marker.get('id', ''))) is None \
                or marker.get('role') != 'historical-control-only' \
                or marker.get('historicalRoot') != row or marker.get('recovered') is not False:
            fail('PENDING_INVALID')
    return value


def directory_identity(path, expected_entries=None):
    path = Path(path)
    try:
        info = path.lstat()
        entries = sorted(item.name for item in path.iterdir())
    except OSError as error:
        raise RecoveryError('PENDING_INVALID') from error
    if path.is_symlink() or not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 \
            or expected_entries is not None and entries != sorted(expected_entries):
        fail('PENDING_INVALID')
    return info, entries


def replacement_row(path, marker_sha):
    info, _ = directory_identity(path, expected_entries=['owner.json'])
    marker_path = Path(path) / 'owner.json'
    try:
        marker_identity = stable_sha256(marker_path, expected=marker_sha, maximum=1024 * 1024)
    except RecoveryError as error:
        raise RecoveryError('PENDING_INVALID') from error
    if stat.S_IMODE(marker_path.stat().st_mode) != 0o400:
        fail('PENDING_INVALID')
    return {
        'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
        'role': 'historical-control-only',
        'marker': {'relative': 'owner.json', 'sha256': marker_identity['sha256']},
    }


def build_receipt(name, window_id, manifest_fact, repository, recovery_tool, benchmark, plans, pending):
    mappings = []
    for plan in plans:
        replacement = pending / plan['directoryName']
        marker_sha = hashlib.sha256(compact_json(plan['ownerMarker'])).hexdigest()
        mappings.append({
            'historicalRoot': plan['historicalRoot'],
            'state': 'LOST',
            'recovered': False,
            'replacementRoot': replacement_row(replacement, marker_sha),
        })
    return {
        'schemaVersion': 1,
        'scope': 'musicbridge-capacity-measure-root-recovery',
        'access': 'read-only',
        'state': 'PUBLISHED',
        'model': 'exact75-v2-replacement-closure',
        'windowId': window_id,
        'historicalManifest': manifest_fact,
        'repository': repository,
        'recoveryTool': recovery_tool,
        'mappings': mappings,
        'activeBenchmarkInput': benchmark,
        'contentRecovered': False,
        'historicalManifestRewritten': False,
        'deviceOpened': False,
        'formalReady': False,
        'gateB': 'NOT_RUN',
    }


def receipt_for_final_path(receipt, pending, final):
    value = json.loads(json.dumps(receipt))
    for mapping in value['mappings']:
        path = Path(mapping['replacementRoot']['path'])
        mapping['replacementRoot']['path'] = str(final / path.relative_to(pending))
    return value


def validate_completed_pending(pending, final, expected):
    receipt_path = pending / 'recovery.json'
    value, _ = strict_json(receipt_path, maximum=4 * 1024 * 1024)
    if stat.S_IMODE(receipt_path.stat().st_mode) != 0o400 or value != expected:
        fail('PENDING_INVALID')
    expected_entries = ['recovery.json'] + [f'replacement-{index:03d}' for index in range(1, 8)]
    directory_identity(pending, expected_entries=expected_entries)


def parse_args(argv):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--repo-root', required=True)
    parser.add_argument('--expected-branch', required=True)
    parser.add_argument('--expected-head', required=True)
    parser.add_argument('--expected-script-sha256', required=True)
    parser.add_argument('--runtime-root', required=True)
    parser.add_argument('--measure-owned-manifest', required=True)
    parser.add_argument('--expected-measure-owned-sha256', required=True)
    parser.add_argument('--expected-window-id', required=True)
    parser.add_argument('--recovery-dir-name', required=True)
    parser.add_argument('--durable-seed-snapshot', required=True)
    parser.add_argument('--expected-durable-seed-snapshot-sha256', required=True)
    parser.add_argument('--evidence-json', action='append', required=True)
    return parser.parse_args(argv)


def issue(options):
    if SAFE_NAME.fullmatch(options.recovery_dir_name or '') is None:
        fail('RECOVERY_DIRECTORY_NAME')
    root, repository, recovery_tool = validate_repository(options)
    runtime = canonical_directory(Path(options.runtime_root))
    if runtime == root or os.path.commonpath((str(root), str(runtime))) == str(root):
        fail('RUNTIME_BOUNDARY')
    final = runtime / options.recovery_dir_name
    pending = runtime / f'.{options.recovery_dir_name}.pending'
    if final.exists() or final.is_symlink():
        fail('RECOVERY_DIRECTORY_EXISTS')

    declared_missing = evidence_directories(options.evidence_json)
    manifest_path, manifest_identity, missing = validate_manifest(
        options, runtime, declared_missing=declared_missing)
    validate_evidence(options.evidence_json, missing)
    require_originals_absent(missing)
    if SHA256.fullmatch(options.expected_durable_seed_snapshot_sha256 or '') is None:
        fail('BENCHMARK_INPUT')
    snapshot_supplied = Path(options.durable_seed_snapshot)
    try:
        snapshot_info = snapshot_supplied.lstat()
        snapshot = snapshot_supplied.resolve(strict=True)
    except OSError as error:
        raise RecoveryError('BENCHMARK_INPUT') from error
    if not snapshot_supplied.is_absolute() or snapshot_supplied != snapshot \
            or snapshot_supplied.is_symlink() or not stat.S_ISREG(snapshot_info.st_mode) \
            or snapshot.name != 'seed.sqlite' \
            or os.path.commonpath((str(runtime), str(snapshot))) != str(runtime):
        fail('BENCHMARK_INPUT')
    snapshot_identity = stable_sha256(
        snapshot, expected=options.expected_durable_seed_snapshot_sha256)
    manifest_fact = {'path': str(manifest_path), 'sha256': manifest_identity['sha256']}
    benchmark = {
        'model': 'durable-seed-snapshot', 'path': str(snapshot),
        'sha256': snapshot_identity['sha256'],
    }

    pending_path = pending / 'pending.json'
    if pending.exists() or pending.is_symlink():
        directory_identity(pending)
        if pending_path.exists() and regular_file(pending_path):
            value, _ = strict_json(pending_path, maximum=4 * 1024 * 1024)
            if stat.S_IMODE(pending_path.stat().st_mode) != 0o400:
                fail('PENDING_INVALID')
            plan = validate_pending_value(
                value, options.recovery_dir_name, manifest_fact, repository,
                recovery_tool, benchmark, missing)
        elif (pending / 'recovery.json').exists():
            plan = None
        else:
            fail('PENDING_INVALID')
    else:
        mkdir_exclusive(pending)
        plan = pending_value(
            options.recovery_dir_name, manifest_fact, repository,
            recovery_tool, benchmark, missing)
        exclusive_bytes(pending_path, receipt_bytes(plan))

    if plan is not None:
        allowed = {'pending.json', 'recovery.json'} | {
            f'replacement-{index:03d}' for index in range(1, MISSING_ROOT_COUNT + 1)}
        _, entries = directory_identity(pending)
        if any(entry not in allowed for entry in entries):
            fail('PENDING_INVALID')
        stop_after_raw = os.environ.get(TEST_STOP_ENV)
        stop_after = None
        if stop_after_raw is not None:
            try:
                stop_after = int(stop_after_raw)
            except ValueError:
                fail('TEST_STOP_INVALID')
            if stop_after < 1 or stop_after > MISSING_ROOT_COUNT:
                fail('TEST_STOP_INVALID')
        for index, item in enumerate(plan['plans'], 1):
            destination = pending / item['directoryName']
            marker_path = destination / 'owner.json'
            marker_bytes = compact_json(item['ownerMarker'])
            marker_sha = hashlib.sha256(marker_bytes).hexdigest()
            if destination.exists() or destination.is_symlink():
                replacement_row(destination, marker_sha)
                try:
                    marker_value = json.loads(marker_path.read_bytes().decode('utf-8'))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise RecoveryError('PENDING_INVALID') from error
                if marker_value != item['ownerMarker'] or marker_path.read_bytes() != marker_bytes:
                    fail('PENDING_INVALID')
            else:
                mkdir_exclusive(destination)
                exclusive_bytes(marker_path, marker_bytes)
            if stop_after == index:
                fsync_directory(pending)
                os._exit(75)

        pending_receipt = build_receipt(
            options.recovery_dir_name, options.expected_window_id, manifest_fact, repository, recovery_tool,
            benchmark, plan['plans'], pending)
        final_receipt = receipt_for_final_path(pending_receipt, pending, final)
        completed_receipt = final_receipt
        recovery_path = pending / 'recovery.json'
        if recovery_path.exists() or recovery_path.is_symlink():
            existing, _ = strict_json(recovery_path, maximum=4 * 1024 * 1024)
            if existing != final_receipt:
                fail('PENDING_INVALID')
        else:
            exclusive_bytes(recovery_path, receipt_bytes(final_receipt))
        try:
            pending_path.unlink()
        except OSError as error:
            raise RecoveryError('PERSISTENCE') from error
        fsync_directory(pending)
        validate_completed_pending(pending, final, final_receipt)
    else:
        plans = []
        for index, row in enumerate(missing, 1):
            destination = pending / f'replacement-{index:03d}'
            marker_path = destination / 'owner.json'
            try:
                marker = json.loads(marker_path.read_bytes().decode('utf-8'))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise RecoveryError('PENDING_INVALID') from error
            plans.append({'directoryName': destination.name, 'historicalRoot': row, 'ownerMarker': marker})
        validate_pending_value({
            'schemaVersion': 1,
            'scope': 'musicbridge-capacity-measure-root-recovery-pending',
            'state': 'PENDING',
            'recoveryDirectoryName': options.recovery_dir_name,
            'historicalManifest': manifest_fact,
            'repository': repository,
            'recoveryTool': recovery_tool,
            'activeBenchmarkInput': benchmark,
            'plans': plans,
        }, options.recovery_dir_name, manifest_fact, repository, recovery_tool, benchmark, missing)
        expected = receipt_for_final_path(build_receipt(
            options.recovery_dir_name, options.expected_window_id, manifest_fact, repository, recovery_tool,
            benchmark, plans, pending), pending, final)
        validate_completed_pending(pending, final, expected)
        completed_receipt = expected

    # 发布前重读全部外部身份；历史路径重现或候选漂移一律停止并保留 pending。
    require_originals_absent(missing)
    validate_manifest(options, runtime, declared_missing=declared_missing)
    validate_evidence(options.evidence_json, missing)
    current_snapshot = snapshot.lstat()
    snapshot_fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    if any(getattr(current_snapshot, key) != snapshot_identity[{
            'st_dev': 'device', 'st_ino': 'inode', 'st_size': 'size',
            'st_mtime_ns': 'mtimeNs', 'st_ctime_ns': 'ctimeNs', 'st_nlink': 'nlink'}[key]]
           for key in snapshot_fields):
        fail('BENCHMARK_INPUT')
    validate_repository(options)
    _publish_completed_pending(runtime, pending, final, completed_receipt, missing)
    return {
        'state': 'PUBLISHED',
        'recoveryDirectoryName': options.recovery_dir_name,
        'replacementCount': MISSING_ROOT_COUNT,
        'contentRecovered': False,
        'historicalManifestRewritten': False,
        'benchmarkDataSource': 'durable-seed-snapshot',
        'gateB': 'NOT_RUN',
    }


def main(argv):
    try:
        value = issue(parse_args(argv))
    except RecoveryError as error:
        print(f'MEASURE_ROOT_RECOVERY={error}', file=sys.stderr)
        return 1
    except Exception:
        print('MEASURE_ROOT_RECOVERY=INTERNAL_ERROR', file=sys.stderr)
        return 1
    print(json.dumps(value, ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
