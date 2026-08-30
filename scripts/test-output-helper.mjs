import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const [command, args] of [[path.join(root, 'reports/runtime/task-073-output-backend/native-build/frame-pump-test'), []], [process.execPath, ['--test', 'native/output-helper/process.test.mjs']]]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
