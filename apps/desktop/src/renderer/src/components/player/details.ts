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
export function audioQualityDetails(value: Pick<import('@music-bridge/contracts').PlaybackSnapshot, 'source' | 'local' | 'actualQuality' | 'format' | 'bitrate'> & Partial<Pick<import('@music-bridge/contracts').PlaybackSnapshot, 'currentTrack' | 'queue'>>): {file: string; provider: string; output: string; evidence: string} {
 const selected = value.queue?.items[value.queue.index]?.local
 const current = value.source === 'local_file' && value.currentTrack?.id === value.local?.local_track_id && (!selected || selected.asset_id === value.local?.asset_id && selected.asset_revision === value.local?.asset_revision)
 const p = current ? value.local?.file_parameters : undefined
 const file = p ? `文件参数（解析报告）：${p.container} · ${p.codec} · ${p.sampleRateHz / 1000} kHz · ${p.bitsPerSample === null ? '位深未知' : `${p.bitsPerSample} bit`} · ${p.channels} 声道` : '文件参数未知'
 const provider = value.source === 'local_file' ? '本地原文件，未请求来源音质档位' : `来源返回：${qualityDetails(value)}`
 const axes = current ? value.local?.quality : undefined
 const status = (v?: string) => v === 'NOT_TESTED' || !v ? '未测' : v === 'FAILED' || v === 'MISMATCH' ? '失败' : v === 'UNSUPPORTED' ? '不支持' : v === 'SAMPLE_VERIFIED' ? '受测样本字节已核验' : v === 'OBSERVED' ? '路径已观察' : '受测条件已核验'
 return { file, provider, output: 'Roon 实际输入、处理与输出：未知', evidence: `HTTP 字节 ${status(axes?.http_bytes)} · Signal Path ${status(axes?.signal_path)} · 数字输出 ${status(axes?.digital_output)} · 曲目边界 ${status(axes?.gapless)}` }
}

export interface LocalLibraryPlayReceipt {
 request: import('@music-bridge/contracts').LocalPlayRequest
 result: import('@music-bridge/contracts').LocalPlayAccepted | import('@music-bridge/contracts').LocalSourceUnsupported | null
 outcome?: 'pending' | 'received' | 'unknown'
}
/** 当前公开观察与最近请求分别呈现；受理、队列变更或字节发送不能生成 Playing。 */
export function localLibraryPlaybackStatus(snapshot: import('@music-bridge/contracts').PlaybackSnapshot | null, receipt: LocalLibraryPlayReceipt | null): {state: string; delivery: string; request: string} {
 const request = receipt?.request, local = snapshot?.local
 const same = local && request && local.request_id === request.request_id && local.local_track_id === request.local_track_id && local.asset_id === request.asset_id && local.asset_revision === request.expected_asset_revision
  && local.target.core_id === request.target.core_id && local.target.zone_id === request.target.zone_id
 let recent = receipt?.result?.status === 'accepted' ? request?.action === 'PLAY_NOW' ? '最近点播已受理，等待 Roon 观察确认' : '最近 MB 队列操作已受理，播放状态由原播放器确认'
  : receipt?.result?.status === 'unsupported' ? '最近请求不支持原文件直送' : receipt?.outcome === 'pending' ? '最近请求已派发，等待受理回执' : receipt ? '最近请求结果未知，核对原播放器；暂不重复提交' : '本页尚无最近点播请求'
 const current = snapshot?.source === 'local_file' && snapshot.currentTrack?.id === local?.local_track_id && (!snapshot.selectedZoneId || snapshot.selectedZoneId === local?.target.zone_id)
 const selected = snapshot?.queue.items[snapshot.queue.index]
 const identity = current && (!selected || selected.resolvedSource === 'local_file' && selected.trackId === local?.local_track_id && selected.local?.local_track_id === local?.local_track_id && selected.local.asset_id === local?.asset_id && selected.local.asset_revision === local?.asset_revision)
 const observed = identity && local?.ownership === 'MB_OWNED' && local.queue_owner === 'MB' && local.roon_observation.observed && local.roon_observation.correlation === 'ATTEMPT_CONFIRMED'
 const phases: Record<NonNullable<typeof local>['phase'], string> = {PREPARING:'正在准备原文件',SUBMITTING:'正在提交 Roon',AWAITING_ROON:'等待 Roon 确认',PLAYING:'Roon 已确认播放',PAUSED:'Roon 已确认暂停',ENDED:'本次播放已结束',FAILED:'本次播放失败，请核对源目录与 Roon 状态',CANCELLED:'本次点播已取消',SUBMISSION_UNKNOWN:'提交结果未知，请核对 Roon 状态，暂不重复提交',OWNERSHIP_LOST: local?.ownership === 'EXTERNAL' || local?.queue_owner === 'ROON_NATIVE_EXTERNAL' ? 'Roon 播放所有权已改变，MB 自动推进已暂停' : 'Roon 播放所有权未知，MB 自动推进已暂停'}
 const delivery: Record<NonNullable<typeof local>['delivery_state'], string> = {NOT_STARTED:'尚未开始',READ_REQUESTED:'已收到读取请求',SENDING:'正在发送',BYTES_SENT:'字节已发送',FAILED:'发送失败',UNKNOWN:'状态未知'}
 const relevant = identity || local?.phase === 'OWNERSHIP_LOST' || local?.phase === 'SUBMISSION_UNKNOWN'
 const confirmed = local?.phase === 'PLAYING' ? observed && ['PLAYING', 'TIME'].includes(local.roon_observation.event) : local?.phase === 'PAUSED' ? observed && ['PAUSED', 'TIME'].includes(local.roon_observation.event) : true
 if (same && receipt?.request.action === 'PLAY_NOW' && local) recent = `最近点播：${confirmed ? phases[local.phase] : '当前身份或 Roon 观察尚未确认'}`
 return { state: relevant && local ? confirmed ? phases[local.phase] : '等待 Roon 确认' : '尚无当前本地播放观察', delivery: relevant && local ? `文件直送：${delivery[local.delivery_state]}` : '文件直送：当前状态未知', request: recent }
}

export function mbQueueOwnershipStatus(snapshot: import('@music-bridge/contracts').PlaybackSnapshot | null): string | null {
 const local = snapshot?.local
 if (local?.queue_owner === 'ROON_NATIVE_EXTERNAL' || local?.ownership === 'EXTERNAL') return '当前由 Roon 外部播放控制；下面是 MB 已保存队列，自动推进已暂停。'
 if (local && (local.ownership === 'UNKNOWN' || local.queue_owner === 'UNKNOWN' || local.phase === 'OWNERSHIP_LOST' || local.phase === 'SUBMISSION_UNKNOWN')) return '当前 Roon 播放所有权未知；下面是 MB 已保存队列，自动推进已暂停。'
 return null
}
