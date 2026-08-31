import type test from 'node:test';
import { backup } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  capacityMeasureWorkingBytes,
  createCapacityClone,
  createCapacityQueuedStopAggregateGuard,
  createCapacitySeed,
  finishCapacityClone,
  hashCapacityFile,
} from '../helpers/recording-capacity-fixture.js';
import { runCapacityQueuedStop } from '../helpers/recording-capacity-process.js';
import {
  capacityQueuedStopMeasurement,
  capacityQueuedStopSummary,
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

/** 固定正式口径的纯执行编排；没有window、authority、重试、预跑或参数入口。 */
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

interface ProductionPrepared {
  runRoot: string;
  outputRoot: string;
  seedPath: string;
  seedSha256: string;
  fixtureDirectory: string;
  planId: string;
  planHash: string;
  plannedBytes: number;
  aggregate: ReturnType<typeof createCapacityQueuedStopAggregateGuard>;
  cleanups: Array<() => void | Promise<void>>;
  childPids: Set<number>;
}

async function productionDependencies(): Promise<CleanCloneBenchmarkDependencies<ProductionPrepared>> {
  let pending: ProductionPrepared | undefined;
  return {
    async prepare(config) {
      const runRoot = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'musicbridge-capacity-direct-')));
      const seedRoot = path.join(runRoot, 'seed'), outputRoot = path.join(runRoot, 'output');
      mkdirSync(seedRoot); mkdirSync(outputRoot);
      const cleanups: Array<() => void | Promise<void>> = [];
      const context = { after(callback: () => void | Promise<void>) { cleanups.push(callback); } } as test.TestContext;
      const fixture = await createCapacitySeed(context, { profile: config.profile, retainDirectory: true });
      const seedPath = path.join(seedRoot, 'seed.sqlite');
      await backup(fixture.db, seedPath);
      const seedSha256 = hashCapacityFile(seedPath), snapshotBytes = lstatSync(seedPath).size;
      if (!snapshotBytes || ['-wal', '-shm', '-journal'].some(suffix => existsSync(seedPath + suffix))) {
        throw new Error('clean clone seed无效');
      }
      pending = {
        runRoot, outputRoot, seedPath, seedSha256, fixtureDirectory: fixture.directory,
        planId: fixture.nextPlan.id, planHash: fixture.nextPlan.contentHash,
        plannedBytes: capacityMeasureWorkingBytes(snapshotBytes),
        aggregate: createCapacityQueuedStopAggregateGuard(outputRoot, snapshotBytes),
        cleanups, childPids: new Set<number>(),
      };
      return pending;
    },
    async sample(prepared, index, config) {
      if (hashCapacityFile(prepared.seedPath) !== prepared.seedSha256) throw new Error('clean clone seed漂移');
      const label = `sample-${String(index).padStart(3, '0')}`;
      const clone = createCapacityClone(prepared.outputRoot, label, prepared.seedPath, prepared.plannedBytes, prepared.aggregate);
      const result = await runCapacityQueuedStop({ clone, planId: prepared.planId, planHash: prepared.planHash }, {
        executionTimeoutMs: config.executionMs,
        killGraceMs: config.killGraceMs,
        closeTimeoutMs: config.closeMs,
      });
      process.stdout.write(`CAPACITY_PROCESS_RAW index=${index} raw=${JSON.stringify(result)}\n`);
      const measurement = capacityQueuedStopMeasurement(result, prepared.planId, prepared.planHash);
      const childPid = result.childPid;
      const uniqueChild = childPid !== null && !prepared.childPids.has(childPid);
      if (childPid !== null) prepared.childPids.add(childPid);
      const valid = measurement && uniqueChild && result.forkToCloseMs <= config.executionMs
        && hashCapacityFile(prepared.seedPath) === prepared.seedSha256;
      if (result.closed) finishCapacityClone(clone, {
        outcome: valid ? 'ok' : result.outcome === 'timeout' ? 'timeout' : 'failed',
        resourcesClosed: true,
        samples: [result],
      });
      return valid ? { index, ...measurement } : undefined;
    },
    summarize: capacityQueuedStopSummary,
    async cleanup(prepared) {
      const value = prepared ?? pending;
      if (!value) return;
      let failure: unknown;
      for (const callback of [...value.cleanups].reverse()) {
        try { await callback(); } catch (error) { failure ??= error; }
      }
      for (const directory of [value.outputRoot, path.dirname(value.seedPath), value.fixtureDirectory, value.runRoot]) {
        try { if (existsSync(directory)) await rm(directory, { recursive: true, force: false }); }
        catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    },
    now: Date.now,
    log: line => process.stdout.write(`${line}\n`),
  };
}

async function main() {
  const root = realpathSync(path.join(import.meta.dirname, '../../../..'));
  let clean = false;
  try {
    clean = process.argv.length === 2 && realpathSync(process.cwd()) === root
      && realpathSync(execFileSync('/usr/bin/git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim()) === root
      && execFileSync('/usr/bin/git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim() === '';
  } catch { clean = false; }
  if (!clean) {
    process.exitCode = 3;
    return;
  }
  const classification = await runCleanCloneObjectsLimitBenchmark(await productionDependencies());
  process.exitCode = classification === 'PASS' ? 0 : classification === 'PRODUCT_BUG' ? 2 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
