import type { PublicError } from './errors.js';
import type { Page, PageRequest, PlaylistDetail, PlaylistSummary, TrackSummary } from './library.js';
import type {
  PlaybackQueueItem,
  PlaybackQueueSnapshot,
  PlaybackQuality,
  PlaybackSnapshot,
} from './playback.js';
import type { PublicAuthState, PublicBridgeState, PublicRoonZone } from './state.js';

export const IPC_VERSION = 1 as const;

export const IPC_COMMANDS = [
  'core.ping',
  'core.getHealth',
  'core.getState',
  'core.shutdown',
  'auth.setCredential',
  'auth.clearCredential',
  'auth.beginQr',
  'auth.pollQr',
  'auth.cancelQr',
  'auth.getState',
  'auth.logout',
  'library.search',
  'library.liked',
  'library.playlists',
  'library.playlist',
  'roon.listZones',
  'roon.selectZone',
  'playback.getState',
  'playback.play',
  'playback.stop',
  'playback.next',
  'playback.previous',
  'playback.replaceQueue',
] as const;

export type IpcCommand = (typeof IPC_COMMANDS)[number];

export const IPC_EVENTS = [
  'core.ready',
  'core.health',
  'auth.changed',
  'roon.changed',
  'diagnostic.notice',
  'playback.changed',
  'queue.changed',
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
  'core.shutdown': Record<string, never>;
  'auth.setCredential': { credential: string };
  'auth.clearCredential': Record<string, never>;
  'auth.beginQr': Record<string, never>;
  'auth.pollQr': { challengeId: string };
  'auth.cancelQr': { challengeId: string };
  'auth.getState': Record<string, never>;
  'auth.logout': Record<string, never>;
  'library.search': { query: string; page: PageRequest };
  'library.liked': { page: PageRequest };
  'library.playlists': Record<string, never>;
  'library.playlist': { playlistId: string; page: PageRequest };
  'roon.listZones': Record<string, never>;
  'roon.selectZone': { zoneId: string };
  'playback.getState': Record<string, never>;
  'playback.play': { trackId: string; quality: PlaybackQuality };
  'playback.stop': Record<string, never>;
  'playback.next': Record<string, never>;
  'playback.previous': Record<string, never>;
  'playback.replaceQueue': { items: readonly PlaybackQueueItem[]; index: number };
}

export interface IpcCommandResults {
  'core.ping': { pong: true };
  'core.getHealth': PublicBridgeState;
  'core.getState': PublicBridgeState;
  'core.shutdown': { stopped: true };
  'auth.setCredential': PublicBridgeState;
  'auth.clearCredential': PublicBridgeState;
  'auth.beginQr': PublicAuthState;
  'auth.pollQr': PublicAuthState;
  'auth.cancelQr': PublicAuthState;
  'auth.getState': PublicAuthState;
  'auth.logout': PublicAuthState;
  'library.search': Page<TrackSummary>;
  'library.liked': Page<TrackSummary>;
  'library.playlists': readonly PlaylistSummary[];
  'library.playlist': PlaylistDetail;
  'roon.listZones': { zones: readonly PublicRoonZone[] };
  'roon.selectZone': PublicBridgeState;
  'playback.getState': PlaybackSnapshot;
  'playback.play': PlaybackSnapshot;
  'playback.stop': PlaybackSnapshot;
  'playback.next': PlaybackSnapshot;
  'playback.previous': PlaybackSnapshot;
  'playback.replaceQueue': PlaybackSnapshot;
}

export interface IpcEventPayloads {
  'core.ready': { state: PublicBridgeState };
  'core.health': { state: PublicBridgeState };
  'roon.changed': { state: PublicBridgeState };
  'auth.changed': { state: PublicAuthState };
  'diagnostic.notice': { code: string; message?: string };
  'playback.changed': { state: PlaybackSnapshot };
  'queue.changed': { queue: PlaybackQueueSnapshot };
}

export type IpcInternalCommand = 'auth.pollQr';

export interface IpcInternalCommandResults {
  'auth.pollQr': { state: PublicAuthState; credential?: string };
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
