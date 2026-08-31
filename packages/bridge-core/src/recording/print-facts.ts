import { createHash } from 'node:crypto';
import {
  RECORDING_PRINT_GEOMETRY, RECORDING_PRINT_TEMPLATE_ID, MAX_RECORDING_PRINT_PAGES,
  isRecordingRecord, isRecordingPlanVersion, isRecordingPrintFacts, isRecordingPrintRequest,
  type RecordingRecord, type RecordingPlanVersion, type RecordingPrintFacts, type RecordingPrintRequest,
} from '@music-bridge/contracts';

/** 仅固定模板语义；真实PDF渲染由受限Main producer完成。 */
export const RECORDING_PRINT_TEMPLATE_SPEC = Object.freeze({
  id: RECORDING_PRINT_TEMPLATE_ID, version: 1, geometry: RECORDING_PRINT_GEOMETRY,
  layout: 'outside-then-inside-continuations', minBodyFontPt: 7.5, maxPages: MAX_RECORDING_PRINT_PAGES,
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export const RECORDING_PRINT_TEMPLATE_HASH = digest(RECORDING_PRINT_TEMPLATE_SPEC);
export class RecordingPrintFactsError extends Error {
  constructor(readonly code: 'INVALID_HISTORY' | 'NOT_APPLICABLE' | 'INVALID_REQUEST') { super(code); this.name = 'RecordingPrintFactsError'; }
}
const reject = (code: RecordingPrintFactsError['code']): never => { throw new RecordingPrintFactsError(code); };

/** 从冻结Record/Plan提取；不访问数据库、当前型号、当前Artwork或执行准入。 */
export function buildRecordingPrintFacts(record: RecordingRecord, plan: RecordingPlanVersion): RecordingPrintFacts {
  if (!isRecordingRecord(record) || !isRecordingPlanVersion(plan)) return reject('INVALID_HISTORY');
  const c = record.completion, media = record.media;
  if (c.planVersionId !== plan.id || c.planContentHash !== plan.contentHash || c.draftId !== plan.draftId || c.executionAssetId !== plan.execution.assetId
    || c.physicalId !== plan.physicalCopy.physicalId || media.modelId !== plan.layout.reservation.modelId || media.skuId !== plan.physicalCopy.skuId
    || media.lotId !== plan.physicalCopy.lotId || media.origin !== plan.physicalCopy.origin || media.lengthMinutes !== plan.physicalCopy.lengthMinutes
    || c.sides.length !== plan.execution.audio.length || !c.sides.every((s, i) => {
      const a = plan.execution.audio[i]!;
      return s.side === a.recipe.side && s.frameCount === a.audio.frameCount && s.recipeHash === a.recipeHash && s.audioSha256 === a.audio.sha256 && s.pcmSha256 === a.audio.pcmSha256;
    }) || record.visuals.artwork.state === 'captured' && record.visuals.artwork.version.masterVersionId !== plan.master.id) return reject('INVALID_HISTORY');
  if (plan.layout.spec.format !== 'cassette') return reject('NOT_APPLICABLE');
  const facts: RecordingPrintFacts = {
    schemaVersion: 1, recordingId: record.id, recordingContentHash: record.contentHash, planVersionId: plan.id, planContentHash: plan.contentHash,
    physicalId: c.physicalId, title: plan.master.title, spine: plan.master.title, completedAt: c.endedAt, displayDateUtc: c.endedAt.slice(0, 10),
    tapeModel: media.snapshotSource === 'completion' ? { state: 'known', descriptor: structuredClone(media.descriptor) } : { state: 'unknown' },
    sides: plan.layout.timeline.sides.map(side => {
      if (side.name !== 'A' && side.name !== 'B') return reject('INVALID_HISTORY');
      const audio = plan.execution.audio.find(a => a.recipe.side === side.name);
      if (!audio && side.totalFrames !== 0) return reject('INVALID_HISTORY');
      const frameCount = audio?.audio.frameCount ?? 0, sampleRate = audio?.recipe.format.sampleRate ?? plan.execution.compiledSettings.format.sampleRate;
      return { side: side.name, frameCount, sampleRate, durationMs: Number((BigInt(frameCount) * 2000n + BigInt(sampleRate)) / (2n * BigInt(sampleRate))),
        tracks: side.tracks.map((track, index) => {
          const source = plan.master.content.tracks.find(t => t.trackId === track.trackId);
          if (!source) return reject('INVALID_HISTORY');
          return { position: index + 1, trackId: track.trackId, title: source.metadata.title, ...(source.metadata.artist !== undefined ? { artist: source.metadata.artist } : {}) };
        }) };
    }),
    artwork: structuredClone(record.visuals.artwork),
  };
  if (!isRecordingPrintFacts(facts)) return reject('INVALID_HISTORY');
  return facts;
}
export function hashRecordingPrintFacts(facts: RecordingPrintFacts): string {
  if (!isRecordingPrintFacts(facts)) return reject('INVALID_HISTORY');
  return digest(facts);
}
export function hashRecordingPrintInput(input: { factsHash: string; templateHash: string }): string {
  if (Object.keys(input).length !== 2 || ![input.factsHash, input.templateHash].every(value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/u.test(value))) return reject('INVALID_REQUEST');
  return digest(input);
}
export function createRecordingPrintRequest(input: {
  id: string; record: RecordingRecord; plan: RecordingPlanVersion; origin: RecordingPrintRequest['origin']; createdAt: string;
}): { request: RecordingPrintRequest; facts: RecordingPrintFacts } {
  const { id, record, plan, origin, createdAt } = input;
  const facts = buildRecordingPrintFacts(record, plan);
  if (origin === 'completion' ? record.schemaVersion !== 2 || record.printRequestId !== id : origin !== 'historical-backfill' || record.schemaVersion !== 1) return reject('INVALID_REQUEST');
  const factsHash = hashRecordingPrintFacts(facts), templateHash = RECORDING_PRINT_TEMPLATE_HASH;
  const request: RecordingPrintRequest = { id, recordingId: record.id, recordingContentHash: record.contentHash, planVersionId: plan.id, planContentHash: plan.contentHash,
    origin, templateId: RECORDING_PRINT_TEMPLATE_ID, templateHash, factsHash, inputHash: hashRecordingPrintInput({ factsHash, templateHash }), createdAt };
  if (!isRecordingPrintRequest(request) || createdAt < record.createdAt) return reject('INVALID_REQUEST');
  return { request, facts };
}
