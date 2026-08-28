import { createCollectionRepository } from '../../src/collection/repository.js';
import { createArchiveTransactionRunner } from '../../src/recording/archive-transactions.js';

const [filePath, operationId, cut] = process.argv.slice(2);
if (!filePath || !operationId || !cut || !process.send) throw new Error('缺少合成崩溃 Gate 参数');
const repository = createCollectionRepository({ filePath });
await createArchiveTransactionRunner({ store: repository.archive, afterPhase: async phase => {
  if (phase !== cut) return;
  process.send!({ phase });
  // 父测试在收到已落盘检查点后发送 SIGKILL，不运行 close/finally。
  await new Promise<void>(() => undefined);
} }).run(operationId);
throw new Error('测试未在指定归档阶段中断');
