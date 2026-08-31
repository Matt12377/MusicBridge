import argparse
import datetime
import decimal
import hashlib
import importlib.util
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


def _lineage_module(repository_root=None):
    path = Path(repository_root) / 'scripts/ci/capacity_process_failure_lineage.py' \
        if repository_root is not None else Path(__file__).resolve().with_name(
            'capacity_process_failure_lineage.py')
    spec = importlib.util.spec_from_file_location('musicbridge_capacity_failure_lineage', path)
    if spec is None or spec.loader is None:
        raise ValueError('LINEAGE_CONTRACT')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evaluate_process_failure_lineage(case, contract):
    return _lineage_module().evaluate_process_failure_lineage(case, contract)


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
_TYPESCRIPT_LIBRARY = re.compile(r'^lib(?:\.[A-Za-z0-9.-]+)?\.d\.ts$', re.ASCII)
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
                           'end-budget.json', 'summary.json', 'exit.json', 'measure-stages.jsonl',
                           'measure-aggregate-budget.jsonl')
_STOP_WORKSPACE_RECEIPT = 'group-stop.workspace.receipt.json'
_MEASURE_GROUPS = ('progress', 'stop', 'read')
_STOP_METRICS = ('signalAborted', 'driverStopInvoked', 'driverStopAck',
                 'driverCloseInvoked', 'driverCloseResolved', 'receiptSettled')
_STAGE_PHASES = ('copy', 'open-audit', 'operation', 'round-fsync', 'final-hash', 'cleanup')
_QUEUED_STOP_KEYS = {'schemaVersion', 'scope', 'owner', 'id', 'state', 'phase', 'profile',
                     'label', 'seedLabel', 'seed', 'n', 'issuerFailureCarryoverCount',
                     'prechildFailureCarryoverCount', 'processFailureCarryoverCount',
                     'issuedAt', 'deadlineAt', 'limits',
                     'ownedManifest', 'sourceManifest', 'queuedStopPlan', 'supervisor',
                     'candidateRepository', 'measureCarryover', 'toolchain', 'issuer'}
_JOINT_QUEUED_STOP_KEYS = _QUEUED_STOP_KEYS - {
    'issuerFailureCarryoverCount', 'prechildFailureCarryoverCount', 'processFailureCarryoverCount'}
_QUEUED_STOP_LIMITS = {'executionMs': 50000, 'killGraceMs': 1000, 'closeMs': 2000,
                       'minimumFreeBytes': 10 * 1024 ** 3, 'maximumOwnedBytes': 16 * 1024 ** 3}
_QUEUED_STOP_ALLOWANCE = 256 * 1024 ** 2
_QUEUED_STOP_SNAPSHOT_BYTES = 1_990_471_680
_QUEUED_STOP_AUDIT = 'queued-stop-aggregate-budget.jsonl'
_QUEUED_STOP_MODEL = 'serial-single-clone-plus-bounded-growth-v1'
_QUEUED_STOP_BASE_ROOTS = 73
def _queued_stop_process_failure_stderr(pid):
    return (
        b'CAPACITY_PHASE_OPERATION_FAILED\n'
        + f'(node:{pid}) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n'.encode()
        + b'(Use `node --trace-warnings ...` to show where the warning was created)\n'
    )
_QUEUED_STOP_MEASURE_WINDOW_ID = 'afc81a99-d15d-4179-8326-5774a5c40b62'
_QUEUED_STOP_SEED = {'metadataSha256': '632d8e4b0c01ffec07adc72344e7bcc877e5f1d764e7745af856c6ba44492309',
                     'snapshotSha256': '7ec9b3bed1642503cc9fcee70c6156b54eb43834b0a457050ec51607f2e1ab3a',
                     'fixtureOwnerSha256': '8e885bdee2c2acd6ba6b189f6de6c88bcb5e3a4b84d838a9b56e30987eb716c1'}
_QUEUED_STOP_CARRYOVER = {
    'window': 'cfac8e19336a181de00c68d458d046065cd821a0dca48cc4fc78af0e15c15227',
    'close': '1c93f6c6ec1a0b58619f87127d3e2c7d11a1cfcce1c155b3576a84eda2af84b7',
    'ownedManifest': 'cd6faddd3b205f290e379cec95af9c20a6fbbbbfd2c7989ef07ff2712bc3c4ab',
    'sourceManifest': '71bfb77f9c706ae9d31f580d4067f7ff427ee1099c341f03915d39ab1edff503',
    'supervision': '18ef840fe99b861ca8881c7c7be09b70c13431df02d88ddf282e29f2169cdc92',
    'supervisor': 'aaf871474dfe8129bae76ff8d2f07ed4f9a1200801d9108d005e6bbd1823e743',
    'output': '4a0417df8056764a5ba6a24ffda42d7be590cb4bfbd480b5d7188d8d609b8231'}


def _measure_planned_bytes(snapshot_bytes):
    """三个 measure group 严格串行：峰值只允许一个完整 clone 加固定增长余量。"""
    if type(snapshot_bytes) is not int or snapshot_bytes <= 0:
        raise ValueError('OWNED_SPACE')
    planned = snapshot_bytes + 256 * 1024 ** 2
    if planned > 16 * 1024 ** 3:
        raise ValueError('OWNED_SPACE')
    return planned
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


def _strict_root_marker(path, marker, expected_device, expected_inode, error_code):
    path = Path(path)
    directory_flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    marker_flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        directory_fd = os.open(path, directory_flags)
        try:
            before = os.fstat(directory_fd); named_before = path.lstat()
            marker_fd = os.open(marker['relative'], marker_flags, dir_fd=directory_fd)
            digest = hashlib.sha256()
            try:
                marker_before = os.fstat(marker_fd)
                if not stat.S_ISREG(marker_before.st_mode) or marker_before.st_nlink != 1:
                    raise ValueError(error_code)
                for chunk in iter(lambda: os.read(marker_fd, 1024 * 1024), b''):
                    digest.update(chunk)
                marker_after = os.fstat(marker_fd)
            finally:
                os.close(marker_fd)
            marker_named = os.stat(
                marker['relative'], dir_fd=directory_fd, follow_symlinks=False)
            after = os.fstat(directory_fd); named_after = path.lstat()
        finally:
            os.close(directory_fd)
    except (OSError, TypeError, ValueError) as error:
        raise ValueError(error_code) from error
    directory_fields = ('st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    marker_fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    if not stat.S_ISDIR(before.st_mode) \
            or before.st_dev != expected_device or before.st_ino != expected_inode \
            or any(getattr(before, key) != getattr(after, key)
                   or getattr(after, key) != getattr(named_after, key)
                   or getattr(before, key) != getattr(named_before, key)
                   for key in directory_fields) \
            or not stat.S_ISREG(marker_named.st_mode) \
            or any(getattr(marker_before, key) != getattr(marker_after, key)
                   or getattr(marker_after, key) != getattr(marker_named, key)
                   for key in marker_fields) \
            or digest.hexdigest() != marker['sha256']:
        raise ValueError(error_code)
    return {'path': str(path), 'device': before.st_dev, 'inode': before.st_ino,
            'marker': {'relative': marker['relative'], 'sha256': marker['sha256']}}


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
             'packages/contracts/capacity-process-failure-lineage-v1.json',
             'packages/bridge-core/test/benchmarks/recording-capacity.ts',
             'packages/bridge-core/test/benchmarks/recording-capacity-process.ts',
             'scripts/ci/capacity_process_failure_lineage.py',
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


def _planned_generation_plan(profile):
    if profile != 'joint': raise ValueError('OWNED_SPACE')
    mib = 1024 ** 2
    final_axis_bytes = 64 * mib + 64 * mib + 64 * mib + 512 * mib + 512 * mib
    active_record_workspace_bytes = 16 * mib
    evidence_allowance_bytes = 128 * mib
    return {
        'model': 'serial-single-output-plus-bounded-growth-v1',
        'activeOutputMaximum': 1,
        'finalAxisBytes': final_axis_bytes,
        'activeOutputBytes': final_axis_bytes,
        'activeRecordWorkspaceBytes': active_record_workspace_bytes,
        'evidenceAllowanceBytes': evidence_allowance_bytes,
        'plannedBytes': 2 * final_axis_bytes + active_record_workspace_bytes + evidence_allowance_bytes,
    }


def _joint_generation_plan_valid(value):
    expected = _planned_generation_plan('joint')
    if not isinstance(value, dict) or set(value) != set(expected): return False
    for key, expected_value in expected.items():
        observed = value.get(key)
        if type(expected_value) is int:
            if type(observed) is not int or observed != expected_value: return False
        elif type(observed) is not str or observed != expected_value: return False
    return True


def _joint_axes_valid(value):
    mib = 1024 ** 2
    targets = {
        'attemptEvents': 50_000,
        'attemptBytes': 64 * mib,
        'recordBytes': 64 * mib,
        'printBytes': 64 * mib,
        'photoBytes': 512 * mib,
        'printObjectBytes': 512 * mib,
    }
    if not isinstance(value, dict) or set(value) != {'targets', 'actual', 'reached'}: return False
    observed_targets = value.get('targets'); actual = value.get('actual'); reached = value.get('reached')
    if not isinstance(observed_targets, dict) or set(observed_targets) != set(targets) \
            or any(type(observed_targets[key]) is not int or observed_targets[key] != target
                   for key, target in targets.items()) \
            or not isinstance(actual, dict) or set(actual) != set(targets) \
            or not isinstance(reached, dict) or set(reached) != set(targets):
        return False
    return all(type(actual[key]) is int and actual[key] >= target for key, target in targets.items()) \
        and all(type(reached[key]) is bool and reached[key] is True for key in targets)


def _joint_plan_preparation_valid(value, budget):
    keys = {'strategy', 'prepared', 'beforeFirstAttempt', 'preparedBeforeFirstAttempt',
            'activePlanMaximum', 'unconsumedAtSeal'}
    if not isinstance(value, dict) or set(value) != keys or not isinstance(budget, dict): return False
    records = budget.get('records')
    return type(records) is int and records >= 1 \
        and value.get('strategy') == 'serial-create-consume-one-active' \
        and type(value.get('prepared')) is int and value['prepared'] == records + 1 \
        and type(value.get('beforeFirstAttempt')) is bool and value['beforeFirstAttempt'] is True \
        and type(value.get('preparedBeforeFirstAttempt')) is int and value['preparedBeforeFirstAttempt'] == 1 \
        and type(value.get('activePlanMaximum')) is int and value['activePlanMaximum'] == 1 \
        and type(value.get('unconsumedAtSeal')) is int and value['unconsumedAtSeal'] == 1


def _joint_generation_contract_valid(value):
    return isinstance(value, dict) and _joint_generation_plan_valid(value.get('generationPlan')) \
        and _joint_axes_valid(value.get('axes')) \
        and _joint_plan_preparation_valid(value.get('planPreparation'), value.get('budget'))


def _joint_generation_seed_valid(value):
    return isinstance(value, dict) and type(value.get('schema')) is int and value.get('schema') == 21 \
        and type(value.get('profile')) is str and value.get('profile') == 'joint' \
        and value.get('integrity') == 'passed' and value.get('growth', {}).get('state') == 'target-reached' \
        and _uuid4(value.get('nextPlanId')) and type(value.get('nextPlanHash')) is str \
        and _SHA256.fullmatch(value['nextPlanHash']) is not None \
        and isinstance(value.get('budget'), dict) and isinstance(value.get('fixtureDirectory'), str) \
        and isinstance(value.get('marker'), dict) and set(value['marker']) == {'id', 'scope'} \
        and _uuid4(value['marker'].get('id')) and value['marker'].get('scope') == 'musicbridge-capacity-synthetic-only' \
        and _joint_generation_contract_valid(value)


def _joint_generation_space_valid(value, plan, snapshot_bytes, fixture_bytes,
                                  pre_snapshot_output_bytes, terminal_output_bytes):
    if not isinstance(value, dict) or set(value) != {'availableBytes', 'plannedBytes', 'ownedBytes'} \
            or not _joint_generation_plan_valid(plan) \
            or any(type(item) is not int or item < 0 for item in (
                snapshot_bytes, fixture_bytes, pre_snapshot_output_bytes, terminal_output_bytes)) \
            or snapshot_bytes <= 0 or fixture_bytes <= 0:
        return False
    if any(type(value.get(key)) is not int or value[key] < 0 for key in value): return False
    planned = value['plannedBytes']; owned = value['ownedBytes']; available = value['availableBytes']
    return snapshot_bytes <= fixture_bytes \
        and planned == fixture_bytes + plan['evidenceAllowanceBytes'] \
        and owned == fixture_bytes + pre_snapshot_output_bytes \
        and owned + planned <= plan['plannedBytes'] \
        and owned + planned <= 16 * 1024 ** 3 \
        and fixture_bytes + terminal_output_bytes <= plan['plannedBytes'] \
        and available - planned >= 10 * 1024 ** 3


def _planned_generation_bytes(profile):
    mib = 1024 ** 2; gib = 1024 ** 3
    if profile == 'history-limit': axes, max_records = (int(.9 * 128 * mib + .999999), 0, 0, 0, 0), 1
    elif profile == 'objects-limit': axes, max_records = (0, 0, 0, int(.9 * gib + .999999), int(.9 * gib + .999999)), 220
    elif profile == 'joint': return _planned_generation_plan(profile)['plannedBytes']
    else: raise ValueError('OWNED_SPACE')
    # 与 createCapacitySeed 的写前投影保持同一公式，不能漏掉每条 Record 的工作余量。
    return 3 * sum(axes) + max_records * 16 * mib + 128 * mib


def _validate_owned_manifest(manifest_path, runtime, window_id, profile, planned_bytes=None,
                             future_path=None, future_state=None):
    try: manifest, manifest_identity = _strict_json(manifest_path)
    except ValueError as error: raise ValueError('OWNED_MANIFEST') from error
    manifest_keys = {'schemaVersion', 'scope', 'access', 'windowId', 'roots'}
    if future_path is not None: manifest_keys.add('futureRoots')
    maximum_roots = 70 if future_path is not None else 68
    if not isinstance(manifest, dict) or set(manifest) != manifest_keys \
            or manifest.get('schemaVersion') != 1 or manifest.get('scope') != 'musicbridge-capacity-owned-roots' \
            or manifest.get('access') != 'count-only' or manifest.get('windowId') != window_id \
            or not isinstance(manifest.get('roots'), list) or not 1 <= len(manifest['roots']) <= maximum_roots:
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
        if planned_bytes is not None and value > planned_bytes: raise ValueError('OWNED_SPACE')
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
            or not isinstance(metadata.get('budget'), dict) or not isinstance(metadata.get('fixtureDirectory'), str) \
            or window.get('profile') == 'joint' and not _joint_generation_seed_valid(metadata):
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
    planned = _measure_planned_bytes(seed['snapshotBytes'])
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
    fixture_bytes, fixture_entries = _directory_bytes(fixture)
    return {'valid': True, 'checkpointCount': len(checkpoints), 'latestCheckpoint': checkpoints[-1].name,
            'fixtureDirectory': str(fixture), 'seedBound': seed is not None, 'identityStable': True,
            'fixtureBytes': fixture_bytes, 'fixtureEntries': fixture_entries,
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
    space_receipt = _read_json(output / 'space-before-snapshot.json') if output_exists else None
    exit_receipt = _read_json(output / 'exit.json') if output_exists else None
    before = _read_json(output / 'source-before.json') if output_exists else None
    after = _read_json(output / 'source-after.json') if output_exists else None
    command = _read_json(output / 'command.json') if output_exists else None
    target_reached = (seed.get('growth', {}).get('state') == 'target-reached') if isinstance(seed, dict) else None
    joint_seed_valid = (expected is None or expected.get('profile') != 'joint'
                        or _joint_generation_seed_valid(seed))
    generation_plan_valid = (expected is None or expected.get('profile') != 'joint'
                             or isinstance(seed, dict) and _joint_generation_plan_valid(seed.get('generationPlan')))
    generation_space_valid = expected is None or expected.get('profile') != 'joint'
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
    if expected is not None and expected.get('profile') == 'joint' and isinstance(seed, dict) and fixture_identity_valid:
        try:
            terminal_output_bytes, _ = _directory_bytes(output)
            pre_snapshot_output_bytes = sum(files[name]['size'] for name in ('source-before.json', 'command.json', *checkpoints))
            generation_space_valid = _joint_generation_space_valid(
                space_receipt, seed.get('generationPlan'), files['seed.sqlite']['size'],
                fixture_identity['fixtureBytes'], pre_snapshot_output_bytes, terminal_output_bytes)
        except (KeyError, TypeError, ValueError): generation_space_valid = False
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
                and fixture_identity_valid and authority_stable and joint_seed_valid
                and generation_plan_valid and generation_space_valid)
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
        'generationPlanValid': generation_plan_valid,
        'jointSeedValid': joint_seed_valid,
        'generationSpaceValid': generation_space_valid,
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


def _git_environment():
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update({'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_LAZY_FETCH': '1'})
    return environment


def _git_value(root, *arguments):
    try:
        return subprocess.check_output(
            ['/usr/bin/git', *arguments], cwd=root, text=True,
            stderr=subprocess.DEVNULL, timeout=15, env=_git_environment()).strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise ValueError('CANDIDATE_REPOSITORY') from error


def _git_blob(root, revision_path):
    if _git_value(root, 'rev-parse', '--show-toplevel') != str(root):
        raise ValueError('CANDIDATE_REPOSITORY')
    try:
        return subprocess.check_output(
            ['/usr/bin/git', 'show', revision_path], cwd=root, stderr=subprocess.DEVNULL,
            timeout=15, env=_git_environment())
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
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
    if _git_value(root, 'rev-parse', '--show-toplevel') != str(root) \
            or _git_value(root, 'branch', '--show-current') != candidate['branch'] \
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


def _frozen_identity_matches(expected, observed):
    required = {'device', 'inode', 'size', 'sha256'}
    allowed = required | {'mtimeNs', 'ctimeNs'}
    return isinstance(expected, dict) and required <= set(expected) <= allowed \
        and all(expected[key] == observed.get(key) for key in expected)


def _preview_runtime_root_relocation(binding, runtime, error_code):
    if not _queued_stop_exact_binding(binding, {'path', 'sha256'}):
        return None
    try:
        receipt_path = Path(binding['path']).resolve(strict=True)
        receipt, identity = _strict_json(receipt_path, 4 * 1024 * 1024)
    except (OSError, ValueError) as error:
        raise ValueError(error_code) from error
    if identity['sha256'] != binding['sha256'] \
            or not isinstance(receipt, dict) \
            or receipt.get('model') != 'exact75-v3-runtime-relocation-closure':
        return None
    relocation = receipt.get('liveRootRemap')
    if not isinstance(relocation, dict) \
            or set(relocation) != {
                'mode', 'historicalRuntime', 'currentRuntime', 'liveRootCount', 'mappings'} \
            or relocation.get('mode') != 'PREFIX_RELOCATION' \
            or relocation.get('currentRuntime') != str(runtime) \
            or relocation.get('liveRootCount') != 63 \
            or not isinstance(relocation.get('mappings'), list) \
            or len(relocation['mappings']) != 63:
        raise ValueError(error_code)
    historical = Path(str(relocation.get('historicalRuntime', '')))
    if not historical.is_absolute() or Path(os.path.normpath(str(historical))) != historical \
            or historical == runtime:
        raise ValueError(error_code)
    observed = []
    seen_historical = set(); seen_current = set()
    for mapping in relocation['mappings']:
        historical_root = mapping.get('historicalRoot') if isinstance(mapping, dict) else None
        current_root = mapping.get('currentRoot') if isinstance(mapping, dict) else None
        if not isinstance(mapping, dict) or set(mapping) != {'historicalRoot', 'currentRoot'} \
                or not isinstance(historical_root, dict) or not isinstance(current_root, dict) \
                or set(historical_root) != {'path', 'device', 'inode', 'marker'} \
                or set(current_root) != {'path', 'device', 'inode', 'marker'}:
            raise ValueError(error_code)
        try:
            relative = Path(historical_root['path']).relative_to(historical)
            expected = runtime / relative
            path = Path(current_root['path']); info = path.lstat(); canonical = path.resolve(strict=True)
        except (KeyError, OSError, TypeError, ValueError) as error:
            raise ValueError(error_code) from error
        if relative == Path('.') or path != expected or canonical != path or path.is_symlink() \
                or current_root.get('marker') != historical_root.get('marker') \
                or current_root.get('device') != info.st_dev or current_root.get('inode') != info.st_ino \
                or historical_root['path'] in seen_historical or current_root['path'] in seen_current:
            raise ValueError(error_code)
        marker = current_root['marker']
        _strict_root_marker(path, marker, info.st_dev, info.st_ino, error_code)
        seen_historical.add(historical_root['path']); seen_current.add(current_root['path'])
        observed.append({'historicalRoot': historical_root, 'currentRoot': current_root})
    return {**relocation, 'mappings': observed}


def _relocate_runtime_value(value, relocation, runtime, error_code, preserve_historical=False):
    """仅在内存中投影历史runtime；根身份必须以当前marker重新核验。"""
    if relocation is None:
        return value
    historical = Path(relocation['historicalRuntime'])
    runtime = Path(runtime)
    if isinstance(value, str):
        if preserve_historical:
            return value
        try: relative = Path(value).relative_to(historical)
        except ValueError: return value
        return str(runtime / relative) if relative != Path('.') else value
    if isinstance(value, list):
        return [_relocate_runtime_value(item, relocation, runtime, error_code,
                                        preserve_historical) for item in value]
    if not isinstance(value, dict):
        return value
    relocated = {key: _relocate_runtime_value(
        item, relocation, runtime, error_code,
        preserve_historical or key in {'historicalRoot', 'historicalRuntime'})
        for key, item in value.items()}
    if not preserve_historical and set(value) in (
            {'path', 'device', 'inode', 'marker'},
            {'path', 'device', 'inode', 'marker', 'role'}) \
            and isinstance(value.get('path'), str):
        current_path = _relocate_runtime_value(value['path'], relocation, runtime, error_code)
        if current_path != value['path']:
            marker = value.get('marker')
            try: info = Path(current_path).lstat()
            except OSError as error: raise ValueError(error_code) from error
            if not isinstance(marker, dict) or set(marker) != {'relative', 'sha256'} \
                    or not isinstance(marker.get('relative'), str) \
                    or _SHA256.fullmatch(str(marker.get('sha256', ''))) is None:
                raise ValueError(error_code)
            _strict_root_marker(Path(current_path), marker, info.st_dev, info.st_ino, error_code)
            return {**value, 'path': current_path, 'device': info.st_dev, 'inode': info.st_ino}
    if set(value) == {'mode', 'historicalDevice', 'currentDevice', 'liveRootCount'} \
            and value.get('mode') in {'UNCHANGED', 'REMAPPED'} \
            and type(value.get('historicalDevice')) is int \
            and type(value.get('currentDevice')) is int:
        current_device = runtime.lstat().st_dev
        return {**value, 'mode': 'UNCHANGED' if value['historicalDevice'] == current_device else 'REMAPPED',
                'currentDevice': current_device}
    return relocated


def _validate_measure_root_recovery(binding, runtime, manifest_path, manifest_sha256, window_id,
                                    missing_roots, expected_live_device_remap, candidate_repository, expected_seed_sha256,
                                    expected_fixture_owner_sha256, error_code,
                                    historical_repository=False, expected_live_root_remap=None,
                                    runtime_relocation=None):
    """验证exact75-v2/v3替代闭包；历史根保持LOST，替代根仅提供计数控制身份。"""
    receipt_keys = {'schemaVersion', 'scope', 'access', 'state', 'model', 'windowId',
                    'historicalManifest', 'liveDeviceRemap', 'repository', 'recoveryTool', 'mappings',
                    'activeBenchmarkInput', 'contentRecovered', 'historicalManifestRewritten',
                    'deviceOpened', 'formalReady', 'gateB'}
    relocation_receipt = expected_live_root_remap is not None
    if relocation_receipt:
        receipt_keys.add('liveRootRemap')
    repository_keys = {'root', 'branch', 'head', 'clean', 'pushedHead'}
    tool_keys = {'path', 'relativePath', 'workingSha256', 'gitBlobSha256'}
    mapping_keys = {'historicalRoot', 'state', 'recovered', 'replacementRoot'}
    replacement_keys = {'path', 'device', 'inode', 'marker', 'role'}
    marker_keys = {'schemaVersion', 'scope', 'id', 'role', 'recovered', 'historicalRoot'}
    if not _queued_stop_exact_binding(binding, {'path', 'sha256'}):
        raise ValueError(error_code)
    supplied = Path(binding['path'])
    try:
        receipt_path = supplied.resolve(strict=True)
        recovery_root = receipt_path.parent
        recovery_root_info = recovery_root.lstat()
        receipt, receipt_identity = _strict_json(receipt_path, 4 * 1024 * 1024)
        receipt = _relocate_runtime_value(
            receipt, runtime_relocation, runtime, error_code) if runtime_relocation else receipt
    except (OSError, ValueError) as error:
        raise ValueError(error_code) from error
    if supplied != receipt_path or supplied.is_symlink() or receipt_path.name != 'recovery.json' \
            or recovery_root.parent != runtime or recovery_root.is_symlink() \
            or not stat.S_ISDIR(recovery_root_info.st_mode) \
            or stat.S_IMODE(recovery_root_info.st_mode) != 0o700 \
            or stat.S_IMODE(receipt_path.stat().st_mode) != 0o400 \
            or receipt_identity['sha256'] != binding['sha256'] \
            or not isinstance(receipt, dict) or set(receipt) != receipt_keys \
            or receipt.get('schemaVersion') != 1 \
            or receipt.get('scope') != 'musicbridge-capacity-measure-root-recovery' \
            or receipt.get('access') != 'read-only' or receipt.get('state') != 'PUBLISHED' \
            or receipt.get('model') != (
                'exact75-v3-runtime-relocation-closure' if relocation_receipt
                else 'exact75-v2-replacement-closure') \
            or receipt.get('windowId') != window_id \
            or receipt.get('historicalManifest') != {
                'path': str(manifest_path), 'sha256': manifest_sha256} \
            or receipt.get('liveDeviceRemap') != expected_live_device_remap \
            or receipt.get('liveRootRemap') != expected_live_root_remap \
            or receipt.get('contentRecovered') is not False \
            or receipt.get('historicalManifestRewritten') is not False \
            or receipt.get('deviceOpened') is not False \
            or receipt.get('formalReady') is not False or receipt.get('gateB') != 'NOT_RUN':
        raise ValueError(error_code)

    repository = receipt.get('repository')
    tool = receipt.get('recoveryTool')
    if not isinstance(repository, dict) or set(repository) != repository_keys \
            or not isinstance(repository.get('root'), str) \
            or not isinstance(repository.get('branch'), str) or not repository['branch'] \
            or _GIT_SHA.fullmatch(str(repository.get('head', ''))) is None \
            or repository.get('clean') is not True or repository.get('pushedHead') is not True \
            or not isinstance(tool, dict) or set(tool) != tool_keys \
            or not isinstance(tool.get('path'), str) \
            or tool.get('relativePath') != 'scripts/ci/create-v3-capacity-measure-root-recovery.py' \
            or _SHA256.fullmatch(str(tool.get('workingSha256', ''))) is None \
            or tool.get('gitBlobSha256') != tool.get('workingSha256'):
        raise ValueError(error_code)
    if candidate_repository is not None and (not isinstance(candidate_repository, dict) or repository != {
            'root': candidate_repository.get('root'), 'branch': candidate_repository.get('branch'),
            'head': candidate_repository.get('head'), 'clean': True, 'pushedHead': True}):
        raise ValueError(error_code)
    candidate = Path(repository['root'])
    recovery_tool = candidate / tool['relativePath']
    try:
        canonical_candidate = candidate.resolve(strict=True)
        candidate_info = candidate.lstat()
        working_identity = _strict_identity(recovery_tool, 2 * 1024 * 1024)
        blob = _git_blob(candidate, f"{repository['head']}:{tool['relativePath']}")
        top = _git_value(candidate, 'rev-parse', '--show-toplevel')
        branch = _git_value(candidate, 'branch', '--show-current')
        head = _git_value(candidate, 'rev-parse', 'HEAD^{commit}')
        upstream = _git_value(candidate, 'rev-parse', '@{u}^{commit}')
        dirty = _git_value(candidate, 'status', '--porcelain=v1', '--untracked-files=all')
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise ValueError(error_code) from error
    if not candidate.is_absolute() or candidate != canonical_candidate or candidate.is_symlink() \
            or not stat.S_ISDIR(candidate_info.st_mode) or Path(tool.get('path', '')) != recovery_tool \
            or hashlib.sha256(blob).hexdigest() != tool['gitBlobSha256']:
        raise ValueError(error_code)
    if not historical_repository and (working_identity['sha256'] != tool['workingSha256'] \
            or top != str(candidate) or branch != repository['branch'] or head != repository['head'] \
            or upstream != head or dirty):
        raise ValueError(error_code)

    mappings = receipt.get('mappings')
    if not isinstance(mappings, list) or len(mappings) != 7 \
            or [row.get('historicalRoot') if isinstance(row, dict) else None for row in mappings] \
            != missing_roots:
        raise ValueError(error_code)
    if expected_fixture_owner_sha256 is not None \
            and sum(row['marker']['sha256'] == expected_fixture_owner_sha256
                    for row in missing_roots) != 1:
        raise ValueError(error_code)
    roots = []; snapshots = []; replacement_paths = set(); marker_ids = set()
    for mapping, historical in zip(mappings, missing_roots):
        replacement = mapping.get('replacementRoot') if isinstance(mapping, dict) else None
        if not isinstance(mapping, dict) or set(mapping) != mapping_keys \
                or mapping.get('state') != 'LOST' \
                or mapping.get('recovered') is not False or mapping.get('historicalRoot') != historical \
                or not isinstance(replacement, dict) or set(replacement) != replacement_keys \
                or replacement.get('role') != 'historical-control-only' \
                or type(replacement.get('device')) is not int \
                or type(replacement.get('inode')) is not int:
            raise ValueError(error_code)
        path = Path(str(replacement.get('path', ''))); marker = replacement.get('marker')
        try:
            info = path.lstat(); canonical = path.resolve(strict=True)
            entries = sorted(item.name for item in path.iterdir())
        except OSError as error:
            raise ValueError(error_code) from error
        if not path.is_absolute() or path.is_symlink() or canonical != path \
                or not stat.S_ISDIR(info.st_mode) or not _inside(runtime, path) or path == runtime \
                or path.parent != recovery_root or stat.S_IMODE(info.st_mode) != 0o700 \
                or str(path) in replacement_paths \
                or any(_inside(Path(other), path) or _inside(path, Path(other))
                       for other in replacement_paths) \
                or info.st_dev != expected_live_device_remap['currentDevice'] \
                or info.st_dev != replacement['device'] \
                or info.st_ino != replacement['inode'] or entries != ['owner.json'] \
                or not isinstance(marker, dict) or set(marker) != {'relative', 'sha256'} \
                or marker.get('relative') != 'owner.json' \
                or _SHA256.fullmatch(str(marker.get('sha256', ''))) is None \
                or marker['sha256'] == historical['marker']['sha256']:
            raise ValueError(error_code)
        try:
            owner, owner_identity = _strict_json(path / 'owner.json', 1024 * 1024)
            info_after = path.lstat()
            entries_after = sorted(item.name for item in path.iterdir())
        except ValueError as error:
            raise ValueError(error_code) from error
        except OSError as error:
            raise ValueError(error_code) from error
        directory_fields = ('st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
        if owner_identity['sha256'] != marker['sha256'] or not isinstance(owner, dict) \
                or set(owner) != marker_keys or owner.get('schemaVersion') != 1 \
                or owner.get('scope') != 'musicbridge-capacity-historical-control-only' \
                or not _uuid4(owner.get('id')) or owner.get('id') in marker_ids \
                or owner.get('role') != 'historical-control-only' \
                or owner.get('recovered') is not False \
                or owner.get('historicalRoot') != historical \
                or stat.S_IMODE((path / 'owner.json').stat().st_mode) != 0o400 \
                or entries_after != entries \
                or any(getattr(info, key) != getattr(info_after, key) for key in directory_fields):
            raise ValueError(error_code)
        replacement_paths.add(str(path)); marker_ids.add(owner['id'])
        roots.append({'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
                      'marker': {'relative': 'owner.json', 'sha256': marker['sha256']}})
        snapshots.append({
            'root': {'device': info.st_dev, 'inode': info.st_ino, 'mtimeNs': info.st_mtime_ns,
                     'ctimeNs': info.st_ctime_ns, 'nlink': info.st_nlink, 'entries': entries},
            'marker': owner_identity})

    benchmark = receipt.get('activeBenchmarkInput')
    if not isinstance(benchmark, dict) or set(benchmark) != {'model', 'path', 'sha256'} \
            or benchmark.get('model') != 'durable-seed-snapshot' \
            or not isinstance(benchmark.get('path'), str) \
            or _SHA256.fullmatch(str(benchmark.get('sha256', ''))) is None \
            or expected_seed_sha256 is not None and benchmark['sha256'] != expected_seed_sha256:
        raise ValueError(error_code)
    seed = Path(benchmark['path'])
    try:
        canonical_seed = seed.resolve(strict=True); seed_identity = _strict_identity(seed)
    except (OSError, ValueError) as error:
        raise ValueError(error_code) from error
    if not seed.is_absolute() or seed != canonical_seed or seed.is_symlink() or seed.name != 'seed.sqlite' \
            or not _inside(runtime, seed) or seed_identity['sha256'] != benchmark['sha256'] \
            or any(_inside(Path(path), seed) for path in replacement_paths):
        raise ValueError(error_code)
    for historical in missing_roots:
        try: Path(historical['path']).lstat()
        except FileNotFoundError: pass
        except OSError as error: raise ValueError(error_code) from error
        else: raise ValueError(error_code)
    try:
        recovery_root_after = recovery_root.lstat()
        recovery_entries = sorted(item.name for item in recovery_root.iterdir())
    except OSError as error:
        raise ValueError(error_code) from error
    recovery_fields = ('st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    expected_entries = sorted(['recovery.json', *(Path(path).name for path in replacement_paths)])
    if recovery_entries != expected_entries \
            or any(getattr(recovery_root_info, key) != getattr(recovery_root_after, key)
                   for key in recovery_fields):
        raise ValueError(error_code)
    try: receipt_after = _strict_identity(receipt_path, 4 * 1024 * 1024)
    except ValueError as error: raise ValueError(error_code) from error
    if receipt_after != receipt_identity:
        raise ValueError(error_code)
    return {'roots': roots, 'mappings': mappings, 'receiptIdentity': receipt_identity,
            'replacementSnapshots': snapshots, 'benchmarkIdentity': seed_identity,
            'liveDeviceRemap': expected_live_device_remap,
            'liveRootRemap': expected_live_root_remap,
            'recoveryDirectory': {
                'device': recovery_root_info.st_dev, 'inode': recovery_root_info.st_ino,
                'mtimeNs': recovery_root_info.st_mtime_ns, 'ctimeNs': recovery_root_info.st_ctime_ns,
                'nlink': recovery_root_info.st_nlink, 'entries': recovery_entries},
            'repository': repository, 'recoveryToolIdentity': working_identity}


def _validate_frozen_owned_roots(manifest_path, runtime, expected_sha256, window_id,
                                 future_path, future_state, error_code, root_recovery=None,
                                 candidate_repository=None, expected_seed_sha256=None,
                                 expected_fixture_owner_sha256=None):
    """复核冻结owned manifest的目录/marker identity；不读取根内大型文件。"""
    try:
        runtime = Path(runtime).resolve(strict=True)
        supplied_manifest = Path(manifest_path)
        canonical_manifest = supplied_manifest.resolve(strict=True)
        manifest, manifest_identity = _strict_json(canonical_manifest)
    except (OSError, ValueError) as error:
        raise ValueError(error_code) from error
    if not supplied_manifest.is_absolute() or supplied_manifest != canonical_manifest \
            or canonical_manifest.name != 'owned-roots.json' \
            or _SHA256.fullmatch(str(expected_sha256 or '')) is None \
            or manifest_identity['sha256'] != expected_sha256 \
            or not isinstance(manifest, dict) \
            or set(manifest) != {'schemaVersion', 'scope', 'access', 'windowId', 'roots', 'futureRoots'} \
            or manifest.get('schemaVersion') != 1 \
            or manifest.get('scope') != 'musicbridge-capacity-owned-roots' \
            or manifest.get('access') != 'count-only' or manifest.get('windowId') != window_id \
            or not isinstance(manifest.get('roots'), list) or not 1 <= len(manifest['roots']) <= 70:
        raise ValueError(error_code)
    root_relocation = _preview_runtime_root_relocation(
        root_recovery, runtime, error_code) if root_recovery is not None else None
    relocation_by_historical = {
        row['historicalRoot']['path']: row for row in root_relocation['mappings']
    } if root_relocation is not None else {}
    future = Path(future_path)
    declared_future = manifest.get('futureRoots')
    expected_declared_future = str(future)
    if root_relocation is not None and isinstance(declared_future, list) \
            and len(declared_future) == 1 and isinstance(declared_future[0], str):
        historical_runtime = Path(root_relocation['historicalRuntime'])
        try:
            relative_future = Path(declared_future[0]).relative_to(historical_runtime)
        except ValueError:
            relative_future = None
        if relative_future is not None and relative_future != Path('.') \
                and runtime / relative_future == future:
            expected_declared_future = declared_future[0]
    if future_state not in {'absent', 'present'} or not future.is_absolute() \
            or future.parent != runtime or _SAFE.fullmatch(future.name) is None \
            or manifest.get('futureRoots') != [expected_declared_future]:
        raise ValueError(error_code)
    if future_state == 'absent':
        if future.exists() or future.is_symlink(): raise ValueError(error_code)
    else:
        try: future_info = future.lstat(); canonical_future = future.resolve(strict=True)
        except OSError as error: raise ValueError(error_code) from error
        if future.is_symlink() or canonical_future != future or not stat.S_ISDIR(future_info.st_mode):
            raise ValueError(error_code)

    runtime_device = runtime.lstat().st_dev
    temp_roots = {Path(tempfile.gettempdir()).resolve(strict=True), Path('/tmp').resolve(strict=True)}
    rows = []; missing = []; seen = set()
    for declared in manifest['roots']:
        if not isinstance(declared, dict) or set(declared) != {'path', 'device', 'inode', 'marker'} \
                or type(declared.get('device')) is not int or type(declared.get('inode')) is not int \
                or not isinstance(declared.get('path'), str):
            raise ValueError(error_code)
        path = Path(declared['path']); marker = declared.get('marker')
        relocated = relocation_by_historical.get(str(path))
        try: normalized = path.resolve(strict=False)
        except (OSError, RuntimeError) as error: raise ValueError(error_code) from error
        if not path.is_absolute() or (relocated is None and normalized != path) or str(path) in seen \
                or not isinstance(marker, dict) or set(marker) != {'relative', 'sha256'} \
                or marker.get('relative') not in _MARKERS \
                or _SHA256.fullmatch(str(marker.get('sha256', ''))) is None:
            raise ValueError(error_code)
        if relocated is not None:
            if relocated['historicalRoot'] != declared:
                raise ValueError(error_code)
            rows.append(relocated['currentRoot']); seen.add(str(path)); continue
        in_runtime = _inside(runtime, path) and path != runtime
        fixture = path.parent in temp_roots and re.fullmatch(r'musicbridge-version-[A-Za-z0-9]+', path.name)
        app_clone = path.parent == Path(tempfile.gettempdir()).resolve(strict=True) \
            and re.fullmatch(r'musicbridge-ui-diagnostics-r021-[A-Za-z0-9]{6}', path.name)
        if not in_runtime and not (fixture and marker['relative'] == 'capacity-owner.json') \
                and not (app_clone and marker['relative'] == 'r020-owner.json'):
            raise ValueError(error_code)
        try: info = path.lstat(); canonical = path.resolve(strict=True)
        except FileNotFoundError:
            if root_recovery is None or not fixture or marker['relative'] != 'capacity-owner.json':
                raise ValueError(error_code)
            missing.append(declared); seen.add(str(path)); continue
        except OSError as error: raise ValueError(error_code) from error
        expected_device = runtime_device if root_recovery is not None else declared['device']
        if path.is_symlink() or canonical != path or not stat.S_ISDIR(info.st_mode) \
                or info.st_dev != expected_device or info.st_ino != declared['inode']:
            raise ValueError(error_code)
        observed = _strict_root_marker(
            path, marker, expected_device, declared['inode'], error_code)
        seen.add(str(path))
        rows.append(observed)
    recovery = None
    if root_recovery is not None:
        historical_devices = {row['device'] for row in manifest['roots']}
        if len(manifest['roots']) != 70 or len(rows) != 63 or len(missing) != 7 \
                or len(historical_devices) != 1:
            raise ValueError(error_code)
        historical_device = next(iter(historical_devices))
        live_device_remap = {
            'mode': 'UNCHANGED' if historical_device == runtime_device else 'REMAPPED',
            'historicalDevice': historical_device, 'currentDevice': runtime_device,
            'liveRootCount': 63}
        recovery = _validate_measure_root_recovery(
            root_recovery, runtime, canonical_manifest, expected_sha256, window_id, missing,
            live_device_remap, candidate_repository, expected_seed_sha256,
            expected_fixture_owner_sha256, error_code,
            expected_live_root_remap=root_relocation)
        live_paths = [Path(row['path']) for row in rows]
        replacement_paths = [Path(row['path']) for row in recovery['roots']]
        if any(_inside(live, replacement) or _inside(replacement, live)
               for live in live_paths for replacement in replacement_paths) \
                or any(_inside(future, replacement) or _inside(replacement, future)
                       for replacement in replacement_paths):
            raise ValueError(error_code)
        rows.extend(recovery['roots'])
        if len(rows) != 70 or len({row['path'] for row in rows}) != 70:
            raise ValueError(error_code)
    try: current_manifest = _strict_identity(canonical_manifest, 8 * 1024 * 1024)
    except ValueError as error: raise ValueError(error_code) from error
    if current_manifest != manifest_identity \
            or future_state == 'absent' and (future.exists() or future.is_symlink()):
        raise ValueError(error_code)
    return {'roots': rows, 'manifestIdentity': manifest_identity, 'future': future,
            'rootRecovery': recovery}


def _validate_measure_issuer_failure_carryover(parent, runtime, expected_owned_sha256,
                                               expected_failure_sha256, expected_window_id,
                                               expected_dir_name, expected_label):
    """验证未发布window03的终态issuer失败目录，保留其完整owned identity闭包。"""
    error_code = 'MEASURE_ISSUER_FAILURE_CARRYOVER'
    supplied_parent = Path(parent); supplied_runtime = Path(runtime)
    try: parent = supplied_parent.resolve(strict=True); runtime = supplied_runtime.resolve(strict=True)
    except OSError as error: raise ValueError(error_code) from error
    if not supplied_parent.is_absolute() or supplied_parent != parent \
            or not supplied_runtime.is_absolute() or supplied_runtime != runtime \
            or parent.parent != runtime or parent.name != expected_dir_name \
            or _SAFE.fullmatch(str(expected_dir_name or '')) is None \
            or _SAFE.fullmatch(str(expected_label or '')) is None or not _uuid4(expected_window_id) \
            or _SHA256.fullmatch(str(expected_failure_sha256 or '')) is None:
        raise ValueError(error_code)
    try:
        parent_info = parent.lstat()
        owner, _ = _strict_json(parent / 'owner.json')
        failure, failure_identity = _strict_json(parent / 'issuer-failure.json')
        _strict_identity(parent / 'supervisor.py', 8 * 1024 * 1024)
        _strict_json(parent / 'issuer-identity' / 'owner.json')
        _strict_json(parent / 'source-pins.json')
    except (OSError, ValueError) as error:
        raise ValueError(error_code) from error
    created = ['owner.json', 'supervisor.py', 'issuer-identity/owner.json',
               'source-pins.json', 'owned-roots.json']
    try: recorded = datetime.datetime.fromisoformat(failure.get('recordedAt'))
    except (AttributeError, TypeError, ValueError): recorded = None
    if parent.is_symlink() or not stat.S_ISDIR(parent_info.st_mode) \
            or owner != {'scope': 'musicbridge-capacity-measure-window', 'owner': 'root', 'id': expected_window_id} \
            or failure_identity['sha256'] != expected_failure_sha256 \
            or not isinstance(failure, dict) \
            or set(failure) != {'schemaVersion', 'scope', 'state', 'windowId', 'windowDirName',
                                'label', 'errorCode', 'authorityFilesCreated', 'windowWritten',
                                'replayAllowed', 'recordedAt'} \
            or failure.get('schemaVersion') != 1 \
            or failure.get('scope') != 'musicbridge-capacity-measure-authority-issuer-failure' \
            or failure.get('state') != 'TERMINAL_ISSUER_FAILURE' \
            or failure.get('windowId') != expected_window_id \
            or failure.get('windowDirName') != expected_dir_name or failure.get('label') != expected_label \
            or failure.get('errorCode') != 'AUTHORITY_PREFLIGHT' \
            or failure.get('authorityFilesCreated') != created \
            or failure.get('windowWritten') is not False or failure.get('replayAllowed') is not False \
            or recorded is None or recorded.utcoffset() is None \
            or (parent / 'window.json').exists() or (parent / 'window.json').is_symlink() \
            or (parent / 'window.pending.json').exists() or (parent / 'window.pending.json').is_symlink():
        raise ValueError(error_code)
    frozen = _validate_frozen_owned_roots(
        parent / 'owned-roots.json', runtime, expected_owned_sha256, expected_window_id,
        runtime / expected_label, 'absent', error_code)
    observed_paths = {row['path'] for row in frozen['roots']}
    if str(parent) not in observed_paths or str(parent / 'issuer-identity') not in observed_paths:
        raise ValueError(error_code)
    try: current_failure = _strict_identity(parent / 'issuer-failure.json', 8 * 1024 * 1024)
    except ValueError as error: raise ValueError(error_code) from error
    if current_failure != failure_identity: raise ValueError(error_code)
    return {'valid': True,
            'terminal': {'windowId': expected_window_id, 'windowDirName': expected_dir_name,
                         'label': expected_label, 'state': 'TERMINAL_ISSUER_FAILURE',
                         'errorCode': 'AUTHORITY_PREFLIGHT', 'windowWritten': False,
                         'replayAllowed': False, 'failureSha256': expected_failure_sha256,
                         'ownedManifestSha256': expected_owned_sha256},
            'roots': frozen['roots']}


def _stable_sqlite_lstat(file, error_code):
    try: info = os.lstat(file)
    except OSError as error: raise ValueError(error_code) from error
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size <= 0:
        raise ValueError(error_code)
    return info


def _same_sqlite_lstat(file, before, error_code):
    try: after = os.lstat(file)
    except OSError as error: raise ValueError(error_code) from error
    keys = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    if any(getattr(before, key) != getattr(after, key) for key in keys): raise ValueError(error_code)


def _validate_measure_v2_terminal_carryover(window_path, close_path, output, runtime,
                                            expected_owned_sha256, expected_window_sha256,
                                            expected_close_sha256, expected_command_sha256,
                                            expected_window_id, expected_label):
    """验证window04 v2终态partial；retained SQLite仅做stable lstat/size。"""
    error_code = 'MEASURE_V2_TERMINAL_CARRYOVER'
    supplied = (Path(window_path), Path(close_path), Path(output), Path(runtime))
    try:
        window_path, close_path, output, runtime = (path.resolve(strict=True) for path in supplied)
    except OSError as error:
        raise ValueError(error_code) from error
    expected_hashes = (expected_owned_sha256, expected_window_sha256,
                       expected_close_sha256, expected_command_sha256)
    if any(not path.is_absolute() or path != canonical for path, canonical in zip(supplied,
           (window_path, close_path, output, runtime))) \
            or any(_SHA256.fullmatch(str(value or '')) is None for value in expected_hashes) \
            or window_path.name != 'window.json' or close_path.name != 'close.json' \
            or window_path.parent != close_path.parent or window_path.parent.parent != runtime \
            or output.parent != runtime or output.name != expected_label \
            or _SAFE.fullmatch(str(expected_label or '')) is None or not _uuid4(expected_window_id):
        raise ValueError(error_code)
    parent = window_path.parent
    try:
        window, window_identity = _strict_json(window_path)
        close, close_identity = _strict_json(close_path)
        command, command_identity = _strict_json(output / 'command.json')
        owner, _ = _strict_json(parent / 'owner.json')
    except ValueError as error:
        raise ValueError(error_code) from error
    if window_identity['sha256'] != expected_window_sha256 \
            or close_identity['sha256'] != expected_close_sha256 \
            or command_identity['sha256'] != expected_command_sha256 \
            or not isinstance(window, dict) or set(window) != _MEASURE_KEYS \
            or any(window.get(key) != value for key, value in {
                'schemaVersion': 1, 'scope': 'musicbridge-capacity-measure-window', 'owner': 'root',
                'id': expected_window_id, 'state': 'approved', 'phase': 'measure',
                'profile': 'objects-limit', 'label': expected_label, 'n': 105}.items()) \
            or window.get('limits') != _MEASURE_LIMITS or window.get('measurePlan') != _MEASURE_PLAN \
            or owner != {'scope': 'musicbridge-capacity-measure-window', 'owner': 'root', 'id': expected_window_id}:
        raise ValueError(error_code)
    try:
        issued = datetime.datetime.fromisoformat(window['issuedAt'])
        deadline = datetime.datetime.fromisoformat(window['deadlineAt'])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(error_code) from error
    seed = window.get('seed'); supervisor = window.get('supervisor'); candidate = window.get('candidateRepository')
    if issued.utcoffset() is None or deadline.utcoffset() is None \
            or deadline - issued != datetime.timedelta(seconds=900) \
            or _SAFE.fullmatch(str(window.get('seedLabel', ''))) is None \
            or not isinstance(seed, dict) or set(seed) != {'metadataSha256', 'snapshotSha256', 'fixtureOwnerSha256'} \
            or any(_SHA256.fullmatch(str(seed.get(key, ''))) is None for key in seed) \
            or window.get('ownedManifest') != {'file': 'owned-roots.json', 'sha256': expected_owned_sha256} \
            or not isinstance(window.get('sourceManifest'), dict) \
            or window['sourceManifest'].get('file') != 'source-pins.json' \
            or _SHA256.fullmatch(str(window['sourceManifest'].get('sha256', ''))) is None \
            or not isinstance(supervisor, dict) or set(supervisor) != {'path', 'sha256'} \
            or supervisor.get('path') != str(parent / 'supervisor.py') \
            or _SHA256.fullmatch(str(supervisor.get('sha256', ''))) is None \
            or not isinstance(candidate, dict) or set(candidate) != {'root', 'branch', 'head'} \
            or not isinstance(candidate.get('root'), str) or not Path(candidate['root']).is_absolute() \
            or not isinstance(candidate.get('branch'), str) or not candidate['branch'] \
            or _GIT_SHA.fullmatch(str(candidate.get('head', ''))) is None:
        raise ValueError(error_code)
    if os.path.normpath(candidate['root']) != candidate['root']:
        raise ValueError(error_code)
    try:
        supervisor_identity = _strict_identity(parent / 'supervisor.py', 8 * 1024 * 1024)
        source_identity = _strict_identity(parent / 'source-pins.json', 8 * 1024 * 1024)
    except ValueError as error: raise ValueError(error_code) from error
    if supervisor_identity['sha256'] != supervisor['sha256'] \
            or source_identity['sha256'] != window['sourceManifest']['sha256']:
        raise ValueError(error_code)

    frozen = _validate_frozen_owned_roots(
        parent / 'owned-roots.json', runtime, expected_owned_sha256, expected_window_id,
        output, 'present', error_code)
    observed_paths = {row['path'] for row in frozen['roots']}
    if str(parent) not in observed_paths or str(parent / 'issuer-identity') not in observed_paths:
        raise ValueError(error_code)
    authority_admission = close.get('authorityAdmission') if isinstance(close, dict) else None
    authority_terminal = close.get('authorityTerminal') if isinstance(close, dict) else None
    measurement = close.get('measurement') if isinstance(close, dict) else None
    source_sha = window['sourceManifest']['sha256']
    stable_admission = ('authorityStable', 'windowStable', 'ownerStable', 'sourceManifestStable',
                        'ownedManifestStable', 'sourcePinsValid', 'ownedRootsValid', 'spaceValid', 'seedValid')
    if not isinstance(close, dict) or close.get('schemaVersion') != 1 \
            or close.get('scope') != 'musicbridge-capacity-measure-window-close' \
            or close.get('windowId') != expected_window_id or close.get('profile') != 'objects-limit' \
            or close.get('label') != expected_label or close.get('seedLabel') != window['seedLabel'] \
            or close.get('state') != 'failed' or close.get('failure') != 'AUTHORITY_DRIFT' \
            or close.get('managedProcessGroup') is not True or close.get('code') != 1 \
            or close.get('exitSignal') is not None or close.get('signals') != [] \
            or close.get('groupEmpty') is not True or close.get('zombies') != [] \
            or close.get('windowSha256') != expected_window_sha256 \
            or close.get('ownedManifestSha256') != expected_owned_sha256 \
            or close.get('sourceManifestSha256') != source_sha or close.get('seed') != seed \
            or close.get('deviceOpened') is not False or close.get('formalReady') is not False \
            or close.get('gateB') != 'NOT_RUN' \
            or close.get('replayPolicy') != 'terminal-window-id-and-label-never-reuse' \
            or not isinstance(authority_admission, dict) \
            or any(authority_admission.get(key) is not True for key in stable_admission) \
            or authority_admission.get('windowSha256Observed') != expected_window_sha256 \
            or authority_admission.get('sourceManifestSha256Observed') != source_sha \
            or authority_admission.get('ownedManifestSha256Observed') != expected_owned_sha256 \
            or authority_admission.get('ownedRootCount') != len(frozen['roots']) + 1 \
            or type(authority_admission.get('plannedBytes')) is not int \
            or not 0 < authority_admission['plannedBytes'] <= 16 * 1024 ** 3 \
            or not isinstance(authority_terminal, dict) \
            or authority_terminal != {'authorityStable': False, 'error': 'AUTHORITY_DRIFT'} \
            or not isinstance(measurement, dict):
        raise ValueError(error_code)
    fixed = ('command.json', 'measurement.json', 'samples.jsonl', 'source-before.json',
             'source-after.json', 'end-budget.json', 'summary.json', 'exit.json',
             'measure-stages.jsonl')
    files = measurement.get('files')
    if measurement.get('profile') != 'objects-limit' or measurement.get('label') != expected_label \
            or measurement.get('seedLabel') != window['seedLabel'] \
            or measurement.get('window') != expected_window_id \
            or measurement.get('windowSha256') != expected_window_sha256 \
            or measurement.get('ownedManifestSha256') != expected_owned_sha256 \
            or measurement.get('sourceManifestSha256') != source_sha \
            or measurement.get('outputDirectory') != str(output) \
            or measurement.get('outputDirectoryExists') is not True \
            or measurement.get('partialExists') is not True or measurement.get('partialPreserved') is not True \
            or measurement.get('unexpectedEntries') != [] or measurement.get('sampleCount') != 111 \
            or measurement.get('receiptCount') != 1 or measurement.get('roundReceiptCount') != 1 \
            or measurement.get('stageCount') != 10 or measurement.get('measurePlan') != _MEASURE_PLAN \
            or any(measurement.get(key) is not False for key in (
                'samplesValid', 'receiptsValid', 'roundReceiptsValid', 'stageEvidenceValid',
                'partialEvidenceValid', 'exitZero', 'summaryComplete', 'thresholdPassed',
                'authorityStable', 'verifiedComplete', 'verifiedPassed')) \
            or measurement.get('sourceBeforeEqualsAfter') is not True \
            or measurement.get('childExitMatchesThreshold') is not True \
            or measurement.get('commandMatchesWindow') is not True \
            or measurement.get('measurementMatchesWindow') is not True \
            or measurement.get('authority') is not None \
            or measurement.get('authorityError') != 'AUTHORITY_DRIFT' \
            or not isinstance(files, dict) or set(files) != set(fixed):
        raise ValueError(error_code)
    for name in fixed:
        fact = files.get(name)
        if not isinstance(fact, dict) or set(fact) != {'exists', 'size', 'sha256'}:
            raise ValueError(error_code)
        path = output / name
        if fact['exists'] is True:
            try: observed = _strict_identity(path, 8 * 1024 * 1024)
            except ValueError as error: raise ValueError(error_code) from error
            if fact['size'] != observed['size'] or fact['sha256'] != observed['sha256']:
                raise ValueError(error_code)
        elif fact != {'exists': False, 'size': None, 'sha256': None} \
                or path.exists() or path.is_symlink():
            raise ValueError(error_code)
    present = {name for name in fixed if files[name]['exists'] is True}
    allowed = present | {'group-progress.receipt.json', 'group-stop.round-001.receipt.json', 'group-stop'}
    try: output_entries = {item.name for item in output.iterdir()}
    except OSError as error: raise ValueError(error_code) from error
    if output_entries != allowed: raise ValueError(error_code)

    def command_option(name):
        args = command.get('args') if isinstance(command, dict) else None
        if not isinstance(args, list) or args.count(name) != 1: return None
        index = args.index(name)
        return args[index + 1] if index + 1 < len(args) else None
    if not isinstance(command, dict) or command.get('phase') != 'measure' \
            or command.get('profile') != 'objects-limit' or command.get('window') != expected_window_id \
            or command.get('deviceOpened') is not False or command.get('formalReady') is not False \
            or command.get('gateB') != 'NOT_RUN' or command_option('--phase') != 'measure' \
            or command_option('--profile') != 'objects-limit' or command_option('--label') != expected_label \
            or command_option('--seed-label') != window['seedLabel'] \
            or command_option('--window') != expected_window_id \
            or command_option('--runtime-root') != str(runtime):
        raise ValueError(error_code)
    try:
        measurement_file, _ = _strict_json(output / 'measurement.json')
        source_before, _ = _strict_json(output / 'source-before.json')
        source_after, _ = _strict_json(output / 'source-after.json')
        exit_receipt, _ = _strict_json(output / 'exit.json')
    except ValueError as error: raise ValueError(error_code) from error
    if not isinstance(measurement_file, dict) or measurement_file.get('window') != expected_window_id \
            or measurement_file.get('profile') != 'objects-limit' \
            or measurement_file.get('seedLabel') != window['seedLabel'] \
            or measurement_file.get('seedSha256') != seed['snapshotSha256'] \
            or measurement_file.get('measurePlan') != _MEASURE_PLAN \
            or source_before != source_after or exit_receipt != {'exit': 1}:
        raise ValueError(error_code)
    try:
        samples_identity = _strict_identity(output / 'samples.jsonl', 8 * 1024 * 1024)
        samples = [json.loads(line) for line in (output / 'samples.jsonl').read_text().splitlines() if line]
        if _strict_identity(output / 'samples.jsonl', 8 * 1024 * 1024) != samples_identity:
            raise ValueError(error_code)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(error_code) from error
    if len(samples) != 111 \
            or any(not isinstance(row, dict) or row.get('metric') != 'progress' \
                   or row.get('outcome') != 'ok' or row.get('warmup') is not (index < 5)
                   for index, row in enumerate(samples[:105])) \
            or [row.get('metric') for row in samples[105:] if isinstance(row, dict)] != list(_STOP_METRICS) \
            or any(row.get('outcome') != 'ok' or row.get('warmup') is not True for row in samples[105:]):
        raise ValueError(error_code)

    receipts = measurement.get('receiptInventory'); retained_rows = measurement.get('retainedInventory')
    if not isinstance(receipts, list) or len(receipts) != 1 or not isinstance(receipts[0], dict) \
            or receipts[0].get('name') != 'group-progress.receipt.json' \
            or receipts[0].get('outcome') != 'ok' or receipts[0].get('retained') is not False \
            or receipts[0].get('sampleCount') != 105 \
            or not isinstance(retained_rows, list) or len(retained_rows) != 1:
        raise ValueError(error_code)
    try:
        progress, progress_identity = _strict_json(output / 'group-progress.receipt.json')
        round_one, _ = _strict_json(output / 'group-stop.round-001.receipt.json')
    except ValueError as error: raise ValueError(error_code) from error
    if not _frozen_identity_matches(receipts[0].get('identity'), progress_identity) \
            or progress.get('outcome') != 'ok' or progress.get('resourcesClosed') is not True \
            or progress.get('retained') is not False or progress.get('samples') != samples[:105] \
            or progress.get('marker') != receipts[0].get('marker') \
            or round_one.get('schemaVersion') != 1 \
            or round_one.get('scope') != 'musicbridge-capacity-measure-stop-round' \
            or round_one.get('group') != 'stop' or round_one.get('roundIndex') != 1 \
            or round_one.get('sampleCount') != 6 or round_one.get('samples') != samples[105:] \
            or round_one.get('inProgressBefore') != 0 or round_one.get('inProgressAfter') != 0 \
            or round_one.get('attemptStatus') != 'aborted' or round_one.get('attemptReason') != 'user-stop' \
            or round_one.get('coordinatorClosed') is not True or round_one.get('repositoryOpen') is not True:
        raise ValueError(error_code)
    retained = Path(retained_rows[0].get('path', ''))
    try:
        retained_info = retained.lstat(); canonical_retained = retained.resolve(strict=True)
        retained_entries = {item.name for item in retained.iterdir()}
        retained_marker, retained_marker_identity = _strict_json(retained / 'owner.json')
    except (OSError, ValueError) as error:
        raise ValueError(error_code) from error
    if retained != output / 'group-stop' or retained.is_symlink() or canonical_retained != retained \
            or not stat.S_ISDIR(retained_info.st_mode) or retained_info.st_dev != retained_rows[0].get('device') \
            or retained_info.st_ino != retained_rows[0].get('inode') \
            or retained_entries != {'owner.json', 'sample.sqlite'} \
            or retained_marker != round_one.get('groupMarker') \
            or not _frozen_identity_matches(retained_rows[0].get('marker'), retained_marker_identity):
        raise ValueError(error_code)
    sqlite_before = _stable_sqlite_lstat(retained / 'sample.sqlite', error_code)
    try: output_bytes, _ = _directory_bytes(output)
    except (OSError, ValueError) as error: raise ValueError(error_code) from error
    if output_bytes > authority_admission['plannedBytes']: raise ValueError(error_code)

    try:
        stages_identity = _strict_identity(output / 'measure-stages.jsonl', 8 * 1024 * 1024)
        stages = [json.loads(line) for line in (output / 'measure-stages.jsonl').read_text().splitlines() if line]
        if _strict_identity(output / 'measure-stages.jsonl', 8 * 1024 * 1024) != stages_identity:
            raise ValueError(error_code)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(error_code) from error
    expected_stages = [('progress', phase) for phase in _STAGE_PHASES] \
        + [('stop', phase) for phase in _STAGE_PHASES[:4]]
    if len(stages) != 10 or any(not isinstance(row, dict) for row in stages) \
            or [(row.get('group'), row.get('phase')) for row in stages] != expected_stages \
            or stages[-1].get('details') != {'requestedRounds': 105, 'completedRounds': 1,
                                               'lastReceipt': 'group-stop.round-001.receipt.json'}:
        raise ValueError(error_code)
    if measurement.get('roundReceiptInventory') != []: raise ValueError(error_code)

    capture_identities = {}
    for key, name in (('stdout', 'stdout.log'), ('stderr', 'stderr.log')):
        fact = close.get(key)
        expected_path = parent / 'supervision' / name
        if not isinstance(fact, dict) or fact.get('path') != str(expected_path) \
                or fact.get('exists') is not True:
            raise ValueError(error_code)
        try: observed = _strict_identity(expected_path, 8 * 1024 * 1024)
        except ValueError as error: raise ValueError(error_code) from error
        if fact.get('size') != observed['size'] or fact.get('sha256') != observed['sha256']:
            raise ValueError(error_code)
        capture_identities[key] = observed
    try:
        stdout = (parent / 'supervision' / 'stdout.log').read_text()
        supervision_identity = _strict_identity(parent / 'supervision' / 'supervisor.json', 8 * 1024 * 1024)
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise ValueError(error_code) from error
    if "code: 'COPY_UNAVAILABLE'" not in stdout \
            or close.get('supervisorSha256') != supervision_identity['sha256']:
        raise ValueError(error_code)

    _same_sqlite_lstat(retained / 'sample.sqlite', sqlite_before, error_code)
    try:
        current_window = _strict_identity(window_path, 8 * 1024 * 1024)
        current_close = _strict_identity(close_path, 8 * 1024 * 1024)
        current_command = _strict_identity(output / 'command.json', 8 * 1024 * 1024)
        current_supervisor = _strict_identity(parent / 'supervisor.py', 8 * 1024 * 1024)
        current_source = _strict_identity(parent / 'source-pins.json', 8 * 1024 * 1024)
        current_supervision = _strict_identity(parent / 'supervision' / 'supervisor.json', 8 * 1024 * 1024)
        current_stdout = _strict_identity(parent / 'supervision' / 'stdout.log', 8 * 1024 * 1024)
        current_stderr = _strict_identity(parent / 'supervision' / 'stderr.log', 8 * 1024 * 1024)
    except ValueError as error: raise ValueError(error_code) from error
    if current_window != window_identity or current_close != close_identity \
            or current_command != command_identity or current_supervisor != supervisor_identity \
            or current_source != source_identity or current_supervision != supervision_identity \
            or current_stdout != capture_identities['stdout'] or current_stderr != capture_identities['stderr']:
        raise ValueError(error_code)
    output_root = _carryover_root_identity(output, 'command.json')
    _same_sqlite_lstat(retained / 'sample.sqlite', sqlite_before, error_code)
    return {'valid': True,
            'terminal': {'windowId': expected_window_id, 'label': expected_label,
                         'state': 'failed', 'failure': 'AUTHORITY_DRIFT',
                         'windowSha256': expected_window_sha256, 'closeSha256': expected_close_sha256,
                         'groupEmpty': True, 'zombies': [], 'authorityAdmissionStable': True,
                         'authorityTerminalStable': False, 'replayAllowed': False},
            'partial': {'outputDirectory': str(output), 'commandSha256': expected_command_sha256,
                        'benchmarkFailureCode': 'COPY_UNAVAILABLE', 'sampleCount': 111,
                        'receiptCount': 1, 'roundReceiptCount': 1, 'stageCount': 10,
                        'partialExists': True, 'partialPreserved': True, 'verifiedPassed': False,
                        'retainedDirectory': 'group-stop',
                        'outputBytes': output_bytes,
                        'retainedSqlite': {'size': sqlite_before.st_size, 'nlink': sqlite_before.st_nlink,
                                           'contentSha256Verified': False,
                                           'verification': 'stable-lstat-size-only-no-content-read'},
                        'unexpectedEntries': []},
            'roots': frozen['roots'], 'outputRoot': output_root}


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


def _validate_measure_aggregate_budget(output):
    """验证新measure output的逐行aggregate预算与最终全树逻辑字节上限。"""
    invalid = {'valid': False, 'rowCount': 0, 'snapshotBytes': None, 'limitBytes': None,
               'finalOutputBytes': None, 'fileIdentity': None}
    supplied = Path(output)
    try:
        output = supplied.resolve(strict=True); output_info = supplied.lstat()
    except OSError:
        return invalid
    if not supplied.is_absolute() or supplied != output or supplied.is_symlink() \
            or not stat.S_ISDIR(output_info.st_mode):
        return invalid
    file = output / 'measure-aggregate-budget.jsonl'
    try:
        identity = _strict_identity(file, 8 * 1024 * 1024)
        text = file.read_text()
        if not text.endswith('\n') or _strict_identity(file, 8 * 1024 * 1024) != identity:
            return invalid
        lines = text.splitlines()
        if not lines or any(not line for line in lines): return invalid
        rows = [json.loads(line) for line in lines]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return invalid
    exact_keys = {'schemaVersion', 'scope', 'sequence', 'checkpoint', 'group', 'activeClone',
                  'snapshotBytes', 'limitBytes', 'outputBytesBefore', 'plannedBytes', 'recordedAt'}
    safe_max = 2 ** 53 - 1; groups = set(_MEASURE_GROUPS)
    snapshot_bytes = None; limit_bytes = None
    for sequence, row in enumerate(rows, 1):
        if not isinstance(row, dict) or set(row) != exact_keys \
                or row.get('schemaVersion') != 1 \
                or row.get('scope') != 'musicbridge-capacity-measure-aggregate-budget' \
                or type(row.get('sequence')) is not int or row['sequence'] != sequence \
                or re.fullmatch(r'[a-z0-9][a-z0-9:-]{0,95}', str(row.get('checkpoint', '')),
                                re.ASCII) is None:
            return invalid
        group = row.get('group'); active_clone = row.get('activeClone')
        if group is not None and group not in groups \
                or active_clone is not None and active_clone not in {f'group-{value}' for value in groups} \
                or group is not None and active_clone is not None and active_clone != f'group-{group}':
            return invalid
        for key in ('snapshotBytes', 'limitBytes', 'outputBytesBefore', 'plannedBytes'):
            if type(row.get(key)) is not int or not 0 <= row[key] <= safe_max:
                return invalid
        if row['snapshotBytes'] <= 0 \
                or row['snapshotBytes'] > safe_max - 256 * 1024 ** 2 \
                or row['limitBytes'] != row['snapshotBytes'] + 256 * 1024 ** 2 \
                or row['plannedBytes'] > row['limitBytes'] - row['outputBytesBefore']:
            return invalid
        if snapshot_bytes is None:
            snapshot_bytes = row['snapshotBytes']; limit_bytes = row['limitBytes']
        elif row['snapshotBytes'] != snapshot_bytes or row['limitBytes'] != limit_bytes:
            return invalid
        try: recorded = datetime.datetime.fromisoformat(row['recordedAt'])
        except (TypeError, ValueError): return invalid
        if recorded.utcoffset() is None: return invalid
    try:
        final_bytes, _ = _directory_bytes(output)
        final_bytes_again, _ = _directory_bytes(output)
        current_identity = _strict_identity(file, 8 * 1024 * 1024)
    except (OSError, ValueError):
        return invalid
    if final_bytes != final_bytes_again or final_bytes > limit_bytes or current_identity != identity:
        return invalid
    return {'valid': True, 'rowCount': len(rows), 'snapshotBytes': snapshot_bytes,
            'limitBytes': limit_bytes, 'finalOutputBytes': final_bytes, 'fileIdentity': identity}


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
    aggregate_budget = _validate_measure_aggregate_budget(output) if output_exists else {
        'valid': False, 'rowCount': 0, 'snapshotBytes': None, 'limitBytes': None,
        'finalOutputBytes': None, 'fileIdentity': None}
    aggregate_budget_valid = aggregate_budget.get('valid') is True
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
        and aggregate_budget_valid \
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
        and round_receipts_valid and stage_evidence_valid and aggregate_budget_valid \
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
        'aggregateBudgetValid': aggregate_budget_valid,
        'aggregateBudgetRowCount': aggregate_budget.get('rowCount'),
        'aggregateBudgetSnapshotBytes': aggregate_budget.get('snapshotBytes'),
        'aggregateBudgetLimitBytes': aggregate_budget.get('limitBytes'),
        'aggregateOutputBytes': aggregate_budget.get('finalOutputBytes'),
        'aggregateBudgetIdentity': aggregate_budget.get('fileIdentity'),
        'receiptInventory': receipt_inventory, 'retainedInventory': retained_inventory,
        'exitZero': exit_receipt == {'exit': 0}, 'sourceBeforeEqualsAfter': before is not None and before == after,
        'childExitMatchesThreshold': exit_consistent,
        'endBudgetMatchesSeed': end_budget_matches,
        'commandMatchesWindow': command_matches, 'measurementMatchesWindow': measurement_matches,
        'summaryComplete': summary_complete, 'thresholdPassed': threshold_passed,
        'authorityStable': authority_stable, 'authority': authority, 'authorityError': authority_error,
        'verifiedComplete': verified_complete, 'verifiedPassed': verified}


def _queued_stop_times(window):
    try:
        issued = datetime.datetime.fromisoformat(window['issuedAt'])
        deadline = datetime.datetime.fromisoformat(window['deadlineAt'])
    except (KeyError, TypeError, ValueError) as error:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    if issued.utcoffset() is None or deadline.utcoffset() is None \
            or deadline - issued != datetime.timedelta(seconds=900):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    return issued.timestamp(), deadline.timestamp()


def _queued_stop_planned_bytes(snapshot_bytes):
    if type(snapshot_bytes) is not int or snapshot_bytes <= 0:
        raise ValueError('QUEUED_STOP_PLAN')
    planned = snapshot_bytes + _QUEUED_STOP_ALLOWANCE
    if planned > _QUEUED_STOP_LIMITS['maximumOwnedBytes']:
        raise ValueError('QUEUED_STOP_PLAN')
    return planned


def _queued_stop_exact_binding(value, keys):
    return isinstance(value, dict) and set(value) == set(keys) \
        and isinstance(value.get('path'), str) and Path(value['path']).is_absolute() \
        and _SHA256.fullmatch(str(value.get('sha256', ''))) is not None


def _queued_stop_identity_schema(value):
    return _queued_stop_exact_binding(value, {'path', 'sha256'})


def _validate_queued_stop_window(window, now):
    if isinstance(window, dict) and window.get('profile') == 'joint':
        return _validate_joint_queued_stop_window(window, now)
    required = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-queued-stop-window',
                'owner': 'root', 'state': 'approved', 'phase': 'queued-stop',
                'profile': 'objects-limit', 'n': 105}
    if not isinstance(window, dict) or set(window) != _QUEUED_STOP_KEYS \
            or any(window.get(key) != value for key, value in required.items()) \
            or not _uuid4(window.get('id')) or _SAFE.fullmatch(str(window.get('label', ''))) is None \
            or _SAFE.fullmatch(str(window.get('seedLabel', ''))) is None \
            or type(window.get('issuerFailureCarryoverCount')) is not int \
            or not 1 <= window['issuerFailureCarryoverCount'] <= 64 \
            or type(window.get('prechildFailureCarryoverCount')) is not int \
            or not 1 <= window['prechildFailureCarryoverCount'] <= 64 \
            or type(window.get('processFailureCarryoverCount')) is not int \
            or not 1 <= window['processFailureCarryoverCount'] <= 64 \
            or window.get('limits') != _QUEUED_STOP_LIMITS:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    seed = window.get('seed')
    if not isinstance(seed, dict) or set(seed) != {'label', 'metadataSha256', 'snapshotSha256', 'fixtureOwnerSha256'} \
            or seed.get('label') != window['seedLabel'] \
            or any(seed.get(key) != expected for key, expected in _QUEUED_STOP_SEED.items()) \
            or any(_SHA256.fullmatch(str(seed.get(key, ''))) is None
                   for key in ('metadataSha256', 'snapshotSha256', 'fixtureOwnerSha256')):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    plan = window.get('queuedStopPlan')
    plan_keys = {'warmupCount', 'formalCount', 'sampleCount', 'activeCloneMaximum',
                 'snapshotBytes', 'evidenceAllowanceBytes', 'plannedBytes', 'model', 'aggregateAudit'}
    try: expected_planned = _queued_stop_planned_bytes(plan.get('snapshotBytes'))
    except (AttributeError, ValueError) as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    if not isinstance(plan, dict) or set(plan) != plan_keys \
            or plan.get('warmupCount') != 5 or plan.get('formalCount') != 100 \
            or plan.get('sampleCount') != 105 or plan.get('activeCloneMaximum') != 1 \
            or plan.get('snapshotBytes') != _QUEUED_STOP_SNAPSHOT_BYTES \
            or plan.get('evidenceAllowanceBytes') != _QUEUED_STOP_ALLOWANCE \
            or plan.get('plannedBytes') != expected_planned \
            or plan.get('model') != _QUEUED_STOP_MODEL or plan.get('aggregateAudit') != _QUEUED_STOP_AUDIT:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    for key, name in (('ownedManifest', 'owned-roots.json'), ('sourceManifest', 'source-pins.json')):
        value = window.get(key)
        if not isinstance(value, dict) or set(value) != {'file', 'sha256'} \
                or value.get('file') != name or _SHA256.fullmatch(str(value.get('sha256', ''))) is None:
            raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    carry = window.get('measureCarryover')
    carry_keys = {'window', 'close', 'ownedManifest', 'sourceManifest', 'supervision', 'supervisor',
                  'output', 'measureRootRecovery'}
    if not isinstance(carry, dict) or set(carry) != carry_keys \
            or not _queued_stop_exact_binding(carry.get('close'), {'path', 'sha256'}) \
            or not _queued_stop_exact_binding(carry.get('ownedManifest'), {'path', 'sha256'}) \
            or not _queued_stop_exact_binding(carry.get('sourceManifest'), {'path', 'sha256'}) \
            or not _queued_stop_exact_binding(carry.get('supervision'), {'path', 'sha256'}) \
            or not _queued_stop_exact_binding(carry.get('supervisor'), {'path', 'sha256'}) \
            or not _queued_stop_exact_binding(carry.get('measureRootRecovery'), {'path', 'sha256'}):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    previous_window = carry.get('window')
    output = carry.get('output')
    if not _queued_stop_exact_binding(previous_window, {'path', 'id', 'sha256'}) \
            or previous_window.get('id') != _QUEUED_STOP_MEASURE_WINDOW_ID \
            or previous_window.get('sha256') != _QUEUED_STOP_CARRYOVER['window'] \
            or any(carry[key]['sha256'] != _QUEUED_STOP_CARRYOVER[key]
                   for key in ('close', 'ownedManifest', 'sourceManifest', 'supervision', 'supervisor')) \
            or not isinstance(output, dict) or set(output) != {'path', 'label', 'commandSha256'} \
            or not isinstance(output.get('path'), str) or not Path(output['path']).is_absolute() \
            or _SAFE.fullmatch(str(output.get('label', ''))) is None \
            or _SHA256.fullmatch(str(output.get('commandSha256', ''))) is None:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    if output['commandSha256'] != _QUEUED_STOP_CARRYOVER['output']:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    toolchain = window.get('toolchain'); issuer = window.get('issuer')
    if not isinstance(toolchain, dict) or set(toolchain) != {'node', 'tsxLoader', 'consumerPython'} \
            or any(not _queued_stop_identity_schema(toolchain.get(key))
                   for key in ('node', 'tsxLoader', 'consumerPython')) \
            or not isinstance(issuer, dict) or set(issuer) != {'path', 'sha256', 'fact'} \
            or not _queued_stop_exact_binding(issuer, {'path', 'sha256', 'fact'}) \
            or not _queued_stop_identity_schema(issuer.get('fact')):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    _validate_supervisor_identity(window)
    try: _validate_candidate_repository(window)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    issued, deadline = _queued_stop_times(window)
    if deadline <= now or issued > now + 1:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    return issued, deadline


def _validate_joint_queued_stop_window(window, now):
    required = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-queued-stop-window',
                'owner': 'root', 'state': 'approved', 'phase': 'queued-stop',
                'profile': 'joint', 'n': 105}
    if not isinstance(window, dict) or set(window) != _JOINT_QUEUED_STOP_KEYS \
            or any(window.get(key) != value for key, value in required.items()) \
            or not _uuid4(window.get('id')) or _SAFE.fullmatch(str(window.get('label', ''))) is None \
            or _SAFE.fullmatch(str(window.get('seedLabel', ''))) is None \
            or window.get('limits') != _QUEUED_STOP_LIMITS:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    seed = window.get('seed')
    if not isinstance(seed, dict) or set(seed) != {
            'label', 'metadataSha256', 'snapshotSha256', 'fixtureOwnerSha256'} \
            or seed.get('label') != window['seedLabel'] \
            or any(_SHA256.fullmatch(str(seed.get(key, ''))) is None
                   for key in ('metadataSha256', 'snapshotSha256', 'fixtureOwnerSha256')):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    plan = window.get('queuedStopPlan')
    plan_keys = {'warmupCount', 'formalCount', 'sampleCount', 'activeCloneMaximum',
                 'snapshotBytes', 'evidenceAllowanceBytes', 'plannedBytes', 'model', 'aggregateAudit'}
    try: expected_planned = _queued_stop_planned_bytes(plan.get('snapshotBytes'))
    except (AttributeError, ValueError) as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    if not isinstance(plan, dict) or set(plan) != plan_keys \
            or plan.get('warmupCount') != 5 or plan.get('formalCount') != 100 \
            or plan.get('sampleCount') != 105 or plan.get('activeCloneMaximum') != 1 \
            or plan.get('evidenceAllowanceBytes') != _QUEUED_STOP_ALLOWANCE \
            or plan.get('plannedBytes') != expected_planned \
            or plan.get('model') != _QUEUED_STOP_MODEL or plan.get('aggregateAudit') != _QUEUED_STOP_AUDIT:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    for key, name in (('ownedManifest', 'owned-roots.json'), ('sourceManifest', 'source-pins.json')):
        value = window.get(key)
        if not isinstance(value, dict) or set(value) != {'file', 'sha256'} \
                or value.get('file') != name or _SHA256.fullmatch(str(value.get('sha256', ''))) is None:
            raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    carry = window.get('measureCarryover')
    if not isinstance(carry, dict) or set(carry) != {
            'window', 'close', 'ownedManifest', 'sourceManifest', 'supervision', 'supervisor', 'output'} \
            or not _queued_stop_exact_binding(carry.get('window'), {'path', 'id', 'sha256'}) \
            or not _uuid4(carry['window'].get('id')) \
            or any(not _queued_stop_exact_binding(carry.get(key), {'path', 'sha256'})
                   for key in ('close', 'ownedManifest', 'sourceManifest', 'supervision', 'supervisor')) \
            or not isinstance(carry.get('output'), dict) \
            or set(carry['output']) != {'path', 'label', 'commandSha256'} \
            or not isinstance(carry['output'].get('path'), str) \
            or not Path(carry['output']['path']).is_absolute() \
            or _SAFE.fullmatch(str(carry['output'].get('label', ''))) is None \
            or _SHA256.fullmatch(str(carry['output'].get('commandSha256', ''))) is None:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    toolchain = window.get('toolchain'); issuer = window.get('issuer')
    if not isinstance(toolchain, dict) or set(toolchain) != {'node', 'tsxLoader', 'consumerPython'} \
            or any(not _queued_stop_identity_schema(toolchain.get(key))
                   for key in ('node', 'tsxLoader', 'consumerPython')) \
            or not isinstance(issuer, dict) or set(issuer) != {'path', 'sha256', 'fact'} \
            or not _queued_stop_exact_binding(issuer, {'path', 'sha256', 'fact'}) \
            or not _queued_stop_identity_schema(issuer.get('fact')):
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    _validate_supervisor_identity(window)
    try: _validate_candidate_repository(window)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    issued, deadline = _queued_stop_times(window)
    if deadline <= now or issued > now + 1:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    return issued, deadline


def _validate_queued_stop_bound_file(binding, expected_path=None, executable=False, maximum=32 * 1024 * 1024):
    if not _queued_stop_identity_schema(binding):
        raise ValueError('QUEUED_STOP_IDENTITY')
    supplied = Path(binding['path'])
    try:
        canonical = supplied.resolve(strict=True); identity = _strict_identity(supplied, maximum)
    except (OSError, ValueError) as error:
        raise ValueError('QUEUED_STOP_IDENTITY') from error
    if supplied != canonical or expected_path is not None \
            and canonical != Path(expected_path).resolve(strict=True) \
            or identity['sha256'] != binding['sha256'] \
            or executable and not os.access(canonical, os.X_OK):
        raise ValueError('QUEUED_STOP_IDENTITY')
    return identity


def _validate_queued_stop_issuer_failures(carryover, runtime):
    runtime = Path(runtime).resolve(strict=True)
    if not isinstance(carryover, list) or not carryover or len(carryover) > 64:
        raise ValueError('QUEUED_STOP_ISSUER_FAILURE')
    discovered = set()
    try: entries = sorted(runtime.iterdir(), key=lambda value: value.name)
    except OSError as error: raise ValueError('QUEUED_STOP_ISSUER_FAILURE_AUDIT') from error
    for entry in entries:
        failure_path = entry / 'issuer-failure.json'
        try: entry_info = entry.lstat()
        except OSError as error: raise ValueError('QUEUED_STOP_ISSUER_FAILURE_AUDIT') from error
        if not stat.S_ISDIR(entry_info.st_mode) or entry.is_symlink():
            if failure_path.exists() or failure_path.is_symlink():
                raise ValueError('QUEUED_STOP_ISSUER_FAILURE_AUDIT')
            continue
        if not failure_path.exists() and not failure_path.is_symlink():
            continue
        try: failure, _ = _strict_json(failure_path, 1024 * 1024)
        except ValueError as error: raise ValueError('QUEUED_STOP_ISSUER_FAILURE_AUDIT') from error
        if not isinstance(failure, dict) or not isinstance(failure.get('scope'), str):
            raise ValueError('QUEUED_STOP_ISSUER_FAILURE_AUDIT')
        if failure['scope'] == 'musicbridge-capacity-queued-stop-authority-issuer-failure':
            discovered.add(str(failure_path))
    expected_row_keys = {'root', 'windowId', 'windowDirName', 'label', 'errorCode', 'files'}
    core_file_keys = {'owner', 'supervisor', 'issuerFact', 'failure'}
    optional_roles = {'source-pins.json': 'sourceManifest', 'owned-roots.json': 'ownedManifest',
                      'window.pending.json': 'pendingWindow', 'window.json': 'window'}
    expected_failure_keys = {'schemaVersion', 'scope', 'state', 'windowId', 'windowDirName',
                             'label', 'errorCode', 'authorityFilesCreated', 'windowWritten',
                             'replayAllowed', 'recordedAt'}
    roots = []; snapshots = []; declared = set()
    seen_roots = set(); seen_windows = set(); seen_dirs = set(); seen_labels = set()
    for row in carryover:
        if not _queued_exact(row, expected_row_keys) or not _uuid4(row.get('windowId')) \
                or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', str(row.get('windowDirName', '')), re.ASCII) is None \
                or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', str(row.get('label', '')), re.ASCII) is None \
                or re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', str(row.get('errorCode', '')), re.ASCII) is None \
                or not isinstance(row.get('files'), dict) \
                or not core_file_keys <= set(row['files']) <= core_file_keys | set(optional_roles.values()):
            raise ValueError('QUEUED_STOP_ISSUER_FAILURE')
        root = Path(str(row['root'])); window_id = row['windowId']; directory = row['windowDirName']
        label = row['label']; files = row['files']; issuer_identity = root / 'issuer-identity'
        try:
            root_info = root.lstat(); canonical = root.resolve(strict=True)
            issuer_info = issuer_identity.lstat(); issuer_canonical = issuer_identity.resolve(strict=True)
            root_entries = {value.name for value in root.iterdir()}
            issuer_entries = {value.name for value in issuer_identity.iterdir()}
            root_after = root.lstat(); issuer_after = issuer_identity.lstat()
        except OSError as error:
            raise ValueError('QUEUED_STOP_ISSUER_FAILURE') from error
        if not root.is_absolute() or root.is_symlink() or canonical != root \
                or not stat.S_ISDIR(root_info.st_mode) or root.parent != runtime or root != runtime / directory \
                or issuer_identity.is_symlink() or issuer_canonical != issuer_identity \
                or not stat.S_ISDIR(issuer_info.st_mode) \
                or any(getattr(root_info, key) != getattr(root_after, key)
                       for key in ('st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')) \
                or any(getattr(issuer_info, key) != getattr(issuer_after, key)
                       for key in ('st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')) \
                or issuer_entries != {'owner.json'} or str(root) in seen_roots \
                or window_id in seen_windows or directory in seen_dirs or label in seen_labels:
            raise ValueError('QUEUED_STOP_ISSUER_FAILURE')
        identities = {
            'owner': _validate_queued_stop_bound_file(files['owner'], root / 'owner.json', maximum=1024 * 1024),
            'supervisor': _validate_queued_stop_bound_file(files['supervisor'], root / 'supervisor.py'),
            'issuerFact': _validate_queued_stop_bound_file(
                files['issuerFact'], issuer_identity / 'owner.json', maximum=1024 * 1024),
            'failure': _validate_queued_stop_bound_file(
                files['failure'], root / 'issuer-failure.json', maximum=1024 * 1024),
        }
        try:
            owner, owner_identity = _strict_json(root / 'owner.json', 1024 * 1024)
            issuer_fact, issuer_fact_identity = _strict_json(issuer_identity / 'owner.json', 1024 * 1024)
            failure, failure_identity = _strict_json(root / 'issuer-failure.json', 1024 * 1024)
            recorded = datetime.datetime.fromisoformat(str(failure.get('recordedAt')))
        except (ValueError, TypeError) as error:
            raise ValueError('QUEUED_STOP_ISSUER_FAILURE') from error
        core_created = ['owner.json', 'supervisor.py', 'issuer-identity/owner.json']
        allowed_created = [core_created, [*core_created, 'source-pins.json'],
                           [*core_created, 'source-pins.json', 'owned-roots.json'],
                           [*core_created, 'source-pins.json', 'owned-roots.json', 'window.pending.json'],
                           [*core_created, 'source-pins.json', 'owned-roots.json', 'window.json']]
        created = failure.get('authorityFilesCreated') if isinstance(failure, dict) else None
        expected_optional = {role for name, role in optional_roles.items() if name in (created or [])}
        expected_parent_entries = {'owner.json', 'supervisor.py', 'issuer-identity', 'issuer-failure.json'} \
            | {name for name in optional_roles if name in (created or [])}
        if identities['owner'] != owner_identity or identities['issuerFact'] != issuer_fact_identity \
                or identities['failure'] != failure_identity \
                or owner != {'scope': 'musicbridge-capacity-queued-stop-window', 'owner': 'root', 'id': window_id} \
                or not isinstance(issuer_fact, dict) or issuer_fact.get('schemaVersion') != 1 \
                or issuer_fact.get('scope') != 'musicbridge-capacity-queued-stop-authority-issuer' \
                or issuer_fact.get('windowId') != window_id \
                or not _queued_exact(failure, expected_failure_keys) or failure.get('schemaVersion') != 1 \
                or failure.get('scope') != 'musicbridge-capacity-queued-stop-authority-issuer-failure' \
                or failure.get('state') != 'TERMINAL_ISSUER_FAILURE' \
                or failure.get('windowId') != window_id or failure.get('windowDirName') != directory \
                or failure.get('label') != label or failure.get('errorCode') != row['errorCode'] \
                or created not in allowed_created or set(files) != core_file_keys | expected_optional \
                or root_entries != expected_parent_entries \
                or failure.get('windowWritten') is not ('window.json' in created) \
                or failure.get('replayAllowed') is not False \
                or recorded.utcoffset() is None:
            raise ValueError('QUEUED_STOP_ISSUER_FAILURE')
        for name, role in optional_roles.items():
            if role not in expected_optional: continue
            identities[role] = _validate_queued_stop_bound_file(
                files[role], root / name, maximum=32 * 1024 * 1024)
            try: value, value_identity = _strict_json(root / name, 32 * 1024 * 1024)
            except ValueError as error: raise ValueError('QUEUED_STOP_ISSUER_FAILURE') from error
            if identities[role] != value_identity or not isinstance(value, dict) \
                    or value.get('schemaVersion') != 1 \
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
                raise ValueError('QUEUED_STOP_ISSUER_FAILURE')
        root_row = {'path': str(root), 'device': root_info.st_dev, 'inode': root_info.st_ino,
                    'marker': {'relative': 'owner.json', 'sha256': identities['owner']['sha256']}}
        roots.append(root_row)
        root_identity = {'path': str(root), 'device': root_info.st_dev, 'inode': root_info.st_ino,
                         'mtimeNs': root_info.st_mtime_ns, 'ctimeNs': root_info.st_ctime_ns,
                         'entries': sorted(root_entries)}
        issuer_directory_identity = {
            'path': str(issuer_identity), 'device': issuer_info.st_dev, 'inode': issuer_info.st_ino,
            'mtimeNs': issuer_info.st_mtime_ns, 'ctimeNs': issuer_info.st_ctime_ns,
            'entries': sorted(issuer_entries)}
        snapshots.append({'root': root_row, 'rootIdentity': root_identity,
                          'issuerIdentity': issuer_directory_identity,
                          'windowId': window_id, 'windowDirName': directory,
                          'label': label, 'errorCode': row['errorCode'], 'files': identities})
        seen_roots.add(str(root)); seen_windows.add(window_id); seen_dirs.add(directory)
        seen_labels.add(label); declared.add(str(root / 'issuer-failure.json'))
    if declared != discovered:
        raise ValueError('QUEUED_STOP_ISSUER_FAILURE_AUDIT')
    ordered = sorted(zip(roots, snapshots), key=lambda value: value[0]['path'])
    return {'roots': [root for root, _ in ordered], 'snapshots': [snapshot for _, snapshot in ordered]}


def _validate_queued_stop_prechild_failures(carryover, runtime):
    runtime = Path(runtime).resolve(strict=True)
    if not isinstance(carryover, list) or not carryover or len(carryover) > 64:
        raise ValueError('QUEUED_STOP_PRECHILD_FAILURE')
    discovered = set()
    try: entries = sorted(runtime.iterdir(), key=lambda value: value.name)
    except OSError as error: raise ValueError('QUEUED_STOP_PRECHILD_FAILURE_AUDIT') from error
    for entry in entries:
        failure_path = entry / 'prechild-failure.json'
        if not entry.is_dir() or entry.is_symlink():
            if failure_path.exists() or failure_path.is_symlink():
                raise ValueError('QUEUED_STOP_PRECHILD_FAILURE_AUDIT')
            continue
        if not failure_path.exists() and not failure_path.is_symlink(): continue
        try: failure, _ = _strict_json(failure_path, 1024 * 1024)
        except ValueError as error: raise ValueError('QUEUED_STOP_PRECHILD_FAILURE_AUDIT') from error
        if not isinstance(failure, dict) or not isinstance(failure.get('scope'), str):
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE_AUDIT')
        if failure['scope'] != 'musicbridge-capacity-queued-stop-prechild-failure':
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE_AUDIT')
        discovered.add(str(failure_path))
    row_keys = {'root', 'windowId', 'windowDirName', 'label', 'errorCode', 'files'}
    file_keys = {'owner', 'supervisor', 'issuerFact', 'sourceManifest',
                 'ownedManifest', 'window', 'failure'}
    failure_keys = {
        'schemaVersion', 'scope', 'state', 'windowId', 'windowDirName', 'label', 'failure',
        'observedExitCode', 'windowSha256', 'authorityFiles', 'trigger', 'reproduction',
        'authorityAdmission', 'supervisionStarted', 'benchmarkStarted', 'childSpawned',
        'outputCreated', 'sampleCount', 'windowConsumed', 'deviceOpened', 'formalReady',
        'gateB', 'replayAllowed', 'replayPolicy', 'recovery', 'recordedAt'}
    roots = []; snapshots = []; declared = set()
    seen_roots = set(); seen_windows = set(); seen_dirs = set(); seen_labels = set()
    for row in carryover:
        if not _queued_exact(row, row_keys) or not isinstance(row.get('root'), str) \
                or not isinstance(row.get('windowDirName'), str) \
                or not isinstance(row.get('label'), str) or not _uuid4(row.get('windowId')) \
                or _SAFE.fullmatch(row['windowDirName']) is None \
                or _SAFE.fullmatch(row['label']) is None \
                or row.get('errorCode') != 'QUEUED_STOP_REPLAY_AUDIT_TYPE_ERROR' \
                or not isinstance(row.get('files'), dict) or set(row['files']) != file_keys \
                or any(not _queued_exact(binding, {'path', 'sha256'})
                       or not isinstance(binding.get('path'), str)
                       or _SHA256.fullmatch(str(binding.get('sha256', ''))) is None
                       for binding in row['files'].values()):
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE')
        root = Path(row['root']); window_id = row['windowId']; directory = row['windowDirName']
        label = row['label']; files = row['files']; issuer_identity = root / 'issuer-identity'
        expected_entries = {'owner.json', 'supervisor.py', 'issuer-identity', 'source-pins.json',
                            'owned-roots.json', 'window.json', 'prechild-failure.json'}
        try:
            root_info = root.lstat(); canonical = root.resolve(strict=True)
            issuer_info = issuer_identity.lstat(); issuer_canonical = issuer_identity.resolve(strict=True)
            root_entries = {value.name for value in root.iterdir()}
            issuer_entries = {value.name for value in issuer_identity.iterdir()}
        except OSError as error: raise ValueError('QUEUED_STOP_PRECHILD_FAILURE') from error
        if not root.is_absolute() or root.is_symlink() or canonical != root or root.parent != runtime \
                or root != runtime / directory or not stat.S_ISDIR(root_info.st_mode) \
                or issuer_identity.is_symlink() or issuer_canonical != issuer_identity \
                or not stat.S_ISDIR(issuer_info.st_mode) or root_entries != expected_entries \
                or issuer_entries != {'owner.json'} or str(root) in seen_roots \
                or window_id in seen_windows or directory in seen_dirs or label in seen_labels:
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE')
        identities = {
            'owner': _validate_queued_stop_bound_file(files['owner'], root / 'owner.json', maximum=1024 * 1024),
            'supervisor': _validate_queued_stop_bound_file(files['supervisor'], root / 'supervisor.py'),
            'issuerFact': _validate_queued_stop_bound_file(
                files['issuerFact'], issuer_identity / 'owner.json', maximum=1024 * 1024),
            'sourceManifest': _validate_queued_stop_bound_file(files['sourceManifest'], root / 'source-pins.json'),
            'ownedManifest': _validate_queued_stop_bound_file(files['ownedManifest'], root / 'owned-roots.json'),
            'window': _validate_queued_stop_bound_file(files['window'], root / 'window.json'),
            'failure': _validate_queued_stop_bound_file(
                files['failure'], root / 'prechild-failure.json', maximum=1024 * 1024),
        }
        try:
            owner, owner_identity = _strict_json(root / 'owner.json', 1024 * 1024)
            issuer_fact, issuer_fact_identity = _strict_json(issuer_identity / 'owner.json', 1024 * 1024)
            source, source_identity = _strict_json(root / 'source-pins.json')
            owned, owned_identity = _strict_json(root / 'owned-roots.json')
            window, window_identity = _strict_json(root / 'window.json')
            failure, failure_identity = _strict_json(root / 'prechild-failure.json', 1024 * 1024)
            if not all(isinstance(value, dict) for value in
                       (owner, issuer_fact, source, owned, window, failure)):
                raise ValueError('schema')
            recorded = datetime.datetime.fromisoformat(str(failure.get('recordedAt')))
        except (AttributeError, OSError, ValueError, TypeError) as error:
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE') from error
        authority = failure.get('authorityFiles') if isinstance(failure, dict) else None
        trigger = failure.get('trigger') if isinstance(failure, dict) else None
        recovery = failure.get('recovery') if isinstance(failure, dict) else None
        expected_authority = {
            'ownerSha256': files['owner']['sha256'], 'supervisorSha256': files['supervisor']['sha256'],
            'issuerFactSha256': files['issuerFact']['sha256'],
            'sourceManifestSha256': files['sourceManifest']['sha256'],
            'ownedManifestSha256': files['ownedManifest']['sha256']}
        if any(identities[key] != observed for key, observed in (
                ('owner', owner_identity), ('issuerFact', issuer_fact_identity),
                ('sourceManifest', source_identity), ('ownedManifest', owned_identity),
                ('window', window_identity), ('failure', failure_identity))) \
                or owner != {'scope': 'musicbridge-capacity-queued-stop-window', 'owner': 'root', 'id': window_id} \
                or not isinstance(window, dict) or window.get('schemaVersion') != 1 \
                or window.get('scope') != 'musicbridge-capacity-queued-stop-window' \
                or window.get('id') != window_id or window.get('label') != label \
                or window.get('state') != 'approved' or window.get('phase') != 'queued-stop' \
                or window.get('profile') != 'objects-limit' \
                or window.get('supervisor') != {'path': str(root / 'supervisor.py'),
                                                'sha256': files['supervisor']['sha256']} \
                or window.get('sourceManifest') != {'file': 'source-pins.json',
                                                    'sha256': files['sourceManifest']['sha256']} \
                or window.get('ownedManifest') != {'file': 'owned-roots.json',
                                                   'sha256': files['ownedManifest']['sha256']} \
                or not isinstance(issuer_fact, dict) or issuer_fact.get('schemaVersion') != 1 \
                or issuer_fact.get('scope') != 'musicbridge-capacity-queued-stop-authority-issuer' \
                or issuer_fact.get('windowId') != window_id \
                or issuer_fact.get('candidateRepository') != window.get('candidateRepository') \
                or not _queued_exact(source, {'schemaVersion', 'scope', 'files'}) \
                or source.get('schemaVersion') != 1 \
                or source.get('scope') != 'musicbridge-capacity-source-pins' \
                or not isinstance(source.get('files'), dict) \
                or not _queued_exact(owned, {'schemaVersion', 'scope', 'access', 'windowId', 'roots'}) \
                or owned.get('schemaVersion') != 1 \
                or owned.get('scope') != 'musicbridge-capacity-owned-roots' \
                or owned.get('access') != 'count-only' or owned.get('windowId') != window_id \
                or not isinstance(owned.get('roots'), list) or not _queued_exact(failure, failure_keys) \
                or failure.get('schemaVersion') != 1 \
                or failure.get('scope') != 'musicbridge-capacity-queued-stop-prechild-failure' \
                or failure.get('state') != 'TERMINAL_PRECHILD_CONTROL_FAILURE' \
                or failure.get('windowId') != window_id or failure.get('windowDirName') != directory \
                or failure.get('label') != label or failure.get('failure') != row['errorCode'] \
                or failure.get('observedExitCode') != 1 \
                or failure.get('windowSha256') != files['window']['sha256'] \
                or authority != expected_authority \
                or failure.get('reproduction') != {
                    'type': 'TypeError', 'messageCode': 'UNHASHABLE_DICT',
                    'fullRuntimeReproduced': True, 'isolatedWitnessReproduced': True} \
                or failure.get('authorityAdmission') != 'NOT_RUN' \
                or any(failure.get(key) is not False for key in (
                    'supervisionStarted', 'benchmarkStarted', 'childSpawned', 'outputCreated',
                    'deviceOpened', 'formalReady', 'replayAllowed')) \
                or failure.get('sampleCount') != 0 or failure.get('windowConsumed') is not True \
                or failure.get('gateB') != 'NOT_RUN' \
                or failure.get('replayPolicy') != 'terminal-window-id-and-label-never-reuse' \
                or not isinstance(trigger, dict) \
                or set(trigger) != {'path', 'sha256', 'scope', 'windowId', 'label', 'fieldType', 'role'} \
                or trigger.get('scope') != 'musicbridge-capacity-generation-close' \
                or trigger.get('fieldType') != 'dict' \
                or trigger.get('role') != 'isolated-reproduction-witness-not-historical-order' \
                or any(not isinstance(trigger.get(key), str) for key in (
                    'path', 'sha256', 'scope', 'windowId', 'label', 'fieldType', 'role')) \
                or not isinstance(recovery, dict) \
                or set(recovery) != {'repositoryRoot', 'branch', 'head', 'scriptPath',
                                     'scriptRelativePath', 'scriptSha256'} \
                or any(not isinstance(recovery.get(key), str) for key in (
                    'repositoryRoot', 'branch', 'head', 'scriptPath',
                    'scriptRelativePath', 'scriptSha256')) \
                or not 1 <= len(recovery.get('branch', '')) <= 255 \
                or recovery.get('scriptRelativePath') != \
                    'scripts/ci/terminalize-v3-capacity-queued-stop-prechild.py' \
                or _GIT_SHA.fullmatch(str(recovery.get('head', ''))) is None \
                or _SHA256.fullmatch(str(recovery.get('scriptSha256', ''))) is None \
                or recorded.utcoffset() is None:
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE')
        trigger_path = Path(str(trigger.get('path', '')))
        try:
            trigger_value, trigger_identity = _strict_json(trigger_path)
            trigger_canonical = trigger_path.resolve(strict=True)
        except (OSError, TypeError, ValueError) as error:
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE') from error
        nested = trigger_value.get('window') if isinstance(trigger_value, dict) else None
        if not trigger_path.is_absolute() or trigger_path.is_symlink() \
                or trigger_canonical != trigger_path or trigger_path.parent != runtime \
                or not trigger_path.name.endswith('-close.json') \
                or trigger_identity['sha256'] != trigger.get('sha256') \
                or not isinstance(trigger_value, dict) \
                or trigger_value.get('scope') != trigger.get('scope') or not isinstance(nested, dict) \
                or nested.get('id') != trigger.get('windowId') or nested.get('label') != trigger.get('label'):
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE')
        try:
            recovery_root = Path(recovery['repositoryRoot'])
            recovery_script = Path(recovery['scriptPath'])
            recovery_canonical = recovery_root.resolve(strict=True)
        except (OSError, TypeError, ValueError) as error:
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE') from error
        if not recovery_root.is_absolute() or recovery_canonical != recovery_root \
                or recovery_root.is_symlink() \
                or recovery_script != recovery_root / recovery['scriptRelativePath']:
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE')
        try:
            script_blob = _git_blob(
                recovery_root, f"{recovery['head']}:{recovery['scriptRelativePath']}")
        except ValueError as error:
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE') from error
        if hashlib.sha256(script_blob).hexdigest() != recovery['scriptSha256']:
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE')
        try:
            root_after = root.lstat(); issuer_after = issuer_identity.lstat()
            root_entries_after = {value.name for value in root.iterdir()}
            issuer_entries_after = {value.name for value in issuer_identity.iterdir()}
            identities_after = {
                role: _validate_queued_stop_bound_file(
                    files[role],
                    {'owner': root / 'owner.json', 'supervisor': root / 'supervisor.py',
                     'issuerFact': issuer_identity / 'owner.json',
                     'sourceManifest': root / 'source-pins.json',
                     'ownedManifest': root / 'owned-roots.json', 'window': root / 'window.json',
                     'failure': root / 'prechild-failure.json'}[role],
                    maximum=1024 * 1024 if role in {'owner', 'issuerFact', 'failure'} else None)
                for role in files}
        except (OSError, TypeError, ValueError) as error:
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE') from error
        directory_fields = ('st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
        if any(getattr(root_info, key) != getattr(root_after, key) for key in directory_fields) \
                or any(getattr(issuer_info, key) != getattr(issuer_after, key) for key in directory_fields) \
                or root_entries_after != expected_entries or issuer_entries_after != {'owner.json'} \
                or identities_after != identities:
            raise ValueError('QUEUED_STOP_PRECHILD_FAILURE')
        root_row = {'path': str(root), 'device': root_info.st_dev, 'inode': root_info.st_ino,
                    'marker': {'relative': 'owner.json', 'sha256': identities['owner']['sha256']}}
        roots.append(root_row)
        snapshots.append({
            'root': root_row,
            'rootIdentity': {'path': str(root), 'device': root_info.st_dev, 'inode': root_info.st_ino,
                             'mtimeNs': root_info.st_mtime_ns, 'ctimeNs': root_info.st_ctime_ns,
                             'nlink': root_info.st_nlink,
                             'entries': sorted(root_entries)},
            'issuerIdentity': {'path': str(issuer_identity), 'device': issuer_info.st_dev,
                               'inode': issuer_info.st_ino, 'mtimeNs': issuer_info.st_mtime_ns,
                               'ctimeNs': issuer_info.st_ctime_ns, 'nlink': issuer_info.st_nlink,
                               'entries': sorted(issuer_entries)},
            'windowId': window_id, 'windowDirName': directory, 'label': label,
            'errorCode': row['errorCode'], 'trigger': trigger_identity, 'files': identities})
        seen_roots.add(str(root)); seen_windows.add(window_id); seen_dirs.add(directory)
        seen_labels.add(label); declared.add(str(root / 'prechild-failure.json'))
    if declared != discovered:
        raise ValueError('QUEUED_STOP_PRECHILD_FAILURE_AUDIT')
    ordered = sorted(zip(roots, snapshots), key=lambda value: value[0]['path'])
    return {'roots': [root for root, _ in ordered], 'snapshots': [snapshot for _, snapshot in ordered]}


def _queued_stop_process_authority(value, window, window_identity, owner_identity,
                                   source_count, owned_count, remaining):
    keys = {
        'authorityStable', 'windowStable', 'ownerStable', 'sourceManifestStable',
        'ownedManifestStable', 'sourcePinsValid', 'ownedRootsValid',
        'measureCarryoverValid', 'issuerFailureCarryoverValid',
        'prechildFailureCarryoverValid', 'spaceValid', 'windowSha256Observed',
        'ownerSha256Observed', 'sourceFileCount', 'ownedRootCount',
        'issuerFailureCount', 'prechildFailureCount', 'ownedBytes', 'plannedBytes',
        'remainingPlannedBytes', 'availableBytes', 'candidateRepository',
        'toolchainStable', 'issuerStable'}
    stable = {
        'authorityStable', 'windowStable', 'ownerStable', 'sourceManifestStable',
        'ownedManifestStable', 'sourcePinsValid', 'ownedRootsValid',
        'measureCarryoverValid', 'issuerFailureCarryoverValid',
        'prechildFailureCarryoverValid', 'spaceValid', 'toolchainStable', 'issuerStable'}
    process_count = window.get('processFailureCarryoverCount')
    if process_count is not None:
        keys |= {'processFailureCarryoverValid', 'processFailureCount'}
        stable.add('processFailureCarryoverValid')
    planned = window['queuedStopPlan']['plannedBytes']
    # window字段是direct head数；递归深度在完整链收集后由canonical evaluator精确核对。
    return _queued_exact(value, keys) \
        and all(value.get(key) is True for key in stable) \
        and value.get('windowSha256Observed') == window_identity['sha256'] \
        and value.get('ownerSha256Observed') == owner_identity['sha256'] \
        and value.get('sourceFileCount') == source_count \
        and value.get('ownedRootCount') == owned_count \
        and value.get('issuerFailureCount') == window['issuerFailureCarryoverCount'] \
        and value.get('prechildFailureCount') == window['prechildFailureCarryoverCount'] \
        and (process_count is None or type(value.get('processFailureCount')) is int
             and 1 <= value['processFailureCount'] <= 64) \
        and value.get('candidateRepository') == window['candidateRepository'] \
        and value.get('plannedBytes') == planned \
        and value.get('remainingPlannedBytes') == remaining \
        and type(value.get('ownedBytes')) is int and value['ownedBytes'] >= 0 \
        and type(value.get('availableBytes')) is int and value['availableBytes'] >= 0 \
        and value['ownedBytes'] + remaining <= _QUEUED_STOP_LIMITS['maximumOwnedBytes'] \
        and value['availableBytes'] - remaining >= _QUEUED_STOP_LIMITS['minimumFreeBytes']


def _validate_queued_stop_process_failures(
        carryover, runtime, lineage_contract=None, runtime_relocation=None):
    """冻结已消费且PROCESS_EXIT的queued-stop authority；历史owned schema不得升级或重写。"""
    error_code = 'QUEUED_STOP_PROCESS_FAILURE'
    audit_code = 'QUEUED_STOP_PROCESS_FAILURE_AUDIT'
    runtime = Path(runtime).resolve(strict=True)
    if not isinstance(carryover, list) or not carryover or len(carryover) > 64:
        raise ValueError(error_code)
    discovered = set()
    try: entries = sorted(runtime.iterdir(), key=lambda value: value.name)
    except OSError as error: raise ValueError(audit_code) from error
    for entry in entries:
        close_path = entry / 'close.json'
        try: entry_info = entry.lstat()
        except OSError as error: raise ValueError(audit_code) from error
        if not stat.S_ISDIR(entry_info.st_mode) or entry.is_symlink():
            if close_path.exists() or close_path.is_symlink():
                raise ValueError(audit_code)
            continue
        if not close_path.exists() and not close_path.is_symlink():
            continue
        try: close, _ = _strict_json(close_path, 8 * 1024 * 1024)
        except ValueError as error: raise ValueError(audit_code) from error
        if not isinstance(close, dict) or not isinstance(close.get('scope'), str):
            raise ValueError(audit_code)
        if close.get('scope') == 'musicbridge-capacity-queued-stop-window-close' \
                and close.get('state') == 'failed' and close.get('failure') == 'PROCESS_EXIT':
            discovered.add(str(close_path))
    row_keys = {'root', 'windowId', 'windowDirName', 'label', 'failure', 'code',
                'sampleCount', 'deviceOpened', 'formalReady', 'gateB', 'files'}
    file_keys = {'owner', 'supervisor', 'issuerFact', 'sourceManifest', 'ownedManifest',
                 'window', 'close', 'supervision', 'supervisorStart', 'stdout', 'stderr'}
    window_keys = _QUEUED_STOP_KEYS - {'processFailureCarryoverCount'}
    fact_keys = {'schemaVersion', 'scope', 'windowId', 'issuerRepository', 'candidateRepository',
                 'supervisorSource', 'toolchain', 'buildHelper', 'buildToolchain', 'build',
                 'issuerFailureCarryover', 'prechildFailureCarryover', 'measureCarryover'}
    close_keys = {'schemaVersion', 'scope', 'windowId', 'profile', 'label', 'seedLabel',
                  'closedAt', 'state', 'failure', 'pid', 'pgid', 'managedProcessGroup',
                  'code', 'exitSignal', 'signals', 'groupEmpty', 'zombies', 'elapsedMs',
                  'windowSha256', 'sourceManifestSha256', 'ownedManifestSha256', 'seed',
                  'measureCarryover', 'authorityAdmission', 'authorityTerminal', 'queuedStop',
                  'supervisorSha256', 'stdout', 'stderr', 'deviceOpened', 'formalReady',
                  'gateB', 'replayPolicy'}
    supervision_keys = {'passed', 'failure', 'pid', 'pgid', 'code', 'exitSignal', 'signals',
                        'groupEmpty', 'zombies', 'elapsedMs', 'managedProcessGroup',
                        'stdout', 'stderr', 'queuedStop'}
    start_keys = {'pid', 'pgid', 'command', 'managedProcessGroup', 'startedMonotonic',
                  'deadlineMonotonic', 'cwd', 'environmentKeys', 'environment', 'stdin',
                  'stdout', 'stderr'}
    queued_keys = {'outputDirectory', 'verifiedComplete', 'verifiedPassed', 'fileCount',
                   'sampleCount', 'uniqueChildPids', 'aggregateBudgetValid', 'unexpectedEntries'}
    roots = []; billing_roots = []; snapshots = []; declared = set(); seen = set()
    lineage_nodes = []; direct_root_ids = []
    seen_windows = set(); seen_dirs = set(); seen_labels = set()
    if len(carryover) != 1:
        raise ValueError(error_code)
    pending = [(carryover[0], None, True)]
    while pending:
        row, successor_issued_at, is_head = pending.pop(0)
        row = _relocate_runtime_value(
            row, runtime_relocation, runtime, error_code) if runtime_relocation else row
        if not _queued_exact(row, row_keys) or row.get('failure') != 'PROCESS_EXIT' \
                or row.get('code') != 1 or row.get('sampleCount') != 0 \
                or row.get('deviceOpened') is not False or row.get('formalReady') is not False \
                or row.get('gateB') != 'NOT_RUN' \
                or not _uuid4(row.get('windowId')) \
                or _SAFE.fullmatch(str(row.get('windowDirName', ''))) is None \
                or _SAFE.fullmatch(str(row.get('label', ''))) is None \
                or not isinstance(row.get('root'), str) \
                or not isinstance(row.get('files'), dict) or set(row['files']) != file_keys \
                or any(not _queued_stop_exact_binding(binding, {'path', 'sha256'})
                       for binding in row['files'].values()):
            raise ValueError(error_code)
        root = Path(row['root']); window_id = row['windowId']; label = row['label']
        issuer_directory = root / 'issuer-identity'; supervision_directory = root / 'supervision'
        expected_entries = {'owner.json', 'supervisor.py', 'issuer-identity', 'source-pins.json',
                            'owned-roots.json', 'window.json', 'supervision', 'close.json'}
        supervision_entries = {'supervisor.json', 'supervisor-start.json', 'stdout.log', 'stderr.log'}
        try:
            root_info = root.lstat(); issuer_info = issuer_directory.lstat()
            supervision_info = supervision_directory.lstat()
            root_canonical = root.resolve(strict=True)
            issuer_canonical = issuer_directory.resolve(strict=True)
            supervision_canonical = supervision_directory.resolve(strict=True)
            root_entries = {entry.name for entry in root.iterdir()}
            issuer_entries = {entry.name for entry in issuer_directory.iterdir()}
            observed_supervision_entries = {entry.name for entry in supervision_directory.iterdir()}
        except OSError as error: raise ValueError(error_code) from error
        if not root.is_absolute() or root.is_symlink() or root_canonical != root \
                or root.parent != runtime or root != runtime / row['windowDirName'] \
                or not stat.S_ISDIR(root_info.st_mode) or root_entries != expected_entries \
                or issuer_directory.is_symlink() or issuer_canonical != issuer_directory \
                or not stat.S_ISDIR(issuer_info.st_mode) or issuer_entries != {'owner.json'} \
                or supervision_directory.is_symlink() or supervision_canonical != supervision_directory \
                or not stat.S_ISDIR(supervision_info.st_mode) \
                or observed_supervision_entries != supervision_entries \
                or str(root) in seen or window_id in seen_windows \
                or row['windowDirName'] in seen_dirs or label in seen_labels:
            raise ValueError(error_code)
        files = row['files']
        expected_paths = {
            'owner': root / 'owner.json', 'supervisor': root / 'supervisor.py',
            'issuerFact': issuer_directory / 'owner.json', 'sourceManifest': root / 'source-pins.json',
            'ownedManifest': root / 'owned-roots.json', 'window': root / 'window.json',
            'close': root / 'close.json', 'supervision': supervision_directory / 'supervisor.json',
            'supervisorStart': supervision_directory / 'supervisor-start.json',
            'stdout': supervision_directory / 'stdout.log', 'stderr': supervision_directory / 'stderr.log'}
        maximums = {'owner': 1024 * 1024, 'issuerFact': 1024 * 1024,
                    'stdout': 64 * 1024, 'stderr': 64 * 1024}
        identities = {role: _validate_queued_stop_bound_file(
            binding, expected_paths[role], maximum=maximums.get(role, 32 * 1024 * 1024))
            for role, binding in files.items()}
        try:
            owner, owner_identity = _strict_json(expected_paths['owner'], 1024 * 1024)
            fact, fact_identity = _strict_json(expected_paths['issuerFact'], 1024 * 1024)
            source, source_identity = _strict_json(expected_paths['sourceManifest'])
            owned, owned_identity = _strict_json(expected_paths['ownedManifest'])
            window, window_identity = _strict_json(expected_paths['window'])
            close, close_identity = _strict_json(expected_paths['close'])
            supervision, supervision_identity = _strict_json(expected_paths['supervision'])
            start, start_identity = _strict_json(expected_paths['supervisorStart'])
            if runtime_relocation:
                owner, fact, source, owned, window, close, supervision, start = (
                    _relocate_runtime_value(document, runtime_relocation, runtime, error_code)
                    for document in (owner, fact, source, owned, window, close, supervision, start))
            stdout_bytes = expected_paths['stdout'].read_bytes()
            stderr_bytes = expected_paths['stderr'].read_bytes()
            closed_at = datetime.datetime.fromisoformat(str(close.get('closedAt')))
            issued_at = datetime.datetime.fromisoformat(str(window.get('issuedAt')))
            deadline_at = datetime.datetime.fromisoformat(str(window.get('deadlineAt')))
        except (OSError, UnicodeDecodeError, ValueError, TypeError) as error:
            raise ValueError(error_code) from error
        if any(identities[role] != identity for role, identity in (
                ('owner', owner_identity), ('issuerFact', fact_identity),
                ('sourceManifest', source_identity), ('ownedManifest', owned_identity),
                ('window', window_identity), ('close', close_identity),
                ('supervision', supervision_identity), ('supervisorStart', start_identity))):
            raise ValueError(error_code)
        source_files = source.get('files') if isinstance(source, dict) else None
        process_carryover = fact.get('processFailureCarryover') if isinstance(fact, dict) else None
        leaf = isinstance(fact, dict) and 'processFailureCarryover' not in fact \
            and 'processFailureCarryoverCount' not in window
        linked = _queued_exact(fact, fact_keys | {'processFailureCarryover'}) \
            and _queued_exact(window, window_keys | {'processFailureCarryoverCount'}) \
            and window.get('processFailureCarryoverCount') == 1 \
            and isinstance(process_carryover, list) and len(process_carryover) == 1
        if not leaf and not linked:
            raise ValueError(error_code)
        expected_owned_count = 75 if leaf else 76
        if owner != {'scope': 'musicbridge-capacity-queued-stop-window', 'owner': 'root', 'id': window_id} \
                or not _queued_exact(source, {'schemaVersion', 'scope', 'files'}) \
                or source.get('schemaVersion') != 1 \
                or source.get('scope') != 'musicbridge-capacity-source-pins' \
                or not isinstance(source_files, dict) or len(source_files) not in (241, 243) \
                or len(source_files) == 243 and any(relative not in source_files for relative in (
                    'scripts/ci/capacity_process_failure_lineage.py',
                    'packages/contracts/capacity-process-failure-lineage-v1.json')) \
                or any(not isinstance(relative, str) or Path(relative).is_absolute()
                       or '..' in Path(relative).parts or _SHA256.fullmatch(str(digest)) is None
                       for relative, digest in source_files.items()):
            raise ValueError(error_code)
        if not _queued_exact(window, window_keys if leaf else
                             window_keys | {'processFailureCarryoverCount'}) \
                or window.get('schemaVersion') != 1 \
                or window.get('scope') != 'musicbridge-capacity-queued-stop-window' \
                or window.get('owner') != 'root' or window.get('id') != window_id \
                or window.get('state') != 'approved' or window.get('phase') != 'queued-stop' \
                or window.get('profile') != 'objects-limit' or window.get('label') != label \
                or window.get('n') != 105 or window.get('limits') != _QUEUED_STOP_LIMITS \
                or window.get('issuerFailureCarryoverCount') != 1 \
                or window.get('prechildFailureCarryoverCount') != 1 \
                or window.get('supervisor') != {'path': str(expected_paths['supervisor']),
                                                'sha256': identities['supervisor']['sha256']} \
                or window.get('sourceManifest') != {'file': 'source-pins.json',
                                                    'sha256': source_identity['sha256']} \
                or window.get('ownedManifest') != {'file': 'owned-roots.json',
                                                   'sha256': owned_identity['sha256']} \
                or issued_at.utcoffset() is None or deadline_at.utcoffset() is None \
                or successor_issued_at is not None and closed_at > successor_issued_at \
                or deadline_at - issued_at != datetime.timedelta(seconds=900):
            raise ValueError(error_code)
        try:
            expected_plan = _queued_stop_planned_bytes(window['queuedStopPlan']['snapshotBytes'])
        except (KeyError, TypeError, ValueError) as error: raise ValueError(error_code) from error
        if window.get('queuedStopPlan') != {
                'warmupCount': 5, 'formalCount': 100, 'sampleCount': 105,
                'activeCloneMaximum': 1, 'snapshotBytes': _QUEUED_STOP_SNAPSHOT_BYTES,
                'evidenceAllowanceBytes': _QUEUED_STOP_ALLOWANCE, 'plannedBytes': expected_plan,
                'model': _QUEUED_STOP_MODEL, 'aggregateAudit': _QUEUED_STOP_AUDIT}:
            raise ValueError(error_code)
        issuer = window.get('issuer'); issuer_repo = fact.get('issuerRepository') if isinstance(fact, dict) else None
        supervisor_source = fact.get('supervisorSource') if isinstance(fact, dict) else None
        candidate = window.get('candidateRepository') if isinstance(window, dict) else None
        toolchain = window.get('toolchain') if isinstance(window, dict) else None
        build_helper = fact.get('buildHelper') if isinstance(fact, dict) else None
        build_toolchain = fact.get('buildToolchain') if isinstance(fact, dict) else None
        build = fact.get('build') if isinstance(fact, dict) else None
        measure_carry = window.get('measureCarryover') if isinstance(window, dict) else None
        identity_shape = lambda value: _queued_stop_identity_schema(value)
        candidate_valid = _queued_exact(candidate, {'root', 'branch', 'head'}) \
            and isinstance(candidate.get('root'), str) and Path(candidate['root']).is_absolute() \
            and isinstance(candidate.get('branch'), str) and 1 <= len(candidate['branch']) <= 255 \
            and _GIT_SHA.fullmatch(str(candidate.get('head', ''))) is not None
        toolchain_valid = _queued_exact(toolchain, {'node', 'tsxLoader', 'consumerPython'}) \
            and all(identity_shape(toolchain.get(key)) for key in ('node', 'tsxLoader', 'consumerPython'))
        build_helper_valid = _queued_exact(build_helper, {'path', 'relativePath', 'sha256'}) \
            and build_helper.get('relativePath') == 'scripts/ci/issue-v3-capacity-window.py' \
            and isinstance(build_helper.get('path'), str) and Path(build_helper['path']).is_absolute() \
            and _SHA256.fullmatch(str(build_helper.get('sha256', ''))) is not None
        build_toolchain_valid = _queued_exact(
            build_toolchain, {'node', 'nodeLibrary', 'typescriptCompiler',
                              'typescriptLibraryManifestSha256'}) \
            and all(identity_shape(build_toolchain.get(key))
                    for key in ('node', 'nodeLibrary', 'typescriptCompiler')) \
            and _SHA256.fullmatch(str(build_toolchain.get('typescriptLibraryManifestSha256', ''))) is not None
        build_valid = _queued_exact(build, {'candidateHead', 'inputs', 'command', 'environment',
                                            'timeoutMs', 'compilerExitCode', 'compilerOutputBytes',
                                            'privateToolchain', 'outputs'}) \
            and build.get('candidateHead') == (candidate or {}).get('head') \
            and isinstance(build.get('inputs'), dict) and isinstance(build.get('command'), list) \
            and isinstance(build.get('environment'), dict) \
            and type(build.get('timeoutMs')) is int and build['timeoutMs'] > 0 \
            and build.get('compilerExitCode') == 0 \
            and type(build.get('compilerOutputBytes')) is int and build['compilerOutputBytes'] >= 0 \
            and isinstance(build.get('privateToolchain'), dict) and isinstance(build.get('outputs'), dict)
        measure_valid = _queued_exact(measure_carry, {
            'window', 'close', 'ownedManifest', 'sourceManifest', 'supervision', 'supervisor',
            'output', 'measureRootRecovery'}) \
            and all(_queued_stop_exact_binding(measure_carry.get(key), {'path', 'sha256'})
                    for key in ('close', 'ownedManifest', 'sourceManifest', 'supervision',
                                'supervisor', 'measureRootRecovery')) \
            and _queued_stop_exact_binding(measure_carry.get('window'), {'path', 'id', 'sha256'}) \
            and _uuid4(measure_carry['window'].get('id')) \
            and _queued_exact(measure_carry.get('output'), {'path', 'label', 'commandSha256'}) \
            and isinstance(measure_carry['output'].get('path'), str) \
            and Path(measure_carry['output']['path']).is_absolute() \
            and _SAFE.fullmatch(str(measure_carry['output'].get('label', ''))) is not None \
            and _SHA256.fullmatch(str(measure_carry['output'].get('commandSha256', ''))) is not None
        if not _queued_exact(fact, fact_keys if leaf else fact_keys | {'processFailureCarryover'}) \
                or fact.get('schemaVersion') != 1 \
                or fact.get('scope') != 'musicbridge-capacity-queued-stop-authority-issuer' \
                or fact.get('windowId') != window_id \
                or fact.get('candidateRepository') != window.get('candidateRepository') \
                or fact.get('toolchain') != window.get('toolchain') \
                or fact.get('measureCarryover') != window.get('measureCarryover') \
                or not candidate_valid or not toolchain_valid or not build_helper_valid \
                or not build_toolchain_valid or not build_valid or not measure_valid \
                or not isinstance(fact.get('issuerFailureCarryover'), list) \
                or len(fact['issuerFailureCarryover']) != window['issuerFailureCarryoverCount'] \
                or not isinstance(fact.get('prechildFailureCarryover'), list) \
                or len(fact['prechildFailureCarryover']) != window['prechildFailureCarryoverCount'] \
                or not _queued_exact(issuer, {'path', 'sha256', 'fact'}) \
                or issuer.get('fact') != {'path': str(expected_paths['issuerFact']),
                                          'sha256': fact_identity['sha256']} \
                or not _queued_exact(issuer_repo, {'root', 'branch', 'head', 'relativePath', 'sha256'}) \
                or issuer_repo.get('root') != window['candidateRepository'].get('root') \
                or issuer_repo.get('branch') != window['candidateRepository'].get('branch') \
                or issuer_repo.get('head') != window['candidateRepository'].get('head') \
                or issuer_repo.get('relativePath') != 'scripts/ci/issue-v3-capacity-queued-stop-window.py' \
                or issuer_repo.get('sha256') != issuer.get('sha256') \
                or issuer.get('path') != str(Path(issuer_repo['root']) / issuer_repo['relativePath']) \
                or not _queued_exact(supervisor_source, {'path', 'relativePath', 'sha256'}) \
                or supervisor_source.get('relativePath') != 'scripts/ci/capacity-phase-supervisor-v2.py' \
                or supervisor_source.get('path') != str(Path(candidate['root']) /
                                                        supervisor_source['relativePath']) \
                or supervisor_source.get('sha256') != identities['supervisor']['sha256']:
            raise ValueError(error_code)
        if not _queued_exact(owned, {'schemaVersion', 'scope', 'access', 'windowId', 'roots'}) \
                or owned.get('schemaVersion') != 1 \
                or owned.get('scope') != 'musicbridge-capacity-owned-roots' \
                or owned.get('access') != 'count-only' or owned.get('windowId') != window_id \
                or not isinstance(owned.get('roots'), list) \
                or len(owned['roots']) != expected_owned_count:
            raise ValueError(error_code)
        predecessor_root = None
        if linked:
            predecessor_path = Path(process_carryover[0].get('root', '')) \
                if isinstance(process_carryover[0], dict) else Path('')
            predecessor_files = process_carryover[0].get('files') \
                if isinstance(process_carryover[0], dict) else None
            try: predecessor_info = predecessor_path.lstat()
            except OSError as error: raise ValueError(error_code) from error
            if not isinstance(predecessor_files, dict) \
                    or not _queued_stop_exact_binding(
                        predecessor_files.get('owner'), {'path', 'sha256'}) \
                    or predecessor_files['owner']['path'] != str(predecessor_path / 'owner.json'):
                raise ValueError(error_code)
            predecessor_root = {'path': str(predecessor_path), 'device': predecessor_info.st_dev,
                                'inode': predecessor_info.st_ino,
                                'marker': {'relative': 'owner.json',
                                           'sha256': predecessor_files['owner']['sha256']}}
        carry_roots = owned['roots'][:73]
        expected_tail = [
            {'path': str(root), 'device': root_info.st_dev, 'inode': root_info.st_ino,
             'marker': {'relative': 'owner.json', 'sha256': owner_identity['sha256']}},
            {'path': str(issuer_directory), 'device': issuer_info.st_dev, 'inode': issuer_info.st_ino,
             'marker': {'relative': 'owner.json', 'sha256': fact_identity['sha256']}},
        ]
        if linked: expected_tail.insert(0, predecessor_root)
        if owned['roots'] != [*carry_roots, *expected_tail]:
            raise ValueError(error_code)
        direct_carry_roots = [*carry_roots, predecessor_root] if linked else carry_roots
        frozen_owned = _validate_queued_stop_owned_manifest(
            expected_paths['ownedManifest'], runtime, window_id, root, direct_carry_roots, 0,
            expected_device=root_info.st_dev, terminal=True,
            runtime_relocation=runtime_relocation)
        if frozen_owned['rootCount'] != expected_owned_count:
            raise ValueError(error_code)
        queued = supervision.get('queuedStop') if isinstance(supervision, dict) else None
        captures = {
            'stdout': {'path': str(expected_paths['stdout']), 'exists': True,
                       'size': identities['stdout']['size'], 'sha256': identities['stdout']['sha256']},
            'stderr': {'path': str(expected_paths['stderr']), 'exists': True,
                       'size': identities['stderr']['size'], 'sha256': identities['stderr']['sha256']}}
        if stdout_bytes != b'' \
                or stderr_bytes != _queued_stop_process_failure_stderr(supervision.get('pid')) \
                or not _queued_exact(queued, queued_keys) \
                or queued != {'outputDirectory': str(root / label), 'verifiedComplete': False,
                              'verifiedPassed': False, 'fileCount': 0, 'sampleCount': 0,
                              'uniqueChildPids': 0, 'aggregateBudgetValid': False,
                              'unexpectedEntries': []} \
                or (root / label).exists() or (root / label).is_symlink():
            raise ValueError(error_code)
        pid = supervision.get('pid') if isinstance(supervision, dict) else None
        if not _queued_exact(supervision, supervision_keys) \
                or supervision.get('passed') is not False \
                or supervision.get('failure') != 'PROCESS_EXIT' \
                or type(pid) is not int or pid <= 0 or supervision.get('pgid') != pid \
                or supervision.get('code') != 1 or supervision.get('exitSignal') is not None \
                or supervision.get('signals') != [] or supervision.get('groupEmpty') is not True \
                or supervision.get('zombies') != [] \
                or supervision.get('managedProcessGroup') is not True \
                or not _queued_number(supervision.get('elapsedMs')) \
                or supervision.get('stdout') != captures['stdout'] \
                or supervision.get('stderr') != captures['stderr']:
            raise ValueError(error_code)
        expected_command = [window['toolchain']['node']['path'], '--import',
                            window['toolchain']['tsxLoader']['path'],
                            str(Path(window['candidateRepository']['root']) /
                                'packages/bridge-core/test/benchmarks/recording-capacity-process.ts'),
                            '--phase', 'queued-stop', '--profile', 'objects-limit', '--label', label,
                            '--seed-label', window['seedLabel'], '--window', str(expected_paths['window']),
                            '--window-sha256', window_identity['sha256'], '--owned-roots',
                            str(expected_paths['ownedManifest']), '--owned-roots-sha256',
                            owned_identity['sha256']]
        environment = start.get('environment') if isinstance(start, dict) else None
        if not _queued_exact(start, start_keys) or start.get('pid') != pid or start.get('pgid') != pid \
                or start.get('command') != expected_command or start.get('managedProcessGroup') is not True \
                or not _queued_number(start.get('startedMonotonic')) \
                or not _queued_number(start.get('deadlineMonotonic')) \
                or start['deadlineMonotonic'] <= start['startedMonotonic'] \
                or start.get('cwd') != window['candidateRepository']['root'] \
                or not isinstance(environment, dict) \
                or set(environment) != {'PATH', 'LANG', 'LC_ALL', 'TZ', 'CI', 'TMPDIR'} \
                or {key: environment.get(key) for key in ('PATH', 'LANG', 'LC_ALL', 'TZ', 'CI')} != {
                    'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C', 'LC_ALL': 'C',
                    'TZ': 'UTC', 'CI': '1'} \
                or not isinstance(environment.get('TMPDIR'), str) \
                or not Path(environment['TMPDIR']).is_absolute() \
                or start.get('environmentKeys') != sorted(environment) \
                or start.get('stdin') != 'DEVNULL' or start.get('stdout') != str(expected_paths['stdout']) \
                or start.get('stderr') != str(expected_paths['stderr']):
            raise ValueError(error_code)
        admission = close.get('authorityAdmission') if isinstance(close, dict) else None
        terminal = close.get('authorityTerminal') if isinstance(close, dict) else None
        observed_process_counts = []
        if linked:
            for authority in (admission, terminal):
                value = authority.get('processFailureCount') if isinstance(authority, dict) else None
                if type(value) is not int or not 1 <= value <= 64:
                    raise ValueError(error_code)
                observed_process_counts.append(value)
            if len(set(observed_process_counts)) != 1:
                raise ValueError(error_code)
        if not _queued_exact(close, close_keys) or close.get('schemaVersion') != 1 \
                or close.get('scope') != 'musicbridge-capacity-queued-stop-window-close' \
                or close.get('windowId') != window_id or close.get('profile') != 'objects-limit' \
                or close.get('label') != label or close.get('seedLabel') != window['seedLabel'] \
                or closed_at.utcoffset() is None or close.get('state') != 'failed' \
                or close.get('failure') != 'PROCESS_EXIT' or close.get('pid') != pid \
                or close.get('pgid') != pid or close.get('managedProcessGroup') is not True \
                or close.get('code') != 1 or close.get('exitSignal') is not None \
                or close.get('signals') != [] or close.get('groupEmpty') is not True \
                or close.get('zombies') != [] or close.get('elapsedMs') != supervision['elapsedMs'] \
                or close.get('windowSha256') != window_identity['sha256'] \
                or close.get('sourceManifestSha256') != source_identity['sha256'] \
                or close.get('ownedManifestSha256') != owned_identity['sha256'] \
                or close.get('seed') != window.get('seed') \
                or close.get('measureCarryover') != window.get('measureCarryover') \
                or close.get('queuedStop') != queued \
                or close.get('supervisorSha256') != supervision_identity['sha256'] \
                or close.get('stdout') != captures['stdout'] or close.get('stderr') != captures['stderr'] \
                or close.get('deviceOpened') is not False or close.get('formalReady') is not False \
                or close.get('gateB') != 'NOT_RUN' \
                or close.get('replayPolicy') != 'terminal-window-id-and-label-never-reuse' \
                or not _queued_stop_process_authority(
                    admission, window, window_identity, owner_identity, len(source_files),
                    expected_owned_count,
                    window['queuedStopPlan']['plannedBytes']) \
                or not _queued_stop_process_authority(
                    terminal, window, window_identity, owner_identity, len(source_files),
                    expected_owned_count, 0):
            raise ValueError(error_code)
        try:
            root_after = root.lstat(); issuer_after = issuer_directory.lstat()
            supervision_after = supervision_directory.lstat()
            entries_after = {entry.name for entry in root.iterdir()}
            issuer_entries_after = {entry.name for entry in issuer_directory.iterdir()}
            supervision_entries_after = {entry.name for entry in supervision_directory.iterdir()}
            identities_after = {role: _validate_queued_stop_bound_file(
                binding, expected_paths[role], maximum=maximums.get(role, 32 * 1024 * 1024))
                for role, binding in files.items()}
        except (OSError, ValueError) as error: raise ValueError(error_code) from error
        directory_fields = ('st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
        if any(getattr(root_info, key) != getattr(root_after, key) for key in directory_fields) \
                or any(getattr(issuer_info, key) != getattr(issuer_after, key) for key in directory_fields) \
                or any(getattr(supervision_info, key) != getattr(supervision_after, key)
                       for key in directory_fields) \
                or entries_after != expected_entries or issuer_entries_after != {'owner.json'} \
                or supervision_entries_after != supervision_entries or identities_after != identities:
            raise ValueError(error_code)
        root_row = {'path': str(root), 'device': root_info.st_dev, 'inode': root_info.st_ino,
                    'marker': {'relative': 'owner.json', 'sha256': owner_identity['sha256']}}
        if is_head:
            roots.append(root_row); direct_root_ids.append(window_id)
        canonical_instant = lambda value: value.astimezone(datetime.timezone.utc).isoformat(
            timespec='milliseconds').replace('+00:00', 'Z')
        predecessor_ids = [process_carryover[0]['windowId']] if linked else []
        predecessor_identities = [json.dumps(predecessor_root, sort_keys=True,
                                               separators=(',', ':'))] if linked else []
        lineage_nodes.append({
            'id': window_id, 'predecessorIds': predecessor_ids,
            'predecessorRootIdentities': predecessor_identities,
            'issuedAt': canonical_instant(issued_at), 'deadlineAt': canonical_instant(deadline_at),
            'closedAt': canonical_instant(closed_at), 'pid': close['pid'], 'pgid': close['pgid'],
            'supervisionPid': supervision['pid'], 'closePid': close['pid'],
            'rootIdentity': json.dumps(root_row, sort_keys=True, separators=(',', ':')),
            'authorityReachableDepth': observed_process_counts[0] if linked else None,
        })
        billing_roots.append(root_row)
        snapshots.append({
            'root': root_row,
            'rootIdentity': {'path': str(root), 'device': root_info.st_dev, 'inode': root_info.st_ino,
                             'mtimeNs': root_info.st_mtime_ns, 'ctimeNs': root_info.st_ctime_ns,
                             'nlink': root_info.st_nlink, 'entries': sorted(root_entries)},
            'issuerIdentity': {'path': str(issuer_directory), 'device': issuer_info.st_dev,
                               'inode': issuer_info.st_ino, 'mtimeNs': issuer_info.st_mtime_ns,
                               'ctimeNs': issuer_info.st_ctime_ns, 'nlink': issuer_info.st_nlink,
                               'entries': sorted(issuer_entries)},
            'supervisionIdentity': {'path': str(supervision_directory),
                                    'device': supervision_info.st_dev, 'inode': supervision_info.st_ino,
                                    'mtimeNs': supervision_info.st_mtime_ns,
                                    'ctimeNs': supervision_info.st_ctime_ns,
                                    'nlink': supervision_info.st_nlink,
                                    'entries': sorted(observed_supervision_entries)},
            'windowId': window_id, 'windowDirName': row['windowDirName'], 'label': label,
            'failure': 'PROCESS_EXIT', 'code': 1, 'sampleCount': 0,
            'deviceOpened': False, 'formalReady': False, 'gateB': 'NOT_RUN',
            'inheritedRoots': carry_roots,
            'historicalMeasure': {
                'measureRootRecovery': measure_carry['measureRootRecovery'],
                'window': {'id': measure_carry['window']['id']},
                'ownedManifest': measure_carry['ownedManifest'],
                'candidateRepository': candidate,
            },
            'files': identities,
            'stdout': captures['stdout'], 'stderr': captures['stderr']})
        declared.add(str(expected_paths['close'])); seen.add(str(root)); seen_windows.add(window_id)
        seen_dirs.add(row['windowDirName']); seen_labels.add(label)
        if len(declared) > 64:
            raise ValueError(error_code)
        if linked:
            pending.append((process_carryover[0], issued_at, False))
    lineage = _lineage_module()
    if lineage_contract is None:
        lineage_contract = lineage.load_contract(Path(__file__).resolve().parents[2])
    lineage_result = lineage.evaluate_process_failure_lineage(
        {'directRootIds': direct_root_ids, 'nodes': lineage_nodes}, lineage_contract)
    if lineage_result['verdict'] != 'PASS':
        raise ValueError(f"{error_code}_{lineage_result['verdict']}")
    if declared != discovered:
        raise ValueError(audit_code)
    return {'roots': roots, 'billingRoots': billing_roots, 'snapshots': snapshots,
            'contractLineage': lineage_result}


def _validate_queued_stop_bound_identities(window, parent, candidate, runtime_relocation=None):
    if window.get('profile') == 'joint':
        return _validate_joint_queued_stop_bound_identities(window, parent, candidate)
    toolchain = window['toolchain']; issuer = window['issuer']
    issuer_path = candidate / 'scripts/ci/issue-v3-capacity-queued-stop-window.py'
    identities = {
        'node': _validate_queued_stop_bound_file(
            toolchain['node'], executable=True, maximum=256 * 1024 * 1024),
        'tsxLoader': _validate_queued_stop_bound_file(toolchain['tsxLoader']),
        'consumerPython': _validate_queued_stop_bound_file(
            toolchain['consumerPython'], expected_path=Path(sys.executable), executable=True),
        'issuer': _validate_queued_stop_bound_file(
            {'path': issuer['path'], 'sha256': issuer['sha256']}, expected_path=issuer_path),
        'issuerFact': _validate_queued_stop_bound_file(
            issuer['fact'], expected_path=Path(parent) / 'issuer-identity' / 'owner.json', maximum=1024 * 1024),
    }
    try: fact, fact_identity = _strict_json(issuer['fact']['path'], 1024 * 1024)
    except ValueError as error: raise ValueError('QUEUED_STOP_IDENTITY') from error
    fact_keys = {'schemaVersion', 'scope', 'windowId', 'issuerRepository', 'candidateRepository',
                 'supervisorSource', 'toolchain', 'buildHelper', 'buildToolchain', 'build',
                 'issuerFailureCarryover', 'prechildFailureCarryover',
                 'processFailureCarryover', 'measureCarryover'}
    issuer_repo = fact.get('issuerRepository') if isinstance(fact, dict) else None
    supervisor_source = fact.get('supervisorSource') if isinstance(fact, dict) else None
    build_helper = fact.get('buildHelper') if isinstance(fact, dict) else None
    build_toolchain = fact.get('buildToolchain') if isinstance(fact, dict) else None
    build = fact.get('build') if isinstance(fact, dict) else None
    if not _queued_exact(fact, fact_keys) or fact.get('schemaVersion') != 1 \
            or fact.get('scope') != 'musicbridge-capacity-queued-stop-authority-issuer' \
            or fact.get('windowId') != window['id'] or fact.get('candidateRepository') != window['candidateRepository'] \
            or fact.get('toolchain') != toolchain or fact.get('measureCarryover') != window['measureCarryover'] \
            or not isinstance(issuer_repo, dict) \
            or set(issuer_repo) != {'root', 'branch', 'head', 'relativePath', 'sha256'} \
            or issuer_repo.get('sha256') != issuer['sha256'] \
            or not isinstance(supervisor_source, dict) \
            or set(supervisor_source) != {'path', 'relativePath', 'sha256'} \
            or supervisor_source.get('relativePath') != 'scripts/ci/capacity-phase-supervisor-v2.py' \
            or supervisor_source.get('path') != str(candidate / supervisor_source['relativePath']) \
            or supervisor_source.get('sha256') != window['supervisor']['sha256'] \
            or not isinstance(build_helper, dict) \
            or set(build_helper) != {'path', 'relativePath', 'sha256'} \
            or build_helper.get('relativePath') != 'scripts/ci/issue-v3-capacity-window.py' \
            or build_helper.get('path') != str(candidate / build_helper['relativePath']) \
            or not isinstance(build_toolchain, dict) \
            or set(build_toolchain) != {'node', 'nodeLibrary', 'typescriptCompiler',
                                        'typescriptLibraryManifestSha256'} \
            or _SHA256.fullmatch(str(build_toolchain.get('typescriptLibraryManifestSha256', ''))) is None:
        raise ValueError('QUEUED_STOP_IDENTITY')
    prior_failures = _validate_queued_stop_issuer_failures(fact['issuerFailureCarryover'], Path(parent).parent)
    if len(prior_failures['roots']) != window['issuerFailureCarryoverCount']:
        raise ValueError('QUEUED_STOP_ISSUER_FAILURE')
    identities['issuerFailureRoots'] = prior_failures['roots']
    identities['issuerFailures'] = prior_failures['snapshots']
    prechild_failures = _validate_queued_stop_prechild_failures(
        fact['prechildFailureCarryover'], Path(parent).parent)
    if len(prechild_failures['roots']) != window['prechildFailureCarryoverCount']:
        raise ValueError('QUEUED_STOP_PRECHILD_FAILURE')
    identities['prechildFailureRoots'] = prechild_failures['roots']
    identities['prechildFailures'] = prechild_failures['snapshots']
    source_pins, _ = _strict_json(Path(parent) / 'source-pins.json')
    source_files = source_pins.get('files') if isinstance(source_pins, dict) else None
    lineage_relatives = ('scripts/ci/capacity_process_failure_lineage.py',
                         'packages/contracts/capacity-process-failure-lineage-v1.json')
    if not isinstance(source_files, dict):
        raise ValueError('QUEUED_STOP_PROCESS_FAILURE')
    for relative in lineage_relatives:
        digest = source_files.get(relative)
        if _SHA256.fullmatch(str(digest or '')) is None:
            raise ValueError('QUEUED_STOP_PROCESS_FAILURE')
        _validate_queued_stop_bound_file({'path': str(candidate / relative), 'sha256': digest},
                                         expected_path=candidate / relative)
    lineage = _lineage_module(candidate)
    lineage_contract = lineage.load_contract(candidate)
    process_failures = _validate_queued_stop_process_failures(
        fact['processFailureCarryover'], Path(parent).parent, lineage_contract,
        runtime_relocation=runtime_relocation)
    if len(process_failures['roots']) != window['processFailureCarryoverCount']:
        raise ValueError('QUEUED_STOP_PROCESS_FAILURE')
    identities['processFailureRoots'] = process_failures['roots']
    identities['processFailureBillingRoots'] = process_failures['billingRoots']
    identities['processFailures'] = process_failures['snapshots']
    identities['processFailureLineage'] = process_failures['contractLineage']
    identities['buildHelper'] = _validate_queued_stop_bound_file(
        {'path': build_helper['path'], 'sha256': build_helper['sha256']},
        expected_path=candidate / build_helper['relativePath'])
    identities['buildNode'] = _validate_queued_stop_bound_file(
        build_toolchain['node'], executable=True, maximum=256 * 1024 * 1024)
    identities['buildNodeLibrary'] = _validate_queued_stop_bound_file(
        build_toolchain['nodeLibrary'], maximum=256 * 1024 * 1024)
    identities['typescriptCompiler'] = _validate_queued_stop_bound_file(
        build_toolchain['typescriptCompiler'], maximum=32 * 1024 * 1024)
    typescript_directory = Path(build_toolchain['typescriptCompiler']['path']).parent
    library_files = {}
    try:
        for path in sorted(typescript_directory.iterdir(), key=lambda value: value.name):
            if _TYPESCRIPT_LIBRARY.fullmatch(path.name):
                library_files[path.name] = _strict_identity(path, 8 * 1024 * 1024)['sha256']
    except (OSError, ValueError) as error:
        raise ValueError('QUEUED_STOP_IDENTITY') from error
    library_manifest = hashlib.sha256(json.dumps(
        {'files': library_files}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    if not library_files or library_manifest != build_toolchain['typescriptLibraryManifestSha256']:
        raise ValueError('QUEUED_STOP_IDENTITY')
    identities['typescriptLibraries'] = {'sha256': library_manifest, 'files': library_files}
    issuer_root = Path(str(issuer_repo.get('root', '')))
    issuer_relative = issuer_repo.get('relativePath')
    if not issuer_root.is_absolute() or not isinstance(issuer_relative, str) \
            or issuer_root / issuer_relative != Path(issuer['path']) \
            or _GIT_SHA.fullmatch(str(issuer_repo.get('head', ''))) is None \
            or _git_value(issuer_root, 'rev-parse', '--show-toplevel') != str(issuer_root) \
            or _git_value(issuer_root, 'branch', '--show-current') != issuer_repo.get('branch') \
            or _git_value(issuer_root, 'rev-parse', 'HEAD^{commit}') != issuer_repo.get('head'):
        raise ValueError('QUEUED_STOP_IDENTITY')
    try:
        issuer_blob = _git_blob(issuer_root, f"{issuer_repo['head']}:{issuer_relative}")
        supervisor_blob = _git_blob(
            candidate,
            f"{window['candidateRepository']['head']}:scripts/ci/capacity-phase-supervisor-v2.py")
        helper_blob = _git_blob(
            candidate, f"{window['candidateRepository']['head']}:{build_helper['relativePath']}")
    except ValueError as error:
        raise ValueError('QUEUED_STOP_IDENTITY') from error
    if hashlib.sha256(issuer_blob).hexdigest() != issuer['sha256'] \
            or hashlib.sha256(supervisor_blob).hexdigest() != window['supervisor']['sha256'] \
            or hashlib.sha256(helper_blob).hexdigest() != build_helper['sha256'] \
            or identities['issuerFact'] != fact_identity:
        raise ValueError('QUEUED_STOP_IDENTITY')
    build_keys = {'candidateHead', 'inputs', 'command', 'environment', 'timeoutMs',
                  'compilerExitCode', 'compilerOutputBytes', 'privateToolchain', 'outputs'}
    private_keys = {'nodeSha256', 'nodeLibrarySha256', 'typescriptCompilerSha256',
                    'typescriptLibraryManifestSha256'}
    expected_private = {
        'nodeSha256': build_toolchain['node']['sha256'],
        'nodeLibrarySha256': build_toolchain['nodeLibrary']['sha256'],
        'typescriptCompilerSha256': build_toolchain['typescriptCompiler']['sha256'],
        'typescriptLibraryManifestSha256': build_toolchain['typescriptLibraryManifestSha256'],
    }
    if not _queued_exact(build, build_keys) or build.get('candidateHead') != window['candidateRepository']['head'] \
            or not isinstance(build.get('inputs'), dict) or not isinstance(build.get('outputs'), dict) \
            or not isinstance(build.get('command'), list) or len(build['command']) != 10 \
            or not str(build['command'][0]).endswith('/toolchain/bin/node') \
            or not str(build['command'][1]).endswith('/toolchain/typescript/lib/_tsc.js') \
            or build['command'][2] != '--project' \
            or not str(build['command'][3]).endswith('/packages/contracts/tsconfig.json') \
            or build['command'][4:] != ['--pretty', 'false', '--incremental', 'false', '--noCheck', '--noResolve'] \
            or build.get('environment') != {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'NO_COLOR': '1'} \
            or build.get('timeoutMs') != 120000 or build.get('compilerExitCode') != 0 \
            or build.get('compilerOutputBytes') != 0 \
            or not _queued_exact(build.get('privateToolchain'), private_keys) \
            or build['privateToolchain'] != expected_private:
        raise ValueError('QUEUED_STOP_IDENTITY')
    try: source_pins, _ = _strict_json(Path(parent) / 'source-pins.json')
    except ValueError as error: raise ValueError('QUEUED_STOP_IDENTITY') from error
    source_files = source_pins.get('files') if isinstance(source_pins, dict) else None
    expected_outputs = {relative: digest for relative, digest in source_files.items()
                        if relative.startswith('packages/contracts/dist/')} \
        if isinstance(source_files, dict) else None
    if not expected_outputs or build['outputs'] != expected_outputs:
        raise ValueError('QUEUED_STOP_IDENTITY')
    expected_inputs = {'packages/contracts/package.json', 'packages/contracts/tsconfig.json'}
    for relative in expected_outputs:
        match = re.fullmatch(r'packages/contracts/dist/([a-z0-9-]+)\.js', relative, re.ASCII)
        if match is None:
            raise ValueError('QUEUED_STOP_IDENTITY')
        expected_inputs.add(f'packages/contracts/src/{match.group(1)}.ts')
    if set(build['inputs']) != expected_inputs:
        raise ValueError('QUEUED_STOP_IDENTITY')
    for relative, expected_sha in build['inputs'].items():
        if not isinstance(relative, str) or _SHA256.fullmatch(str(expected_sha or '')) is None:
            raise ValueError('QUEUED_STOP_IDENTITY')
        try:
            blob = _git_blob(candidate, f"{window['candidateRepository']['head']}:{relative}")
        except ValueError as error:
            raise ValueError('QUEUED_STOP_IDENTITY') from error
        if hashlib.sha256(blob).hexdigest() != expected_sha:
            raise ValueError('QUEUED_STOP_IDENTITY')
    return identities


def _validate_joint_queued_stop_bound_identities(window, parent, candidate):
    toolchain = window['toolchain']; issuer = window['issuer']
    issuer_path = candidate / 'scripts/ci/issue-v3-capacity-joint-queued-stop-window.py'
    identities = {
        'node': _validate_queued_stop_bound_file(
            toolchain['node'], executable=True, maximum=256 * 1024 * 1024),
        'tsxLoader': _validate_queued_stop_bound_file(toolchain['tsxLoader']),
        'consumerPython': _validate_queued_stop_bound_file(
            toolchain['consumerPython'], expected_path=Path(sys.executable), executable=True),
        'issuer': _validate_queued_stop_bound_file(
            {'path': issuer['path'], 'sha256': issuer['sha256']}, expected_path=issuer_path),
        'issuerFact': _validate_queued_stop_bound_file(
            issuer['fact'], expected_path=Path(parent) / 'issuer-identity' / 'owner.json',
            maximum=1024 * 1024),
    }
    try: fact, fact_identity = _strict_json(issuer['fact']['path'], 1024 * 1024)
    except ValueError as error: raise ValueError('QUEUED_STOP_IDENTITY') from error
    fact_keys = {'schemaVersion', 'scope', 'windowId', 'candidateRepository',
                 'predecessor', 'supervisorSource', 'sharedHelper', 'toolchain', 'issuer',
                 'authorityInherited', 'receiptReuseAllowed', 'oldWindowReplayAllowed',
                 'deviceOpened', 'formalReady', 'gateB'}
    predecessor = fact.get('predecessor') if isinstance(fact, dict) else None
    supervisor_source = fact.get('supervisorSource') if isinstance(fact, dict) else None
    shared_helper = fact.get('sharedHelper') if isinstance(fact, dict) else None
    fact_issuer = fact.get('issuer') if isinstance(fact, dict) else None
    if not _queued_exact(fact, fact_keys) or fact.get('schemaVersion') != 1 \
            or fact.get('scope') != 'musicbridge-capacity-joint-queued-stop-authority-issuer' \
            or fact.get('windowId') != window['id'] \
            or fact.get('candidateRepository') != window['candidateRepository'] \
            or fact.get('toolchain') != toolchain \
            or fact.get('authorityInherited') is not False \
            or fact.get('receiptReuseAllowed') is not False \
            or fact.get('oldWindowReplayAllowed') is not False \
            or fact.get('deviceOpened') is not False or fact.get('formalReady') is not False \
            or fact.get('gateB') != 'NOT_RUN' \
            or not isinstance(predecessor, dict) \
            or set(predecessor) != {'requiredResult', 'windowId', 'label', 'windowSha256',
                                    'closeSha256', 'supervisionSha256',
                                    'ownedManifestSha256', 'sourceManifestSha256',
                                    'seedMetadataSha256', 'seedSnapshotSha256',
                                    'fixtureOwnerSha256', 'commandSha256'} \
            or predecessor.get('requiredResult') != 'joint:measure:PASS' \
            or predecessor.get('windowId') != window['measureCarryover']['window']['id'] \
            or any(_SHA256.fullmatch(str(predecessor.get(key, ''))) is None for key in (
                'windowSha256', 'closeSha256', 'supervisionSha256', 'ownedManifestSha256',
                'sourceManifestSha256', 'seedMetadataSha256', 'seedSnapshotSha256',
                'fixtureOwnerSha256', 'commandSha256')) \
            or predecessor.get('windowSha256') != window['measureCarryover']['window']['sha256'] \
            or predecessor.get('closeSha256') != window['measureCarryover']['close']['sha256'] \
            or predecessor.get('supervisionSha256') != window['measureCarryover']['supervision']['sha256'] \
            or predecessor.get('ownedManifestSha256') != window['measureCarryover']['ownedManifest']['sha256'] \
            or predecessor.get('sourceManifestSha256') != window['measureCarryover']['sourceManifest']['sha256'] \
            or predecessor.get('seedMetadataSha256') != window['seed']['metadataSha256'] \
            or predecessor.get('seedSnapshotSha256') != window['seed']['snapshotSha256'] \
            or predecessor.get('fixtureOwnerSha256') != window['seed']['fixtureOwnerSha256'] \
            or predecessor.get('commandSha256') != window['measureCarryover']['output']['commandSha256'] \
            or not isinstance(supervisor_source, dict) \
            or set(supervisor_source) != {'path', 'relativePath', 'sha256'} \
            or supervisor_source.get('relativePath') != 'scripts/ci/capacity-phase-supervisor-v2.py' \
            or supervisor_source.get('path') != str(candidate / supervisor_source['relativePath']) \
            or supervisor_source.get('sha256') != window['supervisor']['sha256'] \
            or not isinstance(shared_helper, dict) \
            or set(shared_helper) != {'path', 'relativePath', 'sha256'} \
            or shared_helper.get('relativePath') != 'scripts/ci/issue-v3-capacity-joint-measure-window.py' \
            or shared_helper.get('path') != str(candidate / shared_helper['relativePath']) \
            or _SHA256.fullmatch(str(shared_helper.get('sha256', ''))) is None \
            or fact_issuer != {'path': issuer['path'], 'sha256': issuer['sha256']}:
        raise ValueError('QUEUED_STOP_IDENTITY')
    try:
        issuer_blob = _git_blob(candidate, f"{window['candidateRepository']['head']}:scripts/ci/issue-v3-capacity-joint-queued-stop-window.py")
        supervisor_blob = _git_blob(candidate, f"{window['candidateRepository']['head']}:scripts/ci/capacity-phase-supervisor-v2.py")
        shared_blob = _git_blob(candidate, f"{window['candidateRepository']['head']}:{shared_helper['relativePath']}")
    except ValueError as error:
        raise ValueError('QUEUED_STOP_IDENTITY') from error
    if hashlib.sha256(issuer_blob).hexdigest() != issuer['sha256'] \
            or hashlib.sha256(supervisor_blob).hexdigest() != window['supervisor']['sha256'] \
            or hashlib.sha256(shared_blob).hexdigest() != shared_helper['sha256'] \
            or identities['issuerFact'] != fact_identity:
        raise ValueError('QUEUED_STOP_IDENTITY')
    return identities


def _validate_phase_source_manifest(manifest_path, root):
    try: manifest, identity = _strict_json(manifest_path)
    except ValueError as error: raise ValueError('QUEUED_STOP_SOURCE') from error
    if not isinstance(manifest, dict) or set(manifest) != {'schemaVersion', 'scope', 'files'} \
            or manifest.get('schemaVersion') != 1 \
            or manifest.get('scope') != 'musicbridge-capacity-source-pins' \
            or not isinstance(manifest.get('files'), dict):
        raise ValueError('QUEUED_STOP_SOURCE')
    root, paths = _expected_source_paths(root)
    excluded = {'scripts/ci/capacity-phase-supervisor-v2.py',
                'scripts/ci/issue-v3-capacity-measure-window.py'}
    paths = [value for value in paths if value not in excluded]
    if len(paths) != 241 or set(manifest['files']) != set(paths):
        raise ValueError('QUEUED_STOP_SOURCE')
    identities = {}
    for relative in paths:
        file = root / relative
        try: observed = _strict_identity(file)
        except ValueError as error: raise ValueError('QUEUED_STOP_SOURCE') from error
        if file.resolve() != file or observed['sha256'] != manifest['files'].get(relative):
            raise ValueError('QUEUED_STOP_SOURCE')
        identities[relative] = observed
    if _strict_identity(manifest_path) != identity:
        raise ValueError('QUEUED_STOP_SOURCE')
    return {'valid': True, 'fileCount': 241, 'manifestIdentity': identity,
            'fileIdentities': identities}


def _validate_queued_stop_measure_carryover(carry, runtime, candidate_repository=None,
                                            expected_seed_sha256=None,
                                            expected_fixture_owner_sha256=None):
    runtime = Path(runtime).resolve(strict=True)
    window_path = Path(carry['window']['path']); close_path = Path(carry['close']['path'])
    owned_path = Path(carry['ownedManifest']['path']); source_path = Path(carry['sourceManifest']['path'])
    supervision_path = Path(carry['supervision']['path']); supervisor_path = Path(carry['supervisor']['path'])
    output = Path(carry['output']['path'])
    if window_path.parent.parent != runtime or close_path.parent != window_path.parent \
            or owned_path.parent != window_path.parent or source_path.parent != window_path.parent \
            or supervision_path != window_path.parent / 'supervision' / 'supervisor.json' \
            or supervisor_path != window_path.parent / 'supervisor.py' \
            or output.parent != runtime or output.name != carry['output']['label']:
        raise ValueError('QUEUED_STOP_MEASURE_CARRYOVER')
    try:
        window, window_identity = _strict_json(window_path)
        close, close_identity = _strict_json(close_path)
        supervision, supervision_identity = _strict_json(supervision_path)
        supervisor_identity = _strict_identity(supervisor_path)
        command_identity = _strict_identity(output / 'command.json')
    except ValueError as error: raise ValueError('QUEUED_STOP_MEASURE_CARRYOVER') from error
    bindings = ((window_identity, carry['window']['sha256']), (close_identity, carry['close']['sha256']),
                (supervision_identity, carry['supervision']['sha256']),
                (supervisor_identity, carry['supervisor']['sha256']),
                (command_identity, carry['output']['commandSha256']))
    if any(identity['sha256'] != expected for identity, expected in bindings) \
            or window.get('id') != carry['window']['id'] or window.get('profile') != 'objects-limit' \
            or window.get('scope') != 'musicbridge-capacity-measure-window' \
            or close.get('scope') != 'musicbridge-capacity-measure-window-close' \
            or close.get('windowId') != window.get('id') or close.get('state') != 'passed' \
            or close.get('failure') is not None or close.get('code') != 0 \
            or close.get('signals') != [] or close.get('groupEmpty') is not True or close.get('zombies') != [] \
            or close.get('windowSha256') != carry['window']['sha256'] \
            or close.get('ownedManifestSha256') != carry['ownedManifest']['sha256'] \
            or close.get('sourceManifestSha256') != carry['sourceManifest']['sha256'] \
            or close.get('supervisorSha256') != carry['supervision']['sha256'] \
            or close.get('deviceOpened') is not False or close.get('formalReady') is not False \
            or close.get('gateB') != 'NOT_RUN' \
            or close.get('replayPolicy') != 'terminal-window-id-and-label-never-reuse' \
            or supervision.get('passed') is not True or supervision.get('code') != 0 \
            or supervision.get('signals') != [] or supervision.get('groupEmpty') is not True \
            or supervision.get('zombies') != []:
        raise ValueError('QUEUED_STOP_MEASURE_CARRYOVER')
    measurement = close.get('measurement'); admission = close.get('authorityAdmission'); terminal = close.get('authorityTerminal')
    if not isinstance(measurement, dict) or measurement.get('verifiedComplete') is not True \
            or measurement.get('verifiedPassed') is not True or measurement.get('thresholdPassed') is not True \
            or measurement.get('sampleCount') != 1575 or measurement.get('receiptCount') != 3 \
            or measurement.get('roundReceiptCount') != 105 or measurement.get('stageCount') != 18 \
            or measurement.get('aggregateBudgetValid') is not True \
            or measurement.get('aggregateBudgetRowCount') != 2383 \
            or measurement.get('aggregateBudgetSnapshotBytes') != 1_990_471_680 \
            or measurement.get('aggregateBudgetLimitBytes') != 2_258_907_136 \
            or measurement.get('aggregateOutputBytes') != 5_544_090 \
            or not isinstance(admission, dict) or admission.get('authorityStable') is not True \
            or admission.get('sourceFileCount') != 243 or admission.get('ownedRootCount') != 71 \
            or admission.get('plannedBytes') != 2_258_907_136 \
            or not isinstance(terminal, dict) or terminal.get('authorityStable') is not True \
            or terminal.get('sourceFileCount') != 243 or terminal.get('ownedRootCount') != 71 \
            or terminal.get('plannedBytes') != 2_258_907_136:
        raise ValueError('QUEUED_STOP_MEASURE_CARRYOVER')
    frozen = _validate_frozen_owned_roots(
        owned_path, runtime, carry['ownedManifest']['sha256'], window['id'], output, 'present',
        'QUEUED_STOP_MEASURE_CARRYOVER', root_recovery=carry['measureRootRecovery'],
        candidate_repository=candidate_repository, expected_seed_sha256=expected_seed_sha256,
        expected_fixture_owner_sha256=expected_fixture_owner_sha256)
    if len(frozen['roots']) != 70:
        raise ValueError('QUEUED_STOP_MEASURE_CARRYOVER')
    try: source, source_identity = _strict_json(source_path)
    except ValueError as error: raise ValueError('QUEUED_STOP_MEASURE_CARRYOVER') from error
    if source_identity['sha256'] != carry['sourceManifest']['sha256'] \
            or not isinstance(source, dict) or not isinstance(source.get('files'), dict) \
            or len(source['files']) != 243:
        raise ValueError('QUEUED_STOP_MEASURE_CARRYOVER')
    output_root = _carryover_root_identity(output, 'command.json')
    roots = [*frozen['roots'], output_root]
    if len({row['path'] for row in roots}) != 71:
        raise ValueError('QUEUED_STOP_MEASURE_CARRYOVER')
    return {'valid': True, 'roots': roots, 'window': window, 'close': close,
            'windowIdentity': window_identity, 'closeIdentity': close_identity,
            'outputIdentity': output_root, 'rootRecovery': frozen['rootRecovery']}


def _validate_queued_stop_owned_manifest(manifest_path, runtime, window_id, parent, carry_roots,
                                         planned_bytes, expected_device=None, terminal=False,
                                         runtime_relocation=None):
    runtime = Path(runtime).resolve(strict=True); parent = Path(parent).resolve(strict=True)
    if expected_device is None:
        expected_device = runtime.lstat().st_dev
    expected_root_count = len(carry_roots) + 2
    try: manifest, manifest_identity = _strict_json(manifest_path)
    except ValueError as error: raise ValueError('QUEUED_STOP_OWNED') from error
    if runtime_relocation:
        manifest = _relocate_runtime_value(
            manifest, runtime_relocation, runtime, 'QUEUED_STOP_OWNED')
    if not isinstance(manifest, dict) or set(manifest) != {'schemaVersion', 'scope', 'access', 'windowId', 'roots'} \
            or manifest.get('schemaVersion') != 1 or manifest.get('scope') != 'musicbridge-capacity-owned-roots' \
            or manifest.get('access') != 'count-only' or manifest.get('windowId') != window_id \
            or not isinstance(manifest.get('roots'), list) or len(manifest['roots']) != expected_root_count:
        raise ValueError('QUEUED_STOP_OWNED')
    rows = []; seen = set(); temp_root = Path(tempfile.gettempdir()).resolve(strict=True)
    for row in manifest['roots']:
        if not isinstance(row, dict) or set(row) != {'path', 'device', 'inode', 'marker'} \
                or type(row.get('device')) is not int or type(row.get('inode')) is not int:
            raise ValueError('QUEUED_STOP_OWNED')
        path = Path(str(row.get('path', ''))); marker = row.get('marker')
        try: info = path.lstat(); canonical = path.resolve(strict=True)
        except OSError as error: raise ValueError('QUEUED_STOP_OWNED') from error
        fixture = path.parent == temp_root and re.fullmatch(r'musicbridge-version-[A-Za-z0-9]+', path.name)
        app_clone = path.parent == temp_root and re.fullmatch(r'musicbridge-ui-diagnostics-r021-[A-Za-z0-9]{6}', path.name)
        if not path.is_absolute() or path.is_symlink() or canonical != path or not stat.S_ISDIR(info.st_mode) \
                or str(path) in seen or row['device'] != expected_device \
                or info.st_dev != row['device'] or info.st_ino != row['inode'] \
                or not (_inside(runtime, path) and path != runtime or fixture or app_clone) \
                or not isinstance(marker, dict) or set(marker) != {'relative', 'sha256'} \
                or marker.get('relative') not in _MARKERS \
                or _SHA256.fullmatch(str(marker.get('sha256', ''))) is None:
            raise ValueError('QUEUED_STOP_OWNED')
        observed = _strict_root_marker(
            path, marker, expected_device, row['inode'], 'QUEUED_STOP_OWNED')
        seen.add(str(path)); rows.append(observed)
    required = {row['path'] for row in carry_roots} | {str(parent), str(parent / 'issuer-identity')}
    if seen != required or len(required) != expected_root_count \
            or expected_root_count < _QUEUED_STOP_BASE_ROOTS:
        raise ValueError('QUEUED_STOP_OWNED')
    minimal = [Path(value) for value in sorted(seen)
               if not any(value != other and _inside(Path(other), Path(value)) for other in seen)]
    owned_bytes = 0
    for root in minimal:
        size, _ = _directory_bytes(root)
        owned_bytes += size
        if owned_bytes > _QUEUED_STOP_LIMITS['maximumOwnedBytes']:
            raise ValueError('QUEUED_STOP_SPACE')
    reserve = 0 if terminal else planned_bytes
    available = os.statvfs(parent).f_bavail * os.statvfs(parent).f_frsize
    if owned_bytes + reserve > _QUEUED_STOP_LIMITS['maximumOwnedBytes'] \
            or available - reserve < _QUEUED_STOP_LIMITS['minimumFreeBytes']:
        raise ValueError('QUEUED_STOP_SPACE')
    return {'valid': True, 'rootCount': len(rows), 'ownedBytes': owned_bytes,
            'plannedBytes': planned_bytes, 'remainingPlannedBytes': reserve,
            'availableBytes': available, 'manifestIdentity': manifest_identity}


def _apply_queued_stop_transitive_billing(value, direct_roots, process_roots, parent, terminal):
    paths = {row['path'] for row in [*direct_roots, *process_roots]}
    minimal = [Path(path) for path in sorted(paths)
               if not any(path != other and _inside(Path(other), Path(path)) for other in paths)]
    owned_bytes = 0
    for root in minimal:
        size, _ = _directory_bytes(root)
        owned_bytes += size
        if owned_bytes > _QUEUED_STOP_LIMITS['maximumOwnedBytes']:
            raise ValueError('QUEUED_STOP_SPACE')
    reserve = 0 if terminal else value['plannedBytes']
    available = os.statvfs(parent).f_bavail * os.statvfs(parent).f_frsize
    if owned_bytes + reserve > _QUEUED_STOP_LIMITS['maximumOwnedBytes'] \
            or available - reserve < _QUEUED_STOP_LIMITS['minimumFreeBytes']:
        raise ValueError('QUEUED_STOP_SPACE')
    return {**value, 'ownedBytes': owned_bytes, 'remainingPlannedBytes': reserve,
            'availableBytes': available}


def _validate_queued_stop_process_recovery_lineage(
        runtime, historical_measure, old_inherited, current_roots, current_mappings,
        runtime_relocation=None):
    code = 'QUEUED_STOP_PROCESS_FAILURE_LINEAGE'
    runtime = Path(runtime).resolve(strict=True)
    if not isinstance(historical_measure, dict) \
            or set(historical_measure) != {
                'measureRootRecovery', 'window', 'ownedManifest', 'candidateRepository'} \
            or not isinstance(old_inherited, list) or len(old_inherited) != 73 \
            or not isinstance(current_roots, list) or len(current_roots) != 73 \
            or not isinstance(current_mappings, list) or len(current_mappings) != 7:
        raise ValueError(code)
    binding = historical_measure['measureRootRecovery']
    window = historical_measure['window']
    owned = historical_measure['ownedManifest']
    candidate = historical_measure['candidateRepository']
    if not _queued_stop_exact_binding(binding, {'path', 'sha256'}) \
            or not _queued_exact(window, {'id'}) or not _uuid4(window.get('id')) \
            or not _queued_stop_exact_binding(owned, {'path', 'sha256'}) \
            or not _queued_exact(candidate, {'root', 'branch', 'head'}) \
            or _GIT_SHA.fullmatch(str(candidate.get('head', ''))) is None:
        raise ValueError(code)
    try:
        receipt, receipt_identity = _strict_json(Path(binding['path']), 4 * 1024 * 1024)
    except ValueError as error:
        raise ValueError(code) from error
    if runtime_relocation:
        receipt = _relocate_runtime_value(receipt, runtime_relocation, runtime, code)
    mappings = receipt.get('mappings') if isinstance(receipt, dict) else None
    remap = receipt.get('liveDeviceRemap') if isinstance(receipt, dict) else None
    if receipt_identity['sha256'] != binding['sha256'] \
            or not isinstance(mappings, list) or len(mappings) != 7 \
            or not _queued_exact(remap, {
                'mode', 'historicalDevice', 'currentDevice', 'liveRootCount'}) \
            or type(remap.get('historicalDevice')) is not int \
            or remap.get('currentDevice') != runtime.lstat().st_dev \
            or remap.get('liveRootCount') != 63 \
            or remap.get('mode') != (
                'UNCHANGED' if remap['historicalDevice'] == remap['currentDevice'] else 'REMAPPED'):
        raise ValueError(code)
    missing = [mapping.get('historicalRoot') if isinstance(mapping, dict) else None
               for mapping in mappings]
    try:
        old_recovery = _validate_measure_root_recovery(
            binding, runtime, Path(owned['path']), owned['sha256'], window['id'], missing,
            remap, None, None, None, code, historical_repository=True,
            runtime_relocation=runtime_relocation)
    except ValueError as error:
        raise ValueError(code) from error
    if old_recovery['repository'] != {**candidate, 'clean': True, 'pushedHead': True}:
        raise ValueError(code)
    current_historical = []
    current_replacements = []
    for mapping in current_mappings:
        if not isinstance(mapping, dict) \
                or set(mapping) != {'historicalRoot', 'state', 'recovered', 'replacementRoot'} \
                or mapping.get('state') != 'LOST' or mapping.get('recovered') is not False \
                or not isinstance(mapping.get('historicalRoot'), dict) \
                or set(mapping['historicalRoot']) != {'path', 'device', 'inode', 'marker'}:
            raise ValueError(code)
        replacement = mapping.get('replacementRoot')
        if not isinstance(replacement, dict) \
                or set(replacement) != {'path', 'device', 'inode', 'marker', 'role'} \
                or replacement.get('role') != 'historical-control-only':
            raise ValueError(code)
        current_historical.append(mapping['historicalRoot'])
        current_replacements.append({key: replacement[key]
                                     for key in ('path', 'device', 'inode', 'marker')})
    old_historical = [mapping['historicalRoot'] for mapping in old_recovery['mappings']]
    if old_inherited[:63] != current_roots[:63] \
            or old_inherited[63:70] != old_recovery['roots'] \
            or current_roots[63:70] != current_replacements \
            or old_historical != current_historical \
            or old_inherited[70:] != current_roots[70:]:
        raise ValueError(code)
    return {'translated': True, 'stableRootCount': 66, 'replacementCount': 7,
            'historicalRoots': old_historical,
            'receipt': old_recovery['receiptIdentity'],
            'recoveryDirectory': old_recovery['recoveryDirectory']}


def _validate_joint_measure_carryover(carry, runtime, expected_seed):
    runtime = Path(runtime).resolve(strict=True)
    window_path = Path(carry['window']['path']); parent = window_path.parent
    close_path = Path(carry['close']['path']); owned_path = Path(carry['ownedManifest']['path'])
    source_path = Path(carry['sourceManifest']['path']); supervision_path = Path(carry['supervision']['path'])
    supervisor_path = Path(carry['supervisor']['path']); output = Path(carry['output']['path'])
    if parent.parent != runtime or close_path.parent != parent or owned_path.parent != parent \
            or source_path.parent != parent or supervision_path != parent / 'supervision' / 'supervisor.json' \
            or supervisor_path != parent / 'supervisor.py' or output.parent != runtime \
            or output.name != carry['output']['label']:
        raise ValueError('JOINT_MEASURE_CARRYOVER')
    try:
        window, window_identity = _strict_json(window_path)
        close, close_identity = _strict_json(close_path)
        supervision, supervision_identity = _strict_json(supervision_path)
        supervisor_identity = _strict_identity(supervisor_path)
        command_identity = _strict_identity(output / 'command.json')
    except ValueError as error:
        raise ValueError('JOINT_MEASURE_CARRYOVER') from error
    bindings = ((window_identity, carry['window']['sha256']),
                (close_identity, carry['close']['sha256']),
                (supervision_identity, carry['supervision']['sha256']),
                (supervisor_identity, carry['supervisor']['sha256']),
                (command_identity, carry['output']['commandSha256']))
    measurement = close.get('measurement') if isinstance(close, dict) else None
    if any(identity['sha256'] != digest for identity, digest in bindings) \
            or window.get('id') != carry['window']['id'] \
            or window.get('scope') != 'musicbridge-capacity-measure-window' \
            or window.get('profile') != 'joint' or window.get('phase') != 'measure' \
            or window.get('seed') != expected_seed \
            or close.get('scope') != 'musicbridge-capacity-measure-window-close' \
            or close.get('windowId') != window.get('id') or close.get('profile') != 'joint' \
            or close.get('state') != 'passed' or close.get('failure') is not None \
            or close.get('code') != 0 or close.get('signals') != [] \
            or close.get('groupEmpty') is not True or close.get('zombies') != [] \
            or close.get('windowSha256') != carry['window']['sha256'] \
            or close.get('ownedManifestSha256') != carry['ownedManifest']['sha256'] \
            or close.get('sourceManifestSha256') != carry['sourceManifest']['sha256'] \
            or close.get('supervisorSha256') != carry['supervision']['sha256'] \
            or close.get('deviceOpened') is not False or close.get('formalReady') is not False \
            or close.get('gateB') != 'NOT_RUN' \
            or close.get('replayPolicy') != 'terminal-window-id-and-label-never-reuse' \
            or supervision.get('passed') is not True or supervision.get('failure') is not None \
            or supervision.get('code') != 0 or supervision.get('groupEmpty') is not True \
            or supervision.get('zombies') != [] \
            or not isinstance(measurement, dict) \
            or measurement.get('verifiedComplete') is not True \
            or measurement.get('verifiedPassed') is not True \
            or measurement.get('thresholdPassed') is not True \
            or measurement.get('sampleCount') != 1575 \
            or measurement.get('roundReceiptCount') != 105 \
            or measurement.get('aggregateBudgetValid') is not True:
        raise ValueError('JOINT_MEASURE_CARRYOVER')
    seed = _validate_measure_seed(runtime, window)
    planned = _measure_planned_bytes(seed['snapshotBytes'])
    owned = _validate_owned_manifest(
        owned_path, runtime, window['id'], 'joint', planned_bytes=planned,
        future_path=output, future_state='present')
    _require_measure_owned_roots(owned, parent, seed, output)
    try: source, source_identity = _strict_json(source_path)
    except ValueError as error: raise ValueError('JOINT_MEASURE_CARRYOVER') from error
    if source_identity['sha256'] != carry['sourceManifest']['sha256'] \
            or not isinstance(source, dict) or source.get('schemaVersion') != 1 \
            or source.get('scope') != 'musicbridge-capacity-source-pins' \
            or not isinstance(source.get('files'), dict) or not source['files']:
        raise ValueError('JOINT_MEASURE_CARRYOVER')
    try: manifest, _ = _strict_json(owned_path)
    except ValueError as error: raise ValueError('JOINT_MEASURE_CARRYOVER') from error
    roots = list(manifest['roots'])
    roots.append(_carryover_root_identity(output, 'command.json'))
    if len({row['path'] for row in roots}) != len(roots):
        raise ValueError('JOINT_MEASURE_CARRYOVER')
    return {'valid': True, 'roots': roots, 'window': window, 'close': close,
            'windowIdentity': window_identity, 'closeIdentity': close_identity,
            'sourceIdentity': source_identity, 'ownedIdentity': owned['manifestIdentity'],
            'seed': seed, 'outputIdentity': roots[-1]}


def _validate_joint_queued_stop_authority(parent, runtime, repo_root, window_sha256,
                                          terminal=False, initial=None):
    parent = Path(parent).resolve(strict=True); runtime = Path(runtime).resolve(strict=True)
    try:
        window, window_identity = _strict_json(parent / 'window.json')
        owner, owner_identity = _strict_json(parent / 'owner.json')
    except ValueError as error: raise ValueError('QUEUED_STOP_AUTHORITY') from error
    if window_identity['sha256'] != window_sha256 \
            or owner != {'scope': window.get('scope'), 'owner': 'root', 'id': window.get('id')}:
        raise ValueError('QUEUED_STOP_AUTHORITY')
    _validate_joint_queued_stop_window(
        window, time.time() if not terminal else datetime.datetime.fromisoformat(window['issuedAt']).timestamp())
    candidate = _validate_candidate_repository(window, runtime)
    if candidate != Path(repo_root).resolve(strict=True):
        raise ValueError('QUEUED_STOP_AUTHORITY')
    bound = _validate_joint_queued_stop_bound_identities(window, parent, candidate)
    carry = _validate_joint_measure_carryover(window['measureCarryover'], runtime, window['seed'])
    source = _validate_source_manifest(parent / 'source-pins.json', candidate)
    if source['manifestIdentity']['sha256'] != window['sourceManifest']['sha256']:
        raise ValueError('QUEUED_STOP_AUTHORITY')
    planned = window['queuedStopPlan']['plannedBytes']
    owned = _validate_owned_manifest(
        parent / 'owned-roots.json', runtime, window['id'], 'joint', planned_bytes=planned)
    required = {row['path'] for row in carry['roots']} | {str(parent), str(parent / 'issuer-identity')}
    if set(owned['rootIdentities']) != required \
            or owned['manifestIdentity']['sha256'] != window['ownedManifest']['sha256']:
        raise ValueError('QUEUED_STOP_AUTHORITY')
    snapshot = {'window': window_identity, 'owner': owner_identity,
                'source': source['manifestIdentity'], 'owned': owned['manifestIdentity'],
                'sourceFiles': source['fileIdentities'], 'ownedRoots': owned['rootIdentities'],
                'carryWindow': carry['windowIdentity'], 'carryClose': carry['closeIdentity'],
                'carrySource': carry['sourceIdentity'], 'carryOwned': carry['ownedIdentity'],
                'carrySeedMetadata': carry['seed']['metadataIdentity'],
                'carrySeedSnapshot': carry['seed']['snapshotIdentity'],
                'node': bound['node'], 'tsxLoader': bound['tsxLoader'],
                'consumerPython': bound['consumerPython'], 'issuer': bound['issuer'],
                'issuerFact': bound['issuerFact']}
    value = {'authorityStable': True, 'windowStable': True, 'ownerStable': True,
             'sourceManifestStable': True, 'ownedManifestStable': True,
             'sourcePinsValid': True, 'ownedRootsValid': True,
             'measureCarryoverValid': True, 'spaceValid': True,
             'toolchainStable': True, 'issuerStable': True,
             'windowSha256Observed': window_identity['sha256'],
             'ownerSha256Observed': owner_identity['sha256'],
             'sourceFileCount': source['fileCount'], 'ownedRootCount': owned['rootCount'],
             'ownedBytes': owned['ownedBytes'], 'plannedBytes': owned['plannedBytes'],
             'remainingPlannedBytes': 0 if terminal else owned['plannedBytes'],
             'availableBytes': owned['availableBytes'],
             'candidateRepository': window['candidateRepository'], '_snapshot': snapshot}
    if initial is not None and initial.get('_snapshot') != snapshot:
        raise ValueError('QUEUED_STOP_AUTHORITY_DRIFT')
    return value


def _validate_queued_stop_authority(parent, runtime, repo_root, window_sha256,
                                    terminal=False, initial=None):
    try: profile = _strict_json(Path(parent) / 'window.json')[0].get('profile')
    except ValueError as error: raise ValueError('QUEUED_STOP_AUTHORITY') from error
    if profile == 'joint':
        return _validate_joint_queued_stop_authority(
            parent, runtime, repo_root, window_sha256, terminal=terminal, initial=initial)
    parent = Path(parent).resolve(strict=True); runtime = Path(runtime).resolve(strict=True)
    try:
        window, window_identity = _strict_json(parent / 'window.json')
        owner, owner_identity = _strict_json(parent / 'owner.json')
    except ValueError as error: raise ValueError('QUEUED_STOP_AUTHORITY') from error
    if window_identity['sha256'] != window_sha256 \
            or owner != {'scope': window.get('scope'), 'owner': 'root', 'id': window.get('id')}:
        raise ValueError('QUEUED_STOP_AUTHORITY')
    _validate_queued_stop_window(window, time.time() if not terminal else
                                 datetime.datetime.fromisoformat(window['issuedAt']).timestamp())
    candidate = _validate_candidate_repository(window, runtime)
    if candidate != Path(repo_root).resolve(strict=True):
        raise ValueError('QUEUED_STOP_AUTHORITY')
    carry = _validate_queued_stop_measure_carryover(
        window['measureCarryover'], runtime, candidate_repository=window['candidateRepository'],
        expected_seed_sha256=window.get('seed', {}).get('snapshotSha256'),
        expected_fixture_owner_sha256=window.get('seed', {}).get('fixtureOwnerSha256'))
    bound_identities = _validate_queued_stop_bound_identities(
        window, parent, candidate,
        runtime_relocation=carry['rootRecovery'].get('liveRootRemap'))
    expected_process_inherited = [*carry['roots'], *bound_identities['issuerFailureRoots'],
                                  *bound_identities['prechildFailureRoots']]
    if len(expected_process_inherited) != _QUEUED_STOP_BASE_ROOTS \
            or not 1 <= len(bound_identities['processFailures']) <= 64:
        raise ValueError('QUEUED_STOP_PROCESS_FAILURE_ROOTS')
    process_lineage = [_validate_queued_stop_process_recovery_lineage(
        runtime, snapshot.get('historicalMeasure'), snapshot.get('inheritedRoots'),
        expected_process_inherited, carry['rootRecovery'].get('mappings'),
        runtime_relocation=carry['rootRecovery'].get('liveRootRemap'))
        for snapshot in bound_identities['processFailures']]
    source = _validate_phase_source_manifest(parent / 'source-pins.json', candidate)
    if source['manifestIdentity']['sha256'] != window['sourceManifest']['sha256']:
        raise ValueError('QUEUED_STOP_AUTHORITY')
    carry_roots = [*carry['roots'], *bound_identities['issuerFailureRoots'],
                   *bound_identities['prechildFailureRoots'],
                   *bound_identities['processFailureRoots']]
    owned = _validate_queued_stop_owned_manifest(
        parent / 'owned-roots.json', runtime, window['id'], parent, carry_roots,
        window['queuedStopPlan']['plannedBytes'],
        carry['rootRecovery']['liveDeviceRemap']['currentDevice'], terminal=terminal)
    direct_billing_roots = [*carry_roots,
                            _carryover_root_identity(parent, 'owner.json'),
                            _carryover_root_identity(parent / 'issuer-identity', 'owner.json')]
    owned = _apply_queued_stop_transitive_billing(
        owned, direct_billing_roots, bound_identities['processFailureBillingRoots'],
        parent, terminal)
    if owned['manifestIdentity']['sha256'] != window['ownedManifest']['sha256']:
        raise ValueError('QUEUED_STOP_AUTHORITY')
    value = {'authorityStable': True, 'windowStable': True, 'ownerStable': True,
             'sourceManifestStable': True, 'ownedManifestStable': True,
             'sourcePinsValid': True, 'ownedRootsValid': True, 'measureCarryoverValid': True,
             'issuerFailureCarryoverValid': True,
             'prechildFailureCarryoverValid': True,
             'processFailureCarryoverValid': True,
             'spaceValid': True, 'windowSha256Observed': window_identity['sha256'],
             'ownerSha256Observed': owner_identity['sha256'], 'sourceFileCount': source['fileCount'],
             'ownedRootCount': owned['rootCount'], 'issuerFailureCount': len(bound_identities['issuerFailures']),
             'prechildFailureCount': len(bound_identities['prechildFailures']),
             'processFailureCount': len(bound_identities['processFailures']),
             'ownedBytes': owned['ownedBytes'],
             'plannedBytes': owned['plannedBytes'], 'remainingPlannedBytes': owned['remainingPlannedBytes'],
             'availableBytes': owned['availableBytes'], 'candidateRepository': window['candidateRepository'],
             'toolchainStable': True, 'issuerStable': True,
             '_snapshot': {'window': window_identity, 'owner': owner_identity,
                           'source': source['manifestIdentity'], 'owned': owned['manifestIdentity'],
                           'node': bound_identities['node'], 'tsxLoader': bound_identities['tsxLoader'],
                           'consumerPython': bound_identities['consumerPython'],
                           'issuer': bound_identities['issuer'], 'issuerFact': bound_identities['issuerFact'],
                           'buildHelper': bound_identities['buildHelper'],
                           'buildNode': bound_identities['buildNode'],
                           'buildNodeLibrary': bound_identities['buildNodeLibrary'],
                           'typescriptCompiler': bound_identities['typescriptCompiler'],
                           'typescriptLibraries': bound_identities['typescriptLibraries'],
                           'measureRootRecovery': carry.get('rootRecovery'),
                           'issuerFailures': bound_identities['issuerFailures'],
                           'prechildFailures': bound_identities['prechildFailures'],
                           'processFailures': bound_identities['processFailures'],
                           'processFailureBillingRoots': bound_identities['processFailureBillingRoots'],
                           'processFailureLineage': process_lineage}}
    if initial is not None:
        for key in ('window', 'owner', 'source', 'owned', 'node', 'tsxLoader',
                    'consumerPython', 'issuer', 'issuerFact', 'buildHelper', 'buildNode',
                    'buildNodeLibrary', 'typescriptCompiler', 'typescriptLibraries',
                    'measureRootRecovery', 'issuerFailures',
                    'prechildFailures', 'processFailures', 'processFailureBillingRoots',
                    'processFailureLineage'):
            if initial.get('_snapshot', {}).get(key) != value['_snapshot'][key]:
                raise ValueError('QUEUED_STOP_AUTHORITY_DRIFT')
    return value


def _queued_stop_budget(output, plan):
    file = Path(output) / _QUEUED_STOP_AUDIT
    result = {'valid': False, 'rowCount': 0, 'finalOutputBytes': None, 'fileIdentity': None}
    try:
        identity = _strict_identity(file, 16 * 1024 * 1024)
        rows, observed_identity = _legacy_jsonl(file)
        if observed_identity != identity: return result
        if not rows: return result
        keys = {'schemaVersion', 'scope', 'sequence', 'checkpoint', 'group', 'activeClone',
                'snapshotBytes', 'limitBytes', 'outputBytesBefore', 'plannedBytes', 'recordedAt'}
        if len(rows) != 843:
            return result
        checkpoints = ('clone-before-write', 'clone-after-write', 'operation-returned',
                       'sample-evidence-written', 'retention-written',
                       'group-receipt-before-write', 'group-receipt-after-write',
                       'clone-after-cleanup')
        expected = [(None, 'output-created', None), (None, 'input-written', None)]
        for sample in range(1, 106):
            group = f'sample-{sample:03d}'
            expected.extend((group, checkpoint,
                             None if checkpoint in ('clone-before-write', 'clone-after-cleanup') else group)
                            for checkpoint in checkpoints)
        expected.append((None, 'terminal-written', None))
        for index, (row, shape) in enumerate(zip(rows, expected), 1):
            group, checkpoint, active_clone = shape
            if not isinstance(row, dict) or set(row) != keys or row.get('schemaVersion') != 1 \
                    or row.get('scope') != 'musicbridge-capacity-queued-stop-aggregate-budget' \
                    or row.get('sequence') != index or row.get('checkpoint') != checkpoint \
                    or row.get('group') != group or row.get('activeClone') != active_clone \
                    or row.get('snapshotBytes') != plan['snapshotBytes'] \
                    or row.get('limitBytes') != plan['plannedBytes'] \
                    or type(row.get('outputBytesBefore')) is not int \
                    or type(row.get('plannedBytes')) is not int \
                    or not 0 <= row['outputBytesBefore'] <= plan['plannedBytes'] \
                    or not 0 <= row['plannedBytes'] <= plan['plannedBytes'] - row['outputBytesBefore'] \
                    or datetime.datetime.fromisoformat(str(row.get('recordedAt'))).utcoffset() is None:
                return result
        if rows[-1]['activeClone'] is not None or rows[-1]['plannedBytes'] != 0: return result
        tree_bytes, _ = _directory_bytes(output, maximum=plan['plannedBytes'])
        result.update(valid=tree_bytes <= plan['plannedBytes'], rowCount=len(rows),
                      finalOutputBytes=tree_bytes, fileIdentity=identity)
    except (OSError, ValueError, TypeError):
        pass
    return result


def _queued_exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def _queued_number(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 2 ** 53 - 1


def _queued_space_valid(value, maximum_planned):
    return _queued_exact(value, {'availableBytes', 'plannedBytes', 'ownedBytes'}) \
        and all(type(value.get(key)) is int and value[key] >= 0
                for key in ('availableBytes', 'plannedBytes', 'ownedBytes')) \
        and value['plannedBytes'] <= maximum_planned \
        and value['availableBytes'] - value['plannedBytes'] >= _QUEUED_STOP_LIMITS['minimumFreeBytes'] \
        and value['ownedBytes'] + value['plannedBytes'] <= _QUEUED_STOP_LIMITS['maximumOwnedBytes']


def _queued_distribution(values, limit_p95=None, limit_max=None):
    values = sorted(values)
    def rank(percent): return values[math.ceil(len(values) * percent) - 1] if values else None
    result = {'n': len(values), 'p50': rank(.5), 'p95': rank(.95),
              'p99': rank(.99), 'max': values[-1] if values else None}
    if limit_p95 is not None:
        result.update(limitP95=limit_p95, limitMax=limit_max,
                      passed=len(values) == 100 and result['p95'] <= limit_p95
                      and result['max'] <= limit_max)
    elif limit_max is not None:
        result.update(limitMax=limit_max,
                      passed=len(values) == 100 and result['max'] <= limit_max)
    return result


def _queued_stop_measurement(raw, plan_id=None, plan_hash=None):
    raw_keys = {'outcome', 'requestId', 'childPid', 'code', 'signal', 'closed', 'cleanup',
                'forkToCloseMs', 'phase', 'timings', 'processGroup', 'result'}
    timing_keys = {'clock', 'readyMs', 'receiptMs', 'exitMs',
                   'sendStopToReceiptMs', 'receiptToChildCloseMs'}
    result_keys = {'kind', 'planId', 'planHash', 'attemptId', 'order', 'progressFrames',
                   'fullAuditMs', 'beginMs', 'progressMs', 'abortObserved',
                   'driverStopInvoked', 'driverStopAcknowledged', 'stopReceivedToAbortMs',
                   'stopReceivedToDriverStopInvokedMs', 'stopReceivedToDriverStopAckMs',
                   'stopReceivedToReceiptMs', 'driverCloseInvoked', 'driverCloseResolved',
                   'stopReceivedToDriverCloseInvokedMs', 'stopReceivedToDriverCloseResolvedMs',
                   'childMeasuredMs', 'clock', 'deviceOpened', 'formalReady', 'gateB'}
    if not _queued_exact(raw, raw_keys) or raw.get('outcome') != 'ok' \
            or not _uuid4(raw.get('requestId')) or type(raw.get('childPid')) is not int \
            or raw['childPid'] <= 0 or raw.get('code') != 0 or raw.get('signal') is not None \
            or raw.get('closed') is not True or raw.get('cleanup') != {'termSent': False, 'killSent': False} \
            or raw.get('phase') != 'exited' or not _queued_number(raw.get('forkToCloseMs')) \
            or raw['forkToCloseMs'] > _QUEUED_STOP_LIMITS['executionMs']:
        return None
    timings = raw.get('timings'); group = raw.get('processGroup'); value = raw.get('result')
    if not _queued_exact(timings, timing_keys) or timings.get('clock') != 'parent-relative' \
            or not all(_queued_number(timings.get(key)) for key in timing_keys - {'clock'}) \
            or not timings['readyMs'] <= timings['receiptMs'] <= timings['exitMs'] <= raw['forkToCloseMs'] \
            or timings['receiptMs'] + timings['receiptToChildCloseMs'] > raw['forkToCloseMs'] \
            or not _queued_exact(group, {'pgid', 'managed', 'groupEmpty', 'zombies'}) \
            or group != {'pgid': raw['childPid'], 'managed': True, 'groupEmpty': True, 'zombies': []} \
            or not _queued_exact(value, result_keys) or value.get('kind') != 'queue' \
            or not _uuid4(value.get('planId')) or _SHA256.fullmatch(str(value.get('planHash', ''))) is None \
            or plan_id is not None and value['planId'] != plan_id \
            or plan_hash is not None and value['planHash'] != plan_hash \
            or not _uuid4(value.get('attemptId')) or value.get('order') != ['progress', 'stop'] \
            or value.get('progressFrames') != 1 or value.get('abortObserved') is not True \
            or value.get('driverStopInvoked') is not True or value.get('driverStopAcknowledged') is not True \
            or value.get('driverCloseInvoked') is not True or value.get('driverCloseResolved') is not True \
            or value.get('clock') != 'child-relative' or value.get('deviceOpened') is not False \
            or value.get('formalReady') is not False or value.get('gateB') != 'NOT_RUN':
        return None
    numeric = ('fullAuditMs', 'beginMs', 'progressMs', 'stopReceivedToAbortMs',
               'stopReceivedToDriverStopInvokedMs', 'stopReceivedToDriverStopAckMs',
               'stopReceivedToReceiptMs', 'stopReceivedToDriverCloseInvokedMs',
               'stopReceivedToDriverCloseResolvedMs', 'childMeasuredMs')
    if not all(_queued_number(value.get(key)) for key in numeric) \
            or not value['stopReceivedToAbortMs'] <= value['stopReceivedToDriverStopInvokedMs'] \
            <= value['stopReceivedToDriverStopAckMs'] <= value['stopReceivedToReceiptMs'] \
            <= value['stopReceivedToDriverCloseInvokedMs'] \
            <= value['stopReceivedToDriverCloseResolvedMs'] <= value['childMeasuredMs']:
        return None
    return {'childProgressMs': value['progressMs'],
            'stopReceivedToAbortMs': value['stopReceivedToAbortMs'],
            'stopReceivedToDriverStopInvokedMs': value['stopReceivedToDriverStopInvokedMs'],
            'stopReceivedToDriverStopAckMs': value['stopReceivedToDriverStopAckMs'],
            'stopReceivedToReceiptMs': value['stopReceivedToReceiptMs'],
            'parentSendStopToReceiptMs': timings['sendStopToReceiptMs'],
            'parentReceiptToChildCloseMs': timings['receiptToChildCloseMs'],
            'driverCloseInvokedMs': value['stopReceivedToDriverCloseInvokedMs'],
            'driverCloseResolvedMs': value['stopReceivedToDriverCloseResolvedMs']}


def _queued_stop_summary(measurements):
    field = lambda key: [value[key] for value in measurements]
    summary = {'counts': {'warmup': 5, 'formal': 100},
               'childProgressMs': _queued_distribution(field('childProgressMs'), 50, 100),
               'stopReceivedToAbortMs': _queued_distribution(field('stopReceivedToAbortMs'), limit_max=100),
               'stopReceivedToDriverStopInvokedMs': _queued_distribution(
                   field('stopReceivedToDriverStopInvokedMs'), limit_max=100),
               'stopReceivedToDriverStopAckMs': _queued_distribution(field('stopReceivedToDriverStopAckMs')),
               'stopReceivedToReceiptMs': _queued_distribution(field('stopReceivedToReceiptMs'), 500, 2000),
               'parentSendStopToReceiptMs': _queued_distribution(field('parentSendStopToReceiptMs'), limit_max=2000),
               'parentReceiptToChildCloseMs': _queued_distribution(field('parentReceiptToChildCloseMs')),
               'driverCloseInvokedMs': _queued_distribution(field('driverCloseInvokedMs')),
               'driverCloseResolvedMs': _queued_distribution(field('driverCloseResolvedMs'), limit_max=250),
               'passed': False}
    summary['passed'] = all(summary[key]['passed'] for key in (
        'childProgressMs', 'stopReceivedToAbortMs', 'stopReceivedToDriverStopInvokedMs',
        'stopReceivedToReceiptMs', 'parentSendStopToReceiptMs', 'driverCloseResolvedMs'))
    return summary


def _validate_queued_stop_artifacts(parent, expected=None):
    parent = Path(parent)
    window = expected.get('window') if isinstance(expected, dict) else None
    window_sha256 = expected.get('windowSha256') if isinstance(expected, dict) else None
    output = parent / str(window.get('label', '')) if isinstance(window, dict) else parent
    result = {'outputDirectory': str(output), 'verifiedComplete': False, 'verifiedPassed': False,
              'fileCount': 0, 'sampleCount': 0, 'uniqueChildPids': 0,
              'aggregateBudgetValid': False, 'unexpectedEntries': []}
    try:
        if not output.is_dir() or output.is_symlink(): return result
        expected_names = {'owner.json', 'input.json', 'samples.jsonl', 'summary.json', 'exit.json', _QUEUED_STOP_AUDIT}
        for index in range(1, 106):
            name = f'sample-{index:03d}'
            expected_names.update((f'{name}-intent.json', f'{name}-raw-receipt.json',
                                   f'{name}-raw-receipt.sha256.json', f'{name}.json',
                                   f'{name}-retention.json', f'{name}.receipt.json'))
        entries = list(output.iterdir()); observed_names = {entry.name for entry in entries}
        result['fileCount'] = len(entries); result['unexpectedEntries'] = sorted(observed_names - expected_names)
        if observed_names != expected_names or len(entries) != 636 \
                or any(not _ordinary_file(entry) or entry.stat().st_nlink != 1 for entry in entries):
            return result
        owner, _ = _strict_json(output / 'owner.json')
        input_value, _ = _strict_json(output / 'input.json')
        args = input_value.get('args') if isinstance(input_value, dict) else None
        initial_space = input_value.get('initialSpace') if isinstance(input_value, dict) else None
        operation_limits = input_value.get('effectiveOperationLimits') if isinstance(input_value, dict) else None
        if not _queued_exact(owner, {'scope', 'id', 'windowId', 'label'}) \
                or owner.get('scope') != 'musicbridge-capacity-phase-output' or not _uuid4(owner.get('id')) \
                or owner.get('windowId') != window['id'] or owner.get('label') != window['label'] \
                or not _queued_exact(input_value, {'args', 'windowId', 'seedSha256', 'sourceManifestSha256',
                                                   'initialSpace', 'effectiveOperationLimits', 'classification',
                                                   'cache', 'n', 'warmup', 'formalSamples', 'clocks', 'backend',
                                                   'deviceOpened', 'formalReady', 'gateB'}) \
                or not _queued_exact(args, {'phase', 'profile', 'label', 'seedLabel', 'windowPath',
                                            'windowSha256', 'ownedRootsPath', 'ownedRootsSha256'}) \
                or args.get('phase') != 'queued-stop' or args.get('profile') != window['profile'] \
                or args.get('label') != window['label'] or args.get('seedLabel') != window['seedLabel'] \
                or args.get('windowPath') != str(parent / 'window.json') \
                or args.get('ownedRootsPath') != str(parent / 'owned-roots.json') \
                or _SHA256.fullmatch(str(window_sha256 or '')) is None \
                or args.get('windowSha256') != window_sha256 \
                or args.get('ownedRootsSha256') != window['ownedManifest']['sha256'] \
                or input_value.get('windowId') != window['id'] \
                or input_value.get('seedSha256') != window['seed']['snapshotSha256'] \
                or input_value.get('sourceManifestSha256') != window['sourceManifest']['sha256'] \
                or not _queued_space_valid(initial_space, window['queuedStopPlan']['plannedBytes']) \
                or initial_space.get('plannedBytes') != window['queuedStopPlan']['plannedBytes'] \
                or operation_limits != {'executionMs': 50000, 'killGraceMs': 1000, 'closeMs': 2000,
                                         'admissionReserveMs': 53000} \
                or input_value.get('classification') != 'software-only/exclusive-window' \
                or not isinstance(input_value.get('cache'), str) or not input_value['cache'] \
                or input_value.get('n') != 105 or input_value.get('warmup') != 5 \
                or input_value.get('formalSamples') != 100 \
                or input_value.get('clocks') != 'parent与child分栏，不跨进程相减' \
                or input_value.get('backend') != 'private-immediate-fake' \
                or input_value.get('deviceOpened') is not False \
                or input_value.get('formalReady') is not False or input_value.get('gateB') != 'NOT_RUN':
            return result
        rows, _ = _legacy_jsonl(output / 'samples.jsonl')
        if len(rows) != 105: return result
        child_pids = set(); request_ids = set(); attempt_ids = set(); marker_ids = set()
        valid = True; measurements = []; plan_id = None; plan_hash = None
        durations = []
        for index in range(1, 106):
            name = f'sample-{index:03d}'
            intent, _ = _strict_json(output / f'{name}-intent.json')
            raw, raw_identity = _strict_json(output / f'{name}-raw-receipt.json')
            raw_hash, _ = _strict_json(output / f'{name}-raw-receipt.sha256.json')
            row, _ = _strict_json(output / f'{name}.json')
            retention, _ = _strict_json(output / f'{name}-retention.json')
            receipt, _ = _strict_json(output / f'{name}.receipt.json')
            pid = raw.get('childPid'); raw_result = raw.get('result') if isinstance(raw, dict) else None
            measurement = _queued_stop_measurement(raw, plan_id, plan_hash)
            if measurement is not None and plan_id is None:
                plan_id = raw_result['planId']; plan_hash = raw_result['planHash']
            if index > 5 and measurement is not None: measurements.append(measurement)
            row_keys = {'index', 'phase', 'profile', 'warmup', 'preparationMs',
                        'outcome', 'result', 'beforeSpace'}
            before_space = row.get('beforeSpace') if isinstance(row, dict) else None
            marker = receipt.get('marker') if isinstance(receipt, dict) else None
            request_id = raw.get('requestId') if isinstance(raw, dict) else None
            attempt_id = raw_result.get('attemptId') if isinstance(raw_result, dict) else None
            marker_id = marker.get('id') if isinstance(marker, dict) else None
            if intent != {'index': index, 'phase': 'queued-stop', 'profile': window['profile'],
                          'windowId': window['id'], 'seedSha256': window['seed']['snapshotSha256'],
                          'state': 'operation-not-yet-returned'} \
                    or raw_hash != {'sha256': raw_identity['sha256']} \
                    or measurement is None or pid in child_pids or request_id in request_ids \
                    or attempt_id in attempt_ids or marker_id in marker_ids \
                    or not _queued_exact(row, row_keys) or not _queued_number(row.get('preparationMs')) \
                    or row.get('index') != index or row.get('warmup') is not (index <= 5) \
                    or row.get('phase') != 'queued-stop' or row.get('profile') != window['profile'] \
                    or row.get('outcome') != 'ok' or row.get('result') != raw or rows[index - 1] != row \
                    or not _queued_space_valid(before_space, window['queuedStopPlan']['plannedBytes']) \
                    or not _queued_exact(retention, {'retained', 'resourcesClosed', 'space'}) \
                    or retention.get('retained') is not False or retention.get('resourcesClosed') is not True \
                    or retention.get('space') != {'availableBytes': retention.get('space', {}).get('availableBytes'),
                                                  'plannedBytes': 0,
                                                  'ownedBytes': retention.get('space', {}).get('ownedBytes')} \
                    or not _queued_space_valid(retention['space'], window['queuedStopPlan']['plannedBytes']) \
                    or not _queued_exact(receipt, {'outcome', 'resourcesClosed', 'samples', 'marker',
                                                   'sqliteSha256', 'retained', 'workspaceReceipt',
                                                   'workspaceTreeSha256'}) \
                    or receipt.get('outcome') != 'ok' or receipt.get('resourcesClosed') is not True \
                    or receipt.get('samples') != [raw] or receipt.get('retained') is not False \
                    or receipt.get('workspaceReceipt') is not None or receipt.get('workspaceTreeSha256') is not None \
                    or not _queued_exact(marker, {'id', 'scope', 'label'}) or not _uuid4(marker.get('id')) \
                    or marker.get('scope') != 'musicbridge-capacity-clone-only' or marker.get('label') != name \
                    or _SHA256.fullmatch(str(receipt.get('sqliteSha256', ''))) is None:
                valid = False
            child_pids.add(pid)
            request_ids.add(request_id); attempt_ids.add(attempt_id); marker_ids.add(marker_id)
            if measurement is not None: durations.append(raw['forkToCloseMs'])
        summary, _ = _strict_json(output / 'summary.json')
        exit_value, _ = _strict_json(output / 'exit.json')
        queue = summary.get('queuedStop') if isinstance(summary, dict) else None
        expected_queue = _queued_stop_summary(measurements)
        sorted_durations = sorted(durations)
        expected_median = (sorted_durations[52] + sorted_durations[52]) / 2 if len(sorted_durations) == 105 else None
        summary_valid = _queued_exact(summary, {'phase', 'profile', 'state', 'planned', 'attempted',
                                                'successes', 'failures', 'timeouts', 'unrun', 'minMs',
                                                'medianMs', 'maxMs', 'p99', 'queuedStop', 'deviceOpened',
                                                'formalReady', 'gateB'}) \
            and summary.get('phase') == 'queued-stop' and summary.get('profile') == window['profile'] \
            and summary.get('state') == 'passed' and summary.get('planned') == 105 \
            and summary.get('attempted') == 105 and summary.get('successes') == 105 \
            and summary.get('failures') == 0 and summary.get('timeouts') == 0 and summary.get('unrun') == 0 \
            and summary.get('minMs') == (sorted_durations[0] if len(sorted_durations) == 105 else None) \
            and summary.get('medianMs') == expected_median \
            and summary.get('maxMs') == (sorted_durations[-1] if len(sorted_durations) == 105 else None) \
            and summary.get('p99') is None and queue == expected_queue and queue.get('passed') is True \
            and summary.get('deviceOpened') is False \
            and summary.get('formalReady') is False and summary.get('gateB') == 'NOT_RUN' \
            and exit_value == {'exit': 0}
        aggregate = _queued_stop_budget(output, window['queuedStopPlan'])
        result.update(sampleCount=len(rows), uniqueChildPids=len(child_pids),
                      aggregateBudgetValid=aggregate['valid'], aggregateBudget=aggregate)
        complete = valid and summary_valid and len(child_pids) == 105 and aggregate['valid']
        result['verifiedComplete'] = complete; result['verifiedPassed'] = complete
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return result


def _queued_stop_replay_identities(value):
    if not isinstance(value, dict): raise ValueError('QUEUED_STOP_REPLAY_AUDIT')
    observed = set()
    for key in ('id', 'windowId', 'label', 'window', 'windowDirName'):
        identity = value.get(key)
        if identity is None: continue
        if key == 'window' and isinstance(identity, dict):
            if value.get('scope') != 'musicbridge-capacity-generation-close':
                raise ValueError('QUEUED_STOP_REPLAY_AUDIT')
            for nested_key in ('id', 'windowId', 'label', 'windowDirName'):
                nested = identity.get(nested_key)
                if nested is None: continue
                if not isinstance(nested, str): raise ValueError('QUEUED_STOP_REPLAY_AUDIT')
                observed.add(nested)
            if not isinstance(identity.get('id'), str) or not isinstance(identity.get('label'), str):
                raise ValueError('QUEUED_STOP_REPLAY_AUDIT')
            continue
        if not isinstance(identity, str): raise ValueError('QUEUED_STOP_REPLAY_AUDIT')
        observed.add(identity)
    return observed


def _reject_queued_stop_replay(runtime, parent, window):
    runtime = Path(runtime).resolve(strict=True); parent = Path(parent).resolve(strict=True)
    target = _queued_stop_replay_identities({
        'id': window.get('id'), 'label': window.get('label'), 'windowDirName': parent.name})
    for candidate in sorted(runtime.iterdir(), key=lambda value: value.name):
        if candidate == parent: continue
        if candidate.is_symlink(): raise ValueError('QUEUED_STOP_REPLAY_AUDIT')
        paths = []
        if candidate.is_dir() and not candidate.is_symlink():
            paths.extend((candidate / 'window.json', candidate / 'close.json',
                          candidate / 'issuer-failure.json', candidate / 'prechild-failure.json'))
        elif candidate.is_file() and not candidate.is_symlink() and candidate.name.endswith('-close.json'):
            paths.append(candidate)
        for path in paths:
            if not path.exists() and not path.is_symlink(): continue
            try: value, _ = _strict_json(path, 32 * 1024 * 1024)
            except ValueError as error: raise ValueError('QUEUED_STOP_REPLAY_AUDIT') from error
            observed = _queued_stop_replay_identities(value)
            if target & observed: raise ValueError('QUEUED_STOP_REPLAY')
    if (parent / 'close.json').exists() or (parent / 'close.json').is_symlink() \
            or (parent / 'issuer-failure.json').exists() or (parent / 'issuer-failure.json').is_symlink() \
            or (parent / 'prechild-failure.json').exists() or (parent / 'prechild-failure.json').is_symlink():
        raise ValueError('QUEUED_STOP_REPLAY')
    return True


def _write_queued_stop_close(parent, window, result, admission, terminal_probe, artifact_probe):
    parent = Path(parent)
    try: artifacts = artifact_probe()
    except Exception as error: artifacts = {'verifiedComplete': False, 'verifiedPassed': False,
                                             'probeError': type(error).__name__}
    if artifacts.get('verifiedComplete') is not True or artifacts.get('verifiedPassed') is not True:
        if result.get('failure') is None: result['failure'] = 'QUEUED_STOP_EVIDENCE_FAILED'
        result['passed'] = False
    try: terminal = terminal_probe()
    except Exception as error:
        terminal = {'authorityStable': False, 'error': type(error).__name__}
        result['failure'] = 'AUTHORITY_DRIFT'; result['passed'] = False
    value = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-queued-stop-window-close',
             'windowId': window['id'], 'profile': window['profile'], 'label': window['label'],
             'seedLabel': window['seedLabel'], 'closedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'state': 'passed' if result.get('passed') is True else 'failed',
             'failure': result.get('failure'), 'pid': result.get('pid'), 'pgid': result.get('pgid'),
             'managedProcessGroup': result.get('managedProcessGroup'), 'code': result.get('code'),
             'exitSignal': result.get('exitSignal'), 'signals': result.get('signals'),
             'groupEmpty': result.get('groupEmpty'), 'zombies': result.get('zombies'),
             'elapsedMs': result.get('elapsedMs'), 'windowSha256': admission.get('windowSha256Observed'),
             'sourceManifestSha256': window['sourceManifest']['sha256'],
             'ownedManifestSha256': window['ownedManifest']['sha256'], 'seed': window['seed'],
             'measureCarryover': window['measureCarryover'],
             'authorityAdmission': {key: value for key, value in admission.items() if key != '_snapshot'},
             'authorityTerminal': {key: value for key, value in terminal.items() if key != '_snapshot'},
             'queuedStop': artifacts,
             'supervisorSha256': _sha(parent / 'supervision' / 'supervisor.json')
                 if _ordinary_file(parent / 'supervision' / 'supervisor.json') else None,
             'stdout': result.get('stdout'), 'stderr': result.get('stderr'),
             'deviceOpened': False, 'formalReady': False, 'gateB': 'NOT_RUN',
             'replayPolicy': 'terminal-window-id-and-label-never-reuse'}
    _write(parent / 'close.json', value)
    return value


def _main_queued_stop(argv, loaded=None):
    runtime, parent, window, loaded_identity = loaded if loaded is not None else _load_window(argv)
    _, deadline = _validate_queued_stop_window(window, time.time())
    try: _require_loaded_window_identity(parent, loaded_identity)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    try: _reject_queued_stop_replay(runtime, parent, window)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    try:
        root = _validate_candidate_repository(window, runtime)
        admission = _validate_queued_stop_authority(
            parent, runtime, root, loaded_identity['sha256'], terminal=False)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    output = parent / window['label']
    if output.exists() or output.is_symlink() or (parent / 'supervision').exists() \
            or (parent / 'close.json').exists() or (parent / 'close.json').is_symlink():
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    node = Path(window['toolchain']['node']['path'])
    tsx_loader = Path(window['toolchain']['tsxLoader']['path'])
    entry = root / 'packages/bridge-core/test/benchmarks/recording-capacity-process.ts'
    try: _strict_identity(entry, 8 * 1024 * 1024)
    except ValueError as error: raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    command = [str(node), '--import', str(tsx_loader), str(entry), '--phase', 'queued-stop',
               '--profile', window['profile'], '--label', window['label'],
               '--seed-label', window['seedLabel'], '--window', str(parent / 'window.json'),
               '--window-sha256', loaded_identity['sha256'], '--owned-roots', str(parent / 'owned-roots.json'),
               '--owned-roots-sha256', window['ownedManifest']['sha256']]
    environment = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C', 'LC_ALL': 'C',
                   'TZ': 'UTC', 'CI': '1', 'TMPDIR': str(Path(tempfile.gettempdir()).resolve(strict=True))}
    expected = {'window': window, 'windowSha256': loaded_identity['sha256']}
    try:
        _require_loaded_window_identity(parent, loaded_identity)
        _reject_queued_stop_replay(runtime, parent, window)
        _validate_queued_stop_authority(
            parent, runtime, root, loaded_identity['sha256'], terminal=False, initial=admission)
    except ValueError as error:
        raise SystemExit('CAPACITY_SUPERVISOR_INPUT') from error
    def terminal_authority():
        _reject_queued_stop_replay(runtime, parent, window)
        return _validate_queued_stop_authority(
            parent, runtime, root, loaded_identity['sha256'], terminal=True, initial=admission)
    result = supervise(command, time.monotonic() + (deadline - time.time()), parent / 'supervision',
                       grace=window['limits']['killGraceMs'] / 1000,
                       close_budget=window['limits']['closeMs'] / 1000,
                       artifact_probe=lambda: _validate_queued_stop_artifacts(parent, expected),
                       cwd=root, environment=environment, capture_output=True, stdin=subprocess.DEVNULL,
                       artifact_name='queuedStop', artifact_failure='QUEUED_STOP_EVIDENCE_FAILED')
    _write_queued_stop_close(parent, window, result, admission, terminal_authority,
                             lambda: _validate_queued_stop_artifacts(parent, expected))
    return 0 if result.get('passed') is True else 1


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


def _write_generation_close(parent, window, result, authority_initial, authority_probe):
    """把generation终态封成独立不可重放收据，供下一阶段验证原始PASS链。"""
    parent = Path(parent)
    generation = result.get('generation')
    if not isinstance(generation, dict) or generation.get('verifiedPassed') is not True:
        if result.get('failure') is None: result['failure'] = 'GENERATION_EVIDENCE_FAILED'
        result['passed'] = False
    try:
        terminal_value = authority_probe()
        authority_terminal = {key: value for key, value in terminal_value.items() if key != '_snapshot'}
    except ValueError as error:
        authority_terminal = {'authorityStable': False, 'error': str(error)}
        result['failure'] = 'AUTHORITY_DRIFT'; result['passed'] = False
    clean_authority = {key: value for key, value in authority_initial.items() if key != '_snapshot'}
    value = {
        'schemaVersion': 1, 'scope': 'musicbridge-capacity-generation-window-close',
        'windowId': window['id'], 'profile': window['profile'], 'label': window['label'],
        'closedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'state': 'passed' if result.get('passed') is True else 'failed',
        'failure': result.get('failure'), 'pid': result.get('pid'), 'pgid': result.get('pgid'),
        'managedProcessGroup': result.get('managedProcessGroup'), 'code': result.get('code'),
        'exitSignal': result.get('exitSignal'), 'signals': result.get('signals'),
        'groupEmpty': result.get('groupEmpty'), 'zombies': result.get('zombies'),
        'elapsedMs': result.get('elapsedMs'),
        'windowSha256': clean_authority.get('windowSha256Observed'),
        'sourceManifestSha256': window['sourceManifest']['sha256'],
        'ownedManifestSha256': window['ownedManifest']['sha256'],
        'authorityAdmission': clean_authority, 'authorityTerminal': authority_terminal,
        'generation': generation,
        'supervisorSha256': _sha(parent / 'supervision' / 'supervisor.json')
            if _ordinary_file(parent / 'supervision' / 'supervisor.json') else None,
        'stdout': result.get('stdout'), 'stderr': result.get('stderr'),
        'deviceOpened': False, 'formalReady': False, 'gateB': 'NOT_RUN',
        'replayPolicy': 'terminal-window-id-and-label-never-reuse'}
    _write(parent / 'close.json', value)
    return value


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
    terminal_authority = lambda: _validate_generation_authority(
        parent, runtime, root, _sha(parent / 'window.json'), window['profile'], authority_initial)
    result = supervise(command, time.monotonic() + (deadline - time.time()), parent / 'supervision',
                       grace=window['limits']['killGraceMs'] / 1000,
                       close_budget=window['limits']['closeMs'] / 1000,
                       artifact_probe=lambda: _generation_artifacts(runtime, window['label'], expected),
                       cwd=root, environment=environment, capture_output=True, stdin=subprocess.DEVNULL)
    _write_generation_close(parent, window, result, authority_initial, terminal_authority)
    return 0 if result['passed'] else 1


def _measurement_identity_closure(value):
    if not isinstance(value, dict): return None
    keys = ('files', 'receiptInventory', 'retainedInventory', 'roundReceiptInventory',
            'workspaceReceiptInventory', 'fixtureTreeInventory',
            'unexpectedEntries', 'measurePlan', 'sampleCount', 'receiptCount',
            'roundReceiptCount', 'stageCount', 'samplesValid', 'receiptsValid',
            'workspaceReceiptValid', 'fixtureTreeValid', 'roundReceiptsValid',
            'stageEvidenceValid', 'partialEvidenceValid', 'aggregateBudgetValid',
            'aggregateBudgetRowCount', 'aggregateBudgetSnapshotBytes',
            'aggregateBudgetLimitBytes', 'aggregateOutputBytes', 'aggregateBudgetIdentity')
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


def main(argv):
    # 旧版phase通过`--`任意透传命令；successor只允许由scope固定构造consumer。
    if '--' in argv: raise SystemExit('CAPACITY_SUPERVISOR_INPUT')
    loaded = _load_window(argv); _, _, window, _ = loaded
    if window.get('scope') == 'musicbridge-capacity-measure-window': return _main_measure(argv, loaded=loaded)
    if window.get('scope') == 'musicbridge-capacity-queued-stop-window': return _main_queued_stop(argv, loaded=loaded)
    return _main_generation(argv)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
