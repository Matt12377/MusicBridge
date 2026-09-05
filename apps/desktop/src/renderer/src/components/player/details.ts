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
