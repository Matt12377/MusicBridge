import type { PlaybackQueueSnapshot, PlaybackSnapshot, TypedIpcEvent } from '@music-bridge/contracts';

/** 队列投影由 Controller 按内容更换；进度通知继续发送完整播放合同。 */
export function createPlaybackEventPublisher(emit: (event: TypedIpcEvent) => void): (snapshot: PlaybackSnapshot) => void {
  let lastPublishedQueue: PlaybackQueueSnapshot | undefined;
  return (snapshot) => {
    emit({
      version: 1,
      event: 'playback.changed',
      payload: { state: snapshot },
    });
    if (snapshot.queue !== lastPublishedQueue) {
      emit({
        version: 1,
        event: 'queue.changed',
        payload: { queue: snapshot.queue },
      });
      lastPublishedQueue = snapshot.queue;
    }
  };
}
