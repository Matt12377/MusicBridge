import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { localWorkbenchNativePromptScript } from '../src/main/local-library-workbench/native-chooser.js'

function prompt(mode: 'library' | 'cue-target' | 'artwork' | 'secret', response: unknown) {
  const logs: unknown[][] = [], secret = '合成密钥-不得进入日志', selected = '/synthetic/selected-directory'
  const wrapped = (value: unknown) => ({ value })
  let secretReads = 0
  const field = { get stringValue() { secretReads++; return wrapped(secret) } }
  const panel = { runModal: wrapped(response), URL: { path: wrapped(selected) } }
  const alert = { runModal: wrapped(response), window: {}, addButtonWithTitle() {} }
  const script = localWorkbenchNativePromptScript(mode)
  const result = JSON.parse(runInNewContext(script + '\nrun()', {
    ObjC: { import() {}, unwrap: (value: any) => value?.value ?? value },
    $: { NSApplication: { sharedApplication: { setActivationPolicy() {}, activateIgnoringOtherApps() {} } },
      NSOpenPanel: { openPanel: panel }, NSAlert: { alloc: { init: alert } }, NSSecureTextField: { alloc: { initWithFrame: () => field } }, NSMakeRect() {} },
    console: { log: (...values: unknown[]) => logs.push(values), info: (...values: unknown[]) => logs.push(values), error: (...values: unknown[]) => logs.push(values) },
  }))
  return { result, logs, secretReads, secret, selected, script }
}

test('原生选择脚本执行实际生成程序：JXA字符串1与数字1均接受，0和未知结果取消', () => {
  for (const mode of ['library', 'cue-target', 'artwork'] as const) {
    for (const response of ['1', 1]) {
      const value = prompt(mode, response)
      assert.deepEqual(value.result, { cancelled: false, value: value.selected }, `${mode}确认不能被NSInteger字符串桥接误判取消`)
      assert.deepEqual(value.logs, [])
    }
    for (const response of ['0', 0, '未知结果', undefined]) assert.deepEqual(prompt(mode, response).result, { cancelled: true, value: null })
  }
})

test('原生密钥脚本执行实际生成程序：字符串1000保存，1001与未知取消且不读取或日志密钥', () => {
  for (const response of ['1000', 1000]) {
    const value = prompt('secret', response)
    assert.deepEqual(value.result, { cancelled: false, value: value.secret })
    assert.equal(value.secretReads, 1)
    assert.deepEqual(value.logs, [])
    assert.equal(value.script.includes(value.secret), false)
  }
  for (const response of ['1001', 1001, '未知结果', undefined]) {
    const value = prompt('secret', response)
    assert.deepEqual(value.result, { cancelled: true, value: null })
    assert.equal(value.secretReads, 0)
    assert.deepEqual(value.logs, [])
  }
})
