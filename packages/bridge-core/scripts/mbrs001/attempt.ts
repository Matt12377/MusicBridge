import type { RoonAudioInputAdapter } from '../../src/roon/adapter.js';
import type { RoonTerminalReason } from '../../src/roon/types.js';
import type { SyntheticFileHttp } from './file-http.js';
import { SYNTHETIC_ZONE, type OfflineFakeSdk } from './fake-roon-sdk.js';

// 工具内每个Adapter只有一个观察owner；不接管产品队列或coordinator。
const observationOwners = new WeakMap<RoonAudioInputAdapter, symbol>();

/** 短run内一份资源观察，不是第二个产品coordinator/队列。 */
export function createOfflineAttempt(options: {
  attemptAlias: string; sampleAlias: string; service: SyntheticFileHttp;
  adapter: RoonAudioInputAdapter; sdk: OfflineFakeSdk;
}) {
  if (![options.attemptAlias, options.sampleAlias].every(alias => /^[a-z][a-z0-9-]{0,47}$/u.test(alias))) throw new Error('隔离attempt别名不合法。');
  const registration = options.service.registrations.find(item => item.sampleAlias === options.sampleAlias);
  if (!registration) throw new Error('隔离attempt没有所属合成输入。');
  const abort = new AbortController();
  const ownerToken = Symbol('isolated-attempt-observer');
  let beginIndex: number | undefined;
  const terminalReasons: RoonTerminalReason[] = [];
  const timePositionsMs: number[] = [];
  const stages: string[] = [];
  let rawPlayingObserved = false;
  let pausedObserved = false;
  let rawSessionEndedObserved = false;
  let cleanupOrigin: 'ADAPTER_TERMINAL' | 'HARNESS_RAW_SESSION_ENDED_RESOURCE_CLEANUP' | 'LOCAL_FINALLY_ONLY' | null = null;
  let cleanup: Promise<void> | undefined;
  let started = false;
  let detached = false;
  let ownedEpoch: number | undefined;
  const ownsObservation = (): boolean => observationOwners.get(options.adapter) === ownerToken;
  const unloadOwnedCallbacks = (): void => {
    if (!ownsObservation()) return;
    options.adapter.setTerminalHandler(() => undefined);
    options.adapter.setTimeHandler(() => undefined);
  };

  const ownedSessionAlias = (): string | undefined => {
    if (!started || beginIndex === undefined || options.sdk.moo.count('begin_session') <= beginIndex) return undefined;
    return options.sdk.moo.request('begin_session', beginIndex).sessionAlias;
  };
  const disposeLocal = (origin: NonNullable<typeof cleanupOrigin> = 'LOCAL_FINALLY_ONLY'): Promise<void> => {
    if (cleanup) return cleanup;
    cleanupOrigin = origin;
    cleanup = options.service.revoke(options.sampleAlias).then(() => {
      // revoke实际等待refs归零及handle.close成功后才交出观察owner。
      if (ownsObservation()) { unloadOwnedCallbacks(); observationOwners.delete(options.adapter); }
    });
    return cleanup;
  };
  const removeObserver = options.sdk.moo.observe(event => {
    if (!started || detached || !ownsObservation() || event.sessionAlias !== ownedSessionAlias()) return;
    if (event.operation === 'play' && event.event === 'Playing') rawPlayingObserved = true;
    if (event.operation === 'play' && event.event === 'Paused'
      && options.adapter.getActivePlaybackEpoch() === ownedEpoch && options.adapter.getState().status === 'paused') pausedObserved = true;
    if (event.operation === 'begin_session' && event.event === 'SessionEnded') {
      rawSessionEndedObserved = true;
      // 只收工具FD；不伪造原Adapter缺失的terminal通知。
      void disposeLocal('HARNESS_RAW_SESSION_ENDED_RESOURCE_CLEANUP').catch(() => undefined);
    }
  });
  return {
    async start(): Promise<void> {
      if (started || detached || cleanup) throw new Error('隔离attempt已开始、已分离或已清理，不能再次提交。');
      if (observationOwners.has(options.adapter)) throw new Error('另一个隔离attempt尚未实际收口，不能抢占观察owner。');
      // 本地FD收口不等于原Adapter的旧会话已确认；不能先挂新handler再重试旧stop。
      if (options.adapter.getActivePlaybackEpoch() !== undefined) throw new Error('旧隔离会话仍未确认收口，不能接管观察owner。');
      observationOwners.set(options.adapter, ownerToken);
      started = true;
      beginIndex = options.sdk.moo.count('begin_session');
      options.adapter.setTerminalHandler(reason => {
        // late-stop/ZoneLoss可先clear epoch；终态归属依据观察owner，不能丢失合法迟到关闭。
        if (detached || !ownsObservation()) return;
        terminalReasons.push(reason);
        void disposeLocal('ADAPTER_TERMINAL').catch(() => undefined);
      });
      options.adapter.setTimeHandler(event => {
        if (!detached && !cleanup && ownsObservation() && event.source === 'audio-input'
          && event.playbackEpoch === ownedEpoch) timePositionsMs.push(event.positionMs);
      });
      return options.adapter.play({ expectedZoneId: SYNTHETIC_ZONE, signal: abort.signal,
        mediaUrl: registration.mediaUrl, iconUrl: options.service.iconUrl,
        metadata: { id: `synthetic-${options.sampleAlias}`, title: 'Same synthetic name', artists: ['Synthetic'], album: 'Synthetic', durationMs: 120_000 },
        onDispatch: () => { ownedEpoch = options.adapter.getActivePlaybackEpoch(); },
        onStartupStage: stage => { stages.push(stage); } });
    },
    cancelStartup(): void { abort.abort(); },
    async stop(): Promise<void> {
      if (!started || !ownsObservation() || cleanup) throw new Error('隔离attempt不能停止未开始、已收口或其它owner的会话。');
      const currentEpoch = options.adapter.getActivePlaybackEpoch();
      if (currentEpoch !== undefined && currentEpoch !== ownedEpoch) throw new Error('当前会话epoch不属于本隔离attempt。');
      // 本owner启动timeout已clear context时允许原Adapter no-op；不能据此把remote账本写closed。
      await options.adapter.stop({ expectedZoneId: SYNTHETIC_ZONE });
    },
    disposeLocal,
    async waitForLocalCleanup(): Promise<void> { if (cleanup) await cleanup; },
    detach(): void { detached = true; removeObserver(); unloadOwnedCallbacks(); },
    observation() {
      const sessionAlias = ownedSessionAlias();
      const ledger = options.sdk.moo.ledger().find(item => item.sessionAlias === sessionAlias);
      return { attemptAlias: options.attemptAlias, sampleAlias: options.sampleAlias,
        sessionAlias: sessionAlias ?? null, sessionConfirmedClosed: ledger?.sessionConfirmedClosed ?? null,
        remoteStop: ledger?.remoteStop ?? 'UNCONFIRMED', adapterTerminalNotified: terminalReasons.length > 0,
        adapterTerminalReasons: [...terminalReasons], playingObserved: stages.includes('roon-playing'), rawPlayingObserved, pausedObserved,
        timePositionsMs: [...timePositionsMs], startupStages: [...stages], rawSessionEndedObserved, cleanupOrigin,
        knownGap: rawSessionEndedObserved && terminalReasons.length === 0 ? 'KNOWN_GAP_SESSION_ENDED_WITHOUT_ADAPTER_TERMINAL' : null };
    },
  };
}
