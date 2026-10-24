import { after } from 'node:test';
import './mbrs008/file-parameters.test.js';
import './mbrs008/http-byte-evidence.test.js';
import './mbrs008/quality-reduction.test.js';
import './mbrs008/pcm-evidence.test.js';

// 本文件消费鲜编 Reader；用例结束后由测试进程归还其共享池。
// 普通 Reader.close 仍只关闭自己的工作，不能停止产品里的其他使用者。
after(async () => {
  const { closeRustMediaWorkerPool } = await import('../dist/library/rust-media-worker.js');
  await closeRustMediaWorkerPool();
});
