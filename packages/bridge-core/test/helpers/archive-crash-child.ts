import { createCollectionRepository } from '../../src/collection/repository.js';
import { createArchiveTransactionRunner } from '../../src/recording/archive-transactions.js';
import { copyReadonlySource } from '../../src/recording/source-files.js';

const [filePath, operationId, cut] = process.argv.slice(2);
if (!filePath || !operationId || !cut || !process.send) throw new Error('缺少合成崩溃 Gate 参数');
const repository = createCollectionRepository({ filePath });
await createArchiveTransactionRunner({ store: repository.archive,
  ...(cut === 'COPY_PARTIAL' ? { copy: (async (root, relative, expected, destination, signal) => {
    const write = destination.write.bind(destination);
    // 仍执行正式只读复制；只在首个真实短写与fsync后暂停，让父进程终止正在复制的子进程。
    destination.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await write(buffer, offset, Math.min(length, 65_536), position);
      await destination.sync();
      const info = await destination.stat();
      if (info.size <= 0 || info.size >= expected.size) throw new Error('没有形成真实复制中间状态');
      process.send!({ phase: 'COPY_PARTIAL', size: info.size, expectedSize: expected.size });
      await new Promise<void>(() => undefined);
      return result;
    }) as typeof destination.write;
    return copyReadonlySource(root, relative, expected, destination, signal);
  }) satisfies typeof copyReadonlySource } : {}),
  afterPhase: async phase => {
  if (phase !== cut) return;
  process.send!({ phase });
  // 父测试在收到已落盘检查点后发送 SIGKILL，不运行 close/finally。
  await new Promise<void>(() => undefined);
} }).run(operationId);
throw new Error('测试未在指定归档阶段中断');
