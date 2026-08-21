import { BridgeController } from './application/bridge-controller.js';
import { loadConfig } from './config/config.js';
import { ControlServer } from './control/server.js';
import { NeteaseClient } from './netease/client.js';
import { RoonAudioInputAdapter } from './roon/adapter.js';
import { asBridgeError } from './shared/errors.js';
import { createLogger } from './shared/logger.js';
import { StreamGateway } from './stream/gateway.js';
import { StreamRegistry } from './stream/registry.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const registry = new StreamRegistry();
  const netease = new NeteaseClient(config.neteaseCookie);
  const roon = new RoonAudioInputAdapter(logger);
  const gateway = new StreamGateway({
    host: config.streamHost,
    port: config.streamPort,
    publicBaseUrl: config.publicStreamBaseUrl,
    registry,
    logger,
  });
  const controller = new BridgeController({
    netease,
    roon,
    registry,
    gateway,
    logger,
  });
  const control = new ControlServer({
    host: config.controlHost,
    port: config.controlPort,
    defaultQuality: config.defaultQuality,
    controller,
    logger,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('bridge_shutdown_started', { signal });
    try {
      await control.stop();
      await controller.shutdown();
      await roon.shutdown();
      registry.revokeAll();
      await gateway.stop();
      logger.info('bridge_shutdown_complete');
    } catch (error) {
      const bridgeError = asBridgeError(error);
      logger.error('bridge_shutdown_failed', {
        code: bridgeError.code,
        message: bridgeError.message,
      });
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await gateway.start();
  await roon.start();
  await control.start();

  logger.info('bridge_started', {
    controlAddress: `${config.controlHost}:${config.controlPort}`,
    streamAddress: `${config.streamHost}:${config.streamPort}`,
    neteaseConfigured: netease.configured,
    defaultQuality: config.defaultQuality,
  });
}

main().catch((error: unknown) => {
  const bridgeError = asBridgeError(error);
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'bridge_start_failed',
      code: bridgeError.code,
      message: bridgeError.message,
    }),
  );
  process.exitCode = 1;
});
