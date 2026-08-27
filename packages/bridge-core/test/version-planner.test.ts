import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { MediaLayoutSpec, SourceBinding, MasterDraft } from '@music-bridge/contracts';
const spec = (overrides: Partial<MediaLayoutSpec> = {}): MediaLayoutSpec => ({ format: 'cassette', splitAfter: 2, leadInMs: 1000, tailMs: 2000, defaultGapMs: 5000, rules: [], compatibility: { confirmed: true, cassetteTypes: ['II'], dat: true }, ...overrides });
function fixture() {
  const tracks = [44101, 48001, 96001].map((frames, i) => ({ id: randomUUID(), source: 'roon' as const, metadata: { title: `曲目 ${i + 1}`, durationMs: 1000 }, frames, rate: [44100, 48000, 96000][i]! }));
  const draft: MasterDraft = { id: randomUUID(), title: '合成母版', programType: 'compilation', revision: 1, status: 'draft', sourceLockEligible: false, trackCount: tracks.length, tracks: tracks.map(({ id, source, metadata }) => ({ id, source, metadata })) };
  const sources = tracks.map((t, i) => ({ trackId: t.id, binding: { id: randomUUID(), rootId: randomUUID(), fileName: '合成.wav', acquisition: 'userFileBind', verification: 'fileHashVerified', preservation: 'externalReferenceOnly', availability: 'ONLINE', sha256: String(i+1).repeat(64), size: t.frames * 4 + 44, modifiedAt: '2026-08-27T00:00:00.000Z', verifiedAt: '2026-08-27T00:00:00.000Z', technical: { container: 'WAV', codec: 'PCM', sampleRate: t.rate, channels: 2, bitsPerSample: 16, lossless: true, durationMs: 1000, sampleFrames: t.frames, frameEvidence: 'container-declared' }, userConfirmed: true, sourceLockEligible: true } as SourceBinding, jobs: [] }));
  return { draft, sources };
}
async function planner() { const module = await import('../src/recording/version-planner.js'); return module; }
test('冻结时间线从源帧数换算，五秒为 480000 帧，换面与末曲不额外加 Gap', async () => {
  const { planVersions } = await planner(), f = fixture(), result = planVersions(f.draft, f.sources, spec(), 96000, 60);
  assert.equal(result.timeline.timebase, 'sample-frames'); assert.equal(result.timeline.sampleRate, 96000);
  assert.equal(result.timeline.rounding, 'nearest-half-up-v1');
  assert.deepEqual(result.timeline.sides.map(s => s.tracks.map(t => [t.startFrame, t.endFrame, t.gapAfterFrames])), [[[96000, 192002, 480000], [672002, 768004, 0]], [[96000, 192001, 0]]]);
  assert.deepEqual(result.timeline.sides.map(s => s.totalFrames), [960004, 384001]);
  assert.equal(result.timeline.sides[0]!.capacityFrames, 172800000);
  assert.equal(result.timeline.sides[0]!.tracks[0]!.sourceBindingId, f.sources[0]!.binding.id);
  assert.equal(result.executionReady, false);
});
test('D-02 只改分界/Lead-in/输出时基复用母版，D-03 曲序/源/Transition 改变母版身份', async () => {
  const { planVersions } = await planner(), f = fixture();
  const original = planVersions(f.draft, f.sources, spec(), 96000, 60);
  for (const changed of [spec({ splitAfter: 1 }), spec({ leadInMs: 0 }), spec({ format: 'dat', splitAfter: 0 })]) {
    const next = planVersions(f.draft, f.sources, changed, 48000, 90);
    assert.equal(next.contentHash, original.contentHash); assert.notEqual(next.timelineHash, original.timelineHash);
  }
  assert.notEqual(planVersions({ ...f.draft, tracks: [...f.draft.tracks].reverse() }, f.sources, spec(), 96000, 60).contentHash, original.contentHash);
  assert.notEqual(planVersions(f.draft, f.sources, spec({ defaultGapMs: 0 }), 96000, 60).contentHash, original.contentHash);
  const changedSources = structuredClone(f.sources); changedSources[0]!.binding.sha256 = 'f'.repeat(64);
  assert.notEqual(planVersions(f.draft, changedSources, spec(), 96000, 60).contentHash, original.contentHash);
  const movedSources = structuredClone(f.sources); movedSources[0]!.binding.id = randomUUID(); movedSources[0]!.binding.rootId = randomUUID(); movedSources[0]!.binding.verifiedAt = '2026-08-28T00:00:00.000Z';
  assert.equal(planVersions(f.draft, movedSources, spec(), 96000, 60).contentHash, original.contentHash);
});
test('缺少精确帧证据、映射确认、可用源或分面约束不能冻结；毫秒容量通过但多一帧仍拒绝', async () => {
  const { planVersions } = await planner(), f = fixture();
  for (const mutate of [(b: SourceBinding) => { delete b.technical.sampleFrames; delete b.technical.frameEvidence; }, (b: SourceBinding) => { b.userConfirmed = false; }, (b: SourceBinding) => { b.availability = 'CONTENT_CHANGED'; }]) {
    const sources = structuredClone(f.sources); mutate(sources[0]!.binding);
    assert.throws(() => planVersions(f.draft, sources, spec(), 96000, 60));
  }
  assert.throws(() => planVersions(f.draft, f.sources, spec({ rules: [{ trackId: f.draft.tracks[1]!.id, keepWithNext: true }] }), 96000, 60));
  assert.throws(() => planVersions(f.draft, f.sources, spec(), 0, 60));
  const sources = structuredClone(f.sources), draft = { ...f.draft, tracks: f.draft.tracks.slice(0, 1), trackCount: 1 };
  sources[0]!.binding.technical.sampleFrames = 44100 * 30 + 1; sources[0]!.binding.technical.durationMs = 30000;
  assert.throws(() => planVersions(draft, sources.slice(0, 1), spec({ splitAfter: 1, leadInMs: 0, tailMs: 0 }), 44100, 1), /容量/u);
});
test('空面无静音，DAT 连续段无跨面边界，显式无间隔规则进入母版和时间线', async () => {
  const { planVersions } = await planner(), f = fixture();
  const empty = planVersions(f.draft, f.sources, spec({ splitAfter: 3 }), 44100, 60);
  assert.deepEqual([empty.timeline.sides[1]!.leadInFrames, empty.timeline.sides[1]!.tailFrames, empty.timeline.sides[1]!.totalFrames], [0, 0, 0]);
  const continuous = planVersions({ ...f.draft, programType: 'concert' }, f.sources, spec({ format: 'dat', splitAfter: 0, defaultGapMs: 0 }), 48000, 60);
  assert.deepEqual(continuous.timeline.sides.map(s => s.name), ['Program']);
  assert.deepEqual(continuous.timeline.sides[0]!.tracks.map(t => t.gapAfterFrames), [0, 0, 0]);
  assert.ok(continuous.content.tracks.every(t => t.transitionAfterMs === 0));
});
