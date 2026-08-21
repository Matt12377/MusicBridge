export type PublicErrorCode =
  | 'INVALID_IPC_REQUEST'
  | 'UNSUPPORTED_IPC_VERSION'
  | 'UNKNOWN_IPC_COMMAND'
  | 'INVALID_IPC_RESPONSE'
  | 'TIMEOUT'
  | 'NOT_READY'
  | 'INTERNAL_ERROR';

export interface PublicError {
  code: PublicErrorCode;
  message: string;
  diagnosticId?: string;
}
