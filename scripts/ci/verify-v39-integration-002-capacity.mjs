import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runV39Integration002AuxiliaryGate } from './verify-v39-integration-002.mjs';
export const runV39Integration002CapacityGate=(argv,env)=>runV39Integration002AuxiliaryGate('capacity',argv,env);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runV39Integration002CapacityGate(process.argv.slice(2),process.env).then(result=>{
 process.stdout.write(JSON.stringify({passed:result.passed,code:result.failureCode,sourceSha:result.sourceSha})+'\n');process.exitCode=result.passed?0:1;
}).catch(()=>{process.stderr.write('V39_002_CAPACITY_GATE_FAILED\n');process.exitCode=1;});
