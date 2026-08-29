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
EXPECTED_GENERATION_ROOTS = 59
EXPECTED_MEASURE_EXISTING_ROOTS = 63
EXPECTED_MEASURE_AUTHORIZED_ROOTS = 64
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
    parser.add_argument('--runtime-root', required=True)
    parser.add_argument('--supervisor', required=True)
    parser.add_argument('--expected-supervisor-sha256', required=True)
    parser.add_argument('--expected-source-count', required=True, type=int)
    parser.add_argument('--generation-window', required=True)
    parser.add_argument('--expected-generation-window-sha256', required=True)
    parser.add_argument('--generation-supervisor', required=True)
    parser.add_argument('--expected-generation-supervisor-sha256', required=True)
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


def record_terminal_failure(helper, code):
    global _FAILURE_CONTEXT
    context = _FAILURE_CONTEXT
    if context is None:
        return
    parent = context['parent']
    receipt = parent / 'issuer-failure.json'
    if receipt.exists() or receipt.is_symlink():
        return
    names = ('owner.json', 'issuer-identity/owner.json', 'source-pins.json',
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


def validate_generation_proof(helper, module, options, root, runtime, source_files):
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
    if window.get('sourceManifest') != {'file': 'source-pins.json', 'sha256': source_sha} \
            or window.get('ownedManifest') != {'file': 'owned-roots.json', 'sha256': owned_sha} \
            or not isinstance(source, dict) or source.get('files') != source_files \
            or not isinstance(owned, dict) or owned.get('windowId') != window['id'] \
            or not isinstance(owned.get('roots'), list) \
            or len(owned['roots']) != EXPECTED_GENERATION_ROOTS:
        fail('GENERATION_PROOF')
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
            or authority.get('sourceFileCount') != options.expected_source_count
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


def issue(options):
    global _FAILURE_CONTEXT
    if SAFE.fullmatch(options.window_dir_name or '') is None \
            or SAFE.fullmatch(options.label or '') is None \
            or SAFE.fullmatch(options.seed_label or '') is None \
            or options.profile != 'objects-limit' \
            or options.window_dir_name in {options.label, options.seed_label} \
            or options.label == options.seed_label \
            or GIT_SHA.fullmatch(options.expected_head or '') is None \
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
    runtime = helper.canonical_directory(options.runtime_root, root)
    issuer_repo = helper.canonical_directory(options.issuer_repo_root)
    supervisor_path = same_regular_file(
        helper, options.supervisor, options.expected_supervisor_sha256, 'SUPERVISOR_IDENTITY')
    if supervisor_path.parent != runtime:
        fail('SUPERVISOR_IDENTITY')
    module = load_python(supervisor_path, 'musicbridge_capacity_measure_supervisor',
                         'SUPERVISOR_IDENTITY')
    required_supervisor = (
        '_expected_source_paths', '_strict_identity', '_validate_source_manifest',
        '_validate_owned_manifest', '_validate_measure_authority', '_MEASURE_LIMITS')
    if any(not hasattr(module, name) for name in required_supervisor) \
            or module._MEASURE_LIMITS != MEASURE_LIMITS:
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
            or helper.git_value(issuer_repo, 'rev-parse', 'HEAD^{commit}') != options.expected_issuer_head \
            or helper.git_value(issuer_repo, 'branch', '--show-current') != options.expected_issuer_branch \
            or hashlib.sha256(helper.git_blob(
                issuer_repo, options.expected_issuer_head, issuer_relative)).hexdigest() \
            != options.expected_issuer_sha256:
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
        helper, module, options, root, runtime, source_files)
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
        'candidateRepository': {'root': str(root), 'branch': options.expected_branch,
                                'head': options.expected_head},
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
    try:
        source_result = module._validate_source_manifest(parent / 'source-pins.json', root)
        owned_result = module._validate_owned_manifest(
            parent / 'owned-roots.json', runtime, window_id, 'objects-limit',
            planned_bytes=planned, future_path=output, future_state='absent')
    except Exception as error:
        raise IssueError('AUTHORITY_PREFLIGHT') from error
    if source_result.get('fileCount') != options.expected_source_count \
            or owned_result.get('rootCount') != EXPECTED_MEASURE_AUTHORIZED_ROOTS \
            or owned_result.get('plannedBytes') != planned \
            or type(owned_result.get('ownedBytes')) is not int \
            or type(owned_result.get('availableBytes')) is not int \
            or owned_result['ownedBytes'] + planned > MEASURE_LIMITS['maximumOwnedBytes'] \
            or owned_result['availableBytes'] - planned < MEASURE_LIMITS['minimumFreeBytes']:
        fail('AUTHORITY_PREFLIGHT')

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
        'seed': {
            'metadataSha256': generation['seed']['metadataSha256'],
            'snapshotSha256': generation['seed']['snapshotSha256'],
            'fixtureOwnerSha256': generation['seed']['fixtureOwnerSha256'],
        },
        'ownedManifest': {'file': 'owned-roots.json', 'sha256': owned_sha},
        'sourceManifest': {'file': 'source-pins.json', 'sha256': source_sha},
    }
    pending = parent / 'window.pending.json'
    window_sha = helper.exclusive_json(pending, window)
    # 发布前再次复核完整 generation proof、签发器与仓库身份。
    validate_generation_proof(helper, module, options, root, runtime, source_files)
    same_regular_file(helper, issuer_path, options.expected_issuer_sha256, 'ISSUER_IDENTITY')
    if helper.git_value(root, 'rev-parse', 'HEAD^{commit}') != options.expected_head \
            or helper.git_value(issuer_repo, 'rev-parse', 'HEAD^{commit}') != options.expected_issuer_head:
        fail('REPOSITORY_IDENTITY')
    fsync_directory(issuer_identity)
    fsync_directory(parent)
    fsync_directory(runtime)
    published = parent / 'window.json'
    os.rename(pending, published)
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
        'consumeCommand': [str(consumer), str(supervisor_path), '--window',
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
