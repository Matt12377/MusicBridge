import {parentPort,workerData} from 'node:worker_threads';
import {readSync} from 'node:fs';
/** 独立只读worker不拥有FD，不关闭parent句柄；仅返回有限原字节。 */
const input=workerData as {fd:number;size:number};
if(!Number.isSafeInteger(input.fd) || input.fd<0 || !Number.isSafeInteger(input.size) || input.size<1 || input.size>65536) {
  parentPort?.postMessage({status:'failure',code:'BUDGET_EXCEEDED'});
} else {
  try {
    const bytes=Buffer.alloc(input.size);let offset=0,calls=0;
    while(offset<bytes.length) {
      if(calls>=64) {const error=new Error('CUE读取调用预算耗尽。');error.name='BUDGET_EXCEEDED';throw error;}
      const n=readSync(input.fd,bytes,offset,Math.min(8192,bytes.length-offset),offset);++calls;
      if(n<1) throw new Error('CUE读取长度改变。');offset+=n;
    }
    parentPort?.postMessage({status:'ok',bytes:new Uint8Array(bytes),readCalls:calls});
  } catch(error) {parentPort?.postMessage({status:'failure',code:error instanceof Error && error.name === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED':'IO_ERROR'});}
}
parentPort?.close();
