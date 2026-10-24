import { parentPort } from 'node:worker_threads';
import { register } from 'tsx/esm/api';
register();
const { attachCoreRuntimePort } = await import('../../src/utility-main.ts');
const { createMobileContentRpcPort } = await import('../../src/mobile/content-rpc-port.ts');
const { mobileRangeWindowCoreFacts } = await import('../../src/mobile/range-window-observer.ts');
const { SOURCE_SCOPE } = await import('./source-byte-pipeline-fixture.ts');
let auth = 0, facts = 0, calls = 0;
const rpc = createMobileContentRpcPort({ initialize: async () => {}, resolveScope: async () => SOURCE_SCOPE,
  assertScope() { auth++; }, invalidateDevice: async () => {},
  content: { async dispatch() { throw new Error('合成Range不能读取目录。'); } },
  async source(_scope, request) {
    calls++;
    if (request.operation !== 'read') throw new Error('合成Range只允许read。');
    for (let index = 0; index < 15; index++) mobileRangeWindowCoreFacts(() => { facts++; });
    return { source: 'local', result: { kind: 'mobile-source-read', handle: request.handle, readId: request.readId,
      start: request.start, bytes: Uint8Array.from({ length: request.maxBytes }, (_, index) => index % 251) } };
  } });
await rpc.request({ type: 'mobile-content-core-request', id: '30000000-0000-4000-8000-000000000001',
  action: 'initialize', serverId: SOURCE_SCOPE.serverId, datasetId: SOURCE_SCOPE.datasetId, key: new Uint8Array(32).fill(42) }, new AbortController().signal);
const port = {
  on(_event, listener) { parentPort.on('message', data => { if (data?.type !== 'test.close') listener({ data }); }); },
  start() {}, postMessage(data) {
    parentPort.postMessage(data);
    if (data.type === 'mobile-content-core-response') parentPort.postMessage({ type: 'test.stats', auth, facts, calls });
  },
};
await attachCoreRuntimePort(port, { async start() {}, mobileContentRpc: (call, signal) => rpc.request(call, signal),
  getState: () => ({ runtime: 'ready', roon: 'disconnected', provider: 'missing', activeStreamCount: 0, activePlaybackPresent: false }) });
parentPort.on('message', async data => { if (data?.type === 'test.close') { await rpc.close(); parentPort.close(); } });
