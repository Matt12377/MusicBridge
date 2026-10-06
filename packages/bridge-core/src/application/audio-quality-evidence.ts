import { isFileAudioParameters, type AudioQualityAxes, type FileAudioParameters } from '@music-bridge/contracts';
import { isMeasuredHttpByteAudit, type HttpByteAudit } from '../stream/http-byte-evidence.js';
import { isMeasuredPcmComparison, isMeasuredBoundaryAnalysis, type BoundaryAnalysis, type PcmComparison } from './pcm-evidence.js';
export function untestedAudioQuality():AudioQualityAxes { return {http_bytes:'NOT_TESTED',signal_path:'NOT_TESTED',digital_output:'NOT_TESTED',gapless:'NOT_TESTED'}; }
export function safeFileParameters(value:unknown):FileAudioParameters|undefined { return isFileAudioParameters(value)?{...value}:undefined; }
export interface AudioEvidenceScope { build:string; core:string; zone:string; outputs:readonly string[]; assetId:string; revision:string; sourceDigest:string; profile:FormatId; settingsDigest:string|null }
export type FormatId = 'FMT-01'|'FMT-02'|'FMT-03'|'FMT-04'|'FMT-05'|'FMT-06'|'FMT-07'|'FMT-08'|'FMT-09'|'FMT-10'|'FMT-11'|'FMT-12'|'FMT-13'|'FMT-14';
const formats:readonly FormatId[]=['FMT-01','FMT-02','FMT-03','FMT-04','FMT-05','FMT-06','FMT-07','FMT-08','FMT-09','FMT-10','FMT-11','FMT-12','FMT-13','FMT-14'];
const label=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_. -]{1,128}$/u.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
export function isAudioEvidenceScope(v:unknown):v is AudioEvidenceScope {
  if(!v||typeof v!=='object'||Array.isArray(v))return false;const s=v as Record<string,unknown>,keys=['build','core','zone','outputs','assetId','revision','sourceDigest','profile','settingsDigest'];
  return keys.every(k=>Object.hasOwn(s,k))&&Object.keys(s).every(k=>keys.includes(k))&&label(s.build)&&label(s.core)&&label(s.zone)&&label(s.assetId)
    &&typeof s.revision==='string'&&/^(0|[1-9]\d{0,19})$/u.test(s.revision)&&digest(s.sourceDigest)&&formats.includes(s.profile as FormatId)
    &&Array.isArray(s.outputs)&&s.outputs.length>=1&&s.outputs.length<=8&&s.outputs.every(label)&&new Set(s.outputs).size===s.outputs.length&&(s.settingsDigest===null||digest(s.settingsDigest));
}
function sameScope(a:AudioEvidenceScope,b:AudioEvidenceScope):boolean { return a.build===b.build&&a.core===b.core&&a.zone===b.zone&&a.assetId===b.assetId&&a.revision===b.revision&&a.sourceDigest===b.sourceDigest&&a.profile===b.profile&&a.settingsDigest===b.settingsDigest&&JSON.stringify([...a.outputs].sort())===JSON.stringify([...b.outputs].sort()); }
export interface SignalPathObservation {
  route:'native'|'direct'; input:{encoding:'PCM'|'DSD'|'UNKNOWN';sampleRateHz:number|null;bitsPerSample:number|null;channels:number|null};
  processing:{gainDb:number|null;volumeLeveling:'ENABLED'|'DISABLED'|'UNKNOWN';loudness:'KNOWN'|'UNKNOWN';replayGain:'ENABLED'|'DISABLED'|'UNKNOWN';dsp:readonly string[]|null;dsdConversion:'NONE'|'PCM'|'UNKNOWN'};
  output:{encoding:'PCM'|'DSD'|'UNKNOWN';sampleRateHz:number|null;bitsPerSample:number|null;channels:number|null};
}
const signalComparisons = new WeakSet<object>();
export function isMeasuredSignalPathComparison(value:unknown):value is SignalPathComparison {
 if(!value||typeof value!=='object'||!signalComparisons.has(value))return false;
 const v=value as SignalPathComparison,keys=['method','outcome','dsd','liveStatus',...(v.scope?['scope']:[])];
 return Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
}
export interface SignalPathComparison { method:'paired-signal-path-record-v1';scope?:AudioEvidenceScope;outcome:'OBSERVED'|'MISMATCH'|'INSUFFICIENT'|'INVALID'; dsd:{received:'DSD'|'PCM'|'UNKNOWN';converted:'NONE'|'PCM'|'UNKNOWN';output:'DSD'|'PCM'|'UNKNOWN'}; liveStatus:'NOT_TESTED' }
function validSignal(v:SignalPathObservation):boolean {
  const validFormat=(f:SignalPathObservation['input'])=>f&&['PCM','DSD','UNKNOWN'].includes(f.encoding)&&Object.keys(f).length===4&&[f.sampleRateHz,f.bitsPerSample,f.channels].every(n=>n===null||typeof n==='number'&&Number.isSafeInteger(n)&&n>0&&n<=1_000_000_000);
  const p=v?.processing;return !!v&&['native','direct'].includes(v.route)&&Object.keys(v).length===4&&validFormat(v.input)&&validFormat(v.output)&&!!p&&Object.keys(p).length===6
    &&(p.gainDb===null||Number.isFinite(p.gainDb)&&Math.abs(p.gainDb)<=200)&&['ENABLED','DISABLED','UNKNOWN'].includes(p.volumeLeveling)&&['KNOWN','UNKNOWN'].includes(p.loudness)
    &&['ENABLED','DISABLED','UNKNOWN'].includes(p.replayGain)&&['NONE','PCM','UNKNOWN'].includes(p.dsdConversion)&&(p.dsp===null||Array.isArray(p.dsp)&&p.dsp.length<=32&&p.dsp.every(label));
}
/** 比较原件的闭合记录，不伪造SDK输出接口；人工/API记录本身仍不是live授权。 */
export function compareSignalPaths(native:SignalPathObservation,direct:SignalPathObservation,nativeScope?:AudioEvidenceScope,directScope?:AudioEvidenceScope):SignalPathComparison {
  const encoding=(v:unknown):'PCM'|'DSD'|'UNKNOWN'=>v==='PCM'||v==='DSD'?v:'UNKNOWN';
  const conversion=(v:unknown):'NONE'|'PCM'|'UNKNOWN'=>v==='NONE'||v==='PCM'?v:'UNKNOWN';
  const dsd={received:encoding(direct?.input?.encoding),converted:conversion(direct?.processing?.dsdConversion),output:encoding(direct?.output?.encoding)};
  const scope=nativeScope&&directScope&&isAudioEvidenceScope(nativeScope)&&isAudioEvidenceScope(directScope)&&sameScope(nativeScope,directScope)?structuredClone(nativeScope):undefined;
  const result=(outcome:SignalPathComparison['outcome']):SignalPathComparison=>{
    const value:SignalPathComparison={method:'paired-signal-path-record-v1',outcome,dsd,liveStatus:'NOT_TESTED',...(scope?{scope}:{})};
    Object.freeze(value.dsd);if(value.scope){Object.freeze(value.scope.outputs);Object.freeze(value.scope);}Object.freeze(value);signalComparisons.add(value);return value;
  };
  if(!validSignal(native)||!validSignal(direct)||native.route!=='native'||direct.route!=='direct')return result('INVALID');
  if(!scope || scope.settingsDigest===null)return result('INSUFFICIENT');
  const known=(v:SignalPathObservation)=>![v.input.encoding,v.output.encoding,v.processing.volumeLeveling,v.processing.loudness,v.processing.replayGain,v.processing.dsdConversion].includes('UNKNOWN')
    &&[v.input.sampleRateHz,v.input.bitsPerSample,v.input.channels,v.output.sampleRateHz,v.output.bitsPerSample,v.output.channels,v.processing.gainDb,v.processing.dsp].every(n=>n!==null);
  if(!known(native)||!known(direct))return result('INSUFFICIENT');
  return result(JSON.stringify([native.input.encoding,native.input.sampleRateHz,native.input.bitsPerSample,native.input.channels,native.processing.gainDb,native.processing.volumeLeveling,native.processing.loudness,native.processing.replayGain,native.processing.dsp,native.processing.dsdConversion,native.output.encoding,native.output.sampleRateHz,native.output.bitsPerSample,native.output.channels])===JSON.stringify([direct.input.encoding,direct.input.sampleRateHz,direct.input.bitsPerSample,direct.input.channels,direct.processing.gainDb,direct.processing.volumeLeveling,direct.processing.loudness,direct.processing.replayGain,direct.processing.dsp,direct.processing.dsdConversion,direct.output.encoding,direct.output.sampleRateHz,direct.output.bitsPerSample,direct.output.channels])?'OBSERVED':'MISMATCH');
}
export type AudioEvidenceRecord = {scope:AudioEvidenceScope;id:string;origin:'synthetic'|'private-record';measurement:
  {axis:'http_bytes';result:HttpByteAudit}|{axis:'signal_path';result:SignalPathComparison}|{axis:'digital_output';result:PcmComparison}|{axis:'gapless';result:BoundaryAnalysis}};
const assessmentsMade = new WeakSet<object>();
export interface AudioQualityAssessment { scope:AudioEvidenceScope;quality:AudioQualityAxes;analyses:Partial<Record<keyof AudioQualityAxes,string>>;limitations:string[];endToEndBitExact:false }
/** 有界私有consumer，运行时真实四轴无入口自报绿色。软件分析与live状态分开。 */
export function assessAudioQuality(scope:AudioEvidenceScope,records:readonly AudioEvidenceRecord[]):AudioQualityAssessment {
  if(!isAudioEvidenceScope(scope)||!Array.isArray(records)||records.length>64)throw new Error('质量证据scope或64条预算无效。');
  const quality=untestedAudioQuality(),analyses:AudioQualityAssessment['analyses']={},limitations:string[]=[];
  for(const record of records as readonly AudioEvidenceRecord[]){
    if(!record||!label(record.id)||!['synthetic','private-record'].includes(record.origin)||!isAudioEvidenceScope(record.scope)||!sameScope(scope,record.scope)){limitations.push('证据scope不匹配');continue;}
    if(!record.measurement || !['http_bytes','signal_path','digital_output','gapless'].includes(record.measurement.axis)){limitations.push('证据轴无效');continue;}
    const {axis,result}=record.measurement;
    let outcome:string;
    if(axis==='http_bytes'){
      if(!isMeasuredHttpByteAudit(result)||result.sourceDigest!==scope.sourceDigest){limitations.push('缺实际字节审计或源身份不匹配');continue;}
      outcome=result.verified?'MATCH':'MISMATCH';quality.http_bytes=result.verified?'SAMPLE_VERIFIED':'FAILED';
    }else {
      const measured=axis==='signal_path'?isMeasuredSignalPathComparison(result):axis==='digital_output'?isMeasuredPcmComparison(result):isMeasuredBoundaryAnalysis(result);
      if(!measured){limitations.push('缺受控轴分析器原件');continue;}
      if(axis==='signal_path'&&(!isMeasuredSignalPathComparison(result)||!result.scope||!sameScope(scope,result.scope))){limitations.push('Signal Path原件配对scope不匹配');continue;}
      outcome=result.outcome;limitations.push('私有离线/观察记录未认证真实设备层');if(scope.settingsDigest===null)limitations.push('测试设置未知');}
    // 任一次失败不被后续成功冲掉，也不丢失本轮负例。
    const severity:Record<string,number>={MATCH:1,OBSERVED:1,INSUFFICIENT:2,UNSUPPORTED:3,INVALID:4,MISMATCH:5};
    const old=analyses[axis];if(!old || severity[outcome]!>=severity[old]!)analyses[axis]=outcome;
    if(axis==='http_bytes'&&old==='MISMATCH')quality.http_bytes='FAILED';
  }
  const result:AudioQualityAssessment={scope:structuredClone(scope),quality,analyses,limitations:[...new Set(limitations)],endToEndBitExact:false};
  Object.freeze(result.scope.outputs);Object.freeze(result.scope);Object.freeze(result.quality);Object.freeze(result.analyses);Object.freeze(result.limitations);Object.freeze(result);assessmentsMade.add(result);return result;
}
export const FORMAT_CAPABILITY_AXES = ['metadata_read','http_raw_file','audioinput_play','pause_resume','seek','sequential','gapless','exact_segment','source_format_preserved','signal_path_observed','digital_output_verified','tag_write'] as const;
export function formatCapabilityMatrix(assessments:readonly AudioQualityAssessment[]) {
  if(assessments.length>64||assessments.some(a=>!assessmentsMade.has(a)||!isAudioEvidenceScope(a.scope)))throw new Error('能力矩阵输入无效。');
  return formats.map(id=>({id,statusByAxis:Object.fromEntries(FORMAT_CAPABILITY_AXES.map(axis=>[axis,id==='FMT-14'&&axis==='exact_segment'?'UNSUPPORTED':'NOT_TESTED'])),evidence:assessments.filter(a=>a.scope.profile===id).map(a=>({scope:structuredClone(a.scope),statusByAxis:Object.fromEntries(FORMAT_CAPABILITY_AXES.map(axis=>[axis,
    axis==='http_raw_file'?a.quality.http_bytes==='SAMPLE_VERIFIED'?'SOFTWARE_VERIFIED':a.quality.http_bytes==='FAILED'?'SOFTWARE_FAILED':'NOT_TESTED':axis==='gapless'&&a.analyses.gapless==='MISMATCH'?'SOFTWARE_FAILED':axis==='exact_segment'&&id==='FMT-14'?'UNSUPPORTED':'NOT_TESTED'])),limitations:[...a.limitations]})),
    untestedAxes:FORMAT_CAPABILITY_AXES.filter(axis=>axis!=='exact_segment'||id!=='FMT-14'),...(id==='FMT-14'?{exactSegment:'UNSUPPORTED' as const}:{})}));
}
export interface SettingsRecord { authorized:boolean;zone:string;outputs:readonly string[];before:Readonly<Record<string,number>>|null;after:Readonly<Record<string,number>>|null;restored:Readonly<Record<string,number>>|null;safeMin:number;safeMax:number }
/** 仅检查私有授权/回读记录；不发送音量/DSP命令，不把finally请求当恢复完成。 */
export function evaluateSettingsRecord(v:SettingsRecord):'NOT_AUTHORIZED'|'INSUFFICIENT'|'RESTORE_FAILED'|'RECORD_CONSISTENT' {
  if(!v||v.authorized!==true)return 'NOT_AUTHORIZED';
  if(!label(v.zone)||!Array.isArray(v.outputs)||v.outputs.length<1||v.outputs.length>8||!v.outputs.every(label)||new Set(v.outputs).size!==v.outputs.length||!Number.isFinite(v.safeMin)||!Number.isFinite(v.safeMax)||v.safeMin>v.safeMax)return 'INSUFFICIENT';
  const known=(values:SettingsRecord['before'])=>values!==null&&Object.keys(values).length===v.outputs.length&&v.outputs.every(id=>Object.hasOwn(values,id)&&Number.isFinite(values[id])&&values[id]!>=v.safeMin&&values[id]!<=v.safeMax);
  if(!known(v.before)||!known(v.after)||!known(v.restored))return 'INSUFFICIENT';
  return v.outputs.every(id=>v.before![id]===v.restored![id])?'RECORD_CONSISTENT':'RESTORE_FAILED';
}
