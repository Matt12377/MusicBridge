import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { runRustPackagedRendererCandidate, validateRustPackagedRendererRunOptions } from '../../scripts/rust-packaged-renderer-runtime.mjs'

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function fixture(t: any) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rust013-runtime-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = path.join(directory, 'Synthetic.app', 'Contents', 'MacOS', 'Synthetic'), bytes = Buffer.from('受控文件身份fixture，不执行app')
  await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, bytes, { mode: 0o700 })
  return { directory, executable, expectedExecutableSha256: sha(bytes) }
}

test('闭集运行参数在任何真实路径查询前拒绝任意入口、环境和launch选择器', async () => {
  const options = { executable: '/Volumes/LifeWeave/Developer/CommandLine/tmp/Synthetic.app/Contents/MacOS/Synthetic', expectedExecutableSha256: 'a'.repeat(64), evidenceDirectory: '/Volumes/LifeWeave/Developer/CommandLine/tmp/rust013-invalid-fixture', kind: 'rust-renderer', launch: { type: 'fresh' } }
  for (const value of [{ ...options, executable: '/Applications/Real.app/Contents/MacOS/Real' }, { ...options, evidenceDirectory: '/Users/yihe/Library/Application Support/MusicBridge' }, { ...options, args: ['--inspect'] }, { ...options, env: { NODE_OPTIONS: '--inspect' } }, { ...options, launch: { type: 'fresh', route: 'node' } }, { ...options, kind: 'default-node', launch: { type: 'cold', priorReceiptPath: options.evidenceDirectory + '/receipt.json', priorReceiptSha256: 'a'.repeat(64) } }]) await assert.rejects(validateRustPackagedRendererRunOptions(value as never))
  await assert.rejects(validateRustPackagedRendererRunOptions({ ...options, get launch() { throw new Error('不应读取getter') } } as never))
})

test('受控child实际采集：直接exe、固定argv、分块UTF8、安全原始事件且绝不自行判PASS', async t => {
  const identity = await fixture(t), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    setImmediate(() => {
      const line = Buffer.from('RUST013_EVIDENCE ' + JSON.stringify({ schemaVersion: 1, actor: 'main', sequence: 1, elapsedMs: 0, pid: 1234, event: 'main.probeFailed', data: { code: 'PROBE_FAILED' } }) + '\n')
      stdout.write(line.subarray(0, 25)); stdout.write(line.subarray(25)); stdout.write('私有非证据输出不落盘\n')
      stdout.write('RUST013_EVIDENCE ' + JSON.stringify({ schemaVersion: 1, actor: 'main', sequence: 2, elapsedMs: 1, pid: 1234, event: 'private.credentials', data: { token: '不得落盘' } }) + '\n')
      stderr.write('DESKTOP_START'); stderr.write('UP_FAIL\n仅计摘要')
      child.emit('close', 0, null)
    })
    return Object.assign(child, { pid: 1234, stdout, stderr, kill() { assert.fail('受控正常关闭不应kill') } }) as never
  })
  const receipt = await runRustPackagedRendererCandidate({ executable: identity.executable, expectedExecutableSha256: identity.expectedExecutableSha256, evidenceDirectory: path.join(identity.directory, 'fresh-evidence'), kind: 'rust-renderer', launch: { type: 'fresh' } })
  assert.equal(receipt.completion, 'closed'); assert.equal(receipt.startupFailed, true)
  assert.equal(receipt.events.length, 1); assert.equal(receipt.parseErrors, 1); assert.equal('pass' in receipt, false)
  const raw = await readFile(receipt.rawEvidence.path)
  assert.equal(sha(raw), receipt.rawEvidence.sha256); assert.doesNotMatch(raw.toString(), /私有非证据|仅计摘要|不得落盘/u)
  const [actualExecutable, argv, options] = spawn.mock.calls[0]!.arguments as unknown as [string, string[], { env: Record<string, string> }]
  assert.equal(actualExecutable, identity.executable); assert.deepEqual(argv, ['--use-mock-keychain'])
  assert.equal(options.env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR, receipt.profileDirectory)
  for (const key of ['NODE_OPTIONS', 'MUSIC_BRIDGE_RUST_BINARY', 'MUSIC_BRIDGE_RUST_PIN', 'MUSIC_BRIDGE_LAUNCH', 'NETEASE_COOKIE']) assert.equal(options.env[key], undefined)
})

for (const kind of ['node-renderer', 'rust-renderer'] as const) test(`${kind} fresh自然收据才能同profile冷启：保存TMP祖先、nonce并拒绝未闭合与并发`, async t => {
  const identity = await fixture(t)
  let calls = 0
  const spawn = t.mock.method(childProcess, 'spawn', (_executable: any, _argv: any, options: any) => {
    const child = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough(), call = ++calls
    setImmediate(async () => {
      const profile = options.env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR, marker = JSON.parse((await readFile(path.join(profile, 'rust013-profile.json'))).toString())
      const completed = { schemaVersion: 1, kind: 'rust013-completed-profile', nonce: marker.nonce, fixtureSha256: 'b'.repeat(64), datasetId: randomUUID(), commandIds: Array.from({ length: 27 }, () => randomUUID()), outboxIds: Array.from({ length: 27 }, () => randomUUID()), models: Array.from({ length: 26 }, (_, index) => ({ id: String(index) })), policyModelId: randomUUID(), policyRevision: 2 }
      if (call === 1) await writeFile(path.join(profile, 'rust013-completed.json'), JSON.stringify(completed) + '\n', { flag: 'wx', mode: 0o600 })
      const completedSha = sha(await readFile(path.join(profile, 'rust013-completed.json')))
      const events = [
        ['main.rendererProbeComplete', { phase: call === 1 ? 'fresh' : 'cold', fixtureCount: 26, fixtureSha256: 'b'.repeat(64), commandIds: completed.commandIds, modelIds: completed.models.map(model => model.id), policyModelId: completed.policyModelId, policyRevision: 2, nonce: marker.nonce, completedMarkerSha256: completedSha }],
        ['main.lifecycle', { event: 'outbox-close-end', actionId: null }], ['main.lifecycle', { event: 'will-quit', actionId: null }],
        ['node.closeCompleted', {}], ['node.exit', { threadId: 1, code: 0 }], ['main.coreExit', { pid: 2346, code: 0 }],
      ]
      if (kind === 'rust-renderer') for (let index = 0; index < (call === 1 ? 3 : 1); index++) {
        events.push(['rust.spawn', { pid: 3000 + index, binary: { path: identity.executable, sha256: identity.expectedExecutableSha256 } }], ['rust.exit', { pid: 3000 + index, code: 0, signal: null, closeAcknowledged: true, pendingRequests: 0 }])
      }
      events.forEach(([event, data], index) => stdout.write('RUST013_EVIDENCE ' + JSON.stringify({ schemaVersion: 1, actor: /^(?:node|rust)\./u.test(event.toString()) ? 'core' : 'main', sequence: index + 1, elapsedMs: index, pid: 2345, event, data }) + '\n'))
      child.emit('close', 0, null)
    })
    return Object.assign(child, { pid: 2345, stdout, stderr, kill() { assert.fail('受控正常关闭不应kill') } }) as never
  })
  const freshDirectory = path.join(identity.directory, 'fresh'), first = await runRustPackagedRendererCandidate({ executable: identity.executable, expectedExecutableSha256: identity.expectedExecutableSha256, evidenceDirectory: freshDirectory, kind, launch: { type: 'fresh' } })
  const priorReceiptPath = path.join(freshDirectory, 'runtime-evidence.json'), priorReceiptSha256 = sha(await readFile(priorReceiptPath))
  const coldOptions = { executable: identity.executable, expectedExecutableSha256: identity.expectedExecutableSha256, evidenceDirectory: path.join(identity.directory, 'cold'), kind, launch: { type: 'cold' as const, priorReceiptPath, priorReceiptSha256 } }
  await writeFile(path.join(first.profileDirectory, 'rust013-runtime.lock'), '受控正在运行', { flag: 'wx', mode: 0o600 })
  await assert.rejects(runRustPackagedRendererCandidate(coldOptions), { code: 'EEXIST' }); assert.equal(calls, 1)
  await rm(path.join(first.profileDirectory, 'rust013-runtime.lock'))
  const second = await runRustPackagedRendererCandidate(coldOptions)
  assert.equal(second.profileDirectory, first.profileDirectory); assert.equal(second.tmpDirectory, first.tmpDirectory); assert.equal(second.nonce, first.nonce)
  assert.notEqual(second.launchId, first.launchId); assert.equal(calls, 2)
  const coldSpawn = spawn.mock.calls[1]!.arguments as unknown as [string, string[], { env: Record<string, string> }]
  assert.equal(coldSpawn[2].env.TMPDIR, first.tmpDirectory); assert.equal(coldSpawn[2].env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR, first.profileDirectory)
  const altered = { ...first, forceKilled: true }, alteredPath = path.join(identity.directory, 'altered-prior.json')
  await writeFile(alteredPath, JSON.stringify(altered), { mode: 0o600 })
  await assert.rejects(runRustPackagedRendererCandidate({ ...coldOptions, evidenceDirectory: path.join(identity.directory, 'reject'), launch: { type: 'cold', priorReceiptPath: alteredPath, priorReceiptSha256: sha(await readFile(alteredPath)) } }))
  if (kind === 'rust-renderer') {
    const oneExit = { ...first, events: first.events.filter(value => value.event !== 'rust.exit' || value.data.pid === 3000) }, onePath = path.join(identity.directory, 'one-exit-prior.json')
    await writeFile(onePath, JSON.stringify(oneExit), { mode: 0o600 })
    await assert.rejects(runRustPackagedRendererCandidate({ ...coldOptions, evidenceDirectory: path.join(identity.directory, 'reject-one'), launch: { type: 'cold', priorReceiptPath: onePath, priorReceiptSha256: sha(await readFile(onePath)) } }))
  }
  assert.equal(calls, 2)
})

test('符号链接证据目录不能在范围外落盘', async t => {
  const identity = await fixture(t), target = path.join(identity.directory, 'target')
  await mkdir(target, { mode: 0o700 }); const alias = path.join(identity.directory, 'alias'); await symlink(target, alias)
  await assert.rejects(validateRustPackagedRendererRunOptions({ executable: identity.executable, expectedExecutableSha256: identity.expectedExecutableSha256, evidenceDirectory: path.join(alias, 'evidence'), kind: 'node-renderer', launch: { type: 'fresh' } }))
})
