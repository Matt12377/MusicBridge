import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 全部为合成音频和库存，经实际preload/Main/Core/outbox创建，不注入数据库或后端认证。 */
export async function seedRecordingPlan(page: Page, app: ElectronApplication, directory: string) {
  const saved = await page.evaluate(async () => {
    const api = window.musicBridge, albums = await api.searchPhysicalRoonAlbums('', { offset: 0, limit: 20 })
    const tracks = await api.getRoonAlbumTracks(albums.items[0]!.reference, { offset: 0, limit: 20 })
    return api.appendMasterDraft({ commandId: crypto.randomUUID(), title: '计划与预检合成草稿', programType: 'compilation', references: [tracks.items[0]!.reference], userConfirmed: true })
  })
  const sourceDirectory = path.join(directory, '源'); await mkdir(sourceDirectory)
  const sourceFile = path.join(sourceDirectory, 'synthetic-plan.wav'), bytes = Buffer.alloc(44 + 44100 * 4)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(176400, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40)
  await writeFile(sourceFile, bytes)
  const choose = async (file: string) => app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
  await choose(sourceDirectory)
  const sourceRoot = await page.evaluate(() => window.musicBridge.chooseRecordingSourceRoot(crypto.randomUUID()))
  await choose(sourceFile)
  const sourceJob = await page.evaluate(request => window.musicBridge.chooseRecordingSource(request), { commandId: randomUUID(), draftId: saved.draftId, trackId: saved.trackIds[0]!, rootId: sourceRoot!.id, acquisition: 'userFileBind' as const })
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getRecordingSourceJob(id), sourceJob!.id)).job?.state).toBe('completed')
  const sources = await page.evaluate(id => window.musicBridge.getDraftSources(id), saved.draftId)
  await page.evaluate(request => window.musicBridge.confirmRecordingSource(request), { commandId: randomUUID(), id: sources.tracks[0]!.binding!.id, draftId: saved.draftId, trackId: saved.trackIds[0]!, userConfirmed: true as const })
  const media = await page.evaluate(async draftId => {
    const api = window.musicBridge
    await api.receiveCollectionStock({ commandId: crypto.randomUUID(), model: { brand: '合成072', name: '计划库存', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' }, lengthMinutes: 60, quantities: { openedBlank: 2, sealedBlank: 0, legacyUsed: 0, unclassified: 0 } })
    const spec = { format: 'cassette' as const, splitAfter: 1, leadInMs: 1000, tailMs: 1000, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II' as const], dat: true } }
    const preview = await api.previewMediaPlan({ draftId, spec, page: { offset: 0, limit: 25 } })
    const plan = await api.saveMediaPlan({ commandId: crypto.randomUUID(), draftId, expectedDraftRevision: preview.draftRevision, inputFingerprint: preview.inputFingerprint, spec })
    return api.reserveMediaPlan({ commandId: crypto.randomUUID(), planId: plan.id, expectedRevision: plan.revision, skuId: preview.candidates.items[0]!.skuId, packaging: 'opened', userConfirmed: true })
  }, saved.draftId)
  const proposal = await page.evaluate(planId => window.musicBridge.previewMasterVersions({ planId, sampleRate: 44100 }), media.id)
  const freeze = await page.evaluate(request => window.musicBridge.freezeMasterVersions(request), { commandId: randomUUID(), planId: media.id, sampleRate: 44100, proposalFingerprint: proposal.proposalFingerprint, userConfirmed: true as const })
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getMasterVersionJob(id), freeze.id)).job?.state).toBe('completed')
  const layout = (await page.evaluate(id => window.musicBridge.listMasterVersions(id), saved.draftId)).layouts[0]!
  const profile = await page.evaluate(async () => window.musicBridge.saveRecordingProfile({ commandId: crypto.randomUUID(), content: { name: '合成录音配置', signalChain: [{ id: crypto.randomUUID(), kind: 'audio-interface', label: '未认证合成声卡' }, { id: crypto.randomUUID(), kind: 'cassette-deck', label: '合成磁带机' }], defaults: { noiseReduction: 'Off', calibration: '人工合成校准', recordLevel: null, preRollMs: 1000 }, compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true }, executionFormat: { sampleRate: 44100, channelCount: 2, channelLayout: 'stereo', internalProcessingPrecision: 'integer-bit-copy', outputSampleFormat: 'pcm-s16le', resamplerImplementation: 'none', resamplerVersion: 'not-applied', ditherPolicy: 'none', channelMapping: 'identity', outputBackend: { id: 'isolated-test-no-output', version: '1' } } }, userConfirmed: true }))
  const session = await page.evaluate(request => window.musicBridge.saveRecordingSession(request), { commandId: randomUUID(), draftId: saved.draftId, expectedRevision: 0, profileVersionId: profile.id, overrides: { recordLevel: '合成初始电平' }, userConfirmed: true as const })
  const target = path.join(directory, '执行输出'); await mkdir(target); await choose(target)
  const destination = await page.evaluate(() => window.musicBridge.choosePreparationDestination(crypto.randomUUID()))
  const executionSelection = { layoutVersionId: layout.id, destinationId: destination!.id, mode: 'direct' as const, sessionRevision: session.revision }
  const preview = await page.evaluate(request => window.musicBridge.previewExecutionAsset(request), { ...executionSelection, readId: randomUUID() })
  const job = await page.evaluate(request => window.musicBridge.startExecutionAsset(request), { ...executionSelection, commandId: randomUUID(), proposalFingerprint: preview.proposalFingerprint, userConfirmed: true as const })
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getExecutionJob(id), job.id)).job?.state).toBe('completed')
  const asset = (await page.evaluate(id => window.musicBridge.listExecutionAssets(id), saved.draftId)).assets[0]!
  const parent = path.join(directory, '归档'); await mkdir(parent); await choose(parent)
  const root = await page.evaluate(() => window.musicBridge.chooseArchiveRoot(crypto.randomUUID()))
  await page.evaluate(request => window.musicBridge.initializeArchiveRoot(request), { commandId: randomUUID(), id: root!.id, userConfirmed: true as const })
  const archiveSelection = { rootId: root!.id, assetId: asset.id, sourcePolicy: 'preserve-exact-sources' as const }
  const archivePreview = await page.evaluate(request => window.musicBridge.previewArchive(request), { ...archiveSelection, readId: randomUUID() })
  const archived = await page.evaluate(request => window.musicBridge.startArchive(request), { ...archiveSelection, commandId: randomUUID(), proposalFingerprint: archivePreview.proposalFingerprint, userConfirmed: true as const })
  await expect.poll(async () => (await page.evaluate(id => window.musicBridge.getArchiveOperation(id), archived.id)).operation?.phase).toBe('FINALIZED')
  return { draft: saved, sourceFile, bytes, media, layout, profile, session, asset, archive: archived, selection: { assetId: asset.id, archiveOperationId: archived.id } }
}
