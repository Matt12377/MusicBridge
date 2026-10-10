import {parentPort,workerData} from 'node:worker_threads';
import {attachDatasetOwnerWorkerPort} from '../../src/collection/dataset-owner-worker.js';
import {prepareOwnedDatasetDomain} from '../../src/collection/dataset-domain.js';
import {readFacts} from '../mbrs006/catalog-fixture.js';
if(!parentPort)throw new Error('合成Owner无父端口。');
attachDatasetOwnerWorkerPort(parentPort,{prepare:(epoch,projection)=>prepareOwnedDatasetDomain({dataDirectory:workerData.dataDirectory,epoch,testMode:true,projection,scanMetadataReader:{async read(){return {status:'ok',parserVersion:'music-metadata-11.15.0/mbrs003-v3',fields:{title:'合成曲目',artist:'合成作者',album:'合成专辑'},...readFacts};},async close(){}}})});
