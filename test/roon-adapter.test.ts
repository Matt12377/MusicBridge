import assert from 'node:assert/strict';
import test from 'node:test';
import { RoonAudioInputAdapter } from '../src/roon/adapter.js';
import type {
  RoonApiInstance,
  RoonApiOptions,
  RoonAudioInputService,
  RoonAudioInputSession,
  RoonCore,
  RoonRequiredServiceConstructor,
  RoonSdk,
  RoonSettingsOptions,
  RoonSettingsService,
  RoonStatusService,
  RoonTransportService,
  RoonZoneChangeCallback,
} from '../src/roon/sdk.js';
import { BridgeError } from '../src/shared/errors.js';
import { createLogger, type Logger } from '../src/shared/logger.js';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

class FakeAudioInput implements RoonAudioInputService {
  beginSessionCalls = 0;
  beginSessionOptions: unknown[] = [];
  beginSessionCallback:
    | ((message: unknown, body: unknown) => void)
    | undefined;
  playCalls = 0;
  playOptions: unknown[] = [];
  playCallback:
    | ((message: unknown, body: unknown) => void)
    | undefined;
  autoPlay = true;

  begin_session(
    options: unknown,
    callback: (message: unknown, body: unknown) => void,
  ): RoonAudioInputSession {
    this.beginSessionCalls += 1;
    this.beginSessionOptions.push(options);
    this.beginSessionCallback = callback;
    return {
      end_session: (callback) => callback('SessionEnded', {}),
    };
  }

  update_transport_controls(
    _options: unknown,
    callback: (message: unknown, body: unknown) => void,
  ): void {
    callback('Success', {});
  }

  play(
    options: unknown,
    callback: (message: unknown, body: unknown) => void,
  ): void {
    this.playCalls += 1;
    this.playOptions.push(options);
    this.playCallback = callback;
    if (this.autoPlay) callback('Playing', {});
  }

  emitSession(message: unknown, body: unknown = {}): void {
    this.beginSessionCallback?.(message, body);
  }

  emitPlay(message: unknown, body: unknown = {}): void {
    this.playCallback?.(message, body);
  }
}

class FakeTransport implements RoonTransportService {
  private zoneCallback: RoonZoneChangeCallback | undefined;

  subscribe_zones(callback: RoonZoneChangeCallback): void {
    this.zoneCallback = callback;
  }

  emit(response: string, message: { zones?: readonly unknown[]; zones_added?: readonly unknown[]; zones_changed?: readonly unknown[]; zones_removed?: readonly (string | { zone_id?: unknown })[] }): void {
    this.zoneCallback?.(response, message);
  }
}

class FakeCore implements RoonCore {
  readonly display_name = 'Fake Core';
  readonly audioInput = new FakeAudioInput();
  readonly transport = new FakeTransport();
  readonly services = {
    RoonApiAudioInput: this.audioInput,
    RoonApiTransport: this.transport,
  };
}

class FakeSettings implements RoonSettingsService {
  constructor(readonly options: RoonSettingsOptions) {}

  saveOutput(outputId: string): void {
    this.options.save_settings(
      { send_complete: () => undefined },
      false,
      { values: { output: { output_id: outputId } } },
    );
  }
}

class FakeStatus implements RoonStatusService {
  set_status(_message: string, _isError: boolean): void {}
}

class FakeApi implements RoonApiInstance {
  readonly core = new FakeCore();
  readonly initServiceCalls: Array<{
    provided_services: readonly unknown[];
    required_services: readonly RoonRequiredServiceConstructor[];
  }> = [];
  startDiscoveryCalls = 0;
  stopDiscoveryCalls = 0;
  disconnectAllCalls = 0;
  saveConfigCalls = 0;

  constructor(
    readonly options: RoonApiOptions,
    private readonly config: Map<string, unknown>,
  ) {}

  load_config(key: string): unknown {
    return this.config.get(key);
  }

  save_config(key: string, value: unknown): void {
    this.saveConfigCalls += 1;
    this.config.set(key, value);
  }

  init_services(options: {
    provided_services?: readonly unknown[];
    required_services?: readonly RoonRequiredServiceConstructor[];
  }): void {
    this.initServiceCalls.push({
      provided_services: options.provided_services ?? [],
      required_services: options.required_services ?? [],
    });
  }

  start_discovery(): void {
    this.startDiscoveryCalls += 1;
  }

  stop_discovery(): void {
    this.stopDiscoveryCalls += 1;
  }

  disconnect_all(): void {
    this.disconnectAllCalls += 1;
  }

  pair(): void {
    this.options.core_paired(this.core);
  }

  unpair(): void {
    this.options.core_unpaired(this.core);
  }
}

class FakeSdk implements RoonSdk {
  readonly config = new Map<string, unknown>();
  readonly apis: FakeApi[] = [];
  readonly settings: FakeSettings[] = [];
  readonly status: FakeStatus[] = [];

  readonly audioInputService = class FakeAudioInputService {};
  readonly transportService = class FakeTransportService {};

  createApi(options: RoonApiOptions): RoonApiInstance {
    const api = new FakeApi(options, this.config);
    this.apis.push(api);
    return api;
  }

  createSettings(
    _roon: RoonApiInstance,
    options: RoonSettingsOptions,
  ): RoonSettingsService {
    const service = new FakeSettings(options);
    this.settings.push(service);
    return service;
  }

  createStatus(_roon: RoonApiInstance): RoonStatusService {
    const service = new FakeStatus();
    this.status.push(service);
    return service;
  }
}

interface AdapterTestOptions {
  sessionBeginTimeoutMs?: number;
  playingTimeoutMs?: number;
}

function recordingLogger(): {
  logger: Logger;
  events: Array<{ event: string; fields: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const record = (event: string, fields?: Record<string, unknown>): void => {
    events.push({ event, fields: fields ?? {} });
  };
  return {
    events,
    logger: {
      debug: record,
      info: record,
      warn: record,
      error: record,
    },
  };
}

function makeHarness(
  options: AdapterTestOptions = {},
  logger: Logger = silentLogger,
): { adapter: RoonAudioInputAdapter; sdk: FakeSdk } {
  const sdk = new FakeSdk();
  return {
    adapter: new RoonAudioInputAdapter(logger, sdk, options),
    sdk,
  };
}

const playRequest = {
  mediaUrl: 'http://test.invalid/stream/fake',
  iconUrl: 'http://test.invalid/icon',
  metadata: {
    id: 'track-1',
    title: 'Fake Track',
    artists: ['Fake Artist'],
    album: 'Fake Album',
  },
};

async function makeReadyHarness(
  options: AdapterTestOptions = {},
  logger: Logger = silentLogger,
): Promise<{
  adapter: RoonAudioInputAdapter;
  sdk: FakeSdk;
  api: FakeApi;
}> {
  const harness = makeHarness(options, logger);
  await harness.adapter.start();
  harness.sdk.settings[0]?.saveOutput('output-1');
  const api = harness.sdk.apis[0];
  assert.ok(api);
  api.pair();
  api.core.transport.emit('Subscribed', {
    zones: [
      {
        zone_id: 'zone-1',
        display_name: 'Fake Zone',
        outputs: [{ output_id: 'output-1' }],
      },
    ],
  });
  return { ...harness, api };
}

test('start begins Roon discovery and reports discovering', async () => {
  const { adapter, sdk } = makeHarness();

  await adapter.start();

  assert.equal(sdk.apis[0]?.startDiscoveryCalls, 1);
  assert.deepEqual(adapter.getState(), { status: 'discovering' });
});

test('paired Core without a selected Zone reports paired', async () => {
  const { adapter, sdk } = makeHarness();
  await adapter.start();

  sdk.apis[0]?.pair();

  assert.deepEqual(adapter.getState(), {
    status: 'paired',
    coreName: 'Fake Core',
  });
});

test('saved output and subscribed zones produce a ready selected Zone', async () => {
  const { adapter, sdk } = makeHarness();
  await adapter.start();

  sdk.settings[0]?.saveOutput('output-1');
  const api = sdk.apis[0];
  api?.pair();
  api?.core.transport.emit('Subscribed', {
    zones: [
      {
        zone_id: 'zone-1',
        display_name: 'Fake Zone',
        outputs: [{ output_id: 'output-1' }],
      },
    ],
  });

  assert.deepEqual(adapter.getState(), {
    status: 'ready',
    coreName: 'Fake Core',
    selectedZoneId: 'zone-1',
    selectedZoneName: 'Fake Zone',
  });
});

test('saving Settings output persists it through the Roon config API', async () => {
  const { adapter, sdk } = makeHarness();
  await adapter.start();

  sdk.settings[0]?.saveOutput('output-1');

  assert.equal(sdk.apis[0]?.saveConfigCalls, 1);
  assert.deepEqual(sdk.config.get('settings'), {
    output: { output_id: 'output-1' },
  });
});

test('a rebuilt adapter restores the saved Zone from the same Fake config', async () => {
  const { adapter, sdk } = makeHarness();
  await adapter.start();
  sdk.settings[0]?.saveOutput('output-1');
  sdk.apis[0]?.pair();
  sdk.apis[0]?.core.transport.emit('Subscribed', {
    zones: [
      {
        zone_id: 'zone-1',
        display_name: 'Fake Zone',
        outputs: [{ output_id: 'output-1' }],
      },
    ],
  });
  await adapter.shutdown();

  const rebuilt = new RoonAudioInputAdapter(silentLogger, sdk);
  await rebuilt.start();
  sdk.apis[1]?.pair();
  sdk.apis[1]?.core.transport.emit('Subscribed', {
    zones: [
      {
        zone_id: 'zone-1',
        display_name: 'Fake Zone',
        outputs: [{ output_id: 'output-1' }],
      },
    ],
  });

  assert.equal(rebuilt.getState().status, 'ready');
  assert.equal(rebuilt.getState().selectedZoneId, 'zone-1');
  assert.equal(rebuilt.getState().selectedZoneName, 'Fake Zone');
});

test('a changed Zone updates the selected Zone name', async () => {
  const { adapter, api } = await makeReadyHarness();

  api.core.transport.emit('Changed', {
    zones_changed: [
      {
        zone_id: 'zone-1',
        display_name: 'Renamed Zone',
        outputs: [{ output_id: 'output-1' }],
      },
    ],
  });

  assert.equal(adapter.getState().selectedZoneName, 'Renamed Zone');
});

test('removing the selected Zone returns to paired without a Zone', async () => {
  const { adapter, api } = await makeReadyHarness();

  api.core.transport.emit('Changed', { zones_removed: ['zone-1'] });

  assert.deepEqual(adapter.getState(), {
    status: 'paired',
    coreName: 'Fake Core',
  });
});

test('unpairing clears the Core and selected Zone state', async () => {
  const { adapter, api } = await makeReadyHarness();

  api.unpair();

  assert.deepEqual(adapter.getState(), { status: 'discovering' });
});

test('unpaired play fails with ROON_NOT_PAIRED', async () => {
  const { adapter } = makeHarness();
  await adapter.start();

  await assert.rejects(
    () => adapter.play(playRequest),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'ROON_NOT_PAIRED',
  );
});

test('paired play without a selected Zone fails with ROON_ZONE_NOT_SELECTED', async () => {
  const { adapter, sdk } = makeHarness();
  await adapter.start();
  sdk.apis[0]?.pair();

  await assert.rejects(
    () => adapter.play(playRequest),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'ROON_ZONE_NOT_SELECTED',
  );
});

test('play reports awaiting_session when SessionBegan is not received', async () => {
  const { adapter } = await makeReadyHarness({ sessionBeginTimeoutMs: 1 });

  await assert.rejects(
    () => adapter.play(playRequest),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === 'ROON_TIMEOUT' &&
      error.message === 'ROON_SESSION_BEGIN_TIMEOUT' &&
      error.details?.phase === 'awaiting_session',
  );
});

test('valid SessionBegan is required before audioInput.play and begin_session omits icon_url', async () => {
  const { logger, events } = recordingLogger();
  const { adapter, api } = await makeReadyHarness({}, logger);
  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const audioInput = api.core.audioInput;
  const beginOptions = audioInput.beginSessionOptions[0] as Record<string, unknown>;
  assert.deepEqual(beginOptions, {
    zone_id: 'zone-1',
    display_name: 'Music Bridge for Roon',
  });
  assert.equal('icon_url' in beginOptions, false);
  assert.equal(audioInput.playCalls, 0);

  audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  await playback;

  assert.equal(audioInput.playCalls, 1);
  assert.equal(
    (audioInput.playOptions[0] as Record<string, unknown>).session_id,
    'opaque-session',
  );
  assert.deepEqual(
    events.filter(({ event }) => event === 'roon_play_event')[0]?.fields,
    { phase: 'awaiting_playing', eventName: 'Playing' },
  );
  assert.equal(JSON.stringify(events).includes('opaque-session'), false);
});

test('play reports awaiting_playing after SessionBegan but before Playing', async () => {
  const { adapter, api } = await makeReadyHarness({ playingTimeoutMs: 1 });
  api.core.audioInput.autoPlay = false;
  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));

  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });

  await assert.rejects(
    () => playback,
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === 'ROON_TIMEOUT' &&
      error.message === 'ROON_PLAYING_TIMEOUT' &&
      error.details?.phase === 'awaiting_playing',
  );
  assert.equal(api.core.audioInput.playCalls, 1);
});

test('SessionBegan without a valid session_id fails before audioInput.play', async () => {
  const { adapter, api } = await makeReadyHarness({ playingTimeoutMs: 20 });
  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));

  api.core.audioInput.emitSession('SessionBegan', { session_id: '' });

  await assert.rejects(
    () => playback,
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === 'ROON_MEDIA_ERROR' &&
      error.details?.reason === 'missing_session_id',
  );
  assert.equal(api.core.audioInput.playCalls, 0);
});

test('unknown Session event fails immediately and logs only its event name', async () => {
  const { logger, events } = recordingLogger();
  const { adapter, api } = await makeReadyHarness({}, logger);
  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));

  api.core.audioInput.emitSession('UnexpectedSessionEvent', {
    session_id: 'opaque-session',
    body: 'must-not-log',
  });

  await assert.rejects(
    () => playback,
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === 'ROON_MEDIA_ERROR' &&
      error.details?.reason === 'unexpected_session_event' &&
      error.details?.event === 'UnexpectedSessionEvent',
  );
  assert.equal(JSON.stringify(events).includes('opaque-session'), false);
  assert.equal(JSON.stringify(events).includes('must-not-log'), false);
  assert.equal(api.core.audioInput.playCalls, 0);
});

test('play events log the event name without callback body content', async () => {
  const { logger, events } = recordingLogger();
  const { adapter, api } = await makeReadyHarness({ playingTimeoutMs: 20 }, logger);
  api.core.audioInput.autoPlay = false;
  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  api.core.audioInput.emitPlay('UnexpectedPlayEvent', { token: 'must-not-log' });

  await assert.rejects(() => playback);
  const playEvent = events.find(({ event }) => event === 'roon_play_event');
  assert.deepEqual(playEvent?.fields, {
    phase: 'awaiting_playing',
    eventName: 'UnexpectedPlayEvent',
  });
  assert.equal(JSON.stringify(events).includes('must-not-log'), false);
});

for (const event of ['ZoneNotFound', 'ZoneLost']) {
  test(`Session ${event} remains mapped to ROON_ZONE_NOT_SELECTED`, async () => {
    const { adapter, api } = await makeReadyHarness();
    const playback = adapter.play(playRequest);
    await new Promise<void>((resolve) => setImmediate(resolve));
    api.core.audioInput.emitSession(event);

    await assert.rejects(
      () => playback,
      (error: unknown) =>
        error instanceof BridgeError && error.code === 'ROON_ZONE_NOT_SELECTED',
    );
    assert.equal(adapter.getState().status, 'paired');
  });
}

test('MooError produces a connection diagnostic without exposing callback data', async () => {
  const { logger, events } = recordingLogger();
  const { adapter, api } = await makeReadyHarness({}, logger);
  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSession('MooError', {
    session_id: 'opaque-session',
    details: 'must-not-log',
  });

  await assert.rejects(
    () => playback,
    (error: unknown) =>
      error instanceof BridgeError &&
      error.details?.reason === 'connection_error' &&
      error.details?.phase === 'awaiting_session',
  );
  assert.deepEqual(
    events.find(({ event }) => event === 'roon_connection_error')?.fields,
    {
      phase: 'awaiting_session',
      eventName: 'MooError',
    },
  );
  assert.equal(JSON.stringify(events).includes('opaque-session'), false);
  assert.equal(JSON.stringify(events).includes('must-not-log'), false);
});

test('diagnostic callback event names do not overwrite the logger envelope', (t) => {
  let line = '';
  t.mock.method(console, 'log', (value: string) => {
    line = value;
  });

  createLogger('info').info('roon_session_event', {
    phase: 'awaiting_session',
    eventName: 'InvalidRequest',
    hasSessionId: false,
  });

  const record = JSON.parse(line) as Record<string, unknown>;
  assert.equal(record.event, 'roon_session_event');
  assert.equal(record.eventName, 'InvalidRequest');
  assert.equal(record.hasSessionId, false);
});

test('play validation failures never begin an Audio Input session', async () => {
  const unpaired = makeHarness();
  await unpaired.adapter.start();
  await assert.rejects(() => unpaired.adapter.play(playRequest));
  assert.equal(unpaired.sdk.apis[0]?.core.audioInput.beginSessionCalls, 0);

  const noZone = makeHarness();
  await noZone.adapter.start();
  noZone.sdk.apis[0]?.pair();
  await assert.rejects(() => noZone.adapter.play(playRequest));
  assert.equal(noZone.sdk.apis[0]?.core.audioInput.beginSessionCalls, 0);
});

test('shutdown stops discovery, disconnects all and clears adapter state', async () => {
  const { adapter, sdk } = await makeReadyHarness();
  const api = sdk.apis[0];
  assert.ok(api);

  await adapter.shutdown();

  assert.equal(api.stopDiscoveryCalls, 1);
  assert.equal(api.disconnectAllCalls, 1);
  assert.deepEqual(adapter.getState(), { status: 'discovering' });
});
