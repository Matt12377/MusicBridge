import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { verifyHumanSessionEvidence, verifyHumanSessionReadiness, verifyHumanSessionIdentity, verifyHumanComponentManifest, verifyHumanRuntimeLinks, type HumanSessionReceipt, type SessionMode } from '../helpers/rust-collection-human-evidence.js'

const supplied = process.env.MUSIC_BRIDGE_RUST_HUMAN_SESSION_REPORTS
assert.ok(supplied, '缺少本轮真实会话报告；验收器负测试不得条件skip。')
const reportPaths = JSON.parse(supplied) as string[]
assert.ok(Array.isArray(reportPaths) && reportPaths.length >= 4 && reportPaths.every(value => typeof value === 'string' && value.length > 0))
assert.equal(new Set(reportPaths).size, reportPaths.length, '会话报告路径重复。')
const originals = reportPaths.map(file => JSON.parse(readFileSync(file, 'utf8')) as HumanSessionReceipt)
assert.equal(new Set(originals.map(value => value.sessionId)).size, originals.length, '真实会话身份重复。')
for (const mode of ['node100', 'rust100', 'rust2000', 'rust5000']) assert.ok(originals.some(value => value.mode === mode), '实际会话规模缺失：' + mode)
const original = originals.find(value => value.mode === 'rust100')!
const readiness = JSON.parse(readFileSync(original.readinessReceiptPath!, 'utf8')) as HumanSessionReceipt
const clone = () => structuredClone(original)
const running = () => structuredClone(readiness)
const resequence = (receipt: HumanSessionReceipt) => receipt.host.observations.forEach((value, index) => { value.sequence = index + 1 })

// 全部输入来自本轮真实可见会话；负变体仅内存，原产物/profile/收据只读。
// 本suite是严格验收器测试，不是另一轮Owner、真实服务或真实用户库验收。
test('实际四静态模式readiness只返回未完成，原app.quit自然闭幕完整证据接受', () => {
  for (const receipt of originals) {
    const ready = JSON.parse(readFileSync(receipt.readinessReceiptPath!, 'utf8')) as HumanSessionReceipt
    assert.deepEqual(verifyHumanSessionReadiness(ready), { phase: 'readiness', complete: false, ownerAcceptance: 'NOT_RUN' })
    assert.deepEqual(verifyHumanSessionEvidence(structuredClone(receipt)), { phase: 'closed', complete: true, ownerAcceptance: 'NOT_RUN', mode: receipt.mode })
  }
})
function reject(name: string, mutate: (receipt: HumanSessionReceipt) => void, pattern: RegExp | { code: string } = { code: 'ERR_ASSERTION' }) {
  test('拒绝：' + name, () => {
    const receipt = clone(); mutate(receipt)
    assert.throws(() => verifyHumanSessionEvidence(receipt), pattern)
  })
}

for (const state of ['preflight', 'starting', 'ready', 'closing', 'failed'] as const) {
  reject('阶段' + state + '不能完整PASS', receipt => { receipt.state = state }, /不能完整PASS/)
}
test('真实运行中ready不能升级完整PASS', () => {
  assert.throws(() => verifyHumanSessionEvidence(running()), /不能完整PASS/)
})
test('自然闭幕收据不能重新冒充运行中readiness', () => {
  assert.throws(() => verifyHumanSessionReadiness(clone()), /要求ready/)
  const falsified = clone(); falsified.state = 'ready'; delete falsified.close
  assert.throws(() => verifyHumanSessionReadiness(falsified), /Owner已关闭/)
})
reject('自动宣称Owner已通过', receipt => { receipt.ownerAcceptance = 'ACCEPTED' as 'NOT_RUN' }, /Owner通过/)
reject('launch信号所有权收据缺失', receipt => { delete (receipt as Partial<HumanSessionReceipt>).signalOwnership }, /信号所有权收据/)
reject('信号dependency路径漂移', receipt => { receipt.signalOwnership.dependencyPath = '/different/coreBundle.js' }, /dependency路径漂移/)
reject('信号bundle pin漂移', receipt => { receipt.signalOwnership.dependencySha256 = '0'.repeat(64) }, /bundle身份漂移/)
reject('信号依赖版本漂移', receipt => { receipt.signalOwnership.version = '1.61.0' }, /版本漂移/)
reject('信号抑制记录遗漏', receipt => { receipt.signalOwnership.suppressed.pop() }, /记录不完整/)
reject('信号抑制记录重复', receipt => { receipt.signalOwnership.suppressed[1] = structuredClone(receipt.signalOwnership.suppressed[0]!) }, /记录重复/)
reject('未知同名监听器源码被抑制', receipt => { receipt.signalOwnership.suppressed[0]!.sourceSha256 = '0'.repeat(64) }, /固定函数源码/)
reject('错误监听器函数名被抑制', receipt => { receipt.signalOwnership.suppressed[0]!.name = 'ownerSignalHandler' }, /固定函数源码/)
reject('信号注册方法未恢复', receipt => { receipt.signalOwnership.restored = false }, /没有恢复/)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  reject('未保留驱动原信号监听器' + signal, receipt => { receipt.signalOwnership.preservedAtStart[signal] = 0 }, /监听器未保留/)
}
test('运行中readiness也拒绝未恢复信号所有权', () => {
  const receipt = running(); receipt.signalOwnership.restored = false
  assert.throws(() => verifyHumanSessionReadiness(receipt), /没有恢复/)
})
reject('不存在的模式或Renderer配置开关', receipt => { receipt.mode = 'renderer-rust' as SessionMode }, /静态闭集/)
reject('5000模式伪称100seed', receipt => { receipt.mode = 'rust5000'; receipt.seed.models = 100 }, /规模与模式错配/)
reject('错误visible规模', receipt => { receipt.visibleWindow.models = 2000 }, /可见Vue页面规模错配/)
reject('窗口隐藏仍声称会话就绪', receipt => { receipt.visibleWindow.isVisible = false }, /窗口不可见/)
reject('窗口未focus', receipt => { receipt.visibleWindow.isFocused = false }, /未focus/)
reject('替换原Renderer URL', receipt => { receipt.visibleWindow.url = 'https://example.test/' }, /原生产Renderer/)
reject('DOM未mounted', receipt => { receipt.visibleWindow.mounted = false })
reject('标题不含实际mode/session身份', receipt => { receipt.visibleWindow.title = 'MusicBridge' }, /标题身份/)
reject('复用已有profile', receipt => { receipt.profileWasFresh = false }, /不是全新/)
reject('真实用户路径冒充合成profile', receipt => { receipt.profile = '/Users/yihe/Library/Application Support/MusicBridge' })
reject('seed作者连接未在Main前关闭', receipt => { receipt.seed.closedBeforeLaunch = false }, /seed必须/)
reject('没有安装能力边界，只剩NOT_RUN常量', receipt => { delete (receipt as Partial<HumanSessionReceipt>).boundary }, /实际Main能力边界/)
reject('边界安装在可见窗口之后', receipt => { receipt.boundary.installedBeforeVisible = false }, /能力边界/)
reject('显示前已有可操作窗口', receipt => { receipt.boundary.visibleBeforeInstallation = true }, /显示前未封闭/)
reject('native文件选择器未封闭', receipt => { receipt.boundary.dialogBlocked = false }, /能力边界/)
reject('未来注册IPC未受guard', receipt => { receipt.boundary.futureRegistrationsGuarded = false }, /能力边界/)
reject('替换原业务handler伪称合成成功', receipt => { receipt.boundary.productionHandlersPreserved = false }, /能力边界/)
reject('将remote SSH加入开放渠道', receipt => { receipt.boundary.allowedChannels.push('remote-core:start') }, /开放渠道越过/)
reject('泛outbox开放非policy命令', receipt => { receipt.boundary.conditionalOutboxCommands.push('collection.receive') }, /泛outbox绕过/)
reject('范围外渠道未被完整拒绝', receipt => { receipt.boundary.blockedChannels.pop() }, /拒绝渠道不覆盖全集/)
for (const channel of ['remote-core:start', 'library:read', 'collection:pick-photo', 'lyrics:display:configure', 'native.showOpenDialog', 'native.showSaveDialog']) {
  reject('缺真实受保护拒绝probe ' + channel, receipt => {
    receipt.boundary.blockedAttempts = receipt.boundary.blockedAttempts.filter(value => value.channel !== channel)
    receipt.boundary.blockedAttempts.forEach((value, index) => { value.sequence = index + 1 })
  }, /范围外拒绝probe/)
}
reject('nonpolicy提交缺真实requestCommand拒绝', receipt => {
  receipt.boundary.blockedAttempts.forEach(value => { if (value.channel === 'commandOutbox:submit') value.requestCommand = 'collection.setPolicy' })
}, /泛outbox非policy真实拒绝/)
reject('receipt嵌入的driver源hash漂移', receipt => { receipt.identity.driverManifest.sources[0]!.sha256 = '0'.repeat(64) }, /identity与本轮预检不同/)
reject('driver manifest SHA漂移', receipt => { receipt.identity.driverManifestSha256 = '0'.repeat(64) }, /driver manifest身份漂移/)
reject('组件产物hash漂移', receipt => { receipt.identity.componentManifest.artifacts[0]!.sha256 = '0'.repeat(64) }, /identity与本轮预检不同/)
reject('Rust binary pin漂移', receipt => { receipt.identity.driverManifest.binarySha256 = '0'.repeat(64) }, /identity与本轮预检不同/)
reject('Electron完整275清单hash漂移', receipt => {
  receipt.identity.electronManifest.entries.find(value => value.kind === 'file')!.sha256 = '0'.repeat(64)
}, /identity与本轮预检不同/)
reject('Electron链接目标漂移', receipt => {
  const link = receipt.identity.electronManifest.entries.find(value => value.kind === 'symlink')!
  assert.ok(link, '真实Electron完整清单必须有框架链接。'); link.target = '/outside'
}, /identity与本轮预检不同/)
reject('固定人工启动器被从identity中遗漏', receipt => { delete (receipt.identity.driverManifest as Partial<typeof receipt.identity.driverManifest>).launcher }, /identity与本轮预检不同/)
reject('固定启动器hash或权限漂移', receipt => { receipt.identity.driverManifest.launcher.sha256 = '0'.repeat(64); receipt.identity.driverManifest.launcher.mode = 0o755 as 448 }, /identity与本轮预检不同/)
reject('新driver错误借用旧组件baseSha', receipt => { receipt.identity.driverManifest.baseSha = 'ae8a53fb1206c65632d3b23c66b929965e89a7d3' }, /identity与本轮预检不同/)
reject('readiness收据缺失', receipt => { delete receipt.readinessReceiptPath }, /readiness收据/)
reject('readiness收据SHA错误', receipt => { receipt.readinessReceiptSha256 = '0'.repeat(64) }, /readinessmanifest 身份漂移/)
reject('最终Host改写readiness历史', receipt => { receipt.host.observations[0]!.entry = '伪造Owner入口' }, /readiness历史/)
reject('Owner与Core PID不匹配', receipt => { receipt.main.find(value => value.event === 'main.coreSpawn')!.pid = 123 }, /身份错配/)
reject('缺两次公开空claim，即使保留Node内部claim也不接受', receipt => {
  receipt.host.observations = receipt.host.observations.filter(value => value.event !== 'core.publicReply' || value.command !== 'recordingPrintWorker.claim')
  resequence(receipt)
}, /两次公开空claim/)
reject('公开claim缺对应Node完成回执', receipt => {
  receipt.host.observations.find(value => value.event === 'node.claimComplete')!.requestId = '不同请求'
}, /真实Node闭环/)
reject('运行期非法accept指令', receipt => {
  receipt.controls[0]!.command = 'accept' as 'status'
}, /非法terminal/)
reject('自动操作被标为人工预算', receipt => { receipt.budget.kind = 'owner-session'; receipt.budget.durationMs = 1800000; receipt.budget.deadlineMs = receipt.budget.startedMs + 1800000 }, /自动操作冒充/)
reject('无界会话或超出30分钟预算', receipt => { receipt.budget.durationMs = 1800001; receipt.budget.deadlineMs = receipt.budget.startedMs + 1800001 })
reject('控制并发越过串行边界', receipt => {
  assert.ok(receipt.controls.length >= 2); receipt.controls[1]!.startedMs = receipt.controls[0]!.startedMs - 1
}, /未串行/)
reject('未记账自动refresh', receipt => {
  const previous = receipt.host.observations.at(-1)!
  receipt.host.observations.push({ event: 'host.explicitRefresh', sequence: previous.sequence + 1, elapsedMs: previous.elapsedMs })
}, /自动refresh或重放/)
reject('app.quit被换成强杀', receipt => { receipt.close!.method = 'kill' as 'app.quit' }, /原app.quit/)
reject('缺真实before-quit事件', receipt => { receipt.close!.beforeQuitObserved = false }, /before-quit/)
reject('Main生命周期文件SHA漂移', receipt => { receipt.close!.lifecycleSha256 = '0'.repeat(64) }, /Main生命周期manifest 身份漂移/)
reject('强制清理不能冒充自然关闭', receipt => { receipt.close!.forcedCleanup = true }, /forcedCleanup/)
reject('Electron signal退出', receipt => { receipt.close!.electronExit.signal = 'SIGKILL' }, /Electron没有自然/)
reject('Core非0退出', receipt => { receipt.coreExit = 1 }, /Core没有自然/)
reject('Owner非0退出', receipt => { receipt.host.observations.find(value => value.event === 'node.exit')!.code = 1 }, /Owner没有自然/)
reject('Owner退出前伪称closed', receipt => {
  const exit = receipt.host.observations.find(value => value.event === 'node.exit')!, closed = receipt.host.observations.find(value => value.event === 'node.closed')!
  exit.event = 'node.closed'; closed.event = 'node.exit'; closed.code = 0
}, /close→exit→closed/)
reject('Rust缺close ACK', receipt => {
  const index = receipt.host.observations.findIndex(value => value.event === 'rust.frame' && value.operation === 'close')
  assert.ok(index >= 0); receipt.host.observations.splice(index, 1); resequence(receipt)
})
reject('Rust signal退出', receipt => { receipt.host.observations.find(value => value.event === 'rust.exit')!.signal = 'SIGKILL' }, /Rust没有自然/)
test('默认Node即使仍有可见页面，Rust child和私有export也拒绝', () => {
  for (const event of ['rust.spawn', 'node.export']) {
    const receipt = structuredClone(originals.find(value => value.mode === 'node100')!), previous = receipt.host.observations.at(-1)!
    receipt.host.observations.push({ event, sequence: previous.sequence + 1, elapsedMs: previous.elapsedMs, pid: 123, liveChildren: 1 })
    assert.throws(() => verifyHumanSessionEvidence(receipt), /默认Node/)
  }
})
test('readiness实际Rust scope被替换，即使ACK计数仍完整也拒绝', () => {
  const receipt = running(); receipt.host.controller!.router!.snapshotId = '另一份快照'
  assert.throws(() => verifyHumanSessionReadiness(receipt), /实际发布scope/)
})
test('fresh身份预检不能只凭文件名存在：错误冻结manifest hash拒绝', () => {
  assert.throws(() => verifyHumanSessionIdentity({ driverManifestPath: original.identity.driverManifestPath, driverManifestSha256: '0'.repeat(64) }), /driver manifest身份漂移/)
})
for (const removed of ['main/private-rust-collection-main-100-wrapper.mjs', 'main/private-rust-collection-main-2000-wrapper.mjs',
  'main/private-rust-collection-main-5000-wrapper.mjs', 'main/private-rust-collection-node-main-wrapper.mjs',
  'main/private-rust-collection-core-100.js', 'main/private-rust-collection-core-2000.js', 'main/private-rust-collection-core-5000.js',
  'main/private-rust-collection-node.js', 'main/private-rust-collection-main-host-wrapper.mjs']) {
  test('真实完整组件输入拒绝同步遗漏产物清单项：' + removed, () => {
    const component = structuredClone(original.identity.componentManifest)
    assert.ok(component.artifacts.some(value => value.path === removed))
    component.artifacts = component.artifacts.filter(value => value.path !== removed)
    assert.throws(() => verifyHumanComponentManifest(component, { sourceRoot: original.identity.driverManifest.sourceRoot,
      componentOutput: original.identity.componentOutput }), /产物完整库存清单/)
  })
}
test('真实源码输入拒绝同步遗漏source并重新伪算aggregate', () => {
  const component = structuredClone(original.identity.componentManifest)
  assert.ok(component.sources.some(value => value.path === 'apps/desktop/e2e/private-rust-collection-host.ts'))
  component.sources = component.sources.filter(value => value.path !== 'apps/desktop/e2e/private-rust-collection-host.ts')
  component.sourceAggregateSha256 = createHash('sha256').update(JSON.stringify(component.sources)).digest('hex')
  assert.throws(() => verifyHumanComponentManifest(component, { sourceRoot: original.identity.driverManifest.sourceRoot,
    componentOutput: original.identity.componentOutput }), /源码完整闭包清单/)
})
test('真实完整产物bytes不可漂移', () => {
  const component = structuredClone(original.identity.componentManifest)
  component.artifacts[0]!.bytes = Number(component.artifacts[0]!.bytes) + 1
  assert.throws(() => verifyHumanComponentManifest(component, { sourceRoot: original.identity.driverManifest.sourceRoot,
    componentOutput: original.identity.componentOutput }), /产物完整库存清单/)
})
test('组件node_modules真实链接指向另一路径直接拒绝，原组件链接保持只读', () => {
  const temporaryRoot = process.env.TMPDIR
  assert.ok(typeof temporaryRoot === 'string' && temporaryRoot.startsWith('/Volumes/LifeWeave/Developer/CommandLine/'), '受控链接负例必须在本轮外置tmp。')
  const fixture = mkdtempSync(path.join(temporaryRoot, 'human-runtime-link-refusal-'))
  symlinkSync(path.join(original.identity.driverManifest.sourceRoot, 'node_modules'), path.join(fixture, 'node_modules'), 'dir')
  assert.throws(() => verifyHumanRuntimeLinks({ sourceRoot: original.identity.driverManifest.sourceRoot, componentOutput: fixture }), /链接目标漂移/)
  // 只新建受控外置fixture，保留它作为收据；不清理或改动任何生产/009链接。
})
test('实际contracts链接目标/解析根不能在收据中被另包替换', () => {
  for (const field of ['target', 'realPath', 'resolvedEntry'] as const) {
    const altered = structuredClone(original.identity.runtimeLinks)
    altered.contracts[field] = '/different-package'
    assert.throws(() => verifyHumanRuntimeLinks({ sourceRoot: original.identity.driverManifest.sourceRoot,
      componentOutput: original.identity.componentOutput }, altered), /dependency链接收据身份漂移/)
  }
})
test('实际组件contracts仅有import导出仍通过ESM只读解析，不采用require条件', () => {
  const sourceRoot = original.identity.driverManifest.sourceRoot
  const metadata = JSON.parse(readFileSync(path.join(sourceRoot, 'packages/contracts/package.json'), 'utf8'))
  assert.equal(metadata.exports['.'].import, './dist/index.js')
  assert.equal(metadata.exports['.'].require, undefined)
  const actual = verifyHumanRuntimeLinks({ sourceRoot, componentOutput: original.identity.componentOutput })
  assert.equal(actual.contracts.resolvedEntry, path.join(sourceRoot, 'packages/contracts/dist/index.js'))
})
