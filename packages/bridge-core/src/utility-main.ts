import {
  IPC_VERSION,
  parseIpcRuntimeMessage,
  validateIpcRequest,
  type IpcCommand,
  type IpcFailure,
  type IpcRequest,
  type IpcResponse,
} from '@music-bridge/contracts';
import { asBridgeError } from './shared/errors.js';
import {
  createBridgeRuntime,
  createTestBridgeRuntime,
  type CoreRuntime,
  type CoreRuntimeEvent,
} from './runtime.js';

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
  if (bridgeError.code === 'AUTH_EXPIRED') {
    return responseFailure(id, 'AUTH_EXPIRED', 'Provider session expired');
  }
  if (bridgeError.code === 'ROON_NOT_PAIRED' || bridgeError.code === 'ROON_ZONE_NOT_SELECTED') {
    return responseFailure(id, 'NOT_READY', 'Core is not ready for this request');
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
    case 'core.shutdown':
      await runtime.shutdown();
      return { stopped: true as const };
    case 'auth.setCredential':
      return runtime.setProviderCredential(
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
    case 'library.search':
      return runtime.searchTracks(
        (request.payload as { query: string }).query,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.liked':
      return runtime.getLikedTracks(
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'library.playlists':
      return runtime.getUserPlaylists();
    case 'library.playlist':
      return runtime.getPlaylist(
        (request.payload as { playlistId: string }).playlistId,
        (request.payload as { page: { offset: number; limit: number } }).page,
      );
    case 'roon.listZones':
      return { zones: runtime.listZones() };
    case 'roon.selectZone':
      return runtime.selectZone((request.payload as { zoneId: string }).zoneId);
    case 'playback.getState':
      return runtime.getPlaybackState();
    case 'playback.play':
      return runtime.playbackPlay(
        (request.payload as { trackId: string }).trackId,
        (request.payload as { quality: Parameters<CoreRuntimeForIpc['playbackPlay']>[1] }).quality,
      );
    case 'playback.stop':
      return runtime.playbackStop();
    case 'playback.next':
      return runtime.playbackNext();
    case 'playback.previous':
      return runtime.playbackPrevious();
    case 'playback.replaceQueue':
      return runtime.replacePlaybackQueue(
        (request.payload as { items: Parameters<CoreRuntimeForIpc['replacePlaybackQueue']>[0] }).items,
        (request.payload as { index: number }).index,
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
          ? createTestBridgeRuntime()
          : createBridgeRuntime({
              onEvent: (message) => {
                if (message.event !== 'core.ready') {
                  port.postMessage(message)
                }
              },
            });
      try {
        await attachCoreRuntimePort(port, runtime, { exitAfterShutdown: true });
        if (isCrashProbeEnabled(env)) {
          setTimeout(() => process.exit(71), 25);
        }
      } catch {
        process.exitCode = 1;
        process.exit(1);
      }
    })();
  });
}

export { parseIpcRuntimeMessage };
