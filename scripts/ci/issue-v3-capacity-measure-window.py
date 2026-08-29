#!/usr/bin/env python3
"""一次性签发 TASK-078 objects-limit measure authority；不执行 benchmark。"""

import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid


SAFE = re.compile(r'^[a-z0-9-]{1,64}$', re.ASCII)
SHA256 = re.compile(r'^[0-9a-f]{64}$', re.ASCII)
GIT_SHA = re.compile(r'^[0-9a-f]{40}$', re.ASCII)
MEASURE_LIMITS = {
    'executionMs': 900000,
    'killGraceMs': 1000,
    'closeMs': 2000,
    'minimumFreeBytes': 10 * 1024 ** 3,
    'maximumOwnedBytes': 16 * 1024 ** 3,
}
MEASURE_PLAN = {
    'groupCloneCount': 3,
    'fullHashCount': 3,
    'stopRoundReceiptCount': 105,
    'sampleCount': 1575,
}
SUPERVISOR_RELATIVE = 'scripts/ci/capacity-phase-supervisor-v2.py'
GENERATION_RUNTIME_SOURCES = {
    'reports/runtime/task-078-v3-acceptance/capacity-phase-supervisor.py',
    'reports/runtime/task-078-v3-acceptance/test_capacity_phase_supervisor.py',
}
EXPECTED_GENERATION_ROOTS = 59
EXPECTED_MEASURE_EXISTING_ROOTS = 65
EXPECTED_MEASURE_AUTHORIZED_ROOTS = 66
EXPECTED_CHECKPOINTS = 557
_FAILURE_CONTEXT = None


class IssueError(Exception):
    pass


def fail(code):
    raise IssueError(code)


def load_python(path, name, error_code):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        fail(error_code)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        raise IssueError(error_code) from error
    return module


def parse_args(argv):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--repo-root', required=True)
    parser.add_argument('--generation-repo-root', required=True)
    parser.add_argument('--expected-generation-branch', required=True)
    parser.add_argument('--expected-generation-head', required=True)
    parser.add_argument('--runtime-root', required=True)
    parser.add_argument('--supervisor', required=True)
    parser.add_argument('--expected-supervisor-sha256', required=True)
    parser.add_argument('--expected-source-count', required=True, type=int)
    parser.add_argument('--generation-window', required=True)
    parser.add_argument('--expected-generation-window-sha256', required=True)
    parser.add_argument('--generation-supervisor', required=True)
    parser.add_argument('--expected-generation-supervisor-sha256', required=True)
    parser.add_argument('--previous-measure-window', required=True)
    parser.add_argument('--expected-previous-measure-window-id', required=True)
    parser.add_argument('--expected-previous-measure-window-sha256', required=True)
    parser.add_argument('--previous-measure-close', required=True)
    parser.add_argument('--expected-previous-measure-close-sha256', required=True)
    parser.add_argument('--previous-measure-output', required=True)
    parser.add_argument('--expected-previous-measure-output-label', required=True)
    parser.add_argument('--expected-previous-measure-output-command-sha256', required=True)
    parser.add_argument('--window-dir-name', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--seed-label', required=True)
    parser.add_argument('--profile', required=True, choices=('objects-limit',))
    parser.add_argument('--expected-branch', required=True)
    parser.add_argument('--expected-head', required=True)
    parser.add_argument('--consumer-python', default=sys.executable)
    parser.add_argument('--expected-consumer-sha256', required=True)
    parser.add_argument('--issuer-repo-root', required=True)
    parser.add_argument('--expected-issuer-branch', required=True)
    parser.add_argument('--expected-issuer-head', required=True)
    parser.add_argument('--expected-issuer-sha256', required=True)
    parser.add_argument('--generation-issuer-helper', required=True)
    parser.add_argument('--expected-generation-issuer-helper-sha256', required=True)
    parser.add_argument('--build-node', required=True)
    parser.add_argument('--expected-build-node-sha256', required=True)
    parser.add_argument('--build-node-library', required=True)
    parser.add_argument('--expected-build-node-library-sha256', required=True)
    parser.add_argument('--typescript-compiler', required=True)
    parser.add_argument('--expected-typescript-compiler-sha256', required=True)
    parser.add_argument('--expected-typescript-library-manifest-sha256', required=True)
    return parser.parse_args(argv)


def strict_uuid4(value):
    try:
        parsed = uuid.UUID(value)
        return parsed.version == 4 and parsed.variant == uuid.RFC_4122 and str(parsed) == value
    except (AttributeError, TypeError, ValueError):
        return False


def ordinary(path):
    path = Path(path)
    try:
        value = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(value.st_mode) and not path.is_symlink() and value.st_nlink == 1


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_json(helper, path, expected_sha256=None, error_code='JSON_INVALID'):
    try:
        value, observed = helper.strict_json(path)
    except Exception as error:
        raise IssueError(error_code) from error
    if expected_sha256 is not None and observed != expected_sha256:
        fail(error_code)
    return value, observed


def same_regular_file(helper, path, expected_sha256, error_code):
    if SHA256.fullmatch(str(expected_sha256 or '')) is None:
        fail(error_code)
    try:
        observed = helper.stable_sha256(path)
    except Exception as error:
        raise IssueError(error_code) from error
    if observed != expected_sha256:
        fail(error_code)
    return Path(path).resolve(strict=True)


def filesystem_available_bytes(path):
    try:
        space = os.statvfs(path)
    except OSError:
        return None
    return space.f_bavail * space.f_frsize


def authority_preflight_snapshot(options, runtime, output, planned):
    return {
        'schemaVersion': 1,
        'scope': 'musicbridge-capacity-measure-authority-preflight',
        'phase': 'source-manifest',
        'failedCheck': None,
        'sourceValidated': False,
        'ownedValidated': False,
        'candidateRepositoryValidated': False,
        'windowValidated': False,
        'expectedSourceFileCount': options.expected_source_count,
        'observedSourceFileCount': None,
        'expectedAuthorizedRootCount': EXPECTED_MEASURE_AUTHORIZED_ROOTS,
        'observedAuthorizedRootCount': None,
        'plannedBytes': planned,
        'observedPlannedBytes': None,
        'ownedBytes': None,
        'availableBytes': None,
        'maximumOwnedBytes': MEASURE_LIMITS['maximumOwnedBytes'],
        'minimumFreeBytes': MEASURE_LIMITS['minimumFreeBytes'],
        'filesystemAvailableBytesBefore': filesystem_available_bytes(runtime),
        'filesystemAvailableBytesAfter': None,
        'futureOutputAbsent': not output.exists() and not output.is_symlink(),
        'sourceCountMatches': None,
        'rootCountMatches': None,
        'plannedBytesMatches': None,
        'ownedBudgetWithinLimit': None,
        'freeReserveAfterPlanSatisfied': None,
    }


def fail_authority_preflight(diagnostic, runtime, code, phase, failed_check):
    diagnostic['phase'] = phase
    diagnostic['failedCheck'] = failed_check
    diagnostic['filesystemAvailableBytesAfter'] = filesystem_available_bytes(runtime)
    fail(code)


def record_terminal_failure(helper, code):
    global _FAILURE_CONTEXT
    context = _FAILURE_CONTEXT
    if context is None:
        return
    parent = context['parent']
    receipt = parent / 'issuer-failure.json'
    if receipt.exists() or receipt.is_symlink():
        return
    names = ('owner.json', 'supervisor.py', 'issuer-identity/owner.json', 'source-pins.json',
             'owned-roots.json', 'window.pending.json', 'window.json')
    created = [name for name in names if ordinary(parent / name)]
    value = {
        'schemaVersion': 1,
        'scope': 'musicbridge-capacity-measure-authority-issuer-failure',
        'state': 'TERMINAL_ISSUER_FAILURE',
        'windowId': context['windowId'],
        'windowDirName': context['windowDirName'],
        'label': context['label'],
        'errorCode': code,
        'authorityFilesCreated': created,
        'windowWritten': 'window.json' in created,
        'replayAllowed': False,
        'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds'),
    }
    if isinstance(context.get('preflight'), dict):
        value['preflight'] = context['preflight']
    try:
        helper.exclusive_json(receipt, value)
        helper.fsync_directory(parent)
        helper.fsync_directory(context['runtime'])
    except Exception:
        pass


def reject_replay(helper, runtime, window_dir_name, label):
    parent = runtime / window_dir_name
    output = runtime / label
    if parent.exists() or parent.is_symlink() or output.exists() or output.is_symlink():
        fail('REPLAY_PATH')
    entries = list(runtime.iterdir())
    if len(entries) > 4096:
        fail('RUNTIME_COUNT')
    for entry in sorted(entries, key=lambda value: value.name):
        candidates = []
        if entry.is_dir() and not entry.is_symlink():
            candidates = [entry / 'window.json', entry / 'close.json', entry / 'issuer-failure.json']
        elif entry.is_file() and not entry.is_symlink() and entry.name.endswith('-close.json'):
            candidates = [entry]
        elif entry.is_symlink() and (entry.name.endswith('-close.json') or entry.name in {
                'window.json', 'close.json', 'issuer-failure.json'}):
            fail('REPLAY_AUDIT')
        for candidate in candidates:
            if not candidate.exists() and not candidate.is_symlink():
                continue
            if candidate.is_symlink() or not ordinary(candidate):
                fail('REPLAY_AUDIT')
            try:
                value, _ = helper.strict_json(candidate)
            except Exception as error:
                raise IssueError('REPLAY_AUDIT') from error
            if not isinstance(value, dict):
                fail('REPLAY_AUDIT')
            scope = value.get('scope')
            related = scope in {
                'musicbridge-capacity-measure-window',
                'musicbridge-capacity-measure-window-close',
                'musicbridge-capacity-measure-authority-issuer-failure',
            }
            if related and label in {
                    value.get('label'), value.get('windowLabel'), value.get('windowDirName')}:
                fail('REPLAY')


def candidate_sources(helper, module, root, head, expected_count, toolchain):
    try:
        source_root, source_paths = module._expected_source_paths(root)
    except Exception as error:
        raise IssueError('SOURCE_MANIFEST') from error
    if Path(source_root) != root or len(source_paths) != expected_count:
        fail('SOURCE_MANIFEST')
    derived = helper.candidate_contract_dist(
        root, head, source_paths,
        toolchain['buildNode'], toolchain['buildNodeSha256'],
        toolchain['buildNodeLibrary'], toolchain['buildNodeLibrarySha256'],
        toolchain['typescriptCompiler'], toolchain['typescriptCompilerSha256'],
        toolchain['typescriptLibraryManifestSha256'])
    files = {}
    for relative in source_paths:
        try:
            identity = module._strict_identity(root / relative)
        except Exception as error:
            raise IssueError('SOURCE_CANDIDATE') from error
        observed = identity.get('sha256')
        if SHA256.fullmatch(str(observed or '')) is None:
            fail('SOURCE_CANDIDATE')
        if relative in derived['files']:
            if observed != derived['files'][relative]:
                fail('EMIT_BYTES')
        elif relative not in {
            'reports/runtime/task-078-v3-acceptance/capacity-phase-supervisor.py',
            'reports/runtime/task-078-v3-acceptance/test_capacity_phase_supervisor.py',
        }:
            if hashlib.sha256(helper.git_blob(root, head, relative)).hexdigest() != observed:
                fail('SOURCE_CANDIDATE')
        files[relative] = observed
    return source_paths, files, derived['provenance']


def validate_seed(helper, runtime, seed_label, generation, proof):
    seed = helper.canonical_directory(runtime / seed_label, runtime)
    metadata, metadata_sha = read_json(helper, seed / 'seed.json', error_code='SEED_INVALID')
    snapshot = seed / 'seed.sqlite'
    try:
        snapshot_sha = helper.stable_sha256(snapshot)
        snapshot_info = snapshot.stat()
    except Exception as error:
        raise IssueError('SEED_INVALID') from error
    if any(Path(str(snapshot) + suffix).exists() or Path(str(snapshot) + suffix).is_symlink()
           for suffix in ('-wal', '-shm', '-journal')):
        fail('SEED_INVALID')
    if not isinstance(metadata, dict) or metadata.get('schema') != 21 \
            or metadata.get('classification') != 'capacity-seed/non-performance' \
            or metadata.get('profile') != 'objects-limit' or metadata.get('integrity') != 'passed' \
            or metadata.get('retained') is not True \
            or not isinstance(metadata.get('growth'), dict) \
            or metadata['growth'].get('state') != 'target-reached' \
            or not strict_uuid4(metadata.get('nextPlanId')) \
            or SHA256.fullmatch(str(metadata.get('nextPlanHash', ''))) is None \
            or not isinstance(metadata.get('budget'), dict) \
            or not isinstance(metadata.get('fixtureDirectory'), str) \
            or metadata.get('snapshotSha256') != snapshot_sha:
        fail('SEED_INVALID')
    fixture = helper.canonical_directory(metadata['fixtureDirectory'])
    fixture_marker, fixture_marker_sha = read_json(
        helper, fixture / 'capacity-owner.json', error_code='SEED_INVALID')
    fixture_fact = generation.get('fixtureIdentity')
    if fixture_marker != metadata.get('marker') or not isinstance(fixture_fact, dict) \
            or fixture_fact.get('valid') is not True or fixture_fact.get('identityStable') is not True \
            or fixture_fact.get('markerSha256') != fixture_marker_sha \
            or generation.get('seedMetadataSha256Observed') != metadata_sha \
            or generation.get('snapshotSha256Observed') != snapshot_sha:
        fail('GENERATION_PROOF')
    exit_value, _ = read_json(helper, seed / 'exit.json', error_code='GENERATION_PROOF')
    if exit_value != {'exit': 0}:
        fail('GENERATION_PROOF')
    before = seed / 'source-before.json'
    after = seed / 'source-after.json'
    try:
        if helper.stable_sha256(before) != helper.stable_sha256(after):
            fail('GENERATION_PROOF')
    except IssueError:
        raise
    except Exception as error:
        raise IssueError('GENERATION_PROOF') from error
    if generation.get('sourceBeforeEqualsAfter') is not True:
        fail('GENERATION_PROOF')
    return {
        'directory': seed,
        'metadata': metadata,
        'metadataSha256': metadata_sha,
        'snapshot': snapshot,
        'snapshotSha256': snapshot_sha,
        'snapshotBytes': snapshot_info.st_size,
        'fixture': fixture,
        'fixtureOwnerSha256': fixture_marker_sha,
    }


def validate_generation_proof(helper, module, options, generation_root, runtime, toolchain):
    window_path = same_regular_file(
        helper, options.generation_window, options.expected_generation_window_sha256,
        'GENERATION_PROOF')
    if window_path.name != 'window.json' or window_path.parent.parent != runtime:
        fail('GENERATION_PROOF')
    window, _ = read_json(helper, window_path, options.expected_generation_window_sha256,
                          'GENERATION_PROOF')
    expected_window = {
        'schemaVersion': 1, 'scope': 'musicbridge-capacity-generation-window',
        'owner': 'root', 'state': 'approved', 'phase': 'generate',
        'profile': 'objects-limit', 'n': 1,
    }
    if not isinstance(window, dict) or any(window.get(key) != value for key, value in expected_window.items()) \
            or window.get('label') != options.seed_label or not strict_uuid4(window.get('id')):
        fail('GENERATION_PROOF')
    parent = window_path.parent
    owner, _ = read_json(helper, parent / 'owner.json', error_code='GENERATION_PROOF')
    if owner != {'scope': window['scope'], 'owner': 'root', 'id': window['id']}:
        fail('GENERATION_PROOF')
    source_path = parent / 'source-pins.json'
    owned_path = parent / 'owned-roots.json'
    source, source_sha = read_json(helper, source_path, error_code='GENERATION_PROOF')
    owned, owned_sha = read_json(helper, owned_path, error_code='GENERATION_PROOF')
    frozen_source_files = source.get('files') if isinstance(source, dict) else None
    if window.get('sourceManifest') != {'file': 'source-pins.json', 'sha256': source_sha} \
            or window.get('ownedManifest') != {'file': 'owned-roots.json', 'sha256': owned_sha} \
            or not isinstance(frozen_source_files, dict) or not frozen_source_files \
            or any(Path(relative).is_absolute() or '..' in Path(relative).parts
                   or SHA256.fullmatch(str(digest or '')) is None
                   for relative, digest in frozen_source_files.items()) \
            or not isinstance(owned, dict) or owned.get('windowId') != window['id'] \
            or not isinstance(owned.get('roots'), list) \
            or len(owned['roots']) != EXPECTED_GENERATION_ROOTS:
        fail('GENERATION_PROOF')
    try:
        derived = helper.candidate_contract_dist(
            generation_root, options.expected_generation_head,
            sorted(frozen_source_files),
            toolchain['buildNode'], toolchain['buildNodeSha256'],
            toolchain['buildNodeLibrary'], toolchain['buildNodeLibrarySha256'],
            toolchain['typescriptCompiler'], toolchain['typescriptCompilerSha256'],
            toolchain['typescriptLibraryManifestSha256'])
    except Exception as error:
        raise IssueError('GENERATION_PROOF') from error
    derived_files = derived.get('files') if isinstance(derived, dict) else None
    expected_derived = {
        relative for relative in frozen_source_files
        if relative.startswith('packages/contracts/dist/')}
    if not isinstance(derived_files, dict) or set(derived_files) != expected_derived:
        fail('GENERATION_PROOF')
    for relative, digest in frozen_source_files.items():
        file = generation_root / relative
        try:
            if helper.stable_sha256(file) != digest:
                fail('GENERATION_PROOF')
            if relative in derived_files:
                if derived_files[relative] != digest:
                    fail('GENERATION_PROOF')
            elif relative not in GENERATION_RUNTIME_SOURCES \
                    and hashlib.sha256(helper.git_blob(
                        generation_root, options.expected_generation_head, relative)).hexdigest() != digest:
                fail('GENERATION_PROOF')
        except IssueError:
            raise
        except Exception as error:
            raise IssueError('GENERATION_PROOF') from error
    roots = []
    seen = set()
    for row in owned['roots']:
        try:
            checked = helper.root_identity(row)
        except Exception as error:
            raise IssueError('GENERATION_PROOF') from error
        if checked['path'] in seen:
            fail('GENERATION_PROOF')
        seen.add(checked['path'])
        roots.append(checked)
    proof_path = same_regular_file(
        helper, options.generation_supervisor,
        options.expected_generation_supervisor_sha256, 'GENERATION_PROOF')
    if proof_path != parent / 'supervision' / 'supervisor.json':
        fail('GENERATION_PROOF')
    proof, _ = read_json(helper, proof_path, options.expected_generation_supervisor_sha256,
                         'GENERATION_PROOF')
    generation = proof.get('generation') if isinstance(proof, dict) else None
    if not isinstance(generation, dict) or proof.get('passed') is not True \
            or proof.get('failure') is not None or proof.get('code') != 0 \
            or proof.get('exitSignal') is not None or proof.get('signals') != [] \
            or proof.get('managedProcessGroup') is not True or proof.get('groupEmpty') is not True \
            or proof.get('zombies') != [] or generation.get('profile') != 'objects-limit' \
            or generation.get('label') != options.seed_label or generation.get('window') != window['id'] \
            or generation.get('windowSha256') != options.expected_generation_window_sha256 \
            or generation.get('sourceManifestSha256') != source_sha \
            or generation.get('ownedManifestSha256') != owned_sha \
            or generation.get('outputDirectory') != str(runtime / options.seed_label) \
            or generation.get('outputDirectoryExists') is not True \
            or generation.get('partialExists') is not False \
            or generation.get('unexpectedEntries') != [] \
            or generation.get('checkpointCount') != EXPECTED_CHECKPOINTS \
            or generation.get('seedExists') is not True or generation.get('exitZero') is not True \
            or generation.get('seedProfileMatches') is not True \
            or generation.get('seedShaMatches') is not True \
            or generation.get('noSqliteSidecars') is not True \
            or generation.get('commandMatchesWindow') is not True \
            or generation.get('fixtureIdentityValid') is not True \
            or generation.get('authorityStable') is not True \
            or generation.get('targetReached') is not True \
            or generation.get('verifiedPassed') is not True:
        fail('GENERATION_PROOF')
    checkpoints = generation.get('checkpointFiles')
    expected_checkpoints = {f'checkpoint-{index}.json' for index in range(1, EXPECTED_CHECKPOINTS + 1)}
    if not isinstance(checkpoints, list) or set(checkpoints) != expected_checkpoints \
            or len(checkpoints) != EXPECTED_CHECKPOINTS:
        fail('GENERATION_PROOF')
    files = generation.get('files')
    if not isinstance(files, dict) or not expected_checkpoints.issubset(files):
        fail('GENERATION_PROOF')
    seed_directory = runtime / options.seed_label
    for name in expected_checkpoints | {
            'source-before.json', 'command.json', 'space-before-snapshot.json',
            'seed.sqlite', 'seed.json', 'source-after.json', 'exit.json'}:
        fact = files.get(name)
        if not isinstance(fact, dict) or fact.get('exists') is not True \
                or fact.get('sha256') != helper.stable_sha256(seed_directory / name):
            fail('GENERATION_PROOF')
    authority = generation.get('authority')
    if (not isinstance(authority, dict)
            or authority.get('authorityStable') is not True
            or authority.get('sourcePinsValid') is not True
            or authority.get('ownedRootsValid') is not True
            or authority.get('spaceValid') is not True
            or authority.get('sourceFileCount') != len(frozen_source_files)
            or authority.get('ownedRootCount') != EXPECTED_GENERATION_ROOTS):
        fail('GENERATION_PROOF')
    pgid = proof.get('pgid')
    if type(pgid) is not int or pgid <= 1:
        fail('GENERATION_PROOF')
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        pass
    except PermissionError as error:
        raise IssueError('GENERATION_PROCESS_LIVE') from error
    else:
        fail('GENERATION_PROCESS_LIVE')
    seed = validate_seed(helper, runtime, options.seed_label, generation, proof)
    return {
        'window': window,
        'windowPath': window_path,
        'windowSha256': options.expected_generation_window_sha256,
        'sourceSha256': source_sha,
        'ownedSha256': owned_sha,
        'proofSha256': options.expected_generation_supervisor_sha256,
        'roots': roots,
        'seed': seed,
    }


def unique_roots(rows):
    result = {}
    for row in rows:
        prior = result.get(row['path'])
        if prior is not None and prior != row:
            fail('OWNED_DUPLICATE')
        result[row['path']] = row
    return result


def expected_legacy_carryover(module, options, output, roots):
    evidence = getattr(module, '_LEGACY_CARRYOVER_EVIDENCE', None)
    evidence_keys = {
        'format', 'windowId', 'label', 'windowSha256', 'closeSha256', 'commandSha256',
        'seedLabel', 'seedSha256', 'files', 'receiptSha256', 'receiptManifestSha256',
        'retainedOwner', 'retainedOwnerSha256', 'sqliteBytes', 'wal', 'shm'}
    if not isinstance(evidence, dict) or set(evidence) != evidence_keys \
            or evidence.get('format') != 'legacy-107-clone-partial-v1' \
            or evidence.get('windowId') != options.expected_previous_measure_window_id \
            or evidence.get('label') != options.expected_previous_measure_output_label \
            or evidence.get('windowSha256') != options.expected_previous_measure_window_sha256 \
            or evidence.get('closeSha256') != options.expected_previous_measure_close_sha256 \
            or evidence.get('commandSha256') != options.expected_previous_measure_output_command_sha256 \
            or SAFE.fullmatch(str(evidence.get('seedLabel', ''))) is None \
            or SHA256.fullmatch(str(evidence.get('seedSha256', ''))) is None \
            or SHA256.fullmatch(str(evidence.get('receiptManifestSha256', ''))) is None \
            or SHA256.fullmatch(str(evidence.get('retainedOwnerSha256', ''))) is None \
            or type(evidence.get('sqliteBytes')) is not int or evidence['sqliteBytes'] <= 0:
        fail('MEASURE_CARRYOVER')
    files = evidence.get('files')
    fixed_names = {'command.json', 'measurement.json', 'source-before.json', 'samples.jsonl'}
    if not isinstance(files, dict) or set(files) != fixed_names:
        fail('MEASURE_CARRYOVER')
    for name, identity in files.items():
        if not isinstance(identity, dict) or set(identity) != {'size', 'sha256'} \
                or type(identity.get('size')) is not int or identity['size'] < 0 \
                or SHA256.fullmatch(str(identity.get('sha256', ''))) is None:
            fail('MEASURE_CARRYOVER')
    if files['command.json']['sha256'] != options.expected_previous_measure_output_command_sha256:
        fail('MEASURE_CARRYOVER')
    receipts = evidence.get('receiptSha256')
    if not isinstance(receipts, (list, tuple)) or len(receipts) != 29 \
            or any(SHA256.fullmatch(str(value or '')) is None for value in receipts):
        fail('MEASURE_CARRYOVER')
    retained_owner = evidence.get('retainedOwner')
    if not isinstance(retained_owner, dict) or set(retained_owner) != {'id', 'scope', 'label'} \
            or not strict_uuid4(retained_owner.get('id')) \
            or retained_owner.get('scope') != 'musicbridge-capacity-clone-only' \
            or retained_owner.get('label') != 'sample-30':
        fail('MEASURE_CARRYOVER')
    for name in ('wal', 'shm'):
        identity = evidence.get(name)
        if not isinstance(identity, dict) or set(identity) != {'size', 'sha256'} \
                or type(identity.get('size')) is not int or identity['size'] < 0 \
                or SHA256.fullmatch(str(identity.get('sha256', ''))) is None:
            fail('MEASURE_CARRYOVER')
    receipt_names = [f'sample-{index}.receipt.json' for index in range(1, 30)]
    metric_counts = {
        'progress': 105, 'signalAborted': 28, 'driverStopInvoked': 28,
        'driverStopAck': 28, 'driverCloseInvoked': 28,
        'driverCloseResolved': 28, 'receiptSettled': 28,
    }
    return {
        'valid': True,
        'terminal': {
            'windowId': options.expected_previous_measure_window_id,
            'label': options.expected_previous_measure_output_label,
            'state': 'failed',
            'failure': 'EXECUTION_TIMEOUT',
            'windowSha256': options.expected_previous_measure_window_sha256,
            'closeSha256': options.expected_previous_measure_close_sha256,
            'groupEmpty': True,
            'zombies': [],
            'authorityStable': True,
            'replayAllowed': False,
        },
        'partial': {
            'format': evidence['format'],
            'outputDirectory': str(output),
            'commandSha256': options.expected_previous_measure_output_command_sha256,
            'partialExists': True,
            'partialPreserved': True,
            'verifiedPassed': False,
            'sampleCount': 273,
            'receiptCount': 29,
            'samplesSha256': files['samples.jsonl']['sha256'],
            'samplesMatchReceipts': True,
            'receiptManifestSha256': evidence['receiptManifestSha256'],
            'receiptNames': receipt_names,
            'metricCounts': metric_counts,
            'retainedDirectories': ['sample-30'],
            'retainedClone': {
                'directoryName': 'sample-30',
                'ownerSha256': evidence['retainedOwnerSha256'],
                'sqlite': {
                    'size': evidence['sqliteBytes'],
                    'nlink': 1,
                    'contentSha256Verified': False,
                    'verification': 'stable-lstat-size-only-no-content-read',
                },
                'wal': dict(evidence['wal']),
                'shm': dict(evidence['shm']),
            },
            'unexpectedEntries': [],
        },
        'roots': roots,
    }


def validate_measure_carryover(helper, module, options, runtime):
    window_path = same_regular_file(
        helper, options.previous_measure_window,
        options.expected_previous_measure_window_sha256, 'MEASURE_CARRYOVER')
    close_path = same_regular_file(
        helper, options.previous_measure_close,
        options.expected_previous_measure_close_sha256, 'MEASURE_CARRYOVER')
    if window_path.name != 'window.json' or close_path.name != 'close.json' \
            or window_path.parent.parent != runtime or close_path.parent != window_path.parent:
        fail('MEASURE_CARRYOVER')
    try:
        output = helper.canonical_directory(options.previous_measure_output, runtime)
    except Exception as error:
        raise IssueError('MEASURE_CARRYOVER') from error
    if output.parent != runtime or output.name != options.expected_previous_measure_output_label:
        fail('MEASURE_CARRYOVER')
    command_path = same_regular_file(
        helper, output / 'command.json',
        options.expected_previous_measure_output_command_sha256, 'MEASURE_CARRYOVER')
    owner, _ = read_json(helper, window_path.parent / 'owner.json', error_code='MEASURE_CARRYOVER')
    if owner != {
            'scope': 'musicbridge-capacity-measure-window',
            'owner': 'root',
            'id': options.expected_previous_measure_window_id}:
        fail('MEASURE_CARRYOVER')
    expected = {
        'windowId': options.expected_previous_measure_window_id,
        'windowSha256': options.expected_previous_measure_window_sha256,
        'closeSha256': options.expected_previous_measure_close_sha256,
        'label': options.expected_previous_measure_output_label,
        'outputCommandSha256': options.expected_previous_measure_output_command_sha256,
    }
    try:
        observed = module._validate_measure_carryover(
            window_path, close_path, output, runtime,
            expected['windowSha256'], expected['closeSha256'],
            expected['outputCommandSha256'], expected['windowId'], expected['label'])
    except Exception as error:
        raise IssueError('MEASURE_CARRYOVER') from error
    try:
        roots = [
            helper.current_root(window_path.parent, 'owner.json'),
            helper.current_root(output, 'command.json'),
        ]
    except Exception as error:
        raise IssueError('MEASURE_CARRYOVER') from error
    expected_result = expected_legacy_carryover(module, options, output, roots)
    if observed != expected_result:
        fail('MEASURE_CARRYOVER')
    try:
        checked_roots = [helper.root_identity(row) for row in observed['roots']]
    except Exception as error:
        raise IssueError('MEASURE_CARRYOVER') from error
    if checked_roots != roots or command_path != output / 'command.json':
        fail('MEASURE_CARRYOVER')
    return {
        'windowPath': window_path,
        'closePath': close_path,
        'output': output,
        'roots': roots,
        'terminal': observed['terminal'],
        'partial': observed['partial'],
    }


def install_supervisor(source, destination, expected_sha256):
    source_fd = None
    destination_fd = None
    flags = getattr(os, 'O_NOFOLLOW', 0)
    digest = hashlib.sha256()
    try:
        source_fd = os.open(source, os.O_RDONLY | flags)
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail('SUPERVISOR_INSTALL')
        destination_fd = os.open(
            destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | flags, 0o700)
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                if written <= 0:
                    fail('SUPERVISOR_INSTALL')
                view = view[written:]
        os.fchmod(destination_fd, 0o700)
        os.fsync(destination_fd)
        after = os.fstat(source_fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != \
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) \
                or digest.hexdigest() != expected_sha256:
            fail('SUPERVISOR_INSTALL')
    except IssueError:
        raise
    except OSError as error:
        raise IssueError('SUPERVISOR_INSTALL') from error
    finally:
        if destination_fd is not None:
            os.close(destination_fd)
        if source_fd is not None:
            os.close(source_fd)
    try:
        fsync_directory(Path(destination).parent)
    except OSError as error:
        raise IssueError('SUPERVISOR_INSTALL') from error


def validate_window_file(helper, path, expected, expected_sha256, installed_supervisor):
    try:
        value, observed_sha256 = helper.strict_json(path)
    except Exception as error:
        raise IssueError('WINDOW_IDENTITY') from error
    if not isinstance(value, dict):
        fail('WINDOW_IDENTITY')
    if value.get('supervisor') != installed_supervisor:
        fail('SUPERVISOR_IDENTITY')
    if value != expected or observed_sha256 != expected_sha256:
        fail('WINDOW_IDENTITY')
    same_regular_file(
        helper, installed_supervisor['path'], installed_supervisor['sha256'],
        'SUPERVISOR_IDENTITY')


def issue(options):
    global _FAILURE_CONTEXT
    if SAFE.fullmatch(options.window_dir_name or '') is None \
            or SAFE.fullmatch(options.label or '') is None \
            or SAFE.fullmatch(options.seed_label or '') is None \
            or SAFE.fullmatch(options.expected_previous_measure_output_label or '') is None \
            or options.profile != 'objects-limit' \
            or options.window_dir_name in {options.label, options.seed_label} \
            or options.label in {options.seed_label, options.expected_previous_measure_output_label} \
            or options.window_dir_name == options.expected_previous_measure_output_label \
            or not strict_uuid4(options.expected_previous_measure_window_id) \
            or SHA256.fullmatch(options.expected_previous_measure_window_sha256 or '') is None \
            or SHA256.fullmatch(options.expected_previous_measure_close_sha256 or '') is None \
            or SHA256.fullmatch(options.expected_previous_measure_output_command_sha256 or '') is None \
            or GIT_SHA.fullmatch(options.expected_head or '') is None \
            or GIT_SHA.fullmatch(options.expected_generation_head or '') is None \
            or GIT_SHA.fullmatch(options.expected_issuer_head or '') is None:
        fail('INPUT')
    helper_path = Path(options.generation_issuer_helper).resolve(strict=True)
    helper = load_python(helper_path, 'musicbridge_capacity_generation_issuer_helper', 'HELPER_IDENTITY')
    required_helper = (
        'stable_sha256', 'strict_json', 'exclusive_json', 'fsync_directory',
        'canonical_directory', 'root_identity', 'current_root', 'git_value', 'git_blob',
        'verified_file', 'candidate_contract_dist', 'typescript_library_manifest')
    if any(not hasattr(helper, name) for name in required_helper):
        fail('HELPER_IDENTITY')
    same_regular_file(helper, helper_path, options.expected_generation_issuer_helper_sha256,
                      'HELPER_IDENTITY')
    root = helper.canonical_directory(options.repo_root)
    generation_root = helper.canonical_directory(options.generation_repo_root)
    if generation_root == root:
        fail('REPOSITORY_IDENTITY')
    runtime = helper.canonical_directory(options.runtime_root, generation_root)
    issuer_repo = helper.canonical_directory(options.issuer_repo_root)
    supervisor_path = same_regular_file(
        helper, options.supervisor, options.expected_supervisor_sha256, 'SUPERVISOR_IDENTITY')
    try:
        supervisor_relative = str(supervisor_path.relative_to(issuer_repo))
    except ValueError:
        fail('SUPERVISOR_IDENTITY')
    if supervisor_relative != SUPERVISOR_RELATIVE:
        fail('SUPERVISOR_IDENTITY')
    module = load_python(supervisor_path, 'musicbridge_capacity_measure_supervisor',
                         'SUPERVISOR_IDENTITY')
    required_supervisor = (
        '_expected_source_paths', '_strict_identity', '_validate_source_manifest',
        '_validate_owned_manifest', '_validate_measure_authority',
        '_validate_measure_carryover', '_validate_measure_window',
        '_validate_candidate_repository', '_MEASURE_LIMITS', '_MEASURE_PLAN')
    if any(not hasattr(module, name) for name in required_supervisor) \
            or module._MEASURE_LIMITS != MEASURE_LIMITS \
            or module._MEASURE_PLAN != MEASURE_PLAN:
        fail('SUPERVISOR_CONTRACT')
    consumer = same_regular_file(
        helper, options.consumer_python, options.expected_consumer_sha256,
        'CONSUMER_IDENTITY')
    if not os.access(consumer, os.X_OK):
        fail('CONSUMER_IDENTITY')
    issuer_path = Path(__file__).resolve(strict=True)
    same_regular_file(helper, issuer_path, options.expected_issuer_sha256, 'ISSUER_IDENTITY')
    try:
        issuer_relative = str(issuer_path.relative_to(issuer_repo))
    except ValueError:
        fail('ISSUER_IDENTITY')
    if helper.git_value(root, 'rev-parse', 'HEAD^{commit}') != options.expected_head \
            or helper.git_value(root, 'branch', '--show-current') != options.expected_branch \
            or helper.git_value(generation_root, 'rev-parse', 'HEAD^{commit}') \
            != options.expected_generation_head \
            or helper.git_value(generation_root, 'branch', '--show-current') \
            != options.expected_generation_branch \
            or helper.git_value(issuer_repo, 'rev-parse', 'HEAD^{commit}') != options.expected_issuer_head \
            or helper.git_value(issuer_repo, 'branch', '--show-current') != options.expected_issuer_branch \
            or hashlib.sha256(helper.git_blob(
                issuer_repo, options.expected_issuer_head, issuer_relative)).hexdigest() \
            != options.expected_issuer_sha256 \
            or hashlib.sha256(helper.git_blob(
                issuer_repo, options.expected_issuer_head, supervisor_relative)).hexdigest() \
            != options.expected_supervisor_sha256:
        fail('REPOSITORY_IDENTITY')
    toolchain = {
        'buildNode': same_regular_file(helper, options.build_node,
                                       options.expected_build_node_sha256,
                                       'BUILD_TOOLCHAIN_IDENTITY'),
        'buildNodeSha256': options.expected_build_node_sha256,
        'buildNodeLibrary': same_regular_file(helper, options.build_node_library,
                                              options.expected_build_node_library_sha256,
                                              'BUILD_TOOLCHAIN_IDENTITY'),
        'buildNodeLibrarySha256': options.expected_build_node_library_sha256,
        'typescriptCompiler': same_regular_file(helper, options.typescript_compiler,
                                                options.expected_typescript_compiler_sha256,
                                                'BUILD_TOOLCHAIN_IDENTITY'),
        'typescriptCompilerSha256': options.expected_typescript_compiler_sha256,
        'typescriptLibraryManifestSha256': options.expected_typescript_library_manifest_sha256,
    }
    helper.typescript_library_manifest(
        toolchain['typescriptCompiler'].parent,
        options.expected_typescript_library_manifest_sha256)
    source_paths, source_files, build = candidate_sources(
        helper, module, root, options.expected_head, options.expected_source_count, toolchain)
    generation = validate_generation_proof(
        helper, module, options, generation_root, runtime, toolchain)
    carryover = validate_measure_carryover(helper, module, options, runtime)
    reject_replay(helper, runtime, options.window_dir_name, options.label)

    parent = runtime / options.window_dir_name
    window_id = str(uuid.uuid4())
    try:
        parent.mkdir(mode=0o700)
    except OSError as error:
        raise IssueError('EXCLUSIVE_CREATE') from error
    _FAILURE_CONTEXT = {
        'parent': parent, 'runtime': runtime, 'windowId': window_id,
        'windowDirName': options.window_dir_name, 'label': options.label,
    }
    owner = {'scope': 'musicbridge-capacity-measure-window', 'owner': 'root', 'id': window_id}
    owner_sha = helper.exclusive_json(parent / 'owner.json', owner)
    installed_supervisor_path = parent / 'supervisor.py'
    install_supervisor(supervisor_path, installed_supervisor_path,
                       options.expected_supervisor_sha256)
    installed_supervisor = {
        'path': str(installed_supervisor_path),
        'sha256': options.expected_supervisor_sha256,
    }
    installed_module = load_python(
        installed_supervisor_path, 'musicbridge_capacity_measure_installed_supervisor',
        'SUPERVISOR_INSTALL')
    issuer_identity = parent / 'issuer-identity'
    try:
        issuer_identity.mkdir(mode=0o700)
    except OSError as error:
        raise IssueError('EXCLUSIVE_CREATE') from error
    issuer_fact = {
        'schemaVersion': 1,
        'scope': 'musicbridge-capacity-measure-authority-issuer',
        'owner': 'root',
        'id': window_id,
        'issuer': {'path': str(issuer_path), 'sha256': options.expected_issuer_sha256},
        'helper': {'path': str(helper_path),
                   'sha256': options.expected_generation_issuer_helper_sha256},
        'issuerRepository': {'root': str(issuer_repo),
                             'branch': options.expected_issuer_branch,
                             'head': options.expected_issuer_head,
                             'relativePath': issuer_relative},
        'measureRepository': {'root': str(root), 'branch': options.expected_branch,
                              'head': options.expected_head},
        'generationRepository': {
            'root': str(generation_root),
            'branch': options.expected_generation_branch,
            'head': options.expected_generation_head,
        },
        'supervisor': installed_supervisor,
        'supervisorSource': {
            'path': str(supervisor_path),
            'relativePath': supervisor_relative,
            'sha256': options.expected_supervisor_sha256,
        },
        'previousMeasure': {
            'window': {
                'path': str(carryover['windowPath']),
                'id': options.expected_previous_measure_window_id,
                'sha256': options.expected_previous_measure_window_sha256,
            },
            'close': {
                'path': str(carryover['closePath']),
                'sha256': options.expected_previous_measure_close_sha256,
            },
            'output': {
                'path': str(carryover['output']),
                'label': options.expected_previous_measure_output_label,
                'commandSha256': options.expected_previous_measure_output_command_sha256,
            },
            'terminal': carryover['terminal'],
            'partial': carryover['partial'],
        },
        'generation': {
            'window': {'path': str(generation['windowPath']),
                       'sha256': generation['windowSha256']},
            'supervisorSha256': generation['proofSha256'],
            'sourceManifestSha256': generation['sourceSha256'],
            'ownedManifestSha256': generation['ownedSha256'],
            'seedMetadataSha256': generation['seed']['metadataSha256'],
            'seedSnapshotSha256': generation['seed']['snapshotSha256'],
            'fixtureOwnerSha256': generation['seed']['fixtureOwnerSha256'],
        },
        'buildToolchain': {
            'node': {'path': str(toolchain['buildNode']),
                     'sha256': toolchain['buildNodeSha256']},
            'nodeLibrary': {'path': str(toolchain['buildNodeLibrary']),
                            'sha256': toolchain['buildNodeLibrarySha256']},
            'typescriptCompiler': {'path': str(toolchain['typescriptCompiler']),
                                   'sha256': toolchain['typescriptCompilerSha256']},
            'typescriptLibraryManifestSha256': toolchain['typescriptLibraryManifestSha256'],
        },
        'build': build,
    }
    issuer_fact_sha = helper.exclusive_json(issuer_identity / 'owner.json', issuer_fact)
    roots = list(generation['roots'])
    roots.extend((
        helper.current_root(generation['seed']['directory'], 'seed.json'),
        helper.current_root(generation['seed']['fixture'], 'capacity-owner.json'),
        *carryover['roots'],
        helper.current_root(parent, 'owner.json'),
        helper.current_root(issuer_identity, 'owner.json'),
    ))
    root_map = unique_roots(roots)
    if len(root_map) != EXPECTED_MEASURE_EXISTING_ROOTS:
        fail('OWNED_COUNT')
    source = {'schemaVersion': 1, 'scope': 'musicbridge-capacity-source-pins',
              'files': source_files}
    source_sha = helper.exclusive_json(parent / 'source-pins.json', source)
    output = runtime / options.label
    owned = {
        'schemaVersion': 1, 'scope': 'musicbridge-capacity-owned-roots',
        'access': 'count-only', 'windowId': window_id,
        'roots': list(root_map.values()), 'futureRoots': [str(output)],
    }
    owned_sha = helper.exclusive_json(parent / 'owned-roots.json', owned)
    planned = 2 * generation['seed']['snapshotBytes'] + 256 * 1024 ** 2
    preflight = authority_preflight_snapshot(options, runtime, output, planned)
    _FAILURE_CONTEXT['preflight'] = preflight
    try:
        source_result = module._validate_source_manifest(parent / 'source-pins.json', root)
    except Exception as error:
        try:
            fail_authority_preflight(
                preflight, runtime, 'AUTHORITY_PREFLIGHT_SOURCE',
                'source-manifest', 'validator-exception')
        except IssueError as failure:
            raise failure from error
    preflight['sourceValidated'] = True
    if not isinstance(source_result, dict):
        fail_authority_preflight(
            preflight, runtime, 'AUTHORITY_PREFLIGHT_SOURCE',
            'source-manifest', 'validator-result')
    preflight['observedSourceFileCount'] = source_result.get('fileCount')
    preflight['sourceCountMatches'] = (
        source_result.get('fileCount') == options.expected_source_count)
    if not preflight['sourceCountMatches']:
        fail_authority_preflight(
            preflight, runtime, 'AUTHORITY_PREFLIGHT_SOURCE',
            'source-manifest', 'file-count')

    preflight['phase'] = 'owned-manifest'
    try:
        owned_result = module._validate_owned_manifest(
            parent / 'owned-roots.json', runtime, window_id, 'objects-limit',
            planned_bytes=planned, future_path=output, future_state='absent')
    except Exception as error:
        try:
            fail_authority_preflight(
                preflight, runtime, 'AUTHORITY_PREFLIGHT_OWNED',
                'owned-manifest', 'validator-exception')
        except IssueError as failure:
            raise failure from error
    preflight['ownedValidated'] = True
    if not isinstance(owned_result, dict):
        fail_authority_preflight(
            preflight, runtime, 'AUTHORITY_PREFLIGHT_OWNED',
            'owned-manifest', 'validator-result')
    preflight['observedAuthorizedRootCount'] = owned_result.get('rootCount')
    preflight['observedPlannedBytes'] = owned_result.get('plannedBytes')
    preflight['ownedBytes'] = owned_result.get('ownedBytes')
    preflight['availableBytes'] = owned_result.get('availableBytes')
    preflight['rootCountMatches'] = (
        owned_result.get('rootCount') == EXPECTED_MEASURE_AUTHORIZED_ROOTS)
    preflight['plannedBytesMatches'] = owned_result.get('plannedBytes') == planned
    if not preflight['rootCountMatches']:
        fail_authority_preflight(
            preflight, runtime, 'AUTHORITY_PREFLIGHT_OWNED',
            'owned-manifest', 'root-count')
    if not preflight['plannedBytesMatches']:
        fail_authority_preflight(
            preflight, runtime, 'AUTHORITY_PREFLIGHT_OWNED',
            'owned-manifest', 'planned-bytes')
    preflight['phase'] = 'facts'
    if type(owned_result.get('ownedBytes')) is not int:
        fail_authority_preflight(
            preflight, runtime, 'AUTHORITY_PREFLIGHT_FACTS',
            'facts', 'owned-bytes-type')
    if type(owned_result.get('availableBytes')) is not int:
        fail_authority_preflight(
            preflight, runtime, 'AUTHORITY_PREFLIGHT_FACTS',
            'facts', 'available-bytes-type')
    preflight['ownedBudgetWithinLimit'] = (
        owned_result['ownedBytes'] + planned <= MEASURE_LIMITS['maximumOwnedBytes'])
    preflight['freeReserveAfterPlanSatisfied'] = (
        owned_result['availableBytes'] - planned >= MEASURE_LIMITS['minimumFreeBytes'])
    if not preflight['ownedBudgetWithinLimit']:
        fail_authority_preflight(
            preflight, runtime, 'AUTHORITY_PREFLIGHT_FACTS',
            'facts', 'maximum-owned-bytes')
    if not preflight['freeReserveAfterPlanSatisfied']:
        fail_authority_preflight(
            preflight, runtime, 'AUTHORITY_PREFLIGHT_FACTS',
            'facts', 'minimum-free-bytes')

    issued = datetime.datetime.now(datetime.timezone.utc)
    deadline = issued + datetime.timedelta(seconds=900)
    window = {
        'schemaVersion': 1, 'scope': 'musicbridge-capacity-measure-window',
        'owner': 'root', 'id': window_id, 'state': 'approved', 'phase': 'measure',
        'profile': 'objects-limit', 'label': options.label,
        'seedLabel': options.seed_label, 'n': 105,
        'issuedAt': issued.isoformat(timespec='milliseconds'),
        'deadlineAt': deadline.isoformat(timespec='milliseconds'),
        'limits': dict(MEASURE_LIMITS),
        'measurePlan': dict(MEASURE_PLAN),
        'supervisor': installed_supervisor,
        'candidateRepository': {
            'root': str(root),
            'branch': options.expected_branch,
            'head': options.expected_head,
        },
        'seed': {
            'metadataSha256': generation['seed']['metadataSha256'],
            'snapshotSha256': generation['seed']['snapshotSha256'],
            'fixtureOwnerSha256': generation['seed']['fixtureOwnerSha256'],
        },
        'ownedManifest': {'file': 'owned-roots.json', 'sha256': owned_sha},
        'sourceManifest': {'file': 'source-pins.json', 'sha256': source_sha},
    }
    preflight['phase'] = 'candidate-repository'
    try:
        installed_module._validate_candidate_repository(window, runtime)
    except (Exception, SystemExit) as error:
        try:
            fail_authority_preflight(
                preflight, runtime, 'AUTHORITY_PREFLIGHT_CANDIDATE',
                'candidate-repository', 'validator-exception')
        except IssueError as failure:
            raise failure from error
    preflight['candidateRepositoryValidated'] = True
    preflight['phase'] = 'window'
    try:
        installed_module._validate_measure_window(window, issued.timestamp())
    except (Exception, SystemExit) as error:
        try:
            fail_authority_preflight(
                preflight, runtime, 'AUTHORITY_PREFLIGHT_WINDOW',
                'window', 'validator-exception')
        except IssueError as failure:
            raise failure from error
    preflight['windowValidated'] = True
    preflight['phase'] = 'complete'
    preflight['filesystemAvailableBytesAfter'] = filesystem_available_bytes(runtime)
    pending = parent / 'window.pending.json'
    window_sha = helper.exclusive_json(pending, window)
    # 发布前再次复核完整 generation proof、签发器与仓库身份。
    validate_generation_proof(helper, module, options, generation_root, runtime, toolchain)
    validate_measure_carryover(helper, module, options, runtime)
    same_regular_file(helper, issuer_path, options.expected_issuer_sha256, 'ISSUER_IDENTITY')
    same_regular_file(helper, supervisor_path, options.expected_supervisor_sha256,
                      'SUPERVISOR_IDENTITY')
    same_regular_file(helper, installed_supervisor_path, options.expected_supervisor_sha256,
                      'SUPERVISOR_IDENTITY')
    if helper.git_value(root, 'rev-parse', 'HEAD^{commit}') != options.expected_head \
            or helper.git_value(root, 'branch', '--show-current') != options.expected_branch \
            or helper.git_value(generation_root, 'rev-parse', 'HEAD^{commit}') \
            != options.expected_generation_head \
            or helper.git_value(generation_root, 'branch', '--show-current') \
            != options.expected_generation_branch \
            or helper.git_value(issuer_repo, 'rev-parse', 'HEAD^{commit}') != options.expected_issuer_head \
            or helper.git_value(issuer_repo, 'branch', '--show-current') != options.expected_issuer_branch \
            or hashlib.sha256(helper.git_blob(
                issuer_repo, options.expected_issuer_head, supervisor_relative)).hexdigest() \
            != options.expected_supervisor_sha256:
        fail('REPOSITORY_IDENTITY')
    validate_window_file(helper, pending, window, window_sha, installed_supervisor)
    fsync_directory(issuer_identity)
    fsync_directory(parent)
    fsync_directory(runtime)
    published = parent / 'window.json'
    os.rename(pending, published)
    try:
        validate_window_file(helper, published, window, window_sha, installed_supervisor)
    except IssueError:
        try:
            os.rename(published, pending)
            fsync_directory(parent)
            fsync_directory(runtime)
        except OSError:
            _FAILURE_CONTEXT = None
        raise
    try:
        fsync_directory(parent)
        fsync_directory(runtime)
    except Exception as error:
        # 保持 live 状态单一：撤回 approved 名称，再由统一失败路径写终止回执。
        try:
            os.rename(published, pending)
        except OSError:
            # rename 已是逻辑发布点；无法撤回时不得再写冲突的 terminal failure，
            # 也不下发消费命令。调用方必须重新独立审计这个已烧毁的窗口。
            _FAILURE_CONTEXT = None
            return {
                'state': 'PUBLISHED_NOT_EXECUTED_DURABILITY_UNCONFIRMED',
                'windowId': window_id, 'windowPath': str(published),
                'windowSha256': window_sha, 'profile': 'objects-limit',
                'label': options.label, 'seedLabel': options.seed_label,
                'sourceFileCount': source_result.get('fileCount'),
                'ownedRootCount': owned_result.get('rootCount'),
                'ownedBytes': owned_result.get('ownedBytes'),
                'plannedBytes': owned_result.get('plannedBytes'),
                'availableBytes': owned_result.get('availableBytes'),
                'deadlineAt': window['deadlineAt'],
                'issuerFact': {'file': 'issuer-identity/owner.json', 'sha256': issuer_fact_sha},
                'consumeCommand': None,
            }
        try:
            fsync_directory(parent)
            fsync_directory(runtime)
        except Exception:
            # live 名称已经撤回；失败回执明确保持不可重放，后续不消费 pending。
            pass
        raise IssueError('PUBLISH_DURABILITY') from error
    result = {
        'state': 'ISSUED_NOT_EXECUTED', 'windowId': window_id,
        'windowPath': str(published), 'windowSha256': window_sha,
        'profile': 'objects-limit', 'label': options.label,
        'seedLabel': options.seed_label, 'sourceFileCount': source_result.get('fileCount'),
        'ownedRootCount': owned_result.get('rootCount'),
        'ownedBytes': owned_result.get('ownedBytes'),
        'plannedBytes': owned_result.get('plannedBytes'),
        'availableBytes': owned_result.get('availableBytes'),
        'deadlineAt': window['deadlineAt'],
        'issuerFact': {'file': 'issuer-identity/owner.json', 'sha256': issuer_fact_sha},
        'consumeCommand': [str(consumer), str(installed_supervisor_path), '--window',
                           str(published), '--window-sha256', window_sha],
    }
    _FAILURE_CONTEXT = None
    return result


def main(argv):
    helper = None
    try:
        options = parse_args(argv)
        helper_path = Path(options.generation_issuer_helper).resolve(strict=True)
        helper = load_python(helper_path, 'musicbridge_capacity_generation_issuer_failure_helper',
                             'HELPER_IDENTITY')
        value = issue(options)
    except IssueError as error:
        if helper is not None:
            record_terminal_failure(helper, str(error))
        print(f'CAPACITY_MEASURE_WINDOW_ISSUER={error}', file=sys.stderr)
        return 1
    except Exception:
        if helper is not None:
            record_terminal_failure(helper, 'ISSUER_INTERNAL')
        print('CAPACITY_MEASURE_WINDOW_ISSUER=ISSUER_INTERNAL', file=sys.stderr)
        return 1
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
