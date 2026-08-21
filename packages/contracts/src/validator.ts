import type { PublicError } from './errors.js';
import {
  IPC_COMMANDS,
  IPC_VERSION,
  type IpcRequest,
} from './ipc.js';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PublicError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(): ValidationResult<never> {
  return {
    ok: false,
    error: {
      code: 'INVALID_IPC_REQUEST',
      message: 'Invalid IPC request',
    },
  };
}

export function validateIpcRequest(
  input: unknown,
): ValidationResult<IpcRequest<unknown>> {
  if (!isRecord(input)) return invalidRequest();

  if (input.version !== IPC_VERSION) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_IPC_VERSION',
        message: 'Unsupported IPC version',
      },
    };
  }

  if (
    typeof input.id !== 'string' ||
    input.id.trim().length === 0 ||
    input.id.length > 128 ||
    typeof input.command !== 'string' ||
    !IPC_COMMANDS.includes(input.command as (typeof IPC_COMMANDS)[number]) ||
    !isRecord(input.payload)
  ) {
    if (
      typeof input.command === 'string' &&
      input.command.length > 0 &&
      !IPC_COMMANDS.includes(input.command as (typeof IPC_COMMANDS)[number])
    ) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_IPC_COMMAND',
          message: 'Unknown IPC command',
        },
      };
    }
    return invalidRequest();
  }

  return {
    ok: true,
    value: {
      version: IPC_VERSION,
      id: input.id,
      command: input.command as (typeof IPC_COMMANDS)[number],
      payload: input.payload,
    },
  };
}
