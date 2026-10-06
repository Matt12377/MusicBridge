const comparisons = new WeakSet<object>(), boundaries = new WeakSet<object>();
function closed(value:object,keys:readonly string[]):boolean{return Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
export function isMeasuredPcmComparison(value:unknown):value is PcmComparison { return !!value&&typeof value==='object'&&comparisons.has(value)&&closed(value,['method','outcome','frames','offsetFrames','changedSamples','firstChangedSample','reason']); }
export function isMeasuredBoundaryAnalysis(value:unknown):value is BoundaryAnalysis { return !!value&&typeof value==='object'&&boundaries.has(value)&&closed(value,['method','outcome','trials','issues','reason','liveGapless']); }
function comparisonResult(value:PcmComparison):PcmComparison { Object.freeze(value);comparisons.add(value);return value; }
function boundaryResult(value:BoundaryAnalysis):BoundaryAnalysis { value.trials.forEach(Object.freeze);value.issues.forEach(Object.freeze);Object.freeze(value.trials);Object.freeze(value.issues);Object.freeze(value);boundaries.add(value);return value; }
export const PCM_MAX_FRAMES = 65_536;
export interface PcmWindow { sampleRateHz: number; channels: 2; bitsPerSample: 16 | 24 | 32; samples: Int32Array }
export type PcmOutcome = 'MATCH' | 'MISMATCH' | 'INSUFFICIENT' | 'UNSUPPORTED' | 'INVALID';
export interface PcmComparison { method:'integer-pcm-window-v1'; outcome:PcmOutcome; frames:number; offsetFrames:number; changedSamples:number; firstChangedSample:number|null; reason:string|null }
function valid(v:PcmWindow):boolean {
  if(!v || !Number.isSafeInteger(v.sampleRateHz) || v.sampleRateHz<1 || v.sampleRateHz>1_000_000 || v.channels!==2 || ![16,24,32].includes(v.bitsPerSample)
    || !(v.samples instanceof Int32Array) || !v.samples.length || v.samples.length%2!==0 || v.samples.length/2>PCM_MAX_FRAMES)return false;
  const min=-(2**(v.bitsPerSample-1)),max=2**(v.bitsPerSample-1)-1;return v.samples.every(n=>n>=min && n<=max);
}
function excited(v:PcmWindow):boolean {
  const lowMask=v.bitsPerSample===32?65535:v.bitsPerSample===24?255:1;
  let different=false;
  for(let channel=0;channel<2;channel++){
    let changes=false,low=false,nonzero=false;
    for(let i=channel;i<v.samples.length;i+=2){const n=v.samples[i]!;changes ||= n!==v.samples[channel];low ||= (n&lowMask)!==0;nonzero ||= n!==0;if(channel===0)different ||= n!==v.samples[i+1];}
    if(!changes || !low || !nonzero)return false;
  }
  return different;
}
/** 明确的整数帧偏移，不进行重采样、幅度修正或内容驱动任意剪裁。 */
export function comparePcm(reference:PcmWindow,capture:PcmWindow,offsetFrames=0):PcmComparison {
  const result=(outcome:PcmOutcome,reason:string|null,changedSamples=0,firstChangedSample:number|null=null):PcmComparison=>comparisonResult({method:'integer-pcm-window-v1',outcome,frames:valid(reference)?reference.samples.length/2:0,offsetFrames,changedSamples,firstChangedSample,reason});
  if(!valid(reference)||!valid(capture)||!Number.isSafeInteger(offsetFrames)||offsetFrames<0||offsetFrames>PCM_MAX_FRAMES)return result('INVALID','参数或预算无效');
  if(reference.sampleRateHz!==capture.sampleRateHz||reference.bitsPerSample!==capture.bitsPerSample)return result('UNSUPPORTED','采样率/位深不一致，不转换验证');
  if(!excited(reference))return result('INSUFFICIENT','参考缺非静音双声道及有效低位激励');
  if(capture.samples.length<reference.samples.length+offsetFrames*2)return result('MISMATCH','捕获帧不足');
  let changed=0,first:number|null=null;
  for(let i=0;i<reference.samples.length;i++)if(reference.samples[i]!==capture.samples[i+offsetFrames*2]){changed++;first??=i;}
  return result(changed?'MISMATCH':'MATCH',changed?'逐样本差异':null,changed,first);
}
export interface BoundaryTrial { capture:PcmWindow; native:PcmWindow; alignmentErrorFrames:number }
export interface BoundaryMeasurement { trialIndex:number; lostFrames:number; insertedSilenceFrames:number; repeatedFrames:number; extraFrames:number; changedSamples:number; maxAbsoluteDifference:number; nativeChangedSamples:number }
export interface BoundaryIssue { trialIndex:number;outcome:'INVALID'|'UNSUPPORTED'|'INSUFFICIENT';reason:string }
export interface BoundaryAnalysis { method:'anchored-pcm-boundary-v1'; outcome:PcmOutcome; trials:BoundaryMeasurement[]; issues:BoundaryIssue[]; reason:string|null; liveGapless:'NOT_TESTED' }
function findMarker(v:Int32Array,marker:Int32Array):number|null {
  let found:number|null=null;
  for(let at=0;at<=v.length-marker.length;at+=2){let match=true;for(let i=0;i<marker.length;i++)if(v[at+i]!==marker[i]){match=false;break;}if(match){if(found!==null)return null;found=at/2;}}
  return found;
}
/** 同clock、同格式、唯一锚点；保留逐次最坏失败。跨格式relock不走gapless算法。 */
export function analyzeBoundaries(reference:PcmWindow,boundaryFrame:number,trials:readonly BoundaryTrial[]):BoundaryAnalysis {
  const issues:BoundaryIssue[]=[];
  const result=(outcome:PcmOutcome,reason:string|null,measurements:BoundaryMeasurement[]=[]):BoundaryAnalysis=>boundaryResult({method:'anchored-pcm-boundary-v1',outcome,trials:measurements,issues,reason,liveGapless:'NOT_TESTED'});
  if(!valid(reference)||!Number.isSafeInteger(boundaryFrame)||boundaryFrame<16||boundaryFrame+16>reference.samples.length/2||trials.length<3||trials.length>16)return result('INVALID','边界参数或3至16重复预算无效');
  if(!excited(reference))return result('INSUFFICIENT','边界参考缺有效激励');
  const left=reference.samples.slice((boundaryFrame-16)*2,(boundaryFrame-8)*2),right=reference.samples.slice((boundaryFrame+8)*2,(boundaryFrame+16)*2);
  const expected=reference.samples.slice((boundaryFrame-8)*2,(boundaryFrame+8)*2),measurements:BoundaryMeasurement[]=[];
  for(const [trialIndex,trial] of trials.entries()){
    if(!valid(trial.capture)||!valid(trial.native)||!Number.isFinite(trial.alignmentErrorFrames)||trial.alignmentErrorFrames<0){issues.push({trialIndex,outcome:'INVALID',reason:'捕获/native参数无效'});continue;}
    if([trial.capture,trial.native].some(v=>v.sampleRateHz!==reference.sampleRateHz||v.bitsPerSample!==reference.bitsPerSample)){issues.push({trialIndex,outcome:'UNSUPPORTED',reason:'跨格式或采样率relock须单列'});continue;}
    if(trial.alignmentErrorFrames!==0){issues.push({trialIndex,outcome:'INSUFFICIENT',reason:'时钟对齐误差覆盖零帧阈值'});continue;}
    const positions=[trial.capture,trial.native].map(v=>[findMarker(v.samples,left),findMarker(v.samples,right)] as const);
    if(positions.some(([a,b])=>a===null||b===null||b<a+8)){issues.push({trialIndex,outcome:'INSUFFICIENT',reason:'边界锚点缺失或不唯一'});continue;}
    const [a,b]=positions[0]!,[na,nb]=positions[1]!;
    const actual=trial.capture.samples.slice((a!+8)*2,b!*2),native=trial.native.samples.slice((na!+8)*2,nb!*2),delta=actual.length/2-16;
    let changed=Math.abs(actual.length-expected.length),nativeChanged=Math.abs(native.length-expected.length),maxDifference=0;
    for(let i=0;i<Math.min(actual.length,expected.length);i++)if(actual[i]!==expected[i]){changed++;maxDifference=Math.max(maxDifference,Math.abs(actual[i]!-expected[i]!));}
    for(let i=0;i<Math.min(native.length,expected.length);i++)if(native[i]!==expected[i])nativeChanged++;
    const insertion=delta>0?actual.slice(16,16+delta*2):new Int32Array();
    let insertedSilenceFrames=0,repeatedFrames=0;
    if(delta>0 && insertion.every(n=>n===0))insertedSilenceFrames=delta;
    else if(delta>0 && delta<=8 && insertion.every((n,i)=>n===expected[16-delta*2+i]))repeatedFrames=delta;
    measurements.push({trialIndex,lostFrames:Math.max(0,-delta),insertedSilenceFrames,repeatedFrames,extraFrames:Math.max(0,delta),changedSamples:changed,maxAbsoluteDifference:maxDifference,nativeChangedSamples:nativeChanged});
  }
  const failed=measurements.some(m=>m.changedSamples || m.nativeChangedSamples);
  const uncertain=issues.find(issue=>issue.outcome==='INVALID')??issues.find(issue=>issue.outcome==='UNSUPPORTED')??issues[0];
  return result(failed?'MISMATCH':uncertain?.outcome??'MATCH',failed?(measurements.some(m=>m.nativeChangedSamples)?'原生基线也存在差异，不能掩盖':'已测边界差异，逐次限制另列'):uncertain?.reason??null,measurements);
}
