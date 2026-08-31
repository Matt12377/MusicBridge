import { realpathSync } from 'node:fs';
import { CAPACITY_PHASE_REPO_ROOT, capacityPhaseFailureCode, parseCapacityPhaseArguments, runCapacityPhase } from '../helpers/recording-capacity-phases.js';

// 仅显式CLI；没有默认phase、自动重试或环境授权入口。
async function main() {
  try {
    if (realpathSync(process.cwd()) !== realpathSync(CAPACITY_PHASE_REPO_ROOT)) throw new Error('CAPACITY_PHASE_INVALID_INPUT');
    const result = await runCapacityPhase(parseCapacityPhaseArguments(process.argv.slice(2)));
    process.stdout.write(`CAPACITY_PHASE_${result.state.toUpperCase()}\n`);
    if (result.state !== 'passed' && result.state !== 'prepared') process.exitCode = 1;
  } catch (error) { process.stderr.write(capacityPhaseFailureCode(error) + '\n'); process.exitCode = 1; }
}
void main();
