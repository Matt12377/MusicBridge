import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { MessageChannel } from 'node:worker_threads'
import { captureDatasetWorkbenchNativeConfiguration, isDatasetWorkbenchNativeConfiguration } from '../../../../packages/bridge-core/src/collection/dataset-owner-protocol.js'
import { PHYSICAL_RESOURCE_BUFFER_BYTES } from '../../../../packages/bridge-core/src/stream/physical-resource-locks.js'
import { parseDatasetOwnerWorkerData, readDatasetWorkbenchNativeConfiguration } from '../../src/main/dataset-owner-bootstrap.js'
import type { LocalLibraryManagementMainCommand as LocalLibraryManagementCommand, LocalLibraryManagementMainPayloads as LocalLibraryManagementPayloads, LocalLibraryManagementMainResults as LocalLibraryManagementResults, LocalNameSettingsCommand, LocalNameSettingsPayloads, LocalNameSettingsResults, LocalNameSettings } from '@music-bridge/contracts'
import { useLocalWorkbenchLibrary, type LocalLibraryWorkspaceApi } from '../../src/renderer/src/composables/application/local-library-workbench/library.js'
import { mountVueSfc } from '../support/mbf-vue-host.js'

test('实际AI Settings修改模型并显式保存，安全输入按钮零密码字段且只发Main有限命令', async t => {
  const calls: { command: string; payload: unknown }[] = []
  let state: LocalNameSettings = { revision: '1', backend: 'ollama', ollama: { endpoint: 'http://127.0.0.1:11434', model: '合成模型' }, vllm: { endpoint: 'http://127.0.0.1:8000/v1', model: '合成vLLM' }, cloud: { endpoint: 'https://example.invalid/v1', model: '合成云模型', keyConfigured: false } }
  const api: LocalLibraryWorkspaceApi = {
    async localLibraryManagement<C extends LocalLibraryManagementCommand>(_command: C, _payload: LocalLibraryManagementPayloads[C]): Promise<LocalLibraryManagementResults[C]> { throw new Error('此UI测试不调用库管理') },
    async localNameSettings<C extends LocalNameSettingsCommand>(command: C, payload: LocalNameSettingsPayloads[C]): Promise<LocalNameSettingsResults[C]> {
      calls.push({ command, payload: structuredClone(payload) })
      if (command === 'name.settings.save') { const input = (payload as LocalNameSettingsPayloads['name.settings.save']).settings; state = { revision: '2', backend: input.backend, ollama: input.ollama, vllm: input.vllm, cloud: { ...input.cloud, keyConfigured: false } } }
      if (command === 'name.settings.securityPrompt') { state.cloud.keyConfigured = true; return { configured: true, cancelled: false } as LocalNameSettingsResults[C] }
      return state as LocalNameSettingsResults[C]
    },
  }
  let ids = 0; const model = useLocalWorkbenchLibrary({ api, makeCommandId: () => `settings-${++ids}` }); t.after(model.dispose)
  const host = await mountVueSfc(t, new URL('../../src/renderer/src/components/settings/LocalAiSettings.vue', import.meta.url).pathname, { model })
  const input = host.all().find(v => v.props['aria-label'] === '本地Ollama模型')!; input.value = '合成新模型'; await host.dispatch(input, 'onInput')
  await host.dispatch(host.all().find(v => v.type === 'form'), 'onSubmit')
  assert.equal(model.settings.value?.ollama.model, '合成新模型')
  assert.equal(host.all().filter(v => v.type === 'input' && v.props.type === 'password').length, 0)
  await host.dispatch(host.all().find(v => v.type === 'button' && host.text(v).includes('打开本地安全输入')), 'onClick')
  assert.deepEqual(calls.find(v => v.command === 'name.settings.securityPrompt')?.payload, { commandId: 'settings-2', backend: 'cloud' })
  assert.match(host.text(), /已在本地保险库配置/u); assert.doesNotMatch(JSON.stringify(calls), /password|apiKey|bearer/iu)
})

test('非法带凭据端点在配置端口前拒绝，实际设置保留且不生成成功提示', async t => {
  let writes = 0
  const model = useLocalWorkbenchLibrary({ api: { localLibraryManagement: async () => { throw new Error('未调用') }, localNameSettings: async () => { writes++; throw new Error('不应调用') } } }); t.after(model.dispose)
  model.settings.value = { revision: '1', backend: 'cloud', ollama: { endpoint: 'http://127.0.0.1:11434', model: '合成' }, vllm: { endpoint: 'http://127.0.0.1:8000/v1', model: '合成' }, cloud: { endpoint: 'https://example.invalid/v1', model: '合成', keyConfigured: false } }
  model.editName({ expectedRevision: '1', backend: 'cloud', ollama: model.settings.value.ollama, vllm: model.settings.value.vllm, cloud: { endpoint: 'https://synthetic:synthetic@example.invalid/v1', model: '合成' } })
  assert.equal(await model.saveNameSettings(), false); assert.equal(writes, 0); assert.equal(model.settings.value.cloud.endpoint, 'https://example.invalid/v1'); assert.match(model.error.value, /不得含凭据/u)
})

test('watch独立编译身份原样进入Owner配置，旧两字段仅得到null且未知字段和错根拒绝', async () => {
  const base = '/Volumes/LifeWeave/Developer/CommandLine/tmp/controlled-watch-config/native'
  const legacy = captureDatasetWorkbenchNativeConfiguration({ cue: null, tags: null })
  assert.deepEqual(legacy, { cue: null, tags: null, watch: null })
  const input = { cue: { root: base + '/cue-ffmpeg/darwin-arm64', manifestSha256: 'a'.repeat(64) },
    tags: { root: base + '/local-audio-tags/darwin-arm64', manifestSha256: 'b'.repeat(64) },
    watch: { root: base + '/library-watch/darwin-arm64', manifestSha256: 'c'.repeat(64) } }
  const original = structuredClone(input), captured = captureDatasetWorkbenchNativeConfiguration(input)
  input.watch.manifestSha256 = 'd'.repeat(64)
  assert.deepEqual(captured, original); assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.watch))
  for (const bad of [{ ...original, unknown: null }, { ...original, watch: undefined },
    { ...original, watch: original.cue }, { ...original, watch: { ...original.watch, root: '/other/native/library-watch/darwin-arm64' } },
    { ...original, watch: { ...original.watch, manifestSha256: 'not-a-pin' } }, { ...original, watch: { ...original.watch, opened: true } }]) {
    assert.equal(isDatasetWorkbenchNativeConfiguration(bad), false); assert.throws(() => captureDatasetWorkbenchNativeConfiguration(bad))
  }
  const source = new MessageChannel(), relocation = new MessageChannel()
  try {
    const buffer = new SharedArrayBuffer(PHYSICAL_RESOURCE_BUFFER_BYTES)
    const parsed = parseDatasetOwnerWorkerData({ dataDirectory: base + '/data', resourcesDirectory: base + '/resources',
      physicalResourceBuffer: buffer, sourceWritesPort: source.port1, relocationMainPort: relocation.port1, localWorkbenchNative: captured })
    assert.deepEqual(parsed.localWorkbenchNative, original); assert.equal(parsed.physicalResourceBuffer, buffer)
    assert.equal(parsed.sourceWritesPort, source.port1); assert.equal(parsed.relocationMainPort, relocation.port1)
  } finally { source.port1.close(); source.port2.close(); relocation.port1.close(); relocation.port2.close() }
})

test('watch只读取capture后的编译metadata和asar原件，拒重复键及旁边manifest替代许可', async () => {
  assert.ok(process.env.TMPDIR)
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'watch-metadata-config-'))
  const app = path.join(directory, 'app'), entry = path.join(app, 'dist/main'), resources = path.join(directory, 'resources')
  await mkdir(entry, { recursive: true, mode: 0o700 }); await mkdir(resources, { mode: 0o700 })
  const purposes = { cue: 'cue-independent-eight-format-output', tags: 'owner-protected-audio-copy-tags', watch: 'owner-fsevents-library-invalidation' }
  const names = { cue: 'cue-build.json', tags: 'local-audio-tags-build.json', watch: 'library-watch-build.json' }
  const metadata = (purpose: string, pin: string | null): Buffer => Buffer.from(JSON.stringify({ schemaVersion: 1, purpose, platform: 'darwin', arch: 'arm64', manifestSha256: pin }) + '\n')
  await writeFile(path.join(entry, names.cue), metadata(purposes.cue, null), { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(entry, names.tags), metadata(purposes.tags, null), { flag: 'wx', mode: 0o600 })
  const context = { entryDirectory: entry, appDirectory: app, resourcesDirectory: resources, packaged: false }
  const watchRoot = path.join(app, 'native/library-watch/darwin-arm64')
  await mkdir(watchRoot, { recursive: true, mode: 0o700 }); await writeFile(path.join(watchRoot, 'manifest.json'), '{"qualifiedRuntime":true}', { mode: 0o600 })
  assert.deepEqual(await readDatasetWorkbenchNativeConfiguration(context), { cue: null, tags: null, watch: null })
  const pin = 'c'.repeat(64), watch = metadata(purposes.watch, pin)
  await writeFile(path.join(entry, names.watch), watch, { flag: 'wx', mode: 0o600 })
  assert.deepEqual((await readDatasetWorkbenchNativeConfiguration(context)).watch, { root: watchRoot, manifestSha256: pin })
  for (const bad of [metadata(purposes.cue, pin), Buffer.from(watch.toString().replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1')),
    Buffer.from(watch.toString().replace('"manifestSha256"', '"extra":true,"manifestSha256"'))]) {
    await writeFile(path.join(entry, names.watch), bad); await assert.rejects(readDatasetWorkbenchNativeConfiguration(context))
  }
  await writeFile(path.join(entry, names.watch), watch)
  const packed = (records: Array<{ name: string; raw: Buffer }>): Buffer => {
    let offset = 0; const files: Record<string, unknown> = {}
    for (const record of records) { const hash = createHash('sha256').update(record.raw).digest('hex'); files[record.name] = { size: record.raw.length, offset: String(offset),
      integrity: { algorithm: 'SHA256', hash, blockSize: 4 * 1024 * 1024, blocks: [hash] } }; offset += record.raw.length }
    const json = Buffer.from(JSON.stringify({ files: { dist: { files: { main: { files } } } } })), length = (8 + json.length + 3) & ~3
    const header = Buffer.alloc(8 + length); header.writeUInt32LE(4, 0); header.writeUInt32LE(length, 4); header.writeUInt32LE(length - 4, 8); header.writeUInt32LE(json.length, 12); json.copy(header, 16)
    return Buffer.concat([header, ...records.map(record => record.raw)])
  }
  const records = [{ name: names.cue, raw: metadata(purposes.cue, 'a'.repeat(64)) }, { name: names.tags, raw: metadata(purposes.tags, 'b'.repeat(64)) }]
  const archive = path.join(resources, 'app.asar'), packagedContext = { ...context, entryDirectory: path.join(archive, 'dist/main'), packaged: true }
  await writeFile(archive, packed(records), { flag: 'wx', mode: 0o600 })
  assert.equal((await readDatasetWorkbenchNativeConfiguration(packagedContext)).watch, null)
  await writeFile(archive, packed([...records, { name: names.watch, raw: watch }]))
  assert.deepEqual((await readDatasetWorkbenchNativeConfiguration(packagedContext)).watch, { root: path.join(resources, 'library-watch/darwin-arm64'), manifestSha256: pin })
  await writeFile(archive, packed([...records, { name: names.watch, raw: metadata(purposes.watch, null) }]))
  await assert.rejects(readDatasetWorkbenchNativeConfiguration(packagedContext))
})


test('私有Native可调用性：原prompt host动态状态和原作者共同决定，不弹框也不借方法存在授资格', async () => {
  const { createLocalWorkbenchNativeChooser } = await import('../../src/main/local-library-workbench/native-chooser.js')
  let alive = false, authorLive = true, prompts = 0, guards = 0
  const host = { async request() { prompts++; return { cancelled: true, value: null } }, async join() {}, async close() { alive = false }, readAvailability() { return alive ? { available: true as const } : { available: false as const, reason: '原合成host已关闭' } } }
  const chooser = createLocalWorkbenchNativeChooser({ promptHost: host, assertCurrent() { guards++; if (!authorLive) throw new Error('原作者已换代') }, registerLibraryDirectory: async () => ({ choiceId: 'original', label: '合成原目录', suggestedRole: 'catalog' as const, evidence: ['原组件目录许可'] }), registerCueTarget: async () => {} })
  const context = { datasetId: 'synthetic-dataset', signal: new AbortController().signal }
  assert.equal((await chooser.readAvailability('artwork', context)).available, false)
  alive = true
  for (const mode of ['artwork', 'library', 'cue-target'] as const) assert.deepEqual(await chooser.readAvailability(mode, context), { available: true })
  assert.equal((await ({ ...chooser }).readAvailability('artwork', context)).available, false)
  authorLive = false; assert.equal((await chooser.readAvailability('artwork', context)).available, false)
  authorLive = true; const controller = new AbortController(); controller.abort()
  assert.equal((await chooser.readAvailability('artwork', { ...context, signal: controller.signal })).available, false)
  assert.equal(prompts, 0); assert.ok(guards >= 8); await chooser.closeReadResources()
  assert.equal((await chooser.readAvailability('artwork', context)).available, false)
})

test('私有Native可调用性：缺原host状态/目录登记口及原close在途均拒可用，不制造Native ACK', async () => {
  const { createLocalWorkbenchNativeChooser } = await import('../../src/main/local-library-workbench/native-chooser.js')
  const context = { datasetId: 'synthetic-dataset', signal: new AbortController().signal }
  const bare = createLocalWorkbenchNativeChooser({ assertCurrent() {}, promptHost: { async request() { assert.fail('状态读取不得弹框') }, async join() {}, async close() {} } })
  assert.equal((await bare.readAvailability('artwork', context)).available, false); await bare.closeReadResources()
  let finish!: () => void; const physicalClose = new Promise<void>(resolve => { finish = resolve }), host = { async request() { assert.fail('状态读取不得弹框') }, async join() {}, close: () => physicalClose, readAvailability: () => ({ available: true as const }) }
  const chooser = createLocalWorkbenchNativeChooser({ assertCurrent() {}, promptHost: host })
  assert.deepEqual(await chooser.readAvailability('artwork', context), { available: true })
  assert.equal((await chooser.readAvailability('library', context)).available, false)
  assert.equal((await chooser.readAvailability('cue-target', context)).available, false)
  const closing = chooser.closeReadResources(); assert.equal((await chooser.readAvailability('artwork', context)).available, false)
  finish(); await closing; assert.equal((await chooser.readAvailability('artwork', context)).available, false)
})

test('私有Native可调用性：内建host只核darwin固定程序可执行和自有closure，不运行osascript', async () => {
  const { createLocalWorkbenchNativeChooser } = await import('../../src/main/local-library-workbench/native-chooser.js')
  const chooser = createLocalWorkbenchNativeChooser({ assertCurrent() {} }), context = { datasetId: 'synthetic-dataset', signal: new AbortController().signal }
  const state = await chooser.readAvailability('artwork', context)
  if (process.platform !== 'darwin') assert.equal(state.available, false)
  else assert.deepEqual(state, { available: true })
  await chooser.closeReadResources(); assert.equal((await chooser.readAvailability('artwork', context)).available, false)
})
