import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createBridgeRuntime } from '../../src/runtime.js';
import { createLocalFavoriteRepository } from '../../src/favorites/repository.js';
import { createLocalSourceTickets } from '../../src/collection/local-source-tickets.js';
import type { CollectionRepository } from '../../src/collection/repository.js';
import type { DatasetOwnerEndpoint } from '../../src/collection/dataset-owner-protocol.js';
import type { RoonSdk, RoonApiOptions, RoonZoneChangeCallback, RoonAudioInputPlayOptions } from '../../src/roon/sdk.js';
import type { Logger } from '../../src/shared/logger.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
async function reservePort() {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { port: address.port, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

/** 原runtime/Controller/Adapter/网关与固定FD原字节；只替代SDK设备、Owner外进程传输，不接真实Roon/账号、不发声。 */
export async function createPlaybackPriorityRuntime(repository: CollectionRepository, identity: { epoch: string; datasetId: string }) {
  const ports = await Promise.all([reservePort(), reservePort()]);
  await Promise.all(ports.map(port => port.close()));
  let apiOptions!: RoonApiOptions, zoneCallback!: RoonZoneChangeCallback, alive = true;
  const sessions: ((message: unknown, body: unknown) => void)[] = [], plays: ((message: unknown, body: unknown) => void)[] = [];
  const transfers: Promise<void>[] = [], transferBytes: number[] = [], controls: string[] = [];
  const emitZone = (state: 'stopped' | 'playing' | 'paused', positionSeconds = 0): void => zoneCallback('Changed', { zones_changed: [{
    zone_id: 'synthetic-zone', display_name: 'Controlled Zone', state, seek_position: positionSeconds, outputs: [{ output_id: 'synthetic-output' }],
    is_pause_allowed: true, is_play_allowed: true, is_seek_allowed: true,
  }] });
  const core = { core_id: 'synthetic-core', display_name: 'Controlled Core', services: {
    RoonApiAudioInput: {
      begin_session(_options: unknown, callback: (message: unknown, body: unknown) => void) {
        const index = sessions.push(callback); queueMicrotask(() => callback('SessionBegan', { session_id: `controlled-priority-${index}` }));
        return { end_session(done: (message: unknown, body: unknown) => void) { done('SessionEnded', {}); } };
      },
      update_transport_controls(_options: unknown, callback: (message: unknown, body: unknown) => void) { callback('Success', {}); },
      play(options: RoonAudioInputPlayOptions, callback: (message: unknown, body: unknown) => void) {
        plays.push(callback);
        const transfer = (async () => {
          assert.equal(new URL(options.media_url).origin, `http://127.0.0.1:${ports[1]!.port}`, '合成SDK绝不访问非本任务loopback');
          const response = await fetch(options.media_url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
          assert.equal(response.status, 200); const bytes = new Uint8Array(await response.arrayBuffer()); assert.ok(bytes.length > 0);
          transferBytes.push(bytes.length); emitZone('playing'); callback('Playing', {});
        })().catch(() => { callback('MediaError', {}); });
        transfers.push(transfer);
      },
    },
    RoonApiTransport: {
      subscribe_zones(callback: RoonZoneChangeCallback) { zoneCallback = callback; },
      control(_zone: unknown, action: string, callback: (error: false) => void) {
        controls.push(action); const paused = action === 'pause'; emitZone(paused ? 'paused' : action === 'stop' ? 'stopped' : 'playing');
        plays.at(-1)?.(paused ? 'Paused' : 'Playing', {}); callback(false);
      },
      seek(_zone: unknown, _how: unknown, seconds: number, callback: (error: false) => void) {
        callback(false); emitZone('playing', seconds); plays.at(-1)?.('Time', { seek_position_ms: seconds * 1000 });
      },
    },
  } };
  const sdk = { audioInputService: class {}, transportService: class {},
    createApi(options: RoonApiOptions) { apiOptions = options; return { load_config() {}, save_config() {}, init_services() {}, start_discovery() {}, stop_discovery() {}, disconnect_all() {} }; },
    createSettings() { return {}; }, createStatus() { return { set_status() {} }; },
  } as unknown as RoonSdk;
  const tickets = createLocalSourceTickets(repository, identity.epoch, identity.datasetId, () => { repository.list({ offset: 0, limit: 1 }); });
  const endpoint: DatasetOwnerEndpoint = { async prepare() { return identity; }, async dispatch() { throw new Error('合成Owner不派发mutation'); },
    async commitBoot() {}, async close() {}, isLocalSourceCurrent: () => alive,
    sealLocalSources() { alive = false; tickets.seal(); }, captureLocalSource: async request => tickets.capture(request),
    revalidateLocalSource: async ticket => tickets.revalidate(ticket), releaseLocalSource: async ticket => tickets.release(ticket) };
  const runtime = createBridgeRuntime({ env: { LOG_LEVEL: 'error', BRIDGE_CONTROL_HOST: '127.0.0.1', BRIDGE_STREAM_HOST: '127.0.0.1',
    BRIDGE_CONTROL_PORT: String(ports[0]!.port), BRIDGE_STREAM_PORT: String(ports[1]!.port) },
    localScanReadProfile: 'bulk-v2', favoriteRepository: createLocalFavoriteRepository(), logger, roonSdk: sdk,
    datasetOwnerEndpoint: endpoint, playbackEventProtocol: 'compact-v1' });
  try {
    await runtime.start(); apiOptions.core_paired(core);
    zoneCallback('Subscribed', { zones: [{ zone_id: 'synthetic-zone', display_name: 'Controlled Zone', state: 'stopped',
      outputs: [{ output_id: 'synthetic-output' }], is_pause_allowed: true, is_play_allowed: true, is_seek_allowed: true }] });
    await runtime.selectZone('synthetic-zone');
  } catch (error) {
    await runtime.shutdown(); throw error;
  }
  return { runtime, tickets, sessions, plays, transferBytes, controls, emitZone,
    unpair: () => apiOptions.core_unpaired(core),
    async close() { await runtime.shutdown(); await Promise.all(transfers); assert.equal(tickets.size, 0); },
  };
}
