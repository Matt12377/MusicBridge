import { createHash, randomUUID } from 'node:crypto'
import { RECORDING_PRINT_GEOMETRY, isCollectionPhotoImage, isRecordingPrintLease, type CollectionPhotoImage, type RecordingPrintLease } from '@music-bridge/contracts'
import type { BrowserWindowConstructorOptions, PrintToPDFOptions, Rectangle } from 'electron'
import { recordingPrintHtml, recordingPrintLayoutScript } from './recording-print-template.js'
import { normalizeRecordingPrintPdf } from './recording-print-pdf.js'

export type RecordingPrintRenderErrorCode = 'RENDER_FAILED' | 'LAYOUT_OVERFLOW' | 'RENDER_TIMEOUT' | 'OBJECT_LIMIT'
export class RecordingPrintRenderError extends Error {
  constructor(readonly code: RecordingPrintRenderErrorCode) { super(`J-Card 生成未完成，请检查排版或重试。[${code}]`) }
}
interface Event { preventDefault(): void }
interface PrintSession {
  webRequest: { onBeforeRequest(listener: ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) | null): void }
  on(event: 'will-download', listener: (event: Event) => void): unknown
  removeListener(event: 'will-download', listener: (event: Event) => void): unknown
  setPermissionCheckHandler(handler: (() => boolean) | null): void
  setPermissionRequestHandler(handler: ((contents: unknown, permission: unknown, callback: (allowed: boolean) => void) => void) | null): void
}
export interface RecordingPrintWindow {
  loadURL(url: string): Promise<unknown>
  destroy(): void
  isDestroyed(): boolean
  webContents: {
    session: PrintSession
    on(event: string, listener: (...args: any[]) => void): unknown
    removeListener(event: string, listener: (...args: any[]) => void): unknown
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    setAudioMuted(muted: boolean): void
    executeJavaScript(script: string): Promise<unknown>
    printToPDF(options: PrintToPDFOptions): Promise<Buffer>
    capturePage(rect: Rectangle, options: { stayHidden: boolean; stayAwake: boolean }): Promise<RecordingPrintImage>
  }
}
interface RecordingPrintImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'best' }): RecordingPrintImage
  toJPEG(quality: number): Buffer
}
export type RecordingPrintWindowFactory = (options: BrowserWindowConstructorOptions) => RecordingPrintWindow | Promise<RecordingPrintWindow>
export interface RecordingPrintRendered {
  pdfBase64: string; pdfSha256: string; preview: CollectionPhotoImage; pagePreviews?: readonly CollectionPhotoImage[]; pageCount: number; rendererVersion: string
}
interface Options { createWindow?: RecordingPrintWindowFactory; decodeJpeg?: (bytes: Buffer) => Promise<Pick<RecordingPrintImage, 'isEmpty' | 'getSize'>>; timeoutMs?: number }
interface Task { cancelled?: RecordingPrintRenderError; window?: RecordingPrintWindow; reject(error: RecordingPrintRenderError): void }
const fail = (code: RecordingPrintRenderErrorCode): never => { throw new RecordingPrintRenderError(code) }
const defaultFactory: RecordingPrintWindowFactory = async options => { const { BrowserWindow } = await import('electron'); return new BrowserWindow(options) }
const defaultDecodeJpeg = async (bytes: Buffer) => { const { nativeImage } = await import('electron'); return nativeImage.createFromBuffer(bytes) }
const engineVersion = (value?: string) => value && /^\d{1,3}(?:\.\d{1,6}){1,3}$/u.test(value) ? value : 'none'
const pagedRendererVersion = `jp0-v1-box1-pages1-electron-${engineVersion(process.versions.electron)}-chrome-${engineVersion(process.versions.chrome)}`
const designRendererVersion = `jc-design-v1-box1-pages1-electron-${engineVersion(process.versions.electron)}-chrome-${engineVersion(process.versions.chrome)}`

/** 只生成受信任历史事实的PDF；没有打印机、文件路径、页面脚本或任意URL公共入口。 */
export function createRecordingPrintRenderer({ createWindow = defaultFactory, decodeJpeg = defaultDecodeJpeg, timeoutMs = 60_000 }: Options = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return fail('RENDER_FAILED')
  let closed = false, active: Task | undefined
  const destroy = (window?: RecordingPrintWindow) => { if (window && !window.isDestroyed()) window.destroy() }
  const cancel = (task: Task, code: RecordingPrintRenderErrorCode) => {
    task.cancelled ??= new RecordingPrintRenderError(code)
    task.reject(task.cancelled)
    // timer/close不在render的try内；销毁失败留给finally再收口，不能逸出Main或覆盖首终因。
    try { destroy(task.window) } catch { /* 已锁存失败，不发布结果。 */ }
  }
  return {
    async render(value: RecordingPrintLease): Promise<RecordingPrintRendered> {
      if (closed || active || !isRecordingPrintLease(value)) {
        if (process.env.MUSIC_BRIDGE_UI_E2E === '1') console.error('[印刷渲染诊断] 阶段=lease-check 结果=RENDER_FAILED')
        return fail('RENDER_FAILED')
      }
      const lease = structuredClone(value)
      let phase = 'window'
      let reject!: (error: RecordingPrintRenderError) => void
      const cancelled = new Promise<never>((_, no) => { reject = no }), task: Task = { reject }; active = task
      const check = () => { if (task.cancelled) throw task.cancelled; if (closed) return fail('RENDER_FAILED') }
      const timer = setTimeout(() => cancel(task, 'RENDER_TIMEOUT'), timeoutMs)
      const listeners: Array<[string, (...args: any[]) => void]> = []
      let releaseListeners: (() => void) | undefined
      const prevent = (event: Event) => event.preventDefault()
      const work = (async (): Promise<RecordingPrintRendered> => {
        const geometry = lease.design?.geometry ?? RECORDING_PRINT_GEOMETRY
        const viewport = { width: Math.round(geometry.widthMm * 96 / 25.4), height: Math.round(geometry.heightMm * 96 / 25.4) }
        const window = await createWindow({ show: false, width: viewport.width, height: viewport.height, useContentSize: true, focusable: false, skipTaskbar: true, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false, backgroundThrottling: false, partition: `recording-print-${randomUUID()}` } })
        task.window = window
        if (task.cancelled || closed) { destroy(window); check() }
        const contents = window.webContents, session = contents.session
        phase = 'session'
        // 缓存会话/事件对象；超时destroy后不再从已销毁窗口读取webContents属性。
        releaseListeners = () => {
          for (const [name, listener] of listeners) contents.removeListener(name, listener)
          session.removeListener('will-download', prevent)
          session.webRequest.onBeforeRequest(null)
          session.setPermissionCheckHandler(null); session.setPermissionRequestHandler(null)
        }
        const url = `data:text/html;charset=utf-8,${encodeURIComponent(recordingPrintHtml(lease))}`
        const allowed = new Set([url, ...(lease.artworkImage ? [lease.artworkImage.dataUrl] : []), ...(lease.designImage ? [lease.designImage.dataUrl] : [])])
        session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed.has(details.url) }))
        session.setPermissionCheckHandler(() => false)
        session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
        session.on('will-download', prevent)
        contents.setAudioMuted(true); contents.setWindowOpenHandler(() => ({ action: 'deny' }))
        for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) { contents.on(name, prevent); listeners.push([name, prevent]) }
        const crashed = () => cancel(task, 'RENDER_FAILED')
        contents.on('render-process-gone', crashed); listeners.push(['render-process-gone', crashed])
        phase = 'load'
        await window.loadURL(url); check()
        phase = 'layout'
        const layout = await contents.executeJavaScript(recordingPrintLayoutScript(lease)); check()
        if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return fail('RENDER_FAILED')
        const result = layout as Record<string, unknown>
        if (result.ok === false && result.errorCode === 'LAYOUT_OVERFLOW') return fail('LAYOUT_OVERFLOW')
        if (Object.keys(result).sort().join(',') !== 'ok,pageCount' || result.ok !== true || !Number.isSafeInteger(result.pageCount) || Number(result.pageCount) < 1) return fail('RENDER_FAILED')
        if (Number(result.pageCount) > 24) return fail('LAYOUT_OVERFLOW')
        // 本链路独立读取页面 DPR 并核对截图表示尺寸，避免将高分屏预览按 CSS viewport 误判。
        const deviceScale = await contents.executeJavaScript('window.devicePixelRatio'); check()
        if (typeof deviceScale !== 'number' || !Number.isFinite(deviceScale) || deviceScale < 1 || deviceScale > 4) return fail('RENDER_FAILED')
        const capturedSize = { width: Math.round(viewport.width * deviceScale), height: Math.round(viewport.height * deviceScale) }
        phase = 'print-to-pdf'
        const printed = await contents.printToPDF({ pageSize: { width: geometry.widthMm / 25.4, height: geometry.heightMm / 25.4 }, preferCSSPageSize: true, scale: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 }, printBackground: true, displayHeaderFooter: false }); check()
        if (!Buffer.isBuffer(printed) || printed.length > 4 * 1024 * 1024) return fail('OBJECT_LIMIT')
        phase = 'normalize-pdf'
        const pdf = normalizeRecordingPrintPdf(printed, Number(result.pageCount), geometry, lease.design?.schemaVersion === 2)
        const capture = async (): Promise<CollectionPhotoImage> => {
          const image = await contents.capturePage({ x: 0, y: 0, width: viewport.width, height: viewport.height }, { stayHidden: true, stayAwake: true }); check()
          if (process.env.MUSIC_BRIDGE_UI_E2E === '1') console.error(`[印刷截图诊断] empty=${image.isEmpty()} viewport=${viewport.width}x${viewport.height} size=${image.getSize().width}x${image.getSize().height}`)
          if (image.isEmpty()) return fail('RENDER_FAILED')
          const captured = image.getSize()
          if (captured.width !== capturedSize.width || captured.height !== capturedSize.height) return fail('RENDER_FAILED')
          const scale = Math.min(1, 1200 / Math.max(captured.width, captured.height))
          const size = { width: Math.max(1, Math.round(captured.width * scale)), height: Math.max(1, Math.round(captured.height * scale)) }
          const bounded = scale < 1 ? image.resize({ ...size, quality: 'best' }) : image
          if (bounded.isEmpty() || bounded.getSize().width !== size.width || bounded.getSize().height !== size.height) return fail('RENDER_FAILED')
          const bytes = bounded.toJPEG(85)
          if (bytes.length > 1024 * 1024) return fail('OBJECT_LIMIT')
          const decoded = await decodeJpeg(bytes); check()
          if (decoded.isEmpty() || decoded.getSize().width !== size.width || decoded.getSize().height !== size.height) return fail('RENDER_FAILED')
          const preview = { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, width: size.width, height: size.height }
          if (!isCollectionPhotoImage(preview)) return fail('RENDER_FAILED')
          return preview
        }
        phase = 'capture-first'
        const preview = await capture()
        const pagePreviews: CollectionPhotoImage[] = [preview]
        let previewBytes = Buffer.from(preview.dataUrl.slice(23), 'base64').length
        for (let index = 1; index < Number(result.pageCount); index++) {
          phase = 'scroll-preview'
          const scrolled = await contents.executeJavaScript(`(async()=>{const sheet=document.querySelectorAll('.sheet')[${index}];if(!sheet)return false;sheet.scrollIntoView({block:'start',behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return Math.abs(sheet.getBoundingClientRect().top)<0.5})()`); check()
          if (scrolled !== true) return fail('RENDER_FAILED')
          phase = 'capture-next'
          const page = await capture(); previewBytes += Buffer.from(page.dataUrl.slice(23), 'base64').length
          if (previewBytes > 4 * 1024 * 1024) return fail('OBJECT_LIMIT')
          pagePreviews.push(page)
        }
        return { pdfBase64: pdf.toString('base64'), pdfSha256: createHash('sha256').update(pdf).digest('hex'), preview, pagePreviews, pageCount: Number(result.pageCount), rendererVersion: lease.design?.schemaVersion === 2 ? designRendererVersion : pagedRendererVersion }
      })()
      try { return await Promise.race([work, cancelled]) }
      catch (error) {
        if (process.env.MUSIC_BRIDGE_UI_E2E === '1') console.error(`[印刷渲染诊断] 阶段=${phase} 结果=${error instanceof RecordingPrintRenderError ? error.code : '未分类错误'}`)
        if (error instanceof RecordingPrintRenderError) throw error
        return fail('RENDER_FAILED')
      }
      finally {
        clearTimeout(timer)
        let cleanupFailed = false
        try { releaseListeners?.() } catch { cleanupFailed = true }
        try { destroy(task.window) } catch { cleanupFailed = true }
        finally { if (active === task) active = undefined }
        // 清理异常不跳过destroy/忙状态收口，也不能覆盖已锁存的超时/取消事实。
        if (cleanupFailed) {
          if (process.env.MUSIC_BRIDGE_UI_E2E === '1') console.error('[印刷渲染诊断] 阶段=cleanup 结果=RENDER_FAILED')
          throw task.cancelled ?? new RecordingPrintRenderError('RENDER_FAILED')
        }
      }
    },
    close(): void { closed = true; if (active) cancel(active, 'RENDER_FAILED') },
  }
}
export type RecordingPrintRenderer = ReturnType<typeof createRecordingPrintRenderer>
