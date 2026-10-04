import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { RoonAudioInputAdapter, type RoonAudioInputAdapterOptions } from '../../src/roon/adapter.js';
import type { Logger } from '../../src/shared/logger.js';
import type { RoonApiInstance, RoonApiOptions, RoonAudioInputService, RoonCore,
  RoonRequiredServiceConstructor, RoonSdk, RoonSettingsOptions, RoonSettingsService,
  RoonStatusService, RoonTransportControl, RoonTransportService, RoonTransportTarget,
  RoonZone, RoonZoneChangeCallback } from '../../src/roon/sdk.js';

export const AUDIOINPUT_COMMIT = '21ff59e52a12cf36a21bb9d3fd546f3e6d70581f';
export const AUDIOINPUT_LIB_SHA256 = '807a30adb8a6c9b6f0d9e9f913d5b2f7be9694f0e8c6dfa7c428da4261c1cd23';
export const SYNTHETIC_ZONE = 'synthetic-zone-1';
const service = 'com.roonlabs.audioinput:1/';
type Callback = (message: { name: string }, body: unknown) => void;
export type Operation = 'begin_session' | 'play' | 'end_session' | 'update_transport_controls';
interface Request { operation: Operation; payload: Record<string, unknown>; callback?: Callback; sessionAlias: string }
interface Session { alias: string; rawId: string; began: boolean; confirmedClosed: boolean; endRequested: boolean }
export interface ObservedSdkEvent { operation: Operation; event: string; sessionAlias: string }

/** 核本地真实锁定字节，再交官方类给Fake moo；不访问官方网络。 */
export function loadOfficialAudioInput(): new (core: unknown) => RoonAudioInputService {
  const require = createRequire(new URL('../../package.json', import.meta.url));
  const filename = require.resolve('node-roon-api-audioinput');
  const digest = createHash('sha256').update(readFileSync(filename)).digest('hex');
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  if (digest !== AUDIOINPUT_LIB_SHA256 || manifest.dependencies['node-roon-api-audioinput'] !== `github:RoonLabs/node-roon-api-audioinput#${AUDIOINPUT_COMMIT}`) {
    throw new Error('锁定官方AudioInput源码身份不匹配。');
  }
  return require('node-roon-api-audioinput') as new (core: unknown) => RoonAudioInputService;
}

/** 只在实际send_request时分配callback slot；raw参数仅在内存断言。 */
export class FakeMoo {
  readonly requests: Request[] = [];
  private readonly sessions: Session[] = [];
  private readonly observers = new Set<(event: ObservedSdkEvent) => void>();
  private connected = true;
  endHandleInvocations = 0;

  send_request(method: string, options: unknown, callback: Callback): void {
    if (!this.connected || !method.startsWith(service)) throw new Error('禁止非离线AudioInput请求。');
    const operation = method.slice(service.length) as Operation;
    if (!['begin_session', 'play', 'end_session', 'update_transport_controls'].includes(operation)
      || !options || typeof options !== 'object') throw new Error('未知离线SDK请求。');
    const payload = { ...options as Record<string, unknown> };
    let session: Session;
    if (operation === 'begin_session') {
      if (payload.zone_id !== SYNTHETIC_ZONE) throw new Error('必须显式选择合成Zone。');
      session = { alias: `session-${this.sessions.length + 1}`, rawId: randomUUID(), began: false, confirmedClosed: false, endRequested: false };
      this.sessions.push(session);
    } else {
      const existing = this.sessions.find(item => item.rawId === payload.session_id && item.began);
      if (!existing) throw new Error('SDK请求没有已交付SessionBegan的所属会话。');
      session = existing;
      if (operation === 'end_session') session.endRequested = true;
    }
    this.requests.push({ operation, payload, callback, sessionAlias: session.alias });
    if (operation === 'update_transport_controls') callback({ name: 'Success' }, {});
  }

  request(operation: Operation, index = 0): Request {
    const request = this.requests.filter(item => item.operation === operation)[index];
    if (!request) throw new Error('不能为没有实际发送的SDK请求制造回调。');
    return request;
  }
  count(operation: Operation): number { return this.requests.filter(item => item.operation === operation).length; }
  private deliver(operation: Operation, index: number, event: string, body: unknown): void {
    const request = this.request(operation, index);
    if (!request.callback) throw new Error('SDK连接已关闭，回调slot已释放。');
    const session = this.sessions.find(item => item.alias === request.sessionAlias)!;
    if (operation === 'begin_session' && event === 'SessionBegan') session.began = true;
    if ((operation === 'begin_session' && event === 'SessionEnded')
      || (operation === 'end_session' && (event === 'SessionEnded' || event === 'Success'))) session.confirmedClosed = true;
    request.callback({ name: event }, body);
    for (const observe of this.observers) observe({ operation, event, sessionAlias: session.alias });
  }
  emitBegin(index = 0, event = 'SessionBegan'): void {
    const request = this.request('begin_session', index);
    const session = this.sessions.find(item => item.alias === request.sessionAlias)!;
    this.deliver('begin_session', index, event, event === 'SessionBegan' ? { session_id: session.rawId } : {});
  }
  emitPlay(index = 0, event = 'Playing', body: unknown = {}): void { this.deliver('play', index, event, body); }
  replyEnd(index = 0, event = 'SessionEnded'): void { this.deliver('end_session', index, event, {}); }
  observe(callback: (event: ObservedSdkEvent) => void): () => void {
    this.observers.add(callback); return () => { this.observers.delete(callback); };
  }
  ledger(): Array<{ sessionAlias: string; sessionBeganObserved: boolean; sessionConfirmedClosed: boolean;
    remoteStop: 'CONFIRMED_CLOSED' | 'UNCONFIRMED'; endRequested: boolean }> {
    return this.sessions.map(item => ({ sessionAlias: item.alias, sessionBeganObserved: item.began,
      sessionConfirmedClosed: item.confirmedClosed, remoteStop: item.confirmedClosed ? 'CONFIRMED_CLOSED' : 'UNCONFIRMED', endRequested: item.endRequested }));
  }
  callbackSlots(): number { return this.requests.filter(request => request.callback !== undefined).length; }
  observerCount(): number { return this.observers.size; }
  disconnect(): void {
    this.connected = false;
    for (const request of this.requests) delete request.callback;
    // 本地断连接不改变远端ledger；未收到关闭观察仍UNCONFIRMED。
  }
}

export class FakeTransport implements RoonTransportService {
  private subscription: RoonZoneChangeCallback | undefined;
  readonly controls: Array<{ target: RoonTransportTarget; control: RoonTransportControl }> = [];
  readonly seeks: Array<{ target: string; how: 'absolute' | 'relative'; seconds: number }> = [];
  zone: RoonZone = { zone_id: SYNTHETIC_ZONE, display_name: 'Synthetic Zone', outputs: [{ output_id: 'synthetic-output-1' }],
    state: 'stopped', is_pause_allowed: true, is_play_allowed: true, is_seek_allowed: true, seek_position: 0 };
  subscribe_zones(callback: RoonZoneChangeCallback): void {
    this.subscription = callback; callback('Subscribed', { zones: [this.zone] });
  }
  control(target: RoonTransportTarget, control: RoonTransportControl, callback: (error: string | false) => void): void {
    const syntheticTarget = target === SYNTHETIC_ZONE || (target !== null && typeof target === 'object'
      && !Array.isArray(target) && Reflect.ownKeys(target).length === 1
      && Object.hasOwn(target, 'zone_id') && 'zone_id' in target && target.zone_id === SYNTHETIC_ZONE);
    if (!syntheticTarget) throw new Error('控制请求只接受明确的合成Zone字符串或zone_id对象。');
    this.controls.push({ target, control }); callback(false);
  }
  seek(target: string, how: 'absolute' | 'relative', seconds: number, callback: (error: string | false) => void): void {
    if (target !== SYNTHETIC_ZONE) throw new Error('seek不能写到其它Zone。');
    this.seeks.push({ target, how, seconds }); callback(false);
  }
  emit(state: NonNullable<RoonZone['state']>, positionSeconds = this.zone.seek_position ?? 0): void {
    this.zone = { ...this.zone, state, seek_position: positionSeconds };
    this.subscription?.('Changed', { zones_changed: [this.zone] });
  }
  subscriptionCount(): number { return this.subscription ? 1 : 0; }
  disconnect(): void { this.subscription = undefined; }
}

export class OfflineFakeSdk implements RoonSdk {
  readonly moo = new FakeMoo();
  readonly transport = new FakeTransport();
  readonly audioInputService = loadOfficialAudioInput() as RoonRequiredServiceConstructor;
  readonly transportService = class OfflineTransportService {};
  readonly forbiddenCalls = { browse: 0, resolver: 0, enhancement: 0 };
  readonly configs = new Map<string, unknown>();
  apiOptions: RoonApiOptions | undefined;
  requiredServices: readonly RoonRequiredServiceConstructor[] = [];
  optionalServices: readonly RoonRequiredServiceConstructor[] = [];
  discoveryCalls = 0;
  disconnected = false;
  private readonly core: RoonCore;

  constructor() {
    const audioInput = new this.audioInputService({ moo: this.moo } as unknown as RoonCore) as RoonAudioInputService;
    const begin = audioInput.begin_session.bind(audioInput);
    audioInput.begin_session = (options, callback) => {
      const session = begin(options, callback);
      return { end_session: endCallback => { this.moo.endHandleInvocations += 1; session.end_session(endCallback); } };
    };
    this.core = { display_name: 'Synthetic Core', services: { RoonApiAudioInput: audioInput, RoonApiTransport: this.transport } };
  }
  forbidden(kind: keyof OfflineFakeSdk['forbiddenCalls']): never {
    this.forbiddenCalls[kind] += 1; throw new Error('离线POC禁止Browse/Resolver/增强端口。');
  }
  createApi(options: RoonApiOptions): RoonApiInstance {
    this.apiOptions = options;
    return {
      load_config: key => this.configs.get(key), save_config: (key, value) => { this.configs.set(key, value); },
      init_services: services => {
        this.requiredServices = services.required_services ?? [];
        this.optionalServices = services.optional_services ?? [];
        if (this.optionalServices.length > 0) throw new Error('离线SDK没有Browse/Image能力。');
      },
      start_discovery: () => { this.discoveryCalls += 1; },
      stop_discovery: () => undefined,
      disconnect_all: () => { this.disconnected = true; this.transport.disconnect(); this.moo.disconnect(); },
      ws_connect: () => { throw new Error('离线SDK禁止真实连接。'); },
    };
  }
  createSettings(_api: RoonApiInstance, _options: RoonSettingsOptions): RoonSettingsService { return {}; }
  createStatus(_api: RoonApiInstance): RoonStatusService { return { set_status: () => undefined }; }
  pair(): void {
    if (!this.apiOptions) throw new Error('离线Adapter尚未创建API。');
    this.apiOptions.core_paired(this.core);
  }
}

export const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
export async function readyFakeAdapter(options: RoonAudioInputAdapterOptions = {}): Promise<{
  adapter: RoonAudioInputAdapter; sdk: OfflineFakeSdk; diagnostics: Array<{ event: string; fields: Record<string, unknown> }>;
}> {
  const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const record: Logger['info'] = (event, fields) => { diagnostics.push({ event, fields: fields ?? {} }); };
  const logger: Logger = { debug: record, info: record, warn: record, error: record };
  const sdk = new OfflineFakeSdk();
  let track = 0;
  const adapter = new RoonAudioInputAdapter(logger, sdk, { sessionBeginTimeoutMs: 1000, playingTimeoutMs: 1000,
    transportTimeoutMs: 1000, trackIdFactory: () => `musicbridge-synthetic-track-${++track}`, ...options });
  await adapter.start(); sdk.pair(); adapter.selectZone(SYNTHETIC_ZONE);
  return { adapter, sdk, diagnostics };
}
