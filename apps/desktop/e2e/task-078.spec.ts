import { testElectronArguments } from '../scripts/test-keychain.mjs'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, realpath, readFile, readdir, rename, rm, lstat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { TestContext } from 'node:test'
import type { BackupJobView, CollectionCounts, CollectionDetail, RecordingReplicaInspection } from '@music-bridge/contracts'
import { recordingRecordFixture } from '../../../packages/bridge-core/test/helpers/recording-record-fixture.js'
import { createRecordingRecordCoordinator } from '../../../packages/bridge-core/src/recording/record-coordinator.js'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const pageRequest = { offset: 0, limit: 25 }
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const countsBefore: CollectionCounts = { total: 7, sealedBlank: 5, openedBlank: 1, legacyUsed: 0, recorded: 1, reserved: 0, unavailable: 0, unknown: 0 }
const countsAfter: CollectionCounts = { ...countsBefore, openedBlank: 0, recorded: 2 }

// 只读取自建数据库的这些业务表；恢复允许撤销路径能力，但不允许重写库存、档案、打印字节或完成回执。
const preservedTables = [
  'collection_models', 'collection_skus', 'inventory_lots', 'physical_sequences', 'physical_copies', 'inventory_ledger',
  'recording_records', 'recording_record_current', 'recording_record_events', 'recording_record_permits', 'recording_record_receipts',
  'master_artwork_versions', 'master_artwork_current', 'recording_print_objects', 'recording_print_requests',
  'recording_print_jobs', 'recording_print_events', 'recording_print_artifacts', 'recording_print_receipts',
] as const

async function databaseFacts(file: string) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = Object.fromEntries(preservedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { bytesBase64: Buffer.from(value).toString('base64') } : value])),
    )]))
    return { schema: db.prepare('PRAGMA user_version').get()?.user_version, tables }
  } finally { db.close() }
}

async function pendingPrintFacts(file: string, recordingId: string) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db.prepare('SELECT j.id, j.request_id, j.data, j.lease, r.recording_id, r.data AS request_data FROM recording_print_jobs j JOIN recording_print_requests r ON r.id=j.request_id WHERE r.recording_id=?').all(recordingId) as Array<{ id: string; request_id: string; data: string; lease: string | null; recording_id: string; request_data: string }>
    if (rows.length !== 1) throw new Error(`Main启动前打印job数量错误：${rows.length}`)
    const row = rows[0]!
    const events = db.prepare('SELECT revision, kind, data, previous_hash, event_hash FROM recording_print_events WHERE job_id=? ORDER BY revision').all(row.id)
    return {
      jobId: row.id,
      jobRequestId: row.request_id,
      requestRecordingId: row.recording_id,
      job: JSON.parse(row.data) as Record<string, unknown>,
      request: JSON.parse(row.request_data) as Record<string, unknown>,
      currentLease: row.lease,
      events,
      artifactCount: Number(db.prepare('SELECT count(*) AS count FROM recording_print_artifacts WHERE request_id=?').get(row.request_id)?.count),
      completeReceiptCount: Number(db.prepare("SELECT count(*) AS count FROM recording_print_receipts WHERE kind='complete'").get()?.count),
    }
  } finally { db.close() }
}

async function printPersistenceFacts(file: string, jobId: string) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T
  try {
    const jobRow = db.prepare('SELECT request_id, data, lease FROM recording_print_jobs WHERE id=?').get(jobId) as { request_id: string; data: string; lease: string | null } | undefined
    if (!jobRow) throw new Error('测试打印job不存在')
    const job = parse<Record<string, unknown>>(jobRow.data)
    const events = (db.prepare('SELECT revision, kind, data, previous_hash, event_hash FROM recording_print_events WHERE job_id=? ORDER BY revision').all(jobId) as Array<{ revision: number; kind: string; data: string; previous_hash: string; event_hash: string }>).map(row => ({
      revision: row.revision,
      kind: row.kind,
      data: parse<{ job: Record<string, unknown>; lease: Record<string, unknown> | null }>(row.data),
      previousHash: row.previous_hash,
      eventHash: row.event_hash,
    }))
    const claim = events.find(event => event.kind === 'claim')
    if (!claim?.data.lease) throw new Error('测试打印claim事件不存在')
    const requestRow = db.prepare('SELECT recording_id, data, facts FROM recording_print_requests WHERE id=?').get(jobRow.request_id) as { recording_id: string; data: string; facts: string } | undefined
    if (!requestRow) throw new Error('测试打印request不存在')
    const artifactId = String(job.artifactId ?? '')
    const artifactRow = db.prepare('SELECT request_id, pdf_sha, preview_sha, data FROM recording_print_artifacts WHERE id=?').get(artifactId) as { request_id: string; pdf_sha: string; preview_sha: string; data: string } | undefined
    if (!artifactRow) throw new Error('测试打印artifact不存在')
    const receiptId = `lease:${String(claim.data.lease.leaseId)}`
    const receiptRow = db.prepare('SELECT kind, fingerprint, request, result FROM recording_print_receipts WHERE id=?').get(receiptId) as { kind: string; fingerprint: string; request: string; result: string } | undefined
    if (!receiptRow) throw new Error('测试打印complete receipt不存在')
    const object = (sha: string) => {
      const row = db.prepare('SELECT mime, content, width, height FROM recording_print_objects WHERE sha256=?').get(sha) as { mime: string; content: Uint8Array; width: number | null; height: number | null } | undefined
      if (!row) throw new Error(`测试打印对象不存在：${sha}`)
      const bytes = Buffer.from(row.content)
      return { sha256: sha, mime: row.mime, size: bytes.length, bytesSha256: sha256(bytes), width: row.width, height: row.height }
    }
    return {
      jobId,
      requestId: jobRow.request_id,
      jobRequestId: jobRow.request_id,
      requestRecordingId: requestRow.recording_id,
      artifactRequestId: artifactRow.request_id,
      job,
      request: parse<Record<string, unknown>>(requestRow.data),
      facts: parse<Record<string, unknown>>(requestRow.facts),
      events,
      claim: claim.data.lease,
      receipt: { id: receiptId, kind: receiptRow.kind, fingerprint: receiptRow.fingerprint, request: parse<Record<string, unknown>>(receiptRow.request), result: parse<Record<string, unknown>>(receiptRow.result) },
      artifact: parse<Record<string, unknown>>(artifactRow.data),
      pdfObject: object(artifactRow.pdf_sha),
      previewObject: object(artifactRow.preview_sha),
      currentLease: jobRow.lease,
    }
  } finally { db.close() }
}

async function directoryHashes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name)
      expect(entry.isSymbolicLink(), '合成归档不允许链接').toBe(false)
      if (entry.isDirectory()) await visit(child)
      else { expect(entry.isFile()).toBe(true); result[child] = sha256(await readFile(path.join(directory, child))) }
    }
  }
  await visit('')
  return result
}

function historicalInspection(value: RecordingReplicaInspection) {
  // fingerprint绑定本次位置和授权，恢复后必须重新确认；历史身份和音频事实保持不变。
  const { readId: _readId, checkedAt: _checkedAt, fingerprint: _fingerprint, ...identity } = value
  return identity
}

test('V3同数据集7盘：幂等Completed、Replica历史核验、真实J-Card与完整备份激活冷启守恒', async () => {
  test.setTimeout(240_000)
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-ui-e2e-v3-chain-')))
  const cleanups: Array<() => void | Promise<void>> = []
  const context = { after: (fn: () => void | Promise<void>) => { cleanups.push(fn) } } as unknown as TestContext
  let app: ElectronApplication | undefined, page!: Page
  const close = async () => { const current = app; app = undefined; await current?.close() }
  async function launch() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MUSIC_BRIDGE_|NETEASE_|ROON_)/u.test(key))) as Record<string, string>
    // 此链只验合成业务，使用Chromium内存钥匙串；真实系统钥匙串/普通Quit另列R021，不以此PASS替代。
    app = await electron.launch({ timeout: 150_000, args: testElectronArguments([path.join(desktopRoot, 'dist/main/index.js')], 'mock'), cwd: desktopRoot, env: { ...env, MUSIC_BRIDGE_UI_E2E: '1', MUSIC_BRIDGE_CORE_TEST_MODE: '1', MUSIC_BRIDGE_UI_E2E_USER_DATA_DIR: directory } })
    expect(await app.evaluate(({ app, session }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), storage: session.defaultSession.getStoragePath() }))).toEqual({ userData: directory, sessionData: directory, storage: directory })
    page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#home-heading')).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime, { timeout: 30_000 }).toBe('ready')
  }
  async function chooseDirectory(folder: string, kind: 'backup-destination' | 'restore-destination') {
    // 唯一原生替身只返回本测试创建的目录；不替换任何IPC、Core、备份或渲染处理器。
    await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, folder)
    const root = await page.evaluate(request => window.musicBridge.chooseBackupRoot(request), { commandId: randomUUID(), kind })
    expect(root).not.toBeNull(); expect(root).toMatchObject({ kind, authorized: true })
    expect(await readdir(folder)).toEqual([])
    return root!
  }
  async function completedJob(id: string): Promise<BackupJobView> {
    await expect.poll(async () => {
      const current = (await page.evaluate(() => window.musicBridge.getBackupOverview())).jobs.find(job => job.id === id)
      if (current && ['failed', 'cancelled', 'interrupted'].includes(current.state)) throw new Error(`合成备份链失败：${current.kind}/${current.state}/${current.issue}`)
      return current?.state
    }, { timeout: 60_000 }).toBe('succeeded')
    const job = (await page.evaluate(() => window.musicBridge.getBackupOverview())).jobs.find(item => item.id === id)!
    expect(job).toMatchObject({ id, state: 'succeeded' }); expect(job.summary).toBeDefined()
    return job
  }

  try {
    await mkdir(test.info().outputDir, { recursive: true })
    let before: CollectionDetail | undefined, modelId = '', legacyId = ''
    // U03是同fixture预留前的真实Core观察；私有Fake仅提供完成前置，绝不是从UI录制过真实磁带。
    const f = await recordingRecordFixture(context, 'cassette', {
      stockQuantities: { sealedBlank: 5, openedBlank: 1, legacyUsed: 1, unclassified: 0 },
      afterReceive(repository) {
        const collection = repository.list(pageRequest)
        expect(collection.total).toBe(1); modelId = collection.items[0]!.id
        const initial = repository.detail(modelId, pageRequest)
        expect(initial.model.counts.total).toBe(7); expect(initial.copies.total).toBe(0)
        expect(initial.lots.total).toBe(1)
        const registered = repository.materialize({ commandId: randomUUID(), lotId: initial.lots.items[0]!.id, bucket: 'legacyUsed', action: 'register-legacy' })
        legacyId = registered.physicalId!
        before = repository.detail(modelId, pageRequest)
        expect(before.model.counts).toEqual(countsBefore)
        expect(before.copies.total).toBe(1)
        expect(before.copies.items[0]).toMatchObject({ physicalId: legacyId, usage: 'recorded', origin: 'legacy-registration' })
      },
    })
    expect(before).toBeDefined()
    const sourceBefore = await readFile(f.file), archiveBefore = await directoryHashes(f.root.root.path)
    const pending = await f.readyForFinal(), completed = await f.attempts.confirm(pending.request)
    expect(completed.status).toBe('completed')
    const afterFirst = f.repository.detail(modelId, pageRequest)
    expect(afterFirst.model.counts).toEqual(countsAfter); expect(afterFirst.copies.total).toBe(2)
    expect(await f.attempts.confirm(pending.request)).toEqual(completed)
    expect(f.repository.detail(modelId, pageRequest)).toEqual(afterFirst)
    const records = createRecordingRecordCoordinator({ store: f.repository.recordingRecords, assertCurrent: () => {}, assertExecutionIdle: () => f.attempts.assertExecutionIdle() })
    cleanups.push(() => records.close())
    const list = records.list({ page: pageRequest }); expect(list.total).toBe(1)
    const detail = records.get({ id: list.items[0]!.id }).record!, recordingId = detail.record.id, physicalId = detail.record.completion.physicalId
    expect(physicalId).not.toBe(legacyId)
    expect(detail.record.schemaVersion).toBe(2); expect(detail.record.completion.id).toBe(completed.id)
    expect(detail.plan.physicalCopy.physicalId).toBe(physicalId)
    const data = path.join(directory, 'data'), database = path.join(data, 'collection.v1.sqlite')
    await mkdir(data)
    f.repository.recordingRecords.read(db => db.prepare('VACUUM INTO ?').run(database))
    const printBeforeWorker = await pendingPrintFacts(database, recordingId)
    expect(printBeforeWorker).toMatchObject({ jobRequestId: printBeforeWorker.request.id, requestRecordingId: recordingId, currentLease: null, artifactCount: 0, completeReceiptCount: 0,
      job: { id: printBeforeWorker.jobId, request: printBeforeWorker.request, state: 'pending', revision: 1, artifactId: null, errorCode: null } })
    expect(printBeforeWorker.events).toHaveLength(1)
    expect(printBeforeWorker.events[0]).toMatchObject({ revision: 1, kind: 'create', previous_hash: '', data: expect.any(String), event_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(JSON.parse(String(printBeforeWorker.events[0]!.data))).toEqual({ job: printBeforeWorker.job, lease: null })
    await writeFile(test.info().outputPath('u03-u05-private-fixture.json'), JSON.stringify({ evidence: 'same-synthetic-seven-stock-core-before-reservation-and-private-driver-completion-not-real-device-or-ui-recording', before, after: afterFirst, completed, recordingId, physicalId, legacyId }, null, 2), { flag: 'wx' })
    await launch()

    async function verifyInventoryAndRecord() {
      const collection = await page.evaluate(request => window.musicBridge.listCollection(request), pageRequest)
      expect(collection.total).toBe(1); expect(collection.items[0]!.id).toBe(modelId); expect(collection.items[0]!.counts).toEqual(countsAfter)
      const model = await page.evaluate(input => window.musicBridge.getCollectionModel(input.id, input.page), { id: modelId, page: pageRequest })
      expect(model.copies.total).toBe(2)
      expect(model.copies.items.map(copy => copy.physicalId).sort()).toEqual([physicalId, legacyId].sort())
      expect(model.copies.items.find(copy => copy.physicalId === physicalId)).toMatchObject({ origin: 'blank-pool', usage: 'recorded', recordingState: { state: 'confirmed-recording', recordingId } })
      expect(model.copies.items.find(copy => copy.physicalId === legacyId)).toMatchObject({ origin: 'legacy-registration', usage: 'recorded' })
      const music = await page.evaluate(request => window.musicBridge.listPhysicalMusic(request), pageRequest)
      expect(music.total).toBe(2); expect(music.items.map(entry => entry.id).sort()).toEqual([physicalId, legacyId].sort())
      expect(music.items.every(entry => entry.kind === 'personal-cassette' && entry.quantity === 1 && entry.modelId === modelId)).toBe(true)
      expect(music.items.filter(entry => entry.contentStatus === 'commercial')).toEqual([])
      expect(music.items.filter(entry => entry.contentStatus === 'formal')).toHaveLength(1)
      const history = await page.evaluate(request => window.musicBridge.listRecordingRecords(request), { page: pageRequest })
      expect(history.total).toBe(1); expect(history.items[0]!.id).toBe(recordingId)
      expect((await page.evaluate(id => window.musicBridge.getRecordingRecord(id), recordingId)).record!.record).toEqual(detail.record)
      const attempts = await page.evaluate(request => window.musicBridge.listRecordingAttempts(request), { page: pageRequest })
      expect(attempts.total).toBe(1); expect(attempts.items[0]).toMatchObject({ id: completed.id, status: 'completed' })
      return { collection, model, music }
    }
    const appFacts = await verifyInventoryAndRecord()
    const printList = () => page.evaluate(request => window.musicBridge.listRecordingPrints(request), { recordingId, page: pageRequest })
    await expect.poll(async () => {
      const job = (await printList()).items[0]
      if (job?.state === 'failed') throw new Error(`合成J-Card生成失败：${job.errorCode}`)
      return job?.state
    }, { timeout: 65_000 }).toBe('ready')
    const printsBefore = await printList(), job = printsBefore.items[0]!
    expect(printsBefore.total).toBe(1); expect(job.request.origin).toBe('completion')
    const artifactId = job.artifactId!, printRequest = { recordingId, artifactId }
    const print = await page.evaluate(request => window.musicBridge.getRecordingPrint(request), printRequest)
    expect(print.facts.physicalId).toBe(physicalId); expect(print.facts.recordingContentHash).toBe(detail.record.contentHash)
    expect(print.facts.planContentHash).toBe(detail.plan.contentHash)
    expect(print.artifact.rendererVersion).toContain('preview2')
    expect(print.artifact.geometry).toMatchObject({ widthMm: 103.1875, heightMm: 101.6, widthPt: 292.5, heightPt: 288 })
    const exported = path.join(directory, '同一七盘档案.pdf')
    await app!.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog }, exported)
    expect(await page.evaluate(request => window.musicBridge.exportRecordingPrint(request), { ...printRequest, expectedPdfSha256: print.artifact.pdfSha256 })).toEqual({ state: 'exported', artifactId, pdfSha256: print.artifact.pdfSha256, size: print.artifact.size })
    const pdf = await readFile(exported)
    expect(sha256(pdf)).toBe(print.artifact.pdfSha256); expect(pdf.length).toBe(print.artifact.size); expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const printPersistence = await printPersistenceFacts(database, job.id)
    expect(printPersistence.events.map(event => [event.revision, event.kind, event.data.job.state, event.data.lease === null])).toEqual([
      [1, 'create', 'pending', true],
      [2, 'claim', 'rendering', false],
      [3, 'complete', 'ready', true],
    ])
    expect(printPersistence.events.map(event => event.previousHash)).toEqual(['', printPersistence.events[0]!.eventHash, printPersistence.events[1]!.eventHash])
    expect(printPersistence.events.map(event => event.data.job.request)).toEqual([job.request, job.request, job.request])
    expect(printPersistence.events.map(event => [event.data.job.id, event.data.job.revision])).toEqual([[job.id, 1], [job.id, 2], [job.id, 3]])
    expect(printPersistence.events[2]!.data.job).toEqual(job)
    expect(printPersistence.claim).toMatchObject({ jobId: job.id, requestId: job.request.id, inputHash: job.request.inputHash })
    expect(printPersistence.claim.leaseId).toMatch(/^[0-9a-f-]{36}$/u); expect(printPersistence.claim.workerId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(printPersistence.receipt).toMatchObject({ id: `lease:${String(printPersistence.claim.leaseId)}`, kind: 'complete', request: {
      leaseId: printPersistence.claim.leaseId, workerId: printPersistence.claim.workerId, jobId: job.id, inputHash: job.request.inputHash,
      pdfSha256: print.artifact.pdfSha256, pageCount: print.artifact.pageCount, rendererVersion: print.artifact.rendererVersion,
    }, result: { id: job.id, state: 'ready', revision: 3, artifactId } })
    expect(printPersistence.jobRequestId).toBe(job.request.id); expect(printPersistence.requestRecordingId).toBe(recordingId); expect(printPersistence.artifactRequestId).toBe(job.request.id)
    expect(printPersistence.job).toEqual(job); expect(printPersistence.request).toEqual(job.request); expect(printPersistence.receipt.result).toEqual(job); expect(printPersistence.artifact).toEqual(print.artifact)
    expect(printPersistence.artifact).toMatchObject({ requestId: job.request.id, recordingId, inputHash: job.request.inputHash, templateId: job.request.templateId, templateHash: job.request.templateHash })
    expect(printPersistence.currentLease).toBeNull()
    expect(printPersistence.pdfObject).toEqual({ sha256: print.artifact.pdfSha256, mime: 'application/pdf', size: pdf.length, bytesSha256: sha256(pdf), width: null, height: null })
    expect(printPersistence.previewObject).toMatchObject({ sha256: print.artifact.previewSha256, mime: 'image/jpeg', size: print.artifact.previewSize, bytesSha256: print.artifact.previewSha256 })
    await writeFile(test.info().outputPath('same-dataset-print-chain.json'), JSON.stringify({ beforeMain: printBeforeWorker, afterMain: printPersistence }, null, 2), { flag: 'wx' })
    expect(JSON.parse(await readFile(test.info().outputPath('same-dataset-print-chain.json'), 'utf8'))).toMatchObject({ beforeMain: { jobId: job.id, artifactCount: 0 }, afterMain: { jobId: job.id, artifact: { id: artifactId, pdfSha256: print.artifact.pdfSha256 } } })
    await writeFile(test.info().outputPath('same-dataset-j-card.pdf'), pdf, { flag: 'wx' })
    await writeFile(test.info().outputPath('same-dataset-preview.jpg'), Buffer.from(print.preview.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64'), { flag: 'wx' })
    const inspect = () => page.evaluate(request => window.musicBridge.inspectRecordingReplica(request), { readId: randomUUID(), recordingId })
    const inspection = await inspect()
    expect(inspection).toMatchObject({ recordingId, recordingContentHash: detail.record.contentHash, playback: 'blocked', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' })
    expect(inspection.targets.map(target => [target.target, target.side, target.state])).toEqual([['actual-execution', 'A', 'verified'], ['actual-execution', 'B', 'verified']])
    for (const target of inspection.targets) {
      if (target.state !== 'verified') throw new Error('实际历史音频未核验')
      const expected = detail.plan.execution.audio.find(audio => audio.recipe.side === target.side)!
      expect(target.audio.fileSha256).toBe(expected.audio.sha256); expect(target.audio.pcmSha256).toBe(expected.audio.pcmSha256)
    }
    const runId = randomUUID()
    await expect(page.evaluate(request => window.musicBridge.startRecordingReplica(request), { runId, recordingId, target: 'actual-execution' as const, side: 'A' as const, expectedFingerprint: inspection.fingerprint, userConfirmed: true as const })).rejects.toThrow(/NOT_READY/u)
    expect(await page.evaluate(id => window.musicBridge.getRecordingReplicaRun(id), runId)).toEqual({ run: null })
    const stableFacts = await databaseFacts(database)
    expect(stableFacts.schema).toBe(21)

    const backupDirectory = path.join(directory, '完整备份'), restoreDirectory = path.join(directory, '隔离恢复')
    await mkdir(backupDirectory); await mkdir(restoreDirectory)
    const backupRoot = await chooseDirectory(backupDirectory, 'backup-destination')
    const backup = await completedJob((await page.evaluate(request => window.musicBridge.startBackupJob(request), { commandId: randomUUID(), kind: 'backup' as const, rootId: backupRoot.id, mode: 'archive-content' as const, userConfirmed: true as const })).id)
    expect(backup.summary).toMatchObject({ mode: 'archive-content', operationCount: 1, incompleteCount: 0 })
    expect(backup.summary!.objectCount).toBeGreaterThan(0); expect(backup.resultRootId).toBeDefined()
    const sourceRoot = (await page.evaluate(() => window.musicBridge.getBackupOverview())).roots.find(root => root.id === backup.resultRootId)!
    expect(sourceRoot).toMatchObject({ kind: 'backup-source', authorized: true })
    const verification = await completedJob((await page.evaluate(request => window.musicBridge.startBackupJob(request), { commandId: randomUUID(), kind: 'verify' as const, rootId: sourceRoot.id, userConfirmed: true as const })).id)
    expect(verification.summary).toEqual(backup.summary)
    const restoreRoot = await chooseDirectory(restoreDirectory, 'restore-destination')
    const restoreRequest = { commandId: randomUUID(), kind: 'restore' as const, rootId: sourceRoot.id, destinationId: restoreRoot.id, verificationId: verification.id, userConfirmed: true as const }
    const restoreReceipt = await page.evaluate(request => window.musicBridge.startBackupJob(request), restoreRequest)
    const restored = await completedJob(restoreReceipt.id)
    // outbox复用原接收回执；最终状态必须另查同一job，不能把queued回执冒充完成状态。
    expect(await page.evaluate(request => window.musicBridge.startBackupJob(request), restoreRequest)).toEqual(restoreReceipt)
    expect(await completedJob(restoreReceipt.id)).toEqual(restored)
    const isolated = path.join(restoreDirectory, restored.id), isolatedDatabase = path.join(isolated, 'database', 'collection.sqlite')
    const marker = JSON.parse(await readFile(path.join(isolated, 'Restore.json'), 'utf8')) as { state: string; contentIncluded: boolean; mode: string; objects: Array<{ sha256: string; size: number }> }
    expect(marker).toMatchObject({ state: 'isolated-pending-activation', contentIncluded: true, mode: 'archive-content' })
    expect(marker.objects.length).toBe(backup.summary!.objectCount)
    for (const object of marker.objects) {
      expect(object.sha256).toMatch(/^[a-f0-9]{64}$/u)
      const bytes = await readFile(path.join(isolated, 'objects', object.sha256))
      expect(bytes.length).toBe(object.size); expect(sha256(bytes)).toBe(object.sha256)
    }
    expect(await databaseFacts(isolatedDatabase)).toEqual(stableFacts)
    expect(await verifyInventoryAndRecord()).toEqual(appFacts)
    const scopeBefore = (await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId
    await page.locator('[data-sidebar-source="recording"]').click()
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
    const restorePanel = page.getByRole('dialog', { name: '备份与恢复', exact: true })
    await expect(restorePanel).toBeVisible()
    await restorePanel.getByRole('combobox', { name: /^待激活的隔离恢复/u }).selectOption(restored.id)
    await restorePanel.getByLabel('我确认停止播放、重启 Core 并复制为新工作库；保留旧库，丢弃未保存的录音编辑', { exact: true }).check()
    await restorePanel.getByRole('button', { name: '确认停止播放并切换工作库', exact: true }).click()
    await expect(page.locator('[data-testid="dataset-reload-required"]')).toBeVisible({ timeout: 60_000 })
    const activation = (await page.evaluate(() => window.musicBridge.getBackupOverview())).activations.find(item => item.state === 'active')!
    expect(activation).toMatchObject({ state: 'active', restoreJobId: restored.id, previousId: null, contentIncluded: true })
    await expect.poll(async () => (await page.evaluate(() => window.musicBridge.getCoreHealth())).runtime, { timeout: 30_000 }).toBe('ready')
    const scopeAfter = (await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId
    expect(scopeAfter).not.toBe(scopeBefore)
    // 激活不迁移旧窗口权限；先证实旧上下文被拒绝，再显式加载新工作库上下文。
    await expect(page.evaluate(request => window.musicBridge.listRecordingRecords(request), { page: pageRequest })).rejects.toThrow(/OUTBOX_SCOPE_MISMATCH/u)
    await page.locator('[data-sidebar-source="collection"]').click()
    await page.locator('[data-sidebar-source="recording"]').click()
    await expect(page.locator('[data-testid="dataset-reload-required"]')).toBeVisible()
    await expect(page.getByRole('button', { name: '录音档案', exact: true })).toBeDisabled()
    await page.screenshot({ path: test.info().outputPath('dataset-reload-required.png') })
    await page.getByRole('button', { name: '重新加载窗口', exact: true }).click()
    await expect(page.locator('#home-heading')).toBeVisible()
    expect((await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId).toBe(scopeAfter)

    // 只移动本fixture创建的旧归档；之后仍verified必须来自新恢复绑定，不能偷偷读旧位置。
    const offlineArchive = path.join(f.directory, '旧归档离线')
    await rename(f.root.root.path, offlineArchive)
    await expect(lstat(f.root.root.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await directoryHashes(offlineArchive)).toEqual(archiveBefore)
    expect(await verifyInventoryAndRecord()).toEqual(appFacts)
    const restoredInspection = await inspect()
    expect(restoredInspection.fingerprint).not.toBe(inspection.fingerprint)
    expect(historicalInspection(restoredInspection)).toEqual(historicalInspection(inspection))
    expect(await printList()).toEqual(printsBefore)
    expect(await page.evaluate(request => window.musicBridge.getRecordingPrint(request), printRequest)).toEqual(print)
    const activeDatabase = path.join(data, 'restored-datasets', activation.id, 'database', 'collection.sqlite')
    expect(await databaseFacts(activeDatabase)).toEqual(stableFacts)
    expect(await databaseFacts(database)).toEqual(stableFacts)
    await close(); await launch()
    expect((await page.evaluate(() => window.musicBridge.getCommandOutbox())).datasetId).toBe(scopeAfter)
    expect(await verifyInventoryAndRecord()).toEqual(appFacts)
    const coldInspection = await inspect()
    expect(coldInspection.fingerprint).toBe(restoredInspection.fingerprint)
    expect(historicalInspection(coldInspection)).toEqual(historicalInspection(inspection))
    expect(await printList()).toEqual(printsBefore)
    expect(await page.evaluate(request => window.musicBridge.getRecordingPrint(request), printRequest)).toEqual(print)
    expect(await page.evaluate(() => window.musicBridge.getRecordingReplicaStatus())).toMatchObject({ playback: 'blocked', deviceAccess: 'not-authorized', deviceOpened: false, formalReady: false, gateB: 'NOT_RUN' })
    expect(await page.evaluate(() => window.musicBridge.getRecordingOutputStatus())).toMatchObject({ deviceAccess: 'not-authorized', formalReady: false, gateB: 'NOT_RUN' })
    expect((await page.evaluate(() => window.musicBridge.getPlaybackState())).state).toBe('idle')
    expect(await readFile(f.file)).toEqual(sourceBefore)
    expect(await databaseFacts(isolatedDatabase)).toEqual(stableFacts)
    expect(await databaseFacts(activeDatabase)).toEqual(stableFacts)
    expect(await readFile(exported)).toEqual(pdf)
    await writeFile(test.info().outputPath('same-dataset-chain.json'), JSON.stringify({ evidence: 'private-synthetic-attempt-then-real-app-api-pdf-backup-restore-activation-not-device-recording-or-listening', modelId, legacyId, physicalId, recordingId, before: before!.model.counts, after: countsAfter, scopeBefore, scopeAfter, inspection, print, backup, verification, restored, activation, preservedTableNames: preservedTables }, null, 2), { flag: 'wx' })
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: test.info().outputPath('chain-failure.png') }).catch(() => undefined)
      await writeFile(test.info().outputPath('chain-failure-aria.txt'), await page.locator('body').ariaSnapshot(), { flag: 'wx' }).catch(() => undefined)
    }
    throw error
  } finally {
    const errors: unknown[] = []
    try { await close() } catch (error) { errors.push(error) }
    for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch (error) { errors.push(error) } }
    try { await rm(directory, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, '合成全链路资源清理失败')
  }
})
