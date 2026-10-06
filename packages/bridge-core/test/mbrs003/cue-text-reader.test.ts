import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCueText, type CueOwnerAssetReference, type CueReadResult, type CueReadBudget } from '../../src/library/cue-text-reader.js';
const a: CueOwnerAssetReference = Object.freeze({ assetId: '11111111-1111-4111-8111-111111111111',
  libraryRootId: '22222222-2222-4222-8222-222222222222', sourceRootId: '33333333-3333-4333-8333-333333333333',
  rootRevision: '9007199254740992', fileRevision: '9007199254740993', locationRevision: '18446744073709551615' });
const b: CueOwnerAssetReference = Object.freeze({ ...a, assetId: '44444444-4444-4444-8444-444444444444', locationRevision: '9007199254740994' });
const bindings = new Map<string, readonly CueOwnerAssetReference[]>([['a.flac', Object.freeze([a])], ['b.flac', Object.freeze([b])]]);
const base = ['FILE "a.flac" WAVE', 'TRACK 01 AUDIO', 'INDEX 01 00:00:00'].join(String.fromCharCode(10));
const join = (...lines: string[]): string => lines.join(String.fromCharCode(10));
const good = (result: CueReadResult<CueOwnerAssetReference>): Extract<CueReadResult<CueOwnerAssetReference>, { status: 'ok' }> => {
  assert.equal(result.status, 'ok'); if (result.status !== 'ok') assert.fail('合法CUE须产生文本事实'); return result;
};
const failed = (input: string | Uint8Array, code: string, options: Partial<CueReadBudget> = {},
  associations: ReadonlyMap<string, readonly CueOwnerAssetReference[]> = bindings): void => {
  const result = parseCueText(input, associations, options); assert.equal(result.status, 'failure');
  if (result.status === 'failure') assert.equal(result.code, code);
};

test('MBRS003 CUE合成文本保留75fps整数INDEX，零起点合法且不推sampleFrames或播放', () => {
  const source = join('TITLE "合成专辑"', 'PERFORMER "合成艺人"', 'FILE "a.flac" WAVE',
    'TRACK 01 AUDIO', 'TITLE "第一段"', 'INDEX 01 00:00:00', 'TRACK 02 AUDIO', 'INDEX 00 00:00:08', 'INDEX 01 00:00:10');
  const result = good(parseCueText(source, bindings)); assert.equal(result.albumTitle, '合成专辑'); assert.equal(result.albumPerformer, '合成艺人');
  assert.deepEqual(result.tracks.map(t => [t.trackNumber, t.index00Frames, t.index01Frames]), [[1, null, 0], [2, 8, 10]]);
  assert.equal(result.tracks[0]!.title, '第一段');
  for (const track of result.tracks) {
    assert.equal(track.timebase, 'cue-cd-frames'); assert.equal(track.framesPerSecond, 75); assert.equal(track.endFrames, null);
    assert.equal(track.evidence, 'cue-text-declared'); assert.equal(track.playback, 'NOT_VERIFIED');
    assert.equal(Object.hasOwn(track, 'sampleFrames') || Object.hasOwn(track, 'sampleRate') || Object.hasOwn(track, 'durationSeconds'), false);
  }
});
test('MBRS003 CUE可信资产快照的相邻大整数revision原样保留，源关联不可改写', () => {
  const before = JSON.stringify([...bindings]); const result = good(parseCueText(base, bindings));
  assert.strictEqual(result.tracks[0]!.assetReference, a); assert.deepEqual(result.tracks[0]!.assetReference, a);
  assert.notEqual(a.rootRevision, a.fileRevision); assert.equal(result.tracks[0]!.assetReference.fileRevision, '9007199254740993');
  assert.equal(JSON.stringify([...bindings]), before);
});
test('MBRS003 CUE多FILE保持独立时间原点和唯一asset，不因同标题合并', () => {
  const result = good(parseCueText(join('FILE "a.flac" WAVE', 'TRACK 01 AUDIO', 'TITLE "同名"', 'INDEX 01 00:00:10',
    'FILE "b.flac" WAVE', 'TRACK 02 AUDIO', 'TITLE "同名"', 'INDEX 01 00:00:00'), bindings));
  assert.deepEqual(result.tracks.map(t => [t.fileOrdinal, t.assetReference.assetId, t.index01Frames]), [[1, a.assetId, 10], [2, b.assetId, 0]]);
  assert.equal(result.tracks.length, 2); assert.equal(result.tracks.every(t => t.endFrames === null), true);
});
test('MBRS003 CUE缺失与多候选关联明确拒绝，两个同ID候选也不自动exact消歧', () => {
  failed(base, 'UNBOUND_FILE', {}, new Map());
  failed(base, 'UNBOUND_FILE', {}, new Map([['a.flac', []]]));
  failed(base, 'AMBIGUOUS_FILE', {}, new Map([['a.flac', [a, b]]]));
  failed(base, 'AMBIGUOUS_FILE', {}, new Map([['a.flac', [a, a]]]));
});
test('MBRS003 CUE合法UTF8字节与BOM/CRLF产生相同事实', () => {
  const source = join('TITLE "中文音乐😀"', ...base.split(String.fromCharCode(10)));
  const expected = good(parseCueText(source, bindings));
  const withBom = '\ufeff' + source.replaceAll(String.fromCharCode(10), String.fromCharCode(13, 10));
  assert.deepEqual(parseCueText(Buffer.from(withBom, 'utf8'), bindings), expected);
  assert.deepEqual(parseCueText(withBom, bindings), expected);
});
test('MBRS003 CUE非法UTF8与孤立surrogate拒绝，不能替换解码冒成功', () => {
  for (const bytes of [new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xed, 0xa0, 0x80]), new Uint8Array([0xe4, 0xb8])]) failed(bytes, 'MALFORMED');
  failed('\ud800', 'MALFORMED'); failed('\udc00', 'MALFORMED');
});
test('MBRS003 CUEUTF8总字节精确阈值通过，多1B拒绝', () => {
  const source = join('TITLE "音乐😀"', ...base.split(String.fromCharCode(10))), bytes = Buffer.byteLength(source);
  assert.equal(good(parseCueText(source, bindings, { maxUtf8Bytes: bytes })).tracks.length, 1);
  failed(source, 'BUDGET_EXCEEDED', { maxUtf8Bytes: bytes - 1 });
  failed(Buffer.from(source), 'BUDGET_EXCEEDED', { maxUtf8Bytes: bytes - 1 });
});
test('MBRS003 CUE单字段预算按UTF8字节而非JS字符数', () => {
  const source = join('TITLE "éééé"', ...base.split(String.fromCharCode(10)));
  assert.equal(good(parseCueText(source, bindings, { maxFieldUtf8Bytes: 8 })).albumTitle, 'éééé');
  failed(source, 'BUDGET_EXCEEDED', { maxFieldUtf8Bytes: 7 });
});
test('MBRS003 CUE行上限在分割前限制，CRLF按单次换行计数', () => {
  assert.equal(good(parseCueText(base, bindings, { maxLines: 3 })).tracks.length, 1);
  failed(base, 'BUDGET_EXCEEDED', { maxLines: 2 });
  assert.equal(good(parseCueText(base.replaceAll(String.fromCharCode(10), String.fromCharCode(13, 10)), bindings, { maxLines: 3 })).tracks.length, 1);
});
test('MBRS003 CUE条目上限不静默丢后续track', () => {
  const source = join(base, 'TRACK 02 AUDIO', 'INDEX 01 00:00:10');
  assert.equal(good(parseCueText(source, bindings, { maxTracks: 2 })).tracks.length, 2);
  failed(source, 'BUDGET_EXCEEDED', { maxTracks: 1 });
});
test('MBRS003 CUEFILE上限保留多源正控制，越界拒绝', () => {
  const source = join(base, 'FILE "b.flac" WAVE', 'TRACK 02 AUDIO', 'INDEX 01 00:00:00');
  assert.equal(good(parseCueText(source, bindings, { maxFiles: 2 })).tracks.length, 2);
  failed(source, 'BUDGET_EXCEEDED', { maxFiles: 1 });
});
test('MBRS003 CUE可信预算不可提高默认上限或传未知字段', () => {
  failed(base, 'MALFORMED', { maxTracks: 100 }); failed(base, 'MALFORMED', { maxUtf8Bytes: 65537 });
  failed(base, 'MALFORMED', { maxLines: 0 });
  failed(base, 'MALFORMED', { arbitrary: 1 } as unknown as Partial<CueReadBudget>);
  failed(base, 'MALFORMED', null as unknown as Partial<CueReadBudget>);
});
test('MBRS003 CUE分钟秒帧整数保持精确，74帧合法而75帧或60秒拒绝', () => {
  const prefix = join('FILE "a.flac" WAVE', 'TRACK 01 AUDIO');
  assert.equal(good(parseCueText(join(prefix, 'INDEX 01 999:59:74'), bindings)).tracks[0]!.index01Frames, 4_499_999);
  failed(join(prefix, 'INDEX 01 00:00:75'), 'MALFORMED'); failed(join(prefix, 'INDEX 01 00:60:00'), 'MALFORMED');
  failed(join(prefix, 'INDEX 01 -1:00:00'), 'MALFORMED'); failed(join(prefix, 'INDEX 01 00:00:0.5'), 'MALFORMED');
});
test('MBRS003 CUETRACK00、重复和倒序TRACK拒绝', () => {
  failed(join('FILE "a.flac" WAVE', 'TRACK 00 AUDIO', 'INDEX 01 00:00:00'), 'MALFORMED');
  failed(join(base, 'TRACK 01 AUDIO', 'INDEX 01 00:00:10'), 'MALFORMED');
  failed(join('FILE "a.flac" WAVE', 'TRACK 02 AUDIO', 'INDEX 01 00:00:00', 'TRACK 01 AUDIO', 'INDEX 01 00:00:10'), 'MALFORMED');
});
test('MBRS003 CUE同FILE相同或倒序INDEX01拒绝', () => {
  failed(join(base, 'TRACK 02 AUDIO', 'INDEX 01 00:00:00'), 'MALFORMED');
  failed(join('FILE "a.flac" WAVE', 'TRACK 01 AUDIO', 'INDEX 01 00:00:10', 'TRACK 02 AUDIO', 'INDEX 01 00:00:09'), 'MALFORMED');
});
test('MBRS003 CUE重复INDEX00/01与未支持INDEX02明确拒绝', () => {
  failed(join(base, 'INDEX 01 00:00:10'), 'MALFORMED');
  failed(join('FILE "a.flac" WAVE', 'TRACK 01 AUDIO', 'INDEX 00 00:00:00', 'INDEX 00 00:00:01', 'INDEX 01 00:00:02'), 'MALFORMED');
  failed(join(base, 'INDEX 02 00:00:10'), 'UNSUPPORTED_DIRECTIVE');
});
test('MBRS003 CUEINDEX00不得晚于01、回到前track之前或声明顺序倒置', () => {
  const prefix = join('FILE "a.flac" WAVE', 'TRACK 01 AUDIO');
  failed(join(prefix, 'INDEX 00 00:00:11', 'INDEX 01 00:00:10'), 'MALFORMED');
  failed(join(prefix, 'INDEX 01 00:00:10', 'TRACK 02 AUDIO', 'INDEX 00 00:00:09', 'INDEX 01 00:00:20'), 'MALFORMED');
  failed(join(prefix, 'INDEX 01 00:00:10', 'INDEX 00 00:00:09'), 'MALFORMED');
});
test('MBRS003 CUE空文本、空FILE、缺INDEX01与先TRACK后FILE拒绝', () => {
  failed('', 'MALFORMED'); failed('REM bounded comment', 'MALFORMED'); failed('FILE "a.flac" WAVE', 'MALFORMED');
  failed(join('FILE "a.flac" WAVE', 'TRACK 01 AUDIO'), 'MALFORMED'); failed('TRACK 01 AUDIO', 'MALFORMED');
  failed(join('FILE "a.flac" WAVE', 'FILE "b.flac" WAVE', 'TRACK 01 AUDIO', 'INDEX 01 00:00:00'), 'MALFORMED');
});
test('MBRS003 CUEFILE locator不能变打开许可，危险文字在关联查表前拒绝', () => {
  let lookups = 0;
  class CheckedMap extends Map<string, readonly CueOwnerAssetReference[]> {
    override get(key: string): readonly CueOwnerAssetReference[] | undefined { ++lookups; return super.get(key); }
  }
  const known = new CheckedMap();
  for (const name of ['../a.flac', '/a.flac', 'file:///a.flac', 'http://example.invalid/a.flac', 'C:\\a.flac', '.', '..']) {
    failed(join(`FILE "${name}" WAVE`, 'TRACK 01 AUDIO', 'INDEX 01 00:00:00'), 'MALFORMED', {}, known);
  }
  assert.equal(lookups, 0);
});
test('MBRS003 CUEFILE名512字节边界明确，不依靠扩展名确认codec', () => {
  const name = 'a'.repeat(512), source = join(`FILE "${name}" WAVE`, 'TRACK 01 AUDIO', 'INDEX 01 00:00:00');
  assert.equal(good(parseCueText(source, new Map([[name, [a]]]))).tracks[0]!.assetReference.assetId, a.assetId);
  failed(join(`FILE "${name}a" WAVE`, 'TRACK 01 AUDIO', 'INDEX 01 00:00:00'), 'BUDGET_EXCEEDED');
});
test('MBRS003 CUE未知语义不静默归零，数据TRACK/PREGAP/POSTGAP明确未支持', () => {
  failed(join(base, 'PREGAP 00:00:10'), 'UNSUPPORTED_DIRECTIVE'); failed(join(base, 'POSTGAP 00:00:10'), 'UNSUPPORTED_DIRECTIVE');
  failed(join('FILE "a.flac" WAVE', 'TRACK 01 MODE1/2352', 'INDEX 01 00:00:00'), 'UNSUPPORTED_DIRECTIVE');
  failed(join(base, 'FLAGS DCP'), 'UNSUPPORTED_DIRECTIVE');
  assert.equal(good(parseCueText(join('REM synthetic note', base), bindings)).tracks.length, 1);
});
test('MBRS003 CUE控制字节和隐藏Unicode行分隔不能逃避语法或行预算', () => {
  for (const control of ['\u0000', '\u0001', '\u007f', '\u2028', '\u2029']) failed(join(`TITLE "a${control}b"`, base), 'MALFORMED');
});
test('MBRS003 CUE重复title/performer拒绝，输入不是持久化或exact播放证明', () => {
  failed(join('TITLE "a"', 'TITLE "b"', base), 'MALFORMED');
  failed(join('PERFORMER "a"', 'PERFORMER "b"', base), 'MALFORMED');
  failed(join('FILE "a.flac" WAVE', 'TRACK 01 AUDIO', 'TITLE "a"', 'TITLE "b"', 'INDEX 01 00:00:00'), 'MALFORMED');
  const result = good(parseCueText(base, bindings)); assert.equal(Object.hasOwn(result, 'persisted') || Object.hasOwn(result, 'playing'), false);
  assert.equal(result.tracks[0]!.playback, 'NOT_VERIFIED');
});
