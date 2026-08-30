import argparse
import datetime
import decimal
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid


def _write(file, value):
    fd = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        if os.path.exists(file):
            directory = os.open(str(Path(file).parent), os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)


def _members(pgid):
    rows = []
    for line in subprocess.check_output(['ps', '-axo', 'pid=,pgid=,state='], text=True).splitlines():
        fields = line.split()
        if len(fields) >= 3 and int(fields[1]) == pgid:
            rows.append({'pid': int(fields[0]), 'state': fields[2]})
    return rows


def _live(pgid):
    return [row for row in _members(pgid) if not row['state'].startswith('Z')]


def _wait_empty(pgid, seconds):
    deadline = time.monotonic() + seconds
    while _members(pgid) and time.monotonic() < deadline:
        time.sleep(0.02)
    return not _members(pgid)


def _send_group_signal(pgid, value, signals):
    try:
        os.killpg(pgid, value)
    except ProcessLookupError:
        return False
    signals.append(signal.Signals(value).name)
    return True


def _terminate_group(process, pgid, signals, grace, close_budget):
    if _live(pgid) and _send_group_signal(pgid, signal.SIGTERM, signals):
        _wait_empty(pgid, grace)
    if _live(pgid):
        _send_group_signal(pgid, signal.SIGKILL, signals)
    # KILL后的wait与最终进程组核验共享同一个close期限，不能各自再获得完整预算。
    close_deadline = time.monotonic() + close_budget
    try: process.wait(timeout=max(0, close_deadline - time.monotonic()))
    except subprocess.TimeoutExpired: pass
    return _wait_empty(pgid, max(0, close_deadline - time.monotonic()))


def _bind_artifacts(result, artifact_probe, artifact_name='generation', artifact_failure='GENERATION_EVIDENCE_FAILED'):
    if artifact_probe is None:
        return
    try:
        result[artifact_name] = artifact_probe()
        if result[artifact_name].get('verifiedPassed') is not True:
            if result['failure'] is None: result['failure'] = artifact_failure
            result['passed'] = False
    except Exception as error:
        result[artifact_name] = {
            'partialExists': None, 'checkpointFiles': [], 'checkpointCount': None,
            'seedExists': None, 'targetReached': None,
            'targetVerdict': 'CHILD_SEED_EVIDENCE_REQUIRED',
            'probeError': f'{type(error).__name__}: {error}'
        }
        result['failure'] = 'ARTIFACT_PROBE_FAILED'
        result['passed'] = False


def _captured_file(file):
    if file is None: return None
    return {'path': str(file), 'exists': file.is_file(), 'size': file.stat().st_size if file.is_file() else None,
            'sha256': _sha(file) if file.is_file() else None}


def supervise(command, deadline, output, grace=1, close_budget=2, artifact_probe=None,
              cwd=None, environment=None, capture_output=False, stdin=None,
              artifact_name='generation', artifact_failure='GENERATION_EVIDENCE_FAILED'):
    output.mkdir(mode=0o700)
    stdout_path = output / 'stdout.log' if capture_output else None
    stderr_path = output / 'stderr.log' if capture_output else None
    stdout_stream = open(stdout_path, 'xb', buffering=0) if stdout_path else None
    stderr_stream = open(stderr_path, 'xb', buffering=0) if stderr_path else None
    def close_capture():
        for stream in (stdout_stream, stderr_stream):
            if stream is not None and not stream.closed:
                stream.flush(); os.fsync(stream.fileno()); stream.close()
    started = time.monotonic()
    result = {'passed': False, 'failure': None, 'pid': None, 'pgid': None, 'code': None,
              'exitSignal': None, 'signals': [], 'groupEmpty': True, 'zombies': [], 'elapsedMs': 0,
              'managedProcessGroup': None}
    if deadline <= started:
        result['failure'] = 'WINDOW_EXPIRED'
        close_capture()
        if capture_output:
            result['stdout'] = _captured_file(stdout_path); result['stderr'] = _captured_file(stderr_path)
        _bind_artifacts(result, artifact_probe, artifact_name, artifact_failure)
        _write(output / 'supervisor.json', result)
        return result
    try:
        process = subprocess.Popen(command, start_new_session=True, cwd=cwd, env=environment,
                                   stdin=stdin, stdout=stdout_stream, stderr=stderr_stream)
    except OSError as error:
        result['failure'] = 'SPAWN_FAILED'
        result['spawnError'] = f'{type(error).__name__}: {error}'
        result['elapsedMs'] = (time.monotonic() - started) * 1000
        close_capture()
        if capture_output:
            result['stdout'] = _captured_file(stdout_path); result['stderr'] = _captured_file(stderr_path)
        _bind_artifacts(result, artifact_probe, artifact_name, artifact_failure)
        _write(output / 'supervisor.json', result)
        return result
    result['pid'] = process.pid
    result['pgid'] = os.getpgid(process.pid)
    result['managedProcessGroup'] = result['pgid'] == process.pid
    _write(output / 'supervisor-start.json', {'pid': process.pid, 'pgid': result['pgid'], 'command': command,
                                               'managedProcessGroup': result['managedProcessGroup'],
                                               'startedMonotonic': started, 'deadlineMonotonic': deadline,
                                               'cwd': str(cwd) if cwd is not None else None,
                                               'environmentKeys': sorted(environment) if environment is not None else None,
                                               'environment': environment,
                                               'stdin': 'DEVNULL' if stdin == subprocess.DEVNULL else None,
                                               'stdout': str(stdout_path) if stdout_path else None,
                                               'stderr': str(stderr_path) if stderr_path else None})
    if not result['managedProcessGroup']:
        result['failure'] = 'PROCESS_GROUP_IDENTITY'
        close_deadline = time.monotonic() + close_budget
        try:
            process.terminate()
            process.wait(timeout=max(0, close_deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            process.kill()
            try: process.wait(timeout=max(0, close_deadline - time.monotonic()))
            except subprocess.TimeoutExpired: pass
        result['code'] = process.poll()
        result['groupEmpty'] = False
        result['elapsedMs'] = (time.monotonic() - started) * 1000
        close_capture()
        if capture_output:
            result['stdout'] = _captured_file(stdout_path); result['stderr'] = _captured_file(stderr_path)
        _bind_artifacts(result, artifact_probe, artifact_name, artifact_failure)
        _write(output / 'supervisor.json', result)
        return result
    try:
        process.wait(timeout=max(0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        result['failure'] = 'EXECUTION_TIMEOUT'
    result['code'] = process.poll()
    members = _members(result['pgid']); live = [row for row in members if not row['state'].startswith('Z')]
    if result['failure'] is None and (result['code'] != 0 or members):
        result['failure'] = 'PROCESS_EXIT' if result['code'] not in (0, None) else 'LEFTOVER_PROCESSES'
    if result['failure'] == 'EXECUTION_TIMEOUT' or live:
        result['groupEmpty'] = _terminate_group(process, result['pgid'], result['signals'], grace, close_budget)
    elif members:
        result['groupEmpty'] = _wait_empty(result['pgid'], close_budget)
    else:
        result['groupEmpty'] = True
    result['zombies'] = [row['pid'] for row in _members(result['pgid']) if row['state'].startswith('Z')]
    if not result['groupEmpty']:
        result['failure'] = 'CLOSE_TIMEOUT'
    result['code'] = process.poll()
    result['exitSignal'] = signal.Signals(-result['code']).name if result['code'] is not None and result['code'] < 0 else None
    result['passed'] = result['failure'] is None and result['code'] == 0 and result['groupEmpty'] and not result['signals']
    result['elapsedMs'] = (time.monotonic() - started) * 1000
    close_capture()
    if capture_output:
        result['stdout'] = _captured_file(stdout_path); result['stderr'] = _captured_file(stderr_path)
    _bind_artifacts(result, artifact_probe, artifact_name, artifact_failure)
    _write(output / 'supervisor.json', result)
    return result


def _sha(file):
    value = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): value.update(chunk)
    return value.hexdigest()


_SAFE = re.compile(r'^[a-z0-9-]{1,64}$', re.ASCII)
_SHA256 = re.compile(r'^[0-9a-f]{64}$', re.ASCII)
_GIT_SHA = re.compile(r'^[0-9a-f]{40}$', re.ASCII)
_GENERATION_PROFILES = {'history-limit', 'objects-limit', 'joint'}
_GENERATION_KEYS = {'schemaVersion', 'scope', 'owner', 'id', 'state', 'phase', 'profile', 'label', 'n',
                    'issuedAt', 'deadlineAt', 'limits', 'ownedManifest', 'sourceManifest'}
_GENERATION_LIMITS = {'executionMs': 1200000, 'killGraceMs': 1000, 'closeMs': 2000,
                      'minimumFreeBytes': 10 * 1024 ** 3, 'maximumOwnedBytes': 16 * 1024 ** 3}
_GENERATION_REQUIRED_FILES = ('source-before.json', 'command.json', 'space-before-snapshot.json',
                              'seed.sqlite', 'seed.json', 'source-after.json', 'exit.json')
_MEASURE_PROFILES = {'history-limit', 'objects-limit', 'joint'}
_MEASURE_KEYS = {'schemaVersion', 'scope', 'owner', 'id', 'state', 'phase', 'profile', 'label',
                 'seedLabel', 'n', 'issuedAt', 'deadlineAt', 'limits', 'seed',
                 'ownedManifest', 'sourceManifest', 'measurePlan', 'supervisor',
                 'candidateRepository'}
_MEASURE_LIMITS = {'executionMs': 900000, 'killGraceMs': 1000, 'closeMs': 2000,
                   'minimumFreeBytes': 10 * 1024 ** 3, 'maximumOwnedBytes': 16 * 1024 ** 3}
_MEASURE_PLAN = {'groupCloneCount': 3, 'fullHashCount': 3,
                 'stopRoundReceiptCount': 105, 'sampleCount': 1575}
_MEASURE_METRICS = ('progress', 'signalAborted', 'driverStopInvoked', 'driverStopAck',
                    'driverCloseInvoked', 'driverCloseResolved', 'receiptSettled', 'recordList',
                    'queryLastPage', 'queryChinese', 'queryMissing', 'queryPhysical',
                    'emptyPoll', 'pdf', 'photo')
_MEASURE_THRESHOLDS = {
    'progress': {'max': 100, 'p95': 50}, 'signalAborted': {'max': 100},
    'driverStopInvoked': {'max': 100}, 'receiptSettled': {'max': 2000, 'p95': 500},
    'driverCloseResolved': {'max': 250}, 'recordList': {'max': 1000, 'p95': 250},
    'queryMissing': {'max': 1000, 'p95': 250}, 'queryPhysical': {'max': 1000, 'p95': 250},
    'queryLastPage': {'max': 1000, 'p95': 250}, 'queryChinese': {'max': 1000, 'p95': 250},
    'emptyPoll': {'max': 50}, 'pdf': {'max': 1000, 'p95': 250}, 'photo': {'max': 1000, 'p95': 250}}
_MEASURE_REQUIRED_FILES = ('command.json', 'measurement.json', 'samples.jsonl', 'source-before.json',
                           'source-after.json', 'fixture-before.json', 'fixture-after.json',
                           'end-budget.json', 'summary.json', 'exit.json', 'measure-stages.jsonl')
_STOP_WORKSPACE_RECEIPT = 'group-stop.workspace.receipt.json'
_MEASURE_GROUPS = ('progress', 'stop', 'read')
_STOP_METRICS = ('signalAborted', 'driverStopInvoked', 'driverStopAck',
                 'driverCloseInvoked', 'driverCloseResolved', 'receiptSettled')
_STAGE_PHASES = ('copy', 'open-audit', 'operation', 'round-fsync', 'final-hash', 'cleanup')
_LEGACY_CARRYOVER_EVIDENCE = {
    'format': 'legacy-107-clone-partial-v1',
    'windowId': '1bcbe626-0ad2-401b-9140-7dbcf67cdce3',
    'label': 'r023-objects-limit-measure-01',
    'windowSha256': '5c646834b03e775b27959aaec4b0db25c4ffd84c064a835058f4171cbcfa45ea',
    'closeSha256': 'c88e14612044ca2e2e5784d655da6e8c0db861d45c6b893a0c4a27bb8c28b8e5',
    'commandSha256': 'a2fb65455cf4f2dadfe83198cdf1778d1fc3d87c989cf4834b80eeaf6bbf6add',
    'seedLabel': 'r023-objects-limit-seed-03',
    'seedSha256': '7ec9b3bed1642503cc9fcee70c6156b54eb43834b0a457050ec51607f2e1ab3a',
    'files': {
        'command.json': {'size': 1272, 'sha256': 'a2fb65455cf4f2dadfe83198cdf1778d1fc3d87c989cf4834b80eeaf6bbf6add'},
        'measurement.json': {'size': 626, 'sha256': 'b9f505f13f7fd41a3103773839548c5495f5905a1315d719aa4239a784fdfa5f'},
        'source-before.json': {'size': 933, 'sha256': '39e7dc66533321a7604eb2f0bf4b53c802f84406365af93bedcd8fdca834a02e'},
        'samples.jsonl': {'size': 32272, 'sha256': 'f089082c4a631bb9ef8554cb1a08d22c989887eed2ac12d1935a9e52e5b2d86f'},
    },
    'receiptSha256': (
        'b01d70d0506c9b38cfeb9c40c984a086fab9f436f1ed3a4b2fe621e636a50c6f',
        'a06927e4bbf6ce2cb56fb6d7364798fddfea8bdc8198fa83d5256a152145ed21',
        '08c8f14404a7077c195cc661172499bb4d5ee0640e8704c509c817a2f29bd377',
        '847341cee340560d83a9679345e8c76b4547222e8c541b506c3d8ca8481ffb6c',
        '4a3cc5e6fa07dd7352ddece575039c7d0907d168044b4e29bddacd7ee13e44b6',
        'aa6ccc5b4e5322768a3caab158c98c31e2235d203f00fe8eea007f8229e41cd4',
        '59784eb91e806e9c59a9cb4dc1ee61b3b128bc1cc43ad65b544defea0a7c43ec',
        '14bcce928f1ef68edb62da1711c24fa56a4d3224ab4004e1482d195e006fef35',
        '6779a50977b07bf1e780e6bd6aaf3d848c79ebd5af38159301ca344d81ee7329',
        '6f5e942d15ee21a1f677f2ae512ae77f5cbd94032a6a01648854f1b03535376e',
        '80bd3986cd6ca3e1b71bc88b07d97d4939c4147c3132d6647f48740d6d134c38',
        '6d4919c613a745014c0815f26c55e9a9d9c08dc5e6989b8a0016d4acfc305026',
        '5d646ea2aa290b29087d4954dc4642c89808e09fc66530f3004b82f9d0cdefb0',
        '8d83bba7f77dd551d256842607ad551f3e26a6b9e37b08005bb65985f7093423',
        '363ad2cb8e42afd29af19f371a26b6671f40c22438089cc0557aaff3aeef86d2',
        '528ccbe073f77a76360365162fb9c511b9c28935b53194edf15ae727fa21f8b9',
        '72a8d609723c8c48ae592616e5ea498e03bb2bbc0afc71b1b9f6f1e0fe29ebe9',
        'f2709e9393a9342bdf80cb1dc9c3b5b85ad647ae634b6e347266a1ea29de75bd',
        'c3aaadeb7f3f2ef62267c3cf971f89138305c596f2540a45aad1a28622926194',
        '10f3e0f4ccbe6783b713fce362ea0a6812329aab9d5dafce280e8bf5b1068fb4',
        'da6bd961e75c6e2aa14440c3fafb6972845ede0d49abf6f357dc6ffecc31726d',
        '9456f46bd6eff77706cd55d891e907dede7a14201370478fed653d25e2722320',
        'c4a27aeac6c6aff1a70cf7d6229e73f79c7d9c61bad93f0d8f1abae89930bd8d',
        'f01fd23ab6bd7ddf763000b6671833b466592f556ca7f2c231d91951ebb3df0e',
        '1c27000e90456a156837a90f9bc759ced140290dd4729532aa639144c5a73efc',
        '79ba11cdc8e4b188a0686285839ffe49064a9e2d464ae12f652adfb4e5dec21c',
        'fae99bad585e569206e749bd20cc2ee133b59cb5143b7e904d399cadb25100ff',
        '5215233afd983950641ed5c333093359bc1935480958984d0d38fe2a970131f2',
        'e683048b20dad2e86370e9cd5ccaaa93b0ea6e98a15bc2fdc9140a1e47efdb61',
    ),
    'receiptManifestSha256': 'cacf4abd5abe90c727d604401413be59e59821e773ef1fb33b9c3db0dd1050bc',
    'retainedOwner': {'id': '8bb717dc-97cf-49c1-899a-3a3e5a44a26a',
                      'scope': 'musicbridge-capacity-clone-only', 'label': 'sample-30'},
    'retainedOwnerSha256': '9be38eeceda792995fbff54a5e27dba239a4020c3a5578daff514987f4413b76',
    'sqliteBytes': 1990471680,
    'wal': {'size': 0, 'sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'},
    'shm': {'size': 32768, 'sha256': 'fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb'},
}


def _ordinary_file(file):
    return file.is_file() and not file.is_symlink()


def _file_inventory(file):
    exists = _ordinary_file(file)
    return {'exists': exists, 'size': file.stat().st_size if exists else None,
            'sha256': _sha(file) if exists else None}


def _read_json(file):
    try:
        if not _ordinary_file(file): return None
        return json.loads(file.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _uuid4(value):
    try:
        parsed = uuid.UUID(value)
        return parsed.version == 4 and parsed.variant == uuid.RFC_4122 and str(parsed) == value
    except (AttributeError, TypeError, ValueError):
        return False


def _strict_identity(file, maximum=None):
    file = Path(file)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try: fd = os.open(file, flags)
    except OSError as error: raise ValueError('ORDINARY_FILE') from error
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or maximum is not None and before.st_size > maximum:
            raise ValueError('ORDINARY_FILE')
        digest = hashlib.sha256(); total = 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk: break
            total += len(chunk); digest.update(chunk)
        after = os.fstat(fd)
    finally: os.close(fd)
    named = os.lstat(file)
    keys = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    if total != before.st_size or any(getattr(before, key) != getattr(after, key) or getattr(after, key) != getattr(named, key) for key in keys):
        raise ValueError('FILE_CHANGED')
    return {'device': before.st_dev, 'inode': before.st_ino, 'size': before.st_size,
            'mtimeNs': before.st_mtime_ns, 'ctimeNs': before.st_ctime_ns,
            'sha256': digest.hexdigest()}


def _strict_json(file, maximum=8 * 1024 * 1024):
    identity = _strict_identity(file, maximum)
    try: value = json.loads(Path(file).read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error: raise ValueError('JSON_INVALID') from error
    if _strict_identity(file, maximum) != identity: raise ValueError('FILE_CHANGED')
    return value, identity


def _expected_source_paths(root):
    root = Path(root).resolve(strict=True)
    names = ['package.json', 'pnpm-lock.yaml', 'packages/bridge-core/package.json',
             'packages/contracts/package.json',
             'packages/bridge-core/test/benchmarks/recording-capacity.ts',
             'packages/bridge-core/test/benchmarks/recording-capacity-process.ts',
             'scripts/ci/capacity-phase-supervisor-v2.py',
             'scripts/ci/issue-v3-capacity-measure-window.py']
    def walk(relative, suffix):
        directory = root / relative
        if not directory.is_dir() or directory.is_symlink(): raise ValueError('SOURCE_MANIFEST')
        for item in sorted(directory.iterdir(), key=lambda value: value.name):
            if item.is_symlink(): raise ValueError('SOURCE_CHANGED')
            child = str(item.relative_to(root))
            if item.is_dir(): walk(child, suffix)
            elif item.is_file() and item.name.endswith(suffix): names.append(child)
            if len(names) > 2048: raise ValueError('SOURCE_MANIFEST')
    for relative, suffix in (('packages/bridge-core/src', '.ts'), ('packages/bridge-core/test/helpers', '.ts'),
                             ('packages/contracts/src', '.ts'), ('packages/contracts/dist', '.js')):
        walk(relative, suffix)
    return root, sorted(names)


def _validate_source_manifest(manifest_path, root):
    try: manifest, manifest_identity = _strict_json(manifest_path)
    except ValueError as error: raise ValueError('SOURCE_MANIFEST') from error
    if not isinstance(manifest, dict) or set(manifest) != {'schemaVersion', 'scope', 'files'} \
            or manifest.get('schemaVersion') != 1 or manifest.get('scope') != 'musicbridge-capacity-source-pins' \
            or not isinstance(manifest.get('files'), dict):
        raise ValueError('SOURCE_MANIFEST')
    root, expected = _expected_source_paths(root)
    if set(manifest['files']) != set(expected): raise ValueError('SOURCE_MANIFEST')
    identities = {}
    for relative in expected:
        if Path(relative).is_absolute() or '..' in Path(relative).parts: raise ValueError('SOURCE_MANIFEST')
        file = root / relative
        try: identity = _strict_identity(file)
        except ValueError as error: raise ValueError('SOURCE_CHANGED') from error
        if file.resolve() != file or not str(file).startswith(str(root) + os.sep) \
                or _SHA256.fullmatch(str(manifest['files'].get(relative, ''))) is None \
                or identity['sha256'] != manifest['files'][relative]:
            raise ValueError('SOURCE_CHANGED')
        identities[relative] = identity
    return {'valid': True, 'fileCount': len(expected), 'manifestSha256': manifest_identity['sha256'],
            'manifestIdentity': manifest_identity, 'fileIdentities': identities}


_MARKERS = {'owner.json', 'capacity-owner.json', 'seed.json', 'command.json', 'r020-owner.json'}


def _inside(parent, child):
    try: return os.path.commonpath((str(parent), str(child))) == str(parent)
    except ValueError: return False


def _directory_bytes(directory, maximum=16 * 1024 ** 3, maximum_entries=200000):
    total = 0; count = 0; stack = [Path(directory)]
    while stack:
        current = stack.pop()
        for item in current.iterdir():
            count += 1
            if count > maximum_entries or item.is_symlink(): raise ValueError('OWNED_MANIFEST')
            info = item.lstat()
            if stat.S_ISDIR(info.st_mode): stack.append(item)
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                if total > maximum: raise ValueError('OWNED_SPACE')
            else: raise ValueError('OWNED_MANIFEST')
    return total, count


def _planned_generation_bytes(profile):
    mib = 1024 ** 2; gib = 1024 ** 3
    if profile == 'history-limit': axes, max_records = (int(.9 * 128 * mib + .999999), 0, 0, 0, 0), 1
    elif profile == 'objects-limit': axes, max_records = (0, 0, 0, int(.9 * gib + .999999), int(.9 * gib + .999999)), 220
    elif profile == 'joint': axes, max_records = (64 * mib, 64 * mib, 64 * mib, 512 * mib, 512 * mib), 130
    else: raise ValueError('OWNED_SPACE')
    # 与 createCapacitySeed 的写前投影保持同一公式，不能漏掉每条 Record 的工作余量。
    return 3 * sum(axes) + max_records * 16 * mib + 128 * mib


def _validate_owned_manifest(manifest_path, runtime, window_id, profile, planned_bytes=None,
                             future_path=None, future_state=None):
    try: manifest, manifest_identity = _strict_json(manifest_path)
    except ValueError as error: raise ValueError('OWNED_MANIFEST') from error
    manifest_keys = {'schemaVersion', 'scope', 'access', 'windowId', 'roots'}
    if future_path is not None: manifest_keys.add('futureRoots')
    if not isinstance(manifest, dict) or set(manifest) != manifest_keys \
            or manifest.get('schemaVersion') != 1 or manifest.get('scope') != 'musicbridge-capacity-owned-roots' \
            or manifest.get('access') != 'count-only' or manifest.get('windowId') != window_id \
            or not isinstance(manifest.get('roots'), list) or not 1 <= len(manifest['roots']) <= 68:
        raise ValueError('OWNED_MANIFEST')
    runtime = Path(runtime).resolve(strict=True); temp_root = Path(tempfile.gettempdir()).resolve(strict=True)
    future_roots = []; future_identities = {}
    if future_path is not None:
        expected_future = Path(future_path)
        if future_state not in {'absent', 'present'} or not expected_future.is_absolute() \
                or expected_future != runtime / expected_future.name or _SAFE.fullmatch(expected_future.name) is None \
                or manifest.get('futureRoots') != [str(expected_future)]:
            raise ValueError('OWNED_MANIFEST')
        future_roots = [str(expected_future)]
        if future_state == 'absent':
            if expected_future.exists() or expected_future.is_symlink(): raise ValueError('OWNED_MANIFEST')
        else:
            try: canonical_future = expected_future.resolve(strict=True); future_info = expected_future.lstat()
            except OSError as error: raise ValueError('OWNED_MANIFEST') from error
            if expected_future.is_symlink() or canonical_future != expected_future \
                    or not stat.S_ISDIR(future_info.st_mode):
                raise ValueError('OWNED_MANIFEST')
            try: future_marker = _strict_identity(expected_future / 'command.json', 8 * 1024 * 1024)
            except ValueError as error: raise ValueError('OWNED_MANIFEST') from error
            future_identities[str(expected_future)] = {
                'device': future_info.st_dev, 'inode': future_info.st_ino, 'marker': future_marker}
    # 只为后续窗口计费既有受控fixture；本次checkpoint身份仍仅接受冻结的temp_root。
    owned_fixture_roots = {temp_root, Path('/tmp').resolve(strict=True)}
    roots = []; identities = {}; seen = set()
    for row in manifest['roots']:
        if not isinstance(row, dict) or set(row) != {'path', 'device', 'inode', 'marker'} or type(row.get('device')) is not int \
                or type(row.get('inode')) is not int or not isinstance(row.get('path'), str): raise ValueError('OWNED_MANIFEST')
        path = Path(row['path'])
        try: canonical = path.resolve(strict=True); info = path.lstat()
        except OSError as error: raise ValueError('OWNED_MANIFEST') from error
        if path.is_symlink() or not stat.S_ISDIR(info.st_mode) or canonical != path or str(path) in seen \
                or info.st_dev != row['device'] or info.st_ino != row['inode']: raise ValueError('OWNED_MANIFEST')
        seen.add(str(path)); marker = row.get('marker')
        if not isinstance(marker, dict) or set(marker) != {'relative', 'sha256'} or marker.get('relative') not in _MARKERS \
                or _SHA256.fullmatch(str(marker.get('sha256', ''))) is None: raise ValueError('OWNED_MANIFEST')
        in_runtime = _inside(runtime, path) and path != runtime
        fixture = path.parent in owned_fixture_roots and re.fullmatch(r'musicbridge-version-[A-Za-z0-9]+', path.name)
        app_clone = path.parent == temp_root and re.fullmatch(r'musicbridge-ui-diagnostics-r021-[A-Za-z0-9]{6}', path.name)
        if not in_runtime and not (fixture and marker['relative'] == 'capacity-owner.json') \
                and not (app_clone and marker['relative'] == 'r020-owner.json'): raise ValueError('OWNED_MANIFEST')
        marker_path = path / marker['relative']
        try: marker_identity = _strict_identity(marker_path, 8 * 1024 * 1024)
        except ValueError as error: raise ValueError('OWNED_MANIFEST') from error
        if marker_identity['sha256'] != marker['sha256']: raise ValueError('OWNED_MANIFEST')
        roots.append(path); identities[str(path)] = {'device': info.st_dev, 'inode': info.st_ino,
                                                     'marker': marker_identity}
    minimal = [root for root in sorted(roots, key=lambda value: (len(value.parts), str(value)))
               if not any(root != other and _inside(other, root) for other in roots)]
    total = 0; entries = 0
    for root in minimal:
        value, count = _directory_bytes(root); total += value; entries += count
        if total > 16 * 1024 ** 3: raise ValueError('OWNED_SPACE')
    if future_path is not None and future_state == 'present':
        value, count = _directory_bytes(Path(future_path)); total += value; entries += count
        if total > 16 * 1024 ** 3: raise ValueError('OWNED_SPACE')
    planned = _planned_generation_bytes(profile) if planned_bytes is None else planned_bytes
    if type(planned) is not int or planned < 0 or planned > 16 * 1024 ** 3:
        raise ValueError('OWNED_SPACE')
    # terminal 已把真实 future output 计入 total；此时没有尚未落盘的未来预算，不能重复叠加 admission plan。
    remaining_planned = 0 if future_path is not None and future_state == 'present' else planned
    space = os.statvfs(runtime); available = space.f_bavail * space.f_frsize
    if total + remaining_planned > 16 * 1024 ** 3 \
            or available - remaining_planned < 10 * 1024 ** 3:
        raise ValueError('OWNED_SPACE')
    return {'valid': True, 'rootCount': len(roots) + len(future_roots),
            'minimalRootCount': len(minimal) + len(future_roots), 'entryCount': entries,
            'ownedBytes': total, 'plannedBytes': planned, 'availableBytes': available,
            'manifestSha256': manifest_identity['sha256'], 'manifestIdentity': manifest_identity,
            'rootIdentities': identities, 'futureRoots': future_roots,
            'futureRootIdentities': future_identities}


def _validate_generation_authority_once(parent, runtime, repo_root, window_sha256, profile):
    parent = Path(parent).resolve(strict=True); runtime = Path(runtime).resolve(strict=True)
    if parent.parent != runtime or parent.is_symlink(): raise ValueError('AUTHORITY_INVALID')
    window_path, owner_path = parent / 'window.json', parent / 'owner.json'
    window, window_identity = _strict_json(window_path)
    if window_identity['sha256'] != window_sha256: raise ValueError('AUTHORITY_INVALID')
    _validate_generation_window(window, min(time.time(), _generation_times(window)[1] - .001))
    owner, owner_identity = _strict_json(owner_path)
    if not isinstance(owner, dict) or set(owner) != {'scope', 'owner', 'id'} or owner != {
            'scope': window['scope'], 'owner': 'root', 'id': window['id']}:
        raise ValueError('AUTHORITY_INVALID')
    source_path, owned_path = parent / 'source-pins.json', parent / 'owned-roots.json'
    if window['sourceManifest']['sha256'] != _strict_identity(source_path)['sha256'] \
            or window['ownedManifest']['sha256'] != _strict_identity(owned_path)['sha256']:
        raise ValueError('AUTHORITY_INVALID')
    source = _validate_source_manifest(source_path, repo_root)
    owned = _validate_owned_manifest(owned_path, runtime, window['id'], profile)
    snapshot = {'window': window_identity, 'owner': owner_identity,
                'sourceManifest': source['manifestIdentity'], 'ownedManifest': owned['manifestIdentity'],
                'sourceFiles': source['fileIdentities'], 'ownedRoots': owned['rootIdentities']}
    return {'authorityStable': True, 'windowStable': True, 'ownerStable': True,
            'sourceManifestStable': True, 'ownedManifestStable': True,
            'sourcePinsValid': True, 'ownedRootsValid': True, 'spaceValid': True,
            'windowSha256Observed': window_identity['sha256'], 'ownerSha256Observed': owner_identity['sha256'],
            'sourceManifestSha256Observed': source['manifestSha256'],
            'ownedManifestSha256Observed': owned['manifestSha256'],
            'sourceFileCount': source['fileCount'], 'ownedRootCount': owned['rootCount'],
            'ownedBytes': owned['ownedBytes'], 'plannedBytes': owned['plannedBytes'],
            'availableBytes': owned['availableBytes'], '_snapshot': snapshot}


def _validate_generation_authority(parent, runtime, repo_root, window_sha256, profile, initial=None):
    try: observed = _validate_generation_authority_once(parent, runtime, repo_root, window_sha256, profile)
    except ValueError as error:
        if initial is not None: raise ValueError('AUTHORITY_DRIFT') from error
        raise
    if initial is not None and observed['_snapshot'] != initial.get('_snapshot'):
        raise ValueError('AUTHORITY_DRIFT')
    return observed


def _validate_measure_seed(runtime, window):
    runtime = Path(runtime).resolve(strict=True)
    label = window.get('seedLabel')
    if _SAFE.fullmatch(label or '') is None: raise ValueError('SEED_INVALID')
    seed_directory = runtime / label
    try: canonical = seed_directory.resolve(strict=True); directory_info = seed_directory.lstat()
    except OSError as error: raise ValueError('SEED_INVALID') from error
    if seed_directory.is_symlink() or not stat.S_ISDIR(directory_info.st_mode) or canonical != seed_directory \
            or seed_directory.parent != runtime: raise ValueError('SEED_INVALID')
    expected = window.get('seed')
    if not isinstance(expected, dict): raise ValueError('SEED_INVALID')
    metadata_path, snapshot_path = seed_directory / 'seed.json', seed_directory / 'seed.sqlite'
    try:
        metadata, metadata_identity = _strict_json(metadata_path)
        snapshot_identity = _strict_identity(snapshot_path)
    except ValueError as error: raise ValueError('SEED_INVALID') from error
    if metadata_identity['sha256'] != expected.get('metadataSha256') \
            or snapshot_identity['sha256'] != expected.get('snapshotSha256') \
            or any((Path(str(snapshot_path) + suffix).exists() or Path(str(snapshot_path) + suffix).is_symlink())
                   for suffix in ('-wal', '-shm', '-journal')):
        raise ValueError('SEED_INVALID')
    if not isinstance(metadata, dict) or metadata.get('schema') != 21 or metadata.get('profile') != window.get('profile') \
            or metadata.get('integrity') != 'passed' or metadata.get('growth', {}).get('state') != 'target-reached' \
            or not _uuid4(metadata.get('nextPlanId')) or _SHA256.fullmatch(str(metadata.get('nextPlanHash', ''))) is None \
            or metadata.get('snapshotSha256') != expected.get('snapshotSha256') \
            or not isinstance(metadata.get('budget'), dict) or not isinstance(metadata.get('fixtureDirectory'), str):
        raise ValueError('SEED_INVALID')
    try: fixture = _fixture_snapshot(metadata['fixtureDirectory'])
    except ValueError as error: raise ValueError('SEED_INVALID') from error
    if fixture['marker'] != metadata.get('marker') or fixture['markerSha256'] != expected.get('fixtureOwnerSha256'):
        raise ValueError('SEED_INVALID')
    return {'valid': True, 'seedDirectory': str(seed_directory), 'snapshotBytes': snapshot_identity['size'],
            'metadata': metadata, 'metadataIdentity': metadata_identity, 'snapshotIdentity': snapshot_identity,
            'directoryIdentity': {'device': directory_info.st_dev, 'inode': directory_info.st_ino},
            'fixture': fixture}


def _require_measure_owned_roots(owned, parent, seed, output):
    roots = set(owned.get('rootIdentities', {})) if isinstance(owned, dict) else set()
    required = {str(Path(parent)), str(seed.get('seedDirectory')), str(seed.get('fixture', {}).get('path'))}
    if None in required or 'None' in required or not required.issubset(roots) \
            or owned.get('futureRoots') != [str(Path(output))]:
        raise ValueError('OWNED_MANIFEST')
    return True


def _validate_measure_authority_once(parent, runtime, repo_root, window_sha256, terminal=False):
    parent = Path(parent).resolve(strict=True); runtime = Path(runtime).resolve(strict=True)
    if parent.parent != runtime or parent.is_symlink(): raise ValueError('AUTHORITY_INVALID')
    window_path, owner_path = parent / 'window.json', parent / 'owner.json'
    window, window_identity = _strict_json(window_path)
    if window_identity['sha256'] != window_sha256: raise ValueError('AUTHORITY_INVALID')
    _validate_measure_window(window, min(time.time(), _measure_times(window)[1] - .001))
    owner, owner_identity = _strict_json(owner_path)
    if owner != {'scope': window['scope'], 'owner': 'root', 'id': window['id']}:
        raise ValueError('AUTHORITY_INVALID')
    source_path, owned_path = parent / 'source-pins.json', parent / 'owned-roots.json'
    if window['sourceManifest']['sha256'] != _strict_identity(source_path)['sha256'] \
            or window['ownedManifest']['sha256'] != _strict_identity(owned_path)['sha256']:
        raise ValueError('AUTHORITY_INVALID')
    seed = _validate_measure_seed(runtime, window)
    source = _validate_source_manifest(source_path, repo_root)
    planned = 2 * seed['snapshotBytes'] + 256 * 1024 ** 2
    output = runtime / window['label']
    owned = _validate_owned_manifest(
        owned_path, runtime, window['id'], window['profile'], planned_bytes=planned,
        future_path=output, future_state='present' if terminal else 'absent')
    _require_measure_owned_roots(owned, parent, seed, output)
    snapshot = {'window': window_identity, 'owner': owner_identity,
                'candidateRepository': dict(window['candidateRepository']),
                'sourceManifest': source['manifestIdentity'], 'ownedManifest': owned['manifestIdentity'],
                'sourceFiles': source['fileIdentities'], 'ownedRoots': owned['rootIdentities'],
                'ownedFutureRoots': owned['futureRoots'],
                'seedMetadata': seed['metadataIdentity'], 'seedSnapshot': seed['snapshotIdentity'],
                'seedDirectory': seed['directoryIdentity'], 'seedFixture': seed['fixture']}
    return {'authorityStable': True, 'windowStable': True, 'ownerStable': True,
            'sourceManifestStable': True, 'ownedManifestStable': True, 'sourcePinsValid': True,
            'ownedRootsValid': True, 'spaceValid': True, 'seedValid': True,
            'windowSha256Observed': window_identity['sha256'], 'ownerSha256Observed': owner_identity['sha256'],
            'sourceManifestSha256Observed': source['manifestSha256'],
            'ownedManifestSha256Observed': owned['manifestSha256'], 'sourceFileCount': source['fileCount'],
            'candidateRepository': dict(window['candidateRepository']),
            'ownedRootCount': owned['rootCount'], 'ownedBytes': owned['ownedBytes'],
            'ownedFutureRootIdentities': owned['futureRootIdentities'],
            'plannedBytes': owned['plannedBytes'], 'availableBytes': owned['availableBytes'],
            'seedMetadataSha256Observed': seed['metadataIdentity']['sha256'],
            'seedSnapshotSha256Observed': seed['snapshotIdentity']['sha256'],
            'seedSnapshotBytes': seed['snapshotBytes'], 'seedBudget': seed['metadata']['budget'], '_snapshot': snapshot}


def _validate_measure_authority(parent, runtime, repo_root, window_sha256, initial=None):
    try: observed = _validate_measure_authority_once(
        parent, runtime, repo_root, window_sha256, terminal=initial is not None)
    except ValueError as error:
        if initial is not None: raise ValueError('AUTHORITY_DRIFT') from error
        raise
    if initial is not None and observed['_snapshot'] != initial.get('_snapshot'):
        raise ValueError('AUTHORITY_DRIFT')
    return observed


def _fixture_snapshot(fixture):
    fixture = Path(fixture)
    try: canonical = fixture.resolve(strict=True); info = fixture.lstat()
    except OSError as error: raise ValueError('FIXTURE_IDENTITY') from error
    temp_root = Path(tempfile.gettempdir()).resolve(strict=True)
    if fixture.is_symlink() or not stat.S_ISDIR(info.st_mode) or canonical != fixture or fixture.parent != temp_root \
            or re.fullmatch(r'musicbridge-version-[A-Za-z0-9]+', fixture.name) is None:
        raise ValueError('FIXTURE_IDENTITY')
    marker_path = fixture / 'capacity-owner.json'
    try: marker, marker_identity = _strict_json(marker_path, 1024 * 1024)
    except ValueError as error: raise ValueError('FIXTURE_MARKER') from error
    if not isinstance(marker, dict) or set(marker) != {'id', 'scope'} or not _uuid4(marker.get('id')) \
            or marker.get('scope') != 'musicbridge-capacity-synthetic-only':
        raise ValueError('FIXTURE_MARKER')
    return {'path': str(fixture), 'device': info.st_dev, 'inode': info.st_ino,
            'markerDevice': marker_identity['device'], 'markerInode': marker_identity['inode'],
            'markerSha256': marker_identity['sha256'], 'marker': marker}


def _validate_generation_fixture(output):
    output = Path(output)
    checkpoints = sorted((path for path in output.iterdir()
                          if re.fullmatch(r'checkpoint-[1-9][0-9]*\.json', path.name)),
                         key=lambda path: int(path.stem.split('-')[1]))
    if not checkpoints: raise ValueError('CHECKPOINT_MISSING')
    directories = []
    for checkpoint in checkpoints:
        try: value, _ = _strict_json(checkpoint)
        except ValueError as error: raise ValueError('CHECKPOINT_INVALID') from error
        if not isinstance(value, dict) or not isinstance(value.get('fixtureDirectory'), str):
            raise ValueError('CHECKPOINT_INVALID')
        directories.append(value['fixtureDirectory'])
    if len(set(directories)) != 1: raise ValueError('CHECKPOINT_SPLIT')
    fixture = Path(directories[0])
    before = _fixture_snapshot(fixture)
    seed_path = output / 'seed.json'; seed = None
    if seed_path.exists() or seed_path.is_symlink():
        try: seed, _ = _strict_json(seed_path)
        except ValueError as error: raise ValueError('SEED_FIXTURE') from error
        if not isinstance(seed, dict) or seed.get('fixtureDirectory') != str(fixture) or seed.get('marker') != before['marker']:
            raise ValueError('SEED_FIXTURE')
    after = _fixture_snapshot(fixture)
    if before != after: raise ValueError('FIXTURE_CHANGED')
    return {'valid': True, 'checkpointCount': len(checkpoints), 'latestCheckpoint': checkpoints[-1].name,
            'fixtureDirectory': str(fixture), 'seedBound': seed is not None, 'identityStable': True,
            'device': before['device'], 'inode': before['inode'], 'markerDevice': before['markerDevice'],
            'markerInode': before['markerInode'], 'markerSha256': before['markerSha256'],
            'marker': before['marker']}


def _generation_artifacts(runtime, label, expected=None):
    if _SAFE.fullmatch(label) is None: raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    runtime = Path(runtime).resolve(strict=True)
    output = runtime / label
    output_exists = output.is_dir() and not output.is_symlink() and output.resolve() == output
    checkpoints = []
    seed_exists = False
    entries = []
    if output_exists:
        entries = sorted(file.name for file in output.iterdir())
        checkpoints = sorted(file.name for file in output.iterdir()
                             if re.fullmatch(r'checkpoint-[1-9][0-9]*\.json', file.name)
                             and file.is_file() and not file.is_symlink())
        seed = output / 'seed.json'
        seed_exists = seed.is_file() and not seed.is_symlink()
    allowed = set(_GENERATION_REQUIRED_FILES) | set(checkpoints)
    unexpected = [name for name in entries if name not in allowed]
    files = {name: _file_inventory(output / name) for name in (*_GENERATION_REQUIRED_FILES, *checkpoints)}
    sidecars = [f'seed.sqlite{suffix}' for suffix in ('-wal', '-shm', '-journal')]
    no_sidecars = not any((output / name).exists() or (output / name).is_symlink() for name in sidecars)
    seed = _read_json(output / 'seed.json') if output_exists else None
    exit_receipt = _read_json(output / 'exit.json') if output_exists else None
    before = _read_json(output / 'source-before.json') if output_exists else None
    after = _read_json(output / 'source-after.json') if output_exists else None
    command = _read_json(output / 'command.json') if output_exists else None
    target_reached = (seed.get('growth', {}).get('state') == 'target-reached') if isinstance(seed, dict) else None
    seed_sha_matches = False
    seed_profile_matches = False
    command_matches = False
    fixture_identity = None; fixture_identity_valid = False; fixture_error = None
    authority = None; authority_stable = False; authority_error = None
    if expected is not None and isinstance(seed, dict):
        seed_profile_matches = seed.get('profile') == expected['profile']
        seed_file = output / 'seed.sqlite'
        seed_sha_matches = _ordinary_file(seed_file) and seed.get('snapshotSha256') == _sha(seed_file)
    if expected is not None and isinstance(command, dict):
        wanted_args = [str(expected['entry']), '--phase', 'generate', '--profile', expected['profile'],
                       '--label', expected['label'], '--window', expected['window']]
        expected_cwd = str(expected['root'])
        command_matches = (command.get('executable') == expected['node'] and command.get('args') == wanted_args
                           and command.get('cwd') in {expected_cwd, expected_cwd + os.sep} and command.get('node') == 'v22.23.2'
                           and command.get('phase') == 'generate'
                           and command.get('profile') == expected['profile'] and command.get('window') == expected['window'])
    if expected is not None and output_exists and checkpoints:
        try:
            fixture_identity = _validate_generation_fixture(output); fixture_identity_valid = True
        except ValueError as error: fixture_error = str(error)
    if expected is not None and callable(expected.get('authorityProbe')):
        try:
            observed = expected['authorityProbe']()
            authority = {key: value for key, value in observed.items() if key != '_snapshot'}
            authority_stable = authority.get('authorityStable') is True and authority.get('sourcePinsValid') is True \
                and authority.get('ownedRootsValid') is True and authority.get('spaceValid') is True
        except ValueError as error: authority_error = str(error)
    all_required = all(files[name]['exists'] and files[name]['size'] > 0 and files[name]['sha256']
                       for name in _GENERATION_REQUIRED_FILES)
    verified = (expected is not None and output_exists and all_required and len(checkpoints) > 0 and not unexpected
                and no_sidecars and exit_receipt == {'exit': 0} and target_reached is True
                and seed_profile_matches and seed_sha_matches and before is not None and before == after and command_matches
                and fixture_identity_valid and authority_stable)
    return {
        'profile': expected['profile'] if expected is not None else None,
        'label': expected['label'] if expected is not None else label,
        'window': expected['window'] if expected is not None else None,
        'windowSha256': expected.get('windowSha256') if expected is not None else None,
        'ownedManifestSha256': expected.get('ownedManifestSha256') if expected is not None else None,
        'sourceManifestSha256': expected.get('sourceManifestSha256') if expected is not None else None,
        'outputDirectory': str(output),
        'outputDirectoryExists': output_exists,
        'partialExists': output_exists and not verified,
        'partialPreserved': True,
        'allowlist': [*_GENERATION_REQUIRED_FILES, 'checkpoint-<positive-integer>.json'],
        'files': files,
        'unexpectedEntries': unexpected,
        'checkpointFiles': checkpoints,
        'checkpointCount': len(checkpoints),
        'seedExists': seed_exists,
        'seedMetadataSha256Observed': files['seed.json']['sha256'],
        'snapshotSha256Observed': files['seed.sqlite']['sha256'],
        'exitZero': exit_receipt == {'exit': 0},
        'seedProfileMatches': seed_profile_matches,
        'seedShaMatches': seed_sha_matches,
        'noSqliteSidecars': no_sidecars,
        'sourceBeforeEqualsAfter': before is not None and before == after,
        'commandMatchesWindow': command_matches,
        'fixtureIdentityValid': fixture_identity_valid,
        'fixtureIdentity': fixture_identity,
        'fixtureError': fixture_error,
        'authorityStable': authority_stable,
        'authority': authority,
        'authorityError': authority_error,
        'targetReached': target_reached,
        'targetVerdict': 'CHILD_SEED_TARGET_REACHED' if target_reached is True else 'CHILD_SEED_EVIDENCE_REQUIRED',
        'verifiedPassed': verified
    }


def _measure_times(window):
    try:
        issued = datetime.datetime.fromisoformat(window['issuedAt'])
        deadline = datetime.datetime.fromisoformat(window['deadlineAt'])
    except (KeyError, TypeError, ValueError):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    if issued.utcoffset() is None or deadline.utcoffset() is None \
            or deadline - issued != datetime.timedelta(seconds=900):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    return issued.timestamp(), deadline.timestamp()


def _validate_measure_window(window, now):
    required = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-measure-window',
                'owner': 'root', 'state': 'approved', 'phase': 'measure'}
    if not isinstance(window, dict) or set(window) != _MEASURE_KEYS \
            or any(window.get(key) != value for key, value in required.items()):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    if window.get('profile') not in _MEASURE_PROFILES or type(window.get('n')) is not int or window['n'] != 105 \
            or _SAFE.fullmatch(window.get('label', '')) is None \
            or _SAFE.fullmatch(window.get('seedLabel', '')) is None or not _uuid4(window.get('id')) \
            or window.get('limits') != _MEASURE_LIMITS or window.get('measurePlan') != _MEASURE_PLAN:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    _validate_supervisor_identity(window)
    try: _validate_candidate_repository(window)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    seed = window.get('seed')
    if not isinstance(seed, dict) or set(seed) != {'metadataSha256', 'snapshotSha256', 'fixtureOwnerSha256'} \
            or any(_SHA256.fullmatch(str(seed.get(key, ''))) is None for key in seed):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    for key, name in (('ownedManifest', 'owned-roots.json'), ('sourceManifest', 'source-pins.json')):
        manifest = window.get(key)
        if not isinstance(manifest, dict) or set(manifest) != {'file', 'sha256'} \
                or manifest.get('file') != name or _SHA256.fullmatch(str(manifest.get('sha256', ''))) is None:
            raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    issued, deadline = _measure_times(window)
    if deadline <= now or issued > now + 1:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    return issued, deadline


def _runtime_repo_root():
    script = Path(__file__).resolve(strict=True)
    runtime = script.parent.parent
    return runtime.parents[2]


def _git_value(root, *arguments):
    try:
        return subprocess.check_output(
            ['/usr/bin/git', *arguments], cwd=root, text=True,
            stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError('CANDIDATE_REPOSITORY') from error


def _validate_candidate_repository(window, runtime=None):
    candidate = window.get('candidateRepository') if isinstance(window, dict) else None
    if not isinstance(candidate, dict) or set(candidate) != {'root', 'branch', 'head'} \
            or not isinstance(candidate.get('root'), str) \
            or not isinstance(candidate.get('branch'), str) or not candidate['branch'] \
            or len(candidate['branch']) > 255 or '\x00' in candidate['branch'] \
            or _GIT_SHA.fullmatch(str(candidate.get('head', ''))) is None:
        raise ValueError('CANDIDATE_REPOSITORY')
    supplied = Path(candidate['root'])
    try: root = supplied.resolve(strict=True); info = supplied.lstat()
    except OSError as error: raise ValueError('CANDIDATE_REPOSITORY') from error
    if not supplied.is_absolute() or supplied != root or supplied.is_symlink() \
            or not stat.S_ISDIR(info.st_mode):
        raise ValueError('CANDIDATE_REPOSITORY')
    if runtime is not None:
        try: runtime = Path(runtime).resolve(strict=True)
        except OSError as error: raise ValueError('CANDIDATE_REPOSITORY') from error
        if root == runtime.parents[2]: raise ValueError('CANDIDATE_REPOSITORY')
    if _git_value(root, 'branch', '--show-current') != candidate['branch'] \
            or _git_value(root, 'rev-parse', 'HEAD^{commit}') != candidate['head']:
        raise ValueError('CANDIDATE_REPOSITORY')
    return root


def _measure_execution_target(window, runtime):
    root = _validate_candidate_repository(window, runtime)
    entry = root / 'packages/bridge-core/test/benchmarks/recording-capacity.ts'
    try: _strict_identity(entry, 8 * 1024 * 1024)
    except ValueError as error: raise ValueError('CANDIDATE_REPOSITORY') from error
    return root, entry


def _validate_supervisor_identity(window):
    supervisor = window.get('supervisor') if isinstance(window, dict) else None
    script = Path(__file__)
    try:
        canonical = script.resolve(strict=True)
        identity = _strict_identity(canonical, 8 * 1024 * 1024)
    except (OSError, ValueError) as error:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    if not isinstance(supervisor, dict) or set(supervisor) != {'path', 'sha256'} \
            or not isinstance(supervisor.get('path'), str) \
            or Path(supervisor['path']) != canonical \
            or _SHA256.fullmatch(str(supervisor.get('sha256', ''))) is None \
            or supervisor['sha256'] != identity['sha256']:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    return identity


def _carryover_root_identity(root, marker_name):
    root = Path(root)
    try:
        info = root.lstat(); canonical = root.resolve(strict=True)
        marker = _strict_identity(root / marker_name, 8 * 1024 * 1024)
    except (OSError, ValueError) as error:
        raise ValueError('MEASURE_CARRYOVER') from error
    if root.is_symlink() or canonical != root or not stat.S_ISDIR(info.st_mode):
        raise ValueError('MEASURE_CARRYOVER')
    return {'path': str(root), 'device': info.st_dev, 'inode': info.st_ino,
            'marker': {'relative': marker_name, 'sha256': marker['sha256']}}


def _legacy_stable_lstat(file, expected_size):
    """只以lstat绑定旧retained SQLite，禁止读取这个近2GB文件。"""
    try: info = os.lstat(file)
    except OSError as error: raise ValueError('MEASURE_CARRYOVER') from error
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != expected_size:
        raise ValueError('MEASURE_CARRYOVER')
    return info


def _legacy_same_lstat(file, before):
    try: after = os.lstat(file)
    except OSError as error: raise ValueError('MEASURE_CARRYOVER') from error
    keys = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    if any(getattr(before, key) != getattr(after, key) for key in keys):
        raise ValueError('MEASURE_CARRYOVER')


def _legacy_jsonl(file):
    try:
        identity = _strict_identity(file, 8 * 1024 * 1024)
        rows = [json.loads(line) for line in Path(file).read_text().splitlines()]
        if _strict_identity(file, 8 * 1024 * 1024) != identity: raise ValueError('FILE_CHANGED')
        return rows, identity
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError('MEASURE_CARRYOVER') from error


def _legacy_sample(row, metric, warmup, details):
    return isinstance(row, dict) and set(row) == {'details', 'durationMs', 'metric', 'outcome', 'warmup'} \
        and row.get('metric') == metric and row.get('warmup') is warmup and row.get('outcome') == 'ok' \
        and row.get('details') == details and type(row.get('durationMs')) in (int, float) \
        and math.isfinite(row['durationMs']) and row['durationMs'] >= 0


def _validate_measure_carryover(previous_window, previous_close, previous_output, runtime,
                                expected_window_sha256, expected_close_sha256,
                                expected_command_sha256, expected_window_id, expected_label):
    """验证唯一旧107-clone超时partial；大SQLite只做stable lstat，绝不读取。"""
    evidence = _LEGACY_CARRYOVER_EVIDENCE
    try:
        runtime = Path(runtime).resolve(strict=True)
        window_path = Path(previous_window).resolve(strict=True)
        close_path = Path(previous_close).resolve(strict=True)
        output = Path(previous_output).resolve(strict=True)
    except OSError as error:
        raise ValueError('MEASURE_CARRYOVER') from error
    supplied = (Path(previous_window), Path(previous_close), Path(previous_output))
    expected_hashes = (expected_window_sha256, expected_close_sha256, expected_command_sha256)
    if any(not path.is_absolute() or path != resolved for path, resolved in
           zip(supplied, (window_path, close_path, output))) \
            or any(_SHA256.fullmatch(str(value or '')) is None for value in expected_hashes) \
            or window_path.name != 'window.json' or close_path.name != 'close.json' \
            or window_path.parent != close_path.parent or window_path.parent.parent != runtime \
            or output.parent != runtime or _SAFE.fullmatch(str(expected_label or '')) is None \
            or not _uuid4(expected_window_id):
        raise ValueError('MEASURE_CARRYOVER')
    if not isinstance(evidence, dict) or evidence.get('format') != 'legacy-107-clone-partial-v1' \
            or evidence.get('windowId') != expected_window_id or evidence.get('label') != expected_label \
            or evidence.get('windowSha256') != expected_window_sha256 \
            or evidence.get('closeSha256') != expected_close_sha256 \
            or evidence.get('commandSha256') != expected_command_sha256:
        raise ValueError('MEASURE_CARRYOVER')
    try:
        window, window_identity = _strict_json(window_path)
        close, close_identity = _strict_json(close_path)
        command, command_identity = _strict_json(output / 'command.json')
    except ValueError as error:
        raise ValueError('MEASURE_CARRYOVER') from error
    if window_identity['sha256'] != expected_window_sha256 \
            or close_identity['sha256'] != expected_close_sha256 \
            or command_identity['sha256'] != expected_command_sha256:
        raise ValueError('MEASURE_CARRYOVER')
    if not isinstance(window, dict) or window.get('schemaVersion') != 1 \
            or window.get('scope') != 'musicbridge-capacity-measure-window' \
            or window.get('id') != expected_window_id or window.get('label') != expected_label:
        raise ValueError('MEASURE_CARRYOVER')
    authority_admission = close.get('authorityAdmission') if isinstance(close, dict) else None
    authority_terminal = close.get('authorityTerminal') if isinstance(close, dict) else None
    measurement = close.get('measurement') if isinstance(close, dict) else None
    if not isinstance(close, dict) or close.get('schemaVersion') != 1 \
            or close.get('scope') != 'musicbridge-capacity-measure-window-close' \
            or close.get('windowId') != expected_window_id or close.get('label') != expected_label \
            or close.get('state') != 'failed' or close.get('failure') != 'EXECUTION_TIMEOUT' \
            or close.get('groupEmpty') is not True or close.get('zombies') != [] \
            or close.get('windowSha256') != expected_window_sha256 \
            or close.get('deviceOpened') is not False or close.get('formalReady') is not False \
            or close.get('gateB') != 'NOT_RUN' \
            or close.get('replayPolicy') != 'terminal-window-id-and-label-never-reuse' \
            or not isinstance(authority_admission, dict) or authority_admission.get('authorityStable') is not True \
            or not isinstance(authority_terminal, dict) or authority_terminal.get('authorityStable') is not True \
            or not isinstance(measurement, dict):
        raise ValueError('MEASURE_CARRYOVER')
    sqlite_bytes = evidence.get('sqliteBytes')
    if type(sqlite_bytes) is not int or sqlite_bytes <= 0 \
            or authority_admission.get('seedSnapshotBytes') != sqlite_bytes \
            or authority_terminal.get('seedSnapshotBytes') != sqlite_bytes:
        raise ValueError('MEASURE_CARRYOVER')
    if measurement.get('outputDirectory') != str(output) \
            or measurement.get('partialExists') is not True \
            or measurement.get('partialPreserved') is not True \
            or measurement.get('verifiedComplete') is not False \
            or measurement.get('verifiedPassed') is not False \
            or measurement.get('authorityStable') is not True \
            or measurement.get('commandMatchesWindow') is not True \
            or measurement.get('sampleCount') != 273 or measurement.get('receiptCount') != 29:
        raise ValueError('MEASURE_CARRYOVER')
    command_keys = {'arch', 'args', 'cache', 'cwd', 'deviceOpened', 'executable', 'formalReady', 'gateB',
                    'logicalCpus', 'node', 'osVersion', 'phase', 'platform', 'profile',
                    'profileDefinition', 'window'}
    args = command.get('args') if isinstance(command, dict) else None
    def option(name):
        if not isinstance(args, list) or args.count(name) != 1: return None
        index = args.index(name)
        return args[index + 1] if index + 1 < len(args) else None
    if not isinstance(command, dict) or set(command) != command_keys \
            or command.get('phase') != 'measure' or command.get('window') != expected_window_id \
            or command.get('profile') != 'objects-limit' or command.get('deviceOpened') is not False \
            or command.get('formalReady') is not False or command.get('gateB') != 'NOT_RUN' \
            or option('--phase') != 'measure' or option('--profile') != 'objects-limit' \
            or option('--label') != expected_label or option('--window') != expected_window_id \
            or option('--seed-label') != evidence.get('seedLabel'):
        raise ValueError('MEASURE_CARRYOVER')

    fixed_names = ('command.json', 'measurement.json', 'source-before.json', 'samples.jsonl')
    receipt_names = [f'sample-{index}.receipt.json' for index in range(1, 30)]
    expected_entries = set(fixed_names) | set(receipt_names) | {'sample-30'}
    try:
        entries = {item.name for item in output.iterdir()}
    except (OSError, ValueError) as error:
        raise ValueError('MEASURE_CARRYOVER') from error
    if entries != expected_entries: raise ValueError('MEASURE_CARRYOVER')

    expected_files = evidence.get('files')
    if not isinstance(expected_files, dict) or set(expected_files) != set(fixed_names):
        raise ValueError('MEASURE_CARRYOVER')
    identities = {'command.json': command_identity}
    try:
        measurement_file, identities['measurement.json'] = _strict_json(output / 'measurement.json')
        _, identities['source-before.json'] = _strict_json(output / 'source-before.json')
        samples, identities['samples.jsonl'] = _legacy_jsonl(output / 'samples.jsonl')
    except ValueError as error:
        raise ValueError('MEASURE_CARRYOVER') from error
    for name in fixed_names:
        expected = expected_files.get(name)
        if not isinstance(expected, dict) or set(expected) != {'size', 'sha256'} \
                or identities[name]['size'] != expected.get('size') \
                or identities[name]['sha256'] != expected.get('sha256'):
            raise ValueError('MEASURE_CARRYOVER')
    close_files = measurement.get('files')
    absent = ('source-after.json', 'end-budget.json', 'summary.json', 'exit.json')
    if not isinstance(close_files, dict) or set(close_files) != set(fixed_names) | set(absent):
        raise ValueError('MEASURE_CARRYOVER')
    for name in fixed_names:
        if close_files.get(name) != {'exists': True, **expected_files[name]}:
            raise ValueError('MEASURE_CARRYOVER')
    if any(close_files.get(name) != {'exists': False, 'size': None, 'sha256': None} for name in absent):
        raise ValueError('MEASURE_CARRYOVER')
    measurement_keys = {'cache', 'classification', 'excluded', 'profile', 'progressSamples', 'readSamples',
                        'seedLabel', 'seedSha256', 'stopSamples', 'warmup', 'window'}
    if not isinstance(measurement_file, dict) or set(measurement_file) != measurement_keys \
            or measurement_file.get('window') != expected_window_id \
            or measurement_file.get('profile') != 'objects-limit' \
            or measurement_file.get('seedLabel') != evidence.get('seedLabel') \
            or measurement_file.get('seedSha256') != evidence.get('seedSha256') \
            or measurement_file.get('warmup') != 5 or measurement_file.get('progressSamples') != 100 \
            or measurement_file.get('stopSamples') != 100 or measurement_file.get('readSamples') != 100:
        raise ValueError('MEASURE_CARRYOVER')

    if len(samples) != 273:
        raise ValueError('MEASURE_CARRYOVER')
    for index, row in enumerate(samples[:105]):
        if not _legacy_sample(row, 'progress', index < 5, None): raise ValueError('MEASURE_CARRYOVER')
    offset = 105
    for sample_index in range(28):
        for metric_index, metric in enumerate(_STOP_METRICS):
            row = samples[offset + sample_index * 6 + metric_index]
            if not _legacy_sample(row, metric, sample_index < 5,
                                  {'sample': sample_index, 'observed': True}):
                raise ValueError('MEASURE_CARRYOVER')

    expected_receipt_sha = evidence.get('receiptSha256')
    if not isinstance(expected_receipt_sha, (list, tuple)) or len(expected_receipt_sha) != 29:
        raise ValueError('MEASURE_CARRYOVER')
    receipt_samples = []; marker_ids = set(); receipt_inventory = []
    for index, name in enumerate(receipt_names, 1):
        try: receipt, identity = _strict_json(output / name)
        except ValueError as error: raise ValueError('MEASURE_CARRYOVER') from error
        marker = receipt.get('marker') if isinstance(receipt, dict) else None
        expected_samples = samples[:105] if index == 1 else samples[105 + (index - 2) * 6:105 + (index - 1) * 6]
        if not isinstance(receipt, dict) \
                or set(receipt) != {'outcome', 'resourcesClosed', 'samples', 'marker', 'sqliteSha256', 'retained'} \
                or receipt.get('outcome') != 'ok' or receipt.get('resourcesClosed') is not True \
                or receipt.get('retained') is not False or receipt.get('samples') != expected_samples \
                or not isinstance(marker, dict) or set(marker) != {'id', 'scope', 'label'} \
                or not _uuid4(marker.get('id')) or marker['id'] in marker_ids \
                or marker.get('scope') != 'musicbridge-capacity-clone-only' \
                or marker.get('label') != f'sample-{index}' \
                or _SHA256.fullmatch(str(receipt.get('sqliteSha256', ''))) is None \
                or identity['sha256'] != expected_receipt_sha[index - 1]:
            raise ValueError('MEASURE_CARRYOVER')
        marker_ids.add(marker['id']); receipt_samples.extend(receipt['samples'])
        receipt_inventory.append({'name': name, 'size': identity['size'], 'sha256': identity['sha256']})
    manifest_sha256 = hashlib.sha256(json.dumps(receipt_inventory, sort_keys=True,
                                                separators=(',', ':')).encode()).hexdigest()
    if receipt_samples != samples or manifest_sha256 != evidence.get('receiptManifestSha256'):
        raise ValueError('MEASURE_CARRYOVER')

    retained = output / 'sample-30'
    try:
        retained_info = retained.lstat()
        if retained.is_symlink() or retained.resolve(strict=True) != retained \
                or not stat.S_ISDIR(retained_info.st_mode):
            raise ValueError('MEASURE_CARRYOVER')
        if {item.name for item in retained.iterdir()} != {'owner.json', 'sample.sqlite',
                                                          'sample.sqlite-wal', 'sample.sqlite-shm'}:
            raise ValueError('MEASURE_CARRYOVER')
        sqlite_before = _legacy_stable_lstat(retained / 'sample.sqlite', sqlite_bytes)
        owner, owner_identity = _strict_json(retained / 'owner.json')
        wal_identity = _strict_identity(retained / 'sample.sqlite-wal', 1024 * 1024)
        shm_identity = _strict_identity(retained / 'sample.sqlite-shm', 1024 * 1024)
    except (OSError, ValueError) as error:
        raise ValueError('MEASURE_CARRYOVER') from error
    if owner != evidence.get('retainedOwner') or owner_identity['sha256'] != evidence.get('retainedOwnerSha256'):
        raise ValueError('MEASURE_CARRYOVER')
    for identity, key in ((wal_identity, 'wal'), (shm_identity, 'shm')):
        expected = evidence.get(key)
        if not isinstance(expected, dict) or set(expected) != {'size', 'sha256'} \
                or identity['size'] != expected.get('size') or identity['sha256'] != expected.get('sha256'):
            raise ValueError('MEASURE_CARRYOVER')
    _legacy_same_lstat(retained / 'sample.sqlite', sqlite_before)

    roots = [_carryover_root_identity(window_path.parent, 'owner.json'),
             _carryover_root_identity(output, 'command.json')]
    _legacy_same_lstat(retained / 'sample.sqlite', sqlite_before)
    metric_counts = {'progress': 105, **{metric: 28 for metric in _STOP_METRICS}}
    return {
        'valid': True,
        'terminal': {'windowId': expected_window_id, 'label': expected_label, 'state': 'failed',
                     'failure': 'EXECUTION_TIMEOUT', 'windowSha256': expected_window_sha256,
                     'closeSha256': expected_close_sha256, 'groupEmpty': True, 'zombies': [],
                     'authorityStable': True, 'replayAllowed': False},
        'partial': {'format': evidence['format'], 'outputDirectory': str(output),
                    'commandSha256': expected_command_sha256,
                    'partialExists': True, 'partialPreserved': True, 'verifiedPassed': False,
                    'sampleCount': 273, 'receiptCount': 29,
                    'samplesSha256': identities['samples.jsonl']['sha256'],
                    'samplesMatchReceipts': True, 'receiptManifestSha256': manifest_sha256,
                    'receiptNames': receipt_names, 'metricCounts': metric_counts,
                    'retainedDirectories': ['sample-30'],
                    'retainedClone': {
                        'directoryName': 'sample-30', 'ownerSha256': owner_identity['sha256'],
                        'sqlite': {'size': sqlite_before.st_size, 'nlink': sqlite_before.st_nlink,
                                   'contentSha256Verified': False,
                                   'verification': 'stable-lstat-size-only-no-content-read'},
                        'wal': {'size': wal_identity['size'], 'sha256': wal_identity['sha256']},
                        'shm': {'size': shm_identity['size'], 'sha256': shm_identity['sha256']}},
                    'unexpectedEntries': []},
        'roots': roots}


def _measure_metric_stats(formal):
    values = sorted(row['durationMs'] for row in formal if row['outcome'] == 'ok')
    rank = lambda numerator: values[(len(values) * numerator + 99) // 100 - 1] if values else None
    return {'attempts': len(formal), 'successes': len(values),
            'failures': sum(row['outcome'] == 'failed' for row in formal),
            'timeouts': sum(row['outcome'] == 'timeout' for row in formal),
            'p50': rank(50), 'p95': rank(95), 'p99': rank(99) if len(values) >= 100 else None,
            'max': values[-1] if values else None, 'complete': len(values) == len(formal)}


def _safe_tree_relative(value):
    if not isinstance(value, str) or len(value) > 4096 or '\x00' in value or '\\' in value:
        return False
    if value == '': return True
    return not value.startswith('/') and not value.endswith('/') \
        and all(part not in ('', '.', '..') for part in value.split('/'))


def _js_number(value):
    if type(value) is int:
        if abs(value) > 2 ** 53 - 1: raise ValueError('JS_NUMBER')
        return str(value)
    if type(value) is not float or not math.isfinite(value): raise ValueError('JS_NUMBER')
    if value == 0: return '0'
    # Python repr 与 ECMAScript Number::toString 都以最短 round-trip 十进制为基础；
    # 这里补齐两者对 fixed/scientific 阈值及 exponent 前导零的格式差异。
    raw = repr(value).lower(); decimal_value = decimal.Decimal(raw); magnitude = abs(value)
    if 1e-6 <= magnitude < 1e21:
        fixed = format(decimal_value, 'f')
        if '.' in fixed: fixed = fixed.rstrip('0').rstrip('.')
        return fixed
    coefficient, exponent = format(decimal_value.normalize(), 'e').lower().split('e')
    coefficient = coefficient.rstrip('0').rstrip('.')
    exponent_value = int(exponent)
    return f'{coefficient}e{"+" if exponent_value >= 0 else ""}{exponent_value}'


def _js_compact_json(value):
    if value is None: return 'null'
    if value is True: return 'true'
    if value is False: return 'false'
    if type(value) in (int, float): return _js_number(value)
    if isinstance(value, str): return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, list): return '[' + ','.join(_js_compact_json(item) for item in value) + ']'
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return '{' + ','.join(
            f'{json.dumps(key, ensure_ascii=False)}:{_js_compact_json(item)}'
            for key, item in value.items()) + '}'
    raise ValueError('JS_JSON')


def _tree_entries_sha256(entries):
    try:
        digest = hashlib.sha256()
        for entry in entries: digest.update(_js_compact_json(entry).encode('utf-8'))
        return digest.hexdigest()
    except (UnicodeEncodeError, ValueError):
        return None


def _validate_tree_entries(entries, database_content_excluded):
    if not isinstance(entries, list) or not 1 <= len(entries) <= 4096:
        return None
    seen = set(); directories = set(); file_count = 0; directory_count = 0; file_bytes = 0
    database_files = []
    exact_keys = {'relative', 'type', 'device', 'inode', 'mode', 'size', 'mtimeMs', 'ctimeMs',
                  'contentSha256', 'contentSha256Verified'}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or set(entry) != exact_keys:
            return None
        relative = entry.get('relative'); kind = entry.get('type')
        if not _safe_tree_relative(relative) or relative in seen or kind not in {'directory', 'file'}:
            return None
        if index == 0 and (relative != '' or kind != 'directory') or index > 0 and relative == '':
            return None
        parent = relative.rpartition('/')[0] if relative else None
        if parent is not None and parent not in directories:
            return None
        for key in ('device', 'inode', 'mode', 'size'):
            if type(entry.get(key)) is not int or not 0 <= entry[key] <= 2 ** 53 - 1:
                return None
        for key in ('mtimeMs', 'ctimeMs'):
            if type(entry.get(key)) not in (int, float) or not math.isfinite(entry[key]) or entry[key] < 0:
                return None
        database = kind == 'file' and re.search(
            r'(?:\.sqlite(?:-(?:wal|shm|journal))?|\.db(?:-(?:wal|shm|journal))?)$', relative) is not None
        verified = entry.get('contentSha256Verified'); content_sha = entry.get('contentSha256')
        if kind == 'directory':
            if verified is not False or content_sha is not None:
                return None
            directories.add(relative); directory_count += 1
        else:
            expected_verified = not (database_content_excluded and database)
            if verified is not expected_verified \
                    or expected_verified and _SHA256.fullmatch(str(content_sha or '')) is None \
                    or not expected_verified and content_sha is not None:
                return None
            if database_content_excluded and database: database_files.append(relative)
            file_count += 1; file_bytes += entry['size']
            if file_bytes > 2 ** 53 - 1: return None
        seen.add(relative)
    tree_sha256 = _tree_entries_sha256(entries)
    if tree_sha256 is None: return None
    return {'directories': directory_count, 'files': file_count, 'bytes': file_bytes,
            'databaseFiles': database_files, 'paths': seen, 'treeSha256': tree_sha256}


def _validate_fixture_tree(value, expected_root=None):
    exact_keys = {'scope', 'root', 'entries', 'treeSha256', 'databaseContentSha256Verified',
                  'excludedDatabaseFiles'}
    if not isinstance(value, dict) or set(value) != exact_keys \
            or value.get('scope') != 'musicbridge-capacity-fixture-tree' \
            or value.get('databaseContentSha256Verified') is not False \
            or _SHA256.fullmatch(str(value.get('treeSha256', ''))) is None:
        return False
    root = value.get('root')
    if not isinstance(root, str) or len(root) > 4096 or '\x00' in root or not os.path.isabs(root) \
            or os.path.normpath(root) != root or expected_root is not None and root != expected_root:
        return False
    counts = _validate_tree_entries(value.get('entries'), True)
    return counts is not None and value['treeSha256'] == counts['treeSha256'] \
        and bool(counts['databaseFiles']) \
        and value.get('excludedDatabaseFiles') == counts['databaseFiles']


def _validate_workspace_tree(value):
    exact_keys = {'marker', 'directories', 'files', 'bytes', 'treeSha256', 'entries'}
    if not isinstance(value, dict) or set(value) != exact_keys \
            or _SHA256.fullmatch(str(value.get('treeSha256', ''))) is None:
        return False
    marker = value.get('marker')
    if not isinstance(marker, dict) or set(marker) != {'id', 'scope'} or not _uuid4(marker.get('id')) \
            or marker.get('scope') != 'musicbridge-capacity-stop-workspace':
        return False
    counts = _validate_tree_entries(value.get('entries'), False)
    if counts is None or any(type(value.get(key)) is not int for key in ('directories', 'files', 'bytes')):
        return False
    return value['treeSha256'] == counts['treeSha256'] \
        and value['directories'] == counts['directories'] and value['files'] == counts['files'] \
        and value['bytes'] == counts['bytes'] \
        and {'', 'owner.json', 'source', 'execution', 'archive', 'source/fixture.wav'} <= counts['paths']


def _retained_workspace_identity(workspace):
    try:
        root_info = workspace.lstat()
        if workspace.is_symlink() or not stat.S_ISDIR(root_info.st_mode) \
                or workspace.resolve(strict=True) != workspace:
            return None
        entry_count = 0; total_bytes = 0
        pending = [workspace]
        while pending:
            directory = pending.pop()
            for item in directory.iterdir():
                entry_count += 1
                if entry_count > 4096: return None
                relative = item.relative_to(workspace).as_posix()
                if not _safe_tree_relative(relative): return None
                info = item.lstat()
                if stat.S_ISDIR(info.st_mode) and not item.is_symlink():
                    if item.resolve(strict=True) != item: return None
                    pending.append(item)
                elif stat.S_ISREG(info.st_mode) and not item.is_symlink() and info.st_nlink == 1:
                    total_bytes += info.st_size
                    if total_bytes > 2 ** 53 - 1: return None
                else: return None
        return {'device': root_info.st_dev, 'inode': root_info.st_ino,
                'entryCount': entry_count, 'bytes': total_bytes}
    except OSError:
        return None


def _measure_artifacts(runtime, label, expected=None):
    if _SAFE.fullmatch(label) is None: raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    runtime = Path(runtime).resolve(strict=True); output = runtime / label
    output_exists = output.is_dir() and not output.is_symlink() and output.resolve() == output
    files = {name: _file_inventory(output / name) for name in _MEASURE_REQUIRED_FILES}
    entries = sorted(item.name for item in output.iterdir()) if output_exists else []
    group_receipt_names = [f'group-{group}.receipt.json' for group in _MEASURE_GROUPS
                           if _ordinary_file(output / f'group-{group}.receipt.json')]
    round_receipt_names = [name for name in entries
                           if re.fullmatch(r'group-stop\.round-(?:00[1-9]|0[1-9][0-9]|10[0-5])\.receipt\.json', name)
                           and _ordinary_file(output / name)]
    round_receipt_names.sort(key=lambda name: int(re.search(r'round-(\d{3})', name).group(1)))
    workspace_receipt_names = [_STOP_WORKSPACE_RECEIPT] \
        if _ordinary_file(output / _STOP_WORKSPACE_RECEIPT) else []
    retained_names = [f'group-{group}' for group in _MEASURE_GROUPS
                      if (output / f'group-{group}').is_dir() and not (output / f'group-{group}').is_symlink()]
    allowed = set(_MEASURE_REQUIRED_FILES) | set(group_receipt_names) | set(round_receipt_names) \
        | set(workspace_receipt_names) | set(retained_names)
    unexpected = [name for name in entries if name not in allowed]
    command = _read_json(output / 'command.json') if output_exists else None
    measurement = _read_json(output / 'measurement.json') if output_exists else None
    before = _read_json(output / 'source-before.json') if output_exists else None
    after = _read_json(output / 'source-after.json') if output_exists else None
    summary = _read_json(output / 'summary.json') if output_exists else None
    end_budget = _read_json(output / 'end-budget.json') if output_exists else None
    exit_receipt = _read_json(output / 'exit.json') if output_exists else None
    fixture_tree_valid = False; fixture_tree_inventory = []
    try:
        fixture_before, fixture_before_identity = _strict_json(output / 'fixture-before.json')
        fixture_after, fixture_after_identity = _strict_json(output / 'fixture-after.json')
        expected_fixture_root = expected.get('seedFixtureDirectory') if expected is not None else None
        fixture_tree_valid = fixture_before == fixture_after \
            and (expected is None or isinstance(expected_fixture_root, str)) \
            and _validate_fixture_tree(fixture_before, expected_fixture_root)
        fixture_tree_inventory = [
            {'name': 'fixture-before.json', 'identity': fixture_before_identity},
            {'name': 'fixture-after.json', 'identity': fixture_after_identity}]
    except (OSError, ValueError):
        fixture_tree_valid = False
    samples = []
    samples_valid = False; samples_well_formed = False
    if files['samples.jsonl']['exists']:
        try:
            with open(output / 'samples.jsonl', encoding='utf-8') as stream:
                samples = [json.loads(line) for line in stream if line.strip()]
            samples_well_formed = all(
                isinstance(row, dict) and row.get('metric') in _MEASURE_METRICS
                and row.get('outcome') in {'ok', 'failed', 'timeout'}
                and type(row.get('durationMs')) in (int, float) and math.isfinite(row['durationMs'])
                and row.get('durationMs') >= 0 and isinstance(row.get('warmup'), bool)
                for row in samples)
            samples_valid = len(samples) == 1575 and samples_well_formed
            if samples_valid:
                for metric in _MEASURE_METRICS:
                    rows = [row for row in samples if row['metric'] == metric]
                    samples_valid = samples_valid and len(rows) == 105 \
                        and sum(row['warmup'] is True for row in rows) == 5 \
                        and sum(row['warmup'] is False for row in rows) == 100
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            samples_valid = False
    receipts_valid = len(group_receipt_names) == 3
    receipt_inventory = []; retained_inventory = []; receipt_samples = []; group_markers = {}
    if group_receipt_names:
        for group in _MEASURE_GROUPS:
            name = f'group-{group}.receipt.json'
            if name not in group_receipt_names: receipts_valid = False; continue
            path = output / name
            try: value, identity = _strict_json(path)
            except ValueError: receipts_valid = False; break
            marker = value.get('marker') if isinstance(value, dict) else None
            exact_keys = {'outcome', 'resourcesClosed', 'samples', 'marker', 'sqliteSha256', 'retained',
                          'workspaceReceipt', 'workspaceTreeSha256'}
            workspace_name = value.get('workspaceReceipt') if isinstance(value, dict) else None
            workspace_sha = value.get('workspaceTreeSha256') if isinstance(value, dict) else None
            workspace_fields_valid = workspace_name is None and workspace_sha is None
            if group == 'stop' and workspace_name == _STOP_WORKSPACE_RECEIPT \
                    and _SHA256.fullmatch(str(workspace_sha or '')) is not None:
                workspace_fields_valid = True
            if group != 'stop' and (workspace_name is not None or workspace_sha is not None):
                workspace_fields_valid = False
            if not isinstance(value, dict) or set(value) != exact_keys or value.get('outcome') not in {'ok', 'failed', 'timeout'} \
                    or value.get('resourcesClosed') is not True or type(value.get('retained')) is not bool \
                    or value['retained'] is not (value['outcome'] != 'ok') or not isinstance(value.get('samples'), list) \
                    or not isinstance(marker, dict) or set(marker) != {'id', 'scope', 'label'} \
                    or not _uuid4(marker.get('id')) or marker.get('scope') != 'musicbridge-capacity-clone-only' \
                    or marker.get('label') != f'group-{group}' \
                    or _SHA256.fullmatch(str(value.get('sqliteSha256', ''))) is None \
                    or not workspace_fields_valid \
                    or group == 'stop' and value['outcome'] == 'ok' and workspace_name != _STOP_WORKSPACE_RECEIPT:
                receipts_valid = False; break
            group_markers[group] = marker
            receipt_samples.extend(value['samples'])
            clone = output / f'group-{group}'
            if value['retained']:
                try:
                    clone_identity = clone.lstat(); canonical = clone.resolve(strict=True)
                    clone_entries = sorted(item.name for item in clone.iterdir())
                    marker_value, marker_identity = _strict_json(clone / 'owner.json')
                    sqlite_identity = _strict_identity(clone / 'sample.sqlite')
                except (OSError, ValueError): receipts_valid = False; break
                allowed_clone_entries = {'owner.json', 'sample.sqlite', 'group-stop-workspace'} \
                    if group == 'stop' else {'owner.json', 'sample.sqlite'}
                retained_workspace = clone / 'group-stop-workspace'
                retained_workspace_identity = _retained_workspace_identity(retained_workspace) \
                    if 'group-stop-workspace' in clone_entries else None
                if clone.is_symlink() or not stat.S_ISDIR(clone_identity.st_mode) or canonical != clone \
                        or set(clone_entries) not in ({'owner.json', 'sample.sqlite'}, allowed_clone_entries) \
                        or 'group-stop-workspace' in clone_entries and retained_workspace_identity is None \
                        or marker_value != marker or sqlite_identity['sha256'] != value['sqliteSha256']:
                    receipts_valid = False; break
                retained_inventory.append({'path': str(clone), 'device': clone_identity.st_dev,
                                           'inode': clone_identity.st_ino, 'marker': marker_identity,
                                           'sqlite': sqlite_identity,
                                           'workspace': retained_workspace_identity})
            elif clone.exists() or clone.is_symlink():
                receipts_valid = False; break
            receipt_inventory.append({'name': name, 'identity': identity, 'outcome': value['outcome'],
                                      'retained': value['retained'], 'sampleCount': len(value['samples']),
                                      'marker': marker, 'sqliteSha256': value['sqliteSha256'],
                                      'workspaceReceipt': workspace_name,
                                      'workspaceTreeSha256': workspace_sha})
        receipts_valid = receipts_valid and receipt_samples == samples \
            and set(retained_names) == {item['marker']['label'] for item in receipt_inventory if item['retained']}

    workspace_receipt_valid = False; workspace_receipt_inventory = None
    if workspace_receipt_names and isinstance(group_markers.get('stop'), dict):
        try:
            workspace_receipt, workspace_identity = _strict_json(output / _STOP_WORKSPACE_RECEIPT)
            exact_keys = {'schemaVersion', 'scope', 'groupMarker', 'workspace', 'recordedAt'}
            try: workspace_recorded = datetime.datetime.fromisoformat(workspace_receipt['recordedAt'])
            except (KeyError, TypeError, ValueError): workspace_recorded = None
            stop_receipt = next((item for item in receipt_inventory if item['marker']['label'] == 'group-stop'), None)
            workspace_value = workspace_receipt.get('workspace') if isinstance(workspace_receipt, dict) else None
            workspace_receipt_valid = isinstance(workspace_receipt, dict) \
                and set(workspace_receipt) == exact_keys and workspace_receipt.get('schemaVersion') == 1 \
                and workspace_receipt.get('scope') == 'musicbridge-capacity-stop-workspace-tree' \
                and workspace_receipt.get('groupMarker') == group_markers['stop'] \
                and workspace_recorded is not None and workspace_recorded.utcoffset() is not None \
                and _validate_workspace_tree(workspace_value) and stop_receipt is not None \
                and stop_receipt['workspaceReceipt'] == _STOP_WORKSPACE_RECEIPT \
                and stop_receipt['workspaceTreeSha256'] == workspace_value['treeSha256']
            workspace_receipt_inventory = {
                'name': _STOP_WORKSPACE_RECEIPT, 'identity': workspace_identity,
                'treeSha256': workspace_value.get('treeSha256') if isinstance(workspace_value, dict) else None}
        except (OSError, ValueError):
            workspace_receipt_valid = False
    if len(group_receipt_names) == 3:
        receipts_valid = receipts_valid and workspace_receipt_valid \
            and not (output / 'group-stop').exists() and not (output / 'group-stop').is_symlink()

    stages = []; stage_evidence_valid = False; partial_stages_valid = False
    if files['measure-stages.jsonl']['exists']:
        try:
            with open(output / 'measure-stages.jsonl', encoding='utf-8') as stream:
                stages = [json.loads(line) for line in stream if line.strip()]
            def valid_stage(row):
                try: recorded = datetime.datetime.fromisoformat(row['recordedAt'])
                except (KeyError, TypeError, ValueError): return False
                return isinstance(row, dict) and set(row) == {
                    'schemaVersion', 'scope', 'group', 'phase', 'recordedAt', 'details'} \
                    and row['schemaVersion'] == 1 and row['scope'] == 'musicbridge-capacity-measure-stage' \
                    and row['group'] in _MEASURE_GROUPS and row['phase'] in _STAGE_PHASES \
                    and recorded.utcoffset() is not None and isinstance(row['details'], dict)
            partial_stages_valid = bool(stages) and all(valid_stage(row) for row in stages)
            expected_stages = [(group, phase) for group in _MEASURE_GROUPS for phase in _STAGE_PHASES]
            stage_evidence_valid = partial_stages_valid \
                and [(row['group'], row['phase']) for row in stages] == expected_stages \
                and stages[9]['details'] == {
                    'requestedRounds': 105, 'completedRounds': 105,
                    'lastReceipt': 'group-stop.round-105.receipt.json'}
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            stages = []; partial_stages_valid = False

    round_receipts_valid = len(round_receipt_names) == _MEASURE_PLAN['stopRoundReceiptCount']
    partial_rounds_valid = bool(round_receipt_names)
    round_inventory = []; round_samples = []; attempt_ids = set(); command_ids = set()
    stop_marker = group_markers.get('stop')
    retained_stop = output / 'group-stop'
    if stop_marker is None and retained_stop.name in retained_names:
        try:
            stop_marker, marker_identity = _strict_json(retained_stop / 'owner.json')
            retained_info = retained_stop.lstat()
            retained_entries = sorted(item.name for item in retained_stop.iterdir())
            allowed_retained = {'owner.json', 'sample.sqlite', 'sample.sqlite-wal',
                                'sample.sqlite-shm', 'sample.sqlite-journal', 'group-stop-workspace'}
            retained_files = [name for name in retained_entries if name != 'group-stop-workspace']
            retained_workspace_identity = _retained_workspace_identity(retained_stop / 'group-stop-workspace') \
                if 'group-stop-workspace' in retained_entries else None
            if retained_stop.resolve(strict=True) != retained_stop or retained_stop.is_symlink() \
                    or not stat.S_ISDIR(retained_info.st_mode) or not {'owner.json', 'sample.sqlite'} <= set(retained_entries) \
                    or not set(retained_entries) <= allowed_retained \
                    or not all(_ordinary_file(retained_stop / name) for name in retained_files) \
                    or 'group-stop-workspace' in retained_entries and retained_workspace_identity is None \
                    or not isinstance(stop_marker, dict) or set(stop_marker) != {'id', 'scope', 'label'} \
                    or not _uuid4(stop_marker.get('id')) \
                    or stop_marker.get('scope') != 'musicbridge-capacity-clone-only' \
                    or stop_marker.get('label') != 'group-stop':
                partial_rounds_valid = False
            else:
                retained_inventory.append({'path': str(retained_stop), 'device': retained_info.st_dev,
                                           'inode': retained_info.st_ino, 'marker': marker_identity,
                                           'workspace': retained_workspace_identity})
        except (OSError, ValueError):
            partial_rounds_valid = False
    for expected_index, name in enumerate(round_receipt_names, 1):
        try: value, identity = _strict_json(output / name)
        except ValueError: partial_rounds_valid = False; round_receipts_valid = False; break
        exact_keys = {'schemaVersion', 'scope', 'group', 'groupMarker', 'roundIndex', 'attemptId',
                      'commandId', 'inProgressBefore', 'inProgressAfter', 'attemptStatus',
                      'attemptReason', 'coordinatorClosed', 'repositoryOpen', 'samples',
                      'sampleCount', 'recordedAt'}
        try: recorded = datetime.datetime.fromisoformat(value['recordedAt'])
        except (KeyError, TypeError, ValueError): recorded = None
        round_rows = value.get('samples') if isinstance(value, dict) else None
        valid = isinstance(value, dict) and set(value) == exact_keys \
            and value.get('schemaVersion') == 1 and value.get('scope') == 'musicbridge-capacity-measure-stop-round' \
            and value.get('group') == 'stop' and value.get('groupMarker') == stop_marker \
            and value.get('roundIndex') == expected_index and _uuid4(value.get('attemptId')) \
            and _uuid4(value.get('commandId')) and value.get('attemptId') not in attempt_ids \
            and value.get('commandId') not in command_ids and value.get('inProgressBefore') == 0 \
            and value.get('inProgressAfter') == 0 and value.get('attemptStatus') == 'aborted' \
            and value.get('attemptReason') == 'user-stop' and value.get('coordinatorClosed') is True \
            and value.get('repositoryOpen') is True and value.get('sampleCount') == 6 \
            and isinstance(round_rows, list) and len(round_rows) == 6 \
            and [row.get('metric') for row in round_rows if isinstance(row, dict)] == list(_STOP_METRICS) \
            and len({row.get('metric') for row in round_rows if isinstance(row, dict)}) == 6 \
            and recorded is not None and recorded.utcoffset() is not None
        if not valid:
            partial_rounds_valid = False; round_receipts_valid = False; break
        attempt_ids.add(value['attemptId']); command_ids.add(value['commandId']); round_samples.extend(round_rows)
        round_inventory.append({'name': name, 'identity': identity, 'roundIndex': expected_index,
                                'attemptId': value['attemptId'], 'commandId': value['commandId']})
    expected_stop_samples = samples[105:105 + len(round_receipt_names) * 6]
    partial_rounds_valid = partial_rounds_valid and round_samples == expected_stop_samples \
        and len(round_receipt_names) < _MEASURE_PLAN['stopRoundReceiptCount']
    round_receipts_valid = round_receipts_valid and round_samples == samples[105:735]
    expected_partial_stages = [(group, phase) for group in ('progress',) for phase in _STAGE_PHASES] \
        + [('stop', phase) for phase in _STAGE_PHASES[:4]]
    partial_stages_valid = partial_stages_valid \
        and [(row['group'], row['phase']) for row in stages] == expected_partial_stages \
        and stages[9]['details'] == {
            'requestedRounds': 105, 'completedRounds': len(round_receipt_names),
            'lastReceipt': f'group-stop.round-{len(round_receipt_names):03d}.receipt.json'}
    partial_evidence_valid = output_exists and not receipts_valid and len(group_receipt_names) == 1 \
        and group_receipt_names == ['group-progress.receipt.json'] and retained_names == ['group-stop'] \
        and 0 < len(round_receipt_names) < _MEASURE_PLAN['stopRoundReceiptCount'] \
        and samples_well_formed and len(samples) == 105 + 6 * len(round_receipt_names) \
        and all(row.get('metric') == 'progress' for row in samples[:105]) \
        and sum(row.get('warmup') is True for row in samples[:105]) == 5 \
        and samples == receipt_samples + round_samples and partial_rounds_valid and partial_stages_valid
    raw_metrics = None; raw_verdict = None
    if samples_valid:
        raw_metrics = {}
        for metric in _MEASURE_METRICS:
            formal = [row for row in samples if row['metric'] == metric and row['warmup'] is False]
            raw_metrics[metric] = _measure_metric_stats(formal)
        raw_verdict = {}
        for metric, limit in _MEASURE_THRESHOLDS.items():
            stats = raw_metrics[metric]
            raw_verdict[metric] = stats['complete'] and stats['max'] is not None and stats['max'] <= limit['max'] \
                and ('p95' not in limit or stats['p95'] is not None and stats['p95'] <= limit['p95'])
    command_matches = False; measurement_matches = False; summary_complete = False; threshold_passed = False
    authority = None; authority_stable = False; authority_error = None
    if expected is not None and isinstance(command, dict):
        wanted_args = [str(expected['entry']), '--phase', 'measure', '--profile', expected['profile'],
                       '--label', expected['label'], '--seed-label', expected['seedLabel'], '--window', expected['window'],
                       '--runtime-root', str(expected['runtime'])]
        expected_cwd = str(expected['root'])
        command_matches = command.get('executable') == expected['node'] and command.get('args') == wanted_args \
            and command.get('cwd') in {expected_cwd, expected_cwd + os.sep} and command.get('node') == 'v22.23.2' \
            and command.get('phase') == 'measure' and command.get('profile') == expected['profile'] \
            and command.get('window') == expected['window']
    if expected is not None and isinstance(measurement, dict):
        measurement_matches = measurement == {
            'seedLabel': expected['seedLabel'], 'seedSha256': expected['seedSnapshotSha256'],
            'profile': expected['profile'], 'window': expected['window'],
            'classification': 'software-only/exclusive-window',
            'cache': '新DatabaseSync实例，OS页缓存未清理；不是物理冷盘。此入口不测新Node进程或UI ready。',
            'measurePlan': _MEASURE_PLAN,
            'excluded': ['真实设备无声', '新进程冷启', '完整恢复50s',
                         '真实Print领取/写入', '父IPC排队Stop']}
    if isinstance(summary, dict):
        metrics = summary.get('metrics'); verdict = summary.get('verdict')
        verdict_complete = isinstance(verdict, dict) and verdict == raw_verdict
        summary_complete = summary.get('fullR023Passed') is False \
            and isinstance(metrics, dict) and metrics == raw_metrics \
            and verdict_complete and summary.get('limits') == _MEASURE_THRESHOLDS
        if summary_complete:
            formal_threshold_passed = all(verdict.values())
            summary_complete = summary.get('allMeasuredPassed') is formal_threshold_passed
            threshold_passed = formal_threshold_passed and all(row['outcome'] == 'ok' for row in samples)
    if expected is not None and callable(expected.get('authorityProbe')):
        try:
            observed = expected['authorityProbe']()
            authority = {key: value for key, value in observed.items() if key != '_snapshot'}
            authority_stable = authority.get('authorityStable') is True and authority.get('sourcePinsValid') is True \
                and authority.get('ownedRootsValid') is True and authority.get('spaceValid') is True \
                and authority.get('seedValid') is True
        except ValueError as error: authority_error = str(error)
    all_required = all(value['exists'] and value['size'] > 0 and value['sha256'] for value in files.values())
    end_budget_matches = expected is not None and end_budget == expected.get('seedBudget')
    exit_valid = exit_receipt in ({'exit': 0}, {'exit': 1})
    exit_consistent = exit_receipt == {'exit': 0 if threshold_passed else 1}
    verified_complete = expected is not None and output_exists and all_required and not unexpected \
        and samples_valid and receipts_valid and workspace_receipt_valid and fixture_tree_valid \
        and round_receipts_valid and stage_evidence_valid \
        and command_matches and measurement_matches and summary_complete \
        and exit_valid and end_budget_matches and before is not None and before == after and authority_stable
    verified = verified_complete and threshold_passed and exit_consistent
    return {
        'profile': expected['profile'] if expected is not None else None,
        'label': expected['label'] if expected is not None else label,
        'seedLabel': expected['seedLabel'] if expected is not None else None,
        'window': expected['window'] if expected is not None else None,
        'windowSha256': expected.get('windowSha256') if expected is not None else None,
        'ownedManifestSha256': expected.get('ownedManifestSha256') if expected is not None else None,
        'sourceManifestSha256': expected.get('sourceManifestSha256') if expected is not None else None,
        'outputDirectory': str(output), 'outputDirectoryExists': output_exists,
        'partialExists': output_exists and not verified_complete, 'partialPreserved': True,
        'files': files, 'unexpectedEntries': unexpected, 'sampleCount': len(samples),
        'measurePlan': dict(_MEASURE_PLAN),
        'samplesValid': samples_valid, 'receiptCount': len(group_receipt_names), 'receiptsValid': receipts_valid,
        'workspaceReceiptValid': workspace_receipt_valid,
        'workspaceReceiptInventory': workspace_receipt_inventory,
        'fixtureTreeValid': fixture_tree_valid, 'fixtureTreeInventory': fixture_tree_inventory,
        'roundReceiptCount': len(round_receipt_names), 'roundReceiptsValid': round_receipts_valid,
        'roundReceiptInventory': round_inventory, 'stageEvidenceValid': stage_evidence_valid,
        'stageCount': len(stages), 'partialEvidenceValid': partial_evidence_valid,
        'receiptInventory': receipt_inventory, 'retainedInventory': retained_inventory,
        'exitZero': exit_receipt == {'exit': 0}, 'sourceBeforeEqualsAfter': before is not None and before == after,
        'childExitMatchesThreshold': exit_consistent,
        'endBudgetMatchesSeed': end_budget_matches,
        'commandMatchesWindow': command_matches, 'measurementMatchesWindow': measurement_matches,
        'summaryComplete': summary_complete, 'thresholdPassed': threshold_passed,
        'authorityStable': authority_stable, 'authority': authority, 'authorityError': authority_error,
        'verifiedComplete': verified_complete, 'verifiedPassed': verified}


def _generation_times(window):
    try:
        issued = datetime.datetime.fromisoformat(window['issuedAt'])
        deadline = datetime.datetime.fromisoformat(window['deadlineAt'])
    except (KeyError, TypeError, ValueError):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    if issued.utcoffset() is None or deadline.utcoffset() is None:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    if deadline - issued != datetime.timedelta(seconds=1200):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    return issued.timestamp(), deadline.timestamp()


def _validate_generation_window(window, now):
    required = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-generation-window',
                'owner': 'root', 'state': 'approved', 'phase': 'generate'}
    if set(window) != _GENERATION_KEYS or any(window.get(key) != value for key, value in required.items()):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    if window.get('profile') not in _GENERATION_PROFILES:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    if _SAFE.fullmatch(window.get('label', '')) is None or not _uuid4(window.get('id')):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    if type(window.get('n')) is not int or window['n'] != 1:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    if window.get('limits') != _GENERATION_LIMITS:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    for key, name in (('ownedManifest', 'owned-roots.json'), ('sourceManifest', 'source-pins.json')):
        manifest = window.get(key)
        if not isinstance(manifest, dict) or set(manifest) != {'file', 'sha256'} or manifest.get('file') != name \
                or _SHA256.fullmatch(manifest.get('sha256', '')) is None:
            raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    issued, deadline = _generation_times(window)
    # 正式generation window从签发到终止必须精确为1200秒；不接受近似或可调期限。
    if deadline <= now or issued > now + 1:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    return issued, deadline


def _load_window(argv):
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument('--window', required=True)
    parser.add_argument('--window-sha256', required=True)
    options = parser.parse_args(argv)
    supplied_path = Path(options.window)
    try: window_path = supplied_path.resolve(strict=True)
    except OSError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    script = Path(__file__).resolve(strict=True)
    runtime = window_path.parent.parent
    if not supplied_path.is_absolute() or supplied_path != window_path or window_path.name != 'window.json' \
            or script.parent != window_path.parent or _SHA256.fullmatch(options.window_sha256 or '') is None:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    try: window, window_identity = _strict_json(window_path)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    if window_identity['sha256'] != options.window_sha256: raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    if isinstance(window, dict) and window.get('scope') == 'musicbridge-capacity-measure-window':
        _validate_supervisor_identity(window)
        try: _validate_candidate_repository(window, runtime)
        except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    parent = window_path.parent
    owner_path = parent / 'owner.json'
    try: owner, _ = _strict_json(owner_path)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    if owner != {'scope': window.get('scope'), 'owner': 'root', 'id': window.get('id')}:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    return runtime, parent, window, window_identity


def _require_loaded_window_identity(parent, loaded_identity):
    try: current = _strict_identity(Path(parent) / 'window.json')
    except ValueError as error: raise ValueError('AUTHORITY_DRIFT') from error
    if current != loaded_identity: raise ValueError('AUTHORITY_DRIFT')
    return True


def _reject_measure_replay(runtime, parent, window):
    runtime = Path(runtime).resolve(strict=True); parent = Path(parent).resolve(strict=True)
    for candidate in runtime.iterdir():
        if candidate == parent or not candidate.is_dir() or candidate.is_symlink(): continue
        value = _read_json(candidate / 'window.json')
        if isinstance(value, dict) and value.get('scope') == 'musicbridge-capacity-measure-window' \
                and (value.get('id') == window.get('id') or value.get('label') == window.get('label')):
            raise ValueError('REPLAY')
    current_labels = {window.get('label'), parent.name}
    candidates = [path for path in runtime.iterdir()
                  if path.is_file() and not path.is_symlink() and path.name.endswith('-close.json')]
    candidates.extend(path / 'close.json' for path in runtime.iterdir()
                      if path.is_dir() and not path.is_symlink() and path != parent)
    for close_path in candidates:
        value = _read_json(close_path)
        if isinstance(value, dict) and value.get('scope') == 'musicbridge-capacity-measure-window-close' \
                and (value.get('windowId') == window.get('id')
                     or value.get('label') in current_labels or value.get('windowLabel') in current_labels):
            raise ValueError('REPLAY')
    return True


def _main_generation(argv):
    runtime, parent, window, _ = _load_window(argv)
    _, deadline = _validate_generation_window(window, time.time())
    root = _runtime_repo_root()
    try: authority_initial = _validate_generation_authority(parent, runtime, root, _sha(parent / 'window.json'), window['profile'])
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    generation_output = runtime / window['label']
    if generation_output.exists() or generation_output.is_symlink() or (parent / 'supervision').exists():
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    node = Path('/Users/yihe/.nvm/versions/node/v22.23.2/bin/node')
    entry = root / 'packages/bridge-core/test/benchmarks/recording-capacity.ts'
    command = [str(node), '--import', 'tsx', str(entry), '--phase', 'generate',
               '--profile', window['profile'], '--label', window['label'], '--window', window['id']]
    # 父监督器与受控Node必须使用同一规范临时根，否则checkpoint中的fixture在终态无法复核。
    environment = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC', 'CI': '1',
                   'TMPDIR': str(Path(tempfile.gettempdir()).resolve(strict=True))}
    expected = {'profile': window['profile'], 'label': window['label'], 'window': window['id'],
                'node': str(node), 'entry': entry, 'root': root,
                'windowSha256': _sha(parent / 'window.json'),
                'ownedManifestSha256': window['ownedManifest']['sha256'],
                'sourceManifestSha256': window['sourceManifest']['sha256'],
                'authorityProbe': lambda: _validate_generation_authority(
                    parent, runtime, root, _sha(parent / 'window.json'), window['profile'], authority_initial)}
    result = supervise(command, time.monotonic() + (deadline - time.time()), parent / 'supervision',
                       grace=window['limits']['killGraceMs'] / 1000,
                       close_budget=window['limits']['closeMs'] / 1000,
                       artifact_probe=lambda: _generation_artifacts(runtime, window['label'], expected),
                       cwd=root, environment=environment, capture_output=True, stdin=subprocess.DEVNULL)
    return 0 if result['passed'] else 1


def _measurement_identity_closure(value):
    if not isinstance(value, dict): return None
    keys = ('files', 'receiptInventory', 'retainedInventory', 'roundReceiptInventory',
            'workspaceReceiptInventory', 'fixtureTreeInventory',
            'unexpectedEntries', 'measurePlan', 'sampleCount', 'receiptCount',
            'roundReceiptCount', 'stageCount', 'samplesValid', 'receiptsValid',
            'workspaceReceiptValid', 'fixtureTreeValid', 'roundReceiptsValid',
            'stageEvidenceValid', 'partialEvidenceValid')
    return {key: value.get(key) for key in keys}


def _write_measure_close(parent, window, result, authority_initial, authority_probe, measurement_probe):
    parent = Path(parent)
    supervisor_path = parent / 'supervision' / 'supervisor.json'
    clean_authority = {key: value for key, value in authority_initial.items() if key != '_snapshot'}
    supervisor_measurement = result.get('measurement')
    try:
        measurement = measurement_probe()
    except Exception as error:
        measurement = {'verifiedComplete': False, 'verifiedPassed': False,
                       'probeError': type(error).__name__}
    identity_stable = _measurement_identity_closure(measurement) \
        == _measurement_identity_closure(supervisor_measurement)
    measurement_aligned = isinstance(measurement, dict) \
        and (result.get('passed') is (measurement.get('verifiedPassed') is True))
    if measurement.get('verifiedComplete') is not True or not identity_stable or not measurement_aligned:
        if result.get('failure') is None: result['failure'] = 'MEASUREMENT_EVIDENCE_FAILED'
        result['passed'] = False
    result['measurement'] = measurement
    try:
        terminal_value = authority_probe()
        authority_terminal = {key: value for key, value in terminal_value.items() if key != '_snapshot'}
    except ValueError as error:
        result['priorFailure'] = result.get('failure')
        result['failure'] = 'AUTHORITY_DRIFT'
        result['passed'] = False
        authority_terminal = {'authorityStable': False, 'error': str(error)}
    value = {
        'schemaVersion': 1, 'scope': 'musicbridge-capacity-measure-window-close',
        'windowId': window['id'], 'profile': window['profile'], 'label': window['label'],
        'seedLabel': window['seedLabel'], 'closedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'state': 'passed' if result.get('passed') is True else 'failed',
        'failure': result.get('failure'), 'pid': result.get('pid'), 'pgid': result.get('pgid'),
        'managedProcessGroup': result.get('managedProcessGroup'), 'code': result.get('code'),
        'exitSignal': result.get('exitSignal'), 'signals': result.get('signals'),
        'groupEmpty': result.get('groupEmpty'), 'zombies': result.get('zombies'),
        'elapsedMs': result.get('elapsedMs'),
        'windowSha256': authority_terminal.get('windowSha256Observed', clean_authority.get('windowSha256Observed')),
        'sourceManifestSha256': window['sourceManifest']['sha256'],
        'ownedManifestSha256': window['ownedManifest']['sha256'], 'seed': window['seed'],
        'authorityAdmission': clean_authority, 'authorityTerminal': authority_terminal,
        'measurement': measurement,
        'supervisorSha256': _sha(supervisor_path) if _ordinary_file(supervisor_path) else None,
        'stdout': result.get('stdout'), 'stderr': result.get('stderr'),
        'deviceOpened': False, 'formalReady': False, 'gateB': 'NOT_RUN',
        'replayPolicy': 'terminal-window-id-and-label-never-reuse'}
    _write(parent / 'close.json', value)
    return value


def _main_measure(argv, loaded=None):
    runtime, parent, window, loaded_identity = loaded if loaded is not None else _load_window(argv)
    _, deadline = _validate_measure_window(window, time.time())
    try: root, entry = _measure_execution_target(window, runtime)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    try: _require_loaded_window_identity(parent, loaded_identity)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    window_sha = loaded_identity['sha256']
    try: _reject_measure_replay(runtime, parent, window)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    try: authority_initial = _validate_measure_authority(parent, runtime, root, window_sha)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    def terminal_authority():
        try: _validate_supervisor_identity(window)
        except SystemExit as error: raise ValueError('SUPERVISOR_DRIFT') from error
        _reject_measure_replay(runtime, parent, window)
        return _validate_measure_authority(parent, runtime, root, window_sha, authority_initial)
    measure_output = runtime / window['label']
    if measure_output.exists() or measure_output.is_symlink() or (parent / 'supervision').exists() \
            or (parent / 'close.json').exists() or (parent / 'close.json').is_symlink():
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    node = Path('/Users/yihe/.nvm/versions/node/v22.23.2/bin/node')
    command = [str(node), '--import', 'tsx', str(entry), '--phase', 'measure',
               '--profile', window['profile'], '--label', window['label'],
               '--seed-label', window['seedLabel'], '--window', window['id'],
               '--runtime-root', str(runtime)]
    environment = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC', 'CI': '1',
                   'TMPDIR': str(Path(tempfile.gettempdir()).resolve(strict=True))}
    expected = {'profile': window['profile'], 'label': window['label'], 'seedLabel': window['seedLabel'],
                'window': window['id'], 'node': str(node), 'entry': entry, 'root': root,
                'runtime': runtime,
                'windowSha256': window_sha, 'ownedManifestSha256': window['ownedManifest']['sha256'],
                'sourceManifestSha256': window['sourceManifest']['sha256'],
                'seedBudget': authority_initial.get('seedBudget'),
                'seedSnapshotSha256': window['seed']['snapshotSha256'],
                'seedFixtureDirectory': authority_initial.get('_snapshot', {}).get('seedFixture', {}).get('path'),
                'authorityProbe': terminal_authority}
    result = supervise(command, time.monotonic() + (deadline - time.time()), parent / 'supervision',
                       grace=window['limits']['killGraceMs'] / 1000,
                       close_budget=window['limits']['closeMs'] / 1000,
                       artifact_probe=lambda: _measure_artifacts(runtime, window['label'], expected),
                       cwd=root, environment=environment, capture_output=True, stdin=subprocess.DEVNULL,
                       artifact_name='measurement', artifact_failure='MEASUREMENT_EVIDENCE_FAILED')
    _write_measure_close(
        parent, window, result, authority_initial, authority_probe=terminal_authority,
        measurement_probe=lambda: _measure_artifacts(runtime, window['label'], expected))
    return 0 if result.get('passed') is True else 1


def _main_phase(argv):
    if '--' not in argv: raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    split = argv.index('--')
    runtime, parent, window, _ = _load_window(argv[:split])
    required = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-phase-window', 'owner': 'root', 'state': 'approved'}
    if any(window.get(key) != value for key, value in required.items()): raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    issued_value = datetime.datetime.fromisoformat(window['issuedAt'])
    deadline_value = datetime.datetime.fromisoformat(window['deadlineAt'])
    if issued_value.utcoffset() is None or deadline_value.utcoffset() is None: raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    issued = issued_value.timestamp()
    deadline = deadline_value.timestamp()
    if deadline <= time.time() or deadline - issued > 900 or issued > time.time() + 1: raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    root = _runtime_repo_root()
    node = Path('/Users/yihe/.nvm/versions/node/v22.23.2/bin/node')
    entry = root / 'packages/bridge-core/test/benchmarks/recording-capacity-process.ts'
    phase_args = argv[split + 1:]
    command = [str(node), '--import', 'tsx', str(entry), *phase_args]
    result = supervise(command, time.monotonic() + (deadline - time.time()), parent / 'supervision')
    return 0 if result['passed'] else 1


def main(argv):
    if '--' in argv: return _main_phase(argv)
    loaded = _load_window(argv); _, _, window, _ = loaded
    if window.get('scope') == 'musicbridge-capacity-measure-window': return _main_measure(argv, loaded=loaded)
    return _main_generation(argv)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
