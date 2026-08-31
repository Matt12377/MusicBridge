import {
  type CapacityQueuedStopMeasurement,
  type CapacityQueuedStopSummary,
} from '../helpers/recording-capacity-phases.js';

export type CleanCloneCapacityClassification = 'PASS' | 'PRODUCT_BUG' | 'HARNESS_BUG';
export interface CleanCloneSample extends CapacityQueuedStopMeasurement { index: number }

export const CLEAN_CLONE_OBJECTS_LIMIT_CONFIG = Object.freeze({
  profile: 'objects-limit' as const,
  warmupCount: 5 as const,
  formalCount: 100 as const,
  sampleCount: 105 as const,
  executionMs: 50_000 as const,
  killGraceMs: 1_000 as const,
  closeMs: 2_000 as const,
  windowMs: 900_000 as const,
  admissionReserveMs: 53_000 as const,
  activeCloneMaximum: 1 as const,
});

export interface CleanCloneBenchmarkDependencies<Prepared = unknown> {
  prepare(config: typeof CLEAN_CLONE_OBJECTS_LIMIT_CONFIG): Promise<Prepared>;
  sample(prepared: Prepared, index: number, config: typeof CLEAN_CLONE_OBJECTS_LIMIT_CONFIG): Promise<CleanCloneSample | undefined>;
  summarize(values: CapacityQueuedStopMeasurement[]): Pick<CapacityQueuedStopSummary, 'passed'>;
  cleanup(prepared: Prepared | undefined): Promise<void>;
  now(): number;
  log(line: string): void;
}

/** 固定口径的纯编排测试缝；生产CLI不得从本模块直接执行benchmark。 */
export async function runCleanCloneObjectsLimitBenchmark<Prepared>(
  dependencies: CleanCloneBenchmarkDependencies<Prepared>,
): Promise<CleanCloneCapacityClassification> {
  let prepared: Prepared | undefined;
  let classification: CleanCloneCapacityClassification = 'HARNESS_BUG';
  const deadline = dependencies.now() + CLEAN_CLONE_OBJECTS_LIMIT_CONFIG.windowMs;
  try {
    prepared = await dependencies.prepare(CLEAN_CLONE_OBJECTS_LIMIT_CONFIG);
    const formal: CapacityQueuedStopMeasurement[] = [];
    for (let index = 1; index <= CLEAN_CLONE_OBJECTS_LIMIT_CONFIG.sampleCount; ++index) {
      if (dependencies.now() + CLEAN_CLONE_OBJECTS_LIMIT_CONFIG.admissionReserveMs >= deadline) {
        classification = 'PRODUCT_BUG';
        break;
      }
      const value = await dependencies.sample(prepared, index, CLEAN_CLONE_OBJECTS_LIMIT_CONFIG);
      dependencies.log(`CAPACITY_SAMPLE index=${index} class=${index <= CLEAN_CLONE_OBJECTS_LIMIT_CONFIG.warmupCount ? 'warmup' : 'formal'} raw=${JSON.stringify(value ?? null)}`);
      if (!value || value.index !== index) {
        classification = 'PRODUCT_BUG';
        break;
      }
      if (index > CLEAN_CLONE_OBJECTS_LIMIT_CONFIG.warmupCount) formal.push(value);
      if (index === CLEAN_CLONE_OBJECTS_LIMIT_CONFIG.sampleCount) {
        const summary = dependencies.summarize(formal);
        dependencies.log(`CAPACITY_SUMMARY raw=${JSON.stringify(summary)}`);
        classification = formal.length === CLEAN_CLONE_OBJECTS_LIMIT_CONFIG.formalCount && summary.passed
          ? 'PASS' : 'PRODUCT_BUG';
      }
    }
  } catch (error) {
    dependencies.log(`CAPACITY_HARNESS_ERROR raw=${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    classification = 'HARNESS_BUG';
  } finally {
    try { await dependencies.cleanup(prepared); }
    catch (error) {
      dependencies.log(`CAPACITY_CLEANUP_ERROR raw=${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      classification = 'HARNESS_BUG';
    }
  }
  return classification;
}
