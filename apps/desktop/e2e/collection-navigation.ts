import { expect, type Page } from '@playwright/test'

/** 顶层两库通过侧栏真实按钮进入，父按钮只负责展开或返回。 */
export async function openCollectionView(page: Page, view: 'tapes' | 'music'): Promise<void> {
  const group = page.getByRole('group', { name: '实物收藏分类', exact: true })
  if (!await group.isVisible()) await page.locator('[data-sidebar-source="collection"]').click()
  await expect(group).toBeVisible()
  const label = view === 'tapes' ? '收藏音乐库' : '实体音乐库'
  const button = group.getByRole('button', { name: label, exact: true })
  await button.click()
  await expect(button).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: label, exact: true })).toBeVisible()
}

/** 型号操作及汇总都先切到真实可见详情页，不访问隐藏的 v-show 面板。 */
export async function selectModelPage(page: Page, label: '概览' | '我的库存' | '实体磁带' | '资料照片'): Promise<void> {
  const detail = page.getByRole('region', { name: '磁带型号详情', exact: true })
  await expect(detail).toBeVisible()
  const tab = detail.getByRole('tablist', { name: '型号详情页面', exact: true }).getByRole('tab', { name: label, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(detail.getByRole('tabpanel', { name: label, exact: true })).toBeVisible()
  await expect(detail.getByRole('tabpanel')).toHaveCount(1)
}
