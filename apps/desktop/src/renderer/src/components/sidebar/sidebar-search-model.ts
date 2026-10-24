/** 下拉只保存展示身份；来源权限和播放资格继续由原业务入口判断。 */
export interface SidebarSearchSuggestion {
  key: string
  kind: 'artist' | 'album' | 'track' | 'keyword'
  source: 'local' | 'netease' | 'roon'
  title: string
  subtitle: string
  artworkUrl?: string
  artworkReference?: string
}

export type SidebarSearchKeyAction =
  | { type: 'none' }
  | { type: 'close' }
  | { type: 'highlight'; index: number }
  | { type: 'select'; index: number }
  | { type: 'submit' }

export function sidebarSearchKeyAction(input: {
  key: string; composing: boolean; open: boolean; highlighted: number; count: number; query: string
}): SidebarSearchKeyAction {
  if (input.composing) return { type: 'none' }
  if (input.key === 'Escape') return { type: 'close' }
  if (!input.query.trim()) return { type: 'none' }
  // 最后一项是“查看全部”，无命中时仍可直接提交完整搜索。
  const count = input.count + 1
  if (input.key === 'ArrowDown') return { type: 'highlight', index: input.open ? (input.highlighted + 1 + count) % count : 0 }
  if (input.key === 'ArrowUp') return { type: 'highlight', index: input.open ? (input.highlighted - 1 + count) % count : count - 1 }
  if (input.key === 'Enter') return input.open && input.highlighted >= 0 && input.highlighted < input.count
    ? { type: 'select', index: input.highlighted } : { type: 'submit' }
  return { type: 'none' }
}
