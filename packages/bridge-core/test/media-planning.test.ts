import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { CollectionModel, MediaLayoutSpec, MediaTimingTrack } from '@music-bridge/contracts';
import { resolveMediaLayout, balancedSplit, assessMediaCandidate } from '../src/recording/media-planner.js';
const spec = (overrides: Partial<MediaLayoutSpec> = {}): MediaLayoutSpec => ({ format: 'cassette', splitAfter: 2, leadInMs: 1000, tailMs: 2000, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['I', 'II'], dat: false }, ...overrides });
const tracks = (...durations: (number | undefined)[]): MediaTimingTrack[] => durations.map(durationMs => ({ trackId: randomUUID(), ...(durationMs === undefined ? {} : { durationMs }), basis: 'roon-estimate' }));
const model = (overrides: Partial<CollectionModel> = {}): CollectionModel => ({ id: randomUUID(), brand: 'TDK', name: 'SA', edition: '合成版', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified', collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1, lengths: [60], counts: { total: 8, sealedBlank: 5, openedBlank: 3, legacyUsed: 0, recorded: 0, reserved: 0, unavailable: 0, unknown: 0 }, ...overrides });

test('分面按每面真实边界计算 Gap，Lead-in/Tail 独立，源顺序不改变', () => {
  const music = tracks(180000, 210000, 120000), result = resolveMediaLayout(music, spec());
  assert.equal(result.timebase, 'milliseconds'); assert.equal(result.executionReady, false);
  assert.deepEqual(result.sides.map(s => s.durationMs), [398000, 123000]);
  assert.deepEqual(result.sides.flatMap(s => s.tracks.map(t => t.trackId)), music.map(t => t.trackId));
  assert.deepEqual(result.sides[0]!.tracks.map(t => [t.startMs, t.endMs, t.gapAfterMs]), [[1000, 181000, 5000], [186000, 396000, 0]]);
  assert.equal(result.constraints.length, 0);
});

test('未知曲长不伪造总时长；空面不添加 Lead-in/Tail；连续节目只生成 Program', () => {
  const unknown = resolveMediaLayout(tracks(180000, undefined), spec());
  assert.equal(unknown.sides[0]!.durationMs, undefined); assert.equal(unknown.sides[0]!.tracks[1]!.endMs, undefined);
  assert.equal(unknown.sides[1]!.durationMs, 0); assert.equal(unknown.sides[1]!.leadInMs, 0);
  const continuous = resolveMediaLayout(tracks(180000, 210000), spec({ format: 'dat', splitAfter: 0, defaultGapMs: 0 }));
  assert.deepEqual(continuous.sides.map(s => [s.name, s.durationMs]), [['Program', 393000]]);
});

test('辅助平衡只选分界，Keep With Next 和强制面/首尾约束都参与', () => {
  const music = tracks(100000, 100000, 100000, 100000);
  assert.equal(balancedSplit(music, spec()), 2);
  const constraints = spec({ rules: [{ trackId: music[1]!.trackId, keepWithNext: true }, { trackId: music[0]!.trackId, forceSide: 'A' }, { trackId: music[3]!.trackId, forceSide: 'B', sideOpener: true }] });
  assert.equal(balancedSplit(music, constraints), 3);
  assert.ok(resolveMediaLayout(music, { ...constraints, splitAfter: 2 }).constraints.length > 0);
  assert.throws(() => balancedSplit(tracks(1000, undefined), spec()));
  assert.throws(() => balancedSplit(music, spec({ rules: [{ trackId: music[0]!.trackId, forceSide: 'B' }] })));
});

test('逐曲 Gap 覆盖仅用于实际相邻边界，不添加最后一首或跨面的 Gap', () => {
  const music = tracks(1000, 2000, 3000), result = resolveMediaLayout(music, spec({ leadInMs: 0, tailMs: 0, rules: [{ trackId: music[0]!.trackId, gapAfterMs: 0 }, { trackId: music[1]!.trackId, gapAfterMs: 60000 }] }));
  assert.deepEqual(result.sides.map(s => s.durationMs), [3000, 3000]);
});

test('总时长装得下但 A 面超长仍排除；不把未知兼容性当成可正式使用', () => {
  const request = spec({ leadInMs: 0, tailMs: 0 }), layout = resolveMediaLayout(tracks(1000000, 1000000, 500000), request);
  const stock = { skuId: randomUUID(), model: model(), lengthMinutes: 60, packaging: 'opened' as const, availableCount: 3 };
  const tooShort = assessMediaCandidate(stock, layout, request, 'roon-estimate'); assert.equal(tooShort.fit, 'too-short'); assert.equal(tooShort.status, 'excluded'); assert.equal(tooShort.reservableCount, 0);
  const fitting = resolveMediaLayout(tracks(1000, 2000), request), unknown = assessMediaCandidate(stock, fitting, { ...request, compatibility: { confirmed: false, cassetteTypes: [], dat: false } }, 'roon-estimate');
  assert.equal(unknown.status, 'pending'); assert.ok(unknown.reasons.includes('compatibility-unknown')); assert.equal(unknown.reservableCount, 0);
  assert.equal(assessMediaCandidate(stock, fitting, request, 'roon-estimate').status, 'recommended');
});

test('收藏保护与最低未拆保留线跨 SKU 生效；无源或布局冲突不能预留', () => {
  const request = spec(), layout = resolveMediaLayout(tracks(1000, 2000), request), stock = { skuId: randomUUID(), model: model({ minimumSealedReserve: 3 }), lengthMinutes: 60, packaging: 'sealed' as const, availableCount: 5 };
  assert.equal(assessMediaCandidate(stock, layout, request, 'roon-estimate').reservableCount, 2);
  const protectedStock = { ...stock, model: model({ collectorPolicy: 'collector' }) };
  assert.equal(assessMediaCandidate(protectedStock, layout, request, 'roon-estimate').status, 'excluded');
  assert.equal(assessMediaCandidate(stock, layout, request, 'unavailable').reservableCount, 0);
  assert.equal(assessMediaCandidate(stock, { ...layout, constraints: ['分界冲突'] }, request, 'roon-estimate').reservableCount, 0);
});
