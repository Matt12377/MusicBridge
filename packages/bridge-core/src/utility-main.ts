import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
import {
  IPC_VERSION,
  parseIpcRuntimeMessage,
  validateIpcRequest,
  type IpcCommand,
  type IpcFailure,
  type IpcRequest,
  type IpcResponse,
  type RoonImageShapeSummary,
} from '@music-bridge/contracts';
import { asBridgeError } from './shared/errors.js';
import {
  createBridgeRuntime,
  createTestBridgeRuntime,
  type CoreRuntime,
  type CoreRuntimeEvent,
} from './runtime.js';
import type { RoonTimeShapeSummary } from './roon/adapter.js';
import type { RoonBrowseShapeSummary } from './roon/library.js';

export interface UtilityPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
}

export type CoreRuntimeForIpc = CoreRuntime;

interface MessageWithPorts {
  data: unknown;
  ports?: readonly UtilityPort[];
}

interface ParentPortLike {
  once(event: 'message', listener: (event: MessageWithPorts) => void): unknown;
}

interface ProcessWithParentPort {
  parentPort?: ParentPortLike | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseFailure(
  id: string,
  code: IpcFailure['error']['code'],
  message: string,
): IpcFailure {
  return {
    version: IPC_VERSION,
    id,
    ok: false,
    error: { code, message },
  };
}

function requestId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  if (value.id.trim().length === 0 || value.id.length > 128) return undefined;
  return value.id;
}

function failureForError(id: string, error: unknown): IpcFailure {
  const bridgeError = asBridgeError(error);
  if (bridgeError.code === 'NETEASE_NOT_CONFIGURED') {
    return responseFailure(id, 'AUTH_REQUIRED', 'Provider login required');
  }
  if (bridgeError.code === 'AUTH_EXPIRED') {
    return responseFailure(id, 'AUTH_EXPIRED', 'Provider session expired');
  }
  if (bridgeError.code === 'ACCOUNT_PROFILE_UNAVAILABLE') {
    return responseFailure(id, 'ACCOUNT_PROFILE_UNAVAILABLE', 'Account profile is temporarily unavailable');
  }
  if (bridgeError.code === 'DAILY_RECOMMENDATIONS_UNAVAILABLE') {
    return responseFailure(id, 'DAILY_RECOMMENDATIONS_UNAVAILABLE', 'Daily recommendations are temporarily unavailable');
  }
  if (bridgeError.code === 'ROON_NOT_PAIRED') {
    return responseFailure(id, 'ROON_CORE_NOT_CONNECTED', 'Roon Core is not connected');
  }
  if (bridgeError.code === 'ROON_ZONE_NOT_SELECTED') {
    return responseFailure(id, 'ROON_ZONE_NOT_SELECTED', 'Roon Zone is not selected');
  }
  if (bridgeError.code === 'ROON_TRANSPORT_UNAVAILABLE') {
    return responseFailure(id, 'NOT_READY', 'Roon Transport is not ready for this request');
  }
  if (bridgeError.code === 'ROON_LIBRARY_UNAVAILABLE') {
    return responseFailure(id, 'ROON_LIBRARY_UNAVAILABLE', 'Roon Library is not available');
  }
  if (bridgeError.code === 'ROON_LIBRARY_REQUEST_FAILED') {
    return responseFailure(id, 'ROON_LIBRARY_REQUEST_FAILED', 'Roon Library request failed');
  }
  if (bridgeError.code === 'ROON_IMAGE_DECODE_FAILED') {
    return responseFailure(id, 'ROON_IMAGE_DECODE_FAILED', 'Roon image decode failed');
  }
  if (bridgeError.code === 'ROON_ALBUM_HIERARCHY_INVALID') {
    return responseFailure(id, 'ROON_ALBUM_HIERARCHY_INVALID', 'Roon album hierarchy is invalid');
  }
  if (bridgeError.code === 'ROON_TRACK_ACTION_UNAVAILABLE') {
    return responseFailure(id, 'ROON_TRACK_ACTION_UNAVAILABLE', 'Roon track action is unavailable');
  }
  if (
    bridgeError.code === 'ROON_LIBRARY_INVALID_REFERENCE' ||
    bridgeError.code === 'ROON_ACTION_BLOCKED' ||
    bridgeError.code === 'BAD_REQUEST'
  ) {
    return responseFailure(id, 'INVALID_IPC_REQUEST', 'Invalid Roon Library request');
  }
  return responseFailure(id, 'INTERNAL_ERROR', 'Core request failed');
}

function postReady(port: UtilityPort, runtime: CoreRuntime): void {
  port.postMessage({
    version: IPC_VERSION,
    event: 'core.ready',
    payload: { state: runtime.getState() },
  } satisfies CoreRuntimeEvent);
}

async function dispatch(
  runtime: CoreRuntimeForIpc,
  request: IpcRequest,
): Promise<unknown> {
  switch (request.command as IpcCommand) {
    case 'core.ping':
      return runtime.ping();
    case 'core.getHealth':
      return runtime.getHealth();
    case 'core.getState':
      return runtime.getState();
    case 'core.getDiagnostics':
      return runtime.getDiagnostics();
    case 'core.shutdown':
      await runtime.shutdown();
      return { stopped: true as const };
    case 'auth.setCredential':
      return runtime.setProviderCredential(
        (request.payload as { credential: string }).credential,
      );
    case 'auth.verifyCredential':
      return runtime.verifyProviderCredential(
        (request.payload as { credential: string }).credential,
      );
    case 'auth.clearCredential':
      return runtime.clearProviderCredential();
    case 'auth.beginQr':
      return runtime.beginQrLogin();
    case 'auth.pollQr':
      return runtime.pollQrLogin(
        (request.payload as { challengeId: string }).challengeId,
      );
    case 'auth.cancelQr':
      return runtime.cancelQrLogin(
        (request.payload as { challengeId: string }).challengeId,
      );
    case 'auth.getState':
      return runtime.getAuthState();
    case 'auth.logout':
      return runtime.logoutProvider();
    case 'account.getState':
      return runtime.getAccountState();
    case 'account.refresh':
      return runtime.refreshAccountProfile();
    case 'library.search':
      return runtime.searchTracks(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.searchArtists':
      return runtime.searchArtists(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.searchAlbums':
      return runtime.searchAlbums(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.artist':
      return runtime.getArtist(
        (request.payload as { artistId: string }).artistId,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.album':
      return runtime.getAlbum(
        (request.payload as { albumId: string }).albumId,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.aggregateSearch':
      return runtime.aggregateSearch(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.liked':
      return runtime.getLikedTracks(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.likeStatus':
      return runtime.getTrackLikeStatus(
        (request.payload as { trackId: string }).trackId,
      );
    case 'library.like':
      return runtime.likeTrack(
        (request.payload as { trackId: string }).trackId,
        (request.payload as { liked: boolean }).liked,
      );
    case 'library.match':
      return runtime.matchLibraryTrack(
        (request.payload as { track: Parameters<CoreRuntimeForIpc['matchLibraryTrack']>[0] }).track,
      );
    case 'library.playlists':
      return runtime.getUserPlaylists();
    case 'library.playlist':
      return runtime.getPlaylist(
        (request.payload as { playlistId: string }).playlistId,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.dailyRecommendations':
      return runtime.getDailyRecommendations();
    case 'favorites.list':
      return runtime.listFavorites(
        (request.payload as { kind?: Parameters<CoreRuntimeForIpc['listFavorites']>[0] }).kind,
        (request.payload as { page: Parameters<CoreRuntimeForIpc['listFavorites']>[1] }).page,
      );
    case 'favorites.check':
      return runtime.checkFavorite(
        (request.payload as { descriptor: Parameters<CoreRuntimeForIpc['checkFavorite']>[0] }).descriptor,
      );
    case 'favorites.set':
      return runtime.setFavorite(
        (request.payload as { descriptor: Parameters<CoreRuntimeForIpc['setFavorite']>[0] }).descriptor,
        (request.payload as { favorite: boolean }).favorite,
      );
    case 'lyrics.get':
      return runtime.getLyrics((request.payload as { trackId: string }).trackId);
    case 'roon.listZones':
      return { zones: runtime.listZones() };
    case 'roon.selectZone':
      return runtime.selectZone((request.payload as { zoneId: string }).zoneId);
    case 'roon.library.albums':
      return runtime.browseRoonAlbums(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.artists':
      return runtime.browseRoonArtists(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.genres':
      return runtime.browseRoonGenres(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.playlists':
      return runtime.browseRoonPlaylists(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.album':
      return runtime.browseRoonAlbum(
        (request.payload as { reference: string }).reference,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.artist':
      return runtime.browseRoonArtist(
        (request.payload as { reference: string }).reference,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.genre':
      return runtime.browseRoonGenre(
        (request.payload as { reference: string }).reference,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.playlist':
      return runtime.browseRoonPlaylist(
        (request.payload as { reference: string }).reference,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.search':
      return runtime.searchRoonLibrary(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.library.image':
      return runtime.getRoonImage(
        (request.payload as { reference: string }).reference,
        (request.payload as { options?: Parameters<CoreRuntimeForIpc['getRoonImage']>[1] }).options,
      );
    case 'roon.library.play':
      return runtime.playRoonTrack(
        (request.payload as { reference: string }).reference,
        (request.payload as { zoneId: string }).zoneId,
      );
    case 'roon.library.queue':
      return runtime.queueRoonTrack(
        (request.payload as { reference: string }).reference,
        (request.payload as { zoneId: string }).zoneId,
      );
    case 'roon.transport.stop':
      return runtime.stopRoonTransport();
    case 'playback.getState':
      return runtime.getPlaybackState();
    case 'playback.play':
      return runtime.playbackPlay(
        (request.payload as { trackId: string }).trackId,
        (request.payload as { qualityPreference: Parameters<CoreRuntimeForIpc['playbackPlay']>[1] }).qualityPreference,
        (request.payload as { rendererClickAtMs?: number }).rendererClickAtMs,
      );
    case 'playback.pause':
      return runtime.playbackPause();
    case 'playback.resume':
      return runtime.playbackResume();
    case 'playback.seek':
      return runtime.seekPlayback(
        (request.payload as { positionMs: number }).positionMs,
      );
    case 'playback.stop':
      return runtime.playbackStop();
    case 'playback.next':
      return runtime.playbackNext();
    case 'playback.previous':
      return runtime.playbackPrevious();
    case 'playback.playQueueIndex':
      return runtime.playbackPlayQueueIndex(
        (request.payload as { index: number }).index,
      );
    case 'playback.replaceQueue':
      return runtime.replacePlaybackQueue(
        (request.payload as { items: Parameters<CoreRuntimeForIpc['replacePlaybackQueue']>[0] }).items,
        (request.payload as { index: number }).index,
      );
    case 'playback.appendQueue':
      return runtime.appendPlaybackQueue(
        (request.payload as { items: Parameters<CoreRuntimeForIpc['appendPlaybackQueue']>[0] }).items,
      );
    case 'playback.insertNext':
      return runtime.insertNextPlayback(
        (request.payload as { items: Parameters<CoreRuntimeForIpc['insertNextPlayback']>[0] }).items,
      );
  }
}

export async function attachCoreRuntimePort(
  port: UtilityPort,
  runtime: CoreRuntimeForIpc,
  options: { exitAfterShutdown?: boolean } = {},
): Promise<void> {
  port.on('message', (event) => {
    void (async () => {
      const parsed = validateIpcRequest(event.data);
      const id = requestId(event.data);
      if (!parsed.ok) {
        if (id) port.postMessage(responseFailure(id, parsed.error.code, parsed.error.message));
        return;
      }
      try {
        const result = await dispatch(runtime, parsed.value);
        const response: IpcResponse = {
          version: IPC_VERSION,
          id: parsed.value.id,
          ok: true,
          result,
        };
        port.postMessage(response);
        if (parsed.value.command === 'core.shutdown' && options.exitAfterShutdown) {
          setImmediate(() => process.exit(0));
        }
      } catch (error) {
        port.postMessage(failureForError(parsed.value.id, error));
      }
    })();
  });
  port.start();
  await runtime.start();
  postReady(port, runtime);
}

export function isCrashProbeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' && env.MUSIC_BRIDGE_CORE_CRASH_PROBE === '1';
}

function createRoonTimeShapeRecorder(
  env: NodeJS.ProcessEnv,
): ((summary: RoonTimeShapeSummary) => void) | undefined {
  const outputPath = env.MUSIC_BRIDGE_ROON_TIME_GATE_PATH;
  if (env.MUSIC_BRIDGE_ROON_TIME_GATE !== '1' || outputPath === undefined) return undefined;
  return (summary) => {
    try {
      writeFileSync(outputPath, `${JSON.stringify(summary)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(outputPath, 0o600);
    } catch {
      // A diagnostic sampler must never change playback behavior.
    }
  };
}

function createRoonBrowseShapeRecorder(
  env: NodeJS.ProcessEnv,
): ((summary: RoonBrowseShapeSummary) => void) | undefined {
  const outputPath = env.MUSIC_BRIDGE_ROON_BROWSE_GATE_PATH;
  if (env.MUSIC_BRIDGE_ROON_BROWSE_GATE !== '1' || outputPath === undefined) return undefined;
  return (summary) => {
    try {
      appendFileSync(outputPath, `${JSON.stringify(summary)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(outputPath, 0o600);
    } catch {
      // 诊断采样不得改变 Browse 行为。
    }
  };
}

function createRoonImageShapeRecorder(
  env: NodeJS.ProcessEnv,
): ((summary: RoonImageShapeSummary) => void) | undefined {
  const outputPath = env.MUSIC_BRIDGE_ROON_IMAGE_GATE_PATH;
  if (env.MUSIC_BRIDGE_ROON_IMAGE_GATE !== '1' || outputPath === undefined) return undefined;
  return (summary) => {
    try {
      appendFileSync(outputPath, `${JSON.stringify(summary)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(outputPath, 0o600);
    } catch {
      // 诊断采样不得改变图片行为。
    }
  };
}

export async function runCoreUtilityProcess(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parentPort = (process as unknown as ProcessWithParentPort).parentPort;
  if (!parentPort) {
    process.exitCode = 1;
    return;
  }

  parentPort.once('message', (event) => {
    void (async () => {
      const port = event.ports?.[0];
      if (!port) {
        process.exitCode = 1;
        return;
      }
      const runtime =
        env.MUSIC_BRIDGE_CORE_TEST_MODE === '1'
          ? createTestBridgeRuntime({
              authorized: env.MUSIC_BRIDGE_UI_E2E === '1',
              ...(env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE === 'profile-unavailable' || env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE === 'expired'
                ? { accountMode: env.MUSIC_BRIDGE_SYNTHETIC_ACCOUNT_MODE }
                : {}),
            })
          : (() => {
              const onRoonTimeShape = createRoonTimeShapeRecorder(env);
              const onRoonBrowseShape = createRoonBrowseShapeRecorder(env);
              const onRoonImageShape = createRoonImageShapeRecorder(env);
              return createBridgeRuntime({
                ...(onRoonTimeShape ? { onRoonTimeShape } : {}),
                ...(onRoonBrowseShape ? { onRoonBrowseShape } : {}),
                ...(onRoonImageShape ? { onRoonImageShape } : {}),
                onEvent: (message) => {
                if (message.event !== 'core.ready') {
                  port.postMessage(message)
                }
                },
              });
            })();
      try {
        await attachCoreRuntimePort(port, runtime, { exitAfterShutdown: true });
        if (isCrashProbeEnabled(env)) {
          const configuredDelay = Number(env.MUSIC_BRIDGE_CORE_CRASH_DELAY_MS);
          const delayMs = Number.isSafeInteger(configuredDelay) && configuredDelay >= 25
            ? Math.min(configuredDelay, 5_000)
            : 25;
          setTimeout(() => process.exit(71), delayMs);
        }
      } catch {
        process.exitCode = 1;
        process.exit(1);
      }
    })();
  });
}

export { parseIpcRuntimeMessage };
