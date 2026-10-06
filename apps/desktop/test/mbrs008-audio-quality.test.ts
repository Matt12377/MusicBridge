import assert from 'node:assert/strict';
import test from 'node:test';
import { audioQualityDetails, playbackSourceLabel, qualityDetails } from '../src/renderer/src/components/player/details.js';
import { snapshot } from '../../../packages/contracts/test/mbrs006/fixture.js';
test('008本地来源徽标明确本地音乐，cloud/native标签保持各自来源',()=>{
 assert.equal(playbackSourceLabel('local_file'),'本地音乐');assert.equal(playbackSourceLabel('netease'),'网易云');assert.equal(playbackSourceLabel('roon'),'Roon 本地');
});
test('008已知文件24/96只显示解析来源，Roon实际输出未知且四轴未测',()=>{
 const state=snapshot();state.local!.file_parameters={container:'FLAC',codec:'FLAC',sampleRateHz:96000,channels:2,bitsPerSample:24,durationMs:1000,lossless:true,evidence:'bounded-parser-reported'};
 const result=audioQualityDetails(state);assert.match(result.file,/解析报告.*96 kHz.*24 bit/u);assert.match(result.output,/未知/u);assert.equal(result.evidence.match(/未测/gu)?.length,4);assert.doesNotMatch(result.provider,/网易云/u);
});
test('008缺参数/换cloud不从扩展名、码率、偏好或旧local叶推文件参数/设备质量',()=>{
 const state=snapshot();assert.equal(audioQualityDetails({...state,format:'flac',actualQuality:'hires',bitrate:4608000}).file,'文件参数未知');
 state.local!.file_parameters={container:'FLAC',codec:'FLAC',sampleRateHz:96000,channels:2,bitsPerSample:24,durationMs:null,lossless:true,evidence:'bounded-parser-reported'};
 const cloud=audioQualityDetails({...state,source:'netease',actualQuality:'lossless',format:'flac',bitrate:1411200});assert.equal(cloud.file,'文件参数未知');assert.equal(cloud.provider,'来源返回：无损 · FLAC · 1,411 kbps');assert.equal(qualityDetails({format:'mp3'}),'MP3');assert.match(cloud.output,/未知/u);
});
