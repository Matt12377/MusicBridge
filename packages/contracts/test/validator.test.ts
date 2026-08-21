import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IPC_VERSION,
  parseIpcRuntimeMessage,
  validateIpcEvent,
  validateIpcInternalResponseForCommand,
  validateIpcResponse,
  validateIpcResponseForCommand,
  validateIpcRequest,
} from '../src/index.js';

test('contracts accepts a versioned public core request', () => {
  const result = validateIpcRequest({
    version: IPC_VERSION,
    id: 'request-1',
    command: 'core.ping',
    payload: {},
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.version, IPC_VERSION);
    assert.equal(result.value.command, 'core.ping');
  }
});

test('contracts rejects an unsupported IPC version', () => {
  const result = validateIpcRequest({
    version: 2,
    id: 'request-2',
    command: 'core.ping',
    payload: {},
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'UNSUPPORTED_IPC_VERSION',
      message: 'Unsupported IPC version',
    },
  });
});

test('contracts rejects an unknown command without exposing internals', () => {
  const result = validateIpcRequest({
    version: IPC_VERSION,
    id: 'request-3',
    command: 'internal.readCookie',
    payload: {},
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'UNKNOWN_IPC_COMMAND',
      message: 'Unknown IPC command',
    },
  });
});

test('contracts rejects malformed request identity and payload shape', () => {
  const result = validateIpcRequest({
    version: IPC_VERSION,
    id: '',
    command: 'core.ping',
    payload: null,
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'INVALID_IPC_REQUEST',
      message: 'Invalid IPC request',
    },
  });
});

test('contracts rejects a valid command with an invalid command payload', () => {
  const result = validateIpcRequest({
    version: IPC_VERSION,
    id: 'request-4',
    command: 'roon.selectZone',
    payload: { zoneId: 42 },
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'INVALID_IPC_REQUEST',
      message: 'Invalid IPC request',
    },
  });
});

test('contracts accepts controlled credential input but only validates public state as its result', () => {
  const request = validateIpcRequest({
    version: IPC_VERSION,
    id: 'credential-request',
    command: 'auth.setCredential',
    payload: { credential: 'fixture-credential' },
  });
  assert.equal(request.ok, true);

  const response = validateIpcResponseForCommand(
    {
      version: IPC_VERSION,
      id: 'credential-request',
      ok: true,
      result: {
        runtime: 'ready',
        roon: 'paired',
        provider: 'configured',
        activeStreamCount: 0,
        activePlaybackPresent: false,
      },
    },
    'auth.setCredential',
  );
  assert.equal(response.ok, true);

  const invalid = validateIpcRequest({
    version: IPC_VERSION,
    id: 'credential-request-too-long',
    command: 'auth.setCredential',
    payload: { credential: 'x'.repeat(64 * 1024 + 1) },
  });
  assert.deepEqual(invalid, {
    ok: false,
    error: {
      code: 'INVALID_IPC_REQUEST',
      message: 'Invalid IPC request',
    },
  });
});

test('contracts accepts a typed response and rejects an unsafe error shape', () => {
  const response = validateIpcResponse({
    version: IPC_VERSION,
    id: 'request-5',
    ok: true,
    result: { pong: true },
  });
  assert.equal(response.ok, true);

  const unsafe = validateIpcResponse({
    version: IPC_VERSION,
    id: 'request-6',
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'internal stack at /private/path',
      stack: 'not allowed',
    },
  });
  assert.deepEqual(unsafe, {
    ok: false,
    error: {
      code: 'INVALID_IPC_RESPONSE',
      message: 'Invalid IPC response',
    },
  });

  assert.deepEqual(
    validateIpcResponseForCommand(
      {
        version: IPC_VERSION,
        id: 'request-typed',
        ok: true,
        result: { pong: 'yes' },
      },
      'core.ping',
    ),
    {
      ok: false,
      error: {
        code: 'INVALID_IPC_RESPONSE',
        message: 'Invalid IPC response',
      },
    },
  );
});

test('contracts parses public health events and rejects unknown runtime messages', () => {
  const event = validateIpcEvent({
    version: IPC_VERSION,
    event: 'core.health',
    payload: {
      state: {
        runtime: 'ready',
        roon: 'discovering',
        provider: 'missing',
        activeStreamCount: 0,
        activePlaybackPresent: false,
      },
    },
  });
  assert.equal(event.ok, true);

  const unknown = parseIpcRuntimeMessage({
    version: IPC_VERSION,
    kind: 'internal',
    payload: {},
  });
  assert.deepEqual(unknown, {
    ok: false,
    error: {
      code: 'INVALID_IPC_RESPONSE',
      message: 'Invalid IPC response',
    },
  });
});

test('contracts keeps QR login state public and isolates the internal poll credential', () => {
  const publicState = {
    status: 'waiting',
    challengeId: 'challenge-1',
    qrImage: 'data:image/png;base64,synthetic-qr',
    expiresAt: 123_456,
  };

  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'auth-begin',
      command: 'auth.beginQr',
      payload: {},
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'auth-poll',
      command: 'auth.pollQr',
      payload: { challengeId: 'challenge-1' },
    }).ok,
    true,
  );
  assert.deepEqual(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'auth-poll-invalid',
      command: 'auth.pollQr',
      payload: { challengeId: '' },
    }),
    {
      ok: false,
      error: {
        code: 'INVALID_IPC_REQUEST',
        message: 'Invalid IPC request',
      },
    },
  );

  const internalResponse = {
    version: IPC_VERSION,
    id: 'auth-poll',
    ok: true,
    result: { state: { status: 'authorized' }, credential: 'synthetic-credential' },
  };
  assert.equal(
    validateIpcResponseForCommand(internalResponse, 'auth.pollQr').ok,
    false,
  );
  const validatedInternal = validateIpcInternalResponseForCommand(
    internalResponse,
    'auth.pollQr',
  );
  assert.equal(validatedInternal.ok, true);

  const publicResponse = validateIpcResponseForCommand(
    {
      version: IPC_VERSION,
      id: 'auth-begin',
      ok: true,
      result: publicState,
    },
    'auth.beginQr',
  );
  assert.equal(publicResponse.ok, true);

  const event = validateIpcEvent({
    version: IPC_VERSION,
    event: 'auth.changed',
    payload: { state: { status: 'idle' } },
  });
  assert.equal(event.ok, true);
});

test('contracts validates bounded library commands and sanitized paged results', () => {
  const page = {
    items: [
      {
        id: '101',
        title: 'Synthetic Song',
        artists: ['Synthetic Artist'],
        album: 'Synthetic Album',
        artworkUrl: 'https://p1.music.126.net/synthetic-cover.jpg',
      },
    ],
    offset: 0,
    limit: 20,
    total: 1,
    hasMore: false,
  };

  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'library-search',
      command: 'library.search',
      payload: { query: 'synthetic', page: { offset: 0, limit: 20 } },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'library-liked',
      command: 'library.liked',
      payload: { page: { offset: 20, limit: 20 } },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'library-playlists',
      command: 'library.playlists',
      payload: {},
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'library-playlist',
      command: 'library.playlist',
      payload: { playlistId: '301', page: { offset: 0, limit: 20 } },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'library-search-too-long',
      command: 'library.search',
      payload: { query: 'x'.repeat(101), page: { offset: 0, limit: 20 } },
    }).ok,
    false,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'library-page-too-large',
      command: 'library.search',
      payload: { query: 'synthetic', page: { offset: 0, limit: 101 } },
    }).ok,
    false,
  );

  const response = validateIpcResponseForCommand(
    {
      version: IPC_VERSION,
      id: 'library-search',
      ok: true,
      result: page,
    },
    'library.search',
  );
  assert.equal(response.ok, true);

  const unsafeResponse = validateIpcResponseForCommand(
    {
      version: IPC_VERSION,
      id: 'library-search',
      ok: true,
      result: { ...page, rawProviderResponse: { code: 200 } },
    },
    'library.search',
  );
  assert.deepEqual(unsafeResponse, {
    ok: false,
    error: {
      code: 'INVALID_IPC_RESPONSE',
      message: 'Invalid IPC response',
    },
  });
});

test('contracts preserves the public AUTH_EXPIRED error without internal details', () => {
  const result = validateIpcResponseForCommand(
    {
      version: IPC_VERSION,
      id: 'library-expired',
      ok: false,
      error: { code: 'AUTH_EXPIRED', message: 'Provider session expired' },
    },
    'library.search',
  );
  assert.equal(result.ok, true);
});

test('contracts validates bounded playback controls and sanitized snapshots', () => {
  const snapshot = {
    state: 'playing',
    queue: {
      items: [
        { trackId: '101', quality: 'lossless' },
        { trackId: '102', quality: 'standard' },
      ],
      index: 0,
      hasNext: true,
      hasPrevious: false,
    },
    currentTrack: {
      id: '101',
      title: 'Synthetic Song',
      artists: ['Synthetic Artist'],
      album: 'Synthetic Album',
    },
    requestedQuality: 'lossless',
    actualQuality: 'lossless',
    format: 'flac',
    bitrate: 900_000,
    selectedZoneId: 'zone-1',
    lastIssue: {
      code: 'ROON_MEDIA_ERROR',
      message: 'Roon 报告媒体错误，请重试',
      retryable: true,
      diagnosticId: 'diag-contract-1',
      action: 'retry',
    },
    qualityNotice: {
      code: 'QUALITY_DOWNGRADED',
      message: '请求无损，实际高品质',
      retryable: false,
      diagnosticId: 'diag-contract-2',
      action: 'none',
    },
    canNext: true,
    canPrevious: false,
    canStop: true,
  };

  for (const [id, command, payload] of [
    ['playback-get', 'playback.getState', {}],
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
    assert.equal(
      validateIpcRequest({ version: IPC_VERSION, id, command, payload }).ok,
      true,
    );
    assert.equal(
      validateIpcResponseForCommand(
        { version: IPC_VERSION, id, ok: true, result: snapshot },
        command,
      ).ok,
      true,
    );
  }

  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'playback-replace-too-many',
      command: 'playback.replaceQueue',
      payload: {
        items: Array.from({ length: 101 }, (_, index) => ({
          trackId: String(index + 1),
          quality: 'standard',
        })),
        index: 0,
      },
    }).ok,
    false,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'playback-invalid-quality',
      command: 'playback.play',
      payload: { trackId: '101', quality: 'hi-res-unlock' },
    }).ok,
    false,
  );

  assert.equal(
    validateIpcEvent({
      version: IPC_VERSION,
      event: 'playback.changed',
      payload: { state: snapshot },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcEvent({
      version: IPC_VERSION,
      event: 'queue.changed',
      payload: { queue: snapshot.queue },
    }).ok,
    true,
  );

  assert.equal(
    validateIpcResponseForCommand(
      {
        version: IPC_VERSION,
        id: 'playback-invalid-issue',
        ok: true,
        result: {
          ...snapshot,
          lastIssue: { ...snapshot.lastIssue, diagnosticId: '' },
        },
      },
      'playback.getState',
    ).ok,
    false,
  );
});

test('contracts validates bounded lyrics snapshots and rejects provider fields', () => {
  const snapshot = {
    status: 'ready',
    lines: [
      {
        startMs: 0,
        endMs: 1_000,
        text: 'Synthetic lyric',
        translation: 'Synthetic translation',
        romanization: 'Synthetic romanization',
        words: [{ startMs: 0, endMs: 500, text: 'Synthetic' }],
      },
    ],
    activeLineIndex: 0,
    activeWordIndex: 0,
    timingSource: 'roon-time',
  };

  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'lyrics-get',
      command: 'lyrics.get',
      payload: { trackId: '101' },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcResponseForCommand(
      { version: IPC_VERSION, id: 'lyrics-get', ok: true, result: snapshot },
      'lyrics.get',
    ).ok,
    true,
  );
  assert.equal(
    validateIpcEvent({
      version: IPC_VERSION,
      event: 'lyrics.changed',
      payload: { state: snapshot },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcResponseForCommand(
      {
        version: IPC_VERSION,
        id: 'lyrics-unsafe',
        ok: true,
        result: { ...snapshot, rawProviderResponse: { code: 200 } },
      },
      'lyrics.get',
    ).ok,
    false,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'lyrics-invalid-track',
      command: 'lyrics.get',
      payload: { trackId: 'not-a-numeric-id' },
    }).ok,
    false,
  );
});
