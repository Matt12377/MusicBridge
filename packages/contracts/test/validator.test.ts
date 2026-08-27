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

test('V3 照片命令和筛选合同有界，不接受外部路径或任意 URL', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const image = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', width: 1, height: 1 };
  const request = (command: string, payload: unknown) => validateIpcRequest({ version: 1, id: 'photo', command, payload }).ok;
  assert.equal(request('collection.list', { page: { offset: 0, limit: 20 }, filter: { query: 'SA', brand: 'TDK', decade: 1990 } }), true);
  assert.equal(request('collection.addPhoto', { commandId: id, modelId: id, image }), true);
  assert.equal(request('collection.photo', { photoId: id }), true);
  assert.equal(request('collection.changePhoto', { commandId: id, modelId: id, photoId: id, expectedRevision: 1, action: 'feature' }), true);
  for (const bad of [{ ...image, dataUrl: 'file:///private/photo.jpg' }, { ...image, dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }, { ...image, width: 20000 }, { ...image, path: '/private/photo.jpg' }]) {
    assert.equal(request('collection.addPhoto', { commandId: id, modelId: id, image: bad }), false);
  }
  assert.equal(request('collection.list', { page: { offset: 0, limit: 20 }, filter: { decade: 1991 } }), false);
  assert.equal(request('collection.list', { page: { offset: 0, limit: 20 }, filter: { query: 'x'.repeat(121) } }), false);
});

test('V3 库存合同接受有界的查询与收货请求', () => {
  for (const [command, payload] of [
    ['collection.list', { page: { offset: 0, limit: 20 } }],
    ['collection.receive', {
      commandId: '11111111-1111-4111-8111-111111111111',
      model: { brand: 'TDK', name: 'SA', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
      lengthMinutes: 90,
      quantities: { sealedBlank: 5, openedBlank: 1, legacyUsed: 1, unclassified: 0 },
    }],
  ]) {
    assert.equal(validateIpcRequest({ version: IPC_VERSION, id: 'inventory-1', command, payload }).ok, true, String(command));
  }
});

test('V3 库存拒绝非法数量、未知字段、错配介质及无版次的确认', () => {
  const payload = {
    commandId: '11111111-1111-4111-8111-111111111111',
    model: { brand: 'TDK', name: 'SA', edition: '1990', year: 1990, format: 'cassette', tapeType: 'II', identification: 'verified' },
    lengthMinutes: 90,
    quantities: { sealedBlank: 5, openedBlank: 0, legacyUsed: 0, unclassified: 0 },
  };
  for (const invalid of [
    { ...payload, commandId: '../../config' }, { ...payload, privatePath: '/private/music' },
    ...[-1, 0, 1.5, 10_001, NaN].map(n => ({ ...payload, quantities: { ...payload.quantities, sealedBlank: n } })),
    { ...payload, model: { ...payload.model, edition: '' } },
    { ...payload, model: { ...payload.model, format: 'dat' } },
    { ...payload, model: { ...payload.model, brand: 'x'.repeat(121) } },
    { ...payload, lengthMinutes: 0 },
  ]) assert.equal(validateIpcRequest({ version: 1, id: 'bad-collection', command: 'collection.receive', payload: invalid }).ok, false);
  assert.equal(validateIpcRequest({ version: 1, id: 'bad-page', command: 'collection.list', payload: { page: { offset: 0, limit: 101 } } }).ok, false);
  assert.equal(validateIpcRequest({ version: 1, id: 'bad-copy', command: 'collection.materialize', payload: {
    commandId: payload.commandId, lotId: payload.commandId, bucket: 'unclassified', action: 'open',
  } }).ok, false);
});

test('V3 库存响应必须数量守恒且不暴露额外路径或无界数据', () => {
  const item = { id: '11111111-1111-4111-8111-111111111111', brand: 'TDK', name: 'SA', edition: '', year: null,
    format: 'cassette', tapeType: 'II', identification: 'unidentified', collectorPolicy: 'normal', minimumSealedReserve: 0, revision: 1,
    lengths: [90], counts: { total: 2, sealedBlank: 1, openedBlank: 0, legacyUsed: 1, recorded: 0, reserved: 0, unavailable: 0, unknown: 0 } };
  const response = (items: unknown[]) => ({ version: 1, id: 'result', ok: true, result: { items, offset: 0, limit: 20, total: items.length, hasMore: false } });
  assert.equal(validateIpcResponseForCommand(response([item]), 'collection.list').ok, true);
  assert.equal(validateIpcResponseForCommand(response([{ ...item, counts: { ...item.counts, total: 3 } }]), 'collection.list').ok, false);
  assert.equal(validateIpcResponseForCommand(response([{ ...item, filePath: '/private/inventory.sqlite' }]), 'collection.list').ok, false);
  assert.equal(validateIpcResponseForCommand(response(Array(101).fill(item)), 'collection.list').ok, false);
});

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
    source: 'netease',
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
  for (const forbidden of [
    { source: 'roon' },
    { confidence: 1 },
    { evidence: ['title-exact'] },
    { rawProviderResponse: { code: 200 } },
  ]) {
    assert.equal(
      validateIpcResponseForCommand(
        {
          version: IPC_VERSION,
          id: 'lyrics-private-match-data',
          ok: true,
          result: { ...snapshot, ...forbidden },
        },
        'lyrics.get',
      ).ok,
      false,
    );
  }
  assert.equal(
    validateIpcEvent({
      version: IPC_VERSION,
      event: 'lyrics.changed',
      payload: {
        state: {
          status: 'unavailable',
          lines: [],
          activeLineIndex: -1,
          timingSource: 'static',
          source: 'netease',
        },
      },
    }).ok,
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

test('contracts bounds local lyrics candidate sessions without exposing matching internals', () => {
  const choice = {
    status: 'needs-choice',
    matchSessionId: 'session-0123456789abcdef',
    candidates: [{
      candidateId: 'candidate-0123456789abcdef',
      title: '归零',
      artists: ['林忆莲'],
      album: '0',
      durationMs: 271_000,
    }],
    canRevoke: false,
  };

  assert.equal(validateIpcRequest({
    version: IPC_VERSION,
    id: 'lyrics-match-get',
    command: 'lyrics.match.get',
    payload: {},
  }).ok, true);
  assert.equal(validateIpcRequest({
    version: IPC_VERSION,
    id: 'lyrics-match-select',
    command: 'lyrics.match.select',
    payload: {
      matchSessionId: choice.matchSessionId,
      candidateId: choice.candidates[0]?.candidateId,
    },
  }).ok, true);
  assert.equal(validateIpcRequest({
    version: IPC_VERSION,
    id: 'lyrics-match-revoke',
    command: 'lyrics.match.revoke',
    payload: {},
  }).ok, true);

  for (const command of ['lyrics.match.get', 'lyrics.match.select', 'lyrics.match.revoke'] as const) {
    assert.equal(validateIpcResponseForCommand({
      version: IPC_VERSION,
      id: command,
      ok: true,
      result: choice,
    }, command).ok, true);
  }
  assert.equal(validateIpcEvent({
    version: IPC_VERSION,
    event: 'lyrics.match.changed',
    payload: { state: choice },
  }).ok, true);

  for (const forbidden of [
    { score: 0.9 },
    { confidence: 0.9 },
    { evidence: ['title-exact'] },
    { algorithmVersion: 'lyrics-match-v1' },
    { signature: 'private-signature' },
    { roonReference: 'private-roon-reference' },
    { searchQuery: 'private search text' },
  ]) {
    assert.equal(validateIpcResponseForCommand({
      version: IPC_VERSION,
      id: 'lyrics-match-private',
      ok: true,
      result: { ...choice, ...forbidden },
    }, 'lyrics.match.get').ok, false);
  }

  assert.equal(validateIpcResponseForCommand({
    version: IPC_VERSION,
    id: 'lyrics-match-track-id',
    ok: true,
    result: {
      ...choice,
      candidates: [{ ...choice.candidates[0], neteaseTrackId: '123' }],
    },
  }, 'lyrics.match.get').ok, false);
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

test('实体音乐合同区分原版和历史副本，拒绝路径、混合分面及伪造身份', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const release = { format: 'cd', title: '合成专辑', artist: '合成艺术家', quantity: 1, completeness: 'basic', tracks: [] };
  const valid = (command: string, payload: unknown) => validateIpcRequest({ version: 1, id: 'music-contract', command, payload }).ok;
  assert.equal(valid('physicalMusic.saveRelease', { commandId: id, release }), true);
  assert.equal(valid('physicalMusic.saveLegacy', { commandId: id, physicalId: 'MB-C-00001', expectedRevision: 1, content: { title: '旧录音', artist: '合成', tracks: [] } }), true);
  for (const bad of [{ ...release, quantity: 0 }, { ...release, path: '/private/music' }, { ...release, completeness: 'verified' }, { ...release, tracks: [{ title: '曲目', artist: '', position: 1, side: 'A' }] }]) assert.equal(valid('physicalMusic.saveRelease', { commandId: id, release: bad }), false);
  assert.equal(valid('physicalMusic.saveRelease', { commandId: id, id: 'MB-C-00001', expectedRevision: 1, release }), false);
  assert.equal(valid('physicalMusic.list', { page: { offset: 0, limit: 101 } }), false);
  assert.equal(valid('physicalMusic.photo', { photoId: '/private/photo.jpg' }), false);
  const response = { version: 1, id: 'music-contract', ok: true, result: { entry: { id: 'MB-C-00001', kind: 'cd', title: '伪造', artist: '合成', quantity: 1, revision: 1, contentStatus: 'commercial' }, release, photos: [] } };
  assert.equal(validateIpcResponseForCommand(response, 'physicalMusic.detail').ok, false);
});

test('关联合同要求明确确认，不接受路径、双重身份或不一致的 CD Rip 关系', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const request = { commandId: id, releaseId: id, expectedRevision: 1, reference: 'musicbridge-v2-entity-22222222-2222-5222-8222-222222222222', relation: 'exact', ripFromCdConfirmed: false, userConfirmed: true };
  const valid = (payload: unknown) => validateIpcRequest({ version: 1, id: 'links-contract', command: 'physicalLinks.confirm', payload }).ok;
  assert.equal(valid(request), true);
  for (const bad of [{ ...request, userConfirmed: false }, { ...request, digitalId: id }, { ...request, reference: '/private/music.wav' }, { ...request, itemKey: 'private' }, { ...request, relation: 'probable', ripFromCdConfirmed: true }]) assert.equal(valid(bad), false);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: 'runtime', ok: true, result: { status: 'unavailable', reference: request.reference } }, 'physicalLinks.runtime').ok, false);
});

test('录音草稿只接收确认后的 Roon 引用，拒绝伪造元数据与冻结状态', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const reference = 'musicbridge-v2-entity-22222222-2222-5222-8222-222222222222';
  const request = { commandId: id, title: '私人精选', programType: 'compilation', references: [reference], userConfirmed: true };
  const valid = (payload: unknown) => validateIpcRequest({ version: 1, id: 'draft-contract', command: 'recordingDrafts.append', payload }).ok;
  assert.equal(valid(request), true);
  for (const bad of [{ ...request, userConfirmed: false }, { ...request, sourceLockEligible: true }, { ...request, tracks: [{ title: '伪造' }] }, { ...request, references: [reference, reference] }, { ...request, references: ['/private/song.flac'] }, { ...request, draftId: id }]) assert.equal(valid(bad), false);
  const summary = { id, title: '私人精选', programType: 'compilation', revision: 1, status: 'draft', sourceLockEligible: false, trackCount: 1, estimatedDurationMs: 180000 };
  assert.equal(validateIpcResponseForCommand({ version: 1, id: 'draft-contract', ok: true, result: { items: [summary], offset: 0, limit: 20, total: 1, hasMore: false } }, 'recordingDrafts.list').ok, true);
  assert.equal(validateIpcResponseForCommand({ version: 1, id: 'draft-contract', ok: true, result: { ...summary, sourceLockEligible: true, tracks: [] } }, 'recordingDrafts.detail').ok, false);
});

test('源能力私有路径仅允许内部响应，公开结果拒绝路径和伪造源锁', async () => {
  const { isSourceSelection, isSourceBinding, isDraftSourceSnapshot } = await import('../src/index.js');
  const id = '11111111-1111-4111-8111-111111111111', response = { version: 1, id: 'source', ok: true, result: { absolutePath: '/synthetic/authorized' } };
  assert.equal(validateIpcResponseForCommand(response, 'recordingSources.context').ok, false);
  assert.equal(validateIpcInternalResponseForCommand(response, 'recordingSources.context').ok, true);
  const selection = { commandId: id, draftId: id, trackId: id, rootId: id, acquisition: 'userFileBind' };
  assert.equal(isSourceSelection(selection), true); assert.equal(isSourceSelection({ ...selection, absolutePath: '/untrusted/path' }), false); assert.equal(isSourceSelection({ ...selection, acquisition: 'anything' }), false);
  const binding = { id, rootId: id, fileName: 'audio.flac', acquisition: 'userFileBind', verification: 'fileHashVerified', preservation: 'externalReferenceOnly', availability: 'ONLINE', sha256: 'a'.repeat(64), size: 100, modifiedAt: '2026-08-27T00:00:00.000Z', verifiedAt: '2026-08-27T00:00:00.000Z', technical: { container: 'FLAC', codec: 'FLAC', sampleRate: 44100, channels: 2, durationMs: 1000, lossless: true }, userConfirmed: false, sourceLockEligible: false };
  assert.equal(isSourceBinding(binding), true);
  for (const bad of [{ ...binding, sourceLockEligible: true }, { ...binding, fileName: '/private/audio.flac' }, { ...binding, absolutePath: '/private/audio.flac' }, { ...binding, availability: 'MISSING', userConfirmed: true, sourceLockEligible: true }]) assert.equal(isSourceBinding(bad), false);
  assert.equal(isDraftSourceSnapshot({ draftId: id, sourceLockEligible: true, tracks: [] }), false);
});

test('分面预览合同支持逐面规划，拒绝伪造源时长与失控间隔', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const spec = { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: false, cassetteTypes: [], dat: false } };
  const valid = (payload: unknown) => validateIpcRequest({ version: 1, id: 'media-preview', command: 'recordingMedia.preview', payload }).ok;
  const payload = { draftId: id, spec, page: { offset: 0, limit: 20 } };
  assert.equal(valid(payload), true);
  assert.equal(valid({ ...payload, durations: [100] }), false);
  assert.equal(valid({ ...payload, spec: { ...spec, defaultGapMs: -1 } }), false);
  assert.equal(valid({ ...payload, spec: { ...spec, format: 'dat', splitAfter: 1 } }), false);
});

test('分面变更合同要求原命令和明确确认，公开结果拒绝路径及执行就绪伪造', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const request = { commandId: id, planId: id, expectedRevision: 1, skuId: id, packaging: 'opened', userConfirmed: true };
  const valid = (payload: unknown) => validateIpcRequest({ version: 1, id: 'reserve', command: 'recordingMedia.reserve', payload }).ok;
  assert.equal(valid(request), true);
  for (const bad of [{ ...request, userConfirmed: false }, { ...request, expectedRevision: 0 }, { ...request, commandId: 'unstable' }, { ...request, path: '/private/source.wav' }]) assert.equal(valid(bad), false);
  const spec = { format: 'cassette', splitAfter: 1, leadInMs: 0, tailMs: 0, defaultGapMs: 5000, rules: [], compatibility: { confirmed: false, cassetteTypes: [], dat: false } };
  const result = { id, draftId: id, draftRevision: 1, revision: 1, spec, layout: { timebase: 'milliseconds', executionReady: false, sides: [{ name: 'A', tracks: [{ trackId: id, startMs: 0, endMs: 1000, gapAfterMs: 0 }], musicMs: 1000, durationMs: 1000, gapMs: 0, leadInMs: 0, tailMs: 0 }, { name: 'B', tracks: [], musicMs: 0, durationMs: 0, gapMs: 0, leadInMs: 0, tailMs: 0 }], constraints: [] }, sourceBasis: 'roon-estimate', inputFingerprint: 'a'.repeat(64), requiresReview: false, executionReady: false };
  const accepted = (value: unknown) => validateIpcResponseForCommand({ version: 1, id: 'reserve', ok: true, result: value }, 'recordingMedia.save').ok;
  assert.equal(accepted(result), true);
  assert.equal(accepted({ ...result, executionReady: true }), false);
  assert.equal(accepted({ ...result, path: '/private/source.wav' }), false);
  assert.equal(accepted({ ...result, layout: { ...result.layout, timebase: 'frames' } }), false);
});
