import { createBridgeRuntime } from './runtime.js'
import { asBridgeError } from './shared/errors.js'

async function main(): Promise<void> {
  const runtime = createBridgeRuntime()
  let shuttingDown = false

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await runtime.shutdown()
    } catch (error) {
      process.exitCode = 1
      const bridgeError = asBridgeError(error)
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          event: 'bridge_shutdown_failed',
          code: bridgeError.code,
          message: bridgeError.message,
        }),
      )
    }
  }

  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())

  await runtime.start()
}

main().catch((error: unknown) => {
  const bridgeError = asBridgeError(error)
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'bridge_start_failed',
      code: bridgeError.code,
      message: bridgeError.message,
    }),
  )
  process.exitCode = 1
})
