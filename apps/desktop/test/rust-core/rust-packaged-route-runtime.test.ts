import assert from 'node:assert/strict'
import test from 'node:test'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { validateRustPackagedRouteRunOptions, runRustPackagedRouteCandidate } from '../../scripts/rust-packaged-route-runtime.mjs'

test('直接候选运行在文件查询前拒绝外置JS、真实profile与新增路由参数', async () => {
  const base = { executable: '/Volumes/LifeWeave/Synthetic.app/Contents/MacOS/Synthetic', expectedExecutableSha256: 'a'.repeat(64), evidenceDirectory: '/Volumes/LifeWeave/Developer/CommandLine/tmp/rust012-helper-test', kind: 'node-diagnostic' as const }
  for (const options of [{ ...base, executable: '/Users/yihe/real.js' }, { ...base, evidenceDirectory: '/Users/yihe/Library/Application Support/MusicBridge' }, { ...base, kind: 'external-node' }, { ...base, args: ['--inspect'] }, { ...base, binary: '/tmp/fake' }]) await assert.rejects(validateRustPackagedRouteRunOptions(options as never))
})

test('实际包运行helper直接固定exe与mockkeychain，隔离profile并保留分块中文收据', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rust012-runtime-behavior-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = path.join(directory, 'Synthetic.app', 'Contents', 'MacOS', 'Synthetic'), bytes = Buffer.from('仅受控文件身份fixture，不执行')
  await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, bytes, { mode: 0o700 })
  const child = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough()
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    setImmediate(() => {
      const evidence = Buffer.from('RUST012_EVIDENCE ' + JSON.stringify({ schemaVersion: 1, actor: 'main', sequence: 1, elapsedMs: 0, pid: 4567, event: 'main.fixture', data: { text: '合成' } }) + '\n')
      const at = evidence.indexOf(Buffer.from('合')) + 1
      stdout.write(evidence.subarray(0, at)); stdout.write(evidence.subarray(at)); stderr.write('仅计摘要')
      stderr.write('DESKTOP_START'); stderr.write('UP_FAIL\n')
      child.emit('close', 0, null)
    })
    return Object.assign(child, { pid: 4567, stdout, stderr, kill() { throw new Error('受控正常关闭不应kill') } }) as never
  })
  const receipt = await runRustPackagedRouteCandidate({ executable, expectedExecutableSha256: createHash('sha256').update(bytes).digest('hex'), evidenceDirectory: path.join(directory, 'evidence'), kind: 'rust-diagnostic' })
  assert.equal(receipt.completion, 'closed'); assert.equal(receipt.forceKilled, false); assert.equal(receipt.events[0]!.data.text, '合成')
  assert.equal(receipt.startupFailed, true, '原Main将固定bootstrap失败标记写到stderr，采集必须涵盖分块stderr。')
  const [actualExecutable, args, options] = spawn.mock.calls[0]!.arguments as unknown as [string, string[], { env: Record<string, string> }]
  assert.equal(actualExecutable, executable); assert.deepEqual(args, ['--use-mock-keychain'])
  assert.equal(options.env.MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR, receipt.profileDirectory)
  assert.ok(receipt.profileDirectory.startsWith(receipt.tmpDirectory + '/'))
  for (const key of ['NODE_OPTIONS', 'NETEASE_COOKIE', 'MUSIC_BRIDGE_RUST_BINARY', 'MUSIC_BRIDGE_RUST_PIN']) assert.equal(options.env[key], undefined)
  assert.equal('pass' in receipt, false)
})
