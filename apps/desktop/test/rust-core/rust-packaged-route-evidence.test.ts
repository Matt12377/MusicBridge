import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptRustPackagedRouteEvidence } from '../helpers/rust-packaged-route-evidence.js'

for (const [name, value] of [['空值', null], ['数组', []], ['空报告', {}], ['旧任务', { task: 'RUST-011' }],
  ['外部协议', { kind: 'external-node-to-packaged-rust-protocol' }], ['Owner伪成功', { ownerAcceptance: 'ACCEPTED' }]] as const) {
  test(`基础拒绝：${name}`, () => assert.throws(() => acceptRustPackagedRouteEvidence(value, {}), /包内路由证据未准入/u))
}
test('基础拒绝：getter和Proxy不执行其代码', () => {
  let calls = 0
  const getter = Object.defineProperty({}, 'task', { enumerable: true, get() { calls++; return 'RUST-012' } })
  assert.throws(() => acceptRustPackagedRouteEvidence(getter, {}), /包内路由证据未准入/u)
  assert.throws(() => acceptRustPackagedRouteEvidence(new Proxy({}, { ownKeys() { calls++; return [] } }), {}), /包内路由证据未准入/u)
  assert.equal(calls, 0)
})

import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises'
import path from 'node:path'

const external = '/Volumes/LifeWeave/Developer/CommandLine/tmp'
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
async function actualInput() {
  const reportFile = process.env.MUSIC_BRIDGE_RUST_PACKAGED_ROUTE_REPORT
  const expectedFile = process.env.MUSIC_BRIDGE_RUST_PACKAGED_ROUTE_EXPECTED_IDENTITY
  assert.ok(reportFile && expectedFile && reportFile.startsWith(external + '/') && expectedFile.startsWith(external + '/')
    && path.resolve(reportFile) === reportFile && path.resolve(expectedFile) === expectedFile,
  '需要本期实际四包报告与独立expected绝对路径；缺输入失败，不skip或伪造实际通过。')
  return { report: JSON.parse(await readFile(reportFile, 'utf8')), expected: JSON.parse(await readFile(expectedFile, 'utf8')) }
}
test('实际四静态包完整证据准入，保留诊断与Owner边界', async () => {
  const { report, expected } = await actualInput()
  assert.deepEqual(acceptRustPackagedRouteEvidence(report, expected), { state: 'PASS', task: 'RUST-012', packagedReadonlyRoute: 'PASS', ownerAcceptance: 'NOT_RUN', rendererAcceptance: 'NOT_RUN' })
})
const topMutations: Array<[string, (report: any, expected: any) => void]> = [
  ['报告额外字段', report => { report.injected = true }], ['旧任务', report => { report.task = 'RUST-011' }],
  ['sourceCommit与独立expected不匹配', report => { report.sourceCommit = 'ed40e39c39db908200e946c0c13dcfc1ddc0a206' }], ['源码SHA漂移', report => { report.sourceSha256 = '1'.repeat(64) }],
  ['expected缺独立runs', (_report, expected) => { delete expected.runs }], ['expected runSHA漂移', (_report, expected) => { expected.runs['rust-diagnostic'].sha256 = '1'.repeat(64) }],
  ['少一个包', report => { delete report.packages['pin-rejected'] }], ['Owner伪通过', report => { report.ownerAcceptance = 'ACCEPTED' }],
  ['Renderer伪通过', report => { report.rendererAcceptance = 'PASS' }], ['生产默认Rust', report => { report.productionDefault = 'Rust' }],
  ['第二数据库作者', report => { report.soleDatabaseWriter = 'Rust' }], ['运行时mode', report => { report.candidateDiagnostics = 'ENV' }],
  ['runtime收据SHA漂移', report => { report.runs['rust-diagnostic'].evidence.sha256 = '1'.repeat(64) }],
  ['真实用户证据路径', report => { report.runs['rust-diagnostic'].evidence.path = '/Users/yihe/真实用户资料' }],
  ['包外binary', report => { report.packages['rust-diagnostic'].candidateIdentity.native.binaryPath = '/Users/yihe/真实用户资料' }],
  ['缺实际签名', report => { report.packages['rust-diagnostic'].verification.bundleSignature.verified = false }],
  ['Inspect打开', (report, expected) => { report.packages['rust-diagnostic'].candidateIdentity.fuses['3'] = 49; expected.packages['rust-diagnostic'].candidateIdentity.fuses['3'] = 49 }],
  ['关闭ASAR准入', (report, expected) => { report.packages['rust-diagnostic'].candidateIdentity.fuses['5'] = 48; expected.packages['rust-diagnostic'].candidateIdentity.fuses['5'] = 48 }],
  ['default运行时选Rust', (report, expected) => { report.packages['default-node'].compile.diagnostics = true; expected.packages['default-node'].compile.diagnostics = true }],
  ['Rust编译pin漂移', (report, expected) => { report.packages['rust-diagnostic'].compile.manifestPin = '1'.repeat(64); expected.packages['rust-diagnostic'].compile.manifestPin = '1'.repeat(64) }],
  ['负例变正确pin', (report, expected) => { for (const value of [report, expected]) value.packages['pin-rejected'].compile.manifestPin = value.packages['pin-rejected'].candidateIdentity.manifestSha256 }],
]
for (const [name, change] of topMutations) test(`实际身份拒绝：${name}`, async () => {
  const { report, expected } = await actualInput(); change(report, expected)
  assert.throws(() => acceptRustPackagedRouteEvidence(report, expected), /包内路由证据未准入/u)
})
function found(receipt: any, event: string, predicate: (entry: any) => boolean = () => true) {
  const value = receipt.events.find((entry: any) => entry.event === event && predicate(entry)); assert.ok(value, `真实收据缺事件${event}`); return value
}
function remove(receipt: any, event: string, predicate: (entry: any) => boolean = () => true) {
  const value = found(receipt, event, predicate); receipt.events.splice(receipt.events.indexOf(value), 1)
}
async function changedRuntime(report: any, expected: any, kind: string, change: (receipt: any) => void) {
  const receipt = report.runs[kind].receipt
  change(receipt)
  // 移除事件后重编actor序号；避免缺ACK负例仅被sequence断裂挡住。
  const counters = new Map<string, number>()
  for (const event of receipt.events) { const key = event.actor + ':' + event.pid, at = (counters.get(key) ?? 0) + 1; counters.set(key, at); event.sequence = at; event.elapsedMs = at }
  // 原始report位于本次candidate目录；拒绝副本仍独占其任务stage的author-c。
  const authorDirectory = path.join(path.dirname(path.dirname(process.env.MUSIC_BRIDGE_RUST_PACKAGED_ROUTE_REPORT!)), 'author-c')
  assert.ok(authorDirectory.startsWith(external + '/') && path.resolve(authorDirectory) === authorDirectory)
  await mkdir(authorDirectory, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(path.join(authorDirectory, 'raw-rejection-'))
  receipt.evidenceDirectory = directory
  receipt.tmpDirectory = await mkdtemp(path.join(directory, 'runtime-tmp-'))
  receipt.profileDirectory = await mkdtemp(path.join(receipt.tmpDirectory, kind === 'default-node' ? 'musicbridge-task036-startup-' : 'musicbridge-ui-diagnostics-'))
  const file = path.join(directory, 'runtime-evidence.json'), bytes = JSON.stringify(receipt, null, 2) + '\n'
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
  const evidence = { path: file, sha256: digest(bytes) }
  report.runs[kind].evidence = evidence; expected.runs[kind] = { ...evidence }
}
const rawMutations: Array<[string, string, (receipt: any) => void]> = [
  ['Rust Main非零退出', 'rust-diagnostic', receipt => { receipt.mainExit.code = 1 }],
  ['default缺ready', 'default-node', receipt => { receipt.startupReady = false }],
  ['default诊断事件', 'default-node', receipt => { receipt.events.push({ schemaVersion: 1, actor: 'main', sequence: 1, elapsedMs: 1, pid: receipt.mainPid, event: 'main.diagnosticsInstalled', data: {} }) }],
  ['default强杀', 'default-node', receipt => { receipt.forceKilled = true }],
  ['负例伪零退出', 'pin-rejected', receipt => { receipt.mainExit.code = 0 }],
  ['负例伪ready', 'pin-rejected', receipt => { receipt.startupReady = true }],
  ['负例只重启一次', 'pin-rejected', receipt => { remove(receipt, 'main.coreSpawn') }],
  ['Core外置wrapper', 'rust-diagnostic', receipt => { found(receipt, 'main.coreFork').data.entryPath = '/Volumes/LifeWeave/Developer/CommandLine/tmp/外置wrapper.js' }],
  ['Core额外mode参数', 'rust-diagnostic', receipt => { found(receipt, 'main.coreFork').data.args.push('--rust') }],
  ['Core actor错误pid', 'rust-diagnostic', receipt => { found(receipt, 'core.ready').pid = 1 }],
  ['Node Worker错误host', 'rust-diagnostic', receipt => { found(receipt, 'node.spawn').data.hostPid++ }],
  ['Node Worker未编码fileURL', 'rust-diagnostic', receipt => { found(receipt, 'node.spawn').data.entry = found(receipt, 'node.spawn').data.entry.replaceAll('%20', ' ') }],
  ['内部空租约合同串改', 'rust-diagnostic', receipt => {
    const request = found(receipt, 'main.request', entry => entry.data.request.command === 'recordingPrintWorker.claim').data.request
    for (const entry of receipt.events) {
      if (['main.response', 'core.publicReply'].includes(entry.event) && entry.data.reply.id === request.id) entry.data.reply.result = { lease: '伪造租约' }
      if (entry.event === 'node.reply' && entry.data.requestId === request.id) entry.data.result = { lease: '伪造租约' }
    }
  }],
  ['Node非零exit', 'rust-diagnostic', receipt => { found(receipt, 'node.exit').data.code = 1 }],
  ['缺Owner close完成', 'rust-diagnostic', receipt => { remove(receipt, 'node.closeCompleted') }],
  ['Node伪Rust路由', 'node-diagnostic', receipt => { found(receipt, 'core.diagnosticsInstalled').data.mode = 'rust' }],
  ['缺Mainresponse', 'rust-diagnostic', receipt => { remove(receipt, 'main.response', entry => entry.data.reply.result?.items !== undefined) }],
  ['Core收到不同request', 'rust-diagnostic', receipt => { found(receipt, 'core.publicRequest', entry => entry.data.request.command === 'collection.list').data.request.payload.page.offset = 1 }],
  ['Corereply完整DTO漂移', 'rust-diagnostic', receipt => { found(receipt, 'core.publicReply', entry => entry.data.reply.result?.items?.length === 3).data.reply.result.items[0].edition = '漂移' }],
  ['Nodeoracle完整DTO漂移', 'rust-diagnostic', receipt => { found(receipt, 'node.reply', entry => entry.data.result?.items?.length === 4).data.result.items[0].edition = '漂移' }],
  ['Nodewriter丢失', 'rust-diagnostic', receipt => { remove(receipt, 'node.dispatch', entry => entry.data.request.command === 'commandOutbox.execute') }],
  ['写命令重复id变新写', 'rust-diagnostic', receipt => { const writes = receipt.events.filter((entry: any) => entry.event === 'main.request' && entry.data.request.command === 'commandOutbox.execute'); writes[4].data.request.payload.payload.commandId = '00000000-0000-4000-8000-000000000001' }],
  ['刷新来自额外payload', 'rust-diagnostic', receipt => { found(receipt, 'main.refreshRequested').data.mode = 'rust' }],
  ['缺显式刷新', 'rust-diagnostic', receipt => { remove(receipt, 'core.explicitRefreshStarted') }],
  ['刷新ordinal错误', 'rust-diagnostic', receipt => { found(receipt, 'core.explicitRefreshCompleted').data.ordinal = 2 }],
  ['generation不增长', 'rust-diagnostic', receipt => { const values = receipt.events.filter((entry: any) => entry.event === 'core.explicitRefreshCompleted'); values[1].data.status.router.generation = values[0].data.status.router.generation }],
  ['资源校验pin漂移', 'rust-diagnostic', receipt => { found(receipt, 'core.resourceValidated').data.manifestSha256 = '1'.repeat(64) }],
  ['Rust路径越界', 'rust-diagnostic', receipt => { found(receipt, 'rust.spawn').data.binary.path = '/Users/yihe/真实用户资料' }],
  ['缺实际Rust closeACK', 'rust-diagnostic', receipt => { remove(receipt, 'rust.validated-reply', entry => entry.data.frame.operation === 'close') }],
  ['缺实际Rust bootACK', 'rust-diagnostic', receipt => { remove(receipt, 'rust.validated-reply', entry => entry.data.frame.operation === 'commitBoot') }],
  ['wire错误v1', 'rust-diagnostic', receipt => { found(receipt, 'rust.request').data.frame.protocolVersion = 1 }],
  ['wire准备额外字段', 'rust-diagnostic', receipt => { found(receipt, 'rust.request').data.frame.injected = true }],
  ['wire准备变writer', 'rust-diagnostic', receipt => { found(receipt, 'rust.validated-reply', entry => entry.data.frame.operation === 'prepare').data.frame.result.readOnly = false }],
  ['wire请求与Main不同', 'rust-diagnostic', receipt => { found(receipt, 'rust.request', entry => entry.data.frame.operation === 'dispatch').data.frame.payload.request.payload.page.offset = 1 }],
  ['wireACK scope不同', 'rust-diagnostic', receipt => { found(receipt, 'rust.validated-reply').data.frame.epoch = '00000000-0000-4000-8000-000000000001' }],
  ['wireDTO字段漂移', 'rust-diagnostic', receipt => { found(receipt, 'rust.validated-reply', entry => entry.data.frame.result?.items?.length === 3).data.frame.result.items[0].edition = '漂移' }],
  ['Node export与wire不等', 'rust-diagnostic', receipt => { found(receipt, 'node.versionedSnapshotExport').data.modelsSha256 = '1'.repeat(64) }],
  ['Rust被信号杀', 'rust-diagnostic', receipt => { found(receipt, 'rust.exit').data.signal = 'SIGKILL' }],
  ['Rust非零退出', 'rust-diagnostic', receipt => { found(receipt, 'rust.exit').data.code = 1 }],
  ['Rust未closeACK', 'rust-diagnostic', receipt => { found(receipt, 'rust.exit').data.closeAcknowledged = false }],
  ['缺第二beforeQuit', 'rust-diagnostic', receipt => { const values = receipt.events.filter((entry: any) => entry.event === 'main.beforeQuit'); receipt.events.splice(receipt.events.indexOf(values[1]), 1) }],
  ['额外beforeQuit', 'rust-diagnostic', receipt => { receipt.events.push(structuredClone(found(receipt, 'main.beforeQuit'))) }],
]
for (const [name, kind, change] of rawMutations) test(`实际raw JSON重算SHA深入拒绝：${name}`, async () => {
  const { report, expected } = await actualInput(); await changedRuntime(report, expected, kind, change)
  assert.throws(() => acceptRustPackagedRouteEvidence(report, expected), /包内路由证据未准入/u)
})
