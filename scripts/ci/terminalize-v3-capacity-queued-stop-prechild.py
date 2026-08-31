#!/usr/bin/env python3
"""封存 queued-stop 在 child 启动前发生的已复现控制面崩溃；绝不运行 benchmark。"""

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
import tempfile


SHA256 = re.compile(r'^[0-9a-f]{64}$', re.ASCII)
GIT_SHA = re.compile(r'^[0-9a-f]{40}$', re.ASCII)
SAFE = re.compile(r'^[a-z0-9-]{1,64}$', re.ASCII)
EXPECTED_ENTRIES = {
    'owner.json', 'supervisor.py', 'issuer-identity', 'source-pins.json',
    'owned-roots.json', 'window.json',
}


class TerminalizeError(Exception):
    pass


def fail(code):
    raise TerminalizeError(code)


def ordinary(path):
    path = Path(path)
    try: value = path.lstat()
    except OSError: return False
    return stat.S_ISREG(value.st_mode) and not path.is_symlink() and value.st_nlink == 1


def file_identity(path, allowed_links=(1,)):
    path = Path(path)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try: descriptor = os.open(path, flags)
    except OSError as error: raise TerminalizeError('FILE_IDENTITY') from error
    digest = hashlib.sha256()
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink not in allowed_links:
            fail('FILE_IDENTITY')
        for chunk in iter(lambda: os.read(descriptor, 1024 * 1024), b''):
            digest.update(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    try: named = path.lstat()
    except OSError as error: raise TerminalizeError('FILE_IDENTITY') from error
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    if any(getattr(before, key) != getattr(after, key) or getattr(after, key) != getattr(named, key)
           for key in fields):
        fail('FILE_CHANGED')
    return {
        'path': str(path), 'sha256': digest.hexdigest(),
        'device': after.st_dev, 'inode': after.st_ino, 'size': after.st_size,
        'mtimeNs': after.st_mtime_ns, 'ctimeNs': after.st_ctime_ns,
        'nlink': after.st_nlink, 'mode': stat.S_IMODE(after.st_mode),
        'uid': after.st_uid, 'gid': after.st_gid,
    }


def sha256(path):
    return file_identity(path)['sha256']


def receipt_identity(path, allowed_links=(1,)):
    identity = file_identity(path, allowed_links)
    if identity['mode'] != 0o400 or identity['uid'] != os.geteuid():
        fail('PENDING_RECEIPT')
    return identity


def strict_json(path, expected_sha, maximum=32 * 1024 * 1024):
    path = Path(path)
    if not ordinary(path): fail('FILE_IDENTITY')
    try:
        if path.stat().st_size > maximum: fail('FILE_IDENTITY')
        raw = path.read_bytes()
        value = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TerminalizeError('FILE_IDENTITY') from error
    digest = hashlib.sha256(raw).hexdigest()
    if digest != expected_sha or sha256(path) != expected_sha:
        fail('FILE_IDENTITY')
    return value


def git_value(root, *arguments):
    environment = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_NO_LAZY_FETCH': '1'}
    try:
        return subprocess.check_output(
            ['/usr/bin/git', *arguments], cwd=root, env=environment,
            stderr=subprocess.DEVNULL, text=True).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise TerminalizeError('RECOVERY_REPOSITORY') from error


def validate_recovery(options):
    supplied = Path(options.recovery_repo_root)
    try: root = supplied.resolve(strict=True)
    except OSError as error: raise TerminalizeError('RECOVERY_REPOSITORY') from error
    if supplied != root or not root.is_dir() or root.is_symlink() \
            or GIT_SHA.fullmatch(options.expected_recovery_head or '') is None \
            or git_value(root, 'branch', '--show-current') != options.expected_recovery_branch \
            or git_value(root, 'rev-parse', 'HEAD^{commit}') != options.expected_recovery_head \
            or git_value(root, 'status', '--porcelain=v1'):
        fail('RECOVERY_REPOSITORY')
    script = Path(__file__).resolve(strict=True)
    try: relative = str(script.relative_to(root))
    except ValueError as error: raise TerminalizeError('RECOVERY_IDENTITY') from error
    if sha256(script) != options.expected_terminalizer_sha256:
        fail('RECOVERY_IDENTITY')
    try:
        blob = subprocess.check_output(
            ['/usr/bin/git', 'show', f'{options.expected_recovery_head}:{relative}'],
            cwd=root, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError) as error:
        raise TerminalizeError('RECOVERY_IDENTITY') from error
    if hashlib.sha256(blob).hexdigest() != options.expected_terminalizer_sha256:
        fail('RECOVERY_IDENTITY')
    return root, script, relative


def validate_no_child(runtime, authority, window):
    forbidden = [authority / 'supervision', authority / 'close.json', authority / 'issuer-failure.json',
                 authority / window['label'], runtime / window['label']]
    if any(path.exists() or path.is_symlink() for path in forbidden):
        fail('CHILD_STATE')
    try:
        process_rows = subprocess.check_output(
            ['/bin/ps', '-axo', 'pid=,ppid=,pgid=,command='], text=True,
            stderr=subprocess.DEVNULL).splitlines()
    except (OSError, subprocess.CalledProcessError) as error:
        raise TerminalizeError('PROCESS_AUDIT') from error
    supervisor = str(authority / 'supervisor.py')
    for row in process_rows:
        if supervisor in row or 'recording-capacity-process.ts' in row \
                or f"--label {window['label']}" in row:
            fail('PROCESS_ACTIVE')


def directory_identity(path, expected_entries):
    path = Path(path)
    try:
        info = path.lstat(); canonical = path.resolve(strict=True)
        entries = sorted(item.name for item in path.iterdir())
        after = path.lstat()
    except OSError as error:
        raise TerminalizeError('AUTHORITY_IDENTITY') from error
    fields = ('st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    if path.is_symlink() or canonical != path or not stat.S_ISDIR(info.st_mode) \
            or entries != sorted(expected_entries) \
            or any(getattr(info, key) != getattr(after, key) for key in fields):
        fail('AUTHORITY_IDENTITY')
    return {'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
            'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns,
            'nlink': info.st_nlink, 'entries': entries}


def publication_entries(authority):
    pending = authority / '.prechild-failure.pending.json'
    final = authority / 'prechild-failure.json'
    pending_present = pending.exists() or pending.is_symlink()
    final_present = final.exists() or final.is_symlink()
    if final_present and not pending_present:
        fail('EXCLUSIVE_CREATE')
    if pending_present:
        pending_info = receipt_identity(pending, (1, 2))
        if final_present:
            final_info = receipt_identity(final, (2,))
            if pending_info['nlink'] != 2 \
                    or (pending_info['device'], pending_info['inode']) != \
                    (final_info['device'], final_info['inode']):
                fail('PENDING_RECEIPT')
            return EXPECTED_ENTRIES | {pending.name, final.name}
        if pending_info['nlink'] != 1:
            fail('PENDING_RECEIPT')
        return EXPECTED_ENTRIES | {pending.name}
    return EXPECTED_ENTRIES


def stable_incident_snapshot(options, runtime, authority, window, trigger):
    issuer_identity = authority / 'issuer-identity'
    validate_no_child(runtime, authority, window)
    recovery_root, recovery_script, recovery_relative = validate_recovery(options)
    files = {
        'owner': (authority / 'owner.json', options.expected_owner_sha256),
        'supervisor': (authority / 'supervisor.py', options.expected_supervisor_sha256),
        'issuerFact': (issuer_identity / 'owner.json', options.expected_issuer_fact_sha256),
        'sourceManifest': (authority / 'source-pins.json', options.expected_source_sha256),
        'ownedManifest': (authority / 'owned-roots.json', options.expected_owned_sha256),
        'window': (authority / 'window.json', options.expected_window_sha256),
        'witness': (trigger, options.expected_trigger_sha256),
        'recoveryScript': (recovery_script, options.expected_terminalizer_sha256),
    }
    identities = {}
    for role, (path, expected) in files.items():
        observed = file_identity(path)
        if observed['sha256'] != expected: fail('AUTHORITY_DRIFT')
        identities[role] = observed
    entries = publication_entries(authority)
    publication = {}
    for name in sorted(entries - EXPECTED_ENTRIES):
        publication[name] = receipt_identity(
            authority / name, (2,) if len(entries - EXPECTED_ENTRIES) == 2 else (1,))
    return {
        'authority': directory_identity(authority, entries),
        'issuerIdentity': directory_identity(issuer_identity, {'owner.json'}),
        'files': identities,
        'publication': publication,
        'recovery': {'root': str(recovery_root), 'relative': recovery_relative,
                     'head': options.expected_recovery_head},
    }


def reproduce_failure(installed_supervisor, runtime, authority, window, witness):
    if not sys.dont_write_bytecode:
        fail('BYTECODE_DISABLED_REQUIRED')
    spec = importlib.util.spec_from_file_location('queued_stop_incident_supervisor', installed_supervisor)
    if spec is None or spec.loader is None:
        fail('FAILURE_REPRODUCTION')
    module = importlib.util.module_from_spec(spec)
    try: spec.loader.exec_module(module)
    except Exception as error: raise TerminalizeError('FAILURE_REPRODUCTION') from error
    reject = getattr(module, '_reject_queued_stop_replay', None)
    if not callable(reject): fail('FAILURE_REPRODUCTION')
    def expect_type_error(replay_runtime, replay_parent):
        try: reject(replay_runtime, replay_parent, window)
        except TypeError as error:
            if "unhashable type: 'dict'" not in str(error):
                raise TerminalizeError('FAILURE_REPRODUCTION') from error
            return
        except Exception as error:
            raise TerminalizeError('FAILURE_REPRODUCTION') from error
        fail('FAILURE_NOT_REPRODUCED')
    expect_type_error(runtime, authority)
    try:
        witness_bytes = witness.read_bytes()
        with tempfile.TemporaryDirectory(prefix='musicbridge-prechild-witness-') as temporary:
            isolated_runtime = Path(temporary).resolve(strict=True)
            isolated_parent = isolated_runtime / 'current-window'; isolated_parent.mkdir(mode=0o700)
            isolated_witness = isolated_runtime / witness.name
            descriptor = os.open(isolated_witness, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
            try:
                view = memoryview(witness_bytes)
                while view:
                    count = os.write(descriptor, view)
                    if count <= 0: fail('FAILURE_REPRODUCTION')
                    view = view[count:]
                os.fsync(descriptor)
            finally: os.close(descriptor)
            expect_type_error(isolated_runtime, isolated_parent)
    except (OSError, TypeError, ValueError) as error:
        raise TerminalizeError('FAILURE_REPRODUCTION') from error
    return {'type': 'TypeError', 'messageCode': 'UNHASHABLE_DICT',
            'fullRuntimeReproduced': True, 'isolatedWitnessReproduced': True}


def exclusive_json(path, value):
    path = Path(path)
    payload = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    try: descriptor = os.open(path, flags, 0o600)
    except OSError as error: raise TerminalizeError('EXCLUSIVE_CREATE') from error
    try:
        view = memoryview(payload)
        while view:
            count = os.write(descriptor, view)
            if count <= 0: fail('WRITE_FAILED')
            view = view[count:]
        os.fchmod(descriptor, 0o400)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try: os.fsync(directory)
    finally: os.close(directory)
    return hashlib.sha256(payload).hexdigest()


def publish_json(path, value):
    """先完整持久化 pending，再用 hard-link 原子且不覆盖地发布最终收据。"""
    path = Path(path); pending = path.parent / '.prechild-failure.pending.json'
    final_present = path.exists() or path.is_symlink()
    pending_present = pending.exists() or pending.is_symlink()
    if final_present and not pending_present: fail('EXCLUSIVE_CREATE')
    if not final_present and not pending_present:
        exclusive_json(pending, value)
        pending_present = True
    allowed_links = (2,) if final_present else (1,)
    pending_identity = receipt_identity(pending, allowed_links)
    if final_present:
        final_identity = receipt_identity(path, (2,))
        if (pending_identity['device'], pending_identity['inode']) != \
                (final_identity['device'], final_identity['inode']):
            fail('PENDING_RECEIPT')
    try: pending_value = json.loads(pending.read_bytes())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TerminalizeError('PENDING_RECEIPT') from error
    expected = dict(value); observed = dict(pending_value) if isinstance(pending_value, dict) else {}
    expected.pop('recordedAt', None); observed.pop('recordedAt', None)
    if observed != expected: fail('PENDING_RECEIPT')
    if not final_present:
        try: os.link(pending, path, follow_symlinks=False)
        except OSError as error: raise TerminalizeError('EXCLUSIVE_CREATE') from error
        final_identity = receipt_identity(path, (2,))
        pending_identity = receipt_identity(pending, (2,))
        if (pending_identity['device'], pending_identity['inode']) != \
                (final_identity['device'], final_identity['inode']):
            fail('PENDING_RECEIPT')
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try: os.fsync(directory)
        finally: os.close(directory)
    try: pending.unlink()
    except OSError as error: raise TerminalizeError('PUBLISH_CLEANUP') from error
    directory = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try: os.fsync(directory)
    finally: os.close(directory)
    if not ordinary(path): fail('PUBLISHED_RECEIPT')
    final_identity = receipt_identity(path)
    if final_identity['sha256'] != hashlib.sha256(
            (json.dumps(pending_value, ensure_ascii=False, indent=2) + '\n').encode()).hexdigest():
        fail('PUBLISHED_RECEIPT')
    return sha256(path)


def terminalize(options):
    for value in vars(options):
        if 'sha256' in value and SHA256.fullmatch(str(getattr(options, value, '') or '')) is None:
            fail('SHA256')
    if options.observed_exit_code != 1: fail('EXIT_CODE')
    recovery_root, recovery_script, recovery_relative = validate_recovery(options)
    runtime_supplied = Path(options.runtime_root)
    authority_supplied = Path(options.authority_dir)
    try:
        runtime = runtime_supplied.resolve(strict=True); authority = authority_supplied.resolve(strict=True)
    except OSError as error: raise TerminalizeError('AUTHORITY_IDENTITY') from error
    if runtime != runtime_supplied or authority != authority_supplied or runtime.is_symlink() \
            or authority.is_symlink() or authority.parent != runtime \
            or SAFE.fullmatch(authority.name or '') is None:
        fail('AUTHORITY_IDENTITY')
    issuer_identity = authority / 'issuer-identity'
    try:
        issuer_info = issuer_identity.lstat()
        issuer_canonical = issuer_identity.resolve(strict=True)
        entries = {path.name for path in authority.iterdir()}
        issuer_entries = {path.name for path in issuer_identity.iterdir()}
    except OSError as error: raise TerminalizeError('AUTHORITY_IDENTITY') from error
    if issuer_identity.is_symlink() or issuer_canonical != issuer_identity \
            or not stat.S_ISDIR(issuer_info.st_mode) \
            or entries != publication_entries(authority) or issuer_entries != {'owner.json'}:
        fail('AUTHORITY_SHAPE')
    owner = strict_json(authority / 'owner.json', options.expected_owner_sha256, 1024 * 1024)
    window = strict_json(authority / 'window.json', options.expected_window_sha256)
    issuer_fact = strict_json(
        issuer_identity / 'owner.json', options.expected_issuer_fact_sha256, 1024 * 1024)
    source = strict_json(authority / 'source-pins.json', options.expected_source_sha256)
    owned = strict_json(authority / 'owned-roots.json', options.expected_owned_sha256)
    installed_supervisor = authority / 'supervisor.py'
    if sha256(installed_supervisor) != options.expected_supervisor_sha256:
        fail('SUPERVISOR_IDENTITY')
    if not all(isinstance(value, dict) for value in (owner, window, issuer_fact, source, owned)):
        fail('AUTHORITY_IDENTITY')
    if window.get('schemaVersion') != 1 \
            or window.get('scope') != 'musicbridge-capacity-queued-stop-window' \
            or window.get('state') != 'approved' or window.get('phase') != 'queued-stop' \
            or window.get('profile') != 'objects-limit' or not isinstance(window.get('id'), str) \
            or SAFE.fullmatch(str(window.get('label', ''))) is None \
            or owner != {'scope': 'musicbridge-capacity-queued-stop-window', 'owner': 'root',
                         'id': window.get('id')} \
            or window.get('supervisor') != {
                'path': str(installed_supervisor), 'sha256': options.expected_supervisor_sha256} \
            or window.get('sourceManifest') != {
                'file': 'source-pins.json', 'sha256': options.expected_source_sha256} \
            or window.get('ownedManifest') != {
                'file': 'owned-roots.json', 'sha256': options.expected_owned_sha256}:
        fail('WINDOW_IDENTITY')
    candidate = window.get('candidateRepository')
    if not isinstance(candidate, dict) or set(candidate) != {'root', 'branch', 'head'} \
            or not all(isinstance(candidate.get(key), str) for key in ('root', 'branch', 'head')) \
            or not 1 <= len(candidate.get('branch', '')) <= 255 \
            or GIT_SHA.fullmatch(candidate.get('head', '')) is None:
        fail('CANDIDATE_IDENTITY')
    if issuer_fact.get('schemaVersion') != 1 \
            or issuer_fact.get('scope') != 'musicbridge-capacity-queued-stop-authority-issuer' \
            or issuer_fact.get('windowId') != window['id'] \
            or issuer_fact.get('candidateRepository') != candidate \
            or set(source) != {'schemaVersion', 'scope', 'files'} \
            or source.get('schemaVersion') != 1 \
            or source.get('scope') != 'musicbridge-capacity-source-pins' \
            or not isinstance(source.get('files'), dict) \
            or set(owned) != {'schemaVersion', 'scope', 'access', 'windowId', 'roots'} \
            or owned.get('schemaVersion') != 1 \
            or owned.get('scope') != 'musicbridge-capacity-owned-roots' \
            or owned.get('access') != 'count-only' or owned.get('windowId') != window['id'] \
            or not isinstance(owned.get('roots'), list):
        fail('AUTHORITY_IDENTITY')
    try:
        candidate_root = Path(candidate['root']); candidate_canonical = candidate_root.resolve(strict=True)
    except (OSError, TypeError, ValueError) as error:
        raise TerminalizeError('CANDIDATE_IDENTITY') from error
    if not candidate_root.is_absolute() or candidate_root.is_symlink() \
            or candidate_canonical != candidate_root:
        fail('CANDIDATE_IDENTITY')
    if git_value(candidate_root, 'cat-file', '-t', candidate['head']) != 'commit':
        fail('CANDIDATE_IDENTITY')
    try:
        supervisor_blob = subprocess.check_output(
            ['/usr/bin/git', 'show', f"{candidate['head']}:scripts/ci/capacity-phase-supervisor-v2.py"],
            cwd=candidate_root, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError) as error:
        raise TerminalizeError('CANDIDATE_IDENTITY') from error
    if hashlib.sha256(supervisor_blob).hexdigest() != options.expected_supervisor_sha256:
        fail('CANDIDATE_IDENTITY')
    trigger_supplied = Path(options.trigger_close)
    try: trigger = trigger_supplied.resolve(strict=True)
    except OSError as error: raise TerminalizeError('TRIGGER_IDENTITY') from error
    if trigger != trigger_supplied or trigger.parent != runtime or not trigger.name.endswith('-close.json'):
        fail('TRIGGER_IDENTITY')
    trigger_value = strict_json(trigger, options.expected_trigger_sha256)
    nested = trigger_value.get('window') if isinstance(trigger_value, dict) else None
    if not isinstance(trigger_value, dict) \
            or trigger_value.get('scope') != 'musicbridge-capacity-generation-close' \
            or not isinstance(nested, dict) or not isinstance(nested.get('id'), str) \
            or not isinstance(nested.get('label'), str):
        fail('TRIGGER_IDENTITY')
    before = stable_incident_snapshot(options, runtime, authority, window, trigger)
    reproduced = reproduce_failure(installed_supervisor, runtime, authority, window, trigger)
    after = stable_incident_snapshot(options, runtime, authority, window, trigger)
    if after != before: fail('AUTHORITY_DRIFT')
    receipt = {
        'schemaVersion': 1,
        'scope': 'musicbridge-capacity-queued-stop-prechild-failure',
        'state': 'TERMINAL_PRECHILD_CONTROL_FAILURE',
        'windowId': window['id'],
        'windowDirName': authority.name,
        'label': window['label'],
        'failure': 'QUEUED_STOP_REPLAY_AUDIT_TYPE_ERROR',
        'observedExitCode': options.observed_exit_code,
        'windowSha256': options.expected_window_sha256,
        'authorityFiles': {
            'ownerSha256': options.expected_owner_sha256,
            'supervisorSha256': options.expected_supervisor_sha256,
            'issuerFactSha256': options.expected_issuer_fact_sha256,
            'sourceManifestSha256': options.expected_source_sha256,
            'ownedManifestSha256': options.expected_owned_sha256,
        },
        'trigger': {'path': str(trigger), 'sha256': options.expected_trigger_sha256,
                    'scope': trigger_value['scope'], 'windowId': nested['id'],
                    'label': nested['label'], 'fieldType': 'dict',
                    'role': 'isolated-reproduction-witness-not-historical-order'},
        'reproduction': reproduced,
        'authorityAdmission': 'NOT_RUN',
        'supervisionStarted': False,
        'benchmarkStarted': False,
        'childSpawned': False,
        'outputCreated': False,
        'sampleCount': 0,
        'windowConsumed': True,
        'deviceOpened': False,
        'formalReady': False,
        'gateB': 'NOT_RUN',
        'replayAllowed': False,
        'replayPolicy': 'terminal-window-id-and-label-never-reuse',
        'recovery': {'repositoryRoot': str(recovery_root),
                     'branch': options.expected_recovery_branch,
                     'head': options.expected_recovery_head,
                     'scriptPath': str(recovery_script), 'scriptRelativePath': recovery_relative,
                     'scriptSha256': options.expected_terminalizer_sha256},
        'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds'),
    }
    receipt_path = authority / 'prechild-failure.json'
    receipt_sha = publish_json(receipt_path, receipt)
    return {'state': receipt['state'], 'windowId': window['id'], 'label': window['label'],
            'receiptPath': str(receipt_path), 'receiptSha256': receipt_sha,
            'benchmarkStarted': False, 'sampleCount': 0, 'replayAllowed': False}


def parse_args(argv):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--runtime-root', required=True)
    parser.add_argument('--authority-dir', required=True)
    parser.add_argument('--expected-window-sha256', required=True)
    parser.add_argument('--expected-owner-sha256', required=True)
    parser.add_argument('--expected-supervisor-sha256', required=True)
    parser.add_argument('--expected-issuer-fact-sha256', required=True)
    parser.add_argument('--expected-source-sha256', required=True)
    parser.add_argument('--expected-owned-sha256', required=True)
    parser.add_argument('--trigger-close', required=True)
    parser.add_argument('--expected-trigger-sha256', required=True)
    parser.add_argument('--recovery-repo-root', required=True)
    parser.add_argument('--expected-recovery-branch', required=True)
    parser.add_argument('--expected-recovery-head', required=True)
    parser.add_argument('--expected-terminalizer-sha256', required=True)
    parser.add_argument('--observed-exit-code', type=int, required=True)
    return parser.parse_args(argv)


def main(argv):
    try: value = terminalize(parse_args(argv))
    except TerminalizeError as error:
        print(f'CAPACITY_QUEUED_STOP_PRECHILD_TERMINALIZER={error}', file=sys.stderr)
        return 1
    except Exception:
        print('CAPACITY_QUEUED_STOP_PRECHILD_TERMINALIZER=INTERNAL', file=sys.stderr)
        return 1
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
