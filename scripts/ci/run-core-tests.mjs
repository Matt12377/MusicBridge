import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/bridge-core');
const isolated = 'recording-capacity-queued-stop.test.ts';

// 保留原 test/*.test.ts 清单，只将依赖墙钟阈值的排队 Stop 放在独立阶段。
export function coreTestPhases(names) {
  const tests = names.filter(name => !name.startsWith('.') && name.endsWith('.test.ts')).sort();
  if (!tests.includes(isolated) || new Set(tests).size !== tests.length || tests.length < 2
    || tests.some(name => name.includes('/') || name.includes('\\'))) {
    throw new Error('Core 测试清单不完整，不能跳过排队 Stop 阶段。');
  }
  const args = ['--import', 'tsx', '--test', '--test-reporter=tap'];
  return [
    { name: '原有 Core 测试', args: [...args, ...tests.filter(name => name !== isolated).map(name => `test/${name}`)] },
    { name: '排队 Stop 独立阶段', args: [...args, '--test-concurrency=1', `test/${isolated}`] },
  ];
}

export function runCoreTestPhases(phases, execute = spawnSync, announce = console.log) {
  for (const phase of phases) {
    announce(`Core 测试阶段：${phase.name}`);
    const result = execute(process.execPath, phase.args, { cwd: core, env: process.env, stdio: 'inherit' });
    if (result.error || result.signal || !Number.isInteger(result.status)) return 1;
    if (result.status !== 0) return result.status;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = runCoreTestPhases(coreTestPhases(readdirSync(path.join(core, 'test'))));
  } catch {
    console.error('Core 测试清单或阶段执行失败。');
    process.exitCode = 1;
  }
}
