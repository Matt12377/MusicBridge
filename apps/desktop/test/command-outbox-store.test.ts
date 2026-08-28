import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { MAX_COLLECTION_PHOTO_BYTES, MAX_COMMAND_OUTBOX_ENTRIES, isCommandOutboxView } from '@music-bridge/contracts'

const moduleUrl = new URL('../src/main/command-outbox-store.ts', import.meta.url).href
async function api() {
  const value = await import('../src/main/command-outbox-store.js').catch(() => ({}))
  assert.ok('createCommandOutboxStore' in value, '缺少Main独立持久命令账本')
  return value as typeof import('../src/main/command-outbox-store.js')
}
function request() {
  return { datasetId: randomUUID(), command: 'collection.setPolicy' as const, payload: { commandId: randomUUID(), modelId: randomUUID(), expectedRevision: 1, collectorPolicy: 'normal' as const, minimumSealedReserve: 0 } }
}
function revocations(count = 3) {
  const datasetId = randomUUID()
  return Array.from({ length: count }, () => ({ datasetId, command: 'recordingPrepared.revoke' as const, payload: { commandId: randomUUID(), id: randomUUID() } }))
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'musicbridge-outbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'outbox.sqlite'), { createCommandOutboxStore } = await api()
  const store = createCommandOutboxStore({ filePath }); t.after(() => store.close())
  return { directory, filePath, store, createCommandOutboxStore }
}

for (const kind of ['text', 'empty', 'sqlite-empty', 'sqlite-foreign', 'sqlite-forged'] as const) {
  test(`拒绝未知已有${kind}文件且不改变字节或权限`, async t => {
    const f = await fixture(t)
    if (kind === 'text' || kind === 'empty') await writeFile(f.filePath, kind === 'text' ? '用户原始内容' : '')
    else { const db = new DatabaseSync(f.filePath); db.exec(kind === 'sqlite-empty' ? 'VACUUM' : 'CREATE TABLE foreign_data(value TEXT)'); if (kind === 'sqlite-forged') db.exec('PRAGMA application_id=1296192088; PRAGMA user_version=1'); db.close() }
    await chmod(f.filePath, 0o640)
    const before = await readFile(f.filePath), mode = (await stat(f.filePath)).mode
    assert.throws(() => f.store.list(), { code: 'OUTBOX_UNAVAILABLE' })
    assert.deepEqual(await readFile(f.filePath), before); assert.equal((await stat(f.filePath)).mode, mode)
  })
}

for (const kind of ['symlink', 'hardlink'] as const) {
  test(`拒绝${kind}账本，不改变原件`, async t => {
    const f = await fixture(t), original = path.join(f.directory, 'original')
    await writeFile(original, '原件')
    if (kind === 'symlink') await symlink(original, f.filePath); else await link(original, f.filePath)
    assert.throws(() => f.store.list(), { code: 'OUTBOX_UNAVAILABLE' })
    assert.equal(await readFile(original, 'utf8'), '原件')
  })
}

test('请求不可变且幂等，sending冷开变uncertain，公开视图不含私有请求与回执', async t => {
  const f = await fixture(t), input = request(), first = f.store.confirm(input)
  assert.equal(first.created, true)
  assert.equal(f.store.confirm(input).entry.id, first.entry.id)
  assert.throws(() => f.store.confirm({ ...input, datasetId: randomUUID() }), { code: 'OUTBOX_CONFLICT' })
  assert.throws(() => f.store.confirm({ ...input, payload: { ...input.payload, minimumSealedReserve: 1 } }), { code: 'OUTBOX_CONFLICT' })
  input.payload.minimumSealedReserve = 8
  assert.equal((f.store.get(first.entry.id).payload as typeof input.payload).minimumSealedReserve, 0)
  f.store.markSending(first.entry.id); f.store.close()
  const cold = f.createCommandOutboxStore({ filePath: f.filePath })
  try {
    assert.equal(cold.get(first.entry.id).state, 'uncertain')
    const view = cold.list()[0]!
    assert.ok(isCommandOutboxView(view))
    assert.equal('payload' in view, false); assert.equal('result' in view, false); assert.equal('fingerprint' in view, false)
    assert.equal((await stat(f.filePath)).mode & 0o777, 0o600)
  } finally { cold.close() }
})

test('完整受限照片DTO私有持久，越界/路径/凭据字段拒绝，公开view没有图片', async t => {
  const f = await fixture(t), image = Buffer.alloc(MAX_COLLECTION_PHOTO_BYTES, 1); image[0] = 255; image[1] = 216; image[2] = 255
  const photo = { datasetId: randomUUID(), command: 'collection.addPhoto' as const, payload: { commandId: randomUUID(), modelId: randomUUID(), image: { dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`, width: 1200, height: 1200 } } }
  const entry = f.store.confirm(photo).entry
  assert.deepEqual(f.store.get(entry.id).payload, photo.payload)
  assert.equal(JSON.stringify(f.store.list()).includes('data:image'), false)
  for (const extra of [{ absolutePath: '/private/合成' }, { credential: '合成禁用字段' }]) assert.throws(() => f.store.confirm({ ...photo, payload: { ...photo.payload, ...extra } } as never), { code: 'INVALID_IPC_REQUEST' })
  assert.throws(() => f.store.confirm({ ...photo, payload: { ...photo.payload, image: { ...photo.payload.image, width: 1201 } } }), { code: 'INVALID_IPC_REQUEST' })
  assert.throws(() => f.store.confirm({ ...photo, command: 'auth.setCredential', payload: { commandId: randomUUID(), credential: '合成' } } as never), { code: 'INVALID_IPC_REQUEST' })
})

test('合法照片可选undefined字段与省略等价，同命令不重复且回执跨重启可读', async t => {
  const f = await fixture(t)
  const omitted = { datasetId: randomUUID(), command: 'collection.addPhoto' as const, payload: { commandId: randomUUID(), modelId: randomUUID(), image: { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 } } }
  const explicit = { ...omitted, payload: { ...omitted.payload, physicalId: undefined } }
  const first = f.store.confirm(explicit)
  assert.equal(first.created, true)
  assert.deepEqual(f.store.get(first.entry.id).payload, omitted.payload)
  assert.equal(f.store.confirm(omitted).entry.id, first.entry.id)
  assert.equal(f.store.confirm(explicit).created, false)
  assert.throws(() => f.store.confirm({ ...explicit, payload: { ...explicit.payload, absolutePath: undefined } } as never), { code: 'INVALID_IPC_REQUEST' })
  f.store.markSending(first.entry.id)
  const result = { modelId: omitted.payload.modelId }
  f.store.succeed(first.entry.id, result); f.store.close()
  const cold = f.createCommandOutboxStore({ filePath: f.filePath })
  try {
    assert.equal(cold.confirm(omitted).entry.id, first.entry.id)
    assert.deepEqual(cold.get(first.entry.id).result, result)
    assert.equal(cold.get(first.entry.id).state, 'succeeded')
    assert.equal(cold.list().length, 1)
  } finally { cold.close() }
})

test('总照片容量有界，拒绝新项不丢失未确认项且不修改已有DTO', { timeout: 30_000 }, async t => {
  const f = await fixture(t), image = Buffer.alloc(MAX_COLLECTION_PHOTO_BYTES, 1); image[0] = 255; image[1] = 216; image[2] = 255
  const photo = { datasetId: randomUUID(), command: 'collection.addPhoto' as const, payload: { commandId: randomUUID(), modelId: randomUUID(), image: { dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`, width: 1, height: 1 } } }
  let count = 0, limited = false
  for (; count < 60; count++) {
    try { f.store.confirm({ ...photo, payload: { ...photo.payload, commandId: randomUUID() } }) }
    catch (error) { assert.equal((error as { code: string }).code, 'OUTBOX_LIMIT_EXCEEDED'); limited = true; break }
  }
  assert.equal(limited, true); assert.equal(f.store.list().length, count)
  assert.ok(f.store.list().every(view => view.state === 'pending'))
})

test('全部未确认记录达到数量上限仍明确拒绝，不清理任何待确认项', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  for (let index = 0; index < MAX_COMMAND_OUTBOX_ENTRIES; index++) f.store.confirm(request())
  assert.throws(() => f.store.confirm(request()), { code: 'OUTBOX_LIMIT_EXCEEDED' })
  assert.equal(f.store.list().length, MAX_COMMAND_OUTBOX_ENTRIES)
})

test('累计超过1000项已确认历史仍可新写，仅容量不足时最旧终态腾空间', { timeout: 30_000 }, async t => {
  const f = await fixture(t), ids: string[] = []
  for (let index = 0; index < MAX_COMMAND_OUTBOX_ENTRIES; index++) {
    const input = request(), entry = f.store.confirm(input).entry; ids.push(entry.id)
    if (index % 2) f.store.dismiss(entry.id)
    else { f.store.markSending(entry.id); f.store.succeed(entry.id, { modelId: input.payload.modelId }); f.store.ack(entry.id) }
  }
  assert.equal(f.store.list().length, MAX_COMMAND_OUTBOX_ENTRIES, 'ack/dismiss本身不能立即清理历史')
  for (let index = 0; index < 12; index++) f.store.confirm(request())
  assert.equal(f.store.list().length, MAX_COMMAND_OUTBOX_ENTRIES)
  for (const id of ids.slice(0, 12)) assert.throws(() => f.store.get(id), { code: 'OUTBOX_CONFLICT' })
  assert.equal(f.store.get(ids[12]!).id, ids[12])
})

test('容量清理不删除pending/sending/uncertain/未ack成功/rejected，清理不足整体回滚', async t => {
  const f = await fixture(t), protectedIds: string[] = []
  for (const state of ['pending', 'sending', 'uncertain', 'succeeded', 'rejected']) {
    const input = request(), id = f.store.confirm(input).entry.id; protectedIds.push(id)
    if (state === 'sending' || state === 'succeeded' || state === 'rejected') f.store.markSending(id)
    if (state === 'uncertain') f.store.markUncertain(id)
    if (state === 'succeeded') f.store.succeed(id, { modelId: input.payload.modelId })
    if (state === 'rejected') f.store.reject(id, 'INVENTORY_CONFLICT')
  }
  const removable = f.store.confirm(request()).entry.id; f.store.dismiss(removable)
  for (let count = protectedIds.length + 1; count < MAX_COMMAND_OUTBOX_ENTRIES; count++) f.store.confirm(request())
  const snapshot = protectedIds.map(id => f.store.get(id))
  f.store.confirm(request()); assert.throws(() => f.store.get(removable), { code: 'OUTBOX_CONFLICT' })
  assert.deepEqual(protectedIds.map(id => f.store.get(id)), snapshot)
  assert.throws(() => f.store.confirm(request()), { code: 'OUTBOX_LIMIT_EXCEEDED' })
  assert.deepEqual(protectedIds.map(id => f.store.get(id)), snapshot)
})

test('照片满容量只释放已放弃项的私有payload，不碰未确认照片', { timeout: 30_000 }, async t => {
  const f = await fixture(t), image = Buffer.alloc(MAX_COLLECTION_PHOTO_BYTES, 1); image[0] = 255; image[1] = 216; image[2] = 255
  const tiny = f.store.confirm(request()).entry.id; f.store.dismiss(tiny)
  const photo = { datasetId: randomUUID(), command: 'collection.addPhoto' as const, payload: { commandId: randomUUID(), modelId: randomUUID(), image: { dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`, width: 1, height: 1 } } }
  const ids: string[] = []
  while (ids.length < 60) {
    try { ids.push(f.store.confirm({ ...photo, payload: { ...photo.payload, commandId: randomUUID() } }).entry.id) }
    catch (error) { assert.equal((error as { code: string }).code, 'OUTBOX_LIMIT_EXCEEDED'); break }
  }
  assert.equal(f.store.get(tiny).state, 'dismissed', '删除小项仍不足以写入照片时，删除必须随事务回滚')
  assert.equal(f.store.list().length, ids.length + 1)
  const first = ids[0]!, second = ids[1]!, before = f.store.get(second)
  f.store.dismiss(first); assert.equal(f.store.get(first).state, 'dismissed')
  const added = f.store.confirm({ ...photo, payload: { ...photo.payload, commandId: randomUUID() } }).entry
  assert.equal(added.state, 'pending'); assert.throws(() => f.store.get(first), { code: 'OUTBOX_CONFLICT' })
  assert.throws(() => f.store.get(tiny), { code: 'OUTBOX_CONFLICT' })
  assert.deepEqual(f.store.get(second), before); assert.equal(f.store.list().length, ids.length)
})

test('已知schema1安全迁移保留请求和回执，schema2删除护栏阻止未确认项删除', async t => {
  const f = await fixture(t), input = request(), id = f.store.confirm(input).entry.id
  f.store.markSending(id); f.store.succeed(id, { modelId: input.payload.modelId }); const before = f.store.get(id); f.store.close()
  const legacy = new DatabaseSync(f.filePath)
  legacy.exec("DROP TRIGGER outbox_entries_no_delete; CREATE TRIGGER outbox_entries_no_delete BEFORE DELETE ON outbox_entries BEGIN SELECT RAISE(ABORT,'操作确认不可删除'); END; PRAGMA user_version=1;")
  legacy.close()
  const migrated = f.createCommandOutboxStore({ filePath: f.filePath })
  try { assert.deepEqual(migrated.get(id), before) } finally { migrated.close() }
  const inspection = new DatabaseSync(f.filePath)
  try {
    assert.equal(inspection.prepare('PRAGMA user_version').get()?.user_version, 2)
    assert.throws(() => inspection.prepare('DELETE FROM outbox_entries WHERE id=?').run(id))
    assert.equal(inspection.prepare('SELECT count(*) n FROM outbox_states').get()?.n, 1)
  } finally { inspection.close() }
})

test('PREP批量确认先验证整批，尾项冲突不持久化前项', async t => {
  const f = await fixture(t), batch = revocations(), prior = f.store.confirm(batch[2]!).entry
  assert.equal(typeof f.store.confirmBatch, 'function', '缺少整批原子确认入口')
  assert.throws(() => f.store.confirmBatch([batch[0]!, batch[1]!, { ...batch[2]!, payload: { ...batch[2]!.payload, id: randomUUID() } }]), { code: 'OUTBOX_CONFLICT' })
  assert.deepEqual(f.store.list().map(entry => entry.id), [prior.id])
  const accepted = f.store.confirmBatch(batch)
  assert.deepEqual(accepted.map(item => item.created), [true, true, false])
  assert.equal(f.store.list().length, 3)
  assert.deepEqual(f.store.confirmBatch(batch).map(item => item.entry.id), accepted.map(item => item.entry.id))
})

test('批量仅接受1至3项同scope不同命令编号和目标的PREP撤权，坏尾项不留前项', async t => {
  const f = await fixture(t), batch = revocations()
  assert.equal(typeof f.store.confirmBatch, 'function', '缺少受限批量校验入口')
  const invalid = [[], Array(1), revocations(4), [batch[0]!, { ...batch[1]!, datasetId: randomUUID() }],
    [batch[0]!, { ...batch[1]!, payload: { ...batch[1]!.payload, commandId: batch[0]!.payload.commandId } }],
    [batch[0]!, { ...batch[1]!, payload: { ...batch[1]!.payload, id: batch[0]!.payload.id } }],
    [batch[0]!, request()], [batch[0]!, { ...batch[1]!, payload: { ...batch[1]!.payload, absolutePath: undefined } }]]
  for (const value of invalid) {
    assert.throws(() => f.store.confirmBatch(value as never), { code: 'INVALID_IPC_REQUEST' })
    assert.equal(f.store.list().length, 0)
  }
})

test('批量末项容量不足时前项与已执行的终态清理一并回滚', async t => {
  const f = await fixture(t)
  const removable = f.store.confirm(request()).entry.id; f.store.dismiss(removable)
  for (let index = 1; index < MAX_COMMAND_OUTBOX_ENTRIES; index++) f.store.confirm(request())
  assert.equal(typeof f.store.confirmBatch, 'function')
  assert.throws(() => f.store.confirmBatch(revocations(2)), { code: 'OUTBOX_LIMIT_EXCEEDED' })
  assert.equal(f.store.get(removable).state, 'dismissed')
  assert.equal(f.store.list().length, MAX_COMMAND_OUTBOX_ENTRIES)
})

test('批量容量清理保留本批复用的已确认成功回执，只清其他终态', async t => {
  const f = await fixture(t), batch = revocations(2), original = f.store.confirm(batch[0]!).entry
  f.store.markSending(original.id)
  f.store.succeed(original.id, { id: batch[0]!.payload.id, preparationId: randomUUID(), side: 'A', label: '合成PREP', authorized: false })
  f.store.ack(original.id)
  const removable = f.store.confirm(request()).entry.id; f.store.dismiss(removable)
  for (let index = 2; index < MAX_COMMAND_OUTBOX_ENTRIES; index++) f.store.confirm(request())
  const accepted = f.store.confirmBatch(batch)
  assert.equal(accepted[0]!.entry.id, original.id); assert.equal(accepted[0]!.created, false)
  assert.equal(f.store.get(original.id).state, 'succeeded')
  assert.throws(() => f.store.get(removable), { code: 'OUTBOX_CONFLICT' })
})

test('同进程生命周期排他，第二实例失败与close不释放第一实例锁', async t => {
  const f = await fixture(t), id = f.store.confirm(request()).entry.id
  const second = f.createCommandOutboxStore({ filePath: f.filePath })
  assert.throws(() => second.list(), { code: 'OUTBOX_UNAVAILABLE' }); second.close()
  assert.equal(f.store.get(id).state, 'pending')
  f.store.close(); const next = f.createCommandOutboxStore({ filePath: f.filePath })
  try { assert.equal(next.get(id).id, id) } finally { next.close() }
})

test('跨进程锁不误抢存活Main，实际SIGKILL后恢复已提交在途记录', { timeout: 15_000 }, async t => {
  const f = await fixture(t), id = f.store.confirm(request()).entry.id; f.store.close()
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { createCommandOutboxStore } from ${JSON.stringify(moduleUrl)};
    const store = createCommandOutboxStore({filePath:process.argv[1]}); store.markSending(process.argv[2]);
    process.send('ready'); setInterval(()=>{},1000);
  `, f.filePath, id], { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done } })
  const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('子进程未持有账本') })]); assert.equal(ready[0], 'ready')
  const contender = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { createCommandOutboxStore } from ${JSON.stringify(moduleUrl)};
    const store=createCommandOutboxStore({filePath:process.argv[1]});
    try { store.list(); process.stdout.write('unexpected'); } catch(e) { process.stdout.write(e.code); } finally { store.close(); }
  `, f.filePath], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 7000 })
  assert.equal(contender.status, 0, contender.stderr); assert.equal(contender.stdout, 'OUTBOX_UNAVAILABLE')
  const done = once(child, 'exit'); child.kill('SIGKILL'); await done
  const recovered = f.createCommandOutboxStore({ filePath: f.filePath })
  try { assert.equal(recovered.get(id).state, 'uncertain') } finally { recovered.close() }
})
