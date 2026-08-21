export type BridgeErrorCode =
  | 'CONFIG_INVALID'
  | 'NETEASE_NOT_CONFIGURED'
  | 'NETEASE_REQUEST_FAILED'
  | 'AUTH_EXPIRED'
  | 'TRACK_UNAVAILABLE'
  | 'TRACK_PREVIEW_ONLY'
  | 'UNSAFE_UPSTREAM'
  | 'ROON_NOT_PAIRED'
  | 'ROON_ZONE_NOT_SELECTED'
  | 'ROON_MEDIA_ERROR'
  | 'ROON_TIMEOUT'
  | 'STREAM_NOT_FOUND'
  | 'STREAM_UPSTREAM_FAILED'
  | 'BAD_REQUEST'
  | 'INTERNAL_ERROR';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: BridgeErrorCode,
    message: string,
    options: {
      httpStatus?: number;
      cause?: unknown;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'BridgeError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? 500;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof Error) {
    return new BridgeError('INTERNAL_ERROR', error.message, {
      cause: error,
      httpStatus: 500,
    });
  }
  return new BridgeError('INTERNAL_ERROR', 'Unknown internal error', {
    details: { valueType: typeof error },
    httpStatus: 500,
  });
}
