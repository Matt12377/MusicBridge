import type { RoonPlaybackObservation } from './types.js';
import type { RoonTrackActionOutcome } from './library.js';
import { BridgeError } from '../shared/errors.js';

export interface ConfirmedTrackActionOptions {
  dispatch: (onDispatch: () => void) => Promise<RoonTrackActionOutcome | void>;
  confirm: () => Promise<RoonPlaybackObservation>;
  onStage?: (stage: 'dispatch' | 'action-response' | 'confirmed' | 'failed', elapsedMs: number) => void;
}

export async function runConfirmedTrackAction(options: ConfirmedTrackActionOptions): Promise<RoonPlaybackObservation> {
  const startedAt = performance.now();
  const stage = (value: Parameters<NonNullable<ConfirmedTrackActionOptions['onStage']>>[0]): void => {
    try { options.onStage?.(value, Math.round(performance.now() - startedAt)); } catch { /* 诊断不得改变播放。 */ }
  };
  return new Promise((resolve, reject) => {
    let confirming = false;
    let dispatchedAt: number | undefined;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      stage('failed');
      reject(error instanceof BridgeError ? new BridgeError(error.code, error.message, {
        httpStatus: error.httpStatus, cause: error,
        details: { ...error.details, stage: confirming ? 'post-action-confirmation' : 'pre-action-navigation',
          preparationMs: Math.round((dispatchedAt ?? performance.now()) - startedAt),
          confirmationMs: dispatchedAt === undefined ? 0 : Math.round(performance.now() - dispatchedAt) },
      }) : error);
    };
    const onDispatch = (): void => {
      if (confirming || settled) throw new BridgeError('ROON_LIBRARY_REQUEST_FAILED', '播放动作重复派发', { httpStatus: 502 });
      // 在命令派发边界获取 revision 并注册监听；确认可早于回执，回执本身不是成功证据。
      const confirmation = options.confirm();
      confirming = true;
      dispatchedAt = performance.now();
      stage('dispatch');
      void confirmation.then(observation => {
        if (settled) return;
        settled = true;
        stage('confirmed');
        resolve(observation);
      }, fail);
    };
    void Promise.resolve().then(() => options.dispatch(onDispatch)).then(() => {
      stage('action-response');
      if (!confirming) fail(new BridgeError('ROON_LIBRARY_REQUEST_FAILED', '播放动作未派发', { httpStatus: 502 }));
    }, error => {
      // 导航失败立即返回；命令发出后的迟到/丢失回执由有界 Transport 确认裁决。
      if (!confirming) fail(error);
      else stage('action-response');
    });
  });
}
