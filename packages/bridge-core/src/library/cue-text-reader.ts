/** 有界Node私有CUE文本事实；不解析路径、不打开FD、不联网、不生成播放许可。 */
export interface CueReadBudget {
  maxUtf8Bytes: number; maxLines: number; maxTracks: number; maxFiles: number; maxFieldUtf8Bytes: number;
}
export const DEFAULT_CUE_READ_BUDGET: Readonly<CueReadBudget> = Object.freeze({
  maxUtf8Bytes: 65536, maxLines: 1024, maxTracks: 99, maxFiles: 32, maxFieldUtf8Bytes: 4096,
});
export type CueReadFailure = 'BUDGET_EXCEEDED' | 'MALFORMED' | 'UNSUPPORTED_DIRECTIVE' | 'UNBOUND_FILE' | 'AMBIGUOUS_FILE';
/** owner已捕获/验证的身份快照；parser不发明revision、不将FILE文字变成授权。 */
export interface CueOwnerAssetReference {
  readonly assetId: string; readonly libraryRootId: string; readonly sourceRootId: string;
  readonly rootRevision: string; readonly fileRevision: string; readonly locationRevision: string;
}
export interface CueTrackFact<TAssetReference extends CueOwnerAssetReference> {
  trackNumber: number; fileOrdinal: number; assetReference: TAssetReference;
  timebase: 'cue-cd-frames'; framesPerSecond: 75;
  index00Frames: number | null; index01Frames: number; endFrames: null;
  title?: string; performer?: string;
  evidence: 'cue-text-declared'; playback: 'NOT_VERIFIED';
}
export type CueReadResult<TAssetReference extends CueOwnerAssetReference> =
  { status: 'ok'; albumTitle?: string; albumPerformer?: string; tracks: CueTrackFact<TAssetReference>[] }
  | { status: 'failure'; code: CueReadFailure };
interface PendingTrack<T> { trackNumber: number; assetReference: T; fileOrdinal: number;
  index00Frames: number | null; index01Frames: number | null; title?: string; performer?: string }

/** trustedAssociations由owner提供；FILE只作有界查表key，0/多候选明确拒绝。 */
export function parseCueText<TAssetReference extends CueOwnerAssetReference>(input: string | Uint8Array,
  trustedAssociations: ReadonlyMap<string, readonly TAssetReference[]>,
  trustedBudget: Partial<CueReadBudget> = {}): CueReadResult<TAssetReference> {
  const bad = (code: CueReadFailure): CueReadResult<TAssetReference> => ({ status: 'failure', code });
  if (trustedBudget === null || typeof trustedBudget !== 'object' || Array.isArray(trustedBudget)) return bad('MALFORMED');
  const budget = { ...DEFAULT_CUE_READ_BUDGET, ...trustedBudget };
  for (const key of Object.keys(trustedBudget)) if (!Object.hasOwn(DEFAULT_CUE_READ_BUDGET, key)) return bad('MALFORMED');
  for (const key of Object.keys(DEFAULT_CUE_READ_BUDGET) as (keyof CueReadBudget)[]) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 1 || budget[key] > DEFAULT_CUE_READ_BUDGET[key]) return bad('MALFORMED');
  }
  let text: string;
  if (typeof input === 'string') {
    // UTF16长度先界限，再进行有界UTF8计数，拒绝孤立surrogate的替换解码。
    if (input.length > budget.maxUtf8Bytes) return bad('BUDGET_EXCEEDED');
    for (let i = 0; i < input.length; ++i) {
      const code = input.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = input.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return bad('MALFORMED');
      } else if (code >= 0xdc00 && code <= 0xdfff) return bad('MALFORMED');
    }
    if (Buffer.byteLength(input, 'utf8') > budget.maxUtf8Bytes) return bad('BUDGET_EXCEEDED'); text = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > budget.maxUtf8Bytes) return bad('BUDGET_EXCEEDED');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { return bad('MALFORMED'); }
  } else return bad('MALFORMED');
  if (text.startsWith('\ufeff')) text = text.slice(1);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/u.test(text)) return bad('MALFORMED');
  // 先数行再split；CRLF计一行，终止换行后的空行也计数。
  let lineCount = 1;
  for (let i = 0; i < text.length; ++i) {
    if (text[i] === '\r' || text[i] === '\n') {
      if (text[i] === '\r' && text[i + 1] === '\n') ++i;
      if (++lineCount > budget.maxLines) return bad('BUDGET_EXCEEDED');
    }
  }
  const tracks: CueTrackFact<TAssetReference>[] = [];
  let albumTitle: string | undefined, albumPerformer: string | undefined;
  let current: PendingTrack<TAssetReference> | undefined;
  let fileOrdinal = 0, fileTracks = 0, asset: TAssetReference | undefined, lastTrackNumber = 0, lastIndex: number | null = null;
  const finishTrack = (): CueReadFailure | undefined => {
    if (!current) return undefined;
    if (current.index01Frames === null || current.index00Frames !== null && current.index00Frames > current.index01Frames ||
      lastIndex !== null && (current.index01Frames <= lastIndex || current.index00Frames !== null && current.index00Frames < lastIndex)) return 'MALFORMED';
    if (tracks.length >= budget.maxTracks) return 'BUDGET_EXCEEDED';
    tracks.push({ trackNumber: current.trackNumber, fileOrdinal: current.fileOrdinal, assetReference: current.assetReference,
      timebase: 'cue-cd-frames', framesPerSecond: 75, index00Frames: current.index00Frames, index01Frames: current.index01Frames,
      endFrames: null, ...(current.title !== undefined ? { title: current.title } : {}),
      ...(current.performer !== undefined ? { performer: current.performer } : {}), evidence: 'cue-text-declared', playback: 'NOT_VERIFIED' });
    lastIndex = current.index01Frames; current = undefined; ++fileTracks; return undefined;
  };
  for (const raw of text.split(/\r\n|\n|\r/u)) {
    const line = raw.trim(); if (!line) continue;
    const command = /^([A-Z]+)(?:[ \t]+(.*))?$/u.exec(line); if (!command) return bad('MALFORMED');
    const verb = command[1]!, argument = command[2] ?? '';
    if (verb === 'REM') continue; // 仅有界注释，不提供标签/位置证据。
    if (verb === 'FILE') {
      const ended = finishTrack(); if (ended) return bad(ended);
      if (fileOrdinal > 0 && fileTracks === 0) return bad('MALFORMED');
      const match = /^"([^"\r\n]+)"[ \t]+([A-Z0-9]+)$/u.exec(argument); if (!match) return bad('MALFORMED');
      const name = match[1]!, kind = match[2]!;
      if (!['WAVE', 'MP3', 'AIFF'].includes(kind)) return bad('UNSUPPORTED_DIRECTIVE');
      if (name === '.' || name === '..' || /[\\/:\u0000-\u001f\u007f]/u.test(name)) return bad('MALFORMED');
      if (Buffer.byteLength(name, 'utf8') > Math.min(512, budget.maxFieldUtf8Bytes)) return bad('BUDGET_EXCEEDED');
      if (fileOrdinal >= budget.maxFiles) return bad('BUDGET_EXCEEDED');
      const candidates = trustedAssociations.get(name);
      if (!candidates || candidates.length === 0) return bad('UNBOUND_FILE');
      if (candidates.length !== 1) return bad('AMBIGUOUS_FILE');
      if (candidates[0] === undefined || candidates[0] === null) return bad('MALFORMED');
      asset = candidates[0]; ++fileOrdinal; fileTracks = 0; lastIndex = null; continue;
    }
    if (verb === 'TRACK') {
      const ended = finishTrack(); if (ended) return bad(ended);
      const match = /^([0-9]{2})[ \t]+([A-Z0-9/]+)$/u.exec(argument); if (!match || asset === undefined) return bad('MALFORMED');
      if (match[2] !== 'AUDIO') return bad('UNSUPPORTED_DIRECTIVE');
      const number = Number(match[1]); if (number < 1 || number > 99 || number <= lastTrackNumber) return bad('MALFORMED');
      if (tracks.length >= budget.maxTracks) return bad('BUDGET_EXCEEDED');
      current = { trackNumber: number, assetReference: asset, fileOrdinal, index00Frames: null, index01Frames: null };
      lastTrackNumber = number; continue;
    }
    if (verb === 'INDEX') {
      if (!current) return bad('MALFORMED');
      const match = /^([0-9]{2})[ \t]+([0-9]{2,3}):([0-9]{2}):([0-9]{2})$/u.exec(argument); if (!match) return bad('MALFORMED');
      const index = Number(match[1]), minutes = Number(match[2]), seconds = Number(match[3]), frames = Number(match[4]);
      if (seconds >= 60 || frames >= 75) return bad('MALFORMED');
      const cueFrames = (minutes * 60 + seconds) * 75 + frames;
      if (!Number.isSafeInteger(cueFrames)) return bad('MALFORMED');
      if (index === 0) {
        if (current.index00Frames !== null || current.index01Frames !== null) return bad('MALFORMED'); current.index00Frames = cueFrames;
      } else if (index === 1) {
        if (current.index01Frames !== null) return bad('MALFORMED'); current.index01Frames = cueFrames;
      } else return bad('UNSUPPORTED_DIRECTIVE');
      continue;
    }
    if (verb === 'TITLE' || verb === 'PERFORMER') {
      const match = /^"([^"\r\n]*)"$/u.exec(argument); if (!match) return bad('MALFORMED');
      const value = match[1]!; if (Buffer.byteLength(value, 'utf8') > budget.maxFieldUtf8Bytes) return bad('BUDGET_EXCEEDED');
      if (current) {
        if (verb === 'TITLE') { if (current.title !== undefined) return bad('MALFORMED'); current.title = value; }
        else { if (current.performer !== undefined) return bad('MALFORMED'); current.performer = value; }
      } else if (verb === 'TITLE') { if (albumTitle !== undefined) return bad('MALFORMED'); albumTitle = value; }
      else { if (albumPerformer !== undefined) return bad('MALFORMED'); albumPerformer = value; }
      continue;
    }
    return bad('UNSUPPORTED_DIRECTIVE');
  }
  const ended = finishTrack(); if (ended) return bad(ended);
  if (tracks.length === 0 || fileTracks === 0) return bad('MALFORMED');
  return { status: 'ok', ...(albumTitle !== undefined ? { albumTitle } : {}),
    ...(albumPerformer !== undefined ? { albumPerformer } : {}), tracks };
}
