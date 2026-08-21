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
