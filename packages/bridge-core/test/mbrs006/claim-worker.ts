import {parentPort,workerData} from 'node:worker_threads';
import {LocalSourceFence} from '../../src/stream/local-source-fence.js';
const signal=new Int32Array(workerData.signal);
new LocalSourceFence(workerData.buffer).dispatch(()=>{parentPort!.postMessage('claimed');Atomics.wait(signal,0,0);});
parentPort!.postMessage('quiet');
