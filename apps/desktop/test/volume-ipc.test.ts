import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { isVolumeRequest, isVolumeSnapshot, validateIpcRequest, IPC_VERSION } from '@music-bridge/contracts'
test('音量 IPC 在主进程和 Core 边界拒绝非法参数与不可信来源', async () => {
 const source = await readFile('src/main/index.ts','utf8')
 const handlers = new Map<string, (event: boolean, payload?:unknown) => unknown>()
 const calls: unknown[] = []
 const a=source.indexOf("  ipcMain.handle('roon:volume:get'")
 const b=source.indexOf("  ipcMain.handle('playback:seek'",a)
 runInNewContext(ts.transpileModule(source.slice(a,b),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  ipcMain:{handle:(name:string,fn:(event:boolean,payload?:unknown)=>unknown)=>handlers.set(name,fn)},
  invokeCore:(trusted:boolean,fn:()=>unknown)=>{if(!trusted) throw Error('拒绝来源');return fn()},
  supervisor:{request:(...args:unknown[])=>calls.push(args)},isVolumeRequest,
  publicIpcFailure:()=>{throw Error('无效参数')},
 })
 const valid={zoneId:'z',outputId:'o',how:'absolute',value:30}
 for(const payload of [null,{}, {...valid,value:NaN},{...valid,value:Infinity},{...valid,how:'mute'},{...valid,token:'secret'}]) {
  assert.throws(()=>handlers.get('roon:volume:set')!(true,payload))
  assert.equal(validateIpcRequest({version:IPC_VERSION,id:'test',command:'roon.volume.set',payload}).ok,false)
 }
 assert.throws(()=>handlers.get('roon:volume:set')!(false,valid),/拒绝来源/)
 assert.throws(()=>handlers.get('roon:volume:get')!(false),/拒绝来源/)
 assert.equal(calls.length,0)
 handlers.get('roon:volume:set')!(true,valid)
 assert.equal(calls.length,1)
 assert.equal(validateIpcRequest({version:IPC_VERSION,id:'test',command:'roon.volume.set',payload:valid}).ok,true)
 assert.equal(isVolumeSnapshot({zoneId:'z',outputs:[{outputId:'o',name:'音箱',type:'number',value:10}]}),false)
})
