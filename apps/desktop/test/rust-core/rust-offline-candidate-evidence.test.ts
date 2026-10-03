import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptRustOfflineCandidateEvidence } from '../helpers/rust-offline-candidate-evidence.js'

for (const [name, value] of [['空值', null], ['缺少报告', undefined], ['数组', []], ['空报告', {}],
  ['自报Owner接受', { ownerAcceptance: 'ACCEPTED' }], ['未知字段', { schemaVersion: 1, injected: true }]] as const) {
  test(`证据拒绝${name}，不能接受没有实际资源与退出身份的收据`, () => {
    assert.throws(() => acceptRustOfflineCandidateEvidence(value, {}), /候选证据未准入/u)
  })
}

test('证据拒绝访问器与Proxy，不执行其代码', () => {
  let calls = 0
  const getter = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { calls++; return 1 } })
  assert.throws(() => acceptRustOfflineCandidateEvidence(getter, {}), /候选证据未准入/u)
  assert.throws(() => acceptRustOfflineCandidateEvidence(new Proxy({}, { ownKeys() { calls++; return [] } }), {}), /候选证据未准入/u)
  assert.equal(calls, 0)
})

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

const stage = '/Volumes/LifeWeave/Developer/CommandLine/tmp/mb-rust-core-011-3samm9m1'
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
async function actualInput() {
  const reportPath = process.env.MUSIC_BRIDGE_RUST_OFFLINE_CANDIDATE_REPORT
  const expectedPath = process.env.MUSIC_BRIDGE_RUST_OFFLINE_CANDIDATE_EXPECTED_IDENTITY
  assert.ok(reportPath && expectedPath && reportPath.startsWith(stage + '/') && expectedPath.startsWith(stage + '/'),
    '实际候选收据测试必须显式提供本期最终report和独立expected；缺输入失败，不用Fake或skip。')
  return { report: JSON.parse(await readFile(reportPath, 'utf8')), expected: JSON.parse(await readFile(expectedPath, 'utf8')) }
}

test('实际最终候选报告与独立最终身份严格准入，保留资源层和Owner边界', async () => {
  const { report, expected } = await actualInput()
  assert.deepEqual(acceptRustOfflineCandidateEvidence(report, expected), { state: 'PASS', task: 'RUST-011', packagedRustMainCoreRoute: 'NOT_IN_SCOPE', ownerAcceptance: 'NOT_RUN' })
})

const mutations: Array<[string, (report: any, expected: any) => void]> = [
  ['报告多字段', report => { report.injected = true }], ['错任务', report => { report.task = 'RUST-010' }],
  ['错源commit', report => { report.sourceCommit = '1'.repeat(40) }], ['错源SHA', report => { report.sourceSha256 = '1'.repeat(64) }],
  ['Owner伪成功', report => { report.ownerAcceptance = 'ACCEPTED' }], ['MainRust伪通过', report => { report.packagedRustMainCoreRoute = 'PASS' }],
  ['生产默认Rust', report => { report.productionDefault = 'Rust' }], ['真实服务伪通过', report => { report.realServices = 'PASS' }],
  ['安装伪通过', report => { report.installation = 'PASS' }], ['隐式下载', report => { report.implicitDownload = true }],
  ['独立expected缺签名', (_report, expected) => { delete expected.verification }],
  ['独立expected错误pin', (_report, expected) => { expected.candidateIdentity.manifestSha256 = '1'.repeat(64) }],
  ['包外binary', report => { report.candidateIdentity.native.binaryPath = '/Users/yihe/真实用户资料' }],
  ['签名CDHash漂移', report => { report.verification.nativeSignature.cdHash = '1'.repeat(40) }],
  ['最终bundle未verify', report => { report.verification.bundleSignature.verified = false }],
  ['DeveloperID代替adhoc', report => { report.verification.bundleSignature.adHoc = false }],
  ['架构错误', report => { report.verification.arch = 'x64' }], ['ASAR入口Rustwrapper', report => { report.candidateIdentity.asar.main = '外部wrapper.mjs' }],
  ['ASAR SHA漂移', report => { report.candidateIdentity.asar.sha256 = '1'.repeat(64) }], ['ASAR header漂移', report => { report.verification.asarIntegrity.hash = '1'.repeat(64) }],
  ['inspect打开', report => { report.candidateIdentity.fuses['3'] = 49 }], ['onlyASAR关闭', report => { report.candidateIdentity.fuses['5'] = 48 }],
  ['integrity关闭', report => { report.candidateIdentity.fuses['4'] = 48 }], ['Fuse version错误类型', report => { report.candidateIdentity.fuses.version = 1 }],
  ['协议manifest漂移', report => { report.protocol.manifestSha256 = '1'.repeat(64) }], ['协议binary漂移', report => { report.protocol.binary.sha256 = '1'.repeat(64) }],
  ['协议文件SHA漂移', report => { report.protocol.evidence.sha256 = '1'.repeat(64) }], ['协议真实用户路径', report => { report.protocol.evidence.path = '/Users/yihe/真实用户资料' }],
  ['default外置JS参数', report => { report.defaultNode.args.push('/任意wrapper.mjs') }], ['default inspect参数', report => { report.defaultNode.args.push('--inspect=0') }],
  ['default系统钥匙串', report => { report.defaultNode.keychain = 'system' }], ['default非合成环境', report => { report.defaultNode.flags.offline = false }],
  ['default无ready', report => { report.defaultNode.ready = false }], ['default被信号杀', report => { report.defaultNode.exit.signal = 'SIGTERM' }],
  ['default非零退出', report => { report.defaultNode.exit.code = 1 }], ['default强制清理', report => { report.defaultNode.forcedCleanup = true }],
  ['default日志SHA漂移', report => { report.defaultNode.log.sha256 = '1'.repeat(64) }], ['default原始观察缺失', report => { delete report.defaultNode.observation }],
  ['default raw SHA漂移', report => { report.defaultNode.observation.sha256 = '1'.repeat(64) }], ['default用户profile', report => { report.defaultNode.profileDirectory = '/Users/yihe/真实用户库' }],
]
for (const [name, change] of mutations) test(`实际候选收据拒绝：${name}`, async () => {
  const { report, expected } = await actualInput(); change(report, expected)
  assert.throws(() => acceptRustOfflineCandidateEvidence(report, expected), /候选证据未准入/u)
})

// 仅复制C独占证据，重算变异文件SHA以进入具体行为校验；原最终产物与收据不改。
async function changedProtocol(report: any, change: (protocol: any) => void) {
  const directory = await mkdtemp(path.join(stage, 'c-protocol-rejection-'))
  await mkdir(path.join(directory, 'synthetic-data'), { mode: 0o700 })
  for (const item of report.protocol.closedDatabases) if (item.exists) {
    await copyFile(path.join(report.protocol.evidenceDirectory, 'synthetic-data', item.name), path.join(directory, 'synthetic-data', item.name), constants.COPYFILE_EXCL)
  }
  report.protocol.evidenceDirectory = directory; change(report.protocol)
  const { evidence: _old, ...persisted } = report.protocol
  const file = path.join(directory, 'protocol-report.json'), bytes = JSON.stringify(persisted, null, 2) + '\n'
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); report.protocol.evidence = { path: file, sha256: sha(bytes) }
}
const protocolMutations: Array<[string, (protocol: any) => void]> = [
  ['Node close ACK缺失', protocol => { protocol.nodeSessions[1].acknowledgements.pop() }],
  ['初始化Node不同dataset', protocol => { protocol.nodeSessions[0].identity.datasetId = '00000000-0000-4000-8000-000000000001' }],
  ['Node退出非零', protocol => { protocol.nodeSessions[1].exitCode = 1 }], ['Node不同scope', protocol => { protocol.nodeSessions[1].identity.epoch = '00000000-0000-4000-8000-000000000001' }],
  ['两库WAL变化', protocol => { protocol.databasesAfter[1].size++ }], ['缺closed数据库', protocol => { protocol.closedDatabases.pop() }],
  ['Rust wire错误v1', protocol => { protocol.rust.requests[0].protocolVersion = 1; protocol.rust.acknowledgements[0].protocolVersion = 1 }],
  ['Rust缺prepare ACK', protocol => { protocol.rust.acknowledgements.shift() }], ['Rust缺close ACK', protocol => { protocol.rust.acknowledgements.pop() }],
  ['Rust prepare能力变写入', protocol => { protocol.rust.acknowledgements[0].result.readOnly = false }],
  ['Rust prepare额外字段', protocol => { protocol.rust.acknowledgements[0].result.injected = true }],
  ['Rust wire额外字段', protocol => { protocol.rust.requests[0].injected = true }], ['Rust重复sequence', protocol => { protocol.rust.acknowledgements[2].sequence = 1 }],
  ['Rust dispatch请求漂移', protocol => { protocol.rust.requests[2].payload.request.payload.page.offset = 1 }],
  ['Rust dispatch filterProjection漂移', protocol => { protocol.rust.requests[2].payload.filterProjection.query = '错误' }],
  ['Rust close无效payload', protocol => { protocol.rust.requests.at(-1).payload.injected = true }],
  ['完整DTO元数据漂移', protocol => { protocol.comparisons[0].actual.items[0].edition = '错误' }],
  ['参照和结果共同伪造', protocol => { protocol.comparisons[0].expected.total = 99; protocol.comparisons[0].actual.total = 99 }],
  ['Rust退出非零', protocol => { protocol.rust.exit.code = 1 }], ['Rust被信号杀', protocol => { protocol.rust.exit.signal = 'SIGKILL' }],
  ['Rust调用kill', protocol => { protocol.rust.killCalls = 1 }], ['Rust写拒绝缺失', protocol => { protocol.writeRejection.code = 'SUCCESS' }],
  ['Rust强制清理', protocol => { protocol.forcedCleanup = true }],
]
for (const [name, change] of protocolMutations) test(`实际协议独立校验拒绝：${name}`, async () => {
  const { report, expected } = await actualInput(); await changedProtocol(report, change)
  assert.throws(() => acceptRustOfflineCandidateEvidence(report, expected), /候选证据未准入/u)
})

const observationMutations: Array<[string, (raw: any) => void]> = [
  ['raw启动error', raw => { raw.spawnError = '受控错误' }], ['raw观察失败', raw => { raw.observationError = '受控错误' }],
  ['raw缺closed', raw => { raw.electronExit.closed = false }], ['raw复用profile', raw => { raw.profileWasFresh = false }],
  ['raw真实账号env', raw => { raw.environmentKeys.push('NETEASE_COOKIE') }], ['raw多ready', raw => { raw.readyMarkerCount = 2 }],
  ['raw有fail', raw => { raw.failureMarkerCount = 1 }], ['raw发现Rust子进程', raw => { raw.observedRustChildCount = 1 }],
  ['raw Owner退出冒称观察', raw => { raw.ownerWorkerExit = 'OBSERVED_0' }], ['raw argv外置wrapper', raw => { raw.argv.push('wrapper.mjs') }],
]
for (const [name, change] of observationMutations) test(`实际默认Node原始观察拒绝：${name}`, async () => {
  const { report, expected } = await actualInput(), raw = JSON.parse(await readFile(report.defaultNode.observation.path, 'utf8'))
  const directory = await mkdtemp(path.join(stage, 'c-observation-rejection-')); change(raw)
  const file = path.join(directory, 'packaged-default-node.json'), bytes = JSON.stringify(raw) + '\n'
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); report.defaultNode.observation = { path: file, sha256: sha(bytes) }
  assert.throws(() => acceptRustOfflineCandidateEvidence(report, expected), /候选证据未准入/u)
})

const lifecycleMutations: Array<[string, (lifecycle: any[]) => void]> = [
  ['缺第二beforequit', lifecycle => { lifecycle.splice(lifecycle.findLastIndex(item => item.phase === 'before-quit'), 1) }],
  ['额外beforequit', lifecycle => { lifecycle.splice(lifecycle.length - 1, 0, { phase: 'before-quit', elapsedMs: lifecycle.at(-2).elapsedMs }) }],
  ['第二beforequit早于重新退出', lifecycle => {
    const second = lifecycle.splice(lifecycle.findLastIndex(item => item.phase === 'before-quit'), 1)[0]
    const at = lifecycle.findIndex(item => item.phase === 'app-quit-reissued')
    second.elapsedMs = lifecycle[at - 1].elapsedMs; lifecycle.splice(at, 0, second)
  }],
]
for (const [name, change] of lifecycleMutations) test(`实际原Main关闭偏序拒绝：${name}`, async () => {
  const { report, expected } = await actualInput()
  const raw = JSON.parse(await readFile(report.defaultNode.observation.path, 'utf8'))
  const original = await readFile(report.defaultNode.log.path, 'utf8')
  const directory = await mkdtemp(path.join(stage, 'c-lifecycle-rejection-'))
  change(report.defaultNode.lifecycle); raw.lifecycle = report.defaultNode.lifecycle
  const lines = original.split(/\r?\n/u).filter(line => !line.startsWith('TASK078_LIFECYCLE '))
  const logBytes = lines.join('\n') + report.defaultNode.lifecycle.map((item: any) => 'TASK078_LIFECYCLE ' + JSON.stringify(item) + '\n').join('')
  const logPath = path.join(directory, 'packaged-default-node.log')
  await writeFile(logPath, logBytes, { flag: 'wx', mode: 0o600 })
  report.defaultNode.log = { path: logPath, sha256: sha(logBytes) }; raw.log = report.defaultNode.log
  const rawPath = path.join(directory, 'packaged-default-node.json'), rawBytes = JSON.stringify(raw) + '\n'
  await writeFile(rawPath, rawBytes, { flag: 'wx', mode: 0o600 })
  report.defaultNode.observation = { path: rawPath, sha256: sha(rawBytes) }
  assert.throws(() => acceptRustOfflineCandidateEvidence(report, expected), /候选证据未准入/u)
})
