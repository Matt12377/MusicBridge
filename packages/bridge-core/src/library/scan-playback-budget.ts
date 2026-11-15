/** 只由原Controller/网关事实组合产生；不是Renderer状态、Source许可或播放授权。 */
export type ScanPlaybackObservation = { mode: 'blocked' | 'idle' } | { mode: 'stable-owned'; generation: number };
export type ScanReadConcurrency = 0 | 1 | 2 | 8;
export const SCAN_STABLE_PLAYBACK_QUIET_MS = 2000;

/** 无定时器、无队列的私有预算提示；实际逐读许可和FD quiet仍属于原admission。 */
export function createScanPlaybackBudget(options: {
  observe(): ScanPlaybackObservation;
  idleConcurrency: 1 | 2 | 8;
  now?(): number;
}): { read(): ScanReadConcurrency; interrupt(): void } {
  if (![1, 2, 8].includes(options.idleConcurrency)) throw new Error('扫描空闲预算无效。');
  const now = options.now ?? (() => performance.now());
  let generation: number | undefined, since: number | undefined, lastTime: number | undefined;
  const interrupt = (): void => { generation = undefined; since = undefined; };
  return Object.freeze({
    interrupt,
    read(): ScanReadConcurrency {
      try {
        const time = now(), observation = options.observe();
        if (!Number.isFinite(time) || time < 0 || lastTime !== undefined && time < lastTime) {
          if (Number.isFinite(time) && time >= 0) lastTime = time;
          interrupt(); return 0;
        }
        lastTime = time;
        if (observation.mode === 'idle') { interrupt(); return options.idleConcurrency; }
        if (observation.mode !== 'stable-owned' || !Number.isSafeInteger(observation.generation) || observation.generation < 0) {
          interrupt(); return 0;
        }
        if (generation !== observation.generation || since === undefined) {
          generation = observation.generation; since = time; return 0;
        }
        return time - since >= SCAN_STABLE_PLAYBACK_QUIET_MS ? 1 : 0;
      } catch { interrupt(); return 0; }
    },
  });
}
