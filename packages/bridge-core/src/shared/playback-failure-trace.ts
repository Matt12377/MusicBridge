const PREFIX = '[playback:replace-queue] ';
const REASONS = new Set(['request-budget', 'request-timeout', 'upstream-response', 'request-cancelled', 'runtime-prepare', 'unclassified']);
const CODES = new Set(['READ_CANCELLED', 'READ_DEADLINE', 'CONFIG_INVALID', 'NETEASE_NOT_CONFIGURED', 'NETEASE_REQUEST_FAILED',
  'AUTH_EXPIRED', 'ACCOUNT_PROFILE_UNAVAILABLE', 'DAILY_RECOMMENDATIONS_UNAVAILABLE', 'TRACK_UNAVAILABLE', 'TRACK_PREVIEW_ONLY', 'UNSAFE_UPSTREAM',
  'ROON_NOT_PAIRED', 'ROON_ZONE_NOT_SELECTED', 'ROON_MEDIA_ERROR', 'ROON_TIMEOUT', 'ROON_TRANSPORT_UNAVAILABLE',
  'ROON_LIBRARY_UNAVAILABLE', 'ROON_LIBRARY_REQUEST_FAILED', 'ROON_LIBRARY_INVALID_REFERENCE', 'ROON_ACTION_BLOCKED',
  'ROON_IMAGE_UNAVAILABLE', 'ROON_IMAGE_DECODE_FAILED', 'ROON_ALBUM_HIERARCHY_INVALID', 'ROON_TRACK_ACTION_UNAVAILABLE',
  'STREAM_NOT_FOUND', 'STREAM_URL_EXPIRED', 'STREAM_UPSTREAM_FAILED', 'BAD_REQUEST', 'INTERNAL_ERROR']);

/** 只转发已分类的播放失败，其他 SDK 输出与私有字段全部丢弃。 */
export function createPlaybackFailureTraceStreamReader(write: (line: string) => void): (chunk: string) => void {
  let pending = '', dropping = false;
  return chunk => {
    for (const part of chunk.split(/(?<=\n)/u)) {
      const ended = part.endsWith('\n');
      if (pending.length + part.length > 8192) { pending = ''; dropping = true; }
      if (!dropping) pending += part;
      if (!ended) continue;
      if (!dropping) {
        try {
          const input: unknown = JSON.parse(pending);
          if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
            const record = input as Record<string, unknown>;
            if (record.event === 'queue_replace_failed' && record.level === 'warn') {
              const code = typeof record.code === 'string' && CODES.has(record.code) ? record.code : 'OTHER';
              const reason = typeof record.reason === 'string' && REASONS.has(record.reason) ? record.reason : 'unclassified';
              write(`${PREFIX}${JSON.stringify({ code, reason })}\n`);
            }
          }
        } catch { /* 管道中的非结构化文本和输出失败不改变播放或资源收尾。 */ }
      }
      pending = ''; dropping = false;
    }
  };
}
