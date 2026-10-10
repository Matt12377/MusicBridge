import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readDsdContainerFacts, DsdContainerError } from '../../dist/library/dsd-container-facts.js';
import { isScanReadFacts } from '../../dist/collection/local-scan-store.js';

const fixtures = new URL('../fixtures/mbrs003/dsd/',import.meta.url);
async function inspect(bytes: Uint8Array) {
  const reads: {at:number;n:number}[] = [];
  const facts = await readDsdContainerFacts(bytes.length,async (at,n) => { reads.push({at,n});return bytes.subarray(at,at+n); });
  return {facts,reads};
}
const copy = (b: Uint8Array) => Buffer.from(b);
const rejected = (b: Uint8Array, code: DsdContainerError['code'] = 'PARSE_FAILED') =>
  assert.rejects(inspect(b),(e:unknown) => e instanceof DsdContainerError && e.code === code);

test('MBM003容器事实：DSF与DFF实际头、完整边界及1-bit clock，不读取音频载荷',async () => {
  for (const ext of ['dsf','dff']) {
    const bytes = await readFile(new URL(`synthetic-balanced-dsd64.${ext}`,fixtures));
    const {facts,reads} = await inspect(bytes);
    assert.equal(facts.sampleRateHz,2_822_400);assert.equal(facts.bitsPerSample,1);assert.equal(facts.channels,2);
    assert.equal(facts.oneBitSamples,32_768);assert.equal(facts.dataBytes,8_192);
    assert.equal(facts.durationSeconds,32_768/2_822_400);
    assert(reads.every(({at,n}) => at+n <= facts.dataOffset || at >= facts.dataOffset+facts.dataBytes));
    assert(reads.reduce((n,r) => n+r.n,0) < 256);
  }
});
test('MBM003容器真实规格：八clock与实际六声道；DSF packing8仍1-bit',async () => {
  const base = await readFile(new URL('synthetic-balanced-dsd64.dsf',fixtures));
  for (const rate of [2822400,3072000,5644800,6144000,11289600,12288000,22579200,24576000]) {
    const b = copy(base);b.writeUInt32LE(rate,56);b.writeUInt32LE(8,60);
    const {facts} = await inspect(b);assert.equal(facts.sampleRateHz,rate);assert.equal(facts.bitsPerSample,1);assert.equal(facts.bitOrder,'msbf-planar');
  }
  const multi = Buffer.alloc(92+4096*6);base.copy(multi,0,0,92);multi.writeBigUInt64LE(BigInt(multi.length),12);
  multi.writeUInt32LE(7,48);multi.writeUInt32LE(6,52);multi.writeBigUInt64LE(BigInt(12+4096*6),84);
  const {facts} = await inspect(multi);assert.equal(facts.channels,6);assert.equal(facts.dataBytes,4096*6);
});
test('MBM003容器拒绝：伪扩展名、PCM时钟、未知频率、packing和声道布局',async () => {
  const base = await readFile(new URL('synthetic-balanced-dsd64.dsf',fixtures));
  for (const [at,value] of [[56,352800],[56,2822401],[52,7],[60,16],[48,99]]) {
    const b=copy(base);b.writeUInt32LE(value!,at!);await rejected(b,'UNSUPPORTED');
  }
  const mismatch=copy(base);mismatch.writeUInt32LE(1,48);await rejected(mismatch);
  const pcm=copy(base);pcm.write('RIFF',0);await rejected(pcm,'UNSUPPORTED');
});
test('MBM003 DSF完整边界：截尾、假长度、sample/payload及尾部ID3指针拒绝',async () => {
  const base = await readFile(new URL('synthetic-balanced-dsd64.dsf',fixtures));
  await rejected(base.subarray(0,base.length-1));
  for (const [at,value] of [[4,29n],[12,BigInt(base.length+1)],[20,93n],[64,32776n],[84,8205n]] as const) {
    const b=copy(base);b.writeBigUInt64LE(value!,at!);await rejected(b);
  }
  const block=copy(base);block.writeUInt32LE(2048,72);await rejected(block);
  const reserved=copy(base);reserved.writeUInt32LE(1,76);await rejected(reserved);
  const withTag=Buffer.concat([base,Buffer.from([73,68,51,3,0,0,0,0,0,0])]);withTag.writeBigUInt64LE(BigInt(withTag.length),12);withTag.writeBigUInt64LE(BigInt(base.length),20);
  assert.equal((await inspect(withTag)).facts.dataBytes,8192);
});
test('MBM003 DFF闭合：DST、重复属性、错FORM/required chunk和padding拒绝',async () => {
  const base=await readFile(new URL('synthetic-balanced-dsd64.dff',fixtures));
  const dst=copy(base);dst.write('DST ',98);await rejected(dst,'UNSUPPORTED');
  const wrongForm=copy(base);wrongForm.write('WAVE',12);await rejected(wrongForm,'UNSUPPORTED');
  const missingVersion=copy(base);missingVersion.write('JUNK',16);await rejected(missingVersion);
  const badClock=copy(base);badClock.writeUInt32BE(352800,60);await rejected(badClock,'UNSUPPORTED');
  const badChannels=copy(base);badChannels.writeUInt16BE(7,76);await rejected(badChannels,'UNSUPPORTED');
  const payload=copy(base);payload.writeBigUInt64BE(8191n,110);await rejected(payload);
  const tail=Buffer.concat([base,Buffer.from([1])]);tail.writeBigUInt64BE(BigInt(tail.length-12),4);await rejected(tail);
});
test('MBM003容器受限读取：截短FD与大量未知chunk不能取得成功或无界分配',async () => {
  const base=await readFile(new URL('synthetic-balanced-dsd64.dff',fixtures));
  await assert.rejects(readDsdContainerFacts(base.length,async (at,n) => base.subarray(at,at+n-1)),DsdContainerError);
  const head=copy(base.subarray(0,32)), junk=Buffer.alloc(12);junk.write('JUNK',0);
  const b=Buffer.concat([head,...Array.from({length:2049},() => junk)]);b.writeBigUInt64BE(BigInt(b.length-12),4);
  await rejected(b,'BUDGET_EXCEEDED');
});
test('MBM003冷扫描事实：DSF/DFF必须保留实际DSD三轴，矛盾PCM与未知事实拒绝',() => {
  const facts = {technical:{container:'DSF',codec:'DSD',lossless:true,sampleRateHz:2822400,channels:2,bitsPerSample:1,
    durationSeconds:32768/2822400,evidence:'bounded-parser-reported'},coverEvidence:[],readEvidence:{bytesRead:192,readCalls:3,
    maxReadBytes:92,allocationBytes:1024,elapsedMs:1,wholeAudioHash:false,wholeAudioDecode:false}};
  assert.equal(isScanReadFacts(facts),true);assert.equal(isScanReadFacts({...facts,technical:{...facts.technical,container:'DFF'}}),true);
  for (const extra of [{codec:'PCM'},{lossless:false},{sampleRateHz:48000},{sampleRateHz:2822401},{channels:7},
    {channels:1.5},{bitsPerSample:null},{bitsPerSample:8},{durationSeconds:null},{durationSeconds:0}])
    assert.equal(isScanReadFacts({...facts,technical:{...facts.technical,...extra}}),false);
  assert.equal(isScanReadFacts({...facts,technical:{...facts.technical,container:'FLAC',codec:'FLAC',sampleRateHz:192000,bitsPerSample:24}}),true);
});
