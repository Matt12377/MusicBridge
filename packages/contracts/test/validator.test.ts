import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IPC_VERSION,
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
