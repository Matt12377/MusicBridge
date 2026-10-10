/** 文件解析报告，不是Roon实际输出或设备位精确证明。 */
export interface FileAudioParameters {
  container: 'FLAC' | 'MPEG' | 'MP4' | 'WAVE' | 'AIFF' | 'DSF' | 'DFF'; codec: string; lossless: boolean | null;
  sampleRateHz: number; channels: number; bitsPerSample: number | null; durationMs: number | null;
  evidence: 'bounded-parser-reported';
}
export interface AudioQualityAxes {
  http_bytes: 'NOT_TESTED' | 'SAMPLE_VERIFIED' | 'FAILED';
  signal_path: 'NOT_TESTED' | 'OBSERVED' | 'MISMATCH';
  digital_output: 'NOT_TESTED' | 'TEST_CONDITIONS_VERIFIED' | 'FAILED';
  gapless: 'NOT_TESTED' | 'TEST_CONDITIONS_VERIFIED' | 'UNSUPPORTED' | 'FAILED';
}
export function isFileAudioParameters(value: unknown): value is FileAudioParameters {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, keys = ['container','codec','lossless','sampleRateHz','channels','bitsPerSample','durationMs','evidence'];
  const integer = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
  return keys.every(k => Object.hasOwn(v,k)) && Object.keys(v).every(k => keys.includes(k))
    && ['FLAC','MPEG','MP4','WAVE','AIFF','DSF','DFF'].includes(v.container as string)
    && (!['DSF','DFF'].includes(v.container as string) || v.codec === 'DSD' && v.bitsPerSample === 1
      && v.lossless === true && [2822400,3072000,5644800,6144000,11289600,12288000,22579200,24576000].includes(v.sampleRateHz as number)
      && integer(v.channels,1,6))
    && typeof v.codec === 'string' && /^[A-Za-z0-9 ()_.+-]{1,64}$/u.test(v.codec)
    && (v.lossless === null || typeof v.lossless === 'boolean') && integer(v.sampleRateHz,1,1_000_000_000) && integer(v.channels,1,64)
    && (v.bitsPerSample === null || integer(v.bitsPerSample,1,64)) && (v.durationMs === null || integer(v.durationMs,0,Number.MAX_SAFE_INTEGER))
    && v.evidence === 'bounded-parser-reported';
}
