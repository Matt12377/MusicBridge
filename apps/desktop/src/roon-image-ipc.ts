import type {
  PublicErrorCode,
  RoonImageResult,
} from '@music-bridge/contracts'

export interface SafeRoonImageIpcError {
  code: PublicErrorCode
  message: string
}

export type RoonImageIpcEnvelope =
  | { ok: true; value: RoonImageResult }
  | { ok: false; error: SafeRoonImageIpcError }

class RoonImageIpcError extends Error {
  readonly code: PublicErrorCode

  constructor(error: SafeRoonImageIpcError) {
    super(`[${error.code}] ${error.message}`)
    this.name = 'RoonImageIpcError'
    this.code = error.code
  }
}

export async function settleRoonImageIpc(
  operation: () => Promise<RoonImageResult>,
  publicError: (error: unknown) => SafeRoonImageIpcError,
): Promise<RoonImageIpcEnvelope> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error: publicError(error) }
  }
}

export function unwrapRoonImageIpc(envelope: RoonImageIpcEnvelope): RoonImageResult {
  if (envelope.ok) return envelope.value
  throw new RoonImageIpcError(envelope.error)
}
