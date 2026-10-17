import { lyricsPhysicalDigest as directoryDigest } from '../../../../../packages/bridge-core/src/library/lyrics-source-format.js'
import type { SourceWorkbenchDirectoryUi, SourceWorkbenchDirectoryBinding, SourceWorkbenchDirectoryRequest, SourceWorkbenchDirectoryReply, SourceWorkbenchDirectoryRegistrationReply } from '../../../../../packages/bridge-core/src/collection/source-writes-authority.js'
import type { LocalWorkbenchRootMainAuthor, LocalWorkbenchRootAuthorBinding, LocalWorkbenchRootMainRequest, LocalWorkbenchMainPreparationContext } from './service.js'
import * as directoryDto from '@music-bridge/contracts'
import type { LocalLibraryImportChoice, LocalWorkbenchAvailability } from '@music-bridge/contracts'
import { captureSourceWorkbenchDirectoryUi, captureSourceWorkbenchDirectoryBinding, captureSourceWorkbenchDirectoryReply } from '../../../../../packages/bridge-core/src/collection/source-writes-authority.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { realpath, lstat, open, access, type FileHandle } from 'node:fs/promises'
import { abortable } from './providers/boundaries.js'
import { constants } from 'node:fs'
import { captureSourceWorkbenchDirectoryPhysical, type SourceWorkbenchDirectoryPhysical } from '../../../../../packages/bridge-core/src/collection/source-writes-authority.js'
import { authorizeSourceDirectory, sourceRootAvailability, readonlySourceCandidateMetadata,
  withReadonlySourcePublicationClaims, SourcePublicationUnverified, type RootCapability } from '../../../../../packages/bridge-core/src/recording/source-files.js'
import type { LocalWorkbenchApprovedArtworkFile, LocalWorkbenchApprovedCueTarget, LocalWorkbenchNativeChooser } from './service.js'
import type { LocalWorkbenchMainContext } from './workbench-ipc.js'
import type { LocalNameSecurePrompt, LocalNameSettingsContext } from './name-settings.js'

type Mode = 'artwork' | 'cue-target' | 'library' | 'secret'
interface NativeResult { cancelled: boolean; value: string | null }
export interface LocalWorkbenchNativeChooserOptions {
  /** 绑定实际 Main/Utility generation 与原 Owner；公开路径不能安装该作者。 */
  assertCurrent(context: LocalWorkbenchMainContext): void | Promise<void>
  /** 唯一Root私有注册端口；收到实际Main许可对象，不接受Renderer路径或choiceId自签。 */
  registerLibraryDirectory?(approved: LocalWorkbenchApprovedLibraryDirectory, context: LocalWorkbenchMainContext): Promise<LocalLibraryImportChoice>
  registerCueTarget?(approved: LocalWorkbenchApprovedCueTarget, context: LocalWorkbenchMainContext): Promise<void>
  revokeDirectory?(approved:LocalWorkbenchApprovedLibraryDirectory|LocalWorkbenchApprovedCueTarget,context:LocalWorkbenchMainContext):Promise<void>
  /** 仅离线受控测试替换Native host；正式Main不提供此参数。 */
  promptHost?:{
    request(mode:Mode,signal:AbortSignal):Promise<NativeResult>;join():Promise<void>;close():Promise<void>
    /** 只读原host的listen/producer/closing状态；注入host缺此口不授可调用。 */
    readAvailability?(mode:Mode,signal:AbortSignal):LocalWorkbenchAvailability|Promise<LocalWorkbenchAvailability>
  }
}
export interface LocalWorkbenchApprovedLibraryDirectory {
  label: string
  assertCurrent(context: { signal: AbortSignal }): Promise<void>
  withDirectory<T>(operation: (authorizedPath: string) => Promise<T>, context: { signal: AbortSignal }): Promise<T>
  close(): Promise<void>
}
const MAX_RESULT = 64 * 1024, MAX_ARTWORK = 4 * 1024 * 1024
const fail = (message: string): never => { throw new Error(message) }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function absentGroup(pid: number): boolean {
  try { process.kill(-pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
/** 固定 AppKit 程序；不插入用户正文、不传凭据参数、不请求其他应用的 Apple Events。 */
export function localWorkbenchNativePromptScript(mode: Mode): string {
  const header = "ObjC.import('Cocoa'); const app=$.NSApplication.sharedApplication; app.setActivationPolicy(1); app.activateIgnoringOtherApps(true);"
  if (mode === 'secret') return `function run(){${header}
const alert=$.NSAlert.alloc.init; alert.messageText='Music Bridge：云端模型 API 密钥';
alert.informativeText='密钥仅保存到本机加密保险库。'; alert.addButtonWithTitle('保存'); alert.addButtonWithTitle('取消');
const field=$.NSSecureTextField.alloc.initWithFrame($.NSMakeRect(0,0,360,24)); alert.accessoryView=field;
alert.window.initialFirstResponder=field; const response=alert.runModal;
if(response!==1000)return JSON.stringify({cancelled:true,value:null});
return JSON.stringify({cancelled:false,value:ObjC.unwrap(field.stringValue)});}\n`
  const directory = mode === 'cue-target' || mode === 'library'
  return `function run(){${header}
const panel=$.NSOpenPanel.openPanel; panel.title='${mode === 'library' ? 'Music Bridge：选择本地音乐库目录' : directory ? 'Music Bridge：选择独立 CUE 输出目录' : 'Music Bridge：选择封面图片'}';
panel.canChooseFiles=${!directory}; panel.canChooseDirectories=${directory}; panel.allowsMultipleSelection=false;
panel.canCreateDirectories=${directory}; const response=panel.runModal;
if(response!==1)return JSON.stringify({cancelled:true,value:null});
return JSON.stringify({cancelled:false,value:ObjC.unwrap(panel.URL.path)});}\n`
}

/** 对话框的实际 PID/进程组与原管道全部退出后才 resolve；取消回报不代替静止。 */
function createPromptHost() {
  let closed = false, unverified = false
  let current: { child: ChildProcessWithoutNullStreams; done: Promise<NativeResult>; terminate(): void } | undefined
  async function request(mode: Mode, signal: AbortSignal): Promise<NativeResult> {
    if (closed || unverified || current || signal.aborted || process.platform !== 'darwin') return fail('本地原生输入尚未就绪或另一个输入尚未关闭。')
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { LANG: process.env.LANG ?? 'zh_CN.UTF-8', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) } })
    let exceeded = false, cancelled = false, spawnFailed = false, rawBytes = 0, stderrBytes = 0, killTimer: ReturnType<typeof setTimeout> | undefined
    const chunks: Buffer[] = []
    const terminate = () => {
      cancelled = true
      if (!child.pid || absentGroup(child.pid)) return
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* close 与进程组实查决定最终结果。 */ }
      if (!killTimer) killTimer = setTimeout(() => { if (child.pid && !absentGroup(child.pid)) try { process.kill(-child.pid, 'SIGKILL') } catch { /* 原组仍将实查。 */ } }, 500)
    }
    const done = new Promise<NativeResult>((resolve, reject) => {
      child.once('error', () => { spawnFailed = true })
      child.stdin.on('error', () => {})
      child.stdout.on('data', (chunk: Buffer) => { rawBytes += chunk.length; if (rawBytes > MAX_RESULT) { exceeded = true; terminate() } else chunks.push(Buffer.from(chunk)) })
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_RESULT) { exceeded = true; terminate() } })
      child.once('close', (code, exitSignal) => { void (async () => {
        if (killTimer) clearTimeout(killTimer)
        signal.removeEventListener('abort', terminate)
        if (child.pid) {
          for (let attempt = 0; attempt < 40 && !absentGroup(child.pid); attempt++) await sleep(25)
          if (!absentGroup(child.pid)) { unverified = true; return fail('原生输入进程组静止未确认，原任务保留。') }
        }
        if (exceeded || spawnFailed) return fail('原生输入响应超过预算或未启动。')
        if (cancelled || signal.aborted) return { cancelled: true, value: null }
        if (code !== 0 || exitSignal !== null || stderrBytes !== 0) return fail('原生输入未正常结束，未接受任何正文。')
        let value: unknown
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return fail('原生输入结果格式无效。') }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
          || !Object.hasOwn(value, 'cancelled') || !Object.hasOwn(value, 'value')) return fail('原生输入结果字段无效。')
        const result = value as NativeResult
        if (typeof result.cancelled !== 'boolean' || (result.cancelled ? result.value !== null : typeof result.value !== 'string')) return fail('原生输入结果正文无效。')
        return result
      })().then(resolve, reject).finally(() => { if (current?.child === child && !unverified) current = undefined }) })
    })
    current = { child, done, terminate }; signal.addEventListener('abort', terminate, { once: true })
    if (signal.aborted) terminate()
    child.stdin.end(localWorkbenchNativePromptScript(mode))
    return done
  }
  return {
    async readAvailability(mode:Mode,signal:AbortSignal):Promise<LocalWorkbenchAvailability>{
      const unavailable=(reason:string):LocalWorkbenchAvailability=>({available:false,reason})
      if(!['artwork','cue-target','library','secret'].includes(mode)||signal.aborted)return unavailable('原Native输入信号或模式不可用。')
      if(closed)return unavailable('原Native输入host已停止受理。')
      if(unverified)return unavailable('原Native输入物理关闭尚未确认。')
      if(current)return unavailable('原Native输入任务尚未收口。')
      if(process.platform!=='darwin')return unavailable('当前平台未配置固定AppKit输入。')
      try{
        const file='/usr/bin/osascript',info=await lstat(file)
        if(!info.isFile()||info.isSymbolicLink()||await realpath(file)!==file||(info.mode&0o111)===0)return unavailable('固定Native输入程序未确认可执行。')
        await access(file,constants.X_OK)
        if(signal.aborted||closed||unverified||current)return unavailable('原Native输入host已经改变。')
        return {available:true}
      }catch{return unavailable('固定Native输入程序不可调用。')}
    },
    request,
    async join(): Promise<void> { if (current) await current.done.catch(() => {}); if (unverified) return fail('原生输入资源仍未确认关闭。') },
    async close(): Promise<void> { closed = true; current?.terminate(); if (current) await current.done.catch(() => {}); if (unverified) return fail('原生输入资源仍未确认关闭。') },
  }
}

/** 系统选择只生成 Main 私有许可；Renderer 的 choiceId/路径不会创建 SourceFiles 授权。 */
export function createLocalWorkbenchNativeChooser(options: LocalWorkbenchNativeChooserOptions): LocalWorkbenchNativeChooser & {
  /** 配置可调用性；不表示AppKit弹框、来源授权或Owner行为已经验证。 */
  readAvailability(mode:'artwork'|'cue-target'|'library',context:LocalWorkbenchMainContext):Promise<LocalWorkbenchAvailability>
  securePrompt: LocalNameSecurePrompt
  chooseLibrary(context: LocalWorkbenchMainContext): Promise<LocalLibraryImportChoice | null>
  /** 仅私有可信drop装配调用；路径不能从公开Renderer DTO取得许可。 */
  chooseDroppedLibrary(absolute: string, context: LocalWorkbenchDirectoryUiContext): Promise<LocalLibraryImportChoice>
  inspectApprovedLibraryDirectory(approved: LocalWorkbenchApprovedLibraryDirectory, context: LocalWorkbenchMainContext): Promise<Readonly<RootCapability>>
  /** 供真实 Main 私有授权桥使用；必须再次断言原对象，不能把返回 DTO 当成写许可。 */
  inspectApprovedCueTarget(target: LocalWorkbenchApprovedCueTarget, context: LocalWorkbenchMainContext): Promise<Readonly<RootCapability>>
  inspectHeldDirectory(approved:LocalWorkbenchApprovedLibraryDirectory|LocalWorkbenchApprovedCueTarget,context:LocalWorkbenchMainContext):Promise<Readonly<SourceWorkbenchDirectoryPhysical>>
  closeHeldDirectory(approved:LocalWorkbenchApprovedLibraryDirectory|LocalWorkbenchApprovedCueTarget):Promise<void>
  /** 原Owner实际quiet后才关闭已批准目录；读取封口不撤其FD。 */
  closeApprovedDirectories():Promise<void>
} {
  const host = options.promptHost ?? createPromptHost(), reads = new Set<Promise<unknown>>(), targets = new Map<LocalWorkbenchApprovedCueTarget, { root: RootCapability; datasetId: string }>()
  const libraries = new Map<LocalWorkbenchApprovedLibraryDirectory, { root: RootCapability; datasetId: string }>()
  const held=new Map<object,{handle:FileHandle;physical:SourceWorkbenchDirectoryPhysical;pending:Set<Promise<unknown>>;closing?:Promise<void>}>()
  let approvedClosure:Promise<void>|undefined, librarySelectionActive = false
  let closed = false, retained = false, closure: Promise<void> | undefined, closureDone = false, closureFailed = false
  const originalHost=options.promptHost,originalRequest=host.request,originalJoin=host.join,originalClose=host.close,hostAvailability=host.readAvailability
  const originalAuthorGuard=options.assertCurrent,originalLibraryRegister=options.registerLibraryDirectory,originalCueRegister=options.registerCueTarget
  const unavailable=(reason:string):LocalWorkbenchAvailability=>({available:false,reason})
  async function holdDirectory(root:RootCapability):Promise<{handle:FileHandle;physical:SourceWorkbenchDirectoryPhysical;pending:Set<Promise<unknown>>}>{
    const handle=await open(root.path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    try{const f=await handle.stat({bigint:true}),name=await realpath(root.path),named=await lstat(root.path,{bigint:true});if(!f.isDirectory()||named.isSymbolicLink()||name!==root.path||String(f.dev)!==root.dev||String(f.ino)!==root.ino||String(named.dev)!==root.dev||String(named.ino)!==root.ino)throw Error('目录FD不是原物理根。');return{handle,pending:new Set(),physical:captureSourceWorkbenchDirectoryPhysical({path:root.path,dev:String(f.dev),ino:String(f.ino),birthtimeNs:String(f.birthtimeNs),mode:String(f.mode),uid:String(f.uid),gid:String(f.gid)})}}catch(e){await handle.close();throw e}
  }
  async function checkHeld(approved:object):Promise<Readonly<SourceWorkbenchDirectoryPhysical>>{
    const item=held.get(approved);if(!item||item.closing)return fail('原目录FD已撤销。');const f=await item.handle.stat({bigint:true}),named=await lstat(item.physical.path,{bigint:true});if(!f.isDirectory()||named.isSymbolicLink()||await realpath(item.physical.path)!==item.physical.path||['dev','ino','birthtimeNs','mode','uid','gid'].some(k=>String(f[k as keyof typeof f])!==item.physical[k as keyof typeof item.physical])||named.dev!==f.dev||named.ino!==f.ino)return fail('原目录FD或namespace已改变。');return Object.freeze({...item.physical})
  }
  async function closeHeld(approved:object):Promise<void>{
    const item=held.get(approved);if(!item)return;if(!item.closing)item.closing=(async()=>{
      await Promise.allSettled([...item.pending]);await item.handle.close()
      try{await item.handle.stat();throw Error('原目录FileHandle关闭尚未确认。')}catch(error){if((error as NodeJS.ErrnoException).code!=='EBADF')throw error}
      held.delete(approved)
    })();await item.closing
  }
  async function withHeld<T>(approved:object,operation:()=>Promise<T>):Promise<T>{const item=held.get(approved);if(!item||item.closing)return fail('目录FD已进入关闭。');const task=Promise.resolve().then(operation);item.pending.add(task);try{return await task}finally{item.pending.delete(task)}}
  async function fence(context: LocalWorkbenchMainContext): Promise<void> {
    if (closed || retained || context.signal.aborted) return fail('原生选择许可已关闭或撤销。')
    await context.assertCurrent?.(); await options.assertCurrent(context)
    if (closed || retained || context.signal.aborted) return fail('原生选择原身份已撤销。')
  }
  const track = <T>(work: Promise<T>): Promise<T> => {
    reads.add(work); void work.then(() => reads.delete(work), () => reads.delete(work)); return work
  }
  async function chooseArtwork(context: LocalWorkbenchMainContext): Promise<LocalWorkbenchApprovedArtworkFile | null> {
    await fence(context); const chosen = await host.request('artwork', context.signal); await fence(context)
    if (chosen.cancelled) return null
    const absolute = chosen.value!
    if (!path.isAbsolute(absolute) || absolute.includes('\0') || await realpath(absolute) !== absolute) return fail('原生选择的文件身份无效。')
    const info = await lstat(absolute)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_ARTWORK) return fail('封面必须是 4 MiB 以内的普通文件。')
    const root: RootCapability = { id: randomUUID(), ...await authorizeSourceDirectory(path.dirname(absolute)) }
    const relative = path.basename(absolute), original = await readonlySourceCandidateMetadata(root, relative); let released = false
    const pending = new Set<Promise<Uint8Array>>()
    return {
      label: relative,
      read(readContext) {
        const work = (async () => {
          if (released) return fail('原封面文件许可已经关闭。')
          const scoped = { ...context, signal: readContext.signal }; await fence(scoped)
          const deadline = performance.now() + 3000
          try {
            return await withReadonlySourcePublicationClaims([{ root, relative, expectedSignature: original.signature }], readContext.signal, async (verify, files) => {
              await fence(scoped); await verify()
              const file = files[0]!, length = Number(file.info.size)
              if (length < 1 || length > MAX_ARTWORK || performance.now() >= deadline) return fail('封面读取超过原预算。')
              const bytes = Buffer.alloc(length + 1), read = await file.handle.read(bytes, 0, bytes.length, 0)
              await verify(); await fence(scoped)
              if (read.bytesRead !== length || performance.now() >= deadline || released) return fail('原封面文件读取未确认。')
              return new Uint8Array(bytes.subarray(0, length))
            })
          } catch (error) { if (error instanceof SourcePublicationUnverified) retained = true; throw error }
        })()
        pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return track(work)
      },
      async close() { released = true; await Promise.allSettled([...pending]); if (retained) return fail('封面 FD 或来源保护关闭尚未确认。') },
    }
  }
  async function chooseCueTarget(context: LocalWorkbenchMainContext): Promise<LocalWorkbenchApprovedCueTarget | null> {
    if(!options.registerCueTarget)return fail('原Owner独立目标许可登记尚未装配。')
    await fence(context); const chosen = await host.request('cue-target', context.signal); await fence(context)
    if (chosen.cancelled) return null
    const root: RootCapability = { id: randomUUID(), ...await authorizeSourceDirectory(chosen.value!) }
    const holding=await holdDirectory(root)
    const revision = createHash('sha256').update(JSON.stringify({ datasetId: context.datasetId, rootId: root.id, path: root.path, dev: root.dev, ino: root.ino })).digest('hex')
    let released = false
    async function check(readContext: { signal: AbortSignal }): Promise<void> {
      await fence({ ...context, signal: readContext.signal })
      if (released || await sourceRootAvailability(root) !== 'ONLINE') return fail('原 CUE 输出目录许可已撤销或物理身份改变。')
      await checkHeld(approved)
    }
    const approved: LocalWorkbenchApprovedCueTarget = {
      target: { choiceId: root.id, label: root.label, independent: true }, revision,
      assertCurrent: check,
      async withDirectory(operation, readContext) { return withHeld(approved,async()=>{await check(readContext); const result = await operation(root.path); await check(readContext); return result}) },
      async close() { if(released)return;await options.revokeDirectory?.(approved,context);await closeHeld(approved);released = true; targets.delete(approved) },
    }
    held.set(approved,holding);targets.set(approved, { root, datasetId: context.datasetId })
    try { if (options.registerCueTarget) await options.registerCueTarget(approved, context); await fence(context); return approved }
    catch (error) { await approved.close(); throw error }
  }
  async function chooseLibrary(context: LocalWorkbenchMainContext): Promise<LocalLibraryImportChoice | null> {
    // 缺Root实际注册端点时拒绝，不能先弹框再虚构choice/evidence。
    if (!options.registerLibraryDirectory) return fail('原Owner目录许可登记尚未装配。')
    await fence(context); const chosen = await host.request('library', context.signal); await fence(context)
    if (chosen.cancelled) return null
    return approveLibraryDirectory(chosen.value!, context)
  }
  async function chooseDroppedLibrary(absolute: string, context: LocalWorkbenchMainContext): Promise<LocalLibraryImportChoice> {
    await fence(context)
    if (typeof absolute !== 'string' || !path.isAbsolute(absolute) || absolute.length > MAX_RESULT || absolute.includes('\0')
      || absolute.split(path.sep).some(part => part === '.' || part === '..')) return fail('拖入目录的原生路径无效。')
    const named = await lstat(absolute, { bigint: true })
    if (!named.isDirectory() || named.isSymbolicLink() || await realpath(absolute) !== absolute) return fail('拖入对象必须是原目录，不能使用链接或文件。')
    await fence(context)
    const original = captureSourceWorkbenchDirectoryPhysical({ path: absolute, dev: String(named.dev), ino: String(named.ino),
      birthtimeNs: String(named.birthtimeNs), mode: String(named.mode), uid: String(named.uid), gid: String(named.gid) })
    return approveLibraryDirectory(absolute, context, original)
  }
  async function approveLibraryDirectory(absolute: string, context: LocalWorkbenchMainContext, original?: SourceWorkbenchDirectoryPhysical): Promise<LocalLibraryImportChoice> {
    if (!originalLibraryRegister || options.registerLibraryDirectory !== originalLibraryRegister || options.assertCurrent !== originalAuthorGuard)
      return fail('原Owner目录登记或Main作者已改变。')
    await fence(context)
    const root: RootCapability = { id: randomUUID(), ...await authorizeSourceDirectory(absolute) }
    if (original && (root.path !== original.path || root.dev !== original.dev || root.ino !== original.ino)) return fail('拖入的原目录在批准前已被替换。')
    const holding=await holdDirectory(root)
    if (original && ['path', 'dev', 'ino', 'birthtimeNs', 'mode', 'uid', 'gid'].some(key => holding.physical[key as keyof SourceWorkbenchDirectoryPhysical] !== original[key as keyof SourceWorkbenchDirectoryPhysical])) {
      await holding.handle.close(); return fail('拖入的原目录FD身份已改变。')
    }
    let released = false
    async function check(readContext: { signal: AbortSignal }) { await fence({ ...context, signal: readContext.signal }); if (released || await sourceRootAvailability(root) !== 'ONLINE') return fail('原库目录许可已撤销。');await checkHeld(approved) }
    const approved: LocalWorkbenchApprovedLibraryDirectory = {
      label: root.label, assertCurrent: check,
      async withDirectory(operation, readContext) { return withHeld(approved,async()=>{await check(readContext); const result = await operation(root.path); await check(readContext); return result}) },
      async close() { if(released)return;await options.revokeDirectory?.(approved,context);await closeHeld(approved);released = true; libraries.delete(approved) },
    }
    held.set(approved,holding);libraries.set(approved, { root, datasetId: context.datasetId })
    try {
      await fence(context)
      if (options.registerLibraryDirectory !== originalLibraryRegister || options.assertCurrent !== originalAuthorGuard) return fail('原Owner目录登记或Main作者已改变。')
      const result = await originalLibraryRegister.call(options,approved,context); await fence(context); return result
    }
    catch(error) { await approved.close(); throw error }
  }
  async function librarySelection<T>(operation: () => Promise<T>): Promise<T> {
    if (librarySelectionActive) return fail('另一个原库目录选择尚未收口。')
    librarySelectionActive = true
    try { return await operation() } finally { librarySelectionActive = false }
  }
  const securePrompt: LocalNameSecurePrompt = {
    async readSecret(context: LocalNameSettingsContext) {
      if (closed || context.signal.aborted) return fail('本地安全输入已关闭。')
      await context.assertCurrent(); const chosen = await host.request('secret', context.signal); await context.assertCurrent()
      if (closed || context.signal.aborted) return fail('本地安全输入原身份已撤销。')
      return chosen.cancelled ? null : chosen.value
    }, join: () => host.join(), close: () => host.close(),
  }
  const chooser: ReturnType<typeof createLocalWorkbenchNativeChooser> = {
    async readAvailability(mode,context){
      if(this!==chooser)return unavailable('Native状态只接受原工厂对象。')
      if(!['artwork','cue-target','library'].includes(mode))return unavailable('Native选择模式不在原闭集内。')
      if(closed)return unavailable(closureDone?'原Native选择资源已经关闭。':'原Native选择资源正在关闭。')
      if(retained||closureFailed)return unavailable('原Native来源保护或FD关闭尚未确认。')
      if(options.assertCurrent!==originalAuthorGuard||options.registerLibraryDirectory!==originalLibraryRegister||options.registerCueTarget!==originalCueRegister)return unavailable('原Native作者或登记端点已经改变。')
      if(options.promptHost!==originalHost||host.request!==originalRequest||host.join!==originalJoin||host.close!==originalClose||host.readAvailability!==hostAvailability)
        return unavailable('原Native输入host已经换代。')
      if(mode==='library'&&!options.registerLibraryDirectory||mode==='cue-target'&&!options.registerCueTarget)return unavailable('原Owner目录注册端点尚未建立。')
      if(typeof hostAvailability!=='function')return unavailable('原Native输入host状态尚未确认。')
      const originalSignal=context?.signal,originalDataset=context?.datasetId,originalContextGuard=context?.assertCurrent
      try{
        await fence(context)
        const ready=await abortable(Promise.resolve(hostAvailability.call(host,mode,context.signal)),context.signal)
        await fence(context)
        if(context.signal!==originalSignal||context.datasetId!==originalDataset||context.assertCurrent!==originalContextGuard||options.assertCurrent!==originalAuthorGuard
          ||options.registerLibraryDirectory!==originalLibraryRegister||options.registerCueTarget!==originalCueRegister)return unavailable('原Native作者或读取上下文已经换代。')
        if(closed||retained||closureFailed||options.promptHost!==originalHost||host.request!==originalRequest||host.join!==originalJoin
          ||host.close!==originalClose||host.readAvailability!==hostAvailability)return unavailable('原Native选择资源已经改变。')
        if(ready?.available===true&&Reflect.ownKeys(ready).length===1)return {available:true}
        return unavailable('原Native输入host未确认可调用。')
      }catch{return unavailable('原Native选择作者或信号已撤销。')}
    },
    chooseArtwork: context => track(chooseArtwork(context)), chooseCueTarget: context => track(chooseCueTarget(context)), securePrompt,
    chooseLibrary: context => track(librarySelection(() => chooseLibrary(context))),
    chooseDroppedLibrary: (absolute, context) => track(librarySelection(() => chooseDroppedLibrary(absolute, context))),
    async inspectHeldDirectory(approved,context){const actual=libraries.get(approved as LocalWorkbenchApprovedLibraryDirectory)||targets.get(approved as LocalWorkbenchApprovedCueTarget);if(!actual||actual.datasetId!==context.datasetId)return fail('目录对象不是Main原许可。');await approved.assertCurrent(context);return checkHeld(approved)},
    async closeHeldDirectory(approved){await closeHeld(approved);libraries.delete(approved as LocalWorkbenchApprovedLibraryDirectory);targets.delete(approved as LocalWorkbenchApprovedCueTarget)},
    async inspectApprovedLibraryDirectory(approved, context) {
      const actual = libraries.get(approved)
      if (!actual || actual.datasetId !== context.datasetId) return fail('库目录必须来自原Main私有选择对象。')
      await approved.assertCurrent(context); return Object.freeze({ ...actual.root })
    },
    async inspectApprovedCueTarget(target, context) {
      const actual = targets.get(target)
      if (!actual || actual.datasetId !== context.datasetId) return fail('原生目标必须来自原 Main 私有选择对象。')
      await target.assertCurrent(context); return Object.freeze({ ...actual.root })
    },
    closeReadResources(): Promise<void> {
      if (!closure) { closed = true; closure = (async () => { await host.close(); await Promise.allSettled([...reads]); if (retained) return fail('原来源 FD/命名保护尚未实际关闭。'); closureDone = true })(); void closure.catch(() => { closureFailed = true }) }
      return closure
    },
    closeApprovedDirectories():Promise<void>{
      if(!approvedClosure)approvedClosure=(async()=>{
        await this.closeReadResources()
        for(const target of [...targets.keys()])await target.close()
        for(const library of [...libraries.keys()])await library.close()
        if(held.size||retained)return fail('原批准目录或来源FD仍未实际关闭。')
      })()
      return approvedClosure
    },
  }
  return chooser
}

interface DirectoryUiEntry {author:LocalWorkbenchRootMainAuthor;ui:SourceWorkbenchDirectoryUi;choiceId:string|null}
interface DirectoryMainEntry {author:LocalWorkbenchRootMainAuthor;binding:SourceWorkbenchDirectoryBinding;approved:LocalWorkbenchApprovedLibraryDirectory|LocalWorkbenchApprovedCueTarget;context:LocalWorkbenchMainContext;physical:SourceWorkbenchDirectoryPhysical;approvedSent:boolean;registered:boolean;revoking:boolean;closed:boolean;confirmationAccepted:boolean;cancellationAccepted:boolean;cancelState?:'pending'|'closed'|'unknown';closing?:Promise<void>}
export interface LocalWorkbenchDirectoryUiContext extends LocalWorkbenchMainContext {directoryUiToken?:object}
/** 只能由真实Main服务的受理hook调用；token/FD/作者对象不会序列化到Owner或Renderer。 */
export function createLocalWorkbenchDirectoryMainBridge(options:{
 currentAuthor():LocalWorkbenchRootMainAuthor|undefined;chooser:ReturnType<typeof createLocalWorkbenchNativeChooser>;
 registration(command:'register'|'release',binding:SourceWorkbenchDirectoryBinding,actual:Readonly<LocalWorkbenchRootAuthorBinding>,signal:AbortSignal):Promise<SourceWorkbenchDirectoryRegistrationReply>;
 ownerClosed(actual:Readonly<LocalWorkbenchRootAuthorBinding>):Promise<void>;
}){
 const tokens=new WeakMap<object,DirectoryUiEntry>(),entries=new Map<string,DirectoryMainEntry>(),cancelledEntries=new Map<string,DirectoryMainEntry>(),approved=new WeakMap<object,DirectoryMainEntry>(),uses=new Map<string,DirectoryUiEntry>();let closed=false;
 const same=(a:unknown,b:unknown)=>directoryDigest(a)===directoryDigest(b);
 async function live(context:LocalWorkbenchMainContext|LocalWorkbenchMainPreparationContext):Promise<LocalWorkbenchRootMainAuthor>{
  const author=options.currentAuthor();if(closed||!author||author.binding.datasetId!==('datasetId'in context?context.datasetId:context.binding.datasetId)||context.signal.aborted)throw Error('目录原Main作者已撤销。');await context.assertCurrent?.();await author.assertCurrent(author.binding);if(closed||options.currentAuthor()!==author||context.signal.aborted)throw Error('目录原Main作者已改变。');return author
 }
 async function enter(body:LocalWorkbenchRootMainRequest|import('./workbench-ipc.js').LocalWorkbenchMainRequest,context:LocalWorkbenchMainContext|LocalWorkbenchMainPreparationContext,targetChoiceId?:string):Promise<object|undefined>{
  const family='family'in body?body.family:'workbench';if(family!=='management'&&family!=='workbench')return;
  if(!['library.import.prepare','library.import.confirm','library.cue.start','localWorkbench.cue.target','localWorkbench.cue.preview','localWorkbench.plan.apply'].includes(body.command))return;
  const author=await live(context),payload=body.payload as unknown as Record<string,unknown>,ui=captureSourceWorkbenchDirectoryUi({family,command:body.command,commandId:typeof payload.commandId==='string'?payload.commandId:null,requestSha256:directoryDigest({command:body.command,payload:body.payload})});
  let choiceId=targetChoiceId??(typeof payload.choiceId==='string'?payload.choiceId:payload.target&&typeof payload.target==='object'?Object.getOwnPropertyDescriptor(payload.target,'choiceId')?.value:undefined);
  if(body.command==='library.import.prepare'||body.command==='localWorkbench.cue.target')choiceId=undefined;
  else{const entry=typeof choiceId==='string'?entries.get(choiceId):undefined;if(!entry||entry.closed||entry.revoking||entry.author!==author||entry.binding.expiresAtMs<=Date.now())throw Error('原目录choice未登记、已过期或换代。');if(body.command==='library.import.confirm')entry.confirmationAccepted=true;await entry.approved.assertCurrent(context);}
  const token=Object.freeze({}),item={author,ui,choiceId:typeof choiceId==='string'?choiceId:null};tokens.set(token,item);
  if(item.choiceId){const key=JSON.stringify([ui.family,ui.command,ui.commandId??ui.requestSha256]);const prior=uses.get(key);if(prior&&(!same(prior.ui,ui)||prior.choiceId!==item.choiceId||prior.author!==author))throw Error('原目录command/body不能变更或换目标。');if(!prior&&uses.size>=1024)throw Error('目录原命令记录达到原预算。');uses.set(key,item)}return token
 }
 async function register(kind:'library'|'cue',object:LocalWorkbenchApprovedLibraryDirectory|LocalWorkbenchApprovedCueTarget,context:LocalWorkbenchMainContext):Promise<SourceWorkbenchDirectoryRegistrationReply>{
  const token=(context as LocalWorkbenchDirectoryUiContext).directoryUiToken,item=token?tokens.get(token):undefined,author=await live(context);if(!item||item.author!==author||item.ui.command!==(kind==='library'?'library.import.prepare':'localWorkbench.cue.target')||approved.has(object)||entries.size>=32)throw Error('目录对象没有Main真实原UI受理条目。');
  tokens.delete(token!); // 同一受理条目只允许一次实际Native选择对象登记。
  const physical=await options.chooser.inspectHeldDirectory(object,context),root=kind==='library'?await options.chooser.inspectApprovedLibraryDirectory(object as LocalWorkbenchApprovedLibraryDirectory,context):await options.chooser.inspectApprovedCueTarget(object as LocalWorkbenchApprovedCueTarget,context);
  const issuedAtMs=Date.now(),revision=kind==='cue'?(object as LocalWorkbenchApprovedCueTarget).revision:directoryDigest({physical,scope:{datasetId:author.binding.datasetId,ownerEpoch:author.binding.ownerEpoch,childGeneration:author.binding.childGeneration},ui:item.ui});
  const binding=captureSourceWorkbenchDirectoryBinding({datasetId:author.binding.datasetId,ownerEpoch:author.binding.ownerEpoch,childGeneration:author.binding.childGeneration,kind,choiceId:root.id,revision,issuedAtMs,expiresAtMs:issuedAtMs+600000,originalUi:item.ui}),entry:DirectoryMainEntry={author,binding,approved:object,context,physical,approvedSent:false,registered:false,revoking:false,closed:false,confirmationAccepted:false,cancellationAccepted:false};
  entries.set(binding.choiceId,entry);approved.set(object,entry)
  const reply=await options.registration('register',binding,author.binding,context.signal);if(!reply.ok)throw Error('原Owner目录登记未确认。');entry.registered=true;await object.assertCurrent(context);if(options.currentAuthor()!==author||context.signal.aborted)throw Error('目录原登记已换代。');return reply
 }
 function closeEntry(entry:DirectoryMainEntry,signal?:AbortSignal):Promise<void>{
  if(entry.closing)return entry.closing;entry.revoking=true;entry.closing=(async()=>{
   if(entry.registered||entry.approvedSent){try{const reply=await options.registration('release',entry.binding,entry.author.binding,signal??new AbortController().signal);if(!reply.ok||!('physicalClosed'in reply.result)||!reply.result.physicalClosed)throw Error('原Owner目录撤销未确认。')}catch{await options.ownerClosed(entry.author.binding)}}
   await options.chooser.closeHeldDirectory(entry.approved);entry.closed=true;entries.delete(entry.binding.choiceId);
  })();return entry.closing
 }
 async function cancelLibraryChoice(choiceId:string,context:LocalWorkbenchMainPreparationContext):Promise<directoryDto.LocalLibraryManagementMainResults['library.import.cancel']>{
  const author=await live(context),entry=entries.get(choiceId)??cancelledEntries.get(choiceId)
  if(!directoryDto.isLocalWorkbenchIdentity(choiceId)||!entry||entry.author!==author||entry.binding.kind!=='library'
   ||entry.binding.datasetId!==context.binding.datasetId||entry.binding.ownerEpoch!==context.binding.ownerEpoch||entry.binding.childGeneration!==context.binding.childGeneration
   ||context.binding.authorityRef!==author.binding.authorityRef||entry.confirmationAccepted)throw Error('原库目录选择不能取消；已受理的确认只能查原command回执。')
  // 同choice保留原closing；迟到/UNKNOWN不能新造release请求或换作者重试。
  if(!entry.cancellationAccepted){
   if(entry.closed||entry.revoking||entry.binding.expiresAtMs<=Date.now())throw Error('原临时目录取消身份不可用。')
   entry.cancellationAccepted=true;entry.cancelState='pending'
   if(cancelledEntries.size>=1024){const old=[...cancelledEntries].find(([,value])=>value.cancelState==='closed');if(old)cancelledEntries.delete(old[0])}
   // 满额且没有已实闭口的历史可淘汰时，仍执行关闭；收口后缺该历史的重试只能拒绝。
   if(cancelledEntries.size<1024)cancelledEntries.set(choiceId,entry)
   const original=closeEntry(entry,context.signal)
   void original.then(()=>{entry.cancelState='closed'},()=>{entry.cancelState='unknown'})
  }
  await entry.closing
  await live(context)
  if(!entry.closed||!entry.closing||entry.cancelState!=='closed'||entries.has(choiceId)
   ||cancelledEntries.has(choiceId)&&cancelledEntries.get(choiceId)!==entry)throw Error('原Owner与Main目录资源仍未实际关闭。')
  return {choiceId,released:true}
 }
 async function produce(q:SourceWorkbenchDirectoryRequest,context:{signal:AbortSignal;deadlineAtMs:number}):Promise<SourceWorkbenchDirectoryReply>{
  const empty={version:1 as const,type:'workbench-directory-reply' as const,purpose:'WORKBENCH_DIRECTORY' as const,requestId:q.requestId,sequence:q.sequence,authorityId:q.authorityId,command:q.command,binding:q.binding,ui:q.ui,requestSha256:directoryDigest(q),decision:'rejected' as const,nonce:null,validUntilMs:null,physical:null};
  const entry=entries.get(q.binding.choiceId);if(!entry||!same(entry.binding,q.binding))return captureSourceWorkbenchDirectoryReply(empty);
  if(q.command==='revoke'){await options.chooser.closeHeldDirectory(entry.approved);entry.closed=true;entries.delete(entry.binding.choiceId);return captureSourceWorkbenchDirectoryReply({...empty,decision:'revoked'})}
  const current=options.currentAuthor();if(closed||entry.closed||entry.revoking||!current||current!==entry.author||entry.binding.expiresAtMs<=Date.now()||context.signal.aborted||performance.now()>=context.deadlineAtMs)return captureSourceWorkbenchDirectoryReply(empty);
  if(q.command==='revalidate'){const key=JSON.stringify([q.ui.family,q.ui.command,q.ui.commandId??q.ui.requestSha256]),use=uses.get(key);if(!use||use.author!==entry.author||use.choiceId!==entry.binding.choiceId||!same(use.ui,q.ui))return captureSourceWorkbenchDirectoryReply(empty)}else if(!same(q.ui,entry.binding.originalUi))return captureSourceWorkbenchDirectoryReply(empty);
  await entry.author.assertCurrent(entry.author.binding);await entry.approved.assertCurrent({...entry.context,signal:context.signal});const physical=await options.chooser.inspectHeldDirectory(entry.approved,{...entry.context,signal:context.signal});
  if(!same(physical,entry.physical)||options.currentAuthor()!==entry.author||context.signal.aborted||performance.now()>=context.deadlineAtMs||Date.now()>=q.expiresAtMs)throw Error('原目录FD或响应资格已改变。');entry.approvedSent=true;
  return captureSourceWorkbenchDirectoryReply({...empty,decision:'approved',nonce:randomUUID(),validUntilMs:entry.binding.expiresAtMs,physical})
 }
 return{enter,produce,cancelLibraryChoice,async registerLibraryDirectory(object:LocalWorkbenchApprovedLibraryDirectory,context:LocalWorkbenchMainContext){const reply=await register('library',object,context);if(!reply.ok||!('kind'in reply.result)||reply.result.kind!=='library')throw Error('原库登记未返回实际选择。');return reply.result.choice},async registerCueTarget(object:LocalWorkbenchApprovedCueTarget,context:LocalWorkbenchMainContext){const reply=await register('cue',object,context);if(!reply.ok||!('kind'in reply.result)||reply.result.kind!=='cue')throw Error('原CUE目录登记未返回原choice。')},async revokeDirectory(object:LocalWorkbenchApprovedLibraryDirectory|LocalWorkbenchApprovedCueTarget){const entry=approved.get(object);if(entry)await closeEntry(entry)},async close(){closed=true;const r=await Promise.allSettled([...new Set([...entries.values(),...cancelledEntries.values()])].map(entry=>closeEntry(entry)));if(r.some(v=>v.status==='rejected'))throw Error('目录Owner/FD仍未实静止。');uses.clear()},pending(){return entries.size}}
}
