import type { MediaPlan, MediaPreview, MediaLayoutSpec, PreviewMediaRequest, SaveMediaPlanRequest, ReserveMediaRequest, ReleaseMediaRequest } from './media-planning.js';
import type { SourceRoot, SourceJob, SourceBinding, SourceSelection, SourceAction, SourceConfirmation, DraftSourceSnapshot } from './source-evidence.js';
import type { MasterDraft, MasterDraftSummary, AppendMasterDraftRequest, UpdateMasterDraftRequest, MasterDraftResult } from './master-drafts.js';
import type { DigitalAlbum, DigitalAlbumDetail, PhysicalLinksSnapshot, DigitalRuntime, ConfirmPhysicalLinkRequest, RelocateDigitalRequest, RegisterDigitalRequest, RemovePhysicalLinkRequest, ConfirmAbsenceRequest, PhysicalLinkResult, CollectionMatrixRow } from './physical-links.js';
import type { MusicFilter, MusicEntry, MusicDetail, SaveReleaseRequest, SaveLegacyRequest, MusicMutationResult, AddMusicPhotoRequest, RemoveMusicPhotoRequest } from './physical-music.js';
import type { PublicError } from './errors.js';
import type { CollectionFilter, CollectionPhotoImage, CollectionAddPhotoRequest, CollectionChangePhotoRequest, CollectionModel, CollectionDetail, CollectionReceiveRequest, CollectionMaterializeRequest, CollectionUpdateCopyRequest, CollectionPolicyRequest, CollectionMutationResult } from './collection.js';
import type {
  DailyRecommendationsSnapshot,
  ArtistDetail,
  ArtistSummary,
  AlbumDetail,
  AlbumSummary,
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
import type { LocalLyricsMatchSnapshot, LyricsSnapshot } from './lyrics.js';
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
import type {
  FavoriteEntityDescriptor,
  FavoriteKind,
  FavoritePage,
  FavoriteRecord,
} from './favorites.js';
import type { PublicTrackMatchResult } from './matching.js';
import type { PublicAggregatedSearchResult } from './aggregated-search.js';

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
  'library.searchArtists',
  'library.searchAlbums',
  'library.artist',
  'library.album',
  'library.liked',
  'library.likeStatus',
  'library.like',
  'library.match',
  'library.aggregateSearch',
  'library.playlists',
  'library.playlist',
  'library.dailyRecommendations',
  'favorites.list',
  'recordingMedia.plans',
  'recordingMedia.detail',
  'recordingMedia.preview',
  'recordingMedia.balance',
  'recordingMedia.save',
  'recordingMedia.reserve',
  'recordingMedia.release',
  'recordingSources.roots',
  'recordingSources.rootReceipt',
  'recordingSources.authorize',
  'recordingSources.context',
  'recordingSources.start',
  'recordingSources.revoke',
  'recordingSources.snapshot',
  'recordingSources.job',
  'recordingSources.cancel',
  'recordingSources.confirm',
  'recordingSources.recheck',
  'recordingDrafts.list',
  'recordingDrafts.detail',
  'recordingDrafts.append',
  'recordingDrafts.update',
  'recordingDrafts.runtime',
  'physicalLinks.search',
  'physicalLinks.digitalList',
  'physicalLinks.digitalDetail',
  'physicalLinks.physical',
  'physicalLinks.runtime',
  'physicalLinks.confirm',
  'physicalLinks.relocate',
  'physicalLinks.register',
  'physicalLinks.remove',
  'physicalLinks.absence',
  'physicalLinks.matrix',
  'physicalMusic.list',
  'physicalMusic.detail',
  'physicalMusic.saveRelease',
  'physicalMusic.saveLegacy',
  'physicalMusic.addPhoto',
  'physicalMusic.photo',
  'physicalMusic.removePhoto',
  'collection.addPhoto',
  'collection.photo',
  'collection.changePhoto',
  'collection.list',
  'collection.detail',
  'collection.receive',
  'collection.materialize',
  'collection.updateCopy',
  'collection.setPolicy',
  'favorites.check',
  'favorites.set',
  'lyrics.get',
  'lyrics.match.get',
  'lyrics.match.select',
  'lyrics.match.revoke',
  'roon.listZones',
  'roon.selectZone',
  'roon.library.albums',
  'roon.library.artists',
  'roon.library.genres',
  'roon.library.playlists',
  'roon.library.album',
  'roon.library.artist',
  'roon.library.genre',
  'roon.library.playlist',
  'roon.library.search',
  'roon.library.image',
  'roon.library.play',
  'roon.library.queue',
  'roon.transport.stop',
  'playback.getState',
  'playback.play',
  'playback.pause',
  'playback.resume',
  'playback.seek',
  'playback.stop',
  'playback.next',
  'playback.previous',
  'playback.playQueueIndex',
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
  'lyrics.match.changed',
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
  'recordingMedia.plans': { draftId: string };
  'recordingMedia.detail': { id: string };
  'recordingMedia.preview': PreviewMediaRequest;
  'recordingMedia.balance': { draftId: string; spec: MediaLayoutSpec };
  'recordingMedia.save': SaveMediaPlanRequest;
  'recordingMedia.reserve': ReserveMediaRequest;
  'recordingMedia.release': ReleaseMediaRequest;
  'recordingSources.roots': Record<string, never>;
  'recordingSources.rootReceipt': { commandId: string };
  'recordingSources.authorize': { commandId: string; absolutePath: string };
  'recordingSources.context': { id: string };
  'recordingSources.start': { selection: SourceSelection; absolutePath: string };
  'recordingSources.revoke': SourceAction;
  'recordingSources.snapshot': { draftId: string };
  'recordingSources.job': { id: string };
  'recordingSources.cancel': SourceAction;
  'recordingSources.confirm': SourceConfirmation;
  'recordingSources.recheck': SourceConfirmation;
  'recordingDrafts.list': { page: PageRequest };
  'recordingDrafts.detail': { id: string };
  'recordingDrafts.append': AppendMasterDraftRequest;
  'recordingDrafts.update': UpdateMasterDraftRequest;
  'recordingDrafts.runtime': { draftId: string; trackId: string };
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
  'library.searchArtists': { query: string; page: PageRequest };
  'library.searchAlbums': { query: string; page: PageRequest };
  'library.artist': { artistId: string; page: PageRequest };
  'library.album': { albumId: string; page: PageRequest };
  'library.liked': { page: PageRequest };
  'library.likeStatus': { trackId: string };
  'library.like': { trackId: string; liked: boolean };
  'library.match': { track: TrackSummary };
  'library.aggregateSearch': { query: string; page: PageRequest };
  'library.playlists': Record<string, never>;
  'library.playlist': { playlistId: string; page: PageRequest };
  'library.dailyRecommendations': Record<string, never>;
  'favorites.list': { kind?: FavoriteKind; page: PageRequest };
  'physicalLinks.search': { query: string; page: PageRequest };
  'physicalLinks.digitalList': { page: PageRequest };
  'physicalLinks.digitalDetail': { id: string };
  'physicalLinks.physical': { releaseId: string };
  'physicalLinks.runtime': { id: string };
  'physicalLinks.confirm': ConfirmPhysicalLinkRequest;
  'physicalLinks.relocate': RelocateDigitalRequest;
  'physicalLinks.register': RegisterDigitalRequest;
  'physicalLinks.remove': RemovePhysicalLinkRequest;
  'physicalLinks.absence': ConfirmAbsenceRequest;
  'physicalLinks.matrix': { page: PageRequest; query?: string };
  'physicalMusic.list': { page: PageRequest; filter?: MusicFilter };
  'physicalMusic.detail': { id: string };
  'physicalMusic.saveRelease': SaveReleaseRequest;
  'physicalMusic.saveLegacy': SaveLegacyRequest;
  'physicalMusic.addPhoto': AddMusicPhotoRequest;
  'physicalMusic.photo': { photoId: string };
  'physicalMusic.removePhoto': RemoveMusicPhotoRequest;
  'collection.list': { page: PageRequest; filter?: CollectionFilter };
  'collection.addPhoto': CollectionAddPhotoRequest;
  'collection.photo': { photoId: string };
  'collection.changePhoto': CollectionChangePhotoRequest;
  'collection.detail': { modelId: string; page: PageRequest };
  'collection.receive': CollectionReceiveRequest;
  'collection.materialize': CollectionMaterializeRequest;
  'collection.updateCopy': CollectionUpdateCopyRequest;
  'collection.setPolicy': CollectionPolicyRequest;
  'favorites.check': { descriptor: FavoriteEntityDescriptor };
  'favorites.set': { descriptor: FavoriteEntityDescriptor; favorite: boolean };
  'lyrics.get': { trackId: string };
  'lyrics.match.get': Record<string, never>;
  'lyrics.match.select': { matchSessionId: string; candidateId: string };
  'lyrics.match.revoke': Record<string, never>;
  'roon.listZones': Record<string, never>;
  'roon.selectZone': { zoneId: string };
  'roon.library.albums': { page: PageRequest };
  'roon.library.artists': { page: PageRequest };
  'roon.library.genres': { page: PageRequest };
  'roon.library.playlists': { page: PageRequest };
  'roon.library.album': { reference: string; page: PageRequest };
  'roon.library.artist': { reference: string; page: PageRequest };
  'roon.library.genre': { reference: string; page: PageRequest };
  'roon.library.playlist': { reference: string; page: PageRequest };
  'roon.library.search': { query: string; page: PageRequest };
  'roon.library.image': { reference: string; options?: RoonImageOptions };
  'roon.library.play': { reference: string; zoneId: string };
  'roon.library.queue': { reference: string; zoneId: string };
  'roon.transport.stop': Record<string, never>;
  'playback.getState': Record<string, never>;
  'playback.play': {
    trackId: string;
    qualityPreference: PlaybackQualityPreference;
    rendererClickAtMs?: number;
  };
  'playback.pause': Record<string, never>;
  'playback.resume': Record<string, never>;
  'playback.seek': { positionMs: number };
  'playback.stop': Record<string, never>;
  'playback.next': Record<string, never>;
  'playback.previous': Record<string, never>;
  'playback.playQueueIndex': { index: number };
  'playback.replaceQueue': { items: readonly PlaybackQueueRequestItem[]; index: number };
  'playback.appendQueue': { items: readonly PlaybackQueueRequestItem[] };
  'playback.insertNext': { items: readonly PlaybackQueueRequestItem[] };
}

export interface IpcCommandResults {
  'recordingMedia.plans': { draftId: string; plans: readonly MediaPlan[] };
  'recordingMedia.detail': MediaPlan;
  'recordingMedia.preview': MediaPreview;
  'recordingMedia.balance': { splitAfter: number };
  'recordingMedia.save': MediaPlan;
  'recordingMedia.reserve': MediaPlan;
  'recordingMedia.release': MediaPlan;
  'recordingSources.roots': { roots: readonly SourceRoot[] };
  'recordingSources.rootReceipt': { root: SourceRoot | null };
  'recordingSources.authorize': SourceRoot;
  'recordingSources.context': { absolutePath: string };
  'recordingSources.start': SourceJob;
  'recordingSources.revoke': SourceRoot;
  'recordingSources.snapshot': DraftSourceSnapshot;
  'recordingSources.job': { job: SourceJob | null };
  'recordingSources.cancel': SourceJob;
  'recordingSources.confirm': SourceBinding;
  'recordingSources.recheck': SourceJob;
  'recordingDrafts.list': Page<MasterDraftSummary>;
  'recordingDrafts.detail': MasterDraft;
  'recordingDrafts.append': MasterDraftResult;
  'recordingDrafts.update': MasterDraftResult;
  'recordingDrafts.runtime': DigitalRuntime;
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
  'library.searchArtists': Page<ArtistSummary>;
  'library.searchAlbums': Page<AlbumSummary>;
  'library.artist': ArtistDetail;
  'library.album': AlbumDetail;
  'library.liked': Page<TrackSummary>;
  'library.likeStatus': { liked: boolean };
  'library.like': { liked: boolean };
  'library.match': PublicTrackMatchResult;
  'library.aggregateSearch': PublicAggregatedSearchResult;
  'library.playlists': readonly PlaylistSummary[];
  'library.playlist': PlaylistDetail;
  'library.dailyRecommendations': DailyRecommendationsSnapshot;
  'favorites.list': FavoritePage;
  'physicalLinks.search': RoonLibraryPage;
  'physicalLinks.digitalList': Page<DigitalAlbum>;
  'physicalLinks.digitalDetail': DigitalAlbumDetail;
  'physicalLinks.physical': PhysicalLinksSnapshot;
  'physicalLinks.runtime': DigitalRuntime;
  'physicalLinks.confirm': PhysicalLinkResult;
  'physicalLinks.relocate': PhysicalLinkResult;
  'physicalLinks.register': PhysicalLinkResult;
  'physicalLinks.remove': PhysicalLinkResult;
  'physicalLinks.absence': PhysicalLinkResult;
  'physicalLinks.matrix': Page<CollectionMatrixRow>;
  'physicalMusic.list': Page<MusicEntry>;
  'physicalMusic.detail': MusicDetail;
  'physicalMusic.saveRelease': MusicMutationResult;
  'physicalMusic.saveLegacy': MusicMutationResult;
  'physicalMusic.addPhoto': MusicMutationResult;
  'physicalMusic.photo': CollectionPhotoImage;
  'physicalMusic.removePhoto': MusicMutationResult;
  'collection.list': Page<CollectionModel>;
  'collection.addPhoto': CollectionMutationResult;
  'collection.photo': CollectionPhotoImage;
  'collection.changePhoto': CollectionMutationResult;
  'collection.detail': CollectionDetail;
  'collection.receive': CollectionMutationResult;
  'collection.materialize': CollectionMutationResult;
  'collection.updateCopy': CollectionMutationResult;
  'collection.setPolicy': CollectionMutationResult;
  'favorites.check': { favorite: boolean };
  'favorites.set': { favorite: boolean; item?: FavoriteRecord };
  'lyrics.get': LyricsSnapshot;
  'lyrics.match.get': LocalLyricsMatchSnapshot;
  'lyrics.match.select': LocalLyricsMatchSnapshot;
  'lyrics.match.revoke': LocalLyricsMatchSnapshot;
  'roon.listZones': { zones: readonly PublicRoonZone[] };
  'roon.selectZone': PublicBridgeState;
  'roon.library.albums': RoonLibraryPage;
  'roon.library.artists': RoonLibraryPage;
  'roon.library.genres': RoonLibraryPage;
  'roon.library.playlists': RoonLibraryPage;
  'roon.library.album': RoonLibraryPage;
  'roon.library.artist': RoonLibraryPage;
  'roon.library.genre': RoonLibraryPage;
  'roon.library.playlist': RoonLibraryPage;
  'roon.library.search': RoonLibraryPage;
  'roon.library.image': RoonImageResult;
  'roon.library.play': { started: true };
  'roon.library.queue': { queued: true };
  'roon.transport.stop': { stopped: true };
  'playback.getState': PlaybackSnapshot;
  'playback.play': PlaybackSnapshot;
  'playback.pause': PlaybackSnapshot;
  'playback.resume': PlaybackSnapshot;
  'playback.seek': { positionMs: number };
  'playback.stop': PlaybackSnapshot;
  'playback.next': PlaybackSnapshot;
  'playback.previous': PlaybackSnapshot;
  'playback.playQueueIndex': PlaybackSnapshot;
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
  'lyrics.match.changed': { state: LocalLyricsMatchSnapshot };
}

export type IpcInternalCommand = 'auth.pollQr' | 'auth.verifyCredential' | 'recordingSources.rootReceipt' | 'recordingSources.authorize' | 'recordingSources.context' | 'recordingSources.start';

export interface IpcInternalCommandResults {
  'recordingSources.rootReceipt': { root: SourceRoot | null };
  'recordingSources.authorize': SourceRoot;
  'recordingSources.context': { absolutePath: string };
  'recordingSources.start': SourceJob;

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
