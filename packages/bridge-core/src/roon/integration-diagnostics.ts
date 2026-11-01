import type { DiagnosticRingBuffer } from '@music-bridge/contracts';

const MEDIA_STATES: Readonly<Record<string, string>> = {
  roon_media_listener_ready: 'media_listener_ready',
  roon_media_request: 'media_request',
  roon_gateway_first_body_bytes: 'media_bytes_positive',
  roon_gateway_upstream_response: 'media_headers',
  roon_gateway_transfer_complete: 'media_terminal',
  roon_media_request_failed: 'media_rejected',
};
const CONNECTION_STATES: Readonly<Record<string, string>> = {
  roon_core_paired: 'paired', roon_zones_subscribed: 'zones_subscribed',
  roon_core_unpaired: 'unpaired', roon_connection_error: 'connection_error',
  roon_media_prepare_failed: 'media_prepare_failed',
};
const PLAYBACK_STATES: Readonly<Record<string, string>> = {
  stopping: 'stopping_previous', stopped: 'previous_stopped', begin_session: 'awaiting_session',
  session_began: 'session_began', play_dispatched: 'play_dispatched', playing: 'playing_confirmed',
  paused: 'paused_confirmed', session_timeout: 'session_timeout', failed: 'startup_failed',
};
const safeId = (value: unknown): string | undefined => typeof value === 'string' && /^roon-media-[1-9][0-9]{0,14}$/u.test(value) ? value : undefined;
const duration = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000 ? value : undefined;

/** 固定映射进入既有诊断 ring；拒绝 URL、SDK 正文、会话身份和任意错误文本。 */
export function createRoonIntegrationDiagnostics(ring: DiagnosticRingBuffer) {
  return {
    log(event: string, fields: Record<string, unknown> = {}): void {
      const state = MEDIA_STATES[event] ?? CONNECTION_STATES[event];
      if (!state) return;
      const id = safeId(fields.diagnosticId), ms = duration(fields.durationMs);
      const count = fields.bytesForwarded;
      const bytes = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? `|bytes=${count}` : '';
      ring.record({ component: 'core', level: state.endsWith('failed') || state.endsWith('error') || state.endsWith('rejected') ? 'warn' : 'info',
        event, state: `${state}${bytes}`.slice(0, 64), ...(id ? { diagnosticId: id } : {}), ...(ms !== undefined ? { durationMs: ms } : {}) });
    },
    playback(id: string | undefined, event: { stage: string; current: boolean; durationMs: number; phase?: string }): void {
      const state = PLAYBACK_STATES[event.stage];
      if (!state) return;
      const diagnosticId = safeId(id), ms = duration(event.durationMs);
      ring.record({ component: 'core', level: event.stage === 'failed' || event.stage === 'session_timeout' ? 'warn' : 'info',
        event: 'roon_integration_playback', state: event.current ? state : 'stale_ignored',
        ...(diagnosticId ? { diagnosticId } : {}), ...(ms !== undefined ? { durationMs: ms } : {}),
        ...(event.stage === 'session_timeout' ? { code: 'ROON_TIMEOUT' } : {}) });
    },
  };
}
