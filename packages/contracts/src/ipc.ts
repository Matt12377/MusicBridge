import type { PublicError } from './errors.js';
import type {
  DailyRecommendationsSnapshot,
  Page,
  PageRequest,
  PlaylistDetail,
  PlaylistSummary,
  TrackSummary,
} from './library.js';
import type {
  RoonImageOptions,
  RoonImageResult,
  RoonLibraryPage,
} from './roon.js';
import type { LyricsSnapshot } from './lyrics.js';
import type {
  PlaybackQueueRequestItem,
  PlaybackQueueSnapshot,
  PlaybackQualityPreference,
  PlaybackSnapshot,
} from './playback.js';
import type {
  PublicAccountState,
  PublicAuthState,
  PublicBridgeState,
  PublicRoonZone,
} from './state.js';
import type { DiagnosticComponentSnapshot } from './diagnostics.js';

export const IPC_VERSION = 1 as const;

export const IPC_COMMANDS = [
  'core.ping',
  'core.getHealth',
  'core.getState',
  'core.getDiagnostics',
  'core.shutdown',
  'auth.setCredential',
  'auth.verifyCredential',
  'auth.clearCredential',
  'auth.beginQr',
  'auth.pollQr',
  'auth.cancelQr',
  'auth.getState',
  'auth.logout',
  'account.getState',
  'account.refresh',
  'library.search',
  'library.liked',
  'library.playlists',
  'library.playlist',
  'library.dailyRecommendations',
  'lyrics.get',
  'roon.listZones',
  'roon.selectZone',
  'roon.library.albums',
  'roon.library.album',
  'roon.library.image',
  'roon.library.play',
  'roon.library.queue',
  'playback.getState',
  'playback.play',
  'playback.stop',
  'playback.next',
  'playback.previous',
  'playback.replaceQueue',
  'playback.appendQueue',
  'playback.insertNext',
] as const;

export type IpcCommand = (typeof IPC_COMMANDS)[number];

export const IPC_EVENTS = [
  'core.ready',
  'core.health',
  'auth.changed',
  'account.changed',
  'roon.changed',
  'diagnostic.notice',
  'playback.changed',
  'queue.changed',
  'lyrics.changed',
] as const;

export type IpcEvent = (typeof IPC_EVENTS)[number];

export interface IpcRequest<TPayload = unknown> {
  version: typeof IPC_VERSION;
  id: string;
  command: IpcCommand;
  payload: TPayload;
}

export interface IpcSuccess<TResult = unknown> {
  version: typeof IPC_VERSION;
  id: string;
  ok: true;
  result: TResult;
}

export interface IpcFailure {
  version: typeof IPC_VERSION;
  id: string;
  ok: false;
  error: PublicError;
}

export type IpcResponse<TResult = unknown> =
  | IpcSuccess<TResult>
  | IpcFailure;

export type IpcEnvelope<T = unknown> = IpcRequest<T> | IpcResponse<T>;

export interface IpcCommandPayloads {
  'core.ping': Record<string, never>;
  'core.getHealth': Record<string, never>;
  'core.getState': Record<string, never>;
  'core.getDiagnostics': Record<string, never>;
  'core.shutdown': Record<string, never>;
  'auth.setCredential': { credential: string };
  'auth.verifyCredential': { credential: string };
  'auth.clearCredential': Record<string, never>;
  'auth.beginQr': Record<string, never>;
  'auth.pollQr': { challengeId: string };
  'auth.cancelQr': { challengeId: string };
  'auth.getState': Record<string, never>;
  'auth.logout': Record<string, never>;
  'account.getState': Record<string, never>;
  'account.refresh': Record<string, never>;
  'library.search': { query: string; page: PageRequest };
  'library.liked': { page: PageRequest };
  'library.playlists': Record<string, never>;
  'library.playlist': { playlistId: string; page: PageRequest };
  'library.dailyRecommendations': Record<string, never>;
  'lyrics.get': { trackId: string };
  'roon.listZones': Record<string, never>;
  'roon.selectZone': { zoneId: string };
  'roon.library.albums': { page: PageRequest };
  'roon.library.album': { reference: string; page: PageRequest };
  'roon.library.image': { reference: string; options?: RoonImageOptions };
  'roon.library.play': { reference: string; zoneId: string };
  'roon.library.queue': { reference: string; zoneId: string };
  'playback.getState': Record<string, never>;
  'playback.play': { trackId: string; qualityPreference: PlaybackQualityPreference };
  'playback.stop': Record<string, never>;
  'playback.next': Record<string, never>;
  'playback.previous': Record<string, never>;
  'playback.replaceQueue': { items: readonly PlaybackQueueRequestItem[]; index: number };
  'playback.appendQueue': { items: readonly PlaybackQueueRequestItem[] };
  'playback.insertNext': { items: readonly PlaybackQueueRequestItem[] };
}

export interface IpcCommandResults {
  'core.ping': { pong: true };
  'core.getHealth': PublicBridgeState;
  'core.getState': PublicBridgeState;
  'core.getDiagnostics': DiagnosticComponentSnapshot;
  'core.shutdown': { stopped: true };
  'auth.setCredential': PublicBridgeState;
  'auth.verifyCredential': { status: 'authorized' | 'expired' | 'unavailable' };
  'auth.clearCredential': PublicBridgeState;
  'auth.beginQr': PublicAuthState;
  'auth.pollQr': PublicAuthState;
  'auth.cancelQr': PublicAuthState;
  'auth.getState': PublicAuthState;
  'auth.logout': PublicAuthState;
  'account.getState': PublicAccountState;
  'account.refresh': PublicAccountState;
  'library.search': Page<TrackSummary>;
  'library.liked': Page<TrackSummary>;
  'library.playlists': readonly PlaylistSummary[];
  'library.playlist': PlaylistDetail;
  'library.dailyRecommendations': DailyRecommendationsSnapshot;
  'lyrics.get': LyricsSnapshot;
  'roon.listZones': { zones: readonly PublicRoonZone[] };
  'roon.selectZone': PublicBridgeState;
  'roon.library.albums': RoonLibraryPage;
  'roon.library.album': RoonLibraryPage;
  'roon.library.image': RoonImageResult;
  'roon.library.play': { started: true };
  'roon.library.queue': { queued: true };
  'playback.getState': PlaybackSnapshot;
  'playback.play': PlaybackSnapshot;
  'playback.stop': PlaybackSnapshot;
  'playback.next': PlaybackSnapshot;
  'playback.previous': PlaybackSnapshot;
  'playback.replaceQueue': PlaybackSnapshot;
  'playback.appendQueue': PlaybackSnapshot;
  'playback.insertNext': PlaybackSnapshot;
}

export interface IpcEventPayloads {
  'core.ready': { state: PublicBridgeState };
  'core.health': { state: PublicBridgeState };
  'roon.changed': { state: PublicBridgeState };
  'auth.changed': { state: PublicAuthState };
  'account.changed': { state: PublicAccountState };
  'diagnostic.notice': { code: string; message?: string };
  'playback.changed': { state: PlaybackSnapshot };
  'queue.changed': { queue: PlaybackQueueSnapshot };
  'lyrics.changed': { state: LyricsSnapshot };
}

export type IpcInternalCommand = 'auth.pollQr' | 'auth.verifyCredential';

export interface IpcInternalCommandResults {
  'auth.pollQr': { state: PublicAuthState; credential?: string };
  'auth.verifyCredential': { status: 'authorized' | 'expired' | 'unavailable' };
}

export interface IpcEventMessage {
  version: typeof IPC_VERSION;
  event: IpcEventName;
  payload: unknown;
}

export type IpcEventName = (typeof IPC_EVENTS)[number];

export type TypedIpcRequest<TCommand extends IpcCommand = IpcCommand> =
  TCommand extends IpcCommand
    ? IpcRequest<IpcCommandPayloads[TCommand]> & { command: TCommand }
    : never;

export type TypedIpcResponse<TCommand extends IpcCommand = IpcCommand> =
  TCommand extends IpcCommand
    ? IpcResponse<IpcCommandResults[TCommand]>
    : never;

export type TypedIpcEvent<TEvent extends IpcEventName = IpcEventName> =
  TEvent extends IpcEventName
    ? { version: typeof IPC_VERSION; event: TEvent; payload: IpcEventPayloads[TEvent] }
    : never;

export type IpcRuntimeMessage = IpcResponse<unknown> | TypedIpcEvent;
