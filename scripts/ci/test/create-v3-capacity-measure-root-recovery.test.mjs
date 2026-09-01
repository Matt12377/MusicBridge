import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const sourceScript = new URL('../create-v3-capacity-measure-root-recovery.py', import.meta.url).pathname
const python = '/usr/bin/python3'

function compact(value) {
  return Buffer.from(JSON.stringify(value))
}

function shaBytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha(path) {
  return shaBytes(readFileSync(path))
}

function json(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}

function git(cwd, ...args) {
  const value = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  assert.equal(value.status, 0, value.stderr)
  return value.stdout.trim()
}

function rootRow(path, marker, markerBytes) {
  const info = statSync(path)
  return {
    path,
    device: info.dev,
    inode: info.ino,
    marker: { relative: marker, sha256: shaBytes(markerBytes) },
  }
}

function fixture(presentCount = 63) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'measure-root-recovery-')))
  const repo = join(root, 'repo'), remote = join(root, 'remote.git')
  mkdirSync(join(repo, 'scripts/ci'), { recursive: true })
  copyFileSync(sourceScript, join(repo, 'scripts/ci/create-v3-capacity-measure-root-recovery.py'))
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'add recovery control tool')
  git(root, 'init', '--bare', remote)
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-u', 'origin', 'main')
  const head = git(repo, 'rev-parse', 'HEAD')
  const script = join(repo, 'scripts/ci/create-v3-capacity-measure-root-recovery.py')

  const runtime = join(root, 'runtime')
  mkdirSync(runtime, { mode: 0o700 })
  const present = []
  for (let index = 0; index < presentCount; index += 1) {
    const path = join(runtime, `present-${index + 1}`), marker = { scope: 'present', index }
    mkdirSync(path, { mode: 0o700 })
    const bytes = compact(marker)
    writeFileSync(join(path, 'owner.json'), bytes)
    present.push(rootRow(path, 'owner.json', bytes))
  }

  const missing = [], evidences = []
  for (let index = 0; index < 7; index += 1) {
    const path = join(root, `musicbridge-version-old-${index + 1}`)
    const marker = { id: randomUUID(), scope: 'musicbridge-capacity-synthetic-only', index }
    const bytes = compact(marker)
    mkdirSync(path, { mode: 0o700 })
    writeFileSync(join(path, 'capacity-owner.json'), bytes)
    missing.push({ row: rootRow(path, 'capacity-owner.json', bytes), marker, bytes })
    const evidence = join(root, `controlled-evidence-${index + 1}.json`)
    json(evidence, { fixtureDirectory: path, marker })
    evidences.push(evidence)
    rmSync(path, { recursive: true })
  }

  const historical = join(runtime, 'historical-measure-window')
  mkdirSync(historical, { mode: 0o700 })
  const windowId = randomUUID(), manifest = join(historical, 'owned-roots.json')
  json(manifest, {
    schemaVersion: 1,
    scope: 'musicbridge-capacity-owned-roots',
    access: 'count-only',
    windowId,
    roots: [...present, ...missing.map(value => value.row)],
    futureRoots: [join(runtime, 'historical-output')],
  })
  const seed = join(runtime, 'durable-seed', 'seed.sqlite')
  mkdirSync(dirname(seed), { mode: 0o700 })
  writeFileSync(seed, 'small stand-in for the durable two-gigabyte snapshot\n')
  const recoveryName = 'measure-root-recovery-v1'
  const args = [
    '--repo-root', repo,
    '--expected-branch', 'main',
    '--expected-head', head,
    '--expected-script-sha256', sha(script),
    '--runtime-root', runtime,
    '--measure-owned-manifest', manifest,
    '--expected-measure-owned-sha256', sha(manifest),
    '--expected-window-id', windowId,
    '--recovery-dir-name', recoveryName,
    '--durable-seed-snapshot', seed,
    '--expected-durable-seed-snapshot-sha256', sha(seed),
    ...evidences.flatMap(path => ['--evidence-json', path]),
  ]
  return {
    root, repo, runtime, script, head, manifest, windowId, seed, recoveryName,
    recovery: join(runtime, recoveryName), pending: join(runtime, `.${recoveryName}.pending`),
    present, missing, evidences, args,
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}

function run(f, args = f.args, environment = {}) {
  return spawnSync(python, [f.script, ...args], {
    cwd: f.repo,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  })
}

function runMonkeypatched(f, body) {
  const code = `
import importlib.util, json, sys
spec=importlib.util.spec_from_file_location('recovery', sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
${body}
try:
  value=module.issue(module.parse_args(sys.argv[2:]))
  print(json.dumps(value))
except module.RecoveryError as error:
  print(error, file=sys.stderr)
  raise SystemExit(1)
`
  return spawnSync(python, ['-B', '-c', code, f.script, ...f.args], {
    cwd: f.repo, encoding: 'utf8', env: process.env,
  })
}

function replaceEvidenceArgs(args, evidences) {
  const result = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--evidence-json') index += 1
    else result.push(args[index])
  }
  return [...result, ...evidences.flatMap(path => ['--evidence-json', path])]
}

function replaceOption(args, option, value) {
  const result = [...args], index = result.indexOf(option)
  assert.notEqual(index, -1)
  result[index + 1] = value
  return result
}

function rewriteHistoricalDevices(f, deviceForIndex) {
  const value = JSON.parse(readFileSync(f.manifest))
  value.roots = value.roots.map((row, index) => ({ ...row, device: deviceForIndex(index, row) }))
  rmSync(f.manifest)
  json(f.manifest, value)
  return replaceOption(f.args, '--expected-measure-owned-sha256', sha(f.manifest))
}

test('成功时发布7个全新historical-control-only根，旧fixture永久LOST且不复制marker', () => {
  const f = fixture()
  try {
    const result = run(f)
    assert.equal(result.status, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.deepEqual(Object.keys(summary).sort(), [
      'benchmarkDataSource', 'contentRecovered', 'gateB', 'historicalManifestRewritten',
      'recoveryDirectoryName', 'replacementCount', 'state',
    ])
    assert.equal(summary.state, 'PUBLISHED')
    assert.equal(summary.replacementCount, 7)
    assert.equal(summary.recoveryDirectoryName, f.recoveryName)
    assert.equal(result.stdout.includes(f.root), false, 'stdout不得暴露绝对路径')
    assert.equal(existsSync(f.pending), false)
    assert.equal(statSync(f.recovery).mode & 0o777, 0o700)

    const receiptPath = join(f.recovery, 'recovery.json')
    assert.equal(statSync(receiptPath).mode & 0o777, 0o400)
    const receipt = JSON.parse(readFileSync(receiptPath))
    assert.deepEqual(Object.keys(receipt).sort(), [
      'access', 'activeBenchmarkInput', 'contentRecovered', 'deviceOpened', 'formalReady', 'gateB',
      'historicalManifest', 'historicalManifestRewritten', 'liveDeviceRemap', 'mappings', 'model', 'recoveryTool',
      'repository', 'schemaVersion', 'scope', 'state', 'windowId',
    ])
    assert.equal(receipt.scope, 'musicbridge-capacity-measure-root-recovery')
    assert.equal(receipt.state, 'PUBLISHED')
    assert.equal(receipt.model, 'exact75-v2-replacement-closure')
    assert.equal(receipt.windowId, f.windowId)
    assert.equal(receipt.historicalManifest.sha256, sha(f.manifest))
    assert.deepEqual(receipt.repository, {
      root: f.repo, branch: 'main', head: f.head, clean: true, pushedHead: true,
    })
    assert.equal(receipt.recoveryTool.workingSha256, sha(f.script))
    assert.equal(receipt.recoveryTool.gitBlobSha256, sha(f.script))
    assert.deepEqual(receipt.activeBenchmarkInput, {
      model: 'durable-seed-snapshot', path: f.seed, sha256: sha(f.seed),
    })
    assert.equal(receipt.contentRecovered, false)
    assert.equal(receipt.historicalManifestRewritten, false)
    assert.equal(receipt.deviceOpened, false)
    assert.equal(receipt.formalReady, false)
    assert.equal(receipt.gateB, 'NOT_RUN')
    assert.deepEqual(Object.keys(receipt.liveDeviceRemap).sort(), [
      'currentDevice', 'historicalDevice', 'liveRootCount', 'mode',
    ])
    assert.deepEqual(receipt.liveDeviceRemap, {
      mode: 'UNCHANGED',
      historicalDevice: statSync(f.runtime).dev,
      currentDevice: statSync(f.runtime).dev,
      liveRootCount: 63,
    })
    assert.equal(receipt.mappings.length, 7)
    for (const [index, mapping] of receipt.mappings.entries()) {
      assert.deepEqual(mapping.historicalRoot, f.missing[index].row)
      assert.equal(mapping.state, 'LOST')
      assert.equal(mapping.recovered, false)
      assert.equal(mapping.replacementRoot.role, 'historical-control-only')
      assert.equal(statSync(mapping.replacementRoot.path).mode & 0o777, 0o700)
      const markerPath = join(mapping.replacementRoot.path, 'owner.json')
      const bytes = readFileSync(markerPath)
      assert.equal(statSync(markerPath).mode & 0o777, 0o400)
      assert.equal(shaBytes(bytes), mapping.replacementRoot.marker.sha256)
      assert.notDeepEqual(bytes, f.missing[index].bytes, 'replacement不得复刻旧fixture marker')
      const marker = JSON.parse(bytes)
      assert.equal(marker.scope, 'musicbridge-capacity-historical-control-only')
      assert.equal(marker.role, 'historical-control-only')
      assert.deepEqual(marker.historicalRoot, f.missing[index].row)
      assert.equal(marker.recovered, false)
    }
    assert.equal(run(f).status, 1, '已发布终态必须拒绝重复运行')
  } finally { f.cleanup() }
})

test('70个历史root统一旧device时允许REMAPPED且replacement全部落在currentDevice', () => {
  const f = fixture()
  try {
    const currentDevice = statSync(f.runtime).dev
    const historicalDevice = currentDevice + 101
    const args = rewriteHistoricalDevices(f, () => historicalDevice)
    const result = run(f, args)
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(readFileSync(join(f.recovery, 'recovery.json')))
    assert.deepEqual(receipt.liveDeviceRemap, {
      mode: 'REMAPPED', historicalDevice, currentDevice, liveRootCount: 63,
    })
    assert.equal(receipt.mappings.length, 7)
    for (const mapping of receipt.mappings) {
      assert.equal(mapping.state, 'LOST')
      assert.equal(mapping.replacementRoot.device, currentDevice)
      assert.equal(statSync(mapping.replacementRoot.path).dev, currentDevice)
    }
  } finally { f.cleanup() }
})

test('runtime整体迁移时只允许显式前缀重映射，并逐根冻结旧新身份', () => {
  const f = fixture()
  try {
    const historicalRuntime = f.runtime
    const currentRuntime = join(f.root, 'runtime-relocated')
    renameSync(historicalRuntime, currentRuntime)
    const currentManifest = join(currentRuntime, 'historical-measure-window', 'owned-roots.json')
    const currentSeed = join(currentRuntime, 'durable-seed', 'seed.sqlite')
    let args = replaceOption(f.args, '--runtime-root', currentRuntime)
    args = replaceOption(args, '--measure-owned-manifest', currentManifest)
    args = replaceOption(args, '--durable-seed-snapshot', currentSeed)
    args.push('--historical-runtime-root', historicalRuntime)

    const result = run(f, args)
    assert.equal(result.status, 0, result.stderr)
    const recovery = join(currentRuntime, f.recoveryName)
    const receipt = JSON.parse(readFileSync(join(recovery, 'recovery.json')))
    assert.equal(receipt.model, 'exact75-v3-runtime-relocation-closure')
    assert.deepEqual(Object.keys(receipt.liveRootRemap).sort(), [
      'currentRuntime', 'historicalRuntime', 'liveRootCount', 'mappings', 'mode',
    ])
    assert.equal(receipt.liveRootRemap.mode, 'PREFIX_RELOCATION')
    assert.equal(receipt.liveRootRemap.historicalRuntime, historicalRuntime)
    assert.equal(receipt.liveRootRemap.currentRuntime, currentRuntime)
    assert.equal(receipt.liveRootRemap.liveRootCount, 63)
    assert.equal(receipt.liveRootRemap.mappings.length, 63)
    for (const [index, mapping] of receipt.liveRootRemap.mappings.entries()) {
      assert.deepEqual(mapping.historicalRoot, f.present[index])
      assert.equal(mapping.currentRoot.path,
        join(currentRuntime, mapping.historicalRoot.path.slice(historicalRuntime.length + 1)))
      assert.equal(mapping.currentRoot.device, statSync(mapping.currentRoot.path).dev)
      assert.equal(mapping.currentRoot.inode, statSync(mapping.currentRoot.path).ino)
      assert.deepEqual(mapping.currentRoot.marker, mapping.historicalRoot.marker)
    }
  } finally { f.cleanup() }
})

test('历史runtime前缀仍是指向current runtime的符号链接时也允许显式重映射', () => {
  const f = fixture()
  try {
    const historicalRuntime = join(f.root, 'historical-runtime-alias')
    symlinkSync(f.runtime, historicalRuntime, 'dir')
    const value = JSON.parse(readFileSync(f.manifest))
    value.roots = value.roots.map(row => row.path.startsWith(`${f.runtime}/`)
      ? { ...row, path: historicalRuntime + row.path.slice(f.runtime.length) }
      : row)
    value.futureRoots = value.futureRoots.map(path =>
      historicalRuntime + path.slice(f.runtime.length))
    rmSync(f.manifest)
    json(f.manifest, value)
    let args = replaceOption(f.args, '--expected-measure-owned-sha256', sha(f.manifest))
    args.push('--historical-runtime-root', historicalRuntime)

    const result = run(f, args)
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(readFileSync(join(f.recovery, 'recovery.json')))
    assert.equal(receipt.model, 'exact75-v3-runtime-relocation-closure')
    assert.equal(receipt.liveRootRemap.historicalRuntime, historicalRuntime)
    assert.equal(receipt.liveRootRemap.currentRuntime, f.runtime)
    assert.equal(receipt.liveRootRemap.mappings.length, 63)
    for (const mapping of receipt.liveRootRemap.mappings) {
      assert.equal(mapping.historicalRoot.path.startsWith(`${historicalRuntime}/`), true)
      assert.equal(mapping.currentRoot.path.startsWith(`${f.runtime}/`), true)
    }
  } finally { f.cleanup() }
})

test('70个历史root混合device时在创建pending前拒绝', () => {
  const f = fixture()
  try {
    const historicalDevice = statSync(f.runtime).dev + 101
    const args = rewriteHistoricalDevices(
      f, index => index === 69 ? historicalDevice + 1 : historicalDevice)
    const result = run(f, args)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /MEASURE_OWNED_MANIFEST/u)
    assert.equal(existsSync(f.pending), false)
    assert.equal(existsSync(f.recovery), false)
  } finally { f.cleanup() }
})

test('证据缺项或夹带都不能形成exact-7 missing-root闭包', async t => {
  await t.test('缺一项', () => {
    const f = fixture()
    try {
      const result = run(f, replaceEvidenceArgs(f.args, f.evidences.slice(0, 6)))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /MISSING_ROOT_EVIDENCE/)
      assert.equal(existsSync(f.recovery), false)
    } finally { f.cleanup() }
  })
  await t.test('夹带一项', () => {
    const f = fixture()
    try {
      const extraPath = join(f.root, 'never-declared-root')
      const extraEvidence = join(f.root, 'extra-evidence.json')
      json(extraEvidence, { fixtureDirectory: extraPath, marker: { scope: 'smuggled' } })
      const result = run(f, replaceEvidenceArgs(f.args, [...f.evidences, extraEvidence]))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /MISSING_ROOT_EVIDENCE/)
      assert.equal(existsSync(f.recovery), false)
    } finally { f.cleanup() }
  })
})

test('manifest必须在创建pending前精确闭合70 roots、63 live、7 missing与唯一future root', async t => {
  for (const presentCount of [62, 64]) {
    await t.test(`${presentCount}+7 roots拒绝`, () => {
      const f = fixture(presentCount)
      try {
        const result = run(f)
        assert.equal(result.status, 1)
        assert.match(result.stderr, /MEASURE_OWNED_MANIFEST/u)
        assert.equal(existsSync(f.pending), false)
      } finally { f.cleanup() }
    })
  }
  for (const futureRoots of [[], ['/future-a', '/future-b']]) {
    await t.test(`futureRoots数量${futureRoots.length}拒绝`, () => {
      const f = fixture()
      try {
        const value = JSON.parse(readFileSync(f.manifest))
        value.futureRoots = futureRoots
        rmSync(f.manifest); json(f.manifest, value)
        const result = run(f, replaceOption(f.args, '--expected-measure-owned-sha256', sha(f.manifest)))
        assert.equal(result.status, 1)
        assert.match(result.stderr, /MEASURE_OWNED_MANIFEST/u)
        assert.equal(existsSync(f.pending), false)
      } finally { f.cleanup() }
    })
  }
})

test('任一旧路径重现必须停止，不能把它当作已恢复', () => {
  const f = fixture()
  try {
    mkdirSync(f.missing[2].row.path)
    writeFileSync(join(f.missing[2].row.path, 'capacity-owner.json'), f.missing[2].bytes)
    const result = run(f)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ORIGINAL_ROOT_PRESENT/)
    assert.equal(existsSync(f.recovery), false)
  } finally { f.cleanup() }
})

test('受控证据marker紧凑JSON SHA不匹配历史root时停止', () => {
  const f = fixture()
  try {
    rmSync(f.evidences[4])
    json(f.evidences[4], { fixtureDirectory: f.missing[4].row.path,
      marker: { ...f.missing[4].marker, index: 400 } })
    const result = run(f)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /MARKER_EVIDENCE_MISMATCH/)
    assert.equal(existsSync(f.recovery), false)
  } finally { f.cleanup() }
})

test('显式recovery终态目录预存在时独占拒绝', () => {
  const f = fixture()
  try {
    mkdirSync(f.recovery)
    const result = run(f)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /RECOVERY_DIRECTORY_EXISTS/)
  } finally { f.cleanup() }
})

test('候选仓库必须同时clean且当前HEAD已推送到upstream', async t => {
  await t.test('dirty仓库拒绝', () => {
    const f = fixture()
    try {
      writeFileSync(join(f.repo, 'untracked.txt'), 'dirty\n')
      const result = run(f)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /REPOSITORY_IDENTITY/)
    } finally { f.cleanup() }
  })
  await t.test('仅本地commit拒绝', () => {
    const f = fixture()
    try {
      writeFileSync(join(f.repo, 'local-only.txt'), 'not pushed\n')
      git(f.repo, 'add', 'local-only.txt')
      git(f.repo, 'commit', '-m', 'local only')
      const localHead = git(f.repo, 'rev-parse', 'HEAD')
      const result = run(f, replaceOption(f.args, '--expected-head', localHead))
      assert.equal(result.status, 1)
      assert.match(result.stderr, /REPOSITORY_IDENTITY/)
    } finally { f.cleanup() }
  })
})

test('已持久化且身份匹配的pending中断可恢复并原子发布', () => {
  const f = fixture()
  try {
    const interrupted = run(f, f.args, { MUSICBRIDGE_TEST_STOP_AFTER_REPLACEMENTS: '3' })
    assert.equal(interrupted.status, 75, interrupted.stderr)
    assert.equal(existsSync(f.pending), true)
    assert.equal(existsSync(f.recovery), false)
    const pendingRemap = JSON.parse(readFileSync(join(f.pending, 'pending.json'))).liveDeviceRemap
    assert.deepEqual(pendingRemap, {
      mode: 'UNCHANGED', historicalDevice: statSync(f.runtime).dev,
      currentDevice: statSync(f.runtime).dev, liveRootCount: 63,
    })
    const resumed = run(f)
    assert.equal(resumed.status, 0, resumed.stderr)
    assert.equal(existsSync(f.pending), false)
    assert.equal(existsSync(join(f.recovery, 'recovery.json')), true)
    const finalRemap = JSON.parse(readFileSync(join(f.recovery, 'recovery.json'))).liveDeviceRemap
    assert.deepEqual(finalRemap, pendingRemap)
  } finally { f.cleanup() }
})

test('pending后观测到currentDevice漂移时恢复必须fail closed', () => {
  const f = fixture()
  try {
    const interrupted = run(f, f.args, { MUSICBRIDGE_TEST_STOP_AFTER_REPLACEMENTS: '1' })
    assert.equal(interrupted.status, 75, interrupted.stderr)
    assert.equal(existsSync(f.pending), true)
    const pendingRemap = JSON.parse(readFileSync(join(f.pending, 'pending.json'))).liveDeviceRemap
    assert.deepEqual(Object.keys(pendingRemap).sort(), [
      'currentDevice', 'historicalDevice', 'liveRootCount', 'mode',
    ])
    const resumed = runMonkeypatched(f, `
original=module.validate_manifest
def drift(*args, **kwargs):
  path, identity, missing, remap, root_remap = original(*args, **kwargs)
  changed = dict(remap)
  changed['currentDevice'] += 1
  changed['mode'] = ('UNCHANGED' if changed['historicalDevice'] == changed['currentDevice'] else 'REMAPPED')
  return path, identity, missing, changed, root_remap
module.validate_manifest=drift`)
    assert.equal(resumed.status, 1)
    assert.match(resumed.stderr, /PENDING_INVALID/u)
    assert.equal(existsSync(f.pending), true)
    assert.equal(existsSync(f.recovery), false)
  } finally { f.cleanup() }
})

test('pending中若有人把旧fixture marker复制成replacement，恢复必须fail closed', () => {
  const f = fixture()
  try {
    const interrupted = run(f, f.args, { MUSICBRIDGE_TEST_STOP_AFTER_REPLACEMENTS: '1' })
    assert.equal(interrupted.status, 75, interrupted.stderr)
    const marker = join(f.pending, 'replacement-001', 'owner.json')
    rmSync(marker)
    writeFileSync(marker, f.missing[0].bytes, { mode: 0o400 })
    const resumed = run(f)
    assert.equal(resumed.status, 1)
    assert.match(resumed.stderr, /PENDING_INVALID/)
    assert.equal(existsSync(f.recovery), false)
  } finally { f.cleanup() }
})

test('live marker读取完成时目录被换包，即使调用返回后复原也必须拒绝', () => {
  const f = fixture()
  try {
    const target = f.present[0].path
    const marker = join(target, 'owner.json')
    const backup = `${target}.scan-swap`
    const result = runMonkeypatched(f, `
target=${JSON.stringify(target)}
marker=${JSON.stringify(marker)}
backup=${JSON.stringify(backup)}
marker_identity=module.os.stat(marker)
state={'swapped': False}
original_read=module.os.read
original_validate=module.validate_present_root
def read_and_swap(descriptor, size):
  data=original_read(descriptor, size)
  opened=module.os.fstat(descriptor)
  if not data and not state['swapped'] and opened.st_dev == marker_identity.st_dev and opened.st_ino == marker_identity.st_ino:
    module.os.rename(target, backup)
    module.os.symlink(backup, target)
    state['swapped']=True
  return data
def validate_and_restore(row):
  try:
    return original_validate(row)
  finally:
    if state['swapped']:
      module.os.unlink(target)
      module.os.rename(backup, target)
      state['swapped']=False
module.os.read=read_and_swap
module.validate_present_root=validate_and_restore`)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /MEASURE_OWNED_MANIFEST/u)
    assert.equal(existsSync(f.recovery), false)
  } finally { f.cleanup() }
})

test('发布窗口内final并发出现时no-replace发布必须fail closed并保留原pending', () => {
  const f = fixture()
  try {
    const result = runMonkeypatched(f, `
original=module._rename_noreplace
def collide(runtime_fd, pending_name, final_name):
  module.os.mkdir(final_name, mode=0o700, dir_fd=runtime_fd)
  return original(runtime_fd, pending_name, final_name)
module._rename_noreplace=collide`)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /PUBLISH_FAILED/u)
    assert.equal(existsSync(f.pending), true)
  } finally { f.cleanup() }
})

test('rename调用点替换live目录inode时发布锁内最终扫描必须拒绝', () => {
  const f = fixture()
  try {
    const target = f.present[1].path
    const displaced = `${target}.publish-swap`
    const result = runMonkeypatched(f, `
original=module._rename_noreplace
def swap_live_inode(runtime_fd, pending_name, final_name):
  module.os.rename(${JSON.stringify(target)}, ${JSON.stringify(displaced)})
  module.os.mkdir(${JSON.stringify(target)}, mode=0o700)
  module.os.rename(${JSON.stringify(displaced + '/owner.json')}, ${JSON.stringify(target + '/owner.json')})
  return original(runtime_fd, pending_name, final_name)
module._rename_noreplace=swap_live_inode`)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /MEASURE_OWNED_MANIFEST|PUBLISH_IDENTITY/u)
  } finally { f.cleanup() }
})

test('rename调用点旧根重现或pending inode被换包时发布后重验必须fail closed', async t => {
  await t.test('旧根在rename调用点重现', () => {
    const f = fixture()
    try {
      const oldRoot = f.missing[0].row.path
      const result = runMonkeypatched(f, `
original=module._rename_noreplace
def reappear(runtime_fd, pending_name, final_name):
  module.os.mkdir(${JSON.stringify(oldRoot)}, mode=0o700)
  return original(runtime_fd, pending_name, final_name)
module._rename_noreplace=reappear`)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /ORIGINAL_ROOT_PRESENT/u)
    } finally { f.cleanup() }
  })
  await t.test('pending名称在rename调用点换成另一inode', () => {
    const f = fixture()
    try {
      const result = runMonkeypatched(f, `
original=module._rename_noreplace
def swap(runtime_fd, pending_name, final_name):
  module.os.rename(pending_name, pending_name + '.original', src_dir_fd=runtime_fd, dst_dir_fd=runtime_fd)
  module.os.mkdir(pending_name, mode=0o700, dir_fd=runtime_fd)
  return original(runtime_fd, pending_name, final_name)
module._rename_noreplace=swap`)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /PUBLISH_IDENTITY/u)
    } finally { f.cleanup() }
  })
})
