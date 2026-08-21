import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IPC_VERSION,
  parseIpcRuntimeMessage,
  validateIpcEvent,
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
