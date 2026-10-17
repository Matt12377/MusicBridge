import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalNameTransport, type LocalNameBackend, type LocalNameConfiguration } from '../src/main/local-library-workbench/providers/name-transport.js'
import { LocalProviderError } from '../src/main/local-library-workbench/providers/boundaries.js'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, lstat, writeFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import * as dto from '@music-bridge/contracts'
import { CredentialVault, type AsyncSafeStorage } from '../src/main/credential-vault.js'
import { createLocalNameSettings, type LocalNameSettingsContext, type LocalNameSecurePrompt } from '../src/main/local-library-workbench/name-settings.js'

// 全部网络与凭据为合成注入；不证明真实模型、保险库、计费服务或模型输出质量。
const signal = () => new AbortController().signal
const request = (backend: LocalNameBackend = 'ollama') => ({ backend, systemPrompt: '只返回名称 JSON。', userPrompt: '合成原歌手 / 合成原专辑' })
const content = '{"artistName":"合成作者","albumName":"合成专辑"}'
const configuration = (backend: LocalNameBackend): LocalNameConfiguration => ({
  baseUrl: backend === 'ollama' ? 'http://127.0.0.1:11434' : backend === 'vllm' ? 'http://127.0.0.1:8000' : 'https://synthetic.example.com',
  model: '合成模型',
})
function body(text: string, mime = 'application/x-ndjson'): Response { return new Response(text, { headers: { 'content-type': mime } }) }
function ndjson(value = content): Response { return body(JSON.stringify({ message: { content: value, thinking: '此思考不得进入候选' }, done: true }) + '\n') }
function sse(value = content): Response { return body(`data: ${JSON.stringify({ choices: [{ delta: { content: value }, finish_reason: null }] })}\n\ndata: [DONE]\n`, 'text/event-stream') }
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function safe(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof LocalProviderError); assert.equal(error.code, code)
    assert.doesNotMatch(error.message + JSON.stringify(error), /合成密钥|synthetic-secret-key|synthetic\.example|底层秘密|model-output/u)
    assert.equal(Object.hasOwn(error, 'cause'), false)
    return true
  }
}

test('Ollama 保留原 api/chat、名称 schema、thinking 忽略及显式卸载协议', async () => {
  const requests: Array<{ url: string; init: RequestInit; json: Record<string, any> }> = []
  const transport = createLocalNameTransport({ getConfiguration: configuration, fetch: async (url, init) => {
    const json = JSON.parse(String(init?.body)) as Record<string, any>
    requests.push({ url: String(url), init: init!, json })
    return json.messages.length ? ndjson() : body('{"done":true}', 'application/json')
  } })
  const operation = transport.suggest(request(), signal())
  assert.deepEqual(await operation, { backend: 'ollama', content }); await transport.join(operation)
  assert.equal(requests[0]!.url, 'http://127.0.0.1:11434/api/chat')
  assert.deepEqual(requests[0]!.json, { model: '合成模型', messages: [{ role: 'system', content: request().systemPrompt }, { role: 'user', content: request().userPrompt }], think: false, stream: true, format: { type: 'object', properties: { artistName: { type: 'string' }, albumName: { type: 'string' } }, required: ['artistName', 'albumName'], additionalProperties: false }, keep_alive: '30s' })
  assert.equal(new Headers(requests[0]!.init.headers).has('authorization'), false)
  assert.equal(requests[0]!.init.redirect, 'error'); assert.equal(requests[0]!.init.credentials, 'omit')
  assert.deepEqual(await transport.releaseResources('ollama'), { released: true })
  assert.deepEqual(requests[1]!.json, { model: '合成模型', messages: [], stream: false, keep_alive: '0' })
  assert.deepEqual(await transport.releaseResources('ollama'), { released: false })
  await transport.close()
})

test('vLLM 无凭据可用，云端凭据仅进入 Main Authorization，路径不重复 v1', async () => {
  for (const backend of ['vllm', 'cloud'] as const) {
    const requests: Array<{ url: string; init: RequestInit }> = [], secrets: string[] = []
    const transport = createLocalNameTransport({
      getConfiguration: value => ({ ...configuration(value), baseUrl: configuration(value).baseUrl + '/v1///' }),
      resolveSecret: value => { secrets.push(value); return value === 'cloud' ? 'synthetic-secret-key' : null },
      fetch: async (url, init) => { requests.push({ url: String(url), init: init! }); return sse() },
    })
    const result = await transport.suggest(request(backend), signal())
    assert.deepEqual(result, { backend, content }); assert.deepEqual(secrets, [backend])
    assert.equal(requests[0]!.url, configuration(backend).baseUrl + '/v1/chat/completions')
    const json = JSON.parse(String(requests[0]!.init.body))
    assert.deepEqual(Object.keys(json).sort(), ['messages', 'model', 'stream'])
    assert.equal(new Headers(requests[0]!.init.headers).get('authorization'), backend === 'cloud' ? 'Bearer synthetic-secret-key' : null)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret-key|密钥|baseUrl|Authorization/u)
    assert.deepEqual(await transport.releaseResources(backend), { released: false }); await transport.close()
  }
})

test('兼容 SSE 注释、保活、裸 JSON、finish_reason 与跨块 UTF8', async () => {
  const first = '{"artistName":"合成', second = '作者","albumName":"合成专辑"}'
  const text = `: 保活\nevent: message\nid: 1\nretry: 500\ndata:\n\n${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: second }, finish_reason: 'stop' }] })}\n底层秘密不应继续读取`
  const bytes = Buffer.from(text)
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.subarray(at, at + 7)); controller.close() } })
  const transport = createLocalNameTransport({ getConfiguration: configuration, fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }) })
  assert.equal((await transport.suggest(request('vllm'), signal())).content, content); await transport.close()
})

test('私有正文不在 transport 清洗或宣称可应用，正常 EOF 保留原客户端行为', async () => {
  const privateText = '```json\n' + content + '\n```'
  const transport = createLocalNameTransport({ getConfiguration: configuration, fetch: async () => body(JSON.stringify({ message: { content: privateText } })) })
  assert.equal((await transport.suggest(request(), signal())).content, privateText)
  // 卸载只验证释放响应；此用例不产生任何写入或公开候选。
  await transport.close()
})

test('上游正文、HTTP 状态及底层异常不能泄露到公开错误', async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => new Response('合成密钥 https://synthetic.example.com model-output', { status: 401 }),
    async () => body('{"error":"底层秘密 合成密钥"}'),
    async () => body('model-output 合成密钥'),
    async () => body('{"message":{"content":42},"done":true}'),
    async () => { throw new Error('底层秘密 https://synthetic.example.com 合成密钥') },
  ]
  for (let index = 0; index < cases.length; index++) {
    const transport = createLocalNameTransport({ getConfiguration: configuration, fetch: cases[index]! })
    await assert.rejects(transport.suggest(request(), signal()), safe(index === 0 ? 'status' : index === 4 ? 'transport' : 'response'))
    await transport.close()
  }
})

test('无内容、错误 choices 与无效 UTF8 不能形成名称结果', async () => {
  for (const response of [sse(''), body('{"choices":42}', 'text/event-stream'), body('{"choices":[{"delta":{"content":[]}}]}', 'text/event-stream'), new Response(Buffer.from([255, 254]), { headers: { 'content-type': 'text/event-stream' } })]) {
    const transport = createLocalNameTransport({ getConfiguration: configuration, fetch: async () => response })
    await assert.rejects(transport.suggest(request('vllm'), signal()), safe('response')); await transport.close()
  }
})

test('URL userinfo/query/fragment、云端 HTTP 和未设模型在网络前拒绝', async () => {
  const configs = [
    { baseUrl: 'https://user:合成密钥@synthetic.example.com', model: 'm' },
    { baseUrl: 'https://synthetic.example.com?q=secret', model: 'm' },
    { baseUrl: 'https://synthetic.example.com#secret', model: 'm' },
    { baseUrl: 'http://synthetic.example.com', model: 'm' },
    { baseUrl: 'https://synthetic.example.com', model: '' },
  ]
  for (const config of configs) {
    let calls = 0
    const transport = createLocalNameTransport({ getConfiguration: () => config, resolveSecret: () => 'synthetic-secret-key', fetch: async () => { calls++; return sse() } })
    await assert.rejects(transport.suggest(request('cloud'), signal()), safe('configuration')); assert.equal(calls, 0); await transport.close()
  }
})

test('云端缺凭据、非法凭据和凭据解析异常均不发请求，也不输出 secret', async () => {
  for (const secret of [null, ' ', '合成密钥\n注入头']) {
    let calls = 0
    const transport = createLocalNameTransport({ getConfiguration: configuration, resolveSecret: () => secret, fetch: async () => { calls++; return sse() } })
    await assert.rejects(transport.suggest(request('cloud'), signal()), safe('configuration')); assert.equal(calls, 0); await transport.close()
  }
  const transport = createLocalNameTransport({ getConfiguration: configuration, resolveSecret: () => { throw new Error('底层秘密 合成密钥') }, fetch: async () => { assert.fail('解析失败后不能请求') } })
  await assert.rejects(transport.suggest(request('cloud'), signal()), safe('transport')); await transport.close()
})

test('响应声明、流累计、单行和拼接正文各受独立字节预算约束', async () => {
  const cases = [
    { response: () => new Response('x', { headers: { 'content-type': 'text/event-stream', 'content-length': '101' } }), options: { maxResponseBytes: 100 } },
    { response: () => body(' '.repeat(101), 'text/event-stream'), options: { maxResponseBytes: 100 } },
    { response: () => sse(), options: { maxLineBytes: 20 } },
    { response: () => sse(), options: { maxContentBytes: 10 } },
  ]
  for (const item of cases) {
    const transport = createLocalNameTransport({ getConfiguration: configuration, fetch: async () => item.response(), ...item.options })
    await assert.rejects(transport.suggest(request('vllm'), signal()), safe('budget')); await transport.close()
  }
})

test('调用前取消与未知 backend 不触发配置、凭据或网络', async () => {
  let calls = 0
  const transport = createLocalNameTransport({ getConfiguration: () => { calls++; return configuration('vllm') }, fetch: async () => { assert.fail('不可请求') } })
  const controller = new AbortController(); controller.abort()
  const cancelled = transport.suggest(request('vllm'), controller.signal)
  await assert.rejects(cancelled, safe('cancelled')); await transport.join(cancelled)
  await assert.rejects(transport.suggest(request('unknown' as LocalNameBackend), signal()), safe('input'))
  assert.equal(calls, 0); await transport.close()
})

test('取消阻断晚到正文，并用新的未取消信号卸载原 Ollama 模型', async () => {
  const late = deferred<Response>(), parent = new AbortController(), signals: AbortSignal[] = [], bodies: any[] = []
  const transport = createLocalNameTransport({ getConfiguration: configuration, fetch: async (_url, init) => {
    signals.push(init!.signal as AbortSignal); const json = JSON.parse(String(init!.body)); bodies.push(json)
    return json.messages.length ? late.promise : body('{"done":true}', 'application/json')
  } })
  const pending = transport.suggest(request(), parent.signal), rejected = assert.rejects(pending, safe('cancelled'))
  await flush(); parent.abort(); await rejected
  assert.equal(signals.length, 2); assert.equal(signals[0]!.aborted, true); assert.equal(signals[1]!.aborted, false)
  assert.equal(bodies[1]!.keep_alive, '0')
  late.resolve(ndjson('迟到的 model-output')); await flush()
  await transport.close()
})

test('stop 串行取消正在读取的流、阻断忙时新请求，完成卸载后才结束', async () => {
  let cancelled = false, fetches = 0
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('{"message":{"content":"尚未完整"}}\n')) }, cancel() { cancelled = true } })
  const transport = createLocalNameTransport({ getConfiguration: configuration, fetch: async (_url, init) => {
    fetches++; const json = JSON.parse(String(init!.body)); return json.messages.length ? new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }) : body('{"done":true}', 'application/json')
  } })
  const pending = transport.suggest(request(), signal()), rejected = assert.rejects(pending, safe('cancelled'))
  await flush(); await assert.rejects(transport.suggest(request(), signal()), safe('busy'))
  await transport.stop(); await rejected; assert.equal(cancelled, true); assert.equal(fetches, 2)
  await transport.close(); await assert.rejects(transport.suggest(request(), signal()), safe('closed'))
})

test('超时同样阻断结果，Ollama 卸载失败不冒充 released', async () => {
  let calls = 0
  const late = deferred<Response>()
  const transport = createLocalNameTransport({ timeoutMs: 10, unloadTimeoutMs: 10, getConfiguration: configuration, fetch: async (_url, init) => {
    calls++; return JSON.parse(String(init!.body)).messages.length ? late.promise : new Response('', { status: 503 })
  } })
  const operation = transport.suggest(request(), signal())
  await assert.rejects(operation, safe('timeout'))
  assert.equal(calls, 2); await assert.rejects(transport.releaseResources('ollama'), safe('busy'))
  const lateResponse = ndjson('迟到的 model-output'); late.resolve(lateResponse)
  await transport.join(operation)
  const reader = lateResponse.body!.getReader()
  try { assert.equal((await reader.read()).done, true, '原fetch迟到body必须实际cancel并关闭，不能仅凭逻辑timeout卸载') } finally { reader.releaseLock() }
  assert.deepEqual(await transport.releaseResources('ollama'), { released: false }); await transport.close()
})

// 下列检查使用实际文件和加密读写；加密提供者与系统输入明确为合成注入，不签发 Keychain/Native/Owner 资格。
async function settingsFixture(readSecret: LocalNameSecurePrompt['readSecret'] = async () => 'synthetic-main-private-key') {
  const tempRoot = process.env.TMPDIR
  assert.ok(tempRoot && path.isAbsolute(tempRoot), '设置检查必须显式提供外置或 CI 临时根')
  const directory = await mkdtemp(path.join(tempRoot, 'musicbridge-name-settings-'))
  const file = path.join(directory, 'local-name-settings.json'), vaultFile = path.join(directory, 'local-name-cloud.vault')
  const key = randomBytes(32)
  const storage: AsyncSafeStorage = {
    async isAsyncEncryptionAvailable() { return true },
    async encryptStringAsync(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    },
    async decryptStringAsync(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28))
      return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false }
    },
  }
  const vault = new CredentialVault({ filePath: vaultFile, storage })
  let prompts = 0, joins = 0
  const native: LocalNameSecurePrompt = { async readSecret(context) { prompts++; return readSecret(context) }, async join() { joins++ }, async close() {} }
  const reopen = () => createLocalNameSettings({ file, vault: new CredentialVault({ filePath: vaultFile, storage }), securePrompt: native })
  const service = createLocalNameSettings({ file, vault, securePrompt: native })
  const context = (): LocalNameSettingsContext => ({ signal: signal(), assertCurrent() {} })
  return { file, vaultFile, vault, native, service, context, reopen, counts: () => ({ prompts, joins }) }
}
const settingsInput = (settings: dto.LocalNameSettings): dto.LocalNameSettingsInput => ({ expectedRevision: settings.revision,
  backend: settings.backend, ollama: { ...settings.ollama }, vllm: { ...settings.vllm }, cloud: { endpoint: settings.cloud.endpoint, model: settings.cloud.model } })

test('Main 名称设置保留原空 vLLM 默认，只有当前后端必须配置实际模型', async () => {
  const f = await settingsFixture(), value = await f.service.read(f.context()), input = settingsInput(value)
  assert.equal(value.vllm.model, ''); assert.equal(value.cloud.keyConfigured, false)
  assert.equal(await f.service.getConfiguration('vllm'), null)
  assert.equal(dto.isLocalNameSettingsPayload('name.settings.save', { commandId: randomUUID(), settings: input }), true)
  assert.equal(dto.isLocalNameSettingsPayload('name.settings.save', { commandId: randomUUID(), settings: { ...input, backend: 'vllm' } }), false)
  assert.equal(dto.isLocalNameSettingsPayload('name.settings.save', { commandId: randomUUID(), settings: { ...input, vllm: { ...input.vllm, endpoint: 'http://user:credential@127.0.0.1:8000' } } }), false)
  await f.service.close()
})

test('Main 名称设置完整 CAS 串行保存、冷回读并按原命令返回原结果', async () => {
  const f = await settingsFixture(), first = settingsInput(await f.service.read(f.context())), commandId = randomUUID()
  const original = { commandId, settings: { ...first, ollama: { ...first.ollama, model: 'synthetic-first-model' } } }
  const saved = await f.service.save(original, f.context())
  const rival = { commandId: randomUUID(), settings: { ...first, ollama: { ...first.ollama, model: 'synthetic-rival-model' } } }
  await assert.rejects(f.service.save(rival, f.context()), /版本已改变/u)
  const next = await f.service.save({ commandId: randomUUID(), settings: { ...settingsInput(saved), ollama: { ...saved.ollama, model: 'synthetic-next-model' } } }, f.context())
  assert.deepEqual(await f.service.save(original, f.context()), saved)
  await assert.rejects(f.service.save({ ...original, settings: { ...original.settings, backend: 'cloud' } }, f.context()), /正文不同/u)
  await f.service.close(); const cold = f.reopen()
  assert.deepEqual(await cold.read(f.context()), next); assert.deepEqual(await cold.save(original, f.context()), saved)
  assert.equal((await lstat(f.file)).mode & 0o777, 0o600)
  const competing = settingsInput(next), attempts = await Promise.allSettled([
    cold.save({ commandId: randomUUID(), settings: { ...competing, cloud: { ...competing.cloud, model: 'synthetic-a' } } }, f.context()),
    cold.save({ commandId: randomUUID(), settings: { ...competing, cloud: { ...competing.cloud, model: 'synthetic-b' } } }, f.context()),
  ])
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1); assert.equal(attempts.filter(item => item.status === 'rejected').length, 1)
  await cold.close()
})

test('Main 安全输入只写加密保险库，公开值和配置文件无密钥且新端点不继承密钥', async () => {
  const f = await settingsFixture(), original = { commandId: randomUUID(), backend: 'cloud' as const }
  assert.deepEqual(await f.service.securityPrompt(original, f.context()), { configured: true, cancelled: false })
  assert.deepEqual(await f.service.securityPrompt(original, f.context()), { configured: true, cancelled: false }); assert.equal(f.counts().prompts, 1)
  const publicValue = await f.service.read(f.context()), configured = await f.service.getConfiguration('cloud')
  assert.ok(configured); assert.equal(publicValue.cloud.keyConfigured, true)
  assert.equal(await f.service.resolveSecret('cloud', configured, signal()), 'synthetic-main-private-key')
  assert.doesNotMatch(JSON.stringify(publicValue) + await readFile(f.file, 'utf8'), /synthetic-main-private-key|"secret"/u)
  assert.equal((await readFile(f.vaultFile)).includes(Buffer.from('synthetic-main-private-key')), false)
  const input = settingsInput(publicValue), changed = await f.service.save({ commandId: randomUUID(), settings: { ...input, cloud: { ...input.cloud, endpoint: 'https://synthetic-other.invalid' } } }, f.context())
  assert.equal(changed.cloud.keyConfigured, false); assert.equal(await f.service.resolveSecret('cloud', configured, signal()), null)
  assert.deepEqual(await f.service.securityPrompt(original, f.context()), { configured: true, cancelled: false }); assert.equal(f.counts().prompts, 1)
  await f.service.close()
})

test('Main 安全输入真实取消回执冷读不重复弹窗，也不删除已有加密凭据', async () => {
  let cancel = false
  const f = await settingsFixture(async () => cancel ? null : 'synthetic-existing-key')
  await f.service.securityPrompt({ commandId: randomUUID(), backend: 'cloud' }, f.context()); cancel = true
  const original = { commandId: randomUUID(), backend: 'cloud' as const }, before = await readFile(f.vaultFile)
  assert.deepEqual(await f.service.securityPrompt(original, f.context()), { configured: false, cancelled: true })
  await f.service.close(); const cold = f.reopen()
  assert.deepEqual(await cold.securityPrompt(original, f.context()), { configured: false, cancelled: true })
  assert.equal(f.counts().prompts, 2); assert.deepEqual(await readFile(f.vaultFile), before)
  assert.equal((await cold.read(f.context())).cloud.keyConfigured, true); await cold.close()
})

test('Main 加密写入后回执未确认，冷恢复原命令而不重收密钥', async () => {
  const f = await settingsFixture(), command = { commandId: randomUUID(), backend: 'cloud' as const }
  let written = false
  const decorated = createLocalNameSettings({ file: f.file, securePrompt: f.native, vault: { read: () => f.vault.read(), async save(value) { await f.vault.save(value); written = true } } })
  const context: LocalNameSettingsContext = { signal: signal(), assertCurrent() { if (written) throw new Error('合成 Owner 已撤销') } }
  await assert.rejects(decorated.securityPrompt(command, context))
  const state = JSON.parse(await readFile(f.file, 'utf8')); assert.equal(state.security[0].state, 'pending')
  await decorated.close(); const cold = f.reopen()
  assert.deepEqual(await cold.securityPrompt(command, f.context()), { configured: true, cancelled: false })
  assert.equal(f.counts().prompts, 1); assert.equal(JSON.parse(await readFile(f.file, 'utf8')).security[0].state, 'configured')
  await cold.close(); await f.service.close()
})

test('Main 名称设置拒绝损坏 CAS 链和符号链接，不以默认值覆盖原件', async () => {
  const f = await settingsFixture(), input = settingsInput(await f.service.read(f.context()))
  await f.service.save({ commandId: randomUUID(), settings: input }, f.context()); await f.service.close()
  const state = JSON.parse(await readFile(f.file, 'utf8')); state.saves[0].input.ollama.model = 'tampered-original-body'
  await writeFile(f.file, JSON.stringify(state), { mode: 0o600 }); const corrupt = await readFile(f.file), cold = f.reopen()
  await assert.rejects(cold.read(f.context()), /无法完整冷回读/u); assert.deepEqual(await readFile(f.file), corrupt); await cold.close()
  const g = await settingsFixture(); await symlink(f.file, g.file)
  await assert.rejects(g.service.read(g.context()), /无法完整冷回读/u); assert.deepEqual(await readFile(f.file), corrupt); await g.service.close()
})
