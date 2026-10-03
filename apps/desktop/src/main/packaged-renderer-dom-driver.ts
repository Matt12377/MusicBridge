import { createHash } from 'node:crypto'
import type { CollectionReceiveRequest } from '@music-bridge/contracts'

/** 固定合成型号只由原入库表单建立；不包含命令 UUID 或真实库存。 */
function createFixedFixture(): readonly Omit<CollectionReceiveRequest, 'commandId'>[] { return Object.freeze(Array.from({ length: 26 }, (_, index) => Object.freeze({
  model: Object.freeze({ brand: index < 13 ? 'RUST013合成甲' : 'RUST013合成乙', name: `RUST013 合成型号 ${String(index + 1).padStart(2, '0')}`,
    edition: 'RUST013固定合成', year: [1991, 2001, null][index % 3]!, format: index % 4 === 3 ? 'dat' as const : 'cassette' as const,
    tapeType: index % 4 === 3 ? 'dat' as const : index % 2 === 0 ? 'II' as const : 'I' as const,
    identification: index % 5 === 4 ? 'unidentified' as const : 'verified' as const }),
  lengthMinutes: 60, quantities: Object.freeze({ sealedBlank: 0, openedBlank: 1, legacyUsed: 0, unclassified: 0 }),
}))) }
export const PACKAGED_RENDERER_FIXTURE = /* @__PURE__ */ createFixedFixture()
function fixedFixtureDigest(): string { return createHash('sha256').update(JSON.stringify(PACKAGED_RENDERER_FIXTURE)).digest('hex') }
export const PACKAGED_RENDERER_FIXTURE_SHA256 = /* @__PURE__ */ fixedFixtureDigest()
export type PackagedRendererDomOperation = 'snapshot' | 'navigate' | 'receive-open' | 'receive-save' | 'next' | 'previous' | 'filter-brand' | 'filter-query' | 'filter-decade' | 'filter-state' | 'clear' | 'detail-open' | 'detail-close' | 'policy-open' | 'policy-save'
export interface PackagedRendererDomSnapshot {
  frameUrl: string; readyState: string; total: number | null; page: string | null
  rows: { label: string; year: string; state: string }[]
  detail: { label: string; modelId: string; total: number; openedBlank: number; policy: string; reserve: string } | null
  dialog: boolean; inventoryLoading: boolean; errorCount: number
}
// 此函数整体是固定包内表达式；输入只能由以下枚举与冻结 fixture 派生。
async function fixedDom(operation: PackagedRendererDomOperation, fixture: Omit<CollectionReceiveRequest, 'commandId'> | null): Promise<PackagedRendererDomSnapshot> {
  const visible = (element: Element): boolean => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'
  const one = (elements: Element[]): HTMLElement => {
    const matches = elements.filter(visible)
    if (matches.length !== 1) throw new Error('固定控件不存在或不唯一。')
    const element = matches[0] as HTMLElement
    if (element.matches(':disabled')) throw new Error('固定控件尚不可用。')
    element.scrollIntoView({ block: 'center', inline: 'nearest' })
    return element
  }
  const query = (selector: string, scope: ParentNode = document): HTMLElement => one(Array.from(scope.querySelectorAll(selector)))
  const button = (scope: ParentNode, text: string): HTMLElement => one(Array.from(scope.querySelectorAll('button')).filter(element => element.textContent?.trim() === text))
  const set = (scope: ParentNode, name: string, value: string): void => {
    const labels = Array.from(scope.querySelectorAll('label')).filter(label => {
      const direct = Array.from(label.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim()
      return direct === name || label.querySelector('.filter-label')?.textContent?.trim() === name
    })
    const label = one(labels), control = query('input,select', label) as HTMLInputElement | HTMLSelectElement
    if (control instanceof HTMLInputElement && control.readOnly) throw new Error('固定表单只读。')
    if (control instanceof HTMLSelectElement && !Array.from(control.options).some(option => option.value === value)) throw new Error('固定选项不存在。')
    control.value = value
    control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const turn = async (): Promise<void> => { await new Promise<void>(resolve => setTimeout(resolve, 0)) }
  if (operation === 'navigate') {
    query('button[aria-label="实物收藏"]').click(); await turn()
    query('button[data-collection-view="tapes"]').click()
  } else if (operation === 'receive-open') {
    query('#collection-panel-tapes .collection-add').click()
  } else if (operation === 'receive-save') {
    if (!fixture) throw new Error('固定型号缺失。')
    const dialog = query('dialog[aria-label="添加磁带"][open]')
    set(dialog, '品牌', fixture.model.brand); set(dialog, '型号', fixture.model.name)
    set(dialog, '版次 / 包装版本', fixture.model.edition); set(dialog, '年份', fixture.model.year === null ? '' : String(fixture.model.year))
    set(dialog, '介质', fixture.model.format); await turn()
    if (fixture.model.format !== 'dat') set(dialog, '磁带类型', fixture.model.tapeType)
    set(dialog, '时长（分钟）', '60'); set(dialog, '版次确认', fixture.model.identification)
    set(dialog, '未开封空白', '0'); set(dialog, '已拆空白', '1'); set(dialog, '旧录音待登记', '0'); set(dialog, '未分类', '0')
    await turn(); button(dialog, '保存库存').click()
  } else if (operation === 'next' || operation === 'previous') {
    button(query('nav[aria-label="收藏分页"]'), operation === 'next' ? '下一页' : '上一页').click()
  } else if (['filter-brand', 'filter-query', 'filter-decade', 'filter-state'].includes(operation)) {
    const form = query('#collection-filters')
    if (operation === 'filter-brand') { set(form, '品牌', 'RUST013合成甲'); await turn(); button(form, '筛选').click() }
    if (operation === 'filter-query') { set(query('#collection-panel-tapes'), '关键词', 'RUST013 合成型号 01'); await turn(); button(form, '筛选').click() }
    if (operation === 'filter-decade') set(form, '年代', '1990')
    if (operation === 'filter-state') set(form, '收藏状态', 'needs-review')
  } else if (operation === 'clear') {
    button(query('#collection-filters'), '清除').click()
  } else if (operation === 'detail-open') {
    if (!fixture) throw new Error('固定目标型号缺失。')
    const cards = Array.from(document.querySelectorAll('#collection-panel-tapes .inventory-card')).filter(card => card.querySelector('.inventory-card-title')?.textContent?.includes(fixture.model.name))
    one(cards).click()
  } else if (operation === 'detail-close') {
    button(query('.model-detail'), '← 返回收藏').click()
  } else if (operation === 'policy-open') {
    query('.model-detail details.policy summary').click()
  } else if (operation === 'policy-save') {
    const policy = query('.model-detail details.policy[open]')
    set(policy, '收藏策略', 'collector'); set(policy, '最低未开封保留数量', '2'); await turn(); button(policy, '保存保护设置').click()
  } else if (operation !== 'snapshot') throw new Error('固定控件操作无效。')
  await turn()
  const root = document.querySelector('#collection-panel-tapes')
  const summary = root?.querySelector('.collection-list-tools > span')?.textContent?.trim() ?? ''
  const total = /^(?:已登记|筛选结果) · (\d+) 个型号$/u.exec(summary)
  const detail = root?.querySelector('.model-detail')
  const count = (selector: string): number => Number(detail?.querySelector(selector)?.textContent ?? '-1')
  const modelId = detail?.querySelector('.model-id')?.textContent?.replace(/^型号编号：/u, '').trim() ?? ''
  return { frameUrl: location.href, readyState: document.readyState, total: total ? Number(total[1]) : null,
    page: root?.querySelector('.inventory-pagination > span')?.textContent?.trim() ?? null,
    rows: Array.from(root?.querySelectorAll('.inventory-card') ?? []).filter(visible).map(card => ({ label: card.querySelector('.inventory-card-title')?.textContent?.trim() ?? '', year: card.querySelector('.inventory-card-year')?.textContent?.trim() ?? '', state: card.querySelector('.inventory-card-state')?.textContent?.trim() ?? '' })),
    detail: detail ? { label: detail.querySelector('.hero-body h2')?.textContent?.trim() ?? '', modelId, total: count('[data-testid="inventory-total"]'), openedBlank: count('[data-testid="inventory-opened"]'), policy: (detail.querySelector('.policy select') as HTMLSelectElement | null)?.value ?? '', reserve: (detail.querySelector('.policy input') as HTMLInputElement | null)?.value ?? '' } : null,
    dialog: !!document.querySelector('dialog[aria-label="添加磁带"][open]'), inventoryLoading: !!root?.querySelector('.collection-status[role="status"]')?.textContent?.includes('正在读取库存'),
    errorCount: root?.querySelectorAll('.inventory-feedback [role="alert"],.inventory-dialog [role="alert"]').length ?? 0 }
}
export function packagedRendererDomExpression(operation: PackagedRendererDomOperation, fixtureIndex?: number): string {
  const operations: readonly string[] = ['snapshot', 'navigate', 'receive-open', 'receive-save', 'next', 'previous', 'filter-brand', 'filter-query', 'filter-decade', 'filter-state', 'clear', 'detail-open', 'detail-close', 'policy-open', 'policy-save']
  if (!operations.includes(operation) || fixtureIndex !== undefined && (!Number.isInteger(fixtureIndex) || fixtureIndex < 0 || fixtureIndex >= 26)
    || (operation === 'receive-save' || operation === 'detail-open') && fixtureIndex === undefined
    || fixtureIndex !== undefined && operation !== 'receive-save' && operation !== 'detail-open') throw new Error('固定DOM表达式参数无效。')
  const fixture = fixtureIndex === undefined ? null : PACKAGED_RENDERER_FIXTURE[fixtureIndex]
  return `(()=>{const __name=(fn)=>fn;return (${fixedDom.toString()})(${JSON.stringify(operation)},${JSON.stringify(fixture)});})()`
}
