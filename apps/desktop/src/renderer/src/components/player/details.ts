export function qualityName(quality?: string): string {
 return ({standard:'标准',exhigh:'高品质',lossless:'无损',hires:'Hi-Res',auto:'自动'} as Record<string,string>)[quality ?? ''] ?? '音质未知'
}
export function qualityDetails(value: {actualQuality?: string; format?: string; bitrate?: number}): string {
 const parts: string[] = []
 if (value.actualQuality && value.actualQuality !== 'unknown') parts.push(qualityName(value.actualQuality))
 if (value.format?.trim()) parts.push(value.format.trim().toUpperCase())
 if (value.bitrate && Number.isFinite(value.bitrate) && value.bitrate > 0) parts.push(`${Math.round(value.bitrate / 1000).toLocaleString('en-US')} kbps`)
 return parts.join(' · ') || '音质未知'
}
export function playbackPosition(anchor: number, elapsed: number, duration: number, playing: boolean): number {
 if (!Number.isFinite(duration) || duration <= 0) return 0
 return Math.min(duration, Math.max(0, anchor) + (playing ? Math.max(0, elapsed) : 0))
}
export function formatPlaybackTime(ms: number): string {
 const s = Number.isFinite(ms) ? Math.max(0, Math.floor(ms/1000)) : 0
 return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`
}

/** 标签说明数据来源；文件解析参数从不冒充实际Roon输出。 */
export function playbackSourceLabel(source?: string): string {
 return source === 'local_file' ? '本地音乐' : source === 'roon' ? 'Roon 本地' : source === 'netease' ? '网易云' : '来源未知'
}
export function audioQualityDetails(value: Pick<import('@music-bridge/contracts').PlaybackSnapshot, 'source' | 'local' | 'actualQuality' | 'format' | 'bitrate'>): {file: string; provider: string; output: string; evidence: string} {
 const p = value.source === 'local_file' ? value.local?.file_parameters : undefined
 const file = p ? `文件参数（解析报告）：${p.container} · ${p.codec} · ${p.sampleRateHz / 1000} kHz · ${p.bitsPerSample === null ? '位深未知' : `${p.bitsPerSample} bit`} · ${p.channels} 声道` : '文件参数未知'
 const provider = value.source === 'local_file' ? '本地原文件，未请求来源音质档位' : `来源返回：${qualityDetails(value)}`
 const axes = value.source === 'local_file' ? value.local?.quality : undefined
 const status = (v?: string) => v === 'NOT_TESTED' || !v ? '未测' : v === 'FAILED' || v === 'MISMATCH' ? '失败' : v === 'UNSUPPORTED' ? '不支持' : v === 'SAMPLE_VERIFIED' ? '受测样本字节已核验' : v === 'OBSERVED' ? '路径已观察' : '受测条件已核验'
 return { file, provider, output: 'Roon 实际输入、处理与输出：未知', evidence: `HTTP 字节 ${status(axes?.http_bytes)} · Signal Path ${status(axes?.signal_path)} · 数字输出 ${status(axes?.digital_output)} · 曲目边界 ${status(axes?.gapless)}` }
}
