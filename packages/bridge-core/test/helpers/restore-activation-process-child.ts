import { openCollectionDataset } from '../../src/recording/restore-dataset-runtime.js';
import { createTestBridgeRuntime } from '../../src/runtime.js';
import { attachCoreRuntimePort, type UtilityPort } from '../../src/utility-main.js';

const directory = process.argv[2]!, checkpoint = process.argv[3];
const dataset = await openCollectionDataset(directory);
const runtime = createTestBridgeRuntime({ collectionRepository: dataset.repository, backupWorkflowStore: dataset.store, backupPrivateRoot: dataset.privateRoot, ...(dataset.contentBinding ? { backupContentBinding: dataset.contentBinding } : {}) });
const port: UtilityPort = {
  on() {}, start() {},
  postMessage(message) {
    if (typeof message === 'object' && message !== null && 'event' in message && message.event === 'core.ready') {
      process.send?.({ checkpoint: 'after-ready', drafts: dataset.repository.drafts.list({ offset: 0, limit: 20 }).items.map(item => item.title), playback: runtime.getPlaybackState().state });
    }
  },
};
if (checkpoint === 'before-ready') {
  await runtime.start();
  process.send?.({ checkpoint, drafts: dataset.repository.drafts.list({ offset: 0, limit: 20 }).items.map(item => item.title), playback: runtime.getPlaybackState().state });
} else {
  await attachCoreRuntimePort(port, runtime, { beforeReady: () => dataset.commit() });
}
setInterval(() => {}, 1000);
