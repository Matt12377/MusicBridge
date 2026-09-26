// 固定合成公开 DTO 的字节量；事件次数是旧/新策略模型，不代表真实 IPC 或帧率。
const progressUpdates = 100
const queueLengths = [120, 1197]

function publicTrack(index) {
  return {
    id: String(10_000 + index),
    title: `Synthetic Track ${index + 1}`,
    artists: ['Synthetic Artist'],
    album: 'Synthetic Album',
    durationMs: 180_000,
  }
}

function measure(queueLength) {
  const items = Array.from({ length: queueLength }, (_, index) => {
    const track = publicTrack(index)
    return {
      trackId: track.id,
      track,
      qualityPreference: 'auto',
      preferredSource: 'netease',
      resolvedSource: 'netease',
    }
  })
  const queue = { items, index: 0, hasNext: queueLength > 1, hasPrevious: false }
  const base = {
    state: 'playing', source: 'netease', currentTrack: items[0].track,
    queue, selectedZoneId: 'synthetic-zone',
    canNext: queueLength > 1, canPrevious: false,
    canStop: true, canPause: true, canResume: false,
  }
  const queueEventBytes = Buffer.byteLength(JSON.stringify({
    version: 1, event: 'queue.changed', payload: { queue },
  }))
  let playbackEventBytes = 0
  for (let index = 1; index <= progressUpdates; index += 1) {
    playbackEventBytes += Buffer.byteLength(JSON.stringify({
      version: 1, event: 'playback.changed',
      payload: { state: { ...base, positionMs: index * 1_000 } },
    }))
  }
  return {
    queueLength,
    progressUpdates,
    measuredPayloadBytes: { queueEvent: queueEventBytes, playbackEventsTotal: playbackEventBytes },
    sourceDerivedOldPolicy: {
      playbackChanged: progressUpdates,
      queueChanged: progressUpdates,
      totalSerializedBytes: playbackEventBytes + progressUpdates * queueEventBytes,
    },
    proposedUnchangedQueuePolicy: {
      playbackChanged: progressUpdates,
      queueChanged: 0,
      totalSerializedBytes: playbackEventBytes,
    },
  }
}

process.stdout.write(`${JSON.stringify({
  kind: 'synthetic-payload-model',
  baselineCommit: '77d05886888d0b9e9a9a8b90605097e8d0259de4',
  assumptions: '仅在初始队列已发布后，连续进度改变且队列完全不变；旧 runtime 每次播放通知都发布 queue.changed。',
  limits: '字节为 JSON 模型实测；事件次数由源码策略推导，非 Electron IPC 实测；不推断渲染帧率。',
  cases: queueLengths.map(measure),
}, null, 2)}\n`)
