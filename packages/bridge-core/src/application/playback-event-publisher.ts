import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  PlaybackEventProtocol, PlaybackEventProtocolAck, PlaybackQueueSnapshot, PlaybackSnapshot,
  PlaybackStateProjection, PlaybackStreamSnapshot, PlaybackStreamStamp, TypedIpcEvent,
} from '@music-bridge/contracts';

export interface PlaybackPublicationMetadata {
  readonly generation: number;
  readonly kind: 'full' | 'position';
}
export interface PlaybackEventPublisher {
  (snapshot: PlaybackSnapshot, metadata?: PlaybackPublicationMetadata): void;
  capture(snapshot: PlaybackSnapshot, metadata: PlaybackPublicationMetadata): PlaybackStreamSnapshot | null;
  stamp(snapshot: PlaybackSnapshot, metadata: PlaybackPublicationMetadata): PlaybackSnapshot;
  getProtocol(): PlaybackEventProtocolAck | null;
}

/** 私有发布器的输入来自 Controller 同步只读 publication，不能接受客户端 stamp。 */
export function createPlaybackEventPublisher(
  emit: (event: TypedIpcEvent) => void,
  options: { protocol?: PlaybackEventProtocol } = {},
): PlaybackEventPublisher {
  if (options.protocol !== undefined && options.protocol !== 'compact-v1') throw new Error('播放事件协议不受支持');
  const ack: PlaybackEventProtocolAck | null = options.protocol
    ? Object.freeze({ protocol: options.protocol, coreInstanceId: randomUUID() }) : null;
  let lastPublishedQueue: PlaybackQueueSnapshot | undefined;
  let inputQueue: PlaybackQueueSnapshot | undefined;
  let canonical: PlaybackStreamSnapshot | undefined;
  let recoveryRequired = false;

  const observe = (snapshot: PlaybackSnapshot, metadata: PlaybackPublicationMetadata, readonlyCapture: boolean): PlaybackStreamSnapshot => {
    if (!Number.isSafeInteger(metadata.generation) || metadata.generation < 0
      || (canonical && metadata.generation < canonical.stamp.generation)) throw new Error('播放事件代次无效');
    const { queue: suppliedQueue, stream: _untrustedStream, ...suppliedState } = snapshot;
    const previous = canonical;
    // position 使用稳定引用；只有低频 full/read 可以比较完整队列内容。
    const queueChanged = !previous || (suppliedQueue !== inputQueue
      && (metadata.kind === 'position' || !isDeepStrictEqual(suppliedQueue, previous.snapshot.queue)));
    const previousState = previous ? withoutQueue(previous.snapshot) : undefined;
    const stateChanged = !previousState || !isDeepStrictEqual(withoutPosition(suppliedState), withoutPosition(previousState));
    const ownerChanged = !previous || metadata.generation !== previous.stamp.generation;
    const positionChanged = !previous || snapshot.positionMs !== previous.snapshot.positionMs;
    if (readonlyCapture && previous && !queueChanged && !stateChanged && !ownerChanged && !positionChanged) return previous;
    const sequence = increment(previous?.stamp.sequence ?? 0);
    const queueRevision = queueChanged ? increment(previous?.stamp.queueRevision ?? 0) : previous!.stamp.queueRevision;
    const queue = queueChanged ? immutableCopy(suppliedQueue) : previous!.snapshot.queue;
    const state = previousState && !stateChanged
      ? Object.freeze({ ...previousState, positionMs: snapshot.positionMs }) : immutableCopy(suppliedState);
    const stamp: PlaybackStreamStamp = Object.freeze({
      coreInstanceId: ack!.coreInstanceId, generation: metadata.generation, sequence, queueRevision,
      selectedZoneId: snapshot.selectedZoneId ?? null, trackId: snapshot.currentTrack?.id ?? null, source: snapshot.source ?? null,
    });
    const full: PlaybackStreamSnapshot = Object.freeze({ stamp, snapshot: Object.freeze({ ...state, queue }) });
    inputQueue = suppliedQueue;
    canonical = full;
    const fullRequired = !previous || recoveryRequired;
    const event: TypedIpcEvent = fullRequired
      ? { version: 1, event: 'playback.snapshot', payload: full }
      : metadata.kind === 'position' && !queueChanged && !stateChanged && !ownerChanged
        ? { version: 1, event: 'playback.progress', payload: { stamp, positionMs: snapshot.positionMs } }
        : { version: 1, event: 'playback.state', payload: { stamp, state, ...(queueChanged ? { queue } : {}) } };
    // 先提交同一采样事实；发送失败保留序号空洞，下一出版必须发送 full。
    try {
      emit(event);
      if (canonical === full) recoveryRequired = false;
    } catch (error) {
      recoveryRequired = true;
      throw error;
    }
    return full;
  };
  const publish = ((snapshot: PlaybackSnapshot, metadata?: PlaybackPublicationMetadata): void => {
    if (ack) { observe(snapshot, metadata ?? { generation: 0, kind: 'full' }, false); return; }
    emit({ version: 1, event: 'playback.changed', payload: { state: snapshot } });
    if (snapshot.queue !== lastPublishedQueue) {
      emit({ version: 1, event: 'queue.changed', payload: { queue: snapshot.queue } });
      lastPublishedQueue = snapshot.queue;
    }
  }) as PlaybackEventPublisher;
  publish.capture = (snapshot, metadata) => ack ? observe(snapshot, metadata, true) : null;
  publish.stamp = (snapshot, metadata) => {
    const captured = publish.capture(snapshot, metadata);
    return captured ? Object.freeze({ ...captured.snapshot, stream: captured.stamp }) : snapshot;
  };
  publish.getProtocol = () => ack;
  return publish;
}

function increment(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw new Error('播放事件序号已耗尽，需要重建 Core 基准');
  return value + 1;
}
function withoutQueue(snapshot: PlaybackSnapshot): PlaybackStateProjection {
  const { queue: _queue, stream: _stream, ...state } = snapshot;
  return state;
}
function withoutPosition(state: PlaybackStateProjection): Omit<PlaybackStateProjection, 'positionMs'> {
  const { positionMs: _position, ...facts } = state;
  return facts;
}
/** 只在队列/低频 metadata 改变时复制；纯进度不触碰 queue.items。 */
function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(item => immutableCopy(item))) as T;
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableCopy(item)]))) as T;
  }
  return value;
}
