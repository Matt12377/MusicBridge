import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForMainWindow } from '../e2e/main-window.js'

class Page {
  constructor(private readonly address: string, private closed = false) {}
  url(): string { return this.address }
  isClosed(): boolean { return this.closed }
  close(): void { this.closed = true }
  async waitForLoadState(state: 'domcontentloaded'): Promise<void> {
    assert.equal(state, 'domcontentloaded')
    if (this.closed) throw new Error('Target page has been closed')
  }
}

test('J-Card隐藏窗口先加载时选择MusicBridge主窗口', async () => {
  const print = new Page('data:text/html;charset=utf-8,%3Ch1%3EJ-Card%3C%2Fh1%3E')
  const main = new Page('musicbridge://app/index.html')
  const application = {
    firstWindow: async () => print,
    windows: () => [print, main],
    waitForEvent: async () => { throw new Error('主窗口已经存在，不应继续等待') },
  }
  assert.equal(await waitForMainWindow(application), main)
})

test('短命J-Card窗口关闭后等待随后到达的主窗口', async () => {
  const print = new Page('data:text/html;charset=utf-8,%3Ch1%3EJ-Card%3C%2Fh1%3E')
  const main = new Page('musicbridge://app/index.html')
  let listening = false, mainAlreadyEmitted = false
  const application = {
    firstWindow: async () => print,
    windows: () => {
      if (!listening) mainAlreadyEmitted = true
      return [print]
    },
    waitForEvent: async () => {
      listening = true
      if (mainAlreadyEmitted) throw new Error('主窗口事件已经错过')
      print.close()
      return main
    },
  }
  assert.equal(await waitForMainWindow(application), main)
})
