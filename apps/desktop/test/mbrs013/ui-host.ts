import assert from 'node:assert/strict'
import { mounted } from '../mbrs014/ui-host.js'

export { mounted }
export type RelocationUi = Awaited<ReturnType<typeof mounted>>
type Element = ReturnType<RelocationUi['all']>[number]

export const named = (ui: RelocationUi, name: string): Element | undefined => ui.all().find(element => element.props['aria-label'] === name)
export const button = (ui: RelocationUi, name: string): Element | undefined => ui.all().find(element => element.type === 'button' && ui.text(element) === name)

/** 等待真实 SFC 事件返回，包括原请求指纹计算和持久回读；不直接调用领域会话。 */
async function dispatch(ui: RelocationUi, element: Element | undefined, key: string): Promise<void> {
  assert.ok(element, '搬迁界面缺少事件目标')
  assert.ok(!element.props.disabled, '不能派发禁用的搬迁入口')
  const handlers = Array.isArray(element.props[key]) ? element.props[key] : [element.props[key]]
  assert.ok(handlers.length && handlers.every(handler => typeof handler === 'function'), '搬迁界面缺少真实事件处理器')
  element.focus()
  const event = ui.event(element)
  await Promise.all(handlers.map(handler => handler(event)))
  await ui.settle()
}

export async function click(ui: RelocationUi, name: string): Promise<void> {
  await dispatch(ui, button(ui, name), 'onClick')
}

export async function submit(ui: RelocationUi, name: string): Promise<void> {
  await dispatch(ui, ui.all().find(element => element.type === 'form' && element.props['aria-label'] === name), 'onSubmit')
}
