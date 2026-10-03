import assert from 'node:assert/strict'
import test from 'node:test'
import { createCollectionReadonlyControlClient, type CollectionReadonlyControlPort } from '../src/main/collection-readonly-control-client.js'
class Port implements CollectionReadonlyControlPort {
  message?: (event: { data: unknown }) => void
  closed?: () => void
  posts: unknown[] = []
  closeCalls = 0
  on(event: 'message' | 'close', listener: ((event: { data: unknown }) => void) | (() => void)) { if (event === 'message') this.message = listener as (event: { data: unknown }) => void; else this.closed = listener as () => void }
  postMessage(value: unknown) { this.posts.push(value) }
  start() {}
  close() { this.closeCalls++ }
}
function fixture() {
  const port1 = new Port(), port2 = new Port(), parents: unknown[] = []
  const client = createCollectionReadonlyControlClient({ child: { postMessage(value, ports) { parents.push(value); assert.deepEqual(ports, [port1]) }, once() {} }, channel: { port1, port2 } })
  const reply = (patch: Record<string, unknown> = {}) => { const request = port2.posts.at(-1) as Record<string, unknown>; port2.message!({ data: { ...request, ok: true, status: { schemaVersion: 1, enabled: false, mode: 'node', state: 'off' }, ...patch } }) }
  return { client, port1, port2, parents, reply }
}
test('每代只绑定第二父消息，旧nonce/type/多字段拒绝，正确回复放行', async () => {
  const f = fixture(); const pending = f.client.getStatus()
  assert.equal(f.parents.length, 1); assert.equal((f.parents[0] as { type: string }).type, 'musicbridge.collection-readonly.port')
  f.reply({ generationNonce: '11111111-1111-4111-8111-111111111111' }); f.reply({ type: 'refresh' }); f.reply({ pin: '/private' }); f.reply()
  assert.equal((await pending).state, 'off'); f.client.close()
})
test('端口close拒绝pending且迟到不恢复，不再绑定', async () => {
  const f = fixture(); const pending = f.client.getStatus(); const rejected = assert.rejects(pending)
  f.port2.closed!(); await rejected; f.reply(); await assert.rejects(f.client.setEnabled(true)); assert.equal(f.parents.length, 1)
})
test('真实固定15秒预算后关闭当前代际，OFF不排队等ON', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); const on = f.client.setEnabled(true), off = f.client.setEnabled(false)
  assert.equal(f.port2.posts.length, 2)
  const rejected = Promise.all([assert.rejects(on), assert.rejects(off)])
  t.mock.timers.tick(15_000); await rejected; assert.equal(f.port2.closeCalls, 1); assert.equal(f.parents.length, 1)
})

test('同一代际刷新单航班，拒绝关闭后重新刷新', async () => {
  const f = fixture(), first = f.client.refresh(), second = f.client.refresh()
  assert.equal(first, second); assert.equal(f.port2.posts.length, 1)
  f.reply({ result: { refreshed: false, status: { schemaVersion: 1, enabled: false, mode: 'node', state: 'off' } }, status: undefined })
  // result回复不得多带status；上条无效，真实闭集回复才能结算。
  const request = f.port2.posts[0] as Record<string, unknown>
  f.port2.message!({ data: { ...request, ok: true, result: { refreshed: false, status: { schemaVersion: 1, enabled: false, mode: 'node', state: 'off' } } } })
  assert.equal((await first).refreshed, false); f.client.close(); await assert.rejects(f.client.refresh())
})

test('旧refresh跨OFF与新ON不能复用；旧回复和finally不清新航班', async () => {
  const f = fixture()
  const response = (at: number, payload: Record<string, unknown>) => {
    const request = f.port2.posts[at] as Record<string, unknown>
    f.port2.message!({ data: { schemaVersion: 1, generationNonce: request.generationNonce,
      requestId: request.requestId, type: request.type, ok: true, ...payload } })
  }
  const old = f.client.refresh(), off = f.client.setEnabled(false), on = f.client.setEnabled(true)
  void old.catch(() => {}); void off.catch(() => {}); void on.catch(() => {})
  const fresh = f.client.refresh(); void fresh.catch(() => {})
  try {
    assert.notEqual(fresh, old, '新意图必须发送新的refresh请求')
    assert.equal(f.port2.posts.length, 4)
    let freshSettled = false
    void fresh.then(() => { freshSettled = true }, () => { freshSettled = true })
    response(0, { result: { refreshed: false, status: { schemaVersion: 1, enabled: false, mode: 'node', state: 'off' } } })
    assert.equal((await old).refreshed, false); await Promise.resolve()
    assert.equal(freshSettled, false, '旧reply不得结算新请求')
    assert.equal(f.client.refresh(), fresh, '旧finally不得删除新单航班')
    response(1, { status: { schemaVersion: 1, enabled: false, mode: 'node', state: 'off' } })
    response(2, { status: { schemaVersion: 1, enabled: true, mode: 'rust', state: 'ready' } })
    response(3, { result: { refreshed: true, status: { schemaVersion: 1, enabled: true, mode: 'rust', state: 'ready' } } })
    await off; await on; assert.equal((await fresh).refreshed, true)
    assert.equal(f.parents.length, 1, '换意图不重连整个Core')
  } finally { f.client.close() }
})
