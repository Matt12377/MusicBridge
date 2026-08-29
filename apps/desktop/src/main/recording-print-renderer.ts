import { createHash, randomUUID } from 'node:crypto'
import { isCollectionPhotoImage, isRecordingPrintLease, type CollectionPhotoImage, type RecordingPrintLease } from '@music-bridge/contracts'
import type { BrowserWindowConstructorOptions, PrintToPDFOptions, Rectangle } from 'electron'
import { recordingPrintHtml, RECORDING_PRINT_LAYOUT_SCRIPT } from './recording-print-template.js'
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
    capturePage(rect: Rectangle, options: { stayHidden: boolean; stayAwake: boolean }): Promise<{ isEmpty(): boolean; getSize(): { width: number; height: number }; toJPEG(quality: number): Buffer }>
  }
}
export type RecordingPrintWindowFactory = (options: BrowserWindowConstructorOptions) => RecordingPrintWindow | Promise<RecordingPrintWindow>
export interface RecordingPrintRendered {
  pdfBase64: string; pdfSha256: string; preview: CollectionPhotoImage; pageCount: number; rendererVersion: string
}
interface Options { createWindow?: RecordingPrintWindowFactory; timeoutMs?: number }
interface Task { cancelled?: RecordingPrintRenderError; window?: RecordingPrintWindow; reject(error: RecordingPrintRenderError): void }
const fail = (code: RecordingPrintRenderErrorCode): never => { throw new RecordingPrintRenderError(code) }
const defaultFactory: RecordingPrintWindowFactory = async options => { const { BrowserWindow } = await import('electron'); return new BrowserWindow(options) }
const engineVersion = (value?: string) => value && /^\d{1,3}(?:\.\d{1,6}){1,3}$/u.test(value) ? value : 'none'
const rendererVersion = `jp0-v1-box1-preview2-electron-${engineVersion(process.versions.electron)}-chrome-${engineVersion(process.versions.chrome)}`

/** 只生成受信任历史事实的PDF；没有打印机、文件路径、页面脚本或任意URL公共入口。 */
export function createRecordingPrintRenderer({ createWindow = defaultFactory, timeoutMs = 60_000 }: Options = {}) {
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
      if (closed || active || !isRecordingPrintLease(value)) return fail('RENDER_FAILED')
      const lease = structuredClone(value)
      let reject!: (error: RecordingPrintRenderError) => void
      const cancelled = new Promise<never>((_, no) => { reject = no }), task: Task = { reject }; active = task
      const check = () => { if (task.cancelled) throw task.cancelled; if (closed) return fail('RENDER_FAILED') }
      const timer = setTimeout(() => cancel(task, 'RENDER_TIMEOUT'), timeoutMs)
      const listeners: Array<[string, (...args: any[]) => void]> = []
      let releaseListeners: (() => void) | undefined
      const prevent = (event: Event) => event.preventDefault()
      const work = (async (): Promise<RecordingPrintRendered> => {
        const window = await createWindow({ show: false, width: 390, height: 384, useContentSize: true, focusable: false, skipTaskbar: true, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false, backgroundThrottling: false, partition: `recording-print-${randomUUID()}` } })
        task.window = window
        if (task.cancelled || closed) { destroy(window); check() }
        const contents = window.webContents, session = contents.session
        // 缓存会话/事件对象；超时destroy后不再从已销毁窗口读取webContents属性。
        releaseListeners = () => {
          for (const [name, listener] of listeners) contents.removeListener(name, listener)
          session.removeListener('will-download', prevent)
          session.webRequest.onBeforeRequest(null)
          session.setPermissionCheckHandler(null); session.setPermissionRequestHandler(null)
        }
        const url = `data:text/html;charset=utf-8,${encodeURIComponent(recordingPrintHtml(lease))}`
        const allowed = new Set([url, ...(lease.artworkImage ? [lease.artworkImage.dataUrl] : [])])
        session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed.has(details.url) }))
        session.setPermissionCheckHandler(() => false)
        session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
        session.on('will-download', prevent)
        contents.setAudioMuted(true); contents.setWindowOpenHandler(() => ({ action: 'deny' }))
        for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) { contents.on(name, prevent); listeners.push([name, prevent]) }
        const crashed = () => cancel(task, 'RENDER_FAILED')
        contents.on('render-process-gone', crashed); listeners.push(['render-process-gone', crashed])
        await window.loadURL(url); check()
        const layout = await contents.executeJavaScript(RECORDING_PRINT_LAYOUT_SCRIPT); check()
        if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return fail('RENDER_FAILED')
        const result = layout as Record<string, unknown>
        if (result.ok === false && result.errorCode === 'LAYOUT_OVERFLOW') return fail('LAYOUT_OVERFLOW')
        if (Object.keys(result).sort().join(',') !== 'ok,pageCount' || result.ok !== true || !Number.isSafeInteger(result.pageCount) || Number(result.pageCount) < 1) return fail('RENDER_FAILED')
        if (Number(result.pageCount) > 24) return fail('LAYOUT_OVERFLOW')
        const printed = await contents.printToPDF({ pageSize: { width: 4.0625, height: 4 }, preferCSSPageSize: true, scale: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 }, printBackground: true, displayHeaderFooter: false }); check()
        if (!Buffer.isBuffer(printed) || printed.length > 4 * 1024 * 1024) return fail('OBJECT_LIMIT')
        const pdf = normalizeRecordingPrintPdf(printed, Number(result.pageCount))
        const image = await contents.capturePage({ x: 0, y: 0, width: 390, height: 384 }, { stayHidden: true, stayAwake: true }); check()
        if (image.isEmpty()) return fail('RENDER_FAILED')
        const bytes = image.toJPEG(85), size = image.getSize()
        if (bytes.length > 1024 * 1024) return fail('OBJECT_LIMIT')
        const preview = { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, width: size.width, height: size.height }
        if (!isCollectionPhotoImage(preview)) return fail('RENDER_FAILED')
        return { pdfBase64: pdf.toString('base64'), pdfSha256: createHash('sha256').update(pdf).digest('hex'), preview, pageCount: Number(result.pageCount), rendererVersion }
      })()
      try { return await Promise.race([work, cancelled]) }
      catch (error) { if (error instanceof RecordingPrintRenderError) throw error; return fail('RENDER_FAILED') }
      finally {
        clearTimeout(timer)
        let cleanupFailed = false
        try { releaseListeners?.() } catch { cleanupFailed = true }
        try { destroy(task.window) } catch { cleanupFailed = true }
        finally { if (active === task) active = undefined }
        // 清理异常不跳过destroy/忙状态收口，也不能覆盖已锁存的超时/取消事实。
        if (cleanupFailed) throw task.cancelled ?? new RecordingPrintRenderError('RENDER_FAILED')
      }
    },
    close(): void { closed = true; if (active) cancel(active, 'RENDER_FAILED') },
  }
}
export type RecordingPrintRenderer = ReturnType<typeof createRecordingPrintRenderer>
