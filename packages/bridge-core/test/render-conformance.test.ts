import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { RawRenderAsset, RenderAssessment, RenderTimelineSide } from '@music-bridge/contracts';
import { preparationFixture } from './helpers/preparation-fixture.js';
import { assessRender } from '../src/recording/render-conformance.js';

test('Render 五态依据逐曲身份、精确帧与人工确认，不靠文件名或总时长猜测', async t => {
  const f = await preparationFixture(t), job = await f.freeze(); await f.versions.idle();
  const id = f.versions.job(job.id).job!.layoutVersionId!;
  const { master, layout } = f.repository.preparations.frozen(id);
  const assets: RawRenderAsset[] = layout.timeline.sides.map(s => ({ id: randomUUID(), side: s.name, sha256: 'a'.repeat(64), size: 100, format: 'wav', sampleRate: 96000, channelLayout: 'stereo', totalFrames: s.totalFrames, createdAt: new Date().toISOString(), creationTimeEvidence: 'first-observed' }));
  const base: RenderAssessment = { structureChanged: false, acceptVariance: false, varianceReason: '', timeline: { timebase: 'sample-frames', sides: layout.timeline.sides.map((s, i) => ({ name: s.name, renderAssetId: assets[i]!.id, renderFileHash: assets[i]!.sha256, sampleRate: assets[i]!.sampleRate, channelLayout: 'stereo', totalFrames: assets[i]!.totalFrames, markers: s.tracks.map(track => ({ trackId: track.trackId, exactSourceSha256: master.content.tracks.find(m => m.trackId === track.trackId)!.source.sha256, actualStartFrame: track.startFrame, actualEndFrame: track.endFrame, actualGapToNextFrames: track.gapAfterFrames, confirmationMethod: 'manual', userConfirmed: true })) })) } };
  type MutableSide = Omit<RenderTimelineSide, 'markers'> & { markers: Array<RenderTimelineSide['markers'][number]> };
  const changed = () => structuredClone(base) as Omit<RenderAssessment, 'timeline'> & { timeline: { timebase: 'sample-frames'; sides: MutableSide[] } };
  const evaluate = (input = base, raw = assets) => assessRender(master, layout, raw, input);
  await t.test('逐曲一致且全部人工确认才 MATCHED', () => { assert.deepEqual(evaluate(), { status: 'MATCHED', policy: 'one-render-frame-v1', reasons: [] }); });
  await t.test('自动候选和未确认 Marker 都不能冻结', () => {
    const c = changed(); c.timeline.sides[0]!.markers[0]!.userConfirmed = false; assert.equal(evaluate(c).status, 'REJECTED');
    c.timeline.sides[0]!.markers[0]!.userConfirmed = true; c.timeline.sides[0]!.markers[0]!.confirmationMethod = 'automatic-candidate'; assert.equal(evaluate(c).status, 'REJECTED');
  });
  await t.test('一 Render 帧内容差闭区间；超出必须明确接受差异', () => {
    const c = changed(); c.timeline.sides[0]!.markers[0]!.actualStartFrame++; assert.equal(evaluate(c).status, 'MATCHED');
    c.timeline.sides[0]!.markers[0]!.actualStartFrame++; assert.equal(evaluate(c).status, 'REJECTED');
    c.acceptVariance = true; assert.equal(evaluate(c).status, 'REJECTED');
    c.varianceReason = '人工在最终 WAV 中确认缩短开头淡入'; assert.equal(evaluate(c).status, 'ACCEPTED_VARIANCE');
  });
  await t.test('总时长相同但曲目、全局顺序或 ExactSource 变化必须新母版', () => {
    const source = changed(); source.timeline.sides[0]!.markers[0]!.exactSourceSha256 = 'b'.repeat(64); assert.equal(evaluate(source).status, 'REQUIRES_NEW_MASTER');
    const order = changed(), [a,b] = order.timeline.sides[0]!.markers; [a!.trackId,b!.trackId] = [b!.trackId,a!.trackId]; assert.equal(evaluate(order).status, 'REQUIRES_NEW_MASTER');
    const removed = changed(); removed.timeline.sides[1]!.markers = []; assert.equal(evaluate(removed).status, 'REQUIRES_NEW_MASTER');
    const duplicate = changed(); duplicate.timeline.sides[0]!.markers[1]!.trackId = duplicate.timeline.sides[0]!.markers[0]!.trackId; assert.equal(evaluate(duplicate).status, 'REQUIRES_NEW_MASTER');
  });
  await t.test('换面保持全局顺序仍须新布局，用户接受不能覆盖结构变化', () => {
    const c = changed(), moved = c.timeline.sides[0]!.markers.pop()!;
    c.timeline.sides[0]!.markers[0]!.actualGapToNextFrames = 0;
    moved.actualStartFrame = 0; moved.actualEndFrame = 100; moved.actualGapToNextFrames = c.timeline.sides[1]!.markers[0]!.actualStartFrame - 100;
    c.timeline.sides[1]!.markers.unshift(moved); c.acceptVariance = true; c.varianceReason = '换面';
    assert.equal(evaluate(c).status, 'REQUIRES_NEW_LAYOUT');
    const structural = changed(); structural.structureChanged = true; assert.equal(evaluate(structural).status, 'REQUIRES_NEW_LAYOUT');
  });
  await t.test('用户声明已换曲或换源时，即使沿用计划 Marker 也必须新母版', () => { assert.equal(evaluate({ ...base, contentIdentityChanged: true } as RenderAssessment).status, 'REQUIRES_NEW_MASTER'); });
  await t.test('实际文件容量严格检查；不能用一帧容差越过介质容量', () => {
    const c = changed(), raw = structuredClone(assets); c.timeline.sides[0]!.totalFrames = layout.timeline.sides[0]!.capacityFrames + 1; raw[0]!.totalFrames = c.timeline.sides[0]!.totalFrames;
    c.acceptVariance = true; c.varianceReason = '已检查'; assert.equal(evaluate(c, raw).status, 'REQUIRES_NEW_LAYOUT');
  });
  await t.test('Render 元数据必须绑定独立原件，Hash/采样率/声道不能替换', () => {
    for (const key of ['renderFileHash','renderAssetId','sampleRate','channelLayout','totalFrames'] as const) {
      const c = changed(), side = c.timeline.sides[0]!;
      Object.assign(side, { [key]: key === 'sampleRate' ? 48000 : key === 'totalFrames' ? side.totalFrames + 1 : key === 'channelLayout' ? 'mono' : key === 'renderAssetId' ? randomUUID() : 'b'.repeat(64) });
      assert.equal(evaluate(c).status, 'REJECTED', key);
    }
  });
  await t.test('重叠、伪造 Gap、不安全整数和超出文件边界拒绝', () => {
    for (const patch of [{ actualEndFrame: 10000000000 }, { actualStartFrame: 1.2 }, { actualGapToNextFrames: 0 }, { actualStartFrame: Number.MAX_SAFE_INTEGER + 1 }]) {
      const c = changed(); Object.assign(c.timeline.sides[0]!.markers[0]!, patch); assert.equal(evaluate(c).status, 'REJECTED');
    }
  });
  await t.test('不同采样率用整数有理数比较，四舍五入至一 Render 帧内', () => {
    const c = changed(), raw = structuredClone(assets);
    for (const [i, s] of c.timeline.sides.entries()) {
      const convert = (n: number) => Number((BigInt(n) * 44100n * 2n + 96000n) / 192000n);
      s.sampleRate = 44100; s.totalFrames = convert(s.totalFrames); raw[i]!.sampleRate = s.sampleRate; raw[i]!.totalFrames = s.totalFrames;
      s.markers = s.markers.map(m => ({ ...m, actualStartFrame: convert(m.actualStartFrame), actualEndFrame: convert(m.actualEndFrame) }));
      for (const [j, m] of s.markers.entries()) m.actualGapToNextFrames = s.markers[j + 1] ? s.markers[j + 1]!.actualStartFrame - m.actualEndFrame : 0;
    }
    assert.equal(evaluate(c, raw).status, 'MATCHED');
  });
});
