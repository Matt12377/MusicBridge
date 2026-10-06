import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { PreparedLocalSource } from '../../src/application/local-source-resolver.js';
import { authorizeSourceDirectory } from '../../src/recording/source-files.js';
import { StreamGateway } from '../../src/stream/gateway.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import type { Logger } from '../../src/shared/logger.js';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';

export async function fixture(t: TestContext, bytes = Buffer.from(Array.from({ length: 131_113 }, (_, i) => (i * 17 + 31) % 251))) {
  const storage = buildStoragePolicy(), external = storage.check(process.env.TMPDIR!, { mustExist: true });
  const directory = await mkdtemp(path.join(external, 'synthetic-')); storage.check(directory, { mustExist: true }); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const absolute = path.join(directory, '原字节.wav'); await writeFile(absolute, bytes, { mode: 0o600 });
  const sourceRoot = { id: randomUUID(), ...await authorizeSourceDirectory(directory) }, rootId = randomUUID(), assetId = randomUUID();
  const descriptor: PreparedLocalSource = { source_kind: 'local_file', status: 'prepared_descriptor', request_id: randomUUID(), action: 'PLAY_NOW', target: { core_id: 'synthetic-core', zone_id: 'synthetic-zone' },
    facts: { sourceRoot, relative: path.basename(absolute), root: { id: rootId, sourceRootId: sourceRoot.id, role: 'library', revision: '1' },
      asset: { id: assetId, libraryRootId: rootId, sourceRootId: sourceRoot.id, rootRevision: '1', fileRevision: '2', locationRevision: '3', sampleFrames: null, timebaseHz: null },
      track: { id: randomUUID(), assetId, selectionRevision: '4', segment: null } } };
  const info = await stat(absolute, { bigint: true });
  await captureOwnedFileObservation(descriptor, absolute);
  return { directory, absolute, bytes, descriptor, resource: { dev: String(info.dev), ino: String(info.ino) } };
}
/** UNIT的可信观察来自本测试拥有的文件；生产resolver只能消费唯一Owner的当前扫描观察。 */
export async function captureOwnedFileObservation(descriptor: PreparedLocalSource, absolute: string) {
  const info = await stat(absolute, { bigint: true }), { asset, track, root, sourceRoot } = descriptor.facts;
  descriptor.facts.observation = { signature: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'),
    assetId: asset.id, trackId: track.id, libraryRootId: root.id, sourceRootId: sourceRoot.id,
    fileRevision: asset.fileRevision, rootRevision: root.revision, locationRevision: asset.locationRevision, selectionRevision: track.selectionRevision };
}
export function authority(attempt = 1, ownerId = 'synthetic-controller') { return { attempt, ownerId, isCurrent: () => true }; }
export function session(attempt = 1) { return { attempt, sessionId: `synthetic-session-${attempt}`, isConfirmed: () => true }; }
export async function gatewayFixture(t: TestContext) {
  const file = await fixture(t), registry = new StreamRegistry(), events: unknown[] = []; let fetches = 0;
  const record = (event: string, fields?: unknown) => { events.push({ event, fields }); };
  const logger: Logger = { debug: record, info: record, warn: record, error: record };
  const gateway = new StreamGateway({ host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1:0', registry, logger,
    fetcher: async () => { fetches++; throw new Error('本地路径不得访问远程fetch。'); } });
  await gateway.start(); t.after(() => gateway.stop());
  const registration = await registry.registerLocalSource(file.descriptor, authority(), 'wav');
  return { ...file, registry, gateway, events, ...registration, url: gateway.localStreamUrl(registration.token), fetches: () => fetches };
}
export async function eventually(predicate: () => boolean, message: string) {
  const end = performance.now() + 3000;
  while (!predicate() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(predicate(), true, message);
}
