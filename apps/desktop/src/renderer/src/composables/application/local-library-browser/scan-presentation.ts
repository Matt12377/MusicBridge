import type { LocalRootView, ScanJobRecord } from '@music-bridge/contracts'

const phaseLabels: Record<ScanJobRecord['phase'], string> = {
  pending: '等待扫描', running: '正在扫描', paused: '扫描已暂停', completed: '扫描完成', failed: '扫描未完成', cancelled: '扫描已取消',
}
const failureLabels: Record<NonNullable<ScanJobRecord['failureCode']>, string> = {
  ROOT_UNAVAILABLE: '源目录无法读取，请在设置中检查目录与权限。',
  ROOT_REVISION_CHANGED: '目录关联已改变，请在设置中核对后重新扫描。',
  SCAN_READ_FAILED: '读取源目录时发生错误，请在设置中检查目录与权限。',
  CHECKPOINT_INVALID: '上次扫描进度无法确认，请在设置中重新开始扫描。',
}

/** 目录是否存在和音乐数量分别判断；空库不能重新变成首次添加引导。 */
export function localLibraryScanPresentation(options: {
  roots: readonly LocalRootView[]; rootsLoaded: boolean; jobs: readonly ScanJobRecord[]; hasMusic: boolean
}) {
  const roots = options.roots.filter(view => view.root.role === 'library')
  const onboarding = options.rootsLoaded && roots.length === 0
  const rows = roots.flatMap(view => {
    const job = [...options.jobs].reverse().find(value => value.libraryRootId === view.root.id
      && value.sourceRootId === view.root.sourceRootId && value.rootRevision === view.root.revision)
    if (view.availability !== 'ONLINE') return [{ key: view.root.id, phase: 'offline', message: `${view.label} · ${view.availability === 'REVOKED' ? '目录许可已撤销' : '源目录离线'}。已保存的音乐保留，请在设置中恢复目录。` }]
    if (!job) return options.hasMusic ? [] : [{ key: view.root.id, phase: 'unconfirmed', message: `${view.label} · 尚未读取到扫描任务，请在设置中核对扫描状态。` }]
    if (options.hasMusic && (job.phase === 'completed' || job.phase === 'cancelled')) return []
    const counts = `已处理 ${job.progress.visited} · 收录 ${job.progress.accepted} · 跳过 ${job.progress.rejected}`
    const note = job.failureCode ? failureLabels[job.failureCode] : job.phase === 'paused' ? '已保存进度，可在设置中继续。'
      : job.phase === 'running' || job.phase === 'pending' ? '新发现的专辑会陆续显示。'
        : job.phase === 'completed' && !options.hasMusic ? '尚未发现可收录音乐，可在设置中检查扫描目录。' : '已收录的音乐与扫描进度保留。'
    return [{ key: job.jobId, phase: job.phase, message: `${view.label} · ${phaseLabels[job.phase]} · ${counts}。${note}` }]
  })
  const emptyTitle = !options.rootsLoaded ? '正在读取音乐库目录' : onboarding ? '添加本地音乐库'
    : rows.some(row => row.phase === 'running' || row.phase === 'pending') ? '正在建立音乐库' : '已加入音乐目录，尚未显示专辑'
  const emptyCopy = !options.rootsLoaded ? '目录状态确认后会显示已保存的音乐。' : onboarding ? '选择音乐文件夹后会自动扫描。'
    : rows.some(row => row.phase === 'running' || row.phase === 'pending') ? '扫描期间即可浏览已发现的专辑与本地封面。'
      : '已保存的目录与扫描进度保留，请根据扫描状态在设置中继续处理。'
  return { onboarding, rows, emptyTitle, emptyCopy }
}
