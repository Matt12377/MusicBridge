#!/usr/bin/env python3
"""一次性签发 objects-limit queued-stop authority；只写控制文件，不执行 benchmark。"""

import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import uuid


SAFE = re.compile(r'^[a-z0-9-]{1,64}$', re.ASCII)
SHA256 = re.compile(r'^[0-9a-f]{64}$', re.ASCII)
GIT_SHA = re.compile(r'^[0-9a-f]{40}$', re.ASCII)
UUID4 = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.ASCII)
MARKERS = {'owner.json', 'capacity-owner.json', 'seed.json', 'command.json', 'r020-owner.json'}
LIMITS = {'executionMs': 50_000, 'killGraceMs': 1_000, 'closeMs': 2_000,
          'minimumFreeBytes': 10 * 1024 ** 3, 'maximumOwnedBytes': 16 * 1024 ** 3}
EVIDENCE_ALLOWANCE = 256 * 1024 ** 2
EXPECTED_SOURCE_COUNT = 241
EXPECTED_MEASURE_ROOTS = 70
EXPECTED_CONCRETE_ROOTS = 71
BASE_AUTHORITY_ROOTS = 73
FROZEN_MEASURE = {
    'windowId': 'afc81a99-d15d-4179-8326-5774a5c40b62',
    'windowSha256': 'cfac8e19336a181de00c68d458d046065cd821a0dca48cc4fc78af0e15c15227',
    'closeSha256': '1c93f6c6ec1a0b58619f87127d3e2c7d11a1cfcce1c155b3576a84eda2af84b7',
    'ownedSha256': 'cd6faddd3b205f290e379cec95af9c20a6fbbbbfd2c7989ef07ff2712bc3c4ab',
    'sourceSha256': '71bfb77f9c706ae9d31f580d4067f7ff427ee1099c341f03915d39ab1edff503',
    'supervisionSha256': '18ef840fe99b861ca8881c7c7be09b70c13431df02d88ddf282e29f2169cdc92',
    'installedSupervisorSha256': 'aaf871474dfe8129bae76ff8d2f07ed4f9a1200801d9108d005e6bbd1823e743',
    'outputCommandSha256': '4a0417df8056764a5ba6a24ffda42d7be590cb4bfbd480b5d7188d8d609b8231',
    'seedMetadataSha256': '632d8e4b0c01ffec07adc72344e7bcc877e5f1d764e7745af856c6ba44492309',
    'seedSnapshotSha256': '7ec9b3bed1642503cc9fcee70c6156b54eb43834b0a457050ec51607f2e1ab3a',
    'seedSnapshotBytes': 1_990_471_680,
    'seedFixtureOwnerSha256': '8e885bdee2c2acd6ba6b189f6de6c88bcb5e3a4b84d838a9b56e30987eb716c1',
    'measureLabel': 'r023-objects-limit-measure-06',
    'seedLabel': 'r023-objects-limit-seed-03',
}
_FAILURE = None


class IssueError(Exception):
    pass


def fail(code):
    raise IssueError(code)


def ordinary(path):
    path = Path(path)
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink == 1


def sha256(path):
    path = Path(path)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise IssueError('FILE_IDENTITY') from error
    digest = hashlib.sha256()
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail('FILE_IDENTITY')
        for chunk in iter(lambda: os.read(descriptor, 1024 * 1024), b''):
            digest.update(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    try:
        named = path.lstat()
    except OSError as error:
        raise IssueError('FILE_IDENTITY') from error
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    if any(getattr(before, key) != getattr(after, key) or getattr(after, key) != getattr(named, key)
           for key in fields):
        fail('FILE_CHANGED')
    return digest.hexdigest()


def file_snapshot(path, expected_sha):
    path = Path(path)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try: descriptor = os.open(path, flags)
    except OSError as error: raise IssueError('FILE_IDENTITY') from error
    digest = hashlib.sha256()
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail('FILE_IDENTITY')
        for chunk in iter(lambda: os.read(descriptor, 1024 * 1024), b''): digest.update(chunk)
        after = os.fstat(descriptor)
    finally: os.close(descriptor)
    try: named = path.lstat()
    except OSError as error: raise IssueError('FILE_IDENTITY') from error
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    observed_sha = digest.hexdigest()
    if observed_sha != expected_sha or any(
            getattr(before, key) != getattr(after, key) or getattr(after, key) != getattr(named, key)
            for key in fields):
        fail('FILE_CHANGED')
    return {'path': str(path), 'device': before.st_dev, 'inode': before.st_ino,
            'size': before.st_size, 'mtimeNs': before.st_mtime_ns, 'ctimeNs': before.st_ctime_ns,
            'sha256': observed_sha}


def directory_snapshot(path, expected_entries):
    path = Path(path)
    try:
        before = path.lstat(); entries = sorted(value.name for value in path.iterdir()); after = path.lstat()
    except OSError as error:
        raise IssueError('DIRECTORY_IDENTITY') from error
    fields = ('st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    if path.is_symlink() or not stat.S_ISDIR(before.st_mode) \
            or any(getattr(before, key) != getattr(after, key) for key in fields) \
            or entries != sorted(expected_entries):
        fail('DIRECTORY_IDENTITY')
    return {'path': str(path), 'device': before.st_dev, 'inode': before.st_ino,
            'mtimeNs': before.st_mtime_ns, 'ctimeNs': before.st_ctime_ns, 'entries': entries}


def strict_json(path, expected_sha=None, maximum=16 * 1024 * 1024):
    path = Path(path)
    if not ordinary(path):
        fail('JSON_IDENTITY')
    before = path.stat()
    if before.st_size > maximum:
        fail('JSON_SIZE')
    data = path.read_bytes()
    after = path.stat()
    if any(getattr(before, key) != getattr(after, key)
           for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')):
        fail('FILE_CHANGED')
    digest = hashlib.sha256(data).hexdigest()
    if expected_sha is not None and digest != expected_sha:
        fail('HASH_MISMATCH')
    try:
        return json.loads(data.decode('utf-8')), digest
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IssueError('JSON_INVALID') from error


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def exclusive_json(path, value):
    path = Path(path)
    data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise IssueError('EXCLUSIVE_CREATE') from error
    try:
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
    return hashlib.sha256(data).hexdigest()


def canonical_directory(path, parent=None):
    supplied = Path(path)
    try:
        resolved = supplied.resolve(strict=True)
        info = supplied.lstat()
    except OSError as error:
        raise IssueError('DIRECTORY_IDENTITY') from error
    if supplied != resolved or supplied.is_symlink() or not stat.S_ISDIR(info.st_mode):
        fail('DIRECTORY_IDENTITY')
    if parent is not None and os.path.commonpath((str(parent), str(resolved))) != str(parent):
        fail('DIRECTORY_BOUNDARY')
    return resolved


def git_value(root, *arguments):
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update({'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_LAZY_FETCH': '1'})
    try:
        return subprocess.check_output(['/usr/bin/git', *arguments], cwd=root, text=True,
                                       stderr=subprocess.DEVNULL, timeout=15,
                                       env=environment).strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise IssueError('REPOSITORY_IDENTITY') from error


def git_blob(root, head, relative):
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update({'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_LAZY_FETCH': '1'})
    try:
        return subprocess.check_output(['/usr/bin/git', 'show', f'{head}:{relative}'], cwd=root,
                                       stderr=subprocess.DEVNULL, timeout=15, env=environment)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise IssueError('SOURCE_CANDIDATE') from error


def verified_file(path, expected_sha, code, executable=False):
    path = Path(path).resolve(strict=True)
    if not ordinary(path) or sha256(path) != expected_sha or (executable and not os.access(path, os.X_OK)):
        fail(code)
    return path


def current_root(path, marker_relative):
    path = canonical_directory(path)
    if marker_relative not in MARKERS or not ordinary(path / marker_relative):
        fail('OWNED_IDENTITY')
    info = path.stat()
    return {'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
            'marker': {'relative': marker_relative, 'sha256': sha256(path / marker_relative)}}


def validate_root(row):
    if not isinstance(row, dict) or set(row) != {'path', 'device', 'inode', 'marker'}:
        fail('OWNED_IDENTITY')
    marker = row.get('marker')
    if not isinstance(marker, dict) or set(marker) != {'relative', 'sha256'} \
            or marker.get('relative') not in MARKERS \
            or SHA256.fullmatch(str(marker.get('sha256', ''))) is None:
        fail('OWNED_IDENTITY')
    path = canonical_directory(row.get('path'))
    info = path.stat()
    if info.st_dev != row.get('device') or info.st_ino != row.get('inode') \
            or sha256(path / marker['relative']) != marker['sha256']:
        fail('OWNED_IDENTITY')
    return {'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
            'marker': dict(marker)}


def unique_roots(rows):
    result = {}
    for value in rows:
        row = validate_root(value)
        existing = result.get(row['path'])
        if existing is not None and existing != row:
            fail('OWNED_COLLISION')
        result[row['path']] = row
    return result


def directory_bytes(path, maximum=16 * 1024 ** 3, maximum_entries=250_000):
    total = 0
    count = 0
    stack = [Path(path)]
    while stack:
        current = stack.pop()
        try:
            entries = list(current.iterdir())
        except OSError as error:
            raise IssueError('OWNED_IDENTITY') from error
        for item in entries:
            count += 1
            if count > maximum_entries or item.is_symlink():
                fail('OWNED_IDENTITY')
            info = item.lstat()
            if stat.S_ISDIR(info.st_mode):
                stack.append(item)
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                if total > maximum:
                    fail('OWNED_SPACE')
            else:
                fail('OWNED_IDENTITY')
    return total


def owned_facts(rows, planned, runtime):
    paths = [Path(row['path']) for row in rows]
    minimal = [path for path in sorted(paths, key=lambda value: (len(value.parts), str(value)))
               if not any(path != other and os.path.commonpath((str(other), str(path))) == str(other)
                          for other in paths)]
    owned = sum(directory_bytes(path) for path in minimal)
    available = os.statvfs(runtime).f_bavail * os.statvfs(runtime).f_frsize
    if owned + planned > LIMITS['maximumOwnedBytes'] or available - planned < LIMITS['minimumFreeBytes']:
        fail('OWNED_SPACE')
    return {'ownedBytes': owned, 'plannedBytes': planned, 'availableBytes': available,
            'rootCount': len(rows), 'minimalRootCount': len(minimal)}


def source_paths(root):
    base = [
        'package.json', 'pnpm-lock.yaml', 'packages/bridge-core/package.json',
        'packages/contracts/package.json',
        'packages/bridge-core/test/benchmarks/recording-capacity.ts',
        'packages/bridge-core/test/benchmarks/recording-capacity-process.ts',
    ]
    rules = (('packages/bridge-core/src', '.ts'),
             ('packages/bridge-core/test/helpers', '.ts'),
             ('packages/contracts/src', '.ts'),
             ('packages/contracts/dist', '.js'))
    names = list(base)
    for directory, suffix in rules:
        parent = root / directory
        if not parent.is_dir() or parent.is_symlink():
            fail('SOURCE_CANDIDATE')
        for path in sorted(parent.rglob(f'*{suffix}')):
            if path.is_symlink() or not ordinary(path):
                fail('SOURCE_CANDIDATE')
            names.append(str(path.relative_to(root)))
    names = sorted(set(names))
    if len(names) != EXPECTED_SOURCE_COUNT:
        fail('SOURCE_COUNT')
    return names


def source_manifest(root, head, derived_files):
    derived_files = dict(derived_files)
    if any(not isinstance(relative, str) or not relative.startswith('packages/contracts/dist/')
           or SHA256.fullmatch(str(digest or '')) is None
           for relative, digest in derived_files.items()):
        fail('SOURCE_CANDIDATE')
    files = {}
    paths = source_paths(root)
    dist_paths = {relative for relative in paths if relative.startswith('packages/contracts/dist/')}
    if set(derived_files) != dist_paths:
        fail('SOURCE_CANDIDATE')
    for relative in paths:
        path = root / relative
        digest = sha256(path)
        expected = derived_files.get(relative)
        if expected is None:
            expected = hashlib.sha256(git_blob(root, head, relative)).hexdigest()
        if expected != digest:
            fail('SOURCE_CANDIDATE')
        files[relative] = digest
    return {'schemaVersion': 1, 'scope': 'musicbridge-capacity-source-pins', 'files': files}


def load_build_helper(root, head):
    relative = 'scripts/ci/issue-v3-capacity-window.py'
    path = root / relative
    expected = hashlib.sha256(git_blob(root, head, relative)).hexdigest()
    if not ordinary(path) or sha256(path) != expected:
        fail('BUILD_HELPER_IDENTITY')
    spec = importlib.util.spec_from_file_location('musicbridge_capacity_build_helper', path)
    if spec is None or spec.loader is None:
        fail('BUILD_HELPER_IDENTITY')
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        raise IssueError('BUILD_HELPER_IDENTITY') from error
    if not callable(getattr(module, 'candidate_contract_dist', None)) \
            or not callable(getattr(module, 'typescript_library_manifest', None)):
        fail('BUILD_HELPER_IDENTITY')
    return module, path, relative, expected


def rebuild_contract_dist(helper, root, head, paths, options, build_node,
                          build_node_library, typescript_compiler):
    try:
        value = helper.candidate_contract_dist(
            root, head, paths, build_node, options.expected_build_node_sha256,
            build_node_library, options.expected_build_node_library_sha256,
            typescript_compiler, options.expected_typescript_compiler_sha256,
            options.expected_typescript_library_manifest_sha256)
    except Exception as error:
        code = str(error)
        if code in {'BUILD_TOOLCHAIN_IDENTITY', 'SOURCE_CANDIDATE', 'SOURCE_CONFIGURATION',
                    'BUILD_TIMEOUT', 'BUILD_EXECUTION', 'BUILD_EXIT', 'BUILD_OUTPUT',
                    'EMIT_SET', 'EMIT_BYTES', 'SOURCE_MANIFEST'}:
            raise IssueError(code) from error
        raise IssueError('SOURCE_CANDIDATE') from error
    if not isinstance(value, dict) or set(value) != {'files', 'provenance'} \
            or not isinstance(value.get('files'), dict) or not isinstance(value.get('provenance'), dict):
        fail('SOURCE_CANDIDATE')
    return value


def validate_repository(root, branch, head):
    root = canonical_directory(root)
    if GIT_SHA.fullmatch(head or '') is None or git_value(root, 'branch', '--show-current') != branch \
            or git_value(root, 'rev-parse', 'HEAD^{commit}') != head:
        fail('REPOSITORY_IDENTITY')
    return root


def validate_measure(options, runtime):
    window_path = Path(options.measure_window)
    close_path = Path(options.measure_close)
    owned_path = Path(options.measure_owned_manifest)
    source_path = Path(options.measure_source_manifest)
    supervision_path = Path(options.measure_supervision)
    installed_supervisor = Path(options.measure_supervisor)
    output = canonical_directory(options.measure_output, runtime)
    seed = canonical_directory(runtime / options.seed_label, runtime)
    window, _ = strict_json(window_path, options.expected_measure_window_sha256)
    close, _ = strict_json(close_path, options.expected_measure_close_sha256)
    owned, _ = strict_json(owned_path, options.expected_measure_owned_sha256)
    source, _ = strict_json(source_path, options.expected_measure_source_sha256)
    supervision, _ = strict_json(supervision_path, options.expected_measure_supervision_sha256)
    command, _ = strict_json(output / 'command.json', options.expected_measure_output_command_sha256)
    seed_value, _ = strict_json(seed / 'seed.json', options.expected_seed_metadata_sha256)
    if window_path.parent.parent != runtime or close_path.parent != window_path.parent \
            or owned_path.parent != window_path.parent or source_path.parent != window_path.parent \
            or supervision_path.parent != window_path.parent / 'supervision' \
            or output != runtime / options.expected_measure_label:
        fail('MEASURE_PATH')
    if window.get('scope') != 'musicbridge-capacity-measure-window' \
            or window.get('owner') != 'root' or window.get('id') != options.expected_measure_window_id \
            or window.get('state') != 'approved' or window.get('phase') != 'measure' \
            or window.get('profile') != 'objects-limit' or window.get('label') != options.expected_measure_label \
            or window.get('seedLabel') != options.seed_label or window.get('n') != 105 \
            or window.get('ownedManifest') != {'file': 'owned-roots.json', 'sha256': options.expected_measure_owned_sha256} \
            or window.get('sourceManifest') != {'file': 'source-pins.json', 'sha256': options.expected_measure_source_sha256}:
        fail('MEASURE_WINDOW')
    expected_seed = {'metadataSha256': options.expected_seed_metadata_sha256,
                     'snapshotSha256': options.expected_seed_snapshot_sha256,
                     'fixtureOwnerSha256': options.expected_seed_fixture_owner_sha256}
    if window.get('seed') != expected_seed or window.get('supervisor') != {
            'path': str(installed_supervisor), 'sha256': options.expected_measure_supervisor_sha256}:
        fail('MEASURE_WINDOW')
    measurement = close.get('measurement') if isinstance(close, dict) else None
    supervision_measurement = supervision.get('measurement') if isinstance(supervision, dict) else None
    def exact_pass(value):
        return isinstance(value, dict) and value.get('verifiedComplete') is True \
            and value.get('verifiedPassed') is True and value.get('thresholdPassed') is True \
            and value.get('authorityStable') is True and value.get('sampleCount') == 1575 \
            and value.get('receiptCount') == 3 and value.get('roundReceiptCount') == 105 \
            and value.get('stageCount') == 18 and value.get('aggregateBudgetValid') is True
    if close.get('scope') != 'musicbridge-capacity-measure-window-close' \
            or close.get('windowId') != options.expected_measure_window_id \
            or close.get('windowSha256') != options.expected_measure_window_sha256 \
            or close.get('state') != 'passed' or close.get('failure') is not None \
            or close.get('profile') != 'objects-limit' or close.get('label') != options.expected_measure_label \
            or close.get('seedLabel') != options.seed_label or close.get('seed') != expected_seed \
            or close.get('ownedManifestSha256') != options.expected_measure_owned_sha256 \
            or close.get('sourceManifestSha256') != options.expected_measure_source_sha256 \
            or close.get('supervisorSha256') != options.expected_measure_close_supervisor_sha256 \
            or close.get('groupEmpty') is not True or close.get('zombies') != [] \
            or close.get('deviceOpened') is not False or close.get('formalReady') is not False \
            or close.get('gateB') != 'NOT_RUN' \
            or close.get('replayPolicy') != 'terminal-window-id-and-label-never-reuse' \
            or not exact_pass(measurement):
        fail('MEASURE_PASS')
    if supervision.get('passed') is not True or supervision.get('failure') is not None \
            or supervision.get('code') != 0 or supervision.get('groupEmpty') is not True \
            or supervision.get('zombies') != [] or not exact_pass(supervision_measurement):
        fail('MEASURE_SUPERVISION')
    if sha256(installed_supervisor) != options.expected_measure_supervisor_sha256:
        fail('MEASURE_SUPERVISOR')
    if command.get('phase') != 'measure' or command.get('profile') != 'objects-limit' \
            or command.get('window') != options.expected_measure_window_id \
            or command.get('deviceOpened') is not False or command.get('formalReady') is not False \
            or command.get('gateB') != 'NOT_RUN':
        fail('MEASURE_COMMAND')
    if not isinstance(owned, dict) or set(owned) != {'schemaVersion', 'scope', 'access', 'windowId', 'roots', 'futureRoots'} \
            or owned.get('schemaVersion') != 1 or owned.get('scope') != 'musicbridge-capacity-owned-roots' \
            or owned.get('access') != 'count-only' or owned.get('windowId') != options.expected_measure_window_id \
            or not isinstance(owned.get('roots'), list) or len(owned['roots']) != EXPECTED_MEASURE_ROOTS \
            or owned.get('futureRoots') != [str(output)]:
        fail('MEASURE_OWNED')
    if source.get('schemaVersion') != 1 or source.get('scope') != 'musicbridge-capacity-source-pins' \
            or not isinstance(source.get('files'), dict):
        fail('MEASURE_SOURCE')
    if seed_value.get('schema') != 21 or seed_value.get('profile') != 'objects-limit' \
            or seed_value.get('snapshotSha256') != options.expected_seed_snapshot_sha256 \
            or seed_value.get('integrity') != 'passed' or seed_value.get('growth', {}).get('state') != 'target-reached' \
            or seed_value.get('deviceOpened') is not False or seed_value.get('formalReady') is not False \
            or seed_value.get('gateB') != 'NOT_RUN':
        fail('SEED_PASS')
    snapshot = seed / 'seed.sqlite'
    fixture = canonical_directory(seed_value.get('fixtureDirectory'))
    if snapshot.stat().st_size != FROZEN_MEASURE['seedSnapshotBytes'] \
            or sha256(snapshot) != options.expected_seed_snapshot_sha256 \
            or sha256(fixture / 'capacity-owner.json') != options.expected_seed_fixture_owner_sha256:
        fail('SEED_IDENTITY')
    roots = unique_roots(owned['roots'])
    required_roots = {str(window_path.parent), str(seed), str(fixture)}
    if not required_roots.issubset(roots):
        fail('MEASURE_OWNED')
    output_root = validate_root(current_root(output, 'command.json'))
    if output_root['path'] in roots:
        fail('MEASURE_OWNED')
    roots[output_root['path']] = output_root
    if len(roots) != EXPECTED_CONCRETE_ROOTS:
        fail('MEASURE_OWNED')
    return {
        'roots': list(roots.values()), 'snapshotBytes': snapshot.stat().st_size,
        'seed': expected_seed, 'seedDirectory': str(seed),
        'facts': {
            'window': {'path': str(window_path), 'id': options.expected_measure_window_id,
                       'sha256': options.expected_measure_window_sha256},
            'close': {'path': str(close_path), 'sha256': options.expected_measure_close_sha256},
            'ownedManifest': {'path': str(owned_path), 'sha256': options.expected_measure_owned_sha256},
            'sourceManifest': {'path': str(source_path), 'sha256': options.expected_measure_source_sha256},
            'supervision': {'path': str(supervision_path), 'sha256': options.expected_measure_supervision_sha256},
            'supervisor': {'path': str(installed_supervisor), 'sha256': options.expected_measure_supervisor_sha256},
            'output': {'path': str(output), 'label': options.expected_measure_label,
                       'commandSha256': options.expected_measure_output_command_sha256},
        },
    }


def replay_check(runtime, window_dir_name, label):
    if (runtime / window_dir_name).exists() or (runtime / window_dir_name).is_symlink():
        fail('REPLAY')
    for pattern in ('*/window.json', '*/issuer-failure.json', '*/close.json'):
        for path in runtime.glob(pattern):
            try:
                value, _ = strict_json(path)
            except IssueError:
                fail('REPLAY_AUDIT')
            if isinstance(value, dict) and (value.get('label') == label \
                    or value.get('windowDirName') == window_dir_name):
                fail('REPLAY')


def validate_prior_issuer_failures(options, runtime):
    rows = options.prior_issuer_failure
    if not isinstance(rows, list) or not rows or len(rows) > 64:
        fail('PRIOR_ISSUER_FAILURE')
    discovered = set()
    try:
        runtime_entries = sorted(runtime.iterdir(), key=lambda value: value.name)
    except OSError as error:
        raise IssueError('PRIOR_ISSUER_FAILURE_AUDIT') from error
    for entry in runtime_entries:
        failure_path = entry / 'issuer-failure.json'
        try:
            entry_info = entry.lstat()
        except OSError as error:
            raise IssueError('PRIOR_ISSUER_FAILURE_AUDIT') from error
        if not stat.S_ISDIR(entry_info.st_mode) or entry.is_symlink():
            if failure_path.exists() or failure_path.is_symlink():
                fail('PRIOR_ISSUER_FAILURE_AUDIT')
            continue
        if not failure_path.exists() and not failure_path.is_symlink():
            continue
        try:
            failure, _ = strict_json(failure_path, maximum=1024 * 1024)
        except IssueError as error:
            raise IssueError('PRIOR_ISSUER_FAILURE_AUDIT') from error
        if not isinstance(failure, dict) or not isinstance(failure.get('scope'), str):
            fail('PRIOR_ISSUER_FAILURE_AUDIT')
        if failure['scope'] == 'musicbridge-capacity-queued-stop-authority-issuer-failure':
            discovered.add(str(failure_path))
    roots = []
    facts = []
    snapshots = []
    seen_roots = set()
    seen_windows = set()
    seen_dirs = set()
    seen_labels = set()
    declared = set()
    for row in rows:
        if not isinstance(row, (list, tuple)) or len(row) != 9:
            fail('PRIOR_ISSUER_FAILURE')
        (failure_name, failure_sha, owner_sha, supervisor_sha, issuer_fact_sha,
         window_id, window_dir_name, label, error_code) = row
        if any(SHA256.fullmatch(str(value or '')) is None
               for value in (failure_sha, owner_sha, supervisor_sha, issuer_fact_sha)) \
                or UUID4.fullmatch(str(window_id or '')) is None \
                or SAFE.fullmatch(str(window_dir_name or '')) is None \
                or SAFE.fullmatch(str(label or '')) is None \
                or re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', str(error_code or ''), re.ASCII) is None:
            fail('PRIOR_ISSUER_FAILURE')
        failure_path = Path(failure_name)
        parent = canonical_directory(failure_path.parent, runtime)
        issuer_identity = canonical_directory(parent / 'issuer-identity', parent)
        if failure_path != parent / 'issuer-failure.json' or parent != runtime / window_dir_name \
                or str(parent) in seen_roots or window_id in seen_windows \
                or window_dir_name in seen_dirs or label in seen_labels:
            fail('PRIOR_ISSUER_FAILURE')
        owner, observed_owner_sha = strict_json(parent / 'owner.json', owner_sha)
        failure, observed_failure_sha = strict_json(failure_path, failure_sha)
        issuer_fact, observed_issuer_fact_sha = strict_json(
            issuer_identity / 'owner.json', issuer_fact_sha)
        supervisor = verified_file(parent / 'supervisor.py', supervisor_sha, 'PRIOR_ISSUER_FAILURE')
        expected_failure_keys = {
            'schemaVersion', 'scope', 'state', 'windowId', 'windowDirName', 'label', 'errorCode',
            'authorityFilesCreated', 'windowWritten', 'replayAllowed', 'recordedAt'}
        try:
            recorded = datetime.datetime.fromisoformat(failure.get('recordedAt'))
        except (AttributeError, TypeError, ValueError) as error:
            raise IssueError('PRIOR_ISSUER_FAILURE') from error
        core_created = ['owner.json', 'supervisor.py', 'issuer-identity/owner.json']
        allowed_created = [core_created, [*core_created, 'source-pins.json'],
                           [*core_created, 'source-pins.json', 'owned-roots.json'],
                           [*core_created, 'source-pins.json', 'owned-roots.json', 'window.pending.json'],
                           [*core_created, 'source-pins.json', 'owned-roots.json', 'window.json']]
        created = failure.get('authorityFilesCreated')
        if owner != {'scope': 'musicbridge-capacity-queued-stop-window', 'owner': 'root', 'id': window_id} \
                or not isinstance(issuer_fact, dict) \
                or issuer_fact.get('schemaVersion') != 1 \
                or issuer_fact.get('scope') != 'musicbridge-capacity-queued-stop-authority-issuer' \
                or issuer_fact.get('windowId') != window_id \
                or not isinstance(failure, dict) or set(failure) != expected_failure_keys \
                or failure.get('schemaVersion') != 1 \
                or failure.get('scope') != 'musicbridge-capacity-queued-stop-authority-issuer-failure' \
                or failure.get('state') != 'TERMINAL_ISSUER_FAILURE' \
                or failure.get('windowId') != window_id or failure.get('windowDirName') != window_dir_name \
                or failure.get('label') != label or failure.get('errorCode') != error_code \
                or created not in allowed_created \
                or failure.get('windowWritten') is not ('window.json' in created) \
                or failure.get('replayAllowed') is not False \
                or recorded.utcoffset() is None:
            fail('PRIOR_ISSUER_FAILURE')
        optional_roles = {'source-pins.json': 'sourceManifest', 'owned-roots.json': 'ownedManifest',
                          'window.pending.json': 'pendingWindow', 'window.json': 'window'}
        expected_parent_entries = {'owner.json', 'supervisor.py', 'issuer-identity', 'issuer-failure.json'} \
            | {name for name in optional_roles if name in created}
        try:
            parent_entries = {path.name for path in parent.iterdir()}
            issuer_entries = {path.name for path in issuer_identity.iterdir()}
        except OSError as error:
            raise IssueError('PRIOR_ISSUER_FAILURE') from error
        if parent_entries != expected_parent_entries or issuer_entries != {'owner.json'}:
            fail('PRIOR_ISSUER_FAILURE')
        optional_facts = {}; optional_snapshots = {}
        for name, role in optional_roles.items():
            if name not in created: continue
            value, digest = strict_json(parent / name)
            if not isinstance(value, dict) or value.get('schemaVersion') != 1 \
                    or name == 'source-pins.json' and (
                        value.get('scope') != 'musicbridge-capacity-source-pins'
                        or not isinstance(value.get('files'), dict)) \
                    or name == 'owned-roots.json' and (
                        value.get('scope') != 'musicbridge-capacity-owned-roots'
                        or value.get('access') != 'count-only' or value.get('windowId') != window_id
                        or not isinstance(value.get('roots'), list)) \
                    or name in {'window.pending.json', 'window.json'} and (
                        value.get('scope') != 'musicbridge-capacity-queued-stop-window'
                        or value.get('id') != window_id):
                fail('PRIOR_ISSUER_FAILURE')
            optional_facts[role] = {'path': str(parent / name), 'sha256': digest}
            optional_snapshots[role] = file_snapshot(parent / name, digest)
        root = current_root(parent, 'owner.json')
        snapshot = {
            'root': directory_snapshot(parent, expected_parent_entries),
            'issuerIdentity': directory_snapshot(issuer_identity, {'owner.json'}),
            'files': {
                'owner': file_snapshot(parent / 'owner.json', observed_owner_sha),
                'supervisor': file_snapshot(supervisor, supervisor_sha),
                'issuerFact': file_snapshot(
                    issuer_identity / 'owner.json', observed_issuer_fact_sha),
                'failure': file_snapshot(failure_path, observed_failure_sha), **optional_snapshots,
            },
        }
        roots.append(root)
        facts.append({
            'root': str(parent), 'windowId': window_id, 'windowDirName': window_dir_name,
            'label': label, 'errorCode': error_code,
            'files': {
                'owner': {'path': str(parent / 'owner.json'), 'sha256': observed_owner_sha},
                'supervisor': {'path': str(supervisor), 'sha256': supervisor_sha},
                'issuerFact': {'path': str(issuer_identity / 'owner.json'),
                               'sha256': observed_issuer_fact_sha},
                'failure': {'path': str(failure_path), 'sha256': observed_failure_sha}, **optional_facts,
            },
        })
        snapshots.append(snapshot)
        seen_roots.add(str(parent)); seen_windows.add(window_id); seen_dirs.add(window_dir_name)
        seen_labels.add(label); declared.add(str(failure_path))
    if declared != discovered:
        fail('PRIOR_ISSUER_FAILURE_AUDIT')
    ordered = sorted(zip(roots, facts, snapshots), key=lambda value: value[0]['path'])
    return {'roots': [root for root, _, _ in ordered], 'facts': [fact for _, fact, _ in ordered],
            'snapshots': [snapshot for _, _, snapshot in ordered]}


def copy_supervisor(source, destination, expected_sha):
    if destination.exists() or destination.is_symlink():
        fail('EXCLUSIVE_CREATE')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    source_fd = os.open(source, flags)
    destination_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o700)
    digest = hashlib.sha256()
    try:
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail('SUPERVISOR_IDENTITY')
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                count = os.write(destination_fd, view)
                if count <= 0:
                    fail('SUPERVISOR_COPY')
                view = view[count:]
        os.fsync(destination_fd)
    finally:
        os.close(source_fd)
        os.close(destination_fd)
    os.chmod(destination, 0o700)
    if digest.hexdigest() != expected_sha or sha256(destination) != expected_sha:
        fail('SUPERVISOR_COPY')
    fsync_directory(destination.parent)


def parse_args(argv):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--repo-root', required=True)
    parser.add_argument('--runtime-root', required=True)
    parser.add_argument('--measure-window', required=True)
    parser.add_argument('--expected-measure-window-id', required=True)
    parser.add_argument('--expected-measure-window-sha256', required=True)
    parser.add_argument('--measure-close', required=True)
    parser.add_argument('--expected-measure-close-sha256', required=True)
    parser.add_argument('--measure-owned-manifest', required=True)
    parser.add_argument('--expected-measure-owned-sha256', required=True)
    parser.add_argument('--measure-source-manifest', required=True)
    parser.add_argument('--expected-measure-source-sha256', required=True)
    parser.add_argument('--measure-supervision', required=True)
    parser.add_argument('--expected-measure-supervision-sha256', required=True)
    parser.add_argument('--measure-supervisor', required=True)
    parser.add_argument('--expected-measure-supervisor-sha256', required=True)
    parser.add_argument('--expected-measure-close-supervisor-sha256', required=True)
    parser.add_argument('--measure-output', required=True)
    parser.add_argument('--expected-measure-label', required=True)
    parser.add_argument('--expected-measure-output-command-sha256', required=True)
    parser.add_argument('--seed-label', required=True)
    parser.add_argument('--expected-seed-metadata-sha256', required=True)
    parser.add_argument('--expected-seed-snapshot-sha256', required=True)
    parser.add_argument('--expected-seed-fixture-owner-sha256', required=True)
    parser.add_argument('--window-dir-name', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--profile', required=True, choices=('objects-limit',))
    parser.add_argument('--expected-branch', required=True)
    parser.add_argument('--expected-head', required=True)
    parser.add_argument('--supervisor', required=True)
    parser.add_argument('--expected-supervisor-sha256', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--expected-node-sha256', required=True)
    parser.add_argument('--tsx-loader', required=True)
    parser.add_argument('--expected-tsx-loader-sha256', required=True)
    parser.add_argument('--consumer-python', required=True)
    parser.add_argument('--expected-consumer-sha256', required=True)
    parser.add_argument('--issuer-repo-root', required=True)
    parser.add_argument('--expected-issuer-branch', required=True)
    parser.add_argument('--expected-issuer-head', required=True)
    parser.add_argument('--expected-issuer-sha256', required=True)
    parser.add_argument('--build-node', required=True)
    parser.add_argument('--expected-build-node-sha256', required=True)
    parser.add_argument('--build-node-library', required=True)
    parser.add_argument('--expected-build-node-library-sha256', required=True)
    parser.add_argument('--typescript-compiler', required=True)
    parser.add_argument('--expected-typescript-compiler-sha256', required=True)
    parser.add_argument('--expected-typescript-library-manifest-sha256', required=True)
    parser.add_argument('--prior-issuer-failure', action='append', nargs=9,
                        metavar=('FAILURE', 'FAILURE_SHA256', 'OWNER_SHA256', 'SUPERVISOR_SHA256',
                                 'ISSUER_FACT_SHA256', 'WINDOW_ID', 'WINDOW_DIR_NAME', 'LABEL', 'ERROR_CODE'))
    return parser.parse_args(argv)


def validate_options(options):
    for value in (options.window_dir_name, options.label, options.seed_label, options.expected_measure_label):
        if SAFE.fullmatch(value or '') is None:
            fail('NAME')
    for value in vars(options):
        if 'sha256' in value and SHA256.fullmatch(str(getattr(options, value, ''))) is None:
            fail('SHA256')
    if UUID4.fullmatch(options.expected_measure_window_id or '') is None:
        fail('WINDOW_ID')
    observed = {
        'windowId': options.expected_measure_window_id,
        'windowSha256': options.expected_measure_window_sha256,
        'closeSha256': options.expected_measure_close_sha256,
        'ownedSha256': options.expected_measure_owned_sha256,
        'sourceSha256': options.expected_measure_source_sha256,
        'supervisionSha256': options.expected_measure_supervision_sha256,
        'installedSupervisorSha256': options.expected_measure_supervisor_sha256,
        'outputCommandSha256': options.expected_measure_output_command_sha256,
        'seedMetadataSha256': options.expected_seed_metadata_sha256,
        'seedSnapshotSha256': options.expected_seed_snapshot_sha256,
        'seedFixtureOwnerSha256': options.expected_seed_fixture_owner_sha256,
        'measureLabel': options.expected_measure_label,
        'seedLabel': options.seed_label,
    }
    if any(observed[key] != value for key, value in FROZEN_MEASURE.items()
           if key != 'seedSnapshotBytes') \
            or options.expected_measure_close_supervisor_sha256 != FROZEN_MEASURE['supervisionSha256']:
        fail('FROZEN_MEASURE')


def record_failure(code):
    global _FAILURE
    context = _FAILURE
    if not context:
        return
    parent = context['parent']
    receipt = parent / 'issuer-failure.json'
    if receipt.exists() or receipt.is_symlink():
        return
    created = [name for name in ('owner.json', 'supervisor.py', 'issuer-identity/owner.json',
                                 'source-pins.json', 'owned-roots.json', 'window.pending.json', 'window.json')
               if ordinary(parent / name)]
    try:
        exclusive_json(receipt, {
            'schemaVersion': 1, 'scope': 'musicbridge-capacity-queued-stop-authority-issuer-failure',
            'state': 'TERMINAL_ISSUER_FAILURE', 'windowId': context['windowId'],
            'windowDirName': context['windowDirName'], 'label': context['label'],
            'errorCode': code, 'authorityFilesCreated': created,
            'windowWritten': 'window.json' in created, 'replayAllowed': False,
            'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds'),
        })
        fsync_directory(parent)
        fsync_directory(context['runtime'])
    except Exception:
        pass


def build_window_payload(*, window_id, label, seed_label, seed, issued_at, deadline_at,
                         owned_sha, source_sha, plan, issuer_failure_count,
                         installed_supervisor, supervisor_sha,
                         candidate_root, candidate_branch, candidate_head, measure_facts,
                         node, node_sha, tsx, tsx_sha, consumer, consumer_sha,
                         issuer_path, issuer_sha, issuer_fact_path, issuer_fact_sha):
    """构造冻结的outer合同；此纯函数不签发authority，也不绕过CLI的window-06冻结检查。"""
    return {
        'schemaVersion': 1, 'scope': 'musicbridge-capacity-queued-stop-window', 'owner': 'root',
        'id': window_id, 'state': 'approved', 'phase': 'queued-stop', 'profile': 'objects-limit',
        'label': label, 'seedLabel': seed_label, 'seed': seed, 'n': 105,
        'issuerFailureCarryoverCount': issuer_failure_count,
        'issuedAt': issued_at, 'deadlineAt': deadline_at, 'limits': dict(LIMITS),
        'ownedManifest': {'file': 'owned-roots.json', 'sha256': owned_sha},
        'sourceManifest': {'file': 'source-pins.json', 'sha256': source_sha},
        'queuedStopPlan': plan,
        'supervisor': {'path': installed_supervisor, 'sha256': supervisor_sha},
        'toolchain': {
            'node': {'path': node, 'sha256': node_sha},
            'tsxLoader': {'path': tsx, 'sha256': tsx_sha},
            'consumerPython': {'path': consumer, 'sha256': consumer_sha},
        },
        'issuer': {
            'path': issuer_path, 'sha256': issuer_sha,
            'fact': {'path': issuer_fact_path, 'sha256': issuer_fact_sha},
        },
        'candidateRepository': {'root': candidate_root, 'branch': candidate_branch,
                                'head': candidate_head},
        'measureCarryover': measure_facts,
    }


def issue(options):
    global _FAILURE
    validate_options(options)
    root = validate_repository(options.repo_root, options.expected_branch, options.expected_head)
    issuer_repo = validate_repository(options.issuer_repo_root, options.expected_issuer_branch,
                                      options.expected_issuer_head)
    runtime = canonical_directory(options.runtime_root)
    replay_check(runtime, options.window_dir_name, options.label)
    issuer_path = Path(__file__).resolve(strict=True)
    if os.path.commonpath((str(issuer_repo), str(issuer_path))) != str(issuer_repo):
        fail('ISSUER_IDENTITY')
    issuer_relative = str(issuer_path.relative_to(issuer_repo))
    if sha256(issuer_path) != options.expected_issuer_sha256 \
            or hashlib.sha256(git_blob(issuer_repo, options.expected_issuer_head, issuer_relative)).hexdigest() != options.expected_issuer_sha256:
        fail('ISSUER_IDENTITY')
    supervisor_source = verified_file(options.supervisor, options.expected_supervisor_sha256, 'SUPERVISOR_IDENTITY')
    supervisor_relative = str(supervisor_source.relative_to(root))
    if hashlib.sha256(git_blob(root, options.expected_head, supervisor_relative)).hexdigest() != options.expected_supervisor_sha256:
        fail('SUPERVISOR_IDENTITY')
    node = verified_file(options.node, options.expected_node_sha256, 'NODE_IDENTITY', executable=True)
    tsx = verified_file(options.tsx_loader, options.expected_tsx_loader_sha256, 'TSX_IDENTITY')
    consumer = verified_file(options.consumer_python, options.expected_consumer_sha256,
                             'CONSUMER_IDENTITY', executable=True)
    build_node = verified_file(options.build_node, options.expected_build_node_sha256,
                               'BUILD_TOOLCHAIN_IDENTITY', executable=True)
    build_node_library = verified_file(
        options.build_node_library, options.expected_build_node_library_sha256,
        'BUILD_TOOLCHAIN_IDENTITY')
    typescript_compiler = verified_file(
        options.typescript_compiler, options.expected_typescript_compiler_sha256,
        'BUILD_TOOLCHAIN_IDENTITY')
    build_helper, build_helper_path, build_helper_relative, build_helper_sha = \
        load_build_helper(root, options.expected_head)
    paths = source_paths(root)
    derived = rebuild_contract_dist(
        build_helper, root, options.expected_head, paths, options, build_node,
        build_node_library, typescript_compiler)
    source = source_manifest(root, options.expected_head, derived['files'])
    prior_failures = validate_prior_issuer_failures(options, runtime)
    window_id = str(uuid.uuid4())
    parent = runtime / options.window_dir_name
    try:
        parent.mkdir(mode=0o700)
    except OSError as error:
        raise IssueError('EXCLUSIVE_CREATE') from error
    _FAILURE = {'parent': parent, 'runtime': runtime, 'windowId': window_id,
                'windowDirName': options.window_dir_name, 'label': options.label}
    measure = validate_measure(options, runtime)
    planned = measure['snapshotBytes'] + EVIDENCE_ALLOWANCE
    owner_sha = exclusive_json(parent / 'owner.json', {
        'scope': 'musicbridge-capacity-queued-stop-window', 'owner': 'root', 'id': window_id})
    installed = parent / 'supervisor.py'
    copy_supervisor(supervisor_source, installed, options.expected_supervisor_sha256)
    issuer_identity = parent / 'issuer-identity'
    issuer_identity.mkdir(mode=0o700)
    issuer_fact_sha = exclusive_json(issuer_identity / 'owner.json', {
        'schemaVersion': 1, 'scope': 'musicbridge-capacity-queued-stop-authority-issuer',
        'windowId': window_id,
        'issuerRepository': {'root': str(issuer_repo), 'branch': options.expected_issuer_branch,
                             'head': options.expected_issuer_head, 'relativePath': issuer_relative,
                             'sha256': options.expected_issuer_sha256},
        'candidateRepository': {'root': str(root), 'branch': options.expected_branch,
                                'head': options.expected_head},
        'supervisorSource': {'path': str(supervisor_source), 'relativePath': supervisor_relative,
                             'sha256': options.expected_supervisor_sha256},
        'toolchain': {'node': {'path': str(node), 'sha256': options.expected_node_sha256},
                      'tsxLoader': {'path': str(tsx), 'sha256': options.expected_tsx_loader_sha256},
                      'consumerPython': {'path': str(consumer), 'sha256': options.expected_consumer_sha256}},
        'buildHelper': {'path': str(build_helper_path), 'relativePath': build_helper_relative,
                        'sha256': build_helper_sha},
        'buildToolchain': {
            'node': {'path': str(build_node), 'sha256': options.expected_build_node_sha256},
            'nodeLibrary': {'path': str(build_node_library),
                            'sha256': options.expected_build_node_library_sha256},
            'typescriptCompiler': {'path': str(typescript_compiler),
                                   'sha256': options.expected_typescript_compiler_sha256},
            'typescriptLibraryManifestSha256': options.expected_typescript_library_manifest_sha256,
        },
        'build': derived['provenance'],
        'issuerFailureCarryover': prior_failures['facts'],
        'measureCarryover': measure['facts'],
    })
    roots = unique_roots([*measure['roots'], *prior_failures['roots'], current_root(parent, 'owner.json'),
                          current_root(issuer_identity, 'owner.json')])
    expected_authority_roots = BASE_AUTHORITY_ROOTS + len(prior_failures['roots'])
    if len(roots) != expected_authority_roots:
        fail('OWNED_COUNT')
    source_sha = exclusive_json(parent / 'source-pins.json', source)
    owned = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-owned-roots', 'access': 'count-only',
             'windowId': window_id, 'roots': list(roots.values())}
    owned_sha = exclusive_json(parent / 'owned-roots.json', owned)
    budget = owned_facts(list(roots.values()), planned, runtime)
    issued = datetime.datetime.now(datetime.timezone.utc)
    deadline = issued + datetime.timedelta(seconds=900)
    plan = {'warmupCount': 5, 'formalCount': 100, 'sampleCount': 105,
            'activeCloneMaximum': 1, 'snapshotBytes': measure['snapshotBytes'],
            'evidenceAllowanceBytes': EVIDENCE_ALLOWANCE, 'plannedBytes': planned,
            'model': 'serial-single-clone-plus-bounded-growth-v1',
            'aggregateAudit': 'queued-stop-aggregate-budget.jsonl'}
    seed = {'label': options.seed_label, **measure['seed']}
    window = build_window_payload(
        window_id=window_id, label=options.label, seed_label=options.seed_label, seed=seed,
        issued_at=issued.isoformat(timespec='milliseconds'),
        deadline_at=deadline.isoformat(timespec='milliseconds'), owned_sha=owned_sha,
        source_sha=source_sha, plan=plan, issuer_failure_count=len(prior_failures['roots']),
        installed_supervisor=str(installed),
        supervisor_sha=options.expected_supervisor_sha256, candidate_root=str(root),
        candidate_branch=options.expected_branch, candidate_head=options.expected_head,
        measure_facts=measure['facts'], node=str(node), node_sha=options.expected_node_sha256,
        tsx=str(tsx), tsx_sha=options.expected_tsx_loader_sha256, consumer=str(consumer),
        consumer_sha=options.expected_consumer_sha256, issuer_path=str(issuer_path),
        issuer_sha=options.expected_issuer_sha256,
        issuer_fact_path=str(issuer_identity / 'owner.json'), issuer_fact_sha=issuer_fact_sha)
    pending = parent / 'window.pending.json'
    window_sha = exclusive_json(pending, window)
    # 发布前第二次读取全部外部身份与空间；pending 字节也必须保持不变。
    second_measure = validate_measure(options, runtime)
    if second_measure['facts'] != measure['facts'] or second_measure['seed'] != measure['seed'] \
            or second_measure['snapshotBytes'] != measure['snapshotBytes']:
        fail('MEASURE_DRIFT')
    validate_repository(root, options.expected_branch, options.expected_head)
    validate_repository(issuer_repo, options.expected_issuer_branch, options.expected_issuer_head)
    verified_file(issuer_path, options.expected_issuer_sha256, 'ISSUER_IDENTITY')
    verified_file(supervisor_source, options.expected_supervisor_sha256, 'SUPERVISOR_IDENTITY')
    verified_file(node, options.expected_node_sha256, 'NODE_IDENTITY', executable=True)
    verified_file(tsx, options.expected_tsx_loader_sha256, 'TSX_IDENTITY')
    verified_file(consumer, options.expected_consumer_sha256, 'CONSUMER_IDENTITY', executable=True)
    verified_file(build_helper_path, build_helper_sha, 'BUILD_HELPER_IDENTITY')
    verified_file(build_node, options.expected_build_node_sha256, 'BUILD_TOOLCHAIN_IDENTITY', executable=True)
    verified_file(build_node_library, options.expected_build_node_library_sha256, 'BUILD_TOOLCHAIN_IDENTITY')
    verified_file(typescript_compiler, options.expected_typescript_compiler_sha256, 'BUILD_TOOLCHAIN_IDENTITY')
    try:
        build_helper.typescript_library_manifest(
            typescript_compiler.parent, options.expected_typescript_library_manifest_sha256)
    except Exception as error:
        raise IssueError('BUILD_TOOLCHAIN_IDENTITY') from error
    second_prior_failures = validate_prior_issuer_failures(options, runtime)
    if second_prior_failures['facts'] != prior_failures['facts'] \
            or second_prior_failures['roots'] != prior_failures['roots'] \
            or second_prior_failures['snapshots'] != prior_failures['snapshots']:
        fail('PRIOR_ISSUER_FAILURE_DRIFT')
    if strict_json(parent / 'source-pins.json', source_sha)[0] != source_manifest(
            root, options.expected_head, derived['files']) \
            or strict_json(parent / 'owned-roots.json', owned_sha)[0] != owned \
            or strict_json(pending, window_sha)[0] != window:
        fail('AUTHORITY_DRIFT')
    roots_second = unique_roots(owned['roots'])
    if len(roots_second) != expected_authority_roots:
        fail('OWNED_DRIFT')
    budget_second = owned_facts(list(roots_second.values()), planned, runtime)
    os.rename(pending, parent / 'window.json')
    fsync_directory(parent)
    fsync_directory(runtime)
    consume = [str(consumer), str(installed), '--window', str(parent / 'window.json'),
               '--window-sha256', window_sha]
    _FAILURE = None
    return {'state': 'ISSUED_NOT_EXECUTED', 'windowId': window_id,
            'windowPath': str(parent / 'window.json'), 'windowSha256': window_sha,
            'profile': 'objects-limit', 'label': options.label, 'seedLabel': options.seed_label,
            'sourceFileCount': len(source['files']), 'ownedRootCount': len(roots),
            **budget_second, 'deadlineAt': window['deadlineAt'],
            'issuerFact': {'file': 'issuer-identity/owner.json', 'sha256': issuer_fact_sha},
            'ownerSha256': owner_sha, 'consumeCommand': consume,
            'measureCarryover': measure['facts'], 'queuedStopPlan': plan}


def main(argv):
    try:
        value = issue(parse_args(argv))
    except IssueError as error:
        record_failure(str(error))
        print(f'CAPACITY_QUEUED_STOP_WINDOW_ISSUER={error}', file=sys.stderr)
        return 1
    except Exception:
        record_failure('ISSUER_INTERNAL')
        print('CAPACITY_QUEUED_STOP_WINDOW_ISSUER=ISSUER_INTERNAL', file=sys.stderr)
        return 1
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
