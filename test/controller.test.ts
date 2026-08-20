import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeController } from '../src/application/bridge-controller.js';
import type {
  NeteasePort,
  QualityLevel,
  ResolvedAudioStream,
} from '../src/netease/types.js';
import type { RoonPlayRequest, RoonPort, RoonState } from '../src/roon/types.js';
import { createLogger } from '../src/shared/logger.js';
import { StreamGateway } from '../src/stream/gateway.js';
import { StreamRegistry } from '../src/stream/registry.js';

class FakeNetease implements NeteasePort {
  readonly configured = true;
  resolveCalls = 0;

  async getTrack(trackId: string) {
    return {
      id: trackId,
      title: 'Test Song',
      artists: ['Artist'],
      album: 'Album',
      durationMs: 120000,
    };
  }

  async resolveStream(
    trackId: string,
    quality: QualityLevel,
  ): Promise<ResolvedAudioStream> {
    this.resolveCalls += 1;
    return {
      trackId,
      upstreamUrl: 'https://cdn.example/audio.flac',
      requestedQuality: quality,
      actualQuality: 'lossless',
      format: 'flac',
      expiresInSeconds: 600,
    };
  }
}

class FakeRoon implements RoonPort {
  playRequest: RoonPlayRequest | undefined;
  stopCalls = 0;
  shouldFail = false;
  shouldFailOnStop = false;
  terminalDuringPlay = false;
  terminalHandler: (reason: 'ended' | 'stopped' | 'media_error' | 'zone_lost') => void = () => undefined;
  state: RoonState = {
    status: 'ready',
    selectedZoneId: 'zone-1',
    selectedZoneName: 'Living Room',
  };

  setTerminalHandler(handler: (reason: 'ended' | 'stopped' | 'media_error' | 'zone_lost') => void): void {
    this.terminalHandler = handler;
  }

  emitTerminal(reason: 'ended' | 'stopped' | 'media_error' | 'zone_lost'): void {
    this.terminalHandler(reason);
  }

  async start(): Promise<void> {}

  async play(request: RoonPlayRequest): Promise<void> {
    this.playRequest = request;
    if (this.shouldFail) throw new Error('Roon failed');
    this.state = { ...this.state, status: 'playing' };
    if (this.terminalDuringPlay) this.terminalHandler('media_error');
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.shouldFailOnStop) throw new Error('Roon stop failed');
    this.state = { ...this.state, status: 'ready' };
  }

  async shutdown(): Promise<void> {}

  getState(): RoonState {
    return { ...this.state };
  }
}

function makeHarness() {
  const registry = new StreamRegistry();
  const gateway = new StreamGateway({
    host: '127.0.0.1',
    port: 0,
    publicBaseUrl: 'http://127.0.0.1:38502',
    registry,
    logger: createLogger('error'),
  });
  const netease = new FakeNetease();
  const roon = new FakeRoon();
  const controller = new BridgeController({
    netease,
    roon,
    registry,
    gateway,
    logger: createLogger('error'),
    now: () => 1_700_000_000_000,
  });
  return { registry, gateway, netease, roon, controller };
}

test('controller registers a local stream, starts Roon and reports actual quality', async () => {
  const { controller, registry, roon } = makeHarness();
  const state = await controller.play({ trackId: '123', quality: 'lossless' });

  assert.equal(registry.size, 1);
  assert.ok(roon.playRequest?.mediaUrl.startsWith('http://127.0.0.1:38502/stream/'));
  assert.equal(roon.playRequest?.metadata.title, 'Test Song');
  assert.equal(state.activePlayback?.requestedQuality, 'lossless');
  assert.equal(state.activePlayback?.actualQuality, 'lossless');

  await controller.stop();
  assert.equal(registry.size, 0);
  assert.equal(controller.getState().activePlayback, undefined);
});

test('controller stop is idempotent after playback has already been cleared', async () => {
  const { controller, registry, roon } = makeHarness();
  await controller.play({ trackId: '123', quality: 'standard' });

  await controller.stop();
  roon.shouldFailOnStop = true;

  const state = await controller.stop();

  assert.equal(roon.stopCalls, 1);
  assert.equal(registry.size, 0);
  assert.equal(state.activeStreamCount, 0);
  assert.equal(state.activePlayback, undefined);
});

test('controller revokes stream token when Roon start fails', async () => {
  const { controller, registry, roon } = makeHarness();
  roon.shouldFail = true;
  await assert.rejects(() =>
    controller.play({ trackId: '123', quality: 'lossless' }),
  );
  assert.equal(registry.size, 0);
});


test('controller revokes stream token when Roon reports a terminal event', async () => {
  const { controller, registry, roon } = makeHarness();
  await controller.play({ trackId: '123', quality: 'lossless' });
  assert.equal(registry.size, 1);
  roon.emitTerminal('ended');
  assert.equal(registry.size, 0);
  assert.equal(controller.getState().activePlayback, undefined);
});


test('controller does not resurrect playback state if Roon terminates during startup', async () => {
  const { controller, registry, roon } = makeHarness();
  roon.terminalDuringPlay = true;
  await assert.rejects(() =>
    controller.play({ trackId: '123', quality: 'lossless' }),
  );
  assert.equal(registry.size, 0);
  assert.equal(controller.getState().activePlayback, undefined);
});
