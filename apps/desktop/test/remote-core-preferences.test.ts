import assert from 'node:assert/strict'
import test from 'node:test'
import { restoreRemoteTarget, reconnectRemoteTarget } from '../src/renderer/src/remote-core-preferences.js'

test('开发启动得到的目标保存在设置中，打包版无环境变量时仍可恢复', () => {
  const values = new Map<string,string>()
  const storage = {getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => {values.set(key,value)}}
  assert.equal(restoreRemoteTarget('demo-core', storage), 'demo-core')
  assert.equal(restoreRemoteTarget(undefined, storage), 'demo-core')
  assert.equal(restoreRemoteTarget('other-default', storage), 'demo-core')
})

test('冷启动后重连使用已保存目标建立连接，不依赖主进程上次配置', async () => {
  const calls:string[]=[]
  const api={startRemoteCore:async(target:string)=>{calls.push(target);return 'started'},reconnectRemoteCore:async()=>{throw Error('不应重连不存在的会话')}}
  assert.equal(await reconnectRemoteTarget(api,{status:'idle'},'demo-core'),'started')
  assert.deepEqual(calls,['demo-core'])
})

test('已有连接的重连沿用现有受控会话', async () => {
  const api={startRemoteCore:async()=>{throw Error('不应建立重复会话')},reconnectRemoteCore:async()=> 'reconnected'}
  assert.equal(await reconnectRemoteTarget(api,{status:'ready',sshTarget:'demo-core'},'demo-core'),'reconnected')
})

test('失败后修改目标，重连使用新目标', async () => {
  const calls:string[]=[]
  const api={startRemoteCore:async(target:string)=>{calls.push(target)},reconnectRemoteCore:async()=>{throw Error('不应使用旧目标')}}
  await reconnectRemoteTarget(api,{status:'failed',sshTarget:'old-core'},'new-core')
  assert.deepEqual(calls,['new-core'])
})
