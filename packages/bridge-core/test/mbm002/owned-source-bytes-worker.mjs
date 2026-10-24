import { parentPort } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { captureMobileContentCoreResponse } = await import('../../src/mobile/content-rpc.ts');
const { ownedSourceByteLength } = await import('../../src/mobile/owned-source-bytes.ts');
parentPort.on('message', packet => {
  if (packet.kind === 'close') { parentPort.close(); return; }
  const ownedBefore = ownedSourceByteLength(packet.response.result.bytes, 65536);
  const ownKeys = Reflect.ownKeys; let scans = 0;
  Reflect.ownKeys = value => { if (value instanceof Uint8Array) scans++; return ownKeys(value); };
  let response;
  try { response = captureMobileContentCoreResponse(packet.response, packet.call); }
  finally { Reflect.ownKeys = ownKeys; }
  const ownedAfter = ownedSourceByteLength(response.result.bytes, 65536);
  parentPort.postMessage({ kind: 'returned', ownedBefore, ownedAfter, scans, response });
});
parentPort.postMessage({ kind: 'ready' });
