import { after } from 'node:test';
import './mbrs004/name-rules.test.js';
import './mbrs004/upstream-golden.test.js';
import './mbrs004/directory-golden.test.js';
import './mbrs004/name-rules-scan-integration.test.js';

// CD01 注入的 Reader 来自 fresh dist；原 src Domain 关闭不能代替该独立模块的池关闭。
after(async () => {
  const workers = await import(new URL('../dist/library/rust-media-worker.js', import.meta.url).href) as typeof import('../src/library/rust-media-worker.js');
  await workers.closeRustMediaWorkerPool();
});
