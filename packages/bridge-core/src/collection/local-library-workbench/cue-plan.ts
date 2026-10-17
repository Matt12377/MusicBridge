import { LOCAL_WORKBENCH_MAX_ITEMS, isLocalCueOutputTarget, isLocalWorkbenchIdentity, isLocalWorkbenchText, type LocalCueOutputTarget, type LocalCueSplitTrack } from '@music-bridge/contracts'
import type { CueOwnerAssetReference, CueTrackFact } from '../../library/cue-text-reader.js'
import { CUE_INPUT_DEMUXERS } from '../../library/cue-ffmpeg-build-policy.js'
import type { CueInputDemuxer } from '../../library/bundled-cue-converter.js'
import { isLocalWorkbenchAlbumCapture } from './name-proposal.js'
import {
  LocalWorkbenchPlanError, isLocalWorkbenchDataRecord, isLocalWorkbenchDenseArray, type LocalCueAudioProbe, type LocalCueFormatQualification, type LocalCueSheetCapture,
  type LocalWorkbenchPlanDraft, type LocalCueOutputBinding,
} from './types.js'

const extensions = { flac: 'flac', alac: 'm4a', mp3: 'mp3', vorbis: 'ogg', opus: 'opus', wavpack: 'wv', 'pcm-wav': 'wav', 'pcm-aiff': 'aiff' } as const
const sourceKeys = ['assetId', 'libraryRootId', 'sourceRootId', 'rootRevision', 'fileRevision', 'locationRevision'] as const
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const sameSource = (a: CueOwnerAssetReference, b: CueOwnerAssetReference): boolean => sourceKeys.every(key => a[key] === b[key])
export function isLocalCueFormatQualification(value: unknown): value is LocalCueFormatQualification {
  if (!isLocalWorkbenchDataRecord(value, ['formatId', 'revision', 'codec', 'extension', 'lossless', 'evidence', 'available'])) return false
  const item = value as unknown as LocalCueFormatQualification
  return isLocalWorkbenchIdentity(item.formatId) && isLocalWorkbenchIdentity(item.revision) && Object.hasOwn(extensions, item.codec)
    && item.extension === extensions[item.codec] && typeof item.lossless === 'boolean' && item.evidence === 'encoder-tag-audio-roundtrip' && typeof item.available === 'boolean'
    && (['mp3', 'vorbis', 'opus'].includes(item.codec) ? item.lossless === false : item.lossless === true)
}
export function isLocalCueAudioProbe(value: unknown): value is LocalCueAudioProbe {
  if (!isLocalWorkbenchDataRecord(value, ['assetReference', 'sourceLabel', 'evidence', 'readRevision', 'sampleRate', 'totalPcmFrames'])
    || !isLocalWorkbenchDataRecord(value.assetReference, sourceKeys)) return false
  const item = value as unknown as LocalCueAudioProbe
  return !!item.assetReference && sourceKeys.every(key => isLocalWorkbenchIdentity(item.assetReference[key]))
    && isLocalWorkbenchText(item.sourceLabel) && item.evidence === 'audio-pcm-read' && isLocalWorkbenchIdentity(item.readRevision)
    && positive(item.sampleRate) && item.sampleRate <= 768000 && positive(item.totalPcmFrames)
}
/** 与固定原CueTrackFrameMath相同，75fps换算按整数除法截断；BigInt防乘法溢出。 */
export function localCueCdFramesToPcm(cdFrames: number, sampleRate: number): number {
  if (!nonnegative(cdFrames) || !positive(sampleRate) || sampleRate > 768000) throw new LocalWorkbenchPlanError('CUE_INVALID', 'CUE帧或实际采样率无效。')
  const result = BigInt(cdFrames) * BigInt(sampleRate) / 75n
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new LocalWorkbenchPlanError('CUE_INVALID', 'CUE到PCM帧的换算超出安全整数范围。')
  return Number(result)
}
function validTrack(track: CueTrackFact<CueOwnerAssetReference>): boolean {
  return isLocalWorkbenchDataRecord(track, ['trackNumber', 'fileOrdinal', 'assetReference', 'timebase', 'framesPerSecond', 'index00Frames', 'index01Frames', 'endFrames', 'evidence', 'playback'], ['title', 'performer'])
    && isLocalWorkbenchDataRecord(track.assetReference, sourceKeys) && positive(track.trackNumber) && track.trackNumber <= 99 && positive(track.fileOrdinal) && track.fileOrdinal <= 32
    && !!track.assetReference && sourceKeys.every(key => isLocalWorkbenchIdentity(track.assetReference[key]))
    && track.timebase === 'cue-cd-frames' && track.framesPerSecond === 75 && track.endFrames === null
    && track.evidence === 'cue-text-declared' && track.playback === 'NOT_VERIFIED'
    && nonnegative(track.index01Frames) && (track.index00Frames === null || nonnegative(track.index00Frames) && track.index00Frames <= track.index01Frames)
    && (track.title === undefined || isLocalWorkbenchText(track.title, true)) && (track.performer === undefined || isLocalWorkbenchText(track.performer, true))
}
function filename(value: string): string {
  const normalized = value.normalize('NFC').replace(/[\\/:\u0000-\u001f\u007f]/gu, '_').replace(/[. ]+$/u, '').trim()
  let bounded = '', bytes = 0
  for (const point of normalized) { const size = Buffer.byteLength(point, 'utf8'); if (bytes + size > 180) break; bounded += point; bytes += size }
  return bounded && bounded !== '.' && bounded !== '..' ? bounded : '未提供标题'
}
/** 仅消费原Owner已实际probe的字段；纯选择规则不会授予新demux/decoder或Native资格。 */
export interface LocalCueSourceEncoding {
  codec: string
  demuxer: CueInputDemuxer
  sampleFormat: string
  bitsPerSample: number
}
/** MPC原本为有损编码；24bit FLAC只保存其实际解码结果，不宣称恢复原音质。 */
export function isLocalCueSourceOutputPrecisionQualified(source: LocalCueSourceEncoding, output: LocalCueFormatQualification['codec']): boolean {
  if (['mp3', 'vorbis', 'opus'].includes(output)) return true
  return /^(flt|dbl)/u.test(source.sampleFormat)
    ? source.bitsPerSample === 32 && ['pcm-wav', 'pcm-aiff'].includes(output)
    : source.bitsPerSample <= (['pcm-wav', 'pcm-aiff'].includes(output) ? 32 : 24)
}
export function selectLocalCueSourceOutputFormat(sources: readonly LocalCueSourceEncoding[], qualifications: readonly LocalCueFormatQualification[]): LocalCueFormatQualification {
  if (!isLocalWorkbenchDenseArray(sources, 32 * 100) || !sources.length
    || !sources.every(source => isLocalWorkbenchDataRecord(source, ['codec', 'demuxer', 'sampleFormat', 'bitsPerSample'])
      && isLocalWorkbenchText(source.codec) && isLocalWorkbenchText(source.sampleFormat)
      && CUE_INPUT_DEMUXERS.includes(source.demuxer)
      && positive(source.bitsPerSample) && source.bitsPerSample <= 64)
    || !isLocalWorkbenchDenseArray(qualifications, 32) || !qualifications.every(isLocalCueFormatQualification)
    || new Set(qualifications.map(format => format.codec)).size !== qualifications.length)
    throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT', '原源编码捕获或实际输出资格集合无效。')
  const nativeCodecs: Record<string, LocalCueFormatQualification['codec']> = { flac: 'flac', alac: 'alac', mp3: 'mp3', mp3float: 'mp3', vorbis: 'vorbis', opus: 'opus', wavpack: 'wavpack' }
  const family = (source: LocalCueSourceEncoding): LocalCueFormatQualification['codec'] | undefined => source.codec.startsWith('pcm_')
    ? source.demuxer === 'wav' ? 'pcm-wav' : source.demuxer === 'aiff' ? 'pcm-aiff' : undefined
    : Object.hasOwn(nativeCodecs, source.codec) ? nativeCodecs[source.codec] : undefined
  const families = sources.map(family), first = families[0]
  const preserved = first !== undefined && families.every(codec => codec === first)
    ? qualifications.find(format => format.codec === first && format.available) : undefined
  const selected = preserved ?? qualifications.find(format => format.codec === 'flac' && format.available)
  if (!selected) throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT', '原编码输出不可用，FLAC也未取得真实资格。')
  if (sources.some(source => !isLocalCueSourceOutputPrecisionQualified(source, selected.codec)))
    throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT', '保留或回退输出不在原源精度的实际资格内，不能静默降精度。')
  return structuredClone(selected)
}
const outputNameKey = (value: string): string => value.normalize('NFC').toLocaleLowerCase('en-US')
/** 只在预览生成最终名称；执行必须使用原计划名称，并以exclusive link再次拒覆盖。 */
function reserveOutputName(original: string, occupied: Set<string>): string {
  const dot = original.lastIndexOf('.'), stem = original.slice(0, dot), extension = original.slice(dot)
  let candidate = original, suffix = 2
  while (occupied.has(outputNameKey(candidate))) candidate = stem + ' (' + suffix++ + ')' + extension
  if (Buffer.byteLength(candidate, 'utf8') > 240) throw new LocalWorkbenchPlanError('INVALID_PLAN', '独立输出名称超过原安全长度。')
  occupied.add(outputNameKey(candidate)); return candidate
}
export interface LocalCueDraftInput {
  selections: readonly LocalCueSheetCapture[]
  target: LocalCueOutputTarget
  format: LocalCueFormatQualification
  /** 原版本：非末轨接后轨pregap；首轨明确有INDEX00时从源帧0开始。 */
  pregapPolicy: 'append-to-previous'
}
/** 只生成纯计划，不读取音频/目录、不生成临时产物；真实读帧与编码资格必须由Main预先捕获。 */
export function buildLocalCuePlan(input: LocalCueDraftInput, occupiedOutputNames: readonly string[] = []): { draft: Extract<LocalWorkbenchPlanDraft, { kind: 'cue' }>; outputs: readonly LocalCueOutputBinding[] } {
  if (!isLocalWorkbenchDataRecord(input, ['selections', 'target', 'format', 'pregapPolicy']) || !isLocalCueOutputTarget(input.target) || input.pregapPolicy !== 'append-to-previous'
    || !isLocalWorkbenchDenseArray(input.selections, 100) || !input.selections.length
    || !input.selections.every(item => isLocalWorkbenchDataRecord(item, ['album', 'cueId', 'cueRevision', 'parsed', 'audio']) && isLocalWorkbenchAlbumCapture(item.album))
    || new Set(input.selections.map(item => item.album.albumId)).size !== input.selections.length)
    throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '请明确选择已读取的专辑/CUE与独立输出目标。')
  if (!isLocalCueFormatQualification(input.format) || !input.format.available) throw new LocalWorkbenchPlanError('UNQUALIFIED_FORMAT', '所选格式没有实际编码、标签和音频回读资格，不能生成可执行计划。')
  if (!isLocalWorkbenchDenseArray(occupiedOutputNames, LOCAL_WORKBENCH_MAX_ITEMS) || !occupiedOutputNames.every(name => typeof name === 'string' && !/[\\/\u0000]/u.test(name) && Buffer.byteLength(name, 'utf8') <= 255))
    throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '原独立目标完整名称观察无效，不能猜测无覆盖名称。')
  const occupied = new Set(occupiedOutputNames.map(outputNameKey))
  const tracks: LocalCueSplitTrack[] = []
  const outputs: LocalCueOutputBinding[] = []
  input.selections.forEach((selection, albumIndex) => {
    const album = selection.album
    if (!isLocalWorkbenchAlbumCapture(album) || !isLocalWorkbenchIdentity(selection.cueId) || !isLocalWorkbenchIdentity(selection.cueRevision)
      || !isLocalWorkbenchDataRecord(selection.parsed, ['status', 'tracks'], ['albumTitle', 'albumPerformer']) || selection.parsed.status !== 'ok'
      || !isLocalWorkbenchDenseArray(selection.parsed.tracks, 99) || !selection.parsed.tracks.length
      || !isLocalWorkbenchDenseArray(selection.audio, 32)
      || (selection.parsed.albumTitle !== undefined && !isLocalWorkbenchText(selection.parsed.albumTitle, true))
      || (selection.parsed.albumPerformer !== undefined && !isLocalWorkbenchText(selection.parsed.albumPerformer, true)))
      throw new LocalWorkbenchPlanError('CUE_INVALID', 'CUE文本事实或完整专辑捕获无效，尚未生成输出。')
    const parsed = selection.parsed, facts = parsed.tracks
    const byFile = new Map<number, CueTrackFact<CueOwnerAssetReference>[]>()
    let lastNumber = 0, lastFile = 0
    for (const fact of facts) {
      if (!validTrack(fact) || fact.trackNumber <= lastNumber || fact.fileOrdinal < lastFile || fact.fileOrdinal > lastFile + 1)
        throw new LocalWorkbenchPlanError('CUE_INVALID', 'CUE轨序、文件序或CD75索引无效。')
      lastNumber = fact.trackNumber; lastFile = fact.fileOrdinal
      const group = byFile.get(fact.fileOrdinal) ?? []
      if (group.length && (!sameSource(group[0]!.assetReference, fact.assetReference) || fact.index01Frames <= group[group.length - 1]!.index01Frames
        || fact.index00Frames !== null && fact.index00Frames < group[group.length - 1]!.index01Frames))
        throw new LocalWorkbenchPlanError('CUE_INVALID', 'CUE分段存在重叠或同一文件身份变化。')
      group.push(fact); byFile.set(fact.fileOrdinal, group)
    }
    const usedAudio = new Set<string>()
    for (const group of byFile.values()) {
      const reference = group[0]!.assetReference
      const probes = selection.audio.filter(item => item.assetReference && sameSource(item.assetReference, reference))
      if (probes.length !== 1 || !isLocalCueAudioProbe(probes[0])) throw new LocalWorkbenchPlanError('PCM_NOT_READ', '缺少唯一的实际总PCM帧/采样率证据；CUE声明与估计时长不能授权分轨。')
      const probe = probes[0]!, sampleRate = probe.sampleRate!, totalFrames = probe.totalPcmFrames!
      const members = album.members.filter(member => member.assetId === reference.assetId)
      if (reference.libraryRootId !== album.rootId || !members.length || members.some(member => member.rootRevision !== reference.rootRevision
        || member.fileRevision !== reference.fileRevision || member.locationRevision !== reference.locationRevision))
        throw new LocalWorkbenchPlanError('CHANGED', 'CUE来源不属于本次捕获成员，或源修订已经变化。')
      if (usedAudio.has(reference.assetId)) throw new LocalWorkbenchPlanError('CUE_INVALID', '同一源文件在多个FILE段重复出现，不能生成重复输出范围。')
      usedAudio.add(reference.assetId)
      group.forEach((fact, index) => {
        const index01 = localCueCdFramesToPcm(fact.index01Frames, sampleRate)
        const index00 = fact.index00Frames === null ? null : localCueCdFramesToPcm(fact.index00Frames, sampleRate)
        const start = index === 0 && index00 !== null && index00 < index01 ? 0 : index01
        const end = index < group.length - 1 ? localCueCdFramesToPcm(group[index + 1]!.index01Frames, sampleRate) : totalFrames
        if (index01 >= totalFrames || index00 !== null && index00 > totalFrames || start >= end || end > totalFrames)
          throw new LocalWorkbenchPlanError('CUE_INVALID', 'CUE分段为空或超过实际源音频总帧数，尚未生成输出。')
        const sequence = fact.trackNumber, title = fact.title?.trim() || '音轨 ' + String(sequence).padStart(2, '0')
        const artist = fact.performer?.trim() || parsed.albumPerformer?.trim() || album.artistName
        const albumName = parsed.albumTitle?.trim() || album.albumName
        const prefix = input.selections.length > 1 ? String(albumIndex + 1).padStart(3, '0') + '.' : ''
        const outputName = reserveOutputName(prefix + String(sequence).padStart(2, '0') + ' - ' + filename(title) + '.' + input.format.extension, occupied)
        const reason = '标签写入新生成的独立分轨文件。'
        tracks.push({ itemId: 'cue-item-' + album.albumId + '-' + sequence, albumId: album.albumId, label: title, sequence,
          sourceLabel: probe.sourceLabel, startFrame: start, frameCount: end - start, sampleRate, outputName, outputFormat: input.format.formatId,
          changes: [
            { field: 'title', before: null, after: title, reason }, { field: 'artist', before: null, after: artist, reason },
            { field: 'album', before: null, after: albumName, reason }, { field: 'track', before: null, after: String(sequence), reason },
          ] })
        outputs.push({ itemId: 'cue-item-' + album.albumId + '-' + sequence, albumId: album.albumId, sourceAssetId: reference.assetId,
          libraryRootId: reference.libraryRootId, sourceRootId: reference.sourceRootId, sourceReadRevision: probe.readRevision })
      })
    }
    if (usedAudio.size !== selection.audio.length) throw new LocalWorkbenchPlanError('INVALID_CAPTURE', '音频探测集合与CUE实际来源不一致，未采纳额外源。')
  })
  if (new Set(tracks.map(track => track.outputName.normalize('NFC').toLocaleLowerCase('en-US'))).size !== tracks.length)
    throw new LocalWorkbenchPlanError('INVALID_PLAN', '独立输出文件名存在冲突，请重新规划。')
  const draft: Extract<LocalWorkbenchPlanDraft, { kind: 'cue' }> = { kind: 'cue', scope: 'INDEPENDENT_OUTPUT', sourceDisposition: 'retain', target: structuredClone(input.target),
    albumIds: input.selections.map(item => item.album.albumId), state: 'ready', blockers: [], tracks,
    items: tracks.map(({ itemId, albumId, label, changes }) => ({ itemId, albumId, label, changes: structuredClone(changes) })) }
  return { draft, outputs }
}
export function createLocalCuePlanDraft(input: LocalCueDraftInput): Extract<LocalWorkbenchPlanDraft, { kind: 'cue' }> { return buildLocalCuePlan(input).draft }
