import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runV39Integration002AuxiliaryGate } from './verify-v39-integration-002.mjs';
export const runV39Integration002NativeGate=(argv,env)=>runV39Integration002AuxiliaryGate('native',argv,env);
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runV39Integration002NativeGate(process.argv.slice(2),process.env).then(result=>{
 process.stdout.write(JSON.stringify({passed:result.passed,code:result.failureCode,sourceSha:result.sourceSha})+'\n');process.exitCode=result.passed?0:1;
}).catch(()=>{process.stderr.write('V39_002_NATIVE_GATE_FAILED\n');process.exitCode=1;});
