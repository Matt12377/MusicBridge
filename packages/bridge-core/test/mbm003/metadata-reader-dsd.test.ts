import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildStoragePolicy } from '../../../../apps/desktop/scripts/build-storage-root.mjs';
import { authorizeSourceDirectory, readonlySourceCandidateMetadata } from '../../src/recording/source-files.js';
import type { MetadataReaderLifecycle } from '../../src/library/metadata-reader-types.js';
import { loadFreshMetadataReader } from '../helpers/mbrs003-audio-fixtures.js';
const {createMetadataReader} = await loadFreshMetadataReader();
const hash=(b:Uint8Array) => createHash('sha256').update(b).digest('hex');
for (const ext of ['dsf','dff']) test(`MBM003真实Worker ${ext}：可信资格开启后捕获真实1-bit clock与FD静止`,{timeout:20_000},async t => {
  const storage=buildStoragePolicy(), parent=storage.check(process.env.TMPDIR!,{mustExist:true});
  const own=await mkdtemp(path.join(parent,'musicbridge-mbm003-reader-'));await chmod(own,0o700);
  const original=new URL(`../fixtures/mbrs003/dsd/synthetic-balanced-dsd64.${ext}`,import.meta.url), bytes=await readFile(original);
  const file=`qualified.${ext}`;await writeFile(path.join(own,file),bytes,{flag:'wx',mode:0o600});
  const root={...await authorizeSourceDirectory(own),id:randomUUID()}, events:MetadataReaderLifecycle[]=[];
  const reader=createMetadataReader({dsdMetadataEnabled:true,onLifecycle:e => events.push(e)});t.after(() => reader.close());
  const result=await reader.read({root,relative:file,expectedSignature:(await readonlySourceCandidateMetadata(root,file)).signature});
  assert.equal(result.status,'ok');if(result.status!=='ok')return;
  assert.deepEqual(result.technical,{container:ext.toUpperCase(),codec:'DSD',lossless:true,sampleRateHz:2822400,channels:2,
    bitsPerSample:1,durationSeconds:32768/2822400,evidence:'bounded-parser-reported'});
  assert.equal(result.readEvidence.wholeAudioHash,false);assert.equal(result.readEvidence.wholeAudioDecode,false);
  assert(result.readEvidence.bytesRead < 1024);
  const start=events.find(e => e.type==='worker-start');assert(start && start.type==='worker-start');
  const exit=events.findIndex(e => e.type==='worker-exit'),release=events.findIndex(e => e.type==='lease-released');assert(exit>=0 && release>exit);
  assert.throws(() => fstatSync(start.fd),(e:unknown) => (e as NodeJS.ErrnoException).code==='EBADF');
  await reader.close();assert.equal(hash(await readFile(path.join(own,file))),hash(bytes));assert.equal(hash(await readFile(original)),hash(bytes));
});
test('MBM003元数据正常失败：启用资格不把伪DSF损坏payload或DST当成功',{timeout:20_000},async t => {
  const parent=buildStoragePolicy().check(process.env.TMPDIR!,{mustExist:true});const own=await mkdtemp(path.join(parent,'musicbridge-mbm003-invalid-'));await chmod(own,0o700);
  const root={...await authorizeSourceDirectory(own),id:randomUUID()}, reader=createMetadataReader({dsdMetadataEnabled:true});t.after(() => reader.close());
  const dsf=await readFile(new URL('../fixtures/mbrs003/dsd/synthetic-balanced-dsd64.dsf',import.meta.url));
  const dff=await readFile(new URL('../fixtures/mbrs003/dsd/synthetic-balanced-dsd64.dff',import.meta.url));dff.write('DST ',98);
  for(const [file,bytes,code] of [['truncated.dsf',dsf.subarray(0,200),'PARSE_FAILED'],['compressed.dff',dff,'UNSUPPORTED']] as const){
    await writeFile(path.join(own,file),bytes,{flag:'wx',mode:0o600});const result=await reader.read({root,relative:file,expectedSignature:(await readonlySourceCandidateMetadata(root,file)).signature});
    assert.equal(result.status,'failure');if(result.status==='failure')assert.equal(result.code,code);
  }
});
