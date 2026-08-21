import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IPC_VERSION,
  type IpcEventMessage,
  type PlaybackSnapshot,
} from '@music-bridge/contracts';
import {
  attachCoreRuntimePort,
  type CoreRuntimeForIpc,
  type UtilityPort,
} from '../src/utility-main.js';
import { BridgeError } from '../src/shared/errors.js';

class FakePort implements UtilityPort {
  readonly messages: unknown[] = [];
  private listener: ((event: { data: unknown }) => void) | undefined;

  on(event: 'message', listener: (event: { data: unknown }) => void): void {
    assert.equal(event, 'message');
    this.listener = listener;
  }

  start(): void {}

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  send(message: unknown): void {
    this.listener?.({ data: message });
  }
}

function makeRuntime(): CoreRuntimeForIpc & {
  shutdownCalls: number
  setCredentialCalls: string[]
  clearCredentialCalls: number
  setProviderCredential(credential: string): Promise<typeof state>
  clearProviderCredential(): Promise<typeof state>
  getAuthState(): { status: 'idle' | 'waiting' | 'authorized' }
  beginQrLogin(): Promise<{
    status: 'waiting'
    challengeId: string
    qrImage: string
    expiresAt: number
  }>
  pollQrLogin(challengeId: string): Promise<{
    state: { status: 'authorized' }
    credential?: string
  }>
  cancelQrLogin(challengeId: string): { status: 'cancelled'; challengeId?: string }
  logoutProvider(): Promise<{ status: 'idle' }>
} {
  const state = {
    runtime: 'ready' as const,
    roon: 'disconnected' as const,
    provider: 'missing' as const,
    activeStreamCount: 0,
    activePlaybackPresent: false,
  };
  const authState = { status: 'idle' as const };
  const playbackState: PlaybackSnapshot = {
    state: 'idle',
    queue: { items: [], index: -1, hasNext: false, hasPrevious: false },
    canNext: false,
    canPrevious: false,
    canStop: false,
  };
  return {
    shutdownCalls: 0,
    setCredentialCalls: [],
    clearCredentialCalls: 0,
    async start() {},
    async shutdown() {
      this.shutdownCalls += 1;
    },
    ping: () => ({ pong: true as const }),
    getHealth: () => state,
    getState: () => state,
    listZones: () => [],
    selectZone: async () => state,
    async setProviderCredential(credential: string) {
      this.setCredentialCalls.push(credential)
      return state
    },
    async clearProviderCredential() {
      this.clearCredentialCalls += 1
      return state
    },
    getAuthState: () => authState,
    async beginQrLogin() {
      return {
        status: 'waiting' as const,
        challengeId: 'challenge-utility',
        qrImage: 'data:image/png;base64,synthetic-qr',
        expiresAt: 123_456,
      }
    },
    async pollQrLogin(challengeId: string) {
      assert.equal(challengeId, 'challenge-utility')
      return { state: { status: 'authorized' as const }, credential: 'synthetic-credential' }
    },
    cancelQrLogin: (challengeId: string) => {
      assert.equal(challengeId, 'challenge-utility')
      return { status: 'cancelled' as const }
    },
    async logoutProvider() {
      return { status: 'idle' as const }
    },
    async searchTracks() {
      return {
        items: [
          {
            id: '101',
            title: 'Synthetic Song',
            artists: ['Synthetic Artist'],
            album: 'Synthetic Album',
          },
        ],
        offset: 0,
        limit: 20,
        total: 1,
        hasMore: false,
      }
    },
    async getLikedTracks() {
      return { items: [], offset: 0, limit: 20, total: 0, hasMore: false }
    },
    async getUserPlaylists() {
      return [{ id: '301', name: 'Synthetic Playlist', trackCount: 1 }]
    },
    async getPlaylist() {
      return {
        id: '301',
        name: 'Synthetic Playlist',
        trackCount: 1,
        tracks: { items: [], offset: 0, limit: 20, total: 1, hasMore: false },
      }
    },
    getPlaybackState: () => playbackState,
    async playbackPlay() {
      return playbackState;
    },
    async playbackStop() {
      return playbackState;
    },
    async playbackNext() {
      return playbackState;
    },
    async playbackPrevious() {
      return playbackState;
    },
    async replacePlaybackQueue() {
      return playbackState;
    },
  };
}

test('utility IPC returns ready, typed responses and bounded events', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  assert.deepEqual(port.messages[0], {
    version: IPC_VERSION,
    event: 'core.ready',
    payload: { state: runtime.getState() },
  } satisfies IpcEventMessage);

  port.send({
    version: IPC_VERSION,
    id: 'ping-1',
    command: 'core.ping',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'ping-1',
    ok: true,
    result: { pong: true },
  });
});

test('utility IPC rejects invalid payloads without throwing internal details', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'bad-1',
    command: 'roon.selectZone',
    payload: { zoneId: 7 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'bad-1',
    ok: false,
    error: {
      code: 'INVALID_IPC_REQUEST',
      message: 'Invalid IPC request',
    },
  });
});

test('utility shutdown is bounded behind the typed command', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  port.send({
    version: IPC_VERSION,
    id: 'shutdown-1',
    command: 'core.shutdown',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.shutdownCalls, 1);
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'shutdown-1',
    ok: true,
    result: { stopped: true },
  });
});

test('controlled credential requests return only public state', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  port.send({
    version: IPC_VERSION,
    id: 'credential-1',
    command: 'auth.setCredential',
    payload: { credential: 'fixture-credential' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.setCredentialCalls, ['fixture-credential']);
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'credential-1',
    ok: true,
    result: runtime.getState(),
  });
  assert.doesNotMatch(JSON.stringify(port.messages[1]), /fixture-credential/);

  port.send({
    version: IPC_VERSION,
    id: 'credential-2',
    command: 'auth.clearCredential',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.clearCredentialCalls, 1);
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'credential-2',
    ok: true,
    result: runtime.getState(),
  });
});

test('utility IPC exposes paged library data without raw provider fields', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'library-search',
    command: 'library.search',
    payload: { query: 'synthetic', page: { offset: 0, limit: 20 } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'library-search',
    ok: true,
    result: {
      items: [
        {
          id: '101',
          title: 'Synthetic Song',
          artists: ['Synthetic Artist'],
          album: 'Synthetic Album',
        },
      ],
      offset: 0,
      limit: 20,
      total: 1,
      hasMore: false,
    },
  });
  assert.doesNotMatch(JSON.stringify(port.messages[1]), /rawProvider|cookie|token|Authorization/i);

  port.send({
    version: IPC_VERSION,
    id: 'library-playlists',
    command: 'library.playlists',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'library-playlists',
    ok: true,
    result: [{ id: '301', name: 'Synthetic Playlist', trackCount: 1 }],
  });
});

test('utility IPC maps an expired Provider session to a public error', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  runtime.searchTracks = async () => {
    throw new BridgeError('AUTH_EXPIRED', 'synthetic raw provider detail');
  };
  await attachCoreRuntimePort(port, runtime);

  port.send({
    version: IPC_VERSION,
    id: 'library-expired',
    command: 'library.search',
    payload: { query: 'synthetic', page: { offset: 0, limit: 20 } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'library-expired',
    ok: false,
    error: { code: 'AUTH_EXPIRED', message: 'Provider session expired' },
  });
  assert.doesNotMatch(JSON.stringify(port.messages[1]), /synthetic raw provider detail/);
});

test('utility IPC dispatches typed playback controls without exposing stream internals', async () => {
  const port = new FakePort();
  const runtime = makeRuntime();
  await attachCoreRuntimePort(port, runtime);

  for (const [id, command, payload] of [
    ['playback-state', 'playback.getState', {}],
    ['playback-play', 'playback.play', { trackId: '101', quality: 'lossless' }],
    ['playback-stop', 'playback.stop', {}],
    ['playback-next', 'playback.next', {}],
    ['playback-previous', 'playback.previous', {}],
    [
      'playback-replace',
      'playback.replaceQueue',
      { items: [{ trackId: '101', quality: 'lossless' }], index: 0 },
    ],
  ] as const) {
    port.send({ version: IPC_VERSION, id, command, payload });
    await new Promise((resolve) => setImmediate(resolve));
    const response = port.messages.at(-1);
    assert.deepEqual(response, {
      version: IPC_VERSION,
      id,
      ok: true,
      result: runtime.getPlaybackState(),
    });
    assert.doesNotMatch(JSON.stringify(response), /upstreamUrl|gatewayToken|cookie|token/i);
  }
});

test('utility QR commands keep the credential only in the Core-to-Main response', async () => {
  const port = new FakePort();
  await attachCoreRuntimePort(port, makeRuntime());

  port.send({
    version: IPC_VERSION,
    id: 'qr-begin',
    command: 'auth.beginQr',
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[1], {
    version: IPC_VERSION,
    id: 'qr-begin',
    ok: true,
    result: {
      status: 'waiting',
      challengeId: 'challenge-utility',
      qrImage: 'data:image/png;base64,synthetic-qr',
      expiresAt: 123_456,
    },
  });

  port.send({
    version: IPC_VERSION,
    id: 'qr-poll',
    command: 'auth.pollQr',
    payload: { challengeId: 'challenge-utility' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages[2], {
    version: IPC_VERSION,
    id: 'qr-poll',
    ok: true,
    result: {
      state: { status: 'authorized' },
      credential: 'synthetic-credential',
    },
  });
});
