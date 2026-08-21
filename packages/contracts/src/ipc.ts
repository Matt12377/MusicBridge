import type { PublicError } from './errors.js';

export const IPC_VERSION = 1 as const;

export const IPC_COMMANDS = [
  'core.ping',
  'core.getHealth',
  'core.getState',
  'roon.listZones',
  'roon.selectZone',
] as const;

export type IpcCommand = (typeof IPC_COMMANDS)[number];

export const IPC_EVENTS = [
  'core.ready',
  'core.health',
  'roon.changed',
  'diagnostic.notice',
] as const;

export type IpcEvent = (typeof IPC_EVENTS)[number];

export interface IpcRequest<TPayload = unknown> {
  version: typeof IPC_VERSION;
  id: string;
  command: IpcCommand;
  payload: TPayload;
}

export interface IpcSuccess<TResult = unknown> {
  version: typeof IPC_VERSION;
  id: string;
  ok: true;
  result: TResult;
}

export interface IpcFailure {
  version: typeof IPC_VERSION;
  id: string;
  ok: false;
  error: PublicError;
}

export type IpcResponse<TResult = unknown> =
  | IpcSuccess<TResult>
  | IpcFailure;

export type IpcEnvelope<T = unknown> = IpcRequest<T> | IpcResponse<T>;
