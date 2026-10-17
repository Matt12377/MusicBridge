import assert from 'node:assert/strict'
import test from 'node:test'
import { mountVueSfc } from '../support/mbf-vue-host.js'
import { useLocalWorkbenchLyrics, type LocalLyricsRendererApi } from '../../src/renderer/src/composables/application/local-library-workbench/lyrics.js'
import type { LocalLyricsCommand, LocalLyricsCommandPayloads, LocalLyricsCommandResults, LocalLyricsSession, LocalLyricsCandidate, LocalLyricsJobSnapshot } from '@music-bridge/contracts'
const scope = { datasetId: 'dataset-a', libraryId: 'library-a', albumId: 'album-a', captureId: 'capture-a' }
const candidate: LocalLyricsCandidate = { candidateId: 'candidate-a', trackId: 'track-a', source: 'lrclib', title: '合成曲目', artist: '合成艺人', album: '合成专辑', durationMs: 90000, language: '中文', version: 'live', score: 85 }
function fixture() {
  const calls: string[] = []
  let current: LocalLyricsSession = { sessionId: 'session-a', scope, state: 'ready', candidates: [candidate], tracks: [{ trackId: candidate.trackId, title: candidate.title, presence: 'false', match: 'review', candidateIds: [candidate.candidateId], selectedCandidateId: null, sources: [{ source: 'netease', state: 'failed' }, { source: 'qq', state: 'ok' }, { source: 'kugou', state: 'ok' }, { source: 'kuwo', state: 'ok' }, { source: 'lrclib', state: 'ok' }] }] }
  const api: LocalLyricsRendererApi = { async localLibraryLyrics<C extends LocalLyricsCommand>(command: C, payload: LocalLyricsCommandPayloads[C]): Promise<LocalLyricsCommandResults[C]> {
    calls.push(command)
    if (command === 'localLyrics.select') current = { ...current, tracks: current.tracks.map(v => ({ ...v, selectedCandidateId: (payload as LocalLyricsCommandPayloads['localLyrics.select']).candidateId })) }
    return (command === 'localLyrics.detail' ? { candidate, body: '[00:01.00]合成现场版本歌词' } : current) as LocalLyricsCommandResults[C]
  } }
  return { api, calls }
}
test('真实歌词组件点击查询/正文/候选选择，来源失败与现场版本可见且没有保存写入', async t => {
  const f = fixture(), model = useLocalWorkbenchLyrics({ api: f.api }); t.after(model.dispose); model.bind(scope)
  const host = await mountVueSfc(t, new URL('../../src/renderer/src/components/library/local-workbench/LocalLyricsReview.vue', import.meta.url).pathname, { model })
  const button = (label: string) => host.all().find(v => v.type === 'button' && host.text(v).includes(label))
  await host.dispatch(button('查询此专辑缺词'), 'onClick'); assert.match(host.text(), /网易云 · 失败/u); assert.match(host.text(), /有歧义/u)
  await host.dispatch(button('预览正文'), 'onClick'); assert.match(host.text(), /合成现场版本歌词/u); assert.match(host.text(), /现场版/u)
  const radio = host.all().find(v => v.type === 'input' && v.props.type === 'radio'); await host.dispatch(radio, 'onChange')
  assert.equal(model.selectedCount.value, 1); assert.deepEqual(f.calls, ['localLyrics.query', 'localLyrics.detail', 'localLyrics.select'])
})
test('真实全库组件明确展示全范围与原批次入口，不传当前页或过滤条件', async t => {
  const commands: { command: string; payload: unknown }[] = []
  const api: LocalLyricsRendererApi = { async localLibraryLyrics<C extends LocalLyricsCommand>(command: C, payload: LocalLyricsCommandPayloads[C]): Promise<LocalLyricsCommandResults[C]> {
    assert.equal(command, 'localLyrics.job.start'); commands.push({ command, payload })
    const snapshot: LocalLyricsJobSnapshot = { jobId: 'job-a', library: { datasetId: 'dataset-a', libraryId: 'library-a', captureId: 'whole-library-a' }, state: 'running', totalAlbums: 501, processedAlbums: 0, savedAlbums: 0, reviewAlbumIds: [], failedAlbumIds: [], unknownAlbumIds: [], sidecars: 0, embedded: 0, inspectionFailures: 0, revision: 1 }
    const value: unknown = snapshot; return value as LocalLyricsCommandResults[C]
  } }
  const model = useLocalWorkbenchLyrics({ api, makeCommandId: () => 'job-a' }); t.after(model.dispose); model.bind(null, { datasetId: 'dataset-a', libraryId: 'library-a', captureId: 'whole-library-a' })
  const host = await mountVueSfc(t, new URL('../../src/renderer/src/components/library/local-workbench/LocalLyricsBatchControl.vue', import.meta.url).pathname, { model })
  await host.dispatch(host.all().find(v => v.type === 'button' && host.text(v).includes('获取并保存全库缺词')), 'onClick')
  assert.match(host.text(), /501/u); assert.match(host.text(), /停止全库批次/u)
  assert.deepEqual(commands[0], { command: 'localLyrics.job.start', payload: { commandId: 'job-a', library: { datasetId: 'dataset-a', libraryId: 'library-a', captureId: 'whole-library-a' }, embed: true } })
})
