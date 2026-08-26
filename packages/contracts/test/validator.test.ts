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

  const imageUnavailable = validateIpcResponse({
    version: IPC_VERSION,
    id: 'request-image-unavailable',
    ok: false,
    error: {
      code: 'ROON_IMAGE_UNAVAILABLE',
      message: 'Roon image is unavailable',
    },
  });
  assert.equal(imageUnavailable.ok, true);

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

test('contracts keeps credential verification status Main-only', () => {
  const request = validateIpcRequest({
    version: IPC_VERSION,
    id: 'auth-verify',
    command: 'auth.verifyCredential',
    payload: { credential: 'fixture-credential' },
  });
  assert.equal(request.ok, true);

  const internalResponse = {
    version: IPC_VERSION,
    id: 'auth-verify',
    ok: true,
    result: { status: 'unavailable' },
  };
  assert.equal(validateIpcResponseForCommand(internalResponse, 'auth.verifyCredential').ok, false);
  assert.equal(
    validateIpcInternalResponseForCommand(internalResponse, 'auth.verifyCredential').ok,
    true,
  );
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
      id: 'library-artist',
      command: 'library.artist',
      payload: { artistId: '7', page: { offset: 0, limit: 20 } },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'library-aggregate-search',
      command: 'library.aggregateSearch',
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
      id: 'library-like-status',
      command: 'library.likeStatus',
      payload: { trackId: '101' },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'library-like',
      command: 'library.like',
      payload: { trackId: '101', liked: true },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'library-match',
      command: 'library.match',
      payload: {
        track: {
          id: '101',
          title: 'Synthetic Song',
          artists: ['Synthetic Artist'],
          album: 'Synthetic Album',
        },
      },
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
      id: 'playback-seek',
      command: 'playback.seek',
      payload: { positionMs: 12_345 },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'roon-transport-stop',
      command: 'roon.transport.stop',
      payload: {},
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

  const artistDetail = validateIpcResponseForCommand({
    version: IPC_VERSION,
    id: 'library-artist',
    ok: true,
    result: {
      id: '7',
      name: '周杰伦',
      tracks: page,
    },
  }, 'library.artist');
  assert.equal(artistDetail.ok, true);

  assert.equal(
    validateIpcResponseForCommand({
      version: IPC_VERSION,
      id: 'playback-seek',
      ok: true,
      result: { positionMs: 12_345 },
    }, 'playback.seek').ok,
    true,
  );

  assert.equal(
    validateIpcResponseForCommand({
      version: IPC_VERSION,
      id: 'library-aggregate-search',
      ok: true,
      result: {
        query: 'synthetic',
        netease: page,
        roon: { items: [], offset: 0, limit: 20, hasMore: false },
        roonAvailable: false,
      },
    }, 'library.aggregateSearch').ok,
    true,
  );

  assert.equal(
    validateIpcResponseForCommand({
      version: IPC_VERSION,
      id: 'library-match',
      ok: true,
      result: {
        trackId: '101',
        state: 'NONE',
        confidence: 0,
        evidence: ['roon-library-unavailable'],
        candidates: [],
        algorithmVersion: 'v2-deterministic-1',
      },
    }, 'library.match').ok,
    true,
  );

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

test('contracts preserves the public AUTH_REQUIRED error without internal details', () => {
  const result = validateIpcResponseForCommand(
    {
      version: IPC_VERSION,
      id: 'library-auth-required',
      ok: false,
      error: { code: 'AUTH_REQUIRED', message: 'Provider login required' },
    },
    'library.search',
  );
  assert.equal(result.ok, true);
});

test('contracts keeps Roon zone seek capability public and bounded', () => {
  const result = validateIpcResponseForCommand({
    version: IPC_VERSION,
    id: 'roon-zones',
    ok: true,
    result: {
      zones: [{ zoneId: 'zone-1', displayName: 'Zone', selected: true, seekAllowed: true }],
    },
  }, 'roon.listZones');

  assert.equal(result.ok, true);
});

test('contracts validates the opaque Roon Library browse and image seams', () => {
  const albumPage = {
    items: [{
      reference: 'musicbridge-v2-entity-123e4567-e89b-12d3-a456-426614174000',
      kind: 'album',
      title: 'Private Album',
      durationMs: 123_000,
      artworkReference: 'musicbridge-v2-image-123e4567-e89b-12d3-a456-426614174001',
    }],
    offset: 0,
    limit: 20,
    total: 1,
    hasMore: false,
  };
  const albumItem = albumPage.items[0];
  assert.ok(albumItem);
  assert.ok(albumItem.artworkReference);
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'roon-albums',
      command: 'roon.library.albums',
      payload: { page: { offset: 0, limit: 20 } },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'roon-album',
      command: 'roon.library.album',
      payload: {
        reference: albumItem.reference,
        page: { offset: 0, limit: 20 },
      },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'roon-image',
      command: 'roon.library.image',
      payload: {
        reference: albumItem.artworkReference,
        options: { width: 256, height: 256, scale: 'fit', format: 'image/jpeg' },
      },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcResponseForCommand({
      version: IPC_VERSION,
      id: 'roon-albums',
      ok: true,
      result: albumPage,
    }, 'roon.library.albums').ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'roon-play',
      command: 'roon.library.play',
      payload: {
        reference: albumItem.reference,
        zoneId: 'zone-1',
      },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcResponseForCommand({
      version: IPC_VERSION,
      id: 'roon-play',
      ok: true,
      result: { started: true },
    }, 'roon.library.play').ok,
    true,
  );
  assert.equal(
    validateIpcResponseForCommand({
      version: IPC_VERSION,
      id: 'roon-queue',
      ok: true,
      result: { queued: true, rawAction: 'Delete from Library' },
    }, 'roon.library.queue').ok,
    false,
  );
  assert.equal(
    validateIpcResponseForCommand({
      version: IPC_VERSION,
      id: 'roon-image',
      ok: true,
      result: {
        contentType: 'image/jpeg',
        body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      },
    }, 'roon.library.image').ok,
    true,
  );
  for (const result of [
    { contentType: 'image/jpeg', body: new Uint8Array() },
    {
      contentType: 'image/png',
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
    },
    {
      contentType: 'image/jpeg',
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    },
    { contentType: 'image/jpeg', body: { 0: 0xff, 1: 0xd8, 2: 0xff } },
  ]) {
    assert.equal(
      validateIpcResponseForCommand({
        version: IPC_VERSION,
        id: 'roon-image-invalid',
        ok: true,
        result,
      }, 'roon.library.image').ok,
      false,
    );
  }
  for (const [id, command, payload] of [
    ['roon-artists', 'roon.library.artists', { page: { offset: 0, limit: 20 } }],
    ['roon-genres', 'roon.library.genres', { page: { offset: 0, limit: 20 } }],
    ['roon-playlists', 'roon.library.playlists', { page: { offset: 0, limit: 20 } }],
    ['roon-genre', 'roon.library.genre', {
      reference: albumItem.reference,
      page: { offset: 0, limit: 20 },
    }],
    ['roon-playlist', 'roon.library.playlist', {
      reference: albumItem.reference,
      page: { offset: 0, limit: 20 },
    }],
    ['roon-artist', 'roon.library.artist', {
      reference: albumItem.reference,
      page: { offset: 0, limit: 20 },
    }],
    ['roon-search', 'roon.library.search', {
      query: 'Artist',
      page: { offset: 0, limit: 20 },
    }],
  ] as const) {
    assert.equal(
      validateIpcRequest({ version: IPC_VERSION, id, command, payload }).ok,
      true,
    );
    assert.equal(
      validateIpcResponseForCommand({
        version: IPC_VERSION,
        id,
        ok: true,
        result: albumPage,
      }, command).ok,
      true,
    );
  }
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'roon-delete-shaped',
      command: 'roon.library.album',
      payload: { reference: 'album:delete', page: { offset: 0, limit: 20 } },
    }).ok,
    false,
  );
});

test('contracts validates local favorite relationships without media or provider fields', () => {
  const descriptor = {
    kind: 'track',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    durationMs: 180_000,
  };
  const record = {
    ...descriptor,
    favoriteId: '123e4567-e89b-12d3-a456-426614174000',
    createdAt: 1_000,
    updatedAt: 2_000,
  };
  const page = {
    items: [record],
    offset: 0,
    limit: 20,
    total: 1,
    hasMore: false,
  };

  assert.equal(validateIpcRequest({
    version: IPC_VERSION,
    id: 'favorites-list',
    command: 'favorites.list',
    payload: { kind: 'track', page: { offset: 0, limit: 20 } },
  }).ok, true);
  assert.equal(validateIpcRequest({
    version: IPC_VERSION,
    id: 'favorites-check',
    command: 'favorites.check',
    payload: { descriptor },
  }).ok, true);
  assert.equal(validateIpcRequest({
    version: IPC_VERSION,
    id: 'favorites-set',
    command: 'favorites.set',
    payload: { descriptor, favorite: true },
  }).ok, true);
  assert.equal(validateIpcResponseForCommand({
    version: IPC_VERSION,
    id: 'favorites-list',
    ok: true,
    result: page,
  }, 'favorites.list').ok, true);
  assert.equal(validateIpcResponseForCommand({
    version: IPC_VERSION,
    id: 'favorites-check',
    ok: true,
    result: { favorite: true },
  }, 'favorites.check').ok, true);
  assert.equal(validateIpcResponseForCommand({
    version: IPC_VERSION,
    id: 'favorites-set',
    ok: true,
    result: { favorite: true, item: record },
  }, 'favorites.set').ok, true);
  assert.equal(validateIpcRequest({
    version: IPC_VERSION,
    id: 'favorites-path',
    command: 'favorites.set',
    payload: { descriptor: { ...descriptor, mediaPath: '/Users/music/song.flac' }, favorite: true },
  }).ok, false);
});

test('contracts validates bounded playback controls and sanitized snapshots', () => {
  const snapshot = {
    state: 'playing',
    queue: {
      items: [
        {
          trackId: '101',
          qualityPreference: 'lossless',
          preferredSource: 'roon',
          resolvedSource: 'roon',
        },
        { trackId: '102', qualityPreference: 'standard', preferredSource: 'netease' },
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
      artworkReference: 'musicbridge-v2-image-123e4567-e89b-12d3-a456-426614174001',
    },
    source: 'roon',
    requestedQuality: 'lossless',
    actualQuality: 'lossless',
    qualityPreference: 'lossless',
    positionMs: 0,
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
    canPause: true,
    canResume: false,
  };

  for (const [id, command, payload] of [
    ['playback-get', 'playback.getState', {}],
    ['playback-play', 'playback.play', { trackId: '101', qualityPreference: 'lossless' }],
    ['playback-play-traced', 'playback.play', { trackId: '101', qualityPreference: 'lossless', rendererClickAtMs: 1_700_000_000_000 }],
    ['playback-pause', 'playback.pause', {}],
    ['playback-resume', 'playback.resume', {}],
    ['playback-stop', 'playback.stop', {}],
    ['playback-next', 'playback.next', {}],
    ['playback-previous', 'playback.previous', {}],
    ['playback-queue-index', 'playback.playQueueIndex', { index: 0 }],
    [
      'playback-replace',
      'playback.replaceQueue',
      {
        items: [{ trackId: '101', qualityPreference: 'lossless', preferredSource: 'smart' }],
        index: 0,
      },
    ],
    ['playback-append', 'playback.appendQueue', { items: [{ trackId: '102', qualityPreference: 'standard' }] }],
    ['playback-insert-next', 'playback.insertNext', { items: [{ trackId: '103', qualityPreference: 'standard' }] }],
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
    validateIpcResponseForCommand(
      {
        version: IPC_VERSION,
        id: 'playback-paused',
        ok: true,
        result: { ...snapshot, state: 'paused', canPause: false, canResume: true },
      },
      'playback.getState',
    ).ok,
    true,
  );

  for (const state of ['pausing', 'resuming']) {
    assert.equal(
      validateIpcResponseForCommand(
        {
          version: IPC_VERSION,
          id: `playback-${state}`,
          ok: true,
          result: {
            ...snapshot,
            state,
            canPause: false,
            canResume: false,
          },
        },
        'playback.getState',
      ).ok,
      true,
    );
  }

  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'playback-replace-1197',
      command: 'playback.replaceQueue',
      payload: {
        items: Array.from({ length: 1_197 }, (_, index) => ({
          trackId: String(index + 1),
          qualityPreference: 'standard',
        })),
        index: 0,
      },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'playback-replace-too-many',
      command: 'playback.replaceQueue',
      payload: {
        items: Array.from({ length: 5_001 }, (_, index) => ({
          trackId: String(index + 1),
          qualityPreference: 'standard',
        })),
        index: 0,
      },
    }).ok,
    false,
  );
  assert.equal(
    validateIpcResponseForCommand(
      {
        version: IPC_VERSION,
        id: 'playback-roon-reference-leak',
        ok: true,
        result: {
          ...snapshot,
          queue: {
            ...snapshot.queue,
            items: [{ ...snapshot.queue.items[0], roonReference: 'musicbridge-v2-entity-secret' }],
          },
        },
      },
      'playback.getState',
    ).ok,
    false,
  );
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'playback-invalid-quality',
      command: 'playback.play',
      payload: { trackId: '101', qualityPreference: 'hi-res-unlock' },
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

test('contracts validates public account state and keeps provider identity fields out', () => {
  const ready = {
    status: 'ready',
    profile: {
      displayName: 'Synthetic Listener',
      avatarUrl: 'https://p1.music.126.net/avatar.jpg',
    },
  };
  for (const command of ['account.getState', 'account.refresh'] as const) {
    assert.equal(
      validateIpcRequest({ version: IPC_VERSION, id: command, command, payload: {} }).ok,
      true,
    );
    assert.equal(
      validateIpcResponseForCommand(
        { version: IPC_VERSION, id: command, ok: true, result: ready },
        command,
      ).ok,
      true,
    );
  }
  assert.equal(
    validateIpcEvent({
      version: IPC_VERSION,
      event: 'account.changed',
      payload: { state: ready },
    }).ok,
    true,
  );
  assert.equal(
    validateIpcResponseForCommand(
      {
        version: IPC_VERSION,
        id: 'account-unsafe',
        ok: true,
        result: { ...ready, profile: { ...ready.profile, userId: 'private' } },
      },
      'account.getState',
    ).ok,
    false,
  );
  assert.equal(
    validateIpcResponseForCommand(
      {
        version: IPC_VERSION,
        id: 'account-unsafe-avatar',
        ok: true,
        result: {
          status: 'ready',
          profile: { displayName: 'Synthetic', avatarUrl: 'https://example.invalid/a.jpg' },
        },
      },
      'account.getState',
    ).ok,
    false,
  );
});

test('contracts validates daily recommendation snapshots with bounded reasons and artwork', () => {
  const track = {
    id: '101',
    title: 'Synthetic Recommendation',
    artists: ['Synthetic Artist'],
    album: 'Synthetic Album',
    durationMs: 180_000,
    artworkUrl: 'https://p1.music.126.net/recommend.jpg',
    recommendationReason: '根据你的收藏偏好推荐',
  };
  const snapshot = {
    dayKey: '2026-08-22',
    tracks: [track],
  };
  assert.equal(
    validateIpcRequest({
      version: IPC_VERSION,
      id: 'daily-recommendations',
      command: 'library.dailyRecommendations',
      payload: {},
    }).ok,
    true,
  );
  assert.equal(
    validateIpcResponseForCommand(
      { version: IPC_VERSION, id: 'daily-recommendations', ok: true, result: snapshot },
      'library.dailyRecommendations',
    ).ok,
    true,
  );
  assert.equal(
    validateIpcResponseForCommand(
      {
        version: IPC_VERSION,
        id: 'daily-too-many',
        ok: true,
        result: { dayKey: '2026-08-22', tracks: Array.from({ length: 51 }, () => track) },
      },
      'library.dailyRecommendations',
    ).ok,
    false,
  );
  assert.equal(
    validateIpcResponseForCommand(
      {
        version: IPC_VERSION,
        id: 'daily-unsafe',
        ok: true,
        result: {
          dayKey: '2026-08-22',
          tracks: [{ ...track, recommendationReason: 'x'.repeat(121) }],
        },
      },
      'library.dailyRecommendations',
    ).ok,
    false,
  );
});
