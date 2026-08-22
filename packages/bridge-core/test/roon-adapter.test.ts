import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RoonAudioInputAdapter,
  summarizeRoonTimePayload,
  summarizeRoonResponseBody,
} from '../src/roon/adapter.js';
import type {
  RoonApiInstance,
  RoonApiOptions,
  RoonAudioInputService,
  RoonAudioInputPlayOptions,
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
  beginSessionCallbacks: Array<
    ((message: unknown, body: unknown) => void) | undefined
  > = [];
  beginSessionCallback:
    | ((message: unknown, body: unknown) => void)
    | undefined;
  endSessionCallbacks: Array<
    ((message: unknown, body: unknown) => void) | undefined
  > = [];
  playCalls = 0;
  playOptions: RoonAudioInputPlayOptions[] = [];
  playCallbacks: Array<
    ((message: unknown, body: unknown) => void) | undefined
  > = [];
  playCallback:
    | ((message: unknown, body: unknown) => void)
    | undefined;
  autoPlay = true;
  autoEndSession = true;
  beforeEndSession: (() => void) | undefined;

  begin_session(
    options: unknown,
    callback: (message: unknown, body: unknown) => void,
  ): RoonAudioInputSession {
    const sessionIndex = this.beginSessionCalls;
    this.beginSessionCalls += 1;
    this.beginSessionOptions.push(options);
    this.beginSessionCallbacks.push(callback);
    this.beginSessionCallback = callback;
    return {
      end_session: (callback) => {
        this.beforeEndSession?.();
        this.endSessionCallbacks[sessionIndex] = callback;
        if (this.autoEndSession) callback('SessionEnded', {});
      },
    };
  }

  update_transport_controls(
    _options: unknown,
    callback: (message: unknown, body: unknown) => void,
  ): void {
    callback('Success', {});
  }

  play(
    options: RoonAudioInputPlayOptions,
    callback: (message: unknown, body: unknown) => void,
  ): void {
    this.playCalls += 1;
    this.playOptions.push(options);
    this.playCallbacks.push(callback);
    this.playCallback = callback;
    if (this.autoPlay) callback('Playing', {});
  }

  emitSession(message: unknown, body: unknown = {}): void {
    this.beginSessionCallback?.(message, body);
  }

  emitSessionAt(index: number, message: unknown, body: unknown = {}): void {
    this.beginSessionCallbacks[index]?.(message, body);
  }

  emitPlay(message: unknown, body: unknown = {}): void {
    this.playCallback?.(message, body);
  }

  emitPlayAt(index: number, message: unknown, body: unknown = {}): void {
    this.playCallbacks[index]?.(message, body);
  }

  endSessionAt(index: number): void {
    this.endSessionCallbacks[index]?.('SessionEnded', {});
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

  saveZone(outputId: string, name: string): void {
    this.options.save_settings(
      { send_complete: () => undefined },
      false,
      { values: { zone: { output_id: outputId, name } } },
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
  trackIdFactory?: () => string;
  playbackMode?: 'channel' | 'track';
  onTimeShape?: (summary: import('../src/roon/adapter.js').RoonTimeShapeSummary) => void;
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
  iconUrl: 'http://127.0.0.1:38502/assets/icon.png',
  metadata: {
    id: 'track-1',
    title: 'Fake Track',
    artists: ['Fake Artist'],
    album: 'Fake Album',
  },
};

test('Roon extension metadata identifies the beta candidate without the POC suffix', async () => {
  const { adapter, sdk } = makeHarness();

  await adapter.start();
  assert.deepEqual(
    {
      extensionId: sdk.apis[0]?.options.extension_id,
      displayName: sdk.apis[0]?.options.display_name,
      displayVersion: sdk.apis[0]?.options.display_version,
    },
    {
      extensionId: 'com.musicbridgeforroon.netease.poc',
      displayName: 'Music Bridge for Roon',
      displayVersion: '0.1.0-beta.2',
    },
  );
  await adapter.stop();
});

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

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function startSecondPlayback(
  adapter: RoonAudioInputAdapter,
  api: FakeApi,
): Promise<{ playback: Promise<void> }> {
  api.core.audioInput.autoEndSession = false;
  const secondPlayback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.endSessionAt(0);
  await nextTurn();
  assert.equal(api.core.audioInput.beginSessionCalls, 2);
  return { playback: secondPlayback };
}

async function completeSecondPlayback(
  api: FakeApi,
  secondPlayback: Promise<void>,
): Promise<void> {
  api.core.audioInput.emitSessionAt(1, 'SessionBegan', {
    session_id: 'opaque-session-2',
  });
  api.core.audioInput.emitPlayAt(1, 'Playing');
  await secondPlayback;
}

test('start begins Roon discovery and reports discovering', async () => {
  const { adapter, sdk } = makeHarness();

  await adapter.start();

  assert.equal(sdk.apis[0]?.startDiscoveryCalls, 1);
  assert.deepEqual(adapter.getState(), { status: 'discovering' });
});

test('Roon Time sampler keeps only bounded shape and validation metadata', () => {
  const summary = summarizeRoonTimePayload({
    time: 12.5,
    data: { position_ms: 1_250, userContent: 'must-not-escape' },
    opaqueToken: 'must-not-escape',
  });

  assert.deepEqual(summary, {
    bodyPresent: true,
    bodyType: 'object',
    topLevelKeys: ['data', 'opaqueToken', 'time'],
    nestedKeys: ['data.position_ms', 'data.userContent'],
    candidates: [
      { path: 'data.position_ms', type: 'number', finite: true, safeInteger: true, nonNegative: true, durationBounded: true },
      { path: 'data.userContent', type: 'string' },
      { path: 'opaqueToken', type: 'string' },
      { path: 'time', type: 'number', finite: true, safeInteger: false, nonNegative: true, durationBounded: true },
    ],
  });
  assert.equal(JSON.stringify(summary).includes('12.5'), false);
  assert.equal(JSON.stringify(summary).includes('must-not-escape'), false);
});

test('unverified Roon Time callback fields are ignored until a real shape is verified', async () => {
  const summaries: unknown[] = [];
  const { adapter, api } = await makeReadyHarness({
    onTimeShape: (summary) => summaries.push(summary),
  });
  const positions: number[] = [];
  adapter.setTimeHandler((positionMs) => positions.push(positionMs));
  api.core.audioInput.autoPlay = false;
  const playback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  api.core.audioInput.emitPlay('Time', { time: 12.5 });
  api.core.audioInput.emitPlay('Time', { position_ms: -1 });
  api.core.audioInput.emitPlay('Time', { position_ms: 1_250 });
  api.core.audioInput.emitPlay('Playing');
  await playback;
  api.core.audioInput.emitPlay('Time', { data: { timeMs: 1_250 } });
  assert.deepEqual(positions, []);
  assert.equal(summaries.length, 4);
  assert.doesNotMatch(JSON.stringify(summaries), /1250/);
});

test('verified Roon Time seek_position_ms is consumed as milliseconds', async () => {
  const { adapter, api } = await makeReadyHarness();
  const positions: number[] = [];
  adapter.setTimeHandler((positionMs) => positions.push(positionMs));
  api.core.audioInput.autoPlay = false;
  const playback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  api.core.audioInput.emitPlay('Playing');
  await playback;
  api.core.audioInput.emitPlay('Time', { seek_position_ms: 1_250 });
  assert.deepEqual(positions, [1_250]);
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

test('Roon zone picker round-trips the zone setting and keeps the selected value', async () => {
  const { adapter, sdk } = makeHarness();
  await adapter.start();

  sdk.settings[0]?.saveZone('output-1', 'Display');

  assert.deepEqual(sdk.config.get('settings'), {
    output: { output_id: 'output-1', display_name: 'Display' },
  });

  let layout: unknown;
  sdk.settings[0]?.options.get_settings((value) => {
    layout = value;
  });
  assert.deepEqual(layout, {
    values: { zone: { output_id: 'output-1', name: 'Display' } },
    layout: [{ type: 'zone', title: 'Roon Zone', setting: 'zone' }],
    has_error: false,
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

test('valid SessionBegan is required before audioInput.play and begin_session uses the official fields', async () => {
  const { logger, events } = recordingLogger();
  const { adapter, api } = await makeReadyHarness({}, logger);
  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const audioInput = api.core.audioInput;
  const beginOptions = audioInput.beginSessionOptions[0] as Record<string, unknown>;
  assert.deepEqual(beginOptions, {
    zone_id: 'zone-1',
    display_name: 'Music Bridge for Roon',
    icon_url: 'http://127.0.0.1:38502/assets/icon.png',
  });
  assert.deepEqual(Object.keys(beginOptions).sort(), ['display_name', 'icon_url', 'zone_id']);
  assert.equal(typeof beginOptions.zone_id, 'string');
  assert.notEqual(beginOptions.zone_id, '');
  assert.equal(typeof beginOptions.display_name, 'string');
  assert.notEqual(beginOptions.display_name, '');
  assert.equal(typeof beginOptions.icon_url, 'string');
  assert.notEqual(beginOptions.icon_url, '');
  assert.equal(String(beginOptions.icon_url).endsWith('/assets/icon.png'), true);
  assert.equal(String(beginOptions.icon_url).includes('.svg'), false);
  assert.equal(audioInput.playCalls, 0);

  audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  await playback;

  assert.equal(audioInput.playCalls, 1);
  assert.equal(
    audioInput.playOptions[0]?.session_id,
    'opaque-session',
  );
  const playingEvent = events.find(({ event }) => event === 'roon_play_event');
  assert.equal(playingEvent?.fields.phase, 'awaiting_playing');
  assert.equal(playingEvent?.fields.eventName, 'Playing');
  assert.equal(playingEvent?.fields.bodyPresent, true);
  assert.deepEqual(playingEvent?.fields.bodyKeys, []);
  assert.equal(playingEvent?.fields.sanitizedErrorClass, 'none');
  assert.equal(playingEvent?.fields.trackIdPresent, true);
  assert.equal(playingEvent?.fields.gatewayStage, 'none');
  assert.equal(typeof playingEvent?.fields.elapsedMs, 'number');
  assert.equal(JSON.stringify(events).includes('opaque-session'), false);
});

test('channel play payload has one stable non-sensitive track identity', async () => {
  const { adapter, api } = await makeReadyHarness({
    trackIdFactory: () => 'musicbridge-test-track-identity',
    playbackMode: 'channel',
  });
  api.core.audioInput.autoPlay = false;
  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  api.core.audioInput.emitPlay('Time', { session_id: 'opaque-session' });
  api.core.audioInput.emitPlay('Playing', { session_id: 'opaque-session' });
  await playback;

  const payload = api.core.audioInput.playOptions[0];
  assert.ok(payload);
  assert.equal(payload.track_id, 'musicbridge-test-track-identity');
  assert.notEqual(payload.track_id, playRequest.metadata.id);
  assert.equal(payload.track_id.includes('fake'), false);
  assert.notEqual(payload.track_id, new URL(playRequest.mediaUrl).pathname.split('/').at(-1));
  assert.equal(payload.type, 'channel');
  assert.equal(payload.seek_position_ms, undefined);
  assert.equal(payload.info.length, undefined);
  assert.equal(api.core.audioInput.playOptions[0]?.track_id, payload.track_id);
});

test('track play payload uses an explicit start position and metadata duration', async () => {
  const { adapter, api } = await makeReadyHarness({ playbackMode: 'track' });
  const playback = adapter.play({
    ...playRequest,
    metadata: { ...playRequest.metadata, durationMs: 120_000 },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  await playback;

  const payload = api.core.audioInput.playOptions[0];
  assert.ok(payload);
  assert.equal(payload.type, 'track');
  assert.equal(payload.seek_position_ms, 0);
  assert.equal(payload.info.length, 120);
  assert.equal(payload.track_id.startsWith('musicbridge-'), true);
});

test('a new playback receives a new track identity after stop clears the prior one', async () => {
  let nextTrackId = 0;
  const { adapter, api } = await makeReadyHarness({
    trackIdFactory: () => `musicbridge-test-${++nextTrackId}`,
  });

  const firstPlayback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session-1' });
  await firstPlayback;
  assert.equal(api.core.audioInput.playOptions[0]?.track_id, 'musicbridge-test-1');

  await adapter.stop();

  const secondPlayback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session-2' });
  await secondPlayback;
  assert.equal(api.core.audioInput.playOptions[1]?.track_id, 'musicbridge-test-2');
  assert.equal(nextTrackId, 2);
});

test('playback timer and Roon listener counters are cleared on shutdown', async () => {
  const { adapter, api } = await makeReadyHarness();

  assert.deepEqual(adapter.getDiagnosticResourceCounters(), {
    activeSessionCount: 0,
    listenerCount: 1,
    timerCount: 0,
  });

  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(adapter.getDiagnosticResourceCounters().timerCount, 1);
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  await playback;
  assert.deepEqual(adapter.getDiagnosticResourceCounters(), {
    activeSessionCount: 1,
    listenerCount: 1,
    timerCount: 0,
  });

  await adapter.shutdown();
  assert.deepEqual(adapter.getDiagnosticResourceCounters(), {
    activeSessionCount: 0,
    listenerCount: 0,
    timerCount: 0,
  });
});

test('a stale SessionEnded callback does not clear the new playback identity', async () => {
  const { logger, events } = recordingLogger();
  const { adapter, api } = await makeReadyHarness({}, logger);
  api.core.audioInput.autoPlay = false;

  const firstPlayback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
    session_id: 'opaque-session-1',
  });
  api.core.audioInput.emitPlayAt(0, 'Playing');
  await firstPlayback;

  api.core.audioInput.autoEndSession = false;
  const secondPlayback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(api.core.audioInput.beginSessionCalls, 1);

  api.core.audioInput.endSessionAt(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(api.core.audioInput.beginSessionCalls, 2);

  api.core.audioInput.emitSessionAt(0, 'SessionEnded');
  api.core.audioInput.emitSessionAt(1, 'SessionBegan', {
    session_id: 'opaque-session-2',
  });
  api.core.audioInput.emitPlayAt(1, 'Playing');
  await secondPlayback;

  const playingEvents = events.filter(
    ({ event, fields }) => event === 'roon_play_event' && fields.eventName === 'Playing',
  );
  assert.equal(playingEvents.at(-1)?.fields.trackIdPresent, true);
  assert.equal(adapter.getState().status, 'playing');
});

for (const event of ['EndedNaturally', 'StoppedUser', 'Paused', 'MediaError'] as const) {
  test(`a stale ${event} callback cannot terminate the new playback`, async () => {
    const { adapter, api } = await makeReadyHarness();
    api.core.audioInput.autoPlay = false;
    const terminalReasons: string[] = [];
    adapter.setTerminalHandler((reason) => terminalReasons.push(reason));

    const firstPlayback = adapter.play(playRequest);
    await nextTurn();
    api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
      session_id: 'opaque-session-1',
    });
    api.core.audioInput.emitPlayAt(0, 'Playing');
    await firstPlayback;

    const { playback: secondPlayback } = await startSecondPlayback(adapter, api);
    api.core.audioInput.emitPlayAt(0, event, {
      session_id: 'opaque-old-session',
      track_id: 'opaque-old-track',
    });
    await completeSecondPlayback(api, secondPlayback);

    assert.deepEqual(terminalReasons, []);
    assert.equal(adapter.getState().status, 'playing');
  });
}

test('a stale play ZoneLost callback does not clear the selected Zone', async () => {
  const { adapter, api } = await makeReadyHarness();
  api.core.audioInput.autoPlay = false;

  const firstPlayback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
    session_id: 'opaque-session-1',
  });
  api.core.audioInput.emitPlayAt(0, 'Playing');
  await firstPlayback;

  const { playback: secondPlayback } = await startSecondPlayback(adapter, api);
  api.core.audioInput.emitPlayAt(0, 'ZoneLost', {
    session_id: 'opaque-old-session',
  });
  await completeSecondPlayback(api, secondPlayback);

  assert.equal(adapter.getState().status, 'playing');
  assert.equal(adapter.getState().selectedZoneId, 'zone-1');
});

test('a stale session ZoneLost callback does not clear the selected Zone', async () => {
  const { adapter, api } = await makeReadyHarness();
  api.core.audioInput.autoPlay = false;

  const firstPlayback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
    session_id: 'opaque-session-1',
  });
  api.core.audioInput.emitPlayAt(0, 'Playing');
  await firstPlayback;

  const { playback: secondPlayback } = await startSecondPlayback(adapter, api);
  api.core.audioInput.emitSessionAt(0, 'ZoneLost', {
    session_id: 'opaque-old-session',
  });
  await completeSecondPlayback(api, secondPlayback);

  assert.equal(adapter.getState().status, 'playing');
  assert.equal(adapter.getState().selectedZoneId, 'zone-1');
});

test('a stale connection callback cannot reject the new playback', async () => {
  const { adapter, api } = await makeReadyHarness();
  api.core.audioInput.autoPlay = false;

  const firstPlayback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
    session_id: 'opaque-session-1',
  });
  api.core.audioInput.emitPlayAt(0, 'Playing');
  await firstPlayback;

  const { playback: secondPlayback } = await startSecondPlayback(adapter, api);
  api.core.audioInput.emitSessionAt(0, 'MooError', {
    session_id: 'opaque-old-session',
    details: 'must-not-log',
  });
  await completeSecondPlayback(api, secondPlayback);

  assert.equal(adapter.getState().status, 'playing');
});

test('a stale SessionBegan callback cannot start a second old play request', async () => {
  const { adapter, api } = await makeReadyHarness();
  api.core.audioInput.autoPlay = false;

  const firstPlayback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
    session_id: 'opaque-session-1',
  });
  api.core.audioInput.emitPlayAt(0, 'Playing');
  await firstPlayback;

  const { playback: secondPlayback } = await startSecondPlayback(adapter, api);
  api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
    session_id: 'opaque-old-session',
  });
  assert.equal(api.core.audioInput.playCalls, 1);
  await completeSecondPlayback(api, secondPlayback);
});

test('a stale unknown session event cannot reject the new playback', async () => {
  const { adapter, api } = await makeReadyHarness();
  api.core.audioInput.autoPlay = false;

  const firstPlayback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
    session_id: 'opaque-session-1',
  });
  api.core.audioInput.emitPlayAt(0, 'Playing');
  await firstPlayback;

  const { playback: secondPlayback } = await startSecondPlayback(adapter, api);
  api.core.audioInput.emitSessionAt(0, 'UnexpectedOldSessionEvent', {
    session_id: 'opaque-old-session',
  });
  await completeSecondPlayback(api, secondPlayback);
});

test('a stale unknown play event cannot reject the new playback', async () => {
  const { adapter, api } = await makeReadyHarness();
  api.core.audioInput.autoPlay = false;

  const firstPlayback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
    session_id: 'opaque-session-1',
  });
  api.core.audioInput.emitPlayAt(0, 'Playing');
  await firstPlayback;

  const { playback: secondPlayback } = await startSecondPlayback(adapter, api);
  api.core.audioInput.emitPlayAt(0, 'UnexpectedOldPlayEvent', {
    session_id: 'opaque-old-session',
  });
  await completeSecondPlayback(api, secondPlayback);
});

test('a stale Playing callback cannot resolve the new playback', async () => {
  const { adapter, api } = await makeReadyHarness();
  api.core.audioInput.autoPlay = false;

  const firstPlayback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
    session_id: 'opaque-session-1',
  });
  api.core.audioInput.emitPlayAt(0, 'Playing');
  await firstPlayback;

  const { playback: secondPlayback } = await startSecondPlayback(adapter, api);
  let secondSettled = false;
  void secondPlayback.then(
    () => {
      secondSettled = true;
    },
    () => {
      secondSettled = true;
    },
  );
  api.core.audioInput.emitPlayAt(0, 'Playing', {
    session_id: 'opaque-old-session',
  });
  await nextTurn();
  assert.equal(secondSettled, false);
  await completeSecondPlayback(api, secondPlayback);
});

test('stale callback telemetry exposes only generation booleans and presence flags', async () => {
  const { logger, events } = recordingLogger();
  const { adapter, api } = await makeReadyHarness({}, logger);
  api.core.audioInput.autoPlay = false;

  const firstPlayback = adapter.play(playRequest);
  await nextTurn();
  api.core.audioInput.emitSessionAt(0, 'SessionBegan', {
    session_id: 'opaque-session-1',
  });
  api.core.audioInput.emitPlayAt(0, 'Playing');
  await firstPlayback;

  const { playback: secondPlayback } = await startSecondPlayback(adapter, api);
  api.core.audioInput.emitSessionAt(0, 'SessionEnded', {
    session_id: 'opaque-old-session',
    track_id: 'opaque-old-track',
  });
  await completeSecondPlayback(api, secondPlayback);

  const staleSessionEvent = events.find(
    ({ event, fields }) =>
      event === 'roon_session_event' &&
      fields.eventName === 'SessionEnded' &&
      fields.staleCallback === true,
  );
  assert.equal(staleSessionEvent?.fields.generationCurrent, false);
  assert.equal(staleSessionEvent?.fields.trackIdPresent, false);
  assert.equal(JSON.stringify(staleSessionEvent).includes('opaque-old'), false);
});

test('stopping an awaiting session invalidates its timeout before the next generation', async () => {
  const { adapter, api } = await makeReadyHarness({ sessionBeginTimeoutMs: 5 });
  const firstPlayback = adapter.play(playRequest);
  await nextTurn();

  const secondPlayback = adapter.play(playRequest);
  await assert.rejects(
    () => firstPlayback,
    (error: unknown) =>
      error instanceof BridgeError &&
      error.details?.reason === 'stopped_by_new_playback',
  );
  api.core.audioInput.emitSessionAt(1, 'SessionBegan', {
    session_id: 'opaque-session-2',
  });
  await secondPlayback;
  assert.equal(api.core.audioInput.beginSessionCalls, 2);
  assert.equal(adapter.getState().status, 'playing');
});

test('play event telemetry contains only safe body summary and gateway stage', async () => {
  const { logger, events } = recordingLogger();
  const { adapter, api } = await makeReadyHarness({}, logger);
  api.core.audioInput.autoPlay = false;
  const playback = adapter.play({
    ...playRequest,
    gatewayStage: () => 'completed',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  api.core.audioInput.emitPlay('EndedNaturally', {
    session_id: 'opaque-session',
    token: 'must-not-log',
    error_message: 'must-not-log',
  });

  await assert.rejects(() => playback);
  const playEvent = events.find(({ event }) => event === 'roon_play_event');
  assert.deepEqual(playEvent?.fields, {
    phase: 'awaiting_playing',
    eventName: 'EndedNaturally',
    elapsedMs: playEvent?.fields.elapsedMs,
    bodyPresent: true,
    bodyKeys: ['session_id', 'token', 'error_message'],
    sanitizedErrorClass: 'other',
    generationCurrent: true,
    staleCallback: false,
    trackIdPresent: true,
    gatewayStage: 'completed',
  });
  assert.equal(JSON.stringify(events).includes('must-not-log'), false);
});

test('Zone loss during stop rejects before beginning a new Audio Input session', async () => {
  const { adapter, api } = await makeReadyHarness({ sessionBeginTimeoutMs: 5 });
  const firstPlayback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  await firstPlayback;
  api.core.audioInput.beforeEndSession = () => {
    api.core.transport.emit('Changed', { zones_removed: ['zone-1'] });
  };

  await assert.rejects(
    () => adapter.play(playRequest),
    (error: unknown) =>
      error instanceof BridgeError && error.code === 'ROON_ZONE_NOT_SELECTED',
  );
  assert.equal(api.core.audioInput.beginSessionCalls, 1);
});

test('begin_session never receives an undefined zone_id after stop', async () => {
  const { adapter, api } = await makeReadyHarness({ sessionBeginTimeoutMs: 5 });
  const firstPlayback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSession('SessionBegan', { session_id: 'opaque-session' });
  await firstPlayback;
  api.core.audioInput.beforeEndSession = () => {
    api.core.transport.emit('Changed', { zones_removed: ['zone-1'] });
  };

  await assert.rejects(() => adapter.play(playRequest));
  assert.equal(
    api.core.audioInput.beginSessionOptions.every(
      (options) => typeof (options as Record<string, unknown>).zone_id === 'string',
    ),
    true,
  );
});

test('InvalidRequest terminates awaiting_session and records only a sanitized error class', async () => {
  const { logger, events } = recordingLogger();
  const { adapter, api } = await makeReadyHarness({}, logger);
  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));

  api.core.audioInput.emitSession('InvalidRequest', {
    error_message:
      'missing required field session_id for zone 01234567-89ab-cdef-0123-456789abcdef at https://192.0.2.4:38502/path?token=secret-value',
    session_id: 'opaque-session-id',
  });

  await assert.rejects(
    () => playback,
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === 'ROON_MEDIA_ERROR' &&
      error.details?.reason === 'invalid_request',
  );
  const sessionEvent = events.find(({ event }) => event === 'roon_session_event');
  assert.equal(sessionEvent?.fields.sanitizedErrorClass, 'missing_required_field');
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes('opaque-session-id'), false);
  assert.equal(serializedEvents.includes('192.0.2.4'), false);
  assert.equal(serializedEvents.includes('secret-value'), false);
});

test('Roon response body summary bounds keys and redacts identifiers, URLs, IPs, and tokens', () => {
  const summary = summarizeRoonResponseBody({
    error_message:
      'invalid zone 01234567-89ab-cdef-0123-456789abcdef at https://192.0.2.4:38502/path?token=secret-value',
    session_id: 'opaque-session-id',
    output_id: 'opaque-output-id',
    token: 'abcdefghijklmnopqrstuvwxyz0123456789',
    path: '/Users/private/Music/file.flac',
    extra1: true,
    extra2: true,
    extra3: true,
    extra4: true,
    extra5: true,
    extra6: true,
    extra7: true,
    extra8: true,
    extra9: true,
    extra10: true,
    extra11: true,
    extra12: true,
    extra13: true,
  });

  assert.equal(summary.bodyPresent, true);
  assert.equal(summary.bodyType, 'object');
  assert.equal(summary.bodyKeys.length, 16);
  assert.equal(summary.errorMessagePresent, true);
  assert.equal(summary.sanitizedErrorClass, 'invalid_zone');
  assert.ok((summary.sanitizedErrorText?.length ?? 0) <= 160);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('01234567-89ab-cdef-0123-456789abcdef'), false);
  assert.equal(serialized.includes('192.0.2.4'), false);
  assert.equal(serialized.includes('secret-value'), false);
  assert.equal(serialized.includes('opaque-session-id'), false);
  assert.equal(serialized.includes('opaque-output-id'), false);
  assert.equal(serialized.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false);
  assert.equal(serialized.includes('/Users/private/Music/file.flac'), false);
});

test('Roon session logs contain no Zone ID, icon URL, session ID, or callback body', async () => {
  const { logger, events } = recordingLogger();
  const { adapter, api } = await makeReadyHarness({}, logger);
  const playback = adapter.play(playRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  api.core.audioInput.emitSession('InvalidRequest', {
    error_message: 'unsupported request body must-not-log',
    session_id: 'opaque-session-id',
  });

  await assert.rejects(() => playback);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('zone-1'), false);
  assert.equal(serialized.includes(playRequest.iconUrl), false);
  assert.equal(serialized.includes('opaque-session-id'), false);
  assert.equal(serialized.includes('unsupported request body must-not-log'), false);
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
  assert.equal(playEvent?.fields.phase, 'awaiting_playing');
  assert.equal(playEvent?.fields.eventName, 'UnexpectedPlayEvent');
  assert.equal(playEvent?.fields.bodyPresent, true);
  assert.deepEqual(playEvent?.fields.bodyKeys, ['token']);
  assert.equal(playEvent?.fields.sanitizedErrorClass, 'none');
  assert.equal(playEvent?.fields.trackIdPresent, true);
  assert.equal(playEvent?.fields.gatewayStage, 'none');
  assert.equal(typeof playEvent?.fields.elapsedMs, 'number');
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
      generationCurrent: true,
      staleCallback: false,
      trackIdPresent: true,
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
