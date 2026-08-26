export type BridgeErrorCode =
  | 'CONFIG_INVALID'
  | 'NETEASE_NOT_CONFIGURED'
  | 'NETEASE_REQUEST_FAILED'
  | 'AUTH_EXPIRED'
  | 'ACCOUNT_PROFILE_UNAVAILABLE'
  | 'DAILY_RECOMMENDATIONS_UNAVAILABLE'
  | 'TRACK_UNAVAILABLE'
  | 'TRACK_PREVIEW_ONLY'
  | 'UNSAFE_UPSTREAM'
  | 'ROON_NOT_PAIRED'
  | 'ROON_ZONE_NOT_SELECTED'
  | 'ROON_MEDIA_ERROR'
  | 'ROON_TIMEOUT'
  | 'ROON_TRANSPORT_UNAVAILABLE'
  | 'ROON_LIBRARY_UNAVAILABLE'
  | 'ROON_LIBRARY_REQUEST_FAILED'
  | 'ROON_LIBRARY_INVALID_REFERENCE'
  | 'ROON_ACTION_BLOCKED'
  | 'ROON_IMAGE_DECODE_FAILED'
  | 'ROON_ALBUM_HIERARCHY_INVALID'
  | 'ROON_TRACK_ACTION_UNAVAILABLE'
  | 'STREAM_NOT_FOUND'
  | 'STREAM_URL_EXPIRED'
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
