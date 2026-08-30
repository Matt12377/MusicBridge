import { isAudioConversionPlan, isAudioConversionSource, type AudioConversionPlan, type AudioConversionReceipt } from '@music-bridge/contracts';
import type { FfmpegConverter } from '../../src/recording/audio-converter.js';
import { withVerifiedReadonlySource } from '../../src/recording/source-files.js';
import { pcmWaveHeader, inspectConversionOutput } from '../../src/recording/execution-wave.js';
import { mediaFingerprint } from '../../src/recording/media-store.js';

/** 只验证任务/文件编排：生成合成静音，绝不作为 SRC 或真实解码质量证据。 */
export function conversionFixture(): FfmpegConverter {
  const identity = { id:'fixture', version:'1', binarySha256:'a'.repeat(64), buildSha256:'b'.repeat(64), components:[{name:'fixture',version:'1'}] };
  return {
    identity,
    plan(source,format) {
      if (!isAudioConversionSource(source)) throw new Error('合成源合同无效');
      const plan: AudioConversionPlan = {schemaVersion:1,input:structuredClone(source),format:structuredClone(format),converter:identity,processing:{sourceExtent:'whole-input',inputStreamIndex:0,gain:'unchanged',timestampCompensation:'disabled',parameters:[]},formalReady:false};
      if (!isAudioConversionPlan(plan)) throw new Error('合成转换计划无效');
      return plan;
    },
    async convert(plan,location,destination,signal,check = () => undefined) {
      return withVerifiedReadonlySource(location.root,location.relative,plan.input,signal,async () => {
        check(); signal.throwIfAborted();
        if ((await destination.stat()).size !== 0 || plan.format.outputSampleFormat === 'pcm-f32le') throw new Error('合成夹具只接空整数目标');
        const source=plan.input.technical, frames=Math.ceil(source.sampleFrames * plan.format.sampleRate/source.sampleRate), bits=Number(plan.format.outputSampleFormat.slice(5,7));
        const data=Buffer.alloc(frames*plan.format.channelCount*bits/8);
        await destination.writeFile(Buffer.concat([pcmWaveHeader(plan.format.sampleRate,plan.format.channelCount,bits,frames),data,Buffer.alloc(data.length%2)])); await destination.sync();
        const audio=await inspectConversionOutput(destination,plan.format,signal,check);
        const receipt: AudioConversionReceipt={plan,planHash:mediaFingerprint(plan),decoded:{codec:'fixture-pcm',sampleRate:source.sampleRate,channelCount:source.channels as 1|2,sampleFormat:'s16',frameCount:source.sampleFrames,wholeInputConsumed:true},audio,formalReady:false};
        check(); return receipt;
      },check);
    },
  };
}
