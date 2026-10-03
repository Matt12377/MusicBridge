import type { CollectionFilter } from '@music-bridge/contracts'
import type { CollectionReadonlyDomSnapshot } from '../src/main/collection-readonly-dom-driver.js'
import type { CollectionScaleAction } from '../src/renderer/src/collection-scale-observation.js'
export type CollectionScaleWorkload = 'all' | 'brand-stock' | 'literal' | 'unicode' | 'decade' | 'empty'
export const COLLECTION_SCALE_WORKLOADS: Readonly<Record<CollectionScaleWorkload, CollectionFilter>> = Object.freeze({
  all: Object.freeze({}), 'brand-stock': Object.freeze({ brand: 'RUST015品牌甲', stockState: 'blank' }), literal: Object.freeze({ query: '%_' }),
  unicode: Object.freeze({ query: '樱花🌸' }), decade: Object.freeze({ decade: 1990 }), empty: Object.freeze({ query: 'RUST015绝不匹配' }),
})
export type CollectionScaleDomOperation = 'snapshot' | 'navigate' | 'next' | 'previous' | 'workload' | 'target' | 'clear' | 'detail-open' | 'detail-close' | 'policy-open' | 'policy-save' | 'settings-open' | 'settings-close' | 'readonly-on' | 'readonly-off' | 'refresh'
export interface CollectionScaleDomSnapshot extends CollectionReadonlyDomSnapshot { filterClearVisible: boolean }
async function fixedDom(operation: CollectionScaleDomOperation, action: CollectionScaleAction | null, filter: CollectionFilter): Promise<CollectionScaleDomSnapshot> {
  const visible = (element: Element): boolean => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'
  const one = (elements: Element[], identity = '原控件'): HTMLElement => {
    const matches = elements.filter(visible)
    if (matches.length !== 1 || matches[0]!.matches(':disabled')) throw new Error(`固定原控件不存在、不唯一或尚不可用：${identity}；可见数=${matches.length}。`)
    const element = matches[0] as HTMLElement; element.scrollIntoView({ block: 'center', inline: 'nearest' }); return element
  }
  const query = (selector: string, scope: ParentNode = document): HTMLElement => one(Array.from(scope.querySelectorAll(selector)), selector)
  const button = (scope: ParentNode, text: string): HTMLElement => one(Array.from(scope.querySelectorAll('button')).filter(element => element.textContent?.trim() === text), text)
  const set = (scope: ParentNode, name: string, value: string): void => {
    const labels = Array.from(scope.querySelectorAll('label')).filter(label => Array.from(label.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim() === name || label.querySelector('.filter-label')?.textContent?.trim() === name)
    const control = query('input,select', one(labels)) as HTMLInputElement | HTMLSelectElement
    if (control instanceof HTMLInputElement && control.readOnly || control instanceof HTMLSelectElement && !Array.from(control.options).some(option => option.value === value)) throw new Error('固定原表单值不可用。')
    control.value = value; control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); control.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const turn = async (): Promise<void> => { await new Promise<void>(resolve => setTimeout(resolve, 0)) }
  const submitFilter = async (form: HTMLElement): Promise<void> => {
    const started = performance.now()
    while (performance.now() - started < 5_000) {
      const matches = Array.from(form.querySelectorAll('button')).filter(element => visible(element) && element.textContent?.trim() === '筛选')
      if (matches.length !== 1) throw new Error('原筛选提交控件不存在或不唯一。')
      if (!matches[0]!.matches(':disabled')) { button(form, '筛选').click(); return }
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    }
    throw new Error('原筛选提交控件在固定等待预算内仍不可用。')
  }
  if (action) document.dispatchEvent(new CustomEvent('musicbridge:collection-scale-action', { detail: action }))
  if (operation === 'navigate' || operation === 'settings-close') { query('button[aria-label="实物收藏"]').click(); await turn(); query('button[data-collection-view="tapes"]').click() }
  else if (operation === 'settings-open') { query('button[aria-label="打开设置"]').click(); await turn(); query('#settings-tab-application').click() }
  else if (operation === 'readonly-on' || operation === 'readonly-off') {
    const checkbox = query('input[type="checkbox"][aria-label="Rust 收藏查询"]') as HTMLInputElement
    if (checkbox.checked === (operation === 'readonly-on')) throw new Error('固定开关必须实际改变原boolean。')
    checkbox.click()
  } else if (operation === 'refresh') button(query('#collection-panel-tapes'), '刷新库存').click()
  else if (operation === 'next' || operation === 'previous') button(query('nav[aria-label="收藏分页"]'), operation === 'next' ? '下一页' : '上一页').click()
  else if (operation === 'clear') button(query('#collection-filters'), '清除').click()
  else if (operation === 'target') { const form = query('#collection-filters'); set(query('#collection-panel-tapes'), '关键词', 'RUST015 合成型号 000001'); await turn(); await submitFilter(form) }
  else if (operation === 'workload') {
    const form = query('#collection-filters'), root = query('#collection-panel-tapes')
    set(root, '关键词', filter.query ?? ''); set(form, '品牌', filter.brand ?? '')
    set(form, '年代', filter.decade === undefined ? '' : String(filter.decade)); set(form, '收藏状态', filter.stockState ?? '')
    await turn(); await submitFilter(form)
  } else if (operation === 'detail-open') {
    const cards = Array.from(document.querySelectorAll('#collection-panel-tapes .inventory-card')).filter(card => card.querySelector('.inventory-card-title')?.textContent?.includes('RUST015 合成型号 000001'))
    one(cards).click()
  } else if (operation === 'detail-close') button(query('.model-detail'), '← 返回收藏').click()
  else if (operation === 'policy-open') query('.model-detail details.policy summary').click()
  else if (operation === 'policy-save') { const policy = query('.model-detail details.policy[open]'); set(policy, '收藏策略', 'collector'); set(policy, '最低未开封保留数量', '2'); await turn(); button(policy, '保存保护设置').click() }
  else if (operation !== 'snapshot') throw new Error('固定DOM操作未准入。')
  await turn()
  const root = document.querySelector('#collection-panel-tapes'), detail = root?.querySelector('.model-detail'), summary = root?.querySelector('.collection-list-tools > span')?.textContent?.trim() ?? '', total = /^(?:已登记|筛选结果) · (\d+) 个型号$/u.exec(summary)
  const count = (selector: string): number => Number(detail?.querySelector(selector)?.textContent ?? '-1')
  const readonlyElement = document.querySelector('[data-testid="collection-readonly-state"]') as HTMLElement | null
  return { filterClearVisible: Array.from(document.querySelectorAll('#collection-filters button')).some(element => visible(element) && element.textContent?.trim() === '清除'), frameUrl: location.href, readyState: document.readyState, total: total ? Number(total[1]) : null, page: root?.querySelector('.inventory-pagination > span')?.textContent?.trim() ?? null,
    rows: Array.from(root?.querySelectorAll('.inventory-card') ?? []).filter(visible).map(card => ({ label: card.querySelector('.inventory-card-title')?.textContent?.trim() ?? '', year: card.querySelector('.inventory-card-year')?.textContent?.trim() ?? '', state: card.querySelector('.inventory-card-state')?.textContent?.trim() ?? '' })),
    detail: detail ? { label: detail.querySelector('.hero-body h2')?.textContent?.trim() ?? '', modelId: detail.querySelector('.model-id')?.textContent?.replace(/^型号编号：/u, '').trim() ?? '', total: count('[data-testid="inventory-total"]'), openedBlank: count('[data-testid="inventory-opened"]'), policy: (detail.querySelector('.policy select') as HTMLSelectElement | null)?.value ?? '', reserve: (detail.querySelector('.policy input') as HTMLInputElement | null)?.value ?? '' } : null,
    readonlySettings: readonlyElement ? { enabled: readonlyElement.dataset.enabled === 'true', mode: readonlyElement.dataset.mode ?? '', state: readonlyElement.dataset.state ?? '' } : null,
    dialog: !!document.querySelector('dialog[aria-label="添加磁带"][open]'), inventoryLoading: !!root?.querySelector('.collection-status[role="status"]')?.textContent?.includes('正在读取库存') || Array.from(root?.querySelectorAll('button') ?? []).some(button => visible(button) && button.textContent?.trim() === '刷新中…'),
    errorCount: root?.querySelectorAll('.inventory-feedback [role="alert"],.inventory-dialog [role="alert"]').length ?? 0 }
}
export function collectionScaleDomExpression(operation: CollectionScaleDomOperation, action?: CollectionScaleAction): string {
  const operations: readonly string[] = ['snapshot', 'navigate', 'next', 'previous', 'workload', 'target', 'clear', 'detail-open', 'detail-close', 'policy-open', 'policy-save', 'settings-open', 'settings-close', 'readonly-on', 'readonly-off', 'refresh']
  if (!operations.includes(operation) || operation !== 'snapshot' && (!action || action.kind !== 'rust015-dom-action' || action.operation !== operation || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(action.actionId)
    || Object.keys(action).some(key => !['kind', 'actionId', 'operation', 'workload', 'iteration', 'mode'].includes(key))
    || action.iteration !== undefined && (!Number.isSafeInteger(action.iteration) || action.iteration < -1 || action.iteration > 9)
    || action.mode !== undefined && !['node', 'rust'].includes(action.mode)
    || operation !== 'workload' && (action.workload !== undefined || action.iteration !== undefined || action.mode !== undefined))
    || operation === 'snapshot' && action || operation === 'workload' && (!action?.workload || !Object.hasOwn(COLLECTION_SCALE_WORKLOADS, action.workload))) throw new Error('固定DOM表达式参数无效。')
  const filter = action?.workload ? COLLECTION_SCALE_WORKLOADS[action.workload as CollectionScaleWorkload] : {}
  return `(()=>{const __name=(fn)=>fn;return (${fixedDom.toString()})(${JSON.stringify(operation)},${JSON.stringify(action ?? null)},${JSON.stringify(filter)});})()`
}
